import { afterAll, describe, expect, it } from 'vitest'
import type { MemoryEngineContext, MemoryScope } from '@purista/harness'
import { redisMemoryEngine } from '../src/index.js'

const url = process.env['REDIS_MEMORY_URL']
const engine = url ? redisMemoryEngine({ url, namespace: `purista:harness:memory:live:${Date.now()}`, vector: { dimensions: 2 } }) : undefined
const scope: MemoryScope = { kind: 'session', scopeKey: `live/redis/${Date.now()}`, sessionId: 'live' }
const context: MemoryEngineContext = {
  logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } },
  telemetry: { span: async (_name, _attributes, operation) => operation({} as never), recordHistogram() {}, recordCounter() {}, currentTraceparent() { return undefined } },
  metrics: { counter() {}, histogram() {}, duration: async (_name, _attributes, operation) => operation() },
  contentCaptureMode: 'NO_CONTENT', signal: new AbortController().signal
}

describe.skipIf(!engine)('Redis Search live contract', () => {
  afterAll(async () => { await engine?.close?.() })

  it('creates the immutable index and supports text and exact scoped vector retrieval', async () => {
    await engine!.put(scope, { scopeKey: scope.scopeKey, key: 'release', value: { id: 'A' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), indexText: 'release planning', vector: [1, 0], indexDescriptor: { alias: 'embedding', providerId: 'test', model: 'deterministic', dimensions: 2, distance: 'cosine', extractorRevision: 'v1' } }, context)
    await expect(engine!.get(scope, 'release', context)).resolves.toMatchObject({ key: 'release' })
    await expect(engine!.searchText?.(scope, { text: 'release' }, context)).resolves.toMatchObject([{ record: { key: 'release' } }])
    await expect(engine!.searchVector?.(scope, { text: 'release', vector: [1, 0] }, context)).resolves.toMatchObject([{ record: { key: 'release' } }])
  })
})
