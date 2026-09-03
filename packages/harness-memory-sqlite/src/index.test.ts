import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryEngineContract } from '@purista/harness/testing'
import type { MemoryEngineContext, MemoryScope } from '@purista/harness'
import { sqliteMemoryEngine } from './index.js'

const directories: string[] = []
function file(): string { const directory = mkdtempSync(join(tmpdir(), 'purista-memory-')); directories.push(directory); return join(directory, 'memory.sqlite') }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

memoryEngineContract(() => sqliteMemoryEngine({ file: file() }))

describe('sqliteMemoryEngine', () => {
  it('loads sqlite-vec explicitly and performs scoped exact vector search', async () => {
    if ('Bun' in globalThis) {
      expect(() => sqliteMemoryEngine({ file: file(), vector: true })).toThrow(/extension|sqlite-vec/i)
      return
    }
    const engine = sqliteMemoryEngine({ file: file(), vector: true })
    const scope: MemoryScope = { kind: 'session', scopeKey: 'session/a', sessionId: 'a' }
    const context: MemoryEngineContext = {
      logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } },
      telemetry: { span: async (_name, _attributes, operation) => operation({} as never), recordHistogram() {}, recordCounter() {}, currentTraceparent() { return undefined } },
      metrics: { counter() {}, histogram() {}, duration: async (_name, _attributes, operation) => operation() },
      contentCaptureMode: 'NO_CONTENT', signal: new AbortController().signal
    }
    await engine.put(scope, { scopeKey: scope.scopeKey, key: 'release', value: { id: 'A' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), indexText: 'release planning', vector: [1, 0], indexDescriptor: { alias: 'embedding', providerId: 'test', model: 'deterministic', dimensions: 2, distance: 'cosine', extractorRevision: 'v1' } }, context)
    await expect(engine.searchVector?.(scope, { text: 'release', vector: [1, 0] }, context)).resolves.toMatchObject([{ record: { key: 'release' } }])
    await engine.close?.()
  })
})
