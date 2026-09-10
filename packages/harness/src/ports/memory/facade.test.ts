import { describe, expect, it } from 'vitest'

import { StateError } from '../../errors/index.js'
import type { Logger } from '../../logger/index.js'
import { RecordingTelemetry } from '../../testing/recordingTelemetry.js'
import { FakeMemoryEngine } from '../../testing/fakeMemoryEngine.js'
import type { CreateMemoryFacadeOptions, MemoryEngine } from './types.js'
import { createMemoryFacade } from './facade.js'

const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger }
}

function options(engine: MemoryEngine, overrides: Partial<CreateMemoryFacadeOptions> = {}): CreateMemoryFacadeOptions {
  return {
    engine,
    harnessName: 'memory-test',
    sessionId: 'session/one',
    runId: 'run/one',
    agentId: 'agent/one',
    identity: { tenantId: 'tenant/one', principalId: 'principal/one' },
    logger,
    telemetry: new RecordingTelemetry(),
    metrics: { counter() {}, histogram() {}, duration: async (_name, _attrs, fn) => fn() },
    contentCaptureMode: 'NO_CONTENT',
    signal: new AbortController().signal,
    ...overrides
  }
}

describe('memory facade', () => {
  it('binds canonical scopes and routes CRUD plus text search through the engine', async () => {
    const engine = new FakeMemoryEngine()
    const telemetry = new RecordingTelemetry()
    const facade = createMemoryFacade(options(engine, { telemetry }))

    await facade.session.write('note', 'find this text', {
      ttlMs: 60_000,
      tags: ['project'],
      metadata: { source: 'test' },
      index: { text: 'searchable note' }
    })
    await expect(facade.session.read('note')).resolves.toBe('find this text')
    await expect(facade.session.list({ prefix: 'no' })).resolves.toMatchObject({ records: [{ key: 'note' }] })
    await expect(facade.session.search({ text: 'searchable', mode: 'text' })).resolves.toHaveLength(1)
    await facade.session.delete('note')
    await expect(facade.session.read('note')).resolves.toBeUndefined()

    await facade.application.write('key', 1)
    await facade.tenant().write('key', 2)
    await facade.principal().write('key', 3)
    await facade.run.write('key', 4)
    await facade.agent?.write('key', 5)
    expect(engine.scopes.map((scope) => scope.scopeKey)).toContain('v1/agent/tenant=tenant%2Fone/principal=principal%2Fone/session=session%2Fone/run=run%2Fone/agent=agent%2Fone')
    expect(telemetry.spans.map((span) => span.name)).toContain('harness.memory.search')
    expect(telemetry.metrics.some((metric) => metric.name === 'harness.memory.operations')).toBe(true)
  })

  it('uses embedding vectors for semantic search and rejects an unusable response before engine I/O', async () => {
    const calls: string[] = []
    const engine: MemoryEngine = {
      info: { id: 'vector_engine', packageName: 'test' },
      capabilities: ['memory.kv', 'memory.list', 'memory.delete', 'memory.vector_search'],
      async get() { return undefined },
      async put() {},
      async delete() {},
      async list() { return { records: [] } },
      async searchVector(_scope, query) { calls.push(query.text); expect(query.vector).toEqual([0.25, 0.75]); return [] }
    }
    const facade = createMemoryFacade(options(engine, {
      embedding: {
        alias: 'embed', providerId: 'fake', model: 'small',
        async embed() { return { embeddings: [{ index: 0, vector: [0.25, 0.75] }] } }
      }
    }))
    await expect(facade.session.search({ text: 'needle', mode: 'semantic' })).resolves.toEqual([])
    expect(calls).toEqual(['needle'])

    const invalid = createMemoryFacade(options(engine, {
      embedding: {
        alias: 'embed', providerId: 'fake', model: 'small',
        async embed() { return { embeddings: [{ index: 0, vector: [Number.NaN] }] } }
      }
    }))
    await expect(invalid.session.search({ text: 'needle', mode: 'semantic' })).rejects.toMatchObject<Partial<StateError>>({
      code: 'STATE_ERROR', meta: { op: 'memory.search', memory_provider: 'vector_engine' }
    })
    expect(calls).toEqual(['needle'])
  })

  it('normalizes unknown engine failures without exposing the engine error', async () => {
    const engine: MemoryEngine = {
      info: { id: 'broken_memory', packageName: 'test' },
      capabilities: ['memory.kv', 'memory.list', 'memory.delete'],
      async get() { throw new Error('private backend failure') },
      async put() {},
      async delete() {},
      async list() { return { records: [] } }
    }
    const telemetry = new RecordingTelemetry()
    await expect(createMemoryFacade(options(engine, { telemetry })).session.read('safe')).rejects.toMatchObject<Partial<StateError>>({
      code: 'STATE_ERROR',
      meta: { op: 'memory.get', adapter: 'memory', memory_provider: 'broken_memory' }
    })
    expect(JSON.stringify(telemetry.spans)).not.toContain('private backend failure')
  })
})
