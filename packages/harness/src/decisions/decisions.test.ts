import { describe, expect, it, vi } from 'vitest'
import {
  createDecisionEvidence,
  decisionEvidenceSchema,
  decisionOccurrenceSchema,
  decisionResultSchema,
  decisionSourceSchema,
  parseProviderContinuation,
  runDecisionOperation,
} from './index.js'
import { DecisionBlockedError, DecisionEvaluationError } from '../errors/index.js'
import { isJsonValue } from '../models/json.js'
import { governanceConfigSchema } from './schemas.js'

const occurrence = {
  invocationId: 'invocation-1',
  runId: 'run-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  toolId: 'transfer_funds',
  callId: 'call-1',
  step: 2,
} as const

const source = { kind: 'policy', id: 'transfer-policy', version: 'v1', ruleId: 'amount-limit' } as const

describe('decision foundation', () => {
  it('creates frozen deterministic content-free evidence from strict identity fields', () => {
    const evidence = createDecisionEvidence({
      occurrence,
      source,
      phase: 'policy',
      ordinal: 0,
      reasonCode: 'amount_limit',
    })
    expect(evidence.decisionId).toMatch(/^decision_[0-9a-f]{64}$/)
    expect(evidence).toMatchObject({ source, phase: 'policy', reasonCode: 'amount_limit' })
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(Object.isFrozen(evidence.source)).toBe(true)
    expect(createDecisionEvidence({ occurrence, source, phase: 'policy', ordinal: 1 }).decisionId).not.toBe(
      evidence.decisionId,
    )
    expect(
      createDecisionEvidence({ occurrence: { ...occurrence, callId: 'call-2' }, source, phase: 'policy', ordinal: 0 })
        .decisionId,
    ).not.toBe(evidence.decisionId)
  })

  it('rejects malformed closed records and safe-field violations without candidate data', () => {
    expect(() => decisionSourceSchema.parse({ ...source, unexpected: true })).toThrow()
    expect(() => decisionOccurrenceSchema.parse({ ...occurrence, step: -1 })).toThrow()
    expect(() => decisionEvidenceSchema.parse({ decisionId: 'decision_bad', source, phase: 'policy' })).toThrow()
    expect(() => decisionResultSchema.parse({ decision: 'allow', metadata: {} })).toThrow()
    try {
      createDecisionEvidence({ occurrence, source, phase: 'policy', ordinal: 0, reasonCode: 'contains prose' })
      throw new Error('Expected invalid reason code to fail.')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'HARNESS_CONFIG_ERROR',
        message: 'Decision evidence configuration is invalid.',
      })
    }
    expectDecisionConfigFailure(() =>
      createDecisionEvidence({
        occurrence,
        source,
        phase: 'policy',
        ordinal: 0,
        unsafePayload: 'do-not-expose',
      } as never),
    )
  })

  it('projects explicit blocks and failed evaluation through fixed safe errors', () => {
    const evidence = createDecisionEvidence({ occurrence, source, phase: 'policy', ordinal: 0 })
    expect(new DecisionBlockedError(evidence)).toMatchObject({
      code: 'DECISION_BLOCKED',
      category: 'interceptor',
      retriable: false,
      message: 'Decision blocked execution.',
      meta: { evidence },
    })
    expect(new DecisionEvaluationError(evidence, 'callback_timeout')).toMatchObject({
      code: 'DECISION_EVALUATION_ERROR',
      category: 'interceptor',
      retriable: false,
      message: 'Decision evaluation failed closed.',
      meta: { evidence, failureKind: 'callback_timeout' },
    })
    const unsafeEvidence = {
      ...evidence,
      source: { ...evidence.source, unsafePayload: 'do-not-expose' },
    }
    expectDecisionConfigFailure(() => new DecisionBlockedError(unsafeEvidence as never))
    expectDecisionConfigFailure(() => new DecisionEvaluationError(evidence, 'unsafe_failure_kind' as never))
  })

  it('accepts only acyclic plain JSON without serializing or evaluating accessors', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    const accessor = {}
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get: () => {
        throw new Error('must not run')
      },
    })
    expect(isJsonValue({ nested: [1, true, null, 'safe'] })).toBe(true)
    expect(isJsonValue(cyclic)).toBe(false)
    expect(isJsonValue(accessor)).toBe(false)
    expect(isJsonValue({ value: Infinity })).toBe(false)
    expect(isJsonValue(Object.create({ inherited: 'value' }))).toBe(false)
  })

  it('parses a provider continuation only when its canonical tool-call slots match exactly', () => {
    const continuation = {
      providerId: 'openai',
      items: [
        { kind: 'opaque' as const, data: { responseId: 'resp-1' } },
        { kind: 'assistant_content' as const },
        { kind: 'tool_call' as const, callId: 'call-1', data: { providerCallId: 'provider-1' } },
        { kind: 'tool_call' as const, callId: 'call-2' },
      ],
    }

    expect(parseProviderContinuation(continuation, ['call-1', 'call-2'])).toEqual(continuation)
    expect(parseProviderContinuation(continuation, ['call-1'])).toBeUndefined()
    expect(parseProviderContinuation(continuation, ['call-1', 'call-1'])).toBeUndefined()
    expect(
      parseProviderContinuation(
        { ...continuation, items: [...continuation.items, { kind: 'assistant_content' as const }] },
        ['call-1', 'call-2'],
      ),
    ).toBeUndefined()
    expect(
      parseProviderContinuation(
        {
          ...continuation,
          items: [continuation.items[0], continuation.items[2], { kind: 'tool_call' as const, callId: 'call-1' }],
        },
        ['call-1', 'call-2'],
      ),
    ).toBeUndefined()
    expect(
      parseProviderContinuation({ ...continuation, items: [continuation.items[0], continuation.items[2]] }, [
        'call-1',
        'call-2',
      ]),
    ).toBeUndefined()
  })

  it('rejects malformed continuations but preserves an intentionally empty provider template', () => {
    expect(parseProviderContinuation({ providerId: 'openai', items: [] }, ['duplicate', 'duplicate'])).toEqual({
      providerId: 'openai',
      items: [],
    })
    expect(
      parseProviderContinuation(
        { providerId: 'openai', items: [{ kind: 'tool_call', callId: 'call-1', data: new Date() }] },
        ['call-1'],
      ),
    ).toBeUndefined()
    expect(parseProviderContinuation({ providerId: '', items: [] }, [])).toBeUndefined()
  })

  it('validates governance identifiers and callback-only configuration slots', () => {
    const callback = () => undefined
    expect(
      governanceConfigSchema.parse({
        policies: [
          {
            id: 'transfer-policy',
            kind: 'native',
            rules: [{ id: 'amount-limit', effect: 'allow', when: callback }],
          },
          {
            id: 'external-policy',
            evaluate: callback,
          },
        ],
        exposure: {
          id: 'tool-exposure',
          rules: [{ id: 'expose-transfer', effect: 'expose', when: callback }],
        },
        approval: { request: callback },
        audit: { record: callback },
      }),
    ).toMatchObject({ policies: [{ id: 'transfer-policy' }, { id: 'external-policy' }] })

    expect(() =>
      governanceConfigSchema.parse({
        policies: [{ id: 'governance.default', evaluate: callback }],
      }),
    ).toThrow()
    expect(() =>
      governanceConfigSchema.parse({
        policies: [{ id: 'transfer-policy', kind: 'native', rules: [{ id: 'default', effect: 'allow' }] }],
      }),
    ).toThrow()
    expect(() =>
      governanceConfigSchema.parse({
        policies: [{ id: 'transfer-policy', evaluate: 'not a callback' }],
      }),
    ).toThrow()
  })

  it('runs a callback once with a child signal and cleans up after resolution', async () => {
    const parent = new AbortController()
    const operation = vi.fn(async (signal: AbortSignal) => {
      expect(signal).not.toBe(parent.signal)
      expect(signal.aborted).toBe(false)
      return 'allowed'
    })
    await expect(runDecisionOperation({ signal: parent.signal, deadline: Date.now() + 100 }, operation)).resolves.toBe(
      'allowed',
    )
    expect(operation).toHaveBeenCalledTimes(1)
    parent.abort()
  })

  it('does not invoke protected work for pre-aborted or expired contexts', async () => {
    const parent = new AbortController()
    parent.abort()
    const operation = vi.fn()
    await expect(
      runDecisionOperation({ signal: parent.signal, deadline: Date.now() + 100 }, operation),
    ).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    await expect(
      runDecisionOperation({ signal: new AbortController().signal, deadline: Date.now() - 1 }, operation),
    ).rejects.toMatchObject({
      code: 'OPERATION_TIMEOUT',
      meta: { scope: 'decision' },
    })
    expect(operation).not.toHaveBeenCalled()
  })

  it('fences late callback completion and preserves parent cancellation', async () => {
    vi.useFakeTimers()
    try {
      const parent = new AbortController()
      let resolveOperation: ((value: string) => void) | undefined
      const pending = runDecisionOperation(
        { signal: parent.signal, deadline: Date.now() + 10 },
        () =>
          new Promise<string>((resolve) => {
            resolveOperation = resolve
          }),
      )
      const timedOut = expect(pending).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', meta: { scope: 'decision' } })
      await vi.advanceTimersByTimeAsync(10)
      await timedOut
      resolveOperation?.('late')
      await Promise.resolve()

      const cancelled = new AbortController()
      const cancelling = runDecisionOperation(
        { signal: cancelled.signal, deadline: Date.now() + 100 },
        () => new Promise(() => {}),
      )
      const cancellation = expect(cancelling).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
      cancelled.abort(new Error('caller cancelled'))
      await cancellation
    } finally {
      vi.useRealTimers()
    }
  })
})

function expectDecisionConfigFailure(operation: () => unknown): void {
  try {
    operation()
    throw new Error('Expected unsafe decision input to fail.')
  } catch (error) {
    expect(error).toMatchObject({
      code: 'HARNESS_CONFIG_ERROR',
      message: 'Decision evidence configuration is invalid.',
    })
    expect(JSON.stringify(error)).not.toContain('do-not-expose')
  }
}
