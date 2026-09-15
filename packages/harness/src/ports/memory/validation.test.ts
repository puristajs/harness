import { describe, expect, it } from 'vitest'
import { HarnessConfigError, ModelCapabilityError, ValidationError } from '../../errors/index.js'
import {
  assertCapability,
  normalizeListOptions,
  normalizeSearchQuery,
  validateJsonSerializable,
  validateMemoryEngine,
  validateMemoryKey,
  validateScope,
  validateWriteOptions
} from './validation.js'
import type { MemoryCapability, MemoryEngine, MemoryScope } from './types.js'

function memoryEngine(capabilities: readonly MemoryCapability[] = ['memory.kv', 'memory.list', 'memory.delete']): MemoryEngine {
  return {
    info: { id: 'in_memory', packageName: '@purista/harness' },
    capabilities,
    async get() { return undefined },
    async put() {},
    async delete() {},
    async list() { return { records: [] } }
  }
}

function expectValidation(operation: () => unknown, where: string): void {
  try {
    operation()
    throw new Error('Expected validation to fail.')
  } catch (error) {
    expect(error).toMatchObject<Partial<ValidationError>>({ code: 'VALIDATION_ERROR', meta: { where } })
  }
}

function expectError(operation: () => unknown, expected: Record<string, unknown>): void {
  try {
    operation()
    throw new Error('Expected operation to fail.')
  } catch (error) {
    expect(error).toMatchObject(expected)
  }
}

describe('memory validation', () => {
  it('requires a complete engine identity, baseline capabilities, and CRUD operations', () => {
    expect(() => validateMemoryEngine({ ...memoryEngine(), info: { id: 'Invalid', packageName: 'pkg' } })).toThrow(HarnessConfigError)
    expect(() => validateMemoryEngine({ ...memoryEngine(), info: { id: 'valid_engine', packageName: '' } })).toThrow(HarnessConfigError)
    expect(() => validateMemoryEngine({ ...memoryEngine(), capabilities: ['memory.kv'] })).toThrow(HarnessConfigError)

    for (const method of ['get', 'put', 'delete', 'list'] as const) {
      const engine = memoryEngine() as Record<string, unknown>
      delete engine[method]
      expectError(() => validateMemoryEngine(engine as unknown as MemoryEngine), {
        code: 'HARNESS_CONFIG_ERROR', meta: { path: `memory.engine.${method}` }
      })
    }

    expect(() => validateMemoryEngine(memoryEngine())).not.toThrow()
  })

  it('validates keys and all scope-specific bindings', () => {
    expect(() => validateMemoryKey('path/to:value_1')).not.toThrow()
    expectValidation(() => validateMemoryKey('has spaces'), 'memory_key')

    expectValidation(() => validateScope({ kind: 'application', scopeKey: '' }), 'memory_scope')
    const invalidScopes: readonly MemoryScope[] = [
      { kind: 'tenant', scopeKey: 'tenant' },
      { kind: 'principal', scopeKey: 'principal' },
      { kind: 'session', scopeKey: 'session' },
      { kind: 'run', scopeKey: 'run' },
      { kind: 'agent', scopeKey: 'agent' }
    ]
    for (const scope of invalidScopes) expectValidation(() => validateScope(scope), 'memory_scope')

    for (const scope of [
      { kind: 'application', scopeKey: 'application' },
      { kind: 'tenant', scopeKey: 'tenant', identity: { tenantId: 'acme' } },
      { kind: 'principal', scopeKey: 'principal', identity: { principalId: 'ada' } },
      { kind: 'session', scopeKey: 'session', sessionId: 's1' },
      { kind: 'run', scopeKey: 'run', runId: 'r1' },
      { kind: 'agent', scopeKey: 'agent', agentId: 'a1' }
    ] as const) expect(() => validateScope(scope)).not.toThrow()
  })

  it('checks write options, including optional capability and strict JSON boundaries', () => {
    const baseline = memoryEngine()
    expect(() => validateWriteOptions(baseline, undefined)).not.toThrow()
    for (const ttlMs of [0, -1, 1.5]) expectValidation(() => validateWriteOptions(baseline, { ttlMs }), 'memory_write_options')
    expect(() => validateWriteOptions(baseline, { ttlMs: 1 })).toThrow(ModelCapabilityError)
    expectValidation(() => validateWriteOptions(memoryEngine(['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl']), { tags: ['bad tag'] }), 'memory_write_options')
    expectValidation(() => validateWriteOptions(baseline, { metadata: { missing: undefined } as never }), 'memory_write_options')
    expectValidation(() => validateWriteOptions(baseline, { index: { text: '  ' } }), 'memory_write_options')
    expectValidation(() => validateWriteOptions(baseline, { index: { text: 'x'.repeat(32_001) } }), 'memory_write_options')
    expect(() => validateWriteOptions(memoryEngine(['memory.kv', 'memory.list', 'memory.delete', 'memory.ttl']), {
      ttlMs: 1,
      tags: ['project', 'v1.2'],
      metadata: { nested: [true, 1] },
      index: { text: 'searchable text' }
    })).not.toThrow()
  })

  it('normalizes list and search input while rejecting invalid bounds, tags, and metadata', () => {
    expect(normalizeListOptions(undefined)).toEqual({ limit: 20 })
    expect(normalizeListOptions({ prefix: 'task/', cursor: 'next', limit: 1 })).toEqual({ prefix: 'task/', cursor: 'next', limit: 1 })
    for (const limit of [0, -1, 1.5, 101]) expectValidation(() => normalizeListOptions({ limit }), 'memory_list_options')

    expect(normalizeSearchQuery({ text: '  hello  ', tags: ['v1'], metadata: { scope: 'public' } })).toEqual({
      text: 'hello', tags: ['v1'], metadata: { scope: 'public' }, limit: 20
    })
    expect(normalizeSearchQuery({ text: 'find', limit: 100 })).toMatchObject({ text: 'find', limit: 100 })
    for (const text of ['  ', 'x'.repeat(8001)]) expectValidation(() => normalizeSearchQuery({ text }), 'memory_search_query')
    for (const limit of [0, -1, 1.5, 101]) expectValidation(() => normalizeSearchQuery({ text: 'find', limit }), 'memory_search_query')
    expectValidation(() => normalizeSearchQuery({ text: 'find', tags: ['bad tag'] }), 'memory_search_query')
    expectValidation(() => normalizeSearchQuery({ text: 'find', metadata: { value: BigInt(1) } as never }), 'memory_search_query')
  })

  it('fails with safe validation errors for every non-JSON value shape', () => {
    expect(() => assertCapability(memoryEngine(), 'memory.kv', 'read')).not.toThrow()
    expectError(() => assertCapability(memoryEngine(), 'memory.text_search', 'search'), {
      code: 'MODEL_CAPABILITY_ERROR', meta: { method: 'memory.search', reason: 'missing_capability' }
    })

    const circular: { self?: unknown } = {}
    circular.self = circular
    const stringifyFailure = {}
    Object.defineProperty(stringifyFailure, 'toJSON', { enumerable: false, value: () => { throw new Error('never expose') } })
    for (const value of [undefined, () => undefined, Symbol('secret'), BigInt(1), circular, { nested: undefined }, stringifyFailure]) {
      expectValidation(() => validateJsonSerializable(value, 'memory_value'), 'memory_value')
    }
    expect(() => validateJsonSerializable({ nested: [true, null, { count: 1 }] }, 'memory_value')).not.toThrow()
  })
})
