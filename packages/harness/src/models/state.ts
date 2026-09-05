import type { JsonValue } from './json.js'
import type { HarnessIdentity } from '../identity/index.js'
import type { SessionSandboxBinding } from '../sandbox/ownership.js'

/** Session-level metadata persisted by Harness storage. */
export interface SessionRecord {
  id: string
  /** Opaque immutable identity of this record; changes when a closed id is reused. */
  instanceId: string
  createdAt: string
  updatedAt: string
  runCount: number
  /** Identity is bound at creation and compared before any live resource opens. */
  identity?: HarnessIdentity
  /** Immutable sandbox ownership binding for this session incarnation. */
  sandboxBinding: SessionSandboxBinding
  metadata?: Record<string, JsonValue>
}

/** Message persisted in conversation history. */
export interface Message {
  id: string
  sessionId: string
  runId?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: Array<{
    id: string
    name: string
    arguments: JsonValue
  }>
  toolResults?: Array<{
    toolCallId: string
    output?: JsonValue
    error?: SerializedError
  }>
  timestamp: string
}

/** Run lifecycle status values.
 * - `running`: active run in progress
 * - `waiting`: durable run is safely suspended for an external signal
 * - `interrupted`: durable execution stopped and may resume
 * - `succeeded`: run completed successfully
 * - `failed`: run completed with error
 * - `cancelled`: run cancelled before completion
 */
export type RunStatus = 'running' | 'waiting' | 'interrupted' | 'succeeded' | 'failed' | 'cancelled'

/** Serialized error payload stored on run records. */
export interface SerializedError {
  code: string
  message: string
  category?: string
  retriable?: boolean
  meta?: Record<string, unknown>
}

/** Run record persisted by Harness storage. */
export interface RunRecord {
  readonly id: string
  readonly sessionId: string
  readonly kind: 'workflow' | 'agent' | 'child_task'
  readonly target: string
  readonly startedAt: string
  readonly finishedAt?: string
  readonly status: RunStatus
  readonly revision: number
  readonly input: JsonValue
  readonly output?: JsonValue
  readonly error?: SerializedError
  readonly approvalReceipt?: import('../storage/types.js').TerminalApprovalReceiptV1
  /** Current durable attempt. Omitted for ordinary non-durable runs. */
  readonly attempt?: number
  /** Worker currently associated with a durable attempt. */
  readonly workerId?: string
  /** First durable step id, retained across attempts. */
  readonly initialStepId?: string
  /** Adapter-neutral durable execution metadata. */
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

/** Exact persisted metadata for one workflow-owned child task. */
export interface ChildTaskRecordMetadataV1 {
  readonly schemaVersion: 1
  readonly kind: 'workflow_child_task'
  readonly parentRunId: string
  readonly workflowId: string
  readonly workflowInvocationId: string
  readonly callId: string
  readonly agentId: string
  readonly modelAlias: string
  readonly mode: 'one_shot' | 'continuable'
  readonly context: 'isolated'
  readonly timeoutMs: number | null
  readonly idempotencyKey: string | null
  readonly createdAt: string
}

/** Event payload persisted for run replay or audit. */
export interface PersistedRunEvent {
  readonly id: string
  readonly sequence: number
  readonly runId: string
  readonly at: string
  readonly type: import('../definitions/execution-events.js').HarnessExecutionEventType
  readonly payload: JsonValue
}

/** Optional parent correlation persisted only as a complete pair. */
export type PersistedEventParentCorrelation =
  | Readonly<{
      readonly parentRunId?: never
      readonly parentInvocationId?: never
    }>
  | Readonly<{
      readonly parentRunId: string
      readonly parentInvocationId: string
    }>

/** Strict privacy-safe payload for a persisted terminal run event. */
export type PersistedRunFinishedPayload = PersistedEventParentCorrelation & (
  | Readonly<{ readonly outcome: Readonly<{ readonly status: 'completed' }> }>
  | Readonly<{ readonly outcome: Readonly<{ readonly status: 'interrupted' }> }>
  | Readonly<{
      readonly outcome: Readonly<{
        readonly status: 'failed' | 'cancelled'
        readonly error: SerializedError
      }>
    }>
) & JsonValue

/** Terminal payload accepted by atomic run finalization. */
export type PersistedFinalRunFinishedPayload = Exclude<
  PersistedRunFinishedPayload,
  PersistedEventParentCorrelation &
    Readonly<{ readonly outcome: Readonly<{ readonly status: 'interrupted' }> }>
>

/** Strict persisted `run.finished` envelope accepted by atomic finalization. */
export type PersistedFinalRunEvent = Omit<PersistedRunEvent, 'type' | 'payload'> &
  Readonly<{
    readonly type: 'run.finished'
    readonly payload: PersistedFinalRunFinishedPayload
  }>
