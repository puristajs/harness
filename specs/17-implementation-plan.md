# Implementation plan

**Purpose.** Ordered build plan for an AI agent. Each phase has explicit deliverables, files to create, tests to pass, and exit criteria. Phases must be completed in order; later phases may depend on earlier exits.

The published package set contains `@purista/harness` plus independent provider addons. Non-core packages follow the convention `@purista/harness-{addon}`.

## Phase 1 — Harness core types, errors, logger, telemetry shims

Deliverables:
- `packages/harness/src/errors/` with every class from [15-error-catalog](./15-error-catalog.md) and `HarnessError` base.
- `packages/harness/src/logger/` with `Logger` interface and built-in `JsonLogger` default.
- `packages/harness/src/telemetry/` with span/metric helpers wrapping `@opentelemetry/api` and canonical keys from `@opentelemetry/semantic-conventions`.
- One internal telemetry record renderer that emits OTel GenAI and/or
  OpenInference according to `TelemetryOptions.flavor`.
- Trace Context extraction from `InvokeOptions.traceparent`/`tracestate`.
- `packages/harness/src/ulid/` with monotonic ULID utility.

Exit: errors, logger, telemetry flavor, content capture, and trace-context tests
green; coverage ≥85%.

## Phase 2 — State port + in-memory default + history API (no memory KV)

Deliverables:
- `packages/harness/src/ports/state.ts` with the `StateStore` interface (no memory KV methods).
- `packages/harness/src/state/in-memory/` with default impl.
- Persistence shape types (`SessionRecord`, `Message`, `RunRecord`, `PersistedRunEvent`).
- `stateStoreContract` factory under `packages/harness/src/testing/`.

Exit: state contract green.

## Phase 3 — Sandbox port + `inMemorySandbox()` (files-only)

Deliverables:
- `packages/harness/src/ports/sandbox.ts` with `Sandbox` and `SandboxSession`.
- `packages/harness/src/sandbox/in-memory/` with `inMemorySandbox()` factory; `executor: 'unavailable'`.
- Capability-projected sandbox session types: files-only sandboxes do not expose `exec`, exec-capable sandboxes do.
- `sandboxContract` factory parametrized by `{executor}`.

Tests:
- `read`/`write`/`list`/`stat`/`mount` round-trip; relative paths rejected; `exec` throws `SandboxNoExecutorError`.

Exit: in-memory sandbox contract green.

## Phase 4 — `bashSandbox()` wrapping `just-bash` peer dep

Deliverables:
- `packages/harness/src/sandbox/bash/bashSandbox.ts` with the `bashSandbox()` factory; `executor: 'available'`.
- Synchronous failure (`HarnessConfigError{reason:'just_bash_not_installed'}`) when the peer dep is missing.
- Pass-through for `network`, `executionLimits`, `python`.

Tests:
- Same `sandboxContract` with `{executor:'available'}`.
- `exec` honors `timeoutMs`/`signal`.
- Auto-detect path: `defineHarness()` with no `.sandbox()` selects `bashSandbox()` when peer dep is present, else `inMemorySandbox()`.

Exit: bash sandbox contract green.

## Phase 5 — Built-in tools (bash, read, write, edit, glob, grep, list) + alias dispatch

Deliverables:
- `packages/harness/src/tools/builtin/` with the seven canonical implementations and the alias map.
- Schemas per [07-tools](./07-tools.md) §"Built-in tools".
- Tool spec translator: built-ins emitted as `ModelToolSpec` alongside custom tools.
- Auto-disable rule for `bash` and the exec-backed `grep` path when executor is unavailable.

Tests:
- Round-trip each canonical tool against an `inMemorySandbox()` (where applicable).
- Alias dispatch: `Bash`/`LS` etc. map to canonical; `gen_ai.tool.name` reports canonical.

Exit: built-in tools green.

## Phase 6 — Provider runtime parity model port + alias registry

Deliverables:
- `packages/harness/src/ports/model-provider.ts` with all request/response types.
- `ObjectRequest`, `ObjectResponse`, `ObjectStreamChunk`, `EmbeddingRequest`, `EmbeddingResponse`, `Embedding`, `RerankRequest`, `RerankResponse`, `RerankDocument`, and `RerankResult`.
- `ModelProviderInfo`, `ModelFeatureSet`, `ContentPartKind`, and `OutputMode`.
- `packages/harness/src/models/registry.ts` with the per-alias model handle factory.
- Capability gates and type projections for operations, tool use, multimodal content parts, embeddings, and reranking.
- `FakeModelProvider` support for all model operations and provider contract tests that require no external provider access.

Exit: model gate tests, provider contract tests, and type tests green; no provider SDK dependency added to `@purista/harness`.

## Phase 7 — Custom tools (TS and MCP)

Deliverables:
- `packages/harness/src/tools/ts/` with TS tool runner, registry.
- Zod-to-JSON-Schema converter.
- MCP stdio/http runners are executable harness tools. Runtime behavior,
  shutdown, tracing, and contract tests are specified by the consolidated
  [18-living-wiki-jaeger-example](./18-living-wiki-jaeger-example.md).

Exit: TS tool tests and MCP runner tests green.

## Phase 8 — Skills loader (frontmatter validation, mounting)

Deliverables:
- `packages/harness/src/skills/loader.ts` — `SKILL.md` discovery, YAML frontmatter parse, Zod validation; name-vs-key check.
- `packages/harness/src/skills/mount.ts` — recursive directory read, `SandboxSession.mount` at `/skills/<name>/`, per-session caching.

Tests:
- Frontmatter validation: every `SkillManifestError.reason` path.
- Mount round-trip: after mount, the model can list `/skills/<name>/` and read `SKILL.md`.

Exit: skills tests green.

## Phase 9 — Sessions + run loop + streaming generator + `SessionMemory`

Deliverables:
- `packages/harness/src/sessions/` with `Session` facade (incl. `clearHistory`, `replaceHistory`).
- `Session.getRunSummary(runId)` derived from `StateStore`.
- Run lifecycle, OTel spans, run-event persistence.
- Internal in-process bounded run-event queue with overflow notification; slow consumers do not pause model/tool execution.
- `SessionMemory` facade backed by the configured `MemoryAdapter`.
- `sandboxMemory()` default adapter integration for session scope, including legacy `/memory/<key>.json` reads and new `/memory/session/<key>.json` writes.

Tests:
- Lifecycle, `SessionBusyError`, streaming generator suite.
- `SessionMemory` round-trip; non-serializable values rejected.

Exit: session integration and run-summary tests green.

## Phase 10 — Memory adapter port + scoped memory facade

Deliverables:
- `packages/harness/src/ports/memory.ts` with `MemoryAdapter`, `MemoryStore`,
  scope, capability, option, entry, and search result types from
  [20-memory-adapters](./20-memory-adapters.md).
- `packages/harness/src/memory/facade.ts` wrapping adapter calls with validation,
  scope construction, standard spans, standard metrics, error mapping, and
  content-capture policy.
- `packages/harness/src/memory/sandbox/` with `sandboxMemory()` reference adapter.
- `FakeMemoryAdapter` and `memoryAdapterContract` under
  `packages/harness/src/testing/`.
- Builder `.memory(adapter)` support and default `sandboxMemory()`.

Tests:
- Memory adapter contract green.
- Scope isolation for `run`, `session`, `agent`, `user`, and `tenant`.
- Capability gates for search, TTL, persistence, and unsupported scopes.
- Standard memory spans/metrics emitted by core wrapper; adapters do not emit
  duplicate standard spans/metrics.
- Content capture modes for memory raw key/value/query/result content.

Exit: memory contract, telemetry, content capture, and public API tests green.

## Phase 11 — Agents (default loop with built-in tools, skill mount, permissions)

Deliverables:
- `packages/harness/src/agents/registry.ts`.
- `packages/harness/src/agents/default-loop.ts` per [09-agents](./09-agents.md) §"Default loop":
  - Open sandbox session, mount declared skills.
  - Build system message with skill index appended.
  - Resolve tool set (custom + built-in, filtered by executor availability).
  - Default-loop object generation through `models[model].object(...)`.
  - Per-tool permission gate (`allow|ask|deny`) with recoverable denial.
  - `maxSteps` budget (default 16, max 64).

Tests:
- Default loop with a real built-in tool round trip (via FakeModelProvider scripted scenario).
- Permission denial → tool result message with `PERMISSION_DENIED`; run continues.
- `maxSteps` cap → `AgentLoopBudgetError`.

Exit: agent tests green.

## Phase 12 — Workflows

Deliverables:
- `packages/harness/src/workflows/` with `WorkflowContext`, parallel agent invocation, signal propagation.

Exit: workflow tests green.

## Phase 13 — Public API + builder + `$infer` + testing subpath

Deliverables:
- `packages/harness/src/harness/defineHarness.ts` exporting the chainable `HarnessBuilder` entry point.
- `.runtime(...)`, `.requires(...)`, and `harness.inspect()` for adapter capability policy and data-only inspection.
- Surface diff test passes for both entries (actual exports == [13-public-api](./13-public-api.md) lists).

Exit: harness complete; coverage ≥85%.

## Phase 14 — `@purista/harness-openai` provider

Deliverables:
- `packages/harness-openai/` with `openai(...)` factory extending `BaseModelProvider`.
- OpenAI mappings for `text`, `textStream`, `object`, `objectStream`, multimodal image input, and embeddings.
- Reranking only if the current official OpenAI SDK exposes a suitable operation; otherwise omit the capability and keep fake-provider contract coverage.
- Provider descriptor metadata where it can be static and truthful.

Exit: provider package green; coverage ≥80%.

## Phase 14b — Additional provider addons

Deliverables:
- `packages/harness-anthropic/` with `anthropic(...)` extending `BaseModelProvider` over the official `@anthropic-ai/sdk`.
- `packages/harness-bedrock/` with `bedrock(...)` extending `BaseModelProvider` over the official `@aws-sdk/client-bedrock-runtime`.
- `packages/harness-azure-foundry/` with `azureFoundry(...)` extending `BaseModelProvider` over the official `@azure-rest/ai-inference` client.
- Thin request/response mapping only: messages, tool declarations/tool calls, object/schema generation, streaming, usage, finish reasons, and provider option pass-through.

Exit: provider package tests, typechecks, and build green; coverage ≥80%.

## Phase 15 — Quickstart and provider-parity examples

Deliverables:
- `examples/quickstart/` (private package) demonstrating: define a harness with `@purista/harness-openai`, mount one skill, enable built-in `bash`/`read`, run `prompt` and `stream`.
- The example exercises the loop end-to-end: model asks for the skill, calls `read /skills/<name>/SKILL.md`, follows instructions, calls `bash`, returns final answer.
- A focused structured object or multimodal example using only `@purista/harness` and provider packages.
- A focused embeddings or reranking example using only `@purista/harness` and provider packages.
- A short integration note explaining how `@purista/ai` consumes `RunEvent` directly instead of introducing a second internal AI protocol.

Constraints:
- The quickstart example MUST import only from `@purista/harness` and `@purista/harness-openai`.
- Examples MUST NOT use the Vercel AI SDK stream protocol or a PURISTA AI protocol envelope.

Exit: example runs against `FakeModelProvider` in CI.

## Phase 16 — AI evaluation core helpers

Deliverables:
- `evaluatePromptCandidates` in the main `@purista/harness` export, with stable
  ordering, abort propagation, aggregate score calculation, and deterministic
  sorting.
- `evaluateDeterministicScorer` plus deterministic scorer types in the main
  `@purista/harness` export, re-exported by `@purista/harness/testing`.
- No Cloudgrid adapter package, HTTP endpoint, dataset store, prompt-version
  store, product scorer registry, Python, Optuna, or external optimizer
  dependency.

Exit: AI eval core tests in [19-ai-eval-core](./19-ai-eval-core.md) green.

## CI

- Single GitHub Actions workflow: matrix over Node 20 and 22.
- Steps: install (`pnpm i --frozen-lockfile`), build (`pnpm -r build`), test (`pnpm -r test --coverage`), enforce coverage gates.

## Cross-references

- All other spec files. This is the build order.
