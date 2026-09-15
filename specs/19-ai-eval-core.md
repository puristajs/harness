# Runtime telemetry and evaluation foundation

**Status.** Active supporting contract for Harness v4. The exact definition,
instance, session, invocation, and streaming API is owned by
[42-composable-definitions-and-catalogs](./42-composable-definitions-and-catalogs.md).
The generic evaluation API and result semantics are owned by
[35-generic-evaluation-runs](./35-generic-evaluation-runs.md).

**Purpose.** Define the Harness-owned runtime facts that evaluation and other
external systems may consume without adding a product adapter, storage service,
HTTP API, or vendor integration to Harness core.

## Ownership boundary

Harness owns:

- backend-agnostic AI telemetry emission;
- W3C Trace Context acceptance and propagation through Harness runs;
- model/tool/agent/run summaries that applications can read without parsing
  spans; and
- the provider-neutral generic evaluation substrate in spec 35 plus
  credential-free fakes and test utilities.

Applications and optional integrations own HTTP endpoints, datasets,
experiments, prompt versions, score persistence, annotation, dashboards,
retention, product policy, vendor mapping, and access control. Harness imports
no product or evaluation-vendor package and defines no vendor configuration.

## Telemetry configuration and privacy

The exact `TelemetryOptions`, `TelemetryFlavor`, `ContentCaptureMode`, runtime
binding, and attribute/event conventions are owned by
[14-otel-conventions](./14-otel-conventions.md) and spec 42. The effective
defaults remain:

- `flavor`: `PURISTA_TELEMETRY_FLAVOR`, otherwise `dual`;
- `contentCaptureMode`:
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, otherwise
  `NO_CONTENT`.

Harness does not emit prompt, completion, tool input/result, expected-output,
or context content when capture mode is `NO_CONTENT`. Memory content follows
[20-memory-adapters](./20-memory-adapters.md). Evaluation content is never
enabled by the general capture mode; spec 35 owns its stricter content-free
telemetry contract.

## Trace Context and invocation metadata

Callers use the exact `HarnessTargetInvokeOptions<Target>` derived from
spec 42's closed `InvokeOptions`; this specification does not redeclare or
extend that type. `traceparent` and `tracestate` are opaque W3C Trace Context
inputs. When valid, Harness installs the parent context before creating the run
span, and child workflow, agent, model, tool, sandbox, and storage spans inherit
it. Invalid input starts a new trace and emits the content-free
`INVALID_TRACE_CONTEXT` warning defined by the telemetry contract.

The optional invocation `metadata` is a frozen
`Readonly<Record<string, JsonValue>>`. Harness never adds it to a prompt.
Only authoritative runtime contexts that explicitly declare `metadata`, such
as workflow and tool contexts in spec 42, receive it. Agents are configurable
model loops and expose neither a custom handler nor a metadata context. Telemetry may
project metadata only when a key matches
`/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/` and the value is a boolean, finite number, or
string of at most 256 characters. Null, arrays, objects, and longer strings are
omitted. Metadata never changes target identity, session identity, evaluation
identity, authorization, or persistence ownership.

## V4 session execution and run summaries

Applications create an instance from the immutable Harness definition, acquire
a named session with `instance.getSession(...)`, invoke an exact root through
`session.agents` or `session.workflows`, and release the session. Aggregate
`.run(...)` returns the raw target-specific `RunOutcome`; it does not return a
session wrapper. `HarnessSession<Contracts>.getRunSummary(runId)` returns the
exported `RunSummary | undefined` and is the only session summary API.

```ts
const session = await harnessInstance.getSession(
  `eval:${evaluationRunId}:${caseId}:${trialId}`,
)

try {
  const outcome = await session.agents.candidate.run(input, {
    metadata: {
      evaluationRunId,
      caseId,
      candidateId,
      trialId,
      trialOrdinal,
    },
  })

  const summary = await session.getRunSummary(outcome.runId)
  // The application maps outcome and optional summary into its
  // EvaluationTaskOutput; Harness does not create an evaluation record here.
} finally {
  await session.release()
}
```

An evaluation task adapter chooses stable, isolated session ids and owns the
mapping from completed or interrupted `RunOutcome` values into its
`EvaluationTaskOutput`. Failed or cancelled aggregate execution rejects with
the canonical Harness error and follows spec 35's task failure policy. The
metadata above provides content-free operational correlation only; evaluation
identity remains in spec 35's task target and observation contracts.

`RunSummary` reports the persisted run/session identity, status, timestamps,
normalized token totals, model/tool/agent call counts, and optional serialized
error defined by the runtime session contract. Token totals sum persisted
model-usage events; missing usage counts as zero and Harness never estimates
tokens. The summary does not require an OpenTelemetry collector and does not
inspect spans. It is not an `EvaluationAccounting` ledger: an application that
claims complete per-model-call accounting must provide the exact model-call
records required by spec 35 rather than inventing them from aggregate totals.

## Generic evaluation boundary

Spec 35 is the sole source for evaluation dataset, case, candidate, trial,
observation, task, scorer, evidence, error, correlation, accounting, aggregate,
segmentation, cancellation, timeout, failure-policy, telemetry, and
feedback-projection contracts.

`runEvaluation(...)` executes and scores; `scoreEvaluation(...)` re-scores
application-owned observations; `createDeterministicEvaluationScorer(...)` is
the focused deterministic scorer factory. There is no second evaluator,
standalone scorer contract, session-specific evaluation registry, or legacy
entry point.

## Non-goals

- no product or vendor adapter package;
- no evaluation HTTP API or CLI;
- no dataset, prompt-version, annotation, or experiment store;
- no hosted judge, dashboard, external optimizer, or product scorer registry;
- no vendor SDK or automatic exporter dependency in Harness core.

## Required tests

1. Telemetry flavor tests assert the exact namespaces in spec 14.
2. Content-capture tests assert every general mode while evaluation telemetry
   remains content-free.
3. Trace Context tests prove valid parent propagation and safe invalid-context
   fallback with the canonical warning code.
4. Invocation tests prove metadata follows the exact spec 42 option and context
   surfaces, is absent from agent prompts, and projects only permitted scalar
   telemetry values.
5. Session tests prove `.run(...)` returns raw `RunOutcome` and
   `getRunSummary(...)` derives usage totals, counts, status, and errors from
   Harness storage.
6. Generic evaluation tests satisfy every acceptance requirement in spec 35.
7. Stale-symbol checks reject every retired runtime and evaluator surface listed
   by the authoritative clean-break specifications.

Root CI runs these tests without provider credentials, external network,
Docker, Python, or a local OpenTelemetry collector.

## Cross-references

- [02-harness-config](./02-harness-config.md)
- [03-foundation](./03-foundation.md)
- [11-sessions](./11-sessions.md)
- [12-streaming](./12-streaming.md)
- [13-public-api](./13-public-api.md)
- [14-otel-conventions](./14-otel-conventions.md)
- [16-testing](./16-testing.md)
- [35-generic-evaluation-runs](./35-generic-evaluation-runs.md)
- [42-composable-definitions-and-catalogs](./42-composable-definitions-and-catalogs.md)
