import { describe, expect, it, vi } from 'vitest'
import {
  evaluateDeterministicScorer,
  evaluatePromptCandidates,
  ValidationError,
  type PromptCandidate,
  type EvaluationItem
} from '../index.js'

describe('deterministic scorer helpers', () => {
  it('scores regex and contains definitions against JSON Pointer selected output', () => {
    const target = {
      input: { id: 'item-1' },
      output: { answer: 'The deployment is healthy', nested: { status: 'green' } }
    }

    expect(evaluateDeterministicScorer({ type: 'regex', path: '/answer', pattern: 'deploy.*healthy' }, target)).toEqual({
      score: 1,
      passed: true
    })
    expect(evaluateDeterministicScorer({ type: 'contains', path: '/nested/status', value: 'GREEN', caseInsensitive: true }, target)).toEqual({
      score: 1,
      passed: true
    })
  })

  it('returns deterministic evidence for missing pointers and attribute inequality', () => {
    expect(evaluateDeterministicScorer({ type: 'contains', path: '/missing', value: 'x' }, { input: null, output: {} })).toEqual({
      score: 0,
      passed: false,
      evidence: { reason: 'missing_pointer', path: '/missing' }
    })

    expect(evaluateDeterministicScorer(
      { type: 'attribute-equality', leftPath: '/actual', rightPath: '/expected' },
      { input: null, output: { actual: 'a', expected: 'b' } }
    )).toEqual({
      score: 0,
      passed: false,
      evidence: { left: 'a', right: 'b' }
    })
  })

  it('scores JSON Schema validation failures without throwing', () => {
    const result = evaluateDeterministicScorer({
      type: 'json-schema',
      schema: {
        type: 'object',
        properties: { status: { const: 'ok' } },
        required: ['status'],
        additionalProperties: false
      }
    }, { input: null, output: { status: 'fail' } })

    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(result.evidence).toMatchObject({ reason: 'schema_validation_failed' })
  })

  it('supports root pointers, escaped pointer segments, arrays, enum, and equality pass cases', () => {
    expect(evaluateDeterministicScorer({ type: 'contains', path: '', value: 'root' }, { input: null, output: 'root value' })).toEqual({
      score: 1,
      passed: true
    })
    expect(evaluateDeterministicScorer({ type: 'contains', path: '/a~1b/~0key/0', value: 'needle' }, {
      input: null,
      output: { 'a/b': { '~key': ['needle'] } }
    })).toEqual({ score: 1, passed: true })
    expect(evaluateDeterministicScorer({ type: 'attribute-equality', leftPath: '/left', rightPath: '/right' }, {
      input: null,
      output: { left: { ok: true }, right: { ok: true } }
    })).toEqual({ score: 1, passed: true })
    expect(evaluateDeterministicScorer({ type: 'json-schema', schema: { enum: ['a', 'b'] } }, { input: null, output: 'b' })).toEqual({
      score: 1,
      passed: true
    })
  })

  it('reports JSON Schema type, required, and additional-property issues', () => {
    const result = evaluateDeterministicScorer({
      type: 'json-schema',
      schema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count', 'name'],
        additionalProperties: false
      }
    }, { input: null, output: { count: 1.5, extra: true } })

    expect(result.score).toBe(0)
    expect(result.passed).toBe(false)
    expect(JSON.stringify(result.evidence)).toContain('required')
    expect(JSON.stringify(result.evidence)).toContain('additional_properties')
    expect(JSON.stringify(result.evidence)).toContain('integer')
  })

  it('covers JSON Schema primitive type checks and invalid pointer forms', () => {
    expect(evaluateDeterministicScorer({ type: 'contains', path: 'not-a-pointer', value: 'x' }, { input: null, output: 'x' })).toEqual({
      score: 0,
      passed: false,
      evidence: { reason: 'missing_pointer', path: 'not-a-pointer' }
    })
    expect(evaluateDeterministicScorer({ type: 'contains', path: '/5', value: 'x' }, { input: null, output: ['x'] })).toEqual({
      score: 0,
      passed: false,
      evidence: { reason: 'missing_pointer', path: '/5' }
    })
    expect(evaluateDeterministicScorer({ type: 'json-schema', schema: { type: 'array' } }, { input: null, output: [] })).toEqual({ score: 1, passed: true })
    expect(evaluateDeterministicScorer({ type: 'json-schema', schema: { type: 'string' } }, { input: null, output: 'x' })).toEqual({ score: 1, passed: true })
    expect(evaluateDeterministicScorer({ type: 'json-schema', schema: { type: 'number' } }, { input: null, output: 1.5 })).toEqual({ score: 1, passed: true })
    expect(evaluateDeterministicScorer({ type: 'json-schema', schema: { type: 'boolean' } }, { input: null, output: false })).toEqual({ score: 1, passed: true })
    expect(evaluateDeterministicScorer({ type: 'json-schema', schema: { type: 'null' } }, { input: null, output: null })).toEqual({ score: 1, passed: true })
    expect(evaluateDeterministicScorer({ type: 'json-schema', schema: true }, { input: null, output: Symbol('x') })).toEqual({ score: 1, passed: true })
  })
})

describe('evaluatePromptCandidates', () => {
  it('runs candidates and items in stable order, aggregates scores, and sorts deterministically', async () => {
    const candidates: PromptCandidate[] = [
      { id: 'b', prompt: 'second' },
      { id: 'a', prompt: 'first' }
    ]
    const items: EvaluationItem[] = [
      { id: '1', input: 'one' },
      { id: '2', input: 'two' }
    ]
    const calls: string[] = []

    const scores = await evaluatePromptCandidates({
      candidates,
      items,
      signal: new AbortController().signal,
      runCandidate: async (candidate, item) => {
        calls.push(`${candidate.id}:${item.id}`)
        return { candidateId: candidate.id, itemId: item.id }
      },
      scorer: async (target) => {
        const output = target.output as { candidateId: string; itemId: string }
        return {
          score: output.candidateId === 'a' || output.itemId === '1' ? 1 : 0,
          passed: output.candidateId === 'a' || output.itemId === '1'
        }
      }
    })

    expect(calls).toEqual(['b:1', 'b:2', 'a:1', 'a:2'])
    expect(scores).toEqual([
      { candidateId: 'a', meanScore: 1, passRate: 1, itemCount: 2, scorerCount: 2 },
      { candidateId: 'b', meanScore: 0.5, passRate: 0.5, itemCount: 2, scorerCount: 2 }
    ])
  })

  it('rejects empty candidate or item inputs', async () => {
    await expect(evaluatePromptCandidates({
      candidates: [],
      items: [{ id: '1', input: 'x' }],
      signal: new AbortController().signal,
      runCandidate: vi.fn(),
      scorer: vi.fn()
    })).rejects.toBeInstanceOf(ValidationError)

    await expect(evaluatePromptCandidates({
      candidates: [{ id: 'c', prompt: 'p' }],
      items: [],
      signal: new AbortController().signal,
      runCandidate: vi.fn(),
      scorer: vi.fn()
    })).rejects.toBeInstanceOf(ValidationError)
  })

  it('propagates abort before scheduling more work', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stop'))

    await expect(evaluatePromptCandidates({
      candidates: [{ id: 'c', prompt: 'p' }],
      items: [{ id: 'i', input: 'x' }],
      signal: controller.signal,
      runCandidate: vi.fn(),
      scorer: vi.fn()
    })).rejects.toThrow('stop')
  })

  it('uses expected and context values when scoring candidate outputs and sorts ties by id', async () => {
    const scores = await evaluatePromptCandidates({
      candidates: [
        { id: 'b', prompt: 'p' },
        { id: 'a', prompt: 'p' }
      ],
      items: [{ id: 'i', input: 'x', expected: 'expected', context: ['ctx'] }],
      signal: new AbortController().signal,
      runCandidate: async () => 'expected',
      scorer: async (target) => ({
        score: target.output === target.expected && target.context?.[0] === 'ctx' ? 1 : 0,
        passed: target.output === target.expected
      })
    })

    expect(scores.map((score) => score.candidateId)).toEqual(['a', 'b'])
  })
})
