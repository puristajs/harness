import type { Span } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'

import { HarnessError, OperationCancelledError, StateError } from '../../errors/index.js'
import type { CreateMemoryFacadeOptions, MemoryEngine, MemoryScope } from './types.js'
import {
  CONTENT_ATTR_LIMIT,
  attachContent,
  baseAttrs,
  errorType,
  hashKey,
  normalizeMemoryError,
  resultAttributes,
  shouldCaptureContent,
} from './telemetry.js'

const engine: MemoryEngine = {
  info: { id: 'memory-test', packageName: '@test/memory' },
  capabilities: ['memory.kv', 'memory.list', 'memory.delete'],
  async get() { return undefined },
  async put() {},
  async delete() {},
  async list() { return { records: [] } },
}

const opts = (capabilities: readonly string[] = engine.capabilities): CreateMemoryFacadeOptions => ({
  engine: { ...engine, capabilities },
  harnessName: 'telemetry-test',
  sessionId: 'session-1',
  runId: 'run-1',
  agentId: 'agent-1',
  contentCaptureMode: 'NO_CONTENT',
  logger: {} as CreateMemoryFacadeOptions['logger'],
  telemetry: {} as CreateMemoryFacadeOptions['telemetry'],
  metrics: {} as CreateMemoryFacadeOptions['metrics'],
  signal: new AbortController().signal,
})

const scope: MemoryScope = {
  kind: 'session',
  scopeKey: 'session/session-1',
  sessionId: 'session-1',
  runId: 'run-1',
  agentId: 'agent-1',
}

describe('memory telemetry helpers', () => {
  it('builds base attributes and selects the advertised search capability', () => {
    expect(baseAttrs(opts(['memory.kv', 'memory.hybrid_search']), scope, 'search')).toMatchObject({
      'harness.name': 'telemetry-test',
      'harness.memory.provider': 'memory-test',
      'harness.memory.capability': 'memory.hybrid_search',
      'harness.memory.scope': 'session',
    })
    expect(baseAttrs(opts(['memory.text_search']), scope, 'search')['harness.memory.capability']).toBe('memory.text_search')
    expect(baseAttrs(opts(['memory.kv']), scope, 'search')['harness.memory.capability']).toBe('memory.vector_search')
    expect(baseAttrs(opts(['memory.kv']), scope, 'get')['harness.memory.capability']).toBe('memory.kv')
  })

  it('reports operation result attributes and stable key hashes', () => {
    expect(resultAttributes('get', undefined)).toEqual({ 'harness.memory.hit': false })
    expect(resultAttributes('get', null)).toEqual({ 'harness.memory.hit': true })
    expect(resultAttributes('list', [])).toEqual({ 'harness.memory.result_count': 0 })
    expect(resultAttributes('search', [1, 2])).toEqual({ 'harness.memory.result_count': 2 })
    expect(resultAttributes('set', [1])).toEqual({})
    expect(hashKey('private-key')).toHaveLength(64)
    expect(hashKey('private-key')).toBe(hashKey('private-key'))
    expect(hashKey('private-key')).not.toBe(hashKey('other-key'))
  })

  it('honors content capture modes and removes undefined event attributes', () => {
    const calls: { attrs: Record<string, unknown> }[] = []
    const events: { name: string; attrs?: Record<string, unknown> }[] = []
    const span = {
      setAttributes(attrs: Record<string, unknown>) { calls.push({ attrs }) },
      addEvent(name: string, attrs?: Record<string, unknown>) { events.push({ name, attrs }) },
    } as unknown as Span

    attachContent(span, 'SPAN_ONLY', 'set', 'key', { value: { answer: 42 } })
    expect(calls[0]?.attrs).toEqual({ 'harness.memory.key': 'key', 'harness.memory.value': '{"answer":42}' })
    expect(events).toHaveLength(0)

    attachContent(span, 'EVENT_ONLY', 'search', undefined, { query: { text: 'needle' } })
    expect(events[0]).toEqual({ name: 'harness.memory.content', attrs: { 'harness.memory.query': 'needle', 'harness.memory.operation': 'search' } })

    attachContent(span, 'SPAN_AND_EVENT', 'get', '', undefined)
    expect(calls).toHaveLength(2)
    expect(events).toHaveLength(2)
    expect(events[1]?.attrs).toEqual({ 'harness.memory.operation': 'get' })

    attachContent(span, 'NO_CONTENT', 'delete', 'secret', { value: 'private' })
    expect(calls).toHaveLength(2)
    expect(events).toHaveLength(2)
    expect(shouldCaptureContent('NO_CONTENT')).toBe(false)
    expect(shouldCaptureContent('SPAN_ONLY')).toBe(true)
  })

  it('bounds large values and tolerates values that cannot be serialized', () => {
    const attrs: Record<string, unknown>[] = []
    const span = { setAttributes(value: Record<string, unknown>) { attrs.push(value) } } as unknown as Span
    attachContent(span, 'SPAN_ONLY', 'set', 'large', { value: 'x'.repeat(CONTENT_ATTR_LIMIT + 100) })
    expect(String(attrs[0]?.['harness.memory.value'])).toHaveLength(CONTENT_ATTR_LIMIT)

    const circular: Record<string, unknown> = {}
    circular.self = circular
    attachContent(span, 'SPAN_ONLY', 'set', 'circular', { value: circular as never })
    expect(attrs[1]).toEqual({ 'harness.memory.key': 'circular' })
  })

  it('normalizes cancellation, harness, abort, and unknown engine failures', () => {
    const cancelled = new OperationCancelledError('already cancelled', { scope: 'memory' })
    expect(normalizeMemoryError(engine, 'get', cancelled)).toBe(cancelled)

    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const normalizedAbort = normalizeMemoryError(engine, 'search', abort)
    expect(normalizedAbort).toBeInstanceOf(OperationCancelledError)
    expect((normalizedAbort as OperationCancelledError).cause).toBe(abort)

    const harness = new HarnessError({ code: 'CUSTOM', category: 'internal', retriable: false, message: 'custom' })
    expect(normalizeMemoryError(engine, 'list', harness)).toBe(harness)

    const unknown = new Error('backend secret')
    const normalized = normalizeMemoryError(engine, 'delete', unknown)
    expect(normalized).toBeInstanceOf(StateError)
    expect(normalized).toMatchObject({ code: 'STATE_ERROR', meta: { op: 'memory.delete', adapter: 'memory', memory_provider: 'memory-test' } })
    expect((normalized as Error).message).not.toContain('backend secret')
  })

  it('classifies harness errors, normal errors, and non-errors', () => {
    expect(errorType(new StateError('failed', { op: 'memory.get' }))).toBe('STATE_ERROR')
    expect(errorType(new TypeError('failed'))).toBe('TypeError')
    expect(errorType('failure')).toBe('Error')
    expect(errorType(null)).toBe('Error')
  })
})
