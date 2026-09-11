import type { Span } from '@opentelemetry/api'
import { createMetrics, type SpanAttrs } from '../../telemetry/index.js'
import {
  attachContent,
  baseAttrs,
  errorType,
  hashKey,
  normalizeMemoryError,
  resultAttributes,
  shouldCaptureContent
} from './telemetry.js'
import type {
  CreateMemoryFacadeOptions,
  MemoryEngine,
  MemoryEngineContext,
  MemoryFacade,
  MemoryListOptions,
  MemoryListResult,
  MemoryRecord,
  MemoryScope,
  MemoryScopeKind,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryWriteOptions,
  SessionMemory
} from './types.js'
import { assertCapability, normalizeListOptions, normalizeSearchQuery, validateJsonSerializable, validateMemoryKey, validateScope, validateWriteOptions } from './validation.js'

/** Creates the session-bound memory facade. Core owns scope construction and observability. */
export function createMemoryFacade(options: CreateMemoryFacadeOptions): MemoryFacade {
  const bind = (kind: MemoryScopeKind): SessionMemory => createSessionMemory(options, createScope(options, kind))
  return Object.freeze({
    application: bind('application'),
    session: bind('session'),
    run: bind('run'),
    ...(options.agentId ? { agent: bind('agent') } : {}),
    tenant: () => bind('tenant'),
    principal: () => bind('principal'),
    scope: (kind: MemoryScopeKind) => bind(kind)
  })
}

/** Creates one safe public memory handle for a canonical scope. */
export function createSessionMemory(options: CreateMemoryFacadeOptions, scope: MemoryScope): SessionMemory {
  return Object.freeze({
    read: async <T = MemoryRecord['value']>(key: string): Promise<T | undefined> => {
      validateMemoryKey(key)
      return runOperation(options, scope, 'get', key, undefined, async (engine, context) => {
        const record = await engine.get(scope, key, context)
        return record?.value as T | undefined
      })
    },
    write: async (key: string, value: MemoryRecord['value'], writeOptions?: MemoryWriteOptions) => {
      validateMemoryKey(key)
      validateJsonSerializable(value, 'memory_value')
      validateWriteOptions(options.engine, writeOptions)
      await runOperation(options, scope, 'set', key, { value, writeOptions }, async (engine, context) => {
        const existing = await engine.get(scope, key, context)
        const at = new Date().toISOString()
        const text = indexText(value, writeOptions)
        const embedding = text && options.embedding ? await options.embedding.embed(text, context.signal) : undefined
        const vector = embedding?.embeddings.find((item) => item.index === 0)?.vector
        if (text && options.embedding && (!vector || vector.length === 0 || vector.some((item) => !Number.isFinite(item)))) {
          throw new Error('Embedding model returned no finite vector for memory indexing.')
        }
        const record: MemoryRecord = Object.freeze({
          scopeKey: scope.scopeKey,
          key,
          value,
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
          ...(writeOptions?.ttlMs ? { expiresAt: new Date(Date.now() + writeOptions.ttlMs).toISOString() } : {}),
          ...(writeOptions?.tags ? { tags: Object.freeze([...writeOptions.tags]) } : {}),
          ...(writeOptions?.metadata ? { metadata: Object.freeze({ ...writeOptions.metadata }) } : {}),
          ...(text !== undefined ? { indexText: text } : {}),
          ...(vector ? { vector: Object.freeze([...vector]) } : {}),
          ...(vector && options.embedding ? { indexDescriptor: Object.freeze({ alias: options.embedding.alias, providerId: options.embedding.providerId, model: options.embedding.model, dimensions: vector.length, distance: 'cosine' as const, extractorRevision: 'harness.string-or-explicit-text.v1' }) } : {})
        })
        await engine.put(scope, record, context)
      })
    },
    delete: async (key: string) => {
      validateMemoryKey(key)
      await runOperation(options, scope, 'delete', key, undefined, (engine, context) => engine.delete(scope, key, context))
    },
    list: (listOptions?: MemoryListOptions) => runOperation(options, scope, 'list', undefined, listOptions, (engine, context) => engine.list(scope, normalizeListOptions(listOptions), context)),
    search: (query: MemorySearchQuery) => search(options, scope, query)
  })
}

async function search(options: CreateMemoryFacadeOptions, scope: MemoryScope, query: MemorySearchQuery): Promise<readonly MemorySearchResult[]> {
  const normalized = normalizeSearchQuery(query)
  const mode = normalized.mode ?? defaultSearchMode(options.engine)
  return runOperation(options, scope, 'search', undefined, { query: normalized }, async (engine, context) => {
    if (mode === 'text') {
      assertCapability(engine, 'memory.text_search', 'search')
      if (!engine.searchText) throw new Error('Memory engine declared text search without searchText().')
      return engine.searchText(scope, normalized, context)
    }
    if (mode === 'semantic') {
      assertCapability(engine, 'memory.vector_search', 'search')
      if (!options.embedding || !engine.searchVector) throw new Error('Semantic memory search requires an embedding model configuration and a vector search engine.')
      const embedding = await options.embedding.embed(normalized.text, context.signal)
      const vector = embedding.embeddings.find((item) => item.index === 0)?.vector
      if (!vector || vector.length === 0 || vector.some((item) => !Number.isFinite(item))) throw new Error('Embedding model returned no finite vector for memory search.')
      return engine.searchVector(scope, { ...normalized, vector }, context)
    }
    assertCapability(engine, 'memory.hybrid_search', 'search')
    if (!engine.searchHybrid) throw new Error('Memory engine declared hybrid search without searchHybrid().')
    return engine.searchHybrid(scope, normalized, context)
  })
}

async function runOperation<T>(
  options: CreateMemoryFacadeOptions,
  scope: MemoryScope,
  operation: 'get' | 'set' | 'delete' | 'list' | 'search',
  key: string | undefined,
  content: unknown,
  invoke: (engine: MemoryEngine, context: MemoryEngineContext) => Promise<T>
): Promise<T> {
  validateScope(scope)
  options.signal.throwIfAborted()
  const metrics = createMetrics(options.telemetry, baseAttrs(options, scope, operation))
  const started = Date.now()
  let durationAttrs: SpanAttrs = {}
  const attrs = {
    ...baseAttrs(options, scope, operation),
    ...(key ? { 'harness.memory.key_hash': hashKey(key) } : {}),
    'harness.memory.content_captured': shouldCaptureContent(options.contentCaptureMode)
  }
  return options.telemetry.span(`harness.memory.${operation}`, attrs, async (span: Span) => {
    if (shouldCaptureContent(options.contentCaptureMode)) attachContent(span, options.contentCaptureMode, operation, key, content as never)
    try {
      const value = await invoke(options.engine, options)
      durationAttrs = resultAttributes(operation, value)
      span.setAttributes(durationAttrs)
      metrics.counter('harness.memory.operations', 1, durationAttrs)
      if (operation === 'search' && Array.isArray(value)) metrics.histogram('harness.memory.search.results', value.length)
      return value
    } catch (error) {
      const normalized = normalizeMemoryError(options.engine as never, operation, error)
      durationAttrs = { 'error.type': errorType(normalized) }
      metrics.counter('harness.memory.operations', 1, durationAttrs)
      throw normalized
    } finally {
      metrics.histogram('harness.memory.operation.duration', (Date.now() - started) / 1000, durationAttrs)
    }
  })
}

function createScope(options: CreateMemoryFacadeOptions, kind: MemoryScopeKind): MemoryScope {
  const identity = options.identity
  const parts = ['v1', kind]
  if (identity?.tenantId !== undefined) parts.push(`tenant=${encodeURIComponent(identity.tenantId)}`)
  if (identity?.principalId !== undefined) parts.push(`principal=${encodeURIComponent(identity.principalId)}`)
  if (kind === 'session' || kind === 'run' || kind === 'agent') parts.push(`session=${encodeURIComponent(options.sessionId)}`)
  if (kind === 'run' || kind === 'agent') parts.push(`run=${encodeURIComponent(options.runId ?? '')}`)
  if (kind === 'agent') parts.push(`agent=${encodeURIComponent(options.agentId ?? '')}`)
  return Object.freeze({
    kind,
    scopeKey: parts.join('/'),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(identity ? { identity } : {})
  })
}

function indexText(value: MemoryRecord['value'], options: MemoryWriteOptions | undefined): string | undefined {
  if (options?.index?.text !== undefined) return options.index.text
  return typeof value === 'string' ? value : undefined
}

function defaultSearchMode(engine: MemoryEngine): 'text' | 'semantic' | 'hybrid' {
  if (engine.capabilities.includes('memory.hybrid_search')) return 'hybrid'
  if (engine.capabilities.includes('memory.text_search')) return 'text'
  return 'semantic'
}
