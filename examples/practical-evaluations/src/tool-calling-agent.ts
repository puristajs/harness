import { createDeterministicEvaluationScorer, runEvaluation, type EvaluationRunResult } from '@purista/harness'
import { passRate } from './shared.js'

type ToolAssessment = { readonly requiredTool: string; readonly maxCalls: number }
type ToolOutput = { readonly answer: string; readonly toolCalls: readonly string[] }

export async function runToolCallingAgentEvaluation(): Promise<EvaluationRunResult> {
  const toolTrajectory = createDeterministicEvaluationScorer<ToolAssessment, ToolOutput>({
    id: 'tool-trajectory', version: '1', dimension: { id: 'tool_policy_followed', kind: 'boolean' },
    evaluate: observation => {
      const expected = observation.assessment
      const passed = expected !== undefined && observation.output.toolCalls.includes(expected.requiredTool) && observation.output.toolCalls.length <= expected.maxCalls
      return { outcome: 'scored', dimensionId: 'tool_policy_followed', kind: 'boolean', value: passed, passed, evidence: { kind: 'inline', value: { toolCount: observation.output.toolCalls.length } } }
    }
  })
  return await runEvaluation({
    runId: 'tool-agent-fixture-1',
    dataset: { id: 'account-lookups', version: '1', cases: [{ id: 'account', input: 'What is the balance?', assessment: { requiredTool: 'lookup_balance', maxCalls: 1 }, segments: { risk: 'read_only' } }] },
    candidates: [{ id: 'tool-agent', version: '1', config: {} }],
    task: { id: 'answer-account-question', version: '1', async run() { return { output: { answer: 'The balance is 12 EUR.', toolCalls: ['lookup_balance'] } } } },
    scorers: [toolTrajectory]
  })
}

export function toolCallingAgentReport(result: EvaluationRunResult): { readonly policyRate: number } {
  return { policyRate: passRate(result, 'tool_policy_followed') }
}
