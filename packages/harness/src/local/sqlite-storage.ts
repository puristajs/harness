import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { StateError, WorkspaceError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type { Message, PersistedRunEvent, RunRecord, RunStatus, SerializedError, SessionRecord } from '../models/state.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import type { ContextCheckpoint, ContextCheckpointQuery, ContextCheckpointRef, ContextCheckpointStore, ContextCheckpointStoreInfo } from '../ports/context-checkpoints.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'
import type { FinishRunPatch, StateStore } from '../ports/state.js'
import type { DurableReplayCheckpoint } from '../ports/workspace.js'
import { DurableRunLeaseError, DurableTerminalRunError, isTerminalRunStatus, type DurableRunLease, type DurableRunStart, type DurableRuntime, type RunCheckpoint } from '../runtime/durable.js'

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

export interface SqliteDurableRuntimeOptions {
  /** SQLite database file. */
  file: string
  /** Lease takeover window for crashed workers. Default: `120_000`. */
  leaseTtlMs?: number
}

export interface SqliteContextCheckpointStoreOptions {
  /** SQLite database file. */
  file: string
}

export interface SqliteStateStoreOptions {
  /** SQLite database file. */
  file: string
}

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
  const loaded = require(moduleName) as { Database?: new(file: string) => unknown; DatabaseSync?: new(file: string) => unknown }
  const Database = loaded.DatabaseSync ?? loaded.Database
  if (!Database) {
    throw new StateError('Built-in SQLite driver is unavailable.', { op: 'createRun', reason: 'sqlite_unavailable' })
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

function now(): string {
  return new Date().toISOString()
}

function stringify(value: unknown): string | null {
  if (value === undefined) return null
  return JSON.stringify(value)
}

function parseJson<T>(value: SqlValue | undefined): T | undefined {
  if (typeof value !== 'string') return undefined
  return JSON.parse(value) as T
}

function requiredString(row: SqlRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new StateError('SQLite row is missing a required string.', { op: 'getRun', reason: key })
  return value
}

function requiredNumber(row: SqlRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number') throw new StateError('SQLite row is missing a required number.', { op: 'getRun', reason: key })
  return value
}

/** SQLite-backed local storage implementing StateStore, DurableRuntime, and ContextCheckpointStore. */
export class SqliteHarnessStorage implements StateStore, DurableRuntime, ContextCheckpointStore {
  public readonly capabilities = [
    'runtime.checkpoint',
    'runtime.retry',
    'runtime.distributed_lock',
    'runtime.resume_from_checkpoint',
    'runtime.workspace_checkpoint',
    'runtime.persistent',
    'context_checkpoint.write',
    'context_checkpoint.read',
    'context_checkpoint.list',
    'context_checkpoint.delete',
    'context_checkpoint.persistent'
  ] as const satisfies readonly AdapterCapability[]

  public readonly id = 'sqlite_runtime'
  public readonly info: ContextCheckpointStoreInfo = {
    id: 'sqlite_context_checkpoints',
    packageName: '@purista/harness',
    capabilities: [
      'context_checkpoint.write',
      'context_checkpoint.read',
      'context_checkpoint.list',
      'context_checkpoint.delete',
      'context_checkpoint.persistent'
    ] as const
  }

  private readonly db: SqlDatabase
  private readonly leaseTtlMs: number
  private logger: HarnessAdapterContext['logger'] | undefined
  private telemetry: TelemetryShim | undefined

  public constructor(options: SqliteDurableRuntimeOptions) {
    this.leaseTtlMs = options.leaseTtlMs ?? 120_000
    this.db = openBuiltinSqlite(options.file)
    this.migrate()
  }

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.logger = context.logger
    this.telemetry = context.telemetry
  }

  public async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = this.db.prepare('select * from harness_sessions where id = ?').get(id)
    return row ? this.rowToSession(row) : undefined
  }

  public async upsertSession(record: SessionRecord): Promise<void> {
    this.db.prepare('insert into harness_sessions(id, created_at, updated_at, run_count, metadata_json) values(?, ?, ?, ?, ?) on conflict(id) do update set updated_at=excluded.updated_at, run_count=excluded.run_count, metadata_json=excluded.metadata_json')
      .run(record.id, record.createdAt, record.updatedAt, record.runCount, stringify(record.metadata))
  }

  public async closeSession(id: string): Promise<void> {
    this.transaction(() => {
      this.db.prepare('delete from harness_sessions where id = ?').run(id)
      this.db.prepare('delete from harness_messages where session_id = ?').run(id)
      this.db.prepare('delete from harness_run_events where run_id in (select id from harness_runs where session_id = ?)').run(id)
      this.db.prepare('delete from harness_runs where session_id = ?').run(id)
    })
  }

  public async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    this.transaction(() => {
      const insert = this.db.prepare('insert into harness_messages(id, session_id, role, content, tool_calls_json, tool_results_json, timestamp) values(?, ?, ?, ?, ?, ?, ?)')
      for (const message of messages) {
        insert.run(message.id, sessionId, message.role, message.content, stringify(message.toolCalls), stringify(message.toolResults), message.timestamp)
      }
    })
  }

  public async listMessages(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<Message[]> {
    const before = opts.before ? this.db.prepare('select timestamp, id from harness_messages where id = ? and session_id = ?').get(opts.before, sessionId) : undefined
    const rows = before
      ? this.db.prepare('select * from harness_messages where session_id = ? and (timestamp < ? or (timestamp = ? and id < ?)) order by timestamp asc, id asc').all(sessionId, requiredString(before, 'timestamp'), requiredString(before, 'timestamp'), opts.before ?? '')
      : this.db.prepare('select * from harness_messages where session_id = ? order by timestamp asc, id asc').all(sessionId)
    const limited = opts.limit === undefined ? rows : rows.slice(Math.max(0, rows.length - opts.limit))
    return limited.map((row) => this.rowToMessage(row))
  }

  public async clearMessages(sessionId: string): Promise<void> {
    this.db.prepare('delete from harness_messages where session_id = ?').run(sessionId)
  }

  public async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    this.transaction(() => {
      this.db.prepare('delete from harness_messages where session_id = ?').run(sessionId)
      const insert = this.db.prepare('insert into harness_messages(id, session_id, role, content, tool_calls_json, tool_results_json, timestamp) values(?, ?, ?, ?, ?, ?, ?)')
      for (const message of messages) {
        insert.run(message.id, sessionId, message.role, message.content, stringify(message.toolCalls), stringify(message.toolResults), message.timestamp)
      }
    })
  }

  public async createRun(record: RunRecord): Promise<void> {
    const existing = await this.getRun(record.id)
    if (existing) {
      if (existing.status === 'succeeded' || existing.status === 'cancelled') {
        throw new StateError('Terminal run already exists.', { op: 'createRun', reason: 'terminal_run_exists' })
      }
      if (existing.sessionId === record.sessionId && existing.kind === record.kind && existing.target === record.target) {
        this.db.prepare('update harness_runs set status = ?, started_at = ?, finished_at = null, input_json = ?, output_json = null, error_json = null where id = ?')
          .run('running', record.startedAt, stringify(record.input), record.id)
        return
      }
      throw new StateError('Run id already exists for a different run.', { op: 'createRun', reason: 'run_conflict' })
    }
    this.db.prepare('insert into harness_runs(id, session_id, kind, target, started_at, finished_at, status, input_json, output_json, error_json) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.sessionId, record.kind, record.target, record.startedAt, record.finishedAt ?? null, record.status, stringify(record.input), stringify(record.output), stringify(record.error))
  }

  public async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    this.transaction(() => {
      this.db.prepare('update harness_runs set status = coalesce(?, status), finished_at = coalesce(?, finished_at), output_json = coalesce(?, output_json), error_json = coalesce(?, error_json) where id = ?')
        .run(patch.status ?? null, patch.finishedAt ?? null, stringify(patch.output), stringify(patch.error), runId)
      if (patch.status && patch.status !== 'failed') {
        this.db.prepare('update harness_durable_runs set status = ?, output_json = ?, error_json = ?, finished_at = ? where run_id = ?')
          .run(patch.status, stringify(patch.output), stringify(patch.error), patch.finishedAt ?? now(), runId)
        this.db.prepare('delete from harness_durable_leases where run_id = ?').run(runId)
      }
    })
  }

  public async getRun(runId: string): Promise<RunRecord | undefined> {
    const row = this.db.prepare('select * from harness_runs where id = ?').get(runId)
    return row ? this.rowToRun(row) : undefined
  }

  public async listRuns(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<RunRecord[]> {
    const before = opts.before ? this.db.prepare('select started_at, id from harness_runs where id = ? and session_id = ?').get(opts.before, sessionId) : undefined
    const rows = before
      ? this.db.prepare('select * from harness_runs where session_id = ? and (started_at < ? or (started_at = ? and id < ?)) order by started_at desc, id desc').all(sessionId, requiredString(before, 'started_at'), requiredString(before, 'started_at'), opts.before ?? '')
      : this.db.prepare('select * from harness_runs where session_id = ? order by started_at desc, id desc').all(sessionId)
    return (opts.limit === undefined ? rows : rows.slice(0, opts.limit)).map((row) => this.rowToRun(row))
  }

  public async appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    this.transaction(() => {
      const insert = this.db.prepare('insert into harness_run_events(id, run_id, at, type, payload_json) values(?, ?, ?, ?, ?)')
      for (const event of events) insert.run(event.id, runId, event.at, event.type, JSON.stringify(event.payload))
    })
  }

  public async listEvents(runId: string, opts: { limit?: number; after?: string } = {}): Promise<PersistedRunEvent[]> {
    const rows = opts.after
      ? this.db.prepare('select * from harness_run_events where run_id = ? and id > ? order by id asc').all(runId, opts.after)
      : this.db.prepare('select * from harness_run_events where run_id = ? order by id asc').all(runId)
    return (opts.limit === undefined ? rows : rows.slice(0, opts.limit)).map((row) => ({
      id: requiredString(row, 'id'),
      runId: requiredString(row, 'run_id'),
      at: requiredString(row, 'at'),
      type: requiredString(row, 'type'),
      payload: parseJson<JsonValue>(row['payload_json']) ?? null
    }))
  }

  public async startRun(record: DurableRunStart): Promise<DurableRunLease> {
    return this.runtimeSpan('start', {
      'harness.runtime.adapter': this.id,
      'harness.runtime.operation': 'start',
      'harness.runtime.persistent': true,
      'harness.run.id': record.runId,
      'harness.session.id': record.sessionId
    }, () => this.withSessionLock(record.sessionId, async () => {
      const current = this.loadDurableRun(record.runId)
      if (current && isTerminalRunStatus(current.status)) throw new DurableTerminalRunError(record.runId, current.status)
      this.assertLeaseAvailable(record.runId, record.sessionId, record.workerId)
      const attempt = current ? current.attempt + 1 : Math.max(1, record.attempt ?? 1)
      if (!current) {
        this.db.prepare('insert into harness_durable_runs(run_id, session_id, worker_id, step_id, input_json, attempt, status, metadata_json, started_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(record.runId, record.sessionId, record.workerId, record.stepId, JSON.stringify(record.input), attempt, 'running', stringify(record.metadata), now())
      } else {
        this.db.prepare('update harness_durable_runs set attempt = ?, worker_id = ? where run_id = ?').run(attempt, record.workerId, record.runId)
      }
      const leaseId = `lease_${Date.now()}_${Math.random().toString(36).slice(2)}`
      const expiresAt = new Date(Date.now() + this.leaseTtlMs).toISOString()
      this.db.prepare('insert into harness_durable_leases(run_id, session_id, worker_id, lease_id, expires_at) values(?, ?, ?, ?, ?)')
        .run(record.runId, record.sessionId, record.workerId, leaseId, expiresAt)
      return this.toLease(record.runId, leaseId)
    }))
  }

  public async loadCheckpoint(runId: string): Promise<RunCheckpoint | undefined> {
    const row = this.db.prepare('select * from harness_durable_checkpoints where run_id = ? order by sequence desc limit 1').get(runId)
    return row ? this.rowToCheckpoint(row) : undefined
  }

  public async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    return this.runtimeSpan('checkpoint', {
      'harness.runtime.adapter': this.id,
      'harness.runtime.operation': 'checkpoint',
      'harness.runtime.persistent': true,
      'harness.runtime.attempt': checkpoint.attempt,
      'harness.runtime.sequence': checkpoint.sequence,
      'harness.runtime.step_id': checkpoint.stepId,
      'harness.run.id': checkpoint.runId,
      'harness.session.id': checkpoint.sessionId
    }, async () => { this.transaction(() => {
      const lease = this.db.prepare('select * from harness_durable_leases where run_id = ? and lease_id = ? and worker_id = ?').get(checkpoint.runId, checkpoint.leaseId, checkpoint.workerId)
      if (!lease) throw new DurableRunLeaseError(`Durable run "${checkpoint.runId}" is not owned by this lease.`)
      const existing = this.db.prepare('select * from harness_durable_checkpoints where run_id = ? and step_id = ?').get(checkpoint.runId, checkpoint.stepId)
      const outputJson = stringify(checkpoint.output)
      const replayJson = stringify(checkpoint.replay)
      if (existing) {
        if (existing['output_json'] !== outputJson || existing['replay_json'] !== replayJson || existing['sequence'] !== checkpoint.sequence || existing['attempt'] !== checkpoint.attempt) {
          throw new WorkspaceError('Durable checkpoint idempotency conflict.', { reason: 'checkpoint_conflict', run_id: checkpoint.runId, session_id: checkpoint.sessionId })
        }
        return
      }
      this.db.prepare('insert into harness_durable_checkpoints(run_id, session_id, lease_id, worker_id, step_id, input_json, attempt, sequence, output_json, replay_json, metadata_json, committed_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(checkpoint.runId, checkpoint.sessionId, checkpoint.leaseId, checkpoint.workerId, checkpoint.stepId, JSON.stringify(checkpoint.input), checkpoint.attempt, checkpoint.sequence, outputJson, replayJson, stringify(checkpoint.metadata), checkpoint.committedAt ?? now())
    }) })
  }

  public async withSessionLock<T>(_sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.transactionAsync(fn)
  }

  public async write(checkpoint: ContextCheckpoint, opts: { signal?: AbortSignal } = {}): Promise<void> {
    return this.contextSpan('write', {
      'harness.context_checkpoint.kind': checkpoint.kind,
      'harness.context_checkpoint.payload_size_bytes': checkpoint.payloadSizeBytes,
      'harness.run.id': checkpoint.runId,
      'harness.session.id': checkpoint.sessionId,
      ...(checkpoint.workflowId ? { 'harness.workflow.id': checkpoint.workflowId } : {}),
      ...(checkpoint.agentId ? { 'harness.agent.id': checkpoint.agentId } : {})
    }, async () => {
      throwIfAborted(opts.signal)
      this.db.prepare('insert into harness_context_checkpoints(run_id, session_id, workflow_id, agent_id, sequence, kind, payload_json, payload_size_bytes, created_at, metadata_json) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(run_id, session_id, sequence, kind) do update set payload_json=excluded.payload_json, payload_size_bytes=excluded.payload_size_bytes, created_at=excluded.created_at, metadata_json=excluded.metadata_json')
        .run(checkpoint.runId, checkpoint.sessionId, checkpoint.workflowId ?? null, checkpoint.agentId ?? null, checkpoint.sequence, checkpoint.kind, JSON.stringify(checkpoint.payload), checkpoint.payloadSizeBytes, checkpoint.createdAt, stringify(checkpoint.metadata))
    })
  }

  public async list(query: ContextCheckpointQuery): Promise<readonly ContextCheckpoint[]> {
    throwIfAborted(query.signal)
    const clauses: string[] = []
    const params: SqlValue[] = []
    for (const [column, value] of [
      ['run_id', query.runId],
      ['session_id', query.sessionId],
      ['workflow_id', query.workflowId],
      ['agent_id', query.agentId],
      ['kind', query.kind]
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`)
        params.push(value)
      }
    }
    const where = clauses.length > 0 ? `where ${clauses.join(' and ')}` : ''
    const limit = query.limit ?? 100
    const rows = this.db.prepare(`select * from harness_context_checkpoints ${where} order by sequence asc limit ?`).all(...params, limit)
    return rows.map((row) => this.rowToContextCheckpoint(row))
  }

  public async read(ref: ContextCheckpointRef): Promise<ContextCheckpoint | undefined> {
    const row = this.db.prepare('select * from harness_context_checkpoints where run_id = ? and session_id = ? and sequence = ? and kind = ?')
      .get(ref.runId, ref.sessionId, ref.sequence, ref.kind)
    return row ? this.rowToContextCheckpoint(row) : undefined
  }

  public async delete(ref: ContextCheckpointRef): Promise<void> {
    this.db.prepare('delete from harness_context_checkpoints where run_id = ? and session_id = ? and sequence = ? and kind = ?')
      .run(ref.runId, ref.sessionId, ref.sequence, ref.kind)
  }

  public async close(): Promise<void> {
    this.db.close()
  }

  private migrate(): void {
    this.db.exec(`
      pragma journal_mode = WAL;
      pragma foreign_keys = ON;
      pragma busy_timeout = 5000;
      create table if not exists harness_sessions(id text primary key, created_at text not null, updated_at text not null, run_count integer not null, metadata_json text);
      create table if not exists harness_messages(id text primary key, session_id text not null, role text not null, content text not null, tool_calls_json text, tool_results_json text, timestamp text not null);
      create index if not exists idx_harness_messages_session_order on harness_messages(session_id, timestamp, id);
      create table if not exists harness_runs(id text primary key, session_id text not null, kind text not null, target text not null, started_at text not null, finished_at text, status text not null, input_json text, output_json text, error_json text);
      create index if not exists idx_harness_runs_session_order on harness_runs(session_id, started_at, id);
      create table if not exists harness_run_events(id text primary key, run_id text not null, at text not null, type text not null, payload_json text not null);
      create index if not exists idx_harness_run_events_run_order on harness_run_events(run_id, id);
      create table if not exists harness_durable_runs(run_id text primary key, session_id text not null, worker_id text not null, step_id text not null, input_json text not null, attempt integer not null, status text not null, metadata_json text, output_json text, error_json text, started_at text not null, finished_at text);
      create table if not exists harness_durable_checkpoints(run_id text not null, session_id text not null, lease_id text not null, worker_id text not null, step_id text not null, input_json text not null, attempt integer not null, sequence integer not null, output_json text, replay_json text, metadata_json text, committed_at text not null, primary key(run_id, step_id));
      create index if not exists idx_harness_durable_checkpoints_order on harness_durable_checkpoints(run_id, sequence);
      create table if not exists harness_durable_leases(run_id text primary key, session_id text not null, worker_id text not null, lease_id text not null, expires_at text not null);
      create table if not exists harness_context_checkpoints(run_id text not null, session_id text not null, workflow_id text, agent_id text, sequence integer not null, kind text not null, payload_json text not null, payload_size_bytes integer not null, created_at text not null, metadata_json text, primary key(run_id, session_id, sequence, kind));
    `)
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('begin immediate')
    try {
      const result = fn()
      this.db.exec('commit')
      return result
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  private async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('begin immediate')
    try {
      const result = await fn()
      this.db.exec('commit')
      return result
    } catch (error) {
      this.db.exec('rollback')
      throw error
    }
  }

  private loadDurableRun(runId: string): { status: RunStatus; attempt: number } | undefined {
    const row = this.db.prepare('select status, attempt from harness_durable_runs where run_id = ?').get(runId)
    return row ? { status: requiredString(row, 'status') as RunStatus, attempt: requiredNumber(row, 'attempt') } : undefined
  }

  private assertLeaseAvailable(runId: string, sessionId: string, workerId: string): void {
    const nowIso = now()
    this.db.prepare('delete from harness_durable_leases where expires_at < ?').run(nowIso)
    const runLease = this.db.prepare('select * from harness_durable_leases where run_id = ?').get(runId)
    if (runLease && runLease['worker_id'] !== workerId) throw new DurableRunLeaseError(`Durable run "${runId}" is already owned by worker "${runLease['worker_id']}".`)
    const sessionLease = this.db.prepare('select * from harness_durable_leases where session_id = ? and run_id != ?').get(sessionId, runId)
    if (sessionLease && sessionLease['worker_id'] !== workerId) throw new DurableRunLeaseError(`Durable session "${sessionId}" is already owned by another worker.`)
  }

  private toLease(runId: string, leaseId: string): DurableRunLease {
    const run = this.db.prepare('select * from harness_durable_runs where run_id = ?').get(runId)
    if (!run) throw new DurableRunLeaseError(`Durable run "${runId}" has not been started.`)
    const checkpoints = this.db.prepare('select * from harness_durable_checkpoints where run_id = ? order by sequence asc').all(runId).map((row) => this.rowToCheckpoint(row))
    const latest = checkpoints.at(-1)
    return {
      runId,
      sessionId: requiredString(run, 'session_id'),
      workerId: requiredString(run, 'worker_id'),
      leaseId,
      attempt: requiredNumber(run, 'attempt'),
      resumed: checkpoints.length > 0,
      start: {
        runId,
        sessionId: requiredString(run, 'session_id'),
        workerId: requiredString(run, 'worker_id'),
        stepId: requiredString(run, 'step_id'),
        input: parseJson<JsonValue>(run['input_json']) ?? null,
        attempt: requiredNumber(run, 'attempt'),
        ...optional('metadata', parseJson<Record<string, JsonValue>>(run['metadata_json']))
      },
      ...(latest ? { checkpoint: latest } : {}),
      checkpoints,
      release: async () => {
        this.db.prepare('delete from harness_durable_leases where run_id = ? and lease_id = ?').run(runId, leaseId)
      }
    }
  }

  private rowToSession(row: SqlRow): SessionRecord {
    return {
      id: requiredString(row, 'id'),
      createdAt: requiredString(row, 'created_at'),
      updatedAt: requiredString(row, 'updated_at'),
      runCount: requiredNumber(row, 'run_count'),
      ...optional('metadata', parseJson<Record<string, JsonValue>>(row['metadata_json']))
    }
  }

  private rowToMessage(row: SqlRow): Message {
    const toolCalls = parseJson<Message['toolCalls']>(row['tool_calls_json'])
    const toolResults = parseJson<Message['toolResults']>(row['tool_results_json'])
    return {
      id: requiredString(row, 'id'),
      sessionId: requiredString(row, 'session_id'),
      role: requiredString(row, 'role') as Message['role'],
      content: requiredString(row, 'content'),
      ...optional('toolCalls', toolCalls),
      ...optional('toolResults', toolResults),
      timestamp: requiredString(row, 'timestamp')
    }
  }

  private rowToRun(row: SqlRow): RunRecord {
    const input = parseJson<JsonValue>(row['input_json'])
    const output = parseJson<JsonValue>(row['output_json'])
    const error = parseJson<SerializedError>(row['error_json'])
    return {
      id: requiredString(row, 'id'),
      sessionId: requiredString(row, 'session_id'),
      kind: requiredString(row, 'kind') as RunRecord['kind'],
      target: requiredString(row, 'target'),
      startedAt: requiredString(row, 'started_at'),
      ...(row['finished_at'] ? { finishedAt: requiredString(row, 'finished_at') } : {}),
      status: requiredString(row, 'status') as RunRecord['status'],
      ...optional('input', input),
      ...optional('output', output),
      ...optional('error', error)
    }
  }

  private rowToCheckpoint(row: SqlRow): RunCheckpoint {
    const output = parseJson<JsonValue>(row['output_json'])
    const replay = parseJson<DurableReplayCheckpoint>(row['replay_json'])
    const metadata = parseJson<Record<string, JsonValue>>(row['metadata_json'])
    return {
      runId: requiredString(row, 'run_id'),
      sessionId: requiredString(row, 'session_id'),
      leaseId: requiredString(row, 'lease_id'),
      workerId: requiredString(row, 'worker_id'),
      stepId: requiredString(row, 'step_id'),
      input: parseJson<JsonValue>(row['input_json']) ?? null,
      attempt: requiredNumber(row, 'attempt'),
      sequence: requiredNumber(row, 'sequence'),
      ...optional('output', output),
      ...optional('replay', replay),
      ...optional('metadata', metadata),
      committedAt: requiredString(row, 'committed_at')
    }
  }

  private rowToContextCheckpoint(row: SqlRow): ContextCheckpoint {
    const metadata = parseJson<Record<string, JsonValue>>(row['metadata_json'])
    return {
      runId: requiredString(row, 'run_id'),
      sessionId: requiredString(row, 'session_id'),
      ...(row['workflow_id'] ? { workflowId: requiredString(row, 'workflow_id') } : {}),
      ...(row['agent_id'] ? { agentId: requiredString(row, 'agent_id') } : {}),
      sequence: requiredNumber(row, 'sequence'),
      kind: requiredString(row, 'kind') as ContextCheckpoint['kind'],
      payload: parseJson<JsonValue>(row['payload_json']) ?? null,
      payloadSizeBytes: requiredNumber(row, 'payload_size_bytes'),
      createdAt: requiredString(row, 'created_at'),
      ...optional('metadata', metadata)
    }
  }

  private async runtimeSpan<T>(operation: string, attrs: SpanAttrs, fn: () => Promise<T>): Promise<T> {
    return this.operationSpan('harness.runtime', 'harness.runtime.operation.duration', 'harness.runtime.operations', {
      'harness.runtime.adapter': this.id,
      'harness.runtime.operation': operation,
      ...attrs
    }, fn)
  }

  private async contextSpan<T>(operation: string, attrs: SpanAttrs, fn: () => Promise<T>): Promise<T> {
    return this.operationSpan('harness.context_checkpoint', 'harness.context_checkpoint.operation.duration', 'harness.context_checkpoint.operations', {
      'harness.context_checkpoint.adapter': this.info.id,
      'harness.context_checkpoint.operation': operation,
      ...attrs
    }, fn)
  }

  private async operationSpan<T>(prefix: string, histogram: string, counter: string, attrs: SpanAttrs, fn: () => Promise<T>): Promise<T> {
    const started = Date.now()
    const run = async (): Promise<T> => {
      try {
        const result = await fn()
        this.telemetry?.recordCounter(counter, 1, attrs)
        return result
      } finally {
        this.telemetry?.recordHistogram(histogram, (Date.now() - started) / 1000, attrs)
      }
    }
    return this.telemetry ? this.telemetry.span(`${prefix}.${String(attrs[`${prefix}.operation`] ?? 'operation')}`, attrs, run) : run()
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): V extends undefined ? Record<never, never> : { [P in K]: V } {
  return (value === undefined ? {} : { [key]: value }) as V extends undefined ? Record<never, never> : { [P in K]: V }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StateError('Context checkpoint operation was cancelled.', { op: 'contextCheckpointWrite', reason: 'cancelled' })
}

export function sqliteDurableRuntime(options: SqliteDurableRuntimeOptions): DurableRuntime & { close(): Promise<void> } {
  return new SqliteHarnessStorage(options)
}

export function sqliteStateStore(options: SqliteStateStoreOptions): StateStore & { close(): Promise<void> } {
  return new SqliteHarnessStorage(options)
}

export function sqliteContextCheckpointStore(options: SqliteContextCheckpointStoreOptions): ContextCheckpointStore & { close(): Promise<void> } {
  return new SqliteHarnessStorage(options)
}
