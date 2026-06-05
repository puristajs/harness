import { describe, expect, it } from 'vitest'

import {
  DurableRunLeaseError,
  DurableTerminalRunError,
  inMemoryDurableRuntime,
  isTerminalRunStatus
} from '../src/index.js'
import type { DurableRuntime, RunCheckpoint } from '../src/index.js'

async function commitStep(
  runtime: DurableRuntime,
  lease: { runId: string; sessionId: string; leaseId: string; workerId: string; attempt: number },
  sequence: number,
  stepId: string,
  input: RunCheckpoint['input']
): Promise<void> {
  await runtime.commitCheckpoint({
    runId: lease.runId,
    sessionId: lease.sessionId,
    leaseId: lease.leaseId,
    workerId: lease.workerId,
    attempt: lease.attempt,
    sequence,
    stepId,
    input,
    output: { sequence }
  })
}

describe('inMemoryDurableRuntime', () => {
  it('fails after checkpoint N and resumes from checkpoint N', async () => {
    const runtime = inMemoryDurableRuntime({ failAfterCheckpoint: 2 })
    const input = { prompt: 'draft' }
    const firstLease = await runtime.startRun({
      runId: 'run-1',
      sessionId: 'session-1',
      workerId: 'worker-1',
      stepId: 'step-0',
      input
    })

    await commitStep(runtime, firstLease, 1, 'step-1', input)
    await expect(commitStep(runtime, firstLease, 2, 'step-2', input))
      .rejects.toThrow('Injected durable runtime failure after checkpoint 2.')

    await expect(runtime.loadCheckpoint('run-1')).resolves.toEqual(expect.objectContaining({
      runId: 'run-1',
      sessionId: 'session-1',
      sequence: 2,
      stepId: 'step-2',
      input,
      output: { sequence: 2 }
    }))

    const retryLease = await runtime.startRun({
      runId: 'run-1',
      sessionId: 'session-1',
      workerId: 'worker-2',
      stepId: 'step-0',
      input
    })

    expect(retryLease.resumed).toBe(true)
    expect(retryLease.attempt).toBe(2)
    expect(retryLease.checkpoint).toEqual(expect.objectContaining({
      sequence: 2,
      stepId: 'step-2'
    }))
  })

  it('never resumes terminal runs', async () => {
    const runtime = inMemoryDurableRuntime()
    const lease = await runtime.startRun({
      runId: 'run-terminal',
      sessionId: 'session-terminal',
      workerId: 'worker-1',
      stepId: 'step-0',
      input: 'payload'
    })

    await runtime.finishRun(lease.runId, { status: 'succeeded', output: 'done' })

    expect(isTerminalRunStatus('succeeded')).toBe(true)
    await expect(runtime.startRun({
      runId: 'run-terminal',
      sessionId: 'session-terminal',
      workerId: 'worker-2',
      stepId: 'step-0',
      input: 'payload'
    })).rejects.toBeInstanceOf(DurableTerminalRunError)
  })

  it('prevents duplicate workers from owning the same session or run', async () => {
    const runtime = inMemoryDurableRuntime()
    await runtime.startRun({
      runId: 'run-owned',
      sessionId: 'session-owned',
      workerId: 'worker-1',
      stepId: 'step-0',
      input: null
    })

    await expect(runtime.startRun({
      runId: 'run-owned',
      sessionId: 'session-owned',
      workerId: 'worker-2',
      stepId: 'step-0',
      input: null
    })).rejects.toBeInstanceOf(DurableRunLeaseError)

    await expect(runtime.startRun({
      runId: 'run-other',
      sessionId: 'session-owned',
      workerId: 'worker-2',
      stepId: 'step-0',
      input: null
    })).rejects.toBeInstanceOf(DurableRunLeaseError)
  })

  it('preserves retried run metadata across attempts', async () => {
    const runtime = inMemoryDurableRuntime()
    const input = { message: 'same input' }
    const firstLease = await runtime.startRun({
      runId: 'run-retry',
      sessionId: 'session-retry',
      workerId: 'worker-1',
      stepId: 'initial-step',
      input,
      attempt: 7,
      metadata: { traceId: 'trace-1' }
    })

    await commitStep(runtime, firstLease, 1, 'initial-step', input)
    await firstLease.release()

    const retryLease = await runtime.startRun({
      runId: 'run-retry',
      sessionId: 'session-retry',
      workerId: 'worker-2',
      stepId: 'ignored-new-step',
      input: { message: 'ignored new input' }
    })

    expect(retryLease.start).toEqual(expect.objectContaining({
      runId: 'run-retry',
      sessionId: 'session-retry',
      stepId: 'initial-step',
      input,
      attempt: 8,
      metadata: { traceId: 'trace-1' }
    }))
    expect(retryLease.checkpoint).toEqual(expect.objectContaining({
      runId: 'run-retry',
      sessionId: 'session-retry',
      stepId: 'initial-step',
      input,
      attempt: 7
    }))
  })

  it('persists workspace replay checkpoint metadata', async () => {
    const runtime = inMemoryDurableRuntime()
    expect(runtime.capabilities).toContain('runtime.workspace_checkpoint')

    const lease = await runtime.startRun({
      runId: 'run-workspace',
      sessionId: 'session-workspace',
      workerId: 'worker-1',
      stepId: 'start',
      input: { prompt: 'resume me' }
    })

    await runtime.commitCheckpoint({
      runId: lease.runId,
      sessionId: lease.sessionId,
      leaseId: lease.leaseId,
      workerId: lease.workerId,
      attempt: lease.attempt,
      sequence: 1,
      stepId: 'workspace-step',
      input: lease.start.input,
      output: { ok: true },
      replay: {
        runId: lease.runId,
        sessionId: lease.sessionId,
        workerId: lease.workerId,
        leaseId: lease.leaseId,
        stepId: 'workspace-step',
        sequence: 1,
        attempt: lease.attempt,
        checkpointRef: 'workspace-1:checkpoint:1',
        workspaceRef: 'workspace-1',
        snapshotRef: 'snapshot-1',
        runtimeCheckpointRef: 'run-workspace:1',
        schemaVersion: 1,
        payload: { ok: true },
        payloadSizeBytes: 11,
        committedAt: '2026-06-05T00:00:00.000Z'
      }
    })

    await expect(runtime.loadCheckpoint('run-workspace')).resolves.toEqual(expect.objectContaining({
      replay: expect.objectContaining({
        workspaceRef: 'workspace-1',
        checkpointRef: 'workspace-1:checkpoint:1',
        schemaVersion: 1
      })
    }))
  })
})
