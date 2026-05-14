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
  handler: (ctx: WorkflowContext<S, z.infer<I>, z.infer<O>>) => Promise<z.infer<O>>   // REQUIRED
}
```

A workflow MUST provide `handler`. There is no default workflow loop.

## `WorkflowContext`

```ts
interface WorkflowContext<S, I, O> {
  input: I
  agents: { [K in keyof S['agents']]: (input: AgentInput<S, K>, opts?: InvokeOptions) => Promise<AgentOutput<S, K>> }
  log: Logger
  signal: AbortSignal
  runId: string
  sessionId: string
  metadata: Readonly<Record<string, JsonValue>>
  memory: MemoryFacade
  metrics: Metrics
}
```

`AgentInput<S, K>` and `AgentOutput<S, K>` are derived from the agent's `input`/`output` Zod schemas (or default to `string` when omitted), mirroring the `WorkflowInput`/`WorkflowOutput` derivation in [13-public-api](./13-public-api.md).

- All registered agents are reachable from `agents`. Workflows are not scoped to a subset.
- `ctx.memory` exposes run/session/user/tenant memory scopes as defined in [20-memory-adapters](./20-memory-adapters.md). Workflow contexts do not expose `ctx.memory.agent` because no single agent id owns the workflow run.
- Each `agents[id](input)` call:
  - Validates `input` against the agent's `input` schema. Failure → [`ValidationError`](./15-error-catalog.md){where:'agent_input'}.
  - Opens a child `invoke_agent {agent.name}` span (linked to the workflow's `harness.workflow.run` span).
  - Executes the agent (default loop or custom handler).
  - Validates the agent's output. Failure → [`ValidationError`](./15-error-catalog.md){where:'agent_output'}.
  - Returns the validated output.
  - Errors are thrown directly (not wrapped) to allow the workflow to handle them.

The workflow's own input is validated by `workflow.input.parse(value)` at run start; output is validated by `workflow.output.parse(value)` after the handler returns. Failures throw [`ValidationError`](./15-error-catalog.md){where:'workflow_input'|'workflow_output'}.

## Parallel invocation

Workflows may call agents in parallel via standard `Promise.all`/`Promise.allSettled`. Locked rules:

1. The same `signal` is propagated to every parallel agent call. Aborting the workflow aborts all in-flight agent calls.
2. Persisted message ordering follows completion time, not invocation time. Each agent call appends its messages atomically (per the StateStore guarantee), but interleaving is permitted.
3. The session's serial-execution rule (see [11-sessions](./11-sessions.md)) applies at the session boundary, not within a workflow run. Within a single workflow run, parallel agent calls share the run id and are allowed.

## Cancellation

- The workflow's `signal` is wired to:
  - The run's `runTimeoutMs` — when elapsed, abort the controller and throw `OperationTimeoutError`. `runTimeoutMs === 0` disables the run timeout; negative values are rejected at config parse time. `InvokeOptions.timeoutMs` overrides the default for a single call (same `>0/0/<0` semantics; negative throws `ValidationError`).
  - External cancellation passed to `session.workflows[id].prompt(input, {signal})`.
- Aborts propagate down to every active agent, model, tool, skill, and memory adapter call. Each layer translates abort into `OperationCancelledError`.
- After `signal.aborted`, the workflow handler MUST NOT start new agent calls; doing so throws `OperationCancelledError` synchronously.

## Errors

- Errors from agent calls bubble up unchanged unless caught.
- If the workflow handler itself throws a non-`HarnessError`, the harness wraps it in `InternalError` with `cause`.
- `WorkflowNotFoundError` is thrown by the session API when a workflow id doesn't exist; never thrown from inside a handler.

## Telemetry

- Span `harness.workflow.run`, attributes `harness.workflow.id`, `harness.session.id`, `harness.run.id`.
- Histogram `harness.run.duration` (unit `s`, recorded on workflow finish) with attributes `harness.workflow.id`, `harness.session.id`, `error.type` (when error).
- RunEvents emitted: `run.started`, `agent.started`/`agent.finished` per child agent, `run.finished`.

## Cross-references

- [09-agents](./09-agents.md) — agent execution.
- [11-sessions](./11-sessions.md) — session-level concurrency rule.
- [12-streaming](./12-streaming.md) — `RunEvent` shapes.
- [14-otel-conventions](./14-otel-conventions.md), [15-error-catalog](./15-error-catalog.md).
- [20-memory-adapters](./20-memory-adapters.md) — workflow memory facade.
