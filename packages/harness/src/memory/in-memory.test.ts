import { describe, expect, it, vi } from 'vitest'

import type { MemoryScope } from '../ports/memory.js'
import { inMemoryMemoryEngine } from './in-memory.js'

const scope: MemoryScope = { kind: 'session', scopeKey: 'session/s1', sessionId: 's1' }
const context = () => ({
  logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } },
  telemetry: { span: async <T>(_name: string, _attrs: Record<string, unknown>, fn: (span: never) => Promise<T>) => fn({} as never), recordHistogram() {}, recordCounter() {}, currentTraceparent: () => undefined },
  metrics: { counter() {}, histogram() {}, duration: async <T>(_name: string, _attrs: Record<string, unknown> | undefined, fn: () => Promise<T>) => fn() },
  contentCaptureMode: 'NO_CONTENT' as const,
  signal: new AbortController().signal
})

describe('in-memory memory engine', () => {
  it('pages ordered live records and removes expired entries as it reads them', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const engine = inMemoryMemoryEngine()
      const ctx = context()
      for (const key of ['c', 'a', 'b']) {
        await engine.put(scope, { scopeKey: scope.scopeKey, key, value: key, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, ctx)
      }
      await engine.put(scope, { scopeKey: scope.scopeKey, key: 'expired', value: 'expired', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() }, ctx)

      const first = await engine.list(scope, { limit: 2 }, ctx)
      expect(first.records.map((record) => record.key)).toEqual(['a', 'b'])
      expect(first.cursor).toBeDefined()
      const second = await engine.list(scope, { cursor: first.cursor }, ctx)
      expect(second.records.map((record) => record.key)).toEqual(['c'])
      await expect(engine.get(scope, 'expired', ctx)).resolves.toBeUndefined()

      await engine.delete(scope, 'a', ctx)
      await expect(engine.get(scope, 'a', ctx)).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
