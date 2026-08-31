import {
  SandboxStateLostError,
  type SandboxScope,
} from '@purista/harness'
import {
  durableWorkspaceContract,
  sandboxContract,
  sandboxMultiClientContract,
  sandboxTextSearchContract,
  RecordingTelemetry,
} from '@purista/harness/testing'
import type { HarnessAdapterContext } from '@purista/harness'
import { describe, expect, it } from 'vitest'
import { kubernetesSandboxRuntime } from './runtime.js'
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
