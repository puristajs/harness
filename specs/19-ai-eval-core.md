# AI evaluation core

**Purpose.** Defines the harness-owned functionality needed for evaluation and
optimization systems such as Cloudgrid without placing any Cloudgrid adapter,
service, API, or storage code in this repository.

This file promotes the harness-relevant parts of `ai-eval-research/` into the
authoritative spec tree. The Cloudgrid adapter itself belongs in
`~/projekte/@cloudgrid/cloudgrid`.

## Ownership boundary

The harness owns:

- backend-agnostic AI telemetry emission;
- W3C Trace Context acceptance and propagation through harness runs;
- model/tool/agent/run usage summaries that external adapters can read without
  parsing spans;
- in-process deterministic scorer helpers useful for tests and local evals;
- optional workflow helpers for prompt candidate evaluation that run entirely
  through configured harness agents;
- fake/test utilities so external adapters can test without provider
  credentials.

Cloudgrid owns:

- HTTP adapter endpoints;
- datasets, experiments, prompt-version persistence, score persistence, UI,
  GraphQL, and storage;
- Cloudgrid-specific route spans and Problem Details mapping;
- any package named `@cloudgrid/*`;
- any file under `packages/cloudgrid-harness-adapter/`.

The harness must not import Cloudgrid packages, define Cloudgrid environment
variables, or create Cloudgrid-specific adapters.

## Core telemetry requirements

The harness must emit OTel GenAI as the primary convention and OpenInference as
an optional compatibility convention from one internal telemetry record. The
full attribute list is in [14-otel-conventions](./14-otel-conventions.md).

Required public configuration:

```ts
type TelemetryFlavor = 'dual' | 'gen_ai_only' | 'openinference_only'
type ContentCaptureMode = 'NO_CONTENT' | 'SPAN_ONLY' | 'EVENT_ONLY' | 'SPAN_AND_EVENT'

interface TelemetryOptions {
  flavor?: TelemetryFlavor
  contentCaptureMode?: ContentCaptureMode
}
```

Defaults:

- `flavor`: env `PURISTA_TELEMETRY_FLAVOR`, else `'dual'`
- `contentCaptureMode`: env
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, else `'NO_CONTENT'`

v3 core does not emit prompt, completion, tool input/result, expected-output, or
context content on spans or span events. Memory content is governed by
[20-memory-adapters](./20-memory-adapters.md) and defaults to no raw content.
Non-`NO_CONTENT` values are accepted as stable policy inputs for memory content
capture and for adapters that want to inspect the configured policy, but
persisted `HarnessStorage` events remain redacted in every mode.

## Trace Context propagation

Every public run entry point accepts trace context through `InvokeOptions`:

```ts
interface InvokeOptions {
  signal?: AbortSignal
  timeoutMs?: number
  historyWindow?: number
  traceparent?: string
  tracestate?: string
  metadata?: Record<string, JsonValue>
}
```

Rules:

- `traceparent` and `tracestate` are treated as opaque W3C Trace Context input.
- When supplied, the harness extracts them into the active OTel context before
  creating the run span.
- Child workflow, agent, model, tool, sandbox, and state spans inherit that
  context.
- Invalid trace context is ignored, not thrown. The run starts a new trace and
  logs `warn` with `harness.warning.code = "INVALID_TRACE_CONTEXT"`.
- `metadata` is not added to model/tool prompts. It is available to custom
  agent/workflow handlers on `ctx.metadata` and is emitted only as sanitized
  `harness.metadata.<key>` span attributes for scalar string, number, and
  boolean JSON values.

Metadata scalar rules:

- strings longer than 256 chars are omitted;
- finite numbers and booleans are emitted;
- null is omitted because OTel attributes do not support null values;
- arrays and objects are omitted;
- keys must match `/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/`.

## Run summary

External adapters must not parse span events to learn basic run results. The
harness exposes one run summary helper on `Session`:

```ts
interface Session<S extends BuilderState> {
  getRunSummary(runId: string): Promise<RunSummary | undefined>
}

interface RunSummary {
  runId: string
  sessionId: string
  status: RunStatus
  startedAt: string
  finishedAt?: string
  tokenTotals: TokenUsage
  modelCalls: number
  toolCalls: number
  agentCalls: number
  error?: SerializedError
}
```

`tokenTotals` is the sum of persisted model usage events for the run. Missing
usage counts as zero. The harness must not estimate tokens.

`getRunSummary` reads the configured `HarnessStorage`; it does not require an OTel
collector and does not inspect spans.

## Deterministic scorer helpers

The harness exports deterministic scorer execution from the main package
entrypoint because it is a runtime primitive for local eval workflows.
`@purista/harness/testing` re-exports the same helper for test ergonomics.

```ts
export type DeterministicScorerDefinition =
  | { type: 'regex'; path: string; pattern: string; flags?: 'i' | 'm' | 'im' }
  | { type: 'json-schema'; schema: JsonValue }
  | { type: 'contains'; path: string; value: string; caseInsensitive?: boolean }
  | { type: 'attribute-equality'; leftPath: string; rightPath: string }

export interface ScorerTarget {
  input: unknown
  output: unknown
  expected?: unknown
  context?: unknown[]
}

export interface ScorerResult {
  score: number
  passed: boolean
  evidence?: JsonValue
}

export function evaluateDeterministicScorer(
  definition: DeterministicScorerDefinition,
  target: ScorerTarget
): ScorerResult
```

Rules:

- `path`, `leftPath`, and `rightPath` are JSON Pointer, not JSONPath.
- `regex` and `contains` select from `target.output`.
- Missing pointer targets return
  `{ score: 0, passed: false, evidence: { reason: 'missing_pointer' } }`.
- `json-schema` validates `target.output` with the harness subset listed below.
- Passing deterministic scorers return `score: 1`; failing scorers return
  `score: 0`.

The `json-schema` scorer is intentionally a small deterministic subset, not a
full JSON Schema draft implementation. Supported keywords are:

- `type`: `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`
- `const`
- `enum`
- object `properties`
- object `required`
- `additionalProperties: false`

Unsupported keywords are ignored. Downstream agents must not assume `$ref`,
`oneOf`, `anyOf`, `allOf`, `format`, numeric bounds, string patterns, array
item schemas, or draft-specific behavior.

These helpers are testing/local primitives. LLM judge and RAG scorers are not
core exports in v3 because they require product-specific dataset, prompt, and
judge-agent policy.

## Prompt candidate evaluation helper

The harness provides one workflow-local helper, not a product optimizer:

```ts
interface PromptCandidate<I = unknown> {
  id: string
  prompt: string
  metadata?: Record<string, JsonValue>
}

interface EvaluationItem<I = unknown> {
  id: string
  input: I
  expected?: unknown
  context?: unknown[]
}

interface CandidateScore {
  candidateId: string
  meanScore: number
  passRate: number
  itemCount: number
  scorerCount: number
}

interface EvaluatePromptCandidatesInput<I = unknown> {
  candidates: PromptCandidate<I>[]
  items: EvaluationItem<I>[]
  scorer: (target: ScorerTarget, signal: AbortSignal) => Promise<ScorerResult>
  runCandidate: (
    candidate: PromptCandidate<I>,
    item: EvaluationItem<I>,
    signal: AbortSignal
  ) => Promise<unknown>
  signal: AbortSignal
}

export function evaluatePromptCandidates<I = unknown>(
  input: EvaluatePromptCandidatesInput<I>
): Promise<CandidateScore[]>
```

This helper belongs in the main `@purista/harness` export because it is
provider-neutral and has no Cloudgrid dependency.

Rules:

- Candidates and items are evaluated in stable nested order:
  candidates by input order, then items by input order.
- Each `runCandidate` result becomes `target.output`.
- `target.input`, `target.expected`, and `target.context` come from the item.
- Abort stops scheduling new work and propagates the same `AbortSignal` to
  in-flight callbacks.
- Scores are sorted by `(meanScore desc, passRate desc, candidateId asc)`.
- Empty candidate or item arrays throw `ValidationError{where:'eval_input'}`.

The helper does not generate prompt candidates. Candidate generation is left to
application workflows or external systems.

## Non-goals

- No Cloudgrid adapter package in this repository.
- No HTTP API for evals in this repository.
- No dataset store, prompt-version store, annotation queue, or experiment
  database.
- No Python, Optuna, Jupyter, or external optimizer process.
- No dependency on Ragas, DeepEval, Promptfoo, OpenAI Evals, Inspect AI, or
  Autoevals in core.
- No product-specific scorer registry.

## Tests

Required core tests:

1. Telemetry flavor tests assert `dual`, `gen_ai_only`, and
   `openinference_only` produce the exact attribute namespaces defined in
   [14-otel-conventions](./14-otel-conventions.md).
2. Content capture mode tests assert `NO_CONTENT`, `SPAN_ONLY`, `EVENT_ONLY`,
   and `SPAN_AND_EVENT` affect span attributes and span events exactly as
   specified.
3. Trace Context tests assert a supplied `traceparent` becomes the parent of the
   run span and every child span.
4. Invalid Trace Context test asserts a new trace is created and warning log is
   emitted.
5. `getRunSummary` tests assert token totals, model/tool/agent counts, status,
   and errors are derived from `HarnessStorage` data.
6. Deterministic scorer tests cover regex, json-schema, contains,
   attribute-equality, missing pointers, invalid schemas, and invalid regex.
7. `evaluatePromptCandidates` tests cover stable ordering, aggregate
   calculations, sorting tie-breakers, abort propagation, and empty-input
   validation.

Root CI must run all tests without provider credentials, Cloudgrid, external
network, Docker, Python, or a local OTel collector.

## Cross-references

- [02-harness-config](./02-harness-config.md)
- [03-foundation](./03-foundation.md)
- [12-streaming](./12-streaming.md)
- [13-public-api](./13-public-api.md)
- [14-otel-conventions](./14-otel-conventions.md)
- [16-testing](./16-testing.md)
