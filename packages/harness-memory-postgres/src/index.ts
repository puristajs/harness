import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool, type Pool as PgPool, type PoolClient } from 'pg'
import type { MemoryEngine, MemoryEngineContext, MemoryEngineSearchQuery, MemoryListOptions, MemoryListResult, MemoryRecord, MemoryScope, MemorySearchResult } from '@purista/harness'
import { HarnessConfigError } from '@purista/harness'

export interface PostgresMemoryEngineOptions {
  /** PostgreSQL 16+ connection URL. Exactly one of `connectionString` or `pool` is required. */
  readonly connectionString?: string
  /** Caller-owned pg Pool. Harness never closes an injected pool. */
  readonly pool?: PgPool
}

/** PostgreSQL 16+ pgvector engine. It lazily applies the package migration before the first operation. */
export function postgresMemoryEngine(options: PostgresMemoryEngineOptions): MemoryEngine<readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search', 'memory.vector_search', 'memory.hybrid_search', 'memory.persistent', 'memory.multi_instance']> {
  const ownsPool = options.pool === undefined
  if ((options.connectionString === undefined) === (options.pool === undefined)) {
    throw new HarnessConfigError('Provide exactly one of connectionString or pool for PostgreSQL memory.', { reason: 'invalid_memory_engine', path: 'memory.postgres' })
  }
  return new PostgresMemoryEngine(options.pool ?? new Pool({ connectionString: options.connectionString }), ownsPool)
}

class PostgresMemoryEngine implements MemoryEngine<readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search', 'memory.vector_search', 'memory.hybrid_search', 'memory.persistent', 'memory.multi_instance']> {
  public readonly info = Object.freeze({ id: 'postgres_memory', packageName: '@purista/harness-memory-postgres' })
  public readonly capabilities = Object.freeze(['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search', 'memory.vector_search', 'memory.hybrid_search', 'memory.persistent', 'memory.multi_instance'] as const)
  private migration: Promise<void> | undefined
  public constructor(private readonly pool: PgPool, private readonly ownsPool: boolean) {}

  public async get(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<MemoryRecord | undefined> {
    context.signal.throwIfAborted(); await this.ready()
    const rows = await this.query('select * from purista_harness_memory_records where scope_key = $1 and key = $2', [scope.scopeKey, key])
    const record = rows[0] ? row(rows[0]) : undefined
    if (record && expired(record)) { await this.delete(scope, key, context); return undefined }
    return record
  }

  public async put(scope: MemoryScope, record: MemoryRecord, context: MemoryEngineContext): Promise<void> {
    context.signal.throwIfAborted(); await this.ready()
    await this.transaction(context.signal, async (client) => {
      if (record.vector) await ensureIndexDescriptor(client, record)
      await client.query(`insert into purista_harness_memory_records(scope_key,key,value_json,created_at,updated_at,expires_at,tags_json,metadata_json,index_text,vector,index_descriptor_json)
        values($1,$2,$3::jsonb,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::vector,$11::jsonb)
        on conflict(scope_key,key) do update set value_json=excluded.value_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at,tags_json=excluded.tags_json,metadata_json=excluded.metadata_json,index_text=excluded.index_text,vector=excluded.vector,index_descriptor_json=excluded.index_descriptor_json`, values(record) as never)
    })
  }

  public async delete(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<void> { context.signal.throwIfAborted(); await this.ready(); await this.pool.query('delete from purista_harness_memory_records where scope_key = $1 and key = $2', [scope.scopeKey, key]) }

  public async list(scope: MemoryScope, options: MemoryListOptions, context: MemoryEngineContext): Promise<MemoryListResult> {
    context.signal.throwIfAborted(); await this.ready()
    const limit = options.limit ?? 20
    const after = options.cursor ? decodeCursor(options.cursor) : ''
    const records = (await this.query('select * from purista_harness_memory_records where scope_key = $1 and key > $2 and key like $3 and (expires_at is null or expires_at > now()) order by key limit $4', [scope.scopeKey, after, `${options.prefix ?? ''}%`, limit + 1])).map(row)
    const visible = records.slice(0, limit)
    return { records: visible, ...(records.length > visible.length && visible.at(-1) ? { cursor: encodeCursor(visible.at(-1)!.key) } : {}) }
  }

  public async searchText(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext): Promise<readonly MemorySearchResult[]> {
    return this.search(scope, query, context, 'text')
  }
  public async searchVector(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext): Promise<readonly MemorySearchResult[]> {
    if (!query.vector) throw new HarnessConfigError('PostgreSQL vector search requires a query vector.', { reason: 'invalid_memory_engine', path: 'memory.search.vector' })
    return this.search(scope, query, context, 'vector')
  }
  public async searchHybrid(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext): Promise<readonly MemorySearchResult[]> {
    if (!query.vector) return this.search(scope, query, context, 'text')
    return this.search(scope, query, context, 'hybrid')
  }
  public async close(): Promise<void> { if (this.ownsPool) await this.pool.end() }

  private async ready(): Promise<void> {
    this.migration ??= this.applyMigration()
    return this.migration
  }
  private async applyMigration(): Promise<void> {
    const migration = readFileSync(fileURLToPath(new URL('../migrations/001_memory.sql', import.meta.url)), 'utf8')
    for (const statement of migration.split(/;\s*(?:\r?\n|$)/).map((value) => value.trim()).filter(Boolean)) {
      await this.pool.query(statement)
    }
  }
  private async transaction(signal: AbortSignal, operation: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect()
    try { await client.query('begin'); await operation(client); await client.query('commit') } catch (error) { await client.query('rollback').catch(() => undefined); throw error } finally { client.release() }
  }
  private async search(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext, mode: 'text' | 'vector' | 'hybrid'): Promise<readonly MemorySearchResult[]> {
    context.signal.throwIfAborted(); await this.ready()
    if (query.vector) await this.assertQueryDimensions(query.vector)
    const conditions = ['scope_key = $1', '(expires_at is null or expires_at > now())']
    const params: unknown[] = [scope.scopeKey]
    const add = (value: unknown): string => { params.push(value); return `$${params.length}` }
    if (query.tags?.length) conditions.push(`tags_json @> ${add(JSON.stringify(query.tags))}::jsonb`)
    if (query.metadata) conditions.push(`metadata_json @> ${add(JSON.stringify(query.metadata))}::jsonb`)
    if (query.createdAfter) conditions.push(`created_at >= ${add(query.createdAfter)}`)
    if (query.createdBefore) conditions.push(`created_at < ${add(query.createdBefore)}`)
    if (query.updatedAfter) conditions.push(`updated_at >= ${add(query.updatedAfter)}`)
    if (query.updatedBefore) conditions.push(`updated_at < ${add(query.updatedBefore)}`)
    let score: string
    if (mode === 'text') {
      const text = add(query.text)
      score = `ts_rank_cd(to_tsvector('simple', coalesce(index_text, '')), websearch_to_tsquery('simple', ${text}))`
      conditions.push(`to_tsvector('simple', coalesce(index_text, '')) @@ websearch_to_tsquery('simple', ${text})`)
    } else {
      const vector = add(vectorLiteral(query.vector!))
      conditions.push('vector is not null')
      if (mode === 'vector') {
        score = `(1 - (vector <=> ${vector}::vector))`
      } else {
        const text = add(query.text)
        score = `(coalesce(ts_rank_cd(to_tsvector('simple', coalesce(index_text, '')), websearch_to_tsquery('simple', ${text})), 0) + (1 - (vector <=> ${vector}::vector)))`
      }
    }
    const limit = add(query.limit ?? 20)
    const result = await this.query(`select *, ${score} as memory_score from purista_harness_memory_records where ${conditions.join(' and ')} order by memory_score desc, key asc limit ${limit}`, params)
    return result.map((value) => ({ record: row(value), score: Number(value['memory_score']) }))
  }
  private async assertQueryDimensions(queryVector: readonly number[]): Promise<void> {
    assertFiniteVector(queryVector)
    const rows = await this.query('select dimensions from purista_harness_memory_index where id = 1', [])
    if (rows[0] && Number(rows[0]['dimensions']) !== queryVector.length) {
      throw new HarnessConfigError('PostgreSQL query vector dimensions differ from the persisted index. Use a new database/schema and reindex deliberately.', { reason: 'memory_index_reindex_required', path: 'memory.search.vector' })
    }
  }
  private async query(text: string, values: readonly unknown[]): Promise<Record<string, unknown>[]> { return (await this.pool.query(text, values as never)).rows as Record<string, unknown>[] }
}

function values(record: MemoryRecord): readonly unknown[] { return [record.scopeKey, record.key, JSON.stringify(record.value), record.createdAt, record.updatedAt, record.expiresAt ?? null, stringify(record.tags), stringify(record.metadata), record.indexText ?? null, record.vector ? vectorLiteral(record.vector) : null, stringify(record.indexDescriptor)] }
async function ensureIndexDescriptor(client: PoolClient, record: MemoryRecord): Promise<void> {
  const vectorValue = record.vector!
  assertFiniteVector(vectorValue)
  if (!record.indexDescriptor || record.indexDescriptor.dimensions !== vectorValue.length) {
    throw new HarnessConfigError('PostgreSQL vector records require an index descriptor with matching dimensions.', { reason: 'invalid_memory_record', path: 'memory.record.indexDescriptor' })
  }
  const descriptor = canonicalJson(record.indexDescriptor)
  const existing = await client.query('select descriptor_json, dimensions from purista_harness_memory_index where id = 1 for update')
  if (existing.rows[0]) {
    if (canonicalJson(existing.rows[0]['descriptor_json']) !== descriptor || Number(existing.rows[0]['dimensions']) !== vectorValue.length) {
      throw new HarnessConfigError('PostgreSQL memory index descriptor differs from the existing database. Use a new database/schema and reindex deliberately.', { reason: 'memory_index_reindex_required', path: 'memory.record.indexDescriptor' })
    }
    return
  }
  await client.query('insert into purista_harness_memory_index(id,descriptor_json,dimensions) values(1,$1::jsonb,$2)', [descriptor, vectorValue.length])
}
function row(value: Record<string, unknown>): MemoryRecord { return { scopeKey: text(value['scope_key']), key: text(value['key']), value: value['value_json'] as import('@purista/harness').JsonValue, createdAt: date(value['created_at']), updatedAt: date(value['updated_at']), ...(value['expires_at'] ? { expiresAt: date(value['expires_at']) } : {}), ...(value['tags_json'] ? { tags: value['tags_json'] as readonly string[] } : {}), ...(value['metadata_json'] ? { metadata: value['metadata_json'] as Record<string, import('@purista/harness').JsonValue> } : {}), ...(typeof value['index_text'] === 'string' ? { indexText: value['index_text'] } : {}), ...(value['vector'] ? { vector: vector(value['vector']) } : {}), ...(value['index_descriptor_json'] ? { indexDescriptor: value['index_descriptor_json'] as import('@purista/harness').MemoryIndexDescriptor } : {}) } }
function text(value: unknown): string { if (typeof value !== 'string') throw new Error('PostgreSQL memory row is malformed.'); return value }
function date(value: unknown): string { return value instanceof Date ? value.toISOString() : text(value) }
function stringify(value: unknown): string | null { return value === undefined ? null : JSON.stringify(value) }
function vectorLiteral(value: readonly number[]): string { return `[${value.join(',')}]` }
function vector(value: unknown): readonly number[] { return typeof value === 'string' ? value.slice(1, -1).split(',').filter(Boolean).map(Number) : value as readonly number[] }
function assertFiniteVector(value: readonly number[]): void { if (value.length === 0 || value.some((number) => !Number.isFinite(number))) throw new HarnessConfigError('PostgreSQL memory vectors must be non-empty finite number arrays.', { reason: 'invalid_memory_record', path: 'memory.record.vector' }) }
function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortJson((value as Record<string, unknown>)[key])])); return value }
function expired(record: MemoryRecord): boolean { return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now() }
function encodeCursor(key: string): string { return Buffer.from(key, 'utf8').toString('base64url') }
function decodeCursor(cursor: string): string { try { return Buffer.from(cursor, 'base64url').toString('utf8') } catch { return '' } }
