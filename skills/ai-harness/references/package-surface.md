# Package Surface And Source Map

## Contents
- Packages
- Public Exports
- Testing Exports
- Source Map
- Public Docs Map
- Source-Vs-Docs Checks
- Boundary Rules

## Packages
Published packages:
- `@purista/harness`: core runtime, ports, adapters, errors, logger, telemetry, state, sandbox, tools, agents, workflows, sessions, testing subpath
- `@purista/harness-openai`: OpenAI provider adapter
- `@purista/harness-anthropic`: Anthropic provider adapter
- `@purista/harness-bedrock`: Amazon Bedrock provider adapter
- `@purista/harness-azure-foundry`: Azure AI Foundry provider adapter

Package conventions:
- packages are ESM-only
- core exports `.` and `./testing`
- provider/addon packages use `@purista/harness-*`
- addon packages should depend on `@purista/harness` and their provider/runtime SDKs only

## Public Exports
Main core entry exports:
- errors from `errors/index.js`
- logger from `logger/index.js`
- telemetry from `telemetry/index.js`
- ULID from `ulid/index.js`
- ports from `ports/index.js`
- durable runtime helpers from `runtime/index.js`
- `InMemoryStateStore`
- JSON/model state types
- model registry and capability-projected model handles
- sandbox factories and sandbox types
- `sandboxMemory()` memory adapter
- MCP tool support
- `defineHarness` and builder/session/agent/workflow types

OpenAI entry exports:
- `openai(options)`
- `OpenAiFactoryOptions`
- `OpenAiClient`

Anthropic entry exports:
- `anthropic(options)`
- `AnthropicFactoryOptions`
- `AnthropicClient`

Amazon Bedrock entry exports:
- `bedrock(options)`
- `BedrockFactoryOptions`
- `BedrockClient`

Azure AI Foundry entry exports:
- `azureFoundry(options)`
- `AzureFoundryFactoryOptions`
- `AzureFoundryClient`

## Testing Exports
`@purista/harness/testing` exports:
- `makeHarness`
- `FakeModelProvider`
- `stateStoreContract`
- `FakeMemoryAdapter`
- `memoryAdapterContract`
- `sandboxContract`
- `sandboxSnapshotContract`
- `fakeSnapshotSandbox`
- `adapterCapabilitiesContract`
- `fakeCapabilityAdapter`
- `createInMemoryFeedbackRecorder`

Use these before creating local bespoke test doubles.

## Source Map
Use these files as the implementation source of truth:

| Area | Files |
|---|---|
| Builder/public types | `packages/harness/src/harness/defineHarness.ts` |
| Session lifecycle/memory/history | `packages/harness/src/sessions/index.ts` |
| Agent loop/tools/permissions | `packages/harness/src/agents/index.ts` |
| Workflow invocation | `packages/harness/src/workflows/index.ts` |
| Models/capability gates | `packages/harness/src/models/registry.ts`, `ports/model-provider.ts`, `ports/base-model-provider.ts` |
| State port/default | `ports/state.ts`, `state/in-memory.ts`, `models/state.ts` |
| Memory port/default | `ports/memory.ts`, `ports/memory/*`, `memory/*` |
| Sandbox | `sandbox/index.ts` |
| Skills | `skills/index.ts` |
| MCP | `tools/mcp/*` |
| Telemetry | `telemetry/*` |
| Durable runtime | `runtime/*` |
| Errors | `errors/catalog.ts`, `errors/harness-error.ts` |
| Provider adapters | `packages/harness-openai/src/index.ts`, `packages/harness-anthropic/src/index.ts`, `packages/harness-bedrock/src/index.ts`, `packages/harness-azure-foundry/src/index.ts` |

## Public Docs Map
Use public docs for user-facing examples and source files for exact behavior:
- `docs/getting-started/quickstart.md`: minimal setup
- `docs/guides/configuration.md`: builder methods, defaults, telemetry, and adapter wiring
- `docs/guides/usage.md`: sessions, agents, workflows, memory, and history
- `docs/guides/extending-and-customizing.md`: custom tools, providers, sandboxes, and extension points
- `docs/guides/testing.md`: fakes, contracts, and local testing
- `docs/reference/public-api.md`: exported public surface
- `docs/security/security-model.md`: security defaults
- `docs/operations/runbook.md`: operations and triage
- `docs/guides/*`: user-facing patterns

## Source-Vs-Docs Checks
When docs and source disagree, verify source before teaching behavior. Known check points:
- custom agent handler context in source exposes models/memory/history/signal/session/run, not typed `ctx.tools` or callable skill handles
- the internal OpenTelemetry shim is created during session setup; `.telemetry(...)` supplies options such as `contentCaptureMode`, while application SDK/exporter bootstrapping is external
- default sandbox is auto-detected during build when `.sandbox(...)` is omitted; explicit `inMemorySandbox()` is safer for file-only agents
- harness streams are `RunEvent`, not an HTTP/SSE wire protocol
- feedback has exported types and testing recorder, but no production store in core

## Boundary Rules
- Core harness must not import PURISTA framework packages.
- Provider adapters should stay thin over official SDKs.
- Vector stores, HTTP endpoints, auth, review UIs, artifact storage, and business persistence are application concerns.
- Do not add hidden network/process behavior during `.tools(...)`, `.skills(...)`, or `.build()` beyond documented validation.
