import { HarnessConfigError, ModelCapabilityError, ValidationError } from '../../errors/index.js'
import type { JsonValue } from '../../models/json.js'
import type {
  MemoryAdapter,
  MemoryCapability,
  MemoryListOptions,
  MemoryOperation,
  MemoryScope,
  MemoryScopeKind,
  MemorySearchQuery,
  MemoryWriteOptions
} from './types.js'

export const MEMORY_KEY_PATTERN = /^[A-Za-z0-9_.\-:]{1,256}$/
const MEMORY_TAG_PATTERN = /^[A-Za-z0-9_.\-:]{1,64}$/
const MEMORY_ADAPTER_ID_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 100

export const scopeCapability: Record<MemoryScopeKind, MemoryCapability> = {
  run: 'memory.run',
  session: 'memory.session',
  agent: 'memory.agent',
  user: 'memory.user',
  tenant: 'memory.tenant'
}

/** Validates static adapter metadata before the adapter is used. */
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
  if (adapter.capabilities.length !== adapter.info.capabilities.length || adapter.capabilities.some((capability) => !adapter.info.capabilities.includes(capability))) {
    throw new HarnessConfigError('Memory adapter capabilities must match info.capabilities.', { reason: 'invalid_memory_adapter', path: 'memory.capabilities', id: adapter.info.id })
  }
}

export function validateOperationInput(
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

export function validateWriteOptions(adapter: MemoryAdapter, opts: MemoryWriteOptions | undefined): void {
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

export function normalizeListOptions(opts: MemoryListOptions | undefined): MemoryListOptions {
  const limit = opts?.limit ?? DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new ValidationError('Invalid memory list limit.', { where: 'memory_list_options', issues: { limit } })
  }
  return { ...opts, limit }
}

export function normalizeSearchQuery(query: MemorySearchQuery | undefined): MemorySearchQuery {
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

export function validateJsonSerializable(
  value: unknown,
  where: 'memory_value' | 'memory_write_options' | 'memory_search_query'
): void {
  const seen = new WeakSet<object>()
  const invalid = findInvalidJsonValue(value, seen)
  if (invalid) {
    throw new ValidationError('Memory value must be JSON-serializable.', { where, issues: invalid })
  }
  try {
    JSON.stringify(value)
  } catch (error) {
    throw new ValidationError('Memory value must be JSON-serializable.', { where, issues: {} }, error)
  }
}

function findInvalidJsonValue(value: unknown, seen: WeakSet<object>, path = '$'): Record<string, unknown> | undefined {
  if (value === undefined) return { path, reason: 'undefined' }
  const valueType = typeof value
  if (valueType === 'function' || valueType === 'symbol' || valueType === 'bigint') {
    return { path, reason: valueType }
  }
  if (value === null || valueType !== 'object') return undefined
  if (seen.has(value)) return { path, reason: 'circular' }
  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const invalid = findInvalidJsonValue(value[index], seen, `${path}[${index}]`)
      if (invalid) return invalid
    }
    seen.delete(value)
    return undefined
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const invalid = findInvalidJsonValue(item, seen, `${path}.${key}`)
    if (invalid) return invalid
  }
  seen.delete(value)
  return undefined
}

export function validateMemoryKey(key: string): void {
  if (!MEMORY_KEY_PATTERN.test(key)) {
    throw new ValidationError('Invalid session memory key.', { where: 'memory_key', issues: { key } })
  }
}

export function assertScope(adapter: MemoryAdapter, scope: MemoryScope): void {
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

export function assertCapability(adapter: MemoryAdapter, capability: MemoryCapability, method: string): void {
  if (adapter.info.capabilities.includes(capability)) return
  if (capability === 'memory.search') {
    throw new ModelCapabilityError('Memory search is not available for this adapter.', { alias: adapter.info.id, method: 'memory.search', reason: 'missing_capability' })
  }
  throw new ValidationError('Memory adapter does not support the requested scope or option.', { where: 'memory_scope', issues: { reason: 'scope_unsupported', capability, method } })
}
