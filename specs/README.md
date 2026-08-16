# `@purista/harness` — Specification v2

This folder is the authoritative specification for the `@purista/harness` library and its provider ecosystem. The implementation agent must read every file. No file may be skipped; no decision may be improvised beyond what is locked here.

The folder contains 30 files (this README plus 29 numbered specs). The published package set includes `@purista/harness` (the umbrella library) plus independent provider and adapter addons such as `@purista/harness-openai`, `@purista/harness-anthropic`, `@purista/harness-bedrock`, `@purista/harness-azure-foundry`, `@purista/harness-agent-plugins`, future `@purista/harness-memory-*` packages, and future external durable workspace store packages. Core also ships local-first durable execution adapters backed by built-in Node/Bun SQLite plus host-directory workspaces. Private examples may exist under `examples/` when backed by numbered specs. Non-core packages follow the convention `@purista/harness-{addon}`. Shared tool execution, including TypeScript and MCP tools, is part of the harness contract.

## Reading order

For an implementation agent starting cold, read in this order:

1. [00-overview.md](./00-overview.md) — purpose, mental model, scope, glossary.
2. [01-architecture.md](./01-architecture.md) — package layout and dependency direction.
3. [02-harness-config.md](./02-harness-config.md) — `defineHarness` schema and validation.
4. [03-foundation.md](./03-foundation.md) — logger, error base, OTel integration.
5. [04-state-queue-stream.md](./04-state-queue-stream.md) — state and events.
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
20. [19-ai-eval-core.md](./19-ai-eval-core.md) — harness-owned AI eval core, telemetry interop, run summaries, trace-context propagation, and local scorer/candidate helpers.
21. [20-memory-adapters.md](./20-memory-adapters.md) — pluggable memory adapter port, scopes, telemetry, metrics, reference adapter, and testing contract.
22. [21-durable-workspaces.md](./21-durable-workspaces.md) — production durable workspace lifecycle, checkpoint references, retention, encryption, cleanup, quotas, fallback, telemetry, and contract tests.
23. [22-local-durable-execution.md](./22-local-durable-execution.md) — built-in local durable execution with SQLite runtime persistence, host-directory workspace/sandbox binding, context checkpoints, and secure defaults.
24. [23-provider-outcomes-and-retry.md](./23-provider-outcomes-and-retry.md) — provider-neutral finish outcomes, active/deferred retry policy, SDK retry boundaries, and rate-limit metadata.
25. [24-governance-policy.md](./24-governance-policy.md) — optional policy-driven governance layer for typed tool exposure, execution policy, approvals, audit events, and external policy adapters.
26. [25-static-harness-modules.md](./25-static-harness-modules.md) — static typed modules, provenance, lifecycle ownership, and capability-family rules.
27. [26-context-projection-and-compaction.md](./26-context-projection-and-compaction.md) — transient context projection and bounded recovery.
28. [27-test-replay-and-diagnostic-invariants.md](./27-test-replay-and-diagnostic-invariants.md) — sanitized test replay and opt-in diagnostic invariants.
29. [28-workflow-child-tasks.md](./28-workflow-child-tasks.md) — typed background child tasks, bounded fan-out, and in-process continuables.
30. [29-agent-plugins.md](./29-agent-plugins.md) — first-party Agent Plugins client, trust, portable Skills/MCP projection, and current MCP behavior.

## File index (one-liners)

| File | Summary |
|------|---------|
| [00-overview.md](./00-overview.md) | Purpose, mental model, scope/non-goals, glossary. |
| [01-architecture.md](./01-architecture.md) | Layering, dependency rules, core-plus-provider package layout. |
| [02-harness-config.md](./02-harness-config.md) | `defineHarness()` chainable builder, defaults, validation rules. |
| [03-foundation.md](./03-foundation.md) | Logger interface, `HarnessError` base, OTel approach. |
| [04-state-queue-stream.md](./04-state-queue-stream.md) | StateStore port + in-memory default + persisted shapes. |
| [05-sandbox.md](./05-sandbox.md) | Sandbox port (FS + exec), `inMemorySandbox()` files-only and `bashSandbox()` (just-bash) defaults, auto-detect. |
| [06-models.md](./06-models.md) | Model alias, `ModelProvider` port, capability enforcement. |
| [07-tools.md](./07-tools.md) | TS, MCP-stdio, MCP-http tool configs and behavior. |
| [08-skills.md](./08-skills.md) | Agent Skills discovery, strict/lenient `SKILL.md` frontmatter parsing, trust/collision rules, mount-at-`/skills/<name>/`, progressive disclosure, activation, and privacy. |
| [09-agents.md](./09-agents.md) | Inline `AgentDefinition`, default loop with built-in tools, per-agent permissions, `maxSteps`. |
| [10-workflows.md](./10-workflows.md) | Inline `WorkflowDefinition`, parallel agents, cancellation. |
| [11-sessions.md](./11-sessions.md) | `Session` API, persistence, serial concurrency rule, `SessionMemory`, conversation history. |
| [12-streaming.md](./12-streaming.md) | `RunEvent` union, ordering guarantees, in-process buffered queue. |
| [13-public-api.md](./13-public-api.md) | Authoritative export list; Zod-to-JSON-Schema conversion rules. |
| [14-otel-conventions.md](./14-otel-conventions.md) | Spans, metrics, attribute keys, log fields. |
| [15-error-catalog.md](./15-error-catalog.md) | Every error class, code, category, retriable, meta. |
| [16-testing.md](./16-testing.md) | Vitest, contract suites, fakes, coverage gates. |
| [17-implementation-plan.md](./17-implementation-plan.md) | Phased build order with exit criteria. |
| [18-living-wiki-jaeger-example.md](./18-living-wiki-jaeger-example.md) | Canonical living-wiki intelligence workspace contract covering Hono, React/Vite, OpenAI, direct agents, workflows, HITL review, artifacts, MCP, SSE, and Jaeger. |
| [19-ai-eval-core.md](./19-ai-eval-core.md) | Harness-owned AI eval core functionality and explicit non-ownership of Cloudgrid adapter concerns. |
| [20-memory-adapters.md](./20-memory-adapters.md) | Memory adapter port, run/session/agent/user/tenant scopes, telemetry, metrics, and sandbox-backed reference adapter. |
| [21-durable-workspaces.md](./21-durable-workspaces.md) | Durable workspace store contract for production replay across runtime checkpoints and sandbox workspace state. |
| [22-local-durable-execution.md](./22-local-durable-execution.md) | Local durable execution bundle using SQLite runtime persistence, host-directory workspaces, durable sandbox binding, and context checkpoint storage. |
| [23-provider-outcomes-and-retry.md](./23-provider-outcomes-and-retry.md) | Provider-neutral finish outcomes, active/deferred retry policy, SDK retry boundaries, and rate-limit metadata. |
| [24-governance-policy.md](./24-governance-policy.md) | Optional tool-exposure and tool-call governance, typed native policy rules, approval adapters, shadow mode, and external policy engine adapters. |
| [25-static-harness-modules.md](./25-static-harness-modules.md) | Static typed module composition, provenance, capability-family ownership, and lifecycle rules. |
| [26-context-projection-and-compaction.md](./26-context-projection-and-compaction.md) | Model-visible context projection, tool-result pruning, and single-retry recovery. |
| [27-test-replay-and-diagnostic-invariants.md](./27-test-replay-and-diagnostic-invariants.md) | Sanitized offline provider replay and explicit diagnostic invariant contracts. |
| [28-workflow-child-tasks.md](./28-workflow-child-tasks.md) | Typed child-task lifecycle, queued fan-out, durable descriptors, and in-process continuables. |
| [29-agent-plugins.md](./29-agent-plugins.md) | First-party Agent Plugins client: trusted local package inspection, Skills/MCP binding, portable filesystem behavior, MCP, telemetry, testing, and release/docs scope. |

## Authoritative anchors

- All exported symbols → [13-public-api.md](./13-public-api.md).
- All error classes → [15-error-catalog.md](./15-error-catalog.md).
- All OTel names → [14-otel-conventions.md](./14-otel-conventions.md).
- Durable workspace lifecycle and replay semantics → [21-durable-workspaces.md](./21-durable-workspaces.md).
- Local durable execution, SQLite runtime persistence, and context checkpoints → [22-local-durable-execution.md](./22-local-durable-execution.md).
- Provider outcomes, active/deferred retry, and rate-limit metadata → [23-provider-outcomes-and-retry.md](./23-provider-outcomes-and-retry.md).
- Tool-exposure and tool-call governance, approvals → [24-governance-policy.md](./24-governance-policy.md).
- Static module behavior and provenance → [25-static-harness-modules.md](./25-static-harness-modules.md).
- Transient context projection → [26-context-projection-and-compaction.md](./26-context-projection-and-compaction.md).
- Test-only replay and diagnostics → [27-test-replay-and-diagnostic-invariants.md](./27-test-replay-and-diagnostic-invariants.md).
- Workflow child tasks, fan-out, and continuables → [28-workflow-child-tasks.md](./28-workflow-child-tasks.md).
- Agent Plugins client behavior, trust, and portable package semantics → [29-agent-plugins.md](./29-agent-plugins.md).
- Build order → [17-implementation-plan.md](./17-implementation-plan.md).

If two files appear to disagree, the more specific file wins (catalog/api/conventions > behavior > overview). Report any contradiction discovered during implementation as a spec bug rather than improvising.
