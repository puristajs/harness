import type { Span } from '@opentelemetry/api'
import { createHash } from 'node:crypto'
import type { HarnessError } from '../errors/harness-error.js'
import {
  HarnessConfigError,
  ModelCapabilityError,
  OperationCancelledError,
  StateError,
  ValidationError
} from '../errors/index.js'
import type { Logger } from '../logger/index.js'
import type { JsonValue } from '../models/json.js'
import type { SandboxSession } from '../sandbox/index.js'
import { createMetrics, type Metrics, type SpanAttrs, type TelemetryShim } from '../telemetry/index.js'
import type { ContentCaptureMode } from '../harness/defineHarness.js'
import type { AdapterCapability, AdapterCapabilities } from './capabilities.js'
import type { HarnessContextConfigurable } from './harness-context.js'

/** Logical memory scope kinds supported by the harness facade. */
export type MemoryScopeKind = 'run' | 'session' | 'agent' | 'user' | 'tenant'

/**
 * Concrete scope used to namespace memory entries.
 *
 * @example
 * ```ts
 * await ctx.memory.scope({ kind: 'user', userId: 'u_123' }).write('locale', 'de-DE')
 * ```
 */
export interface MemoryScope {
  kind: MemoryScopeKind
  sessionId?: string
  runId?: string
  agentId?: string
  workflowId?: string
  userId?: string
  tenantId?: string
}

/** Adapter capabilities are normal harness adapter capabilities with memory-specific names. */
export type MemoryCapability = Extract<AdapterCapability, `memory.${string}`>

/** Data-only adapter descriptor used for validation, inspection, and `.requires(...)`. */
export interface MemoryAdapterInfo {
  id: string
  packageName: string
  version?: string
  capabilities: readonly MemoryCapability[]
}

/** Per-open context passed to memory adapters. Core owns the standard telemetry wrapper. */
export interface MemoryOpenContext {
  readonly logger: Logger
  readonly telemetry: TelemetryShim
  readonly metrics: Metrics
  readonly contentCaptureMode: ContentCaptureMode
  readonly signal: AbortSignal
  /** Present for the core `sandboxMemory()` adapter and for adapters that intentionally compose with the sandbox. */
  readonly sandbox?: SandboxSession
}

/** Operation names emitted as memory span/metric attributes. */
export type MemoryOperation = 'get' | 'set' | 'delete' | 'list' | 'search'

/** Per-operation context passed to memory stores. */
export interface MemoryOperationContext extends MemoryOpenContext {
  readonly scope: MemoryScope
  readonly operation: MemoryOperation
}

/** Optional write behavior for adapters that support tags, metadata, or TTL. */
export interface MemoryWriteOptions {
  ttlMs?: number
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

/** Listing options supported by the facade. */
export interface MemoryListOptions {
  prefix?: string
  limit?: number
  cursor?: string
}

/** Metadata-only memory entry returned from `list`. */
export interface MemoryEntry {
  key: string
  createdAt?: string
  updatedAt?: string
  expiresAt?: string
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

/** Text search query used by adapters with `memory.search`. */
export interface MemorySearchQuery {
  text: string
  limit?: number
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

/** Search result returned by adapters with `memory.search`. */
export interface MemorySearchResult {
  key: string
  score?: number
  value?: JsonValue
  metadata?: Record<string, JsonValue>
}

/** Backend store opened for one concrete memory scope. */
export interface MemoryStore {
  get<T = JsonValue>(key: string, ctx: MemoryOperationContext): Promise<T | undefined>
  set(key: string, value: JsonValue, ctx: MemoryOperationContext & { opts?: MemoryWriteOptions }): Promise<void>
  delete(key: string, ctx: MemoryOperationContext): Promise<void>
  list(ctx: MemoryOperationContext & { opts?: MemoryListOptions }): Promise<MemoryEntry[]>
  search?(query: MemorySearchQuery, ctx: MemoryOperationContext): Promise<MemorySearchResult[]>
}

/** Pluggable memory backend. External implementations belong in `@purista/harness-memory-*` packages. */
export interface MemoryAdapter extends HarnessContextConfigurable, AdapterCapabilities {
  readonly info: MemoryAdapterInfo
  readonly capabilities: readonly MemoryCapability[]
  open(scope: MemoryScope, ctx: MemoryOpenContext): Promise<MemoryStore>
  close?(): Promise<void>
}

/** Session-scoped public key/value facade. */
export interface SessionMemory {
  /** Reads a JSON value by key. Returns `undefined` when absent. */
  read<T = JsonValue>(key: string): Promise<T | undefined>
  /** Writes a JSON-serializable value by key. */
  write(key: string, value: JsonValue, opts?: MemoryWriteOptions): Promise<void>
  /** Deletes a key if it exists. */
  delete(key: string): Promise<void>
  /** Lists keys in this scope. */
  list(opts?: MemoryListOptions): Promise<string[]>
  /** Searches memory when the configured adapter supports `memory.search`. */
  search?(query: MemorySearchQuery): Promise<MemorySearchResult[]>
}

/**
 * Scoped memory helper exposed to workflows, agents, and TypeScript tools.
 *
 * @example
 * ```ts
 * await ctx.memory.session.write('last_topic', { value: 'pricing' })
 * const prior = await ctx.memory.user().read<{ value: string }>('preference')
 * ```
 */
export interface MemoryFacade {
  session: SessionMemory
  run: SessionMemory
  agent?: SessionMemory
  user(userId?: string): SessionMemory
  tenant(tenantId?: string): SessionMemory
  scope(scope: MemoryScope): SessionMemory
}

export interface CreateMemoryFacadeOptions {
  adapter: MemoryAdapter
  logger: Logger
  telemetry: TelemetryShim
  contentCaptureMode: ContentCaptureMode
  signal: AbortSignal
  sandbox?: SandboxSession
  harnessName: string
  sessionId: string
  runId?: string
  agentId?: string
  workflowId?: string
  metadata?: Readonly<Record<string, JsonValue>>
}

const MEMORY_KEY_PATTERN = /^[A-Za-z0-9_.\-:]{1,256}$/
const MEMORY_TAG_PATTERN = /^[A-Za-z0-9_.\-:]{1,64}$/
const MEMORY_ADAPTER_ID_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 100
const CONTENT_ATTR_LIMIT = 8192

const scopeCapability: Record<MemoryScopeKind, MemoryCapability> = {
  run: 'memory.run',
  session: 'memory.session',
  agent: 'memory.agent',
  user: 'memory.user',
  tenant: 'memory.tenant'
}

export function validateMemoryAdapter(adapter: MemoryAdapter): void {
  if (!MEMORY_ADAPTER_ID_PATTERN.test(adapter.info.id)) {
    throw new HarnessConfigError('Invalid memory adapter id.', { reason: 'invalid_memory_adapter', path: 'memory.info.id', id: adapter.info.id })
  }
  if (!adapter.info.packageName) {
    throw new HarnessConfigError('Invalid memory adapter package name.', { reason: 'invalid_memory_adapter', path: 'memory.info.packageName', id: adapter.info.id })
  }
  if (!adapter.info.capabilities.includes('memory.kv')) {
    throw new HarnessConfigError('Memory adapter must support memory.kv.', { reason: 'invalid_memory_adapter', path: 'memory.info.capabilities', id: adapter.info.id })
  }
}

export function createMemoryFacade(opts: CreateMemoryFacadeOptions): MemoryFacade {
  const base = (scope: MemoryScope): SessionMemory => createSessionMemory(opts, normalizeScope(opts, scope))
  return {
    session: base({ kind: 'session', sessionId: opts.sessionId }),
    run: base({ kind: 'run', sessionId: opts.sessionId, runId: requireRunId(opts) }),
    ...(opts.agentId ? { agent: base(definedScope({ kind: 'agent', sessionId: opts.sessionId, runId: opts.runId, agentId: opts.agentId, workflowId: opts.workflowId })) } : {}),
    user(userId?: string): SessionMemory {
      return base(definedScope({ kind: 'user', sessionId: opts.sessionId, runId: opts.runId, agentId: opts.agentId, workflowId: opts.workflowId, userId: userId ?? metadataString(opts.metadata, 'userId') }))
    },
    tenant(tenantId?: string): SessionMemory {
      return base(definedScope({ kind: 'tenant', sessionId: opts.sessionId, runId: opts.runId, agentId: opts.agentId, workflowId: opts.workflowId, tenantId: tenantId ?? metadataString(opts.metadata, 'tenantId') }))
    },
    scope(scope: MemoryScope): SessionMemory {
      return base(scope)
    }
  }
}

export function createSessionMemory(opts: CreateMemoryFacadeOptions, scope: MemoryScope): SessionMemory {
  const normalized = normalizeScope(opts, scope)
  return {
    read: <T = JsonValue>(key: string) => runMemoryOperation<T | undefined>(opts, normalized, 'get', key, undefined, async (store, ctx) => store.get<T>(key, ctx)),
    write: (key: string, value: JsonValue, writeOpts?: MemoryWriteOptions) => runMemoryOperation<void>(opts, normalized, 'set', key, { value, ...(writeOpts ? { writeOpts } : {}) }, async (store, ctx) => store.set(key, value, { ...ctx, ...(writeOpts ? { opts: writeOpts } : {}) })),
    delete: (key: string) => runMemoryOperation<void>(opts, normalized, 'delete', key, undefined, async (store, ctx) => store.delete(key, ctx)),
    list: async (listOpts?: MemoryListOptions) => {
      const entries = await runMemoryOperation<MemoryEntry[]>(opts, normalized, 'list', undefined, listOpts ? { listOpts } : undefined, async (store, ctx) => store.list({ ...ctx, opts: normalizeListOptions(listOpts) }))
      return entries.map((entry) => entry.key).sort()
    },
    search: (query: MemorySearchQuery) => runMemoryOperation<MemorySearchResult[]>(opts, normalized, 'search', undefined, { query }, async (store, ctx) => {
      assertCapability(opts.adapter, 'memory.search', 'search')
      if (!store.search) {
        throw new ModelCapabilityError('Memory search is not available for this adapter.', { alias: opts.adapter.info.id, method: 'memory.search', reason: 'method_missing' })
      }
      return store.search(normalizeSearchQuery(query), ctx)
    })
  }
}

async function runMemoryOperation<T>(
  opts: CreateMemoryFacadeOptions,
  scope: MemoryScope,
  operation: MemoryOperation,
  key: string | undefined,
  content: { value?: JsonValue; writeOpts?: MemoryWriteOptions; listOpts?: MemoryListOptions; query?: MemorySearchQuery } | undefined,
  fn: (store: MemoryStore, ctx: MemoryOperationContext) => Promise<T>
): Promise<T> {
  validateOperationInput(opts.adapter, scope, operation, key, content)
  const metrics = createMetrics(opts.telemetry, baseAttrs(opts, scope, operation))
  const started = Date.now()
  let durationAttrs: SpanAttrs = {}
  const attrs = {
    ...baseAttrs(opts, scope, operation),
    ...(key ? { 'harness.memory.key_hash': hashKey(key) } : {}),
    'harness.memory.content_captured': shouldCaptureContent(opts.contentCaptureMode)
  }
  const context: MemoryOpenContext = {
    logger: opts.logger,
    telemetry: opts.telemetry,
    metrics,
    contentCaptureMode: opts.contentCaptureMode,
    signal: opts.signal,
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {})
  }
  const execute = async (span: Span): Promise<T> => {
    if (shouldCaptureContent(opts.contentCaptureMode)) attachContent(span, opts.contentCaptureMode, operation, key, content)
    try {
      opts.signal.throwIfAborted()
      const store = await opts.adapter.open(scope, context)
      const result = await fn(store, { ...context, scope, operation })
      const resultAttrs = resultAttributes(operation, result)
      durationAttrs = resultAttrs
      span.setAttributes(resultAttrs)
      metrics.counter('harness.memory.operations', 1, resultAttrs)
      if (operation === 'search' && Array.isArray(result)) {
        metrics.histogram('harness.memory.search.results', result.length)
      }
      return result
    } catch (error) {
      const normalized = normalizeMemoryError(opts.adapter, operation, error)
      const errorAttrs = { 'error.type': errorType(normalized) }
      durationAttrs = errorAttrs
      metrics.counter('harness.memory.operations', 1, errorAttrs)
      throw normalized
    } finally {
      metrics.histogram('harness.memory.operation.duration', (Date.now() - started) / 1000, durationAttrs)
    }
  }
  return opts.telemetry.span(`harness.memory.${operation}`, attrs, execute)
}

function validateOperationInput(
  adapter: MemoryAdapter,
  scope: MemoryScope,
  operation: MemoryOperation,
  key: string | undefined,
  content: { value?: JsonValue; writeOpts?: MemoryWriteOptions; listOpts?: MemoryListOptions; query?: MemorySearchQuery } | undefined
): void {
  assertScope(adapter, scope)
  if (key !== undefined) validateMemoryKey(key)
  if (operation === 'set') {
    validateJsonSerializable(content?.value, 'memory_value')
    validateWriteOptions(adapter, content?.writeOpts)
  }
  if (operation === 'list') normalizeListOptions(content?.listOpts)
  if (operation === 'search') {
    assertCapability(adapter, 'memory.search', 'search')
    normalizeSearchQuery(content?.query)
  }
}

function validateWriteOptions(adapter: MemoryAdapter, opts: MemoryWriteOptions | undefined): void {
  if (!opts) return
  if (opts.ttlMs !== undefined) {
    if (!Number.isInteger(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new ValidationError('Memory ttlMs must be a positive integer.', { where: 'memory_write_options', issues: { ttlMs: opts.ttlMs } })
    }
    if (!adapter.info.capabilities.includes('memory.ttl')) {
      throw new ValidationError('Memory adapter does not support ttlMs.', { where: 'memory_write_options', issues: { reason: 'ttl_unsupported' } })
    }
  }
  for (const tag of opts.tags ?? []) {
    if (!MEMORY_TAG_PATTERN.test(tag)) {
      throw new ValidationError('Invalid memory tag.', { where: 'memory_write_options', issues: { tag } })
    }
  }
  if (opts.metadata !== undefined) validateJsonSerializable(opts.metadata, 'memory_write_options')
}

function normalizeListOptions(opts: MemoryListOptions | undefined): MemoryListOptions {
  const limit = opts?.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new ValidationError('Invalid memory list limit.', { where: 'memory_list_options', issues: { limit } })
  }
  return { ...opts, limit }
}

function normalizeSearchQuery(query: MemorySearchQuery | undefined): MemorySearchQuery {
  const text = query?.text?.trim() ?? ''
  const limit = query?.limit ?? DEFAULT_LIMIT
  if (text.length === 0 || text.length > 8000) {
    throw new ValidationError('Invalid memory search text.', { where: 'memory_search_query', issues: { textLength: text.length } })
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new ValidationError('Invalid memory search limit.', { where: 'memory_search_query', issues: { limit } })
  }
  for (const tag of query?.tags ?? []) {
    if (!MEMORY_TAG_PATTERN.test(tag)) {
      throw new ValidationError('Invalid memory search tag.', { where: 'memory_search_query', issues: { tag } })
    }
  }
  if (query?.metadata !== undefined) validateJsonSerializable(query.metadata, 'memory_search_query')
  return { ...query, text, limit }
}

function validateJsonSerializable(value: unknown, where: 'memory_value' | 'memory_write_options' | 'memory_search_query'): void {
  try {
    JSON.stringify(value)
  } catch (error) {
    throw new ValidationError('Memory value must be JSON-serializable.', { where, issues: {} }, error)
  }
}

function validateMemoryKey(key: string): void {
  if (!MEMORY_KEY_PATTERN.test(key)) {
    throw new ValidationError('Invalid session memory key.', { where: 'memory_key', issues: { key } })
  }
}

function assertScope(adapter: MemoryAdapter, scope: MemoryScope): void {
  const capability = scopeCapability[scope.kind]
  assertCapability(adapter, capability, scope.kind)
  const missing = scope.kind === 'session' && !scope.sessionId
    ? 'sessionId'
    : scope.kind === 'run' && !scope.runId
      ? 'runId'
      : scope.kind === 'agent' && !scope.agentId
        ? 'agentId'
        : scope.kind === 'user' && !scope.userId
          ? 'userId'
          : scope.kind === 'tenant' && !scope.tenantId
            ? 'tenantId'
            : undefined
  if (missing) {
    throw new ValidationError('Missing memory scope identifier.', { where: 'memory_scope', issues: { reason: 'missing_scope_identifier', field: missing, scope: scope.kind } })
  }
}

function assertCapability(adapter: MemoryAdapter, capability: MemoryCapability, method: string): void {
  if (adapter.info.capabilities.includes(capability)) return
  if (capability === 'memory.search') {
    throw new ModelCapabilityError('Memory search is not available for this adapter.', { alias: adapter.info.id, method: 'memory.search', reason: 'missing_capability' })
  }
  throw new ValidationError('Memory adapter does not support the requested scope or option.', { where: 'memory_scope', issues: { reason: 'scope_unsupported', capability, method } })
}

function normalizeScope(opts: CreateMemoryFacadeOptions, scope: MemoryScope): MemoryScope {
  return {
    sessionId: opts.sessionId,
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.workflowId ? { workflowId: opts.workflowId } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...scope
  }
}

function definedScope(scope: {
  kind: MemoryScopeKind
  sessionId?: string | undefined
  runId?: string | undefined
  agentId?: string | undefined
  workflowId?: string | undefined
  userId?: string | undefined
  tenantId?: string | undefined
}): MemoryScope {
  const out: MemoryScope = { kind: scope.kind }
  if (scope.sessionId !== undefined) out.sessionId = scope.sessionId
  if (scope.runId !== undefined) out.runId = scope.runId
  if (scope.agentId !== undefined) out.agentId = scope.agentId
  if (scope.workflowId !== undefined) out.workflowId = scope.workflowId
  if (scope.userId !== undefined) out.userId = scope.userId
  if (scope.tenantId !== undefined) out.tenantId = scope.tenantId
  return out
}

function requireRunId(opts: CreateMemoryFacadeOptions): string {
  if (opts.runId) return opts.runId
  throw new ValidationError('Run memory is only available inside a run.', { where: 'memory_scope', issues: { reason: 'missing_scope_identifier', field: 'runId', scope: 'run' } })
}

function metadataString(metadata: Readonly<Record<string, JsonValue>> | undefined, key: 'userId' | 'tenantId'): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function baseAttrs(opts: CreateMemoryFacadeOptions, scope: MemoryScope, operation: MemoryOperation): SpanAttrs {
  return {
    'harness.name': opts.harnessName,
    'harness.memory.provider': opts.adapter.info.id,
    'harness.memory.operation': operation,
    'harness.memory.scope': scope.kind,
    'harness.memory.capability': operation === 'search' ? 'memory.search' : scopeCapability[scope.kind],
    'harness.session.id': scope.sessionId,
    'harness.run.id': scope.runId,
    'harness.agent.id': scope.agentId,
    'harness.workflow.id': scope.workflowId
  }
}

function resultAttributes(operation: MemoryOperation, result: unknown): SpanAttrs {
  if (operation === 'get') return { 'harness.memory.hit': result !== undefined }
  if (Array.isArray(result) && (operation === 'list' || operation === 'search')) return { 'harness.memory.result_count': result.length }
  return {}
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function shouldCaptureContent(mode: ContentCaptureMode): boolean {
  return mode !== 'NO_CONTENT'
}

function attachContent(
  span: Span,
  mode: ContentCaptureMode,
  operation: MemoryOperation,
  key: string | undefined,
  content: { value?: JsonValue; writeOpts?: MemoryWriteOptions; listOpts?: MemoryListOptions; query?: MemorySearchQuery } | undefined
): void {
  const attrs: SpanAttrs = {
    ...(key ? { 'harness.memory.key': key } : {}),
    ...(content?.value !== undefined ? { 'harness.memory.value': limitedJson(content.value) } : {}),
    ...(content?.query ? { 'harness.memory.query': content.query.text } : {})
  }
  if (mode === 'SPAN_ONLY' || mode === 'SPAN_AND_EVENT') {
    span.setAttributes(attrs)
  }
  if (mode === 'EVENT_ONLY' || mode === 'SPAN_AND_EVENT') {
    span.addEvent('harness.memory.content', cleanAttrs({ ...attrs, 'harness.memory.operation': operation }))
  }
}

function limitedJson(value: JsonValue): string | undefined {
  try {
    return JSON.stringify(value).slice(0, CONTENT_ATTR_LIMIT)
  } catch {
    return undefined
  }
}

function normalizeMemoryError(adapter: MemoryAdapter, operation: MemoryOperation, error: unknown): unknown {
  if (error instanceof OperationCancelledError) return error
  if (isAbortError(error)) return new OperationCancelledError('Memory operation was cancelled.', { scope: 'memory' }, error)
  if (isHarnessError(error)) return error
  return new StateError('Memory adapter operation failed.', { op: `memory.${operation}`, adapter: 'memory', memory_provider: adapter.info.id }, error)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function isHarnessError(error: unknown): error is HarnessError {
  return Boolean(error && typeof error === 'object' && 'code' in error && 'category' in error)
}

function errorType(error: unknown): string {
  return isHarnessError(error) ? error.code : error instanceof Error ? error.name : 'Error'
}

function cleanAttrs(attrs: SpanAttrs): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
