import { describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { FakeModelProvider, memoryEngineContract } from '@purista/harness/testing'
import { defineAgent, defineHarness, type MemoryEngineContext, type MemoryScope } from '@purista/harness'
import { postgresMemoryEngine } from './index.js'

function pglitePool() {
  const database = new PGlite({ extensions: { vector } })
  const query = async (text: string, values?: readonly unknown[]) => database.query(text, values as never)
  return {
    query,
    connect: async () => ({ query, release: () => undefined }),
    end: async () => database.close()
  }
}

memoryEngineContract(() => postgresMemoryEngine({ pool: pglitePool() as never }))

describe('postgresMemoryEngine', () => {
  it('publishes exact frozen metadata and binds without transferring pool ownership', async () => {
    let ended = 0
    const pool = pglitePool()
    const engine = postgresMemoryEngine({ pool: { ...pool, end: async () => { ended += 1 } } as never })
    expect(engine.info).toEqual({ id: 'postgres_memory', packageName: '@purista/harness-memory-postgres' })
    expect(engine.capabilities).toEqual([
      'memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search',
      'memory.vector_search', 'memory.hybrid_search', 'memory.persistent', 'memory.multi_instance',
    ])
    expect(Object.isFrozen(engine.info)).toBe(true)
    expect(Object.isFrozen(engine.capabilities)).toBe(true)
    const close = vi.spyOn(engine, 'close')
    const agent = defineAgent('memoryReader', { model: 'chat', instructions: 'Remember.', memory: { capabilities: ['memory.kv'] } })
    const instance = await defineHarness({ name: 'postgresMemoryHarness' }).addAgent(agent)
      .getInstance({ models: { chat: { provider: new FakeModelProvider(), model: 'fake' } }, memory: engine })
    await instance.close()
    expect(close).not.toHaveBeenCalled()
    await engine.close?.()
    expect(ended).toBe(0)
    await pool.end()
  })

  it('requires exactly one connection ownership mode', () => {
    expect(() => postgresMemoryEngine({})).toThrow(/exactly one/i)
    expect(() => postgresMemoryEngine({ connectionString: 'postgres://example', pool: pglitePool() as never })).toThrow(/exactly one/i)
  })

  it('binds only parameters used by vector search SQL', async () => {
    const queries: { text: string, values: readonly unknown[] }[] = []
    const pool = {
      query: async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values })
        if (text.includes('select dimensions from purista_harness_memory_index')) return { rows: [{ dimensions: 2 }] }
        return { rows: [] }
      }
    }
    const engine = postgresMemoryEngine({ pool: pool as never })
    const scope: MemoryScope = { kind: 'session', scopeKey: 'session/vector-query', sessionId: 'session' }
    const context = { signal: new AbortController().signal } as MemoryEngineContext

    await engine.searchVector?.(scope, { text: 'unused for vector ranking', vector: [1, 0] }, context)

    const search = queries.find(({ text }) => text.includes('memory_score'))
    expect(search?.values).toEqual([scope.scopeKey, '[1,0]', 20])
    expect(search?.text).toContain('vector <=> $2::vector')
    expect(search?.text).toContain('limit $3')
    expect(search?.text).not.toContain('$4')
  })
})
