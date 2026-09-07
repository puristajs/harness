# Telemetry and observability

The application starts its OpenTelemetry SDK before creating a Harness instance, then supplies logger and telemetry options through `getInstance`.

```ts
const instance = await definition.getInstance({
  model,
  logger: new JsonLogger({ level: 'info' }),
  telemetry: { flavor: 'dual', contentCaptureMode: 'NO_CONTENT' },
})
```

Tool and workflow handlers use `context.logger` and `context.metrics`. Include stable ids and low-cardinality outcome fields. Do not log inputs or outputs.

Important spans include `harness.workflow.run`, `invoke_agent <id>`, model operations, tool execution, guardrails, governance, memory, sandbox, and durable storage. `model.completed` is the single generative accounting event. Propagate only validated W3C trace context to trusted destinations.
