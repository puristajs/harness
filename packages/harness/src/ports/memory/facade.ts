import type { Span } from '@opentelemetry/api'
import { ModelCapabilityError, ValidationError } from '../../errors/index.js'
import type { JsonValue } from '../../models/json.js'
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
  MemoryFacade,
  MemoryListOptions,
  MemoryOperation,
  MemoryOperationContext,
  MemoryOpenContext,
  MemoryScope,
  MemoryScopeKind,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryStore,
  MemoryWriteOptions,
  SessionMemory
} from './types.js'
import {
  assertCapability,
  normalizeListOptions,
  normalizeSearchQuery,
  validateOperationInput
} from './validation.js'

/** Creates scoped memory helpers for a concrete session/run context. */
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

/** Creates a key/value memory facade bound to one normalized scope. */
export function createSessionMemory(opts: CreateMemoryFacadeOptions, scope: MemoryScope): SessionMemory {
  const normalized = normalizeScope(opts, scope)
  return {
    read: <T = JsonValue>(key: string) => runMemoryOperation<T | undefined>(opts, normalized, 'get', key, undefined, async (store, ctx) => store.get<T>(key, ctx)),
    write: (key: string, value: JsonValue, writeOpts?: MemoryWriteOptions) => runMemoryOperation<void>(opts, normalized, 'set', key, { value, ...(writeOpts ? { writeOpts } : {}) }, async (store, ctx) => store.set(key, value, { ...ctx, ...(writeOpts ? { opts: writeOpts } : {}) })),
    delete: (key: string) => runMemoryOperation<void>(opts, normalized, 'delete', key, undefined, async (store, ctx) => store.delete(key, ctx)),
    list: async (listOpts?: MemoryListOptions) => {
      const entries = await runMemoryOperation(opts, normalized, 'list', undefined, listOpts ? { listOpts } : undefined, async (store, ctx) => store.list({ ...ctx, opts: normalizeListOptions(listOpts) }))
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
