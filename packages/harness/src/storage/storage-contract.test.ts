import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { harnessStorageContract } from '../testing/harnessStorageContract.js'
import { InMemoryHarnessStorage } from '../storage/in-memory.js'
import { sqliteHarnessStorage } from '../storage/sqlite.js'

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
      await first.createRun({ id: 'crashed', sessionId: 'session', kind: 'workflow', target: 'test', startedAt: new Date(clock).toISOString(), status: 'running' })
      const initial = await first.acquireRun({ runId: 'crashed', sessionId: 'session', workerId: 'first', stepId: 'start', input: null, attempt: 7 })
      expect(initial.resumed).toBe(false)
      expect(initial.attempt).toBe(7)
      clock += 11
      const resumed = await second.acquireRun({ runId: 'crashed', sessionId: 'session', workerId: 'second', stepId: 'start', input: null })
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
})
