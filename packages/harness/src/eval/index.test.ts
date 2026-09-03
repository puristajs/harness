import { describe, expect, it } from 'vitest'

import { ValidationError } from '../errors/index.js'
import { RecordingTelemetry } from '../testing/recordingTelemetry.js'
import {
  createDeterministicEvaluationScorer,
  runEvaluation,
  scoreEvaluation,
  type EvaluationObservation,
  type EvaluationScorer
} from './index.js'

const scorer: EvaluationScorer<{ expected: string }, { answer: string }> = {
  id: 'correctness',
  version: '1',
  dimensions: [{ id: 'correct', kind: 'boolean' }, { id: 'reason', kind: 'label', labels: ['ok', 'wrong'] }],
  async score({ observation }) {
    const passed = observation.output.answer === observation.assessment?.expected
    return {
      dimensions: [
        { outcome: 'scored', dimensionId: 'correct', kind: 'boolean', value: passed, passed },
        { outcome: 'scored', dimensionId: 'reason', kind: 'label', value: passed ? 'ok' : 'wrong' }
      ]
    }
  }
}

describe('generic evaluation runs', () => {
  it('keeps assessment out of tasks, orders the matrix, and reports separate accounting', async () => {
    const seen: unknown[] = []
    const result = await runEvaluation({
      runId: 'eval-1',
      dataset: {
        id: 'dataset',
        version: '1',
        cases: [
          { id: 'a', input: 'one', assessment: { expected: 'one' }, segments: { locale: 'en' } },
          { id: 'b', input: 'two', assessment: { expected: 'two' } }
        ]
      },
      candidates: [{ id: 'candidate', version: '1', config: { prefix: '' } }],
      trials: [{ id: 'first' }, { id: 'second' }],
      task: {
        id: 'task',
        version: '1',
        async run(target) {
          seen.push(target)
          expect('assessment' in target).toBe(false)
          return {
            output: { answer: target.input },
            accounting: { completeness: 'complete', modelCalls: [{ model: { providerId: 'fake', model: 'fake', alias: 'task' }, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }] }
          }
        }
      },
      scorers: [scorer],
      aggregateBy: ['locale']
    })

    expect(seen).toHaveLength(4)
    expect(result.mode).toBe('execute_and_score')
    expect(result.cases.map(row => [row.caseId, row.trialId])).toEqual([['a', 'first'], ['a', 'second'], ['b', 'first'], ['b', 'second']])
    expect(result.cases.every(row => row.scorers[0]?.status === 'completed')).toBe(true)
    expect(result.candidateAggregates[0]?.taskAccounting.tokenTotals).toMatchObject({ totalTokens: 12 })
    expect(result.candidateAggregates[0]?.scorerAccounting.completeness).toBe('unknown')
    expect(JSON.stringify(result)).not.toContain('expected')
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('re-scores observations without executing a task and preserves no-task accounting as unknown', async () => {
    const observation: EvaluationObservation<{ expected: string }, { answer: string }> = {
      id: 'saved-1', datasetId: 'dataset', datasetVersion: '1', caseId: 'a',
      candidateId: 'candidate', candidateVersion: '1', taskId: 'task', taskVersion: '1',
      trialId: 'default', trialOrdinal: 0, output: { answer: 'yes' }, assessment: { expected: 'yes' }
    }
    const result = await scoreEvaluation({ runId: 'rescore-1', observations: [observation], scorers: [scorer] })

    expect(result.mode).toBe('score_only')
    expect(result.cases[0]?.task).toEqual({ status: 'not_run', attempts: 0 })
    expect(result.cases[0]?.scorers[0]?.dimensions[0]).toMatchObject({ outcome: 'scored', value: true })
    expect(result.candidateAggregates[0]?.taskAccounting.completeness).toBe('unknown')
  })

  it('keeps not-applicable and inconclusive dimensions out of value aggregates', async () => {
    const adapter: EvaluationScorer = {
      id: 'coverage', version: '1',
      dimensions: [{ id: 'quality', kind: 'number' }, { id: 'safety', kind: 'boolean' }],
      async score() {
        return {
          dimensions: [
            { outcome: 'not_applicable', dimensionId: 'quality', kind: 'number' },
            { outcome: 'inconclusive', dimensionId: 'safety', kind: 'boolean', reason: 'insufficient_evidence' }
          ]
        }
      }
    }
    const result = await scoreEvaluation({
      runId: 'coverage-1',
      observations: [{ id: 'o', datasetId: 'd', datasetVersion: '1', caseId: 'c', candidateId: 'candidate', candidateVersion: '1', taskId: 'task', taskVersion: '1', trialId: 'default', trialOrdinal: 0, output: null }],
      scorers: [adapter]
    })
    expect(result.dimensionAggregates.map(item => item.coverage)).toEqual([
      { planned: 1, completed: 1, scored: 0, notApplicable: 1, inconclusive: 0, errored: 0, skipped: 0 },
      { planned: 1, completed: 1, scored: 0, notApplicable: 0, inconclusive: 1, errored: 0, skipped: 0 }
    ])
  })

  it('validates definitions before callbacks and normalizes oversized evidence', async () => {
    let called = false
    await expect(runEvaluation({
      runId: 'bad',
      dataset: { id: 'dataset', version: '1', cases: [{ id: 'case', input: 'x' }] },
      candidates: [{ id: 'same', version: '1', config: {} }, { id: 'same', version: '2', config: {} }],
      task: { id: 'task', version: '1', async run() { called = true; return { output: null } } },
      scorers: [scorer]
    })).rejects.toBeInstanceOf(ValidationError)
    expect(called).toBe(false)

    const adapter = createDeterministicEvaluationScorer({
      id: 'bounded', version: '1', dimension: { id: 'check', kind: 'boolean' },
      evaluate: () => ({ outcome: 'scored', dimensionId: 'check', kind: 'boolean', value: true, evidence: { kind: 'inline', value: 'x'.repeat(4097) } })
    })
    const result = await scoreEvaluation({
      runId: 'bound',
      observations: [{ id: 'observation', datasetId: 'd', datasetVersion: '1', caseId: 'c', candidateId: 'candidate', candidateVersion: '1', taskId: 'task', taskVersion: '1', trialId: 'default', trialOrdinal: 0, output: null }],
      scorers: [adapter]
    })
    expect(result.cases[0]?.scorers[0]?.dimensions[0]?.evidence).toEqual({ kind: 'omitted', reason: 'size_limit', originalBytes: 4099 })
  })

  it('keeps matrix identity when a task fails or fail-fast skips a later row', async () => {
    const result = await runEvaluation({
      runId: 'fail-fast',
      dataset: { id: 'dataset', version: '1', cases: [{ id: 'a', input: 'a' }, { id: 'b', input: 'b' }] },
      candidates: [{ id: 'candidate', version: '1', config: {} }],
      task: { id: 'task', version: '1', async run() { throw new Error('broken task') } },
      scorers: [scorer],
      failurePolicy: 'fail_fast'
    })

    expect(result.status).toBe('failed')
    expect(result.cases.map(row => [row.caseId, row.status, row.task.status])).toEqual([
      ['a', 'task_error', 'error'],
      ['b', 'skipped', 'not_run']
    ])
    expect(result.cases[1]).toMatchObject({ datasetId: 'dataset', candidateId: 'candidate', taskId: 'task', trialId: 'default' })
  })

  it('turns a throwing retry predicate into a terminal row error', async () => {
    const result = await runEvaluation({
      runId: 'retry-predicate',
      dataset: { id: 'dataset', version: '1', cases: [{ id: 'a', input: 'a' }] },
      candidates: [{ id: 'candidate', version: '1', config: {} }],
      task: { id: 'task', version: '1', async run() { throw new Error('callback failed') } },
      scorers: [scorer],
      retry: { task: { maxAttempts: 2, shouldRetry() { throw new Error('policy failed') } } }
    })

    expect(result.status).toBe('completed_with_errors')
    expect(result.cases[0]?.task).toMatchObject({ status: 'error', attempts: 1, error: { code: 'EVALUATION_CALLBACK_ERROR' } })
  })

  it('stops remaining scorers immediately after a fail-fast scorer error', async () => {
    let secondCalled = false
    const result = await scoreEvaluation({
      runId: 'scorer-fail-fast',
      observations: [{ id: 'o', datasetId: 'd', datasetVersion: '1', caseId: 'c', candidateId: 'candidate', candidateVersion: '1', taskId: 'task', taskVersion: '1', trialId: 'default', trialOrdinal: 0, output: null }],
      scorers: [
        { id: 'broken', version: '1', dimensions: [{ id: 'first', kind: 'boolean' }], async score() { throw new Error('broken scorer') } },
        { id: 'not-called', version: '1', dimensions: [{ id: 'second', kind: 'boolean' }], async score() { secondCalled = true; return { dimensions: [{ outcome: 'scored', dimensionId: 'second', kind: 'boolean', value: true }] } } }
      ],
      failurePolicy: 'fail_fast'
    })

    expect(secondCalled).toBe(false)
    expect(result.cases[0]?.scorers.map(item => [item.status, item.skipReason])).toEqual([['error', undefined], ['skipped', 'failure_policy']])
  })

  it('emits only content-free evaluation telemetry and lifecycle metrics', async () => {
    const telemetry = new RecordingTelemetry()
    await runEvaluation({
      runId: 'private-run',
      dataset: { id: 'dataset', version: '1', cases: [{ id: 'a', input: 'secret input', assessment: { expected: 'secret assessment' } }] },
      candidates: [{ id: 'candidate', version: '1', config: { secret: 'candidate config' } }],
      task: { id: 'task', version: '1', async run() { return { output: { answer: 'secret output' } } } },
      scorers: [{
        id: 'private-scorer',
        version: '1',
        dimensions: [{ id: 'check', kind: 'boolean' }],
        async score() {
          return { dimensions: [{ outcome: 'scored', dimensionId: 'check', kind: 'boolean', value: true, evidence: { kind: 'reference', ref: 'private-reference' } }] }
        }
      }],
      telemetry
    })

    expect(telemetry.spans.map(span => span.name)).toEqual(['harness.eval.run', 'harness.eval.case', 'harness.eval.scorer'])
    expect(telemetry.spans[0]?.attrs).toMatchObject({ 'harness.eval.candidate.count': 1, 'harness.eval.case.count': 1, 'harness.eval.scorer.count': 1 })
    const emitted = JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics })
    for (const secret of ['private-run', 'dataset', 'secret input', 'secret assessment', 'secret output', 'private-reference', 'candidate config']) expect(emitted).not.toContain(secret)
  })
})
