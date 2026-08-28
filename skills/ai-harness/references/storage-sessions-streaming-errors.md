# Storage, Sessions, Streaming, And Errors

## Contents
- HarnessStorage
- Persisted Shapes
- Sessions
- Memory And History
- Durable History, Retention, And Direct-Agent Redelivery
- Concurrency
- Streaming Run Events
- Error Families
- API Edge Mapping

## HarnessStorage

`HarnessStorage` is the single Harness persistence port. It owns conversations,
run records/events, recoverable workflow checkpoints and leases, and durable
external waits. It is unrelated to PURISTA framework's general-purpose
`StateStore`; never bridge one into the other.

```ts
interface HarnessStorage {
  readonly info: HarnessStorageInfo
  readonly capabilities: readonly AdapterCapability[]
  getSession(id): Promise<SessionRecord | undefined>
  upsertSession(record, mode: 'create' | 'update'): Promise<boolean>
  closeSession(id, expectedInstanceId): Promise<void>
  appendMessages(sessionId, messages): Promise<void>
  listMessages(sessionId, opts?): Promise<Message[]>
  clearMessages(sessionId): Promise<void>
  /** Atomic clear-and-replace; required by defaults.historyRetention. */
  replaceMessages?(sessionId, messages): Promise<void>
  createRun(record): Promise<void>
  finishRun(runId, patch): Promise<void>
  getRun(runId): Promise<RunRecord | undefined>
  listRuns(sessionId, opts?): Promise<RunRecord[]>
  appendEvents(runId, events): Promise<void>
  listEvents(runId, opts?): Promise<PersistedRunEvent[]>

  acquireRun(start): Promise<DurableRunLease>
  loadCheckpoint(runId): Promise<RunCheckpoint | undefined>
  commitCheckpoint(checkpoint): Promise<void>
  withSessionLock<T>(sessionId, fn): Promise<T>

  registerWait(request): Promise<ExternalWaitRegistration>
  getWait(waitId): Promise<ExternalWaitSnapshot | undefined>
  signalWait(signal): Promise<ExternalWaitSignalResult>
  cancelWait(waitId, eventId, observedAt?): Promise<ExternalWaitSignalResult>
  close?(): Promise<void>
}
```

The default is `InMemoryHarnessStorage`, which is suitable for tests and local
development but does not survive process exit. `SqliteHarnessStorage` is the
zero-extra-dependency Node/Bun single-host option. Distributed deployments must
provide a backend with transactional run acquisition, checkpoint, wait, and
session-lock semantics and advertise `storage.multi_instance`.

Custom adapters must pass `harnessStorageContract` from
`@purista/harness/testing`.

## Persisted Shapes
Important records:
- `SessionRecord`: `id`, opaque immutable `instanceId`, `createdAt`, `updatedAt`, `runCount`, optional `identity` and `metadata`. `upsertSession(record, 'create')` returns `true` only for creation; the winner's identity and instance are immutable. `update` requires that instance and cannot recreate missing records. Conditional close prevents stale clients deleting a new instance.
- `Message`: `id`, `sessionId`, optional `runId`, `role`, `content`, optional `toolCalls` / `toolResults`, `timestamp`
- `RunRecord`: `id`, `sessionId`, `kind`, `target`, `startedAt`, status, input/output/error
- `PersistedRunEvent`: `id`, `runId`, `at`, `type`, `payload`

Conversation and run storage is sensitive data. Keep tenant scoping and retention policy at the
application configuration boundary. For a bounded Harness-managed transcript,
configure `defaults.historyRetention`; durable `HarnessStorage` adapters must enforce
the required atomic `replaceMessages` operation.

## Sessions
Application code enters through:

```ts
const session = await harness.getSession('tenant:user:thread')
await session.agents.answerer.prompt(input, opts)
await session.workflows.report.stream(input, opts)
await session.release()
```

The session API exposes:
- `id`
- `agents.<id>.prompt` / `.stream`
- `workflows.<id>.prompt` / `.stream`
- `memory`
- `history`
- `clearHistory()`
- `replaceHistory(messages)`
- `release()`
- `close()`

Use stable, tenant-safe session ids. Do not put secrets in session ids.

## Memory And History
Session memory is exposed through `SessionMemory` and backed by the configured `MemoryEngine`.
The default is dependency-free, process-local in-memory storage; configure a dedicated engine when records must survive a restart or be shared.

```ts
await session.memory.write('last-topic', { topic: 'pricing' })
const value = await session.memory.read<{ topic: string }>('last-topic')
await session.memory.delete('last-topic')
const keys = await session.memory.list()
```

Memory keys use portable identifiers of up to 256 characters (`A-Z`, `a-z`, numbers, `_`, `.`, `/`, `-`, and `:`). Values must be JSON-serializable.
Use `ctx.memory.application`, `ctx.memory.tenant()`, `ctx.memory.principal()`,
`ctx.memory.session`, `ctx.memory.run`, and `ctx.memory.agent` inside run contexts when scoped memory is needed.

History:

```ts
const messages = await session.history.list({ limit: 20 })
await session.clearHistory()
await session.replaceHistory([{ role: 'user', content: 'hello', sessionId: session.id }])
```

`clearHistory()` and `replaceHistory()` fail with `SessionBusyError` while a run is active.

`release()` closes live session resources such as sandbox-bound MCP runners
without deleting `HarnessStorage`-backed history, runs, or events. Call it after an
idle request. `close()` first releases resources and then destructively removes
the session record, conversation history, runs, and persisted events.

## Durable History, Retention, And Direct-Agent Redelivery

The default agent loop commits one complete logical turn only after it
succeeds: user input, any assistant/tool exchanges, and the final assistant
output. Rebuilt instructions, provider retries, and context-projection retries
never create partial or duplicate durable messages.

```ts
const harness = defineHarness({ name: 'support' })
  .storage(distributedHarnessStorage)
  .defaults({ historyRetention: { maxTurns: 50, maxBytes: 256_000 } })
  // models, tools, and agents
  .build()

const session = await harness.getSession(`tenant:${tenantId}:thread:${threadId}`)
const output = await session.agents.answerer.prompt(input, {
  idempotencyKey: queueMessage.id
})
```

`maxTurns` is the rolling retention window. `maxBytes` is a serialized UTF-8
storage bound, not a token approximation; no complete turn is split, and a
newest turn that alone exceeds the cap fails. `historyRetention` requires
atomic `HarnessStorage.replaceMessages`, so use an adapter that implements it.

`idempotencyKey` is only for direct-agent at-least-once delivery and must be a
stable caller-owned delivery id. Repeating the same successful session, agent,
input, and key returns its recorded output without a provider call or a second
transcript write. It does not make external tool side effects exactly-once.
Recoverable workflows use the configured `HarnessStorage` and optional
`DurableWorkspace` idempotency policy.

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
    case 'model.completed':
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
to cancel the run, and use `HarnessStorage.listEvents(runId)` for persisted audit
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
execution-policy decisions for a concrete tool call. Approval events retain
`approvalId`, tool/call correlation, and safe evidence. `DecisionEvidence`
contains `decisionId`, `source`, `phase`, and optional `reasonCode`; source has
kind/id and optional version/ruleId. Policy events add effect/enforcement
state. Approval subjects, tool input/output, reviewer identity/comments, and
arbitrary callback errors are not audit data.

`model.completed` is the sole generative model-call/token accounting event.
Successful direct, nested, and fully consumed streaming calls emit it once
independent of content-event opt-in; failed attempts and failed/abandoned
streams do not. A later content block does not erase completed model work.
Do not count `model.message`, `model.object`, or deltas again.

## Error Families
All `HarnessError` instances carry `code`, `category`, `retriable`, `message`, and optional sanitized `meta`.

Common classes:
- `HarnessConfigError`
- `ValidationError`
- `PermissionDeniedError`
- `DecisionBlockedError`
- `DecisionEvaluationError`
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
