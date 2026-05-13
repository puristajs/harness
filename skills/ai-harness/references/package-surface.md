# Package Surface And Source Map

## Contents
- Packages
- Public Exports
- Testing Exports
- Source Map
- Docs And Specs Map
- Implementation-Vs-Spec Checks
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
| Sandbox | `sandbox/index.ts` |
| Skills | `skills/index.ts` |
| MCP | `tools/mcp/*` |
| Telemetry | `telemetry/*`, `specs/14-otel-conventions.md` |
| Durable runtime | `runtime/*` |
| Errors | `errors/catalog.ts`, `errors/harness-error.ts` |
| Provider adapters | `packages/harness-openai/src/index.ts`, `packages/harness-anthropic/src/index.ts`, `packages/harness-bedrock/src/index.ts`, `packages/harness-azure-foundry/src/index.ts` |

## Docs And Specs Map
Use specs for intended contracts and docs for user-facing examples:
- `specs/02-harness-config.md`: builder methods and validation
- `specs/05-sandbox.md`: sandbox port
- `specs/06-models.md`: model provider/capabilities
- `specs/07-tools.md`: built-ins, TS tools, MCP
- `specs/08-skills.md`: skill loader/mounting
- `specs/09-agents.md`: agent loop
- `specs/10-workflows.md`: workflow orchestration
- `specs/11-sessions.md`: sessions/history/memory
- `specs/12-streaming.md`: run events
- `specs/13-public-api.md`: locked public surface
- `specs/14-otel-conventions.md`: telemetry
- `specs/15-error-catalog.md`: errors
- `specs/16-testing.md`: testing contracts
- `docs/guides/*`: user-facing patterns
- `docs/security/security-model.md`: security defaults
- `docs/operations/runbook.md`: operations and triage

## Implementation-Vs-Spec Checks
When docs/specs and source disagree, verify source before teaching behavior. Known check points:
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
