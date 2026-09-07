import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

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
      const created = await first.createRun({ id: 'crashed', sessionId: 'session', kind: 'workflow', target: 'test', startedAt: new Date(clock).toISOString(), input: null })
      const initialExpected = Object.freeze({ revision: created.revision, status: created.status as 'running', checkpoint: Object.freeze({ stepId: 'start', sequence: null }) })
      const initialId = `acq_${createHash('sha256').update(canonicalJson(['harness-run-acquisition-v1', 'initial', created.id, created.sessionId, 'first', created.revision, created.status, 'start', null, 7])).digest('hex')}`
      const initial = await first.acquireRun({ mode: 'initial', runId: created.id, sessionId: created.sessionId, workerId: 'first', acquisitionId: initialId, expected: initialExpected, requestedAttempt: 7 })
      expect(initial.resumed).toBe(false)
      expect(initial.attempt).toBe(7)
      clock += 10
      const afterExpiry = await second.getRun(created.id)
      expect(afterExpiry).toBeDefined()
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
        startedAt: new Date(clock).toISOString(), input: null,
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
        startedAt: new Date(clock).toISOString(), input: null,
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
