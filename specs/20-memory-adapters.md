# Memory adapters

**Purpose.** Defines the pluggable memory system used by sessions, agents, workflows, and tools. Memory is a core harness port with one built-in reference adapter. Every non-core memory backend MUST live in its own package and depend only on the public `@purista/harness` adapter types.

## Goals

- Preserve the existing developer workflow: `session.memory.read/write/delete/list` continues to work.
- Make memory storage pluggable through a single adapter port.
- Keep core backend-neutral. Core owns the port, facade, telemetry wrapper, validation, and the sandbox-backed reference adapter.
- Support different project memory needs without implementation-time decisions: ephemeral run memory, per-session memory, persistent agent memory, tenant/user memory, and semantic search when the adapter supports it.
- Keep telemetry secure by default. Core emits no memory content unless content capture is explicitly enabled.
- Let adapter authors add custom spans and metrics through the adapter context without reimplementing the standard memory telemetry wrapper.

## Package ownership

| Package | Ownership |
| --- | --- |
| `@purista/harness` | `MemoryAdapter` public types, `SessionMemory` facade, standard telemetry/metrics wrapper, `sandboxMemory()` reference adapter, memory testing contract. |
| `@purista/harness-memory-*` | External memory adapters such as Redis, Postgres, vector DB, graph DB, or product-specific providers. |
| Cloudgrid adapter packages | Out of scope for this repo; they MAY consume the public memory adapter port. |

External memory adapter packages MUST NOT import `@purista/harness` internals, MUST NOT depend on each other, and MUST NOT be required by core tests.

## Builder integration

```ts
defineHarness()
  .telemetry({ contentCaptureMode: 'NO_CONTENT' })
  .memory(sandboxMemory())          // optional; default is sandboxMemory()
  .models({ /* ... */ })
  .agents({ /* ... */ })
  .build()
```

`.memory(adapter)` is an optional foundation-stage builder method. It is callable at most once after `.sandbox(...)` and before `.runtime(...)`, `.requires(...)`, `.defaults(...)`, or any domain method. If omitted, `sandboxMemory()` is used.

Validation rules:

- The adapter value MUST implement `MemoryAdapter`.
- `adapter.info.id` MUST match `/^[a-z][a-z0-9_.-]{1,63}$/`.
- `adapter.info.packageName` MUST be a non-empty package-like string.
- `adapter.info.capabilities` MUST contain at least `'memory.kv'`.
- `build()` MUST call `configureHarnessContext(context)` on the memory adapter before any session opens.
- `.requires([...])` evaluates memory adapter capabilities together with sandbox, state, model, and runtime capabilities.

## Scopes

```ts
type MemoryScopeKind = 'run' | 'session' | 'agent' | 'user' | 'tenant'

interface MemoryScope {
  kind: MemoryScopeKind
  sessionId?: string
  runId?: string
  agentId?: string
  workflowId?: string
  userId?: string
  tenantId?: string
}
```

Scope rules:

- `session`: per conversation thread. Requires `sessionId`.
- `run`: per single agent/workflow run. Requires `sessionId` and `runId`. Core provides an in-process run store even when the configured adapter does not persist run memory.
- `agent`: memory for one agent across sessions. Requires `agentId`. It MAY also include `userId` or `tenantId`.
- `user`: memory for one application user across sessions. Requires `userId`.
- `tenant`: memory shared inside one tenant. Requires `tenantId`.
- If `userId` or `tenantId` is required by the selected scope and not available in `InvokeOptions.metadata`, the facade throws `ValidationError{where:'memory_scope', meta.reason:'missing_scope_identifier'}` before calling the adapter.
- Core never derives `userId` or `tenantId` from `sessionId`. Applications must provide them explicitly through sanitized metadata.

Default public handles:

- `session.memory` is bound to `scope.kind = 'session'`.
- `ctx.memory.session` is bound to the current session.
- `ctx.memory.run` is bound to the current run.
- `ctx.memory.agent` is bound to the current agent for agent and tool contexts; workflow contexts do not expose `agent`.
- `ctx.memory.user(userId?)` and `ctx.memory.tenant(tenantId?)` create explicit scoped handles. When no argument is passed, the facade reads `metadata.userId` or `metadata.tenantId`.

## Public facade

`SessionMemory` remains the simple KV facade for compatibility with current code and docs:

```ts
interface SessionMemory {
  read<T = JsonValue>(key: string): Promise<T | undefined>
  write(key: string, value: JsonValue, opts?: MemoryWriteOptions): Promise<void>
  delete(key: string): Promise<void>
  list(opts?: MemoryListOptions): Promise<string[]>
  search?(query: MemorySearchQuery): Promise<MemorySearchResult[]>
}
```

`MemoryFacade` is exposed inside run contexts:

```ts
interface MemoryFacade {
  session: SessionMemory
  run: SessionMemory
  agent?: SessionMemory
  user(userId?: string): SessionMemory
  tenant(tenantId?: string): SessionMemory
  scope(scope: MemoryScope): SessionMemory
}
```

Core MUST implement all public handles by wrapping the configured adapter. Application and agent code never calls `MemoryAdapter` directly.

## Adapter port

```ts
type MemoryCapability =
  | 'memory.kv'
  | 'memory.list'
  | 'memory.delete'
  | 'memory.search'
  | 'memory.ttl'
  | 'memory.run'
  | 'memory.session'
  | 'memory.agent'
  | 'memory.user'
  | 'memory.tenant'
  | 'memory.persistent'

interface MemoryAdapterInfo {
  id: string
  packageName: string
  version?: string
  capabilities: readonly MemoryCapability[]
}

interface MemoryAdapter extends HarnessContextConfigurable {
  readonly info: MemoryAdapterInfo
  open(scope: MemoryScope, ctx: MemoryOpenContext): Promise<MemoryStore>
  close?(): Promise<void>
}

interface MemoryOpenContext {
  readonly logger: Logger
  readonly telemetry: TelemetryShim
  readonly metrics: Metrics
  readonly contentCaptureMode: ContentCaptureMode
  readonly signal: AbortSignal
}

interface MemoryStore {
  get<T = JsonValue>(key: string, ctx: MemoryOperationContext): Promise<T | undefined>
  set(key: string, value: JsonValue, ctx: MemoryOperationContext & { opts?: MemoryWriteOptions }): Promise<void>
  delete(key: string, ctx: MemoryOperationContext): Promise<void>
  list(ctx: MemoryOperationContext & { opts?: MemoryListOptions }): Promise<MemoryEntry[]>
  search?(query: MemorySearchQuery, ctx: MemoryOperationContext): Promise<MemorySearchResult[]>
}

interface MemoryOperationContext {
  readonly scope: MemoryScope
  readonly operation: MemoryOperation
  readonly logger: Logger
  readonly telemetry: TelemetryShim
  readonly metrics: Metrics
  readonly contentCaptureMode: ContentCaptureMode
  readonly signal: AbortSignal
}
```

Every `MemoryCapability` is also an `AdapterCapability`, so `.requires([...])`
can gate memory capabilities at build time.

Operation names:

```ts
type MemoryOperation = 'get' | 'set' | 'delete' | 'list' | 'search'
```

Adapter behavior:

- Adapters MUST honor `signal`.
- Adapters MUST throw `OperationCancelledError{meta.scope:'memory'}` on cancellation.
- Adapter-specific failures MUST be wrapped in `StateError{meta.adapter:'memory', meta.memory_provider:<id>}` unless the failure is already a `HarnessError`.
- Adapters MUST NOT emit the standard memory spans or metrics. Core emits them around every facade call.
- Adapters MAY emit additional nested spans and custom metrics through `ctx.telemetry` and `ctx.metrics`.
- Adapters MUST NOT add raw memory key, value, query, or result content to custom telemetry unless `ctx.contentCaptureMode` is not `NO_CONTENT`.

## Data contracts

```ts
interface MemoryWriteOptions {
  ttlMs?: number
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

interface MemoryListOptions {
  prefix?: string
  limit?: number
  cursor?: string
}

interface MemoryEntry {
  key: string
  createdAt?: string
  updatedAt?: string
  expiresAt?: string
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

interface MemorySearchQuery {
  text: string
  limit?: number
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

interface MemorySearchResult {
  key: string
  score?: number
  value?: JsonValue
  metadata?: Record<string, JsonValue>
}
```

Validation rules enforced by core before adapter calls:

- `key` regex `/^[A-Za-z0-9_.\-:]{1,256}$/`.
- `value` MUST be JSON-serializable.
- `ttlMs` MUST be a positive integer when provided.
- `tags[]` entries MUST match `/^[A-Za-z0-9_.\-:]{1,64}$/`.
- `metadata` uses the same sanitized scalar/object JSON rules as `InvokeOptions.metadata`; functions, symbols, BigInt, and circular refs are rejected.
- `list.limit` and `search.limit` default to `100`, maximum `1000`, and reject `<=0`.
- `search.text` MUST be non-empty after trim and at most `8000` characters.

Capability behavior:

- If `search` is called and the adapter lacks `'memory.search'` or omits `store.search`, throw `ModelCapabilityError{meta.reason:'memory_search_unavailable'}` before adapter I/O.
- If `ttlMs` is provided and the adapter lacks `'memory.ttl'`, throw `ValidationError{where:'memory_write_options', meta.reason:'ttl_unsupported'}` before adapter I/O.
- If a scope kind is unsupported by the adapter capabilities, throw `ValidationError{where:'memory_scope', meta.reason:'scope_unsupported'}` before adapter I/O.

## Reference adapter: `sandboxMemory()`

`sandboxMemory()` is the built-in reference adapter in `@purista/harness`.

Behavior:

- Supports capabilities: `'memory.kv'`, `'memory.list'`, `'memory.delete'`, `'memory.run'`, `'memory.session'`.
- Session scope stores JSON files in `/memory/session/<key>.json` inside the session sandbox.
- Run scope stores JSON files in `/memory/runs/<runId>/<key>.json` inside the session sandbox.
- For compatibility with the current implementation, the adapter MUST also read existing `/memory/<key>.json` files for session scope when `/memory/session/<key>.json` is absent.
- New session writes MUST use `/memory/session/<key>.json`.
- `list()` for session scope MUST merge keys from `/memory/session/*.json` and legacy `/memory/*.json`, deduplicate by key, and prefer the new path for reads.
- Search is unsupported and MUST fail through the core capability gate.
- `ttlMs`, `tags`, and `metadata` are accepted only when they can be represented in a sidecar `/memory/.meta/<scope>/<key>.json`; v1 implementation MUST reject `ttlMs` because the reference adapter does not run expiry jobs.
- Atomicity is per key. Writes serialize to a string first, then write one file.
- Persistence equals sandbox persistence. The default in-memory sandbox loses all memory on process exit; persistent sandbox adapters may retain memory files.

## Telemetry

Core emits one span around every facade operation:

| Operation | Span name |
| --- | --- |
| get | `harness.memory.get` |
| set | `harness.memory.set` |
| delete | `harness.memory.delete` |
| list | `harness.memory.list` |
| search | `harness.memory.search` |

Required span attributes:

| Key | Type |
| --- | --- |
| `harness.memory.provider` | string |
| `harness.memory.operation` | string |
| `harness.memory.scope` | string |
| `harness.memory.capability` | string |
| `harness.memory.key_hash` | string, only for key-based operations |
| `harness.memory.hit` | boolean, only for `get` |
| `harness.memory.result_count` | integer, for `list` and `search` |
| `harness.memory.content_captured` | boolean |
| `harness.session.id` | string when available |
| `harness.run.id` | string when available |
| `harness.agent.id` | string when available |
| `harness.workflow.id` | string when available |
| `error.type` | string on failure |

`harness.memory.key_hash` is `sha256(key)` encoded as lowercase hex. Raw keys are content and MUST NOT be emitted when `contentCaptureMode` is `NO_CONTENT`.

Content capture:

- `NO_CONTENT`: no raw key, value, query text, search result value, or metadata content is emitted.
- `SPAN_ONLY`: core MAY add `harness.memory.key`, `harness.memory.query`, and JSON string attributes for values/results when the operation-specific value is JSON-serializable and ≤8192 bytes after serialization.
- `EVENT_ONLY`: core MAY emit `harness.memory.content` span events with the same fields instead of span attributes.
- `SPAN_AND_EVENT`: core MAY emit both span attributes and span events.
- Adapters do not implement this policy. Core applies it before and after adapter calls.

Standard metrics:

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `harness.memory.operation.duration` | Histogram | `s` | `harness.memory.provider`, `harness.memory.operation`, `harness.memory.scope`, `error.type` |
| `harness.memory.operations` | Counter | `1` | `harness.memory.provider`, `harness.memory.operation`, `harness.memory.scope`, `harness.memory.hit`, `error.type` |
| `harness.memory.search.results` | Histogram | `1` | `harness.memory.provider`, `harness.memory.scope` |

Metrics MUST NOT include raw keys, values, queries, tags, metadata, user ids, or tenant ids.

## Evaluation and optimization

Memory makes evaluation non-deterministic unless pinned. Eval-oriented harness runs MUST use exactly one of these modes:

```ts
type EvalMemoryMode =
  | { kind: 'disabled' }
  | { kind: 'fixture'; adapter: MemoryAdapter }
  | { kind: 'snapshot'; id: string; adapter: MemoryAdapter }
```

Core v1 does not add a full eval runner memory API, but specs require implementation agents to keep memory facade calls deterministic in tests:

- Unit and contract tests use `sandboxMemory()` or a fake memory adapter.
- Prompt candidate evaluation helpers MUST NOT read or write harness memory unless the caller does so inside `runCandidate`.
- Run summaries MUST NOT depend on sampled spans to report memory operation counts in v1. Memory operation counts may be added later through `StateStore` event data, not OTel span inspection.

## Example

```ts
const harness = defineHarness()
  .memory(sandboxMemory())
  .models({ fast: { provider, model: 'gpt-4.1-mini', capabilities: ['text'] } })
  .agents({
    assistant: {
      model: 'fast',
      async instructions(ctx) {
        const topic = await ctx.memory.session.read<{ value: string }>('last_topic')
        return topic ? `Continue from ${topic.value}.` : 'Help the user.'
      },
      async handler(ctx) {
        await ctx.memory.session.write('last_topic', { value: 'pricing' })
        ctx.metrics.counter('app.memory.preference_updates', 1)
        return 'ok'
      }
    }
  })
  .build()
```

## Cross-references

- [01-architecture](./01-architecture.md)
- [02-harness-config](./02-harness-config.md)
- [03-foundation](./03-foundation.md)
- [09-agents](./09-agents.md)
- [10-workflows](./10-workflows.md)
- [11-sessions](./11-sessions.md)
- [13-public-api](./13-public-api.md)
- [14-otel-conventions](./14-otel-conventions.md)
- [16-testing](./16-testing.md)
