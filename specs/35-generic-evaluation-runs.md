# Generic evaluation runs, observations, and results

**Status.** Revised implementation contract, 2026-08-28. This is a clean-break
contract. The obsolete aggregate evaluator and standalone scorer API are
deleted; no compatibility, migration, alias, wrapper, or dual behavior is
permitted.

**Purpose.** Define the provider-neutral, in-process substrate by which an
application executes candidates against versioned cases, creates a typed
observation, applies interchangeable scorers, re-scores saved observations,
and receives deterministic, privacy-safe result data. It intentionally does
not turn `@purista/harness` into a dataset, annotation, analytics, or vendor
product.

The practical method, handbook sequence, and optional platform mappings are in
[the evaluation direction](../plans/2026-08-26-evaluation-methods-and-toolkit-direction.md).
This specification is the executable source of truth for the core API.

## Decisions and ownership

1. Core owns two public operations: `runEvaluation(...)` executes and scores;
   `scoreEvaluation(...)` scores existing successful observations. Both use the
   same scorer engine and result/aggregate rules.
2. An `EvaluationScorer` is a normal typed adapter object: stable `id` and
   `version`, declared dimensions, and asynchronous `score(...)`. There is no
   registry, class hierarchy, provider dependency, or special LLM-judge API.
3. A row has immutable dataset, case, candidate, task, and trial identity. A
   retry attempt is operational recovery, never an independent trial.
4. Task input is deliberately separate from assessment material. References,
   ground truth, and scorer context reach a scorer only; core never supplies
   them to a task callback.
5. A result is content-minimized, not an observation store. Inputs, assessment
   material, candidate configuration, task output, and scorer context never
   enter result objects, logs, or telemetry. Applications own any observation
   persistence and its privacy/retention policy.
6. Every scorer dimension reports exactly one of `scored`, `not_applicable`, or
   `inconclusive`. These assessment outcomes are distinct from scorer errors,
   cancellations, timeouts, and skipped work.
7. Original candidate task accounting, scorer/judge accounting, and invocation
   wall duration are different measurements and are never silently combined.
   Missing accounting is unknown, never zero.
8. OpenTelemetry remains optional through the existing `TelemetryShim`. Core
   adds content-free evaluation spans/metrics only; model spans remain the
   canonical per-model provider/model and token instrumentation.
9. `FeedbackRecord` remains a lossy optional projection of scored results. It
   is not a replacement for an evaluation result or observation.

Harness owns validation, scheduling, terminal result construction, bounded
evidence normalization, generic operational/coverage aggregates, feedback
projection, and optional telemetry. Applications own datasets, observations,
privacy classification, persistence, consent/access control, model/judge
selection and calibration, task-specific corpus metrics, release policy, and
external platform SDKs.

Core must not add a dataset repository/UI, annotation workflow, dashboard,
result sink, hosted judge, vendor dependency, provider creation, HTTP API, CLI,
or automatic telemetry exporter. A future persistence or sink boundary needs a
separate approved specification.

## Identity, cases, candidates, and trials

All IDs are caller-controlled opaque identifiers matching
`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`. Versions use the same grammar with a
maximum length of 64. Invalid/empty/duplicate values fail before a callback
runs with `ValidationError{where:'eval_input'}`.

```ts
export interface EvaluationCase<I = unknown, Assessment = unknown> {
  readonly id: string
  readonly input: I
  /** Material available only to scorers, never the task callback. */
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
  /** Available only while its task callback executes. */
  readonly config: Candidate
}

export interface EvaluationTrial {
  readonly id: string
}

export type EvaluationDimensionDefinition =
  | { readonly id: string; readonly kind: 'number' }
  | { readonly id: string; readonly kind: 'boolean' }
  | { readonly id: string; readonly kind: 'label'; readonly labels: readonly string[] }
```

Case IDs are unique in a dataset version; candidate, scorer, and trial IDs are
unique per invocation; dimension IDs are unique in a scorer. A label dimension
has a non-empty unique label allowlist. Segment keys use the ID grammar and
values contain at most 128 Unicode code points. `aggregateBy` may name only a
declared segment key; a missing key is an explicit aggregate bucket.

`trials` defaults to exactly `[{ id: 'default' }]`. Applications that provide
more than one trial must reset mutable environment, session, and external test
fixtures before each trial and clean them afterward. Core does not claim that
same-ID trials are independent and provides no hidden environment reset.

## Observations and accounting

An observation is the content-bearing handoff from application execution to
scoring. It is a public in-memory value so an application may persist it under
its own policy and later pass it to `scoreEvaluation`; core never persists,
logs, telemeters, or returns its content.

```ts
export interface EvaluationCorrelation {
  readonly runId?: string
  readonly traceId?: string
  readonly spanId?: string
}

export interface EvaluationCost {
  readonly amount: number
  readonly currency: string
}

export interface EvaluationModelIdentity {
  readonly providerId: string
  readonly model: string
  readonly alias?: string
  readonly responseModel?: string
}

export interface EvaluationModelCall {
  readonly model: EvaluationModelIdentity
  /** Reuses the exact normalized Harness TokenUsage shape. */
  readonly usage?: TokenUsage
  readonly cost?: EvaluationCost
  readonly correlation?: EvaluationCorrelation
}

export interface EvaluationAccounting {
  /** `complete` means all model calls for this operation are represented. */
  readonly completeness: 'complete' | 'partial'
  readonly modelCalls: readonly EvaluationModelCall[]
}

export interface EvaluationExecutionProvenance {
  readonly attempts: number
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly durationMs?: number
  readonly correlation?: EvaluationCorrelation
  readonly accounting?: EvaluationAccounting
}

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
  /** Original candidate work, when known. Omission means unknown, not zero. */
  readonly execution?: EvaluationExecutionProvenance
}
```

`TokenUsage` is the model contract from [06-models](./06-models.md): its cache
read/creation and reasoning fields are preserved. `EvaluationAccounting` is an
operation-local model-call ledger, not an alternate provider telemetry format.
The same physical model call must appear once only, in its immediate task or
scorer operation; parents must not copy child model-call records. An empty
complete ledger means the operation knowingly made no model calls. Omitting the
ledger means accounting is unknown. Core estimates neither tokens nor money.

`EvaluationCost.amount` is finite and non-negative; `currency` is an uppercase
three-letter code. Model identity strings are 1–256 Unicode code points.
`outputRef` and reference evidence are opaque 1–256-code-point application
identifiers: core never dereferences, logs, emits, or validates their scheme.
Correlations validate as the existing W3C-sized lowercase trace/span IDs and
the ID grammar for `runId`. Invalid optional operational data is a callback
result validation error, not silently discarded.

## Task and scorer adapter contracts

```ts
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
  readonly run: (
    target: EvaluationTaskTarget<I, Candidate>,
    signal: AbortSignal,
  ) => Promise<EvaluationTaskOutput<O, ScorerContext>>
}

export type EvaluationEvidence =
  | { readonly kind: 'inline'; readonly value: JsonValue }
  | { readonly kind: 'reference'; readonly ref: string }
  | { readonly kind: 'omitted'; readonly reason: 'size_limit'; readonly originalBytes: number }

export type EvaluationDimensionResult =
  | {
      readonly outcome: 'scored'
      readonly dimensionId: string
      readonly kind: 'number' | 'boolean' | 'label'
      readonly value: number | boolean | string
      readonly passed?: boolean
      readonly evidence?: EvaluationEvidence
    }
  | {
      readonly outcome: 'not_applicable'
      readonly dimensionId: string
      readonly kind: 'number' | 'boolean' | 'label'
      readonly evidence?: EvaluationEvidence
    }
  | {
      readonly outcome: 'inconclusive'
      readonly dimensionId: string
      readonly kind: 'number' | 'boolean' | 'label'
      readonly reason: 'insufficient_evidence' | 'ambiguous_reference' | 'scorer_abstained'
      readonly evidence?: EvaluationEvidence
    }

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

export interface EvaluationScorer<Assessment = unknown, O = unknown, ScorerContext = unknown> {
  readonly id: string
  readonly version: string
  readonly dimensions: readonly EvaluationDimensionDefinition[]
  readonly score: (
    target: EvaluationScorerTarget<Assessment, O, ScorerContext>,
    signal: AbortSignal,
  ) => Promise<EvaluationScorerOutput>
}
```

The task target intentionally has no `assessment`, expected answer, reference,
or scorer context. A task may derive `scorerContext` from its own successful
work (for example retrieved document identifiers or tool-effect facts). A
scorer receives the observation exactly as supplied; applications must redact
or select content before invoking a remote judge.

A successful scorer returns one and only one result for each declared dimension
and no undeclared dimensions. Core validates kind/value/labels, canonicalizes
to declaration order, and rejects malformed results as scorer errors. A
`scored` result alone may carry `value` or `passed`. `not_applicable` and
`inconclusive` cannot carry either. A negative score is a successful scorer
result, never an execution failure or retry trigger.

Inline evidence is JSON-stringified and limited to 4,096 UTF-8 bytes. At
4,097 bytes or more it is replaced with `kind:'omitted'`; core retains no
partial content. Evidence is bounded, not automatically safe: the application
is responsible for redaction and reference access control.

`createDeterministicEvaluationScorer` is a convenience factory for predicates,
not a second scorer protocol:

```ts
export interface DeterministicEvaluationScorerDefinition<Assessment = unknown, O = unknown, ScorerContext = unknown> {
  readonly id: string
  readonly version: string
  readonly dimension: EvaluationDimensionDefinition
  readonly evaluate: (
    observation: EvaluationObservation<Assessment, O, ScorerContext>,
  ) => EvaluationDimensionResult
}

export function createDeterministicEvaluationScorer<Assessment = unknown, O = unknown, ScorerContext = unknown>(
  definition: DeterministicEvaluationScorerDefinition<Assessment, O, ScorerContext>,
): EvaluationScorer<Assessment, O, ScorerContext>
```

The factory validates the returned dimension by the same rules as every other
scorer. It deliberately does not own a partial JSON Schema implementation,
JSON Pointer language, regex policy, or corpus metric vocabulary. Applications
can use their chosen validated schema or deterministic library inside the
typed predicate.

## Invocation inputs and policies

```ts
export type EvaluationFailurePolicy = 'continue' | 'fail_fast'

export interface EvaluationRetryPolicy {
  readonly maxAttempts: number
  readonly delayMs?: number
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean
}

export interface EvaluationTimeouts {
  readonly runMs?: number
  readonly taskMs?: number
  readonly scorerMs?: number
}

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

export function runEvaluation<I, Assessment, Candidate, O, ScorerContext = unknown>(
  input: EvaluationRunInput<I, Assessment, Candidate, O, ScorerContext>,
): Promise<EvaluationRunResult>

export function scoreEvaluation<Assessment, O, ScorerContext = unknown>(
  input: EvaluationScoreInput<Assessment, O, ScorerContext>,
): Promise<EvaluationRunResult>
```

Empty datasets, candidates, observations, or scorer lists are rejected. Score
observations must have unique `id` and unique `(candidateId, candidateVersion,
datasetId, datasetVersion, caseId, taskId, taskVersion, trialId)` tuples; their
segment maps and execution provenance use the same validation as run-created
observations. All observations in one score-only invocation must share dataset
and task ID/version; candidates may differ. One tuple has one observation.

Defaults are `maxConcurrency: 1`, `failurePolicy:'continue'`, one task/scorer
attempt, retry delay zero, default single trial for `runEvaluation`, and no
timers for omitted deadlines. Positive-safe-integer validation applies to
concurrency, timeout, and attempts; delay may be zero. Score-only does not
execute task callbacks and does not synthesize execution latency, usage, cost,
or model identity.

Retries recover a failed callback attempt only. Without a predicate, only a
retriable `HarnessError` is retried; timeout, cancellation, validation error,
and run-level stop are not. A throwing retry predicate becomes the terminal
callback error. Delay is fixed, abortable, and included in the operation
duration. A retry never changes trial identity and never retries a low score,
`not_applicable`, or `inconclusive` assessment result.

## Scheduling, cancellation, and terminal behavior

`runEvaluation` enumerates candidate declaration order, case declaration
order, then trial declaration order. `scoreEvaluation` enumerates supplied
observations in their input order. Rows receive ascending ordinals before work
starts; workers claim them in ordinal order; callback completion cannot affect
returned ordering. A finite worker pool bounds all task/scorer work. Scorers
and their retries execute sequentially within one row in declaration order.

For an execute-and-score row: run task attempts, validate and construct the
observation, run scorer adapters, then discard raw output/assessment/context
after the last scorer settles. For a score-only row: retain the supplied
observation only for its scorer sequence and then release core references. Core
does not mutate, freeze, or persist caller-owned observations.

`continue` records a terminal operation error and continues later scorers/rows.
Task failure produces skipped scorer placeholders. `fail_fast` latches the first
terminal callback failure, aborts in-flight cooperative work, and marks
unclaimed rows skipped. External cancellation marks unclaimed rows cancelled;
a run deadline marks them timed out. Per-task/per-scorer deadlines abort only
that attempt, then follow retry/failure policy. The first run-level stop cause
is latched. After definition/input validation succeeds, both functions resolve
a terminal partial result rather than reject for callback, cancellation, or
deadline outcomes. Non-cooperative JavaScript work may outlive the timeout;
the runner attaches rejection handling and applications must not use it for
irreversible side effects.

## Canonical result and accounting model

```ts
export type EvaluationRunMode = 'execute_and_score' | 'score_only'
export type EvaluationRunStatus = 'completed' | 'completed_with_errors' | 'failed' | 'cancelled' | 'timed_out'
export type EvaluationCaseStatus = 'completed' | 'completed_with_errors' | 'task_error' | 'cancelled' | 'timed_out' | 'skipped'
export type EvaluationScorerStatus = 'completed' | 'error' | 'cancelled' | 'timed_out' | 'skipped'

export interface EvaluationErrorRecord {
  readonly stage: 'task' | 'scorer'
  readonly code: string
  readonly category: ErrorCategory
  readonly retriable: boolean
  readonly attempt: number
}

export interface EvaluationScorerResultRecord {
  readonly scorerId: string
  readonly scorerVersion: string
  readonly status: EvaluationScorerStatus
  readonly attempts: number
  readonly startedAt?: string
  readonly finishedAt?: string
  /** Scorer/judge elapsed time, including retry delays; never task duration. */
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
  /** Original task duration when known; score-only never invents it. */
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
  /** Evaluation-invocation elapsed time, not original task duration. */
  readonly evaluationDurationMs?: number
  readonly task: EvaluationTaskResultRecord
  readonly scorers: readonly EvaluationScorerResultRecord[]
  readonly skipReason?: 'failure_policy' | 'cancelled' | 'run_timeout'
}

export interface EvaluationAccountingSummary {
  readonly completeness: 'complete' | 'partial' | 'unknown'
  readonly reportedModelCallCount: number
  readonly tokenTotals?: TokenUsage
  readonly costTotals: readonly EvaluationCost[]
}
```

`runEvaluation` emits one row for every candidate/case/trial tuple.
`scoreEvaluation` emits one row for every input observation. Each row contains
one scorer record per declared scorer, including terminal placeholders. A
score-only row has a `task` record derived from observation execution provenance
when supplied, otherwise `status:'not_run'`, zero attempts, and no timing,
correlation, or accounting fields. A run-created task record never has
`not_run`.

Completed scorer rows have all dimensions, at least one attempt, timestamps,
and duration. Error/timed-out/cancelled-after-start scorer rows have an error,
at least one attempt, and no dimensions/accounting. Unstarted scorer rows have
zero attempts, a skip reason, and no timing/error/accounting/dimensions.
Task error rows cause every scorer to be skipped. Result fixture validators must
reject invalid status/field combinations.

```ts
export type EvaluationAggregateScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'segment'; readonly key: string; readonly value: string }
  | { readonly kind: 'segment_missing'; readonly key: string }

export interface EvaluationDistribution {
  readonly count: number
  readonly min: number
  readonly max: number
  readonly mean: number
  readonly p50: number
  readonly p95: number
}

export interface EvaluationCoverage {
  readonly planned: number
  readonly completed: number
  readonly scored: number
  readonly notApplicable: number
  readonly inconclusive: number
  readonly errored: number
  readonly skipped: number
}

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
  /** Whole invocation wall duration; parallel operation durations do not sum to it. */
  readonly durationMs: number
  readonly dataset: { readonly id: string; readonly version: string }
  readonly task: { readonly id: string; readonly version: string }
  readonly scorers: readonly {
    readonly id: string
    readonly version: string
    readonly dimensions: readonly EvaluationDimensionDefinition[]
  }[]
  readonly cases: readonly EvaluationCaseResult[]
  readonly candidateAggregates: readonly EvaluationCandidateAggregate[]
  readonly dimensionAggregates: readonly EvaluationDimensionAggregate[]
}
```

Generic aggregates are operational and per-dimension only. A distribution uses
ascending values and nearest-rank p50/p95. `passCounts` considers scored
dimensions that explicitly set `passed`; `not_applicable`, `inconclusive`, and
operational failures remain visible in coverage. Value counts/distributions
contain scored results only. Label counts follow declared label order and
include zeroes. No core average, pass rate, or denominator silently removes
unscored rows.

Accounting summaries group per-model-call `TokenUsage` and costs without
currency conversion. `complete` requires complete accounting on every included
successful operation; `partial` means at least one complete/partial ledger was
reported but the total is incomplete; `unknown` means no accounting was
reported. `tokenTotals` is present only when at least one token value was
reported; it contains reported totals and the summary completeness tells the
reader whether it is exhaustive. `costTotals` follows the same rule and sorts
by currency. Failed/cancelled provider billing is unknowable unless an
application records it in an operation ledger before it fails; core does not
guess. `combinedAccounting` combines task and scorer ledgers once each, not
parent/child summaries.

Ordering is canonical: rows by ordinal; scorers and dimensions by declaration;
candidates by first row/declaration; scopes as all, segment key lexical, value
lexical, missing last; dimension aggregates by candidate, scorer, dimension,
then scope; costs by currency; labels by declaration.

Task-specific corpus/reducer metrics (for example confusion matrices, macro or
micro F1, retrieval recall/rank, BLEU, execution test suites, or statistical
tests) are pure application utilities or handbook examples. Core deliberately
does not average per-case values into a falsely universal corpus metric.

## Feedback projection and optional OpenTelemetry

```ts
export interface EvaluationFeedbackProjectionOptions {
  readonly target: (result: EvaluationCaseResult) => FeedbackTarget | undefined
}

export function evaluationResultToFeedbackRecords(
  result: EvaluationRunResult,
  options: EvaluationFeedbackProjectionOptions,
): readonly FeedbackRecord[]
```

Projection iterates canonical row/scorer/dimension order, skips all but scored
dimensions from completed scorers, and calls `target` once per row. It creates
`source:'evaluator'` feedback with ID
`eval-feedback/<run>/<candidate>/<case>/<trial>/<scorer>/<dimension>`. Numeric
values map to `score`; booleans map to `1|0`; label values have no numeric
score. Metadata contains only evaluation identities, dimension kind, optional
explicit `passed`, and label value. It never projects evidence, outputs,
assessment, scorer context, segments, accounting, errors, or correlations.
Target errors are synchronous and return no partial array.

`runEvaluation` and `scoreEvaluation` use a supplied or default `TelemetryShim`.
They emit `harness.eval.run`, `harness.eval.case`, and `harness.eval.scorer` as
defined in [14-otel-conventions](./14-otel-conventions.md). Evaluation spans
are content-free in every capture mode and carry no run/dataset/case/candidate/
trial/observation IDs, output, assessment, evidence, score, segment, model
identity, usage, cost, or correlation. A completed negative/NA/inconclusive
dimension is a successful scorer span; technical scorer failures are error
spans. Model-backed tasks and scorers use the existing nested model spans for
provider/model identity and normalized usage. Telemetry failure never changes
the evaluation outcome.

## Clean break, structure, security, and acceptance

Delete `evaluatePromptCandidates`, `PromptCandidate`, `EvaluationItem`,
`CandidateScore`, `EvaluatePromptCandidatesInput`, `evaluateDeterministicScorer`,
`DeterministicScorerDefinition`, `ScorerTarget`, `ScorerResult`, and every
documented partial-schema/JSON-pointer deterministic scorer surface. There is
no obsolete public or private callback mirror.

Implementation belongs under `packages/harness/src/eval/`: contracts and
validation; observation construction; runner/scheduler; scorer engine;
aggregation; feedback projection; telemetry adapter; colocated tests. It may
depend only on existing JSON, error, telemetry, model usage, and feedback
foundations. It must not depend on sessions, agents, workflows, providers,
storage, sandbox, examples, web, or vendor packages. Main exports are through
`packages/harness/src/index.ts`; the testing subpath re-exports only the
deterministic factory for fixture ergonomics.

Applications sanitize production-derived cases/observations and own persistence
encryption, access, retention, deletion, export, backups, and vendor consent.
Bounded evidence and opaque references are not a privacy guarantee. Core adds
no per-case log.

Acceptance requires public/type export tests; validation before callbacks;
execute-and-score and score-only parity; task isolation from assessment;
bounded concurrency; deterministic ordering; trials distinct from retries;
continue/fail-fast/cancel/timeout behavior; fixed terminal rows; all three
dimension outcomes; evidence bounds; deep-frozen result values; no result or
telemetry content leaks; separate original/scorer/wall accounting; exact
`TokenUsage` detail preservation; model-call no-double-counting; complete/
partial/unknown accounting tests; feedback exclusion tests; OTel hierarchy and
privacy tests under every flavor/capture mode; obsolete-symbol repository scan;
and root lint, typecheck, unit/type/contract/integration/failure tests,
architecture verification, and build without credentials, network, Docker,
Python, or an OTel collector.
