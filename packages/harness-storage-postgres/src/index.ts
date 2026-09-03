import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Pool, type Pool as PgPool, type PoolClient } from 'pg'

import {
  DurableRunLeaseError,
  DurableStepError,
  DurableTerminalRunError,
  ExternalWaitError,
  HarnessConfigError,
  StateError,
  WorkspaceError,
  isResumeBlockingRunStatus,
  type AdapterCapability,
  type DurableReplayCheckpoint,
  type DurableRunLease,
  type DurableRunStart,
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
type PgRow = Record<string, unknown>

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
 * const harness = defineHarness().storage(storage).build()
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
    await this.transaction(async (client) => {
      const session = await client.query('select instance_id from purista_harness_sessions where id = $1 for update', [id])
      if (session.rows[0]?.['instance_id'] !== expectedInstanceId) return
      await client.query('delete from purista_harness_external_wait_signals where wait_id in (select wait_id from purista_harness_external_waits where session_id = $1)', [id])
      await client.query('delete from purista_harness_external_waits where session_id = $1', [id])
      await client.query('delete from purista_harness_run_checkpoints where session_id = $1', [id])
      await client.query('delete from purista_harness_run_leases where session_id = $1', [id])
      await client.query('delete from purista_harness_run_events where run_id in (select id from purista_harness_runs where session_id = $1)', [id])
      await client.query('delete from purista_harness_runs where session_id = $1', [id])
      await client.query('delete from purista_harness_messages where session_id = $1', [id])
      await client.query('delete from purista_harness_sessions where id = $1 and instance_id = $2', [id, expectedInstanceId])
    })
  }

  public async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.transaction(async (client) => {
      try {
        for (const message of messages) {
          await client.query(
            `insert into purista_harness_messages
              (id, session_id, run_id, role, content, tool_calls_json, tool_results_json, created_at)
             values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
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
        'select created_at, id from purista_harness_messages where id = $1 and session_id = $2',
        [opts.before, sessionId],
      ))[0]
    }
    const values: unknown[] = [sessionId]
    const beforeClause = cursor
      ? ` and (created_at < $${push(values, date(cursor['created_at']))} or (created_at = $${push(values, date(cursor['created_at']))} and id < $${push(values, opts.before ?? '')}))`
      : ''
    if (opts.limit === undefined) {
      const rows = await this.query(
        `select * from purista_harness_messages where session_id = $1${beforeClause} order by created_at asc, id asc`,
        values,
      )
      return rows.map(rowToMessage)
    }
    const limit = push(values, Math.max(0, opts.limit))
    const rows = await this.query(
      `select * from purista_harness_messages where session_id = $1${beforeClause} order by created_at desc, id desc limit $${limit}`,
      values,
    )
    return rows.reverse().map(rowToMessage)
  }

  public async clearMessages(sessionId: string): Promise<void> {
    await this.query('delete from purista_harness_messages where session_id = $1', [sessionId])
  }

  public async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.transaction(async (client) => {
      await client.query('delete from purista_harness_messages where session_id = $1', [sessionId])
      try {
        for (const message of messages) {
          await client.query(
            `insert into purista_harness_messages
              (id, session_id, run_id, role, content, tool_calls_json, tool_results_json, created_at)
             values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
            [message.id, sessionId, message.runId ?? null, message.role, message.content,
              stringify(message.toolCalls), stringify(message.toolResults), message.timestamp],
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

  public async createRun(record: RunRecord): Promise<void> {
    await this.transaction(async (client) => {
      const inserted = await client.query(
        `insert into purista_harness_runs
          (id, session_id, kind, target, started_at, finished_at, status, input_json, output_json, error_json, attempt, worker_id, initial_step_id, metadata_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14::jsonb)
         on conflict (id) do nothing returning id`,
        [record.id, record.sessionId, record.kind, record.target, record.startedAt, record.finishedAt ?? null,
          record.status, stringify(record.input), stringify(record.output), stringify(record.error), record.attempt ?? null,
          record.workerId ?? null, record.initialStepId ?? null, stringify(record.metadata)],
      )
      if (inserted.rowCount === 1) return
      const existingRows = await client.query('select * from purista_harness_runs where id = $1 for update', [record.id])
      const existingRow = existingRows.rows[0] as PgRow | undefined
      if (!existingRow) throw new StateError('Run id creation was not observable.', { op: 'createRun', reason: 'run_conflict' })
      const existing = rowToRun(existingRow)
      if (existing.status === 'succeeded' || existing.status === 'cancelled') {
        throw new StateError('Terminal run already exists.', { op: 'createRun', reason: 'terminal_run_exists' })
      }
      if (existing.sessionId === record.sessionId && existing.kind === record.kind && existing.target === record.target) return
      throw new StateError('Run id already exists for a different run.', { op: 'createRun', reason: 'run_conflict' })
    })
  }

  public async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    return this.storageSpan('finish_run', { 'harness.run.id': runId, 'harness.run.status': patch.status }, async () => {
      await this.transaction(async (client) => {
        await client.query(
          `update purista_harness_runs set
             status = coalesce($1, status), finished_at = coalesce($2, finished_at),
             output_json = coalesce($3::jsonb, output_json), error_json = coalesce($4::jsonb, error_json)
           where id = $5`,
          [patch.status, patch.finishedAt ?? null, stringify(patch.output), stringify(patch.error), runId],
        )
        if (patch.status !== 'running') await client.query('delete from purista_harness_run_leases where run_id = $1', [runId])
      })
    })
  }

  public async getRun(runId: string): Promise<RunRecord | undefined> {
    const rows = await this.query('select * from purista_harness_runs where id = $1', [runId])
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
      `select * from purista_harness_runs where session_id = $1${beforeClause} order by started_at desc, id desc${limitClause}`,
      values,
    )
    return rows.map(rowToRun)
  }

  public async appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    await this.transaction(async (client) => {
      for (const event of events) {
        await client.query(
          'insert into purista_harness_run_events(id, run_id, observed_at, type, payload_json) values ($1, $2, $3, $4, $5::jsonb)',
          [event.id, runId, event.at, event.type, JSON.stringify(event.payload)],
        )
      }
    })
  }

  public async listEvents(runId: string, opts: { limit?: number; after?: string } = {}): Promise<PersistedRunEvent[]> {
    const values: unknown[] = [runId]
    const afterClause = opts.after ? ` and id > $${push(values, opts.after)}` : ''
    const limitClause = opts.limit === undefined ? '' : ` limit $${push(values, Math.max(0, opts.limit))}`
    const rows = await this.query(
      `select * from purista_harness_run_events where run_id = $1${afterClause} order by id asc${limitClause}`,
      values,
    )
    return rows.map((row) => ({
      id: text(row['id']),
      runId: text(row['run_id']),
      at: date(row['observed_at']),
      type: text(row['type']),
      payload: json<JsonValue>(row['payload_json']) ?? null,
    }))
  }

  public async acquireRun(record: DurableRunStart): Promise<DurableRunLease> {
    return this.storageSpan('acquire_run', {
      'harness.run.id': record.runId,
      'harness.session.id': record.sessionId,
    }, (recordAttrs) => this.withSessionLock(record.sessionId, async () => this.transaction(async (client) => {
      const currentRows = await client.query('select * from purista_harness_runs where id = $1 for update', [record.runId])
      const currentRow = currentRows.rows[0] as PgRow | undefined
      if (!currentRow) throw new StateError('Durable run must be created before acquisition.', { op: 'createRun', reason: 'run_not_found' })
      const current = rowToRun(currentRow)
      if (current.sessionId !== record.sessionId) throw new DurableRunLeaseError(`Durable run "${record.runId}" belongs to another session.`)
      if (isResumeBlockingRunStatus(current.status)) {
        throw new DurableTerminalRunError(record.runId, current.status as DurableTerminalRunStatus)
      }
      await this.assertLeaseAvailable(client, record.runId, record.sessionId, record.workerId)
      const priorStatus = current.status
      const attempt = current.attempt === undefined ? Math.max(1, record.attempt ?? 1) : current.attempt + 1
      await client.query(
        `update purista_harness_runs set attempt = $1, worker_id = $2,
           initial_step_id = coalesce(initial_step_id, $3), metadata_json = coalesce(metadata_json, $4::jsonb),
           status = 'running', finished_at = null, output_json = null, error_json = null where id = $5`,
        [attempt, record.workerId, record.stepId, stringify(record.metadata), record.runId],
      )
      const leaseId = `lease_${randomUUID()}`
      await client.query(
        `insert into purista_harness_run_leases(run_id, session_id, worker_id, lease_id, expires_at)
         values ($1, $2, $3, $4, $5)
         on conflict (run_id) do update set session_id = excluded.session_id,
           worker_id = excluded.worker_id, lease_id = excluded.lease_id, expires_at = excluded.expires_at`,
        [record.runId, record.sessionId, record.workerId, leaseId, this.leaseExpiry()],
      )
      const lease = await this.toLease(client, record.runId, leaseId,
        current.attempt !== undefined || priorStatus === 'waiting' || priorStatus === 'interrupted')
      recordAttrs({ 'harness.storage.resumed': lease.resumed, 'harness.storage.attempt': lease.attempt })
      return lease
    })))
  }

  public async loadCheckpoint(runId: string, stepId?: string): Promise<RunCheckpoint | undefined> {
    return this.storageSpan('load_checkpoint', { 'harness.run.id': runId }, async () => {
      const rows = stepId === undefined
        ? await this.query(
            'select * from purista_harness_run_checkpoints where run_id = $1 order by sequence desc limit 1',
            [runId],
          )
        : await this.query(
            'select * from purista_harness_run_checkpoints where run_id = $1 and step_id = $2 order by sequence desc limit 1',
            [runId, stepId],
          )
      return rows[0] ? rowToCheckpoint(rows[0]) : undefined
    })
  }

  public async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    return this.storageSpan('commit_checkpoint', {
      'harness.storage.attempt': checkpoint.attempt,
      'harness.storage.sequence': checkpoint.sequence,
      'harness.storage.step_id': checkpoint.stepId,
      'harness.run.id': checkpoint.runId,
      'harness.session.id': checkpoint.sessionId,
    }, () => this.withSessionLock(checkpoint.sessionId, async () => {
      let inputJson: string
      let outputJson: string | null
      let replayJson: string | null
      let metadataJson: string | null
      try {
        inputJson = JSON.stringify(checkpoint.input)
        outputJson = stringify(checkpoint.output)
        replayJson = stringify(checkpoint.replay)
        metadataJson = stringify(checkpoint.metadata)
      } catch {
        throw new DurableStepError(`Durable checkpoint for step "${checkpoint.stepId}" is not JSON-serializable.`)
      }
      await this.transaction(async (client) => {
        const lease = await client.query(
          `select * from purista_harness_run_leases
           where run_id = $1 and lease_id = $2 and worker_id = $3 for update`,
          [checkpoint.runId, checkpoint.leaseId, checkpoint.workerId],
        )
        if (!lease.rows[0]) throw new DurableRunLeaseError(`Durable run "${checkpoint.runId}" is not owned by this lease.`)
        await client.query(
          'update purista_harness_run_leases set expires_at = $1 where run_id = $2 and lease_id = $3',
          [this.leaseExpiry(), checkpoint.runId, checkpoint.leaseId],
        )
        const existing = await client.query(
          'select * from purista_harness_run_checkpoints where run_id = $1 and step_id = $2 for update',
          [checkpoint.runId, checkpoint.stepId],
        )
        const existingRow = existing.rows[0] as PgRow | undefined
        if (existingRow) {
          const stored = rowToCheckpoint(existingRow)
          if (canonicalJson(stored.output) !== canonicalJson(checkpoint.output)
            || canonicalJson(stored.replay) !== canonicalJson(checkpoint.replay)
            || stored.sequence !== checkpoint.sequence
            || stored.attempt !== checkpoint.attempt) {
            throw new WorkspaceError('Durable checkpoint idempotency conflict.', {
              reason: 'checkpoint_conflict', run_id: checkpoint.runId, session_id: checkpoint.sessionId,
            })
          }
          return
        }
        await client.query(
          `insert into purista_harness_run_checkpoints
            (run_id, session_id, lease_id, worker_id, step_id, input_json, attempt, sequence,
             output_json, replay_json, metadata_json, committed_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)`,
          [checkpoint.runId, checkpoint.sessionId, checkpoint.leaseId, checkpoint.workerId,
            checkpoint.stepId, inputJson, checkpoint.attempt, checkpoint.sequence,
            outputJson, replayJson, metadataJson, checkpoint.committedAt ?? this.nowIso()],
        )
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
    }, () => this.transaction(async (client) => {
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
        return { created: false, snapshot: existing }
      }
      const runRows = await client.query('select * from purista_harness_runs where id = $1 for update', [validated.runId])
      const runRow = runRows.rows[0] as PgRow | undefined
      const run = runRow ? rowToRun(runRow) : undefined
      if (!run || run.sessionId !== validated.sessionId || run.status !== 'running') {
        throw new ExternalWaitError('External wait run binding is invalid.', 'durable_required')
      }
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
      await client.query("update purista_harness_runs set status = 'waiting' where id = $1", [validated.runId])
      await client.query('delete from purista_harness_run_leases where run_id = $1', [validated.runId])
      return { created: true, snapshot }
    }))
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
      const schemaTable = await client.query("select to_regclass('purista_harness_storage_schema') as name")
      const sessionsTable = await client.query("select to_regclass('purista_harness_sessions') as name")
      if (!schemaTable.rows[0]?.['name'] && sessionsTable.rows[0]?.['name']) {
        throw incompatibleSchema()
      }
      if (schemaTable.rows[0]?.['name']) {
        const version = await client.query('select version from purista_harness_storage_schema where id = 1')
        if (version.rows[0] && Number(version.rows[0]['version']) !== 1) throw incompatibleSchema()
      }
      for (const statement of migration.split(/;\s*(?:\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
        await client.query(statement)
      }
      const version = await client.query('select version from purista_harness_storage_schema where id = 1')
      if (Number(version.rows[0]?.['version']) !== 1) throw incompatibleSchema()
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
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
    await client.query('delete from purista_harness_run_leases where run_id = $1 and expires_at < $2', [runId, now])
    await client.query('delete from purista_harness_run_leases where session_id = $1 and expires_at < $2', [sessionId, now])
    const runLease = await client.query('select * from purista_harness_run_leases where run_id = $1 for update', [runId])
    if (runLease.rows[0] && runLease.rows[0]['worker_id'] !== workerId) {
      throw new DurableRunLeaseError(`Durable run "${runId}" is already owned by worker "${String(runLease.rows[0]['worker_id'])}".`)
    }
    const sessionLease = await client.query(
      'select * from purista_harness_run_leases where session_id = $1 and run_id <> $2 for update',
      [sessionId, runId],
    )
    if (sessionLease.rows[0] && sessionLease.rows[0]['worker_id'] !== workerId) {
      throw new DurableRunLeaseError(`Durable session "${sessionId}" is already owned by another worker.`)
    }
  }

  private async toLease(client: PoolClient, runId: string, leaseId: string, previouslyAcquired: boolean): Promise<DurableRunLease> {
    const runRows = await client.query('select * from purista_harness_runs where id = $1', [runId])
    const runRow = runRows.rows[0] as PgRow | undefined
    if (!runRow) throw new DurableRunLeaseError(`Durable run "${runId}" has not been started.`)
    const checkpointRows = await client.query(
      'select * from purista_harness_run_checkpoints where run_id = $1 order by sequence asc',
      [runId],
    )
    const checkpoints = (checkpointRows.rows as PgRow[]).map(rowToCheckpoint)
    const latest = checkpoints.at(-1)
    const sessionId = text(runRow['session_id'])
    const workerId = text(runRow['worker_id'])
    const attempt = number(runRow['attempt'])
    return {
      runId,
      sessionId,
      workerId,
      leaseId,
      attempt,
      resumed: previouslyAcquired || checkpoints.length > 0,
      start: {
        runId,
        sessionId,
        workerId,
        stepId: text(runRow['initial_step_id']),
        input: json<JsonValue>(runRow['input_json']) ?? null,
        attempt,
        ...optional('metadata', json<Record<string, JsonValue>>(runRow['metadata_json'])),
      },
      ...(latest ? { checkpoint: latest } : {}),
      checkpoints,
      release: async () => {
        await this.transaction(async (releaseClient) => {
          const deleted = await releaseClient.query(
            'delete from purista_harness_run_leases where run_id = $1 and lease_id = $2 returning run_id',
            [runId, leaseId],
          )
          if (deleted.rowCount === 1) {
            await releaseClient.query(
              "update purista_harness_runs set status = 'interrupted' where id = $1 and status = 'running'",
              [runId],
            )
          }
        })
      },
    }
  }

  private async loadExternalWait(client: PoolClient, waitId: string): Promise<ExternalWaitSnapshot | undefined> {
    const rows = await client.query('select * from purista_harness_external_waits where wait_id = $1 for update', [waitId])
    const row = rows.rows[0] as PgRow | undefined
    if (!row) return undefined
    return validateExternalWaitSnapshot({
      waitId: text(row['wait_id']),
      kind: text(row['kind']),
      schemaVersion: text(row['schema_version']),
      definitionVersion: text(row['definition_version']),
      deadline: date(row['deadline']),
      status: text(row['status']),
      createdAt: date(row['created_at']),
      ...optional('resolvedAt', nullableDate(row['resolved_at'])),
      ...optional('eventId', nullableText(row['event_id'])),
    })
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
    return resolved
  }

  private async resolveExternalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult> {
    return this.transaction(async (client) => {
      const snapshot = await this.expireExternalWait(client, await this.loadExternalWait(client, signal.waitId))
      if (!snapshot) return validateExternalWaitSignalResult({ kind: 'not_found' })
      const duplicate = await client.query(
        'select event_id from purista_harness_external_wait_signals where wait_id = $1 and event_id = $2',
        [signal.waitId, signal.eventId],
      )
      if (duplicate.rows[0]) return validateExternalWaitSignalResult({ kind: 'duplicate', snapshot })
      await client.query(
        'insert into purista_harness_external_wait_signals(wait_id, event_id) values ($1, $2)',
        [signal.waitId, signal.eventId],
      )
      if (snapshot.status !== 'waiting') return validateExternalWaitSignalResult({ kind: 'already_terminal', snapshot })
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
      return validateExternalWaitSignalResult({ kind: 'applied', snapshot: terminal })
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
  return {
    id: text(row['id']),
    instanceId: text(row['instance_id']),
    createdAt: date(row['created_at']),
    updatedAt: date(row['updated_at']),
    runCount: number(row['run_count']),
    ...optional('identity', json<SessionRecord['identity']>(row['identity_json'])),
    sandboxBinding,
    ...optional('metadata', json<Record<string, JsonValue>>(row['metadata_json'])),
  }
}

function rowToMessage(row: PgRow): Message {
  return {
    id: text(row['id']),
    sessionId: text(row['session_id']),
    ...optional('runId', nullableText(row['run_id'])),
    role: text(row['role']) as Message['role'],
    content: text(row['content']),
    ...optional('toolCalls', json<Message['toolCalls']>(row['tool_calls_json'])),
    ...optional('toolResults', json<Message['toolResults']>(row['tool_results_json'])),
    timestamp: date(row['created_at']),
  }
}

function rowToRun(row: PgRow): RunRecord {
  return {
    id: text(row['id']),
    sessionId: text(row['session_id']),
    kind: text(row['kind']) as RunRecord['kind'],
    target: text(row['target']),
    startedAt: date(row['started_at']),
    ...optional('finishedAt', nullableDate(row['finished_at'])),
    status: text(row['status']) as RunRecord['status'],
    ...optional('input', json<JsonValue>(row['input_json'])),
    ...optional('output', json<JsonValue>(row['output_json'])),
    ...optional('error', json<NonNullable<RunRecord['error']>>(row['error_json'])),
    ...optional('attempt', nullableNumber(row['attempt'])),
    ...optional('workerId', nullableText(row['worker_id'])),
    ...optional('initialStepId', nullableText(row['initial_step_id'])),
    ...optional('metadata', json<Record<string, JsonValue>>(row['metadata_json'])),
  }
}

function rowToCheckpoint(row: PgRow): RunCheckpoint {
  return {
    runId: text(row['run_id']),
    sessionId: text(row['session_id']),
    leaseId: text(row['lease_id']),
    workerId: text(row['worker_id']),
    stepId: text(row['step_id']),
    input: json<JsonValue>(row['input_json']) ?? null,
    attempt: number(row['attempt']),
    sequence: number(row['sequence']),
    ...optional('output', json<JsonValue>(row['output_json'])),
    ...optional('replay', json<DurableReplayCheckpoint>(row['replay_json'])),
    ...optional('metadata', json<Record<string, JsonValue>>(row['metadata_json'])),
    committedAt: date(row['committed_at']),
  }
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

function text(value: unknown): string {
  if (typeof value !== 'string') throw malformedRow()
  return value
}

function nullableText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : text(value)
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw malformedRow()
  return parsed
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
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, sortJson((value as Record<string, unknown>)[key])]))
  }
  return value
}

function definedAttrs(attrs: SpanAttrs): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {}
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined) out[key] = value
  return out
}
