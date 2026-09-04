# State and Events

**Purpose.** Defines the `HarnessStorage` foundation port for session history, run records, and run events, its in-memory default, ordering and durability guarantees, the persisted shapes, and how per-run events are streamed in-process. There is no `Stream` port; per-run streaming uses an internal in-process buffered queue owned by the harness (see [12-streaming](./12-streaming.md)).

Session memory is NOT held in `HarnessStorage`. It is served by the configured `MemoryAdapter`; see [11-sessions](./11-sessions.md) §"Session memory" and [20-memory-adapters](./20-memory-adapters.md). Durable step checkpoints are part of `HarnessStorage`; durable file/workspace snapshots remain in the separate `DurableWorkspace` port described in [21-durable-workspaces](./21-durable-workspaces.md).

## HarnessStorage port

`HarnessStorage` is the sole structured persistence boundary for sessions,
conversation history, run records, run events, durable leases/checkpoints, and
external waits. It is not a generic key/value store and is not the memory or
workspace port. Implementations receive logger and telemetry context through
the optional `configureHarnessContext(...)` hook.

```ts
interface HarnessStorage {
  readonly info: HarnessStorageInfo
  readonly capabilities: readonly AdapterCapability[]
  configureHarnessContext?(context: HarnessAdapterContext): void

  // Sessions
  getSession(id: string): Promise<SessionRecord | undefined>
  upsertSession(record: SessionRecord, mode: 'create' | 'update'): Promise<boolean>
  closeSession(id: string, expectedInstanceId: string): Promise<void>

  // Messages (append-only, plus full-clear / bulk-replace for history management)
  appendMessages(sessionId: string, messages: Message[]): Promise<void>
  listMessages(sessionId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>
  /** Delete every message for a session. Used by `Session.clearHistory` and `replaceHistory`. */
  clearMessages(sessionId: string): Promise<void>
  /** Optional atomic clear-and-replace. Required when `historyRetention` is configured. */
  replaceMessages?(sessionId: string, messages: Message[]): Promise<void>

  // Runs
  createRun(request: CreateRunRequest): Promise<RunRecord>
  finishRun(runId: string, patch: FinishRunPatch): Promise<void>
  getRun(runId: string): Promise<RunRecord | undefined>
  listRuns(sessionId: string, opts?: { limit?: number; before?: string }): Promise<RunRecord[]>

  // Run events (append-only audit log)
  appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void>
  listEvents(runId: string, opts?: { limit?: number; after?: string }): Promise<PersistedRunEvent[]>

  // Recoverable execution
  acquireRun(request: AcquireRunRequest): Promise<DurableRunLease>
  loadCheckpoint(runId: string, stepId?: string): Promise<RunCheckpoint | undefined>
  commitCheckpoint(checkpoint: RunCheckpoint): Promise<void>
  replaceCheckpoint(request: ReplaceCheckpointRequest): Promise<void>
  finalizeRun(request: FinalizeRunRequest): Promise<void>
  withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>

  // Opaque external waits, transactionally bound to the run/session
  registerWait(request: BoundExternalWaitRequest): Promise<ExternalWaitRegistration>
  getWait(waitId: string): Promise<ExternalWaitSnapshot | undefined>
  signalWait(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult>
  cancelWait(waitId: string, eventId: string, observedAt?: string): Promise<ExternalWaitSignalResult>

  close?(): Promise<void>
}

type FinishRunPatch = Pick<RunRecord, 'status'> &
  Partial<Pick<RunRecord, 'finishedAt' | 'output' | 'error'>>
```

### Persisted shapes

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

interface SessionRecord {
  id: string
  instanceId: string  // opaque immutable id generated for each new session record
  createdAt: string   // ISO 8601 UTC
  updatedAt: string
  runCount: number
  identity?: HarnessIdentity
  metadata?: Record<string, JsonValue>
}

interface Message {
  id: string                      // raw ULID, no prefix
  sessionId: string
  runId?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string                 // canonical text
  toolCalls?: Array<{
    id: string
    name: string
    arguments: JsonValue
  }>
  toolResults?: Array<{
    toolCallId: string
    output?: JsonValue
    error?: { code: string; message: string }
  }>
  timestamp: string               // ISO 8601 UTC
}

type RunStatus = 'running' | 'waiting' | 'interrupted' |
  'succeeded' | 'failed' | 'cancelled'

interface CreateRunRequest {
  readonly id: string
  readonly sessionId: string
  readonly kind: 'workflow' | 'agent' | 'child_task'
  readonly target: string
  readonly startedAt: string
  readonly input: JsonValue
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

interface RunRecord {
  readonly id: string                      // run_<ulid>
  readonly sessionId: string
  readonly kind: 'workflow' | 'agent' | 'child_task'
  readonly target: string                  // target agent/workflow id
  readonly startedAt: string
  readonly finishedAt?: string
  readonly status: RunStatus
  readonly revision: number                // positive storage CAS revision; starts at 1
  readonly input: JsonValue                // canonical pre-transform wire input
  readonly output?: JsonValue
  readonly error?: SerializedError         // see 12-streaming
  readonly approvalReceipt?: TerminalApprovalReceiptV1 // exact v4 shape in spec 32; terminal only
  readonly attempt?: number
  readonly workerId?: string
  readonly initialStepId?: string
  readonly metadata?: Readonly<Record<string, JsonValue>>
}

interface PersistedRunEvent {
  id: string                      // ulid (sortable)
  runId: string
  at: string                      // ISO 8601 UTC
  type: string                    // matches RunEvent.type
  payload: JsonValue              // privacy-safe event payload without runId/at/type
}
```

`CreateRunRequest` is the strict caller-owned creation projection. Storage adds
`status:'running'` and `revision:1`; request values cannot supply revision,
status, terminal result/error/receipt fields, attempt, worker, initial step, or
lease data. `input` is required for every run kind. For root `agent` and `workflow` runs it
is the authoritative canonical pre-transform wire input used by approval
resume. A `child_task` retains the canonical child-call input required by spec
28. `approvalReceipt` is permitted only on a terminal `agent` or `workflow`
record; it is forbidden on `child_task` and every non-terminal record.
`revision` starts at `1` when `createRun` wins and increases by exactly one for
each successful acquisition, checkpoint mutation, resumable release/wait
transition, or terminal mutation. Event and message appends do not change it.

`SerializedError` is defined in [12-streaming](./12-streaming.md) and reused here.

### Guarantees

- `appendMessages` and `appendEvents` are atomic per call. Partial writes MUST NOT be observable.
- `appendMessages` rejects duplicate message ids with `StateError{meta.reason:'duplicate_message_id'}`.
- When a harness configures durable `historyRetention`, its HarnessStorage MUST
  implement atomic `replaceMessages`; harness construction rejects adapters
  without it. A clear-then-append fallback is forbidden for retained history.
- `clearMessages` is atomic: either every message for the session is removed or none is.
- `listMessages` returns messages in ascending order by `(timestamp, id)`. `before` cursor is a message id; pagination is exclusive.
- `listRuns` returns runs in descending order by `startedAt` then by `id` descending. `before` cursor is a run id; pagination is exclusive.
- `appendEvents` / `listEvents` preserve insertion order; `after` cursor is an event id; pagination is exclusive.
- Persisted event payloads MUST follow the privacy-safe mapping in [12-streaming](./12-streaming.md). Content-bearing fields are redacted regardless of telemetry span content capture until a future spec adds a dedicated persisted-event content flag.
- `upsertSession(record, mode)` requires explicit `create` or `update` intent.
  Create atomically returns `true` only for the first insert, which
  binds immutable `instanceId`, `createdAt`, and exact optional identity. Existing identity
  mismatch fails with `StateError`; creation against an existing same-identity
  record returns `false` without mutating it. Update requires the exact stored
  instance, creation time, and identity; missing or changed instances fail with
  `StateError` (`session_instance_mismatch`) and never insert. Valid updates
  return `false` and cannot regress `updatedAt` or `runCount`. Callers reread the
  stored record after creation to obtain the winning instance id. A proposed
  different instance cannot overwrite the stored record. This is ordinary
  session binding; storage owns no sandbox lifecycle records.
- `closeSession(id, expectedInstanceId)` atomically deletes the session and its
  owned records only when the stored instance matches. Stale and absent closes
  are no-ops; they never delete a new conversation that reused the same id.
- `createRun` atomically inserts the strict request as a revision-one running
  record and returns the authoritative recursively frozen record. For agent,
  workflow, and child-task retries, an exact creation-identity retry returns
  the current authoritative record without resetting its status, revision,
  messages, events, lease, or checkpoints. Any mismatch uses spec 32's
  content-free `StateError{op:'createRun',reason:'run_conflict'}`. Existing
  terminal runs are never overwritten.
- Durable run acquisition, checkpoint commits, wait registration, and terminal
  transitions follow [32-harness-storage](./32-harness-storage.md). A new wait
  MUST atomically mark its run `waiting` and release the lease.
- HarnessStorage methods MUST throw [`StateError`](./15-error-catalog.md) or the
  more specific durable/wait error on backend or lifecycle failure.

### In-memory default

- All data lives in process memory in `Map`s.
- Concurrent `appendMessages` on the same session are serialized via an internal per-session async lock.
- `clearMessages` and the bulk-replace in `Session.replaceHistory` (delete-then-bulk-append) acquire the same lock.
- On `close()`: clears all data.
- Suitable for tests and single-process development; lost on process exit.

## In-process run-event streaming

The harness exposes per-run streaming via `Session.agents[id].stream(...)` and `Session.workflows[id].stream(...)`. Internally:

- Each run owns an in-process bounded queue. The harness's run-loop appends `RunEvent` values to the queue without waiting for slow consumers.
- `stream()` returns an `AsyncIterable<RunEvent>` reading from that queue.
- Breaking out of a stream iterator detaches that consumer only. It does not cancel the run; pass `opts.signal` for explicit run cancellation.
- Overflow: consumer slowness may drop oldest non-terminal live events and emit `stream.overflow`. See [12-streaming](./12-streaming.md) for full ordering, overflow, and persistence semantics.
- Persistence-of-events for audit goes through `HarnessStorage.appendEvents` inside the run lifecycle; there is no separate persistence span and no separate stream port.

## Cross-references

- [03-foundation](./03-foundation.md) — error categories.
- [11-sessions](./11-sessions.md) — how sessions use HarnessStorage (history and runs).
- [20-memory-adapters](./20-memory-adapters.md) — memory persistence port.
- [21-durable-workspaces](./21-durable-workspaces.md) — durable replay workspace references and checkpoint linkage.
- [12-streaming](./12-streaming.md) — `SerializedError`, bounded in-process queue, overflow, privacy-safe persistence.
- [16-testing](./16-testing.md) — port contract tests.
