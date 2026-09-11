import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  HarnessConfigError,
  InMemoryHarnessStorage,
  OperationCancelledError,
  OperationTimeoutError,
  SandboxError,
  SandboxStateLostError,
  ValidationError,
  agentGuardrailsBinding,
  defineAgent,
  defineHarness,
  defineSkill,
  defineTool,
  inMemoryHarnessStorage,
  type HarnessAdapterContext,
  type SandboxScope,
  type SkillRuntimeId,
  type AgentGuardrailsBinding,
} from '@purista/harness'
import { FakeModelProvider, RecordingTelemetry, sandboxContract, sandboxTextSearchContract } from '@purista/harness/testing'
import { z } from 'zod'
import { dockerSandbox, type DockerSandboxOptions } from './index.js'
import { DockerSandbox } from './lifecycle.js'
import { ScriptedDocker } from './scripted-docker.test-utils.js'
import { collect, OUTPUT_LIMIT_BYTES } from './transport.js'

const image = `example.invalid/harness-tools@sha256:${'a'.repeat(64)}`
const scope = {
  owner: {
    namespace: 'docker-test',
    id: 'secret-session',
    instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7J',
  },
  partition: { kind: 'shared' },
  lifetime: 'run',
  runId: 'run-1',
} satisfies SandboxScope
const directories: string[] = []
const clients: DockerSandbox[] = []
const scopes = new Map<DockerSandbox, SandboxScope[]>()

class RestartableHarnessStorage extends InMemoryHarnessStorage {
  public constructor() {
    super()
    const capabilities = Object.freeze([...this.capabilities, 'storage.persistent'])
    Object.defineProperty(this, 'capabilities', {
      value: capabilities,
    })
    Object.defineProperty(this, 'info', {
      value: Object.freeze({ ...this.info, capabilities }),
    })
  }
  // Match durable storage adapters, whose close releases a handle but retains
  // the journaled session record used by the next Harness process.
  public override async close(): Promise<void> {}
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'purista-docker-test-'))
  directories.push(root)
  const transport = new ScriptedDocker()
  const adapter = new DockerSandbox({ root, image }, transport)
  clients.push(adapter)
  return { root, transport, adapter }
}
async function open(adapter: DockerSandbox, chosen: SandboxScope = scope) {
  scopes.set(adapter, [...(scopes.get(adapter) ?? []), chosen])
  await adapter.registerOwner({ owner: chosen.owner, mode: 'create' })
  return await adapter.open({
    scope: chosen,
    mode: 'create',
    ...(chosen.owner.identity ? { identity: chosen.owner.identity } : {}),
  })
}

function noLiveSessionHarness(adapter: DockerSandbox, storage = inMemoryHarnessStorage()) {
  const noopTool = defineTool('noopTool', {
    description: 'Returns its input.', input: z.string(), output: z.string(),
    requires: { sandbox: ['sandbox.fs'] }, handler: async (_context, input) => input,
  })
  const noopAgent = defineAgent('noopAgent', {
    model: 'chat',
    instructions: 'Call noopTool once.', tools: [noopTool], durable: true,
  })
  return defineHarness({ name: 'dockerNoLiveSession', revision: '1' }).addAgent(noopAgent).getInstance({
    models: { chat: { provider: new FakeModelProvider(), model: 'fake' } }, storage, sandbox: adapter,
  })
}

function runtimeGuardrails<const Runtimes extends readonly SkillRuntimeId[]>(runtimes: Runtimes): AgentGuardrailsBinding<{
  readonly skillRuntimes: Runtimes
}> {
  return {
    [agentGuardrailsBinding]: {
      id: 'runtimeGuard', requirements: { skillRuntimes: runtimes },
      beforeInput: () => ({ decision: 'allow' }),
    },
  }
}
afterEach(async () => {
  for (const adapter of clients.splice(0))
    for (const chosen of scopes.get(adapter) ?? [])
      await adapter.terminate({ scope: chosen, reason: 'manual' }).catch(() => undefined)
  scopes.clear()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('Docker sandbox public configuration', () => {
  it('supports no-live get, release, and close across a restart without Docker allocation', async () => {
    const { root, transport, adapter } = await fixture()
    const storage = new RestartableHarnessStorage()
    const first = await noLiveSessionHarness(adapter, storage)

    const session = await first.getSession('docker-no-live-owner')
    await expect(storage.getSession('docker-no-live-owner')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ registration: 'registered', relation: 'owned' }),
      }),
    )
    await session.release()
    await first.close()

    const resumedAdapter = new DockerSandbox({ root, image }, transport)
    clients.push(resumedAdapter)
    const resumed = await noLiveSessionHarness(resumedAdapter, storage)
    const recovered = await resumed.getSession('docker-no-live-owner')
    await recovered.release()
    await recovered.destroy()

    expect(transport.calls).toEqual([])
    expect(transport.containers.size).toBe(0)
    expect(transport.volumes.size).toBe(0)
  })

  it('validates closed options before invoking any CLI', () => {
    const invalid = [
      { root: 'relative', image },
      { root: '/private/data', image: 'image:latest' },
      { root: '/private/data', image, user: '0:0' },
      { root: '/private/data', image, user: '00:1' },
      { root: '/private/data', image, user: '1:0' },
      { root: '/private/data', image, privileged: true },
      { root: '/private/data', image, resources: { cpus: Number.NaN } },
      { root: '/private/data', image, resources: { pids: 1.5 } },
      { root: '/private/data', image, resources: { unknown: 1 } },
    ]
    for (const value of invalid) expect(() => dockerSandbox(value as DockerSandboxOptions)).toThrow(HarnessConfigError)
    expect(() => dockerSandbox({ root: '/private/data', image: `sha256:${'a'.repeat(64)}` })).not.toThrow()
    expectTypeOf(dockerSandbox({ root: '/private/data', image }).capabilities).toEqualTypeOf<
      readonly ['sandbox.fs', 'sandbox.text_search', 'sandbox.exec', 'sandbox.spawn', 'sandbox.persistent_fs']
    >()
  })

  it('publishes only explicit sorted frozen Skill runtime metadata', () => {
    const omitted = dockerSandbox({ root: '/private/data', image })
    const empty = dockerSandbox({ root: '/private/data', image, runtimes: [] })
    const supplied: SkillRuntimeId[] = ['shell', 'node', 'python']
    const configured = dockerSandbox({ root: '/private/data', image, runtimes: supplied })
    supplied.splice(0, supplied.length, 'shell')

    expect(omitted.runtimes).toEqual([])
    expect(empty.runtimes).toEqual([])
    expect(configured.runtimes).toEqual(['node', 'python', 'shell'])
    expect(Object.isFrozen(omitted.runtimes)).toBe(true)
    expect(Object.isFrozen(configured.runtimes)).toBe(true)
    expect(configured.capabilities).not.toContain('sandbox.readonly_mount')
    expectTypeOf(configured.runtimes).toEqualTypeOf<readonly SkillRuntimeId[]>()
  })

  it('rejects invalid Skill runtime metadata before any Docker effect', () => {
    const throwingRuntime = Object.defineProperty([], '0', {
      enumerable: true, get() { throw new Error('private runtime element') },
    })
    Object.defineProperty(throwingRuntime, 'length', { value: 1 })
    for (const runtimes of [['node', 'node'], ['ruby'], Array(1), throwingRuntime, 'node', null]) {
      const transport = new ScriptedDocker()
      let error: unknown
      try { new DockerSandbox({ root: '/private/data', image, runtimes } as never, transport) }
      catch (failure) { error = failure }
      expect(error).toMatchObject({ meta: { reason: 'invalid_configuration' } })
      expect(JSON.stringify(error)).not.toContain('private runtime element')
      expect(transport.calls).toEqual([])
    }
    expect(dockerSandbox({ root: '/private/data', image: `python-node-shell@sha256:${'a'.repeat(64)}` }).runtimes).toEqual([])
  })

  it('snapshots each explicit runtime element exactly once', () => {
    let reads = 0
    const runtimes = Object.defineProperty([], '0', {
      enumerable: true, get() { reads += 1; return reads === 1 ? 'node' : 'ruby' },
    })
    Object.defineProperty(runtimes, 'length', { value: 1 })
    const adapter = dockerSandbox({ root: '/private/data', image, runtimes } as never)
    expect(adapter.runtimes).toEqual(['node'])
    expect(reads).toBe(1)
  })

  it('uses explicit runtimes during Core instance preflight without opening a sandbox', async () => {
    const agent = defineAgent('runtimeGuardAgent', {
      model: 'chat',
      instructions: 'Return a short answer.', guardrails: runtimeGuardrails(['python']),
    })
    const definition = defineHarness({ name: 'dockerRuntimeGuard' }).addAgent(agent)
    const matching = dockerSandbox({ root: '/private/data', image, runtimes: ['python'] })
    const matchingOpen = vi.spyOn(matching, 'open')
    const instance = await definition.getInstance({
      models: { chat: { provider: new FakeModelProvider(), model: 'fake' } }, sandbox: matching,
    })
    expect(matchingOpen).not.toHaveBeenCalled()
    await instance.close()

    const missing = dockerSandbox({ root: '/private/data', image, runtimes: [] })
    const missingOpen = vi.spyOn(missing, 'open')
    expect(() => definition.getInstance({
      models: { chat: { provider: new FakeModelProvider(), model: 'fake' } }, sandbox: missing,
    })).toThrowError(expect.objectContaining({
      meta: { reason: 'missing_required_capability', path: 'sandbox.runtimes' },
    }))
    expect(missingOpen).not.toHaveBeenCalled()
  })

  it('does not claim read-only Skill mounting for a runtime-bearing Skill', async () => {
    const skill = defineSkill('runtime-skill', {
      directory: new URL('./fixtures/runtime-skill/', import.meta.url), runtimes: ['python'],
    })
    const agent = defineAgent('runtimeSkillAgent', {
      model: 'chat',
      instructions: 'Use the supplied Skill.', skills: [skill],
    })
    const definition = defineHarness({ name: 'dockerRuntimeSkill' }).addAgent(agent)
    const adapter = dockerSandbox({ root: '/private/data', image, runtimes: ['python'] })
    const open = vi.spyOn(adapter, 'open')
    expect(() => definition.getInstance({
      models: { chat: { provider: new FakeModelProvider(), model: 'fake' } }, sandbox: adapter,
    } as never)).toThrowError(expect.objectContaining({
      meta: { reason: 'missing_required_capability', path: 'sandbox.capabilities' },
    }))
    expect(open).not.toHaveBeenCalled()
    expect(adapter.capabilities).not.toContain('sandbox.readonly_mount')
  })

  it('normalizes hostile runtime access to a content-free configuration error', () => {
    const options = Object.defineProperty({ root: '/private/data', image }, 'runtimes', {
      enumerable: true, get() { throw new Error('private runtime getter') },
    })
    let error: unknown
    try { dockerSandbox(options) } catch (failure) { error = failure }
    expect(error).toEqual(expect.objectContaining({
      message: 'Docker sandbox configuration is invalid. Use an absolute metadata root, digest-pinned image, and positive resource limits.',
      meta: { reason: 'invalid_configuration' },
    }))
    expect(JSON.stringify(error)).not.toContain('private runtime getter')
  })

  it('rejects unsupported restore, invalid scope, and pre-cancelled open without CLI mutation', async () => {
    const { adapter, transport } = await fixture()
    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    await expect(adapter.open({ scope, mode: 'restore' })).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(
      adapter.open({ scope: { ...scope, partition: { kind: 'unknown' } } as unknown as SandboxScope, mode: 'create' }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(adapter.open({ scope, mode: 'create', signal: AbortSignal.abort('private') })).rejects.toBeInstanceOf(
      OperationCancelledError,
    )
    expect(transport.calls).toEqual([])
  })

  it('fails closed through the adapter facade when its durable owner journal is truncated', async () => {
    const { adapter, transport, root } = await fixture()
    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    await writeFile(join(root, 'docker-sandbox', 'ownership-journal.json'), '{')
    const resumed = new DockerSandbox({ root, image }, transport)
    await expect(resumed.registerOwner({ owner: scope.owner, mode: 'attach' })).rejects.toBeInstanceOf(
      SandboxStateLostError,
    )
    expect(transport.calls).toEqual([])
  })

  it('emits a redacted register-owner operation through the public adapter facade', async () => {
    const { adapter } = await fixture()
    const telemetry = new RecordingTelemetry()
    adapter.configureHarnessContext({
      telemetry,
      defaults: { toolTimeoutMs: 1_000 },
    } as unknown as HarnessAdapterContext)

    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })

    expect(telemetry.spans).toEqual([
      expect.objectContaining({
        name: 'harness.sandbox.register_owner',
        attrs: expect.objectContaining({
          'harness.sandbox.adapter': 'docker',
          'harness.sandbox.operation': 'register_owner',
          'harness.sandbox.outcome': 'success',
        }),
      }),
    ])
    expect(telemetry.metrics.map((metric) => metric.name)).toEqual([
      'harness.sandbox.operations',
      'harness.sandbox.operation.duration',
    ])
    expect(JSON.stringify(telemetry)).not.toContain('secret-session')
  })
})

describe('Docker lifecycle protocol', () => {
  it('exposes only owner-scoped administrative inventory and purges its exact private resources', async () => {
    const { adapter, transport } = await fixture()
    const { session } = await open(adapter)
    await session.close()

    const inventory = await adapter.administration.list({ selector: { kind: 'owner', owner: scope.owner }, limit: 10 })
    expect(inventory.items).toEqual([expect.objectContaining({ owner: scope.owner, scope, state: 'active' })])
    expect(JSON.stringify(inventory)).not.toContain('purista_sb_')

    await expect(
      adapter.administration.purge({ selector: { kind: 'owner', owner: scope.owner }, idempotencyKey: 'purge-owner' }),
    ).resolves.toEqual({ state: 'completed', deletedResources: 1, remainingResources: 0 })
    expect(transport.containers.size).toBe(0)
    expect(transport.volumes.size).toBe(0)
  })

  it('fences an already-open sibling partition as soon as owner purge commits revocation', async () => {
    const { adapter } = await fixture()
    const first = await open(adapter)
    const siblingScope: SandboxScope = { ...scope, partition: { kind: 'group', id: 'reviewers' } }
    const second = await adapter.open({ scope: siblingScope, mode: 'create' })
    const result = await adapter.administration.purge({
      selector: { kind: 'owner', owner: scope.owner },
      idempotencyKey: 'purge-owner',
      limit: 1,
    })
    expect(result).toMatchObject({ state: 'cleanup_pending', remainingResources: 1 })
    const attempts = await Promise.allSettled([
      first.session.write('/workspace/blocked-a', 'x'),
      second.session.write('/workspace/blocked-b', 'x'),
    ])
    expect(
      attempts.some(
        (attempt) =>
          attempt.status === 'rejected' &&
          typeof attempt.reason === 'object' &&
          attempt.reason !== null &&
          'meta' in attempt.reason &&
          typeof attempt.reason.meta === 'object' &&
          attempt.reason.meta !== null &&
          attempt.reason.meta['reason'] === 'owner_revoked',
      ),
    ).toBe(true)
  })

  it('revokes only the offboarded principal from an already-open tenant-owned partition', async () => {
    const { adapter } = await fixture()
    const owner = {
      ...scope.owner,
      id: 'tenant-shared',
      instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7K',
      identity: { tenantId: 'tenant-a' },
    }
    const sharedScope: SandboxScope = { ...scope, owner }
    scopes.set(adapter, [sharedScope])
    await adapter.registerOwner({ owner, mode: 'create' })
    const first = await adapter.open({
      scope: sharedScope,
      mode: 'create',
      identity: { tenantId: 'tenant-a', principalId: 'principal-a' },
    })
    const second = await adapter.open({
      scope: sharedScope,
      mode: 'create',
      identity: { tenantId: 'tenant-a', principalId: 'principal-b' },
    })

    await expect(
      adapter.administration.purge({
        selector: { kind: 'principal', namespace: owner.namespace, tenantId: 'tenant-a', principalId: 'principal-a' },
        idempotencyKey: 'offboard-principal-a',
      }),
    ).resolves.toEqual({ state: 'completed', deletedResources: 0, remainingResources: 0 })

    await expect(first.session.write('/workspace/revoked', 'x')).rejects.toMatchObject({
      meta: { reason: 'principal_revoked' },
    })
    await expect(second.session.write('/workspace/available', 'x')).resolves.toBeUndefined()
  })

  it('creates once with secure defaults; shares same-client attachments and reattaches after release', async () => {
    const { adapter, transport, root } = await fixture()
    scopes.set(adapter, [scope])
    await adapter.registerOwner({ owner: scope.owner, mode: 'create' })
    const [first, second] = await Promise.all([
      adapter.open({ scope, mode: 'create' }),
      adapter.open({ scope, mode: 'create' }),
    ])
    expect([first.disposition, second.disposition]).toEqual(['created', 'attached'])
    const callCount = transport.calls.length
    inspect(first.session)
    expect(transport.calls).toHaveLength(callCount)
    await first.session.write('/workspace/a', 'retained')
    await first.session.close()
    await expect(second.session.readText('/workspace/a')).resolves.toBe('retained')
    await second.session.close()
    const client = new DockerSandbox({ root, image }, transport)
    await client.registerOwner({ owner: scope.owner, mode: 'attach' })
    const attached = await client.open({ scope, mode: 'attach' })
    await expect(attached.session.readText('/workspace/a')).resolves.toBe('retained')
    await attached.session.close()
    const runs = transport.calls.filter((args) => args.includes('run'))
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual(
      expect.arrayContaining([
        '--pull',
        'never',
        '--network',
        'none',
        '--user',
        '1000:1000',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--cpus',
        '1',
        '--memory',
        '512m',
        '--pids-limit',
        '128',
      ]),
    )
    expect(runs[0]?.join(' ')).not.toContain(root)
    expect(runs[0]?.join(' ')).not.toContain('secret-session')
    expect(runs[0]?.join(' ')).not.toContain('private-tenant')
    expect(runs[0]?.join(' ')).not.toContain('private-user')
    const allState = await Promise.all(
      (await readdir(join(root, 'docker-sandbox'))).map((file) => readFile(join(root, 'docker-sandbox', file), 'utf8')),
    )
    // The private, mode-0600 ownership journal may retain sensitive owner
    // metadata for exact restart/offboarding recovery; Docker labels never do.
    expect(allState.some((value) => value.includes('secret-session'))).toBe(true)
  })

  it('rejects independent concurrent owners without changing resources', async () => {
    const { adapter, transport, root } = await fixture()
    await open(adapter)
    const client = new DockerSandbox({ root, image }, transport)
    await client.registerOwner({ owner: scope.owner, mode: 'attach' })
    await expect(client.open({ scope, mode: 'attach' })).rejects.toMatchObject({
      meta: { reason: 'ownership_conflict' },
    })
    await expect(client.terminate({ scope, reason: 'manual' })).rejects.toMatchObject({
      meta: { reason: 'ownership_conflict' },
    })
    expect(transport.containers.size).toBe(1)
  })

  it('preserves complete scope identity independent of key insertion order', async () => {
    const { adapter, transport } = await fixture()
    const first = await open(adapter)
    const reordered = {
      runId: scope.runId,
      lifetime: scope.lifetime,
      partition: { kind: 'shared' },
      owner: {
        instanceId: scope.owner.instanceId,
        id: scope.owner.id,
        namespace: scope.owner.namespace,
      },
    } satisfies SandboxScope
    const second = await adapter.open({ scope: reordered, mode: 'attach' })
    await first.session.write('/workspace/id', 'same')
    await expect(second.session.readText('/workspace/id')).resolves.toBe('same')
    await open(adapter, { ...scope, owner: { ...scope.owner, id: 'empty-identity' } })
    const unscoped = { ...scope, owner: { ...scope.owner, id: 'unscoped' } }
    await open(adapter, unscoped)
    expect(transport.containers.size).toBe(3)
  })

  it('retains terminal intent through partial cleanup and retries only its exact resources', async () => {
    const { adapter, transport } = await fixture()
    const { session } = await open(adapter)
    transport.failure = (args) =>
      args[0] === 'volume' && args[1] === 'rm' ? { code: 1, stderr: 'private daemon details' } : undefined
    await expect(adapter.terminate({ scope, reason: 'manual' })).rejects.toBeInstanceOf(SandboxError)
    expect(transport.containers.size).toBe(0)
    expect(transport.volumes.size).toBe(1)
    await expect(session.read('/workspace/a')).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(adapter.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
    transport.failure = undefined
    await adapter.terminate({ scope, reason: 'manual' })
    await adapter.terminate({ scope, reason: 'manual' })
    expect(transport.volumes.size).toBe(0)
    await expect(adapter.open({ scope, mode: 'create' })).rejects.toBeInstanceOf(SandboxStateLostError)
    expect(transport.calls.some((call) => call.includes('prune'))).toBe(false)
  })

  it('treats Docker acknowledged missing cleanup resources as terminal success', async () => {
    const { adapter, transport } = await fixture()
    await (await open(adapter)).session.close()
    transport.failure = (args) => {
      if (args[0] === 'container' && (args[1] === 'stop' || args[1] === 'rm')) {
        return { code: 1, stderr: 'Error response from daemon: No such container: recorded-scope' }
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
        return { code: 1, stderr: 'Error response from daemon: No such volume: recorded-scope' }
      }
      return undefined
    }

    await expect(adapter.terminate({ scope, reason: 'manual' })).resolves.toBeUndefined()
    await expect(adapter.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
  })

  it('keeps unrelated Docker cleanup failures pending', async () => {
    const { adapter, transport } = await fixture()
    await (await open(adapter)).session.close()
    transport.failure = (args) =>
      args[0] === 'container' && args[1] === 'stop'
        ? { code: 1, stderr: 'permission denied by private engine policy' }
        : undefined

    await expect(adapter.terminate({ scope, reason: 'manual' })).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'guest_cleanup_failed' },
    })
  })

  it.each(['container', 'volume', 'metadata'] as const)('does not replace missing %s', async (missing) => {
    const { adapter, transport, root } = await fixture()
    const { session } = await open(adapter)
    await session.close()
    if (missing === 'container') transport.containers.clear()
    if (missing === 'volume') transport.volumes.clear()
    if (missing === 'metadata') {
      const record = (await readdir(join(root, 'docker-sandbox'))).find(
        (name) => name.endsWith('.json') && !name.endsWith('.owner.json'),
      )!
      await rm(join(root, 'docker-sandbox', record))
    }
    await expect(adapter.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(adapter.open({ scope, mode: 'create' })).rejects.toBeInstanceOf(SandboxStateLostError)
    expect(transport.calls.filter((args) => args.includes('run'))).toHaveLength(1)
  })

  it('does not classify outage, permissions, or a changed engine as state loss', async () => {
    const { adapter, transport } = await fixture()
    const { session } = await open(adapter)
    await session.close()
    transport.failure = (args) =>
      args[1] === 'inspect' && args[0] === 'container'
        ? { code: 1, stderr: 'permission denied at private socket' }
        : undefined
    const failed = adapter.open({ scope, mode: 'attach' })
    await expect(failed).rejects.toBeInstanceOf(SandboxError)
    await expect(failed).rejects.not.toBeInstanceOf(SandboxStateLostError)
    await expect(failed).rejects.not.toThrow('private socket')
    transport.failure = undefined
    transport.engine = 'different-engine'
    await expect(adapter.open({ scope, mode: 'attach' })).rejects.toMatchObject({
      meta: { reason: 'engine_identity_changed' },
    })
  })

  it('pins the Unix endpoint rather than following subsequent active context changes', async () => {
    const { adapter, transport } = await fixture()
    const { session } = await open(adapter)
    transport.host = 'unix:///other-engine.sock'
    await session.write('/workspace/a', 'data')
    expect(
      transport.calls.filter((call) => call[0] === '--host').every((call) => call[1] === 'unix:///test-docker.sock'),
    ).toBe(true)
  })

  it('rejects changed image or resource policy on attach while preserving explicit cleanup', async () => {
    const { adapter, transport, root } = await fixture()
    await (await open(adapter)).session.close()
    for (const overrides of [
      { network: 'bridge' as const },
      { user: '2000:2000' },
      { image: `sha256:${'b'.repeat(64)}` },
      { resources: { pids: 256 } },
    ]) {
      const changed = new DockerSandbox({ root, image, ...overrides }, transport)
      await changed.registerOwner({ owner: scope.owner, mode: 'attach' })
      await expect(changed.open({ scope, mode: 'attach' })).rejects.toMatchObject({
        meta: { reason: 'sandbox_policy_changed' },
      })
    }
    expect(transport.containers.size).toBe(1)
    const changed = new DockerSandbox({ root, image, network: 'bridge' }, transport)
    await changed.registerOwner({ owner: scope.owner, mode: 'attach' })
    await changed.terminate({ scope, reason: 'manual' })
    expect(transport.containers.size).toBe(0)
  })

  it('stops retained guest work before granting a fresh owner when owner metadata is absent', async () => {
    const { adapter, transport, root } = await fixture()
    await (await open(adapter)).session.close()
    transport.containers.values().next().value!.running = true
    const before = transport.calls.length
    const fresh = new DockerSandbox({ root, image }, transport)
    await fresh.registerOwner({ owner: scope.owner, mode: 'attach' })
    const attached = await fresh.open({ scope, mode: 'attach' })
    const calls = transport.calls.slice(before)
    expect(calls.findIndex((call) => call.includes('stop'))).toBeGreaterThan(-1)
    expect(calls.findIndex((call) => call.includes('stop'))).toBeLessThan(
      calls.findIndex((call) => call.includes('start')),
    )
    await attached.session.close()
  })

  it('rejects remote engines and missing image utilities before accepting a sandbox', async () => {
    const first = await fixture()
    first.transport.host = 'tcp://remote.example:2376'
    await expect(open(first.adapter)).rejects.toMatchObject({ meta: { reason: 'unsupported_docker_context' } })
    expect(first.transport.containers.size).toBe(0)
    const second = await fixture()
    second.transport.failure = (args) =>
      args.some((arg) => arg.includes('for tool in')) ? { code: 1, stderr: 'private path' } : undefined
    await expect(open(second.adapter)).rejects.toMatchObject({ meta: { reason: 'invalid_guest_image' } })
    expect(second.transport.containers.size).toBe(0)
    expect(second.transport.volumes.size).toBe(0)
  })

  it('recovers a confirmed dead owner only after stopping retained guest work', async () => {
    const { adapter, transport, root } = await fixture()
    const { session } = await open(adapter)
    await session.close()
    const directory = join(root, 'docker-sandbox')
    const record = (await readdir(directory)).find((name) => name.endsWith('.json'))!
    await writeFile(
      join(directory, record.replace('.json', '.owner')),
      JSON.stringify({ pid: 2_147_483_647, token: '715bcebf-e48f-4976-8e74-f61d6d1ba9dc' }),
    )
    transport.containers.values().next().value!.running = true
    const before = transport.calls.length
    const resumed = await adapter.open({ scope, mode: 'attach' })
    const calls = transport.calls.slice(before)
    expect(calls.findIndex((call) => call.includes('stop'))).toBeLessThan(
      calls.findIndex((call) => call.includes('start')),
    )
    await resumed.session.close()
  })
})

describe('Docker guest operations', () => {
  it('roundtrips binary data and delimiter-containing filenames without leaking metadata', async () => {
    const { adapter } = await fixture()
    const { session } = await open(adapter)
    const name = '/workspace/line\nwith\ttabs.bin'
    await session.write(name, new Uint8Array([0, 255, 128, 1]))
    expect([...(await session.read(name))]).toEqual([0, 255, 128, 1])
    expect(await session.list('/workspace')).toEqual([
      { path: name, name: 'line\nwith\ttabs.bin', kind: 'file', size: 4 },
    ])
    expect(await session.stat(name)).toMatchObject({ kind: 'file', size: 4 })
    await expect(session.write('/workspace/../escape', 'no')).rejects.toBeInstanceOf(SandboxError)
    await expect(session.mount(new Map([['../escape', 'no']]), '/skills')).rejects.toBeInstanceOf(SandboxError)
  })

  it('returns guest nonzero exit codes and stderr without putting content in errors', async () => {
    const { adapter, transport } = await fixture()
    const { session } = await open(adapter)
    transport.failure = (args) =>
      args.includes('fail-command') ? { stdout: 'user result', stderr: 'user stderr', code: 23 } : undefined
    await expect(session.exec('fail-command')).resolves.toMatchObject({
      stdout: 'user result',
      stderr: 'user stderr',
      exitCode: 23,
    })
  })

  it('confirms guest stop on timeout and permits retained-file reattachment', async () => {
    const { adapter, transport } = await fixture()
    const { session } = await open(adapter)
    await session.write('/workspace/a', 'retained')
    await expect(session.exec('sleep 1', { timeoutMs: 5 })).rejects.toBeInstanceOf(OperationTimeoutError)
    expect(transport.containers.values().next().value!.running).toBe(false)
    expect(transport.killedClients).toBeGreaterThan(0)
    await session.close()
    const next = await adapter.open({ scope, mode: 'attach' })
    await expect(next.session.readText('/workspace/a')).resolves.toBe('retained')
  })

  it('bounds output and confirms guest cleanup instead of silently truncating', async () => {
    const { adapter, transport } = await fixture()
    const { session } = await open(adapter)
    transport.failure = (args) =>
      args.includes('too-much') ? { stdout: Buffer.alloc(OUTPUT_LIMIT_BYTES + 1) } : undefined
    await expect(session.exec('too-much')).rejects.toMatchObject({ meta: { reason: 'output_limit_exceeded' } })
    expect(transport.containers.values().next().value!.running).toBe(false)
  })

  it('fails cleanup visibly and retains ownership until an explicit successful close retry', async () => {
    const { adapter, transport, root } = await fixture()
    const { session } = await open(adapter)
    transport.failure = (args) => (args.includes('stop') ? { code: 1, stderr: 'private daemon' } : undefined)
    await expect(session.exec('sleep 1', { timeoutMs: 5 })).rejects.toBeInstanceOf(SandboxError)
    await expect(session.close()).rejects.toBeInstanceOf(SandboxError)
    const other = new DockerSandbox({ root, image }, transport)
    await other.registerOwner({ owner: scope.owner, mode: 'attach' })
    await expect(other.open({ scope, mode: 'attach' })).rejects.toMatchObject({
      meta: { reason: 'ownership_conflict' },
    })
    transport.failure = undefined
    await session.close()
    await (await other.open({ scope, mode: 'attach' })).session.close()
  })

  it('uses streaming spawn handles and stops guest processes when the attachment closes', async () => {
    const { adapter, transport } = await fixture()
    const { session } = await open(adapter)
    // Public capability inference is also verified by this typed call.
    const process = await session.spawn('node')
    await process.writeStdin('request\n')
    expect(transport.writes).toEqual(['request\n'])
    await session.close()
    await expect(process.exit).resolves.toMatchObject({ exitCode: 137 })
    await expect(process.writeStdin('stale')).rejects.toBeInstanceOf(SandboxError)
  })

  it('honors explicit SIGKILL and confirms guest exit before resolving kill', async () => {
    const { adapter, transport } = await fixture()
    const { session } = await open(adapter)
    const process = await session.spawn('node')
    await process.kill('SIGKILL')
    await expect(process.exit).resolves.toMatchObject({ exitCode: 137 })
    expect(transport.containers.values().next().value!.running).toBe(false)
    expect(
      transport.calls.some((call) => call.includes('kill') && call.includes('--signal') && call.includes('KILL')),
    ).toBe(true)
    await process.kill('SIGKILL')
    expect(transport.calls.filter((call) => call.includes('kill'))).toHaveLength(1)
  })

  it('decodes split UTF-8 sequences and preserves per-stream output bounds', async () => {
    const encoder = new TextEncoder()
    const bytes = encoder.encode('€')
    const child = {
      stdout: (async function* () {
        yield bytes.slice(0, 1)
        yield bytes.slice(1)
      })(),
      stderr: (async function* () {})(),
      exit: Promise.resolve({ exitCode: 0 }),
      end() {},
      kill() {},
      async write() {},
    }
    await expect(collect(child)).resolves.toMatchObject({ stdout: '€', stderr: '', exitCode: 0 })
  })
})

sandboxContract(async () => (await fixture()).adapter, { executor: 'available' })
sandboxTextSearchContract(async () => (await fixture()).adapter)
