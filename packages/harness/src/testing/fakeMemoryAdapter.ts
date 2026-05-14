import { describe, expect, it } from 'vitest'
import type {
  MemoryAdapter,
  MemoryEntry,
  MemoryOpenContext,
  MemoryOperationContext,
  MemoryScope,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryStore
} from '../ports/memory.js'
import type { JsonValue } from '../models/json.js'

/** Deterministic in-memory adapter for unit tests and adapter contract examples. */
export class FakeMemoryAdapter implements MemoryAdapter {
  public readonly info = {
    id: 'fake_memory',
    packageName: '@purista/harness/testing',
    capabilities: [
      'memory.kv',
      'memory.list',
      'memory.delete',
      'memory.search',
      'memory.run',
      'memory.session',
      'memory.agent',
      'memory.user',
      'memory.tenant',
      'memory.persistent'
    ] as const
  }

  public readonly capabilities = this.info.capabilities
  public readonly openedScopes: MemoryScope[] = []
  private readonly values = new Map<string, JsonValue>()

  public configureHarnessContext(): void {
    // Fake adapter does not need inherited services, but implements the hook so contract users can assert it is called.
  }

  public async open(scope: MemoryScope, _ctx: MemoryOpenContext): Promise<MemoryStore> {
    this.openedScopes.push(scope)
    const prefix = scopeKey(scope)
    return {
      get: async <T = JsonValue>(key: string, ctx: MemoryOperationContext): Promise<T | undefined> => {
        ctx.signal.throwIfAborted()
        return this.values.get(`${prefix}:${key}`) as T | undefined
      },
      set: async (key: string, value: JsonValue, ctx: MemoryOperationContext): Promise<void> => {
        ctx.signal.throwIfAborted()
        this.values.set(`${prefix}:${key}`, value)
      },
      delete: async (key: string, ctx: MemoryOperationContext): Promise<void> => {
        ctx.signal.throwIfAborted()
        this.values.delete(`${prefix}:${key}`)
      },
      list: async (ctx: MemoryOperationContext & { opts?: { prefix?: string; limit?: number; cursor?: string } }): Promise<MemoryEntry[]> => {
        ctx.signal.throwIfAborted()
        const keys = [...this.values.keys()]
          .filter((key) => key.startsWith(`${prefix}:`))
          .map((key) => key.slice(prefix.length + 1))
          .filter((key) => !ctx.opts?.prefix || key.startsWith(ctx.opts.prefix))
          .filter((key) => !ctx.opts?.cursor || key > ctx.opts.cursor)
          .sort()
          .slice(0, ctx.opts?.limit)
        return keys.map((key) => ({ key }))
      },
      search: async (query: MemorySearchQuery, ctx: MemoryOperationContext): Promise<MemorySearchResult[]> => {
        ctx.signal.throwIfAborted()
        return [...this.values.entries()]
          .filter(([key]) => key.startsWith(`${prefix}:`))
          .map(([key, value]) => ({ key: key.slice(prefix.length + 1), value, score: JSON.stringify(value).includes(query.text) ? 1 : 0 }))
          .filter((result) => result.score > 0)
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.key.localeCompare(b.key))
          .slice(0, query.limit)
      }
    }
  }
}

/** Shared contract for memory adapters. */
export function memoryAdapterContract(make: () => MemoryAdapter | Promise<MemoryAdapter>): void {
  describe('memoryAdapterContract', () => {
    it('round-trips scoped JSON values', async () => {
      const adapter = await make()
      const ctx = contractContext()
      const store = await adapter.open({ kind: 'session', sessionId: 's1' }, ctx)
      await store.set('foo', { a: 1 }, { ...ctx, scope: { kind: 'session', sessionId: 's1' }, operation: 'set' })
      await expect(store.get('foo', { ...ctx, scope: { kind: 'session', sessionId: 's1' }, operation: 'get' })).resolves.toEqual({ a: 1 })
    })

    it('isolates scopes', async () => {
      const adapter = await make()
      const ctx = contractContext()
      const one = await adapter.open({ kind: 'session', sessionId: 's1' }, ctx)
      const two = await adapter.open({ kind: 'session', sessionId: 's2' }, ctx)
      await one.set('foo', 'one', { ...ctx, scope: { kind: 'session', sessionId: 's1' }, operation: 'set' })
      await expect(two.get('foo', { ...ctx, scope: { kind: 'session', sessionId: 's2' }, operation: 'get' })).resolves.toBeUndefined()
    })
  })
}

function scopeKey(scope: MemoryScope): string {
  return [
    scope.kind,
    scope.tenantId,
    scope.userId,
    scope.sessionId,
    scope.runId,
    scope.workflowId,
    scope.agentId
  ].filter(Boolean).join(':')
}

function contractContext(): MemoryOpenContext {
  const signal = new AbortController().signal
  return {
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => contractContext().logger },
    telemetry: {
      span: async (_name, _attrs, fn) => fn({ setAttribute: () => undefined, setAttributes: () => undefined, addEvent: () => undefined, recordException: () => undefined, setStatus: () => undefined, end: () => undefined, spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }), isRecording: () => false, updateName: () => undefined } as never),
      recordHistogram() {},
      recordCounter() {},
      currentTraceparent: () => undefined
    },
    metrics: { counter() {}, histogram() {}, duration: async (_name, _attrs, fn) => fn() },
    contentCaptureMode: 'NO_CONTENT',
    signal
  }
}
