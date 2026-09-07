import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeModelProvider, memoryEngineContract } from '@purista/harness/testing'
import { defineAgent, defineHarness, type MemoryEngineContext, type MemoryScope } from '@purista/harness'
import { sqliteMemoryEngine } from './index.js'

const directories: string[] = []
function file(): string { const directory = mkdtempSync(join(tmpdir(), 'purista-memory-')); directories.push(directory); return join(directory, 'memory.sqlite') }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

memoryEngineContract(() => sqliteMemoryEngine({ file: file() }))

describe('sqliteMemoryEngine', () => {
  it('publishes exact frozen local metadata and remains application-owned after runtime close', async () => {
    const engine = sqliteMemoryEngine({ file: file() })
    expect(engine.info).toEqual({ id: 'sqlite_memory', packageName: '@purista/harness-memory-sqlite' })
    expect(engine.capabilities).toEqual([
      'memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search', 'memory.persistent',
    ])
    expect(Object.isFrozen(engine.info)).toBe(true)
    expect(Object.isFrozen(engine.capabilities)).toBe(true)
    const close = vi.spyOn(engine, 'close')
    const agent = defineAgent('memoryReader', { instructions: 'Remember.', memory: { capabilities: ['memory.kv'] } })
    const instance = await defineHarness({ name: 'sqliteMemoryHarness' }).addAgent(agent)
      .getInstance({ model: { provider: new FakeModelProvider(), model: 'fake' }, memory: engine })
    await instance.close()
    expect(close).not.toHaveBeenCalled()
    await expect(engine.list({ kind: 'session', scopeKey: 'after-close', sessionId: 'after-close' }, {}, {
      signal: new AbortController().signal,
    } as MemoryEngineContext)).resolves.toMatchObject({ records: [] })
    await engine.close?.()
  })

  it('loads sqlite-vec explicitly and performs scoped exact vector search', async () => {
    if ('Bun' in globalThis) {
      expect(() => sqliteMemoryEngine({ file: file(), vector: true })).toThrow(/extension|sqlite-vec/i)
      return
    }
    const engine = sqliteMemoryEngine({ file: file(), vector: true })
    expect(engine.capabilities).toEqual([
      'memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search', 'memory.persistent',
      'memory.vector_search', 'memory.hybrid_search',
    ])
    expect(Object.isFrozen(engine.capabilities)).toBe(true)
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
