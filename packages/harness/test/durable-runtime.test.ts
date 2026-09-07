import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

import {
  DurableTerminalRunError,
  inMemoryHarnessStorage,
  isTerminalRunStatus
} from '../src/index.js'
import type { HarnessStorage, RunCheckpoint } from '../src/index.js'
import { canonicalJson } from '../src/runtime/canonical-json.js'

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
  const prior = await storage.getRun(record.runId)
  const run = prior ?? await storage.createRun({
    id: record.runId, sessionId: record.sessionId, kind: 'workflow', target: record.stepId,
    startedAt: new Date().toISOString(), input: record.input,
    ...(record.metadata ? { metadata: record.metadata } : {})
  })
  const checkpoint = await storage.loadCheckpoint(record.runId)
  const mode = prior === undefined ? 'initial' as const : 'resume' as const
  const selectedStep = checkpoint?.stepId ?? record.stepId
  const expectedStatus = ['running', 'waiting', 'interrupted'].includes(run.status) ? run.status as 'running' | 'waiting' | 'interrupted' : 'interrupted'
  const requestedAttempt = record.attempt ?? null
  const acquisitionId = `acq_${createHash('sha256').update(canonicalJson(['harness-run-acquisition-v1', mode,
    record.runId, record.sessionId, record.workerId, run.revision, expectedStatus, selectedStep, checkpoint?.sequence ?? null, requestedAttempt])).digest('hex')}`
  return storage.acquireRun({
    mode, runId: record.runId, sessionId: record.sessionId, workerId: record.workerId,
    acquisitionId,
    expected: { revision: run.revision, status: expectedStatus, checkpoint: { stepId: selectedStep, sequence: checkpoint?.sequence ?? null } },
    ...(record.attempt === undefined ? {} : { requestedAttempt: record.attempt }),
  })
}

async function finalize(
  storage: HarnessStorage,
  lease: Awaited<ReturnType<typeof acquire>>,
  patch: { status: 'succeeded'; output: RunCheckpoint['input'] } | { status: 'failed' | 'cancelled'; error: { code: string; message: string } },
): Promise<void> {
  const at = new Date().toISOString()
  const sequence = (await storage.listEvents(lease.runId)).length + 1
  const type = 'run.finished' as const
  const id = `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', lease.runId, sequence, type])).digest('hex')}`
  const outcome = patch.status === 'succeeded'
    ? { status: 'completed' as const }
    : { status: patch.status, error: patch.error }
  await storage.finalizeRun({
    runId: lease.runId,
    sessionId: lease.sessionId,
    leaseId: lease.leaseId,
    workerId: lease.workerId,
    patch: { ...patch, finishedAt: at },
    terminalEvent: { id, sequence, runId: lease.runId, at, type, payload: { outcome } },
    checkpointDisposition: 'delete-all',
  })
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

    const interrupted = await runtime.getRun('run-1')
    expect(interrupted).toMatchObject({ status: 'interrupted', revision: 5 })
    expect(Object.isFrozen(interrupted)).toBe(true)
    expect(Object.isFrozen(interrupted?.input)).toBe(true)

    const retryLease = await acquire(runtime, {
      runId: 'run-1',
      sessionId: 'session-1',
      workerId: 'worker-2',
      stepId: 'step-0',
      input
    })

    expect(retryLease.resumed).toBe(true)
    expect(retryLease.attempt).toBe(2)
    expect(retryLease.run.revision).toBe(6)
    expect(Object.isFrozen(retryLease.run)).toBe(true)
    expect(Object.isFrozen(retryLease.run.input)).toBe(true)
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

    await finalize(runtime, lease, { status: 'succeeded', output: 'done' })

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
    await finalize(runtime, retry, { status: 'failed', error: { code: 'INTERNAL_ERROR', message: 'boom' } })
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
    })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'lease_conflict' } })

    await expect(acquire(runtime, {
      runId: 'run-other',
      sessionId: 'session-owned',
      workerId: 'worker-2',
      stepId: 'step-0',
      input: null
    })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'lease_conflict' } })
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
      stepId: 'initial-step',
      input
    })

    expect(retryLease.run).toEqual(expect.objectContaining({
      id: 'run-retry',
      sessionId: 'session-retry',
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
      input: lease.run.input,
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
