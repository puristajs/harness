# Privacy Principles Source

The default telemetry configuration is privacy-safe. The example should keep
`telemetry.contentCaptureMode` at `NO_CONTENT` unless a future implementation
adds explicit local diagnostic content telemetry.

Tests use fake model providers and must not make OpenAI calls by default. Real
OpenAI verification is a manual workflow that requires `OPENAI_API_KEY` in the
repository-root `.env` file.

Seed references: [[source-grounding]], [[jaeger-tracing]].
