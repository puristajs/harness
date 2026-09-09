import { createHash } from 'node:crypto'

import { StateError } from '../errors/index.js'
import { sameHarnessIdentity } from '../identity/index.js'
import type { Message, PersistedFinalRunEvent, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import { harnessExecutionEventTypesV1 } from '../definitions/execution-events.js'
import { canonicalJson } from '../runtime/canonical-json.js'
import { assertSessionSandboxBindingTransition } from './session-binding.js'
import type { AcquireRunRequest, CreateRunRequest, FinalizeRunRequest, FinishRunPatch, HarnessStorage, ReplaceCheckpointRequest } from '../storage/types.js'
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
import {
  DurableRunLeaseError,
  DurableTerminalRunError,
  type DurableRunLease,
  type RunCheckpoint
} from './execution.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import { assertStoredRunRecord, normalizeFinishRunPatch, normalizeRunCheckpoint, sameInstalledRunCheckpoint } from './run-record-validation.js'

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
  private readonly runLeases = new Map<string, { leaseId: string; sessionId: string; workerId: string; acquisitionId: string; requestBytes: string; acquiredRevision: number }>()
  private readonly sessionLeases = new Map<string, { leaseId: string; runId: string; workerId: string }>()
  private readonly waits = new Map<string, StoredExternalWait>()
  private readonly waitSignals = new Map<string, Set<string>>()
  private leaseCounter = 0
  private checkpointCommitCount = 0
  private telemetry: HarnessAdapterContext['telemetry'] | undefined

  public constructor(private readonly options: { now?: () => Date; failAfterCheckpoint?: number } = {}) {}

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.telemetry = context.telemetry
  }

  public async getSession(id: string): Promise<SessionRecord | undefined> {
    const record = this.sessions.get(id)
    return record ? snapshotJson(record) : undefined
  }

  public async upsertSession(record: SessionRecord, mode: 'create' | 'update'): Promise<boolean> {
    if (mode !== 'create' && mode !== 'update') {
      throw new StateError('Session write mode is invalid.', { op: 'upsertSession', reason: 'invalid_session_write_mode' })
    }
    assertSessionSandboxBindingTransition(record.sandboxBinding, record.sandboxBinding, 'upsertSession')
    const existing = this.sessions.get(record.id)
    if (!existing && mode === 'update') {
      throw new StateError('Session instance is no longer active.', { op: 'upsertSession', reason: 'session_instance_mismatch' })
    }
    if (existing) {
      if (!sameHarnessIdentity(existing.identity, record.identity)) {
        throw new StateError('Session identity cannot be changed.', { op: 'upsertSession', reason: 'session_identity_mismatch' })
      }
      if (mode === 'create') return false
      if (existing.instanceId !== record.instanceId || existing.createdAt !== record.createdAt) {
        throw new StateError('Session instance is no longer active.', { op: 'upsertSession', reason: 'session_instance_mismatch' })
      }
      assertSessionSandboxBindingTransition(existing.sandboxBinding, record.sandboxBinding, 'upsertSession')
      if (record.updatedAt < existing.updatedAt || record.runCount < existing.runCount) return false
    }
    this.sessions.set(record.id, snapshotJson(record))
    return existing === undefined
  }

  public async closeSession(id: string, expectedInstanceId: string): Promise<void> {
    if (this.sessions.get(id)?.instanceId !== expectedInstanceId) return
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
      this.messages.set(sessionId, [...current, ...messages.map(snapshotJson)])
    })
  }

  public async listMessages(sessionId: string, opts: { limit?: number; before?: string } = {}): Promise<Message[]> {
    // Append/replace order is canonical. Timestamps can tie for every message
    // in a run, and ids are identity keys rather than chronological keys.
    let rows = [...(this.messages.get(sessionId) ?? [])]

    if (opts.before) {
      const beforeIndex = rows.findIndex((row) => row.id === opts.before)
      if (beforeIndex >= 0) {
        rows = rows.slice(0, beforeIndex)
      }
    }

    if (opts.limit !== undefined) {
      rows = rows.slice(Math.max(0, rows.length - opts.limit))
    }

    return rows.map(snapshotJson)
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
      this.messages.set(sessionId, messages.map(snapshotJson))
    })
  }

  public async createRun(request: CreateRunRequest): Promise<RunRecord> {
    const normalized = normalizeCreateRunRequest(request)
    const existing = this.runs.get(normalized.id)
    if (existing) {
      if (runCreationBytes(existing) === runCreationBytes(normalized)) return snapshotJson(existing)
      throw runConflict()
    }
    const record = deepFreeze({ ...normalized, status: 'running' as const, revision: 1 })
    this.runs.set(record.id, record)
    return snapshotJson(record)
  }

  public async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    const normalized = normalizeFinishRunPatch(patch, () => this.now().toISOString(), finishRunConflict)
    return this.storageSpan('finish_run', { 'harness.run.id': runId, 'harness.run.status': normalized.status }, async () => {
      const run = this.runs.get(runId)
      if (!run) return
      if (this.runLeases.has(runId) || run.attempt !== undefined) throw new StateError('A durable run requires atomic finalization.', { op: 'finishRun', reason: 'active_lease_requires_finalize' })
      this.runs.set(runId, deepFreeze({ ...run, ...normalized, revision: run.revision + 1 }) as RunRecord)
      if (normalized.status !== 'running') this.releaseRunLease(runId)
    })
  }

  public async getRun(runId: string): Promise<RunRecord | undefined> {
    const record = this.runs.get(runId)
    if (record) assertStoredRunRecord(record, malformedRun)
    return record ? snapshotJson(record) : undefined
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

    for (const row of rows) assertStoredRunRecord(row, malformedRun)
    return rows.map(snapshotJson)
  }

  public async appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    const current = this.events.get(runId) ?? []
    const next = [...current]
    const normalized = events.map((event) => normalizePersistedEvent(event, runId))
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index]!.sequence <= normalized[index - 1]!.sequence) throw eventSequenceConflict()
    }
    for (const event of normalized) {
      const existing = next.find(row => row.sequence === event.sequence || row.id === event.id)
      if (existing) {
        if (canonicalJson(existing) !== canonicalJson(event)) throw new StateError('Run event conflicts with an existing event.', { op: 'appendEvents', reason: 'event_conflict' })
        continue
      }
      if (event.sequence !== next.length + 1) throw eventSequenceConflict()
      next.push(event)
    }
    this.events.set(runId, next)
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

    return rows.map(snapshotJson)
  }

  public async acquireRun(request: AcquireRunRequest): Promise<DurableRunLease> {
    const normalized = normalizeAcquireRunRequest(request)
    return this.storageSpan('acquire_run', { 'harness.run.id': normalized.runId }, () => this.withSessionLock(normalized.sessionId, async () => {
      const run = this.runs.get(normalized.runId)
      if (!run) throw new StateError('Durable run must be created before acquisition.', { op: 'acquireRun', reason: 'run_not_found' })
      if (run.sessionId !== normalized.sessionId) throw new StateError('Run acquisition conflicts with the logical run.', { op: 'acquireRun', reason: 'acquisition_conflict' })
      if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
        throw new DurableTerminalRunError(normalized.runId, run.status)
      }
      const selected = this.checkpoints.get(normalized.runId)?.get(normalized.expected.checkpoint.stepId)
      const requestBytes = canonicalJson(normalized)
      const activeRun = this.runLeases.get(normalized.runId)
      if (activeRun?.acquisitionId === normalized.acquisitionId && activeRun.requestBytes === requestBytes && activeRun.acquiredRevision === run.revision
        && (selected?.sequence ?? null) === normalized.expected.checkpoint.sequence) {
        return this.makeLease(normalized, activeRun, run, selected)
      }
      if (run.revision !== normalized.expected.revision || run.status !== normalized.expected.status
        || (selected?.sequence ?? null) !== normalized.expected.checkpoint.sequence
        || (normalized.mode === 'initial' && (run.revision !== 1 || run.attempt !== undefined || run.workerId !== undefined || (this.checkpoints.get(normalized.runId)?.size ?? 0) > 0))
        || (normalized.mode === 'resume' && run.attempt === undefined)) {
        throw new StateError('Run acquisition conflicts with the observed state.', { op: 'acquireRun', reason: 'acquisition_conflict' })
      }
      if (activeRun) throw new StateError('Run lease is already held.', { op: 'acquireRun', reason: 'lease_conflict' })
      const activeSession = this.sessionLeases.get(normalized.sessionId)
      if (activeSession) throw new StateError('Session lease is already held.', { op: 'acquireRun', reason: 'lease_conflict' })

      const attempt = Math.max((run.attempt ?? 0) + 1, normalized.requestedAttempt ?? 1)
      const updated: RunRecord = deepFreeze({
        ...run,
        status: 'running',
        attempt,
        workerId: normalized.workerId,
        initialStepId: run.initialStepId ?? (normalized.mode === 'initial' ? normalized.expected.checkpoint.stepId : undefined),
        revision: run.revision + 1,
      }) as RunRecord
      this.runs.set(normalized.runId, updated)

      const leaseId = `lease-${++this.leaseCounter}`
      const active = { leaseId, sessionId: normalized.sessionId, workerId: normalized.workerId, acquisitionId: normalized.acquisitionId, requestBytes, acquiredRevision: updated.revision }
      this.runLeases.set(normalized.runId, active)
      this.sessionLeases.set(normalized.sessionId, { leaseId, runId: normalized.runId, workerId: normalized.workerId })
      return this.makeLease(normalized, active, updated, selected)
    }))
  }

  public async replaceCheckpoint(request: ReplaceCheckpointRequest): Promise<void> {
    const normalized = normalizeReplaceCheckpointRequest(request)
    await this.withSessionLock(normalized.sessionId, async () => {
      const run = this.runs.get(normalized.runId)
      const lease = this.runLeases.get(normalized.runId)
      const current = this.checkpoints.get(normalized.runId)?.get(normalized.stepId)
      if (!run || run.sessionId !== normalized.sessionId || run.status !== 'running'
        || !lease || lease.sessionId !== normalized.sessionId || lease.leaseId !== normalized.leaseId || lease.workerId !== normalized.workerId
        || !current || !checkpointIdentityMatches(current, normalized.replacement, run)) throw checkpointConflict()

      if (current.sequence === normalized.replacement.sequence) {
        if (sameInstalledCheckpoint(current, normalized.replacement)) return
        throw checkpointConflict()
      }
      if (current.sequence !== normalized.expectedSequence) throw checkpointConflict()

      const replacement = deepFreeze({
        ...normalized.replacement,
        committedAt: normalized.replacement.committedAt ?? this.now().toISOString(),
      }) as RunCheckpoint
      const map = this.checkpoints.get(normalized.runId) ?? new Map<string, RunCheckpoint>()
      map.set(normalized.stepId, replacement)
      this.checkpoints.set(normalized.runId, map)
      this.runs.set(normalized.runId, deepFreeze({ ...run, revision: run.revision + 1 }))
    })
  }

  public async finalizeRun(request: FinalizeRunRequest): Promise<void> {
    const normalized = normalizeFinalizeRunRequest(request)
    await this.withSessionLock(normalized.sessionId, async () => {
      const run = this.runs.get(normalized.runId)
      if (!run) throw finalizeConflict('run_not_found')
      if (run.sessionId !== normalized.sessionId) throw finalizeConflict('lease_conflict')
      assertApprovalReceiptMatchesRun(normalized.patch.approvalReceipt, run)
      if (isTerminal(run.status)) {
        if (!terminalPatchMatchesRun(run, normalized.patch)) throw finalizeConflict('run_conflict')
        if (!terminalEventMatchesPatch(normalized.terminalEvent, normalized.patch)) throw finalizeConflict('event_conflict')
        const storedEvent = (this.events.get(normalized.runId) ?? []).find(event => event.id === normalized.terminalEvent.id || event.sequence === normalized.terminalEvent.sequence)
        if (storedEvent && canonicalJson(storedEvent) === canonicalJson(normalized.terminalEvent)) return
        throw finalizeConflict('event_conflict')
      }
      const lease = this.runLeases.get(normalized.runId)
      if (!lease || lease.sessionId !== normalized.sessionId || lease.leaseId !== normalized.leaseId || lease.workerId !== normalized.workerId) throw finalizeConflict('lease_conflict')
      const currentEvents = this.events.get(normalized.runId) ?? []
      const collision = currentEvents.find(event => event.id === normalized.terminalEvent.id || event.sequence === normalized.terminalEvent.sequence)
      if (collision || normalized.terminalEvent.sequence !== currentEvents.length + 1
        || !terminalEventMatchesPatch(normalized.terminalEvent, normalized.patch)) throw finalizeConflict('event_conflict')
      const { output: _output, error: _error, approvalReceipt: _approvalReceipt, finishedAt: _finishedAt, ...activeRun } = run
      const terminal = deepFreeze({ ...activeRun, ...normalized.patch, revision: run.revision + 1 }) as RunRecord
      this.runs.set(normalized.runId, terminal)
      this.events.set(normalized.runId, [...currentEvents, normalized.terminalEvent])
      this.checkpoints.delete(normalized.runId)
      this.releaseRunLease(normalized.runId)
    })
  }

  public async loadCheckpoint(runId: string, stepId?: string): Promise<RunCheckpoint | undefined> {
    return this.storageSpan('load_checkpoint', { 'harness.run.id': runId }, async () => {
      const checkpoint = [...(this.checkpoints.get(runId)?.values() ?? [])]
        .filter(checkpoint => stepId === undefined || checkpoint.stepId === stepId)
        .sort((a, b) => a.sequence - b.sequence)
        .at(-1)
      return checkpoint ? snapshotJson(checkpoint) : undefined
    })
  }

  public async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    const normalized = normalizeRunCheckpoint(checkpoint, commitCheckpointConflict)
    await this.storageSpan('commit_checkpoint', {
      'harness.run.id': normalized.runId,
      'harness.storage.sequence': normalized.sequence
    }, () => this.withSessionLock(normalized.sessionId, async () => {
      const lease = this.runLeases.get(normalized.runId)
      if (!lease || lease.sessionId !== normalized.sessionId || lease.leaseId !== normalized.leaseId || lease.workerId !== normalized.workerId) {
        throw new DurableRunLeaseError(`Durable run "${normalized.runId}" is not owned by this lease.`)
      }
      const run = this.runs.get(normalized.runId)
      if (!run || run.sessionId !== normalized.sessionId || run.status !== 'running'
        || run.attempt !== normalized.attempt || canonicalJson(run.input) !== canonicalJson(normalized.input)) {
        throw commitCheckpointConflict()
      }
      const checkpoints = this.checkpoints.get(normalized.runId) ?? new Map<string, RunCheckpoint>()
      const existing = checkpoints.get(normalized.stepId)
      if (existing) {
        if (sameInstalledRunCheckpoint(existing, normalized)) return
        throw commitCheckpointConflict()
      }
      checkpoints.set(normalized.stepId, deepFreeze({ ...normalized, committedAt: normalized.committedAt ?? this.now().toISOString() }) as RunCheckpoint)
      this.checkpoints.set(normalized.runId, checkpoints)
      const checkpointedRun = deepFreeze({ ...run, revision: run.revision + 1 }) as RunRecord
      this.runs.set(normalized.runId, checkpointedRun)
      this.checkpointCommitCount += 1
      if (this.options.failAfterCheckpoint === this.checkpointCommitCount) {
        this.runs.set(normalized.runId, deepFreeze({
          ...checkpointedRun,
          status: 'interrupted',
          revision: checkpointedRun.revision + 1,
        }))
        this.releaseRunLease(normalized.runId)
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
    const validated = validateBoundExternalWaitRequest(request)
    return this.storageSpan('register_wait', {
      'harness.run.id': validated.runId,
      'harness.wait.kind': validated.kind
    }, () => this.withSessionLock(validated.sessionId, async () => {
      const existing = this.expireWait(this.waits.get(validated.waitId))
      if (existing) {
        if (!sameWait(existing, validated)) throw new ExternalWaitError('External wait id is already bound to a different request.', 'request_conflict')
        return snapshotJson({ created: false, snapshot: externalSnapshot(existing) })
      }
      const run = this.runs.get(validated.runId)
      if (!run || run.sessionId !== validated.sessionId) throw new ExternalWaitError('External wait run binding is invalid.', 'invalid_request')
      if (run.status !== 'running') throw new ExternalWaitError('External waits can only suspend a running durable run.', 'durable_required')
      const lease = this.runLeases.get(validated.runId)
      if (!lease || lease.sessionId !== validated.sessionId) throw new ExternalWaitError('External wait run binding is invalid.', 'durable_required')
      const stored: StoredExternalWait = {
        ...projectExternalWaitRequest(validated),
        runId: validated.runId,
        sessionId: validated.sessionId,
        status: 'waiting',
        createdAt: this.now().toISOString()
      }
      this.waits.set(validated.waitId, stored)
      this.waitSignals.set(validated.waitId, new Set())
      this.runs.set(validated.runId, deepFreeze({ ...run, status: 'waiting', revision: run.revision + 1 }))
      this.releaseRunLease(validated.runId)
      return snapshotJson({ created: true, snapshot: externalSnapshot(stored) })
    }))
  }

  public async getWait(waitId: string): Promise<ExternalWaitSnapshot | undefined> {
    const validatedWaitId = validateExternalWaitId(waitId)
    const wait = this.expireWait(this.waits.get(validatedWaitId))
    return wait ? externalSnapshot(wait) : undefined
  }

  public async signalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult> {
    const validated = validateExternalWaitSignal(signal)
    return this.storageSpan('signal_wait', { 'harness.wait.outcome': validated.outcome }, async () => (
      this.resolveWait(validated)
    ))
  }

  public async cancelWait(waitId: string, eventId: string, observedAt?: string): Promise<ExternalWaitSignalResult> {
    return this.resolveWait(createExternalWaitCancellation(waitId, eventId, observedAt))
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

  private makeLease(
    request: AcquireRunRequest,
    active: { leaseId: string; sessionId: string; workerId: string; acquisitionId: string },
    run: RunRecord,
    checkpoint: RunCheckpoint | undefined,
  ): DurableRunLease {
    const checkpoints = snapshotJson([...(this.checkpoints.get(request.runId)?.values() ?? [])].sort((left, right) => left.sequence - right.sequence))
    const acquiredFrom = deepFreeze(copyJson(request.expected))
    const runSnapshot = snapshotJson(run)
    const checkpointSnapshot = checkpoint === undefined ? undefined : snapshotJson(checkpoint)
    return Object.freeze({
      runId: request.runId, sessionId: request.sessionId, workerId: request.workerId,
      acquisitionId: request.acquisitionId, leaseId: active.leaseId, attempt: run.attempt!,
      resumed: request.mode === 'resume', acquiredFrom, run: runSnapshot,
      ...(checkpointSnapshot === undefined ? {} : { checkpoint: checkpointSnapshot }), checkpoints,
      release: async () => {
        await this.withSessionLock(request.sessionId, async () => {
          const currentLease = this.runLeases.get(request.runId)
          if (currentLease?.leaseId !== active.leaseId || currentLease.acquisitionId !== request.acquisitionId
            || currentLease.sessionId !== request.sessionId || currentLease.workerId !== request.workerId) return
          this.releaseRunLease(request.runId)
          const current = this.runs.get(request.runId)
          if (current?.status === 'running') this.runs.set(request.runId, deepFreeze({ ...current, status: 'interrupted', revision: current.revision + 1 }))
        })
      },
    })
  }

  private resolveWait(signal: ExternalWaitSignal): ExternalWaitSignalResult {
    const wait = this.expireWait(this.waits.get(signal.waitId))
    if (!wait) return snapshotJson(validateExternalWaitSignalResult({ kind: 'not_found' }))
    const delivered = this.waitSignals.get(signal.waitId) ?? new Set<string>()
    this.waitSignals.set(signal.waitId, delivered)
    if (delivered.has(signal.eventId)) return snapshotJson(validateExternalWaitSignalResult({ kind: 'duplicate', snapshot: externalSnapshot(wait) }))
    delivered.add(signal.eventId)
    if (wait.status !== 'waiting') return snapshotJson(validateExternalWaitSignalResult({ kind: 'already_terminal', snapshot: externalSnapshot(wait) }))
    const resolvedSnapshot = validateExternalWaitSnapshot({
      waitId: wait.waitId,
      kind: wait.kind,
      schemaVersion: wait.schemaVersion,
      definitionVersion: wait.definitionVersion,
      deadline: wait.deadline,
      createdAt: wait.createdAt,
      status: signal.outcome,
      resolvedAt: signal.observedAt ?? this.now().toISOString(),
      eventId: signal.eventId
    })
    const resolved = asExternalWaitResolved(resolvedSnapshot)
    if (!resolved) throw new ExternalWaitError('External wait adapter returned an invalid snapshot.', 'invalid_snapshot')
    const stored: StoredExternalWait = { ...resolved, runId: wait.runId, sessionId: wait.sessionId }
    this.waits.set(signal.waitId, stored)
    return snapshotJson(validateExternalWaitSignalResult({ kind: 'applied', snapshot: externalSnapshot(stored) }))
  }

  private expireWait(wait: StoredExternalWait | undefined): StoredExternalWait | undefined {
    if (!wait || wait.status !== 'waiting' || Date.parse(wait.deadline) > this.now().getTime()) return wait
    const expiredSnapshot = validateExternalWaitSnapshot({
      waitId: wait.waitId,
      kind: wait.kind,
      schemaVersion: wait.schemaVersion,
      definitionVersion: wait.definitionVersion,
      deadline: wait.deadline,
      status: 'expired',
      createdAt: wait.createdAt,
      resolvedAt: this.now().toISOString()
    })
    const expired = asExternalWaitResolved(expiredSnapshot)
    if (!expired) throw new ExternalWaitError('External wait adapter returned an invalid snapshot.', 'invalid_snapshot')
    const stored: StoredExternalWait = { ...expired, runId: wait.runId, sessionId: wait.sessionId }
    this.waits.set(wait.waitId, stored)
    return stored
  }
}

/** Creates the process-local default Harness storage used by tests and development. */
export function inMemoryHarnessStorage(options: { now?: () => Date; failAfterCheckpoint?: number } = {}): InMemoryHarnessStorage {
  return new InMemoryHarnessStorage(options)
}

type StoredExternalWait = ExternalWaitSnapshot & { readonly runId: string; readonly sessionId: string }

function sameWait(existing: StoredExternalWait, request: BoundExternalWaitRequest): boolean {
  return existing.runId === request.runId
    && existing.sessionId === request.sessionId
    && existing.kind === request.kind
    && existing.schemaVersion === request.schemaVersion
    && existing.definitionVersion === request.definitionVersion
    && existing.deadline === request.deadline
}

function externalSnapshot(wait: StoredExternalWait): ExternalWaitSnapshot {
  const { runId: _runId, sessionId: _sessionId, ...snapshot } = wait
  return snapshotJson(validateExternalWaitSnapshot(snapshot))
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function normalizeCreateRunRequest(value: CreateRunRequest): CreateRunRequest {
  if (!plain(value) || !exactKeys(value, ['id', 'sessionId', 'kind', 'target', 'startedAt', 'input', 'validatedInput', 'metadata'])) throw runConflict()
  try { canonicalJson(value) } catch { throw runConflict() }
  if (!validId(value.id) || !validId(value.sessionId) || !validId(value.target)
    || !['agent', 'workflow', 'child_task'].includes(value.kind) || !validTimestamp(value.startedAt)
    || (value.kind === 'child_task' ? Object.hasOwn(value, 'validatedInput') : !Object.hasOwn(value, 'validatedInput'))
    || (Object.hasOwn(value, 'metadata') && value.metadata === undefined)
    || (value.metadata !== undefined && !plain(value.metadata))) throw runConflict()
  return deepFreeze(copyJson(value))
}

function normalizeAcquireRunRequest(value: AcquireRunRequest): AcquireRunRequest {
  const invalid = () => new StateError('Run acquisition request is invalid.', { op: 'acquireRun', reason: 'acquisition_conflict' })
  if (!plain(value) || !exactKeys(value, ['mode', 'runId', 'sessionId', 'workerId', 'acquisitionId', 'expected', 'requestedAttempt'])
    || !['initial', 'resume'].includes(value.mode) || !validId(value.runId) || !validId(value.sessionId) || !validId(value.workerId)
    || !/^acq_[a-f0-9]{64}$/.test(value.acquisitionId) || !plain(value.expected)
    || !exactKeys(value.expected, ['revision', 'status', 'checkpoint']) || !positive(value.expected.revision)
    || !['running', 'waiting', 'interrupted'].includes(value.expected.status) || !plain(value.expected.checkpoint)
    || !exactKeys(value.expected.checkpoint, ['stepId', 'sequence']) || !validId(value.expected.checkpoint.stepId)
    || (value.expected.checkpoint.sequence !== null && !positive(value.expected.checkpoint.sequence))
    || (Object.hasOwn(value, 'requestedAttempt') && value.requestedAttempt === undefined)
    || (value.requestedAttempt !== undefined && !positive(value.requestedAttempt))) throw invalid()
  const expectedId = `acq_${createHash('sha256').update(canonicalJson(['harness-run-acquisition-v1', value.mode, value.runId, value.sessionId, value.workerId,
    value.expected.revision, value.expected.status, value.expected.checkpoint.stepId, value.expected.checkpoint.sequence, value.requestedAttempt ?? null])).digest('hex')}`
  if (value.acquisitionId !== expectedId) throw invalid()
  return deepFreeze(copyJson(value))
}

function normalizePersistedEvent<Event extends PersistedRunEvent>(value: Event, runId: string, op: 'appendEvents' | 'finalizeRun' = 'appendEvents'): Event {
  if (!plain(value) || !exactKeys(value, ['id', 'sequence', 'runId', 'at', 'type', 'payload']) || value.runId !== runId
    || !positive(value.sequence) || !validTimestamp(value.at) || !harnessExecutionEventTypesV1.includes(value.type)
    || value.id !== `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', value.runId, value.sequence, value.type])).digest('hex')}`) {
    throw new StateError('Run event is invalid.', { op, reason: 'event_conflict' })
  }
  try { canonicalJson(value.payload) } catch { throw new StateError('Run event is invalid.', { op, reason: 'event_conflict' }) }
  return deepFreeze(copyJson(value))
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
  return deepFreeze(copyJson(value))
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
  return deepFreeze(copyJson({ ...value, terminalEvent }))
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
function malformedRun(): StateError { return new StateError('Harness run record is malformed.', { op: 'getRun', reason: 'invalid_record' }) }
function eventSequenceConflict(): StateError { return new StateError('Run event sequence is not contiguous.', { op: 'appendEvents', reason: 'event_sequence_conflict' }) }
function commitCheckpointConflict(): StateError { return new StateError('Durable checkpoint conflicts with the installed record.', { op: 'commitCheckpoint', reason: 'checkpoint_conflict' }) }
function finishRunConflict(): StateError { return new StateError('Run transition is invalid.', { op: 'finishRun', reason: 'run_conflict' }) }
function checkpointConflict(): StateError { return new StateError('Checkpoint replacement conflicts with stored state.', { op: 'replaceCheckpoint', reason: 'checkpoint_conflict' }) }
function finalizeConflict(reason: 'run_conflict' | 'run_not_found' | 'lease_conflict' | 'event_conflict'): StateError {
  return new StateError('Run finalization conflicts with stored state.', { op: 'finalizeRun', reason })
}
function isTerminal(value: RunRecord['status']): boolean { return value === 'succeeded' || value === 'failed' || value === 'cancelled' }
function validId(value: unknown): value is string { return typeof value === 'string' && identifier.test(value) }
function validTimestamp(value: unknown): value is string { return typeof value === 'string' && timestamp.test(value) && new Date(value).toISOString() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) }
function exactKeys(value: object, allowed: readonly string[]): boolean { return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key)) }
function copyJson<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T }
function snapshotJson<T>(value: T): T { return deepFreeze(copyJson(value)) }
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
