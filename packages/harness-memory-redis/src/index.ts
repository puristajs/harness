import { createHash } from 'node:crypto'
import {
  HarnessConfigError,
  ValidationError,
  type JsonValue,
  type MemoryEngine,
  type MemoryEngineContext,
  type MemoryEngineSearchQuery,
  type MemoryIndexDescriptor,
  type MemoryListOptions,
  type MemoryListResult,
  type MemoryRecord,
  type MemoryScope,
  type MemorySearchResult
} from '@purista/harness'

const BASE_CAPABILITIES = Object.freeze([
  'memory.kv',
  'memory.list',
  'memory.delete',
  'memory.ttl',
  'memory.text_search',
  'memory.persistent',
  'memory.multi_instance'
] as const)
const VECTOR_CAPABILITIES = Object.freeze([...BASE_CAPABILITIES, 'memory.vector_search', 'memory.hybrid_search'] as const)
const DEFAULT_NAMESPACE = 'purista:harness:memory:v1'
const NAMESPACE_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{0,127}$/
const PUT_SCRIPT = `
local existingDescriptor = redis.call('GET', KEYS[2])
if ARGV[12] ~= '' and existingDescriptor and existingDescriptor ~= ARGV[12] then
  return redis.error_reply('PURISTA_MEMORY_INDEX_DESCRIPTOR_MISMATCH')
end
if ARGV[12] ~= '' and not existingDescriptor then
  redis.call('SET', KEYS[2], ARGV[12])
end
redis.call('HSET', KEYS[1], 'scope', ARGV[1], 'key', ARGV[2], 'record', ARGV[3], 'text', ARGV[4], 'tags', ARGV[5], 'metadata', ARGV[6], 'createdAt', ARGV[7], 'updatedAt', ARGV[8])
if ARGV[9] == '1' then redis.call('HSET', KEYS[1], 'vector', ARGV[10]) else redis.call('HDEL', KEYS[1], 'vector') end
redis.call('ZADD', KEYS[3], 0, ARGV[2])
if ARGV[11] ~= '' then redis.call('PEXPIREAT', KEYS[1], ARGV[11]) else redis.call('PERSIST', KEYS[1]) end
return 1`
const DELETE_SCRIPT = `
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1`
const REMOVE_STALE_LIST_MEMBER_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('ZREM', KEYS[2], ARGV[1]) end
return 1`

type RedisArgument = string | Buffer

/** The small official node-redis surface used by this package. */
export interface RedisMemoryClient {
  readonly isOpen?: boolean
  connect?(): Promise<unknown>
  quit?(): Promise<unknown>
  sendCommand(arguments_: readonly RedisArgument[], options?: { readonly signal?: AbortSignal }): Promise<unknown>
}

/** Enables RediSearch vector fields for a fixed embedding dimension. */
export interface RedisMemoryVectorOptions {
  /** Exact dimensions of every indexed embedding. Changing it requires a new namespace. */
  readonly dimensions: number
}

/**
 * Connection and index settings for {@link redisMemoryEngine}.
 *
 * Supply exactly one of `url` or `client`. An injected client is never closed
 * by the engine. Redis Search is required because the engine owns text search.
 */
export interface RedisMemoryEngineOptions {
  readonly url?: string
  readonly client?: RedisMemoryClient
  /** A versioned, application-owned Redis key namespace. Defaults to `purista:harness:memory:v1`. */
  readonly namespace?: string
  /** Opts into vector and hybrid search with the immutable index dimension. */
  readonly vector?: RedisMemoryVectorOptions
}

/**
 * Creates a persistent, multi-instance Redis Search memory engine.
 *
 * The package imports the official `redis` client lazily only when `url` is
 * used. This keeps an injected, caller-owned client usable in specialised
 * environments while reporting a precise remediation if the package is absent.
 */
export function redisMemoryEngine(options: RedisMemoryEngineOptions & { readonly vector: RedisMemoryVectorOptions }): MemoryEngine<typeof VECTOR_CAPABILITIES>
/** Creates a Redis text-memory engine without vector-model capabilities. */
export function redisMemoryEngine(options: RedisMemoryEngineOptions): MemoryEngine<typeof BASE_CAPABILITIES>
export function redisMemoryEngine(options: RedisMemoryEngineOptions): MemoryEngine<typeof BASE_CAPABILITIES> | MemoryEngine<typeof VECTOR_CAPABILITIES> {
  validateOptions(options)
  return options.vector ? new RedisMemoryEngine(options, VECTOR_CAPABILITIES) : new RedisMemoryEngine(options, BASE_CAPABILITIES)
}

class RedisMemoryEngine<Capabilities extends typeof BASE_CAPABILITIES | typeof VECTOR_CAPABILITIES> implements MemoryEngine<Capabilities> {
  public readonly info = Object.freeze({ id: 'redis_memory', packageName: '@purista/harness-memory-redis' })
  public readonly capabilities: Capabilities
  private readonly namespace: string
  private readonly vector: RedisMemoryVectorOptions | undefined
  private readonly injectedClient: RedisMemoryClient | undefined
  private readonly url: string | undefined
  private clientPromise: Promise<RedisMemoryClient> | undefined
  private readyPromise: Promise<void> | undefined
  private closed = false

  public constructor(options: RedisMemoryEngineOptions, capabilities: Capabilities) {
    this.capabilities = capabilities
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE
    this.vector = options.vector
    this.injectedClient = options.client
    this.url = options.url
  }

  public async get(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<MemoryRecord | undefined> {
    await this.ready(context.signal)
    const raw = await this.command(['HGET', this.recordKey(scope, key), 'record'], context.signal)
    const record = raw === null ? undefined : parseRecord(raw)
    if (!record) return undefined
    assertScopedRecord(record, scope, key)
    if (!expired(record)) return record
    await this.delete(scope, key, context)
    return undefined
  }

  public async put(scope: MemoryScope, record: MemoryRecord, context: MemoryEngineContext): Promise<void> {
    await this.ready(context.signal)
    assertScopedRecord(record, scope, record.key)
    const vector = record.vector
    if (vector) this.assertVectorRecord(record)
    const expiresAt = record.expiresAt ? Date.parse(record.expiresAt) : undefined
    if (record.expiresAt && !Number.isFinite(expiresAt)) throw config('Redis memory record has an invalid expiresAt timestamp.', 'memory.record.expiresAt', 'invalid_memory_record')
    try {
      await this.command([
        'EVAL', PUT_SCRIPT, '3', this.recordKey(scope, record.key), this.descriptorKey(), this.listKey(scope),
        scopeFingerprint(scope), record.key, canonicalJson(record), record.indexText ?? '', encodeTags(record.tags), metadataTokens(record.metadata),
        String(toEpochMs(record.createdAt, 'createdAt')), String(toEpochMs(record.updatedAt, 'updatedAt')), vector ? '1' : '0', vector ? encodeVector(vector) : '', expiresAt === undefined ? '' : String(expiresAt), record.indexDescriptor ? canonicalJson(record.indexDescriptor) : ''
      ], context.signal)
    } catch (error) {
      if (/PURISTA_MEMORY_INDEX_DESCRIPTOR_MISMATCH/.test(errorMessage(error))) {
        throw config('Redis memory index descriptor differs from the existing namespace. Configure a new versioned namespace and reindex deliberately.', 'memory.record.indexDescriptor', 'memory_index_reindex_required', error)
      }
      throw error
    }
  }

  public async delete(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<void> {
    await this.ready(context.signal)
    await this.command(['EVAL', DELETE_SCRIPT, '2', this.recordKey(scope, key), this.listKey(scope), key], context.signal)
  }

  public async list(scope: MemoryScope, options: MemoryListOptions, context: MemoryEngineContext): Promise<MemoryListResult> {
    await this.ready(context.signal)
    const limit = options.limit ?? 20
    const cursor = options.cursor ? decodeListCursor(options.cursor) : undefined
    const prefix = options.prefix ?? ''
    if (cursor && !cursor.startsWith(prefix)) throw new ValidationError('Memory list cursor does not match the requested prefix.', { where: 'memory_list_options', issues: { cursor: 'prefix_mismatch' } })
    const records: MemoryRecord[] = []
    let after = cursor
    let more = false
    while (records.length <= limit) {
      const members = await this.listMembers(scope, prefix, after, Math.max(4, limit + 1), context.signal)
      if (members.length === 0) break
      for (const key of members) {
        after = key
        const raw = await this.command(['HGET', this.recordKey(scope, key), 'record'], context.signal)
        if (raw === null) {
          await this.removeStaleListMember(scope, key, context.signal)
          continue
        }
        const record = parseRecord(raw)
        assertScopedRecord(record, scope, key)
        if (expired(record)) {
          await this.delete(scope, key, context)
          continue
        }
        records.push(record)
        if (records.length > limit) { more = true; break }
      }
      if (more || members.length < Math.max(4, limit + 1)) break
    }
    const visible = records.slice(0, limit)
    const next = more && visible.at(-1) ? encodeListCursor(visible.at(-1)!.key) : undefined
    return Object.freeze({ records: Object.freeze(visible), ...(next ? { cursor: next } : {}) })
  }

  public async searchText(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext): Promise<readonly MemorySearchResult[]> {
    await this.ready(context.signal)
    return this.search(scope, query, 'text', context.signal)
  }

  public async searchVector(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext): Promise<readonly MemorySearchResult[]> {
    await this.ready(context.signal)
    if (!this.vector) throw config('Redis memory vector search was not enabled for this engine.', 'memory.search', 'missing_vector_configuration')
    this.assertQueryVector(query.vector)
    return this.search(scope, query, 'vector', context.signal)
  }

  public async searchHybrid(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext): Promise<readonly MemorySearchResult[]> {
    await this.ready(context.signal)
    if (!this.vector) throw config('Redis memory hybrid search was not enabled for this engine.', 'memory.search', 'missing_vector_configuration')
    this.assertQueryVector(query.vector)
    const [text, vector] = await Promise.all([
      this.search(scope, query, 'text', context.signal),
      this.search(scope, query, 'vector', context.signal)
    ])
    return reciprocalRankFusion([text, vector], query.limit ?? 20)
  }

  public async close(): Promise<void> {
    this.closed = true
    if (!this.injectedClient) {
      const client = this.clientPromise ? await this.clientPromise : undefined
      if (client?.quit && client.isOpen !== false) await client.quit()
    }
  }

  private async ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.closed) throw config('Redis memory engine is closed.', 'memory.engine', 'memory_engine_closed')
    this.readyPromise ??= this.initialize()
    await abortable(this.readyPromise, signal)
    signal.throwIfAborted()
  }

  private async initialize(): Promise<void> {
    const client = await this.client()
    if (client.connect && client.isOpen !== true) await client.connect()
    await this.ensureSchemaMarker(client)
    await this.ensureIndex(client)
  }

  private async client(): Promise<RedisMemoryClient> {
    if (this.injectedClient) return this.injectedClient
    this.clientPromise ??= createOfficialClient(this.url!)
    return this.clientPromise
  }

  private async ensureIndex(client: RedisMemoryClient): Promise<void> {
    try {
      await client.sendCommand(['FT.INFO', this.indexName()])
      return
    } catch (error) {
      if (isSearchUnavailable(error)) throw config('Redis Search is unavailable. Redis 8+ with Search/vector commands is required by @purista/harness-memory-redis.', 'memory.engine', 'redis_search_unavailable', error)
      if (!isUnknownIndex(error)) throw config('Redis memory index readiness failed.', 'memory.engine', 'redis_index_unavailable', error)
    }
    const schema: RedisArgument[] = [
      'FT.CREATE', this.indexName(), 'ON', 'HASH', 'PREFIX', '1', `${this.namespace}:record:`, 'SCHEMA',
      'scope', 'TAG', 'key', 'TAG', 'SORTABLE', 'text', 'TEXT', 'tags', 'TAG', 'metadata', 'TAG',
      'createdAt', 'NUMERIC', 'SORTABLE', 'updatedAt', 'NUMERIC', 'SORTABLE'
    ]
    if (this.vector) schema.push('vector', 'VECTOR', 'HNSW', '6', 'TYPE', 'FLOAT32', 'DIM', String(this.vector.dimensions), 'DISTANCE_METRIC', 'COSINE')
    try {
      await client.sendCommand(schema)
    } catch (error) {
      if (isIndexAlreadyExists(error)) return
      if (isSearchUnavailable(error)) throw config('Redis Search is unavailable. Redis 8+ with Search/vector commands is required by @purista/harness-memory-redis.', 'memory.engine', 'redis_search_unavailable', error)
      throw config('Redis memory index creation failed. Use a new versioned namespace for incompatible index changes.', 'memory.engine', 'redis_index_create_failed', error)
    }
  }

  private async ensureSchemaMarker(client: RedisMemoryClient): Promise<void> {
    const expected = canonicalJson({ version: 1, vectorDimensions: this.vector?.dimensions ?? null })
    const result = await client.sendCommand(['SET', this.schemaKey(), expected, 'NX'])
    if (asString(result) === 'OK') return
    const actual = await client.sendCommand(['GET', this.schemaKey()])
    if (asString(actual) !== expected) {
      throw config('Redis memory namespace has an incompatible index schema. Configure a new versioned namespace and reindex deliberately.', 'memory.engine.namespace', 'memory_index_reindex_required')
    }
  }

  private async command(arguments_: RedisArgument[], signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const client = await this.client()
    const response = await client.sendCommand(arguments_, { signal })
    signal.throwIfAborted()
    return response
  }

  private async listMembers(scope: MemoryScope, prefix: string, after: string | undefined, count: number, signal: AbortSignal): Promise<string[]> {
    const min = after ? `(${after}` : prefix ? `[${prefix}` : '-'
    const max = prefix ? `[${prefix}\uffff` : '+'
    const raw = await this.command(['ZRANGEBYLEX', this.listKey(scope), min, max, 'LIMIT', '0', String(count)], signal)
    if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string' && !Buffer.isBuffer(value))) throw config('Redis returned an invalid list response.', 'memory.engine', 'redis_protocol_unexpected')
    return raw.map(asString)
  }

  private async removeStaleListMember(scope: MemoryScope, key: string, signal: AbortSignal): Promise<void> {
    await this.command(['EVAL', REMOVE_STALE_LIST_MEMBER_SCRIPT, '2', this.recordKey(scope, key), this.listKey(scope), key], signal)
  }

  private async search(scope: MemoryScope, query: MemoryEngineSearchQuery, mode: 'text' | 'vector' | 'hybrid', signal: AbortSignal): Promise<readonly MemorySearchResult[]> {
    const offset = query.cursor ? decodeSearchCursor(query.cursor, mode) : 0
    const limit = query.limit ?? 20
    const terms = filters(scope, query, mode !== 'vector')
    const index = this.indexName()
    let command: RedisArgument[]
    if (mode === 'text') {
      command = ['FT.SEARCH', index, terms, 'WITHSCORES', 'RETURN', '1', 'record', 'LIMIT', String(offset), String(limit), 'DIALECT', '2']
    } else {
      const vector = encodeVector(query.vector!)
      const candidateCount = offset + limit
      const expression = `${terms}=>[KNN ${candidateCount} @vector $vector AS memory_score]`
      command = ['FT.SEARCH', index, expression, 'PARAMS', '2', 'vector', vector, 'RETURN', '2', 'record', 'memory_score', 'LIMIT', String(offset), String(limit), 'DIALECT', '2']
    }
    const reply = await this.command(command, signal)
    const decoded = decodeSearch(reply, mode === 'text')
    return Object.freeze(decoded.records.map((item) => {
      assertScopedRecord(item.record, scope, item.record.key)
      return Object.freeze(item)
    }))
  }

  private assertVectorRecord(record: MemoryRecord): void {
    if (!this.vector) throw config('Redis memory received a vector record but vector search is not configured.', 'memory.record.vector', 'missing_vector_configuration')
    if (!record.indexDescriptor || record.indexDescriptor.dimensions !== this.vector.dimensions || record.vector!.length !== this.vector.dimensions) {
      throw config('Redis memory vector dimensions do not match the configured immutable index. Configure a new versioned namespace and reindex deliberately.', 'memory.record.indexDescriptor', 'memory_index_reindex_required')
    }
    assertFiniteVector(record.vector!)
  }

  private assertQueryVector(vector: readonly number[] | undefined): asserts vector is readonly number[] {
    if (!vector || vector.length !== this.vector!.dimensions) {
      throw config('Redis memory query vector dimensions do not match the configured immutable index.', 'memory.search.vector', 'memory_index_reindex_required')
    }
    assertFiniteVector(vector)
  }

  private indexName(): string { return `${this.namespace}:index` }
  private schemaKey(): string { return `${this.namespace}:schema` }
  private descriptorKey(): string { return `${this.namespace}:descriptor` }
  private listKey(scope: MemoryScope): string { return `${this.namespace}:scope:${scopeFingerprint(scope)}:keys` }
  private recordKey(scope: MemoryScope, key: string): string { return `${this.namespace}:record:${scopeFingerprint(scope)}:${fingerprint(key)}` }
}

function validateOptions(options: RedisMemoryEngineOptions): void {
  const hasUrl = options.url !== undefined
  const hasClient = options.client !== undefined
  if (hasUrl === hasClient) throw config('Redis memory requires exactly one of url or client.', 'memory.engine', 'invalid_redis_memory_options')
  if (hasUrl && (!options.url || options.url.trim().length === 0)) throw config('Redis memory url must be non-empty.', 'memory.engine.url', 'invalid_redis_memory_options')
  const namespace = options.namespace ?? DEFAULT_NAMESPACE
  if (!NAMESPACE_PATTERN.test(namespace)) throw config('Redis memory namespace must be a versioned Redis-safe identifier.', 'memory.engine.namespace', 'invalid_redis_memory_options')
  if (options.vector && (!Number.isInteger(options.vector.dimensions) || options.vector.dimensions <= 0 || options.vector.dimensions > 65535)) {
    throw config('Redis memory vector.dimensions must be an integer between 1 and 65535.', 'memory.engine.vector.dimensions', 'invalid_redis_memory_options')
  }
}

async function createOfficialClient(url: string): Promise<RedisMemoryClient> {
  try {
    const moduleName: string = 'redis'
    const imported = await import(moduleName) as unknown as { createClient?: (options: { readonly url: string }) => RedisMemoryClient }
    if (typeof imported.createClient !== 'function') throw new Error('createClient export is unavailable')
    return imported.createClient({ url })
  } catch (error) {
    throw config('The official redis client is unavailable. Install redis@^6.2.1 or inject a compatible caller-owned client.', 'memory.engine.url', 'redis_client_unavailable', error)
  }
}

function filters(scope: MemoryScope, query: MemoryEngineSearchQuery, includeText: boolean): string {
  const clauses = [`@scope:{${scopeFingerprint(scope)}}`]
  if (includeText) clauses.push(`@text:(${textTerms(query.text)})`)
  for (const tag of query.tags ?? []) clauses.push(`@tags:{${escapeTag(tag)}}`)
  for (const [key, value] of Object.entries(query.metadata ?? {})) clauses.push(`@metadata:{${escapeTag(metadataToken(key, value))}}`)
  if (query.createdAfter || query.createdBefore) clauses.push(`@createdAt:[${query.createdAfter ? toEpochMs(query.createdAfter, 'createdAfter') : '-inf'} ${query.createdBefore ? toEpochMs(query.createdBefore, 'createdBefore') : '+inf'}]`)
  if (query.updatedAfter || query.updatedBefore) clauses.push(`@updatedAt:[${query.updatedAfter ? toEpochMs(query.updatedAfter, 'updatedAfter') : '-inf'} ${query.updatedBefore ? toEpochMs(query.updatedBefore, 'updatedBefore') : '+inf'}]`)
  return clauses.join(' ')
}

function textTerms(text: string): string {
  const words = text.match(/[\p{L}\p{N}_-]+/gu)
  if (!words || words.length === 0) throw new ValidationError('Memory search text has no searchable terms.', { where: 'memory_search_query', issues: { text: 'no_searchable_terms' } })
  return words.map(escapeText).join(' ')
}

function decodeSearch(raw: unknown, withScores: boolean): { readonly total: number; readonly records: readonly MemorySearchResult[] } {
  if (Array.isArray(raw)) return decodeSearchResp2(raw, withScores)
  const totalRaw = field(raw, 'total_results') ?? field(raw, 'total')
  const resultsRaw = field(raw, 'results') ?? field(raw, 'documents')
  const results = mapLikeValues(resultsRaw)
  if (totalRaw === undefined || results === undefined) throw config('Redis returned an invalid search response.', 'memory.engine', 'redis_protocol_unexpected')
  const total = Number(totalRaw)
  if (!Number.isSafeInteger(total) || total < 0) throw config('Redis returned an invalid search result count.', 'memory.engine', 'redis_protocol_unexpected')
  const records: MemorySearchResult[] = []
  for (const result of results) {
    const recordRaw = searchResultField(result, 'record')
    if (recordRaw === undefined) throw config('Redis Search result lacks the canonical record field.', 'memory.engine', 'redis_protocol_unexpected')
    const score = withScores ? number(field(result, 'score')) : number(searchResultField(result, 'memory_score'))
    records.push(Object.freeze({ record: parseRecord(recordRaw), ...(score === undefined ? {} : { score }) }))
  }
  return Object.freeze({ total, records: Object.freeze(records) })
}

function decodeSearchResp2(raw: readonly unknown[], withScores: boolean): { readonly total: number; readonly records: readonly MemorySearchResult[] } {
  if (raw.length === 0) throw config('Redis returned an invalid search response.', 'memory.engine', 'redis_protocol_unexpected')
  const total = Number(raw[0])
  if (!Number.isSafeInteger(total) || total < 0) throw config('Redis returned an invalid search result count.', 'memory.engine', 'redis_protocol_unexpected')
  const records: MemorySearchResult[] = []
  let index = 1
  while (index < raw.length) {
    index += 1 // document id is intentionally opaque to this package
    const score = withScores ? number(raw[index++]) : undefined
    const fields = raw[index++]
    const recordRaw = field(fields, 'record')
    if (recordRaw === undefined) throw config('Redis Search result lacks the canonical record field.', 'memory.engine', 'redis_protocol_unexpected')
    const vectorScore = withScores ? score : number(field(fields, 'memory_score'))
    records.push(Object.freeze({ record: parseRecord(recordRaw), ...(vectorScore === undefined ? {} : { score: vectorScore }) }))
  }
  return Object.freeze({ total, records: Object.freeze(records) })
}

function searchResultField(result: unknown, name: string): unknown {
  const direct = field(result, name)
  if (direct !== undefined) return direct
  for (const container of ['extra_attributes', 'extraAttributes', 'values', 'value']) {
    const nested = field(field(result, container), name)
    if (nested !== undefined) return nested
  }
  return undefined
}

function field(fields: unknown, name: string): unknown {
  if (fields instanceof Map) {
    for (const [key, value] of fields) if (asString(key) === name) return value
    return undefined
  }
  if (Array.isArray(fields)) {
    for (let index = 0; index < fields.length; index += 2) if (asString(fields[index]) === name) return fields[index + 1]
    return undefined
  }
  if (fields && typeof fields === 'object') return (fields as Record<string, unknown>)[name]
  return undefined
}

function mapLikeValues(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value
  if (value instanceof Map) return [...value.values()]
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) return Object.values(value)
  return undefined
}

function parseRecord(raw: unknown): MemoryRecord {
  try {
    const parsed = JSON.parse(asString(raw)) as MemoryRecord
    if (!parsed || typeof parsed !== 'object' || typeof parsed.scopeKey !== 'string' || typeof parsed.key !== 'string' || typeof parsed.createdAt !== 'string' || typeof parsed.updatedAt !== 'string') {
      throw new Error('missing required record fields')
    }
    return parsed
  } catch (error) {
    throw config('Redis memory contains an invalid canonical record.', 'memory.engine', 'redis_record_invalid', error)
  }
}

function assertScopedRecord(record: MemoryRecord, scope: MemoryScope, key: string): void {
  if (record.scopeKey !== scope.scopeKey || record.key !== key) throw config('Redis memory returned a record outside its requested scope.', 'memory.engine', 'redis_scope_integrity_error')
}

function metadataTokens(metadata: Readonly<Record<string, JsonValue>> | undefined): string {
  return Object.entries(metadata ?? {}).map(([key, value]) => metadataToken(key, value)).join(',')
}

function metadataToken(key: string, value: JsonValue): string {
  return `${Buffer.from(key, 'utf8').toString('base64url')}.${Buffer.from(canonicalJson(value), 'utf8').toString('base64url')}`
}

function encodeTags(tags: readonly string[] | undefined): string { return (tags ?? []).map(escapeStoredTag).join(',') }
function escapeStoredTag(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll(',', '\\,') }
function escapeTag(value: string): string { return value.replace(/[\\$%{}\[\]()|\-@~:\s]/g, '\\$&') }
function escapeText(value: string): string { return value.replace(/[\\@{}\[\]()|\-~*%]/g, '\\$&') }
function scopeFingerprint(scope: MemoryScope): string { return fingerprint(scope.scopeKey) }
function fingerprint(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex') }
function encodeVector(vector: readonly number[]): Buffer { assertFiniteVector(vector); const binary = Buffer.allocUnsafe(vector.length * 4); vector.forEach((value, index) => binary.writeFloatLE(value, index * 4)); return binary }
function assertFiniteVector(vector: readonly number[]): void { if (vector.some((value) => !Number.isFinite(value))) throw config('Redis memory vectors must contain finite numbers.', 'memory.record.vector', 'invalid_memory_record') }
function expired(record: MemoryRecord): boolean { return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now() }
function toEpochMs(value: string, fieldName: string): number { const epoch = Date.parse(value); if (!Number.isFinite(epoch)) throw new ValidationError(`Memory ${fieldName} must be an ISO timestamp.`, { where: 'memory_search_query', issues: { [fieldName]: 'invalid_timestamp' } }); return epoch }
function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortJson((value as Record<string, unknown>)[key])])); return value }
function encodeListCursor(key: string): string { return Buffer.from(key, 'utf8').toString('base64url') }
function decodeListCursor(cursor: string): string { try { const key = Buffer.from(cursor, 'base64url').toString('utf8'); if (!key) throw new Error('empty'); return key } catch (error) { throw new ValidationError('Invalid Redis memory list cursor.', { where: 'memory_list_options', issues: { cursor: 'invalid' } }, error) } }
function decodeSearchCursor(cursor: string, mode: string): number { try { const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { mode?: string; offset?: unknown }; const offset = parsed.offset; if (parsed.mode !== mode || !Number.isInteger(offset) || typeof offset !== 'number' || offset < 0) throw new Error('invalid'); return offset } catch (error) { throw new ValidationError('Invalid Redis memory search cursor.', { where: 'memory_search_query', issues: { cursor: 'invalid' } }, error) } }
function asString(value: unknown): string { if (typeof value === 'string') return value; if (Buffer.isBuffer(value)) return value.toString('utf8'); if (typeof value === 'number') return String(value); throw config('Redis returned an invalid protocol value.', 'memory.engine', 'redis_protocol_unexpected') }
function number(value: unknown): number | undefined { if (value === undefined) return undefined; const parsed = Number(asString(value)); if (!Number.isFinite(parsed)) throw config('Redis returned an invalid score.', 'memory.engine', 'redis_protocol_unexpected'); return parsed }
function isUnknownIndex(error: unknown): boolean { return /unknown index name|no such index/i.test(errorMessage(error)) }
function isIndexAlreadyExists(error: unknown): boolean { return /index already exists/i.test(errorMessage(error)) }
function isSearchUnavailable(error: unknown): boolean { return /unknown command|unknown subcommand|search module|ft\.(info|create)/i.test(errorMessage(error)) }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function reciprocalRankFusion(sources: readonly (readonly MemorySearchResult[])[], limit: number): readonly MemorySearchResult[] {
  const ranked = new Map<string, { record: MemorySearchResult['record']; score: number }>()
  for (const source of sources) source.forEach((result, index) => {
    const previous = ranked.get(result.record.key)
    ranked.set(result.record.key, { record: result.record, score: (previous?.score ?? 0) + 1 / (61 + index) })
  })
  return Object.freeze([...ranked.values()].sort((left, right) => right.score - left.score).slice(0, limit).map((result) => Object.freeze(result)))
}
function config(message: string, path: string, reason: string, cause?: unknown): HarnessConfigError { return new HarnessConfigError(message, { reason, path }, cause) }
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> { signal.throwIfAborted(); return new Promise<T>((resolve, reject) => { const onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }); promise.then((value) => { signal.removeEventListener('abort', onAbort); resolve(value) }, (error) => { signal.removeEventListener('abort', onAbort); reject(error) }) }) }
