# Evaluating AI systems

`@purista/harness` provides a small, provider-neutral evaluation substrate. It
runs versioned candidates against versioned cases, invokes one or more scorer
adapters, and returns deterministic per-case results and operational aggregates.
It runs in your process; it is not a dataset store, experiment UI, annotation
system, dashboard, hosted judge, or vendor integration.

For the evaluation method, dataset design, calibration, CI policy, recipes, and
optional Langfuse, Phoenix, or Datadog mappings, use the canonical
[PURISTA evaluation handbook](https://purista.dev/handbook/harness/test-and-evaluate/).

## Choose the operation

| Operation | Use it when | What it does not do |
| --- | --- | --- |
| `runEvaluation(...)` | You need to execute candidates and judge their outputs. | Persist case content or observations. |
| `scoreEvaluation(...)` | You already retained sanitized observations and want a new scorer/rubric. | Re-run the original task or invent its cost/latency. |
| `createDeterministicEvaluationScorer(...)` | A synchronous typed predicate is sufficient. | Provide a schema language or an LLM judge. |

An evaluation case separates `input` from `assessment`. The task receives only
the input and candidate configuration. A scorer receives the resulting
observation, including the assessment material and any explicitly selected
scorer context. This prevents a reference answer from accidentally reaching a
candidate.

## Run and score a small dataset

```ts
import {
  createDeterministicEvaluationScorer,
  runEvaluation,
} from '@purista/harness'

declare function answerSupportQuestion(
  question: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string>

const exactMatch = createDeterministicEvaluationScorer({
  id: 'exact-match',
  version: 'v1',
  dimension: { id: 'correct', kind: 'boolean' },
  evaluate: (observation) => ({
    outcome: 'scored',
    dimensionId: 'correct',
    kind: 'boolean',
    value: observation.output.answer === observation.assessment?.expected,
  }),
})

const result = await runEvaluation({
  runId: 'support-baseline-2026-08-28',
  dataset: {
    id: 'support-answers',
    version: 'v1',
    cases: [{
      id: 'refund-policy',
      input: { question: 'Can I get a refund?' },
      assessment: { expected: 'yes' },
      segments: { locale: 'en' },
    }],
  },
  candidates: [{ id: 'baseline', version: 'v1', config: { prompt: 'Answer briefly.' } }],
  task: {
    id: 'support-answer',
    version: 'v1',
    async run({ input, candidate }, signal) {
      const answer = await answerSupportQuestion(input.question, candidate.prompt, signal)
      return { output: { answer } }
    },
  },
  scorers: [exactMatch],
  aggregateBy: ['locale'],
  maxConcurrency: 2,
})

console.log(result.cases)
console.log(result.dimensionAggregates)
```

The result preserves declaration order even when work completes out of order.
Each candidate/case/trial row contains one result for every declared scorer.
Use `failurePolicy`, cancellation, timeouts, bounded concurrency, and retries
when your application needs them. A retry recovers a failed operation; it is not
an independent quality trial. Use explicit trial IDs when intentionally
repeating a nondeterministic task, and reset mutable fixtures between trials.

## Write scorer adapters

A scorer is an object with an ID, version, declared dimensions, and async
`score` callback. It can be deterministic, call a structured-output model as a
judge, call an external metric library, or return an existing human judgment.
The core neither constructs providers nor selects judge prompts.

Every declared dimension must report exactly one outcome:

- `scored` has a value and optional explicit pass/fail decision.
- `not_applicable` means the dimension legitimately does not apply.
- `inconclusive` means the scorer cannot reach a reliable conclusion.

These are successful assessment outcomes. A malformed scorer response, thrown
error, timeout, cancellation, or skipped scorer is reported separately and is
never disguised as a low score. Inline evidence is capped at 4 KiB; sanitize it
before returning it.

## Re-score an observation

Core intentionally does not store task output. If you want to judge the same
execution with a different rubric, retain a sanitized observation in your
application and pass it to `scoreEvaluation`.

```ts
import { scoreEvaluation } from '@purista/harness'

const rescored = await scoreEvaluation({
  runId: 'support-rubric-v2-2026-08-28',
  observations: [savedObservation],
  scorers: [newRubric],
})
```

All score-only observations in one invocation share the same dataset and task
identity. Their candidate identities may differ. The scorer receives the saved
output only in memory; Harness returns content-minimized rows. If the original
task duration, model usage, or cost is unknown, it remains unknown rather than
being inferred from re-scoring.

## Costs, telemetry, and ownership

Use the existing Harness model instrumentation for provider/model identity and
normalized token usage. Evaluation accounting keeps original task model calls
separate from scorer/judge model calls and keeps both separate from the
evaluation invocation wall time. Do not add a parent summary again for nested
model calls.

OpenTelemetry is optional. Evaluation spans and metrics are content-free in all
capture modes: they contain no case, candidate, observation, output,
assessment, score, evidence, usage, cost, or trace-correlation values. A
negative, not-applicable, or inconclusive score is a completed scorer operation;
only technical failures mark it as an error.

Your application owns observation persistence, redaction, access control,
retention, export, release thresholds, human review, and corpus metrics such as
macro F1, retrieval recall, or BLEU. Harness aggregates dimensions and
operational coverage, but does not turn per-case values into a universal quality
metric.
