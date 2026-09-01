import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { memoryEngineContract } from '@purista/harness/testing'
import type { MemoryEngineContext, MemoryScope } from '@purista/harness'
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
