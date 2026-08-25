import { describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { memoryEngineContract } from '@purista/harness/testing'
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
})
