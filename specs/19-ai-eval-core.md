# Runtime telemetry and evaluation foundation

**Status.** Approved foundation, revised by the approved clean-break generic
evaluation contract in [35-generic-evaluation-runs](./35-generic-evaluation-runs.md).

**Purpose.** Define the Harness-owned runtime facts needed by evaluation and
other external systems without adding a product adapter, storage service, API,
or vendor integration to Harness core. Generic evaluation execution and result
semantics live only in spec 35.

## Ownership boundary

Harness owns:

- backend-agnostic AI telemetry emission;
- W3C Trace Context acceptance and propagation through Harness runs;
- model/tool/agent/run usage summaries that applications can read without
  parsing spans;
- the provider-neutral generic evaluation substrate in spec 35;
- fake/test utilities that require no provider credentials.

Applications and optional integrations own HTTP endpoints, datasets,
experiments, prompt versions, score persistence, annotation, dashboards,
retention, product policy, vendor mapping, and access control. Harness must not
import a product or evaluation-vendor package or define vendor configuration.

## Core telemetry configuration

```ts
type TelemetryFlavor = 'dual' | 'gen_ai_only' | 'openinference_only'
type ContentCaptureMode = 'NO_CONTENT' | 'SPAN_ONLY' | 'EVENT_ONLY' | 'SPAN_AND_EVENT'

interface TelemetryOptions {
  flavor?: TelemetryFlavor
  contentCaptureMode?: ContentCaptureMode
}
```

Defaults:

- `flavor`: `PURISTA_TELEMETRY_FLAVOR`, otherwise `'dual'`;
- `contentCaptureMode`:
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, otherwise
  `'NO_CONTENT'`.

Harness v3 does not emit prompt, completion, tool input/result,
expected-output, or context content on spans or span events. Memory content is
governed by [20-memory-adapters](./20-memory-adapters.md). Evaluation content is
never enabled by `contentCaptureMode`; spec 35 owns its stricter telemetry
rules.

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

- `traceparent` and `tracestate` are opaque W3C Trace Context input.
- When supplied, Harness extracts them into the active OpenTelemetry context
  before creating the run span.
- Child workflow, agent, model, tool, sandbox, and storage spans inherit that
  context.
- Invalid trace context is ignored. The run starts a new trace and logs `warn`
  with `harness.warning.code = "INVALID_TRACE_CONTEXT"`.
- `metadata` is not added to prompts. Custom agent and workflow handlers may
  read it from `ctx.metadata`; telemetry includes only permitted scalar values
  as `harness.metadata.<key>` attributes.

Metadata scalar rules:

- strings longer than 256 characters are omitted;
- finite numbers and booleans are emitted;
- null, arrays, and objects are omitted;
- keys match `/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/`.

## Run summary

Applications must not parse span events to learn basic run outcomes:

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

`tokenTotals` sums persisted model-usage events for the run. Missing usage
counts as zero and Harness never estimates tokens. `getRunSummary` reads the
configured `HarnessStorage`; it does not require an OpenTelemetry collector or
inspect spans.

## Generic evaluation boundary

Spec 35 is the sole source for evaluation dataset, case, candidate, trial,
observation, task, scorer, evidence, error, correlation, accounting,
aggregate, segmentation, cancellation, timeout, failure-policy, telemetry, and
feedback-projection contracts.

The previous aggregate prompt evaluator and standalone scorer types are not a
second contract. Their source, exports, tests, documentation, and telemetry
claims are deleted by the clean-break implementation plan. `runEvaluation(...)`
executes and scores; `scoreEvaluation(...)` re-scores application-owned
observations; `createDeterministicEvaluationScorer(...)` is a scorer factory.
No legacy entry point remains.

## Non-goals

- no product or vendor adapter package;
- no evaluation HTTP API or CLI;
- no dataset, prompt-version, annotation, or experiment store;
- no hosted judge, dashboard, external optimizer, or product scorer registry;
- no vendor SDK or automatic exporter dependency in Harness core.

## Required tests

1. Telemetry flavor tests assert `dual`, `gen_ai_only`, and
   `openinference_only` emit the exact namespaces in spec 14.
2. Content capture tests assert all four modes follow the declared generic
   Harness policy while evaluation telemetry remains content-free.
3. Trace Context tests prove valid parent propagation and safe invalid-context
   fallback with the warning code.
4. Run-summary tests prove usage totals, counts, status, and errors derive from
   HarnessStorage.
5. Generic evaluation tests satisfy every acceptance requirement in spec 35.
6. Stale-symbol checks prove no obsolete evaluator entry point or type remains.

Root CI runs these tests without provider credentials, external network,
Docker, Python, or a local OpenTelemetry collector.

## Cross-references

- [02-harness-config](./02-harness-config.md)
- [03-foundation](./03-foundation.md)
- [12-streaming](./12-streaming.md)
- [13-public-api](./13-public-api.md)
- [14-otel-conventions](./14-otel-conventions.md)
- [16-testing](./16-testing.md)
- [35-generic-evaluation-runs](./35-generic-evaluation-runs.md)
