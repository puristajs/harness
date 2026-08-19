import { ValidationError } from '../errors/index.js'
import type { Message } from '../models/state.js'

/**
 * Durable conversation-history bounds.
 *
 * This policy controls stored transcript size only. It deliberately does not
 * estimate model tokens: model-visible context is selected separately by a
 * provider/model supplied token counter.
 */
export interface SessionHistoryRetentionPolicy {
  /** Keep at most this many newest complete conversation turns. */
  readonly maxTurns?: number
  /** Keep at most this many UTF-8 bytes of serialized durable messages. */
  readonly maxBytes?: number
}

/** Validates a durable-history policy without inspecting conversation content. */
export function validateSessionHistoryRetention(policy: SessionHistoryRetentionPolicy | undefined): boolean {
  if (!policy) return true
  if (policy.maxTurns === undefined && policy.maxBytes === undefined) return false
  return [policy.maxTurns, policy.maxBytes]
    .filter((value): value is number => value !== undefined)
    .every((value) => Number.isSafeInteger(value) && value >= 0)
}

/**
 * Returns the newest complete turns permitted by `policy`.
 *
 * A turn begins with any leading system messages and a user message, then
 * contains its assistant/tool work until the next user message. This keeps
 * tool calls and their results together. Imported legacy messages without a
 * user boundary are one indivisible leading turn.
 *
 * `maxBytes` is strict. A single completed turn larger than the configured
 * cap is rejected instead of silently splitting or truncating durable audit
 * data.
 */
export function retainCompleteTurns(messages: readonly Message[], policy: SessionHistoryRetentionPolicy | undefined): Message[] {
  if (!policy) return [...messages]
  if (!validateSessionHistoryRetention(policy)) {
    throw new ValidationError('Session history retention is invalid.', {
      where: 'session_history', issues: { retention: policy }
    })
  }

  const turns = partitionTurns(messages)
  let retained = policy.maxTurns === undefined ? turns.slice() : turns.slice(-policy.maxTurns)
  if (policy.maxBytes === undefined) return retained.flat()

  let bytes = retained.reduce((total, turn) => total + turnBytes(turn), 0)
  while (retained.length > 0 && bytes > policy.maxBytes) {
    const removed = retained.shift() as Message[]
    bytes -= turnBytes(removed)
  }

  // Do not split a current/only turn merely to satisfy a byte cap: that would
  // orphan tool results or leave an assistant answer without its prompt. A
  // caller who chooses this policy gets an explicit, actionable failure.
  if (turns.length > 0 && retained.length === 0 && turnBytes(turns.at(-1) as Message[]) > policy.maxBytes) {
    throw new ValidationError('The newest complete conversation turn exceeds maxBytes.', {
      where: 'session_history', issues: { maxBytes: policy.maxBytes, newestTurnBytes: turnBytes(turns.at(-1) as Message[]) }
    })
  }
  return retained.flat()
}

/** UTF-8 storage accounting for one persisted message, independent of model tokenizers. */
export function messageStorageBytes(message: Message): number {
  return Buffer.byteLength(JSON.stringify(message), 'utf8')
}

function turnBytes(turn: readonly Message[]): number {
  return turn.reduce((total, message) => total + messageStorageBytes(message), 0)
}

function partitionTurns(messages: readonly Message[]): Message[][] {
  const turns: Message[][] = []
  let leadingSystem: Message[] = []
  let current: Message[] | undefined
  for (const message of messages) {
    if (message.role === 'system') {
      // Default-agent system instructions are emitted immediately before their
      // user prompt. Close the preceding turn first so these instructions join
      // the following user turn instead of surviving as an orphaned turn.
      if (current) turns.push(current)
      current = undefined
      leadingSystem.push(message)
      continue
    }
    if (message.role === 'user') {
      if (current) turns.push(current)
      current = [...leadingSystem, message]
      leadingSystem = []
      continue
    }
    if (current) current.push(message)
    else leadingSystem.push(message)
  }
  if (current) turns.push(current)
  // Imported legacy history can contain no user boundary. Keep it intact as
  // one conservative turn rather than dropping durable audit data.
  if (leadingSystem.length > 0) turns.push(leadingSystem)
  return turns
}
