import { createDeterministicEvaluationScorer, runEvaluation, type EvaluationRunResult } from '@purista/harness'
import { passRate } from './shared.js'

type SubagentAssessment = { readonly requiredDelegate: string; readonly finalAnswer: string }
type SubagentOutput = { readonly answer: string; readonly delegatedTo: readonly string[] }

export async function runSubagentAsToolEvaluation(): Promise<EvaluationRunResult> {
  const delegation = createDeterministicEvaluationScorer<SubagentAssessment, SubagentOutput>({
    id: 'delegation-contract', version: '1', dimension: { id: 'delegated_and_combined', kind: 'boolean' },
    evaluate: observation => {
      const expected = observation.assessment
      const passed = expected !== undefined && observation.output.delegatedTo.includes(expected.requiredDelegate) && observation.output.answer === expected.finalAnswer
      return { outcome: 'scored', dimensionId: 'delegated_and_combined', kind: 'boolean', value: passed, passed }
    }
  })
  return await runEvaluation({
    runId: 'subagent-fixture-1',
    dataset: { id: 'research-briefs', version: '1', cases: [{ id: 'brief', input: 'Prepare the one-line summary.', assessment: { requiredDelegate: 'researcher', finalAnswer: 'PURISTA is a TypeScript framework.' }, segments: { topology: 'parent_child' } }] },
    candidates: [{ id: 'coordinator', version: '1', config: {} }],
    task: { id: 'coordinate-research', version: '1', async run() { return { output: { answer: 'PURISTA is a TypeScript framework.', delegatedTo: ['researcher'] } } } },
    scorers: [delegation]
  })
}

export function subagentAsToolReport(result: EvaluationRunResult): { readonly coordinationRate: number } {
  return { coordinationRate: passRate(result, 'delegated_and_combined') }
}
