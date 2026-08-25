import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { HarnessConfigError, StateError, WorkspaceError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type { Message, PersistedRunEvent, RunRecord, RunStatus, SerializedError, SessionRecord } from '../models/state.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import { ExternalWaitError, validateExternalWaitRequest, type ExternalWaitOutcome, type ExternalWaitRegistration, type ExternalWaitSignal, type ExternalWaitSignalResult, type ExternalWaitSnapshot } from '../storage/external-wait.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'
import type { BoundExternalWaitRequest, FinishRunPatch, HarnessStorage } from '../storage/types.js'
import type { DurableReplayCheckpoint } from '../ports/workspace.js'
import {
  AsyncMutex,
  DurableRunLeaseError,
  DurableTerminalRunError,
  isResumeBlockingRunStatus,
  type DurableRunLease,
  type DurableRunStart,
  type DurableTerminalRunStatus,
  type RunCheckpoint
} from './execution.js'
import { DurableStepError } from '../runtime/steps.js'

type SqlValue = string | number | null
type SqlRow = Record<string, SqlValue>

interface SqlStatement {
  get(...params: SqlValue[]): SqlRow | undefined
  all(...params: SqlValue[]): SqlRow[]
  run(...params: SqlValue[]): void
}

interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

export interface SqliteHarnessStorageOptions {
  /** SQLite database file. */
  file: string
  /** Lease takeover window for crashed workers. Default: `120_000`. */
  leaseTtlMs?: number
  /** Injectable epoch-millisecond clock for lease tests. Default: `Date.now`. */
  now?: () => number
}

const SQLITE_ENGINE_REQUIREMENT = 'node>=24.15.0 (node:sqlite) or bun (bun:sqlite)'

class BuiltinSqliteStatement implements SqlStatement {
  public constructor(private readonly statement: { get(...params: SqlValue[]): unknown; all(...params: SqlValue[]): unknown[]; run(...params: SqlValue[]): unknown }) {}

  public get(...params: SqlValue[]): SqlRow | undefined {
    const row = this.statement.get(...params)
    return row && typeof row === 'object' ? row as SqlRow : undefined
  }

  public all(...params: SqlValue[]): SqlRow[] {
    return this.statement.all(...params).filter((row): row is SqlRow => Boolean(row && typeof row === 'object'))
  }

  public run(...params: SqlValue[]): void {
    this.statement.run(...params)
  }
}

function openBuiltinSqlite(file: string): SqlDatabase {
  mkdirSync(dirname(file), { recursive: true })
  const require = createRequire(import.meta.url)
  const versions = (globalThis as { process?: { versions?: Record<string, string> } }).process?.versions
  const runtime = versions?.['bun'] ? 'bun' : 'node'
  const moduleName = runtime === 'bun' ? 'bun:sqlite' : 'node:sqlite'
  let loaded: { Database?: new(file: string) => unknown; DatabaseSync?: new(file: string) => unknown }
  try {
    loaded = require(moduleName) as { Database?: new(file: string) => unknown; DatabaseSync?: new(file: string) => unknown }
  } catch (error) {
    throw new HarnessConfigError(`Built-in SQLite driver is unavailable. Requires ${SQLITE_ENGINE_REQUIREMENT}.`, {
      reason: 'sqlite_unavailable',
      path: 'localDurableExecution.databaseFile',
      id: runtime
    }, error)
  }
  const Database = loaded.DatabaseSync ?? loaded.Database
  if (!Database) {
    throw new HarnessConfigError(`Built-in SQLite driver is unavailable. Requires ${SQLITE_ENGINE_REQUIREMENT}.`, {
      reason: 'sqlite_unavailable',
      path: 'localDurableExecution.databaseFile',
      id: runtime
    })
  }
  const raw = new Database(file) as {
    exec(sql: string): void
    prepare(sql: string): { get(...params: SqlValue[]): unknown; all(...params: SqlValue[]): unknown[]; run(...params: SqlValue[]): unknown }
    close(): void
  }
  return {
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => new BuiltinSqliteStatement(raw.prepare(sql)),
    close: () => raw.close()
  }
}

function stringify(value: unknown): string | null {
  if (value === undefined) return null
  return JSON.stringify(value)
}

function parseJson<T>(value: SqlValue | undefined): T | undefined {
  if (typeof value !== 'string') return undefined
  return JSON.parse(value) as T
}

function isConstraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /constraint|unique/i.test(message)
}

type StateOp = ConstructorParameters<typeof StateError>[1]['op']

function requiredString(row: SqlRow, key: string, op: StateOp): string {
  const value = row[key]
  if (typeof value !== 'string') throw new StateError('SQLite row is missing a required string.', { op, reason: key })
  return value
}

function requiredNumber(row: SqlRow, key: string, op: StateOp): number {
  const value = row[key]
  if (typeof value !== 'number') throw new StateError('SQLite row is missing a required number.', { op, reason: key })
  return value
}

/**
 * Native SQLite Harness storage for one local host.
 *
 * @example
 * ```ts
 * const storage = sqliteHarnessStorage({ file: '.purista/harness.sqlite' })
 * const harness = defineHarness().storage(storage).models(models).build()
 * ```
 */
export class SqliteHarnessStorage implements HarnessStorage {
  public readonly capabilities = [
    'storage.checkpoint',
    'storage.retry',
    'storage.resume',
    'storage.workspace_checkpoint',
    'storage.persistent',
    'storage.external_wait'
  ] as const satisfies readonly AdapterCapability[]

  public readonly id = 'sqlite'
  public readonly info = {
    id: 'sqlite',
    packageName: '@purista/harness',
    capabilities: this.capabilities
  }

  private readonly db: SqlDatabase
  private readonly leaseTtlMs: number
  private readonly clock: () => number
  /**
   * In-process serialization for SQLite transactions: one connection allows a
   * single open transaction, so every transactional entry point goes through
   * this mutex before issuing `begin immediate`.
   */
  private readonly dbLock = new AsyncMutex()
  private readonly sessionLocks = new Map<string, AsyncMutex>()
  private readonly statements = new Map<string, SqlStatement>()
  private closed = false
  private logger: HarnessAdapterContext['logger'] | undefined
  private telemetry: TelemetryShim | undefined

  public constructor(options: SqliteHarnessStorageOptions) {
    this.leaseTtlMs = options.leaseTtlMs ?? 120_000
    this.clock = options.now ?? Date.now
    this.db = openBuiltinSqlite(options.file)
    this.assertCleanSchema()
    this.migrate()
  }

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.logger = context.logger
    this.telemetry = context.telemetry
  }

  public async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = this.stmt('select * from harness_sessions where id = ?').get(id)
    return row ? this.rowToSession(row) : undefined
  }

  public async upsertSession(record: SessionRecord): Promise<void> {
    this.stmt('insert into harness_sessions(id, created_at, updated_at, run_count, identity_json, metadata_json) values(?, ?, ?, ?, ?, ?) on conflict(id) do update set updated_at=excluded.updated_at, run_count=excluded.run_count, identity_json=excluded.identity_json, metadata_json=excluded.metadata_json')
      .run(record.id, record.createdAt, record.updatedAt, record.runCount, stringify(record.identity), stringify(record.metadata))
  }

  public async closeSession(id: string): Promise<void> {
    await this.transaction(() => {
      this.stmt('delete from harness_sessions where id = ?').run(id)
      this.stmt('delete from harness_messages where session_id = ?').run(id)
      this.stmt('delete from harness_external_wait_signals where wait_id in (select wait_id from harness_external_waits where session_id = ?)').run(id)
      this.stmt('delete from harness_external_waits where session_id = ?').run(id)
      this.stmt('delete from harness_run_checkpoints where session_id = ?').run(id)
      this.stmt('delete from harness_run_leases where session_id = ?').run(id)
      this.stmt('delete from harness_run_events where run_id in (select id from harness_runs where session_id = ?)').run(id)
      this.stmt('delete from harness_runs where session_id = ?').run(id)
    })
  }

  public async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.transaction(() => {
      const insert = this.stmt('insert into harness_messages(id, session_id, role, content, tool_calls_json, tool_results_json, timestamp) values(?, ?, ?, ?, ?, ?, ?)')
      for (const message of messages) {
        try {
          insert.run(message.id, sessionId, message.role, message.content, stringify(message.toolCalls), stringify(message.toolResults), message.timestamp)
        } catch (error) {
          if (isConstraintViolation(error)) {
            throw new StateError('Message id already exists.', { op: 'appendMessages', reason: 'duplicate_message_id' }, error)
          }
          throw error
        }
      }
    })
  }

  public async listMessages(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<Message[]> {
    const before = opts.before ? this.stmt('select timestamp, id from harness_messages where id = ? and session_id = ?').get(opts.before, sessionId) : undefined
    const beforeClause = before ? ' and (timestamp < ? or (timestamp = ? and id < ?))' : ''
    const beforeParams: SqlValue[] = before
      ? [requiredString(before, 'timestamp', 'listMessages'), requiredString(before, 'timestamp', 'listMessages'), opts.before ?? '']
      : []
    if (opts.limit === undefined) {
      const rows = this.stmt(`select * from harness_messages where session_id = ?${beforeClause} order by timestamp asc, id asc`).all(sessionId, ...beforeParams)
      return rows.map((row) => this.rowToMessage(row))
    }
    // Tail semantics: fetch the newest `limit` rows and restore ascending order.
    const rows = this.stmt(`select * from harness_messages where session_id = ?${beforeClause} order by timestamp desc, id desc limit ?`).all(sessionId, ...beforeParams, Math.max(0, opts.limit))
    return rows.reverse().map((row) => this.rowToMessage(row))
  }

  public async clearMessages(sessionId: string): Promise<void> {
    this.stmt('delete from harness_messages where session_id = ?').run(sessionId)
  }

  public async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.transaction(() => {
      this.stmt('delete from harness_messages where session_id = ?').run(sessionId)
      const insert = this.stmt('insert into harness_messages(id, session_id, role, content, tool_calls_json, tool_results_json, timestamp) values(?, ?, ?, ?, ?, ?, ?)')
      for (const message of messages) {
        try {
          insert.run(message.id, sessionId, message.role, message.content, stringify(message.toolCalls), stringify(message.toolResults), message.timestamp)
        } catch (error) {
          if (isConstraintViolation(error)) {
            throw new StateError('Message id already exists.', { op: 'replaceMessages', reason: 'duplicate_message_id' }, error)
          }
          throw error
        }
      }
    })
  }

  public async createRun(record: RunRecord): Promise<void> {
    await this.transaction(() => {
      const existing = this.loadRun(record.id)
      if (existing) {
        if (existing.status === 'succeeded' || existing.status === 'cancelled') {
          throw new StateError('Terminal run already exists.', { op: 'createRun', reason: 'terminal_run_exists' })
        }
        if (existing.sessionId === record.sessionId && existing.kind === record.kind && existing.target === record.target) {
          return
        }
        throw new StateError('Run id already exists for a different run.', { op: 'createRun', reason: 'run_conflict' })
      }
      try {
        this.stmt('insert into harness_runs(id, session_id, kind, target, started_at, finished_at, status, input_json, output_json, error_json, attempt, worker_id, initial_step_id, metadata_json) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(record.id, record.sessionId, record.kind, record.target, record.startedAt, record.finishedAt ?? null, record.status, stringify(record.input), stringify(record.output), stringify(record.error), record.attempt ?? null, record.workerId ?? null, record.initialStepId ?? null, stringify(record.metadata))
      } catch (error) {
        if (isConstraintViolation(error)) {
          throw new StateError('Run id already exists for a different run.', { op: 'createRun', reason: 'run_conflict' }, error)
        }
        throw error
      }
    })
  }

  public async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    return this.storageSpan('finish_run', {
      'harness.run.id': runId,
      'harness.run.status': patch.status
    }, async () => this.transaction(() => {
      this.stmt('update harness_runs set status = coalesce(?, status), finished_at = coalesce(?, finished_at), output_json = coalesce(?, output_json), error_json = coalesce(?, error_json) where id = ?')
        .run(patch.status ?? null, patch.finishedAt ?? null, stringify(patch.output), stringify(patch.error), runId)
      if (patch.status !== 'running') this.stmt('delete from harness_run_leases where run_id = ?').run(runId)
    }))
  }

  public async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.loadRun(runId)
  }

  public async listRuns(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<RunRecord[]> {
    const before = opts.before ? this.stmt('select started_at, id from harness_runs where id = ? and session_id = ?').get(opts.before, sessionId) : undefined
    const beforeClause = before ? ' and (started_at < ? or (started_at = ? and id < ?))' : ''
    const beforeParams: SqlValue[] = before
      ? [requiredString(before, 'started_at', 'listRuns'), requiredString(before, 'started_at', 'listRuns'), opts.before ?? '']
      : []
    const limitClause = opts.limit === undefined ? '' : ' limit ?'
    const limitParams: SqlValue[] = opts.limit === undefined ? [] : [Math.max(0, opts.limit)]
    const rows = this.stmt(`select * from harness_runs where session_id = ?${beforeClause} order by started_at desc, id desc${limitClause}`).all(sessionId, ...beforeParams, ...limitParams)
    return rows.map((row) => this.rowToRun(row))
  }

  public async appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    await this.transaction(() => {
      const insert = this.stmt('insert into harness_run_events(id, run_id, at, type, payload_json) values(?, ?, ?, ?, ?)')
      for (const event of events) insert.run(event.id, runId, event.at, event.type, JSON.stringify(event.payload))
    })
  }

  public async listEvents(runId: string, opts: { limit?: number; after?: string } = {}): Promise<PersistedRunEvent[]> {
    const afterClause = opts.after ? ' and id > ?' : ''
    const afterParams: SqlValue[] = opts.after ? [opts.after] : []
    const limitClause = opts.limit === undefined ? '' : ' limit ?'
    const limitParams: SqlValue[] = opts.limit === undefined ? [] : [Math.max(0, opts.limit)]
    const rows = this.stmt(`select * from harness_run_events where run_id = ?${afterClause} order by id asc${limitClause}`).all(runId, ...afterParams, ...limitParams)
    return rows.map((row) => ({
      id: requiredString(row, 'id', 'listEvents'),
      runId: requiredString(row, 'run_id', 'listEvents'),
      at: requiredString(row, 'at', 'listEvents'),
      type: requiredString(row, 'type', 'listEvents'),
      payload: parseJson<JsonValue>(row['payload_json']) ?? null
    }))
  }

  public async acquireRun(record: DurableRunStart): Promise<DurableRunLease> {
    return this.storageSpan('acquire_run', {
      'harness.run.id': record.runId,
      'harness.session.id': record.sessionId
    }, (recordAttrs) => this.withSessionLock(record.sessionId, async () => this.transaction(() => {
      const current = this.loadRun(record.runId)
      if (!current) throw new StateError('Durable run must be created before acquisition.', { op: 'createRun', reason: 'run_not_found' })
      if (current.sessionId !== record.sessionId) throw new DurableRunLeaseError(`Durable run "${record.runId}" belongs to another session.`)
      if (isResumeBlockingRunStatus(current.status)) {
        throw new DurableTerminalRunError(record.runId, current.status as DurableTerminalRunStatus)
      }
      this.assertLeaseAvailable(record.runId, record.sessionId, record.workerId)
      const priorStatus = current.status
      const attempt = current.attempt === undefined ? Math.max(1, record.attempt ?? 1) : current.attempt + 1
      this.stmt('update harness_runs set attempt = ?, worker_id = ?, initial_step_id = coalesce(initial_step_id, ?), metadata_json = coalesce(metadata_json, ?), status = ?, finished_at = null, output_json = null, error_json = null where id = ?')
        .run(attempt, record.workerId, record.stepId, stringify(record.metadata), 'running', record.runId)
      const leaseId = `lease_${this.clock()}_${Math.random().toString(36).slice(2)}`
      const expiresAt = new Date(this.clock() + this.leaseTtlMs).toISOString()
      // Upsert allows same-worker lease renewal for retries within the TTL.
      this.stmt('insert into harness_run_leases(run_id, session_id, worker_id, lease_id, expires_at) values(?, ?, ?, ?, ?) on conflict(run_id) do update set session_id=excluded.session_id, worker_id=excluded.worker_id, lease_id=excluded.lease_id, expires_at=excluded.expires_at')
        .run(record.runId, record.sessionId, record.workerId, leaseId, expiresAt)
      const lease = this.toLease(record.runId, leaseId, priorStatus)
      recordAttrs({ 'harness.storage.resumed': lease.resumed, 'harness.storage.attempt': lease.attempt })
      return lease
    })))
  }

  public async loadCheckpoint(runId: string): Promise<RunCheckpoint | undefined> {
    return this.storageSpan('load_checkpoint', {
      'harness.run.id': runId
    }, async () => {
      const row = this.stmt('select * from harness_run_checkpoints where run_id = ? order by sequence desc limit 1').get(runId)
      return row ? this.rowToCheckpoint(row) : undefined
    })
  }

  public async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    return this.storageSpan('commit_checkpoint', {
      'harness.storage.attempt': checkpoint.attempt,
      'harness.storage.sequence': checkpoint.sequence,
      'harness.storage.step_id': checkpoint.stepId,
      'harness.run.id': checkpoint.runId,
      'harness.session.id': checkpoint.sessionId
    }, () => this.withSessionLock(checkpoint.sessionId, async () => {
      // Serialize before any SQLite write so non-serializable payloads are
      // rejected without mutating storage (spec 22 §3).
      let inputJson: string
      let outputJson: string | null
      let replayJson: string | null
      let metadataJson: string | null
      try {
        inputJson = JSON.stringify(checkpoint.input)
        outputJson = stringify(checkpoint.output)
        replayJson = stringify(checkpoint.replay)
        metadataJson = stringify(checkpoint.metadata)
      } catch (error) {
        throw new DurableStepError(`Durable checkpoint for step "${checkpoint.stepId}" is not JSON-serializable.`)
      }
      return this.transaction(() => {
        const lease = this.stmt('select * from harness_run_leases where run_id = ? and lease_id = ? and worker_id = ?').get(checkpoint.runId, checkpoint.leaseId, checkpoint.workerId)
        if (!lease) throw new DurableRunLeaseError(`Durable run "${checkpoint.runId}" is not owned by this lease.`)
        // Heartbeat: each checkpoint by the owning lease renews the TTL so
        // long runs are not taken over mid-flight.
        this.stmt('update harness_run_leases set expires_at = ? where run_id = ? and lease_id = ?')
          .run(new Date(this.clock() + this.leaseTtlMs).toISOString(), checkpoint.runId, checkpoint.leaseId)
        const existing = this.stmt('select * from harness_run_checkpoints where run_id = ? and step_id = ?').get(checkpoint.runId, checkpoint.stepId)
        if (existing) {
          if (existing['output_json'] !== outputJson || existing['replay_json'] !== replayJson || existing['sequence'] !== checkpoint.sequence || existing['attempt'] !== checkpoint.attempt) {
            throw new WorkspaceError('Durable checkpoint idempotency conflict.', { reason: 'checkpoint_conflict', run_id: checkpoint.runId, session_id: checkpoint.sessionId })
          }
          return
        }
        this.stmt('insert into harness_run_checkpoints(run_id, session_id, lease_id, worker_id, step_id, input_json, attempt, sequence, output_json, replay_json, metadata_json, committed_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(checkpoint.runId, checkpoint.sessionId, checkpoint.leaseId, checkpoint.workerId, checkpoint.stepId, inputJson, checkpoint.attempt, checkpoint.sequence, outputJson, replayJson, metadataJson, checkpoint.committedAt ?? this.nowIso())
      })
    }))
  }

  public async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.sessionLocks.get(sessionId)
    if (!lock) {
      lock = new AsyncMutex()
      this.sessionLocks.set(sessionId, lock)
    }
    return lock.lock(fn)
  }

  public async registerWait(request: BoundExternalWaitRequest): Promise<ExternalWaitRegistration> {
    validateExternalWaitRequest(request)
    return this.storageSpan('register_wait', {
      'harness.run.id': request.runId,
      'harness.session.id': request.sessionId,
      'harness.wait.kind': request.kind
    }, async () => this.transaction(() => {
      const existing = this.expireExternalWait(this.loadExternalWait(request.waitId))
      if (existing) {
        const binding = this.stmt('select run_id, session_id from harness_external_waits where wait_id = ?').get(request.waitId)
        if (binding?.['run_id'] !== request.runId || binding?.['session_id'] !== request.sessionId || existing.kind !== request.kind || existing.schemaVersion !== request.schemaVersion || existing.definitionVersion !== request.definitionVersion || existing.deadline !== request.deadline) {
          throw new ExternalWaitError('External wait id is already bound to a different request.', 'request_conflict')
        }
        return { created: false, snapshot: existing }
      }
      const run = this.loadRun(request.runId)
      if (!run || run.sessionId !== request.sessionId || run.status !== 'running') {
        throw new ExternalWaitError('External wait run binding is invalid.', 'durable_required')
      }
      const snapshot: ExternalWaitSnapshot = { ...request, status: 'waiting', createdAt: this.nowIso() }
      this.stmt('insert into harness_external_waits(wait_id, run_id, session_id, kind, schema_version, definition_version, deadline, status, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(snapshot.waitId, request.runId, request.sessionId, snapshot.kind, snapshot.schemaVersion, snapshot.definitionVersion, snapshot.deadline, snapshot.status, snapshot.createdAt)
      this.stmt('update harness_runs set status = ? where id = ?').run('waiting', request.runId)
      this.stmt('delete from harness_run_leases where run_id = ?').run(request.runId)
      return { created: true, snapshot }
    }))
  }

  public async getWait(waitId: string): Promise<ExternalWaitSnapshot | undefined> {
    return this.transaction(() => this.expireExternalWait(this.loadExternalWait(waitId)))
  }

  public async signalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult> {
    return this.storageSpan('signal_wait', {
      'harness.wait.outcome': signal.outcome
    }, async () => this.resolveExternalWait(signal.waitId, signal.eventId, signal.outcome, signal.observedAt))
  }

  public async cancelWait(waitId: string, eventId: string, observedAt?: string): Promise<ExternalWaitSignalResult> {
    return this.resolveExternalWait(waitId, eventId, 'cancelled', observedAt)
  }

  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.statements.clear()
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      pragma journal_mode = WAL;
      pragma foreign_keys = ON;
      pragma busy_timeout = 5000;
      create table if not exists harness_sessions(id text primary key, created_at text not null, updated_at text not null, run_count integer not null, identity_json text, metadata_json text);
      create table if not exists harness_messages(id text primary key, session_id text not null, role text not null, content text not null, tool_calls_json text, tool_results_json text, timestamp text not null);
      create index if not exists idx_harness_messages_session_order on harness_messages(session_id, timestamp, id);
      create table if not exists harness_runs(id text primary key, session_id text not null, kind text not null, target text not null, started_at text not null, finished_at text, status text not null, input_json text, output_json text, error_json text, attempt integer, worker_id text, initial_step_id text, metadata_json text);
      create index if not exists idx_harness_runs_session_order on harness_runs(session_id, started_at, id);
      create table if not exists harness_run_events(id text primary key, run_id text not null, at text not null, type text not null, payload_json text not null);
      create index if not exists idx_harness_run_events_run_order on harness_run_events(run_id, id);
      create table if not exists harness_run_checkpoints(run_id text not null, session_id text not null, lease_id text not null, worker_id text not null, step_id text not null, input_json text not null, attempt integer not null, sequence integer not null, output_json text, replay_json text, metadata_json text, committed_at text not null, primary key(run_id, step_id));
      create index if not exists idx_harness_run_checkpoints_order on harness_run_checkpoints(run_id, sequence);
      create table if not exists harness_run_leases(run_id text primary key, session_id text not null, worker_id text not null, lease_id text not null, expires_at text not null);
      create index if not exists idx_harness_run_leases_session on harness_run_leases(session_id);
      create table if not exists harness_external_waits(wait_id text primary key, run_id text not null, session_id text not null, kind text not null, schema_version text not null, definition_version text not null, deadline text not null, status text not null, created_at text not null, resolved_at text, event_id text);
      create index if not exists idx_harness_external_waits_deadline on harness_external_waits(status, deadline);
      create table if not exists harness_external_wait_signals(wait_id text not null, event_id text not null, primary key(wait_id, event_id));
    `)
  }

  private assertCleanSchema(): void {
    const legacyTables = ['harness_durable_runs', 'harness_context_checkpoints']
      .filter((name) => this.db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(name))
    const runsTable = this.db.prepare("select name from sqlite_master where type = 'table' and name = 'harness_runs'").get()
    if (runsTable) {
      const columns = new Set(this.db.prepare('pragma table_info(harness_runs)').all().map((row) => row['name']))
      if (!columns.has('attempt') || !columns.has('initial_step_id')) legacyTables.push('harness_runs')
    }
    const sessionsTable = this.db.prepare("select name from sqlite_master where type = 'table' and name = 'harness_sessions'").get()
    if (sessionsTable) {
      const columns = new Set(this.db.prepare('pragma table_info(harness_sessions)').all().map((row) => row['name']))
      if (!columns.has('identity_json')) legacyTables.push('harness_sessions')
    }
    if (legacyTables.length > 0) {
      this.db.close()
      throw new HarnessConfigError('Legacy Harness SQLite schema detected. Create a new database for this clean-break release.', {
        reason: 'sqlite_schema_incompatible',
        path: 'localDurableExecution.databaseFile',
        id: legacyTables.join(',')
      })
    }
  }

  private stmt(sql: string): SqlStatement {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString()
  }

  /**
   * Runs a synchronous statement batch inside a single SQLite transaction.
   * The in-process mutex guarantees only one open transaction per connection;
   * the callback must stay synchronous so the transaction never spans an await.
   */
  private async transaction<T>(fn: () => T): Promise<T> {
    return this.dbLock.lock(async () => {
      this.db.exec('begin immediate')
      try {
        const result = fn()
        this.db.exec('commit')
        return result
      } catch (error) {
        this.db.exec('rollback')
        throw error
      }
    })
  }

  private loadRun(runId: string): RunRecord | undefined {
    const row = this.stmt('select * from harness_runs where id = ?').get(runId)
    return row ? this.rowToRun(row) : undefined
  }

  private loadExternalWait(waitId: string): ExternalWaitSnapshot | undefined {
    const row = this.stmt('select * from harness_external_waits where wait_id = ?').get(waitId)
    if (!row) return undefined
    const status = requiredString(row, 'status', 'getRun') as ExternalWaitSnapshot['status']
    return {
      waitId: requiredString(row, 'wait_id', 'getRun'),
      kind: requiredString(row, 'kind', 'getRun'),
      schemaVersion: requiredString(row, 'schema_version', 'getRun'),
      definitionVersion: requiredString(row, 'definition_version', 'getRun'),
      deadline: requiredString(row, 'deadline', 'getRun'),
      status,
      createdAt: requiredString(row, 'created_at', 'getRun'),
      ...optional('resolvedAt', row['resolved_at'] as string | undefined),
      ...optional('eventId', row['event_id'] as string | undefined)
    }
  }

  private expireExternalWait(snapshot: ExternalWaitSnapshot | undefined): ExternalWaitSnapshot | undefined {
    if (!snapshot || snapshot.status !== 'waiting' || Date.parse(snapshot.deadline) > this.clock()) return snapshot
    const expired: ExternalWaitSnapshot = { ...snapshot, status: 'expired', resolvedAt: this.nowIso() }
    this.stmt('update harness_external_waits set status = ?, resolved_at = ? where wait_id = ?').run(expired.status, expired.resolvedAt!, expired.waitId)
    return expired
  }

  private async resolveExternalWait(waitId: string, eventId: string, outcome: ExternalWaitOutcome, observedAt?: string): Promise<ExternalWaitSignalResult> {
    if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(eventId)) throw new ExternalWaitError('External wait eventId must be a bounded identifier.', 'invalid_request')
    return this.transaction(() => {
      const snapshot = this.expireExternalWait(this.loadExternalWait(waitId))
      if (!snapshot) return { kind: 'not_found' }
      const duplicate = this.stmt('select event_id from harness_external_wait_signals where wait_id = ? and event_id = ?').get(waitId, eventId)
      if (duplicate) return { kind: 'duplicate', snapshot }
      this.stmt('insert into harness_external_wait_signals(wait_id, event_id) values(?, ?)').run(waitId, eventId)
      if (snapshot.status !== 'waiting') return { kind: 'already_terminal', snapshot }
      const resolved: ExternalWaitSnapshot = { ...snapshot, status: outcome, resolvedAt: observedAt ?? this.nowIso(), eventId }
      this.stmt('update harness_external_waits set status = ?, resolved_at = ?, event_id = ? where wait_id = ?')
        .run(resolved.status, resolved.resolvedAt!, eventId, waitId)
      return { kind: 'applied', snapshot: resolved }
    })
  }

  private assertLeaseAvailable(runId: string, sessionId: string, workerId: string): void {
    const nowIso = this.nowIso()
    // Scoped expiry: only clear stale leases for the contested run/session so
    // an unrelated long-running lease is never deleted by another start.
    this.stmt('delete from harness_run_leases where run_id = ? and expires_at < ?').run(runId, nowIso)
    this.stmt('delete from harness_run_leases where session_id = ? and expires_at < ?').run(sessionId, nowIso)
    const runLease = this.stmt('select * from harness_run_leases where run_id = ?').get(runId)
    if (runLease && runLease['worker_id'] !== workerId) throw new DurableRunLeaseError(`Durable run "${runId}" is already owned by worker "${runLease['worker_id']}".`)
    const sessionLease = this.stmt('select * from harness_run_leases where session_id = ? and run_id != ?').get(sessionId, runId)
    if (sessionLease && sessionLease['worker_id'] !== workerId) throw new DurableRunLeaseError(`Durable session "${sessionId}" is already owned by another worker.`)
  }

  private toLease(runId: string, leaseId: string, priorStatus: RunStatus): DurableRunLease {
    const run = this.stmt('select * from harness_runs where id = ?').get(runId)
    if (!run) throw new DurableRunLeaseError(`Durable run "${runId}" has not been started.`)
    const checkpoints = this.stmt('select * from harness_run_checkpoints where run_id = ? order by sequence asc').all(runId).map((row) => this.rowToCheckpoint(row))
    const latest = checkpoints.at(-1)
    return {
      runId,
      sessionId: requiredString(run, 'session_id', 'getRun'),
      workerId: requiredString(run, 'worker_id', 'getRun'),
      leaseId,
      attempt: requiredNumber(run, 'attempt', 'getRun'),
      resumed: checkpoints.length > 0 || priorStatus === 'waiting' || priorStatus === 'interrupted',
      start: {
        runId,
        sessionId: requiredString(run, 'session_id', 'getRun'),
        workerId: requiredString(run, 'worker_id', 'getRun'),
        stepId: requiredString(run, 'initial_step_id', 'getRun'),
        input: parseJson<JsonValue>(run['input_json']) ?? null,
        attempt: requiredNumber(run, 'attempt', 'getRun'),
        ...optional('metadata', parseJson<Record<string, JsonValue>>(run['metadata_json']))
      },
      ...(latest ? { checkpoint: latest } : {}),
      checkpoints,
      release: async () => {
        await this.transaction(() => {
          this.stmt('delete from harness_run_leases where run_id = ? and lease_id = ?').run(runId, leaseId)
          this.stmt('update harness_runs set status = ? where id = ? and status = ?').run('interrupted', runId, 'running')
        })
      }
    }
  }

  private rowToSession(row: SqlRow): SessionRecord {
    return {
      id: requiredString(row, 'id', 'getSession'),
      createdAt: requiredString(row, 'created_at', 'getSession'),
      updatedAt: requiredString(row, 'updated_at', 'getSession'),
      runCount: requiredNumber(row, 'run_count', 'getSession'),
      ...optional('identity', parseJson<SessionRecord['identity']>(row['identity_json'])),
      ...optional('metadata', parseJson<Record<string, JsonValue>>(row['metadata_json']))
    }
  }

  private rowToMessage(row: SqlRow): Message {
    const toolCalls = parseJson<Message['toolCalls']>(row['tool_calls_json'])
    const toolResults = parseJson<Message['toolResults']>(row['tool_results_json'])
    return {
      id: requiredString(row, 'id', 'listMessages'),
      sessionId: requiredString(row, 'session_id', 'listMessages'),
      role: requiredString(row, 'role', 'listMessages') as Message['role'],
      content: requiredString(row, 'content', 'listMessages'),
      ...optional('toolCalls', toolCalls),
      ...optional('toolResults', toolResults),
      timestamp: requiredString(row, 'timestamp', 'listMessages')
    }
  }

  private rowToRun(row: SqlRow): RunRecord {
    const input = parseJson<JsonValue>(row['input_json'])
    const output = parseJson<JsonValue>(row['output_json'])
    const error = parseJson<SerializedError>(row['error_json'])
    return {
      id: requiredString(row, 'id', 'getRun'),
      sessionId: requiredString(row, 'session_id', 'getRun'),
      kind: requiredString(row, 'kind', 'getRun') as RunRecord['kind'],
      target: requiredString(row, 'target', 'getRun'),
      startedAt: requiredString(row, 'started_at', 'getRun'),
      ...(row['finished_at'] ? { finishedAt: requiredString(row, 'finished_at', 'getRun') } : {}),
      status: requiredString(row, 'status', 'getRun') as RunRecord['status'],
      ...optional('input', input),
      ...optional('output', output),
      ...optional('error', error),
      ...optional('attempt', typeof row['attempt'] === 'number' ? row['attempt'] : undefined),
      ...optional('workerId', typeof row['worker_id'] === 'string' ? row['worker_id'] : undefined),
      ...optional('initialStepId', typeof row['initial_step_id'] === 'string' ? row['initial_step_id'] : undefined),
      ...optional('metadata', parseJson<Record<string, JsonValue>>(row['metadata_json']))
    }
  }

  private rowToCheckpoint(row: SqlRow): RunCheckpoint {
    const output = parseJson<JsonValue>(row['output_json'])
    const replay = parseJson<DurableReplayCheckpoint>(row['replay_json'])
    const metadata = parseJson<Record<string, JsonValue>>(row['metadata_json'])
    return {
      runId: requiredString(row, 'run_id', 'getRun'),
      sessionId: requiredString(row, 'session_id', 'getRun'),
      leaseId: requiredString(row, 'lease_id', 'getRun'),
      workerId: requiredString(row, 'worker_id', 'getRun'),
      stepId: requiredString(row, 'step_id', 'getRun'),
      input: parseJson<JsonValue>(row['input_json']) ?? null,
      attempt: requiredNumber(row, 'attempt', 'getRun'),
      sequence: requiredNumber(row, 'sequence', 'getRun'),
      ...optional('output', output),
      ...optional('replay', replay),
      ...optional('metadata', metadata),
      committedAt: requiredString(row, 'committed_at', 'getRun')
    }
  }

  private async storageSpan<T>(operation: string, attrs: SpanAttrs, fn: (recordAttrs: (extra: SpanAttrs) => void) => Promise<T>): Promise<T> {
    return this.operationSpan('harness.storage', 'harness.storage.operation.duration', 'harness.storage.operations', {
      'harness.storage.adapter': this.id,
      'harness.storage.operation': operation,
      'harness.storage.persistent': true,
      ...attrs
    }, fn)
  }

  private async operationSpan<T>(prefix: string, histogram: string, counter: string, attrs: SpanAttrs, fn: (recordAttrs: (extra: SpanAttrs) => void) => Promise<T>): Promise<T> {
    const merged: SpanAttrs = { ...attrs }
    const started = Date.now()
    const run = async (span?: { setAttributes(next: Record<string, string | number | boolean | string[]>): unknown }): Promise<T> => {
      const recordAttrs = (extra: SpanAttrs): void => {
        Object.assign(merged, extra)
        span?.setAttributes(definedAttrs(extra))
      }
      try {
        const result = await fn(recordAttrs)
        this.telemetry?.recordCounter(counter, 1, merged)
        return result
      } finally {
        this.telemetry?.recordHistogram(histogram, (Date.now() - started) / 1000, merged)
      }
    }
    return this.telemetry ? this.telemetry.span(`${prefix}.${String(merged[`${prefix}.operation`] ?? 'operation')}`, merged, (span) => run(span)) : run()
  }
}

function definedAttrs(attrs: SpanAttrs): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function optional<K extends string, V>(key: K, value: V | undefined): V extends undefined ? Record<never, never> : { [P in K]: V } {
  return (value === undefined ? {} : { [key]: value }) as V extends undefined ? Record<never, never> : { [P in K]: V }
}

/** Creates the zero-dependency local SQLite Harness storage. */
export function sqliteHarnessStorage(options: SqliteHarnessStorageOptions): HarnessStorage & { close(): Promise<void> } {
  return new SqliteHarnessStorage(options)
}
