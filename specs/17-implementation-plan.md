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
- `packages/harness/src/ports/state.ts` with the `HarnessStorage` interface (no memory KV methods).
- `packages/harness/src/state/in-memory/` with default impl.
- Persistence shape types (`SessionRecord`, `Message`, `RunRecord`, `PersistedRunEvent`).
- `harnessStorageContract` factory under `packages/harness/src/testing/`.

Exit: state contract green.

## Phase 3 — Sandbox port + `inMemorySandbox()` (files and bounded search; no exec)

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
- `Session.getRunSummary(runId)` derived from `HarnessStorage`.
- Run lifecycle, OTel spans, run-event persistence.
- Internal in-process bounded run-event queue with overflow notification; slow consumers do not pause model/tool execution.
- `SessionMemory` facade backed by the configured `MemoryAdapter`.
- `sandboxMemory()` default adapter integration for session scope using `/memory/session/<key>.json` and run scope using `/memory/runs/<runId>/<key>.json`.

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
  - `maxSteps` budget (default 16; positive integer, no hard upper cap).

Tests:
- Default loop with a real built-in tool round trip (via FakeModelProvider scripted scenario).
- Permission denial → tool result message with `PERMISSION_DENIED`; run continues.
- `maxSteps` cap → `AgentLoopBudgetError`.

Exit: agent tests green.

## Phase 12 — Workflows

Deliverables:
- `packages/harness/src/workflows/` with `WorkflowContext`, parallel agent invocation, signal propagation.

Exit: workflow tests green.

## Phase 12b — Optional governance policy

Deliverables:
- `packages/harness/src/policy/` with the core `PolicyEvaluator` port,
  native policy evaluator, approval adapter contract, audit sink contract, and
  sanitized audit record helpers from [24-governance-policy](./24-governance-policy.md).
- Late builder `.governance(...)` stage typed against the already declared
  tools, agents, workflows, and model aliases.
- Tool-call integration in the default loop and typed tool invocation path:
  permission check first, input validation second, `phase:'pre'` policy third,
  tool invocation, then `phase:'post'` policy.
- `PolicyDeniedError` and `DecisionEvaluationError` from
  [15-error-catalog](./15-error-catalog.md).
- `policy.evaluated`, `approval.requested`, and `approval.responded` run events.
- Testing helpers/fakes for native policies, approval adapters, audit sinks, and
  addon evaluator contract tests.

Tests:
- No `.governance(...)` behavior remains byte-for-byte compatible at the public
  API level.
- Unknown policy references fail at the type level and at builder validation.
- Default `deny` and explicit `allow` fallthrough behavior.
- Shadow mode, approval paths, policy denial recovery, evaluator failure
  fail-closed/fail-open semantics, and audit/event redaction.

Exit: governance tests, type tests, public API diff, and no-content telemetry
fixtures green.

## Phase 13 — Public API + builder + `$infer` + testing subpath

Deliverables:
- `packages/harness/src/harness/defineHarness.ts` exporting the chainable `HarnessBuilder` entry point.
- `.storage(...)`, `.requires(...)`, and `harness.inspect()` for adapter capability policy and data-only inspection.
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
- A short integration note explaining how PURISTA `@purista/core` attached agents consume `RunEvent` directly instead of introducing a second internal AI protocol.

Constraints:
- The quickstart example MUST import only from `@purista/harness` and `@purista/harness-openai`.
- Examples MUST NOT use the Vercel AI SDK stream protocol or a PURISTA AI protocol envelope.

Exit: example runs against `FakeModelProvider` in CI.

## Phase 16 — Generic evaluation substrate

Deliverables:
- `runEvaluation` and `scoreEvaluation` in the main `@purista/harness` export:
  the former constructs observations from the approved matrix and scores them;
  the latter re-scores application-owned observations through the same scorer
  engine. Both implement identity/trials, result/error/coverage, deterministic
  ordering, aggregation, concurrency, cancellation, timeout, failure policy,
  optional OTel, separate task/scorer accounting, and feedback behavior.
- `createDeterministicEvaluationScorer` plus its definition types in the main
  export, re-exported by `@purista/harness/testing`; it is a typed predicate
  adapter, not a partial schema/pointer implementation.
- Delete the previous aggregate evaluator, standalone scorer API, old tests,
  exports, documentation, and telemetry declarations with no alias, wrapper,
  overload, or alternate entrypoint.
- No Cloudgrid adapter package, HTTP endpoint, dataset store, prompt-version
  store, product scorer registry, Python, Optuna, or external optimizer
  dependency.

Exit: all acceptance requirements in
[35-generic-evaluation-runs](./35-generic-evaluation-runs.md) pass and the stale
symbol scan is empty outside explicit removal requirements in specifications
and the approved implementation plan.

## Post-1.5 reliability hardening — Provider retry DX

Problem:
- Provider errors and retry behavior are already normalized in
  [23-provider-outcomes-and-retry](./23-provider-outcomes-and-retry.md), but
  JavaScript/generated config users can still supply impossible retry budgets.
- Exhausted active retries should be distinguishable from non-retryable errors
  so API edges, queues, and runbooks can route failures with less inference.

Deliverables:
- Runtime validation for alias-level, default, and per-call model retry
  policies. Invalid values fail with
  `HarnessConfigError{reason:'invalid_model_retry_policy'}` before provider
  execution.
- Final transient errors that already consumed active retry attempts report
  `retryKind:'active'`, `retryAttempt`, and `retryMaxAttempts`; they do not
  invent `retryAfterMs`.
- Docs, public API notes, specs, and the `ai-harness` skill catalog describe
  the validation and retry-kind semantics.

Tests:
- Invalid alias-level and `defaults.retry` policies fail during `.models(...)`.
- Invalid per-call `call.retry` fails before a provider call starts.
- Exhausted active retry attempts produce `retryKind:'active'`.

Exit: focused provider/base harness tests, typecheck, lint, skill/knowledge
audits, and full CI are green.

## Follow-up wave — static modules and lifecycle ownership

Deliverables:
- `defineHarnessModule()` and typed `.use()` static composition, preserving
  cross-module literal inference without a dynamic module loader.
- Additive collision-rejecting definition registration and deterministic,
  data-only inspection provenance.
- Centralized, identity-deduplicated, failure-aggregating, idempotent harness
  shutdown for all resolved closable resources.
- A checked capability-family catalog/dependency verifier and one consumer
  fixture; no package extraction occurs until the verifier is green.

Tests:
- Type and runtime module-composition matrix, external workspace fixture,
  duplicate/atomicity/JavaScript validation cases, inspection privacy, and
  comprehensive shutdown tests from
  [25-static-harness-modules](./25-static-harness-modules.md).

Exit: the static-module specification is implemented, public API diff test is
updated, architecture verifier is deterministic, and the full CI matrix passes.

## Follow-up wave — transient context projection

Deliverables:
- Effective context-projection policy resolution and UTF-8-safe tool-result
  pruner on the transient provider request path.
- Exactly one context-length recovery attempt, with cancellation and durable
  history/event invariants preserved.

Tests:
- The complete acceptance matrix in
  [26-context-projection-and-compaction](./26-context-projection-and-compaction.md),
  including tool/skill/history integrity and privacy assertions.

Exit: no persistent record changes occur during projection and all focused plus
full CI tests pass.

## Follow-up wave — test replay and diagnostic invariants

Deliverables:
- Explicit-sanitizer interaction fixture recorder and strict offline replay
  model provider under `@purista/harness/testing`.
- Explicitly enabled diagnostic invariant runner with data-minimized findings.
- Public API, README, skill guidance, and hermetic examples for static modules,
  replay, and diagnostics.

Tests:
- The complete acceptance matrix in
  [27-test-replay-and-diagnostic-invariants](./27-test-replay-and-diagnostic-invariants.md),
  including no-I/O and no-content-leak proof cases.

Exit: test-only facilities stay opt-in, public/export docs are exact, skills
pass their repository audits, and full CI is green.

## Follow-up wave — Agent Plugins and current MCP major cut

Deliverables:
- Upgrade and pin the MCP runtime to a Tier-1 SDK release implementing MCP
  `2026-07-28`; remove legacy protocol state, HTTP+SSE transport, fallback,
  and compatibility code as one breaking major release.
- Add only the provider-neutral prepared MCP stdio launch bridge necessary to
  stage a validated immutable root and persistent writable data directory into
  the existing sandbox/MCP lifecycle.
- Add `@purista/harness-agent-plugins`, which locally validates Agent Plugins
  1.0.0 manifests/schemas, enforces Windows/Linux realpath containment and
  explicit application trust/digest policy, reuses the core skills loader, and
  projects explicitly selected MCP tools into normal typed bindings.
- Extend existing OTel renderer/metrics and inspection provenance without a
  second telemetry pipeline or content capture.
- Add the hermetic Agent Plugins example, docs/handbook/API/skill updates,
  package release verification, CI coverage, and the current-MCP migration
  notes. Runtime compatibility/migration shims are prohibited.

Tests:
- The complete Agent Plugins and MCP acceptance matrix in
  [29-agent-plugins](./29-agent-plugins.md), including current stateless MCP
  routing/list-cache/tasks, legacy rejection, security/privacy, staged stdio,
  explicit aliases, and Linux/Windows filesystem tests.

Exit: the addon package publishes with the same workflow as core, current MCP
fixtures pass with no external server, the example is hermetic, public APIs and
docs are exact, and the full CI matrix is green.

## CI

- Single GitHub Actions workflow: matrix over Node 20 and 22.
- Steps: install (`pnpm i --frozen-lockfile`), build (`pnpm -r build`), test (`pnpm -r test --coverage`), enforce coverage gates.

## Cross-references

- All other spec files. This is the build order.

## Decision-boundary implementation authority

The approved [decision-boundary plan](../plans/decision-boundaries/implementation-plan.md) owns current guardrail/governance/approval refactoring and cleanup. Earlier completed wave descriptions do not authorize retaining replaced callback or event shapes.
