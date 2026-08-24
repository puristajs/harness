import { describe, expect, it } from 'vitest'

import { WorkspaceError, WorkspaceQuotaExceededError } from '../errors/index.js'
import type { DurableWorkspace } from '../ports/workspace.js'
import { validateDurableWorkspace } from '../ports/workspace.js'

/** Shared Vitest contract for durable workspace implementations (spec 21 §18). */
export function durableWorkspaceContract(make: () => DurableWorkspace | Promise<DurableWorkspace>): void {
  describe('durableWorkspaceContract', () => {
    const signal = new AbortController().signal

    it('validates metadata and round-trips checkpointed workspaces', async () => {
      const adapter = await make()
      validateDurableWorkspace(adapter)
      const handle = await adapter.startWorkspace({ sessionId: 'session-1', runId: 'run-1', agentId: 'agent-1', attempt: 1, idempotencyKey: 'start-1', signal })
      const checkpoint = await adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause-1', signal })
      const resumed = await adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, checkpointRef: checkpoint.checkpointRef, sessionId: 'session-1', runId: 'run-2', attempt: 2, idempotencyKey: 'resume-1', signal })
      const inspection = await adapter.inspectWorkspace?.({ workspaceRef: resumed.workspaceRef, signal })

      expect(resumed.workspaceRef).toBe(handle.workspaceRef)
      expect(inspection?.checkpoints.map((item) => item.checkpointRef)).toEqual([checkpoint.checkpointRef])
    })

    it('start is idempotent and conflicts on a reused key with a different identity', async () => {
      const adapter = await make()
      const first = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'k', signal })
      const replay = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'k', signal })
      expect(replay.workspaceRef).toBe(first.workspaceRef)
      await expect(adapter.startWorkspace({ sessionId: 's2', runId: 'r2', attempt: 1, idempotencyKey: 'k', signal })).rejects.toMatchObject({
        constructor: WorkspaceError,
        meta: { reason: 'idempotency_conflict' }
      })
    })

    it('replays pause and resume results for repeated idempotency keys', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      const checkpoint = await adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })
      const replayedCheckpoint = await adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })
      expect(replayedCheckpoint.checkpointRef).toBe(checkpoint.checkpointRef)
      expect(replayedCheckpoint.committedAt).toBe(checkpoint.committedAt)

      const resumed = await adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's', runId: 'r2', attempt: 2, idempotencyKey: 'resume', signal })
      const replayedResume = await adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's', runId: 'r2', attempt: 2, idempotencyKey: 'resume', signal })
      expect(replayedResume.workspaceRef).toBe(resumed.workspaceRef)
      expect(replayedResume.startedAt).toBe(resumed.startedAt)
    })

    it('conflicts when pause reuses a key under a different run/session', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      await adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'op', signal })
      const otherHandle = { ...handle, runId: 'r2', sessionId: 's2' }
      await expect(adapter.pauseWorkspace({ handle: otherHandle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'op', signal })).rejects.toMatchObject({
        constructor: WorkspaceError,
        meta: { reason: 'idempotency_conflict' }
      })
    })

    it('conflicts when resume reuses a key under a different run/session', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      await adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's', runId: 'r2', attempt: 2, idempotencyKey: 'op', signal })
      await expect(adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's3', runId: 'r3', attempt: 2, idempotencyKey: 'op', signal })).rejects.toMatchObject({
        constructor: WorkspaceError,
        meta: { reason: 'idempotency_conflict' }
      })
    })

    it('conflicts when abort reuses a key under a different run/session', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      await adapter.abortWorkspace?.({ workspaceRef: handle.workspaceRef, runId: 'r', sessionId: 's', reason: 'cancelled', idempotencyKey: 'op', signal })
      await expect(adapter.abortWorkspace?.({ workspaceRef: handle.workspaceRef, runId: 'r2', sessionId: 's2', reason: 'cancelled', idempotencyKey: 'op', signal })).rejects.toMatchObject({
        constructor: WorkspaceError,
        meta: { reason: 'idempotency_conflict' }
      })
    })

    it('conflicts when a key crosses operation kinds (pause then resume)', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      await adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'shared', signal })
      await expect(adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'shared', signal })).rejects.toMatchObject({
        constructor: WorkspaceError,
        meta: { reason: 'idempotency_conflict' }
      })
    })

    it('inspects a workspace through one of its checkpoint refs', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      const checkpoint = await adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })
      const inspection = await adapter.inspectWorkspace?.({ checkpointRef: checkpoint.checkpointRef, signal })
      expect(inspection?.workspaceRef).toBe(handle.workspaceRef)
      expect(inspection?.checkpoints.map((item) => item.checkpointRef)).toContain(checkpoint.checkpointRef)
    })

    it('rejects pause on an aborted workspace and replays the abort result', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      const aborted = await adapter.abortWorkspace?.({ workspaceRef: handle.workspaceRef, runId: 'r', sessionId: 's', reason: 'cancelled', idempotencyKey: 'abort', signal })
      const abortedAgain = await adapter.abortWorkspace?.({ workspaceRef: handle.workspaceRef, runId: 'r', sessionId: 's', reason: 'cancelled', idempotencyKey: 'abort', signal })
      expect(abortedAgain?.state).toBe('aborted')
      expect(abortedAgain?.abortedAt).toBe(aborted?.abortedAt)
      await expect(adapter.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })).rejects.toMatchObject({
        constructor: WorkspaceError,
        meta: { reason: 'aborted' }
      })
    })

    it('blocks resume after abort and is idempotent on repeated cleanup', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      await adapter.abortWorkspace?.({ workspaceRef: handle.workspaceRef, runId: 'r', sessionId: 's', reason: 'cancelled', idempotencyKey: 'abort', signal })
      await expect(adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's', runId: 'r2', attempt: 2, idempotencyKey: 'resume', signal })).rejects.toMatchObject({
        constructor: WorkspaceError,
        meta: { reason: 'aborted' }
      })
      const cleaned = await adapter.cleanupWorkspace?.({ workspaceRef: handle.workspaceRef, reason: 'aborted', idempotencyKey: 'cleanup-1', signal })
      expect(cleaned?.state).toBe('cleaned')
      const cleanedAgain = await adapter.cleanupWorkspace?.({ workspaceRef: handle.workspaceRef, reason: 'aborted', idempotencyKey: 'cleanup-2', signal })
      expect(cleanedAgain?.state).toBe('cleaned')
    })

    it('resume of a cleaned workspace reports not_found', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      await adapter.cleanupWorkspace?.({ workspaceRef: handle.workspaceRef, reason: 'manual', idempotencyKey: 'cleanup', signal })
      await expect(adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, sessionId: 's', runId: 'r2', attempt: 2, idempotencyKey: 'resume', signal })).rejects.toMatchObject({
        constructor: WorkspaceError,
        meta: { reason: 'not_found' }
      })
    })

    it('missing checkpoint on resume reports missing_checkpoint', async () => {
      const adapter = await make()
      const handle = await adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal })
      await expect(adapter.resumeWorkspace({ workspaceRef: handle.workspaceRef, checkpointRef: 'nope', sessionId: 's', runId: 'r2', attempt: 2, idempotencyKey: 'resume', signal })).rejects.toMatchObject({
        constructor: WorkspaceError,
        meta: { reason: 'missing_checkpoint' }
      })
    })

    it('cancellation surfaces OperationCancelledError with workspace scope', async () => {
      const adapter = await make()
      const aborted = AbortSignal.abort()
      await expect(adapter.startWorkspace({ sessionId: 's', runId: 'r', attempt: 1, idempotencyKey: 'start', signal: aborted })).rejects.toMatchObject({
        code: 'OPERATION_CANCELLED',
        meta: { scope: 'workspace' }
      })
    })

    it('enforces the active workspace quota when advertised', async () => {
      const adapter = await make()
      const quota = adapter.info?.policy?.quota?.maxActiveWorkspaces
      if (!quota || quota > 200) return // only exercise small, declared quotas
      for (let i = 0; i < quota; i += 1) {
        await adapter.startWorkspace({ sessionId: 's', runId: `r${i}`, attempt: 1, idempotencyKey: `start-${i}`, signal })
      }
      await expect(adapter.startWorkspace({ sessionId: 's', runId: 'overflow', attempt: 1, idempotencyKey: 'overflow', signal })).rejects.toBeInstanceOf(WorkspaceQuotaExceededError)
    })
  })
}
