# State, Sessions, Streaming, And Errors

## Contents
- StateStore
- Persisted Shapes
- Sessions
- Memory And History
- Concurrency
- Streaming Run Events
- Error Families
- API Edge Mapping

## StateStore
`StateStore` persists sessions, messages, run records, and run events:

```ts
interface StateStore {
  getSession(id): Promise<SessionRecord | undefined>
  upsertSession(record): Promise<void>
  closeSession(id): Promise<void>
  appendMessages(sessionId, messages): Promise<void>
  listMessages(sessionId, opts?): Promise<Message[]>
  clearMessages(sessionId): Promise<void>
  createRun(record): Promise<void>
  finishRun(runId, patch): Promise<void>
  getRun(runId): Promise<RunRecord | undefined>
  listRuns(sessionId, opts?): Promise<RunRecord[]>
  appendEvents(runId, events): Promise<void>
  listEvents(runId, opts?): Promise<PersistedRunEvent[]>
  close?(): Promise<void>
}
```

Default state is `InMemoryStateStore`, which is suitable for tests/local development and not durable production history.

Durable adapters should preserve stable ordering, reject duplicate message ids, and pass `stateStoreContract` from `@purista/harness/testing`.

## Persisted Shapes
Important records:
- `SessionRecord`: `id`, `createdAt`, `updatedAt`, `runCount`, optional `metadata`
- `Message`: `id`, `sessionId`, optional `runId`, `role`, `content`, optional `toolCalls` / `toolResults`, `timestamp`
- `RunRecord`: `id`, `sessionId`, `kind`, `target`, `startedAt`, status, input/output/error
- `PersistedRunEvent`: `id`, `runId`, `at`, `type`, `payload`

State/history is sensitive data. Keep tenant scoping and retention outside the harness if your adapter stores records durably.

## Sessions
Application code enters through:

```ts
const session = await harness.getSession('tenant:user:thread')
await session.agents.answerer.prompt(input, opts)
await session.workflows.report.stream(input, opts)
await session.close()
```

The session API exposes:
- `id`
- `agents.<id>.prompt` / `.stream`
- `workflows.<id>.prompt` / `.stream`
- `memory`
- `history`
- `clearHistory()`
- `replaceHistory(messages)`
- `close()`

Use stable, tenant-safe session ids. Do not put secrets in session ids.

## Memory And History
Session memory is exposed through `SessionMemory` and backed by the configured `MemoryAdapter`.
The default `sandboxMemory()` adapter stores session memory in `/memory/session/`
inside the session sandbox.

```ts
await session.memory.write('last-topic', { topic: 'pricing' })
const value = await session.memory.read<{ topic: string }>('last-topic')
await session.memory.delete('last-topic')
const keys = await session.memory.list()
```

Memory keys must match `/^[A-Za-z0-9_.\-:]{1,256}$/`. Values must be JSON-serializable.
Use `ctx.memory.session`, `ctx.memory.run`, `ctx.memory.agent`, `ctx.memory.user()`,
and `ctx.memory.tenant()` inside run contexts when scoped memory is needed.

History:

```ts
const messages = await session.history.list({ limit: 20 })
await session.clearHistory()
await session.replaceHistory([{ role: 'user', content: 'hello', sessionId: session.id }])
```

`clearHistory()` and `replaceHistory()` fail with `SessionBusyError` while a run is active.

## Concurrency
One session has one active run at a time. Concurrent runs in the same session throw `SessionBusyError` with reason `concurrent_run`.

Use separate session ids for parallel user threads or independent background jobs.

## Streaming Run Events
`prompt(...)` returns final validated output. `stream(...)` yields typed `RunEvent` values:

```ts
for await (const event of session.workflows.audit.stream(input)) {
  switch (event.type) {
    case 'run.started':
    case 'agent.started':
    case 'tool.started':
    case 'tool.finished':
    case 'model.message':
    case 'model.object.partial':
    case 'model.object':
    case 'model.embedding.completed':
    case 'model.rerank.completed':
    case 'agent.finished':
    case 'run.finished':
    case 'stream.overflow':
      break
  }
}
```

Ordering is lifecycle order for a single run. Streams are live observation. Persisted events support audit/history inspection, but recovery should use durable checkpoints, not stream cursors.

Do not expose `RunEvent` directly as a provider protocol unless your application owns that contract. HTTP/SSE adapters should map harness events into client-facing event shapes.

## Error Families
All `HarnessError` instances carry `code`, `category`, `retriable`, `message`, and optional sanitized `meta`.

Common classes:
- `HarnessConfigError`
- `ValidationError`
- `PermissionDeniedError`
- `SandboxError`
- `SandboxNoExecutorError`
- `ModelError`
- `ModelCapabilityError`
- `ToolError`
- `ToolNotFoundError`
- `SkillNotFoundError`
- `SkillManifestError`
- `AgentNotFoundError`
- `AgentLoopBudgetError`
- `WorkflowNotFoundError`
- `SessionNotFoundError`
- `SessionBusyError`
- `StateError`
- `OperationTimeoutError`
- `OperationCancelledError`
- `McpProtocolError`
- `McpAuthError`
- `InternalError`

Use `isHarnessError(error)` for typed routing and `serializeError(error)` for stable API/log envelopes.

## API Edge Mapping
Suggested API mapping:
- validation/config/not-found style errors: 400 or 404 depending on route semantics
- `SessionBusyError`: 409
- `PermissionDeniedError`: 403
- timeout/cancelled: 408/499/504 depending on infrastructure
- retriable model/tool/state errors: 502/503
- `InternalError`: 500

Always include `code`, `category`, `retriable`, and a correlation/run id in API responses; avoid leaking raw provider bodies or tool payloads.
