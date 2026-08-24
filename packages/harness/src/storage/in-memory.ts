import { StateError } from '../errors/index.js'
import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import type { BoundExternalWaitRequest, FinishRunPatch, HarnessStorage } from '../storage/types.js'
import {
  ExternalWaitError,
  validateExternalWaitRequest,
  type ExternalWaitRegistration,
  type ExternalWaitSignal,
  type ExternalWaitSignalResult,
  type ExternalWaitSnapshot
} from '../storage/external-wait.js'
import {
  DurableRunLeaseError,
  DurableTerminalRunError,
  type DurableRunLease,
  type DurableRunStart,
  type RunCheckpoint
} from './execution.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'

class Mutex {
  private current = Promise.resolve()

  public async lock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.current
    let release: (() => void) | undefined
    this.current = new Promise<void>((resolve) => { release = resolve })
    await prev
    try {
      return await fn()
    } finally {
      release?.()
    }
  }
}

/**
 * In-process Harness storage for local development and tests.
 */
export class InMemoryHarnessStorage implements HarnessStorage {
  public readonly capabilities = [
    'storage.checkpoint',
    'storage.retry',
    'storage.resume',
    'storage.workspace_checkpoint',
    'storage.external_wait'
  ] as const
  public readonly info = {
    id: 'in_memory',
    packageName: '@purista/harness',
    capabilities: this.capabilities
  } as const

  private readonly sessions = new Map<string, SessionRecord>()
  private readonly messages = new Map<string, Message[]>()
  private readonly runs = new Map<string, RunRecord>()
  private readonly events = new Map<string, PersistedRunEvent[]>()
  private readonly messageLocks = new Map<string, Mutex>()
  private readonly sessionLocks = new Map<string, Mutex>()
  private readonly checkpoints = new Map<string, Map<string, RunCheckpoint>>()
  private readonly runLeases = new Map<string, { leaseId: string; sessionId: string; workerId: string }>()
  private readonly sessionLeases = new Map<string, { leaseId: string; runId: string; workerId: string }>()
  private readonly waits = new Map<string, ExternalWaitSnapshot & { runId: string; sessionId: string }>()
  private readonly waitSignals = new Map<string, Set<string>>()
  private leaseCounter = 0
  private checkpointCommitCount = 0
  private telemetry: HarnessAdapterContext['telemetry'] | undefined

  public constructor(private readonly options: { now?: () => Date; failAfterCheckpoint?: number } = {}) {}

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.telemetry = context.telemetry
  }

  public async getSession(id: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(id)
  }

  public async upsertSession(record: SessionRecord): Promise<void> {
    this.sessions.set(record.id, record)
  }

  public async closeSession(id: string): Promise<void> {
    this.sessions.delete(id)
    this.messages.delete(id)
    this.messageLocks.delete(id)
    for (const [runId, run] of this.runs) {
      if (run.sessionId === id) {
        this.runs.delete(runId)
        this.events.delete(runId)
        this.checkpoints.delete(runId)
        this.runLeases.delete(runId)
      }
    }
    this.sessionLeases.delete(id)
    this.sessionLocks.delete(id)
    for (const [waitId, wait] of this.waits) {
      if (wait.sessionId === id) {
        this.waits.delete(waitId)
        this.waitSignals.delete(waitId)
      }
    }
  }

  public async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    return this.withMessageLock(sessionId, 'appendMessages', async () => {
      const current = this.messages.get(sessionId) ?? []
      const ids = new Set(current.map((msg) => msg.id))
      for (const message of messages) {
        if (ids.has(message.id)) {
          throw new StateError('Duplicate message id.', { op: 'appendMessages', reason: 'duplicate_message_id' })
        }
        ids.add(message.id)
      }
      this.messages.set(sessionId, [...current, ...messages])
    })
  }

  public async listMessages(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<Message[]> {
    let rows = [...(this.messages.get(sessionId) ?? [])]
      .sort((a, b) => a.timestamp === b.timestamp ? a.id.localeCompare(b.id) : a.timestamp.localeCompare(b.timestamp))

    if (opts.before) {
      const beforeIndex = rows.findIndex((row) => row.id === opts.before)
      if (beforeIndex >= 0) {
        rows = rows.slice(0, beforeIndex)
      }
    }

    if (opts.limit !== undefined) {
      rows = rows.slice(Math.max(0, rows.length - opts.limit))
    }

    return rows
  }

  public async clearMessages(sessionId: string): Promise<void> {
    return this.withMessageLock(sessionId, 'clearMessages', async () => {
      this.messages.delete(sessionId)
    })
  }

  public async replaceMessages(sessionId: string, messages: Message[]): Promise<void> {
    return this.withMessageLock(sessionId, 'replaceMessages', async () => {
      const ids = new Set<string>()
      for (const message of messages) {
        if (ids.has(message.id)) {
          throw new StateError('Duplicate message id.', { op: 'replaceMessages', reason: 'duplicate_message_id' })
        }
        ids.add(message.id)
      }
      // Atomic clear+append under one lock: validate first, then commit so a
      // failure never leaves history partially replaced.
      this.messages.set(sessionId, [...messages])
    })
  }

  public async createRun(record: RunRecord): Promise<void> {
    this.runs.set(record.id, record)
  }

  public async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    return this.storageSpan('finish_run', { 'harness.run.id': runId, 'harness.run.status': patch.status }, async () => {
      const run = this.runs.get(runId)
      if (!run) return
      this.runs.set(runId, { ...run, ...patch })
      if (patch.status !== 'running') this.releaseRunLease(runId)
    })
  }

  public async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId)
  }

  public async listRuns(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<RunRecord[]> {
    let rows = [...this.runs.values()]
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => a.startedAt === b.startedAt ? b.id.localeCompare(a.id) : b.startedAt.localeCompare(a.startedAt))

    if (opts.before) {
      const beforeIndex = rows.findIndex((row) => row.id === opts.before)
      if (beforeIndex >= 0) {
        rows = rows.slice(beforeIndex + 1)
      }
    }

    if (opts.limit !== undefined) {
      rows = rows.slice(0, opts.limit)
    }

    return rows
  }

  public async appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    const current = this.events.get(runId) ?? []
    this.events.set(runId, [...current, ...events])
  }

  public async listEvents(runId: string, opts: { limit?: number; after?: string } = {}): Promise<PersistedRunEvent[]> {
    let rows = [...(this.events.get(runId) ?? [])]

    if (opts.after) {
      const afterIndex = rows.findIndex((row) => row.id === opts.after)
      if (afterIndex >= 0) {
        rows = rows.slice(afterIndex + 1)
      }
    }

    if (opts.limit !== undefined) {
      rows = rows.slice(0, opts.limit)
    }

    return rows
  }

  public async acquireRun(record: DurableRunStart): Promise<DurableRunLease> {
    return this.storageSpan('acquire_run', { 'harness.run.id': record.runId }, () => this.withSessionLock(record.sessionId, async () => {
      const run = this.runs.get(record.runId)
      if (!run) throw new StateError('Durable run must be created before acquisition.', { op: 'createRun', reason: 'run_not_found' })
      if (run.sessionId !== record.sessionId) throw new DurableRunLeaseError(`Durable run "${record.runId}" belongs to another session.`)
      if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
        throw new DurableTerminalRunError(record.runId, run.status)
      }
      const activeRun = this.runLeases.get(record.runId)
      if (activeRun) throw new DurableRunLeaseError(`Durable run "${record.runId}" is already leased.`)
      const activeSession = this.sessionLeases.get(record.sessionId)
      if (activeSession) throw new DurableRunLeaseError(`Durable session "${record.sessionId}" is already leased.`)

      const attempt = run.attempt === undefined ? Math.max(1, record.attempt ?? 1) : run.attempt + 1
      const updated: RunRecord = {
        ...run,
        status: 'running',
        attempt,
        workerId: record.workerId,
        initialStepId: run.initialStepId ?? record.stepId,
        ...((run.metadata ?? record.metadata) ? { metadata: run.metadata ?? record.metadata } : {})
      }
      delete updated.finishedAt
      delete updated.output
      delete updated.error
      this.runs.set(record.runId, updated)

      const leaseId = `lease-${++this.leaseCounter}`
      this.runLeases.set(record.runId, { leaseId, sessionId: record.sessionId, workerId: record.workerId })
      this.sessionLeases.set(record.sessionId, { leaseId, runId: record.runId, workerId: record.workerId })
      const committed = [...(this.checkpoints.get(record.runId)?.values() ?? [])].sort((a, b) => a.sequence - b.sequence)
      const checkpoint = committed.at(-1)
      return {
        runId: record.runId,
        sessionId: record.sessionId,
        workerId: record.workerId,
        leaseId,
        attempt,
        resumed: committed.length > 0 || run.status === 'waiting' || run.status === 'interrupted',
        start: {
          ...record,
          stepId: updated.initialStepId ?? record.stepId,
          input: updated.input ?? null,
          attempt,
          ...(updated.metadata ? { metadata: updated.metadata } : {})
        },
        ...(checkpoint ? { checkpoint } : {}),
        checkpoints: committed,
        release: async () => {
          await this.withSessionLock(record.sessionId, async () => {
            const active = this.runLeases.get(record.runId)
            if (active?.leaseId !== leaseId) return
            this.releaseRunLease(record.runId)
            const current = this.runs.get(record.runId)
            if (current?.status === 'running') this.runs.set(record.runId, { ...current, status: 'interrupted' })
          })
        }
      }
    }))
  }

  public async loadCheckpoint(runId: string): Promise<RunCheckpoint | undefined> {
    return this.storageSpan('load_checkpoint', { 'harness.run.id': runId }, async () => (
      [...(this.checkpoints.get(runId)?.values() ?? [])].sort((a, b) => a.sequence - b.sequence).at(-1)
    ))
  }

  public async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    await this.storageSpan('commit_checkpoint', {
      'harness.run.id': checkpoint.runId,
      'harness.storage.sequence': checkpoint.sequence
    }, () => this.withSessionLock(checkpoint.sessionId, async () => {
      const lease = this.runLeases.get(checkpoint.runId)
      if (!lease || lease.leaseId !== checkpoint.leaseId || lease.workerId !== checkpoint.workerId) {
        throw new DurableRunLeaseError(`Durable run "${checkpoint.runId}" is not owned by this lease.`)
      }
      const run = this.runs.get(checkpoint.runId)
      if (!run || run.status !== 'running') throw new DurableRunLeaseError(`Durable run "${checkpoint.runId}" is not running.`)
      const checkpoints = this.checkpoints.get(checkpoint.runId) ?? new Map<string, RunCheckpoint>()
      const existing = checkpoints.get(checkpoint.stepId)
      if (existing && JSON.stringify(existing.output) !== JSON.stringify(checkpoint.output)) {
        throw new StateError('Durable checkpoint step already has a different output.', { op: 'finishRun', reason: 'checkpoint_conflict' })
      }
      checkpoints.set(checkpoint.stepId, { ...checkpoint, committedAt: checkpoint.committedAt ?? this.now().toISOString() })
      this.checkpoints.set(checkpoint.runId, checkpoints)
      this.checkpointCommitCount += 1
      if (this.options.failAfterCheckpoint === this.checkpointCommitCount) {
        this.releaseRunLease(checkpoint.runId)
        this.runs.set(checkpoint.runId, { ...run, status: 'interrupted' })
        throw new Error(`Injected Harness storage failure after checkpoint ${this.checkpointCommitCount}.`)
      }
    }))
  }

  public async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.sessionLocks.get(sessionId)
    if (!lock) {
      lock = new Mutex()
      this.sessionLocks.set(sessionId, lock)
    }
    return lock.lock(fn)
  }

  public async registerWait(request: BoundExternalWaitRequest): Promise<ExternalWaitRegistration> {
    validateExternalWaitRequest(request)
    return this.storageSpan('register_wait', {
      'harness.run.id': request.runId,
      'harness.wait.kind': request.kind
    }, () => this.withSessionLock(request.sessionId, async () => {
      const existing = this.expireWait(this.waits.get(request.waitId))
      if (existing) {
        if (!sameWait(existing, request)) throw new ExternalWaitError('External wait id is already bound to a different request.', 'request_conflict')
        return { created: false, snapshot: externalSnapshot(existing) }
      }
      const run = this.runs.get(request.runId)
      if (!run || run.sessionId !== request.sessionId) throw new ExternalWaitError('External wait run binding is invalid.', 'invalid_request')
      if (run.status !== 'running') throw new ExternalWaitError('External waits can only suspend a running durable run.', 'durable_required')
      const stored = { ...request, status: 'waiting' as const, createdAt: this.now().toISOString() }
      this.waits.set(request.waitId, stored)
      this.waitSignals.set(request.waitId, new Set())
      this.runs.set(request.runId, { ...run, status: 'waiting' })
      this.releaseRunLease(request.runId)
      return { created: true, snapshot: externalSnapshot(stored) }
    }))
  }

  public async getWait(waitId: string): Promise<ExternalWaitSnapshot | undefined> {
    const wait = this.expireWait(this.waits.get(waitId))
    return wait ? externalSnapshot(wait) : undefined
  }

  public async signalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult> {
    return this.storageSpan('signal_wait', { 'harness.wait.outcome': signal.outcome }, async () => (
      this.resolveWait(signal.waitId, signal.eventId, signal.outcome, signal.observedAt)
    ))
  }

  public async cancelWait(waitId: string, eventId: string, observedAt?: string): Promise<ExternalWaitSignalResult> {
    return this.resolveWait(waitId, eventId, 'cancelled', observedAt)
  }

  public async close(): Promise<void> {
    this.sessions.clear()
    this.messages.clear()
    this.runs.clear()
    this.events.clear()
    this.messageLocks.clear()
    this.sessionLocks.clear()
    this.checkpoints.clear()
    this.runLeases.clear()
    this.sessionLeases.clear()
    this.waits.clear()
    this.waitSignals.clear()
  }

  private async withMessageLock<T>(sessionId: string, op: 'appendMessages' | 'clearMessages' | 'replaceMessages', fn: () => Promise<T>): Promise<T> {
    let lock = this.messageLocks.get(sessionId)
    if (!lock) {
      lock = new Mutex()
      this.messageLocks.set(sessionId, lock)
    }

    try {
      return await lock.lock(fn)
    } catch (error) {
      if (error instanceof StateError) throw error
      throw new StateError('Harness storage operation failed.', { op }, error)
    }
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private async storageSpan<T>(operation: string, attrs: Record<string, string | number | boolean>, fn: () => Promise<T>): Promise<T> {
    const attributes = {
      'harness.storage.adapter': this.info.id,
      'harness.storage.operation': operation,
      'harness.storage.persistent': false,
      ...attrs
    }
    if (!this.telemetry) return fn()
    const started = Date.now()
    return this.telemetry.span(`harness.storage.${operation}`, attributes, async () => {
      try {
        const result = await fn()
        this.telemetry?.recordCounter('harness.storage.operations', 1, attributes)
        return result
      } finally {
        this.telemetry?.recordHistogram('harness.storage.operation.duration', (Date.now() - started) / 1000, attributes)
      }
    })
  }

  private releaseRunLease(runId: string): void {
    const lease = this.runLeases.get(runId)
    if (!lease) return
    this.runLeases.delete(runId)
    const sessionLease = this.sessionLeases.get(lease.sessionId)
    if (sessionLease?.leaseId === lease.leaseId) this.sessionLeases.delete(lease.sessionId)
  }

  private resolveWait(waitId: string, eventId: string, outcome: 'approved' | 'rejected' | 'expired' | 'cancelled', observedAt?: string): ExternalWaitSignalResult {
    if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(eventId)) throw new ExternalWaitError('External wait eventId must be a bounded identifier.', 'invalid_request')
    const wait = this.expireWait(this.waits.get(waitId))
    if (!wait) return { kind: 'not_found' }
    const delivered = this.waitSignals.get(waitId) ?? new Set<string>()
    this.waitSignals.set(waitId, delivered)
    if (delivered.has(eventId)) return { kind: 'duplicate', snapshot: externalSnapshot(wait) }
    delivered.add(eventId)
    if (wait.status !== 'waiting') return { kind: 'already_terminal', snapshot: externalSnapshot(wait) }
    const resolved = { ...wait, status: outcome, resolvedAt: observedAt ?? this.now().toISOString(), eventId }
    this.waits.set(waitId, resolved)
    return { kind: 'applied', snapshot: externalSnapshot(resolved) }
  }

  private expireWait(wait: (ExternalWaitSnapshot & { runId: string; sessionId: string }) | undefined): (ExternalWaitSnapshot & { runId: string; sessionId: string }) | undefined {
    if (!wait || wait.status !== 'waiting' || Date.parse(wait.deadline) > this.now().getTime()) return wait
    const expired = { ...wait, status: 'expired' as const, resolvedAt: this.now().toISOString() }
    this.waits.set(wait.waitId, expired)
    return expired
  }
}

/** Creates the process-local default Harness storage used by tests and development. */
export function inMemoryHarnessStorage(options: { now?: () => Date; failAfterCheckpoint?: number } = {}): InMemoryHarnessStorage {
  return new InMemoryHarnessStorage(options)
}

function sameWait(existing: ExternalWaitSnapshot & { runId: string; sessionId: string }, request: BoundExternalWaitRequest): boolean {
  return existing.runId === request.runId
    && existing.sessionId === request.sessionId
    && existing.kind === request.kind
    && existing.schemaVersion === request.schemaVersion
    && existing.definitionVersion === request.definitionVersion
    && existing.deadline === request.deadline
}

function externalSnapshot(wait: ExternalWaitSnapshot & { runId: string; sessionId: string }): ExternalWaitSnapshot {
  const { runId: _runId, sessionId: _sessionId, ...snapshot } = wait
  return snapshot
}
