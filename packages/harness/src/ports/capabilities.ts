/**
 * Stable capability ids declared by non-model harness adapters.
 *
 * Adapter capabilities describe setup-level behavior the harness may rely on.
 * They are separate from `ModelCapability`, which describes model operations.
 */
export type AdapterCapability =
  /** Sandbox supports filesystem access. */
  | 'sandbox.fs'
  /** Sandbox supports command execution. */
  | 'sandbox.exec'
  /** Sandbox filesystem survives adapter-level close/reopen for the same session. */
  | 'sandbox.persistent_fs'
  /** Sandbox can create durable snapshots. */
  | 'sandbox.snapshot'
  /** Sandbox can resume a session from a durable snapshot. */
  | 'sandbox.resume'
  /** Sandbox can snapshot and release active compute. */
  | 'sandbox.hibernate'
  /** Sandbox can host a long-lived process with streaming stdin/stdout. */
  | 'sandbox.spawn'
  /** Runtime can commit stable checkpoints. */
  | 'runtime.checkpoint'
  /** Runtime can retry durable boundaries. */
  | 'runtime.retry'
  /** Runtime can coordinate distributed session/run ownership. */
  | 'runtime.distributed_lock'
  /** Runtime can resume from committed checkpoints. */
  | 'runtime.resume_from_checkpoint'
  /** Runtime checkpoint records can carry durable workspace references. */
  | 'runtime.workspace_checkpoint'
  /** Runtime exposes checkpoint retention and expiry metadata. */
  | 'runtime.checkpoint_retention'
  /** Runtime checkpoints, leases, and terminal state survive process exit. */
  | 'runtime.persistent'
  /** Workspace store implements durable lifecycle and opaque checkpoint refs. */
  | 'workspace_store.durable'
  /** Workspace store persists state beyond process exit. */
  | 'workspace_store.persistent'
  /** Workspace store can produce stable checkpoints. */
  | 'workspace_store.checkpoint'
  /** Workspace store can resume committed checkpoints. */
  | 'workspace_store.resume'
  /** Workspace store can abort active or paused workspaces. */
  | 'workspace_store.abort'
  /** Workspace store supports idempotent cleanup. */
  | 'workspace_store.cleanup'
  /** Workspace store supports read-only inspection. */
  | 'workspace_store.inspect'
  /** Workspace store exposes retention policy and expiry metadata. */
  | 'workspace_store.retention'
  /** Workspace store enforces and reports quota policy. */
  | 'workspace_store.quota'
  /** Workspace store encrypts checkpoint, snapshot, file, and metadata storage. */
  | 'workspace_store.encrypted_storage'
  /** Context checkpoint store can write checkpoints. */
  | 'context_checkpoint.write'
  /** Context checkpoint store can read checkpoints. */
  | 'context_checkpoint.read'
  /** Context checkpoint store can list checkpoints. */
  | 'context_checkpoint.list'
  /** Context checkpoint store can delete checkpoints. */
  | 'context_checkpoint.delete'
  /** Context checkpoint store survives adapter close/reopen. */
  | 'context_checkpoint.persistent'
  /** Adapter can record feedback. */
  | 'feedback.record'
  /** Memory adapter supports key/value reads and writes. */
  | 'memory.kv'
  /** Memory adapter supports key listing. */
  | 'memory.list'
  /** Memory adapter supports key deletion. */
  | 'memory.delete'
  /** Memory adapter supports text search over stored memory. */
  | 'memory.search'
  /** Memory adapter supports entry expiration. */
  | 'memory.ttl'
  /** Memory adapter supports run-scoped memory. */
  | 'memory.run'
  /** Memory adapter supports session-scoped memory. */
  | 'memory.session'
  /** Memory adapter supports agent-scoped memory. */
  | 'memory.agent'
  /** Memory adapter supports user-scoped memory. */
  | 'memory.user'
  /** Memory adapter supports tenant-scoped memory. */
  | 'memory.tenant'
  /** Memory survives adapter close/reopen for the same logical scope. */
  | 'memory.persistent'

/** Data-only descriptor implemented by adapters that expose capability metadata. */
export interface AdapterCapabilities {
  readonly capabilities: readonly AdapterCapability[]
}

/** Adapter descriptor surfaced through `harness.inspect()`. */
export interface AdapterInspection {
  readonly kind: 'state' | 'sandbox' | 'runtime' | 'workspace_store' | 'context_checkpoint' | 'feedback' | 'model' | 'memory'
  readonly id: string
  readonly capabilities: readonly AdapterCapability[]
  readonly metadata?: Record<string, unknown>
}

/** Data-only definition contribution recorded for a local static module. */
export interface HarnessModuleContribution {
  readonly kind: 'model' | 'tool' | 'skill' | 'agent' | 'workflow' | 'foundation'
  readonly ids: readonly string[]
}

/** Immutable provenance row surfaced by {@link HarnessInspection}. */
export interface HarnessModuleInspection {
  readonly id: string
  readonly version?: string
  readonly requires: readonly AdapterCapability[]
  readonly contributions: readonly HarnessModuleContribution[]
}

/** Data-only snapshot of resolved harness setup. */
export interface HarnessInspection {
  readonly name: string
  readonly capabilities: readonly AdapterCapability[]
  readonly requiredCapabilities: readonly AdapterCapability[]
  readonly adapters: readonly AdapterInspection[]
  readonly modules: readonly HarnessModuleInspection[]
}

/** Optional durable runtime adapter surface for capability-gated setup. */
export interface DurableRuntimeAdapter extends AdapterCapabilities {
  readonly id?: string
}

/** Result returned when comparing required and available adapter capabilities. */
export interface AdapterCapabilityValidation {
  readonly required: readonly AdapterCapability[]
  readonly available: readonly AdapterCapability[]
  readonly missing: readonly AdapterCapability[]
  readonly ok: boolean
}

/** Returns `true` when a value exposes an adapter capability descriptor. */
export function hasAdapterCapabilities(value: unknown): value is AdapterCapabilities {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as { capabilities?: unknown }).capabilities)
  )
}

/** Deduplicates capabilities while preserving first-seen order. */
export function uniqueCapabilities(capabilities: readonly AdapterCapability[]): readonly AdapterCapability[] {
  return [...new Set(capabilities)]
}

/** Returns the required capabilities that are not present in `available`. */
export function missingCapabilities(
  required: readonly AdapterCapability[],
  available: readonly AdapterCapability[]
): readonly AdapterCapability[] {
  const availableSet = new Set(available)
  return uniqueCapabilities(required).filter((capability) => !availableSet.has(capability))
}

/** Aggregates effective capabilities from adapter descriptors. */
export function collectAdapterCapabilities(
  adapters: readonly (AdapterCapabilities | undefined | null)[]
): readonly AdapterCapability[] {
  return uniqueCapabilities(adapters.flatMap((adapter) => adapter?.capabilities ?? []))
}

/** Compares required capabilities with the currently available capability set. */
export function validateAdapterCapabilities(
  required: readonly AdapterCapability[],
  available: readonly AdapterCapability[]
): AdapterCapabilityValidation {
  const requiredCapabilities = uniqueCapabilities(required)
  const availableCapabilities = uniqueCapabilities(available)
  const missing = missingCapabilities(requiredCapabilities, availableCapabilities)

  return {
    required: requiredCapabilities,
    available: availableCapabilities,
    missing,
    ok: missing.length === 0
  }
}

/** Throws when required adapter capabilities are missing. */
export function assertAdapterCapabilities(
  required: readonly AdapterCapability[],
  available: readonly AdapterCapability[],
  message = 'Required adapter capabilities are not available.'
): void {
  const result = validateAdapterCapabilities(required, available)
  if (!result.ok) {
    throw new Error(`${message} Missing: ${result.missing.join(', ')}`)
  }
}
