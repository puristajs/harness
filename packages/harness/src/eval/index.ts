import { HarnessError, OperationCancelledError, OperationTimeoutError, ValidationError, type ErrorCategory } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type { TokenUsage } from '../ports/model-provider.js'
import type { FeedbackRecord, FeedbackTarget } from '../ports/feedback.js'
import type { TelemetryShim } from '../telemetry/index.js'
import type { TelemetryOptions } from '../harness/defineHarness.js'

export interface EvaluationCase<I = unknown, Assessment = unknown> {
  readonly id: string
  readonly input: I
  readonly assessment?: Assessment
  readonly segments?: Readonly<Record<string, string>>
}

export interface EvaluationDataset<I = unknown, Assessment = unknown> {
  readonly id: string
  readonly version: string
  readonly cases: readonly EvaluationCase<I, Assessment>[]
}

export interface EvaluationCandidate<Candidate = unknown> {
  readonly id: string
  readonly version: string
  readonly config: Candidate
}

export interface EvaluationTrial { readonly id: string }

export type EvaluationDimensionDefinition =
  | { readonly id: string; readonly kind: 'number' }
  | { readonly id: string; readonly kind: 'boolean' }
  | { readonly id: string; readonly kind: 'label'; readonly labels: readonly string[] }

export interface EvaluationCorrelation { readonly runId?: string; readonly traceId?: string; readonly spanId?: string }
export interface EvaluationCost { readonly amount: number; readonly currency: string }
export interface EvaluationModelIdentity { readonly providerId: string; readonly model: string; readonly alias?: string; readonly responseModel?: string }
export interface EvaluationModelCall { readonly model: EvaluationModelIdentity; readonly usage?: TokenUsage; readonly cost?: EvaluationCost; readonly correlation?: EvaluationCorrelation }
export interface EvaluationAccounting { readonly completeness: 'complete' | 'partial'; readonly modelCalls: readonly EvaluationModelCall[] }
export interface EvaluationExecutionProvenance {
  readonly attempts: number
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly correlation?: EvaluationCorrelation
  readonly accounting?: EvaluationAccounting
}

/** Content-bearing application-owned handoff. Core never persists or returns its content. */
export interface EvaluationObservation<Assessment = unknown, O = unknown, ScorerContext = unknown> {
  readonly id: string
  readonly datasetId: string
  readonly datasetVersion: string
  readonly caseId: string
  readonly segments?: Readonly<Record<string, string>>
  readonly candidateId: string
  readonly candidateVersion: string
  readonly taskId: string
  readonly taskVersion: string
  readonly trialId: string
  readonly trialOrdinal: number
  readonly output: O
  readonly assessment?: Assessment
  readonly scorerContext?: ScorerContext
  readonly outputRef?: string
  readonly execution?: EvaluationExecutionProvenance
}

export interface EvaluationTaskTarget<I, Candidate> {
  readonly evaluationRunId: string
  readonly datasetId: string
  readonly datasetVersion: string
  readonly caseId: string
  readonly segments?: Readonly<Record<string, string>>
  readonly candidateId: string
  readonly candidateVersion: string
  readonly candidate: Candidate
  readonly trialId: string
  readonly trialOrdinal: number
  readonly input: I
  readonly attempt: number
}

export interface EvaluationTaskOutput<O = unknown, ScorerContext = unknown> {
  readonly output: O
  readonly scorerContext?: ScorerContext
  readonly outputRef?: string
  readonly correlation?: EvaluationCorrelation
  readonly accounting?: EvaluationAccounting
}

export interface EvaluationTask<I, Candidate, O, ScorerContext = unknown> {
  readonly id: string
  readonly version: string
  readonly run: (target: EvaluationTaskTarget<I, Candidate>, signal: AbortSignal) => Promise<EvaluationTaskOutput<O, ScorerContext>>
}

export type EvaluationEvidence =
  | { readonly kind: 'inline'; readonly value: JsonValue }
  | { readonly kind: 'reference'; readonly ref: string }
  | { readonly kind: 'omitted'; readonly reason: 'size_limit'; readonly originalBytes: number }

export type EvaluationDimensionResult =
  | { readonly outcome: 'scored'; readonly dimensionId: string; readonly kind: 'number' | 'boolean' | 'label'; readonly value: number | boolean | string; readonly passed?: boolean; readonly evidence?: EvaluationEvidence }
  | { readonly outcome: 'not_applicable'; readonly dimensionId: string; readonly kind: 'number' | 'boolean' | 'label'; readonly evidence?: EvaluationEvidence }
  | { readonly outcome: 'inconclusive'; readonly dimensionId: string; readonly kind: 'number' | 'boolean' | 'label'; readonly reason: 'insufficient_evidence' | 'ambiguous_reference' | 'scorer_abstained'; readonly evidence?: EvaluationEvidence }

export interface EvaluationScorerOutput {
  readonly dimensions: readonly EvaluationDimensionResult[]
  readonly correlation?: EvaluationCorrelation
  readonly accounting?: EvaluationAccounting
}

export interface EvaluationScorerTarget<Assessment, O, ScorerContext> {
  readonly evaluationRunId: string
  readonly observation: EvaluationObservation<Assessment, O, ScorerContext>
  readonly attempt: number
}

/** A normal adapter object: deterministic checks, judges, and external metrics share this shape. */
export interface EvaluationScorer<Assessment = unknown, O = unknown, ScorerContext = unknown> {
  readonly id: string
  readonly version: string
  readonly dimensions: readonly EvaluationDimensionDefinition[]
  readonly score: (target: EvaluationScorerTarget<Assessment, O, ScorerContext>, signal: AbortSignal) => Promise<EvaluationScorerOutput>
}

export interface DeterministicEvaluationScorerDefinition<Assessment = unknown, O = unknown, ScorerContext = unknown> {
  readonly id: string
  readonly version: string
  readonly dimension: EvaluationDimensionDefinition
  readonly evaluate: (observation: EvaluationObservation<Assessment, O, ScorerContext>) => EvaluationDimensionResult
}

/** Creates one ordinary scorer adapter; it deliberately does not implement a partial schema language. */
export function createDeterministicEvaluationScorer<Assessment = unknown, O = unknown, ScorerContext = unknown>(
  definition: DeterministicEvaluationScorerDefinition<Assessment, O, ScorerContext>
): EvaluationScorer<Assessment, O, ScorerContext> {
  validateId('scorer id', definition.id)
  validateVersion('scorer version', definition.version)
  validateDimension(definition.dimension)
  if (typeof definition.evaluate !== 'function') invalid('Deterministic scorer evaluate must be a function.', { evaluate: 'invalid' })
  return {
    id: definition.id,
    version: definition.version,
    dimensions: [definition.dimension],
    async score(target) {
      return { dimensions: [definition.evaluate(target.observation)] }
    }
  }
}

export type EvaluationFailurePolicy = 'continue' | 'fail_fast'
export interface EvaluationRetryPolicy { readonly maxAttempts: number; readonly delayMs?: number; readonly shouldRetry?: (error: unknown, attempt: number) => boolean }
export interface EvaluationTimeouts { readonly runMs?: number; readonly taskMs?: number; readonly scorerMs?: number }

export interface EvaluationRunInput<I, Assessment, Candidate, O, ScorerContext = unknown> {
  readonly runId: string
  readonly dataset: EvaluationDataset<I, Assessment>
  readonly candidates: readonly EvaluationCandidate<Candidate>[]
  readonly trials?: readonly EvaluationTrial[]
  readonly task: EvaluationTask<I, Candidate, O, ScorerContext>
  readonly scorers: readonly EvaluationScorer<Assessment, O, ScorerContext>[]
  readonly aggregateBy?: readonly string[]
  readonly maxConcurrency?: number
  readonly failurePolicy?: EvaluationFailurePolicy
  readonly retry?: { readonly task?: EvaluationRetryPolicy; readonly scorer?: EvaluationRetryPolicy }
  readonly timeouts?: EvaluationTimeouts
  readonly signal?: AbortSignal
  readonly telemetry?: TelemetryShim
  readonly telemetryOptions?: TelemetryOptions
}

export interface EvaluationScoreInput<Assessment, O, ScorerContext = unknown> {
  readonly runId: string
  readonly observations: readonly EvaluationObservation<Assessment, O, ScorerContext>[]
  readonly scorers: readonly EvaluationScorer<Assessment, O, ScorerContext>[]
  readonly aggregateBy?: readonly string[]
  readonly maxConcurrency?: number
  readonly failurePolicy?: EvaluationFailurePolicy
  readonly retry?: { readonly scorer?: EvaluationRetryPolicy }
  readonly timeouts?: Pick<EvaluationTimeouts, 'runMs' | 'scorerMs'>
  readonly signal?: AbortSignal
  readonly telemetry?: TelemetryShim
  readonly telemetryOptions?: TelemetryOptions
}

export type EvaluationRunMode = 'execute_and_score' | 'score_only'
export type EvaluationRunStatus = 'completed' | 'completed_with_errors' | 'failed' | 'cancelled' | 'timed_out'
export type EvaluationCaseStatus = 'completed' | 'completed_with_errors' | 'task_error' | 'cancelled' | 'timed_out' | 'skipped'
export type EvaluationScorerStatus = 'completed' | 'error' | 'cancelled' | 'timed_out' | 'skipped'
export interface EvaluationErrorRecord { readonly stage: 'task' | 'scorer'; readonly code: string; readonly category: ErrorCategory; readonly retriable: boolean; readonly attempt: number }
export interface EvaluationScorerResultRecord {
  readonly scorerId: string
  readonly scorerVersion: string
  readonly status: EvaluationScorerStatus
  readonly attempts: number
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly correlation?: EvaluationCorrelation
  readonly accounting?: EvaluationAccounting
  readonly dimensions: readonly EvaluationDimensionResult[]
  readonly error?: EvaluationErrorRecord
  readonly skipReason?: 'task_failed' | 'failure_policy' | 'cancelled' | 'run_timeout'
}
export interface EvaluationTaskResultRecord {
  readonly status: 'completed' | 'error' | 'cancelled' | 'timed_out' | 'not_run'
  readonly attempts: number
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly outputRef?: string
  readonly correlation?: EvaluationCorrelation
  readonly accounting?: EvaluationAccounting
  readonly error?: EvaluationErrorRecord
}
export interface EvaluationCaseResult {
  readonly ordinal: number
  readonly observationId?: string
  readonly datasetId: string
  readonly datasetVersion: string
  readonly caseId: string
  readonly segments?: Readonly<Record<string, string>>
  readonly candidateId: string
  readonly candidateVersion: string
  readonly taskId: string
  readonly taskVersion: string
  readonly trialId: string
  readonly trialOrdinal: number
  readonly status: EvaluationCaseStatus
  readonly evaluationDurationMs?: number
  readonly task: EvaluationTaskResultRecord
  readonly scorers: readonly EvaluationScorerResultRecord[]
  readonly skipReason?: 'failure_policy' | 'cancelled' | 'run_timeout'
}

export type EvaluationAggregateScope = { readonly kind: 'all' } | { readonly kind: 'segment'; readonly key: string; readonly value: string } | { readonly kind: 'segment_missing'; readonly key: string }
export interface EvaluationDistribution { readonly count: number; readonly min: number; readonly max: number; readonly mean: number; readonly p50: number; readonly p95: number }
export interface EvaluationCoverage { readonly planned: number; readonly completed: number; readonly scored: number; readonly notApplicable: number; readonly inconclusive: number; readonly errored: number; readonly skipped: number }
export interface EvaluationAccountingSummary { readonly completeness: 'complete' | 'partial' | 'unknown'; readonly reportedModelCallCount: number; readonly tokenTotals?: TokenUsage; readonly costTotals: readonly EvaluationCost[] }
export interface EvaluationCandidateAggregate {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly scope: EvaluationAggregateScope
  readonly caseCount: number
  readonly statusCounts: Readonly<Record<EvaluationCaseStatus, number>>
  readonly evaluationDurationMs?: EvaluationDistribution
  readonly taskDurationMs?: EvaluationDistribution
  readonly taskAccounting: EvaluationAccountingSummary
  readonly scorerAccounting: EvaluationAccountingSummary
  readonly combinedAccounting: EvaluationAccountingSummary
}
export interface EvaluationDimensionAggregate {
  readonly candidateId: string
  readonly candidateVersion: string
  readonly scorerId: string
  readonly scorerVersion: string
  readonly dimensionId: string
  readonly kind: EvaluationDimensionDefinition['kind']
  readonly scope: EvaluationAggregateScope
  readonly scorerStatusCounts: Readonly<Record<EvaluationScorerStatus, number>>
  readonly coverage: EvaluationCoverage
  readonly numeric?: EvaluationDistribution
  readonly booleanCounts?: { readonly true: number; readonly false: number }
  readonly labelCounts?: readonly { readonly label: string; readonly count: number }[]
  readonly passCounts?: { readonly passed: number; readonly failed: number; readonly rate: number }
  readonly scorerDurationMs?: EvaluationDistribution
  readonly scorerAccounting: EvaluationAccountingSummary
}
export interface EvaluationRunResult {
  readonly runId: string
  readonly mode: EvaluationRunMode
  readonly status: EvaluationRunStatus
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly dataset: { readonly id: string; readonly version: string; readonly caseCount: number }
  readonly task: { readonly id: string; readonly version: string }
  readonly scorers: readonly { readonly id: string; readonly version: string; readonly dimensions: readonly EvaluationDimensionDefinition[] }[]
  readonly cases: readonly EvaluationCaseResult[]
  readonly candidateAggregates: readonly EvaluationCandidateAggregate[]
  readonly dimensionAggregates: readonly EvaluationDimensionAggregate[]
}

export interface EvaluationFeedbackProjectionOptions { readonly target: (result: EvaluationCaseResult) => FeedbackTarget | undefined }

export function evaluationResultToFeedbackRecords(result: EvaluationRunResult, options: EvaluationFeedbackProjectionOptions): readonly FeedbackRecord[] {
  const records: FeedbackRecord[] = []
  for (const row of result.cases) {
    const target = options.target(row)
    if (!target) continue
    for (const scorer of row.scorers) if (scorer.status === 'completed') for (const dimension of scorer.dimensions) if (dimension.outcome === 'scored') {
      const base = { id: `eval-feedback/${result.runId}/${row.candidateId}/${row.caseId}/${row.trialId}/${scorer.scorerId}/${dimension.dimensionId}`, target, source: 'evaluator' as const, label: `${scorer.scorerId}/${dimension.dimensionId}`, createdAt: scorer.finishedAt ?? result.finishedAt, metadata: { evaluationRunId: result.runId, datasetId: row.datasetId, datasetVersion: row.datasetVersion, candidateId: row.candidateId, candidateVersion: row.candidateVersion, taskId: row.taskId, taskVersion: row.taskVersion, trialId: row.trialId, scorerId: scorer.scorerId, scorerVersion: scorer.scorerVersion, dimensionId: dimension.dimensionId, kind: dimension.kind, ...(dimension.passed === undefined ? {} : { passed: dimension.passed }), ...(dimension.kind === 'label' ? { value: dimension.value } : {}) } }
      if (dimension.kind === 'number') records.push({ ...base, score: dimension.value as number })
      else if (dimension.kind === 'boolean') records.push({ ...base, score: dimension.value ? 1 : 0 })
      else records.push(base)
    }
  }
  return records
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const MAX_EVIDENCE_BYTES = 4096

interface RowIdentity { readonly datasetId: string; readonly datasetVersion: string; readonly caseId: string; readonly segments?: Readonly<Record<string, string>>; readonly candidateId: string; readonly candidateVersion: string; readonly taskId: string; readonly taskVersion: string; readonly trialId: string; readonly trialOrdinal: number }
interface Row<A, O, S> { ordinal: number; identity: RowIdentity; observation?: EvaluationObservation<A, O, S>; task?: (signal: AbortSignal) => Promise<EvaluationObservation<A, O, S>> }
interface Retry { maxAttempts: number; delayMs: number; shouldRetry?: (error: unknown, attempt: number) => boolean }

/** Executes candidate/case/trial rows and scores the resulting observations. */
export async function runEvaluation<I, Assessment, Candidate, O, ScorerContext = unknown>(input: EvaluationRunInput<I, Assessment, Candidate, O, ScorerContext>): Promise<EvaluationRunResult> {
  validateRunInput(input)
  const trials = input.trials ?? [{ id: 'default' }]
  const rows: Row<Assessment, O, ScorerContext>[] = []
  for (const candidate of input.candidates) for (const testCase of input.dataset.cases) for (const [trialOrdinal, trial] of trials.entries()) {
    const identity: RowIdentity = { datasetId: input.dataset.id, datasetVersion: input.dataset.version, caseId: testCase.id, ...(testCase.segments === undefined ? {} : { segments: copySegments(testCase.segments) }), candidateId: candidate.id, candidateVersion: candidate.version, taskId: input.task.id, taskVersion: input.task.version, trialId: trial.id, trialOrdinal }
    rows.push({ ordinal: rows.length, identity, task: async (signal) => {
      const startedAt = now()
      const attempt = await withRetry(input.retry?.task, input.timeouts?.taskMs, (attemptSignal, attempt) => input.task.run({ evaluationRunId: input.runId, datasetId: input.dataset.id, datasetVersion: input.dataset.version, caseId: testCase.id, ...(testCase.segments === undefined ? {} : { segments: testCase.segments }), candidateId: candidate.id, candidateVersion: candidate.version, candidate: candidate.config, trialId: trial.id, trialOrdinal, input: testCase.input, attempt }, attemptSignal), signal)
      if (!attempt.ok) throw new RowTaskError(attempt.error, attempt.attempts, startedAt, now())
      const value = validateTaskOutput(attempt.value)
      return { id: `${input.runId}:${candidate.id}:${testCase.id}:${trial.id}`, datasetId: input.dataset.id, datasetVersion: input.dataset.version, caseId: testCase.id, ...(testCase.segments === undefined ? {} : { segments: copySegments(testCase.segments) }), candidateId: candidate.id, candidateVersion: candidate.version, taskId: input.task.id, taskVersion: input.task.version, trialId: trial.id, trialOrdinal, output: value.output as O, ...(testCase.assessment === undefined ? {} : { assessment: testCase.assessment }), ...(value.scorerContext === undefined ? {} : { scorerContext: value.scorerContext as ScorerContext }), ...(value.outputRef === undefined ? {} : { outputRef: value.outputRef }), execution: { attempts: attempt.attempts, startedAt, finishedAt: now(), durationMs: duration(startedAt), ...(value.correlation === undefined ? {} : { correlation: copyCorrelation(value.correlation) }), ...(value.accounting === undefined ? {} : { accounting: copyAccounting(value.accounting) }) } } as EvaluationObservation<Assessment, O, ScorerContext>
    } })
  }
  return await evaluateRows('execute_and_score', input.runId, { dataset: { id: input.dataset.id, version: input.dataset.version, caseCount: input.dataset.cases.length }, task: { id: input.task.id, version: input.task.version }, scorers: scorerSummaries(input.scorers) }, rows, input.scorers, input.aggregateBy, input.maxConcurrency, input.failurePolicy, input.retry?.scorer, input.timeouts, input.signal, input.telemetry)
}

/** Applies new scorer versions to caller-owned observations without task execution. */
export async function scoreEvaluation<Assessment, O, ScorerContext = unknown>(input: EvaluationScoreInput<Assessment, O, ScorerContext>): Promise<EvaluationRunResult> {
  validateScoreInput(input)
  const first = input.observations[0]!
  return await evaluateRows('score_only', input.runId, { dataset: { id: first.datasetId, version: first.datasetVersion, caseCount: input.observations.length }, task: { id: first.taskId, version: first.taskVersion }, scorers: scorerSummaries(input.scorers) }, input.observations.map((observation, ordinal) => ({ ordinal, identity: observationIdentity(observation), observation })), input.scorers, input.aggregateBy, input.maxConcurrency, input.failurePolicy, input.retry?.scorer, input.timeouts, input.signal, input.telemetry)
}

async function evaluateRows<A, O, S>(mode: EvaluationRunMode, runId: string, summary: Pick<EvaluationRunResult, 'dataset' | 'task' | 'scorers'>, rows: readonly Row<A, O, S>[], scorers: readonly EvaluationScorer<A, O, S>[], aggregateBy: readonly string[] | undefined, maxConcurrency = 1, failurePolicy: EvaluationFailurePolicy = 'continue', scorerRetry: EvaluationRetryPolicy | undefined, timeouts: Pick<EvaluationTimeouts, 'runMs' | 'scorerMs'> | undefined, external: AbortSignal | undefined, telemetry: TelemetryShim | undefined): Promise<EvaluationRunResult> {
  const startedAt = now()
  const controller = new AbortController()
  let stop: 'failure_policy' | 'cancelled' | 'run_timeout' | undefined
  const stopNow = (reason: NonNullable<typeof stop>) => { if (stop) return; stop = reason; controller.abort(reason === 'run_timeout' ? new OperationTimeoutError('Evaluation timed out.', { scope: 'run', timeout_ms: timeouts?.runMs ?? 0 }) : new OperationCancelledError('Evaluation cancelled.', { scope: 'run' })) }
  if (external) { if (external.aborted) stopNow('cancelled'); else external.addEventListener('abort', () => stopNow('cancelled'), { once: true }) }
  const timer = timeouts?.runMs === undefined ? undefined : setTimeout(() => stopNow('run_timeout'), timeouts.runMs)
  const results = new Array<EvaluationCaseResult | undefined>(rows.length)
  const candidateOrdinals = new Map<string, number>()
  for (const row of rows) {
    const key = `${row.identity.candidateId}\u0000${row.identity.candidateVersion}`
    if (!candidateOrdinals.has(key)) candidateOrdinals.set(key, candidateOrdinals.size)
  }
  let next = 0
  const work = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      const index = next++
      if (index >= rows.length) return
      const row = rows[index]!
      const candidateKey = `${row.identity.candidateId}\u0000${row.identity.candidateVersion}`
      const result = await safeSpan(telemetry, 'harness.eval.case', { 'harness.eval.mode': mode, 'harness.eval.task.id': summary.task.id, 'harness.eval.task.version': summary.task.version, 'harness.eval.candidate.ordinal': candidateOrdinals.get(candidateKey), 'harness.eval.case.ordinal': row.ordinal }, async () => await evaluateRow(mode, runId, row, scorers, scorerRetry, timeouts?.scorerMs, controller.signal, telemetry, summary.task, () => { if (failurePolicy === 'fail_fast') stopNow('failure_policy') }, () => stop))
      results[index] = result
      recordRowMetrics(telemetry, summary.task, mode, result)
      if (failurePolicy === 'fail_fast' && rowFailed(result)) stopNow('failure_policy')
    }
  }
  await safeSpan(telemetry, 'harness.eval.run', { 'harness.eval.task.id': summary.task.id, 'harness.eval.task.version': summary.task.version, 'harness.eval.mode': mode, 'harness.eval.candidate.count': candidateOrdinals.size, 'harness.eval.case.count': summary.dataset.caseCount, 'harness.eval.scorer.count': scorers.length, 'harness.eval.trial.count': new Set(rows.map(row => row.identity.trialId)).size, 'harness.eval.max_concurrency': maxConcurrency, 'harness.eval.failure_policy': failurePolicy }, async () => await Promise.all(Array.from({ length: Math.min(maxConcurrency, rows.length) }, work)))
  if (timer) clearTimeout(timer)
  for (const row of rows) if (!results[row.ordinal]) results[row.ordinal] = placeholder(row, stop ?? 'cancelled', scorers)
  const cases = results as EvaluationCaseResult[]
  const status: EvaluationRunStatus = stop === 'run_timeout' ? 'timed_out' : stop === 'cancelled' ? 'cancelled' : stop === 'failure_policy' ? 'failed' : cases.some(rowFailed) ? 'completed_with_errors' : 'completed'
  const result = { runId, mode, status, startedAt, finishedAt: now(), durationMs: duration(startedAt), ...summary, cases, candidateAggregates: candidateAggregates(cases, aggregateBy ?? []), dimensionAggregates: dimensionAggregates(cases, scorers as readonly EvaluationScorer<any, any, any>[], aggregateBy ?? []) }
  safeMetric(telemetry, 'harness.eval.runs', 'counter', 1, { 'harness.eval.task.id': summary.task.id, 'harness.eval.task.version': summary.task.version, 'harness.eval.mode': mode, 'harness.eval.failure_policy': failurePolicy, 'harness.eval.status': status })
  safeMetric(telemetry, 'harness.eval.run.duration', 'histogram', result.durationMs / 1000, { 'harness.eval.task.id': summary.task.id, 'harness.eval.task.version': summary.task.version, 'harness.eval.mode': mode, 'harness.eval.status': status })
  return deepFreeze(result)
}

async function evaluateRow<A, O, S>(mode: EvaluationRunMode, runId: string, row: Row<A, O, S>, scorers: readonly EvaluationScorer<A, O, S>[], retryPolicy: EvaluationRetryPolicy | undefined, timeoutMs: number | undefined, signal: AbortSignal, telemetry: TelemetryShim | undefined, taskSummary: { id: string; version: string }, onFailure: () => void, stopReason: () => 'failure_policy' | 'cancelled' | 'run_timeout' | undefined): Promise<EvaluationCaseResult> {
  const startedAt = now()
  let observation: EvaluationObservation<A, O, S>
  try { observation = row.observation ?? await row.task!(signal) } catch (error) { const result = taskFailure(row, error, scorers, startedAt); if (result.status === 'task_error' || result.status === 'timed_out') onFailure(); return result }
  const scorerResults: EvaluationScorerResultRecord[] = []
  for (const scorer of scorers) {
    if (signal.aborted) { scorerResults.push(scorerPlaceholder(scorer, stopReason() ?? (signal.reason instanceof OperationTimeoutError ? 'run_timeout' : 'cancelled'))); continue }
    const scorerStarted = now()
    const attempt = await safeSpan(telemetry, 'harness.eval.scorer', { 'harness.eval.task.id': taskSummary.id, 'harness.eval.task.version': taskSummary.version, 'harness.eval.scorer.id': scorer.id, 'harness.eval.scorer.version': scorer.version }, async () => await withRetry(retryPolicy, timeoutMs, (scorerSignal, attempt) => scorer.score({ evaluationRunId: runId, observation, attempt }, scorerSignal), signal))
    if (!attempt.ok) { const status = terminalScorerStatus(attempt.error, signal); scorerResults.push({ scorerId: scorer.id, scorerVersion: scorer.version, status, attempts: attempt.attempts, startedAt: scorerStarted, finishedAt: now(), durationMs: duration(scorerStarted), dimensions: [], error: errorRecord('scorer', attempt.error, attempt.attempts) }); if (status === 'error' || status === 'timed_out') onFailure(); continue }
    try {
      const output = validateScorerOutput(scorer, attempt.value)
      scorerResults.push({ scorerId: scorer.id, scorerVersion: scorer.version, status: 'completed', attempts: attempt.attempts, startedAt: scorerStarted, finishedAt: now(), durationMs: duration(scorerStarted), ...(output.correlation === undefined ? {} : { correlation: copyCorrelation(output.correlation) }), ...(output.accounting === undefined ? {} : { accounting: copyAccounting(output.accounting) }), dimensions: output.dimensions })
    } catch (error) { scorerResults.push({ scorerId: scorer.id, scorerVersion: scorer.version, status: 'error', attempts: attempt.attempts, startedAt: scorerStarted, finishedAt: now(), durationMs: duration(scorerStarted), dimensions: [], error: errorRecord('scorer', error, attempt.attempts) }); onFailure() }
  }
  const task = taskResult(mode, observation)
  return { ordinal: row.ordinal, ...(mode === 'score_only' ? { observationId: observation.id } : {}), datasetId: observation.datasetId, datasetVersion: observation.datasetVersion, caseId: observation.caseId, ...(observation.segments === undefined ? {} : { segments: copySegments(observation.segments) }), candidateId: observation.candidateId, candidateVersion: observation.candidateVersion, taskId: observation.taskId, taskVersion: observation.taskVersion, trialId: observation.trialId, trialOrdinal: observation.trialOrdinal, status: scorerResults.some(item => item.status !== 'completed') ? 'completed_with_errors' : 'completed', evaluationDurationMs: duration(startedAt), task, scorers: scorerResults }
}

class RowTaskError extends Error { public constructor(readonly causeValue: unknown, readonly attempts: number, readonly startedAt: string, readonly finishedAt: string) { super('Evaluation task failed.') } }
function taskFailure<A, O, S>(row: Row<A, O, S>, error: unknown, scorers: readonly EvaluationScorer<A, O, S>[], startedAt: string): EvaluationCaseResult {
  const taskError = error instanceof RowTaskError ? error.causeValue : error
  const details = error instanceof RowTaskError ? error : { attempts: 1, startedAt, finishedAt: now() }
  const observation = row.observation
  const identity = observation ? observationIdentity(observation) : row.identity
  const status = taskError instanceof OperationTimeoutError ? 'timed_out' : taskError instanceof OperationCancelledError ? 'cancelled' : 'task_error'
  return { ordinal: row.ordinal, ...(observation ? { observationId: observation.id } : {}), ...identity, status, evaluationDurationMs: duration(startedAt), task: { status: status === 'timed_out' ? 'timed_out' : status === 'cancelled' ? 'cancelled' : 'error', attempts: details.attempts, startedAt: details.startedAt, finishedAt: details.finishedAt, durationMs: duration(details.startedAt), error: errorRecord('task', taskError, details.attempts) }, scorers: scorers.map(scorer => scorerPlaceholder(scorer, 'task_failed')) }
}

function taskResult(mode: EvaluationRunMode, observation: EvaluationObservation): EvaluationTaskResultRecord {
  const execution = observation.execution
  if (!execution) return { status: mode === 'score_only' ? 'not_run' : 'completed', attempts: mode === 'score_only' ? 0 : 1, ...(observation.outputRef === undefined ? {} : { outputRef: observation.outputRef }) }
  return { status: 'completed', attempts: execution.attempts, ...(execution.startedAt === undefined ? {} : { startedAt: execution.startedAt }), ...(execution.finishedAt === undefined ? {} : { finishedAt: execution.finishedAt }), ...(execution.durationMs === undefined ? {} : { durationMs: execution.durationMs }), ...(observation.outputRef === undefined ? {} : { outputRef: observation.outputRef }), ...(execution.correlation === undefined ? {} : { correlation: copyCorrelation(execution.correlation) }), ...(execution.accounting === undefined ? {} : { accounting: copyAccounting(execution.accounting) }) }
}

async function withRetry<T>(policy: EvaluationRetryPolicy | undefined, timeoutMs: number | undefined, callback: (signal: AbortSignal, attempt: number) => Promise<T>, parent?: AbortSignal): Promise<{ ok: true; value: T; attempts: number } | { ok: false; error: unknown; attempts: number }> {
  validateRetry(policy)
  const attempts = policy?.maxAttempts ?? 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const outcome = await timeoutRace(signal => callback(signal, attempt), timeoutMs, parent)
    if (outcome.ok) return { ...outcome, attempts: attempt }
    if (parent?.aborted || attempt === attempts) return { ...outcome, attempts: attempt }
    try {
      if (!retryable(policy, outcome.error, attempt)) return { ...outcome, attempts: attempt }
    } catch (error) {
      return { ok: false, error, attempts: attempt }
    }
    const delay = policy?.delayMs ?? 0
    if (delay > 0) { const waited = await wait(delay, parent); if (!waited.ok) return { ok: false, error: waited.error, attempts: attempt } }
  }
  return { ok: false, error: new Error('Evaluation callback failed.'), attempts }
}

async function timeoutRace<T>(callback: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined, parent?: AbortSignal): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason ?? new OperationCancelledError('Evaluation cancelled.', { scope: 'run' }))
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true })
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new OperationTimeoutError('Evaluation callback timed out.', { scope: 'run', timeout_ms: timeoutMs })), timeoutMs)
  const call = Promise.resolve().then(() => callback(controller.signal))
  void call.catch(() => undefined)
  const cancelled = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }))
  try { return { ok: true, value: await Promise.race([call, cancelled]) } } catch (error) { return { ok: false, error } } finally { if (timer) clearTimeout(timer); parent?.removeEventListener('abort', abort) }
}

function validateRunInput<I, A, C, O, S>(input: EvaluationRunInput<I, A, C, O, S>): void {
  validateId('run id', input.runId); validateDataset(input.dataset); validateCandidates(input.candidates); validateTask(input.task); validateScorers(input.scorers); validateTrials(input.trials); validateOptions(input.aggregateBy, input.maxConcurrency, input.failurePolicy, input.retry, input.timeouts, input.dataset.cases)
}
function validateScoreInput<A, O, S>(input: EvaluationScoreInput<A, O, S>): void {
  validateId('run id', input.runId); if (input.observations.length === 0) invalid('At least one observation is required.', { observations: 'empty' }); validateScorers(input.scorers); validateOptions(input.aggregateBy, input.maxConcurrency, input.failurePolicy, input.retry, input.timeouts, input.observations.map(item => item.segments === undefined ? {} : { segments: item.segments })); const ids = new Set<string>(); const tuples = new Set<string>(); const first = input.observations[0]!; for (const observation of input.observations) { validateObservation(observation); if (observation.datasetId !== first.datasetId || observation.datasetVersion !== first.datasetVersion || observation.taskId !== first.taskId || observation.taskVersion !== first.taskVersion) invalid('Score observations must share dataset and task identity.', { observation: observation.id }); if (ids.has(observation.id)) invalid('Observation ids must be unique.', { id: observation.id }); ids.add(observation.id); const tuple = [observation.candidateId, observation.candidateVersion, observation.datasetId, observation.datasetVersion, observation.caseId, observation.taskId, observation.taskVersion, observation.trialId].join('\u0000'); if (tuples.has(tuple)) invalid('Observation identity tuples must be unique.', { observation: observation.id }); tuples.add(tuple) }
}
function validateDataset(dataset: EvaluationDataset): void { validateId('dataset id', dataset.id); validateVersion('dataset version', dataset.version); if (dataset.cases.length === 0) invalid('At least one case is required.', { cases: 'empty' }); unique(dataset.cases.map(item => item.id), 'case ids'); for (const item of dataset.cases) { validateId('case id', item.id); validateSegments(item.segments) } }
function validateCandidates(candidates: readonly EvaluationCandidate[]): void { if (candidates.length === 0) invalid('At least one candidate is required.', { candidates: 'empty' }); unique(candidates.map(item => item.id), 'candidate ids'); for (const candidate of candidates) { validateId('candidate id', candidate.id); validateVersion('candidate version', candidate.version) } }
function validateTask(task: EvaluationTask<any, any, any, any>): void { validateId('task id', task.id); validateVersion('task version', task.version); if (typeof task.run !== 'function') invalid('Task run must be a function.', { task: 'run' }) }
function validateTrials(trials: readonly EvaluationTrial[] | undefined): void { if (!trials) return; if (trials.length === 0) invalid('Trials must not be empty.', { trials: 'empty' }); unique(trials.map(item => item.id), 'trial ids'); trials.forEach(item => validateId('trial id', item.id)) }
function validateScorers(scorers: readonly EvaluationScorer<any, any, any>[]): void { if (scorers.length === 0) invalid('At least one scorer is required.', { scorers: 'empty' }); unique(scorers.map(item => item.id), 'scorer ids'); for (const scorer of scorers) { validateId('scorer id', scorer.id); validateVersion('scorer version', scorer.version); if (scorer.dimensions.length === 0 || typeof scorer.score !== 'function') invalid('Scorer definition is invalid.', { scorer: scorer.id }); unique(scorer.dimensions.map(item => item.id), 'dimension ids'); scorer.dimensions.forEach(validateDimension) } }
function validateDimension(dimension: EvaluationDimensionDefinition): void { validateId('dimension id', dimension.id); if (dimension.kind === 'label') { if (dimension.labels.length === 0) invalid('Label dimensions need labels.', { dimension: dimension.id }); unique(dimension.labels, 'labels'); for (const label of dimension.labels) if (typeof label !== 'string' || codePoints(label) === 0 || codePoints(label) > 128) invalid('Label is invalid.', { dimension: dimension.id }) } }
function validateOptions(aggregateBy: readonly string[] | undefined, maxConcurrency: number | undefined, failurePolicy: EvaluationFailurePolicy | undefined, retry: { task?: EvaluationRetryPolicy; scorer?: EvaluationRetryPolicy } | undefined, timeouts: EvaluationTimeouts | Pick<EvaluationTimeouts, 'runMs' | 'scorerMs'> | undefined, cases: readonly { readonly segments?: Readonly<Record<string, string>> }[]): void { if (maxConcurrency !== undefined) positive(maxConcurrency, 'maxConcurrency'); if (failurePolicy !== undefined && failurePolicy !== 'continue' && failurePolicy !== 'fail_fast') invalid('Failure policy is invalid.', { failurePolicy }); validateRetry(retry?.task); validateRetry(retry?.scorer); if (timeouts) for (const [key, value] of Object.entries(timeouts)) if (value !== undefined) positive(value, key); const keys = new Set(cases.flatMap(item => Object.keys(item.segments ?? {}))); unique(aggregateBy ?? [], 'aggregateBy'); for (const key of aggregateBy ?? []) { validateId('aggregateBy key', key); if (!keys.has(key)) invalid('aggregateBy names an undeclared segment.', { key }) } }
function validateRetry(retry: EvaluationRetryPolicy | undefined): void { if (!retry) return; positive(retry.maxAttempts, 'retry.maxAttempts'); if (retry.delayMs !== undefined && (!Number.isSafeInteger(retry.delayMs) || retry.delayMs < 0)) invalid('retry.delayMs is invalid.', { delayMs: retry.delayMs }); if (retry.shouldRetry !== undefined && typeof retry.shouldRetry !== 'function') invalid('retry.shouldRetry is invalid.', { shouldRetry: 'invalid' }) }
function validateObservation(observation: EvaluationObservation): void { validateId('observation id', observation.id); validateId('dataset id', observation.datasetId); validateVersion('dataset version', observation.datasetVersion); validateId('case id', observation.caseId); validateId('candidate id', observation.candidateId); validateVersion('candidate version', observation.candidateVersion); validateId('task id', observation.taskId); validateVersion('task version', observation.taskVersion); validateId('trial id', observation.trialId); if (!Number.isSafeInteger(observation.trialOrdinal) || observation.trialOrdinal < 0) invalid('trialOrdinal is invalid.', { trialOrdinal: observation.trialOrdinal }); validateSegments(observation.segments); validateOpaque(observation.outputRef, 'outputRef'); validateExecution(observation.execution) }
function validateTaskOutput(value: EvaluationTaskOutput): EvaluationTaskOutput { if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'output')) invalid('Task output is invalid.', { task: 'output' }); validateOpaque(value.outputRef, 'outputRef'); validateCorrelation(value.correlation); validateAccounting(value.accounting); return value }
function validateScorerOutput(scorer: EvaluationScorer<any, any, any>, value: EvaluationScorerOutput): { dimensions: EvaluationDimensionResult[]; correlation?: EvaluationCorrelation; accounting?: EvaluationAccounting } { if (!value || !Array.isArray(value.dimensions)) invalid('Scorer output is invalid.', { scorer: scorer.id }); validateCorrelation(value.correlation); validateAccounting(value.accounting); const results = new Map(value.dimensions.map(item => [item.dimensionId, item])); if (results.size !== value.dimensions.length || results.size !== scorer.dimensions.length) invalid('Scorer must return every dimension exactly once.', { scorer: scorer.id }); return { dimensions: scorer.dimensions.map(definition => { const result = results.get(definition.id); if (!result) invalid('Scorer dimension is missing.', { dimension: definition.id }); validateDimensionResult(definition, result); return normalizeDimension(result) }), ...(value.correlation === undefined ? {} : { correlation: copyCorrelation(value.correlation) }), ...(value.accounting === undefined ? {} : { accounting: copyAccounting(value.accounting) }) } }
function validateDimensionResult(definition: EvaluationDimensionDefinition, result: EvaluationDimensionResult): void { if (result.dimensionId !== definition.id || result.kind !== definition.kind) invalid('Scorer dimension identity or kind is invalid.', { dimension: definition.id }); if (result.outcome === 'scored') { if (definition.kind === 'number' && (typeof result.value !== 'number' || !Number.isFinite(result.value))) invalid('Number result is invalid.', { dimension: definition.id }); if (definition.kind === 'boolean' && typeof result.value !== 'boolean') invalid('Boolean result is invalid.', { dimension: definition.id }); if (definition.kind === 'label' && (typeof result.value !== 'string' || !definition.labels.includes(result.value))) invalid('Label result is invalid.', { dimension: definition.id }); if (result.passed !== undefined && typeof result.passed !== 'boolean') invalid('passed is invalid.', { dimension: definition.id }) } else if (result.outcome === 'inconclusive') { if (!['insufficient_evidence', 'ambiguous_reference', 'scorer_abstained'].includes(result.reason)) invalid('Inconclusive reason is invalid.', { dimension: definition.id }) } else if (result.outcome !== 'not_applicable') invalid('Dimension outcome is invalid.', { dimension: definition.id }); validateEvidence(result.evidence) }
function validateEvidence(evidence: EvaluationEvidence | undefined): void { if (!evidence) return; if (evidence.kind === 'inline') jsonBytes(evidence.value); else if (evidence.kind === 'reference') validateOpaque(evidence.ref, 'evidence ref'); else if (evidence.kind !== 'omitted' || evidence.reason !== 'size_limit' || !Number.isSafeInteger(evidence.originalBytes) || evidence.originalBytes < 0) invalid('Evidence is invalid.', { evidence: 'invalid' }) }
function validateExecution(execution: EvaluationExecutionProvenance | undefined): void { if (!execution) return; if (!Number.isSafeInteger(execution.attempts) || execution.attempts < 1) invalid('Execution attempts are invalid.', { execution: 'attempts' }); if (execution.durationMs !== undefined && (!Number.isSafeInteger(execution.durationMs) || execution.durationMs < 0)) invalid('Execution duration is invalid.', { execution: 'durationMs' }); validateCorrelation(execution.correlation); validateAccounting(execution.accounting) }
function validateAccounting(accounting: EvaluationAccounting | undefined): void { if (!accounting) return; if (accounting.completeness !== 'complete' && accounting.completeness !== 'partial') invalid('Accounting completeness is invalid.', { accounting: 'completeness' }); if (!Array.isArray(accounting.modelCalls)) invalid('Accounting model calls are invalid.', { accounting: 'modelCalls' }); for (const call of accounting.modelCalls) { if (!call || typeof call !== 'object') invalid('Model call is invalid.', { accounting: 'modelCall' }); for (const value of [call.model.providerId, call.model.model, call.model.alias, call.model.responseModel]) if (value !== undefined && (typeof value !== 'string' || codePoints(value) === 0 || codePoints(value) > 256)) invalid('Model identity is invalid.', { accounting: 'model' }); if (call.usage) for (const value of [call.usage.inputTokens, call.usage.outputTokens, call.usage.totalTokens, call.usage.cachedInputTokens, call.usage.cacheCreationInputTokens, call.usage.reasoningTokens]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) invalid('Usage is invalid.', { accounting: 'usage' }); if (call.cost && (!Number.isFinite(call.cost.amount) || call.cost.amount < 0 || !/^[A-Z]{3}$/.test(call.cost.currency))) invalid('Cost is invalid.', { accounting: 'cost' }); validateCorrelation(call.correlation) } }
function validateCorrelation(correlation: EvaluationCorrelation | undefined): void { if (!correlation) return; if (correlation.runId !== undefined) validateId('correlation runId', correlation.runId); if (correlation.traceId !== undefined && !/^(?!0{32}$)[0-9a-f]{32}$/.test(correlation.traceId)) invalid('traceId is invalid.', { traceId: correlation.traceId }); if (correlation.spanId !== undefined && !/^(?!0{16}$)[0-9a-f]{16}$/.test(correlation.spanId)) invalid('spanId is invalid.', { spanId: correlation.spanId }) }
function validateSegments(segments: Readonly<Record<string, string>> | undefined): void { for (const [key, value] of Object.entries(segments ?? {})) { validateId('segment key', key); if (typeof value !== 'string' || codePoints(value) > 128) invalid('Segment value is invalid.', { key }) } }
function validateOpaque(value: string | undefined, name: string): void { if (value !== undefined && (typeof value !== 'string' || codePoints(value) === 0 || codePoints(value) > 256)) invalid(`${name} is invalid.`, { [name]: value }) }
function validateId(name: string, value: string): void { if (typeof value !== 'string' || !ID.test(value)) invalid(`${name} is invalid.`, { [name]: value }) }
function validateVersion(name: string, value: string): void { if (typeof value !== 'string' || !VERSION.test(value)) invalid(`${name} is invalid.`, { [name]: value }) }
function unique(values: readonly string[], name: string): void { if (new Set(values).size !== values.length) invalid(`${name} must be unique.`, { [name]: 'duplicate' }) }
function positive(value: number, name: string): void { if (!Number.isSafeInteger(value) || value < 1) invalid(`${name} must be a positive safe integer.`, { [name]: value }) }
function invalid(message: string, issues: unknown): never { throw new ValidationError(message, { where: 'eval_input', issues }) }

function retryable(policy: EvaluationRetryPolicy | undefined, error: unknown, attempt: number): boolean { if (error instanceof OperationTimeoutError || error instanceof OperationCancelledError || error instanceof ValidationError) return false; if (policy?.shouldRetry) return policy.shouldRetry(error, attempt); return error instanceof HarnessError && error.retriable }
function wait(ms: number, signal: AbortSignal | undefined): Promise<{ ok: true } | { ok: false; error: unknown }> { return new Promise(resolve => { if (signal?.aborted) return resolve({ ok: false, error: signal.reason }); const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve({ ok: true }) }, ms); const abort = () => { clearTimeout(timer); resolve({ ok: false, error: signal?.reason }) }; signal?.addEventListener('abort', abort, { once: true }) }) }
function terminalScorerStatus(error: unknown, signal: AbortSignal): EvaluationScorerStatus { return error instanceof OperationTimeoutError || (signal.aborted && signal.reason instanceof OperationTimeoutError) ? 'timed_out' : error instanceof OperationCancelledError || signal.aborted ? 'cancelled' : 'error' }
function errorRecord(stage: 'task' | 'scorer', error: unknown, attempt: number): EvaluationErrorRecord { return error instanceof HarnessError ? { stage, code: error.code, category: error.category, retriable: error.retriable, attempt } : { stage, code: 'EVALUATION_CALLBACK_ERROR', category: 'internal', retriable: false, attempt } }
function scorerPlaceholder(scorer: EvaluationScorer<any, any, any>, reason: NonNullable<EvaluationScorerResultRecord['skipReason']>): EvaluationScorerResultRecord { return { scorerId: scorer.id, scorerVersion: scorer.version, status: reason === 'run_timeout' ? 'timed_out' : reason === 'cancelled' ? 'cancelled' : 'skipped', attempts: 0, dimensions: [], skipReason: reason } }
function placeholder<A, O, S>(row: Row<A, O, S>, reason: 'failure_policy' | 'cancelled' | 'run_timeout', scorers: readonly EvaluationScorer<A, O, S>[]): EvaluationCaseResult { const observation = row.observation; const identity = observation ? observationIdentity(observation) : row.identity; return { ordinal: row.ordinal, ...(observation ? { observationId: observation.id } : {}), ...identity, status: reason === 'failure_policy' ? 'skipped' : reason === 'run_timeout' ? 'timed_out' : 'cancelled', task: { status: reason === 'run_timeout' ? 'timed_out' : reason === 'cancelled' ? 'cancelled' : 'not_run', attempts: 0 }, scorers: scorers.map(scorer => scorerPlaceholder(scorer, reason)), skipReason: reason } }
function rowFailed(row: EvaluationCaseResult): boolean { return row.status !== 'completed' }

function normalizeDimension(value: EvaluationDimensionResult): EvaluationDimensionResult { const evidence = normalizeEvidence(value.evidence); return evidence === undefined ? { ...value } : { ...value, evidence } }
function normalizeEvidence(value: EvaluationEvidence | undefined): EvaluationEvidence | undefined { if (!value || value.kind !== 'inline') return value; const bytes = jsonBytes(value.value); return bytes > MAX_EVIDENCE_BYTES ? { kind: 'omitted', reason: 'size_limit', originalBytes: bytes } : { kind: 'inline', value: JSON.parse(JSON.stringify(value.value)) as JsonValue } }
function jsonBytes(value: JsonValue): number { try { return Buffer.byteLength(JSON.stringify(value), 'utf8') } catch { return invalid('Evidence must be JSON serializable.', { evidence: 'non_json' }) } }
function copySegments(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> { return { ...value } }
function copyCorrelation(value: EvaluationCorrelation): EvaluationCorrelation { return { ...value } }
function copyAccounting(value: EvaluationAccounting): EvaluationAccounting { return { completeness: value.completeness, modelCalls: value.modelCalls.map(call => ({ model: { ...call.model }, ...(call.usage === undefined ? {} : { usage: { ...call.usage } }), ...(call.cost === undefined ? {} : { cost: { ...call.cost } }), ...(call.correlation === undefined ? {} : { correlation: { ...call.correlation } }) })) } }
function observationIdentity(observation: EvaluationObservation): RowIdentity { return { datasetId: observation.datasetId, datasetVersion: observation.datasetVersion, caseId: observation.caseId, ...(observation.segments === undefined ? {} : { segments: copySegments(observation.segments) }), candidateId: observation.candidateId, candidateVersion: observation.candidateVersion, taskId: observation.taskId, taskVersion: observation.taskVersion, trialId: observation.trialId, trialOrdinal: observation.trialOrdinal } }
function resultIdentity(identity: RowIdentity | undefined): RowIdentity { if (!identity) throw new Error('Evaluation row identity is unavailable.'); return identity }
function now(): string { return new Date().toISOString() }
function duration(startedAt: string): number { return Math.max(0, Date.now() - Date.parse(startedAt)) }
function codePoints(value: string): number { return [...value].length }

function candidateAggregates(cases: readonly EvaluationCaseResult[], aggregateBy: readonly string[]): EvaluationCandidateAggregate[] {
  const candidates = uniqueRows(cases, row => `${row.candidateId}\u0000${row.candidateVersion}`)
  return candidates.flatMap(candidate => scopes(cases.filter(row => row.candidateId === candidate.candidateId && row.candidateVersion === candidate.candidateVersion), aggregateBy).map(scope => {
    const rows = selectScope(cases.filter(row => row.candidateId === candidate.candidateId && row.candidateVersion === candidate.candidateVersion), scope)
    const taskAccounting = accountingSummary(rows.map(row => row.task.accounting))
    const scorerAccounting = accountingSummary(rows.flatMap(row => row.scorers.map(scorer => scorer.accounting)))
    return { candidateId: candidate.candidateId, candidateVersion: candidate.candidateVersion, scope, caseCount: rows.length, statusCounts: statusCounts(rows.map(row => row.status), ['completed', 'completed_with_errors', 'task_error', 'cancelled', 'timed_out', 'skipped']), ...(distribution(rows.map(row => row.evaluationDurationMs).filter(isNumber)) === undefined ? {} : { evaluationDurationMs: distribution(rows.map(row => row.evaluationDurationMs).filter(isNumber)) }), ...(distribution(rows.map(row => row.task.durationMs).filter(isNumber)) === undefined ? {} : { taskDurationMs: distribution(rows.map(row => row.task.durationMs).filter(isNumber)) }), taskAccounting, scorerAccounting, combinedAccounting: accountingSummary([...rows.map(row => row.task.accounting), ...rows.flatMap(row => row.scorers.map(scorer => scorer.accounting))]) }
  })) as EvaluationCandidateAggregate[]
}
function dimensionAggregates(cases: readonly EvaluationCaseResult[], scorers: readonly EvaluationScorer<any, any, any>[], aggregateBy: readonly string[]): EvaluationDimensionAggregate[] {
  const candidates = uniqueRows(cases, row => `${row.candidateId}\u0000${row.candidateVersion}`)
  const out: EvaluationDimensionAggregate[] = []
  for (const candidate of candidates) for (const scorer of scorers) for (const definition of scorer.dimensions) for (const scope of scopes(cases.filter(row => row.candidateId === candidate.candidateId && row.candidateVersion === candidate.candidateVersion), aggregateBy)) {
    const rows = selectScope(cases.filter(row => row.candidateId === candidate.candidateId && row.candidateVersion === candidate.candidateVersion), scope)
    const scoreRows = rows.map(row => row.scorers.find(item => item.scorerId === scorer.id))
    const dimensions = scoreRows.flatMap(item => item?.dimensions.filter(dimension => dimension.dimensionId === definition.id) ?? [])
    const scored = dimensions.filter((item): item is Extract<EvaluationDimensionResult, { outcome: 'scored' }> => item.outcome === 'scored')
    const explicit = scored.filter(item => item.passed !== undefined)
    const base = { candidateId: candidate.candidateId, candidateVersion: candidate.candidateVersion, scorerId: scorer.id, scorerVersion: scorer.version, dimensionId: definition.id, kind: definition.kind, scope, scorerStatusCounts: statusCounts(scoreRows.map(row => row?.status ?? 'skipped'), ['completed', 'error', 'cancelled', 'timed_out', 'skipped']), coverage: { planned: rows.length, completed: dimensions.length, scored: scored.length, notApplicable: dimensions.filter(item => item.outcome === 'not_applicable').length, inconclusive: dimensions.filter(item => item.outcome === 'inconclusive').length, errored: scoreRows.filter(item => item?.status === 'error' || item?.status === 'timed_out' || item?.status === 'cancelled').length, skipped: scoreRows.filter(item => !item || item.status === 'skipped').length }, ...(explicit.length === 0 ? {} : { passCounts: { passed: explicit.filter(item => item.passed).length, failed: explicit.filter(item => !item.passed).length, rate: explicit.filter(item => item.passed).length / explicit.length } }), ...(distribution(scoreRows.map(item => item?.durationMs).filter(isNumber)) === undefined ? {} : { scorerDurationMs: distribution(scoreRows.map(item => item?.durationMs).filter(isNumber)) }), scorerAccounting: accountingSummary(scoreRows.map(item => item?.accounting)) }
    if (definition.kind === 'number') out.push({ ...base, ...(distribution(scored.map(item => item.value as number)) === undefined ? {} : { numeric: distribution(scored.map(item => item.value as number)) }) } as EvaluationDimensionAggregate)
    else if (definition.kind === 'boolean') out.push({ ...base, booleanCounts: { true: scored.filter(item => item.value === true).length, false: scored.filter(item => item.value === false).length } } as EvaluationDimensionAggregate)
    else out.push({ ...base, labelCounts: definition.labels.map(label => ({ label, count: scored.filter(item => item.value === label).length })) } as EvaluationDimensionAggregate)
  }
  return out
}
function scopes(cases: readonly EvaluationCaseResult[], keys: readonly string[]): EvaluationAggregateScope[] { const result: EvaluationAggregateScope[] = [{ kind: 'all' }]; for (const key of [...keys].sort()) { const values = [...new Set(cases.map(row => row.segments?.[key]).filter((value): value is string => value !== undefined))].sort(); result.push(...values.map(value => ({ kind: 'segment', key, value } as const))); if (cases.some(row => row.segments?.[key] === undefined)) result.push({ kind: 'segment_missing', key }) } return result }
function selectScope(cases: readonly EvaluationCaseResult[], scope: EvaluationAggregateScope): EvaluationCaseResult[] { return scope.kind === 'all' ? [...cases] : cases.filter(row => scope.kind === 'segment' ? row.segments?.[scope.key] === scope.value : row.segments?.[scope.key] === undefined) }
function statusCounts<T extends string>(values: readonly T[], all: readonly T[]): Record<T, number> { return Object.fromEntries(all.map(item => [item, values.filter(value => value === item).length])) as Record<T, number> }
function distribution(values: readonly number[]): EvaluationDistribution | undefined { if (values.length === 0) return undefined; const sorted = [...values].sort((a, b) => a - b); const rank = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!; return { count: sorted.length, min: sorted[0]!, max: sorted.at(-1)!, mean: sorted.reduce((total, value) => total + value, 0) / sorted.length, p50: rank(.5), p95: rank(.95) } }
function accountingSummary(values: readonly (EvaluationAccounting | undefined)[]): EvaluationAccountingSummary { const reported = values.filter((value): value is EvaluationAccounting => value !== undefined); const completeness = reported.length === 0 ? 'unknown' : reported.length === values.length && reported.every(value => value.completeness === 'complete') ? 'complete' : 'partial'; const calls = reported.flatMap(value => value.modelCalls); const usages = calls.map(call => call.usage).filter((usage): usage is TokenUsage => usage !== undefined); const tokenTotals = usages.length === 0 ? undefined : usages.reduce<TokenUsage>((total, usage) => ({ inputTokens: total.inputTokens + usage.inputTokens, outputTokens: total.outputTokens + usage.outputTokens, totalTokens: total.totalTokens + usage.totalTokens, ...(total.cachedInputTokens === undefined && usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: (total.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0) }), ...(total.cacheCreationInputTokens === undefined && usage.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: (total.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) }), ...(total.reasoningTokens === undefined && usage.reasoningTokens === undefined ? {} : { reasoningTokens: (total.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0) }) }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }); const costs = new Map<string, number>(); for (const call of calls) if (call.cost) costs.set(call.cost.currency, (costs.get(call.cost.currency) ?? 0) + call.cost.amount); return { completeness, reportedModelCallCount: calls.length, ...(tokenTotals === undefined ? {} : { tokenTotals }), costTotals: [...costs.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, amount]) => ({ currency, amount })) } }
function uniqueRows<T>(values: readonly T[], key: (value: T) => string): T[] { const seen = new Set<string>(); return values.filter(value => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true }) }
function isNumber(value: unknown): value is number { return typeof value === 'number' }
function scorerSummaries(scorers: readonly EvaluationScorer<any, any, any>[]): EvaluationRunResult['scorers'] { return scorers.map(scorer => ({ id: scorer.id, version: scorer.version, dimensions: scorer.dimensions.map(dimension => dimension.kind === 'label' ? { ...dimension, labels: [...dimension.labels] } : { ...dimension }) })) }

async function safeSpan<T>(telemetry: TelemetryShim | undefined, name: string, attrs: Record<string, string | number | boolean | undefined>, callback: () => Promise<T>): Promise<T> {
  if (!telemetry) return await callback()
  let invocation: Promise<T> | undefined
  const invoke = (): Promise<T> => invocation ??= callback()
  try { return await telemetry.span(name, attrs, async () => await invoke()) } catch (error) {
    if (!invocation) return await invoke()
    try { return await invocation } catch { throw error }
  }
}
function safeMetric(telemetry: TelemetryShim | undefined, name: string, kind: 'counter' | 'histogram', value: number, attrs: Record<string, string | number | boolean | undefined>): void {
  try {
    if (kind === 'counter') telemetry?.recordCounter(name, value, attrs)
    else telemetry?.recordHistogram(name, value, attrs)
  } catch {
    // Telemetry is optional instrumentation and must never affect an evaluation verdict.
  }
}
function recordRowMetrics(telemetry: TelemetryShim | undefined, task: { id: string; version: string }, mode: EvaluationRunMode, row: EvaluationCaseResult): void {
  const base = { 'harness.eval.task.id': task.id, 'harness.eval.task.version': task.version, 'harness.eval.mode': mode }
  safeMetric(telemetry, 'harness.eval.cases', 'counter', 1, { ...base, 'harness.eval.status': row.status })
  if (row.evaluationDurationMs !== undefined) safeMetric(telemetry, 'harness.eval.case.duration', 'histogram', row.evaluationDurationMs / 1000, { ...base, 'harness.eval.status': row.status })
  for (const scorer of row.scorers) {
    const attrs = { ...base, 'harness.eval.scorer.id': scorer.scorerId, 'harness.eval.scorer.version': scorer.scorerVersion, 'harness.eval.status': scorer.status }
    safeMetric(telemetry, 'harness.eval.scorer.results', 'counter', 1, attrs)
    if (scorer.durationMs !== undefined) safeMetric(telemetry, 'harness.eval.scorer.duration', 'histogram', scorer.durationMs / 1000, attrs)
  }
}
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child) } return value }
