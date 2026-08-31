# Sessions

**Purpose.** Defines the `Session` API, persistence semantics, the serial-execution concurrency rule, message shape (referenced from [04](./04-state-queue-stream.md)), and session memory facade semantics. The pluggable memory adapter contract lives in [20-memory-adapters](./20-memory-adapters.md).

## API

```ts
interface Harness<S> {
  getSession(id: string): Promise<Session<S>>
}

interface Session<S> {
  readonly id: string
  readonly agents: { readonly [K in keyof S['agents']]: AgentInvoker<S, K> }
  readonly workflows: { readonly [K in keyof S['workflows']]: WorkflowInvoker<S, K> }
  readonly childTasks: SessionChildTasks
  memory: SessionMemory
  history: ConversationHistory
  getRunSummary(runId: string): Promise<RunSummary | undefined>
  /** Remove all messages for this session. See "Conversation history and threads". */
  clearHistory(): Promise<void>
  /** Atomically replace history with the provided messages. Each entry gets a fresh ULID and current timestamp. */
  replaceHistory(messages: ReadonlyArray<Omit<Message, 'id' | 'timestamp'>>): Promise<void>
  /** Frees live sandbox/MCP resources while preserving persisted session state. */
  release(): Promise<void>
  /** Destructively removes persisted session state after releasing live resources. */
  destroy(): Promise<void>
}

interface AgentInvoker<S, K extends keyof S['agents']> {
  run(input: AgentInput<S, K>, opts?: InvokeOptions): Promise<AgentOutput<S, K>>
  stream(input: AgentInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

interface WorkflowInvoker<S, K extends keyof S['workflows']> {
  run(input: WorkflowInput<S, K>, opts?: InvokeOptions): Promise<WorkflowOutput<S, K>>
  stream(input: WorkflowInput<S, K>, opts?: InvokeOptions): AsyncIterable<RunEvent>
}

interface InvokeOptions {
  signal?: AbortSignal
  /** Override the default run timeout for this call. `>0` enabled, `0` disabled, `<0` throws `ValidationError`. */
  timeoutMs?: number
  /** Override `harness.defaults.historyWindow` for this call. Same semantics; negative throws `ValidationError{where:'invoke_options'}`. */
  historyWindow?: number
  /** Optional W3C Trace Context parent. Invalid values are ignored with warning log code `INVALID_TRACE_CONTEXT`. */
  traceparent?: string
  /** Optional W3C Trace Context state paired with `traceparent`. */
  tracestate?: string
  /** Sanitized scalar metadata made available to handlers and emitted as `harness.metadata.*` attributes. */
  metadata?: Record<string, JsonValue>
  /**
   * Opt into durable execution for a workflow run. Requires a configured
   * executable `.storage(...)`. Workflow-only; supplying it on an agent run
   * throws `ValidationError{where:'invoke_options'}`. See
   * [21-durable-workspaces](./21-durable-workspaces.md) §16.1.
   */
  durable?: DurableInvokeOptions
}

interface DurableInvokeOptions {
  /** Stable run id reused across resumes/retries. Matches /^[A-Za-z0-9_.:-]{1,200}$/. */
  runId: string
  /** Worker/process id owning the lease. Defaults to the harness worker id. */
  workerId?: string
  /** Initial durable step id label. Defaults to the workflow id. */
  stepId?: string
  /** Optional attempt hint; the runtime may raise it on retry. */
  attempt?: number
  /** Per-run workspace constraints; the workspace adapter validates and enforces them. */
  workspacePolicy?: Partial<DurableWorkspacePolicy>
}
```

`Session` is a JS object with:

- A fixed `id` property.
- An `agents` map: one `AgentInvoker` per registered agent id.
- A `workflows` map: one `WorkflowInvoker` per registered workflow id.
- A `childTasks` owner-only map. `get(id)` returns a live task handle or a
  terminal persisted handle only when its `RunRecord` belongs to this session;
  `list()` returns content-free child-task snapshots. A non-resident running
  task is observable but cannot be cancelled or awaited without a task-worker
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
3. **Extract trace context** from `opts.traceparent`/`opts.tracestate` if present. Invalid context is ignored with warning log code `INVALID_TRACE_CONTEXT`.
4. **Open `harness.session.run` span** (outermost) with attributes `harness.session.id`, `harness.run.id`, and `harness.workflow.id` for workflow runs.
5. **Validate input** via the selected agent/workflow input schema. Failure → `ValidationError{where:'agent_input'|'workflow_input'}`.
6. **`storage.createRun({status:'running', ...})`.** If this fails, the harness does not open further spans, does not emit any RunEvent, and propagates the `StateError` to the caller of `run`/`stream`.
7. **Emit `run.started`** to the in-process run queue (see [12-streaming](./12-streaming.md)) and persist via `storage.appendEvents`.
8. **Open child span**: `invoke_agent {agent.name}` for direct agent runs or `harness.workflow.run` for workflow runs.
9. **On success:** validate output via the selected output schema (failure → `ValidationError{where:'agent_output'|'workflow_output'}`); emit `run.finished{output}`; `storage.finishRun({status:'succeeded', finishedAt, output})`.
10. **On error:** classify the error; emit `run.finished{error}`; `storage.finishRun({status:'failed'|'cancelled', finishedAt, error})`. (`cancelled` is used when the cause is `OperationCancelledError`; `failed` otherwise — including `OperationTimeoutError`.)
11. **Close spans, release lock.** Failed/cancelled spans carry safe
    `harness.error.*` attributes. Timeout/cancel errors include
    `harness.error.scope` and, for timeouts, `harness.error.timeout_ms`.
12. **Resolve `run` with output (or reject with error).** For `stream`, the async iterator yields events as they are emitted and finishes after `run.finished` is yielded.

The outermost span is always `harness.session.run`; the child is `invoke_agent {agent.name}` for direct agent runs or `harness.workflow.run` for workflow runs.

### Durable workflow runs

When `opts.durable` is supplied to a workflow `run`/`stream`, the locked order
above is extended (see [21-durable-workspaces](./21-durable-workspaces.md) §16.1):

- The run id is `opts.durable.runId` (not a fresh ULID), so the `RunRecord`,
  persisted events, run summary, durable storage lease, and any durable workspace
  share one stable id.
- After the busy check and before the handler runs, the harness acquires a durable
  runtime lease and (when a workspace is configured) starts or resumes the
  durable workspace. `ctx.step(...)` becomes durable for the call.
- On terminal, the harness finalizes the durable storage (`finishRun`) and drives
  the workspace lifecycle in addition to the ordinary `storage.finishRun`. Durable
  finalization failures are logged and counted but never mask the primary error.
- Supplying `opts.durable` on an agent run throws
  `ValidationError{where:'invoke_options'}`; supplying it without an executable
  `.storage(...)` throws `HarnessConfigError{meta.reason:'durable_runtime_required'}`.

## Concurrency rule (locked)

Sessions are **serial-only**. Per session, only one run executes at a time. Implementation:

- The harness maintains an in-process per-session async lock keyed by `sessionId`.
- Each `prompt`/`stream` call acquires the lock at start.
- Sessions execute one prompt/stream at a time. Overlap throws `SessionBusyError` synchronously (`category:'session'`, `retriable:true`).
- There is no `concurrent: true` opt-out.

Cross-process concurrency is enforced only in-process. Cross-process callers may execute concurrently unless the HarnessStorage adapter implements advisory locks (out-of-scope for v3).

## Persistence semantics

For every run:

1. A `RunRecord` is created via `storage.createRun({id, sessionId, kind:'agent'|'workflow', target:agentIdOrWorkflowId, startedAt, status:'running', input})`.
2. As the run executes, the harness appends messages to `storage.appendMessages(sessionId, ...)` whenever the conversation list grows.
3. RunEvents are appended to the in-process run queue (consumed by any active `stream()` iterator) AND persisted via `storage.appendEvents(runId, ...)`. `appendEvents` failures are logged at `error` level and counted via the `harness.events.persist_errors` metric; the run continues unaffected.
4. On finish: `storage.finishRun(runId, {status, finishedAt, output?, error?})`. Session metadata is updated with `updatedAt` and incremented `runCount`.

Append rules:

- Rebuilt agent instructions are never persisted. They are reconstructed as
  the one canonical system prompt for each default-loop provider request.
- `user`, `assistant`, and `tool` messages are assembled as one logical turn
  and committed only after the default agent loop succeeds.

## Session memory

`Session.memory` is a session-scoped facade over the configured `MemoryAdapter`. Memory is not stored in the `HarnessStorage`. The default adapter is `sandboxMemory()`, which stores session memory in `/memory/session/` inside the sandbox.

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
- Persistence depends on the configured memory adapter. `sandboxMemory()` persists for the lifetime of the sandbox session; the default in-memory sandbox loses everything on process exit.
- Search, TTL, tags, metadata, run/agent/user/tenant scopes, telemetry, metrics, and adapter capability gates are defined in [20-memory-adapters](./20-memory-adapters.md).
- The model can read/write the default adapter's sandbox files only when `sandboxMemory()` is used. With external memory adapters, model access to memory is through tools or application code, not direct filesystem reads.

## Conversation history and threads

**One session equals one conversation thread.** The harness does not model thread/conversation as a separate entity in v3. Apps that need multiple chat threads per user MUST create multiple sessions, e.g. `session_id = \`${userId}:${threadId}\``. Each session owns its own message history, sandbox session, session-scoped memory facade, and serial-execution lock.

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
An idempotent `.stream(...)` replay emits exactly `run.started` followed by
`run.finished{output}` from the recorded result; it performs no state write and
emits no model or tool events.

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

The cap is applied by the default agent loop before history conversion (see [09-agents](./09-agents.md) §"History conversion"). Custom-handler agents that consume `ctx.history` directly are responsible for honoring the window themselves.

### `Session.clearHistory()`

```ts
clearHistory(): Promise<void>
```

Removes all messages from the HarnessStorage for this session id. Memory KV is unaffected. Emits no `RunEvent` (it is not part of a run). Acquires the per-session serial lock; if a run is in flight, rejects with `SessionBusyError{meta.reason:'history_clear_during_run'}`.

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
- [12-streaming](./12-streaming.md) — `RunEvent` and stream relay.
- [15-error-catalog](./15-error-catalog.md) — `SessionBusyError`, `SessionNotFoundError`.
- [20-memory-adapters](./20-memory-adapters.md) — memory scopes, adapter contract, reference adapter, telemetry, metrics.
