import { describe, expect, it } from 'vitest'

import { ModelError } from '../errors/index.js'
import {
  accumulateStreamToolCallDeltas,
  createStreamToolCallState,
  finalizeStreamToolCalls,
  malformedResponseError,
  parseProviderJson,
  redactProviderContent,
  safePartialJson,
  toTokenUsage,
  withoutObjectTool,
  type AdapterCallContext
} from './adapter-utils.js'

const ctx: AdapterCallContext = { provider: 'test', model: 'm', method: 'object' }

describe('adapter-utils', () => {
  it('toTokenUsage sums totals and honors provider totals', () => {
    expect(toTokenUsage(3, 4)).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
    expect(toTokenUsage(3, 4, 10)).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 10 })
    expect(toTokenUsage()).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  it('redactProviderContent collapses raw strings into a safe descriptor', () => {
    expect(redactProviderContent('raw model output')).toEqual({ redacted: true, contentLength: 16 })
  })

  it('redactProviderContent sanitizes structured bodies', () => {
    const result = redactProviderContent({ message: 'safe', content: 'secret output' }) as Record<string, unknown>
    expect(result['message']).toBe('safe')
    expect(result['content']).toBe('[redacted]')
  })

  it('malformedResponseError redacts the provider body and carries call context', () => {
    const error = malformedResponseError(ctx, 'Malformed JSON.', '{"broken":', new Error('parse'))
    expect(error).toBeInstanceOf(ModelError)
    expect(error.meta).toMatchObject({
      provider: 'test',
      model: 'm',
      method: 'object',
      reason: 'malformed_response',
      providerBody: { redacted: true, contentLength: 10 }
    })
  })

  it('parseProviderJson parses valid JSON and throws the shared malformed error otherwise', () => {
    expect(parseProviderJson('{"ok":true}', ctx, 'Malformed.')).toEqual({ ok: true })
    expect(() => parseProviderJson('{"ok":', ctx, 'Malformed.')).toThrowError(ModelError)
  })

  it('safePartialJson wraps incomplete fragments', () => {
    expect(safePartialJson('{"ok":true}')).toEqual({ ok: true })
    expect(safePartialJson('{"ok":')).toEqual({ _partial: '{"ok":' })
  })

  it('withoutObjectTool drops the synthetic harness_response call', () => {
    expect(withoutObjectTool([
      { id: 'a', name: 'harness_response', arguments: {} },
      { id: 'b', name: 'search', arguments: { q: 'x' } }
    ])).toEqual([{ id: 'b', name: 'search', arguments: { q: 'x' } }])
    expect(withoutObjectTool([{ id: 'a', name: 'harness_response', arguments: {} }])).toBeUndefined()
    expect(withoutObjectTool(undefined)).toBeUndefined()
  })

  it('accumulates OpenAI-compatible tool-call deltas by index and finalizes in order', () => {
    const state = createStreamToolCallState()
    accumulateStreamToolCallDeltas(state, [{ index: 1, id: 'call_2', function: { name: 'second', arguments: '' } }])
    accumulateStreamToolCallDeltas(state, [{ index: 0, id: 'call_1', function: { name: 'first', arguments: '{"a":' } }])
    accumulateStreamToolCallDeltas(state, [{ index: 0, function: { arguments: '1}' } }])

    expect(finalizeStreamToolCalls(state, ctx, 'Malformed.')).toEqual([
      { id: 'call_1', name: 'first', arguments: { a: 1 } },
      { id: 'call_2', name: 'second', arguments: {} }
    ])
  })

  it('finalize parses empty tool-call arguments as an empty object', () => {
    const state = createStreamToolCallState()
    accumulateStreamToolCallDeltas(state, [{ index: 0, id: 'call_1', function: { name: 'noop' } }])
    expect(finalizeStreamToolCalls(state, ctx, 'Malformed.')).toEqual([
      { id: 'call_1', name: 'noop', arguments: {} }
    ])
  })

  it('finalize skips fragments without id or name', () => {
    const state = createStreamToolCallState()
    accumulateStreamToolCallDeltas(state, [{ index: 0, function: { arguments: '{"orphan":true}' } }])
    expect(finalizeStreamToolCalls(state, ctx, 'Malformed.')).toEqual([])
  })

  it('finalize throws the shared malformed error for broken argument JSON', () => {
    const state = createStreamToolCallState()
    accumulateStreamToolCallDeltas(state, [{ index: 0, id: 'call_1', function: { name: 'broken', arguments: '{"a":' } }])
    expect(() => finalizeStreamToolCalls(state, ctx, 'Malformed.')).toThrowError(ModelError)
  })
})
