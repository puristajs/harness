import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { HarnessConfigError, StateError } from '../errors/index.js'
import { sameHarnessIdentity } from '../identity/index.js'
import type { JsonValue } from '../models/json.js'
import type { Message, PersistedFinalRunEvent, PersistedRunEvent, RunRecord, RunStatus, SerializedError, SessionRecord } from '../models/state.js'
import { harnessExecutionEventTypesV1 } from '../definitions/execution-events.js'
import { canonicalJson } from '../runtime/canonical-json.js'
import { assertSessionSandboxBindingTransition } from './session-binding.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import {
  createExternalWaitCancellation,
  ExternalWaitError,
  asExternalWaitResolved,
  projectExternalWaitRequest,
  validateBoundExternalWaitRequest,
  validateExternalWaitId,
  validateExternalWaitSignal,
  validateExternalWaitSignalResult,
  validateExternalWaitSnapshot,
  type BoundExternalWaitRequest,
  type ExternalWaitRegistration,
  type ExternalWaitSignal,
  type ExternalWaitSignalResult,
  type ExternalWaitSnapshot
} from '../storage/external-wait.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'
import type { AcquireRunRequest, CreateRunRequest, FinalizeRunRequest, FinishRunPatch, HarnessStorage, ReplaceCheckpointRequest, RunAcquisitionExpectation } from '../storage/types.js'
import type { DurableReplayCheckpoint } from '../ports/workspace.js'
import {
  AsyncMutex,
  DurableRunLeaseError,
  DurableTerminalRunError,
  isResumeBlockingRunStatus,
  type DurableRunLease,
  type DurableTerminalRunStatus,
  type RunCheckpoint
} from './execution.js'
import { assertStoredRunRecord, normalizeFinishRunPatch, normalizeRunCheckpoint, sameInstalledRunCheckpoint } from './run-record-validation.js'

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
 * const harness = await definition.getInstance({ storage, model })
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

  public async upsertSession(record: SessionRecord, mode: 'create' | 'update'): Promise<boolean> {
    if (mode !== 'create' && mode !== 'update') {
      throw new StateError('Session write mode is invalid.', { op: 'upsertSession', reason: 'invalid_session_write_mode' })
    }
    assertSessionSandboxBindingTransition(record.sandboxBinding, record.sandboxBinding, 'upsertSession')
    return this.transaction(() => {
      const row = this.stmt('select * from harness_sessions where id = ?').get(record.id)
      if (row) {
        const existing = this.rowToSession(row)
        if (!sameHarnessIdentity(existing.identity, record.identity)) {
          throw new StateError('Session identity cannot be changed.', { op: 'upsertSession', reason: 'session_identity_mismatch' })
        }
        if (mode === 'create') return false
        if (existing.instanceId !== record.instanceId || existing.createdAt !== record.createdAt) {
          throw new StateError('Session instance is no longer active.', { op: 'upsertSession', reason: 'session_instance_mismatch' })
        }
        assertSessionSandboxBindingTransition(existing.sandboxBinding, record.sandboxBinding, 'upsertSession')
        if (record.updatedAt < existing.updatedAt || record.runCount < existing.runCount) return false
        this.stmt('update harness_sessions set updated_at = ?, run_count = ?, sandbox_binding_json = ?, metadata_json = ? where id = ?')
          .run(record.updatedAt, record.runCount, stringify(record.sandboxBinding), stringify(record.metadata), record.id)
        return false
      }
      if (mode === 'update') {
        throw new StateError('Session instance is no longer active.', { op: 'upsertSession', reason: 'session_instance_mismatch' })
      }
      this.stmt('insert into harness_sessions(id, instance_id, created_at, updated_at, run_count, identity_json, sandbox_binding_json, metadata_json) values(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.instanceId, record.createdAt, record.updatedAt, record.runCount, stringify(record.identity), stringify(record.sandboxBinding), stringify(record.metadata))
      return true
    })
  }

  public async closeSession(id: string, expectedInstanceId: string): Promise<void> {
    await this.transaction(() => {
      const row = this.stmt('select instance_id from harness_sessions where id = ?').get(id)
      if (!row || row['instance_id'] !== expectedInstanceId) return
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
      let messageOrder = this.nextMessageOrder(sessionId)
      const insert = this.stmt('insert into harness_messages(id, session_id, role, content, tool_calls_json, tool_results_json, timestamp, message_order) values(?, ?, ?, ?, ?, ?, ?, ?)')
      for (const message of messages) {
        try {
          insert.run(message.id, sessionId, message.role, message.content, stringify(message.toolCalls), stringify(message.toolResults), message.timestamp, messageOrder++)
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
    const before = opts.before ? this.stmt('select message_order from harness_messages where id = ? and session_id = ?').get(opts.before, sessionId) : undefined
    const beforeClause = before ? ' and message_order < ?' : ''
    const beforeParams: SqlValue[] = before
      ? [requiredNumber(before, 'message_order', 'listMessages')]
      : []
    if (opts.limit === undefined) {
      const rows = this.stmt(`select * from harness_messages where session_id = ?${beforeClause} order by message_order asc`).all(sessionId, ...beforeParams)
      return rows.map((row) => this.rowToMessage(row))
    }
    // Tail semantics: fetch the newest `limit` rows and restore ascending order.
    const rows = this.stmt(`select * from harness_messages where session_id = ?${beforeClause} order by message_order desc limit ?`).all(sessionId, ...beforeParams, Math.max(0, opts.limit))
    return rows.reverse().map((row) => this.rowToMessage(row))
  }

  public async clearMessages(sessionId: string): Promise<void> {
    this.stmt('delete from harness_messages where session_id = ?').run(sessionId)
  }

  public async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    await this.transaction(() => {
      this.stmt('delete from harness_messages where session_id = ?').run(sessionId)
      const insert = this.stmt('insert into harness_messages(id, session_id, role, content, tool_calls_json, tool_results_json, timestamp, message_order) values(?, ?, ?, ?, ?, ?, ?, ?)')
      for (const [index, message] of messages.entries()) {
        try {
          insert.run(message.id, sessionId, message.role, message.content, stringify(message.toolCalls), stringify(message.toolResults), message.timestamp, index + 1)
        } catch (error) {
          if (isConstraintViolation(error)) {
            throw new StateError('Message id already exists.', { op: 'replaceMessages', reason: 'duplicate_message_id' }, error)
          }
          throw error
        }
      }
    })
  }

  public async createRun(request: CreateRunRequest): Promise<RunRecord> {
    const record = normalizeCreateRunRequest(request)
    return this.transaction(() => {
      const existing = this.loadRun(record.id)
      if (existing) {
        if (runCreationBytes(existing) === runCreationBytes(record)) return existing
        throw runConflict()
      }
      try {
        this.stmt('insert into harness_runs(id, session_id, kind, target, started_at, finished_at, status, revision, input_json, validated_input_json, output_json, error_json, approval_receipt_json, attempt, worker_id, initial_step_id, metadata_json) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(record.id, record.sessionId, record.kind, record.target, record.startedAt, null, 'running', 1,
            JSON.stringify(record.input), record.kind === 'child_task' ? null : JSON.stringify(record.validatedInput),
            null, null, null, null, null, null, stringify(record.metadata))
      } catch (error) {
        if (isConstraintViolation(error)) {
          const winner = this.loadRun(record.id)
          if (winner && runCreationBytes(winner) === runCreationBytes(record)) return winner
          throw runConflict()
        }
        throw error
      }
      return this.loadRun(record.id)!
    })
  }

  public async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    const normalized = normalizeFinishRunPatch(patch, () => this.nowIso(), finishRunConflict)
    return this.storageSpan('finish_run', {
      'harness.run.id': runId,
      'harness.run.status': normalized.status
    }, async () => this.transaction(() => {
      const run = this.loadRun(runId)
      if (run?.attempt !== undefined || this.stmt('select run_id from harness_run_leases where run_id = ?').get(runId)) {
        throw new StateError('A durable run requires atomic finalization.', { op: 'finishRun', reason: 'active_lease_requires_finalize' })
      }
      this.stmt('update harness_runs set status = coalesce(?, status), finished_at = coalesce(?, finished_at), output_json = coalesce(?, output_json), error_json = coalesce(?, error_json), revision = revision + 1 where id = ?')
        .run(normalized.status, normalized.finishedAt ?? null, stringify(normalized.output), stringify(normalized.error), runId)
      if (normalized.status !== 'running') this.stmt('delete from harness_run_leases where run_id = ?').run(runId)
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
    const normalized = events.map((event) => normalizePersistedEvent(event, runId))
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index]!.sequence <= normalized[index - 1]!.sequence) throw eventSequenceConflict()
    }
    await this.transaction(() => {
      const insert = this.stmt('insert into harness_run_events(id, sequence, run_id, at, type, payload_json) values(?, ?, ?, ?, ?, ?)')
      for (const event of normalized) {
        const existing = this.stmt('select * from harness_run_events where run_id = ? and (sequence = ? or id = ?)').get(runId, event.sequence, event.id)
        if (existing) {
          if (canonicalJson(this.rowToEvent(existing)) !== canonicalJson(event)) throw new StateError('Run event conflicts with an existing event.', { op: 'appendEvents', reason: 'event_conflict' })
          continue
        }
        const max = this.stmt('select max(sequence) as sequence from harness_run_events where run_id = ?').get(runId)?.['sequence'] ?? 0
        if (event.sequence !== Number(max) + 1) throw eventSequenceConflict()
        insert.run(event.id, event.sequence, runId, event.at, event.type, JSON.stringify(event.payload))
      }
    })
  }

  public async listEvents(runId: string, opts: { limit?: number; after?: string } = {}): Promise<PersistedRunEvent[]> {
    const afterRow = opts.after ? this.stmt('select sequence from harness_run_events where run_id = ? and id = ?').get(runId, opts.after) : undefined
    const afterClause = afterRow ? ' and sequence > ?' : ''
    const afterParams: SqlValue[] = afterRow ? [requiredNumber(afterRow, 'sequence', 'listEvents')] : []
    const limitClause = opts.limit === undefined ? '' : ' limit ?'
    const limitParams: SqlValue[] = opts.limit === undefined ? [] : [Math.max(0, opts.limit)]
    const rows = this.stmt(`select * from harness_run_events where run_id = ?${afterClause} order by sequence asc${limitClause}`).all(runId, ...afterParams, ...limitParams)
    return rows.map(row => this.rowToEvent(row))
  }

  public async acquireRun(request: AcquireRunRequest): Promise<DurableRunLease> {
    const record = normalizeAcquireRunRequest(request)
    return this.storageSpan('acquire_run', {
      'harness.run.id': record.runId,
      'harness.session.id': record.sessionId
    }, (recordAttrs) => this.withSessionLock(record.sessionId, async () => this.transaction(() => {
      const current = this.loadRun(record.runId)
      if (!current) throw new StateError('Durable run must be created before acquisition.', { op: 'acquireRun', reason: 'run_not_found' })
      if (current.sessionId !== record.sessionId) throw acquisitionConflict()
      if (isResumeBlockingRunStatus(current.status)) {
        throw new DurableTerminalRunError(record.runId, current.status as DurableTerminalRunStatus)
      }
      const selected = this.stmt('select * from harness_run_checkpoints where run_id = ? and step_id = ?').get(record.runId, record.expected.checkpoint.stepId)
      const anyCheckpoint = this.stmt('select step_id from harness_run_checkpoints where run_id = ? limit 1').get(record.runId)
      const selectedSequence = selected ? requiredNumber(selected, 'sequence', 'loadCheckpoint') : null
      const requestJson = canonicalJson(record)
      const existingLease = this.stmt('select * from harness_run_leases where run_id = ?').get(record.runId)
      if (existingLease && existingLease['acquisition_id'] === record.acquisitionId && existingLease['request_json'] === requestJson
        && existingLease['acquired_revision'] === current.revision
        && Date.parse(requiredString(existingLease, 'expires_at', 'acquireRun')) > this.clock()
        && selectedSequence === record.expected.checkpoint.sequence) {
        return this.toLease(record, requiredString(existingLease, 'lease_id', 'acquireRun'))
      }
      if (current.revision !== record.expected.revision || current.status !== record.expected.status
        || selectedSequence !== record.expected.checkpoint.sequence
        || (record.mode === 'initial' && (current.revision !== 1 || current.attempt !== undefined || current.workerId !== undefined || anyCheckpoint !== undefined))
        || (record.mode === 'resume' && current.attempt === undefined)) throw acquisitionConflict()
      this.assertLeaseAvailable(record.runId, record.sessionId)
      const attempt = Math.max((current.attempt ?? 0) + 1, record.requestedAttempt ?? 1)
      this.stmt('update harness_runs set attempt = ?, worker_id = ?, initial_step_id = coalesce(initial_step_id, ?), status = ?, revision = revision + 1 where id = ?')
        .run(attempt, record.workerId, record.mode === 'initial' ? record.expected.checkpoint.stepId : null, 'running', record.runId)
      const leaseId = `lease_${this.clock()}_${Math.random().toString(36).slice(2)}`
      const expiresAt = new Date(this.clock() + this.leaseTtlMs).toISOString()
      const acquired = this.loadRun(record.runId)!
      this.stmt('insert into harness_run_leases(run_id, session_id, worker_id, acquisition_id, request_json, acquired_revision, lease_id, expires_at) values(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record.runId, record.sessionId, record.workerId, record.acquisitionId, requestJson, acquired.revision, leaseId, expiresAt)
      const lease = this.toLease(record, leaseId)
      recordAttrs({ 'harness.storage.resumed': lease.resumed, 'harness.storage.attempt': lease.attempt })
      return lease
    })))
  }

  public async replaceCheckpoint(request: ReplaceCheckpointRequest): Promise<void> {
    const normalized = normalizeReplaceCheckpointRequest(request)
    await this.withSessionLock(normalized.sessionId, async () => this.transaction(() => {
      const lease = this.stmt('select * from harness_run_leases where run_id = ? and session_id = ? and lease_id = ? and worker_id = ? and expires_at > ?')
        .get(normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId, this.nowIso())
      const run = this.loadRun(normalized.runId)
      const currentRow = this.stmt('select * from harness_run_checkpoints where run_id = ? and step_id = ?').get(normalized.runId, normalized.stepId)
      const current = currentRow ? this.rowToCheckpoint(currentRow) : undefined
      if (!lease || !run || run.sessionId !== normalized.sessionId || run.status !== 'running'
        || !current || !checkpointIdentityMatches(current, normalized.replacement, run)) throw checkpointConflict()

      if (current.sequence === normalized.replacement.sequence) {
        if (sameInstalledCheckpoint(current, normalized.replacement)) return
        throw checkpointConflict()
      }
      if (current.sequence !== normalized.expectedSequence) throw checkpointConflict()

      const committedAt = normalized.replacement.committedAt ?? this.nowIso()
      this.stmt('update harness_run_checkpoints set lease_id=?, worker_id=?, input_json=?, attempt=?, sequence=?, output_json=?, replay_json=?, metadata_json=?, committed_at=? where run_id=? and step_id=?')
        .run(normalized.replacement.leaseId, normalized.replacement.workerId, JSON.stringify(normalized.replacement.input), normalized.replacement.attempt, normalized.replacement.sequence,
          stringify(normalized.replacement.output), stringify(normalized.replacement.replay), stringify(normalized.replacement.metadata),
          committedAt, normalized.runId, normalized.stepId)
      this.stmt('update harness_runs set revision = revision + 1 where id = ?').run(normalized.runId)
    }))
  }

  public async finalizeRun(request: FinalizeRunRequest): Promise<void> {
    const normalized = normalizeFinalizeRunRequest(request)
    await this.withSessionLock(normalized.sessionId, async () => this.transaction(() => {
      const run = this.loadRun(normalized.runId)
      if (!run) throw finalizeConflict('run_not_found')
      if (run.sessionId !== normalized.sessionId) throw finalizeConflict('lease_conflict')
      assertApprovalReceiptMatchesRun(normalized.patch.approvalReceipt, run)
      if (isTerminal(run.status)) {
        if (!terminalPatchMatchesRun(run, normalized.patch)) throw finalizeConflict('run_conflict')
        if (!terminalEventMatchesPatch(normalized.terminalEvent, normalized.patch)) throw finalizeConflict('event_conflict')
        const eventRow = this.stmt('select * from harness_run_events where run_id = ? and (id = ? or sequence = ?)')
          .get(normalized.runId, normalized.terminalEvent.id, normalized.terminalEvent.sequence)
        if (eventRow && canonicalJson(this.rowToEvent(eventRow)) === canonicalJson(normalized.terminalEvent)) return
        throw finalizeConflict('event_conflict')
      }
      const lease = this.stmt('select * from harness_run_leases where run_id = ? and session_id = ? and lease_id = ? and worker_id = ? and expires_at > ?')
        .get(normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId, this.nowIso())
      if (!lease) throw finalizeConflict('lease_conflict')
      const maximum = Number(this.stmt('select max(sequence) as sequence from harness_run_events where run_id = ?').get(normalized.runId)?.['sequence'] ?? 0)
      const collision = this.stmt('select id from harness_run_events where run_id = ? and (id = ? or sequence = ?)')
        .get(normalized.runId, normalized.terminalEvent.id, normalized.terminalEvent.sequence)
      if (collision || normalized.terminalEvent.sequence !== maximum + 1 || !terminalEventMatchesPatch(normalized.terminalEvent, normalized.patch)) throw finalizeConflict('event_conflict')
      this.stmt('update harness_runs set status=?, finished_at=?, output_json=?, error_json=?, approval_receipt_json=?, revision=revision+1 where id=?')
        .run(normalized.patch.status, normalized.patch.finishedAt, stringify(normalized.patch.output), stringify(normalized.patch.error), stringify(normalized.patch.approvalReceipt), normalized.runId)
      this.stmt('insert into harness_run_events(id, sequence, run_id, at, type, payload_json) values(?, ?, ?, ?, ?, ?)')
        .run(normalized.terminalEvent.id, normalized.terminalEvent.sequence, normalized.terminalEvent.runId,
          normalized.terminalEvent.at, normalized.terminalEvent.type, JSON.stringify(normalized.terminalEvent.payload))
      this.stmt('delete from harness_run_checkpoints where run_id = ?').run(normalized.runId)
      this.stmt('delete from harness_run_leases where run_id = ?').run(normalized.runId)
    }))
  }

  public async loadCheckpoint(runId: string, stepId?: string): Promise<RunCheckpoint | undefined> {
    return this.storageSpan('load_checkpoint', {
      'harness.run.id': runId
    }, async () => {
      const row = stepId === undefined
        ? this.stmt('select * from harness_run_checkpoints where run_id = ? order by sequence desc limit 1').get(runId)
        : this.stmt('select * from harness_run_checkpoints where run_id = ? and step_id = ? order by sequence desc limit 1').get(runId, stepId)
      return row ? this.rowToCheckpoint(row) : undefined
    })
  }

  public async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    const normalized = normalizeRunCheckpoint(checkpoint, commitCheckpointConflict)
    return this.storageSpan('commit_checkpoint', {
      'harness.storage.attempt': normalized.attempt,
      'harness.storage.sequence': normalized.sequence,
      'harness.storage.step_id': normalized.stepId,
      'harness.run.id': normalized.runId,
      'harness.session.id': normalized.sessionId
    }, () => this.withSessionLock(normalized.sessionId, async () => {
      const inputJson = canonicalJson(normalized.input)
      const outputJson = normalized.output === undefined ? null : canonicalJson(normalized.output)
      const replayJson = normalized.replay === undefined ? null : canonicalJson(normalized.replay)
      const metadataJson = normalized.metadata === undefined ? null : canonicalJson(normalized.metadata)
      return this.transaction(() => {
        const lease = this.stmt('select * from harness_run_leases where run_id = ? and session_id = ? and lease_id = ? and worker_id = ? and expires_at > ?')
          .get(normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId, this.nowIso())
        if (!lease) throw new DurableRunLeaseError(`Durable run "${normalized.runId}" is not owned by this lease.`)
        const run = this.loadRun(normalized.runId)
        if (!run || run.sessionId !== normalized.sessionId || run.status !== 'running'
          || run.attempt !== normalized.attempt || canonicalJson(run.input) !== canonicalJson(normalized.input)) {
          throw commitCheckpointConflict()
        }
        const existing = this.stmt('select * from harness_run_checkpoints where run_id = ? and step_id = ?').get(checkpoint.runId, checkpoint.stepId)
        if (existing) {
          if (sameInstalledRunCheckpoint(this.rowToCheckpoint(existing), normalized)) return
          throw commitCheckpointConflict()
        }
        // Heartbeat only for a newly installed checkpoint; an exact retry is a no-op.
        this.stmt('update harness_run_leases set expires_at = ? where run_id = ? and session_id = ? and lease_id = ? and worker_id = ?')
          .run(new Date(this.clock() + this.leaseTtlMs).toISOString(), normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId)
        this.stmt('insert into harness_run_checkpoints(run_id, session_id, lease_id, worker_id, step_id, input_json, attempt, sequence, output_json, replay_json, metadata_json, committed_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(normalized.runId, normalized.sessionId, normalized.leaseId, normalized.workerId, normalized.stepId, inputJson, normalized.attempt, normalized.sequence, outputJson, replayJson, metadataJson, normalized.committedAt ?? this.nowIso())
        this.stmt('update harness_runs set revision = revision + 1 where id = ?').run(normalized.runId)
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
    const validated = validateBoundExternalWaitRequest(request)
    return this.storageSpan('register_wait', {
      'harness.run.id': validated.runId,
      'harness.session.id': validated.sessionId,
      'harness.wait.kind': validated.kind
    }, async () => this.transaction(() => {
      const existing = this.expireExternalWait(this.loadExternalWait(validated.waitId))
      if (existing) {
        const binding = this.stmt('select run_id, session_id from harness_external_waits where wait_id = ?').get(validated.waitId)
        if (binding?.['run_id'] !== validated.runId || binding?.['session_id'] !== validated.sessionId || existing.kind !== validated.kind || existing.schemaVersion !== validated.schemaVersion || existing.definitionVersion !== validated.definitionVersion || existing.deadline !== validated.deadline) {
          throw new ExternalWaitError('External wait id is already bound to a different request.', 'request_conflict')
        }
        return deepFreeze({ created: false, snapshot: existing })
      }
      const run = this.loadRun(validated.runId)
      if (!run || run.sessionId !== validated.sessionId || run.status !== 'running') {
        throw new ExternalWaitError('External wait run binding is invalid.', 'durable_required')
      }
      const lease = this.stmt('select run_id from harness_run_leases where run_id = ? and session_id = ? and expires_at > ?')
        .get(validated.runId, validated.sessionId, this.nowIso())
      if (!lease) throw new ExternalWaitError('External wait run binding is invalid.', 'durable_required')
      const snapshot = validateExternalWaitSnapshot({
        ...projectExternalWaitRequest(validated),
        status: 'waiting',
        createdAt: this.nowIso()
      })
      this.stmt('insert into harness_external_waits(wait_id, run_id, session_id, kind, schema_version, definition_version, deadline, status, created_at) values(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(snapshot.waitId, validated.runId, validated.sessionId, snapshot.kind, snapshot.schemaVersion, snapshot.definitionVersion, snapshot.deadline, snapshot.status, snapshot.createdAt)
      this.stmt('update harness_runs set status = ?, revision = revision + 1 where id = ?').run('waiting', validated.runId)
      this.stmt('delete from harness_run_leases where run_id = ?').run(validated.runId)
      return deepFreeze({ created: true, snapshot: deepFreeze(snapshot) })
    }))
  }

  public async getWait(waitId: string): Promise<ExternalWaitSnapshot | undefined> {
    const validatedWaitId = validateExternalWaitId(waitId)
    return this.transaction(() => this.expireExternalWait(this.loadExternalWait(validatedWaitId)))
  }

  public async signalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult> {
    const validated = validateExternalWaitSignal(signal)
    return this.storageSpan('signal_wait', {
      'harness.wait.outcome': validated.outcome
    }, async () => this.resolveExternalWait(validated))
  }

  public async cancelWait(waitId: string, eventId: string, observedAt?: string): Promise<ExternalWaitSignalResult> {
    return this.resolveExternalWait(createExternalWaitCancellation(waitId, eventId, observedAt))
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
      create table if not exists harness_sessions(id text primary key, instance_id text not null, created_at text not null, updated_at text not null, run_count integer not null, identity_json text, sandbox_binding_json text, metadata_json text);
      create table if not exists harness_messages(id text primary key, session_id text not null, role text not null, content text not null, tool_calls_json text, tool_results_json text, timestamp text not null, message_order integer not null);
      create unique index if not exists idx_harness_messages_session_order on harness_messages(session_id, message_order);
      create table if not exists harness_runs(id text primary key, session_id text not null, kind text not null, target text not null, started_at text not null, finished_at text, status text not null, revision integer not null, input_json text not null, validated_input_json text, output_json text, error_json text, approval_receipt_json text, attempt integer, worker_id text, initial_step_id text, metadata_json text, constraint harness_runs_validated_input_kind check ((kind in ('agent', 'workflow') and validated_input_json is not null) or (kind = 'child_task' and validated_input_json is null)));
      create index if not exists idx_harness_runs_session_order on harness_runs(session_id, started_at, id);
      create table if not exists harness_run_events(id text primary key, sequence integer not null, run_id text not null, at text not null, type text not null, payload_json text not null, unique(run_id, sequence));
      create index if not exists idx_harness_run_events_run_order on harness_run_events(run_id, sequence);
      create table if not exists harness_run_checkpoints(run_id text not null, session_id text not null, lease_id text not null, worker_id text not null, step_id text not null, input_json text not null, attempt integer not null, sequence integer not null, output_json text, replay_json text, metadata_json text, committed_at text not null, primary key(run_id, step_id));
      create index if not exists idx_harness_run_checkpoints_order on harness_run_checkpoints(run_id, sequence);
      create table if not exists harness_run_leases(run_id text primary key, session_id text not null, worker_id text not null, acquisition_id text not null unique, request_json text not null, acquired_revision integer not null, lease_id text not null, expires_at text not null);
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
      if (!columns.has('attempt') || !columns.has('initial_step_id') || !columns.has('revision')
        || !columns.has('approval_receipt_json') || !columns.has('validated_input_json')
        || !this.hasValidatedInputKindSemantics()) legacyTables.push('harness_runs')
    }
    for (const [table, required] of [['harness_run_events', ['sequence']], ['harness_run_leases', ['acquisition_id', 'request_json', 'acquired_revision']]] as const) {
      const exists = this.db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(table)
      if (exists) {
        const columns = new Set(this.db.prepare(`pragma table_info(${table})`).all().map(row => row['name']))
        if (required.some(column => !columns.has(column))) legacyTables.push(table)
      }
    }
    const sessionsTable = this.db.prepare("select name from sqlite_master where type = 'table' and name = 'harness_sessions'").get()
    if (sessionsTable) {
      const columns = new Set(this.db.prepare('pragma table_info(harness_sessions)').all().map((row) => row['name']))
      if (!columns.has('identity_json') || !columns.has('instance_id') || !columns.has('sandbox_binding_json')) legacyTables.push('harness_sessions')
    }
    const messagesTable = this.db.prepare("select name from sqlite_master where type = 'table' and name = 'harness_messages'").get()
    if (messagesTable) {
      const columns = new Map(this.db.prepare('pragma table_info(harness_messages)').all().map(row => [row['name'], row]))
      const messageOrder = columns.get('message_order')
      const indexes = this.db.prepare('pragma index_list(harness_messages)').all()
      const hasOrderIndex = indexes.some((index) => {
        if (index['unique'] !== 1 || index['partial'] !== 0 || typeof index['name'] !== 'string') return false
        const name = index['name'].replaceAll('"', '""')
        const columns = this.db.prepare(`pragma index_info("${name}")`).all()
        return columns.length === 2 && columns[0]?.['name'] === 'session_id' && columns[1]?.['name'] === 'message_order'
      })
      if (!messageOrder || typeof messageOrder['type'] !== 'string' || messageOrder['type'].toUpperCase() !== 'INTEGER'
        || messageOrder['notnull'] !== 1 || !hasOrderIndex) {
        legacyTables.push('harness_messages')
      }
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

  private nextMessageOrder(sessionId: string): number {
    const row = this.stmt('select coalesce(max(message_order), 0) + 1 as next_order from harness_messages where session_id = ?').get(sessionId)
    return requiredNumber(row!, 'next_order', 'appendMessages')
  }

  private hasValidatedInputKindSemantics(): boolean {
    const insert = this.db.prepare(`insert into harness_runs
      (id, session_id, kind, target, started_at, status, revision, input_json, validated_input_json)
      values (?, 'schema-probe-session', ?, 'schemaProbe', '2026-01-01T00:00:00.000Z', 'running', 1, 'null', ?)`)
    this.db.exec('savepoint harness_validated_input_probe')
    try {
      insert.run('schema-probe-agent-valid', 'agent', 'null')
      insert.run('schema-probe-workflow-valid', 'workflow', 'null')
      insert.run('schema-probe-child-valid', 'child_task', null)
      for (const [id, kind, validatedInput] of [
        ['schema-probe-agent-invalid', 'agent', null],
        ['schema-probe-workflow-invalid', 'workflow', null],
        ['schema-probe-child-invalid', 'child_task', 'null'],
      ] as const) {
        let rejected = false
        try { insert.run(id, kind, validatedInput) } catch { rejected = true }
        if (!rejected) return false
      }
      return true
    } catch {
      return false
    } finally {
      this.db.exec('rollback to harness_validated_input_probe')
      this.db.exec('release harness_validated_input_probe')
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
    const status = requiredString(row, 'status', 'getRun')
    return deepFreeze(validateExternalWaitSnapshot({
      waitId: requiredString(row, 'wait_id', 'getRun'),
      kind: requiredString(row, 'kind', 'getRun'),
      schemaVersion: requiredString(row, 'schema_version', 'getRun'),
      definitionVersion: requiredString(row, 'definition_version', 'getRun'),
      deadline: requiredString(row, 'deadline', 'getRun'),
      status,
      createdAt: requiredString(row, 'created_at', 'getRun'),
      ...optional('resolvedAt', typeof row['resolved_at'] === 'string' ? row['resolved_at'] : undefined),
      ...optional('eventId', typeof row['event_id'] === 'string' ? row['event_id'] : undefined)
    }))
  }

  private expireExternalWait(snapshot: ExternalWaitSnapshot | undefined): ExternalWaitSnapshot | undefined {
    if (!snapshot || snapshot.status !== 'waiting' || Date.parse(snapshot.deadline) > this.clock()) return snapshot
    const expired = validateExternalWaitSnapshot({
      waitId: snapshot.waitId,
      kind: snapshot.kind,
      schemaVersion: snapshot.schemaVersion,
      definitionVersion: snapshot.definitionVersion,
      deadline: snapshot.deadline,
      status: 'expired',
      createdAt: snapshot.createdAt,
      resolvedAt: this.nowIso()
    })
    const resolved = asExternalWaitResolved(expired)
    if (!resolved) throw new ExternalWaitError('External wait adapter returned an invalid snapshot.', 'invalid_snapshot')
    this.stmt('update harness_external_waits set status = ?, resolved_at = ? where wait_id = ?').run(resolved.status, resolved.resolvedAt, resolved.waitId)
    return deepFreeze(resolved)
  }

  private async resolveExternalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult> {
    return this.transaction(() => {
      const snapshot = this.expireExternalWait(this.loadExternalWait(signal.waitId))
      if (!snapshot) return deepFreeze(validateExternalWaitSignalResult({ kind: 'not_found' }))
      const duplicate = this.stmt('select event_id from harness_external_wait_signals where wait_id = ? and event_id = ?').get(signal.waitId, signal.eventId)
      if (duplicate) return deepFreeze(validateExternalWaitSignalResult({ kind: 'duplicate', snapshot }))
      this.stmt('insert into harness_external_wait_signals(wait_id, event_id) values(?, ?)').run(signal.waitId, signal.eventId)
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
        eventId: signal.eventId
      })
      const terminal = asExternalWaitResolved(resolved)
      if (!terminal) throw new ExternalWaitError('External wait adapter returned an invalid snapshot.', 'invalid_snapshot')
      this.stmt('update harness_external_waits set status = ?, resolved_at = ?, event_id = ? where wait_id = ?')
        .run(terminal.status, terminal.resolvedAt, signal.eventId, signal.waitId)
      return deepFreeze(validateExternalWaitSignalResult({ kind: 'applied', snapshot: terminal }))
    })
  }

  private assertLeaseAvailable(runId: string, sessionId: string): void {
    const nowIso = this.nowIso()
    // Scoped expiry: only clear stale leases for the contested run/session so
    // an unrelated long-running lease is never deleted by another start.
    this.stmt('delete from harness_run_leases where run_id = ? and expires_at <= ?').run(runId, nowIso)
    this.stmt('delete from harness_run_leases where session_id = ? and expires_at <= ?').run(sessionId, nowIso)
    const runLease = this.stmt('select * from harness_run_leases where run_id = ?').get(runId)
    if (runLease) throw leaseConflict()
    const sessionLease = this.stmt('select * from harness_run_leases where session_id = ? and run_id != ?').get(sessionId, runId)
    if (sessionLease) throw leaseConflict()
  }

  private toLease(request: AcquireRunRequest, leaseId: string): DurableRunLease {
    const run = this.loadRun(request.runId)
    if (!run) throw new DurableRunLeaseError(`Durable run "${request.runId}" has not been started.`)
    const checkpoints = this.stmt('select * from harness_run_checkpoints where run_id = ? order by sequence asc').all(request.runId).map((row) => this.rowToCheckpoint(row))
    const selected = checkpoints.find(checkpoint => checkpoint.stepId === request.expected.checkpoint.stepId)
    return Object.freeze({
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
        await this.transaction(() => {
          const deleted = this.stmt('select * from harness_run_leases where run_id = ? and session_id = ? and worker_id = ? and lease_id = ? and acquisition_id = ? and expires_at > ?')
            .get(request.runId, request.sessionId, request.workerId, leaseId, request.acquisitionId, this.nowIso())
          if (!deleted) return
          this.stmt('delete from harness_run_leases where run_id = ? and session_id = ? and worker_id = ? and lease_id = ? and acquisition_id = ?')
            .run(request.runId, request.sessionId, request.workerId, leaseId, request.acquisitionId)
          this.stmt('update harness_runs set status = ?, revision = revision + 1 where id = ? and status = ?').run('interrupted', request.runId, 'running')
        })
      }
    })
  }

  private rowToSession(row: SqlRow): SessionRecord {
    const sandboxBinding = parseJson<SessionRecord['sandboxBinding']>(row['sandbox_binding_json'])
    assertSessionSandboxBindingTransition(sandboxBinding, sandboxBinding, 'getSession')
    return deepFreeze({
      id: requiredString(row, 'id', 'getSession'),
      instanceId: requiredString(row, 'instance_id', 'getSession'),
      createdAt: requiredString(row, 'created_at', 'getSession'),
      updatedAt: requiredString(row, 'updated_at', 'getSession'),
      runCount: requiredNumber(row, 'run_count', 'getSession'),
      ...optional('identity', parseJson<SessionRecord['identity']>(row['identity_json'])),
      ...optional('sandboxBinding', sandboxBinding),
      ...optional('metadata', parseJson<Record<string, JsonValue>>(row['metadata_json']))
    })
  }

  private rowToMessage(row: SqlRow): Message {
    const toolCalls = parseJson<Message['toolCalls']>(row['tool_calls_json'])
    const toolResults = parseJson<Message['toolResults']>(row['tool_results_json'])
    return deepFreeze({
      id: requiredString(row, 'id', 'listMessages'),
      sessionId: requiredString(row, 'session_id', 'listMessages'),
      role: requiredString(row, 'role', 'listMessages') as Message['role'],
      content: requiredString(row, 'content', 'listMessages'),
      ...optional('toolCalls', toolCalls),
      ...optional('toolResults', toolResults),
      timestamp: requiredString(row, 'timestamp', 'listMessages')
    })
  }

  private rowToRun(row: SqlRow): RunRecord {
    const output = parseJson<JsonValue>(row['output_json'])
    const error = parseJson<SerializedError>(row['error_json'])
    const input = parseJson<JsonValue>(row['input_json'])
    const kind = requiredString(row, 'kind', 'getRun') as RunRecord['kind']
    const validatedInput = parseJson<JsonValue>(row['validated_input_json'])
    if (input === undefined) throw new StateError('SQLite run input is invalid.', { op: 'getRun', reason: 'invalid_record' })
    if (kind === 'child_task' ? row['validated_input_json'] !== null : validatedInput === undefined) {
      throw new StateError('SQLite validated run input is invalid.', { op: 'getRun', reason: 'invalid_record' })
    }
    const record = {
      id: requiredString(row, 'id', 'getRun'),
      sessionId: requiredString(row, 'session_id', 'getRun'),
      kind,
      target: requiredString(row, 'target', 'getRun'),
      startedAt: requiredString(row, 'started_at', 'getRun'),
      ...(row['finished_at'] ? { finishedAt: requiredString(row, 'finished_at', 'getRun') } : {}),
      status: requiredString(row, 'status', 'getRun') as RunRecord['status'],
      revision: requiredNumber(row, 'revision', 'getRun'),
      input,
      ...(kind === 'child_task' ? {} : { validatedInput }),
      ...optional('output', output),
      ...optional('error', error),
      ...optional('approvalReceipt', parseJson<RunRecord['approvalReceipt']>(row['approval_receipt_json'])),
      ...optional('attempt', typeof row['attempt'] === 'number' ? row['attempt'] : undefined),
      ...optional('workerId', typeof row['worker_id'] === 'string' ? row['worker_id'] : undefined),
      ...optional('initialStepId', typeof row['initial_step_id'] === 'string' ? row['initial_step_id'] : undefined),
      ...optional('metadata', parseJson<Record<string, JsonValue>>(row['metadata_json']))
    } as RunRecord
    assertStoredRunRecord(record, () => new StateError('SQLite run record is invalid.', { op: 'getRun', reason: 'invalid_record' }))
    return deepFreeze(record)
  }

  private rowToEvent(row: SqlRow): PersistedRunEvent {
    return deepFreeze({
      id: requiredString(row, 'id', 'listEvents'), sequence: requiredNumber(row, 'sequence', 'listEvents'),
      runId: requiredString(row, 'run_id', 'listEvents'), at: requiredString(row, 'at', 'listEvents'),
      type: requiredString(row, 'type', 'listEvents') as PersistedRunEvent['type'],
      payload: parseJson<JsonValue>(row['payload_json']) ?? null,
    })
  }

  private rowToCheckpoint(row: SqlRow): RunCheckpoint {
    const output = parseJson<JsonValue>(row['output_json'])
    const replay = parseJson<DurableReplayCheckpoint>(row['replay_json'])
    const metadata = parseJson<Record<string, JsonValue>>(row['metadata_json'])
    return deepFreeze({
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
    })
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

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
function normalizeCreateRunRequest(value: CreateRunRequest): CreateRunRequest {
  if (!plain(value) || !exactKeys(value, ['id', 'sessionId', 'kind', 'target', 'startedAt', 'input', 'validatedInput', 'metadata'])) throw runConflict()
  try { canonicalJson(value) } catch { throw runConflict() }
  if (!validId(value.id) || !validId(value.sessionId) || !validId(value.target) || !['agent', 'workflow', 'child_task'].includes(value.kind)
    || (value.kind === 'child_task' ? Object.hasOwn(value, 'validatedInput') : !Object.hasOwn(value, 'validatedInput'))
    || !validTimestamp(value.startedAt) || (Object.hasOwn(value, 'metadata') && value.metadata === undefined)
    || (value.metadata !== undefined && !plain(value.metadata))) throw runConflict()
  return deepFreeze(structuredClone(value))
}
function normalizeAcquireRunRequest(value: AcquireRunRequest): AcquireRunRequest {
  if (!plain(value) || !exactKeys(value, ['mode', 'runId', 'sessionId', 'workerId', 'acquisitionId', 'expected', 'requestedAttempt'])
    || !['initial', 'resume'].includes(value.mode) || !validId(value.runId) || !validId(value.sessionId) || !validId(value.workerId)
    || !/^acq_[a-f0-9]{64}$/.test(value.acquisitionId) || !plain(value.expected) || !exactKeys(value.expected, ['revision', 'status', 'checkpoint'])
    || !positive(value.expected.revision) || !['running', 'waiting', 'interrupted'].includes(value.expected.status)
    || !plain(value.expected.checkpoint) || !exactKeys(value.expected.checkpoint, ['stepId', 'sequence']) || !validId(value.expected.checkpoint.stepId)
    || (value.expected.checkpoint.sequence !== null && !positive(value.expected.checkpoint.sequence))
    || (Object.hasOwn(value, 'requestedAttempt') && value.requestedAttempt === undefined)
    || (value.requestedAttempt !== undefined && !positive(value.requestedAttempt))) throw acquisitionConflict()
  const id = `acq_${createHash('sha256').update(canonicalJson(['harness-run-acquisition-v1', value.mode, value.runId, value.sessionId, value.workerId,
    value.expected.revision, value.expected.status, value.expected.checkpoint.stepId, value.expected.checkpoint.sequence, value.requestedAttempt ?? null])).digest('hex')}`
  if (id !== value.acquisitionId) throw acquisitionConflict()
  return deepFreeze(structuredClone(value))
}
function normalizePersistedEvent<Event extends PersistedRunEvent>(value: Event, runId: string, op: 'appendEvents' | 'finalizeRun' = 'appendEvents'): Event {
  if (!plain(value) || !exactKeys(value, ['id', 'sequence', 'runId', 'at', 'type', 'payload']) || value.runId !== runId || !positive(value.sequence)
    || !validTimestamp(value.at) || !harnessExecutionEventTypesV1.includes(value.type)
    || value.id !== `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', value.runId, value.sequence, value.type])).digest('hex')}`) {
    throw new StateError('Run event is invalid.', { op, reason: 'event_conflict' })
  }
  try { canonicalJson(value.payload) } catch { throw new StateError('Run event is invalid.', { op, reason: 'event_conflict' }) }
  return deepFreeze(structuredClone(value))
}

function normalizeReplaceCheckpointRequest(value: ReplaceCheckpointRequest): ReplaceCheckpointRequest {
  if (!plain(value) || !exactKeys(value, ['runId', 'sessionId', 'stepId', 'expectedSequence', 'leaseId', 'workerId', 'replacement'])
    || !validId(value.runId) || !validId(value.sessionId) || !validId(value.stepId) || !positive(value.expectedSequence)
    || !validId(value.leaseId) || !validId(value.workerId) || !plain(value.replacement)
    || !exactKeys(value.replacement, ['runId', 'sessionId', 'leaseId', 'workerId', 'stepId', 'input', 'attempt', 'sequence', 'output', 'replay', 'metadata', 'committedAt'])
    || value.replacement.runId !== value.runId || value.replacement.sessionId !== value.sessionId
    || value.replacement.stepId !== value.stepId || value.replacement.leaseId !== value.leaseId
    || value.replacement.workerId !== value.workerId || !positive(value.replacement.attempt)
    || value.replacement.sequence <= value.expectedSequence
    || (value.replacement.output === undefined && Object.prototype.hasOwnProperty.call(value.replacement, 'output'))
    || (value.replacement.replay === undefined && Object.prototype.hasOwnProperty.call(value.replacement, 'replay'))
    || (value.replacement.metadata === undefined && Object.prototype.hasOwnProperty.call(value.replacement, 'metadata'))
    || (value.replacement.committedAt === undefined && Object.prototype.hasOwnProperty.call(value.replacement, 'committedAt'))
    || (value.replacement.metadata !== undefined && !plain(value.replacement.metadata))
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
  if (!plain(value) || !exactKeys(value, ['runId', 'sessionId', 'leaseId', 'workerId', 'patch', 'terminalEvent', 'checkpointDisposition'])
    || !validId(value.runId) || !validId(value.sessionId) || !validId(value.leaseId) || !validId(value.workerId)
    || value.checkpointDisposition !== 'delete-all' || !plain(value.patch)) throw finalizeConflict('run_conflict')
  const patch = value.patch
  if (!exactKeys(patch, ['status', 'finishedAt', 'output', 'error', 'approvalReceipt']) || !validTimestamp(patch.finishedAt)) throw finalizeConflict('run_conflict')
  if (Object.prototype.hasOwnProperty.call(patch, 'approvalReceipt') && patch.approvalReceipt === undefined) throw finalizeConflict('run_conflict')
  if (patch.status === 'succeeded') {
    if (!Object.prototype.hasOwnProperty.call(patch, 'output') || Object.prototype.hasOwnProperty.call(patch, 'error')) throw finalizeConflict('run_conflict')
    try { canonicalJson(patch.output) } catch { throw finalizeConflict('run_conflict') }
  } else if (patch.status === 'failed' || patch.status === 'cancelled') {
    if (Object.prototype.hasOwnProperty.call(patch, 'output') || !validSerializedError(patch.error)) throw finalizeConflict('run_conflict')
  } else throw finalizeConflict('run_conflict')
  if (patch.approvalReceipt !== undefined) validateApprovalReceipt(patch.approvalReceipt)
  const terminalEvent = normalizePersistedEvent(value.terminalEvent, value.runId, 'finalizeRun')
  return deepFreeze(structuredClone({ ...value, terminalEvent }))
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
  const hasParentRunId = Object.prototype.hasOwnProperty.call(event.payload, 'parentRunId')
  const hasParentInvocationId = Object.prototype.hasOwnProperty.call(event.payload, 'parentInvocationId')
  if (hasParentRunId !== hasParentInvocationId
    || (hasParentRunId && (!validId(event.payload['parentRunId']) || !validId(event.payload['parentInvocationId'])))) return false
  const outcome = event.payload['outcome']
  if (patch.status === 'succeeded') {
    return exactKeys(outcome, ['status']) && outcome['status'] === 'completed'
  }
  return exactKeys(outcome, ['status', 'error']) && Object.prototype.hasOwnProperty.call(outcome, 'error')
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

function validSerializedError(value: unknown): boolean {
  if (!plain(value) || !exactKeys(value, ['code', 'message', 'category', 'retriable', 'meta'])
    || typeof value['code'] !== 'string' || value['code'].length === 0 || typeof value['message'] !== 'string'
    || (value['category'] !== undefined && typeof value['category'] !== 'string')
    || (value['retriable'] !== undefined && typeof value['retriable'] !== 'boolean')
    || (value['meta'] !== undefined && !plain(value['meta']))) return false
  try { canonicalJson(value) } catch { return false }
  return true
}
function runCreationBytes(value: CreateRunRequest | RunRecord): string {
  return canonicalJson(['harness-run-create-v1', value.id, value.sessionId, value.kind, value.target, value.startedAt, value.input,
    Object.prototype.hasOwnProperty.call(value, 'validatedInput'), value.kind === 'child_task' ? null : value.validatedInput,
    Object.prototype.hasOwnProperty.call(value, 'metadata'), value.metadata ?? null])
}
function runConflict(): StateError { return new StateError('Run creation conflicts with an existing logical run.', { op: 'createRun', reason: 'run_conflict' }) }
function leaseConflict(): StateError { return new StateError('Run or session lease is already held.', { op: 'acquireRun', reason: 'lease_conflict' }) }
function eventSequenceConflict(): StateError { return new StateError('Run event sequence is not contiguous.', { op: 'appendEvents', reason: 'event_sequence_conflict' }) }
function commitCheckpointConflict(): StateError { return new StateError('Durable checkpoint conflicts with the installed record.', { op: 'commitCheckpoint', reason: 'checkpoint_conflict' }) }
function finishRunConflict(): StateError { return new StateError('Run transition is invalid.', { op: 'finishRun', reason: 'run_conflict' }) }
function acquisitionConflict(): StateError { return new StateError('Run acquisition conflicts with the observed state.', { op: 'acquireRun', reason: 'acquisition_conflict' }) }
function checkpointConflict(): StateError { return new StateError('Checkpoint replacement conflicts with stored state.', { op: 'replaceCheckpoint', reason: 'checkpoint_conflict' }) }
function finalizeConflict(reason: 'run_conflict' | 'run_not_found' | 'lease_conflict' | 'event_conflict'): StateError {
  return new StateError('Run finalization conflicts with stored state.', { op: 'finalizeRun', reason })
}
function isTerminal(status: RunStatus): boolean { return status === 'succeeded' || status === 'failed' || status === 'cancelled' }
function validId(value: unknown): value is string { return typeof value === 'string' && identifier.test(value) }
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && timestamp.test(value) && new Date(value).toISOString() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) }
function exactKeys(value: object, keys: readonly string[]): boolean { return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)) }
function deepFreeze<T>(value: T): T { if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value) } return value }

/** Creates the zero-dependency local SQLite Harness storage. */
export function sqliteHarnessStorage(options: SqliteHarnessStorageOptions): HarnessStorage & { close(): Promise<void> } {
  return new SqliteHarnessStorage(options)
}
