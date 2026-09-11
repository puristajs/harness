import { runEvaluation, type EvaluationDimensionResult, type EvaluationRunResult, type EvaluationScorer } from '@purista/harness'
import { fixtureAccounting, passRate } from './shared.js'

type TranslationAssessment = { readonly targetLanguage: 'de'; readonly requiredTerm: string }
type TranslationOutput = { readonly text: string }

/** A judge port stays application-owned; replacing this fake with a model call changes no Harness API. */
export interface TranslationJudge { judge(input: { readonly source: string; readonly translation: string; readonly requiredTerm: string }, signal: AbortSignal): Promise<{ readonly score: number; readonly rationaleRef: string }> }

const fakeJudge: TranslationJudge = {
  async judge(input) { return { score: input.translation.includes(input.requiredTerm) ? 0.95 : 0.25, rationaleRef: 'fixture://translation-judge/1' } }
}

export function translationJudgeScorer(judge: TranslationJudge): EvaluationScorer<TranslationAssessment, TranslationOutput> {
  return {
    id: 'translation-judge', version: '1', dimensions: [{ id: 'translation_quality', kind: 'number' }],
    async score({ observation }, signal) {
      const assessment = observation.assessment
      if (!assessment) return { dimensions: [{ outcome: 'inconclusive', dimensionId: 'translation_quality', kind: 'number', reason: 'insufficient_evidence' }] }
      const verdict = await judge.judge({ source: String(observation.scorerContext ?? ''), translation: observation.output.text, requiredTerm: assessment.requiredTerm }, signal)
      const dimension: EvaluationDimensionResult = { outcome: 'scored', dimensionId: 'translation_quality', kind: 'number', value: verdict.score, passed: verdict.score >= 0.8, evidence: { kind: 'reference', ref: verdict.rationaleRef } }
      return { dimensions: [dimension], accounting: fixtureAccounting('translation-judge') }
    }
  }
}

export async function runTranslationEvaluation(): Promise<EvaluationRunResult> {
  return await runEvaluation({
    runId: 'translation-fixture-1',
    dataset: { id: 'english-to-german', version: '1', cases: [{ id: 'welcome', input: 'Welcome to the account page.', assessment: { targetLanguage: 'de', requiredTerm: 'Konto' }, segments: { target: 'de' } }] },
    candidates: [{ id: 'translator', version: '1', config: {} }],
    task: { id: 'translate', version: '1', async run(target) { return { output: { text: 'Willkommen auf der Konto-Seite.' }, scorerContext: target.input, accounting: fixtureAccounting('translator') } } },
    scorers: [translationJudgeScorer(fakeJudge)]
  })
}

export function translationReport(result: EvaluationRunResult): { readonly acceptedRate: number; readonly judgeCostUsd: number } {
  const judgeCost = result.candidateAggregates[0]?.scorerAccounting.costTotals.find(cost => cost.currency === 'USD')?.amount ?? 0
  return { acceptedRate: passRate(result, 'translation_quality'), judgeCostUsd: judgeCost }
}
