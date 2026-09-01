import { describe, expect, it } from 'vitest'
import { HarnessConfigError, type MemoryEngineContext, type MemoryIndexDescriptor, type MemoryRecord, type MemoryScope } from '@purista/harness'
import { memoryEngineContract } from '@purista/harness/testing'
import { redisMemoryEngine, type RedisMemoryClient } from './index.js'

const scope: MemoryScope = { kind: 'session', scopeKey: 'tenant-a/session-1', sessionId: 'session-1' }

memoryEngineContract(() => redisMemoryEngine({ client: new FakeRedisClient() }))

describe('redisMemoryEngine', () => {
  it('uses one atomic script for the canonical record, scope list, TTL, and Search-indexed fields', async () => {
    const client = new FakeRedisClient()
    const engine = redisMemoryEngine({ client })
    await engine.put(scope, record({ indexText: 'hello reliable redis', tags: ['support'], metadata: { category: 'incident' } }), context())

    const script = client.commands.find((command) => command[0] === 'EVAL')
    expect(script).toBeDefined()
    expect(script?.[2]).toBe('3')
    expect(client.commands.some((command) => command[0] === 'HSET')).toBe(false)
    expect(client.commands.some((command) => command[0] === 'ZADD')).toBe(false)
    expect(client.commands.some((command) => command[0] === 'FT.CREATE')).toBe(true)
  })

  it('keeps scopes isolated for text search and emits only the scope fingerprint in the search query', async () => {
    const client = new FakeRedisClient()
    const engine = redisMemoryEngine({ client })
    await engine.put(scope, record({ indexText: 'redis incident response' }), context())
    await engine.put({ ...scope, scopeKey: 'tenant-b/session-1' }, record({ scopeKey: 'tenant-b/session-1', indexText: 'redis incident response' }), context())

    if (!engine.searchText) throw new Error('Expected Redis text search implementation.')
    const results = await engine.searchText(scope, { text: 'redis incident', limit: 10 }, context())

    expect(results).toHaveLength(1)
    expect(results[0]?.record.scopeKey).toBe(scope.scopeKey)
    const command = client.commands.findLast((item) => item[0] === 'FT.SEARCH')
    expect(command?.[2]).toContain('@scope:{')
    expect(command?.[2]).not.toContain(scope.scopeKey)
  })

  it('lists canonical records by logical key and removes stale list members atomically', async () => {
    const client = new FakeRedisClient()
    const engine = redisMemoryEngine({ client })
    await engine.put(scope, record({ key: 'a' }), context())
    await engine.put(scope, record({ key: 'b' }), context())
    client.removeRecordButKeepListMember('b')

    const listed = await engine.list(scope, { limit: 10 }, context())

    expect(listed.records.map((item) => item.key)).toEqual(['a'])
    expect(client.commands.some((command) => command[0] === 'EVAL' && String(command[1]).includes("EXISTS"))).toBe(true)
  })

  it('enforces fixed vector dimensions and uses Redis vector queries for semantic and hybrid modes', async () => {
    const client = new FakeRedisClient()
    const engine = redisMemoryEngine({ client, vector: { dimensions: 3 } })
    const indexed = record({ vector: [0.1, 0.2, 0.3], indexDescriptor: descriptor(3), indexText: 'redis search' })
    await engine.put(scope, indexed, context())

    if (!engine.searchVector || !engine.searchHybrid) throw new Error('Expected Redis vector search implementation.')
    await expect(engine.searchVector(scope, { text: 'redis', vector: [0.1, 0.2, 0.3], limit: 1 }, context())).resolves.toHaveLength(1)
    await expect(engine.searchHybrid(scope, { text: 'redis', vector: [0.1, 0.2, 0.3], limit: 1 }, context())).resolves.toHaveLength(1)
    await expect(engine.put(scope, record({ vector: [0.1, 0.2], indexDescriptor: descriptor(2) }), context())).rejects.toMatchObject({ meta: { reason: 'memory_index_reindex_required' } })
    await expect(engine.put(scope, record({ key: 'other', vector: [0.1, 0.2, 0.3], indexDescriptor: { ...descriptor(3), model: 'different' } }), context())).rejects.toMatchObject({ meta: { reason: 'memory_index_reindex_required' } })
    const vectorCommand = client.commands.find((command) => command[0] === 'FT.SEARCH' && String(command[2]).includes('KNN'))
    expect(vectorCommand).toBeDefined()
    expect(vectorCommand?.some((value) => Buffer.isBuffer(value))).toBe(true)
  })

  it('decodes default RESP3 Search replies from the official Redis client', async () => {
    const client = new Resp3FakeRedisClient()
    const engine = redisMemoryEngine({ client, vector: { dimensions: 3 } })
    await engine.put(scope, record({ vector: [0.1, 0.2, 0.3], indexDescriptor: descriptor(3), indexText: 'redis search' }), context())

    await expect(engine.searchText?.(scope, { text: 'redis', limit: 1 }, context())).resolves.toMatchObject([{ record: { key: 'entry' } }])
    await expect(engine.searchVector?.(scope, { text: 'redis', vector: [0.1, 0.2, 0.3], limit: 1 }, context())).resolves.toMatchObject([{ record: { key: 'entry' } }])
  })

  it('fails closed for invalid connection ownership and never closes an injected client', async () => {
    expect(() => redisMemoryEngine({})).toThrow(HarnessConfigError)
    expect(() => redisMemoryEngine({ url: 'redis://localhost:6379', client: new FakeRedisClient() })).toThrow(HarnessConfigError)

    const client = new FakeRedisClient()
    const engine = redisMemoryEngine({ client })
    if (!engine.close) throw new Error('Expected Redis close implementation.')
    await engine.close()
    expect(client.quitCalls).toBe(0)
  })

  it('does not issue a mutation after caller cancellation', async () => {
    const client = new FakeRedisClient()
    const engine = redisMemoryEngine({ client })
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))

    await expect(engine.put(scope, record(), context(controller.signal))).rejects.toThrow('cancelled')
    expect(client.commands).toHaveLength(0)
  })
})

class FakeRedisClient implements RedisMemoryClient {
  public readonly commands: Array<readonly (string | Buffer)[]> = []
  public readonly isOpen = true
  public quitCalls = 0
  private index = false
  private schema: string | undefined
  private descriptor: string | undefined
  private readonly hashes = new Map<string, Map<string, string | Buffer>>()
  private readonly lists = new Map<string, Set<string>>()

  public async quit(): Promise<void> { this.quitCalls += 1 }

  public async sendCommand(arguments_: readonly (string | Buffer)[]): Promise<unknown> {
    this.commands.push([...arguments_])
    const command = asString(arguments_[0]).toUpperCase()
    if (command === 'FT.INFO') {
      if (!this.index) throw new Error('Unknown Index name')
      return ['index_name', arguments_[1] ?? '']
    }
    if (command === 'FT.CREATE') { this.index = true; return 'OK' }
    if (command === 'SET') {
      if (!this.schema) { this.schema = asString(arguments_[2]); return 'OK' }
      return null
    }
    if (command === 'GET') return this.schema ?? null
    if (command === 'HGET') return this.hashes.get(asString(arguments_[1]))?.get(asString(arguments_[2])) ?? null
    if (command === 'ZRANGEBYLEX') return this.range(arguments_)
    if (command === 'FT.SEARCH') return this.search(arguments_)
    if (command === 'EVAL') return this.eval(arguments_)
    throw new Error(`Unsupported fake Redis command: ${command}`)
  }

  public removeRecordButKeepListMember(key: string): void {
    for (const [recordKey, hash] of this.hashes) if (hash.get('key') === key) this.hashes.delete(recordKey)
  }

  private eval(arguments_: readonly (string | Buffer)[]): number {
    const script = asString(arguments_[1])
    const keys = Number(arguments_[2])
    if (keys === 3) {
      const recordKey = asString(arguments_[3])
      const descriptorKey = asString(arguments_[4])
      const listKey = asString(arguments_[5])
      const values = arguments_.slice(6)
      const descriptor = asString(values[11])
      if (descriptor) {
        if (this.descriptor && this.descriptor !== descriptor) throw new Error('PURISTA_MEMORY_INDEX_DESCRIPTOR_MISMATCH')
        this.descriptor ??= descriptor
      }
      const hash = new Map<string, string | Buffer>([
        ['scope', asString(values[0])], ['key', asString(values[1])], ['record', asString(values[2])], ['text', asString(values[3])], ['tags', asString(values[4])], ['metadata', asString(values[5])], ['createdAt', asString(values[6])], ['updatedAt', asString(values[7])]
      ])
      if (asString(values[8]) === '1') hash.set('vector', values[9] as Buffer)
      this.hashes.set(recordKey, hash)
      const members = this.lists.get(listKey) ?? new Set<string>()
      members.add(asString(values[1]))
      this.lists.set(listKey, members)
      void descriptorKey
      return 1
    }
    const recordKey = asString(arguments_[3])
    const listKey = asString(arguments_[4])
    const key = asString(arguments_[5])
    if (script.includes('EXISTS')) {
      if (!this.hashes.has(recordKey)) this.lists.get(listKey)?.delete(key)
      return 1
    }
    this.hashes.delete(recordKey)
    this.lists.get(listKey)?.delete(key)
    return 1
  }

  private range(arguments_: readonly (string | Buffer)[]): string[] {
    const members = [...(this.lists.get(asString(arguments_[1])) ?? [])].sort()
    const min = asString(arguments_[2])
    const max = asString(arguments_[3])
    const count = Number(arguments_[6])
    return members.filter((member) => {
      const lower = min === '-' || (min.startsWith('(') ? member > min.slice(1) : member >= min.slice(1))
      const upper = max === '+' || member <= max.slice(1).replace('\uffff', '') || member.startsWith(max.slice(1).replace('\uffff', ''))
      return lower && upper
    }).slice(0, count)
  }

  private search(arguments_: readonly (string | Buffer)[]): unknown[] {
    const query = asString(arguments_[2])
    const scopeMatch = /@scope:\{([^}]+)\}/.exec(query)
    const scopeHash = scopeMatch?.[1]
    const withScores = arguments_.some((value) => asString(value) === 'WITHSCORES')
    const matching = [...this.hashes.entries()].filter(([, hash]) => hash.get('scope') === scopeHash)
    const response: unknown[] = [matching.length]
    for (const [key, hash] of matching) {
      response.push(key)
      if (withScores) response.push('1')
      response.push(withScores ? ['record', hash.get('record')!] : ['record', hash.get('record')!, 'memory_score', '0.25'])
    }
    return response
  }
}

class Resp3FakeRedisClient extends FakeRedisClient {
  public override async sendCommand(arguments_: readonly (string | Buffer)[]): Promise<unknown> {
    const raw = await super.sendCommand(arguments_)
    if (asString(arguments_[0]).toUpperCase() !== 'FT.SEARCH' || !Array.isArray(raw)) return raw
    const withScores = arguments_.some((value) => asString(value) === 'WITHSCORES')
    const results: Record<string, unknown>[] = []
    let index = 1
    while (index < raw.length) {
      const id = raw[index++]
      const score = withScores ? raw[index++] : undefined
      const fields = raw[index++] as readonly unknown[]
      results.push({ id, ...(score === undefined ? {} : { score }), extra_attributes: Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, item) => [asString(fields[item * 2] as string | Buffer), fields[item * 2 + 1]])) })
    }
    return { total_results: raw[0], results }
  }
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    scopeKey: scope.scopeKey,
    key: 'entry',
    value: { message: 'hello' },
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...overrides
  }
}

function descriptor(dimensions: number): MemoryIndexDescriptor {
  return { alias: 'memoryEmbedding', providerId: 'fake', model: 'test', dimensions, distance: 'cosine', extractorRevision: 'harness.string-or-explicit-text.v1' }
}

function context(signal = new AbortController().signal): MemoryEngineContext {
  return {
    signal,
    contentCaptureMode: 'NO_CONTENT',
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => context().logger },
    telemetry: { span: async (_name, _attrs, fn) => fn({} as never), recordHistogram() {}, recordCounter() {}, currentTraceparent: () => undefined },
    metrics: { counter() {}, histogram() {}, duration: async (_name, _attrs, fn) => fn() }
  }
}

function asString(value: string | Buffer | undefined): string { return Buffer.isBuffer(value) ? value.toString('utf8') : value ?? '' }
