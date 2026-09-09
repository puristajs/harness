import { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
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

function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => Array.isArray(entry)
    ? entry.map(sort)
    : entry && typeof entry === 'object'
      ? Object.fromEntries(Object.keys(entry as Record<string, unknown>).sort().map((key) => [key, sort((entry as Record<string, unknown>)[key])]))
      : entry
  return JSON.stringify(sort(value))
}

function acquisitionId(mode: 'initial' | 'resume', runId: string, sessionId: string, workerId: string,
  revision: number, status: 'running' | 'waiting' | 'interrupted', stepId: string, sequence: number | null,
  requestedAttempt: number | null = null): string {
  return `acq_${createHash('sha256').update(canonicalJson([
    'harness-run-acquisition-v1', mode, runId, sessionId, workerId, revision, status, stepId, sequence, requestedAttempt,
  ])).digest('hex')}`
}

function eventId(runId: string, sequence: number, type: 'run.started' | 'run.finished'): string {
  return `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', runId, sequence, type])).digest('hex')}`
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
    expect(storage.capabilities).toEqual([
      'storage.checkpoint',
      'storage.retry',
      'storage.resume',
      'storage.workspace_checkpoint',
      'storage.persistent',
      'storage.multi_instance',
      'storage.external_wait',
    ])
    expect(storage.info).toEqual({
      id: 'postgres',
      packageName: '@purista/harness-storage-postgres',
      capabilities: storage.capabilities,
    })
    expect(Object.isFrozen(storage.capabilities)).toBe(true)
    expect(Object.isFrozen(storage.info)).toBe(true)
  })

  it('persists immutable validated input and enforces the root/child storage discriminator', async () => {
    const pool = pglitePool()
    const first = postgresHarnessStorage({ pool: pool as never })
    const validatedInput = { account: { id: 'account-1', labels: ['verified'] } }
    const request = {
      id: 'validated-run', sessionId: 'validated-session', kind: 'workflow' as const, target: 'review',
      startedAt: '2026-01-01T00:00:00.000Z', input: { accountId: 'account-1' }, validatedInput,
    }
    const created = await first.createRun(request)
    validatedInput.account.labels[0] = 'mutated'
    expect(created).toMatchObject({ validatedInput: { account: { id: 'account-1', labels: ['verified'] } } })
    expect(Object.isFrozen(created)).toBe(true)
    if (created.kind === 'child_task') throw new Error('Expected a root run record.')
    expect(Object.isFrozen(created.validatedInput)).toBe(true)
    await first.finishRun(request.id, {
      status: 'succeeded', finishedAt: '2026-01-01T00:00:01.000Z', output: { accepted: true },
    })

    const second = postgresHarnessStorage({ pool: pool as never })
    await expect(second.getRun(request.id)).resolves.toMatchObject({
      status: 'succeeded',
      input: request.input,
      validatedInput: { account: { id: 'account-1', labels: ['verified'] } },
    })
    await expect(second.createRun({ ...request, validatedInput: { account: { id: 'account-1', labels: ['verified'] } } })).resolves.toMatchObject({
      status: 'succeeded', validatedInput: { account: { id: 'account-1', labels: ['verified'] } },
    })
    await expect(second.createRun({ ...request, validatedInput: { account: { id: 'account-1', labels: ['changed'] } } }))
      .rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' } })
    const { validatedInput: _validatedInput, ...missingValidatedInput } = request
    await expect(second.createRun({ ...missingValidatedInput, id: 'missing-validated' } as never))
      .rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' } })
    await expect(second.createRun({ ...request, id: 'invalid-child', kind: 'child_task', validatedInput: undefined } as never))
      .rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' } })
    await expect(pool.query('update purista_harness_runs set validated_input_json = null where id = $1', [request.id]))
      .rejects.toBeDefined()
  })

  it('accepts a renamed exact validated-input constraint and rejects a same-name weakened constraint', async () => {
    const exactPool = pglitePool()
    await postgresHarnessStorage({ pool: exactPool as never }).getSession('missing')
    await exactPool.query(`alter table purista_harness_runs
      rename constraint purista_harness_runs_validated_input_kind to exact_but_renamed`)
    await expect(postgresHarnessStorage({ pool: exactPool as never }).getSession('missing')).resolves.toBeUndefined()

    const weakenedPool = pglitePool()
    await postgresHarnessStorage({ pool: weakenedPool as never }).getSession('missing')
    await weakenedPool.query('alter table purista_harness_runs drop constraint purista_harness_runs_validated_input_kind')
    await weakenedPool.query(`alter table purista_harness_runs
      add constraint purista_harness_runs_validated_input_kind check (true)`)
    await expect(postgresHarnessStorage({ pool: weakenedPool as never }).getSession('missing'))
      .rejects.toMatchObject({ code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'postgres_schema_incompatible' } })
  })

  it('rejects non-JSON run creation before storage mutation', async () => {
    const storage = postgresHarnessStorage({ pool: pglitePool() as never })
    for (const input of [Number.NaN, new Date(), [, 'sparse']]) {
      await expect(storage.createRun({
        id: 'invalid-run', sessionId: 'invalid-session', kind: 'agent', target: 'agent',
        startedAt: '2026-01-01T00:00:00.000Z', input: input as never, validatedInput: null,
      })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' } })
    }
    await expect(storage.getRun('invalid-run')).resolves.toBeUndefined()
  })

  it('validates ordinary run transitions and authors a terminal timestamp', async () => {
    const now = Date.parse('2026-01-01T00:00:02.000Z')
    const storage = postgresHarnessStorage({ pool: pglitePool() as never, now: () => now })
    const created = await storage.createRun({
      id: 'ordinary-run', sessionId: 'ordinary-session', kind: 'agent', target: 'ordinaryAgent',
      startedAt: '2026-01-01T00:00:00.000Z', input: null, validatedInput: null,
    })
    for (const patch of [
      { status: 'succeeded' },
      { status: 'succeeded', output: { ok: true }, error: { code: 'BAD', message: 'bad' } },
      { status: 'failed' },
      { status: 'waiting', output: null },
      { status: 'cancelled', error: { code: 'BAD', message: 'bad', category: undefined } },
    ]) {
      await expect(storage.finishRun(created.id, patch as never)).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { op: 'finishRun', reason: 'run_conflict' },
      })
      await expect(storage.getRun(created.id)).resolves.toEqual(created)
    }
    await storage.finishRun(created.id, { status: 'succeeded', output: null })
    await expect(storage.getRun(created.id)).resolves.toMatchObject({
      status: 'succeeded', finishedAt: '2026-01-01T00:00:02.000Z', output: null, revision: 2,
    })
  })

  it('rejects malformed run status and missing terminal timestamps at the storage boundary', async () => {
    const pool = pglitePool()
    const storage = postgresHarnessStorage({ pool: pool as never })
    const created = await storage.createRun({
      id: 'malformed-row-run', sessionId: 'malformed-row-session', kind: 'agent', target: 'malformedRowAgent',
      startedAt: '2026-01-01T00:00:00.000Z', input: null, validatedInput: null,
    })
    const malformed = { code: 'STATE_ERROR', meta: { op: 'getRun', reason: 'malformed_storage_row' } }

    await pool.query('UPDATE purista_harness_runs SET status = $1 WHERE id = $2', ['unknown', created.id])
    await expect(storage.getRun(created.id)).rejects.toMatchObject(malformed)

    await pool.query(
      'UPDATE purista_harness_runs SET status = $1, output_json = $2::jsonb, finished_at = NULL WHERE id = $3',
      ['succeeded', 'null', created.id],
    )
    await expect(storage.getRun(created.id)).rejects.toMatchObject(malformed)
  })

  it('preserves explicit JSON null outputs in checkpoints and terminal records', async () => {
    const storage = postgresHarnessStorage({ pool: pglitePool() as never })
    const created = await storage.createRun({
      id: 'null-run', sessionId: 'null-session', kind: 'workflow', target: 'nullWorkflow',
      startedAt: '2026-01-01T00:00:00.000Z', input: null, validatedInput: null,
    })
    await storage.appendEvents(created.id, [{
      id: eventId(created.id, 1, 'run.started'), sequence: 1, runId: created.id,
      at: created.startedAt, type: 'run.started', payload: null,
    }])
    const expected = { revision: created.revision, status: 'running' as const, checkpoint: { stepId: 'start', sequence: null } }
    const lease = await storage.acquireRun({
      mode: 'initial', runId: created.id, sessionId: created.sessionId, workerId: 'worker', expected,
      acquisitionId: acquisitionId('initial', created.id, created.sessionId, 'worker', created.revision, 'running', 'start', null),
    })
    await storage.commitCheckpoint({
      runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
      stepId: 'start', input: null, attempt: lease.attempt, sequence: 1, output: null,
    })
    const checkpoint = await storage.loadCheckpoint(created.id, 'start')
    expect(checkpoint).toHaveProperty('output', null)
    const finishedAt = '2026-01-01T00:00:01.000Z'
    const terminalEvent = {
      id: eventId(created.id, 2, 'run.finished'), sequence: 2, runId: created.id,
      at: finishedAt, type: 'run.finished' as const, payload: { outcome: { status: 'completed' as const } },
    }
    const finalization = {
      runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
      patch: { status: 'succeeded' as const, finishedAt, output: null }, terminalEvent,
      checkpointDisposition: 'delete-all' as const,
    }
    await storage.finalizeRun(finalization)
    await storage.finalizeRun(finalization)
    expect(await storage.getRun(created.id)).toHaveProperty('output', null)
    await expect(storage.loadCheckpoint(created.id)).resolves.toBeUndefined()
  })

  it('rejects a non-increasing event batch before persisting any event', async () => {
    const storage = postgresHarnessStorage({ pool: pglitePool() as never })
    const runId = 'event-order-run'
    const at = '2026-01-01T00:00:00.000Z'
    await expect(storage.appendEvents(runId, [
      { id: eventId(runId, 2, 'run.started'), sequence: 2, runId, at, type: 'run.started', payload: null },
      { id: eventId(runId, 1, 'run.started'), sequence: 1, runId, at, type: 'run.started', payload: null },
    ])).rejects.toMatchObject({
      code: 'STATE_ERROR', meta: { op: 'appendEvents', reason: 'event_sequence_conflict' },
    })
    await expect(storage.listEvents(runId)).resolves.toEqual([])
  })

  it('treats only the full installed checkpoint as an idempotent retry', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const pool = pglitePool()
    const storage = postgresHarnessStorage({ pool: pool as never, leaseTtlMs: 1_000, now: () => now })
    const created = await storage.createRun({
      id: 'checkpoint-retry-run', sessionId: 'checkpoint-retry-session', kind: 'workflow', target: 'checkpointWorkflow',
      startedAt: '2026-01-01T00:00:00.000Z', input: { request: true }, validatedInput: { request: true },
    })
    const expected = { revision: created.revision, status: 'running' as const, checkpoint: { stepId: 'step', sequence: null } }
    const lease = await storage.acquireRun({
      mode: 'initial', runId: created.id, sessionId: created.sessionId, workerId: 'worker', expected,
      acquisitionId: acquisitionId('initial', created.id, created.sessionId, 'worker', created.revision, 'running', 'step', null),
    })
    const checkpoint = {
      runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
      stepId: 'step', input: created.input, attempt: lease.attempt, sequence: 1,
      output: { done: true }, replay: { replayed: false }, metadata: { stable: true },
      committedAt: '2026-01-01T00:00:00.100Z',
    }
    await storage.commitCheckpoint(checkpoint)
    const afterFirstCommit = await storage.getRun(created.id)
    const firstExpiry = (await pool.query(
      'select expires_at from purista_harness_run_leases where run_id = $1',
      [created.id],
    )).rows[0]?.['expires_at']

    now += 500
    await storage.commitCheckpoint(checkpoint)
    expect((await storage.getRun(created.id))?.revision).toBe(afterFirstCommit?.revision)
    const secondExpiry = (await pool.query(
      'select expires_at from purista_harness_run_leases where run_id = $1',
      [created.id],
    )).rows[0]?.['expires_at']
    expect(secondExpiry).toEqual(firstExpiry)

    for (const changed of [
      { ...checkpoint, input: { request: false } },
      { ...checkpoint, metadata: { stable: false } },
      { ...checkpoint, committedAt: '2026-01-01T00:00:00.200Z' },
    ]) {
      await expect(storage.commitCheckpoint(changed)).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { op: 'commitCheckpoint', reason: 'checkpoint_conflict' },
      })
    }
    expect((await storage.getRun(created.id))?.revision).toBe(afterFirstCommit?.revision)
    await expect(storage.loadCheckpoint(created.id, checkpoint.stepId)).resolves.toEqual(checkpoint)
  })

  it('validates checkpoint shape and authoritative run identity before mutation', async () => {
    const storage = postgresHarnessStorage({ pool: pglitePool() as never })
    const created = await storage.createRun({
      id: 'checkpoint-identity-run', sessionId: 'checkpoint-identity-session', kind: 'workflow', target: 'checkpointWorkflow',
      startedAt: '2026-01-01T00:00:00.000Z', input: { root: true }, validatedInput: { root: true },
    })
    const expected = { revision: 1, status: 'running' as const, checkpoint: { stepId: 'step', sequence: null } }
    const lease = await storage.acquireRun({
      mode: 'initial', runId: created.id, sessionId: created.sessionId, workerId: 'worker', expected,
      acquisitionId: acquisitionId('initial', created.id, created.sessionId, 'worker', 1, 'running', 'step', null),
    })
    const valid = {
      runId: created.id, sessionId: created.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
      stepId: 'step', input: created.input, attempt: lease.attempt, sequence: 1, output: null,
    }
    for (const invalid of [
      { ...valid, sequence: 0 },
      { ...valid, metadata: undefined },
      { ...valid, committedAt: 'not-a-timestamp' },
      { ...valid, unknown: true },
      { ...valid, input: { root: false } },
      { ...valid, attempt: lease.attempt + 1 },
    ]) {
      await expect(storage.commitCheckpoint(invalid as never)).rejects.toMatchObject({
        code: 'STATE_ERROR', meta: { op: 'commitCheckpoint', reason: 'checkpoint_conflict' },
      })
      await expect(storage.loadCheckpoint(created.id)).resolves.toBeUndefined()
      await expect(storage.getRun(created.id)).resolves.toMatchObject({ revision: 2 })
    }
    await storage.commitCheckpoint(valid)
    await expect(storage.loadCheckpoint(created.id)).resolves.toMatchObject(valid)
  })

  it('returns the exact immutable v4 lease snapshot with requested-attempt semantics', async () => {
    const storage = postgresHarnessStorage({ pool: pglitePool() as never })
    const created = await storage.createRun({
      id: 'lease-shape-run', sessionId: 'lease-shape-session', kind: 'agent', target: 'assistant',
      startedAt: '2026-01-01T00:00:00.000Z', input: { prompt: 'safe' }, validatedInput: { prompt: 'safe' }, metadata: { version: 1 },
    })
    const expected = { revision: 1, status: 'running' as const, checkpoint: { stepId: 'start', sequence: null } }
    const lease = await storage.acquireRun({
      mode: 'initial', runId: created.id, sessionId: created.sessionId, workerId: 'worker', expected,
      requestedAttempt: 7,
      acquisitionId: acquisitionId('initial', created.id, created.sessionId, 'worker', 1, 'running', 'start', null, 7),
    })
    expect(Object.keys(lease).sort()).toEqual([
      'acquiredFrom', 'acquisitionId', 'attempt', 'checkpoints', 'leaseId', 'release', 'resumed',
      'run', 'runId', 'sessionId', 'workerId',
    ].sort())
    expect(lease).toMatchObject({ attempt: 7, resumed: false, acquiredFrom: expected, run: { revision: 2, attempt: 7 } })
    expect(Object.isFrozen(lease)).toBe(true)
    expect(Object.isFrozen(lease.acquiredFrom)).toBe(true)
    expect(Object.isFrozen(lease.acquiredFrom.checkpoint)).toBe(true)
    expect(Object.isFrozen(lease.run)).toBe(true)
    expect(Object.isFrozen(lease.run.input)).toBe(true)
    expect(Object.isFrozen(lease.checkpoints)).toBe(true)
  })

  it('replays one concurrent acquisition and finalization exactly once across adapters', async () => {
    const pool = pglitePool()
    const first = postgresHarnessStorage({ pool: pool as never })
    const second = postgresHarnessStorage({ pool: pool as never })
    const created = await first.createRun({
      id: 'replay-run', sessionId: 'replay-session', kind: 'workflow', target: 'replayWorkflow',
      startedAt: '2026-01-01T00:00:00.000Z', input: { stable: true }, validatedInput: { stable: true },
    })
    const expected = { revision: 1, status: 'running' as const, checkpoint: { stepId: 'start', sequence: null } }
    const request = {
      mode: 'initial' as const, runId: created.id, sessionId: created.sessionId, workerId: 'worker', expected,
      acquisitionId: acquisitionId('initial', created.id, created.sessionId, 'worker', 1, 'running', 'start', null),
    }
    const leases = await Promise.all([first.acquireRun(request), second.acquireRun(request)])
    expect(leases[0]?.leaseId).toBe(leases[1]?.leaseId)
    expect((await first.getRun(created.id))?.revision).toBe(2)
    await first.appendEvents(created.id, [{
      id: eventId(created.id, 1, 'run.started'), sequence: 1, runId: created.id,
      at: created.startedAt, type: 'run.started', payload: null,
    }])
    const finishedAt = '2026-01-01T00:00:01.000Z'
    const finalization = {
      runId: created.id, sessionId: created.sessionId, leaseId: leases[0]!.leaseId, workerId: 'worker',
      patch: { status: 'succeeded' as const, finishedAt, output: { done: true } },
      terminalEvent: {
        id: eventId(created.id, 2, 'run.finished'), sequence: 2, runId: created.id,
        at: finishedAt, type: 'run.finished' as const, payload: { outcome: { status: 'completed' as const } },
      },
      checkpointDisposition: 'delete-all' as const,
    }
    await Promise.all([first.finalizeRun(finalization), second.finalizeRun(finalization)])
    await expect(first.listEvents(created.id)).resolves.toHaveLength(2)
    await expect(first.getRun(created.id)).resolves.toMatchObject({ status: 'succeeded', revision: 3 })
  })

  it('fails closed for legacy and partial storage schemas', async () => {
    const legacyPool = pglitePool()
    await legacyPool.query('create table purista_harness_storage_schema(id smallint primary key, version integer not null)')
    await legacyPool.query('insert into purista_harness_storage_schema values (1, 1)')
    const legacy = postgresHarnessStorage({ pool: legacyPool as never })
    await expect(legacy.getSession('missing')).rejects.toMatchObject({ meta: { reason: 'postgres_schema_incompatible' } })

    const partialPool = pglitePool()
    await partialPool.query('create table purista_harness_runs(id text primary key)')
    const partial = postgresHarnessStorage({ pool: partialPool as never })
    await expect(partial.getSession('missing')).rejects.toMatchObject({ meta: { reason: 'postgres_schema_incompatible' } })
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
    const created = await first.createRun({
      id: 'lease-run', sessionId: record.id, kind: 'workflow', target: 'test',
      startedAt: '2026-01-01T00:00:00.000Z', input: null, validatedInput: null,
    })
    const firstExpected = { revision: created.revision, status: 'running' as const, checkpoint: { stepId: 'start', sequence: null } }
    const oldRequest = {
      mode: 'initial', runId: 'lease-run', sessionId: record.id, workerId: 'old',
      acquisitionId: acquisitionId('initial', 'lease-run', record.id, 'old', created.revision, 'running', 'start', null),
      expected: firstExpected,
    } as const
    const oldLease = await first.acquireRun(oldRequest)
    now += 100
    await expect(first.acquireRun(oldRequest)).rejects.toMatchObject({
      code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'acquisition_conflict' },
    })
    const expired = await first.getRun('lease-run')
    await oldLease.release()
    await expect(first.getRun('lease-run')).resolves.toEqual(expired)
    const beforeTakeover = await second.getRun('lease-run')
    const secondExpected = { revision: beforeTakeover!.revision, status: 'running' as const, checkpoint: { stepId: 'start', sequence: null } }
    const newLease = await second.acquireRun({
      mode: 'resume', runId: 'lease-run', sessionId: record.id, workerId: 'new',
      acquisitionId: acquisitionId('resume', 'lease-run', record.id, 'new', beforeTakeover!.revision, 'running', 'start', null),
      expected: secondExpected,
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

  it('closes an adapter-owned pool idempotently without opening a connection', async () => {
    const storage = postgresHarnessStorage({ connectionString: 'postgres://127.0.0.1:1/unused' })
    await expect(storage.close()).resolves.toBeUndefined()
    await expect(storage.close()).resolves.toBeUndefined()
  })
})
