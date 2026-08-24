import type { JsonValue } from './json.js'

/** Session-level metadata persisted by a state store. */
export interface SessionRecord {
  id: string
  createdAt: string
  updatedAt: string
  runCount: number
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
 * - `succeeded`: run completed successfully
 * - `failed`: run completed with error
 * - `cancelled`: run cancelled before completion
 */
export type RunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled'

/** Serialized error payload stored on run records. */
export interface SerializedError {
  code: string
  message: string
  category?: string
  retriable?: boolean
  meta?: Record<string, unknown>
}

/** Run record persisted by state stores. */
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
}

/** Event payload persisted for run replay or audit. */
export interface PersistedRunEvent {
  id: string
  runId: string
  at: string
  type: string
  payload: JsonValue
}
