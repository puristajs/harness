# Public API index

**Status:** active v4 package-surface contract.

This index assigns public API ownership. Exact generic declarations for
definition composition, target inference, runtime configuration, invocation,
streaming, admission, and host integration live in
[spec 42](./42-composable-definitions-and-catalogs.md). The implementation
must verify every package export against its owning specification and generated
declarations before release.

## TypeScript and package format

- TypeScript peer requirement: `>=5.4`.
- All packages are ESM.
- Public declarations compile with `skipLibCheck: false`.
- Consumers use package exports only; documented deep imports are forbidden.
- Core exposes `.`, `./testing`, `./adapter`, and `./integrator` only
  where the owning specification assigns symbols to that subpath.

## `@purista/harness`

### Definition and composition values

- `defineTool`
- `defineMcpServer`
- `defineSkill`
- `defineAgent`
- `defineWorkflow`
- `defineCatalog`
- `defineHarness`
- immutable `builtInTools`
- the Core-owned opaque `agentGuardrailsBinding`

The corresponding definition, contract, `$infer`, prompt, response,
subagent, authoring-catalog, runtime-requirement, and invocation types are
public exactly as specified by spec 42. A definition, target contract, catalog,
and Harness use the same non-enumerable frozen `$infer` convention. The
compiled graph view and recursive dependency closure are package-private and
are absent from every public value surface.

The Harness surface contains `addAgent`, `addWorkflow`, `use`,
`inspect`, and `getInstance`. A runtime instance contains `getSession` and
`close`. A session contains exact root-keyed `agents` and `workflows`
maps, child-task/history/memory facilities, `release`, and `destroy`.

There is no public mutable registry, string lookup, leaf activation method,
terminal compilation call, general agent handler, raw provider map, or runtime
dispatcher.

### Execution and stream values/types

Core exports the exact contracts needed to call and observe a target:

- `RunOutcome` and `ExecutionTerminalOutcome`;
- `HarnessTargetContract`, target inference helpers, and exact root
  aggregate/terminal/update/interrupt helpers;
- `HarnessTargetInvoker` and `HarnessTargetStream`;
- `HarnessExecutionEvent`, `RootExecutionEventFor`,
  `NestedExecutionEvent`, and
  `HarnessTargetExecutionEvent`;
- `ToolApprovalInterrupt`, `ToolApprovalResume`, and their decision types;
- invocation, identity, trace, durable-run, and session option types.

`run` resolves only completed or interrupted `RunOutcome` values and rejects
for failure or cancellation with the canonical error. `stream().result`
always resolves the exact `ExecutionTerminalOutcome`, including failed and
cancelled terminal data already emitted by `run.finished`. Infrastructure
failure before a trustworthy terminal exists rejects it.

### Provider and model surface

Core exports the provider-neutral `ModelProvider`, model request/response,
stream chunk, message/content-part, capability, outcome, usage, retry,
admission, error, and adapter-context contracts owned by
[spec 06](./06-models.md) and
[spec 23](./23-provider-outcomes-and-retry.md).

Provider helpers used by first-party adapters remain public only through the
assigned adapter-author surface. Application code receives capability-scoped
model invokers through an agent loop or workflow; it does not receive a raw
model service locator.

### Tool, Skill, and policy surface

Core exports:

- portable, built-in, MCP, and integrator host-tool contracts assigned by
  specs 07 and 42;
- `McpBinding`, its typed request-header context, and selected MCP tool
  contracts;
- Skill definition, runtime-id, frontmatter, reader, and resolved metadata
  contracts assigned by specs 08 and 42;
- permission, governance, decision, approval, and Guardrails integration
  contracts assigned by specs 24, 37, 38, 40, and 42.

Native and external governance definitions are agent-owned and typed to the
agent's selected tool map. The public policy types use that tool map directly;
they contain no whole-Harness state generic.

### Runtime ports and defaults

Core exports the canonical ports and safe local implementations assigned by
their topic specifications:

- `HarnessStorage`, `InMemoryHarnessStorage`,
  `inMemoryHarnessStorage`, and SQLite/local durable execution;
- `MemoryEngine`, memory orchestration types, and
  `inMemoryMemoryEngine`;
- `Sandbox`, capability projections, process-local sandbox factories, and
  sandbox telemetry helpers;
- `DurableWorkspace`, local directory workspace, and the in-memory test
  implementation;
- artifact storage, admission, logger, metrics, and telemetry contracts.

`inMemoryAgentAdmission` is the optional bounded process-local FIFO admission
helper specified by spec 42. It supplies concurrency control only. Durable
delivery, retry, and dead-letter behavior remain host queue concerns.

### Errors

Every public error class, code, category, retry flag, and safe metadata shape is
owned by [spec 15](./15-error-catalog.md). No package creates an alias for an
old error or returns an untyped object in place of the canonical class.

## `@purista/harness/integrator`

This narrow subpath exists for host frameworks. It exports only the authentic
host-owner, host-tool, hosted-instance, target-dispatch, and hosted
configuration contracts assigned by spec 42.

It does not expose compiled graph indexes, a mutable binding map, provider
clients, session internals, checkpoint internals, or a general runtime
service locator. Host dispatch streams use the same terminal-result contract
as public streams while retaining nested-event correlation.

## `@purista/harness/adapter`

This narrow subpath exposes shared validators, identities, and conformance
helpers needed by first-party and third-party infrastructure adapters. Exact
symbols are owned by the storage, memory, sandbox, workspace, model, telemetry,
and production-stack specifications.

It does not expose orchestration internals, private definition identities,
PURISTA types, or a second application API.

## `@purista/harness/testing`

The testing subpath owns deterministic fakes and reusable contract suites for:

- model providers and model admission;
- Harness storage and durable workspace;
- memory engines;
- Sandbox, text search, snapshots, and multi-client coordination;
- logger and telemetry capture;
- artifacts and agent admission;
- sanitized provider replay and diagnostic invariants;
- generic evaluation scorers.

`recordEvents` consumes a target event stream without changing cancellation
or terminal-result behavior. Test-only fakes and invariant helpers are not
available from the production root unless an owning specification explicitly
assigns a deliberate overlap.

The testing surface has no alternate Harness constructor. Tests use the same
definitions and `getInstance` path as production.

## Provider packages

Each provider package exposes one provider factory plus its options and client
types:

- `@purista/harness-openai`: `openai`
- `@purista/harness-google`: `google`
- `@purista/harness-anthropic`: `anthropic`
- `@purista/harness-bedrock`: `bedrock`
- `@purista/harness-azure-foundry`: `azureFoundry`

Factories return the provider-neutral `ModelProvider`. They accept their
official SDK configuration and optional injected client, and implement only
the capabilities they support. Harness owns shared timeout, retry, admission,
telemetry, cancellation, and content-safety behavior. Provider packages do not
export agents, workflows, or provider-specific Harness definitions.

## Infrastructure and policy packages

- `@purista/harness-storage-postgres` exposes
  `postgresHarnessStorage`, its options, and adapter-author types assigned by
  [spec 43](./43-distributed-production-reference-stack.md).
- `@purista/harness-sandbox-kubernetes` exposes
  `kubernetesSandboxRuntime`, focused Sandbox/workspace adapters, its driver,
  options, records, and testing helpers assigned by specs 34, 36, and 43.
- Memory, workspace, and sandbox addon packages expose one focused adapter
  family and their contract/testing types.
- `@purista/harness-policy-opa` exposes the constants, client, evaluator
  factory, option/result/error types, and `./testing` fake assigned by
  [spec 41](./41-opa-policy-adapter.md). Its generics use
  `GovernanceToolMap`, never whole-Harness state.
- Guardrail packages expose the action/configuration factories, bindings,
  detector ports, adapters, errors, and testing helpers assigned by specs 30,
  31, and 38.

## `@purista/harness-agent-plugins`

The Agent Plugins package exports the schema constants, limits, inspection,
loading, trust/error, selection, projection, provenance, and result types
assigned by [spec 29](./29-agent-plugins.md).

Projection returns authentic `SkillDefinition`, `McpServerDefinition`, and
matching HTTP `McpBinding` values for explicitly selected components. It does
not return a mutable tool/Skill registry, evaluate plugin code, or activate a
root target.

## AI SDK UI protocol package

`@purista/harness-ai-sdk-ui` exposes only the request parser, execution-event
to AI SDK UI Message Stream v1 projection, SSE response helper, and their
configuration/result types assigned by spec 42. It has a tested peer on
`ai@^7.0.0` and introduces no Harness-specific browser client.

## Schema projection

Public value validation uses Standard Schema V1. A model-facing input or
structured output additionally supports Standard JSON Schema V1. Harness
projects and freezes the provider JSON Schema exactly once per compiled
boundary as specified by
[spec 39](./39-standard-schema-boundaries/03-contracts/model-projection.md).
Providers receive the canonical projection unchanged.

## Release verification

Release checks must:

1. compare actual root and subpath exports with this ownership index and the
   detailed owning specifications;
2. compile positive and negative consumer fixtures against built declarations;
3. reject deep imports and removed API patterns;
4. install packed artifacts into clean consumers;
5. verify all first-party packages use the coordinated v4 major and published
   dependency ranges.

## References

- [42 — authoritative v4 API declarations](./42-composable-definitions-and-catalogs.md)
- [15 — error catalog](./15-error-catalog.md)
- [16 — test gates](./16-testing.md)
- [29 — Agent Plugins API](./29-agent-plugins.md)
- [39 — Standard Schema contracts](./39-standard-schema-boundaries/00-vision.md)
- [41 — OPA API](./41-opa-policy-adapter.md)
- [43 — production adapter API](./43-distributed-production-reference-stack.md)
