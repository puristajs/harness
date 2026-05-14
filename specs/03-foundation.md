# Foundation: telemetry, logging, errors

**Purpose.** Defines the `Logger` interface, the `HarnessError` base, error categories, and the OpenTelemetry integration approach. The full attribute/span/metric list lives in [14-otel-conventions](./14-otel-conventions.md). The full error class catalog lives in [15-error-catalog](./15-error-catalog.md).

## Logger

```ts
type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  fatal(msg: string, fields?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): Logger
}
```

### Default logger

- Class: `JsonLogger`. Emits one JSON object per log line to `process.stdout`.
- Built into `@purista/harness` with no external harness dependency. Users who want a different logger implement the `Logger` interface themselves and pass it to the harness via `defineHarness().logger(...)`.
- Line shape: `{level, time, msg, ...bindings, ...fields}`. `time` is locked RFC3339 millisecond UTC string in the format `YYYY-MM-DDTHH:mm:ss.sssZ`. `level` is the string name. No nesting of fields.
- `child(bindings)` returns a new logger that merges `bindings` into every emitted line. Child bindings shadow parent bindings on key collision.
- Minimum level is `'info'` by default; configurable via env var `PURISTA_HARNESS_LOG_LEVEL` (parsed at logger construction time, invalid values fall back to `'info'` and emit a single warning).

### Bindings emitted by the harness

Every harness-emitted log line includes (when applicable, omitted otherwise):

| Field          | Source                                |
|----------------|---------------------------------------|
| `harness`      | `HarnessOptions.name`                 |
| `session_id`   | session in scope                      |
| `run_id`       | run in scope                          |
| `agent_id`     | agent in scope                        |
| `workflow_id`  | workflow in scope                     |
| `tool_id`      | tool in scope                         |
| `trace_id`     | active OTel trace id                  |
| `span_id`      | active OTel span id                   |

`trace_id`/`span_id` are read from the active OTel context if available. If no OTel provider is registered, both are omitted.

## Errors

```ts
type ErrorCategory =
  | 'config' | 'validation' | 'permission' | 'sandbox'
  | 'model'  | 'tool' | 'skill' | 'session'
  | 'state'
  | 'timeout' | 'cancelled' | 'internal'

abstract class HarnessError extends Error {
  readonly code: string
  readonly category: ErrorCategory
  readonly retriable: boolean
  readonly meta?: Record<string, unknown>
  readonly cause?: unknown
  constructor(opts: {
    code: string
    category: ErrorCategory
    message: string
    retriable: boolean
    meta?: Record<string, unknown>
    cause?: unknown
  })
}
```

- All thrown errors in the harness extend `HarnessError`.
- `code` is SCREAMING_SNAKE_CASE.
- `cause` follows the standard `ErrorOptions.cause` semantics.
- Subclasses set `code`/`category`/`retriable` in their constructor; only `message` and `meta` vary per instance.
- Cancellation: every async path observes `AbortSignal` and throws `OperationCancelledError` (`category: 'cancelled'`, `retriable: false`) on abort.
- Pre-aborted signals: every entry point (`Session.workflows[id].prompt|stream`, agent/tool/skill/model invocation) checks `signal.aborted` first. If aborted, the entry point rejects with `OperationCancelledError{meta.scope: ...}` in a microtask via `Promise.reject(...)` on the next tick. Synchronous throws are not used for pre-aborted signals.
- Timeouts: every timed operation throws `OperationTimeoutError` (`category: 'timeout'`, `retriable: true`) when its budget elapses.

### Serialization

`HarnessError.prototype.toJSON()` returns:

```ts
{
  name: string
  code: string
  category: ErrorCategory
  retriable: boolean
  message: string
  meta?: Record<string, unknown>
  cause?: unknown
  stack?: string
}
```

`cause` is included as-is (consumers may need to handle `cause` recursively).

## OpenTelemetry integration

- The harness depends on `@opentelemetry/api` (peer) and `@opentelemetry/semantic-conventions` for canonical attribute keys. No exporters and no tracing SDK are initialized by core; applications wire `NodeTracerProvider`, resources, processors, and exporters at the process boundary.
- At `defineHarness` time the harness captures one tracer and one meter via the global API. The names are locked (not user-configurable):
  ```ts
  const tracer = trace.getTracer('@purista/harness', HARNESS_VERSION)
  const meter  = metrics.getMeter('@purista/harness', HARNESS_VERSION)
  ```
- If no provider is registered, both APIs no-op (zero overhead).
- Span creation: every public operation (session prompt, workflow run, agent run, model call, tool call, skill call) wraps its work in a standard OpenTelemetry active span (`tracer.startActiveSpan`). Span attributes are set at start; result attributes on success; status `ERROR` and recorded exception on failure.
- Telemetry emission is record-driven: harness code creates one internal telemetry record per span, then renders OTel GenAI and/or OpenInference attributes from that record according to `TelemetryOptions.flavor`. Implementation code must not maintain separate GenAI and OpenInference data paths.
- Trace Context: `InvokeOptions.traceparent` and `InvokeOptions.tracestate` are extracted before the run span is created. Invalid context is ignored with warning log code `INVALID_TRACE_CONTEXT`; it is never a run failure.
- Span linkage: child operations attach to the parent span via the active OTel context.
- Metric instruments are created lazily once at harness construction. Canonical names (full enumeration in [14-otel-conventions](./14-otel-conventions.md)):
  - `gen_ai.client.token.usage`: `Histogram` (unit `{token}`) — GenAI conv.
  - `gen_ai.client.operation.duration`: `Histogram` (unit `s`, seconds, double) — GenAI conv.
  - `harness.agent.iterations`: `Histogram` (unit `1`).
  - `harness.tool.duration` / `harness.run.duration`: `Histogram` (unit `s`, seconds, double).
  - `harness.permission.denials`: `Counter` (unit `1`).
  - `harness.run.errors`: `Counter` (unit `1`).
  - `harness.events.persist_errors`: `Counter` (unit `1`); attributes `harness.session.id`, `harness.run.id`. Incremented on every `state.appendEvents` failure.

Per OTel semconv, durations are seconds (double). The harness emits no `_ms`-suffixed instruments.

## Telemetry helper API (internal, not exported)

```ts
interface TelemetryShim {
  span<T>(name: string, attrs: SpanAttrs, fn: (span: Span) => Promise<T>): Promise<T>
  recordHistogram(name: string, value: number, attrs: SpanAttrs): void
  recordCounter(name: string, value: number, attrs: SpanAttrs): void
}
```

`SpanAttrs` is `Record<string, string | number | boolean | string[] | undefined>`. Undefined values are dropped before being passed to OTel.

## Cross-references

- [14-otel-conventions](./14-otel-conventions.md) — full names list.
- [15-error-catalog](./15-error-catalog.md) — every error class.
- [02-harness-config](./02-harness-config.md) — telemetry config keys.
