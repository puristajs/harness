import type { JsonValue } from './json.js'
import type { HarnessIdentity } from '../identity/index.js'

/** Session-level metadata persisted by Harness storage. */
export interface SessionRecord {
  id: string
  createdAt: string
  updatedAt: string
  runCount: number
  /** Identity is bound at creation and compared before any live resource opens. */
  identity?: HarnessIdentity
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
  id: string
  sessionId: string
  kind: 'workflow' | 'agent' | 'child_task'
  target: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  input?: JsonValue
  output?: JsonValue
  error?: SerializedError
  /** Current durable attempt. Omitted for ordinary non-durable runs. */
  attempt?: number
  /** Worker currently associated with a durable attempt. */
  workerId?: string
  /** First durable step id, retained across attempts. */
  initialStepId?: string
  /** Adapter-neutral durable execution metadata. */
  metadata?: Record<string, JsonValue>
}

/** Event payload persisted for run replay or audit. */
export interface PersistedRunEvent {
  id: string
  runId: string
  at: string
  type: string
  payload: JsonValue
}
