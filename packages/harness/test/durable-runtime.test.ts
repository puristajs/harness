import { describe, expect, it } from 'vitest'

import {
  DurableRunLeaseError,
  DurableTerminalRunError,
  inMemoryHarnessStorage,
  isTerminalRunStatus
} from '../src/index.js'
import type { HarnessStorage, RunCheckpoint } from '../src/index.js'

async function commitStep(
  runtime: HarnessStorage,
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

async function acquire(storage: HarnessStorage, record: { runId: string; sessionId: string; workerId: string; stepId: string; input: RunCheckpoint['input']; attempt?: number; metadata?: Record<string, RunCheckpoint['input']> }) {
  if (!await storage.getRun(record.runId)) {
    await storage.createRun({
      id: record.runId, sessionId: record.sessionId, kind: 'workflow', target: record.stepId,
      startedAt: new Date().toISOString(), status: 'running', input: record.input,
      ...(record.metadata ? { metadata: record.metadata } : {})
    })
  }
  return storage.acquireRun(record)
}

describe('InMemoryHarnessStorage durability', () => {
  it('fails after checkpoint N and resumes from checkpoint N', async () => {
    const runtime = inMemoryHarnessStorage({ failAfterCheckpoint: 2 })
    const input = { prompt: 'draft' }
    const firstLease = await acquire(runtime, {
      runId: 'run-1',
      sessionId: 'session-1',
      workerId: 'worker-1',
      stepId: 'step-0',
      input
    })

    await commitStep(runtime, firstLease, 1, 'step-1', input)
    await expect(commitStep(runtime, firstLease, 2, 'step-2', input))
      .rejects.toThrow('Injected Harness storage failure after checkpoint 2.')

    await expect(runtime.loadCheckpoint('run-1')).resolves.toEqual(expect.objectContaining({
      runId: 'run-1',
      sessionId: 'session-1',
      sequence: 2,
      stepId: 'step-2',
      input,
      output: { sequence: 2 }
    }))

    const retryLease = await acquire(runtime, {
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
    const runtime = inMemoryHarnessStorage()
    const lease = await acquire(runtime, {
      runId: 'run-terminal',
      sessionId: 'session-terminal',
      workerId: 'worker-1',
      stepId: 'step-0',
      input: 'payload'
    })

    await runtime.finishRun(lease.runId, { status: 'succeeded', output: 'done' })

    expect(isTerminalRunStatus('succeeded')).toBe(true)
    await expect(acquire(runtime, {
      runId: 'run-terminal',
      sessionId: 'session-terminal',
      workerId: 'worker-2',
      stepId: 'step-0',
      input: 'payload'
    })).rejects.toBeInstanceOf(DurableTerminalRunError)
  })

  it('resumes interrupted runs but rejects failed runs', async () => {
    const runtime = inMemoryHarnessStorage()
    const lease = await acquire(runtime, {
      runId: 'run-interrupted',
      sessionId: 'session-interrupted',
      workerId: 'worker-1',
      stepId: 'step-0',
      input: 'payload'
    })
    await commitStep(runtime, lease, 1, 'step-1', 'payload')
    await lease.release()

    // Only succeeded/cancelled block resume (spec 22 §3): a retry with the same
    // run id re-acquires the lease and replays the committed checkpoint.
    const retry = await acquire(runtime, {
      runId: 'run-interrupted',
      sessionId: 'session-interrupted',
      workerId: 'worker-2',
      stepId: 'step-0',
      input: 'payload'
    })
    expect(retry.resumed).toBe(true)
    expect(retry.attempt).toBe(lease.attempt + 1)
    expect(retry.checkpoint).toEqual(expect.objectContaining({ stepId: 'step-1' }))
    await runtime.finishRun(retry.runId, { status: 'failed', error: { code: 'INTERNAL_ERROR', message: 'boom' } })
    await expect(acquire(runtime, { runId: retry.runId, sessionId: retry.sessionId, workerId: 'worker-3', stepId: 'step-0', input: 'payload' }))
      .rejects.toBeInstanceOf(DurableTerminalRunError)
  })

  it('prevents duplicate workers from owning the same session or run', async () => {
    const runtime = inMemoryHarnessStorage()
    await acquire(runtime, {
      runId: 'run-owned',
      sessionId: 'session-owned',
      workerId: 'worker-1',
      stepId: 'step-0',
      input: null
    })

    await expect(acquire(runtime, {
      runId: 'run-owned',
      sessionId: 'session-owned',
      workerId: 'worker-2',
      stepId: 'step-0',
      input: null
    })).rejects.toBeInstanceOf(DurableRunLeaseError)

    await expect(acquire(runtime, {
      runId: 'run-other',
      sessionId: 'session-owned',
      workerId: 'worker-2',
      stepId: 'step-0',
      input: null
    })).rejects.toBeInstanceOf(DurableRunLeaseError)
  })

  it('preserves retried run metadata across attempts', async () => {
    const runtime = inMemoryHarnessStorage()
    const input = { message: 'same input' }
    const firstLease = await acquire(runtime, {
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

    const retryLease = await acquire(runtime, {
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
    const runtime = inMemoryHarnessStorage()
    expect(runtime.capabilities).toContain('storage.workspace_checkpoint')

    const lease = await acquire(runtime, {
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
