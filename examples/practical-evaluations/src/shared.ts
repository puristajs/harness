import type { EvaluationAccounting, EvaluationDimensionAggregate, EvaluationRunResult } from '@purista/harness'

/**
 * Fixture-only model accounting. Real tasks should pass the provider-reported
 * identity, token usage, cost, and trace correlation to their task or scorer.
 */
export function fixtureAccounting(alias: string): EvaluationAccounting {
  return {
    completeness: 'complete',
    modelCalls: [{
      model: { providerId: 'fixture', model: 'fixture-small', alias },
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      cost: { amount: 0.00008, currency: 'USD' },
      // OpenTelemetry trace IDs are 32 lower-case hex characters.
      correlation: { traceId: '00000000000000000000000000000001' }
    }]
  }
}

export function dimension(result: EvaluationRunResult, id: string): EvaluationDimensionAggregate {
  const found = result.dimensionAggregates.find(aggregate => aggregate.dimensionId === id && aggregate.scope.kind === 'all')
  if (!found) throw new Error(`Missing ${id} aggregate.`)
  return found
}

export function passRate(result: EvaluationRunResult, id: string): number {
  return dimension(result, id).passCounts?.rate ?? 0
}
