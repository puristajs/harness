import { afterAll, describe, expect, it } from 'vitest'
import type { MemoryEngineContext, MemoryScope } from '@purista/harness'
import { postgresMemoryEngine } from '../src/index.js'

const connectionString = process.env['POSTGRES_MEMORY_URL']
const context: MemoryEngineContext = {
  logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } },
  telemetry: { span: async (_name, _attributes, operation) => operation({} as never), recordHistogram() {}, recordCounter() {}, currentTraceparent() { return undefined } },
  metrics: { counter() {}, histogram() {}, duration: async (_name, _attributes, operation) => operation() },
  contentCaptureMode: 'NO_CONTENT', signal: new AbortController().signal
}
const engine = connectionString ? postgresMemoryEngine({ connectionString }) : undefined
const scope: MemoryScope = { kind: 'session', scopeKey: `live/postgres/${Date.now()}`, sessionId: 'live' }

describe.skipIf(!engine)('PostgreSQL + pgvector live contract', () => {
  afterAll(async () => { await engine?.close?.() })

  it('migrates, persists, and searches within a scope', async () => {
    await engine!.put(scope, { scopeKey: scope.scopeKey, key: 'release', value: { id: 'A' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), indexText: 'release planning', vector: [1, 0], indexDescriptor: { alias: 'embedding', providerId: 'test', model: 'deterministic', dimensions: 2, distance: 'cosine', extractorRevision: 'v1' } }, context)
    await expect(engine!.get(scope, 'release', context)).resolves.toMatchObject({ key: 'release' })
    await expect(engine!.searchVector?.(scope, { text: 'release', vector: [1, 0] }, context)).resolves.toMatchObject([{ record: { key: 'release' } }])
    await engine!.delete(scope, 'release', context)
  })
})
