# Sessions

**Purpose.** Defines the `Session` API, persistence semantics, the serial-execution concurrency rule, message shape (referenced from [04](./04-state-queue-stream.md)), and session memory facade semantics. The pluggable memory adapter contract lives in [20-memory-adapters](./20-memory-adapters.md).

## API

For Harness v4, the exact public `HarnessInstance<Contracts>`,
`HarnessSession<Contracts>`, definition-keyed `HarnessTargetInvoker<Target>`,
`InvokeOptions`, and `DurableInvokeOptions` shapes are owned by
[spec 42 section 9](./42-composable-definitions-and-catalogs.md#9-harness-definition-and-runtime).
This specification retains the session persistence, serial execution, history,
memory, release, and destroy semantics below. It does not define a second API
shape. The v4 instance closes through `HarnessInstance.close()`; the removed
`Harness.shutdown()` spelling is not retained as an alias.

`Session` is a JS object with:

- A fixed `id` property.
- An `agents` map: one exact `HarnessTargetInvoker` per declared agent id.
- A `workflows` map: one exact `HarnessTargetInvoker` per declared workflow id.
- A `childTasks` owner-only map. `get(id)` returns a frozen live task handle, a
  frozen terminal persisted handle, or a frozen recovery handle only when its
  strictly validated `RunRecord` belongs to this session; `list()` returns
  content-free child-task snapshots. For a non-resident running task, the
  recovery handle's `status()` returns its validated frozen content-free
  running snapshot. Its `result()` and `cancel()` each reject a locally
  constructed `ChildTaskStateError` with exact metadata
  `{reason:'recovery_required',task_id,workflow_id,agent_id}`. The handle never
  adopts, awaits, cancels, or otherwise controls that task without a task-worker
  adapter.
- `memory` and `history` handles for direct out-of-run access.
- A `getRunSummary(runId)` method.
- A destructive `destroy()` method and a persistence-preserving `release()` method.

There is no dynamic `session.<workflowId>` property lookup and no `session.agent(...)` method. Direct one-agent execution is available through `session.agents.<agentId>.run(...)` and `.stream(...)`. Multi-agent execution is reachable only through workflows.

Application-facing execution is session-centric. The harness owns registries, adapters, and factories, but application code performs work through `harness.getSession(id)` followed by `session.agents.<agentId>.run(...)` / `.stream(...)` for direct agent work or `session.workflows.<workflowId>.run(...)` / `.stream(...)` for orchestration.

## Lifecycle

- `harness.getSession(id)`:
  1. Looks up `storage.getSession(id)`.
  2. If absent, proposes a new opaque `instanceId` with `storage.upsertSession({id, instanceId, createdAt: now, updatedAt: now, runCount: 0}, 'create')`; only its atomic insertion winner may create the sandbox.
  3. Reads the stored winning record, validates exact optional identity, and returns a `Session` facade bound to that record instance.
- `Session.destroy()` terminates that instance's sandbox before calling
  `storage.closeSession(id, instanceId)`. A stale close never deletes a newer
  instance. Recreating a closed caller-facing id generates a fresh opaque
  instance id even when the clock has not advanced.
- Run summary persistence always calls `upsertSession(record, 'update')`; a
  late writer cannot resurrect a closed session or modify another instance.
- `Session` instances are not cached by the harness — each call returns a fresh facade. They are cheap to construct.

## Per-call lifecycle (locked order)

For every `session.agents[id].run(input, opts?)`, `session.agents[id].stream(input, opts?)`, `session.workflows[id].run(input, opts?)`, and `session.workflows[id].stream(input, opts?)`:

1. **Synchronous pre-checks.** Assert `opts.signal` is not aborted (if aborted, reject in a microtask with `OperationCancelledError{scope:'run'}`). Assert no other run is in-flight on this session (else throw `SessionBusyError` synchronously).
2. **Acquire session lock.**
3. **Canonicalize input.** Validate that the supplied value is JSON and retain
   its canonical pre-transform wire value. On an initial invocation, run the
   selected agent/workflow input schema exactly once and retain the transformed
   result; failure is
   `ValidationError{where:'agent_input'|'workflow_input'}`. On approval resume,
   do not invoke that schema.
4. **Establish the root run.** A new logical invocation calls the strict
   `storage.createRun({id,sessionId,kind,target,startedAt,input:
   canonicalWireInput,metadata})`; storage authors `status:'running'` and
   `revision:1` and returns the authoritative frozen record. For a stable
   caller-owned durable run id, Harness first reads an existing record. When
   present it uses the stored immutable `startedAt` in the create request while
   supplying the current invocation's session, kind, target, canonical input,
   and exact metadata, so a different input or other identity field conflicts
   before acquisition. Concurrent absent observations may propose different
   start times: after `run_conflict`, a caller may reread and retry with the
   winner's `startedAt` only after it has independently verified equality of
   every other creation-identity member. It never adopts stored input or
   metadata to turn a mismatch into a retry. An
   approval resume first reads its existing `RunRecord` and root checkpoint,
   compares the supplied canonical wire input with the authoritative
   `RunRecord.input`, and restores the previously transformed input from the
   strict continuation checkpoint. An input mismatch is
   `ApprovalResumeError{reason:'input_mismatch'}`. It then completes every
   side-effect-free validation and submits spec 32's exact resume
   `AcquireRunRequest` with the observed record revision/status and checkpoint
   step/sequence. The returned lease record/checkpoint snapshot is the atomic
   post-CAS reread and must byte-match the optimistic identity/checkpoint before
   execution; no second record is created. A terminal receipt replay does not acquire.
   Post-acquire validation failure releases the lease under spec 42. If
   establishment fails, Harness opens no span, emits no new event, and
   propagates the specified canonical or aggregate error.
5. **Extract trace context** from `opts.traceparent`/`opts.tracestate` if present. Invalid context is ignored with warning log code `INVALID_TRACE_CONTEXT`.
6. **Open `harness.session.run` span** (outermost) with attributes `harness.session.id`, `harness.run.id`, and `harness.workflow.id` for workflow runs.
7. **Emit or replay `run.started`.** An initial logical run emits its
   sequence-one event to the in-process queue and persists it through
   `storage.appendEvents`. A resume retains the stored sequence and does not
   append, broadcast, or allocate a second start. A resume through
   `stream(...)` yields the persisted original start as its first iterator item
   under spec 12 before yielding newly produced events.
8. **Open child span**: `invoke_agent {agent.name}` for direct agent runs or `harness.workflow.run` for workflow runs.
9. **On completion:** receive the target's already validated output without a
   second parse; emit one completed `run.finished` and finalize the run as
   `succeeded`.
10. **On interruption:** persist the fenced root continuation, emit one
    interrupted `run.finished`, release the attempt, and resolve with that
    `RunOutcome`. A later correlated call resumes the same root run.
11. **On error:** classify the error; emit one failed or cancelled
    `run.finished`; terminalize as `cancelled` for `OperationCancelledError`
    and `failed` otherwise, including `OperationTimeoutError`.
12. **Close spans, release lock.** Failed/cancelled spans carry safe
    `harness.error.*` attributes. Timeout/cancel errors include
    `harness.error.scope` and, for timeouts, `harness.error.timeout_ms`.
13. **Resolve `run` with the completed/interrupted `RunOutcome`, or reject with
    the canonical error.** For `stream`, the iterator yields events as emitted
    and finishes after `run.finished`.

The outermost span is always `harness.session.run`; the child is `invoke_agent {agent.name}` for direct agent runs or `harness.workflow.run` for workflow runs.

### Lease-backed runs

An agent or workflow declared `durable:true` is always lease-backed. A
non-durable root whose compiled path may request tool approval uses the same
lease-backed lifecycle for approval recovery. The exact selection, generated
defaults, and approval timing are owned by spec 42 section 10. The locked order
above is extended as follows (see
[21-durable-workspaces](./21-durable-workspaces.md) §16.1):

- The run id is `opts.durable.runId` when supplied and otherwise a Harness
  generated `run_<ulid>`, so the `RunRecord`,
  persisted events, run summary, durable storage lease, and any durable workspace
  share one stable id.
- After the busy check and before the handler runs, the harness acquires a durable
  runtime lease and (when a workspace is configured) starts or resumes the
  durable workspace. `ctx.step(...)` becomes durable for the call.
- On terminal, the harness uses the lease-fenced
  `storage.finalizeRun(..., checkpointDisposition:'delete-all')`; it does not
  also call `finishRun`. Successful finalization commits the terminal record,
  deletes every run checkpoint, and releases the lease atomically. A
  finalization failure is never reported as a successful invocation.
- Supplying `opts.durable` to either agent or workflow requires that target to
  declare `durable:true`. Any compiled durable or approval-recovery path
  requires executable Harness storage at instance creation.

## Concurrency rule (locked)

Sessions are **serial-only**. Per session, only one run executes at a time. Implementation:

- The harness maintains an in-process per-session async lock keyed by `sessionId`.
- Each `run`/`stream` call acquires the lock at start.
- Sessions execute one run/stream at a time. Overlap throws `SessionBusyError` synchronously (`category:'session'`, `retriable:true`).
- There is no `concurrent: true` opt-out.

The facade lock is in-process. A durable invocation additionally uses the
HarnessStorage run lease and fencing contract, so another process cannot own
the same logical durable run concurrently. Independent non-durable invocations
with the same session id have no cross-process serialization guarantee.

## Persistence semantics

For every run:

1. A root run is created via the strict
   `storage.createRun({id,sessionId,kind:'agent'|'workflow',target:
   agentIdOrWorkflowId,startedAt,input,metadata})`; `input` is required canonical
   pre-transform JSON. Storage returns the authoritative frozen record with
   storage-authored `status:'running'` and `revision:1`. Exact retries follow
   spec 32; a durable repeat with different input fails before acquisition.
2. As the run executes, the harness appends messages to `storage.appendMessages(sessionId, ...)` whenever the conversation list grows.
3. Execution events are appended to the in-process run queue (consumed by any active `stream()` iterator) AND persisted via `storage.appendEvents(runId, ...)`. `appendEvents` failures are logged at `error` level and counted via the `harness.events.persist_errors` metric; the run continues unaffected.
4. On terminal, an ordinary unleased run calls
   `storage.finishRun(runId, {status, finishedAt, output?, error?})`; a run that
   acquired a durable lease calls `storage.finalizeRun(...)` exactly as defined
   by spec 32. Session metadata is then updated with `updatedAt` and incremented
   `runCount`.

Append rules:

- Rebuilt agent instructions are never persisted. They are reconstructed as
  the one canonical system prompt for each default-loop provider request.
- `user`, `assistant`, and `tool` messages are assembled as one logical turn
  and committed only after the default agent loop succeeds.

## Session memory

`Session.memory` is the session-scoped facade produced by the core memory
orchestrator around the configured `MemoryEngine`. Memory is not stored in
`HarnessStorage`. When `.memory(...)` is omitted, core creates and owns
`inMemoryMemoryEngine()` as specified by
[spec 33](./33-enterprise-memory/00-conventions.md#default-conventions).

```ts
interface SessionMemory {
  read(key: string): Promise<JsonValue | undefined>
  write(key: string, value: JsonValue, opts?: MemoryWriteOptions): Promise<void>
  delete(key: string): Promise<void>
  list(opts?: MemoryListOptions): Promise<string[]>
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>
}
```

Locked semantics:

- `key` regex `/^[A-Za-z0-9_.\-:]{1,256}$/`. Invalid → `ValidationError{where:'memory_key'}`.
- `value` is JSON-serialized via `JSON.stringify`. Non-serializable values (functions, symbols, BigInt, circular refs) throw `ValidationError{where:'memory_value'}`.
- Reads and writes are atomic per key from the caller perspective.
- Persistence depends on the configured engine. `inMemoryMemoryEngine()` is
  process-local and loses its records on process exit.
- Search, TTL, tags, metadata, run/agent/user/tenant scopes, telemetry, metrics, and adapter capability gates are defined in [20-memory-adapters](./20-memory-adapters.md).
- Memory never becomes an implicit sandbox filesystem. Agents access it only
  through the Harness memory facade and declared memory capabilities or tools.

## Conversation history and threads

**One session equals one conversation thread.** The Harness does not model a
thread/conversation as a second entity. Apps that need multiple chat threads
per user MUST create multiple sessions, for example by composing the user and
thread ids into the session id. Each session owns its own message history,
sandbox session, session-scoped memory facade, and serial-execution lock.

### Durable transcript, redelivery, and retention

The default agent loop assembles one logical transcript turn locally: the user
input and all assistant/tool messages. Rebuilt agent instructions stay outside
durable history as the one canonical prompt for each model request. The turn
commits only after the model loop succeeds. Provider retries and
context-projection retries therefore never append partial or duplicate history.
Every message id is stable within the logical run.

`InvokeOptions.idempotencyKey` is an optional caller-owned value for
at-least-once direct-agent delivery. It matches `/^[A-Za-z0-9_.:-]{1,120}$/`.
Repeating a successful `(session, agent, input, key)` returns the recorded
output without invoking the model or writing a second transcript. Reusing the
key with a different invocation in the same session and agent is rejected. The
same transport delivery key is valid in an independent conversation.
Queue/framework integrations MUST
pass their stable delivery/message id; the harness never derives an idempotency
key from user content.
An idempotent `.stream(...)` replay yields the stored `run.started` followed by
the stored `run.finished{output}` from the recorded result; it performs no state
write or live emission and yields no model or tool events.

`HarnessDefaults.historyRetention` optionally retains newest complete turns:

```ts
{ historyRetention: { maxTurns?: number, maxBytes?: number } }
```

`maxTurns` is the primary rolling-window control. `maxBytes` counts serialized
UTF-8 durable records solely as a storage bound; it is not a token estimate.
Turns are never split, so an individual newest turn larger than `maxBytes`
fails rather than silently dropping a prompt, tool call, or tool result. The
policy requires atomic `HarnessStorage.replaceMessages`.

### History window

`HarnessDefaults.historyWindow` (see [02-harness-config](./02-harness-config.md)) caps how many conversation messages are passed into model calls. `InvokeOptions.historyWindow` overrides it for a single call. Locked semantics:

- `undefined` ⇒ pass all messages.
- `0` ⇒ pass system messages only (no prior turns).
- positive integer `N` ⇒ pass at most `N` messages, computed as: every `role:'system'` message is always included; remaining slots are filled with the most recent non-system messages preserving chronological order.
- negative ⇒ rejected: at config time as `HarnessConfigError`; at call time (`InvokeOptions.historyWindow`) as `ValidationError{where:'invoke_options'}`.

The standard agent loop applies the cap before history conversion (see
[09-agents](./09-agents.md) §"History conversion"). Workflows receive only
their declared context and do not bypass this agent-owned projection.

### `Session.clearHistory()`

```ts
clearHistory(): Promise<void>
```

Removes all messages from the HarnessStorage for this session id. Memory KV is unaffected. Emits no `ExecutionEvent` (it is not part of a run). Acquires the per-session serial lock; if a run is in flight, rejects with `SessionBusyError{meta.reason:'history_clear_during_run'}`.

### `Session.replaceHistory(messages)`

```ts
replaceHistory(messages: ReadonlyArray<Omit<Message, 'id' | 'timestamp'>>): Promise<void>
```

Atomically replaces history (delete-then-bulk-append). Each message gets a fresh ULID and the current ISO 8601 UTC timestamp. Validates each entry against the `Message` Zod schema; failure throws `ValidationError{where:'session_history'}`. Acquires the per-session serial lock; if a run is in flight, rejects with `SessionBusyError{meta.reason:'history_replace_during_run'}`.

### Provider context-length errors

When a model call fails because the prompt exceeds the model's context length, the provider implementation maps the response to `ModelError{meta.reason:'context_length_exceeded'}` (see [06-models](./06-models.md), [15-error-catalog](./15-error-catalog.md)). With an explicit context-projection policy, the default loop makes at most one transient projected retry; it never rewrites history, reruns tools, or duplicates events. Otherwise callers can recover by reducing `historyWindow`, calling `replaceHistory` to summarize, or calling `clearHistory` to start fresh. See [26-context-projection-and-compaction](./26-context-projection-and-compaction.md).

## Replay

Production replay remains out of scope. The persisted `RunRecord` + `PersistedRunEvent` log is sufficient to reconstruct the run history offline; no production API is provided. Opt-in sanitized provider-fixture replay for tests is defined in [27-test-replay-and-diagnostic-invariants](./27-test-replay-and-diagnostic-invariants.md).

## Cross-references

- [04-state-queue-stream](./04-state-queue-stream.md) — persisted shapes.
- [09-agents](./09-agents.md), [10-workflows](./10-workflows.md) — invocation paths.
- [12-streaming](./12-streaming.md) — `ExecutionEvent` ordering and stream relay.
- [15-error-catalog](./15-error-catalog.md) — `SessionBusyError`, `SessionNotFoundError`.
- [20-memory-adapters](./20-memory-adapters.md) — memory scopes, adapter contract, reference adapter, telemetry, metrics.
- [33-enterprise-memory](./33-enterprise-memory/00-conventions.md) — current
  `MemoryEngine`, core composition, and `inMemoryMemoryEngine()` defaults.
