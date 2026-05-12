# @purista/harness

Self-hosted enterprise agent harness for typed tools, agents, workflows, state,
sandboxing, streaming, and OpenTelemetry instrumentation.

The core package also exports provider-neutral eval helpers:

- `evaluatePromptCandidates(...)` compares prompt candidates against a fixed
  item set and deterministic or custom scorers.
- `@purista/harness/testing` exports `evaluateDeterministicScorer(...)` for
  unit-testing JSON Pointer based scorer definitions without provider calls.

Telemetry defaults to dual GenAI and OpenInference attributes with no content
capture. `InvokeOptions.traceparent` and `tracestate` accept inbound W3C Trace
Context so application traces can parent harness run spans.

## Install

```bash
npm install @purista/harness
```

Optional peer dependencies:

- `@modelcontextprotocol/sdk` enables MCP stdio/http tools.
- `just-bash` enables the exec-capable bash sandbox.
- `@opentelemetry/api` connects harness spans to an existing OpenTelemetry
  context.

## Package Format

This package is ESM-only and ships compiled JavaScript plus TypeScript
declarations from `dist/`. Source files, tests, source maps, and local configs
are not included in the published package.
