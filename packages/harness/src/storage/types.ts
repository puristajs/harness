import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { DurableRunLease, DurableRunStart, RunCheckpoint } from './execution.js'
import type {
  BoundExternalWaitRequest,
  ExternalWaitRegistration,
  ExternalWaitRequest,
  ExternalWaitSignal,
  ExternalWaitSignalResult,
  ExternalWaitSnapshot
} from './external-wait.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import { HarnessConfigError } from '../errors/catalog.js'

/** Fields allowed when marking a run as finished. */
export type FinishRunPatch = Pick<RunRecord, 'status'> & Partial<Pick<RunRecord, 'finishedAt' | 'output' | 'error'>>

/** Metadata surfaced for one configured Harness storage implementation. */
export interface HarnessStorageInfo {
  readonly id: string
  readonly packageName: string
  readonly version?: string
  readonly capabilities: readonly AdapterCapability[]
}

/**
 * Persistence port for sessions, history, recoverable runs, and streamed events.
 *
 * Implement this interface to provide durable backends (Postgres, Redis, etc.).
 */
export interface HarnessStorage {
  readonly info: HarnessStorageInfo
  readonly capabilities: readonly AdapterCapability[]
  configureHarnessContext?(context: HarnessAdapterContext): void
  getSession(id: string): Promise<SessionRecord | undefined>
  /**
   * Atomically inserts a session (`create`) or updates its summary (`update`).
   * Creation never mutates an existing record; updates never insert one.
   * Returns `true` only for the insertion winner. Instance id, creation time and exact
   * optional identity are immutable until `closeSession`; identity conflicts
   * fail with `StateError` (`session_identity_mismatch`). A different creation
   * instance id never overwrites the stored incarnation. Missing or changed
   * instances reject updates with `StateError` (`session_instance_mismatch`);
   * older summaries leave the current record unchanged.
   */
  upsertSession(record: SessionRecord, mode: 'create' | 'update'): Promise<boolean>
  /**
   * Destructively removes all persisted data owned by one session, including
   * its session record, conversation history, runs, and run events.
   * Only removes the record when its instance id matches `expectedInstanceId`;
   * a stale close cannot delete a newly created session with the same id.
   * `Session.release()` intentionally does not call this operation.
   */
  closeSession(id: string, expectedInstanceId: string): Promise<void>

  appendMessages(sessionId: string, messages: Message[]): Promise<void>
  listMessages(sessionId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>
  clearMessages(sessionId: string): Promise<void>
  /**
   * Atomically replace all messages for a session under one lock (clear +
   * append). This method is required when `defaults.historyRetention` is
   * configured; the Harness never uses a non-atomic fallback for retention.
   */
  replaceMessages?(sessionId: string, messages: Message[]): Promise<void>

  /**
   * Atomically creates a run when its id is absent. A repeated creation for
   * the same run identity is idempotent and must preserve the stored record;
   * an incompatible identity fails with `StateError` (`run_conflict`).
   *
   * This is the creation fence for concurrent first durable invocations:
   * callers may observe an absent run concurrently, but no caller may replace
   * the record selected by the creation winner.
   */
  createRun(record: RunRecord): Promise<void>
  finishRun(runId: string, patch: FinishRunPatch): Promise<void>
  getRun(runId: string): Promise<RunRecord | undefined>
  listRuns(sessionId: string, opts?: { limit?: number; before?: string }): Promise<RunRecord[]>

  appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void>
  listEvents(runId: string, opts?: { limit?: number; after?: string }): Promise<PersistedRunEvent[]>

  /** Acquires exclusive ownership of an existing durable run attempt. */
  acquireRun(record: DurableRunStart): Promise<DurableRunLease>
  /** Loads the last committed deterministic step checkpoint. */
  loadCheckpoint(runId: string): Promise<RunCheckpoint | undefined>
  /** Commits one deterministic step checkpoint under the active lease. */
  commitCheckpoint(checkpoint: RunCheckpoint): Promise<void>
  /** Runs an operation under the storage's session-level serialization boundary. */
  withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>

  /** Atomically registers a wait, marks its run waiting, and releases its lease. */
  registerWait(request: BoundExternalWaitRequest): Promise<ExternalWaitRegistration>
  getWait(waitId: string): Promise<ExternalWaitSnapshot | undefined>
  signalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult>
  cancelWait(waitId: string, eventId: string, observedAt?: string): Promise<ExternalWaitSignalResult>

  close?(): Promise<void>
}

const REQUIRED_STORAGE_METHODS = [
  'getSession', 'upsertSession', 'closeSession',
  'appendMessages', 'listMessages', 'clearMessages',
  'createRun', 'finishRun', 'getRun', 'listRuns',
  'appendEvents', 'listEvents',
  'acquireRun', 'loadCheckpoint', 'commitCheckpoint', 'withSessionLock',
  'registerWait', 'getWait', 'signalWait', 'cancelWait'
] as const

const REQUIRED_STORAGE_CAPABILITIES = [
  'storage.checkpoint',
  'storage.retry',
  'storage.resume',
  'storage.workspace_checkpoint',
  'storage.external_wait'
] as const satisfies readonly AdapterCapability[]

/** Validates a JavaScript storage adapter at the builder boundary. */
export function validateHarnessStorage(value: HarnessStorage): void {
  const candidate = value as unknown as Record<string, unknown>
  const info = candidate['info'] as Record<string, unknown> | undefined
  if (!info || typeof info['id'] !== 'string' || !/^[a-z][a-z0-9_.-]{1,63}$/.test(info['id'])) {
    throw new HarnessConfigError('Harness storage info.id is invalid.', { reason: 'invalid_storage', path: 'storage.info.id' })
  }
  if (typeof info['packageName'] !== 'string' || info['packageName'].trim() === '') {
    throw new HarnessConfigError('Harness storage info.packageName is required.', { reason: 'invalid_storage', path: 'storage.info.packageName' })
  }
  const capabilities = candidate['capabilities']
  if (!Array.isArray(capabilities) || !Array.isArray(info['capabilities'])) {
    throw new HarnessConfigError('Harness storage capabilities are required.', { reason: 'invalid_storage', path: 'storage.capabilities' })
  }
  for (const capability of REQUIRED_STORAGE_CAPABILITIES) {
    if (!capabilities.includes(capability) || !(info['capabilities'] as unknown[]).includes(capability)) {
      throw new HarnessConfigError(`Harness storage must support ${capability}.`, { reason: 'invalid_storage', path: 'storage.capabilities', id: capability })
    }
  }
  for (const method of REQUIRED_STORAGE_METHODS) {
    if (typeof candidate[method] !== 'function') {
      throw new HarnessConfigError(`Harness storage method ${method} is required.`, { reason: 'invalid_storage', path: `storage.${method}` })
    }
  }
}
