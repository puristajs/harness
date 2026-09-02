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
- `@purista/harness`: core runtime, ports, local storage/workspace adapters, errors, logger, telemetry, sandbox, tools, agents, workflows, sessions, testing subpath
- `@purista/harness-openai`: OpenAI provider adapter
- `@purista/harness-google`: Google Gemini API provider adapter
- `@purista/harness-anthropic`: Anthropic provider adapter
- `@purista/harness-bedrock`: Amazon Bedrock provider adapter
- `@purista/harness-azure-foundry`: Azure AI Foundry provider adapter
- `@purista/harness-agent-plugins`: data-only Agent Plugins v1 loader and verifier
- `@purista/harness-guardrails`: provider-neutral typed rails and privacy detector port
- `@purista/harness-guardrails-presidio`: optional Microsoft Presidio sidecar detector
- `@purista/harness-guardrails-native-privacy`: optional local Rust/Node-API detector
- `@purista/harness-guardrails-local-ner`: optional local Transformers.js NER detector
- `@purista/harness-policy-opa`: typed OPA Data API governance client/evaluator with strict `./testing` fake
- `@purista/harness-storage-postgres`: distributed PostgreSQL HarnessStorage with migrations, leases, fencing, checkpoints, and external waits
- `@purista/harness-sandbox-kubernetes`: restricted Kubernetes sandbox plus optional PVC/VolumeSnapshot durable workspace

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
- recoverable workflow helpers and execution types from `runtime/index.js`
- `HarnessStorage`, `InMemoryHarnessStorage`, and `SqliteHarnessStorage`
- `DurableWorkspace`, `InMemoryDurableWorkspace`, and local workspace helpers
- JSON/model persistence types
- model registry and capability-projected model handles
- sandbox factories and sandbox types
- `inMemoryMemoryEngine()` default memory engine
- MCP tool support
- governance types for optional exposure policy, execution policy, approvals, audit sinks, and policy events
- `defineHarness` and builder/session/agent/workflow types

OpenAI entry exports:
- `openai(options)`
- `OpenAiFactoryOptions`
- `OpenAiClient`

Google entry exports:
- `google(options)`
- `GoogleFactoryOptions`
- `GoogleClient`

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

OPA policy entry exports:
- `createOpaClient(options)`, `OpaClient`, `OpaClientOptions`, and `OpaQueryResult`
- `opaPolicy(helpers, options)`, `OpaPolicyOptions`, `OpaPolicyRegistrar`, and `OpaJsonResultSchema`
- content-free `OpaClientError` and `OpaPolicyError` categories
- `FakeOpaDataApi` from `@purista/harness-policy-opa/testing`, never main

PostgreSQL storage entry exports:
- `postgresHarnessStorage(options)`
- `PostgresHarnessStorageOptions`

Kubernetes sandbox entry exports:
- `kubernetesSandboxRuntime(options)`
- `KubernetesSandboxRuntime`, `KubernetesSandboxRuntimeOptions`, and workspace-enabled narrowing
- the injectable Kubernetes driver and focused adapter/workspace classes for platform wrappers and tests

## Testing Exports
`@purista/harness/testing` exports:
- `makeHarness`
- `FakeModelProvider`
- `FakeHarnessStorage`
- `harnessStorageContract`
- `durableWorkspaceContract`
- `FakeMemoryEngine`
- `memoryEngineContract`
- `sandboxContract`
- `sandboxTextSearchContract`
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
| Agent loop/tools/permissions/governance | `packages/harness/src/agents/index.ts` |
| Workflow invocation | `packages/harness/src/workflows/index.ts` |
| Models/capability gates | `packages/harness/src/models/registry.ts`, `ports/model-provider.ts`, `ports/base-model-provider.ts` |
| Harness storage | `storage/*`, `models/state.ts` |
| Memory port/default | `ports/memory.ts`, `ports/memory/*`, `memory/*` |
| Sandbox | `sandbox/index.ts` |
| Skills | `skills/index.ts` |
| MCP | `tools/mcp/*` |
| Telemetry | `telemetry/*` |
| Recoverable workflow execution | `runtime/*` |
| Errors | `errors/catalog.ts`, `errors/harness-error.ts` |
| Provider adapters | `packages/harness-openai/src/index.ts`, `packages/harness-google/src/index.ts`, `packages/harness-anthropic/src/index.ts`, `packages/harness-bedrock/src/index.ts`, `packages/harness-azure-foundry/src/index.ts` |
| OPA governance adapter | `packages/harness-policy-opa/src/index.ts`, `packages/harness-policy-opa/src/testing/index.ts` |
| PostgreSQL Harness storage | `packages/harness-storage-postgres/src/index.ts`, `packages/harness-storage-postgres/migrations/*` |
| Kubernetes sandbox/workspace | `packages/harness-sandbox-kubernetes/src/runtime.ts`, `sandbox.ts`, `workspace.ts`, `driver.ts` |

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
- default sandbox is auto-detected during build when `.sandbox(...)` is omitted; explicit `inMemorySandbox()` provides files and bounded search without command execution
- public harness streams are `ExecutionEvent`; detailed `RunEvent` diagnostics use `observe(...)`; neither is an HTTP wire protocol
- governance is optional; exposure-only configs are valid and do not imply execution default-deny
- feedback has exported types and testing recorder, but no production store in core

## Boundary Rules
- Core harness must not import PURISTA framework packages.
- Provider adapters should stay thin over official SDKs.
- Vector stores, HTTP endpoints, auth, review UIs, artifact storage, and business persistence are application concerns.
- Do not add hidden network/process behavior during `.tools(...)`, `.skills(...)`, or `.build()` beyond documented validation.
