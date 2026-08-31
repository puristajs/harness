import { afterAll, describe, expect, it } from 'vitest'

import { postgresHarnessStorage } from '../src/index.js'

const connectionString = process.env['POSTGRES_HARNESS_STORAGE_URL']
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
const first = connectionString ? postgresHarnessStorage({ connectionString }) : undefined
const second = connectionString ? postgresHarnessStorage({ connectionString }) : undefined

function sessionRecord(id: string) {
  const instanceId = '01J00000000000000000000001'
  const timestamp = new Date().toISOString()
  return {
    id,
    instanceId,
    createdAt: timestamp,
    updatedAt: timestamp,
    runCount: 0,
    sandboxBinding: {
      owner: { namespace: 'live', id, instanceId },
      relation: 'owned' as const,
      registration: 'pending' as const,
      policyDigest: 'b'.repeat(64),
      disposed: false,
    },
  }
}

describe.skipIf(!first || !second)('PostgreSQL Harness storage live multi-client contract', () => {
  afterAll(async () => {
    await first?.close()
    await second?.close()
  })

  it('selects one session creation winner across independent pools', async () => {
    const id = `live-${suffix}`
    const record = sessionRecord(id)
    const winners = await Promise.all([
      first!.upsertSession(record, 'create'),
      second!.upsertSession(record, 'create'),
    ])
    expect(winners.filter(Boolean)).toHaveLength(1)
    await first!.closeSession(id, record.instanceId)
  })

  it('recovers persisted state after every adapter client has restarted', async () => {
    const id = `restart-${suffix}`
    const record = sessionRecord(id)
    const writer = postgresHarnessStorage({ connectionString: connectionString! })
    await writer.upsertSession(record, 'create')
    await writer.close()

    const reader = postgresHarnessStorage({ connectionString: connectionString! })
    try {
      await expect(reader.getSession(id)).resolves.toEqual(record)
      await reader.closeSession(id, record.instanceId)
    } finally {
      await reader.close()
    }
  })
})
