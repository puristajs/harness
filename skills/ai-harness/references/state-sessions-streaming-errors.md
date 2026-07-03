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
    case 'model.delta':
    case 'model.object.partial':
    case 'model.object':
    case 'model.embedding.completed':
    case 'model.rerank.completed':
    case 'policy.exposure':
    case 'policy.evaluated':
    case 'approval.requested':
    case 'approval.finished':
    case 'agent.finished':
    case 'run.finished':
    case 'stream.overflow':
      break
  }
}
```

Ordering is lifecycle order for a single run. Streams are live observation.
Breaking out of a `stream(...)` iterator detaches that consumer only; it does
not cancel the underlying run. Pass `opts.signal` when the application intends
to cancel the run, and use `StateStore.listEvents(runId)` for persisted audit
history after live observation ends.

`text(...)` and `object(...)` are final request-response model calls and do not
emit partial run events. Consumed `textStream(...)` and `objectStream(...)`
chunks stay private by default. They emit `model.delta`,
`model.object.partial`, and streamed final `model.object` events only when that
specific model stream call passes `{ emitRunEvents: true }`. Harness-emitted
model stream events include a generated `streamId`, `modelAlias`, and available
`workflowId` / `agentId`. UI labels, semantic buckets, and client event names
belong in the application adapter. Persisted events support audit/history
inspection, but recovery should use durable checkpoints, not stream cursors.

Do not expose `RunEvent` directly as a provider protocol unless your application owns that contract. HTTP/SSE adapters should map harness events into client-facing event shapes.

Governance events are audit-oriented and privacy-safe. `policy.exposure`
records pre-model tool exposure decisions. `policy.evaluated` records
execution-policy decisions for a concrete tool call. Approval events include
`approvalId` and `decisionId`. Persisted policy payloads may include
`policyVersion`, rule id, effect, enforcement state, reason, risk level, and
tags, but must not include raw tool input or output.

## Error Families
All `HarnessError` instances carry `code`, `category`, `retriable`, `message`, and optional sanitized `meta`.

Common classes:
- `HarnessConfigError`
- `ValidationError`
- `PermissionDeniedError`
- `PolicyEvaluationError`
- `PolicyDeniedError`
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

`ModelError` may include provider retry metadata:

- `meta.reason: 'rate_limited' | 'provider_unavailable' | 'network'`
- `meta.retryKind: 'none' | 'active' | 'deferred'`
- `meta.retryAfterMs`
- `meta.retryAttempt`
- `meta.retryMaxAttempts`
- sanitized `meta.providerHeaders` and parsed `meta.rateLimit`

When `retryKind === 'deferred'`, do not sleep inside an HTTP request or
long-running handler. Return a typed API error, enqueue delayed work, or let a
durable/queue integration schedule the retry. The standalone harness reports
the metadata; application or PURISTA queue code owns long-delay scheduling.
Invalid model retry policies throw `HarnessConfigError` with
`reason:'invalid_model_retry_policy'` before provider execution.

## API Edge Mapping
Suggested API mapping:
- validation/config/not-found style errors: 400 or 404 depending on route semantics
- `SessionBusyError`: 409
- `PermissionDeniedError`: 403
- timeout/cancelled: 408/499/504 depending on infrastructure
- retriable model/tool/state errors: 502/503
- `InternalError`: 500

Always include `code`, `category`, `retriable`, and a correlation/run id in API responses; avoid leaking raw provider bodies or tool payloads.
