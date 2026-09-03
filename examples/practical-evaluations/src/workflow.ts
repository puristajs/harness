import { createDeterministicEvaluationScorer, runEvaluation, scoreEvaluation, type EvaluationObservation, type EvaluationRunResult } from '@purista/harness'
import { passRate } from './shared.js'

type WorkflowAssessment = { readonly requiredSteps: readonly string[] }
type WorkflowOutput = { readonly status: 'sent' | 'blocked'; readonly steps: readonly string[] }

const workflowScorer = createDeterministicEvaluationScorer<WorkflowAssessment, WorkflowOutput>({
  id: 'workflow-completion', version: '1', dimension: { id: 'required_steps_complete', kind: 'boolean' },
  evaluate: observation => {
    const required = observation.assessment?.requiredSteps ?? []
    const passed = observation.output.status === 'sent' && required.every(step => observation.output.steps.includes(step))
    return { outcome: 'scored', dimensionId: 'required_steps_complete', kind: 'boolean', value: passed, passed }
  }
})

export async function runWorkflowEvaluation(): Promise<EvaluationRunResult> {
  return await runEvaluation({
    runId: 'workflow-fixture-1',
    dataset: { id: 'onboarding', version: '1', cases: [{ id: 'welcome', input: { userId: 'u-1' }, assessment: { requiredSteps: ['validate', 'provision', 'notify'] }, segments: { flow: 'onboarding' } }] },
    candidates: [{ id: 'workflow-v1', version: '1', config: {} }],
    task: { id: 'onboard-user', version: '1', async run() { return { output: { status: 'sent' as const, steps: ['validate', 'provision', 'notify'] } } } },
    scorers: [workflowScorer]
  })
}

/** Re-scoring demonstrates that saved, application-owned observations need no task replay. */
export async function rescoreWorkflowObservation(): Promise<EvaluationRunResult> {
  const observation: EvaluationObservation<WorkflowAssessment, WorkflowOutput> = {
    id: 'saved-workflow-1', datasetId: 'onboarding', datasetVersion: '1', caseId: 'welcome',
    candidateId: 'workflow-v1', candidateVersion: '1', taskId: 'onboard-user', taskVersion: '1',
    trialId: 'default', trialOrdinal: 0, output: { status: 'sent', steps: ['validate', 'provision', 'notify'] },
    assessment: { requiredSteps: ['validate', 'provision', 'notify'] }
  }
  return await scoreEvaluation({ runId: 'workflow-rescore-fixture-1', observations: [observation], scorers: [workflowScorer] })
}

export function workflowReport(result: EvaluationRunResult): { readonly completionRate: number } {
  return { completionRate: passRate(result, 'required_steps_complete') }
}
