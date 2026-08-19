# State and Events

**Purpose.** Defines the `StateStore` foundation port for session history, run records, and run events, its in-memory default, ordering and durability guarantees, the persisted shapes, and how per-run events are streamed in-process. There is no `Stream` port; per-run streaming uses an internal in-process buffered queue owned by the harness (see [12-streaming](./12-streaming.md)).

Session memory is NOT held in the StateStore. It is served by the configured `MemoryAdapter`; see [11-sessions](./11-sessions.md) §"Session memory" and [20-memory-adapters](./20-memory-adapters.md). Durable workspace snapshots and checkpoint payload storage are NOT held in the StateStore; see [21-durable-workspaces](./21-durable-workspaces.md).

## StateStore port

`StateStore` persists session conversation history, run records, and run events. It is not the memory persistence port.
State adapters that extend `StateStoreAdapterBase` inherit the harness logger,
telemetry shim, and defaults through `configureHarnessContext(...)`; custom
state adapters may implement the same hook directly.

```ts
interface StateStore {
  // Sessions
  getSession(id: string): Promise<SessionRecord | undefined>
  upsertSession(record: SessionRecord): Promise<void>
  closeSession(id: string): Promise<void>

  // Messages (append-only, plus full-clear / bulk-replace for history management)
  appendMessages(sessionId: string, messages: Message[]): Promise<void>
  listMessages(sessionId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>
  /** Delete every message for a session. Used by `Session.clearHistory` and `replaceHistory`. */
  clearMessages(sessionId: string): Promise<void>
  /** Optional atomic clear-and-replace. Required when `historyRetention` is configured. */
  replaceMessages?(sessionId: string, messages: Message[]): Promise<void>

  // Runs
  createRun(record: RunRecord): Promise<void>
  finishRun(runId: string, patch: FinishRunPatch): Promise<void>
  getRun(runId: string): Promise<RunRecord | undefined>
  listRuns(sessionId: string, opts?: { limit?: number; before?: string }): Promise<RunRecord[]>

  // Run events (append-only audit log)
  appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void>
  listEvents(runId: string, opts?: { limit?: number; after?: string }): Promise<PersistedRunEvent[]>

  close?(): Promise<void>
}

type FinishRunPatch = Pick<RunRecord, 'status' | 'finishedAt' | 'output' | 'error'>
```

### Persisted shapes

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

interface SessionRecord {
  id: string
  createdAt: string   // ISO 8601 UTC
  updatedAt: string
  runCount: number
  metadata?: Record<string, JsonValue>
}

interface Message {
  id: string                      // raw ULID, no prefix
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string                 // canonical text
  toolCalls?: Array<{
    id: string
    toolId: string
    input: JsonValue
  }>
  toolResults?: Array<{
    callId: string
    output?: JsonValue
    error?: { code: string; message: string }
  }>
  timestamp: string               // ISO 8601 UTC
}

type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

interface RunRecord {
  id: string                      // run_<ulid>
  sessionId: string
  kind: 'workflow'                // locked: only workflows produce runs
  target: string                  // workflow id
  startedAt: string
  finishedAt?: string
  status: RunStatus
  input?: JsonValue
  output?: JsonValue
  error?: SerializedError         // see 12-streaming
}

interface PersistedRunEvent {
  id: string                      // ulid (sortable)
  runId: string
  at: string                      // ISO 8601 UTC
  type: string                    // matches RunEvent.type
  payload: JsonValue              // privacy-safe event payload without runId/at/type
}
```

`SerializedError` is defined in [12-streaming](./12-streaming.md) and reused here.

### Guarantees

- `appendMessages` and `appendEvents` are atomic per call. Partial writes MUST NOT be observable.
- `appendMessages` rejects duplicate message ids with `StateError{meta.reason:'duplicate_message_id'}`.
- When a harness configures durable `historyRetention`, its StateStore MUST
  implement atomic `replaceMessages`; harness construction rejects adapters
  without it. A clear-then-append fallback is forbidden for retained history.
- `clearMessages` is atomic: either every message for the session is removed or none is.
- `listMessages` returns messages in ascending order by `(timestamp, id)`. `before` cursor is a message id; pagination is exclusive.
- `listRuns` returns runs in descending order by `startedAt` then by `id` descending. `before` cursor is a run id; pagination is exclusive.
- `appendEvents` / `listEvents` preserve insertion order; `after` cursor is an event id; pagination is exclusive.
- Persisted event payloads MUST follow the privacy-safe mapping in [12-streaming](./12-streaming.md). Content-bearing fields are redacted regardless of telemetry span content capture until a future spec adds a dedicated persisted-event content flag.
- `upsertSession` is idempotent: if `id` exists, `updatedAt` and `runCount` are overwritten with the supplied record.
- `createRun` is normally insert-only. For durable workflow retries, the harness
  acquires the durable runtime lease before calling `createRun`; if a
  non-terminal run with the same id already exists and the new record matches
  `sessionId`, `kind`, and `target`, `createRun` is idempotent and must not
  reset messages, events, or committed durable checkpoints. Existing terminal
  runs are never overwritten.
- StateStore methods MUST throw [`StateError`](./15-error-catalog.md) on backend failure.

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
- Persistence-of-events for audit goes through `StateStore.appendEvents` inside the run lifecycle; there is no separate persistence span and no separate stream port.

## Cross-references

- [03-foundation](./03-foundation.md) — error categories.
- [11-sessions](./11-sessions.md) — how sessions use StateStore (history and runs).
- [20-memory-adapters](./20-memory-adapters.md) — memory persistence port.
- [21-durable-workspaces](./21-durable-workspaces.md) — durable replay workspace references and checkpoint linkage.
- [12-streaming](./12-streaming.md) — `SerializedError`, bounded in-process queue, overflow, privacy-safe persistence.
- [16-testing](./16-testing.md) — port contract tests.
