import { HarnessConfigError, ModelCapabilityError, ValidationError } from '../../errors/index.js'
import type { JsonValue } from '../../models/json.js'
import type {
  MemoryCapability,
  MemoryEngine,
  MemoryListOptions,
  MemoryScope,
  MemorySearchQuery,
  MemoryWriteOptions
} from './types.js'

export const MEMORY_KEY_PATTERN = /^[A-Za-z0-9_./\-:]{1,256}$/
const MEMORY_TAG_PATTERN = /^[A-Za-z0-9_.\-:]{1,64}$/
const MEMORY_ENGINE_ID_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20

/** Validates engine metadata and required, non-bypassable operations. */
export function validateMemoryEngine(engine: MemoryEngine): void {
  if (!MEMORY_ENGINE_ID_PATTERN.test(engine.info.id)) {
    throw new HarnessConfigError('Invalid memory engine id.', { reason: 'invalid_memory_engine', path: 'memory.engine.info.id', id: engine.info.id })
  }
  if (!engine.info.packageName || !engine.capabilities.includes('memory.kv') || !engine.capabilities.includes('memory.list') || !engine.capabilities.includes('memory.delete')) {
    throw new HarnessConfigError('A memory engine must declare memory.kv, memory.list, and memory.delete.', { reason: 'invalid_memory_engine', path: 'memory.engine.capabilities', id: engine.info.id })
  }
  for (const method of ['get', 'put', 'delete', 'list'] as const) {
    if (typeof engine[method] !== 'function') {
      throw new HarnessConfigError(`Memory engine is missing ${method}().`, { reason: 'invalid_memory_engine', path: `memory.engine.${method}`, id: engine.info.id })
    }
  }
}

export function validateMemoryKey(key: string): void {
  if (!MEMORY_KEY_PATTERN.test(key)) {
    throw new ValidationError('Invalid memory key.', { where: 'memory_key', issues: { key } })
  }
}

export function validateScope(scope: MemoryScope): void {
  if (!scope.scopeKey) throw new ValidationError('Memory scope is not bound.', { where: 'memory_scope', issues: { scope: scope.kind } })
  if (scope.kind === 'tenant' && !scope.identity?.tenantId) throw missingScope('tenantId', scope.kind)
  if (scope.kind === 'principal' && !scope.identity?.principalId) throw missingScope('principalId', scope.kind)
  if (scope.kind === 'session' && !scope.sessionId) throw missingScope('sessionId', scope.kind)
  if (scope.kind === 'run' && !scope.runId) throw missingScope('runId', scope.kind)
  if (scope.kind === 'agent' && !scope.agentId) throw missingScope('agentId', scope.kind)
}

export function validateWriteOptions(engine: MemoryEngine, options: MemoryWriteOptions | undefined): void {
  if (!options) return
  if (options.ttlMs !== undefined) {
    if (!Number.isInteger(options.ttlMs) || options.ttlMs <= 0) {
      throw new ValidationError('Memory ttlMs must be a positive integer.', { where: 'memory_write_options', issues: { ttlMs: options.ttlMs } })
    }
    assertCapability(engine, 'memory.ttl', 'write')
  }
  for (const tag of options.tags ?? []) {
    if (!MEMORY_TAG_PATTERN.test(tag)) throw new ValidationError('Invalid memory tag.', { where: 'memory_write_options', issues: { tag } })
  }
  if (options.metadata !== undefined) validateJsonSerializable(options.metadata, 'memory_write_options')
  if (options.index?.text !== undefined && (options.index.text.trim().length === 0 || options.index.text.length > 32000)) {
    throw new ValidationError('Memory index text must be non-empty and no longer than 32000 characters.', { where: 'memory_write_options', issues: { indexTextLength: options.index.text.length } })
  }
}

export function normalizeListOptions(options: MemoryListOptions | undefined): MemoryListOptions {
  const limit = options?.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new ValidationError('Invalid memory list limit.', { where: 'memory_list_options', issues: { limit } })
  }
  return { ...options, limit }
}

export function normalizeSearchQuery(query: MemorySearchQuery): MemorySearchQuery {
  const text = query.text.trim()
  const limit = query.limit ?? DEFAULT_LIMIT
  if (text.length === 0 || text.length > 8000) {
    throw new ValidationError('Invalid memory search text.', { where: 'memory_search_query', issues: { textLength: text.length } })
  }
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new ValidationError('Invalid memory search limit.', { where: 'memory_search_query', issues: { limit } })
  }
  for (const tag of query.tags ?? []) {
    if (!MEMORY_TAG_PATTERN.test(tag)) throw new ValidationError('Invalid memory search tag.', { where: 'memory_search_query', issues: { tag } })
  }
  if (query.metadata !== undefined) validateJsonSerializable(query.metadata, 'memory_search_query')
  return { ...query, text, limit }
}

export function assertCapability(engine: MemoryEngine, capability: MemoryCapability, method: string): void {
  if (engine.capabilities.includes(capability)) return
  throw new ModelCapabilityError('Memory engine does not support the requested operation.', {
    alias: engine.info.id,
    method: `memory.${method}`,
    reason: 'missing_capability'
  })
}

export function validateJsonSerializable(value: unknown, where: 'memory_value' | 'memory_write_options' | 'memory_search_query'): asserts value is JsonValue {
  const seen = new WeakSet<object>()
  const invalid = findInvalidJsonValue(value, seen)
  if (invalid) throw new ValidationError('Memory value must be JSON-serializable.', { where, issues: invalid })
  try { JSON.stringify(value) } catch (error) { throw new ValidationError('Memory value must be JSON-serializable.', { where, issues: {} }, error) }
}

function missingScope(field: string, scope: string): ValidationError {
  return new ValidationError('Missing memory scope identifier.', { where: 'memory_scope', issues: { reason: 'missing_scope_identifier', field, scope } })
}

function findInvalidJsonValue(value: unknown, seen: WeakSet<object>, path = '$'): Record<string, unknown> | undefined {
  if (value === undefined) return { path, reason: 'undefined' }
  const valueType = typeof value
  if (valueType === 'function' || valueType === 'symbol' || valueType === 'bigint') return { path, reason: valueType }
  if (value === null || valueType !== 'object') return undefined
  if (seen.has(value)) return { path, reason: 'circular' }
  seen.add(value)
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value as Record<string, unknown>).entries()
  for (const [key, item] of entries) {
    const invalid = findInvalidJsonValue(item, seen, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`)
    if (invalid) return invalid
  }
  seen.delete(value)
  return undefined
}
