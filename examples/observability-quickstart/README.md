# Observability quickstart

This example starts OpenTelemetry before the Harness, emits correlated JSON
logs and application metrics from a workflow, exports Harness spans and
metrics over OTLP/HTTP, and flushes telemetry during shutdown.

```sh
npm run typecheck --workspace @purista/observability-quickstart-example
npm test --workspace @purista/observability-quickstart-example
```

To run against an OTLP collector and OpenAI:

```sh
export OPENAI_API_KEY=your-key
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
npm run build --workspace @purista/observability-quickstart-example
npm start --workspace @purista/observability-quickstart-example
```

The automated test uses in-memory OpenTelemetry exporters and a deterministic
model provider. It verifies span names, custom metric names, log correlation,
and the default no-content telemetry boundary without external services.
