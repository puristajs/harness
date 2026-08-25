# Spec Conformance Status

This page tracks current implementation alignment with the approved specs. It
is a reference for maintainers and reviewers, not the first page new users
should read.

## Summary

- Builder, sessions, direct agents, workflows, tools, skills, sandbox/state
  defaults, logging, and telemetry are implemented.
- Direct agent invocation and workflow invocation are canonical session APIs.
- TypeScript tools and MCP stdio/HTTP tools are executable.
- MCP stdio runs through the sandbox executor and supports sandbox install
  commands.
- Memory engines are wired through the session, workflow, agent, and tool
  contexts with secure-by-default telemetry.
- Living Wiki Jaeger demonstrates the full application path with optional
  external integrations.

## Status By Area

| Area | Status | Notes |
|---|---|---|
| Foundation: errors, logger, telemetry, ULID | Aligned | Error metadata and structured logs are covered by tests. |
| State and event persistence | Aligned | In-memory default and contracts cover ordering and event persistence. |
| Memory engines | Aligned | In-memory default, scoped identity, capability gates, memory telemetry, `memoryEngineContract`, and SQLite/PostgreSQL/Redis/NATS packages are covered. |
| Sandbox | Aligned | Files-only and executor-capable paths are covered. |
| Models and provider adapters | Aligned | Capability gates, provider error normalization, and object-mode application tool-call preservation are covered. |
| Direct agents | Aligned | `session.agents.<id>.prompt/stream` is canonical. |
| Workflows | Aligned | Optional orchestration with typed `ctx.agents`, delegation budgets, allowlists, and child-agent lineage events. |
| TypeScript tools | Aligned | Zod input/output validation and tool spans. |
| MCP tools | Aligned | Stdio/HTTP success and failure paths have focused tests. |
| Skills | Aligned | `SKILL.md` frontmatter validation and mounting are implemented. |
| Durable workspaces (spec 21) | Aligned | `DurableWorkspace` port, lifecycle/idempotency/quota errors, in-memory reference store, and `durableWorkspaceContract` are covered. |
| Local durable execution (spec 22) | Aligned | `localDurableExecution()` bundle: SQLite Harness storage and host-directory durable workspace, jailed local sandbox, lease and resume semantics. |
| Provider outcomes and retry (spec 23) | Aligned | Normalized `ModelOutcome`/`FinishReason`, active/deferred retry policy with `longRetry`, SDK retry disabling, rate-limit metadata, and the shared `modelProviderContract` across all four adapters. |
| Living Wiki example | Aligned | Real app shell, application-owned review tasks, artifacts, graph, SSE, Jaeger links, optional draw.io MCP. |

## Verification Snapshot

Expected gates:

```bash
npm run lint
npm run build
npm test
npm run test:coverage
npm run test:types
npm run test:contracts
npm run test:integration
npm run test:failure
```

Focused Living Wiki gates:

```bash
npm run typecheck --workspace @purista/living-wiki-jaeger-example
npm run test --workspace @purista/living-wiki-jaeger-example
npm run test:ui --workspace @purista/living-wiki-jaeger-example
npm run build --workspace @purista/living-wiki-jaeger-example
```

## Remaining Operational Notes

- The Living Wiki frontend build currently emits a Vite warning for large
  Mermaid/Three.js chunks. This is a bundle optimization follow-up, not a
  correctness issue.
- Real OpenAI, real draw.io MCP, and Jaeger remain opt-in for local
  development and manual verification.
