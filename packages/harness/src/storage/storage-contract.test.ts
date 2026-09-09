import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import { harnessStorageContract } from '../testing/harnessStorageContract.js'
import { InMemoryHarnessStorage } from '../storage/in-memory.js'
import { sqliteHarnessStorage } from '../storage/sqlite.js'
import { canonicalJson } from '../runtime/canonical-json.js'

function sandboxBinding(id: string, instanceId: string, identity?: { tenantId?: string; principalId?: string }) {
  return {
    owner: { namespace: 'storage-test', id, instanceId, ...(identity ? { identity } : {}) },
    relation: 'owned' as const,
    registration: 'pending' as const,
    policyDigest: 'a'.repeat(64),
    disposed: false,
  }
}

describe('InMemoryHarnessStorage', () => {
  harnessStorageContract(() => new InMemoryHarnessStorage())
})

describe('SqliteHarnessStorage', () => {
  harnessStorageContract(async () => sqliteHarnessStorage({
    file: join(await mkdtemp(join(tmpdir(), 'purista-state-contract-')), 'state.sqlite')
  }))

  it.each([
    ['renamed exact constraint', "constraint exact_but_renamed check ((kind in ('agent', 'workflow') and validated_input_json is not null) or (kind = 'child_task' and validated_input_json is null))", true],
    ['same-name weakened constraint', 'constraint harness_runs_validated_input_kind check (1 = 1)', false],
  ] as const)('%s is decided by semantics', async (_name, constraint, accepted) => {
    const root = await mkdtemp(join(tmpdir(), 'purista-schema-constraint-'))
    const file = join(root, 'state.sqlite')
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void }
    }
    const database = new DatabaseSync(file)
    database.exec(`create table harness_runs(
      id text primary key, session_id text not null, kind text not null, target text not null,
      started_at text not null, finished_at text, status text not null, revision integer not null,
      input_json text not null, validated_input_json text, output_json text, error_json text,
      approval_receipt_json text, attempt integer, worker_id text, initial_step_id text, metadata_json text,
      ${constraint}
    )`)
    database.close()
    try {
      if (accepted) {
        const storage = sqliteHarnessStorage({ file })
        await expect(storage.getRun('missing')).resolves.toBeUndefined()
        await storage.close()
      } else {
        expect(() => sqliteHarnessStorage({ file })).toThrow(expect.objectContaining({
          code: 'HARNESS_CONFIG_ERROR', meta: expect.objectContaining({ reason: 'sqlite_schema_incompatible' }),
        }))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retains validated input after terminal checkpoint deletion and close/reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purista-validated-input-'))
    const file = join(root, 'state.sqlite')
    const request = {
      id: 'validated-terminal-run', sessionId: 'validated-terminal-session', kind: 'workflow' as const,
      target: 'review', startedAt: '2026-09-09T00:00:00.000Z',
      input: { accountId: 'account-1' }, validatedInput: { account: { id: 'account-1', risk: 7 } },
    }
    const first = sqliteHarnessStorage({ file })
    try {
      const created = await first.createRun(request)
      const start = {
        id: `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', created.id, 1, 'run.started'])).digest('hex')}`,
        sequence: 1, runId: created.id, at: created.startedAt, type: 'run.started' as const, payload: {},
      }
      await first.appendEvents(created.id, [start])
      const expected = Object.freeze({ revision: created.revision, status: 'running' as const,
        checkpoint: Object.freeze({ stepId: 'start', sequence: null }) })
      const acquisitionId = `acq_${createHash('sha256').update(canonicalJson([
        'harness-run-acquisition-v1', 'initial', created.id, created.sessionId, 'worker',
        created.revision, created.status, 'start', null, null,
      ])).digest('hex')}`
      const lease = await first.acquireRun({ mode: 'initial', runId: created.id, sessionId: created.sessionId,
        workerId: 'worker', acquisitionId, expected })
      await first.commitCheckpoint({ runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId,
        workerId: lease.workerId, stepId: 'start', input: created.input, attempt: lease.attempt, sequence: 1,
        output: { pending: true } })
      const finishedAt = '2026-09-09T00:00:01.000Z'
      const type = 'run.finished' as const
      await first.finalizeRun({ runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId,
        workerId: lease.workerId, patch: { status: 'succeeded', finishedAt, output: { accepted: true } },
        terminalEvent: {
          id: `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', created.id, 2, type])).digest('hex')}`,
          sequence: 2, runId: created.id, at: finishedAt, type, payload: { outcome: { status: 'completed' } },
        }, checkpointDisposition: 'delete-all' })
    } finally {
      await first.close()
    }

    const second = sqliteHarnessStorage({ file })
    try {
      await expect(second.getRun(request.id)).resolves.toMatchObject({
        status: 'succeeded', input: request.input, validatedInput: request.validatedInput,
      })
      await expect(second.loadCheckpoint(request.id)).resolves.toBeUndefined()
      await expect(second.createRun(request)).resolves.toMatchObject({
        status: 'succeeded', validatedInput: request.validatedInput,
      })
      await expect(second.createRun({ ...request, validatedInput: { account: { id: 'account-1', risk: 8 } } }))
        .rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' } })
    } finally {
      await second.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('atomically binds identity across independent clients sharing one database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purista-session-binding-'))
    const first = sqliteHarnessStorage({ file: join(root, 'state.sqlite') })
    const second = sqliteHarnessStorage({ file: join(root, 'state.sqlite') })
    const record = { id: 'shared', instanceId: '01J00000000000000000000001', createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z', runCount: 0 }
    try {
      const outcomes = await Promise.allSettled([
        first.upsertSession({ ...record, identity: { tenantId: 'first' }, sandboxBinding: sandboxBinding(record.id, record.instanceId, { tenantId: 'first' }) }, 'create'),
        second.upsertSession({ ...record, identity: { tenantId: 'second' }, sandboxBinding: sandboxBinding(record.id, record.instanceId, { tenantId: 'second' }) }, 'create')
      ])
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.find(result => result.status === 'rejected')).toMatchObject({
        reason: { code: 'STATE_ERROR', meta: { reason: 'session_identity_mismatch' } }
      })
      const stored = await first.getSession(record.id)
      await expect(second.getSession(record.id)).resolves.toEqual(stored)
      await expect(second.upsertSession({ ...record, ...(stored?.identity ? { identity: stored.identity } : {}), sandboxBinding: stored!.sandboxBinding }, 'create')).resolves.toBe(false)
    } finally {
      await first.close()
      await second.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not let a stale client close a recreated session at the same timestamp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purista-session-close-'))
    const first = sqliteHarnessStorage({ file: join(root, 'state.sqlite') })
    const second = sqliteHarnessStorage({ file: join(root, 'state.sqlite') })
    const old = { id: 'shared', instanceId: '01J00000000000000000000002', createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z', runCount: 0, sandboxBinding: sandboxBinding('shared', '01J00000000000000000000002') }
    try {
      await first.upsertSession(old, 'create')
      await first.closeSession(old.id, old.instanceId)
      const fresh = { ...old, instanceId: '01J00000000000000000000003', sandboxBinding: sandboxBinding('shared', '01J00000000000000000000003') }
      await first.upsertSession(fresh, 'create')
      await second.closeSession(old.id, old.instanceId)
      await expect(first.getSession(old.id)).resolves.toEqual(fresh)
    } finally {
      await first.close()
      await second.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recognizes crashed-running takeover without a checkpoint as resumed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purista-run-takeover-'))
    let clock = Date.parse('2026-08-26T00:00:00.000Z')
    const first = sqliteHarnessStorage({ file: join(root, 'state.sqlite'), leaseTtlMs: 10, now: () => clock })
    const second = sqliteHarnessStorage({ file: join(root, 'state.sqlite'), leaseTtlMs: 10, now: () => clock })
    try {
      const created = await first.createRun({ id: 'crashed', sessionId: 'session', kind: 'workflow', target: 'test', startedAt: new Date(clock).toISOString(), input: null, validatedInput: null })
      const initialExpected = Object.freeze({ revision: created.revision, status: created.status as 'running', checkpoint: Object.freeze({ stepId: 'start', sequence: null }) })
      const initialId = `acq_${createHash('sha256').update(canonicalJson(['harness-run-acquisition-v1', 'initial', created.id, created.sessionId, 'first', created.revision, created.status, 'start', null, 7])).digest('hex')}`
      const initial = await first.acquireRun({ mode: 'initial', runId: created.id, sessionId: created.sessionId, workerId: 'first', acquisitionId: initialId, expected: initialExpected, requestedAttempt: 7 })
      expect(initial.resumed).toBe(false)
      expect(initial.attempt).toBe(7)
      clock += 10
      const afterExpiry = await second.getRun(created.id)
      expect(afterExpiry).toBeDefined()
      expect(afterExpiry).toMatchObject({ validatedInput: null })
      const resumeExpected = Object.freeze({ revision: afterExpiry!.revision, status: afterExpiry!.status as 'running', checkpoint: Object.freeze({ stepId: 'start', sequence: null }) })
      const resumeId = `acq_${createHash('sha256').update(canonicalJson(['harness-run-acquisition-v1', 'resume', created.id, created.sessionId, 'second', afterExpiry!.revision, afterExpiry!.status, 'start', null, null])).digest('hex')}`
      const resumed = await second.acquireRun({ mode: 'resume', runId: created.id, sessionId: created.sessionId, workerId: 'second', acquisitionId: resumeId, expected: resumeExpected })
      expect(resumed.resumed).toBe(true)
      expect(resumed.checkpoint).toBeUndefined()
      expect(resumed.attempt).toBe(8)
      await resumed.release()
    } finally {
      await first.close()
      await second.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an exact acquisition retry after its lease expires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purista-run-expired-retry-'))
    let clock = Date.parse('2026-08-26T00:00:00.000Z')
    const storage = sqliteHarnessStorage({ file: join(root, 'state.sqlite'), leaseTtlMs: 10, now: () => clock })
    try {
      const created = await storage.createRun({
        id: 'expired-retry', sessionId: 'session', kind: 'workflow', target: 'test',
        startedAt: new Date(clock).toISOString(), input: null, validatedInput: null,
      })
      const expected = Object.freeze({
        revision: created.revision,
        status: created.status as 'running',
        checkpoint: Object.freeze({ stepId: 'start', sequence: null }),
      })
      const acquisitionId = `acq_${createHash('sha256').update(canonicalJson([
        'harness-run-acquisition-v1', 'initial', created.id, created.sessionId, 'worker',
        created.revision, created.status, 'start', null, null,
      ])).digest('hex')}`
      const request = Object.freeze({
        mode: 'initial' as const,
        runId: created.id,
        sessionId: created.sessionId,
        workerId: 'worker',
        acquisitionId,
        expected,
      })

      await storage.acquireRun(request)
      clock += 10

      await expect(storage.acquireRun(request)).rejects.toMatchObject({
        code: 'STATE_ERROR',
        meta: { op: 'acquireRun', reason: 'acquisition_conflict' },
      })
      await expect(storage.getRun(created.id)).resolves.toMatchObject({ revision: 2, attempt: 1, workerId: 'worker' })
    } finally {
      await storage.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not let an expired owner checkpoint, wait, or release the run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purista-run-expired-owner-'))
    let clock = Date.parse('2026-08-26T00:00:00.000Z')
    const storage = sqliteHarnessStorage({ file: join(root, 'state.sqlite'), leaseTtlMs: 10, now: () => clock })
    try {
      const created = await storage.createRun({
        id: 'expired-owner', sessionId: 'session', kind: 'workflow', target: 'test',
        startedAt: new Date(clock).toISOString(), input: null, validatedInput: null,
      })
      const expected = Object.freeze({
        revision: created.revision,
        status: created.status as 'running',
        checkpoint: Object.freeze({ stepId: 'start', sequence: null }),
      })
      const acquisitionId = `acq_${createHash('sha256').update(canonicalJson([
        'harness-run-acquisition-v1', 'initial', created.id, created.sessionId, 'worker',
        created.revision, created.status, 'start', null, null,
      ])).digest('hex')}`
      const lease = await storage.acquireRun({
        mode: 'initial', runId: created.id, sessionId: created.sessionId, workerId: 'worker',
        acquisitionId, expected,
      })
      const acquired = await storage.getRun(created.id)
      clock += 10

      await expect(storage.commitCheckpoint({
        runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
        stepId: 'start', input: created.input, attempt: lease.attempt, sequence: 1, output: { stale: true },
      })).rejects.toBeDefined()
      await expect(storage.registerWait({
        runId: created.id, sessionId: created.sessionId, waitId: 'expired-wait', kind: 'review',
        schemaVersion: 'v1', definitionVersion: 'v1', deadline: '2030-01-01T00:00:00.000Z',
      })).rejects.toMatchObject({ code: 'EXTERNAL_WAIT_ERROR', meta: { reason: 'durable_required' } })
      await lease.release()

      await expect(storage.getRun(created.id)).resolves.toEqual(acquired)
      await expect(storage.loadCheckpoint(created.id)).resolves.toBeUndefined()
      await expect(storage.getWait('expired-wait')).resolves.toBeUndefined()
    } finally {
      await storage.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
