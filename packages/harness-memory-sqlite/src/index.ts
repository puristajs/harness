import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
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

const BASE_CAPABILITIES = Object.freeze(['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search', 'memory.persistent'] as const)
const VECTOR_CAPABILITIES = Object.freeze([...BASE_CAPABILITIES, 'memory.vector_search', 'memory.hybrid_search'] as const)

export interface SqliteMemoryEngineOptions {
  /** Database file. Its parent directory is created when the engine opens. */
  readonly file: string
  /** Opt into exact local vector search through the optional `sqlite-vec@0.1.9` peer. */
  readonly vector?: boolean
}

type SqlValue = string | number | bigint | Uint8Array | null
type SqlRow = Record<string, unknown>
type Statement = { get(...params: SqlValue[]): unknown; all(...params: SqlValue[]): unknown[]; run(...params: SqlValue[]): unknown }
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void; loadExtension?(path: string, entrypoint?: string): void; enableLoadExtension?(allow: boolean): void }

/** Opens a local SQLite memory engine with FTS5 and exact sqlite-vec retrieval. */
export function sqliteMemoryEngine(options: SqliteMemoryEngineOptions & { readonly vector: true }): MemoryEngine<typeof VECTOR_CAPABILITIES>
/** Opens a local SQLite memory engine with FTS5 and no optional native dependency. */
export function sqliteMemoryEngine(options: SqliteMemoryEngineOptions): MemoryEngine<typeof BASE_CAPABILITIES>
export function sqliteMemoryEngine(options: SqliteMemoryEngineOptions): MemoryEngine<typeof BASE_CAPABILITIES> | MemoryEngine<typeof VECTOR_CAPABILITIES> {
  if (!options.file || options.file.trim().length === 0) throw config('SQLite memory requires a non-empty file path.', 'memory.file', 'invalid_memory_engine')
  const engine = new SqliteMemoryEngine(options.file, options.vector === true)
  return options.vector ? engine as MemoryEngine<typeof VECTOR_CAPABILITIES> : engine as unknown as MemoryEngine<typeof BASE_CAPABILITIES>
}

class SqliteMemoryEngine implements MemoryEngine<typeof VECTOR_CAPABILITIES> {
  public readonly info = Object.freeze({ id: 'sqlite_memory', packageName: '@purista/harness-memory-sqlite' })
  public readonly capabilities: typeof VECTOR_CAPABILITIES
  private readonly db: Database
  private readonly vectorEnabled: boolean

  public constructor(file: string, vectorEnabled: boolean) {
    this.vectorEnabled = vectorEnabled
    this.capabilities = vectorEnabled ? VECTOR_CAPABILITIES : BASE_CAPABILITIES as unknown as typeof VECTOR_CAPABILITIES
    mkdirSync(dirname(file), { recursive: true })
    this.db = openDatabase(file, vectorEnabled)
    try {
      if (vectorEnabled) loadSqliteVec(this.db)
      this.initializeSchema()
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  public async get(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<MemoryRecord | undefined> {
    context.signal.throwIfAborted()
    const row = this.one('select * from harness_memory_records where scope_key = ? and key = ?', scope.scopeKey, key)
    const record = row ? toRecord(row) : undefined
    if (record && expired(record)) { this.deleteSync(scope.scopeKey, key); return undefined }
    return record
  }

  public async put(scope: MemoryScope, record: MemoryRecord, context: MemoryEngineContext): Promise<void> {
    context.signal.throwIfAborted()
    assertRecordScope(record, scope)
    if (record.vector && !this.vectorEnabled) throw config('SQLite vector memory is not enabled. Recreate the engine with vector: true and install sqlite-vec@0.1.9.', 'memory.record.vector', 'missing_vector_configuration')
    this.transaction(() => {
      if (record.vector) this.ensureVectorLayout(record)
      this.run(`insert into harness_memory_records(scope_key,key,value_json,created_at,updated_at,expires_at,tags_json,metadata_json,index_text,vector_json,index_descriptor_json)
        values(?,?,?,?,?,?,?,?,?,?,?) on conflict(scope_key,key) do update set value_json=excluded.value_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at,tags_json=excluded.tags_json,metadata_json=excluded.metadata_json,index_text=excluded.index_text,vector_json=excluded.vector_json,index_descriptor_json=excluded.index_descriptor_json`,
      record.scopeKey, record.key, JSON.stringify(record.value), record.createdAt, record.updatedAt, record.expiresAt ?? null, json(record.tags), json(record.metadata), record.indexText ?? null, json(record.vector), json(record.indexDescriptor))
      this.run('delete from harness_memory_fts where scope_key = ? and key = ?', record.scopeKey, record.key)
      if (record.indexText) this.run('insert into harness_memory_fts(scope_key,key,text) values(?,?,?)', record.scopeKey, record.key, record.indexText)
      if (this.vectorTableExists()) {
        const id = this.recordId(record.scopeKey, record.key)
        this.run('delete from harness_memory_vectors where rowid = ?', BigInt(id))
        if (record.vector) this.run('insert into harness_memory_vectors(rowid,embedding,scope_key) values(?,?,?)', BigInt(id), encodeVector(record.vector), record.scopeKey)
      }
    })
  }

  public async delete(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<void> { context.signal.throwIfAborted(); this.deleteSync(scope.scopeKey, key) }

  public async list(scope: MemoryScope, options: MemoryListOptions, context: MemoryEngineContext): Promise<MemoryListResult> {
    context.signal.throwIfAborted()
    const after = options.cursor ? decodeCursor(options.cursor) : ''
    const prefix = options.prefix ?? ''
    const limit = options.limit ?? 20
    const all = this.all('select * from harness_memory_records where scope_key = ? and key > ? and key like ? order by key limit ?', scope.scopeKey, after, `${prefix}%`, limit + 1).map(toRecord)
    const records = all.filter((record) => !expired(record))
    for (const record of all.filter(expired)) this.deleteSync(scope.scopeKey, record.key)
    const visible = records.slice(0, limit)
    return Object.freeze({ records: Object.freeze(visible), ...(records.length > visible.length && visible.at(-1) ? { cursor: encodeCursor(visible.at(-1)!.key) } : {}) })
  }

  public async searchText(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext): Promise<readonly MemorySearchResult[]> {
    context.signal.throwIfAborted()
    if (!query.text?.trim()) throw new ValidationError('Text memory search requires a non-empty query.', { where: 'memory_search_query', issues: { text: 'required' } })
    const expression = query.text.trim().split(/\s+/u).map(escapeFtsTerm).join(' AND ')
    const rows = this.all('select r.*, bm25(harness_memory_fts) as rank from harness_memory_fts f join harness_memory_records r on r.scope_key = f.scope_key and r.key = f.key where f.scope_key = ? and f.text match ? order by rank limit ?', scope.scopeKey, expression, query.limit ?? 20)
    return Object.freeze(rows.map(toRecord).filter((record) => !expired(record) && matches(record, query)).map((record, index) => Object.freeze({ record, score: 1 / (index + 1) })))
  }

  public async searchVector(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext): Promise<readonly MemorySearchResult[]> {
    context.signal.throwIfAborted()
    if (!this.vectorEnabled) throw config('SQLite vector memory is not enabled. Recreate the engine with vector: true.', 'memory.search', 'missing_vector_configuration')
    if (!query.vector) throw new ValidationError('Vector memory search requires a query vector.', { where: 'memory_search_query', issues: { vector: 'required' } })
    assertFiniteVector(query.vector)
    const dimensions = this.vectorDimensions()
    if (dimensions === undefined) return Object.freeze([])
    if (query.vector.length !== dimensions) throw config('SQLite query vector dimensions differ from the persisted index. Use a new memory database and reindex deliberately.', 'memory.search.vector', 'memory_index_reindex_required')
    const rows = this.all('with matches as (select rowid, distance from harness_memory_vectors where embedding match ? and k = ? and scope_key = ?) select r.*, matches.distance from matches join harness_memory_records r on r.id = matches.rowid order by matches.distance', encodeVector(query.vector), query.limit ?? 20, scope.scopeKey)
    return Object.freeze(rows.map((row) => ({ record: toRecord(row), distance: number(row['distance']) })).filter(({ record }) => !expired(record) && matches(record, query)).map(({ record, distance }) => Object.freeze({ record, score: 1 / (1 + distance) })))
  }

  public async searchHybrid(scope: MemoryScope, query: MemoryEngineSearchQuery, context: MemoryEngineContext): Promise<readonly MemorySearchResult[]> {
    const [text, vector] = await Promise.all([query.text?.trim() ? this.searchText(scope, query, context) : Promise.resolve<readonly MemorySearchResult[]>([]), this.searchVector(scope, query, context)])
    const ranked = new Map<string, { record: MemoryRecord; score: number }>()
    for (const source of [text, vector]) source.forEach((result, index) => {
      const existing = ranked.get(result.record.key)
      ranked.set(result.record.key, { record: result.record, score: (existing?.score ?? 0) + 1 / (61 + index) })
    })
    return Object.freeze([...ranked.values()].sort((left, right) => right.score - left.score).slice(0, query.limit ?? 20).map((result) => Object.freeze(result)))
  }

  public async close(): Promise<void> { this.db.close() }

  private initializeSchema(): void {
    try {
      this.db.exec(`pragma journal_mode = WAL; pragma busy_timeout = 5000;
        create table if not exists harness_memory_records(id integer primary key, scope_key text not null, key text not null, value_json text not null, created_at text not null, updated_at text not null, expires_at text, tags_json text, metadata_json text, index_text text, vector_json text, index_descriptor_json text, unique(scope_key, key));
        create table if not exists harness_memory_meta(name text primary key, value text not null);
        create index if not exists idx_harness_memory_records_scope_key on harness_memory_records(scope_key, key);
        create virtual table if not exists harness_memory_fts using fts5(scope_key unindexed, key unindexed, text);`)
      const columns = this.all('pragma table_info(harness_memory_records)').map((row) => String(row['name']))
      if (!columns.includes('id')) throw config('SQLite memory database uses an incompatible schema. Create a new memory file and migrate records deliberately.', 'memory.file', 'sqlite_schema_incompatible')
    } catch (error) {
      if (error instanceof HarnessConfigError) throw error
      throw config('SQLite FTS5 is unavailable in this runtime. Use a SQLite build with FTS5 enabled.', 'memory.engine', 'sqlite_fts_unavailable', error)
    }
  }

  private ensureVectorLayout(record: MemoryRecord): void {
    const vector = record.vector!
    assertFiniteVector(vector)
    if (!record.indexDescriptor || record.indexDescriptor.dimensions !== vector.length) throw config('SQLite vector records require an index descriptor with matching dimensions.', 'memory.record.indexDescriptor', 'invalid_memory_record')
    const descriptor = canonicalJson(record.indexDescriptor)
    const persistedDescriptor = this.meta('index_descriptor')
    if (persistedDescriptor && persistedDescriptor !== descriptor) throw config('SQLite memory index descriptor differs from the existing database. Use a new database file and reindex deliberately.', 'memory.record.indexDescriptor', 'memory_index_reindex_required')
    if (!persistedDescriptor) this.setMeta('index_descriptor', descriptor)
    const dimensions = this.vectorDimensions()
    if (dimensions !== undefined && dimensions !== vector.length) throw config('SQLite vector dimensions differ from the existing database. Use a new database file and reindex deliberately.', 'memory.record.vector', 'memory_index_reindex_required')
    if (dimensions === undefined) {
      this.setMeta('vector_dimensions', String(vector.length))
      this.db.exec(`create virtual table harness_memory_vectors using vec0(embedding float[${vector.length}] distance_metric=cosine, scope_key text partition key)`)
    }
  }

  private vectorTableExists(): boolean { return this.vectorDimensions() !== undefined }
  private vectorDimensions(): number | undefined { const value = this.meta('vector_dimensions'); return value === undefined ? undefined : Number(value) }
  private meta(name: string): string | undefined { const row = this.one('select value from harness_memory_meta where name = ?', name); return row ? string(row, 'value') : undefined }
  private setMeta(name: string, value: string): void { this.run('insert into harness_memory_meta(name,value) values(?,?) on conflict(name) do update set value=excluded.value', name, value) }
  private recordId(scopeKey: string, key: string): number { const row = this.one('select id from harness_memory_records where scope_key = ? and key = ?', scopeKey, key); if (!row) throw config('SQLite memory could not resolve the just-written record id.', 'memory.engine', 'sqlite_protocol_unexpected'); return number(row['id']) }
  private one(sql: string, ...params: SqlValue[]): SqlRow | undefined { const row = this.db.prepare(sql).get(...params); return row && typeof row === 'object' ? row as SqlRow : undefined }
  private all(sql: string, ...params: SqlValue[]): SqlRow[] { return this.db.prepare(sql).all(...params).filter((row): row is SqlRow => Boolean(row && typeof row === 'object')) }
  private run(sql: string, ...params: SqlValue[]): void { this.db.prepare(sql).run(...params) }
  private transaction(operation: () => void): void { this.db.exec('begin immediate'); try { operation(); this.db.exec('commit') } catch (error) { this.db.exec('rollback'); throw error } }
  private deleteSync(scopeKey: string, key: string): void { this.transaction(() => { const row = this.one('select id from harness_memory_records where scope_key = ? and key = ?', scopeKey, key); if (row && this.vectorTableExists()) this.run('delete from harness_memory_vectors where rowid = ?', BigInt(number(row['id']))); this.run('delete from harness_memory_records where scope_key = ? and key = ?', scopeKey, key); this.run('delete from harness_memory_fts where scope_key = ? and key = ?', scopeKey, key) }) }
}

function openDatabase(file: string, allowExtension: boolean): Database {
  const require = createRequire(import.meta.url)
  const isBun = Boolean((globalThis as { Bun?: unknown }).Bun)
  try {
    const loaded = require(isBun ? 'bun:sqlite' : 'node:sqlite') as { Database?: new(file: string, options?: { allowExtension?: boolean }) => Database; DatabaseSync?: new(file: string, options?: { allowExtension?: boolean }) => Database }
    const Constructor = loaded.DatabaseSync ?? loaded.Database
    if (!Constructor) throw new Error('missing SQLite constructor')
    return new Constructor(file, isBun ? undefined : { allowExtension })
  } catch (error) { throw config('The built-in SQLite driver is unavailable in this runtime.', 'memory.file', 'sqlite_unavailable', error) }
}

function loadSqliteVec(db: Database): void {
  if (!db.loadExtension) throw config('This SQLite runtime does not permit extension loading. In Bun, configure Database.setCustomSQLite(...) with an extension-capable SQLite build before enabling vector memory.', 'memory.vector', 'sqlite_vector_extension_unavailable')
  const require = createRequire(import.meta.url)
  try {
    const sqliteVec = require('sqlite-vec') as { load?: (database: { loadExtension(path: string): void }) => void }
    if (typeof sqliteVec.load !== 'function') throw new Error('sqlite-vec does not expose load()')
    sqliteVec.load(db as { loadExtension(path: string): void })
    const version = db.prepare('select vec_version() as version').get()
    if (!version || typeof version !== 'object') throw new Error('vec_version() is unavailable')
    db.enableLoadExtension?.(false)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = /cannot find module|sqlite-vec/i.test(message) && /module|install|not found/i.test(message) ? 'sqlite_vector_dependency_missing' : 'sqlite_vector_extension_unavailable'
    throw config(reason === 'sqlite_vector_dependency_missing' ? 'SQLite vector memory requires sqlite-vec@0.1.9. Install it with npm install sqlite-vec@0.1.9.' : 'sqlite-vec could not be loaded by this runtime. Verify the platform-native sqlite-vec package and SQLite extension policy; Bun on macOS requires Database.setCustomSQLite(...).', 'memory.vector', reason, error)
  }
}

function toRecord(row: SqlRow): MemoryRecord { return { scopeKey: string(row, 'scope_key'), key: string(row, 'key'), value: parseJson(row['value_json']), createdAt: string(row, 'created_at'), updatedAt: string(row, 'updated_at'), ...(optionalString(row['expires_at']) ? { expiresAt: optionalString(row['expires_at'])! } : {}), ...(row['tags_json'] ? { tags: parseJson(row['tags_json']) as readonly string[] } : {}), ...(row['metadata_json'] ? { metadata: parseJson(row['metadata_json']) as Record<string, JsonValue> } : {}), ...(optionalString(row['index_text']) ? { indexText: optionalString(row['index_text'])! } : {}), ...(row['vector_json'] ? { vector: parseJson(row['vector_json']) as readonly number[] } : {}), ...(row['index_descriptor_json'] ? { indexDescriptor: parseJson(row['index_descriptor_json']) as unknown as MemoryIndexDescriptor } : {}) } }
function assertRecordScope(record: MemoryRecord, scope: MemoryScope): void { if (record.scopeKey !== scope.scopeKey) throw config('SQLite memory received a record outside the requested scope.', 'memory.record.scopeKey', 'sqlite_scope_integrity_error') }
function string(row: SqlRow, key: string): string { const value = row[key]; if (typeof value !== 'string') throw config('SQLite memory returned an invalid row.', 'memory.engine', 'sqlite_protocol_unexpected'); return value }
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw config('SQLite memory returned an invalid numeric value.', 'memory.engine', 'sqlite_protocol_unexpected'); return value }
function optionalString(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function parseJson(value: unknown): JsonValue { try { return JSON.parse(typeof value === 'string' ? value : 'null') as JsonValue } catch (error) { throw config('SQLite memory contains invalid JSON.', 'memory.engine', 'sqlite_protocol_unexpected', error) } }
function json(value: unknown): string | null { return value === undefined ? null : JSON.stringify(value) }
function encodeVector(vector: readonly number[]): Uint8Array { assertFiniteVector(vector); return new Uint8Array(new Float32Array(vector).buffer) }
function assertFiniteVector(vector: readonly number[]): void { if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) throw new ValidationError('Memory vectors must be non-empty finite number arrays.', { where: 'memory_search_query', issues: { vector: 'invalid' } }) }
function expired(record: MemoryRecord): boolean { return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now() }
function matches(record: MemoryRecord, query: MemoryEngineSearchQuery): boolean { const createdAt = Date.parse(record.createdAt); const updatedAt = Date.parse(record.updatedAt); return (!query.tags || query.tags.every((tag) => record.tags?.includes(tag))) && (!query.metadata || Object.entries(query.metadata).every(([key, value]) => canonicalJson(record.metadata?.[key]) === canonicalJson(value))) && (!query.createdAfter || createdAt >= Date.parse(query.createdAfter)) && (!query.createdBefore || createdAt <= Date.parse(query.createdBefore)) && (!query.updatedAfter || updatedAt >= Date.parse(query.updatedAfter)) && (!query.updatedBefore || updatedAt <= Date.parse(query.updatedBefore)) }
function escapeFtsTerm(value: string): string { return `"${value.replaceAll('"', '""')}"` }
function canonicalJson(value: unknown): string { return JSON.stringify(sortJson(value)) }
function sortJson(value: unknown): unknown { if (Array.isArray(value)) return value.map(sortJson); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortJson((value as Record<string, unknown>)[key])])); return value }
function encodeCursor(key: string): string { return Buffer.from(key, 'utf8').toString('base64url') }
function decodeCursor(cursor: string): string { try { const value = Buffer.from(cursor, 'base64url').toString('utf8'); if (!value) throw new Error('empty'); return value } catch (error) { throw new ValidationError('Invalid SQLite memory list cursor.', { where: 'memory_list_options', issues: { cursor: 'invalid' } }, error) } }
function config(message: string, path: string, reason: string, cause?: unknown): HarnessConfigError { return new HarnessConfigError(message, { reason, path }, cause) }
