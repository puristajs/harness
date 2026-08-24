# Workflow Child Tasks

**Purpose.** Defines typed, workflow-owned child tasks, bounded fan-out, and
in-process continuables. The feature adds background lifecycles without turning
agents into autonomous orchestrators or introducing a model-authored workflow
language.

## Ownership and boundaries

- Only `WorkflowContext.childTasks` creates a task. Direct agents remain leaf
  model loops.
- A task uses a registered agent id and therefore inherits the workflow's
  existing delegation allowlist, model-alias policy, depth limit, total-call
  budget, and parallel-call budget.
- The child context is always `isolated`: it receives its direct typed input,
  its own sandbox session, run/agent memory scope, and the selected agent's
  existing tools/skills/permissions. It never receives raw parent history or a
  widened tool/model permission.
- A task owns a separate `RunRecord{kind:'child_task'}` and never appends its
  generated messages to the parent's session history.

## API

```ts
const task = await ctx.childTasks.start('reviewer', { documentId }, {
  model: 'deep_review',
  timeoutMs: 60_000,
  context: 'isolated'
})

const review = await task.result()
await task.cancel('no longer needed')
```

`start()` returns `ChildTaskHandle<O>` with typed `result()`, content-free
`status()`, and idempotent `cancel()`. Starting may return before the task
settles, so the workflow may safely return a persisted task id to application
code or await the result when the next step depends on it.

Pass `{ mode: 'continuable' }` to receive a typed
`ContinuableChildTaskHandle<I, O>`. Its isolated task-owned sandbox and private
conversation stay alive between sequential `send(input)` turns. `close()`
settles the task successfully with its final output; `result()` resolves only
after that close. A continuable task does not append either its inputs or its
outputs to the parent session history. `session.childTasks.get(id)` and
`session.childTasks.list()` provide session-owner lookup with content-free
status; terminal tasks remain readable through the configured HarnessStorage.

`ChildTaskDescriptor` persists only lifecycle identity: task/parent/session/
workflow/agent/model ids, context-policy name, and creation time. Inputs and
outputs follow ordinary run-record privacy behavior and are never copied into
diagnostic lifecycle events.

## Durable invocations

When a workflow invocation uses `opts.durable`, every **one-shot** child-task start MUST
supply `idempotencyKey`. The effective task id derives from the durable parent
run id and key. On a later retry, a terminal task with that id is returned as a
completed handle instead of publishing another agent task. A non-resident
running descriptor is surfaced as a recovery-required validation failure;
cross-process task resumption requires an explicit queue/worker adapter and is
not implied by the in-process harness runtime.

`mode: 'continuable'` is rejected for a durable workflow invocation: retaining
a live sandbox and turn queue across process restart requires that explicit
worker adapter and its inbox/lease protocol.

## Lifecycle and shutdown

- A child task emits content-free `child_task.started` and exactly one
  `child_task.settled` event in its own run event stream, in addition to its
  normal agent lifecycle events. The start event identifies its `mode`.
- Parent cancellation is relayed to every live task. A successful parent
  workflow does not cancel a task merely because its handler returned.
- `Session.close()` and `Harness.shutdown()` cancel and await their live child
  tasks before releasing resources.
- Cancellation, failure, and completion are terminal; a handle retains its
  final content-free status snapshot after resource cleanup.

## Fan-out

`ctx.fanOut(items, worker, {concurrency})` is the companion convenience API for
short-lived, awaited parallel work. It queues at the workflow's delegation
parallel ceiling, preserves input order, honors cancellation, and emits
content-free `fanout.started` / `fanout.finished` events. It is not a separate
workflow DSL: `Promise.all` remains valid for application-defined concurrency.

Background tasks reserve the workflow's total child-agent budget at creation,
but consume a parallel slot only while an agent turn executes. Tasks beyond the
parallel limit therefore queue instead of failing merely because another task
is active. Direct `ctx.agents.*` calls retain their immediate limit failure,
which makes accidental unbounded foreground fan-out visible to the handler.

## Non-goals

- No model-authored JavaScript/VM workflow execution.
- No dynamic plugin loading or raw parent-history fork.
- No child-to-parent messaging or durable cross-process worker recovery in
core. These need an explicit queue/worker adapter with tenant authority, inbox
ordering, leases, and retention contracts.
