import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { SandboxScope, WorkspaceHandle } from '@purista/harness'
import { kubernetesSandboxRuntime } from '../src/index.js'

const live = process.env.PURISTA_KUBERNETES_LIVE === '1'

describe.runIf(live)('Kubernetes sandbox live contract', () => {
  it('creates a pod/PVC, restores a committed VolumeSnapshot, fences the old pod, and cleans up', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const execution = kubernetesSandboxRuntime({
      namespace: required('PURISTA_KUBERNETES_NAMESPACE'),
      image: required('PURISTA_KUBERNETES_SANDBOX_IMAGE'),
      runtimeId: `live-${suffix}`,
      ...(process.env.PURISTA_KUBERNETES_SERVICE_ACCOUNT
        ? { serviceAccountName: process.env.PURISTA_KUBERNETES_SERVICE_ACCOUNT }
        : {}),
      workspace: { snapshotClassName: required('PURISTA_KUBERNETES_SNAPSHOT_CLASS') },
      podReadyTimeoutMs: 120_000,
    })
    const owner = {
      namespace: 'kubernetes-live',
      id: `owner-${suffix}`,
      instanceId: '01J00000000000000000000000',
    } as const
    const runId = `run-${suffix}`
    const scope: SandboxScope = { owner, partition: { kind: 'shared' }, lifetime: 'run', runId }
    let handle: WorkspaceHandle | undefined

    try {
      handle = await execution.workspace.startWorkspace({
        runId,
        sessionId: `session-${suffix}`,
        sandboxOwner: owner,
        sandboxPolicyDigest: 'a'.repeat(64),
        attempt: 1,
        idempotencyKey: `start-${suffix}`,
      })
      await execution.sandbox.registerOwner({ owner, mode: 'create' })
      const first = await execution.sandbox.open({ scope, mode: 'create' })
      await first.session.write('/workspace/value.txt', 'committed')
      const checkpoint = await execution.workspace.pauseWorkspace({
        handle,
        sandboxPartitions: [scope.partition],
        stepId: 'live-write-v1',
        sequence: 1,
        attempt: 1,
        reason: 'step_completed',
        idempotencyKey: `pause-${suffix}`,
      })
      await first.session.write('/workspace/value.txt', 'uncommitted')
      await execution.workspace.resumeWorkspace({
        workspaceRef: handle.workspaceRef,
        checkpointRef: checkpoint.checkpointRef,
        runId,
        sessionId: handle.sessionId,
        attempt: 2,
        idempotencyKey: `resume-${suffix}`,
      })
      await expect(first.session.write('/workspace/stale.txt', 'denied')).rejects.toBeDefined()
      const restored = await execution.sandbox.open({ scope, mode: 'restore' })
      await expect(restored.session.readText('/workspace/value.txt')).resolves.toBe('committed')
      await execution.sandbox.terminate({ scope, reason: 'terminal' })
      await execution.workspace.finish({
        workspaceRef: handle.workspaceRef,
        runId,
        status: 'succeeded',
        idempotencyKey: `finish-${suffix}`,
      })
    } finally {
      if (handle) {
        await execution.workspace.cleanupWorkspace?.({
          workspaceRef: handle.workspaceRef,
          reason: 'manual',
          idempotencyKey: `cleanup-${suffix}`,
        }).catch(() => undefined)
      }
      await execution.close()
    }
  }, 300_000)
})

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required when PURISTA_KUBERNETES_LIVE=1`)
  return value
}

