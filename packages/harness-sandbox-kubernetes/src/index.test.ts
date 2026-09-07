import {
  HarnessConfigError,
  SandboxStateLostError,
  agentGuardrailsBinding,
  defineAgent,
  defineHarness,
  defineSkill,
  type AgentGuardrailsBinding,
  type SandboxScope,
  type SkillRuntimeId,
} from '@purista/harness'
import {
  durableWorkspaceContract,
  sandboxContract,
  sandboxMultiClientContract,
  sandboxTextSearchContract,
  RecordingTelemetry,
  FakeModelProvider,
} from '@purista/harness/testing'
import type { HarnessAdapterContext } from '@purista/harness'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { kubernetesSandboxRuntime } from './runtime.js'
import { KubernetesSandboxAdapter } from './sandbox.js'
import { InMemoryKubernetesSandboxDriver } from './test-driver.js'

function runtime(
  driver = new InMemoryKubernetesSandboxDriver(),
  workspace: false | true = false,
  runtimeId = 'purista-harness',
) {
  return kubernetesSandboxRuntime({
    namespace: 'test',
    image: 'sandbox:test',
    runtimeId,
    driver,
    workspace,
  })
}

function runtimeGuardrails(runtimes: readonly SkillRuntimeId[]): AgentGuardrailsBinding<{
  readonly skillRuntimes: readonly SkillRuntimeId[]
}> {
  return {
    [agentGuardrailsBinding]: {
      id: 'runtimeGuard', requirements: { skillRuntimes: runtimes },
      beforeInput: () => ({ decision: 'allow' }),
    },
  }
}

sandboxContract(() => runtime().sandbox, { executor: 'available' })
sandboxTextSearchContract(() => runtime().sandbox)
sandboxMultiClientContract(() => {
  const driver = new InMemoryKubernetesSandboxDriver()
  return [runtime(driver).sandbox, runtime(driver).sandbox]
})
durableWorkspaceContract(() => runtime(new InMemoryKubernetesSandboxDriver(), true).workspace!)

describe('kubernetesSandboxRuntime', () => {
  it('emits content-free telemetry for owner registration and administration', async () => {
    const execution = runtime()
    const telemetry = new RecordingTelemetry()
    const context: HarnessAdapterContext = {
      harnessName: 'sandbox-test',
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } },
      telemetry,
      metrics: { counter() {}, histogram() {}, duration: async (_name, _attrs, action) => action() },
      contentCaptureMode: 'NO_CONTENT',
      defaults: { agentMaxIterations: 1, runTimeoutMs: 1, toolTimeoutMs: 1, decisionTimeoutMs: 1, skillTimeoutMs: 1, modelTimeoutMs: 1, maxParallelToolCalls: 1 },
    }
    execution.sandbox.configureHarnessContext?.(context)
    const owner = { namespace: 'private-tenant', id: 'private-session', instanceId: '01J00000000000000000000000' } as const
    await execution.sandbox.registerOwner({ owner, mode: 'create' })
    await execution.sandbox.administration.list({ selector: { kind: 'owner', owner }, limit: 10 })

    expect(telemetry.spans.map((span) => span.name)).toEqual(expect.arrayContaining([
      'harness.sandbox.register_owner',
      'harness.sandbox.list',
    ]))
    expect(JSON.stringify(telemetry)).not.toContain('private-tenant')
    expect(JSON.stringify(telemetry)).not.toContain('private-session')
  })

  it('keeps durable workspace support opt-in and closes idempotently', async () => {
    const driver = new InMemoryKubernetesSandboxDriver()
    const basic = runtime(driver)
    expect(basic.workspace).toBeUndefined()
    expect(basic.sandbox.capabilities).not.toContain('sandbox.workspace_binding')
    await Promise.all([basic.close(), basic.close()])
    expect(driver.closeCalls).toBe(1)

    const durable = runtime(new InMemoryKubernetesSandboxDriver(), true)
    expect(durable.workspace).toBeDefined()
    expect(durable.sandbox.capabilities).toContain('sandbox.workspace_binding')
  })

  it('rejects unknown or invalid options before constructing a client', () => {
    expect(() => kubernetesSandboxRuntime({ namespace: '', image: 'sandbox:test' })).toThrow()
    expect(() => kubernetesSandboxRuntime({ namespace: 'test', image: 'sandbox:test', unexpected: true } as never)).toThrow()
  })

  it('publishes only explicit sorted frozen Skill runtime metadata', () => {
    const omitted = kubernetesSandboxRuntime({ namespace: 'test', image: 'python-node-shell:latest', driver: new InMemoryKubernetesSandboxDriver() })
    const empty = kubernetesSandboxRuntime({ namespace: 'test', image: 'sandbox:test', driver: new InMemoryKubernetesSandboxDriver(), runtimes: [] })
    const supplied: SkillRuntimeId[] = ['shell', 'node', 'python']
    const configured = kubernetesSandboxRuntime({
      namespace: 'test', image: 'sandbox:test', driver: new InMemoryKubernetesSandboxDriver(), runtimes: supplied,
    })
    supplied.splice(0, supplied.length, 'shell')

    expect(omitted.sandbox.runtimes).toEqual([])
    expect(empty.sandbox.runtimes).toEqual([])
    expect(configured.sandbox.runtimes).toEqual(['node', 'python', 'shell'])
    expect(Object.isFrozen(omitted.sandbox.runtimes)).toBe(true)
    expect(Object.isFrozen(configured.sandbox.runtimes)).toBe(true)
    expect(configured.sandbox.capabilities).not.toContain('sandbox.readonly_mount')
    expectTypeOf(configured.sandbox.runtimes).toEqualTypeOf<readonly SkillRuntimeId[]>()

    const durable = kubernetesSandboxRuntime({
      namespace: 'test', image: 'sandbox:test', driver: new InMemoryKubernetesSandboxDriver(), runtimes: ['shell'], workspace: true,
    })
    expectTypeOf(omitted.sandbox.runtimes).toEqualTypeOf<readonly SkillRuntimeId[]>()
    expectTypeOf(durable.sandbox.runtimes).toEqualTypeOf<readonly SkillRuntimeId[]>()
    expect(durable.sandbox.runtimes).toEqual(['shell'])
  })

  it('rejects invalid Skill runtime metadata before any Kubernetes effect', () => {
    const throwingRuntime = Object.defineProperty([], '0', {
      enumerable: true, get() { throw new Error('private runtime element') },
    })
    Object.defineProperty(throwingRuntime, 'length', { value: 1 })
    for (const runtimes of [['node', 'node'], ['ruby'], Array(1), throwingRuntime, 'node', null]) {
      const driver = new InMemoryKubernetesSandboxDriver()
      let error: unknown
      try { kubernetesSandboxRuntime({ namespace: 'test', image: 'sandbox:test', driver, runtimes } as never) }
      catch (failure) { error = failure }
      expect(error).toEqual(expect.objectContaining({
        message: 'Kubernetes sandbox runtime configuration is invalid.',
        meta: { reason: 'invalid_option', path: 'options.runtimes' },
      }))
      expect(error).toBeInstanceOf(HarnessConfigError)
      expect(JSON.stringify(error)).not.toContain('private runtime element')
      expect(driver.closeCalls).toBe(0)
    }
  })

  it('snapshots each explicit runtime element exactly once', () => {
    let reads = 0
    const runtimes = Object.defineProperty([], '0', {
      enumerable: true, get() { reads += 1; return reads === 1 ? 'node' : 'ruby' },
    })
    Object.defineProperty(runtimes, 'length', { value: 1 })
    const execution = kubernetesSandboxRuntime({
      namespace: 'test', image: 'sandbox:test', driver: new InMemoryKubernetesSandboxDriver(), runtimes,
    } as never)
    expect(execution.sandbox.runtimes).toEqual(['node'])
    expect(reads).toBe(1)
  })

  it('validates runtime metadata on the low-level adapter boundary', () => {
    const driver = new InMemoryKubernetesSandboxDriver()
    const options = {
      driver, runtimeId: 'low-level', image: 'sandbox:test', containerName: 'workspace', imagePullPolicy: 'Never' as const,
      volumeSize: '1Gi', podReadyTimeoutMs: 1_000, defaultCommandTimeoutMs: 1_000,
      cpuLimit: '1', memoryLimit: '1Gi', ephemeralStorageLimit: '1Gi',
    }
    const adapter = new KubernetesSandboxAdapter({ ...options, runtimes: ['python'] })
    expect(adapter.runtimes).toEqual(['python'])
    expect(Object.isFrozen(adapter.runtimes)).toBe(true)
    expectTypeOf(adapter.runtimes).toEqualTypeOf<readonly SkillRuntimeId[]>()
    expect(() => new KubernetesSandboxAdapter({ ...options, runtimes: ['python', 'python'] } as never)).toThrowError(
      expect.objectContaining({ meta: { reason: 'invalid_option', path: 'options.runtimes' } }),
    )
    expect(() => new KubernetesSandboxAdapter({ ...options, runtimes: Array(1) } as never)).toThrowError(
      expect.objectContaining({ meta: { reason: 'invalid_option', path: 'options.runtimes' } }),
    )
    const hostile = Object.defineProperty({ ...options }, 'runtimes', {
      enumerable: true, get() { throw new Error('private low-level getter') },
    })
    let error: unknown
    try { new KubernetesSandboxAdapter(hostile) } catch (failure) { error = failure }
    expect(error).toEqual(expect.objectContaining({
      message: 'Kubernetes sandbox runtime configuration is invalid.',
      meta: { reason: 'invalid_option', path: 'options.runtimes' },
    }))
    expect(JSON.stringify(error)).not.toContain('private low-level getter')
  })

  it('uses explicit runtimes during Core instance preflight without opening a sandbox', async () => {
    const agent = defineAgent('runtimeGuardAgent', {
      instructions: 'Return a short answer.', guardrails: runtimeGuardrails(['python']),
    })
    const definition = defineHarness({ name: 'kubernetesRuntimeGuard' }).addAgent(agent)
    const matching = kubernetesSandboxRuntime({
      namespace: 'test', image: 'sandbox:test', driver: new InMemoryKubernetesSandboxDriver(), runtimes: ['python'],
    })
    const matchingOpen = vi.spyOn(matching.sandbox, 'open')
    const instance = await definition.getInstance({
      model: { provider: new FakeModelProvider(), model: 'fake' }, sandbox: matching.sandbox,
    })
    expect(matchingOpen).not.toHaveBeenCalled()
    await instance.close()

    const missing = kubernetesSandboxRuntime({
      namespace: 'test', image: 'sandbox:test', driver: new InMemoryKubernetesSandboxDriver(), runtimes: [],
    })
    const missingOpen = vi.spyOn(missing.sandbox, 'open')
    expect(() => definition.getInstance({
      model: { provider: new FakeModelProvider(), model: 'fake' }, sandbox: missing.sandbox,
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
      instructions: 'Use the supplied Skill.', skills: [skill],
    })
    const definition = defineHarness({ name: 'kubernetesRuntimeSkill' }).addAgent(agent)
    const execution = kubernetesSandboxRuntime({
      namespace: 'test', image: 'sandbox:test', driver: new InMemoryKubernetesSandboxDriver(), runtimes: ['python'],
    })
    const open = vi.spyOn(execution.sandbox, 'open')
    expect(() => definition.getInstance({
      model: { provider: new FakeModelProvider(), model: 'fake' }, sandbox: execution.sandbox,
    } as never)).toThrowError(expect.objectContaining({
      meta: { reason: 'missing_required_capability', path: 'sandbox.capabilities' },
    }))
    expect(open).not.toHaveBeenCalled()
    expect(execution.sandbox.capabilities).not.toContain('sandbox.readonly_mount')
  })

  it('normalizes hostile runtime access to a content-free configuration error', () => {
    const options = Object.defineProperty({
      namespace: 'test', image: 'sandbox:test', driver: new InMemoryKubernetesSandboxDriver(),
    }, 'runtimes', {
      enumerable: true, get() { throw new Error('private runtime getter') },
    })
    let error: unknown
    try { kubernetesSandboxRuntime(options) } catch (failure) { error = failure }
    expect(error).toEqual(expect.objectContaining({
      message: 'Kubernetes sandbox runtime configuration is invalid.',
      meta: { reason: 'invalid_option', path: 'options.runtimes' },
    }))
    expect(JSON.stringify(error)).not.toContain('private runtime getter')
  })

  it('isolates runtimes with matching logical owner and run identifiers in one namespace', async () => {
    const driver = new InMemoryKubernetesSandboxDriver()
    const left = runtime(driver, true, 'payments-a')
    const right = runtime(driver, true, 'payments-b')
    const owner = { namespace: 'kubernetes-test', id: 'session', instanceId: '01J00000000000000000000000' } as const
    const scope: SandboxScope = { owner, partition: { kind: 'shared' }, lifetime: 'run', runId: 'run' }

    const [leftWorkspace, rightWorkspace] = await Promise.all([
      left.workspace.startWorkspace({
        runId: 'run', sessionId: 'session', sandboxOwner: owner,
        sandboxPolicyDigest: 'a'.repeat(64), attempt: 1, idempotencyKey: 'start',
      }),
      right.workspace.startWorkspace({
        runId: 'run', sessionId: 'session', sandboxOwner: owner,
        sandboxPolicyDigest: 'a'.repeat(64), attempt: 1, idempotencyKey: 'start',
      }),
    ])
    expect(leftWorkspace.workspaceRef).not.toBe(rightWorkspace.workspaceRef)

    await Promise.all([
      left.sandbox.registerOwner({ owner, mode: 'create' }),
      right.sandbox.registerOwner({ owner, mode: 'create' }),
    ])
    const [leftOpen, rightOpen] = await Promise.all([
      left.sandbox.open({ scope, mode: 'create' }),
      right.sandbox.open({ scope, mode: 'create' }),
    ])
    await leftOpen.session.write('/workspace/runtime.txt', 'left')
    await rightOpen.session.write('/workspace/runtime.txt', 'right')
    await expect(leftOpen.session.readText('/workspace/runtime.txt')).resolves.toBe('left')
    await expect(rightOpen.session.readText('/workspace/runtime.txt')).resolves.toBe('right')
  })

  it('restores the committed PVC snapshot and fences the old pod generation', async () => {
    const execution = runtime(new InMemoryKubernetesSandboxDriver(), true)
    const owner = { namespace: 'kubernetes-test', id: 'session', instanceId: '01J00000000000000000000000' } as const
    const scope: SandboxScope = { owner, partition: { kind: 'shared' }, lifetime: 'run', runId: 'run' }
    const handle = await execution.workspace!.startWorkspace({
      runId: 'run', sessionId: 'session', sandboxOwner: owner,
      sandboxPolicyDigest: 'a'.repeat(64), attempt: 1, idempotencyKey: 'start',
    })
    await execution.sandbox.registerOwner({ owner, mode: 'create' })
    const first = await execution.sandbox.open({ scope, mode: 'create' })
    await first.session.write('/workspace/value.txt', 'committed')
    const checkpoint = await execution.workspace!.pauseWorkspace({
      handle, sandboxPartitions: [scope.partition], stepId: 'write', sequence: 1,
      attempt: 1, reason: 'step_completed', idempotencyKey: 'pause',
    })
    await first.session.write('/workspace/value.txt', 'uncommitted')
    await execution.workspace!.resumeWorkspace({
      workspaceRef: handle.workspaceRef, checkpointRef: checkpoint.checkpointRef,
      runId: 'run', sessionId: 'session', attempt: 2, idempotencyKey: 'resume',
    })
    await expect(first.session.write('/workspace/stale.txt', 'denied')).rejects.toBeInstanceOf(SandboxStateLostError)
    const restored = await execution.sandbox.open({ scope, mode: 'restore' })
    await expect(restored.session.readText('/workspace/value.txt')).resolves.toBe('committed')
  })
})
