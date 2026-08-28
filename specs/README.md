# `@purista/harness` — Specification v3

This folder is the authoritative specification for the `@purista/harness` library and its provider ecosystem. The implementation agent must read every file. No file may be skipped; no decision may be improvised beyond what is locked here. All persistence-related specs have been reconciled with the v3 `HarnessStorage` clean break in `32-harness-storage.md`. Proposed specs remain non-implementable until their matching readiness scope is approved.

The folder contains numbered specifications through 36 plus this index; spec 33 is a structured, manifest-bound feature folder, spec 34 is the approved distributed sandbox contract/bake-off scope, and spec 35 is the approved clean-break generic evaluation contract. Spec 34 keeps provider selection and production adapter work behind a separate bake-off decision. The published package set includes `@purista/harness` (the umbrella library) plus independent provider and adapter addons such as `@purista/harness-openai`, `@purista/harness-anthropic`, `@purista/harness-bedrock`, `@purista/harness-azure-foundry`, `@purista/harness-agent-plugins`, `@purista/harness-guardrails-presidio`, `@purista/harness-guardrails-native-privacy`, and the planned `@purista/harness-memory-postgres` and `@purista/harness-memory-redis` engines. Core also ships local-first durable execution adapters backed by built-in Node/Bun SQLite plus host-directory workspaces. Private examples may exist under `examples/` when backed by numbered specs. Non-core packages follow the convention `@purista/harness-{addon}`. Shared tool execution, including TypeScript and MCP tools, is part of the harness contract.

## Active sandbox follow-up

[Spec 36: sandbox ownership and administration](./36-sandbox-ownership-and-administration/00-vision.md)
is approved and extends the numbered set through 36. It is the canonical source
for inherited/private/group sharing, exact owner versus actor identity, indexed
offboarding, bounded retention, and PURISTA mapping. Its explicit precedence map
supersedes the listed parts of specs 05/09/10/11/13/14/15/16/21/22/25/28/32/34;
all other requirements and spec 34's production-provider gate remain in force.
Earlier manifest-bound spec 34 and its accepted audit stay historical, not
retroactively rewritten. Use the [new scoped plan](../plans/sandbox-ownership/implementation-plan.md)
for this follow-up. It authorizes no implementation during the planning turn.

## Detailed reading order

For an implementation agent starting cold, read in this order:

1. [00-overview.md](./00-overview.md) — purpose, mental model, scope, glossary.
2. [01-architecture.md](./01-architecture.md) — package layout and dependency direction.
3. [02-harness-config.md](./02-harness-config.md) — `defineHarness` schema and validation.
4. [03-foundation.md](./03-foundation.md) — logger, error base, OTel integration.
5. [04-state-queue-stream.md](./04-state-queue-stream.md) — Harness storage and events.
6. [05-sandbox.md](./05-sandbox.md) — sandbox port (FS + exec) and default factories.
7. [06-models.md](./06-models.md) — model provider port.
8. [07-tools.md](./07-tools.md) — TS, MCP-stdio, MCP-http tools.
9. [08-skills.md](./08-skills.md) — skill manifest and executor.
10. [09-agents.md](./09-agents.md) — inline `AgentDefinition`, `AgentContext`, default loop.
11. [10-workflows.md](./10-workflows.md) — inline `WorkflowDefinition`, `WorkflowContext`.
12. [11-sessions.md](./11-sessions.md) — `Session` API, concurrency, conversation history.
13. [12-streaming.md](./12-streaming.md) — `RunEvent`, bounded live streaming, and privacy-safe persistence.
14. [13-public-api.md](./13-public-api.md) — authoritative export list.
15. [14-otel-conventions.md](./14-otel-conventions.md) — span/metric/attribute names.
16. [15-error-catalog.md](./15-error-catalog.md) — every error class.
17. [16-testing.md](./16-testing.md) — vitest, contract suites, gates.
18. [17-implementation-plan.md](./17-implementation-plan.md) — ordered build phases.
19. [18-living-wiki-jaeger-example.md](./18-living-wiki-jaeger-example.md) — canonical Living Wiki intelligence workspace with direct agents, workflows, HITL review, artifacts, MCP, SSE, and Jaeger tracing.
20. [19-ai-eval-core.md](./19-ai-eval-core.md) — runtime telemetry configuration, trace-context propagation, run summaries, and the generic evaluation ownership boundary.
21. [20-memory-adapters.md](./20-memory-adapters.md) — redirect to the clean-break enterprise memory contract.
22. [21-durable-workspaces.md](./21-durable-workspaces.md) — production durable workspace lifecycle, checkpoint references, retention, encryption, cleanup, quotas, fallback, telemetry, and contract tests.
23. [22-local-durable-execution.md](./22-local-durable-execution.md) — built-in local durable execution with native SQLite Harness storage, host-directory workspace/sandbox binding, and secure defaults.
24. [23-provider-outcomes-and-retry.md](./23-provider-outcomes-and-retry.md) — provider-neutral finish outcomes, active/deferred retry policy, SDK retry boundaries, and rate-limit metadata.
25. [24-governance-policy.md](./24-governance-policy.md) — optional policy-driven governance layer for typed tool exposure, execution policy, approvals, audit events, and external policy adapters.
26. [25-static-harness-modules.md](./25-static-harness-modules.md) — static typed modules, provenance, lifecycle ownership, and capability-family rules.
27. [26-context-projection-and-compaction.md](./26-context-projection-and-compaction.md) — transient context projection and bounded recovery.
28. [27-test-replay-and-diagnostic-invariants.md](./27-test-replay-and-diagnostic-invariants.md) — sanitized test replay and opt-in diagnostic invariants.
29. [28-workflow-child-tasks.md](./28-workflow-child-tasks.md) — typed background child tasks, bounded fan-out, and in-process continuables.
30. [29-agent-plugins.md](./29-agent-plugins.md) — first-party Agent Plugins client, trust, portable Skills/MCP projection, and current MCP behavior.
31. [30-guardrails.md](./30-guardrails.md) — typed NeMo-shaped guardrails subset.
32. [31-sensitive-data-guardrails.md](./31-sensitive-data-guardrails.md) — sensitive-data adapters and privacy behavior.
33. [32-harness-storage.md](./32-harness-storage.md) — one Harness storage boundary, one run model, local SQLite, external waits, and PURISTA integration contract.
34. [33-enterprise-memory](./33-enterprise-memory/00-vision.md) — core memory orchestration, typed model references, tenant/principal identity, search, summaries, SQLite/PostgreSQL/Redis/NATS engines, PURISTA integration, and release gates.
35. [34-distributed-sandbox-lifecycle](./34-distributed-sandbox-lifecycle/00-vision.md) — approved topology-transparent Sandbox lifecycle with adapter-private distributed coordination, local development/test adapters, durable-file recovery, PURISTA boundary, telemetry, tests, and provider bake-off gate.
36. [35-generic-evaluation-runs.md](./35-generic-evaluation-runs.md) — provider-neutral execute-and-score and score-only observation contract, versioned trials, multi-scorer outcomes, separate task/judge accounting, aggregates, cancellation, feedback projection, and safe telemetry.

## File index (one-liners)

| File | Summary |
|------|---------|
| [00-overview.md](./00-overview.md) | Purpose, mental model, scope/non-goals, glossary. |
| [01-architecture.md](./01-architecture.md) | Layering, dependency rules, core-plus-provider package layout. |
| [02-harness-config.md](./02-harness-config.md) | `defineHarness()` chainable builder, defaults, validation rules. |
| [03-foundation.md](./03-foundation.md) | Logger interface, `HarnessError` base, OTel approach. |
| [04-state-queue-stream.md](./04-state-queue-stream.md) | HarnessStorage port, in-memory default, durable lifecycle, and persisted shapes. |
| [05-sandbox.md](./05-sandbox.md) | Sandbox port (FS + exec), `inMemorySandbox()` files-only and `bashSandbox()` (just-bash) defaults, auto-detect. |
| [06-models.md](./06-models.md) | Model alias, `ModelProvider` port, capability enforcement. |
| [07-tools.md](./07-tools.md) | TS, MCP-stdio, MCP-http tool configs and behavior. |
| [08-skills.md](./08-skills.md) | Agent Skills discovery, strict/lenient `SKILL.md` frontmatter parsing, trust/collision rules, mount-at-`/skills/<name>/`, progressive disclosure, activation, and privacy. |
| [09-agents.md](./09-agents.md) | Inline `AgentDefinition`, default loop with built-in tools, per-agent permissions, `maxSteps`. |
| [10-workflows.md](./10-workflows.md) | Inline `WorkflowDefinition`, parallel agents, cancellation. |
| [11-sessions.md](./11-sessions.md) | `Session` API, persistence, serial concurrency rule, `SessionMemory`, conversation history. |
| [12-streaming.md](./12-streaming.md) | `RunEvent` union, ordering guarantees, in-process buffered queue. |
| [13-public-api.md](./13-public-api.md) | Authoritative export list; Zod-to-JSON-Schema conversion rules. |
| [30-guardrails.md](./30-guardrails.md) | Optional NeMo-shaped config subset, rail phases, failure/privacy rules, and release evidence. |
| [31-sensitive-data-guardrails.md](./31-sensitive-data-guardrails.md) | Sensitive-data policy, detector port, optional Presidio/native packages, Node/Bun support, privacy and release evidence. |
| [14-otel-conventions.md](./14-otel-conventions.md) | Spans, metrics, attribute keys, log fields. |
| [15-error-catalog.md](./15-error-catalog.md) | Every error class, code, category, retriable, meta. |
| [16-testing.md](./16-testing.md) | Vitest, contract suites, fakes, coverage gates. |
| [17-implementation-plan.md](./17-implementation-plan.md) | Phased build order with exit criteria. |
| [18-living-wiki-jaeger-example.md](./18-living-wiki-jaeger-example.md) | Canonical living-wiki intelligence workspace contract covering Hono, React/Vite, OpenAI, direct agents, workflows, HITL review, artifacts, MCP, SSE, and Jaeger. |
| [19-ai-eval-core.md](./19-ai-eval-core.md) | Runtime telemetry, trace-context, run-summary, and generic evaluation ownership foundation. |
| [20-memory-adapters.md](./20-memory-adapters.md) | Redirect to the approved clean-break enterprise memory specification. |
| [21-durable-workspaces.md](./21-durable-workspaces.md) | Durable workspace contract for production replay across storage checkpoints and sandbox workspace state. |
| [22-local-durable-execution.md](./22-local-durable-execution.md) | Local durable execution bundle using native SQLite Harness storage, host-directory workspaces, and durable sandbox binding. |
| [23-provider-outcomes-and-retry.md](./23-provider-outcomes-and-retry.md) | Provider-neutral finish outcomes, active/deferred retry policy, SDK retry boundaries, and rate-limit metadata. |
| [24-governance-policy.md](./24-governance-policy.md) | Optional tool-exposure and tool-call governance, typed native policy rules, approval adapters, shadow mode, and external policy engine adapters. |
| [25-static-harness-modules.md](./25-static-harness-modules.md) | Static typed module composition, provenance, capability-family ownership, and lifecycle rules. |
| [26-context-projection-and-compaction.md](./26-context-projection-and-compaction.md) | Model-visible context projection, tool-result pruning, and single-retry recovery. |
| [27-test-replay-and-diagnostic-invariants.md](./27-test-replay-and-diagnostic-invariants.md) | Sanitized offline provider replay and explicit diagnostic invariant contracts. |
| [28-workflow-child-tasks.md](./28-workflow-child-tasks.md) | Typed child-task lifecycle, queued fan-out, durable descriptors, and in-process continuables. |
| [29-agent-plugins.md](./29-agent-plugins.md) | First-party Agent Plugins client: trusted local package inspection, Skills/MCP binding, portable filesystem behavior, MCP, telemetry, testing, and release/docs scope. |
| [32-harness-storage.md](./32-harness-storage.md) | Clean-break Harness storage contract replacing separately configured state, runtime, context-checkpoint, and external-wait persistence. |
| [33-enterprise-memory](./33-enterprise-memory/00-vision.md) | Manifest-bound memory orchestration, identity, search, summary, SQLite, PostgreSQL, Redis, NATS, PURISTA, testing, operations, and migration contract. |
| [34-distributed-sandbox-lifecycle](./34-distributed-sandbox-lifecycle/00-vision.md) | Approved topology-transparent Sandbox lifecycle, adapter conformance boundaries, and provider bake-off criteria; production adapter selection remains blocked. |
| [35-generic-evaluation-runs.md](./35-generic-evaluation-runs.md) | Clean-break generic evaluation run/observation/result contract, including score-only reuse, trials, assessment coverage, accounting, and optional OTel. |

## Authoritative anchors

- All exported symbols → [13-public-api.md](./13-public-api.md).
- All error classes → [15-error-catalog.md](./15-error-catalog.md).
- All OTel names → [14-otel-conventions.md](./14-otel-conventions.md).
- Durable workspace lifecycle and replay semantics → [21-durable-workspaces.md](./21-durable-workspaces.md).
- Local durable execution, native SQLite Harness storage, and workspace binding → [22-local-durable-execution.md](./22-local-durable-execution.md).
- Provider outcomes, active/deferred retry, and rate-limit metadata → [23-provider-outcomes-and-retry.md](./23-provider-outcomes-and-retry.md).
- Tool-exposure and tool-call governance, approvals → [24-governance-policy.md](./24-governance-policy.md).
- Static module behavior and provenance → [25-static-harness-modules.md](./25-static-harness-modules.md).
- Transient context projection → [26-context-projection-and-compaction.md](./26-context-projection-and-compaction.md).
- Test-only replay and diagnostics → [27-test-replay-and-diagnostic-invariants.md](./27-test-replay-and-diagnostic-invariants.md).
- Workflow child tasks, fan-out, and continuables → [28-workflow-child-tasks.md](./28-workflow-child-tasks.md).
- Agent Plugins client behavior, trust, and portable package semantics → [29-agent-plugins.md](./29-agent-plugins.md).
- Harness structured persistence and PURISTA `ai.storage` integration → [32-harness-storage.md](./32-harness-storage.md).
- Memory orchestration, typed model references, database engines, and PURISTA `ai.memory` integration → [33-enterprise-memory](./33-enterprise-memory/00-vision.md).
- Distributed sandbox scope, adapter-private generations/leases/fencing, durable recovery, PURISTA boundary, and provider bake-off → [34-distributed-sandbox-lifecycle](./34-distributed-sandbox-lifecycle/00-vision.md).
- Generic evaluation execution and result behavior → [35-generic-evaluation-runs](./35-generic-evaluation-runs.md).
- Build order → [17-implementation-plan.md](./17-implementation-plan.md).

If two files appear to disagree, the more specific file wins (catalog/api/conventions > behavior > overview). Report any contradiction discovered during implementation as a spec bug rather than improvising.

## Approved decision-boundary refactor (2026-08-26)

[Scope and approval](./37-decision-boundaries/00-vision.md), [contracts](./37-decision-boundaries/03-contracts/decisions.md), and [implementation plan](../plans/decision-boundaries/implementation-plan.md). This scope replaces guardrail/governance/approval callback and replay definitions without compatibility paths; other approved workstreams remain unchanged.

## Guardrail authoring and callback inference

[Approved scoped target](./38-guardrail-authoring/00-vision.md) and [implementation plan](../plans/guardrail-authoring/implementation-plan.md): optional YAML, source-derived config, action tokens, build preflight, callback inference and clean consumer alignment. Definition-ready; implementation not started. Voyage excluded.
