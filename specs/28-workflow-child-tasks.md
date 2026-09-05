# Workflow Child Tasks

> **V4 dispatch precedence:** typed agent references, workflow allowlists,
> distributed dispatch, and nested interruption behavior are defined by
> [42-composable-definitions-and-catalogs](./42-composable-definitions-and-catalogs.md).
> Existing bounded fan-out and durable checkpoint rules remain normative.

**Purpose.** Defines typed, workflow-owned child tasks, bounded fan-out, and
in-process continuables. The feature adds background lifecycles without turning
agents into autonomous orchestrators or introducing a model-authored workflow
language.

## Ownership and boundaries

- Only `WorkflowContext.childTasks` creates a task. Direct agents remain leaf
  model loops.
- A task uses a key from the workflow's exact declared agent map and executes
  through the same `HarnessTargetDispatcher` as direct workflow agent calls.
  It inherits depth, total-call, and parallel-call budgets.
- The child context is always `isolated`: it receives its direct typed input,
  its own sandbox session, run/agent memory scope, and the selected agent's
  existing tools/skills/permissions. It never receives raw parent history or a
  widened tool/model permission.
- A task owns a separate `RunRecord{kind:'child_task'}` and never appends its
  generated messages to the parent's session history.

## API

```ts
const task = await ctx.childTasks.start('reviewer', { documentId }, {
  callId: 'reviewDocument',
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

Every start requires a stable `callId`. The exact one-shot options are
`{callId,idempotencyKey?,timeoutMs?,context?:'isolated',mode?:'one_shot'}`;
the exact continuable options are
`{callId,timeoutMs?,context?:'isolated',mode:'continuable'}`. A child task cannot
override the selected agent's model or sandbox policy. This preserves the
agent's compiled capability boundary.

The `callId` matches `/^[A-Za-z0-9_.:-]{1,128}$/`. Before budget reservation,
the workflow invocation compares the complete start tuple
`('child_task_start',agent,canonical JSON wire input,{mode,idempotencyKey|null,
timeoutMs|null,context:'isolated'})`. An equal active or terminal tuple returns
the same handle and consumes no second budget reservation, whether that terminal
succeeded, failed, or was cancelled. Reusing the id with a changed operation,
agent, input, normalized option, or idempotency key throws
`WorkflowCallReplayConflictError` before creating a record or event. When more
than one field differs, reason precedence is operation, target, input,
idempotency key, then remaining normalized options.

`idempotencyKey` uses the same grammar. Invalid call id/key, missing durable
key, durable continuable mode, invalid timeout, invalid context, and an
approval-capable selected agent use the exact content-free `ValidationError`
issues in spec 15. When present, `timeoutMs` is a positive safe integer;
`context` is absent or exactly `isolated`. A child task is approval-capable when the canonical recursive
requirements helper finds a permissions/governance approval path on the agent
or a reachable subagent. Such a start is prohibited before any effect. Human
approval remains available through awaited `ctx.agents.*.run(...)` and the root
interruption protocol; child tasks never convert an approval into failure or a
second task-specific resume API.

Pass `{ mode: 'continuable' }` to receive a typed
`ContinuableChildTaskHandle<I, O>`. Its isolated task-owned sandbox and private
conversation stay alive between sequential `send(input)` turns. `close()`
settles the task successfully with its final output; `result()` resolves only
after that close. A continuable task does not append either its inputs or its
outputs to the parent session history. `session.childTasks.get(id)` and
`session.childTasks.list()` provide session-owner lookup with content-free
status; terminal tasks remain readable through the configured HarnessStorage.
H4-007 owns task execution, handles, and task records. H4-008 owns binding this
session facade and coordinating instance/session shutdown with those records.

`session.childTasks.get(id)` validates the candidate `child_task` `RunRecord`
and returns `undefined` when it is absent or belongs to another session. A
resident task returns its existing frozen live handle. A terminal record returns
the frozen reconstructed terminal handle defined below. A valid non-resident
running record returns a frozen recovery handle: `status()` returns the frozen
content-free running `ChildTaskStatus`, while `result()` and `cancel()` each
reject a locally constructed `ChildTaskStateError` with exact metadata
`{reason:'recovery_required',task_id:record.id,workflow_id:metadata.workflowId,
agent_id:record.target}`. Those rejections have no transported cause or stored
message. Constructing or calling the recovery handle performs no task admission,
dispatch, cancellation, event emission, or record mutation.

The initial input is the first serialized turn. Each accepted `send(input)` is
appended to one FIFO promise chain, reserves one workflow agent call, waits in
the shared task-turn capacity queue, and resolves with that turn's typed output.
Only one turn executes at a time. `result()` remains pending until `close()` or
a terminal failure/cancellation. The first `close()` atomically marks the task
closing, rejects later sends, waits for accepted sends, commits success with the
last output, and resolves all concurrent `close()` calls with the same promise.
If a turn fails, that failure becomes terminal; queued turns that did not start
reject with the same error and no model call. `cancel()` is idempotent, may
overtake `close()` until success is committed, aborts a running turn and all
queued turns, and waits for the one cancelled terminal transition. Once success
is committed, later cancellation is a no-op. Sends after closing/terminal throw
`ChildTaskStateError` with reason `closing`/`terminal` respectively.

For a newly accepted task, `createdAt` is captured once immediately before its
RunRecord is created. A present `timeoutMs` establishes one deadline at
`createdAt + timeoutMs`. The clock includes initial capacity queue time, active
execution, every continuable send queue and turn, and continuable idle time
until `close`; replay never restarts or extends it. Expiry removes queued turns,
aborts an active turn, closes task-owned resources, commits `failed`, and makes
all pending handle operations reject `OperationTimeoutError` with fixed message
`Child task timed out.` and metadata `{scope:'child_task',timeout_ms}`. Explicit
or parent cancellation commits `cancelled` and rejects `result()`, active or
queued `send()`, and a racing uncommitted `close()` with
`OperationCancelledError`, fixed message `Child task was cancelled.`, and
metadata `{scope:'child_task'}`. Terminal transitions are serialized by one
task-local lifecycle mutex: the first committed success, failure, timeout, or
cancellation wins; later timer/cancel callbacks are no-ops. This rule is
identical for one-shot and continuable tasks. Cancellation before start
admission creates no task or budget entry. After task acceptance, terminal
record/event persistence and cleanup use the task lifecycle signal rather than
the already-aborted caller signal, and finish before the terminal handle
operation settles.

`ChildTaskDescriptor` persists only lifecycle identity: task/parent/session/
workflow/workflow-invocation/call/agent/model ids, context-policy name, mode,
and creation time. Inputs and
outputs follow ordinary run-record privacy behavior and are never copied into
diagnostic lifecycle events.

The persisted projection is exact:

```ts
interface ChildTaskRecordMetadataV1 {
  readonly schemaVersion: 1
  readonly kind: 'workflow_child_task'
  readonly parentRunId: string
  readonly workflowId: string
  readonly workflowInvocationId: string
  readonly callId: string
  readonly agentId: string
  readonly modelAlias: string
  readonly mode: 'one_shot' | 'continuable'
  readonly context: 'isolated'
  readonly timeoutMs: number | null
  readonly idempotencyKey: string | null
  readonly createdAt: string
}

type ChildTaskStoredErrorV1 =
  | Readonly<{
      code: 'WORKFLOW_CHILD_TARGET_FAILED'
      message: 'Workflow child target failed.'
      category: 'internal'
      retriable: false
      meta: Readonly<{
        reason: 'child_task_failed'
        workflow_id: string
        call_id: string
        task_id: string
        target_kind: 'agent'
        target_id: string
      }>
    }>
  | Readonly<{
      code: 'OPERATION_TIMEOUT'
      message: 'Child task timed out.'
      category: 'timeout'
      retriable: true
      meta: Readonly<{ scope: 'child_task'; timeout_ms: number }>
    }>
  | Readonly<{
      code: 'OPERATION_CANCELLED'
      message: 'Child task was cancelled.'
      category: 'cancelled'
      retriable: false
      meta: Readonly<{ scope: 'child_task' }>
    }>
```

Its running `RunRecord` has `id:taskId`, the owning `sessionId`,
`kind:'child_task'`, `target:agentId`, `startedAt:createdAt`, status `running`,
the initial JSON wire input, no output/error/finishedAt, and `metadata` equal to
this record. A succeeded terminal has status `succeeded`, the exact validated
JSON output and `finishedAt`, with no error. A failed terminal has status
`failed`, `finishedAt`, no output, and exactly the target-failure or timeout
member of `ChildTaskStoredErrorV1`. A cancelled terminal has status `cancelled`,
`finishedAt`, no output, and exactly its cancellation member. A validated
target `failed` terminal is wrapped as `WorkflowChildTargetError` reason
`child_task_failed`; transported remote class/category/retriability remains an
untrusted private cause and is never persisted. A failed envelope that claims a
timeout remains this target wrapper; only expiry of the task-owned clock creates
the local `OperationTimeoutError`. Loading
is strict: exact keys, scalar grammars, matching id/session/target/time and
compiled model alias, JSON
input, and status-appropriate terminal fields are required. Malformation throws
`ChildTaskStateError{reason:'invalid_record',task_id}` without exposing stored
content. The public descriptor is reconstructed exactly from the RunRecord's
`id`, `sessionId`, `target`, and `startedAt` plus the validated metadata's
parent/workflow/workflow-invocation/call/model/mode/context fields; no second
persisted descriptor is stored.

## Durable invocations

When a workflow invocation uses `opts.durable`, every **one-shot** child-task start MUST
supply `idempotencyKey`. The effective task id derives from the durable parent
run id and key as
`task_` plus lowercase SHA-256 of the canonical JSON tuple
`['harness.child-task-id.v1',parentRunId,idempotencyKey]`. On a later retry, a
terminal task with that id is returned as a terminal handle instead of
publishing another agent task. A non-resident
running descriptor throws
`ChildTaskStateError{reason:'recovery_required'}`;
cross-process task resumption requires an explicit queue/worker adapter and is
not implied by the in-process harness runtime.

The existing record must match the complete call-id start tuple and the exact
stable normalized start tuple `(callId,agentId,canonical JSON wire input,mode,
timeoutMs|null,context:'isolated')`. Stored `createdAt` is authoritative and is
never compared with the retry's wall clock or replaced. Parent/workflow/session
identity is validated as record integrity; model alias is validated against the
compiled graph. The same derived task id with changed call id, agent, input,
mode, timeout, or context throws the content-free
`ChildTaskConflictError{reason:'idempotency_key_reused'}`. A matching resident
running task returns the same live handle; a matching terminal record returns a
terminal handle; neither reserves budget or emits lifecycle events again.
`ChildTaskConflictError.agent_id` and `.call_id` are the received attempted
values.

`result()` on a live or reconstructed terminal handle has identical behavior:
success returns the validated stored output; target failure rejects a locally
constructed `WorkflowChildTargetError`; timeout rejects a locally constructed
`OperationTimeoutError`; and cancellation rejects a locally constructed
`OperationCancelledError`. Reconstruction first validates the exact stored
member above and never trusts a transported or arbitrary stored error class.
`status().error` is absent for success and is exactly the matching stored error
member for failure, timeout, or cancellation; it contains no private cause.

`mode: 'continuable'` is rejected for a durable workflow invocation: retaining
a live sandbox and turn queue across process restart requires that explicit
worker adapter and its inbox/lease protocol.

## Lifecycle and shutdown

- A child task emits content-free `child_task.started` and exactly one
  `child_task.settled` event in its own run event stream, in addition to its
  normal agent lifecycle events. The start event identifies its `mode`.
- Parent cancellation is relayed to every live task. A successful parent
  workflow does not cancel a task merely because its handler returned.
- `Session.destroy()` and `HarnessInstance.close()` cancel and await their live child
  tasks before releasing resources.
- Cancellation, failure, and completion are terminal; a handle retains its
  final content-free status snapshot after resource cleanup.
- Because approval-capable agents are rejected before task creation,
  `interrupted` is not a child-task status and no child-task approval event or
  checkpoint exists. Direct awaited workflow agent calls retain ordinary
  nested interruption and resume.

## Workflow agent-call budgets

Workflow budgets are independent of each called agent's local
`maxSubagentCalls` and `maxParallelSubagents`. Effective values resolve from
workflow `agentCalls.maxCalls` / `agentCalls.maxParallel`, Harness defaults
`maxWorkflowAgentCalls` / `maxParallelWorkflowAgentCalls`, then `32` / `8`.
They are positive safe integers and apply to one logical workflow invocation.
The state resets for a later independent invocation and is restored rather than
reset on durable/interruption re-entry.

Direct agent calls, one-shot initial turns, continuable initial turns, and every
accepted `send` each reserve one total call. Replay/coalescing does not. Options
and tuple validation happen first, then total reservation, then parallel
admission. Direct calls fail immediately at a full parallel ceiling or behind
an existing FIFO task waiter and roll back their tentative total reservation.
Task turns keep their total reservation and wait cancellation-aware FIFO for an
active slot; cancellation before execution removes the waiter but does not
refund the accepted total call. Total/parallel failures use
`WorkflowAgentCallBudgetError` with reason `max_calls` / `max_parallel`.

## Fan-out

`ctx.fanOut(items, worker, {concurrency})` is the companion convenience API for
short-lived, awaited parallel work. `fanOut` never reserves a total call or
acquires a workflow agent-call slot itself. It only clamps worker concurrency
to the effective parallel ceiling, preserves input order, honors cancellation,
and emits content-free `fanout.started` / `fanout.finished` events. Each direct
agent call or child-task turn made by a worker performs its own ordinary
admission. A worker that performs no agent call consumes no agent budget. This
distinction requires a regression test. `fanOut` is not a separate workflow
DSL: `Promise.all` remains valid for application-defined concurrency.

Background tasks reserve the workflow's total agent-call budget for their
initial turn at creation, while later continuable sends reserve at acceptance.
They consume a parallel slot only while an agent turn executes. Tasks beyond the
parallel limit therefore queue instead of failing merely because another task
is active. Direct `ctx.agents.*` calls retain their immediate limit failure,
which makes accidental unbounded foreground fan-out visible to the handler.

## Non-goals

- No model-authored JavaScript/VM workflow execution.
- No dynamic plugin loading or raw parent-history fork.
- No child-to-parent messaging or durable cross-process worker recovery in
core. These need an explicit queue/worker adapter with tenant authority, inbox
ordering, leases, and retention contracts.
