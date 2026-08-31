import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

import type { SessionRecord } from '@purista/harness'
import { harnessStorageContract } from '@purista/harness/testing'
import { postgresHarnessStorage } from './index.js'

function pglitePool(database = new PGlite()) {
  let connectionTail = Promise.resolve()
  const query = async (text: string, values?: readonly unknown[]) => {
    const result = await database.query(text, values as never)
    return {
      ...result,
      rowCount: result.rows.length > 0 ? result.rows.length : result.affectedRows,
    }
  }
  return {
    query,
    connect: async () => {
      const previous = connectionTail
      let releaseConnection!: () => void
      connectionTail = new Promise<void>((resolve) => { releaseConnection = resolve })
      await previous
      let released = false
      return {
        query,
        release: () => {
          if (released) return
          released = true
          releaseConnection()
        },
      }
    },
    end: async () => database.close(),
  }
}

function session(id = 'session_1'): SessionRecord {
  const instanceId = '01J00000000000000000000001'
  return {
    id,
    instanceId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    runCount: 0,
    sandboxBinding: {
      owner: { namespace: 'harness', id, instanceId },
      relation: 'owned',
      registration: 'pending',
      policyDigest: 'a'.repeat(64),
      disposed: false,
    },
  }
}

harnessStorageContract(() => postgresHarnessStorage({ pool: pglitePool() as never }))

describe('postgresHarnessStorage', () => {
  it('requires exactly one connection ownership mode', () => {
    expect(() => postgresHarnessStorage({})).toThrow(/exactly one/i)
    expect(() => postgresHarnessStorage({
      connectionString: 'postgres://example',
      pool: pglitePool() as never,
    })).toThrow(/exactly one/i)
  })

  it('advertises persistent multi-instance guarantees', () => {
    const storage = postgresHarnessStorage({ pool: pglitePool() as never })
    expect(storage.capabilities).toEqual(expect.arrayContaining([
      'storage.persistent',
      'storage.multi_instance',
      'storage.checkpoint',
      'storage.external_wait',
    ]))
  })

  it('coordinates two independently constructed adapters through the database', async () => {
    const pool = pglitePool()
    const first = postgresHarnessStorage({ pool: pool as never })
    const second = postgresHarnessStorage({ pool: pool as never })
    const record = session('shared')

    const winners = await Promise.all([
      first.upsertSession(record, 'create'),
      second.upsertSession(record, 'create'),
    ])

    expect(winners.filter(Boolean)).toHaveLength(1)
    await expect(second.getSession(record.id)).resolves.toEqual(record)
  })

  it('fences an expired lease and ignores its later release', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const pool = pglitePool()
    const first = postgresHarnessStorage({ pool: pool as never, leaseTtlMs: 100, now: () => now })
    const second = postgresHarnessStorage({ pool: pool as never, leaseTtlMs: 100, now: () => now })
    const record = session('lease-session')
    await first.upsertSession(record, 'create')
    await first.createRun({
      id: 'lease-run', sessionId: record.id, kind: 'workflow', target: 'test',
      startedAt: '2026-01-01T00:00:00.000Z', status: 'running', input: null,
    })
    const oldLease = await first.acquireRun({
      runId: 'lease-run', sessionId: record.id, workerId: 'old', stepId: 'start', input: null,
    })
    now += 101
    const newLease = await second.acquireRun({
      runId: 'lease-run', sessionId: record.id, workerId: 'new', stepId: 'start', input: null,
    })

    await oldLease.release()
    await expect(second.getRun('lease-run')).resolves.toMatchObject({ status: 'running', workerId: 'new', attempt: 2 })
    await expect(second.commitCheckpoint({
      runId: 'lease-run', sessionId: record.id, workerId: newLease.workerId,
      leaseId: newLease.leaseId, stepId: 'start', input: null,
      attempt: newLease.attempt, sequence: 1, output: { ok: true },
    })).resolves.toBeUndefined()
  })

  it('does not close a caller-owned pool', async () => {
    let ended = false
    const pool = pglitePool()
    const storage = postgresHarnessStorage({
      pool: { ...pool, end: async () => { ended = true } } as never,
    })
    await storage.close()
    await storage.close()
    expect(ended).toBe(false)
    await pool.end()
  })
})
