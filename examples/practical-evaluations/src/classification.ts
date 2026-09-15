import { createDeterministicEvaluationScorer, runEvaluation, type EvaluationRunResult } from '@purista/harness'
import { fixtureAccounting, passRate } from './shared.js'

type ClassificationAssessment = { readonly label: 'billing' | 'technical' }
type ClassificationOutput = { readonly label: 'billing' | 'technical' }

export async function runClassificationEvaluation(): Promise<EvaluationRunResult> {
  const exactLabel = createDeterministicEvaluationScorer<ClassificationAssessment, ClassificationOutput>({
    id: 'exact-label', version: '1', dimension: { id: 'exact_label', kind: 'boolean' },
    evaluate: observation => ({ outcome: 'scored', dimensionId: 'exact_label', kind: 'boolean', value: observation.output.label === observation.assessment?.label, passed: observation.output.label === observation.assessment?.label })
  })
  return await runEvaluation({
    runId: 'classification-fixture-1',
    dataset: { id: 'support-routing', version: '1', cases: [
      { id: 'invoice', input: 'My invoice is incorrect.', assessment: { label: 'billing' }, segments: { language: 'en' } },
      { id: 'login', input: 'I cannot sign in.', assessment: { label: 'technical' }, segments: { language: 'en' } }
    ] },
    candidates: [{ id: 'keyword-router', version: '1', config: {} }],
    task: { id: 'route-ticket', version: '1', async run(target) {
      const label = target.input.includes('invoice') ? 'billing' : 'technical'
      return { output: { label: label as ClassificationOutput['label'] }, accounting: fixtureAccounting('router') }
    } },
    scorers: [exactLabel], aggregateBy: ['language']
  })
}

export function classificationReport(result: EvaluationRunResult): { readonly exactLabelRate: number } {
  return { exactLabelRate: passRate(result, 'exact_label') }
}
