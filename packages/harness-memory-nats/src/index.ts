import { createHash } from 'node:crypto'
import { jetstream, StorageType } from '@nats-io/jetstream'
import { Kvm, type KV, type KvEntry, type KvStatus } from '@nats-io/kv'
import { connect, type NatsConnection, type NodeConnectionOptions } from '@nats-io/transport-node'
import {
  HarnessConfigError,
  isHarnessError,
  OperationCancelledError,
  StateError,
  type JsonValue,
  type MemoryEngine,
  type MemoryEngineContext,
  type MemoryListOptions,
  type MemoryListResult,
  type MemoryRecord,
  type MemoryScope,
} from '@purista/harness'

const PACKAGE_NAME = '@purista/harness-memory-nats'
const ENGINE_ID = 'nats_memory'
const SCHEMA_VERSION = 'v1'
const SCHEMA_METADATA_KEY = 'purista.harness.memory.schema'
const DEFAULT_BUCKET = 'purista-harness-memory-v1'
const DEFAULT_MAX_ENUMERATED_KEYS = 10_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Connection options used only when this engine creates the NATS connection. */
export type NatsMemoryConnectionOptions = Omit<NodeConnectionOptions, 'servers'>

interface NatsMemorySharedOptions {
  /** JetStream KV bucket. Existing buckets must match this engine's v1 layout. */
  readonly bucket?: string
  /** Creates the bucket when it does not exist. Defaults to `true`. */
  readonly createBucket?: boolean
  /** Hard upper bound for scoped KV enumeration. Defaults to `10000`. */
  readonly maxEnumeratedKeys?: number
  /** JetStream replication factor for a newly created bucket. Defaults to `1`. */
  readonly replicas?: 1 | 3 | 5
}

/** Options that let the engine own a connection created through the official NATS Node/Bun transport. */
export interface NatsMemoryEngineServersOptions extends NatsMemorySharedOptions {
  readonly servers: string | readonly string[]
  readonly connection?: never
  readonly connectionOptions?: NatsMemoryConnectionOptions
}

/** Options that reuse an application-owned NATS connection. The engine never closes it. */
export interface NatsMemoryEngineConnectionOptions extends NatsMemorySharedOptions {
  readonly connection: NatsConnection
  readonly servers?: never
  readonly connectionOptions?: never
}

/** Configuration for a KV-only NATS JetStream memory engine. Exactly one connection source is required. */
export type NatsMemoryEngineOptions = NatsMemoryEngineServersOptions | NatsMemoryEngineConnectionOptions

interface ResolvedOptions {
  readonly bucket: string
  readonly createBucket: boolean
  readonly maxEnumeratedKeys: number
  readonly replicas: 1 | 3 | 5
  readonly servers?: string | readonly string[]
  readonly connection?: NatsConnection
  readonly connectionOptions?: NatsMemoryConnectionOptions
}

/**
 * Creates a persistent, multi-instance memory engine over NATS JetStream KV.
 *
 * The engine intentionally supports only key/value, list, delete, and lazy TTL
 * visibility. It never advertises text, vector, or hybrid relevance search.
 */
export function natsMemoryEngine(
  options: NatsMemoryEngineOptions,
): MemoryEngine<readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.persistent', 'memory.multi_instance']> {
  return new NatsMemoryEngine(resolveOptions(options))
}

class NatsMemoryEngine implements MemoryEngine<readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.persistent', 'memory.multi_instance']> {
  public readonly info = Object.freeze({ id: ENGINE_ID, packageName: PACKAGE_NAME })
  public readonly capabilities = Object.freeze([
    'memory.kv',
    'memory.list',
    'memory.delete',
    'memory.ttl',
    'memory.persistent',
    'memory.multi_instance',
  ] as const)

  private connection: NatsConnection | undefined
  private kv: KV | undefined
  private opening: Promise<KV> | undefined
  private closed = false

  public constructor(private readonly options: ResolvedOptions) {}

  public async get(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<MemoryRecord | undefined> {
    return this.operation('memory.get', context, async (kv) => {
      const entry = await kv.get(storageKey(scope, key))
      if (entry === null) return undefined
      const record = decodeEntry(entry, scope)
      if (!expired(record)) return record
      await this.deleteExpired(kv, entry, context.signal)
      return undefined
    })
  }

  public async put(scope: MemoryScope, record: MemoryRecord, context: MemoryEngineContext): Promise<void> {
    return this.operation('memory.set', context, async (kv) => {
      assertRecordScope(scope, record)
      const key = storageKey(scope, record.key)
      const value = encoder.encode(encodeRecord(record))
      const existing = await kv.get(key)
      assertNotAborted(context.signal)
      if (existing === null) {
        await kv.create(key, value)
      } else {
        await kv.update(key, value, existing.revision)
      }
    })
  }

  public async delete(scope: MemoryScope, key: string, context: MemoryEngineContext): Promise<void> {
    return this.operation('memory.delete', context, async (kv) => {
      await kv.delete(storageKey(scope, key))
    })
  }

  public async list(scope: MemoryScope, options: MemoryListOptions, context: MemoryEngineContext): Promise<MemoryListResult> {
    return this.operation('memory.list', context, async (kv) => {
      const keys = await this.enumerateScopeKeys(kv, scope, context.signal)
      const records: ListedRecord[] = []
      for (const key of keys) {
        assertNotAborted(context.signal)
        const entry = await kv.get(key)
        if (entry === null) continue
        const record = decodeEntry(entry, scope)
        if (expired(record)) {
          await this.deleteExpired(kv, entry, context.signal)
          continue
        }
        if (options.prefix !== undefined && !record.key.startsWith(options.prefix)) continue
        records.push({ record, keyHash: hash(record.key) })
      }

      records.sort((left, right) => left.record.key.localeCompare(right.record.key))
      const start = cursorStart(records, options.cursor)
      const limit = options.limit ?? 20
      const page = records.slice(start, start + limit)
      const last = page.at(-1)
      return {
        records: page.map((entry) => entry.record),
        ...(last !== undefined && start + page.length < records.length ? { cursor: encodeCursor(last.keyHash) } : {}),
      }
    })
  }

  public async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.kv = undefined
    this.opening = undefined
    const connection = this.connection
    this.connection = undefined
    if (connection === undefined || this.options.connection !== undefined) return
    try {
      await connection.drain()
      await connection.close()
    } catch (error) {
      throw new StateError('NATS memory connection shutdown failed.', {
        op: 'memory.delete',
        adapter: 'memory',
        memory_provider: ENGINE_ID,
        reason: 'nats_connection_shutdown_failed',
      }, error)
    }
  }

  private async operation<T>(
    operation: 'memory.get' | 'memory.set' | 'memory.delete' | 'memory.list',
    context: MemoryEngineContext,
    action: (kv: KV) => Promise<T>,
  ): Promise<T> {
    assertNotAborted(context.signal)
    try {
      const value = await action(await this.getBucket(context.signal))
      assertNotAborted(context.signal)
      return value
    } catch (error) {
      if (isHarnessError(error)) throw error
      if (isAbortError(error, context.signal)) {
        throw new OperationCancelledError('NATS memory operation was cancelled.', { scope: 'memory' }, error)
      }
      throw new StateError('NATS memory operation failed.', {
        op: operation,
        adapter: 'memory',
        memory_provider: ENGINE_ID,
        reason: 'nats_operation_failed',
      }, error)
    }
  }

  private async getBucket(signal: AbortSignal): Promise<KV> {
    assertNotAborted(signal)
    if (this.closed) {
      throw new StateError('NATS memory engine is closed.', {
        op: 'memory.get',
        adapter: 'memory',
        memory_provider: ENGINE_ID,
        reason: 'nats_engine_closed',
      })
    }
    if (this.kv !== undefined) return this.kv
    this.opening ??= this.openBucket(signal)
    try {
      this.kv = await this.opening
      return this.kv
    } catch (error) {
      this.opening = undefined
      throw error
    }
  }

  private async openBucket(signal: AbortSignal): Promise<KV> {
    const connection = await this.getConnection(signal)
    if (!connection.info?.jetstream) {
      await this.closeOwnedConnectionAfterFailedOpen(connection)
      throw natsStateError('memory.get', 'nats_jetstream_unavailable', 'NATS JetStream is required for NATS memory.')
    }
    try {
      const kvm = new Kvm(jetstream(connection))
      const kv = this.options.createBucket
        ? await kvm.create(this.options.bucket, bucketOptions(this.options.replicas))
        : await kvm.open(this.options.bucket)
      assertNotAborted(signal)
      validateBucket(await kv.status(), this.options)
      return kv
    } catch (error) {
      if (isHarnessError(error)) throw error
      await this.closeOwnedConnectionAfterFailedOpen(connection)
      throw new StateError('NATS memory bucket is unavailable or incompatible.', {
        op: 'memory.get',
        adapter: 'memory',
        memory_provider: ENGINE_ID,
        reason: 'nats_bucket_incompatible',
      }, error)
    }
  }

  private async getConnection(signal: AbortSignal): Promise<NatsConnection> {
    assertNotAborted(signal)
    if (this.connection !== undefined) return this.connection
    if (this.options.connection !== undefined) {
      this.connection = this.options.connection
      return this.connection
    }
    try {
      this.connection = await connect({
        ...this.options.connectionOptions,
        ...(typeof this.options.servers === 'string' ? { servers: this.options.servers } : { servers: [...this.options.servers ?? []] }),
      })
      return this.connection
    } catch (error) {
      if (isAbortError(error, signal)) throw new OperationCancelledError('NATS memory connection was cancelled.', { scope: 'memory' }, error)
      throw new StateError('NATS memory could not establish a connection.', {
        op: 'memory.get',
        adapter: 'memory',
        memory_provider: ENGINE_ID,
        reason: 'nats_connection_unavailable',
      }, error)
    }
  }

  private async enumerateScopeKeys(kv: KV, scope: MemoryScope, signal: AbortSignal): Promise<readonly string[]> {
    const keys: string[] = []
    const iterator = await kv.keys(scopePattern(scope))
    for await (const key of iterator) {
      assertNotAborted(signal)
      keys.push(key)
      if (keys.length > this.options.maxEnumeratedKeys) {
        throw natsStateError('memory.list', 'nats_enumeration_limit_exceeded', 'NATS memory enumeration exceeded its configured safety limit.')
      }
    }
    return keys
  }

  private async deleteExpired(kv: KV, entry: KvEntry, signal: AbortSignal): Promise<void> {
    assertNotAborted(signal)
    try {
      await kv.delete(entry.key, { previousSeq: entry.revision })
    } catch (error) {
      if (isAbortError(error, signal)) throw new OperationCancelledError('NATS memory operation was cancelled.', { scope: 'memory' }, error)
      // A replacement between read and delete is expected. Its revision is preserved.
      if (isRevisionConflict(error)) return
      throw error
    }
  }

  private async closeOwnedConnectionAfterFailedOpen(connection: NatsConnection): Promise<void> {
    if (this.options.connection !== undefined || this.connection !== connection) return
    this.connection = undefined
    try {
      await connection.close()
    } catch {
      // Preserve the actionable initialization failure without leaking driver output.
    }
  }
}

interface ListedRecord {
  readonly record: MemoryRecord
  readonly keyHash: string
}

function resolveOptions(options: NatsMemoryEngineOptions): ResolvedOptions {
  const hasServers = 'servers' in options && options.servers !== undefined
  const hasConnection = 'connection' in options && options.connection !== undefined
  if (hasServers === hasConnection) {
    throw new HarnessConfigError('NATS memory requires exactly one of servers or connection.', {
      reason: 'nats_connection_source_invalid',
      path: 'memory',
    })
  }
  const bucket = options.bucket ?? DEFAULT_BUCKET
  if (!/^[A-Za-z0-9_-]+$/.test(bucket)) {
    throw new HarnessConfigError('NATS memory bucket must contain only letters, numbers, underscores, or hyphens.', {
      reason: 'nats_bucket_invalid',
      path: 'memory.bucket',
    })
  }
  const maxEnumeratedKeys = options.maxEnumeratedKeys ?? DEFAULT_MAX_ENUMERATED_KEYS
  if (!Number.isSafeInteger(maxEnumeratedKeys) || maxEnumeratedKeys < 1) {
    throw new HarnessConfigError('NATS memory maxEnumeratedKeys must be a positive safe integer.', {
      reason: 'nats_enumeration_limit_invalid',
      path: 'memory.maxEnumeratedKeys',
    })
  }
  const replicas = options.replicas ?? 1
  if (replicas !== 1 && replicas !== 3 && replicas !== 5) {
    throw new HarnessConfigError('NATS memory replicas must be 1, 3, or 5.', {
      reason: 'nats_replicas_invalid',
      path: 'memory.replicas',
    })
  }
  if (hasServers) {
    const servers = options.servers
    if (!validServers(servers)) {
      throw new HarnessConfigError('NATS memory servers must be a non-empty URL or URL list.', {
        reason: 'nats_servers_invalid',
        path: 'memory.servers',
      })
    }
    return {
      bucket,
      createBucket: options.createBucket ?? true,
      maxEnumeratedKeys,
      replicas,
      servers,
      ...(options.connectionOptions !== undefined ? { connectionOptions: options.connectionOptions } : {}),
    }
  }
  return {
    bucket,
    createBucket: options.createBucket ?? true,
    maxEnumeratedKeys,
    replicas,
    connection: options.connection,
  }
}

function bucketOptions(replicas: 1 | 3 | 5) {
  return {
    history: 1,
    replicas,
    storage: StorageType.File,
    metadata: { [SCHEMA_METADATA_KEY]: SCHEMA_VERSION },
  }
}

function validateBucket(status: KvStatus, options: ResolvedOptions): void {
  const schema = status.metadata?.[SCHEMA_METADATA_KEY]
  if (
    status.history !== 1
    || status.storage !== StorageType.File
    || status.replicas !== options.replicas
    || schema !== SCHEMA_VERSION
  ) {
    throw natsStateError('memory.get', 'nats_bucket_incompatible', 'NATS memory bucket does not match the required v1 KV layout.')
  }
}

function storageKey(scope: MemoryScope, key: string): string {
  return `m.${hash(scope.scopeKey)}.${hash(key)}`
}

function scopePattern(scope: MemoryScope): string {
  return `m.${hash(scope.scopeKey)}.*`
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function encodeRecord(record: MemoryRecord): string {
  const value: { [key: string]: JsonValue } = {
    scopeKey: record.scopeKey,
    key: record.key,
    value: record.value,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
  if (record.expiresAt !== undefined) value['expiresAt'] = record.expiresAt
  if (record.tags !== undefined) value['tags'] = [...record.tags]
  if (record.metadata !== undefined) value['metadata'] = { ...record.metadata }
  if (record.indexText !== undefined) value['indexText'] = record.indexText
  if (record.vector !== undefined) value['vector'] = [...record.vector]
  if (record.indexDescriptor !== undefined) value['indexDescriptor'] = { ...record.indexDescriptor }
  return stableJson(value)
}

function decodeEntry(entry: KvEntry, scope: MemoryScope): MemoryRecord {
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(entry.value))
  } catch (error) {
    throw natsStateError('memory.get', 'nats_record_malformed', 'NATS memory contains a malformed record.', error)
  }
  const record = parseRecord(value)
  assertRecordScope(scope, record)
  return record
}

function parseRecord(value: unknown): MemoryRecord {
  if (!isObject(value)) throw natsStateError('memory.get', 'nats_record_malformed', 'NATS memory contains a malformed record.')
  const scopeKey = requiredString(value, 'scopeKey')
  const key = requiredString(value, 'key')
  const createdAt = requiredString(value, 'createdAt')
  const updatedAt = requiredString(value, 'updatedAt')
  const recordValue = value['value']
  if (!isJsonValue(recordValue)) throw natsStateError('memory.get', 'nats_record_malformed', 'NATS memory contains a malformed record.')
  return {
    scopeKey,
    key,
    value: recordValue,
    createdAt,
    updatedAt,
    ...(optionalString(value['expiresAt'], 'expiresAt') !== undefined ? { expiresAt: optionalString(value['expiresAt'], 'expiresAt')! } : {}),
    ...(optionalTags(value['tags']) !== undefined ? { tags: optionalTags(value['tags'])! } : {}),
    ...(optionalMetadata(value['metadata']) !== undefined ? { metadata: optionalMetadata(value['metadata'])! } : {}),
    ...(optionalString(value['indexText'], 'indexText') !== undefined ? { indexText: optionalString(value['indexText'], 'indexText')! } : {}),
    ...(optionalVector(value['vector']) !== undefined ? { vector: optionalVector(value['vector'])! } : {}),
    ...(optionalDescriptor(value['indexDescriptor']) !== undefined ? { indexDescriptor: optionalDescriptor(value['indexDescriptor'])! } : {}),
  }
}

function assertRecordScope(scope: MemoryScope, record: MemoryRecord): void {
  if (record.scopeKey !== scope.scopeKey) {
    throw natsStateError('memory.get', 'nats_record_scope_mismatch', 'NATS memory record does not belong to the requested scope.')
  }
}

function expired(record: MemoryRecord): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= Date.now()
}

function encodeCursor(keyHash: string): string {
  return Buffer.from(JSON.stringify({ v: 1, h: keyHash }), 'utf8').toString('base64url')
}

function cursorStart(records: readonly ListedRecord[], cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const keyHash = decodeCursor(cursor)
  const index = records.findIndex((entry) => entry.keyHash === keyHash)
  if (index === -1) {
    throw natsStateError('memory.list', 'nats_cursor_unavailable', 'NATS memory list cursor is no longer available. Restart the listing.')
  }
  return index + 1
}

function decodeCursor(cursor: string): string {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (isObject(value) && value['v'] === 1 && typeof value['h'] === 'string' && /^[a-f0-9]{64}$/.test(value['h'])) return value['h']
  } catch {
    // The generic cursor remains opaque. Report a safe, actionable state error below.
  }
  throw natsStateError('memory.list', 'nats_cursor_invalid', 'NATS memory list cursor is invalid. Restart the listing.')
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key]!)}`).join(',')}}`
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isObject(value)) return false
  return Object.values(value).every(isJsonValue)
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: { readonly [key: string]: unknown }, name: string): string {
  const field = value[name]
  if (typeof field !== 'string') throw natsStateError('memory.get', 'nats_record_malformed', 'NATS memory contains a malformed record.')
  return field
}

function optionalString(value: unknown, _name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw natsStateError('memory.get', 'nats_record_malformed', 'NATS memory contains a malformed record.')
  return value
}

function optionalTags(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === 'string')) {
    throw natsStateError('memory.get', 'nats_record_malformed', 'NATS memory contains a malformed record.')
  }
  return value
}

function optionalMetadata(value: unknown): Readonly<{ [key: string]: JsonValue }> | undefined {
  if (value === undefined) return undefined
  if (!isObject(value) || !isJsonValue(value)) {
    throw natsStateError('memory.get', 'nats_record_malformed', 'NATS memory contains a malformed record.')
  }
  return value
}

function optionalVector(value: unknown): readonly number[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    throw natsStateError('memory.get', 'nats_record_malformed', 'NATS memory contains a malformed record.')
  }
  return value
}

function optionalDescriptor(value: unknown): MemoryRecord['indexDescriptor'] {
  if (value === undefined) return undefined
  const dimensions = isObject(value) ? value['dimensions'] : undefined
  if (!isObject(value)
    || typeof value['alias'] !== 'string'
    || typeof value['providerId'] !== 'string'
    || typeof value['model'] !== 'string'
    || typeof dimensions !== 'number'
    || !Number.isSafeInteger(dimensions)
    || value['distance'] !== 'cosine'
    || typeof value['extractorRevision'] !== 'string') {
    throw natsStateError('memory.get', 'nats_record_malformed', 'NATS memory contains a malformed record.')
  }
  return {
    alias: value['alias'],
    providerId: value['providerId'],
    model: value['model'],
    dimensions,
    distance: value['distance'],
    extractorRevision: value['extractorRevision'],
  }
}

function validServers(servers: string | readonly string[]): boolean {
  const values = typeof servers === 'string' ? [servers] : servers
  return values.length > 0 && values.every((server) => server.trim().length > 0)
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new OperationCancelledError('NATS memory operation was cancelled.', { scope: 'memory' })
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

function isRevisionConflict(error: unknown): boolean {
  return error instanceof Error && /(?:wrong last sequence|expected.*sequence|sequence.*mismatch)/i.test(error.message)
}

function natsStateError(
  operation: 'memory.get' | 'memory.set' | 'memory.delete' | 'memory.list',
  reason: string,
  message: string,
  cause?: unknown,
): StateError {
  return new StateError(message, { op: operation, adapter: 'memory', memory_provider: ENGINE_ID, reason }, cause)
}
