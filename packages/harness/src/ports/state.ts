import { StateError } from '../errors/index.js'
import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import type { Logger } from '../logger/index.js'
import type { TelemetryShim } from '../telemetry/index.js'
import type { HarnessAdapterContext } from './harness-context.js'

/** Fields allowed when marking a run as finished. */
export type FinishRunPatch = Pick<RunRecord, 'status' | 'finishedAt' | 'output' | 'error'>

/**
 * Persistence port for session state, history, run metadata, and streamed events.
 *
 * Implement this interface to provide durable backends (Postgres, Redis, etc.).
 */
export interface StateStore {
  getSession(id: string): Promise<SessionRecord | undefined>
  upsertSession(record: SessionRecord): Promise<void>
  closeSession(id: string): Promise<void>

  appendMessages(sessionId: string, messages: Message[]): Promise<void>
  listMessages(sessionId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>
  clearMessages(sessionId: string): Promise<void>
  /**
   * Atomically replace all messages for a session under one lock (clear +
   * append). Adapters that implement this provide the spec-mandated atomic
   * `replaceHistory`; the session layer falls back to clear+append when absent.
   */
  replaceMessages?(sessionId: string, messages: Message[]): Promise<void>

  createRun(record: RunRecord): Promise<void>
  finishRun(runId: string, patch: FinishRunPatch): Promise<void>
  getRun(runId: string): Promise<RunRecord | undefined>
  listRuns(sessionId: string, opts?: { limit?: number; before?: string }): Promise<RunRecord[]>

  appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void>
  listEvents(runId: string, opts?: { limit?: number; after?: string }): Promise<PersistedRunEvent[]>

  close?(): Promise<void>
}

/**
 * Optional base for durable state adapters.
 *
 * Concrete adapters still implement the `StateStore` port directly, while this
 * base provides shared error normalization so provider-specific code can stay
 * focused on mapping records to the backing store.
 */
export abstract class StateStoreAdapterBase implements StateStore {
  protected logger: Logger | undefined
  protected telemetry: TelemetryShim | undefined
  protected harnessName: string | undefined

  abstract getSession(id: string): Promise<SessionRecord | undefined>
  abstract upsertSession(record: SessionRecord): Promise<void>
  abstract closeSession(id: string): Promise<void>
  abstract appendMessages(sessionId: string, messages: Message[]): Promise<void>
  abstract listMessages(sessionId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>
  abstract clearMessages(sessionId: string): Promise<void>
  abstract createRun(record: RunRecord): Promise<void>
  abstract finishRun(runId: string, patch: FinishRunPatch): Promise<void>
  abstract getRun(runId: string): Promise<RunRecord | undefined>
  abstract listRuns(sessionId: string, opts?: { limit?: number; before?: string }): Promise<RunRecord[]>
  abstract appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void>
  abstract listEvents(runId: string, opts?: { limit?: number; after?: string }): Promise<PersistedRunEvent[]>

  public async close(): Promise<void> {}

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.logger ??= context.logger
    this.telemetry ??= context.telemetry
    this.harnessName ??= context.harnessName
  }

  protected stateError(op: Parameters<StateStore['appendEvents']>[0] extends never ? never : ConstructorParameters<typeof StateError>[1]['op'], message: string, error: unknown, reason?: string): StateError {
    if (error instanceof StateError) return error
    return new StateError(message, { op, ...(reason ? { reason } : {}) }, error)
  }
}
