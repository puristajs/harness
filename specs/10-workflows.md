# Workflows

**Purpose.** Defines the inline `WorkflowDefinition` shape used in `defineHarness().workflows({...})`, the `WorkflowContext`, parallel agent invocation rules, and cancellation semantics. There is no standalone `defineWorkflow` factory; only inline-in-builder objects achieve cross-key type constraints (the workflow handler's `ctx.agents` typed by the registered agent keys).

## `WorkflowDefinition` (inline in builder)

```ts
import type { z } from 'zod'

interface WorkflowDefinition<
  S,
  I extends z.ZodTypeAny = z.ZodTypeAny,
  O extends z.ZodTypeAny = z.ZodTypeAny,
> {
  input?: I                              // default: z.string()
  output?: O                             // default: z.string()
  delegation?: WorkflowDelegationPolicy<S>
  handler: (ctx: WorkflowContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>   // REQUIRED
}

interface WorkflowDelegationPolicy<S> {
  enabled?: boolean
  agents?: readonly (keyof S['agents'] & string)[]
  maxChildAgentCalls?: number
  maxParallelChildAgentCalls?: number
  maxDepth?: number
  modelAliases?: readonly (keyof S['models'] & string)[]
  agentModelAliases?: Partial<Record<keyof S['agents'] & string, readonly (keyof S['models'] & string)[]>>
}
```

A workflow MUST provide `handler`. There is no default workflow loop.

## `WorkflowContext`

```ts
interface WorkflowContext<S, I, O> {
  input: I
  agents: { [K in keyof S['agents']]: (input: AgentInput<S, K>, opts?: InvokeOptions & { model?: keyof S['models'] & string }) => Promise<AgentOutput<S, K>> }
  log: Logger
  signal: AbortSignal
  runId: string
  sessionId: string
  metadata: Readonly<Record<string, JsonValue>>
  memory: MemoryFacade
  metrics: Metrics
  /** Runs `fn` as a durable step. See "Durable steps". */
  step<T extends JsonValue>(stepId: string, fn: () => Promise<T>): Promise<T>
  /** Bounded, cancellation-aware parallel work preserving input order. */
  fanOut<T, R>(items: readonly T[], worker: (item: T, index: number) => Promise<R>, options?: { concurrency?: number }): Promise<R[]>
  /** Workflow-owned isolated background and continuable child tasks. */
  childTasks: WorkflowChildTasks<S>
}
```

`AgentInput<S, K>` and `AgentOutput<S, K>` are derived from the agent's `input`/`output` Zod schemas (or default to `string` when omitted), mirroring the `WorkflowInput`/`WorkflowOutput` derivation in [13-public-api](./13-public-api.md).

- All registered agents are typed on `agents`. `WorkflowDefinition.delegation`
  can restrict which agents a workflow may call at runtime.
- Embedders that wrap a workflow definition outside a direct
  `defineHarness().agents(...).workflows(...)` chain MUST register the intended
  harness-local agent definitions before registering the workflow. Otherwise
  `ctx.agents` is empty or missing the referenced agent keys at runtime.
- `ctx.memory` exposes run/session/user/tenant memory scopes as defined in [20-memory-adapters](./20-memory-adapters.md). Workflow contexts do not expose `ctx.memory.agent` because no single agent id owns the workflow run.
- Each `agents[id](input)` call:
  - Validates `input` against the agent's `input` schema. Failure → [`ValidationError`](./15-error-catalog.md){where:'agent_input'}.
  - Opens a child `invoke_agent {agent.name}` span (linked to the workflow's `harness.workflow.run` span).
  - Executes the agent (default loop or custom handler).
  - Validates the agent's output. Failure → [`ValidationError`](./15-error-catalog.md){where:'agent_output'}.
  - Returns the validated output.
  - Errors are thrown directly (not wrapped) to allow the workflow to handle them.

`ctx.fanOut` is a small bounded-concurrency primitive, not a second workflow
language. Its effective concurrency is clamped to
`maxParallelChildAgentCalls`, it preserves item order, and it emits
content-free fan-out lifecycle events. `ctx.childTasks.start` starts a separate
child-task run using a registered agent. Background task turns queue under the
same delegation parallel ceiling rather than rejecting solely because the
ceiling is occupied. `{ mode: 'continuable' }` retains an isolated task-owned
sandbox and private turn history until `close()`; it is in-process only and is
rejected from durable workflow invocation. See
[28-workflow-child-tasks](./28-workflow-child-tasks.md).

## Delegation policy

Workflows may orchestrate child agents through `ctx.agents`; agents do not spawn
other agents directly. Child-agent delegation is disabled unless either:

- the workflow declares `delegation`; or
- `defaults.delegation.enabled` is set to `true`.

A workflow-level `delegation` object enables that workflow unless it sets
`enabled: false`. Once enabled, the harness applies these safe defaults per
workflow run:

- `maxChildAgentCalls: 32`
- `maxParallelChildAgentCalls: 8`
- `maxDepth: 1`

`WorkflowDefinition.delegation` can override the numeric budgets, disable the
workflow with `enabled: false`, restrict the child agent ids with `agents`, and
restrict the model aliases child-agent calls may run with. `modelAliases`
applies to **every** child-agent call in the workflow — both calls that use the
agent's default `model` and calls passing a per-call `{ model }` override. A
workflow with `modelAliases: ['cheap']` cannot invoke an agent whose selected
alias (default or override) is not in that list; the call throws
`DelegationPolicyError{reason:'model_alias_not_allowed'}`. `agentModelAliases`
replaces that set for the named child agent.

```ts
delegation: {
  agents: ['planner', 'reviewer'],
  maxChildAgentCalls: 4,
  maxParallelChildAgentCalls: 2,
  agentModelAliases: { reviewer: ['deep_review'] }
}
```

`ctx.agents.reviewer(input, { model: 'deep_review' })` runs the reviewer agent
with that configured model alias for this call only; the agent definition's
default `model` remains unchanged.

Builder validation rejects unknown agent ids, unknown model aliases, and invalid
numeric budgets. Runtime violations throw
[`DelegationPolicyError`](./15-error-catalog.md).

Task-specific idempotency, recovery, and session-owner lookup rules are
defined in [28-workflow-child-tasks](./28-workflow-child-tasks.md).

The workflow's own input is validated by `workflow.input.parse(value)` at run start; output is validated by `workflow.output.parse(value)` after the handler returns. Failures throw [`ValidationError`](./15-error-catalog.md){where:'workflow_input'|'workflow_output'}.

## Durable steps

`ctx.step(stepId, fn, options?)` marks a JSON-serializable boundary in a workflow handler.
Its behavior depends purely on how the workflow is invoked:

- **Durable invocation** (`opts.durable` supplied and a `.storage(...)` adapter is
  configured — see [21-durable-workspaces](./21-durable-workspaces.md) §16.1): a
  step committed on a prior attempt returns its stored output **without re-running
  `fn`** or re-committing a checkpoint. A new step runs `fn`, validates that the
  output is JSON-serializable (`DurableStepError` otherwise), commits a runtime
  checkpoint, and — when a workspace is configured — links a durable
  workspace checkpoint committed before the storage checkpoint.
- **Ephemeral invocation** (no `opts.durable`, or no configured runtime):
  `ctx.step(stepId, fn)` is a transparent pass-through — it simply awaits `fn` and
  returns its value with no checkpointing.

Locked rules:

- `stepId` matches `/^[A-Za-z0-9_.:-]{1,128}$/`; an invalid id throws
  `DurableStepError`.
- A duplicate `stepId` within one run throws `DurableStepError`.
- `options.retry` retries `fn` before any checkpoint is committed. `true`
  means three total attempts with exponential backoff. A policy object can set
  `maxAttempts`, `minDelayMs`, `maxDelayMs`, `backoff`, and `shouldRetry`.
  Committed replayed steps never re-run retry logic.
- The same workflow body therefore runs durably or ephemerally with no code
  change; durability is an invocation-time decision, not a handler concern.

## Long-running workflow versions

The harness does not own deployment pinning, HTTP workers, or queues. Long-lived
applications should treat explicit step outputs and workflow return values as
versioned migration boundaries:

- include an application `workflowVersion` in invoke metadata or workflow input
  when a run may outlive one deployment;
- keep each durable step output schema backward-compatible, or migrate it in the
  next step before handing it to an agent;
- prefer chaining a new durable run with a new `runId` when a workflow needs to
  self-upgrade after a major code change;
- store the old run id in the new run metadata so UI and audit views can link
  the logical process across runs.

This is an application pattern, not a core scheduler feature. Core guarantees
only stable durable checkpoints, state-store run/event history, cancellation,
and typed workflow boundaries.

## Parallel invocation

Workflows may call agents in parallel via standard `Promise.all`/`Promise.allSettled`. Locked rules:

1. The same `signal` is propagated to every parallel agent call. Aborting the workflow aborts all in-flight agent calls.
2. Persisted message ordering follows completion time, not invocation time. Each agent call appends its messages atomically (per the HarnessStorage guarantee), but interleaving is permitted.
3. The session's serial-execution rule (see [11-sessions](./11-sessions.md)) applies at the session boundary, not within a workflow run. Within a single workflow run, parallel agent calls share the run id and are allowed.

## Cancellation

- The workflow's `signal` is wired to:
  - The run's `runTimeoutMs` — when elapsed, abort the controller and throw `OperationTimeoutError`. `runTimeoutMs === 0` disables the run timeout; negative values are rejected at config parse time. `InvokeOptions.timeoutMs` overrides the default for a single call (same `>0/0/<0` semantics; negative throws `ValidationError`).
  - External cancellation passed to `session.workflows[id].prompt(input, {signal})`.
- Aborts propagate down to every active agent, model, tool, skill, and memory adapter call. Each layer translates abort into `OperationCancelledError`.
- The harness races the workflow handler against the workflow signal. A
  non-cooperative handler cannot block timeout/cancel finalization, but any
  in-process work it started may keep running until that application code
  observes `ctx.signal` or returns.
- After `signal.aborted`, the workflow handler MUST NOT start new agent calls; doing so throws `OperationCancelledError` synchronously.

## Errors

- Errors from agent, model, and tool calls bubble up unchanged unless caught.
- A handler error is preserved by identity (it is not re-wrapped), so failure
  terminalization never masks the original failure. When the error is not a
  `HarnessError`, it is persisted with code `INTERNAL_ERROR` via `serializeError`,
  but the original error instance is what the caller receives.
- `WorkflowNotFoundError` is thrown by the session API when a workflow id doesn't exist; never thrown from inside a handler.

## Telemetry

- Span `harness.workflow.run`, attributes `harness.workflow.id`, `harness.session.id`, `harness.run.id`.
- Histogram `harness.run.duration` (unit `s`, recorded on workflow finish) with attributes `harness.workflow.id`, `harness.session.id`, `error.type` (when error).
- RunEvents emitted: `run.started`, `agent.started`/`agent.finished` per child agent, `run.finished`.
  Child-agent lifecycle events include `workflowId`, `delegationCallId`,
  `delegationDepth`, and `modelAlias`.

## Cross-references

- [09-agents](./09-agents.md) — agent execution.
- [11-sessions](./11-sessions.md) — session-level concurrency rule.
- [12-streaming](./12-streaming.md) — `RunEvent` shapes.
- [14-otel-conventions](./14-otel-conventions.md), [15-error-catalog](./15-error-catalog.md).
- [20-memory-adapters](./20-memory-adapters.md) — workflow memory facade.
