import { describe, expect, it } from 'vitest'
import type { MemoryEngine, MemoryEngineContext, MemoryListOptions, MemoryListResult, MemoryRecord, MemoryScope } from '../ports/memory.js'

/** Deterministic text-search engine for unit tests and vendor-engine contract suites. */
export class FakeMemoryEngine implements MemoryEngine<readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search']> {
  public readonly info = Object.freeze({ id: 'fake_memory', packageName: '@purista/harness/testing' })
  public readonly capabilities = Object.freeze(['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search'] as const)
  public readonly scopes: MemoryScope[] = []
  private readonly records = new Map<string, MemoryRecord>()

  public async get(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<MemoryRecord | undefined> {
    context.signal.throwIfAborted()
    this.scopes.push(scope)
    const record = this.records.get(keyFor(scope, key))
    return record && !expired(record) ? record : undefined
  }
  public async put(scope: MemoryScope, record: MemoryRecord, context: MemoryEngineContext): Promise<void> {
    context.signal.throwIfAborted(); this.scopes.push(scope); this.records.set(keyFor(scope, record.key), record)
  }
  public async delete(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<void> {
    context.signal.throwIfAborted(); this.scopes.push(scope); this.records.delete(keyFor(scope, key))
  }
  public async list(scope: MemoryScope, options: MemoryListOptions, context: MemoryEngineContext): Promise<MemoryListResult> {
    context.signal.throwIfAborted(); this.scopes.push(scope)
    const records = [...this.records.values()].filter((record) => record.scopeKey === scope.scopeKey && !expired(record) && (!options.prefix || record.key.startsWith(options.prefix))).sort((a, b) => a.key.localeCompare(b.key)).slice(0, options.limit)
    return { records }
  }
  public async searchText(scope: MemoryScope, query: { text: string; limit?: number }, context: MemoryEngineContext) {
    context.signal.throwIfAborted(); this.scopes.push(scope)
    return [...this.records.values()]
      .filter((record) => record.scopeKey === scope.scopeKey && !expired(record) && (record.indexText ?? JSON.stringify(record.value)).includes(query.text))
      .slice(0, query.limit)
      .map((record) => ({ record, score: 1 }))
  }
}

/** Shared non-provider contract. Vendor packages should run this unchanged. */
export function memoryEngineContract(make: () => MemoryEngine | Promise<MemoryEngine>): void {
  describe('memoryEngineContract', () => {
    const scope: MemoryScope = { kind: 'session', scopeKey: 'test/session', sessionId: 's1' }
    const record: MemoryRecord = { scopeKey: scope.scopeKey, key: 'foo', value: { a: 1 }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    it('round-trips canonical records', async () => {
      const engine = await make(); const context = contractContext()
      await engine.put(scope, record, context)
      await expect(engine.get(scope, 'foo', context)).resolves.toEqual(record)
    })
    it('isolates scopes', async () => {
      const engine = await make(); const context = contractContext()
      await engine.put(scope, record, context)
      await expect(engine.get({ ...scope, scopeKey: 'test/other', sessionId: 's2' }, 'foo', context)).resolves.toBeUndefined()
    })
    it('deletes canonical records', async () => {
      const engine = await make(); const context = contractContext()
      await engine.put(scope, record, context)
      await engine.delete(scope, record.key, context)
      await expect(engine.get(scope, record.key, context)).resolves.toBeUndefined()
    })
    it('returns a bounded, cursor-paginated list', async () => {
      const engine = await make(); const context = contractContext()
      await engine.put(scope, { ...record, key: 'a' }, context)
      await engine.put(scope, { ...record, key: 'b' }, context)
      await engine.put(scope, { ...record, key: 'c' }, context)
      const first = await engine.list(scope, { limit: 2 }, context)
      expect(first.records.map((item) => item.key)).toEqual(['a', 'b'])
      expect(first.cursor).toBeDefined()
      const cursor = first.cursor
      if (!cursor) throw new Error('Memory engine did not return the required next cursor.')
      await expect(engine.list(scope, { limit: 2, cursor }, context)).resolves.toMatchObject({ records: [{ key: 'c' }] })
    })
    it('does not reveal expired records', async () => {
      const engine = await make(); const context = contractContext()
      await engine.put(scope, { ...record, key: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' }, context)
      await expect(engine.get(scope, 'expired', context)).resolves.toBeUndefined()
      await expect(engine.list(scope, {}, context)).resolves.toMatchObject({ records: [] })
    })
    it('honors an already-aborted operation signal', async () => {
      const engine = await make()
      const controller = new AbortController()
      controller.abort(new Error('test cancellation'))
      await expect(engine.get(scope, record.key, { ...contractContext(), signal: controller.signal })).rejects.toBeDefined()
    })
  })
}

function keyFor(scope: MemoryScope, key: string): string { return `${scope.scopeKey}\u0000${key}` }
function expired(record: MemoryRecord): boolean { return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now() }
function contractContext(): MemoryEngineContext {
  const signal = new AbortController().signal
  return {
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => contractContext().logger },
    telemetry: { span: async (_name, _attrs, fn) => fn({ setAttribute() {}, setAttributes() {}, addEvent() {}, recordException() {}, setStatus() {}, end() {}, spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }), isRecording: () => false, updateName() {} } as never), recordHistogram() {}, recordCounter() {}, currentTraceparent: () => undefined },
    metrics: { counter() {}, histogram() {}, duration: async (_name, _attrs, fn) => fn() }, contentCaptureMode: 'NO_CONTENT', signal
  }
}
