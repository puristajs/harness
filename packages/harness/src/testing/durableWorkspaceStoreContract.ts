import { describe, expect, it } from 'vitest'

import type { DurableWorkspaceStore } from '../ports/workspace.js'
import { validateDurableWorkspaceStore } from '../ports/workspace.js'

/** Shared Vitest contract for durable workspace store implementations. */
export function durableWorkspaceStoreContract(make: () => DurableWorkspaceStore | Promise<DurableWorkspaceStore>): void {
  describe('durableWorkspaceStoreContract', () => {
    it('validates metadata and round-trips checkpointed workspaces', async () => {
      const adapter = await make()
      validateDurableWorkspaceStore(adapter)
      const signal = new AbortController().signal
      const handle = await adapter.startWorkspace({
        sessionId: 'session-1',
        runId: 'run-1',
        agentId: 'agent-1',
        attempt: 1,
        idempotencyKey: 'start-1',
        signal
      })
      const checkpoint = await adapter.pauseWorkspace({
        handle,
        stepId: 'step-1',
        sequence: 1,
        attempt: 1,
        reason: 'step_completed',
        idempotencyKey: 'pause-1',
        signal
      })
      const resumed = await adapter.resumeWorkspace({
        workspaceRef: handle.workspaceRef,
        checkpointRef: checkpoint.checkpointRef,
        sessionId: 'session-1',
        runId: 'run-2',
        attempt: 2,
        idempotencyKey: 'resume-1',
        signal
      })
      const inspection = await adapter.inspectWorkspace?.({ workspaceRef: resumed.workspaceRef, signal })

      expect(resumed.workspaceRef).toBe(handle.workspaceRef)
      expect(inspection?.checkpoints.map((item) => item.checkpointRef)).toEqual([checkpoint.checkpointRef])
    })
  })
}
