# Telemetry And Observability

## Contents
- Runtime Setup
- Harness Configuration
- TelemetryShim
- Span Names
- Metrics
- Logs
- Adapter Context Propagation
- Privacy Gate

Use this reference when wiring OpenTelemetry, logs, privacy gates, or adapter context propagation.

## Runtime Setup
The harness exports `OtelTelemetryShim` and `createTelemetryShim`, but applications own OpenTelemetry SDK/exporter setup.

Typical Node setup:

```ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

export function startOpenTelemetry(): NodeSDK {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318'
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'my-harness-app' }),
    traceExporter: new OTLPTraceExporter({
      url: endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`
    })
  })
  sdk.start()
  return sdk
}
```

Call this before creating/running harness sessions.

## Harness Configuration
```ts
const harness = defineHarness({ name: 'my-harness-app' })
  .logger(new JsonLogger({ level: process.env.PURISTA_HARNESS_LOG_LEVEL ?? 'info' }))
  .telemetry({ contentCaptureMode: 'NO_CONTENT' })
  .models(...)
  .agents(...)
  .build()
```

The implementation creates the internal OpenTelemetry-backed shim during
session setup. `.telemetry(...)` supplies options such as
`contentCaptureMode`. It defaults to `NO_CONTENT`.

## TelemetryShim
Adapters and tools receive a minimal shim:

```ts
interface TelemetryShim {
  span<T>(name: string, attrs: SpanAttrs, fn: (span: Span) => Promise<T>): Promise<T>
  recordHistogram(name: string, value: number, attrs: SpanAttrs): void
  recordCounter(name: string, value: number, attrs: SpanAttrs): void
  currentTraceparent(): string | undefined
}
```

Use `currentTraceparent()` to propagate W3C trace context into provider calls or remote services.

## Span Names
Important emitted spans:
- `harness.session.prompt`
- `harness.workflow.run`
- `invoke_agent {agent.name}`
- `chat {request.model}` for model calls in the current implementation
- `execute_tool {tool.name}`
- `harness.sandbox.exec`
- `harness.state.op`

Every relevant span should carry `harness.name`, `harness.session.id`, `harness.run.id`, and when available `harness.workflow.id` / `harness.agent.id`.

## Metrics
Common instruments:
- `gen_ai.client.token.usage`
- `gen_ai.client.operation.duration`
- `harness.tool.duration`
- `harness.run.duration`
- `harness.run.errors`
- `harness.events.persist_errors`
- `harness.permission.denials`

Durations are seconds. Do not invent `_ms` metrics in harness adapters.

Token usage is attached to model spans using both GenAI attributes
(`gen_ai.usage.*`) and OpenInference attributes (`llm.token_count.*`). The
`gen_ai.client.token.usage` metric is emitted in addition because production
trace backends may sample or drop spans while still aggregating metrics.

Handler code should use the scoped `ctx.metrics` helper for application-owned
measurements:

```ts
handler: async (ctx) => {
  ctx.metrics.counter('app.workflow.started', 1, { workflow: 'triage' })
  return ctx.metrics.duration('app.workflow.duration', { workflow: 'triage' }, async () => {
    return ctx.agents.triage(ctx.input)
  })
}
```

Use an application prefix such as `app.` or a service-specific namespace. Avoid
colliding with `gen_ai.*` and `harness.*` instruments.

## Logs
Use `JsonLogger` or a compatible `Logger`. Tool handlers receive `ctx.logger`; include operational ids and avoid content:

```ts
handler: async (ctx, input) => {
  ctx.logger.info('Searching documents.', {
    tool_id: ctx.toolId,
    session_id: ctx.sessionId,
    run_id: ctx.runId
  })
  return search(input)
}
```

Avoid logging prompts, full documents, secrets, provider request bodies, and tool outputs unless intentionally redacted.

## Adapter Context Propagation
Providers extending `BaseModelProvider`, `StateStoreAdapterBase`, tools, sandboxes, and other configurable adapters can inherit harness context:

```ts
configureHarnessContext(context) {
  this.logger ??= context.logger
  this.telemetry ??= context.telemetry
  this.harnessName ??= context.harnessName
}
```

`BaseModelProvider` uses inherited logger/telemetry/default model timeout unless explicitly configured. Prefer inheriting harness context over creating independent tracers/loggers inside each adapter.

## Privacy Gate
When `contentCaptureMode: 'NO_CONTENT'`:
- GenAI events can still exist
- message content, tool-call arguments, tool results, embedding input, and rerank documents should be omitted or nulled
- operational metadata, token usage, duration, model names, and error codes remain available

v1 core does not emit prompt, model output, tool input/result, file,
expected-output, or context content in any mode. Memory content is omitted by
default and follows the bounded memory-facade capture policy when
non-`NO_CONTENT` modes are enabled.
