import type { Logger } from '../../logger/index.js'
import type { ContentCaptureMode } from '../../harness/defineHarness.js'
import type { JsonValue } from '../../models/json.js'
import type { SandboxSession } from '../../sandbox/index.js'
import type { Metrics, TelemetryShim } from '../../telemetry/index.js'
import type { AdapterCapability, AdapterCapabilities } from '../capabilities.js'
import type { HarnessContextConfigurable } from '../harness-context.js'

/** Logical memory scope kinds supported by the harness facade. */
export type MemoryScopeKind = 'run' | 'session' | 'agent' | 'user' | 'tenant'

/**
 * Concrete scope used to namespace memory entries.
 *
 * @example
 * ```ts
 * await ctx.memory.scope({ kind: 'user', userId: 'u_123' }).write('locale', 'de-DE')
 * ```
 */
export interface MemoryScope {
  /** Scope discriminator. */
  kind: MemoryScopeKind
  /** Harness session id for session-local and run-local memory. */
  sessionId?: string
  /** Harness run id for run-local memory. */
  runId?: string
  /** Agent id for agent-scoped memory. */
  agentId?: string
  /** Workflow id attached for observability when memory is used inside a workflow. */
  workflowId?: string
  /** Application-owned user id for user-scoped memory. */
  userId?: string
  /** Application-owned tenant id for tenant-scoped memory. */
  tenantId?: string
}

/** Adapter capabilities are normal harness adapter capabilities with memory-specific names. */
export type MemoryCapability = Extract<AdapterCapability, `memory.${string}`>

/** Data-only adapter descriptor used for validation, inspection, and `.requires(...)`. */
export interface MemoryAdapterInfo {
  /** Stable adapter id, for example `sandbox_memory` or `redis_memory`. */
  id: string
  /** Package that provides the adapter factory. */
  packageName: string
  /** Optional adapter package version for diagnostics. */
  version?: string
  /** Memory capabilities implemented by this adapter. */
  capabilities: readonly MemoryCapability[]
}

/** Per-open context passed to memory adapters. Core owns the standard telemetry wrapper. */
export interface MemoryOpenContext {
  /** Harness logger inherited by the adapter. */
  readonly logger: Logger
  /** Harness telemetry shim for adapter-specific nested spans. */
  readonly telemetry: TelemetryShim
  /** Harness metrics helper for adapter-specific metrics. */
  readonly metrics: Metrics
  /** Content capture policy; adapters must respect this for custom telemetry/logs. */
  readonly contentCaptureMode: ContentCaptureMode
  /** Cancellation signal for the memory operation. */
  readonly signal: AbortSignal
  /** Present for the core `sandboxMemory()` adapter and adapters that intentionally compose with the sandbox. */
  readonly sandbox?: SandboxSession
}

/** Operation names emitted as memory span/metric attributes. */
export type MemoryOperation = 'get' | 'set' | 'delete' | 'list' | 'search'

/** Per-operation context passed to memory stores. */
export interface MemoryOperationContext extends MemoryOpenContext {
  /** Concrete scope for this operation. */
  readonly scope: MemoryScope
  /** Operation currently being executed. */
  readonly operation: MemoryOperation
}

/** Optional write behavior for adapters that support tags, metadata, or TTL. */
export interface MemoryWriteOptions {
  /** Positive expiry duration in milliseconds. Requires `memory.ttl`. */
  ttlMs?: number
  /** Optional index/filter tags. */
  tags?: readonly string[]
  /** Optional JSON metadata stored beside the value. */
  metadata?: Record<string, JsonValue>
}

/** Listing options supported by the facade. */
export interface MemoryListOptions {
  /** Return keys with this prefix only. */
  prefix?: string
  /** Maximum entries to return. Defaults to `100`, maximum `1000`. */
  limit?: number
  /** Adapter-defined cursor; the built-in adapter treats this as the last key. */
  cursor?: string
}

/** Metadata-only memory entry returned from `list`. */
export interface MemoryEntry {
  /** Memory key without backend-specific path or extension. */
  key: string
  /** ISO creation timestamp when the adapter tracks it. */
  createdAt?: string
  /** ISO update timestamp when the adapter tracks it. */
  updatedAt?: string
  /** ISO expiry timestamp when the adapter tracks TTL. */
  expiresAt?: string
  /** Optional index/filter tags. */
  tags?: readonly string[]
  /** Optional JSON metadata. */
  metadata?: Record<string, JsonValue>
}

/** Text search query used by adapters with `memory.search`. */
export interface MemorySearchQuery {
  /** Search text. Empty strings are rejected before adapter I/O. */
  text: string
  /** Maximum results. Defaults to `100`, maximum `1000`. */
  limit?: number
  /** Optional tag filter. */
  tags?: readonly string[]
  /** Optional metadata filter. */
  metadata?: Record<string, JsonValue>
}

/** Search result returned by adapters with `memory.search`. */
export interface MemorySearchResult {
  /** Memory key for the matched entry. */
  key: string
  /** Adapter-defined relevance score. */
  score?: number
  /** Optional value payload. Treat as content for telemetry/logging. */
  value?: JsonValue
  /** Optional JSON metadata. */
  metadata?: Record<string, JsonValue>
}

/** Backend store opened for one concrete memory scope. */
export interface MemoryStore {
  /** Reads a JSON value by key. */
  get<T = JsonValue>(key: string, ctx: MemoryOperationContext): Promise<T | undefined>
  /** Writes a JSON value by key. */
  set(key: string, value: JsonValue, ctx: MemoryOperationContext & { opts?: MemoryWriteOptions }): Promise<void>
  /** Deletes a key if it exists. */
  delete(key: string, ctx: MemoryOperationContext): Promise<void>
  /** Lists memory entries in the opened scope. */
  list(ctx: MemoryOperationContext & { opts?: MemoryListOptions }): Promise<MemoryEntry[]>
  /** Searches memory when the adapter advertises `memory.search`. */
  search?(query: MemorySearchQuery, ctx: MemoryOperationContext): Promise<MemorySearchResult[]>
}

/** Pluggable memory backend. External implementations belong in `@purista/harness-memory-*` packages. */
export interface MemoryAdapter extends HarnessContextConfigurable, AdapterCapabilities {
  /** Static adapter metadata used for validation and inspection. */
  readonly info: MemoryAdapterInfo
  /** Adapter capability list mirrored from `info.capabilities`. */
  readonly capabilities: readonly MemoryCapability[]
  /** Opens a backend store for one scope. */
  open(scope: MemoryScope, ctx: MemoryOpenContext): Promise<MemoryStore>
  /** Releases adapter-owned resources. */
  close?(): Promise<void>
}

/** Session-scoped public key/value facade. */
export interface SessionMemory {
  /** Reads a JSON value by key. Returns `undefined` when absent. */
  read<T = JsonValue>(key: string): Promise<T | undefined>
  /** Writes a JSON-serializable value by key. */
  write(key: string, value: JsonValue, opts?: MemoryWriteOptions): Promise<void>
  /** Deletes a key if it exists. */
  delete(key: string): Promise<void>
  /** Lists keys in this scope. */
  list(opts?: MemoryListOptions): Promise<string[]>
  /** Searches memory, or throws `ModelCapabilityError` when the adapter does not support `memory.search`. */
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>
}

/**
 * Scoped memory helper exposed to workflows, agents, and TypeScript tools.
 *
 * @example
 * ```ts
 * await ctx.memory.session.write('last_topic', { value: 'pricing' })
 * const prior = await ctx.memory.user().read<{ value: string }>('preference')
 * ```
 */
export interface MemoryFacade {
  /** Session-scoped memory for the current conversation thread. */
  session: SessionMemory
  /** Run-scoped memory for the current agent or workflow run. */
  run: SessionMemory
  /** Agent-scoped memory, present in agent and tool contexts. */
  agent?: SessionMemory
  /** User-scoped memory using the explicit id or `metadata.userId`. */
  user(userId?: string): SessionMemory
  /** Tenant-scoped memory using the explicit id or `metadata.tenantId`. */
  tenant(tenantId?: string): SessionMemory
  /** Creates a memory handle for an explicit scope. */
  scope(scope: MemoryScope): SessionMemory
}

/** Internal options for creating a scoped memory facade. */
export interface CreateMemoryFacadeOptions {
  adapter: MemoryAdapter
  logger: Logger
  telemetry: TelemetryShim
  contentCaptureMode: ContentCaptureMode
  signal: AbortSignal
  sandbox?: SandboxSession
  harnessName: string
  sessionId: string
  runId?: string
  agentId?: string
  workflowId?: string
  metadata?: Readonly<Record<string, JsonValue>>
}
