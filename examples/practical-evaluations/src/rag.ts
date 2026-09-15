import { createDeterministicEvaluationScorer, runEvaluation, type EvaluationRunResult } from '@purista/harness'
import { fixtureAccounting, passRate } from './shared.js'

type RagAssessment = { readonly requiredCitation: string }
type RagOutput = { readonly answer: string; readonly citations: readonly string[] }

export async function runRagEvaluation(): Promise<EvaluationRunResult> {
  const grounded = createDeterministicEvaluationScorer<RagAssessment, RagOutput>({
    id: 'citation-grounding', version: '1', dimension: { id: 'required_citation_present', kind: 'boolean' },
    evaluate: observation => {
      const passed = observation.assessment !== undefined && observation.output.citations.includes(observation.assessment.requiredCitation)
      return { outcome: 'scored', dimensionId: 'required_citation_present', kind: 'boolean', value: passed, passed, evidence: { kind: 'reference', ref: observation.output.citations[0] ?? 'no-citation' } }
    }
  })
  return await runEvaluation({
    runId: 'rag-fixture-1',
    dataset: { id: 'policy-questions', version: '1', cases: [{ id: 'refund', input: 'What is the refund period?', assessment: { requiredCitation: 'policy/refunds#period' }, segments: { collection: 'policies' } }] },
    candidates: [{ id: 'retrieval-v1', version: '1', config: {} }],
    task: { id: 'answer-with-citations', version: '1', async run() { return { output: { answer: 'Refunds are available for 30 days.', citations: ['policy/refunds#period'] }, accounting: fixtureAccounting('rag-answer') } } },
    scorers: [grounded]
  })
}

export function ragReport(result: EvaluationRunResult): { readonly groundingRate: number; readonly taskTokens: number } {
  return { groundingRate: passRate(result, 'required_citation_present'), taskTokens: result.candidateAggregates[0]?.taskAccounting.tokenTotals?.totalTokens ?? 0 }
}
