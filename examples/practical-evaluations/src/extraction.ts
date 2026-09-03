import { createDeterministicEvaluationScorer, runEvaluation, type EvaluationRunResult } from '@purista/harness'
import { passRate } from './shared.js'

type ExtractionAssessment = { readonly invoiceId: string; readonly amount: number }
type ExtractionOutput = { readonly invoiceId?: string; readonly amount?: number }

export async function runExtractionEvaluation(): Promise<EvaluationRunResult> {
  const complete = createDeterministicEvaluationScorer<ExtractionAssessment, ExtractionOutput>({
    id: 'invoice-fields', version: '1', dimension: { id: 'required_fields', kind: 'boolean' },
    evaluate: observation => {
      const expected = observation.assessment
      const passed = observation.output.invoiceId === expected?.invoiceId && observation.output.amount === expected?.amount
      return { outcome: 'scored', dimensionId: 'required_fields', kind: 'boolean', value: passed, passed, evidence: { kind: 'inline', value: { extracted: Object.keys(observation.output).sort() } } }
    }
  })
  return await runEvaluation({
    runId: 'extraction-fixture-1',
    dataset: { id: 'invoice-snippets', version: '1', cases: [{ id: 'inv-1', input: 'Invoice INV-42 totals 19 EUR.', assessment: { invoiceId: 'INV-42', amount: 19 }, segments: { document: 'invoice' } }] },
    candidates: [{ id: 'regex-extractor', version: '1', config: {} }],
    task: { id: 'extract-invoice', version: '1', async run() { return { output: { invoiceId: 'INV-42', amount: 19 } } } },
    scorers: [complete]
  })
}

export function extractionReport(result: EvaluationRunResult): { readonly requiredFieldsRate: number } {
  return { requiredFieldsRate: passRate(result, 'required_fields') }
}
