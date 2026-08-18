# DeepSeek Workflow and Sub-agent Comparison

- **Date:** 2026-08-14
- **PURISTA baseline:** current `codex/static-harness-modules` worktree
- **DeepSeek source reviewed:** [`47f9438`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a) (developer preview; upstream declares compatibility-breaking changes)
- **Scope:** workflow and sub-agent execution only. Web UI, presets, plugin discovery, and live plugin reload are out of scope.

## Decision in one sentence

Keep PURISTA workflows as developer-authored, typed TypeScript. Adopt a
first-class **workflow-owned child-task lifecycle** and bounded fan-out helper;
do not add DeepSeek's model-authored `vm` workflow scripting or dynamic plugin
runtime to the core harness.

## What DeepSeek implements

| Area | Evidence | Useful property |
|---|---|---|
| Dynamic workflow seam | [`dsh-workflow`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/workflow/workflow/src/index.ts), [`worker engine`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/workflow/workflow-worker-thread/README.md) | Model-written scripts receive `agent`, `parallel`, `pipeline`, `phase`, and `log`; host controls limits and provider routing. |
| Bounded execution and cleanup | [`worker runtime`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/workflow/workflow-worker-thread/src/runtime.ts), [`host`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/workflow/workflow-worker-thread/src/host.ts) | Concurrency/total/item caps, one cancellation signal, a grace period, first-wins terminal outcome, and child reaping. |
| Provider-neutral subagent seam | [`subagent contract`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/types.ts), [`overview`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/README.md) | Named providers advertise supported child features; starts have a clear publish/ownership/dispose boundary. |
| Fresh or forked child context | [`spawn`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent-spawn-in-process/src/index.ts), [`fork`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent-fork-in-process/src/index.ts) | The caller explicitly chooses fresh context or a completed-turn prefix; a child gets its own session and lineage. |
| Long-lived child sessions | [`continuation manager`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/src/continuation.ts), [`delegation tool`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent/README.md) | A background child can accept follow-ups, be interrupted, report to its parent, and send an eventual settlement notice. |
| Generic background ownership | [`jobs contract`](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/jobs/jobs/README.md) | Per-owner listing, waiting, cancellation, completion notices, and bounded cleanup are reusable across job types. |

## Current PURISTA position

PURISTA already has several stronger foundation pieces for an application
library:

- Workflows are inline, typed handlers; agent ids, model aliases, inputs, and
  outputs are checked at compile time ([`specs/10-workflows.md`](../specs/10-workflows.md)).
- Child calls are deliberately workflow-only. Delegation is opt-in and has
  allowlists, model routing restrictions, total/parallel/depth budgets,
  cancellation propagation, telemetry, and content-free lineage events
  ([`sessions runtime`](../packages/harness/src/sessions/index.ts),
  [`workflow delegation tests`](../packages/harness/test/workflow-delegation.test.ts)).
- Durable workflows already replay committed, JSON-serializable `ctx.step()`
  outputs, rather than replaying arbitrary orchestration code
  ([`specs/10-workflows.md`](../specs/10-workflows.md),
  [`specs/22-local-durable-execution.md`](../specs/22-local-durable-execution.md)).
- Static local modules, transient context projection, sanitized model replay,
  and content-free diagnostics are now part of the harness. They preserve
  explicit ownership rather than making runtime composition mutable.

## Gap assessment

| Capability | PURISTA today | Recommendation |
|---|---|---|
| Typed, developer-authored fan-out | `Promise.all`/`Promise.allSettled` plus delegation budgets | Add a small typed `ctx.fanOut()` helper that **queues** at the configured concurrency limit, returns ordered settled results, propagates cancellation, and emits one stable batch id. It removes common ad-hoc semaphore code without replacing ordinary TypeScript. |
| Foreground child call lifecycle | Awaited `ctx.agents.<id>()`, with run events | Retain it. It is simpler and safer than a generic spawn handle when the next workflow action needs the answer. |
| Background child work | No workflow-owned handle, list/wait/cancel/report protocol, or durable child identity | Add a separate, explicit child-task capability. It must be owned by a workflow invocation, not exposed as an agent self-spawn tool. |
| Long-lived conversations with a child | Not present | Defer until the child-task foundation is proven. A first release should support one task input and one typed terminal output; follow-up messages need a separate durable session/authority model. |
| Child context isolation | Calls share the application session's history and state boundary | Add an explicit child context policy before background execution: default `isolated`; optional typed, bounded projection supplied by the workflow. Do not silently fork raw parent history. |
| Per-child authority | Workflow has agent/model allowlists; no child-specific tool subset contract | Add an intersection-only capability/tool policy for child tasks. A child may receive less authority than its parent/workflow, never more; record policy identity, not content. |
| Durable child start/retry | A durable step can surround an agent call, but child invocations themselves are not durable handles | Make `ctx.childTasks.start()` legal only inside a durable `ctx.step()` when durable execution is requested. Persist a typed descriptor and idempotency key before publishing work, then reconstruct the terminal result after restart. |
| Aggregate cost/time budgets | Call-count, parallelism, depth, and existing per-call timeout | Add workflow aggregate ceilings for child wall time and model usage/cost (where the provider reports it). Fail closed before a new child starts; surface a machine-readable budget error and counters. DeepSeek itself lists token-budget vocabulary as deferred, so this is an opportunity to lead rather than copy. |
| Child lifecycle observability | `agent.started`/`agent.finished` lineage exists | Add content-free `child_task.started`, `child_task.progress`, `child_task.settled`, and `child_task.cancelled` events, OTel spans, and deterministic correlation ids. A terminal event must be paired exactly once even on timeout/cancellation. |
| Model-authored workflow scripts | Not offered | Do **not** add to core. DeepSeek documents its worker/`node:vm` as containment rather than a security boundary; it would also discard the main type-inference advantage of `WorkflowContext`. Consider only a future, separately sandboxed adapter with an explicit threat model. |
| Dynamic plugins / live reload | Not offered | Do **not** adopt. Static modules are intentionally local, synchronous, typed, and immutable after `build()`; this is the correct application-library trade-off. |

## Proposed delivery plan

### Phase 0 — lock the contracts before code

Create `specs/28-workflow-child-tasks.md` and update the public API, error,
streaming, telemetry, testing, durable-runtime, and security specifications.
Decide these non-negotiables:

1. Only workflow handlers can create child tasks; agents remain leaf loops.
2. `start()` returns a typed opaque handle; it cannot disclose another task's
   output or be forged from an id.
3. A handle exposes `result`, `cancel`, and a status snapshot. `dispose`/close
   ownership and idempotency must be explicit.
4. Default context is isolated. Any projected parent context is bounded,
   serializable, redacted by caller policy, and recorded as a policy id—not
   persisted raw as a new hidden transcript.
5. Authority only narrows: agent, model, tool, sandbox, and approval policies
   intersect with the caller's effective policy.
6. Cancellation, timeout, terminal state, and parent shutdown use first-wins
   rules, with a bounded cleanup grace. Terminal lifecycle events pair exactly
   once.

**Exit gate:** a security and durability review approves the state machine,
ownership table, persistence shape, and public type signatures.

### Phase 1 — ergonomic bounded fan-out

Add `ctx.fanOut(items, options, worker)` for existing registered agents only.
It is a convenience primitive, not a workflow DSL:

```ts
const reviews = await ctx.fanOut(tickets, { concurrency: 4 }, (ticket) =>
  ctx.agents.reviewer({ ticketId: ticket.id })
)
```

It preserves input order, queues rather than rejects merely because the local
parallel limit is full, propagates `ctx.signal`, and still consumes the existing
delegation budgets when the callback starts a child. Keep `Promise.all` fully
supported for custom application concurrency.

**Tests:** ordered results; bounded active count; cancellation while queued and
running; error policy; budget accounting; no session-busy release until all
started children settle; content-free events.

### Phase 2 — one-shot workflow child tasks

Introduce `ctx.childTasks.start(agentId, input, options)` alongside, not inside,
`ctx.agents`. The option shape is typed by the selected agent and deliberately
small: label, model alias, timeout, priority, optional output schema inherited
from the agent, and context/authority policy ids. The returned handle supports
`await result()`, `cancel()`, and `status()`.

Start with in-process one-shot tasks only. The task gets a distinct correlation
id and an isolated execution context; it never mutates the parent run after the
parent has terminalized. Add a per-workflow task limit and a scheduler that
enforces fair bounded concurrency.

**Tests:** start failure rolls back atomically; cancellation races; parent
failure reaps every child; all outcomes produce exactly one terminal event;
model/tool/session cleanup; no cross-tenant handle access.

### Phase 3 — durable task descriptors and restart recovery

Persist the child-task descriptor in the durable runtime before starting work:
parent run/workflow/session ids, agent id, idempotency key, non-content policy
identities, attempt, and terminal outcome reference. Bind start and awaiting a
result to `ctx.step()` so replay cannot duplicate external effects. Resume is
descriptor-driven, not a replay of an arbitrary child transcript.

**Tests:** crash before publish; crash after publish; retry/replay returns the
same task; lease transfer; cancellation during recovery; retention cleanup;
fixture replay of lifecycle events without model payloads.

### Phase 4 — optional continuable child sessions

Only after Phases 1–3 are stable, assess explicit `send`/`interrupt`/`list`
operations for durable child sessions. This requires direct-parent and ancestor
authority, inbox ordering, settlement-notice delivery, session retention, and
operator tooling. It is a new product capability, not a small extension of
`ctx.agents`; ship it as an optional addon or adapter boundary first.

## What we deliberately do not copy

- **Cordis/YAML/HMR plugin composition:** clashes with static module types,
  inspection provenance, and single-harness lifecycle ownership.
- **Model-authored workflow code in a Node `vm`:** upstream explicitly says it
  is not a security boundary. It weakens compile-time safety and creates a much
  larger governance and sandbox surface.
- **Raw parent-history fork as a convenience default:** it risks secret/context
  over-sharing and makes cost and replay behavior opaque. PURISTA should make
  projection a named, bounded workflow decision.
- **Provider-selected execution hidden from application code:** PURISTA's model
  aliases and workflow policies should remain visible and type-checked.

## User-facing result if Phases 1–3 land

- Teams can fan out review, research, enrichment, and validation tasks without
  hand-rolled concurrency plumbing.
- Long-running work gets a typed task handle with clear `start`, `await`,
  `cancel`, and observable terminal state.
- A workflow can remain durable without duplicated child effects after retry or
  restart.
- Operators get a lineage graph and budgets without prompts, tool payloads, or
  customer content entering diagnostics.
- Existing `ctx.agents` and inline workflows keep their small, familiar API.
