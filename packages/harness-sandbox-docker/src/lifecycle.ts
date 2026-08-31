import {
  ValidationError,
  SandboxPermissionDeniedError,
  sandboxScopeSchema,
  type HarnessAdapterContext, type Sandbox, type SandboxOpenOptions,
  type SandboxOpenResult, type SandboxTerminateOptions, type SandboxAdministration,
  type SandboxOwnerRegistrationOptions, type HarnessIdentity,
} from '@purista/harness'
import { resolveOptions, failure, configurationFailure, type DockerSandboxOptions, type ResolvedOptions } from './options.js'
import { Records, hash, scopeKey, stateLost, type LifecycleRecord, type Ownership } from './records.js'
import { DockerSandboxSession } from './session.js'
import { checkCancelled, collect, DEFAULT_TIMEOUT_MS, type DockerChild, type DockerResult, type DockerTransport } from './transport.js'
import { DockerAdministration } from './administration.js'
import { DockerOwnershipJournal } from './ownership.js'

export const CAPABILITIES = ['sandbox.fs', 'sandbox.text_search', 'sandbox.exec', 'sandbox.spawn', 'sandbox.persistent_fs'] as const
type Engine = Pick<LifecycleRecord, 'context' | 'host' | 'engineId'>
const LABEL = 'purista.sandbox.owner'
const CONTAINER_FORMAT = `{{.Id}}\t{{index .Config.Labels "${LABEL}"}}\t{{.State.Running}}`
const VOLUME_FORMAT = `{{.Name}}\t{{index .Labels "${LABEL}"}}`

/** Private implementation; tests inject a scripted CLI transport, never a public escape hatch. */
export class DockerSandbox implements Sandbox<typeof CAPABILITIES> {
  public readonly capabilities = CAPABILITIES
  public readonly telemetryAdapterId = 'docker'
  public timeoutMs = DEFAULT_TIMEOUT_MS
  private readonly options: ResolvedOptions
  private readonly records: Records
  private readonly journal: DockerOwnershipJournal
  private readonly dockerAdministration: DockerAdministration
  public readonly administration: SandboxAdministration
  private readonly policyHash: string
  private enginePromise: Promise<Engine> | undefined
  private readonly sessions = new Map<string, { record: LifecycleRecord; ownership: Ownership; handles: Set<DockerSandboxSession> }>()
  private readonly opening = new Map<string, Promise<void>>()

  public constructor(options: DockerSandboxOptions, private readonly transport: DockerTransport) {
    this.options = resolveOptions(options)
    this.records = new Records(this.options.root)
    this.journal = new DockerOwnershipJournal(this.records, this.options.administration)
    this.dockerAdministration = new DockerAdministration(this.journal, {
      stopContainer: async (name, signal) => await this.stopKnownContainer(name, signal),
      removeContainer: async (name, signal) => await this.removeKnownContainer(name, signal),
      removeVolume: async (name, signal) => await this.removeKnownVolume(name, signal),
    })
    this.administration = this.dockerAdministration
    this.policyHash = hash(JSON.stringify([this.options.image, this.options.user, this.options.network,
      this.options.resources.cpus, this.options.resources.memoryMb, this.options.resources.pids, this.options.resources.tmpfsMb]))
  }
  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.timeoutMs = context.defaults.toolTimeoutMs
    this.dockerAdministration.configureHarnessContext(context)
  }

  /** Records immutable ownership before Docker resources or guest files are allocated. */
  public async registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void> {
    await this.dockerAdministration.registerOwner(options)
  }

  public async open(options: SandboxOpenOptions): Promise<SandboxOpenResult<typeof CAPABILITIES>> {
    const scope = parseContract(sandboxScopeSchema, options.scope, 'scope')
    const input = { ...options, scope }
    scopeKey(input.scope)
    checkCancelled(input.signal)
    if (!canActOnOwner(input.scope.owner.identity, input.identity)) throw new SandboxPermissionDeniedError('scope_mismatch')
    if (input.mode === 'restore') throw stateLost(input.scope.lifetime, 'durable_workspace_recovery_unavailable')
    if (input.mode !== 'attach' && input.mode !== 'create') throw failure('invalid_open_mode')
    const openingKey = scopeKey(input.scope)
    const previous = this.opening.get(openingKey)
    let releaseOpening!: () => void
    const pending = new Promise<void>(resolve => { releaseOpening = resolve })
    this.opening.set(openingKey, pending)
    const key = await this.records.key(input.scope)
    try {
      await previous
      await this.journal.assertAttachment(input.scope.owner, input.identity)
      return await this.openScoped(input, key)
    } finally {
      releaseOpening()
      if (this.opening.get(openingKey) === pending) this.opening.delete(openingKey)
    }
  }
  private async openScoped(options: SandboxOpenOptions, key: string): Promise<SandboxOpenResult<typeof CAPABILITIES>> {
    checkCancelled(options.signal)
    const existing = this.sessions.get(key)
    if (existing) {
      await this.assertActive(existing.record, existing.ownership, options.identity)
      const session = new DockerSandboxSession(this, existing.record, existing.ownership, options.identity)
      existing.handles.add(session)
      return { session, disposition: 'attached', liveProcessState: 'not_preserved' }
    }
    const engine = await this.engine(options.signal)
    const ownership = await this.records.acquire(key, async () => {
      const stale = await this.records.read(key)
      if (!stale) throw stateLost(options.scope.lifetime, 'lifecycle_state_missing')
      await this.verifyEngine(stale, options.signal)
      await this.stopRetained(stale)
    })
    try {
      let record = await this.records.read(key)
      let disposition: 'created' | 'attached' = 'attached'
      if (record) {
        if (record.state !== 'active') throw stateLost(record.lifetime, 'lifecycle_state_missing')
        await this.journal.assertResource(key, options.scope)
        if (record.policyHash !== this.policyHash) throw configurationFailure('sandbox_policy_changed', 'Retained sandbox image or resource policy differs from this adapter configuration. Restore the original configuration or explicitly terminate the old scope.')
        await this.verifyEngine(record, options.signal)
        // Missing ownership metadata is not evidence that retained guest work
        // stopped. Every new host owner establishes this before attachment.
        await this.stopRetained(record)
        await this.retained(record, true, options.signal)
      } else {
        if (options.mode === 'attach') throw stateLost(options.scope.lifetime, 'lifecycle_state_missing')
        record = { version: 2, key, lifetime: options.scope.lifetime, state: 'creating', policyHash: this.policyHash, ...engine }
        // Names include the canonical private-root namespace; no raw identity reaches Docker.
        if (await this.inspectResource(record, 'container', options.signal) || await this.inspectResource(record, 'volume', options.signal)) {
          throw stateLost(record.lifetime, 'lifecycle_state_missing')
        }
        await this.preflight(engine, options.signal)
        // Intent survives a CLI timeout or host crash before resource identifiers return.
        await this.records.write(record)
        await this.journal.trackResource({
          summary: {
            resourceId: key,
            kind: 'sandbox',
            owner: options.scope.owner,
            scope: options.scope,
            state: 'provisioning',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            pinned: false,
          },
          label: this.journal.labelFor(options.scope.owner),
          containerName: resourceName(record),
          volumeName: resourceName(record),
        })
        try {
          await this.command(engine, ['volume', 'create', '--label', `${LABEL}=${key}`, resourceName(record)], options.signal)
          await this.command(engine, [
            'run', '--detach', '--pull', 'never', '--name', resourceName(record),
            '--label', `${LABEL}=${key}`, '--network', this.options.network, '--user', this.options.user,
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
            '--cpus', String(this.options.resources.cpus), '--memory', `${this.options.resources.memoryMb}m`,
            '--pids-limit', String(this.options.resources.pids),
            '--tmpfs', `/tmp:rw,noexec,nosuid,size=${this.options.resources.tmpfsMb}m`,
            '--mount', `type=volume,src=${resourceName(record)},dst=/workspace`,
            '--workdir', '/workspace', '--entrypoint', 'sh', this.options.image,
            '-c', 'trap "exit 0" TERM INT; while :; do sleep 86400 & wait; done',
          ], options.signal)
          const preflight = await this.run(engine, ['exec', resourceName(record), 'sh', '-ceu',
            'for tool in sh sleep base64 find grep stat realpath dirname mkdir rm cat test; do command -v "$tool" >/dev/null; done; test -w /workspace; find /workspace -maxdepth 0 -printf ""; stat --printf "" /workspace; realpath -m /workspace >/dev/null; printf test | grep -E -m 1 -- "t.st" >/dev/null'], options.signal)
          if (preflight.exitCode !== 0) throw configurationFailure('invalid_guest_image', 'Docker sandbox image must provide GNU-compatible filesystem and bounded text-search utilities plus a workspace writable by its configured non-root user.')
          record = { ...record, state: 'active' }
          await this.records.write(record)
          await this.journal.markActive(key)
          disposition = 'created'
        } catch (error) {
          await this.records.write({ ...record, state: 'terminating' })
          await this.journal.markCleanupPending(key)
          // An interrupted CLI can leave an uncertain late provider mutation.
          // Keep terminal intent until a subsequent explicit cleanup retry.
          await this.cleanup(record, undefined, false)
          throw error
        }
      }
      const session = new DockerSandboxSession(this, record, ownership, options.identity)
      this.sessions.set(key, { record, ownership, handles: new Set([session]) })
      return { session, disposition, liveProcessState: 'not_preserved' }
    } catch (error) {
      await ownership.release()
      throw error
    }
  }

  public async terminate(options: SandboxTerminateOptions): Promise<void> {
    const scope = parseContract(sandboxScopeSchema, options.scope, 'scope')
    const input = { ...options, scope }
    scopeKey(input.scope)
    if (!['session_closed', 'run_disposed', 'manual'].includes(input.reason)) throw failure('invalid_termination_reason')
    checkCancelled(input.signal)
    await this.journal.assertAttachment(input.scope.owner)
    const openingKey = scopeKey(input.scope)
    const key = await this.records.key(input.scope)
    await this.opening.get(openingKey)
    const existing = this.sessions.get(key)
    if (existing) {
      // Terminal intent is durable before invalidating or deleting resources.
      await this.records.write({ ...existing.record, state: 'terminating' })
      await Promise.all([...existing.handles].map(session => session.invalidate()))
      await existing.ownership.release()
      this.sessions.delete(key)
    }
    const ownership = await this.records.acquire(key, async () => {
      const stale = await this.records.read(key)
      if (!stale) throw stateLost(input.scope.lifetime, 'lifecycle_state_missing')
      await this.verifyEngine(stale, input.signal)
    })
    try {
      const record = await this.records.read(key)
      if (record?.state === 'terminated') return
      if (!record) {
        const engine = await this.engine(input.signal)
        // This is a durable negative lifecycle marker only. It authorizes no
        // provider discovery, adoption, or deletion.
        await this.records.write({ version: 2, key, lifetime: input.scope.lifetime, state: 'terminated', policyHash: this.policyHash, ...engine })
        return
      }
      await this.journal.assertResource(key, input.scope)
      await this.verifyEngine(record, input.signal)
      await this.records.write({ ...record, state: 'terminating' })
      await this.journal.markCleanupPending(key)
      await this.cleanup(record, input.signal)
    } finally { await ownership.release() }
  }

  private async cleanup(record: LifecycleRecord, signal?: AbortSignal, completed = true): Promise<void> {
    const result = await this.dockerAdministration.cleanupResource(record.key, signal)
    if (result !== 'deleted') throw failure('guest_cleanup_failed', 'Docker sandbox cleanup is pending and must be retried with the same private metadata.')
    if (completed) {
      await this.records.write({ ...record, state: 'terminated' })
    }
  }
  public async assertActive(record: LifecycleRecord, ownership: Ownership, identity?: HarnessIdentity): Promise<void> {
    await ownership.assert()
    const current = await this.records.read(record.key)
    if (!current || current.state !== 'active') throw stateLost(record.lifetime, 'lifecycle_state_missing')
    const resource = await this.journal.resource(record.key)
    if (!resource) throw stateLost(record.lifetime, 'lifecycle_state_missing')
    await this.journal.assertAttachment(resource.summary.owner, identity)
    await this.verifyEngine(record)
    await this.retained(record, false)
  }
  public async detached(record: LifecycleRecord, ownership: Ownership, session: DockerSandboxSession): Promise<void> {
    const group = this.sessions.get(record.key)
    if (!group) return
    await ownership.assert()
    if (group.handles.size > 1) { group.handles.delete(session); return }
    await this.stopRetained(record)
    await ownership.release()
    this.sessions.delete(record.key)
  }
  public async stopRetained(record: LifecycleRecord, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    await this.records.withResourceLock(record.key, async () => {
      await this.verifyEngine(record)
      const container = await this.inspectResource(record, 'container')
      if (!container) return
      if (container.running) await this.command(record, signal === 'SIGKILL'
        ? ['container', 'kill', '--signal', 'KILL', resourceName(record)]
        : ['container', 'stop', '--time', '1', resourceName(record)])
      const stopped = await this.inspectResource(record, 'container')
      if (stopped?.running) throw failure('guest_cleanup_failed', 'Docker sandbox guest cleanup could not be confirmed; ownership is retained.')
    })
  }
  public async startGuest(record: LifecycleRecord, command: readonly string[], options: { cwd?: string; env?: Record<string, string> } = {}): Promise<DockerChild> {
    return await this.transport.start(['--host', record.host, 'exec', '--interactive', '--workdir', options.cwd ?? '/workspace',
      ...environmentArgs(options.env), resourceName(record), ...command])
  }
  private async retained(record: LifecycleRecord, restart: boolean, signal?: AbortSignal): Promise<void> {
    const container = await this.inspectResource(record, 'container', signal)
    const volume = await this.inspectResource(record, 'volume', signal)
    if (!container || !volume) throw stateLost(record.lifetime, 'provider_missing')
    if (!container.running) {
      if (!restart) throw failure('attachment_stopped', 'Docker sandbox compute is stopped. Release and attach again to resume retained files.')
      await this.command(record, ['container', 'start', resourceName(record)], signal)
    }
  }
  private async inspectResource(engine: Engine & Pick<LifecycleRecord, 'key'>, kind: 'container' | 'volume', signal?: AbortSignal): Promise<{ running: boolean } | undefined> {
    const result = await this.run(engine, [kind, 'inspect', '--format', kind === 'container' ? CONTAINER_FORMAT : VOLUME_FORMAT, resourceName(engine)], signal)
    if (result.exitCode !== 0) {
      if (/\bno such (?:container|volume|object)\b/i.test(result.stderr)) return undefined
      throw failure('provider_unavailable', 'Docker sandbox resource inspection failed; retained state was not replaced.')
    }
    const [id, owner, running] = result.stdout.trim().split('\t')
    if (!id || owner !== engine.key) throw failure('resource_ownership_mismatch')
    if (kind === 'container' && running !== 'true' && running !== 'false') throw failure('provider_response_invalid')
    return { running: running === 'true' }
  }
  private async preflight(engine: Engine, signal?: AbortSignal): Promise<void> {
    const image = await this.run(engine, ['image', 'inspect', '--format', '{{.Os}}', this.options.image], signal)
    if (image.exitCode !== 0 && !/\bno such (?:image|object)\b/i.test(image.stderr)) throw failure('provider_unavailable')
    if (image.exitCode !== 0 || image.stdout.trim() !== 'linux') throw configurationFailure('invalid_guest_image', 'Provide an already-present digest-pinned Linux image; the adapter never pulls or builds images.')
  }
  private async engine(signal?: AbortSignal): Promise<Engine> {
    this.enginePromise ??= (async () => {
      const context = this.options.context ?? (await this.raw(['context', 'show'], signal)).stdout.trim()
      if (!context) throw failure('provider_unavailable')
      const endpoint = await this.raw(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}'], signal)
      const host = endpoint.stdout.trim()
      if (!host.startsWith('unix:///') || host.includes('\0') || endpoint.exitCode !== 0) throw configurationFailure('unsupported_docker_context', 'Docker sandbox requires a local Unix-socket context.')
      const result = await this.raw(['--host', host, 'info', '--format', '{{.ID}}\t{{.OSType}}'], signal)
      const [engineId, os] = result.stdout.trim().split('\t')
      if (result.exitCode !== 0 || !engineId) throw failure('provider_unavailable')
      if (os !== 'linux') throw configurationFailure('unsupported_docker_engine', 'Docker sandbox supports Linux containers only.')
      return { context, host, engineId }
    })().catch(error => { this.enginePromise = undefined; throw error })
    return await this.enginePromise
  }
  private async verifyEngine(record: Engine, signal?: AbortSignal): Promise<void> {
    const engine = await this.engine(signal)
    if (engine.engineId !== record.engineId || engine.host !== record.host) throw failure('engine_identity_changed')
    const current = await this.run(engine, ['info', '--format', '{{.ID}}\t{{.OSType}}'], signal)
    if (current.exitCode !== 0) throw failure('provider_unavailable')
    if (current.stdout.trim() !== `${record.engineId}\tlinux`) throw failure('engine_identity_changed')
  }
  private async raw(args: readonly string[], signal?: AbortSignal): Promise<DockerResult> {
    checkCancelled(signal)
    return await collect(await this.transport.start(args), { signal, timeoutMs: this.timeoutMs })
  }
  private async run(engine: Engine, args: readonly string[], signal?: AbortSignal): Promise<DockerResult> { return await this.raw(['--host', engine.host, ...args], signal) }
  private async command(engine: Engine, args: readonly string[], signal?: AbortSignal): Promise<string> {
    const result = await this.run(engine, args, signal)
    if (result.exitCode !== 0) throw failure('provider_operation_failed')
    return result.stdout
  }

  private async removeKnownContainer(name: string, signal?: AbortSignal): Promise<void> {
    const engine = await this.engine(signal)
    await this.cleanupCommand(engine, ['container', 'rm', '--force', name], 'container', signal)
  }

  private async stopKnownContainer(name: string, signal?: AbortSignal): Promise<void> {
    const engine = await this.engine(signal)
    await this.cleanupCommand(engine, ['container', 'stop', '--time', '1', name], 'container', signal)
  }

  private async removeKnownVolume(name: string, signal?: AbortSignal): Promise<void> {
    const engine = await this.engine(signal)
    await this.cleanupCommand(engine, ['volume', 'rm', name], 'volume', signal)
  }

  /**
   * A cleanup command is idempotent only for the exact provider acknowledgement
   * that the known resource is already absent. Other nonzero results (including
   * permissions, transport failures, and timeouts) remain retryable failures.
   */
  private async cleanupCommand(engine: Engine, args: readonly string[], kind: 'container' | 'volume', signal?: AbortSignal): Promise<void> {
    const result = await this.run(engine, args, signal)
    if (result.exitCode === 0 || isResourceNotFound(result.stderr, kind)) return
    throw failure('provider_operation_failed')
  }

}

function parseContract<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, issue: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ValidationError('Docker sandbox input is invalid.', { where: 'sandbox_options', issues: [issue] })
  return parsed.data
}

function resourceName(record: Pick<LifecycleRecord, 'key'>): string { return `purista_sb_${record.key}_g1` }
function environmentArgs(environment?: Record<string, string>): string[] {
  return Object.entries(environment ?? {}).flatMap(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw failure('invalid_environment')
    return ['--env', `${key}=${value}`]
  })
}

function canActOnOwner(owner: HarnessIdentity | undefined, actor: HarnessIdentity | undefined): boolean {
  if (owner?.tenantId !== undefined) {
    if (actor?.tenantId !== owner.tenantId) return false
  } else if (actor?.tenantId !== undefined) return false
  if (owner?.principalId !== undefined) return actor?.principalId === owner.principalId
  return owner !== undefined || actor?.principalId === undefined
}

/** Docker's stable missing-resource acknowledgement; it does not accept other CLI failures. */
function isResourceNotFound(stderr: string, kind: 'container' | 'volume'): boolean {
  return new RegExp(`\\bno such (?:${kind}|object)\\b`, 'i').test(stderr)
}
