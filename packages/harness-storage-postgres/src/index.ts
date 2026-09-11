import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Pool, type Pool as PgPool, type PoolClient } from 'pg'

import {
  DurableRunLeaseError,
  DurableTerminalRunError,
  ExternalWaitError,
  HarnessConfigError,
  StateError,
  harnessExecutionEventTypesV1,
  isJsonValue,
  isResumeBlockingRunStatus,
  type AdapterCapability,
  type DurableReplayCheckpoint,
  type DurableRunLease,
  type DurableTerminalRunStatus,
  type ExternalWaitRegistration,
  type ExternalWaitSignal,
  type ExternalWaitSignalResult,
  type ExternalWaitSnapshot,
  type FinishRunPatch,
  type HarnessAdapterContext,
  type HarnessStorage,
  type JsonValue,
  type Message,
  type PersistedRunEvent,
  type RunCheckpoint,
  type RunRecord,
  type RunStatus,
  type SessionRecord,
  type SpanAttrs,
  type TelemetryShim,
} from '@purista/harness'
import {
  asExternalWaitResolved,
  assertSessionSandboxBindingTransition,
  createExternalWaitCancellation,
  projectExternalWaitRequest,
  sameHarnessIdentity,
  validateBoundExternalWaitRequest,
  validateExternalWaitId,
  validateExternalWaitSignal,
  validateExternalWaitSignalResult,
  validateExternalWaitSnapshot,
} from '@purista/harness/adapter'

type BoundExternalWaitRequest = Parameters<HarnessStorage['registerWait']>[0]
type CreateRunRequest = Parameters<HarnessStorage['createRun']>[0]
type AcquireRunRequest = Parameters<HarnessStorage['acquireRun']>[0]
type ReplaceCheckpointRequest = Parameters<HarnessStorage['replaceCheckpoint']>[0]
type FinalizeRunRequest = Parameters<HarnessStorage['finalizeRun']>[0]
type PersistedFinalRunEvent = FinalizeRunRequest['terminalEvent']
type SerializedError = NonNullable<RunRecord['error']>
type PgRow = Record<string, unknown>
const RUN_PROJECTION = '*, output_json is not null as has_output, approval_receipt_json is not null as has_approval_receipt, validated_input_json is not null as has_validated_input'
const CHECKPOINT_PROJECTION = '*, output_json is not null as has_output'

const STORAGE_CAPABILITIES = Object.freeze([
  'storage.checkpoint',
  'storage.retry',
  'storage.resume',
  'storage.workspace_checkpoint',
  'storage.persistent',
  'storage.multi_instance',
  'storage.external_wait',
] as const satisfies readonly AdapterCapability[])

export interface PostgresHarnessStorageOptions {
  /** PostgreSQL 16+ connection URL. Exactly one of `connectionString` or `pool` is required. */
  readonly connectionString?: string
  /** Caller-owned `pg.Pool`. The adapter never closes an injected pool. */
  readonly pool?: PgPool
  /** Lease takeover window for interrupted workers. Default: `120_000`. */
  readonly leaseTtlMs?: number
  /** Injectable epoch-millisecond clock for deterministic tests. Default: `Date.now`. */
  readonly now?: () => number
}

/**
 * Creates distributed PostgreSQL storage for the complete Harness persistence
 * boundary. The migration is applied lazily before the first operation.
 *
 * @example
 * ```ts
 * const storage = postgresHarnessStorage({
 *   connectionString: process.env.DATABASE_URL!,
 * })
 * const definition = defineHarness({ name: 'worker', revision: '2026-09-07' })
 *   .addWorkflow(durableWorkflow)
 * const harness = await definition.getInstance({ storage })
 * ```
 */
export function postgresHarnessStorage(
  options: PostgresHarnessStorageOptions,
): HarnessStorage & { close(): Promise<void> } {
  if ((options.connectionString === undefined) === (options.pool === undefined)) {
    throw new HarnessConfigError(
      'Provide exactly one of connectionString or pool for PostgreSQL Harness storage.',
      { reason: 'invalid_storage', path: 'storage.postgres' },
    )
  }
  const ownsPool = options.pool === undefined
  const pool = options.pool ?? new Pool({ connectionString: options.connectionString })
  return new PostgresHarnessStorage(pool, ownsPool, options)
}

class PostgresHarnessStorage implements HarnessStorage {
  public readonly capabilities = STORAGE_CAPABILITIES
  public readonly info = Object.freeze({
    id: 'postgres',
    packageName: '@purista/harness-storage-postgres',
    capabilities: STORAGE_CAPABILITIES,
  })

  private readonly transactionContext = new AsyncLocalStorage<PoolClient>()
  private readonly leaseTtlMs: number
  private readonly clock: () => number
  private migration: Promise<void> | undefined
  private closed = false
  private logger: HarnessAdapterContext['logger'] | undefined
  private telemetry: TelemetryShim | undefined

  public constructor(
    private readonly pool: PgPool,
    private readonly ownsPool: boolean,
    options: Pick<PostgresHarnessStorageOptions, 'leaseTtlMs' | 'now'>,
  ) {
    this.leaseTtlMs = options.leaseTtlMs ?? 120_000
    this.clock = options.now ?? Date.now
    if (!Number.isFinite(this.leaseTtlMs) || this.leaseTtlMs <= 0) {
      throw new HarnessConfigError('PostgreSQL Harness storage leaseTtlMs must be positive.', {
        reason: 'invalid_storage', path: 'storage.postgres.leaseTtlMs',
      })
    }
  }

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.logger = context.logger
    this.telemetry = context.telemetry
  }

  public async getSession(id: string): Promise<SessionRecord | undefined> {
    const rows = await this.query('select * from purista_harness_sessions where id = $1', [id])
    return rows[0] ? rowToSession(rows[0]) : undefined
  }

  public async upsertSession(record: SessionRecord, mode: 'create' | 'update'): Promise<boolean> {
    if (mode !== 'create' && mode !== 'update') {
      throw new StateError('Session write mode is invalid.', { op: 'upsertSession', reason: 'invalid_session_write_mode' })
    }
    assertSessionSandboxBindingTransition(record.sandboxBinding, record.sandboxBinding, 'upsertSession')
    return this.transaction(async (client) => {
      const existingRows = await client.query('select * from purista_harness_sessions where id = $1 for update', [record.id])
      const existingRow = existingRows.rows[0] as PgRow | undefined
      if (existingRow) {
        const existing = rowToSession(existingRow)
        if (!sameHarnessIdentity(existing.identity, record.identity)) {
          throw new StateError('Session identity cannot be changed.', { op: 'upsertSession', reason: 'session_identity_mismatch' })
        }
        if (mode === 'create') return false
        if (existing.instanceId !== record.instanceId || existing.createdAt !== record.createdAt) {
          throw new StateError('Session instance is no longer active.', { op: 'upsertSession', reason: 'session_instance_mismatch' })
        }
        assertSessionSandboxBindingTransition(existing.sandboxBinding, record.sandboxBinding, 'upsertSession')
        if (record.updatedAt < existing.updatedAt || record.runCount < existing.runCount) return false
        await client.query(
          `update purista_harness_sessions
             set updated_at = $1, run_count = $2, sandbox_binding_json = $3::jsonb, metadata_json = $4::jsonb
           where id = $5`,
          [record.updatedAt, record.runCount, stringify(record.sandboxBinding), stringify(record.metadata), record.id],
        )
        return false
      }
      if (mode === 'update') {
        throw new StateError('Session instance is no longer active.', { op: 'upsertSession', reason: 'session_instance_mismatch' })
      }
      try {
        await client.query(
          `insert into purista_harness_sessions
            (id, instance_id, created_at, updated_at, run_count, identity_json, sandbox_binding_json, metadata_json)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
          [record.id, record.instanceId, record.createdAt, record.updatedAt, record.runCount,
            stringify(record.identity), stringify(record.sandboxBinding), stringify(record.metadata)],
        )
        return true
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        const winner = await client.query('select * from purista_harness_sessions where id = $1', [record.id])
        const winnerRow = winner.rows[0] as PgRow | undefined
        if (!winnerRow) throw error
        if (!sameHarnessIdentity(rowToSession(winnerRow).identity, record.identity)) {
          throw new StateError('Session identity cannot be changed.', { op: 'upsertSession', reason: 'session_identity_mismatch' }, error)
        }
        return false
      }
    })
  }

  public async closeSession(id: string, expectedInstanceId: string): Promise<void> {
    await this.withSessionLock(id, async () => this.transaction(async (client) => {
      const session = await client.query('select instance_id from purista_harness_sessions where id = $1 for update', [id])
      if (session.rows[0]?.['instance_id'] !== expectedInstanceId) return
      const runIds = await client.query('select id from purista_harness_runs where session_id = $1 order by id', [id])
      for (const row of runIds.rows) {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`run-events:${text(row['id'])}`])
      }
      await client.query('delete from purista_harness_external_wait_signals where wait_id in (select wait_id from purista_harness_external_waits where session_id = $1)', [id])
      await client.query('delete from purista_harness_external_waits where session_id = $1', [id])
      await client.query('delete from purista_harness_run_checkpoints where session_id = $1', [id])
      await client.query('delete from purista_harness_run_leases where session_id = $1', [id])
      await client.query('delete from purista_harness_run_events where run_id in (select id from purista_harness_runs where session_id = $1)', [id])
      await client.query('delete from purista_harness_runs where session_id = $1', [id])
      await client.query('delete from purista_harness_messages where session_id = $1', [id])
      await client.query('delete from purista_harness_sessions where id = $1 and instance_id = $2', [id, expectedInstanceId])
    }))
  }

  public async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [sessionId])
      try {
        for (const message of messages) {
          await client.query(
            `insert into purista_harness_messages
              (id, session_id, run_id, role, content, tool_calls_json, tool_results_json, created_at, message_order)
             values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8,
               (select coalesce(max(message_order), 0) + 1 from purista_harness_messages where session_id = $2))`,
            [message.id, sessionId, message.runId ?? null, message.role, message.content,
              stringify(message.toolCalls), stringify(message.toolResults), message.timestamp],
          )
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StateError('Message id already exists.', { op: 'appendMessages', reason: 'duplicate_message_id' }, error)
        }
        throw error
      }
    })
  }

  public async listMessages(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<Message[]> {
    let cursor: PgRow | undefined
    if (opts.before) {
      cursor = (await this.query(
        'select message_order from purista_harness_messages where id = $1 and session_id = $2',
        [opts.before, sessionId],
      ))[0]
    }
    const values: unknown[] = [sessionId]
    const beforeClause = cursor ? ` and message_order < $${push(values, bigint(cursor['message_order']))}` : ''
    if (opts.limit === undefined) {
      const rows = await this.query(
        `select * from purista_harness_messages where session_id = $1${beforeClause} order by message_order asc`,
        values,
      )
      return rows.map(rowToMessage)
    }
    const limit = push(values, Math.max(0, opts.limit))
    const rows = await this.query(
      `select * from purista_harness_messages where session_id = $1${beforeClause} order by message_order desc limit $${limit}`,
      values,
    )
    return rows.reverse().map(rowToMessage)
  }

  public async clearMessages(sessionId: string): Promise<void> {
    await this.query('delete from purista_harness_messages where session_id = $1', [sessionId])
  }

  public async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [sessionId])
      await client.query('delete from purista_harness_messages where session_id = $1', [sessionId])
      try {
        for (const [index, message] of messages.entries()) {
          await client.query(
            `insert into purista_harness_messages
              (id, session_id, run_id, role, content, tool_calls_json, tool_results_json, created_at, message_order)
             values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
            [message.id, sessionId, message.runId ?? null, message.role, message.content,
              stringify(message.toolCalls), stringify(message.toolResults), message.timestamp, String(index + 1)],
          )
        }
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StateError('Message id already exists.', { op: 'replaceMessages', reason: 'duplicate_message_id' }, error)
        }
        throw error
      }
    })
  }

  public async createRun(request: CreateRunRequest): Promise<RunRecord> {
    const record = normalizeCreateRunRequest(request)
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `insert into purista_harness_runs
          (id, session_id, kind, target, started_at, finished_at, status, revision, input_json,
           validated_input_json, output_json, error_json, approval_receipt_json, attempt, worker_id, initial_step_id, metadata_json)
         values ($1, $2, $3, $4, $5, null, 'running', 1, $6::jsonb,
           $7::jsonb, null, null, null, null, null, null, $8::jsonb)
         on conflict (id) do nothing returning *, output_json is not null as has_output,
           approval_receipt_json is not null as has_approval_receipt,
           validated_input_json is not null as has_validated_input`,
        [record.id, record.sessionId, record.kind, record.target, record.startedAt,
          JSON.stringify(record.input), record.kind === 'child_task' ? null : JSON.stringify(record.validatedInput),
          stringify(record.metadata)],
      )
      const insertedRow = inserted.rows[0] as PgRow | undefined
      if (insertedRow) return rowToRun(insertedRow)
      const existingRows = await client.query(`select ${RUN_PROJECTION} from purista_harness_runs where id = $1 for update`, [record.id])
      const existingRow = existingRows.rows[0] as PgRow | undefined
      if (!existingRow) throw runConflict()
      const existing = rowToRun(existingRow)
      if (runCreationBytes(existing) === runCreationBytes(record)) return existing
      throw runConflict()
    })
  }

  public async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    const normalized = normalizeFinishRunPatch(patch, () => this.nowIso())
    return this.storageSpan('finish_run', { 'harness.run.id': runId, 'harness.run.status': normalized.status }, async () => {
      await this.transaction(async (client) => {
        const runRows = await client.query('select attempt from purista_harness_runs where id = $1 for update', [runId])
        if (runRows.rows[0]?.['attempt'] !== null && runRows.rows[0]?.['attempt'] !== undefined) {
          throw new StateError('An acquired run requires atomic finalization.', { op: 'finishRun', reason: 'active_lease_requires_finalize' })
        }
        const lease = await client.query('select run_id from purista_harness_run_leases where run_id = $1 for update', [runId])
        if (lease.rows[0]) throw new StateError('An active lease requires atomic finalization.', { op: 'finishRun', reason: 'active_lease_requires_finalize' })
        await client.query(
          `update purista_harness_runs set
             status = $1, finished_at = $2,
             output_json = $3::jsonb, error_json = $4::jsonb,
             revision = revision + 1
           where id = $5`,
          [normalized.status, normalized.finishedAt ?? null, stringify(normalized.output), stringify(normalized.error), runId],
        )
        if (normalized.status !== 'running') await client.query('delete from purista_harness_run_leases where run_id = $1', [runId])
      })
    })
  }

  public async getRun(runId: string): Promise<RunRecord | undefined> {
    const rows = await this.query(`select ${RUN_PROJECTION} from purista_harness_runs where id = $1`, [runId])
    return rows[0] ? rowToRun(rows[0]) : undefined
  }

  public async listRuns(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<RunRecord[]> {
    let cursor: PgRow | undefined
    if (opts.before) {
      cursor = (await this.query(
        'select started_at, id from purista_harness_runs where id = $1 and session_id = $2',
        [opts.before, sessionId],
      ))[0]
    }
    const values: unknown[] = [sessionId]
    const beforeClause = cursor
      ? ` and (started_at < $${push(values, date(cursor['started_at']))} or (started_at = $${push(values, date(cursor['started_at']))} and id < $${push(values, opts.before ?? '')}))`
      : ''
    const limitClause = opts.limit === undefined ? '' : ` limit $${push(values, Math.max(0, opts.limit))}`
    const rows = await this.query(
      `select ${RUN_PROJECTION} from purista_harness_runs where session_id = $1${beforeClause} order by started_at desc, id desc${limitClause}`,
      values,
    )
    return rows.map(rowToRun)
  }

  public async appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    const normalized = events.map((event) => normalizePersistedEvent(event, runId))
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index]!.sequence <= normalized[index - 1]!.sequence) {
        throw new StateError('Run event sequence is not contiguous.', { op: 'appendEvents', reason: 'event_sequence_conflict' })
      }
    }
    await this.transaction(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`run-events:${runId}`])
      for (const event of normalized) {
        const collision = await client.query(
          'select * from purista_harness_run_events where run_id = $1 and (sequence = $2 or id = $3)',
          [runId, event.sequence, event.id],
        )
        const collisionRow = collision.rows[0] as PgRow | undefined
        if (collisionRow) {
          if (canonicalJson(rowToEvent(collisionRow)) !== canonicalJson(event)) {
            throw new StateError('Run event conflicts with an existing event.', { op: 'appendEvents', reason: 'event_conflict' })
          }
          continue
        }
        const maximum = await client.query('select max(sequence) as sequence from purista_harness_run_events where run_id = $1', [runId])
        if (event.sequence !== Number(maximum.rows[0]?.['sequence'] ?? 0) + 1) {
          throw new StateError('Run event sequence is not contiguous.', { op: 'appendEvents', reason: 'event_sequence_conflict' })
        }
        await client.query(
          'insert into purista_harness_run_events(id, sequence, run_id, at, type, payload_json) values ($1, $2, $3, $4, $5, $6::jsonb)',
          [event.id, event.sequence, runId, event.at, event.type, JSON.stringify(event.payload)],
        )
      }
    })
  }

  public async listEvents(runId: string, opts: { limit?: number; after?: string } = {}): Promise<PersistedRunEvent[]> {
    let cursor: PgRow | undefined
    if (opts.after) {
      cursor = (await this.query('select sequence from purista_harness_run_events where run_id = $1 and id = $2', [runId, opts.after]))[0]
    }
    const values: unknown[] = [runId]
    const afterClause = cursor ? ` and sequence > $${push(values, number(cursor['sequence']))}` : ''
    const limitClause = opts.limit === undefined ? '' : ` limit $${push(values, Math.max(0, opts.limit))}`
    const rows = await this.query(
      `select * from purista_harness_run_events where run_id = $1${afterClause} order by sequence asc${limitClause}`,
      values,
    )
    return rows.map(rowToEvent)
  }

  public async acquireRun(request: AcquireRunRequest): Promise<DurableRunLease> {
    const record = normalizeAcquireRunRequest(request)
    return this.storageSpan('acquire_run', {
      'harness.run.id': record.runId,
      'harness.session.id': record.sessionId,
    }, (recordAttrs) => this.withSessionLock(record.sessionId, async () => this.transaction(async (client) => {
      const currentRows = await client.query(`select ${RUN_PROJECTION} from purista_harness_runs where id = $1 for update`, [record.runId])
      const currentRow = currentRows.rows[0] as PgRow | undefined
      if (!currentRow) throw new StateError('Durable run must be created before acquisition.', { op: 'acquireRun', reason: 'run_not_found' })
      const current = rowToRun(currentRow)
      if (current.sessionId !== record.sessionId) throw acquisitionConflict()
      if (isResumeBlockingRunStatus(current.status)) {
        throw new DurableTerminalRunError(record.runId, current.status as DurableTerminalRunStatus)
      }
      const selectedRows = await client.query(
        `select ${CHECKPOINT_PROJECTION} from purista_harness_run_checkpoints where run_id = $1 and step_id = $2`,
        [record.runId, record.expected.checkpoint.stepId],
      )
      const selectedRow = selectedRows.rows[0] as PgRow | undefined
      const selectedSequence = selectedRow ? number(selectedRow['sequence']) : null
      const checkpointCount = await client.query(
        'select count(*) as count from purista_harness_run_checkpoints where run_id = $1',
        [record.runId],
      )
      const hasAnyCheckpoint = number(checkpointCount.rows[0]?.['count']) > 0
      const requestJson = canonicalJson(record)
      const existingLease = await client.query('select * from purista_harness_run_leases where run_id = $1 for update', [record.runId])
      const existingLeaseRow = existingLease.rows[0] as PgRow | undefined
      if (existingLeaseRow && existingLeaseRow['acquisition_id'] === record.acquisitionId
        && jsonCanonical(existingLeaseRow['request_json']) === requestJson
        && number(existingLeaseRow['acquired_revision']) === current.revision
        && Date.parse(date(existingLeaseRow['expires_at'])) > this.clock()
        && selectedSequence === record.expected.checkpoint.sequence) {
        return this.toLease(client, record, text(existingLeaseRow['lease_id']))
      }
      if (current.revision !== record.expected.revision || current.status !== record.expected.status
        || selectedSequence !== record.expected.checkpoint.sequence
        || (record.mode === 'initial' && (current.revision !== 1 || current.attempt !== undefined || current.workerId !== undefined || hasAnyCheckpoint))
        || (record.mode === 'resume' && current.attempt === undefined)) {
        throw acquisitionConflict()
      }
      await this.assertLeaseAvailable(client, record.runId, record.sessionId, record.workerId)
      const attempt = Math.max((current.attempt ?? 0) + 1, record.requestedAttempt ?? 1)
      await client.query(
        `update purista_harness_runs set attempt = $1, worker_id = $2,
           initial_step_id = coalesce(initial_step_id, $3), status = 'running', revision = revision + 1 where id = $4`,
        [attempt, record.workerId, record.mode === 'initial' ? record.expected.checkpoint.stepId : null, record.runId],
      )
      const leaseId = `lease_${randomUUID()}`
      const acquiredRows = await client.query('select revision from purista_harness_runs where id = $1', [record.runId])
      const acquiredRevision = number(acquiredRows.rows[0]?.['revision'])
      await client.query(
        `insert into purista_harness_run_leases
          (run_id, session_id, worker_id, acquisition_id, request_json, acquired_revision, lease_id, expires_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [record.runId, record.sessionId, record.workerId, record.acquisitionId, requestJson,
          acquiredRevision, leaseId, this.leaseExpiry()],
      )
      const lease = await this.toLease(client, record, leaseId)
      recordAttrs({ 'harness.storage.resumed': lease.resumed, 'harness.storage.attempt': lease.attempt })
      return lease
    })))
  }

  public async replaceCheckpoint(request: ReplaceCheckpointRequest): Promise<void> {
    const normalized = normalizeReplaceCheckpointRequest(request)
    await this.withSessionLock(normalized.sessionId, async () => this.transaction(async (client) => {
      const runRows = await client.query(`select ${RUN_PROJECTION} from purista_harness_runs where id = $1 for update`, [normalized.runId])
      const runRow = runRows.rows[0] as PgRow | undefined
      const run = runRow ? rowToRun(runRow) : undefined
      const lease = await client.query(
        `select run_id from purista_harness_run_leases
         where run_id = $1 and session_id = $2 and lease_id = $3 and worker_id = $4 and expires_at > $5 for update`,
        [normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId, this.nowIso()],
      )
      const currentRows = await client.query(
        `select ${CHECKPOINT_PROJECTION} from purista_harness_run_checkpoints where run_id = $1 and step_id = $2 for update`,
        [normalized.runId, normalized.stepId],
      )
      const currentRow = currentRows.rows[0] as PgRow | undefined
      const current = currentRow ? rowToCheckpoint(currentRow) : undefined
      if (!lease.rows[0] || !run || run.sessionId !== normalized.sessionId || run.status !== 'running'
        || !current || !checkpointIdentityMatches(current, normalized.replacement, run)) throw checkpointConflict()
      if (current.sequence === normalized.replacement.sequence) {
        if (sameInstalledCheckpoint(current, normalized.replacement)) return
        throw checkpointConflict()
      }
      if (current.sequence !== normalized.expectedSequence) throw checkpointConflict()
      const replacement = normalized.replacement
      await client.query(
        `update purista_harness_run_checkpoints set lease_id=$1, worker_id=$2, input_json=$3::jsonb,
           attempt=$4, sequence=$5, output_json=$6::jsonb, replay_json=$7::jsonb,
           metadata_json=$8::jsonb, committed_at=$9 where run_id=$10 and step_id=$11`,
        [replacement.leaseId, replacement.workerId, JSON.stringify(replacement.input), replacement.attempt,
          replacement.sequence, stringify(replacement.output), stringify(replacement.replay),
          stringify(replacement.metadata), replacement.committedAt ?? this.nowIso(), normalized.runId, normalized.stepId],
      )
      await client.query('update purista_harness_runs set revision = revision + 1 where id = $1', [normalized.runId])
    }))
  }

  public async finalizeRun(request: FinalizeRunRequest): Promise<void> {
    const normalized = normalizeFinalizeRunRequest(request)
    await this.withSessionLock(normalized.sessionId, async () => this.transaction(async (client) => {
      const runRows = await client.query(`select ${RUN_PROJECTION} from purista_harness_runs where id = $1 for update`, [normalized.runId])
      const runRow = runRows.rows[0] as PgRow | undefined
      if (!runRow) throw finalizeConflict('run_not_found')
      const run = rowToRun(runRow)
      if (run.sessionId !== normalized.sessionId) throw finalizeConflict('lease_conflict')
      assertApprovalReceiptMatchesRun(normalized.patch.approvalReceipt, run)
      if (isTerminal(run.status)) {
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`run-events:${normalized.runId}`])
        if (!terminalPatchMatchesRun(run, normalized.patch)) throw finalizeConflict('run_conflict')
        if (!terminalEventMatchesPatch(normalized.terminalEvent, normalized.patch)) throw finalizeConflict('event_conflict')
        const eventRows = await client.query(
          'select * from purista_harness_run_events where run_id = $1 and (id = $2 or sequence = $3)',
          [normalized.runId, normalized.terminalEvent.id, normalized.terminalEvent.sequence],
        )
        const eventRow = eventRows.rows[0] as PgRow | undefined
        if (eventRow && canonicalJson(rowToEvent(eventRow)) === canonicalJson(normalized.terminalEvent)) return
        throw finalizeConflict('event_conflict')
      }
      const lease = await client.query(
        `select run_id from purista_harness_run_leases
         where run_id = $1 and session_id = $2 and lease_id = $3 and worker_id = $4 and expires_at > $5 for update`,
        [normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId, this.nowIso()],
      )
      if (!lease.rows[0]) throw finalizeConflict('lease_conflict')
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`run-events:${normalized.runId}`])
      const maximum = await client.query('select max(sequence) as sequence from purista_harness_run_events where run_id = $1', [normalized.runId])
      const collision = await client.query(
        'select id from purista_harness_run_events where run_id = $1 and (id = $2 or sequence = $3)',
        [normalized.runId, normalized.terminalEvent.id, normalized.terminalEvent.sequence],
      )
      if (collision.rows[0] || normalized.terminalEvent.sequence !== Number(maximum.rows[0]?.['sequence'] ?? 0) + 1
        || !terminalEventMatchesPatch(normalized.terminalEvent, normalized.patch)) throw finalizeConflict('event_conflict')
      await client.query(
        `update purista_harness_runs set status=$1, finished_at=$2, output_json=$3::jsonb,
           error_json=$4::jsonb, approval_receipt_json=$5::jsonb, revision=revision+1 where id=$6`,
        [normalized.patch.status, normalized.patch.finishedAt, stringify(normalized.patch.output),
          stringify(normalized.patch.error), stringify(normalized.patch.approvalReceipt), normalized.runId],
      )
      await client.query(
        'insert into purista_harness_run_events(id, sequence, run_id, at, type, payload_json) values($1, $2, $3, $4, $5, $6::jsonb)',
        [normalized.terminalEvent.id, normalized.terminalEvent.sequence, normalized.terminalEvent.runId,
          normalized.terminalEvent.at, normalized.terminalEvent.type, JSON.stringify(normalized.terminalEvent.payload)],
      )
      await client.query('delete from purista_harness_run_checkpoints where run_id = $1', [normalized.runId])
      await client.query('delete from purista_harness_run_leases where run_id = $1', [normalized.runId])
    }))
  }

  public async loadCheckpoint(runId: string, stepId?: string): Promise<RunCheckpoint | undefined> {
    return this.storageSpan('load_checkpoint', { 'harness.run.id': runId }, async () => {
      const rows = stepId === undefined
        ? await this.query(
            `select ${CHECKPOINT_PROJECTION} from purista_harness_run_checkpoints where run_id = $1 order by sequence desc limit 1`,
            [runId],
          )
        : await this.query(
            `select ${CHECKPOINT_PROJECTION} from purista_harness_run_checkpoints where run_id = $1 and step_id = $2 order by sequence desc limit 1`,
            [runId, stepId],
          )
      return rows[0] ? rowToCheckpoint(rows[0]) : undefined
    })
  }

  public async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    const normalized = normalizeRunCheckpoint(checkpoint)
    return this.storageSpan('commit_checkpoint', {
      'harness.storage.attempt': normalized.attempt,
      'harness.storage.sequence': normalized.sequence,
      'harness.storage.step_id': normalized.stepId,
      'harness.run.id': normalized.runId,
      'harness.session.id': normalized.sessionId,
    }, () => this.withSessionLock(normalized.sessionId, async () => {
      const inputJson = JSON.stringify(normalized.input)
      const outputJson = stringify(normalized.output)
      const replayJson = stringify(normalized.replay)
      const metadataJson = stringify(normalized.metadata)
      await this.transaction(async (client) => {
        const runRows = await client.query(`select ${RUN_PROJECTION} from purista_harness_runs where id = $1 for update`, [normalized.runId])
        const runRow = runRows.rows[0] as PgRow | undefined
        const run = runRow ? rowToRun(runRow) : undefined
        const observedAt = this.nowIso()
        const lease = await client.query(
          `select * from purista_harness_run_leases
           where run_id = $1 and session_id = $2 and lease_id = $3 and worker_id = $4 and expires_at > $5 for update`,
          [normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId, observedAt],
        )
        if (!lease.rows[0]) throw new DurableRunLeaseError(`Durable run "${normalized.runId}" is not owned by this lease.`)
        if (!run || run.sessionId !== normalized.sessionId || run.status !== 'running'
          || run.attempt !== normalized.attempt || canonicalJson(run.input) !== canonicalJson(normalized.input)) {
          throw commitCheckpointConflict()
        }
        const existing = await client.query(
          `select ${CHECKPOINT_PROJECTION} from purista_harness_run_checkpoints where run_id = $1 and step_id = $2 for update`,
          [normalized.runId, normalized.stepId],
        )
        const existingRow = existing.rows[0] as PgRow | undefined
        if (existingRow) {
          const stored = rowToCheckpoint(existingRow)
          if (!sameInstalledCheckpoint(stored, normalized)) throw commitCheckpointConflict()
          return
        }
        await client.query(
          `update purista_harness_run_leases set expires_at = $1
           where run_id = $2 and session_id = $3 and lease_id = $4 and worker_id = $5 and expires_at > $6`,
          [this.leaseExpiry(), normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId, observedAt],
        )
        await client.query(
          `insert into purista_harness_run_checkpoints
            (run_id, session_id, lease_id, worker_id, step_id, input_json, attempt, sequence,
             output_json, replay_json, metadata_json, committed_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)`,
          [normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId,
            normalized.stepId, inputJson, normalized.attempt, normalized.sequence,
          outputJson, replayJson, metadataJson, normalized.committedAt ?? this.nowIso()],
        )
        await client.query('update purista_harness_runs set revision = revision + 1 where id = $1', [normalized.runId])
      })
    }))
  }

  public async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [sessionId])
      return fn()
    })
  }

  public async registerWait(request: BoundExternalWaitRequest): Promise<ExternalWaitRegistration> {
    const validated = validateBoundExternalWaitRequest(request)
    return this.storageSpan('register_wait', {
      'harness.run.id': validated.runId,
      'harness.session.id': validated.sessionId,
      'harness.wait.kind': validated.kind,
    }, () => this.withSessionLock(validated.sessionId, async () => this.transaction(async (client) => {
      const existing = await this.expireExternalWait(client, await this.loadExternalWait(client, validated.waitId))
      if (existing) {
        const binding = await client.query(
          'select run_id, session_id from purista_harness_external_waits where wait_id = $1',
          [validated.waitId],
        )
        const row = binding.rows[0]
        if (row?.['run_id'] !== validated.runId || row?.['session_id'] !== validated.sessionId
          || existing.kind !== validated.kind || existing.schemaVersion !== validated.schemaVersion
          || existing.definitionVersion !== validated.definitionVersion || existing.deadline !== validated.deadline) {
          throw new ExternalWaitError('External wait id is already bound to a different request.', 'request_conflict')
        }
        return deepFreeze({ created: false, snapshot: existing })
      }
      const runRows = await client.query(`select ${RUN_PROJECTION} from purista_harness_runs where id = $1 for update`, [validated.runId])
      const runRow = runRows.rows[0] as PgRow | undefined
      const run = runRow ? rowToRun(runRow) : undefined
      if (!run || run.sessionId !== validated.sessionId || run.status !== 'running') {
        throw new ExternalWaitError('External wait run binding is invalid.', 'durable_required')
      }
      const lease = await client.query(
        `select run_id from purista_harness_run_leases
         where run_id = $1 and session_id = $2 and expires_at > $3 for update`,
        [validated.runId, validated.sessionId, this.nowIso()],
      )
      if (!lease.rows[0]) throw new ExternalWaitError('External wait run binding is invalid.', 'durable_required')
      const snapshot = validateExternalWaitSnapshot({
        ...projectExternalWaitRequest(validated), status: 'waiting', createdAt: this.nowIso(),
      })
      await client.query(
        `insert into purista_harness_external_waits
          (wait_id, run_id, session_id, kind, schema_version, definition_version, deadline, status, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [snapshot.waitId, validated.runId, validated.sessionId, snapshot.kind, snapshot.schemaVersion,
          snapshot.definitionVersion, snapshot.deadline, snapshot.status, snapshot.createdAt],
      )
      await client.query("update purista_harness_runs set status = 'waiting', revision = revision + 1 where id = $1", [validated.runId])
      await client.query('delete from purista_harness_run_leases where run_id = $1', [validated.runId])
      return deepFreeze({ created: true, snapshot: deepFreeze(snapshot) })
    })))
  }

  public async getWait(waitId: string): Promise<ExternalWaitSnapshot | undefined> {
    const validated = validateExternalWaitId(waitId)
    return this.transaction(async (client) => this.expireExternalWait(client, await this.loadExternalWait(client, validated)))
  }

  public async signalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult> {
    const validated = validateExternalWaitSignal(signal)
    return this.storageSpan('signal_wait', { 'harness.wait.outcome': validated.outcome }, () => this.resolveExternalWait(validated))
  }

  public async cancelWait(waitId: string, eventId: string, observedAt?: string): Promise<ExternalWaitSignalResult> {
    return this.resolveExternalWait(createExternalWaitCancellation(waitId, eventId, observedAt))
  }

  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.ownsPool) await this.pool.end()
  }

  private async ready(): Promise<void> {
    if (this.closed) {
      throw new HarnessConfigError('PostgreSQL Harness storage is closed.', { reason: 'invalid_storage', path: 'storage.postgres' })
    }
    this.migration ??= this.applyMigration()
    return this.migration
  }

  private async applyMigration(): Promise<void> {
    const migration = readFileSync(fileURLToPath(new URL('../migrations/001_storage.sql', import.meta.url)), 'utf8')
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      await client.query('select pg_advisory_xact_lock($1)', [43_108_003])
      const ownedTables = [
        'purista_harness_sessions', 'purista_harness_messages', 'purista_harness_runs',
        'purista_harness_run_events', 'purista_harness_run_checkpoints', 'purista_harness_run_leases',
        'purista_harness_external_waits', 'purista_harness_external_wait_signals',
      ] as const
      const schemaTable = await client.query("select to_regclass('purista_harness_storage_schema') as name")
      const existingOwned = await Promise.all(ownedTables.map(async (table) => {
        const result = await client.query('select to_regclass($1) as name', [table])
        return result.rows[0]?.['name'] ? table : undefined
      }))
      if (!schemaTable.rows[0]?.['name'] && existingOwned.some(Boolean)) {
        throw incompatibleSchema()
      }
      if (schemaTable.rows[0]?.['name']) {
        const version = await client.query('select version from purista_harness_storage_schema where id = 1')
        if (!version.rows[0] || Number(version.rows[0]['version']) !== 3) throw incompatibleSchema()
      }
      for (const statement of migration.split(/;\s*(?:\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
        await client.query(statement)
      }
      const version = await client.query('select version from purista_harness_storage_schema where id = 1')
      if (Number(version.rows[0]?.['version']) !== 3) throw incompatibleSchema()
      await this.assertV4Schema(client)
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private async assertV4Schema(client: PoolClient): Promise<void> {
    const required: Readonly<Record<string, Readonly<Record<string, string | undefined>>>> = {
      purista_harness_messages: { message_order: 'bigint' },
      purista_harness_runs: { revision: 'bigint', input_json: 'jsonb', validated_input_json: 'jsonb', approval_receipt_json: undefined },
      purista_harness_run_events: { sequence: 'bigint', at: 'timestamp with time zone' },
      purista_harness_run_leases: { acquisition_id: 'text', request_json: 'jsonb', acquired_revision: 'bigint' },
    }
    for (const [table, columns] of Object.entries(required)) {
      const rows = await client.query(
        `select column_name, data_type, is_nullable from information_schema.columns
         where table_schema = current_schema() and table_name = $1`,
        [table],
      )
      const actual = new Map(rows.rows.map((row) => [row['column_name'], row]))
      for (const [column, type] of Object.entries(columns)) {
        const row = actual.get(column)
        if (!row || (type !== undefined && row['data_type'] !== type)
          || (!['approval_receipt_json', 'validated_input_json'].includes(column) && row['is_nullable'] !== 'NO')) throw incompatibleSchema()
      }
    }
    await this.assertUniqueConstraint(client, 'purista_harness_run_events', ['run_id', 'sequence'])
    await this.assertUniqueConstraint(client, 'purista_harness_run_leases', ['acquisition_id'])
    await this.assertUniqueIndex(client, 'purista_harness_messages', ['session_id', 'message_order'])
    await this.assertValidatedInputKindSemantics(client)
  }

  private async assertValidatedInputKindSemantics(client: PoolClient): Promise<void> {
    const constraints = await client.query(
      `select pg_get_constraintdef(oid) as definition
       from pg_constraint
       where conrelid = 'purista_harness_runs'::regclass and contype = 'c'`,
    )
    if (!constraints.rows.some((row) => hasValidatedInputKindSemantics(row['definition']))) throw incompatibleSchema()
  }

  private async assertUniqueConstraint(client: PoolClient, table: string, columns: readonly string[]): Promise<void> {
    const constraints = await client.query(
      `select tc.constraint_name, array_agg(kcu.column_name order by kcu.ordinal_position) as columns
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
       where tc.table_schema = current_schema() and tc.table_name = $1 and tc.constraint_type = 'UNIQUE'
       group by tc.constraint_name`,
      [table],
    )
    if (!constraints.rows.some((row) => canonicalJson(row['columns']) === canonicalJson(columns))) throw incompatibleSchema()
  }

  private async assertUniqueIndex(client: PoolClient, table: string, columns: readonly string[]): Promise<void> {
    const indexes = await client.query(
      `select array_agg(attribute.attname order by key_column.ordinality) as columns
       from pg_index index_definition
       join pg_class relation on relation.oid = index_definition.indrelid
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       join unnest(index_definition.indkey) with ordinality as key_column(attribute_number, ordinality) on true
       join pg_attribute attribute on attribute.attrelid = relation.oid and attribute.attnum = key_column.attribute_number
       where namespace.nspname = current_schema() and relation.relname = $1
         and index_definition.indisunique and index_definition.indisvalid and index_definition.indisready
         and index_definition.indpred is null
       group by index_definition.indexrelid`,
      [table],
    )
    if (!indexes.rows.some((row) => canonicalJson(row['columns']) === canonicalJson(columns))) throw incompatibleSchema()
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ready()
    const active = this.transactionContext.getStore()
    if (active) return operation(active)
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const result = await this.transactionContext.run(client, () => operation(client))
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  private async query(sql: string, values: readonly unknown[]): Promise<PgRow[]> {
    await this.ready()
    const client = this.transactionContext.getStore()
    const result = client
      ? await client.query(sql, values as unknown[])
      : await this.pool.query(sql, values as unknown[])
    return result.rows as PgRow[]
  }

  private async assertLeaseAvailable(client: PoolClient, runId: string, sessionId: string, workerId: string): Promise<void> {
    const now = this.nowIso()
    await client.query('delete from purista_harness_run_leases where run_id = $1 and expires_at <= $2', [runId, now])
    await client.query('delete from purista_harness_run_leases where session_id = $1 and expires_at <= $2', [sessionId, now])
    const runLease = await client.query('select * from purista_harness_run_leases where run_id = $1 for update', [runId])
    if (runLease.rows[0]) {
      throw new StateError('A competing durable run lease is active.', { op: 'acquireRun', reason: 'lease_conflict' })
    }
    const sessionLease = await client.query(
      'select * from purista_harness_run_leases where session_id = $1 and run_id <> $2 for update',
      [sessionId, runId],
    )
    if (sessionLease.rows[0]) {
      throw new StateError('A competing durable session lease is active.', { op: 'acquireRun', reason: 'lease_conflict' })
    }
  }

  private async toLease(client: PoolClient, request: AcquireRunRequest, leaseId: string): Promise<DurableRunLease> {
    const runRows = await client.query(`select ${RUN_PROJECTION} from purista_harness_runs where id = $1`, [request.runId])
    const runRow = runRows.rows[0] as PgRow | undefined
    if (!runRow) throw new DurableRunLeaseError(`Durable run "${request.runId}" has not been started.`)
    const checkpointRows = await client.query(
      `select ${CHECKPOINT_PROJECTION} from purista_harness_run_checkpoints where run_id = $1 order by sequence asc`,
      [request.runId],
    )
    const checkpoints = (checkpointRows.rows as PgRow[]).map(rowToCheckpoint)
    const selected = checkpoints.find((checkpoint) => checkpoint.stepId === request.expected.checkpoint.stepId)
    const run = rowToRun(runRow)
    return deepFreeze({
      runId: request.runId,
      sessionId: run.sessionId,
      workerId: request.workerId,
      acquisitionId: request.acquisitionId,
      leaseId,
      attempt: run.attempt!,
      resumed: request.mode === 'resume',
      acquiredFrom: deepFreeze(structuredClone(request.expected)),
      run,
      ...(selected ? { checkpoint: selected } : {}),
      checkpoints: Object.freeze(checkpoints),
      release: async () => {
        await this.withSessionLock(request.sessionId, async () => this.transaction(async (releaseClient) => {
          await releaseClient.query('select id from purista_harness_runs where id = $1 for update', [request.runId])
          const deleted = await releaseClient.query(
            `delete from purista_harness_run_leases
             where run_id = $1 and session_id = $2 and worker_id = $3 and lease_id = $4 and acquisition_id = $5
               and expires_at > $6
             returning run_id`,
            [request.runId, request.sessionId, request.workerId, leaseId, request.acquisitionId, this.nowIso()],
          )
          if (deleted.rowCount === 1) {
            await releaseClient.query(
              "update purista_harness_runs set status = 'interrupted', revision = revision + 1 where id = $1 and status = 'running'",
              [request.runId],
            )
          }
        }))
      },
    })
  }

  private async loadExternalWait(client: PoolClient, waitId: string): Promise<ExternalWaitSnapshot | undefined> {
    const rows = await client.query('select * from purista_harness_external_waits where wait_id = $1 for update', [waitId])
    const row = rows.rows[0] as PgRow | undefined
    if (!row) return undefined
    return deepFreeze(validateExternalWaitSnapshot({
      waitId: text(row['wait_id']),
      kind: text(row['kind']),
      schemaVersion: text(row['schema_version']),
      definitionVersion: text(row['definition_version']),
      deadline: date(row['deadline']),
      status: text(row['status']),
      createdAt: date(row['created_at']),
      ...optional('resolvedAt', nullableDate(row['resolved_at'])),
      ...optional('eventId', nullableText(row['event_id'])),
    }))
  }

  private async expireExternalWait(client: PoolClient, snapshot: ExternalWaitSnapshot | undefined): Promise<ExternalWaitSnapshot | undefined> {
    if (!snapshot || snapshot.status !== 'waiting' || Date.parse(snapshot.deadline) > this.clock()) return snapshot
    const expired = validateExternalWaitSnapshot({
      waitId: snapshot.waitId,
      kind: snapshot.kind,
      schemaVersion: snapshot.schemaVersion,
      definitionVersion: snapshot.definitionVersion,
      deadline: snapshot.deadline,
      status: 'expired',
      createdAt: snapshot.createdAt,
      resolvedAt: this.nowIso(),
    })
    const resolved = asExternalWaitResolved(expired)
    if (!resolved) throw new ExternalWaitError('External wait adapter returned an invalid snapshot.', 'invalid_snapshot')
    await client.query(
      'update purista_harness_external_waits set status = $1, resolved_at = $2 where wait_id = $3',
      [resolved.status, resolved.resolvedAt, resolved.waitId],
    )
    return deepFreeze(resolved)
  }

  private async resolveExternalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult> {
    return this.transaction(async (client) => {
      const snapshot = await this.expireExternalWait(client, await this.loadExternalWait(client, signal.waitId))
      if (!snapshot) return deepFreeze(validateExternalWaitSignalResult({ kind: 'not_found' }))
      const duplicate = await client.query(
        'select event_id from purista_harness_external_wait_signals where wait_id = $1 and event_id = $2',
        [signal.waitId, signal.eventId],
      )
      if (duplicate.rows[0]) return deepFreeze(validateExternalWaitSignalResult({ kind: 'duplicate', snapshot }))
      await client.query(
        'insert into purista_harness_external_wait_signals(wait_id, event_id) values ($1, $2)',
        [signal.waitId, signal.eventId],
      )
      if (snapshot.status !== 'waiting') return deepFreeze(validateExternalWaitSignalResult({ kind: 'already_terminal', snapshot }))
      const resolved = validateExternalWaitSnapshot({
        waitId: snapshot.waitId,
        kind: snapshot.kind,
        schemaVersion: snapshot.schemaVersion,
        definitionVersion: snapshot.definitionVersion,
        deadline: snapshot.deadline,
        status: signal.outcome,
        createdAt: snapshot.createdAt,
        resolvedAt: signal.observedAt ?? this.nowIso(),
        eventId: signal.eventId,
      })
      const terminal = asExternalWaitResolved(resolved)
      if (!terminal) throw new ExternalWaitError('External wait adapter returned an invalid snapshot.', 'invalid_snapshot')
      await client.query(
        'update purista_harness_external_waits set status = $1, resolved_at = $2, event_id = $3 where wait_id = $4',
        [terminal.status, terminal.resolvedAt, signal.eventId, signal.waitId],
      )
      return deepFreeze(validateExternalWaitSignalResult({ kind: 'applied', snapshot: terminal }))
    })
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString()
  }

  private leaseExpiry(): string {
    return new Date(this.clock() + this.leaseTtlMs).toISOString()
  }

  private async storageSpan<T>(
    operation: string,
    attrs: SpanAttrs,
    fn: (recordAttrs: (extra: SpanAttrs) => void) => Promise<T>,
  ): Promise<T> {
    const merged: SpanAttrs = {
      'harness.storage.adapter': this.info.id,
      'harness.storage.operation': operation,
      'harness.storage.persistent': true,
      ...attrs,
    }
    const started = Date.now()
    const run = async (span?: { setAttributes(next: Record<string, string | number | boolean | string[]>): unknown }): Promise<T> => {
      const recordAttrs = (extra: SpanAttrs): void => {
        Object.assign(merged, extra)
        span?.setAttributes(definedAttrs(extra))
      }
      try {
        const result = await fn(recordAttrs)
        this.telemetry?.recordCounter('harness.storage.operations', 1, merged)
        return result
      } catch (error) {
        this.logger?.warn('PostgreSQL Harness storage operation failed.', {
          operation,
          error_type: error instanceof Error ? error.name : 'UnknownError',
        })
        throw error
      } finally {
        this.telemetry?.recordHistogram('harness.storage.operation.duration', (Date.now() - started) / 1000, merged)
      }
    }
    return this.telemetry
      ? this.telemetry.span(`harness.storage.${operation}`, merged, (span) => run(span))
      : run()
  }
}

function rowToSession(row: PgRow): SessionRecord {
  const sandboxBinding = json<SessionRecord['sandboxBinding']>(row['sandbox_binding_json'])
  if (!sandboxBinding) throw malformedRow()
  assertSessionSandboxBindingTransition(sandboxBinding, sandboxBinding, 'getSession')
  return deepFreeze({
    id: text(row['id']),
    instanceId: text(row['instance_id']),
    createdAt: date(row['created_at']),
    updatedAt: date(row['updated_at']),
    runCount: number(row['run_count']),
    ...optional('identity', json<SessionRecord['identity']>(row['identity_json'])),
    sandboxBinding,
    ...optional('metadata', json<Record<string, JsonValue>>(row['metadata_json'])),
  })
}

function rowToMessage(row: PgRow): Message {
  return deepFreeze({
    id: text(row['id']),
    sessionId: text(row['session_id']),
    ...optional('runId', nullableText(row['run_id'])),
    role: text(row['role']) as Message['role'],
    content: text(row['content']),
    ...optional('toolCalls', json<Message['toolCalls']>(row['tool_calls_json'])),
    ...optional('toolResults', json<Message['toolResults']>(row['tool_results_json'])),
    timestamp: date(row['created_at']),
  })
}

function bigint(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  throw malformedRow()
}

function rowToRun(row: PgRow): RunRecord {
  const input = json<JsonValue>(row['input_json']) ?? null
  const kind = text(row['kind']) as RunRecord['kind']
  const hasValidatedInput = boolean(row['has_validated_input'])
  const validatedInput = jsonIncludingNull<JsonValue>(row['validated_input_json'])
  const hasOutput = boolean(row['has_output'])
  const hasApprovalReceipt = boolean(row['has_approval_receipt'])
  const output = json<JsonValue>(row['output_json']) ?? null
  const record = {
    id: text(row['id']),
    sessionId: text(row['session_id']),
    kind,
    target: text(row['target']),
    startedAt: date(row['started_at']),
    ...optional('finishedAt', nullableDate(row['finished_at'])),
    status: text(row['status']) as RunRecord['status'],
    revision: number(row['revision']),
    input,
    ...(hasValidatedInput ? { validatedInput } : {}),
    ...(hasOutput ? { output } : {}),
    ...optional('error', json<NonNullable<RunRecord['error']>>(row['error_json'])),
    ...(hasApprovalReceipt ? { approvalReceipt: json<NonNullable<RunRecord['approvalReceipt']>>(row['approval_receipt_json']) } : {}),
    ...optional('attempt', nullableNumber(row['attempt'])),
    ...optional('workerId', nullableText(row['worker_id'])),
    ...optional('initialStepId', nullableText(row['initial_step_id'])),
    ...optional('metadata', json<Record<string, JsonValue>>(row['metadata_json'])),
  } as RunRecord
  validateRunRecord(record)
  return deepFreeze(record)
}

function validateRunRecord(record: RunRecord): void {
  if (!validId(record.id) || !validId(record.sessionId) || !validId(record.target)
    || !['agent', 'workflow', 'child_task'].includes(record.kind) || !validTimestamp(record.startedAt)
    || !['running', 'waiting', 'interrupted', 'succeeded', 'failed', 'cancelled'].includes(record.status)
    || !positive(record.revision) || !isJsonValue(record.input)
    || (record.metadata !== undefined && (!plain(record.metadata) || !isJsonValue(record.metadata)))
    || (record.attempt !== undefined && !positive(record.attempt))
    || (record.workerId !== undefined && !validId(record.workerId))
    || (record.initialStepId !== undefined && !validId(record.initialStepId))) throw malformedRow()
  const hasValidatedInput = Object.hasOwn(record, 'validatedInput')
  if (record.kind === 'child_task' ? hasValidatedInput : !hasValidatedInput
    || !isJsonValue(record.validatedInput)) throw malformedRow()
  const terminal = isTerminal(record.status)
  if (!terminal) {
    if (record.finishedAt !== undefined || Object.hasOwn(record, 'output') || record.error !== undefined
      || Object.hasOwn(record, 'approvalReceipt')) throw malformedRow()
    return
  }
  if (!validTimestamp(record.finishedAt)) throw malformedRow()
  if (record.status === 'succeeded') {
    if (!Object.hasOwn(record, 'output') || !isJsonValue(record.output) || record.error !== undefined) throw malformedRow()
  } else if (Object.hasOwn(record, 'output') || !validSerializedError(record.error)) throw malformedRow()
  if (Object.hasOwn(record, 'approvalReceipt')) {
    if (record.approvalReceipt === undefined) throw malformedRow()
    try {
      validateApprovalReceipt(record.approvalReceipt)
      assertApprovalReceiptMatchesRun(record.approvalReceipt, record)
    } catch { throw malformedRow() }
  }
}

function rowToEvent(row: PgRow): PersistedRunEvent {
  return deepFreeze({
    id: text(row['id']),
    sequence: number(row['sequence']),
    runId: text(row['run_id']),
    at: date(row['at']),
    type: text(row['type']) as PersistedRunEvent['type'],
    payload: json<JsonValue>(row['payload_json']) ?? null,
  })
}

function rowToCheckpoint(row: PgRow): RunCheckpoint {
  const hasOutput = boolean(row['has_output'])
  const output = json<JsonValue>(row['output_json']) ?? null
  return deepFreeze({
    runId: text(row['run_id']),
    sessionId: text(row['session_id']),
    leaseId: text(row['lease_id']),
    workerId: text(row['worker_id']),
    stepId: text(row['step_id']),
    input: json<JsonValue>(row['input_json']) ?? null,
    attempt: number(row['attempt']),
    sequence: number(row['sequence']),
    ...(hasOutput ? { output } : {}),
    ...optional('replay', json<DurableReplayCheckpoint>(row['replay_json'])),
    ...optional('metadata', json<Record<string, JsonValue>>(row['metadata_json'])),
    committedAt: date(row['committed_at']),
  })
}

function incompatibleSchema(): HarnessConfigError {
  return new HarnessConfigError(
    'Incompatible PostgreSQL Harness storage schema detected. Use the matching package migration.',
    { reason: 'postgres_schema_incompatible', path: 'storage.postgres' },
  )
}

function stringify(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

function json<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

function jsonIncludingNull<T>(value: unknown): T | undefined {
  if (value === undefined) return undefined
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw malformedRow()
  return value
}

function nullableText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value)
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw malformedRow()
  return parsed
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw malformedRow()
  return value
}

function nullableNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : number(value)
}

function date(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  const parsed = text(value)
  const timestamp = new Date(parsed)
  if (!Number.isFinite(timestamp.getTime())) throw malformedRow()
  return timestamp.toISOString()
}

function nullableDate(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : date(value)
}

function malformedRow(): StateError {
  return new StateError('PostgreSQL Harness storage row is malformed.', { op: 'getRun', reason: 'malformed_storage_row' })
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505')
    || /duplicate key|unique constraint/i.test(error instanceof Error ? error.message : String(error))
}

function push(values: unknown[], value: unknown): number {
  values.push(value)
  return values.length
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]: V }
}

function canonicalJson(value: unknown): string {
  return encodeCanonicalJson(value, new Set<object>())
}

function encodeCanonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON numbers must be finite.')
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') throw new TypeError('Canonical JSON values must contain only JSON data.')
  if (ancestors.has(value)) throw new TypeError('Canonical JSON values must not contain cycles.')
  ancestors.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== 'string')) throw new TypeError('Canonical JSON values must not contain symbol keys.')
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('Canonical JSON arrays must use the standard prototype.')
      const length = descriptors['length']
      if (!length || !('value' in length) || length.value !== value.length) throw new TypeError('Canonical JSON arrays must have a data length.')
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Canonical JSON arrays must be dense enumerable data.')
        items.push(encodeCanonicalJson(descriptor.value, ancestors))
      }
      if (keys.length !== value.length + 1) throw new TypeError('Canonical JSON arrays must contain only indexes and length.')
      return `[${items.join(',')}]`
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Canonical JSON objects must be plain records.')
    const stringKeys = keys as string[]
    for (const key of stringKeys) {
      const descriptor = descriptors[key]
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new TypeError('Canonical JSON objects must contain only enumerable data properties.')
    }
    stringKeys.sort(codePointCompare)
    return `{${stringKeys.map((key) => `${JSON.stringify(key)}:${encodeCanonicalJson((descriptors[key] as PropertyDescriptor & { value: unknown }).value, ancestors)}`).join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function jsonCanonical(value: unknown): string {
  return canonicalJson(json<unknown>(value))
}

function codePointCompare(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!)
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!
  }
  return leftPoints.length - rightPoints.length
}

function hasValidatedInputKindSemantics(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.toLowerCase().replace(/\s+/g, '')
  return normalized === "check((((kind=any(array['agent'::text,'workflow'::text]))and(validated_input_jsonisnotnull))or((kind='child_task'::text)and(validated_input_jsonisnull))))"
}

function definedAttrs(attrs: SpanAttrs): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {}
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined) out[key] = value
  return out
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function normalizeCreateRunRequest(value: CreateRunRequest): CreateRunRequest {
  if (!plain(value) || !isJsonValue(value) || !exactKeys(value, ['id', 'sessionId', 'kind', 'target', 'startedAt', 'input', 'validatedInput', 'metadata'])
    || !hasKeys(value, ['id', 'sessionId', 'kind', 'target', 'startedAt', 'input'])
    || !validId(value.id) || !validId(value.sessionId) || !validId(value.target)
    || !['agent', 'workflow', 'child_task'].includes(value.kind) || !validTimestamp(value.startedAt)
    || (value.kind === 'child_task' ? Object.hasOwn(value, 'validatedInput') : !Object.hasOwn(value, 'validatedInput'))
    || !isJsonValue(value.input)
    || (Object.hasOwn(value, 'metadata') && (value.metadata === undefined || !plain(value.metadata) || !isJsonValue(value.metadata)))) throw runConflict()
  try {
    canonicalJson(value.input)
    if (value.kind !== 'child_task') canonicalJson(value['validatedInput'])
    if (value.metadata !== undefined) canonicalJson(value.metadata)
  } catch { throw runConflict() }
  return deepFreeze(structuredClone(value))
}

function normalizeAcquireRunRequest(value: AcquireRunRequest): AcquireRunRequest {
  if (!plain(value) || !isJsonValue(value) || !exactKeys(value, ['mode', 'runId', 'sessionId', 'workerId', 'acquisitionId', 'expected', 'requestedAttempt'])
    || !hasKeys(value, ['mode', 'runId', 'sessionId', 'workerId', 'acquisitionId', 'expected'])
    || !['initial', 'resume'].includes(value.mode) || !validId(value.runId) || !validId(value.sessionId)
    || !validId(value.workerId) || !/^acq_[a-f0-9]{64}$/.test(value.acquisitionId)
    || !plain(value.expected) || !exactKeys(value.expected, ['revision', 'status', 'checkpoint'])
    || !hasKeys(value.expected, ['revision', 'status', 'checkpoint'])
    || !positive(value.expected.revision) || !['running', 'waiting', 'interrupted'].includes(value.expected.status)
    || !plain(value.expected.checkpoint) || !exactKeys(value.expected.checkpoint, ['stepId', 'sequence'])
    || !hasKeys(value.expected.checkpoint, ['stepId', 'sequence'])
    || !validId(value.expected.checkpoint.stepId)
    || (value.expected.checkpoint.sequence !== null && !positive(value.expected.checkpoint.sequence))
    || (Object.hasOwn(value, 'requestedAttempt') && (value.requestedAttempt === undefined || !positive(value.requestedAttempt)))) throw acquisitionConflict()
  const acquisitionId = `acq_${createHash('sha256').update(canonicalJson([
    'harness-run-acquisition-v1', value.mode, value.runId, value.sessionId, value.workerId,
    value.expected.revision, value.expected.status, value.expected.checkpoint.stepId,
    value.expected.checkpoint.sequence, value.requestedAttempt ?? null,
  ])).digest('hex')}`
  if (value.acquisitionId !== acquisitionId) throw acquisitionConflict()
  return deepFreeze(structuredClone(value))
}

function normalizePersistedEvent<Event extends PersistedRunEvent>(
  value: Event,
  runId: string,
  op: 'appendEvents' | 'finalizeRun' = 'appendEvents',
): Event {
  if (!plain(value) || !isJsonValue(value) || !exactKeys(value, ['id', 'sequence', 'runId', 'at', 'type', 'payload'])
    || value.runId !== runId || !positive(value.sequence) || !validTimestamp(value.at)
    || !harnessExecutionEventTypesV1.includes(value.type) || !isJsonValue(value.payload)
    || value.id !== `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', value.runId, value.sequence, value.type])).digest('hex')}`) {
    throw new StateError('Run event is invalid.', { op, reason: 'event_conflict' })
  }
  try { canonicalJson(value.payload) } catch {
    throw new StateError('Run event is invalid.', { op, reason: 'event_conflict' })
  }
  return deepFreeze(structuredClone(value))
}

function normalizeReplaceCheckpointRequest(value: ReplaceCheckpointRequest): ReplaceCheckpointRequest {
  if (!plain(value) || !isJsonValue(value) || !exactKeys(value, ['runId', 'sessionId', 'stepId', 'expectedSequence', 'leaseId', 'workerId', 'replacement'])
    || !validId(value.runId) || !validId(value.sessionId) || !validId(value.stepId) || !positive(value.expectedSequence)
    || !validId(value.leaseId) || !validId(value.workerId) || !plain(value.replacement)
    || !exactKeys(value.replacement, ['runId', 'sessionId', 'leaseId', 'workerId', 'stepId', 'input', 'attempt', 'sequence', 'output', 'replay', 'metadata', 'committedAt'])
    || value.replacement.runId !== value.runId || value.replacement.sessionId !== value.sessionId
    || value.replacement.stepId !== value.stepId || value.replacement.leaseId !== value.leaseId
    || value.replacement.workerId !== value.workerId || !positive(value.replacement.attempt)
    || value.replacement.sequence <= value.expectedSequence
    || (value.replacement.output === undefined && Object.hasOwn(value.replacement, 'output'))
    || (value.replacement.replay === undefined && Object.hasOwn(value.replacement, 'replay'))
    || (value.replacement.metadata === undefined && Object.hasOwn(value.replacement, 'metadata'))
    || (value.replacement.committedAt === undefined && Object.hasOwn(value.replacement, 'committedAt'))
    || !isJsonValue(value.replacement.input)
    || (value.replacement.output !== undefined && !isJsonValue(value.replacement.output))
    || (value.replacement.replay !== undefined && !isJsonValue(value.replacement.replay))
    || (value.replacement.metadata !== undefined && (!plain(value.replacement.metadata) || !isJsonValue(value.replacement.metadata)))
    || (value.replacement.committedAt !== undefined && !validTimestamp(value.replacement.committedAt))) throw checkpointConflict()
  try {
    canonicalJson(value.replacement.input)
    if (value.replacement.output !== undefined) canonicalJson(value.replacement.output)
    if (value.replacement.replay !== undefined) canonicalJson(value.replacement.replay)
    if (value.replacement.metadata !== undefined) canonicalJson(value.replacement.metadata)
  } catch { throw checkpointConflict() }
  return deepFreeze(structuredClone(value))
}

function normalizeFinalizeRunRequest(value: FinalizeRunRequest): FinalizeRunRequest {
  if (!plain(value) || !isJsonValue(value) || !exactKeys(value, ['runId', 'sessionId', 'leaseId', 'workerId', 'patch', 'terminalEvent', 'checkpointDisposition'])
    || !validId(value.runId) || !validId(value.sessionId) || !validId(value.leaseId) || !validId(value.workerId)
    || value.checkpointDisposition !== 'delete-all' || !plain(value.patch)) throw finalizeConflict('run_conflict')
  const patch = value.patch
  if (!exactKeys(patch, ['status', 'finishedAt', 'output', 'error', 'approvalReceipt']) || !validTimestamp(patch.finishedAt)) throw finalizeConflict('run_conflict')
  if (Object.hasOwn(patch, 'approvalReceipt') && patch.approvalReceipt === undefined) throw finalizeConflict('run_conflict')
  if (patch.status === 'succeeded') {
    if (!Object.hasOwn(patch, 'output') || Object.hasOwn(patch, 'error')) throw finalizeConflict('run_conflict')
    if (!isJsonValue(patch.output)) throw finalizeConflict('run_conflict')
  } else if (patch.status === 'failed' || patch.status === 'cancelled') {
    if (Object.hasOwn(patch, 'output') || !validSerializedError(patch.error)) throw finalizeConflict('run_conflict')
  } else throw finalizeConflict('run_conflict')
  if (patch.approvalReceipt !== undefined) validateApprovalReceipt(patch.approvalReceipt)
  const terminalEvent = normalizePersistedEvent(value.terminalEvent, value.runId, 'finalizeRun')
  return deepFreeze(structuredClone({ ...(value as FinalizeRunRequest), terminalEvent }))
}

function checkpointIdentityMatches(current: RunCheckpoint, replacement: RunCheckpoint, run: RunRecord): boolean {
  return current.runId === replacement.runId && current.sessionId === replacement.sessionId
    && current.stepId === replacement.stepId && run.attempt === replacement.attempt
    && canonicalJson(current.input) === canonicalJson(replacement.input)
    && canonicalJson(run.input) === canonicalJson(replacement.input)
}

function sameInstalledCheckpoint(current: RunCheckpoint, replacement: RunCheckpoint): boolean {
  return canonicalJson(current) === canonicalJson({ ...replacement, committedAt: replacement.committedAt ?? current.committedAt })
}

function normalizeRunCheckpoint(value: RunCheckpoint): RunCheckpoint {
  if (!plain(value) || !exactKeys(value, [
    'runId', 'sessionId', 'leaseId', 'workerId', 'stepId', 'input', 'attempt', 'sequence',
    'output', 'replay', 'metadata', 'committedAt',
  ]) || !validId(value.runId) || !validId(value.sessionId) || !validId(value.leaseId)
    || !validId(value.workerId) || !validId(value.stepId) || !positive(value.attempt) || !positive(value.sequence)
    || !isJsonValue(value.input)
    || (Object.hasOwn(value, 'output') && value.output === undefined)
    || (Object.hasOwn(value, 'replay') && value.replay === undefined)
    || (Object.hasOwn(value, 'metadata') && value.metadata === undefined)
    || (Object.hasOwn(value, 'committedAt') && value.committedAt === undefined)
    || (value.output !== undefined && !isJsonValue(value.output))
    || (value.replay !== undefined && !isJsonValue(value.replay))
    || (value.metadata !== undefined && (!plain(value.metadata) || !isJsonValue(value.metadata)))
    || (value.committedAt !== undefined && !validTimestamp(value.committedAt))) throw commitCheckpointConflict()
  return deepFreeze(structuredClone(value))
}

function normalizeFinishRunPatch(value: FinishRunPatch, now: () => string): FinishRunPatch {
  if (!plain(value) || !exactKeys(value, ['status', 'finishedAt', 'output', 'error'])
    || !['running', 'waiting', 'interrupted', 'succeeded', 'failed', 'cancelled'].includes(value.status)) {
    throw finishRunConflict()
  }
  if (value.status === 'running' || value.status === 'waiting' || value.status === 'interrupted') {
    if (Object.hasOwn(value, 'finishedAt') || Object.hasOwn(value, 'output') || Object.hasOwn(value, 'error')) {
      throw finishRunConflict()
    }
    return deepFreeze(structuredClone(value))
  }
  if (Object.hasOwn(value, 'finishedAt') && value.finishedAt === undefined) throw finishRunConflict()
  const finishedAt = value.finishedAt ?? now()
  if (!validTimestamp(finishedAt)) throw finishRunConflict()
  if (value.status === 'succeeded') {
    if (!Object.hasOwn(value, 'output') || !isJsonValue(value.output) || Object.hasOwn(value, 'error')) {
      throw finishRunConflict()
    }
  } else if (Object.hasOwn(value, 'output') || !validSerializedError(value.error)) {
    throw finishRunConflict()
  }
  return deepFreeze(structuredClone({ ...value, finishedAt }))
}

function terminalPatchMatchesRun(run: RunRecord, patch: FinalizeRunRequest['patch']): boolean {
  if (run.status !== patch.status || run.finishedAt !== patch.finishedAt
    || canonicalJson(run.approvalReceipt ?? null) !== canonicalJson(patch.approvalReceipt ?? null)) return false
  return patch.status === 'succeeded'
    ? canonicalJson(run.output) === canonicalJson(patch.output) && run.error === undefined
    : canonicalJson(run.error) === canonicalJson(patch.error) && run.output === undefined
}

function terminalEventMatchesPatch(event: PersistedFinalRunEvent, patch: FinalizeRunRequest['patch']): boolean {
  if (event.type !== 'run.finished' || event.at !== patch.finishedAt || !plain(event.payload)
    || !exactKeys(event.payload, ['parentRunId', 'parentInvocationId', 'outcome'])
    || !plain(event.payload['outcome'])) return false
  const hasParentRunId = Object.hasOwn(event.payload, 'parentRunId')
  const hasParentInvocationId = Object.hasOwn(event.payload, 'parentInvocationId')
  if (hasParentRunId !== hasParentInvocationId
    || (hasParentRunId && (!validId(event.payload['parentRunId']) || !validId(event.payload['parentInvocationId'])))) return false
  const outcome = event.payload['outcome']
  if (patch.status === 'succeeded') return exactKeys(outcome, ['status']) && outcome['status'] === 'completed'
  return exactKeys(outcome, ['status', 'error']) && Object.hasOwn(outcome, 'error')
    && outcome['status'] === patch.status && validSerializedError(outcome['error'])
    && canonicalJson(outcome['error']) === canonicalJson(patch.error)
}

function validateApprovalReceipt(value: NonNullable<FinalizeRunRequest['patch']['approvalReceipt']>): void {
  if (!plain(value) || !exactKeys(value, ['schemaVersion', 'interruptId', 'resumeEventId', 'decisions', 'deploymentRevision', 'compiledGraphDigest', 'sessionIdentityDigest', 'rootTarget'])
    || value.schemaVersion !== 1 || !validId(value.interruptId) || !validId(value.resumeEventId)
    || typeof value.deploymentRevision !== 'string' || value.deploymentRevision.length === 0
    || !/^sha256:[a-f0-9]{64}$/.test(value.compiledGraphDigest) || !/^sha256:[a-f0-9]{64}$/.test(value.sessionIdentityDigest)
    || !plain(value.rootTarget) || !exactKeys(value.rootTarget, ['kind', 'id'])
    || !['agent', 'workflow'].includes(value.rootTarget['kind'] as string) || !validId(value.rootTarget['id'])
    || !Array.isArray(value.decisions)) throw finalizeConflict('run_conflict')
  let previous: string | undefined
  for (const decision of value.decisions) {
    if (!plain(decision) || !exactKeys(decision, ['approvalId', 'approved']) || !validId(decision['approvalId'])
      || typeof decision['approved'] !== 'boolean' || (previous !== undefined && previous >= decision['approvalId'])) throw finalizeConflict('run_conflict')
    previous = decision['approvalId']
  }
}

function assertApprovalReceiptMatchesRun(receipt: FinalizeRunRequest['patch']['approvalReceipt'], run: RunRecord): void {
  if (receipt === undefined) return
  if (run.kind === 'child_task' || receipt.rootTarget.kind !== run.kind || receipt.rootTarget.id !== run.target) throw finalizeConflict('run_conflict')
}

function validSerializedError(value: unknown): value is SerializedError {
  if (!plain(value) || !exactKeys(value, ['code', 'message', 'category', 'retriable', 'meta'])
    || !isJsonValue(value)
    || typeof value['code'] !== 'string' || value['code'].length === 0 || typeof value['message'] !== 'string'
    || (value['category'] !== undefined && typeof value['category'] !== 'string')
    || (value['retriable'] !== undefined && typeof value['retriable'] !== 'boolean')
    || (value['meta'] !== undefined && !plain(value['meta']))) return false
  try { canonicalJson(value) } catch { return false }
  return true
}

function runCreationBytes(value: CreateRunRequest | RunRecord): string {
  return canonicalJson(['harness-run-create-v1', value.id, value.sessionId, value.kind, value.target,
    value.startedAt, value.input, Object.hasOwn(value, 'validatedInput'), value.kind === 'child_task' ? null : value.validatedInput,
    Object.hasOwn(value, 'metadata'), value.metadata ?? null])
}
function runConflict(): StateError { return new StateError('Run creation conflicts with an existing logical run.', { op: 'createRun', reason: 'run_conflict' }) }
function acquisitionConflict(): StateError { return new StateError('Run acquisition conflicts with the observed state.', { op: 'acquireRun', reason: 'acquisition_conflict' }) }
function checkpointConflict(): StateError { return new StateError('Checkpoint replacement conflicts with stored state.', { op: 'replaceCheckpoint', reason: 'checkpoint_conflict' }) }
function commitCheckpointConflict(): StateError { return new StateError('Durable checkpoint conflicts with the installed record.', { op: 'commitCheckpoint', reason: 'checkpoint_conflict' }) }
function finishRunConflict(): StateError { return new StateError('Run transition is invalid.', { op: 'finishRun', reason: 'run_conflict' }) }
function finalizeConflict(reason: 'run_conflict' | 'run_not_found' | 'lease_conflict' | 'event_conflict'): StateError {
  return new StateError('Run finalization conflicts with stored state.', { op: 'finalizeRun', reason })
}
function isTerminal(status: RunStatus): boolean { return status === 'succeeded' || status === 'failed' || status === 'cancelled' }
function validId(value: unknown): value is string { return typeof value === 'string' && identifier.test(value) }
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && timestamp.test(value) && new Date(value).toISOString() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function exactKeys(value: object, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))
}
function hasKeys(value: object, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key))
}
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
