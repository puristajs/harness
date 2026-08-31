import path from 'node:path'

import {
  OperationCancelledError,
  SandboxError,
  SandboxPermissionDeniedError,
  SandboxStateLostError,
  sandboxOwnerRegistrationOptionsSchema,
  validateSandboxTextSearchRequest,
  type AdapterCapability,
  type DirEntry,
  type ExecOptions,
  type ExecResult,
  type FileStat,
  type HarnessAdapterContext,
  type HarnessIdentity,
  type Sandbox,
  type SandboxOpenOptions,
  type SandboxOpenResult,
  type SandboxOwner,
  type SandboxOwnerRegistrationOptions,
  type SandboxScope,
  type SandboxSessionFor,
  type SandboxTerminateOptions,
  type SandboxTextSearchRequest,
  type SandboxTextSearchResult,
  withSandboxTelemetry,
} from '@purista/harness'
import {
  sandboxScopeKey,
  validateSandboxOpenOptions,
  validateSandboxTerminateOptions,
} from '@purista/harness/adapter'
import { KubernetesSandboxAdministration } from './administration.js'
import {
  actorLogicalKey,
  controlRecordName,
  mutateRecord,
  nowIso,
  ownerLogicalKey,
  throwIfAborted,
  type KubernetesOwnerRecord,
  type KubernetesSandboxRecord,
  type KubernetesWorkspaceCoordinator,
} from './control.js'
import type { KubernetesSandboxDriver, VersionedKubernetesRecord } from './driver.js'
import { kubernetesResourceName } from './driver.js'

/** Capabilities advertised by a Kubernetes sandbox without durable-workspace coordination. */
export const KUBERNETES_SANDBOX_CAPABILITIES = Object.freeze([
  'sandbox.fs',
  'sandbox.text_search',
  'sandbox.exec',
  'sandbox.persistent_fs',
] as const satisfies readonly AdapterCapability[])

/** Capabilities advertised when the sandbox is paired with the Kubernetes durable workspace. */
export const KUBERNETES_WORKSPACE_SANDBOX_CAPABILITIES = Object.freeze([
  ...KUBERNETES_SANDBOX_CAPABILITIES,
  'sandbox.workspace_binding',
] as const satisfies readonly AdapterCapability[])

/** Low-level construction options for platform wrappers that do not use the runtime factory. */
export interface KubernetesSandboxAdapterOptions {
  /** Kubernetes infrastructure boundary. */
  readonly driver: KubernetesSandboxDriver
  /** Stable namespace for all Kubernetes object names owned by this Harness runtime. */
  readonly runtimeId: string
  /** Optional durable-workspace coordinator paired with sandbox run scopes. */
  readonly coordinator?: KubernetesWorkspaceCoordinator
  /** Reviewed non-root sandbox image. */
  readonly image: string
  /** Container selected for exec operations. */
  readonly containerName: string
  /** Tokenless service account assigned to generated Pods. */
  readonly serviceAccountName?: string
  /** Optional stronger-isolation RuntimeClass. */
  readonly runtimeClassName?: string
  /** Container image pull behavior. */
  readonly imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
  /** Requested PVC size. */
  readonly volumeSize: string
  /** StorageClass used for generated PVCs. */
  readonly storageClassName?: string
  /** Maximum wait for Pod readiness in milliseconds. */
  readonly podReadyTimeoutMs: number
  /** Default command wall-clock limit in milliseconds. */
  readonly defaultCommandTimeoutMs: number
  /** Sandbox container CPU limit. */
  readonly cpuLimit: string
  /** Sandbox container memory limit. */
  readonly memoryLimit: string
  /** Sandbox container ephemeral-storage limit. */
  readonly ephemeralStorageLimit: string
}

type KubernetesCapabilities = readonly AdapterCapability[]

/** Kubernetes implementation of the provider-neutral Harness `Sandbox` port. */
export class KubernetesSandboxAdapter implements Sandbox<KubernetesCapabilities> {
  public readonly capabilities: KubernetesCapabilities
  public readonly telemetryAdapterId = 'kubernetes'
  public readonly administration: KubernetesSandboxAdministration
  private logger: HarnessAdapterContext['logger'] | undefined
  private telemetry: HarnessAdapterContext['telemetry'] | undefined

  /** Creates the low-level sandbox adapter; most applications use `kubernetesSandboxRuntime()`. */
  public constructor(private readonly options: KubernetesSandboxAdapterOptions) {
    this.capabilities = options.coordinator
      ? KUBERNETES_WORKSPACE_SANDBOX_CAPABILITIES
      : KUBERNETES_SANDBOX_CAPABILITIES
    this.administration = new KubernetesSandboxAdministration(options.driver)
  }

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.logger = context.logger
    this.telemetry = context.telemetry
    this.administration.configureHarnessContext(context)
  }

  public async registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void> {
    return withSandboxTelemetry(this.telemetry, this.telemetryAdapterId, 'register_owner', async () => this.registerOwnerUnsafe(options))
  }

  private async registerOwnerUnsafe(options: SandboxOwnerRegistrationOptions): Promise<void> {
    const parsed = sandboxOwnerRegistrationOptionsSchema.parse(options)
    throwIfAborted(parsed.signal)
    const name = ownerRecordName(this.options.runtimeId, parsed.owner)
    const existing = await this.options.driver.readRecord<KubernetesOwnerRecord>(name)
    if (existing) {
      if (ownerLogicalKey(existing.value.owner) !== ownerLogicalKey(parsed.owner)) {
        throw new SandboxPermissionDeniedError('owner_not_authorized')
      }
      return
    }
    if (parsed.mode === 'attach') throw this.stateLostForOwner()
    const timestamp = nowIso()
    const created = await this.options.driver.createRecord(name, 'owner', {
      kind: 'owner', owner: parsed.owner, createdAt: timestamp, updatedAt: timestamp, revokedActors: [],
    } satisfies KubernetesOwnerRecord)
    if (!created) {
      const winner = await this.options.driver.readRecord<KubernetesOwnerRecord>(name)
      if (!winner || ownerLogicalKey(winner.value.owner) !== ownerLogicalKey(parsed.owner)) {
        throw new SandboxPermissionDeniedError('owner_not_authorized')
      }
    }
  }

  public async open(options: SandboxOpenOptions): Promise<SandboxOpenResult<KubernetesCapabilities>> {
    validateSandboxOpenOptions(options)
    throwIfAborted(options.signal)
    const owner = await this.requireOwner(options.scope.owner)
    this.assertActor(owner, options.identity)
    const logicalKey = sandboxScopeKey(options.scope)
    const recordName = sandboxRecordName(this.options.runtimeId, logicalKey)
    let current = await this.options.driver.readRecord<KubernetesSandboxRecord>(recordName)

    if (!current) {
      if (options.mode !== 'create') throw this.stateLost(options.scope, 'lifecycle_state_missing')
      const binding = await this.options.coordinator?.bindingForScope(options.scope)
      const generation = 1
      const timestamp = nowIso()
      const record: KubernetesSandboxRecord = {
        kind: 'sandbox',
        scope: options.scope,
        state: 'provisioning',
        generation,
        podName: podName(this.options.runtimeId, logicalKey, generation),
        volumeName: binding?.volumeName ?? volumeName(this.options.runtimeId, logicalKey),
        ...(binding ? { workspaceRef: binding.workspaceRef } : {}),
        ownsVolume: binding === undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
        revokedActors: [],
      }
      const created = await this.options.driver.createRecord(recordName, 'sandbox', record)
      current = created
        ? await this.options.driver.readRecord<KubernetesSandboxRecord>(recordName)
        : await this.options.driver.readRecord<KubernetesSandboxRecord>(recordName)
      if (!current) throw this.stateLost(options.scope, 'creation_indeterminate')
      if (created) {
        await this.provision(recordName, current, options.signal)
        current = await this.options.driver.readRecord<KubernetesSandboxRecord>(recordName)
        if (!current) throw this.stateLost(options.scope, 'creation_indeterminate')
        return this.opened(current.value, options.identity, 'created')
      }
    }

    if (options.mode === 'restore') return this.restore(recordName, current, options)
    const active = await this.awaitActive(recordName, current, options.signal)
    if (active.state === 'terminated') throw this.stateLost(options.scope, 'scope_terminated')
    if (active.state !== 'active' || !active.podName) throw this.stateLost(options.scope, 'provider_missing')
    if (!await this.options.driver.podExists(active.podName)) {
      await this.markLost(recordName)
      throw this.stateLost(options.scope, 'provider_missing')
    }
    return this.opened(active, options.identity, 'attached')
  }

  public async terminate(options: SandboxTerminateOptions): Promise<void> {
    validateSandboxTerminateOptions(options)
    throwIfAborted(options.signal)
    const logicalKey = sandboxScopeKey(options.scope)
    const recordName = sandboxRecordName(this.options.runtimeId, logicalKey)
    let current = await this.options.driver.readRecord<KubernetesSandboxRecord>(recordName)
    if (!current) {
      const timestamp = nowIso()
      const tombstone: KubernetesSandboxRecord = {
        kind: 'sandbox', scope: options.scope, state: 'terminated', generation: 1,
        ownsVolume: false, createdAt: timestamp, updatedAt: timestamp, revokedActors: [],
      }
      await this.options.driver.createRecord(recordName, 'sandbox', tombstone)
      return
    }
    if (current.value.state !== 'terminated') {
      current = await mutateRecord<KubernetesSandboxRecord>(this.options.driver, recordName, 'sandbox', (record) => ({
        ...record, state: 'terminated', updatedAt: nowIso(),
      }), options.signal)
    }
    if (current.value.podName) await this.options.driver.deletePod(current.value.podName)
    if (current.value.ownsVolume && current.value.volumeName) await this.options.driver.deleteVolume(current.value.volumeName)
  }

  private async provision(
    recordName: string,
    versioned: VersionedKubernetesRecord<KubernetesSandboxRecord>,
    signal?: AbortSignal,
  ): Promise<void> {
    const record = versioned.value
    if (!record.podName || !record.volumeName) throw this.stateLost(record.scope, 'creation_indeterminate')
    try {
      await this.options.driver.ensureVolume({
        name: record.volumeName,
        size: this.options.volumeSize,
        ...(this.options.storageClassName ? { storageClassName: this.options.storageClassName } : {}),
      })
      await this.options.driver.ensurePod(this.podOptions(record.podName, record.volumeName, recordName))
      await this.options.driver.waitForPodReady(record.podName, this.options.podReadyTimeoutMs, signal)
      await mutateRecord<KubernetesSandboxRecord>(this.options.driver, recordName, 'sandbox', (current) => {
        if (current.generation !== record.generation || current.state === 'terminated') return current
        return { ...current, state: 'active', updatedAt: nowIso() }
      }, signal)
    } catch (error) {
      await this.markLost(recordName).catch(() => undefined)
      await this.options.driver.deletePod(record.podName).catch(() => undefined)
      this.logger?.warn('Kubernetes sandbox provisioning failed.', { error_type: error instanceof Error ? error.name : 'UnknownError' })
      throw error
    }
  }

  private async restore(
    recordName: string,
    current: VersionedKubernetesRecord<KubernetesSandboxRecord>,
    options: SandboxOpenOptions,
  ): Promise<SandboxOpenResult<KubernetesCapabilities>> {
    if (current.value.state === 'active' || current.value.state === 'provisioning') {
      throw this.stateLost(options.scope, 'durable_workspace_recovery_unavailable')
    }
    if (current.value.state === 'terminated') throw this.stateLost(options.scope, 'scope_terminated')
    const binding = await this.options.coordinator?.bindingForScope(options.scope)
    if (!binding?.restoreReady) throw this.stateLost(options.scope, 'durable_workspace_required')
    if (!await this.options.driver.volumeExists(binding.volumeName)) {
      throw this.stateLost(options.scope, 'durable_workspace_recovery_unavailable')
    }
    const generation = current.value.generation + 1
    const next = await mutateRecord<KubernetesSandboxRecord>(this.options.driver, recordName, 'sandbox', (record) => {
      if (record.state !== 'state_lost') return record
      return {
        ...record,
        state: 'provisioning',
        generation,
        podName: podName(this.options.runtimeId, sandboxScopeKey(options.scope), generation),
        volumeName: binding.volumeName,
        workspaceRef: binding.workspaceRef,
        ownsVolume: false,
        updatedAt: nowIso(),
      }
    }, options.signal)
    if (next.value.state !== 'provisioning' || next.value.generation !== generation) {
      throw this.stateLost(options.scope, 'creation_indeterminate')
    }
    await this.provision(recordName, next, options.signal)
    const restored = await this.options.driver.readRecord<KubernetesSandboxRecord>(recordName)
    if (!restored || restored.value.state !== 'active') throw this.stateLost(options.scope, 'creation_indeterminate')
    return this.opened(restored.value, options.identity, 'restored')
  }

  private async awaitActive(
    recordName: string,
    initial: VersionedKubernetesRecord<KubernetesSandboxRecord>,
    signal?: AbortSignal,
  ): Promise<KubernetesSandboxRecord> {
    let current = initial.value
    const deadline = Date.now() + this.options.podReadyTimeoutMs
    while (current.state === 'provisioning' && Date.now() < deadline) {
      throwIfAborted(signal)
      await delay(25, signal)
      const next = await this.options.driver.readRecord<KubernetesSandboxRecord>(recordName)
      if (!next) throw this.stateLost(current.scope, 'creation_indeterminate')
      current = next.value
    }
    return current
  }

  private opened(
    record: KubernetesSandboxRecord,
    identity: HarnessIdentity | undefined,
    disposition: 'created' | 'attached' | 'restored',
  ): SandboxOpenResult<KubernetesCapabilities> {
    if (!record.podName) throw this.stateLost(record.scope, 'provider_missing')
    return {
      session: new KubernetesSandboxSession(
        this.options.driver,
        recordNameForScope(this.options.runtimeId, record.scope),
        record.scope,
        record.generation,
        record.podName,
        identity,
        this.options.defaultCommandTimeoutMs,
        this.options.runtimeId,
      ),
      disposition,
      liveProcessState: disposition === 'restored' ? 'restarted' : 'not_preserved',
    }
  }

  private async requireOwner(owner: SandboxOwner): Promise<KubernetesOwnerRecord> {
    const record = await this.options.driver.readRecord<KubernetesOwnerRecord>(ownerRecordName(this.options.runtimeId, owner))
    if (!record || ownerLogicalKey(record.value.owner) !== ownerLogicalKey(owner)) throw this.stateLostForOwner()
    return record.value
  }

  private assertActor(owner: KubernetesOwnerRecord, identity: HarnessIdentity | undefined): void {
    if (owner.owner.identity === undefined && identity !== undefined) throw new SandboxPermissionDeniedError('scope_mismatch')
    if (owner.owner.identity?.tenantId !== undefined && owner.owner.identity.tenantId !== identity?.tenantId) {
      throw new SandboxPermissionDeniedError('scope_mismatch')
    }
    if (owner.owner.identity?.principalId !== undefined && owner.owner.identity.principalId !== identity?.principalId) {
      throw new SandboxPermissionDeniedError('scope_mismatch')
    }
    if (owner.revokedActors.includes(actorLogicalKey(identity))) throw new SandboxPermissionDeniedError('principal_revoked')
  }

  private async markLost(recordName: string): Promise<void> {
    await mutateRecord<KubernetesSandboxRecord>(this.options.driver, recordName, 'sandbox', (record) =>
      record.state === 'terminated' ? record : { ...record, state: 'state_lost', updatedAt: nowIso() })
  }

  private podOptions(name: string, volume: string, recordName: string) {
    return {
      name,
      volumeName: volume,
      image: this.options.image,
      containerName: this.options.containerName,
      ...(this.options.serviceAccountName ? { serviceAccountName: this.options.serviceAccountName } : {}),
      ...(this.options.runtimeClassName ? { runtimeClassName: this.options.runtimeClassName } : {}),
      imagePullPolicy: this.options.imagePullPolicy,
      cpuLimit: this.options.cpuLimit,
      memoryLimit: this.options.memoryLimit,
      ephemeralStorageLimit: this.options.ephemeralStorageLimit,
      labels: { 'purista.dev/sandbox-record': recordName },
    } as const
  }

  private stateLost(scope: SandboxScope, reason: ConstructorParameters<typeof SandboxStateLostError>[1]['reason']): SandboxStateLostError {
    return new SandboxStateLostError('Kubernetes sandbox state is unavailable.', {
      reason, lifetime: scope.lifetime, adapter_id: 'kubernetes',
    })
  }

  private stateLostForOwner(): SandboxStateLostError {
    return new SandboxStateLostError('Kubernetes sandbox owner metadata is unavailable.', {
      reason: 'owner_missing', lifetime: 'session', adapter_id: 'kubernetes',
    })
  }
}

class KubernetesSandboxSession implements SandboxSessionFor<KubernetesCapabilities> {
  public readonly executor = 'available' as const
  private closed = false

  public constructor(
    private readonly driver: KubernetesSandboxDriver,
    private readonly recordName: string,
    private readonly scope: SandboxScope,
    private readonly generation: number,
    private readonly podName: string,
    private readonly identity: HarnessIdentity | undefined,
    private readonly defaultCommandTimeoutMs: number,
    private readonly runtimeId: string,
  ) {}

  public async read(filePath: string): Promise<Uint8Array> {
    await this.assertActive()
    return this.driver.readFile(this.podName, sandboxPath(filePath))
  }

  public async readText(filePath: string): Promise<string> {
    return new TextDecoder().decode(await this.read(filePath))
  }

  public async write(filePath: string, data: Uint8Array | string): Promise<void> {
    await this.assertActive()
    await this.driver.writeFile(this.podName, sandboxPath(filePath), typeof data === 'string' ? new TextEncoder().encode(data) : data)
  }

  public async remove(filePath: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await this.assertActive()
    await this.driver.removeFile(this.podName, sandboxPath(filePath), opts.recursive ?? false)
  }

  public async list(filePath: string, opts: { recursive?: boolean; glob?: string } = {}): Promise<DirEntry[]> {
    await this.assertActive()
    return this.driver.listFiles(this.podName, sandboxPath(filePath), opts.recursive ?? false, opts.glob)
  }

  public async stat(filePath: string): Promise<FileStat> {
    await this.assertActive()
    return this.driver.statFile(this.podName, sandboxPath(filePath))
  }

  public async exists(filePath: string): Promise<boolean> {
    await this.assertActive()
    return this.driver.fileExists(this.podName, sandboxPath(filePath))
  }

  public async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> {
    const root = sandboxPath(atPath)
    for (const [relative, data] of files) {
      if (relative.startsWith('/') || relative.split('/').some((segment) => segment === '..')) {
        throw new SandboxError('Sandbox mount path is invalid.', { reason: 'invalid_path' })
      }
      await this.write(path.posix.join(root, relative), data)
    }
  }

  public async searchText(request: SandboxTextSearchRequest): Promise<SandboxTextSearchResult> {
    validateSandboxTextSearchRequest(request)
    await this.assertActive(request.signal)
    return this.driver.searchText(this.podName, request)
  }

  public async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    await this.assertActive(opts.signal)
    const tokens = tokenizeCommand(command)
    if (tokens.length === 0) throw new SandboxError('Sandbox command is empty.', { reason: 'exec_failed' })
    return this.driver.runCommand({
      podName: this.podName,
      command: tokens,
      timeoutMs: opts.timeoutMs ?? this.defaultCommandTimeoutMs,
      ...(opts.cwd ? { cwd: sandboxPath(opts.cwd) } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  }

  public async close(): Promise<void> {
    this.closed = true
  }

  private async assertActive(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new SandboxError('Sandbox attachment is closed.', { reason: 'attachment_closed' })
    if (signal?.aborted) throw new OperationCancelledError('Kubernetes sandbox operation was cancelled.', { scope: 'sandbox' })
    const owner = await this.driver.readRecord<KubernetesOwnerRecord>(ownerRecordName(this.runtimeId, this.scope.owner))
    if (!owner || owner.value.revokedActors.includes(actorLogicalKey(this.identity))) {
      throw new SandboxPermissionDeniedError('principal_revoked')
    }
    const current = await this.driver.readRecord<KubernetesSandboxRecord>(this.recordName)
    if (!current || current.value.state !== 'active' || current.value.generation !== this.generation || current.value.podName !== this.podName) {
      throw new SandboxStateLostError('Kubernetes sandbox attachment is stale.', {
        reason: current?.value.state === 'terminated' ? 'scope_terminated' : 'provider_missing',
        lifetime: this.scope.lifetime,
        adapter_id: 'kubernetes',
      })
    }
    if (current.value.revokedActors.includes(actorLogicalKey(this.identity))) {
      throw new SandboxPermissionDeniedError('principal_revoked')
    }
    if (!await this.driver.podExists(this.podName)) {
      throw new SandboxStateLostError('Kubernetes sandbox pod is unavailable.', {
        reason: 'provider_missing', lifetime: this.scope.lifetime, adapter_id: 'kubernetes',
      })
    }
  }
}

function ownerRecordName(runtimeId: string, owner: SandboxOwner): string {
  return controlRecordName('ph-own', `${runtimeId}:${ownerLogicalKey(owner)}`)
}

function recordNameForScope(runtimeId: string, scope: SandboxScope): string {
  return sandboxRecordName(runtimeId, sandboxScopeKey(scope))
}

function sandboxRecordName(runtimeId: string, logicalKey: string): string {
  return controlRecordName('ph-sbx', `${runtimeId}:${logicalKey}`)
}

function podName(runtimeId: string, logicalKey: string, generation: number): string {
  return kubernetesResourceName('ph-pod', `${runtimeId}:${logicalKey}:${generation}`)
}

function volumeName(runtimeId: string, logicalKey: string): string {
  return kubernetesResourceName('ph-vol', `${runtimeId}:${logicalKey}`)
}

function sandboxPath(value: string): string {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('\\')) {
    throw new SandboxError('Sandbox path is invalid.', { reason: 'invalid_path' })
  }
  const normalized = path.posix.normalize(value)
  const contained = normalized === '/workspace'
    || normalized.startsWith('/workspace/')
    || normalized === '/skills'
    || normalized.startsWith('/skills/')
  if (value.split('/').some((segment) => segment === '..') || !contained) {
    throw new SandboxError('Sandbox path is outside the workspace.', { reason: 'invalid_path' })
  }
  return normalized
}

function tokenizeCommand(command: string): readonly string[] {
  if (/[\0\r\n]/.test(command)) {
    throw new SandboxError('Sandbox commands cannot contain control-line separators.', { reason: 'exec_failed' })
  }
  const tokens: string[] = []
  let token = ''
  let quote: 'single' | 'double' | undefined
  let escaped = false
  for (const character of command.trim()) {
    if (escaped) { token += character; escaped = false; continue }
    if (character === '\\') { escaped = true; continue }
    if (character === "'" && quote !== 'double') { quote = quote === 'single' ? undefined : 'single'; continue }
    if (character === '"' && quote !== 'single') { quote = quote === 'double' ? undefined : 'double'; continue }
    if (/\s/.test(character) && !quote) {
      if (token) { tokens.push(token); token = '' }
      continue
    }
    token += character
  }
  if (escaped || quote) throw new SandboxError('Sandbox command quoting is invalid.', { reason: 'exec_failed' })
  if (token) tokens.push(token)
  return tokens
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    const abort = (): void => {
      clearTimeout(timeout)
      reject(new OperationCancelledError('Kubernetes sandbox operation was cancelled.', { scope: 'sandbox' }))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
