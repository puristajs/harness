import { describe, expect, it } from 'vitest'

import {
  messageStorageBytes,
  retainCompleteTurns,
  validateSessionHistoryRetention,
  type Message,
} from '../src/index.js'

function message(id: string, role: Message['role'], content: string): Message {
  return { id, sessionId: 'history', role, content, timestamp: '2026-09-05T00:00:00.000Z' }
}

describe('v4 durable conversation-history retention', () => {
  it('retains complete newest turns without orphaning assistant or tool work', () => {
    const retained = retainCompleteTurns([
      message('u1', 'user', 'first'),
      message('a1', 'assistant', 'first answer'),
      message('t1', 'tool', 'first result'),
      message('u2', 'user', 'second'),
      message('a2', 'assistant', 'second answer'),
    ], { maxTurns: 1 })

    expect(retained.map(entry => entry.id)).toEqual(['u2', 'a2'])
  })

  it('retains eight complete turns when every message timestamp ties', () => {
    const messages = Array.from({ length: 9 }, (_, index) => [
      message(`z-user-${index}`, 'user', `question ${index}`),
      message(`a-assistant-${index}`, 'assistant', `answer ${index}`),
    ]).flat()
    const retained = retainCompleteTurns(messages, { maxTurns: 8 })
    expect(retained).toHaveLength(16)
    expect(retained.map(entry => entry.role)).toEqual(Array.from({ length: 8 }, () => ['user', 'assistant']).flat())
    expect(retained[0]?.id).toBe('z-user-1')
  })

  it('rejects an oversized newest turn instead of splitting it', () => {
    expect(() => retainCompleteTurns([
      message('u1', 'user', 'x'.repeat(500)),
      message('a1', 'assistant', 'done'),
    ], { maxBytes: 20 })).toThrow(/newest complete conversation turn/i)
  })

  it('accounts for exact UTF-8 serialized storage bytes', () => {
    const entry = message('unicode', 'user', 'Grüße 👋')
    expect(messageStorageBytes(entry)).toBe(Buffer.byteLength(JSON.stringify(entry), 'utf8'))
  })

  it('validates bounded non-negative integer policies', () => {
    expect(validateSessionHistoryRetention(undefined)).toBe(true)
    expect(validateSessionHistoryRetention({ maxTurns: 0 })).toBe(true)
    expect(validateSessionHistoryRetention({ maxBytes: 1024 })).toBe(true)
    expect(validateSessionHistoryRetention({})).toBe(false)
    expect(validateSessionHistoryRetention({ maxTurns: -1 })).toBe(false)
    expect(validateSessionHistoryRetention({ maxBytes: 1.5 })).toBe(false)
  })
})
