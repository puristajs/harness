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
  /** Sandbox mounts the active DurableWorkspace into a run-scoped session. */
  | 'sandbox.workspace_binding'
  /** Sandbox can create durable snapshots. */
  | 'sandbox.snapshot'
  /** Sandbox can resume a session from a durable snapshot. */
  | 'sandbox.resume'
  /** Sandbox can snapshot and release active compute. */
  | 'sandbox.hibernate'
  /** Sandbox can host a long-lived process with streaming stdin/stdout. */
  | 'sandbox.spawn'
  /** Sandbox may preserve provider-managed live processes across detach. */
  | 'sandbox.live_process_preservation'
  /** Storage can commit stable durable-step checkpoints. */
  | 'storage.checkpoint'
  /** Storage can retry interrupted durable runs. */
  | 'storage.retry'
  /** Storage can coordinate distributed session/run ownership. */
  | 'storage.multi_instance'
  /** Storage can resume from committed checkpoints. */
  | 'storage.resume'
  /** Storage checkpoints can carry durable workspace references. */
  | 'storage.workspace_checkpoint'
  /** Storage exposes checkpoint retention and expiry metadata. */
  | 'storage.checkpoint_retention'
  /** Storage state survives process exit. */
  | 'storage.persistent'
  /** Storage supports durable, idempotently signalled external waits. */
  | 'storage.external_wait'
  /** Workspace implements durable lifecycle and opaque checkpoint refs. */
  | 'workspace.durable'
  /** Workspace persists state beyond process exit. */
  | 'workspace.persistent'
  /** Workspace can produce stable checkpoints. */
  | 'workspace.checkpoint'
  /** Workspace can resume committed checkpoints. */
  | 'workspace.resume'
  /** Workspace can abort active or paused workspaces. */
  | 'workspace.abort'
  /** Workspace supports idempotent cleanup. */
  | 'workspace.cleanup'
  /** Workspace supports read-only inspection. */
  | 'workspace.inspect'
  /** Workspace exposes retention policy and expiry metadata. */
  | 'workspace.retention'
  /** Workspace enforces and reports quota policy. */
  | 'workspace.quota'
  /** Workspace encrypts checkpoint, snapshot, file, and metadata storage. */
  | 'workspace.encrypted_storage'
  /** Adapter can record feedback. */
  | 'feedback.record'
  /** Memory adapter supports key/value reads and writes. */
  | 'memory.kv'
  /** Memory adapter supports key listing. */
  | 'memory.list'
  /** Memory adapter supports key deletion. */
  | 'memory.delete'
  /** Memory engine supports text search over stored memory. */
  | 'memory.text_search'
  /** Memory engine supports vector similarity search. */
  | 'memory.vector_search'
  /** Memory engine supports native hybrid search. */
  | 'memory.hybrid_search'
  /** Memory adapter supports entry expiration. */
  | 'memory.ttl'
  /** Memory survives adapter close/reopen for the same logical scope. */
  | 'memory.persistent'
  /** Memory is designed for coordinated multi-instance access. */
  | 'memory.multi_instance'

/** Data-only descriptor implemented by adapters that expose capability metadata. */
export interface AdapterCapabilities {
  readonly capabilities: readonly AdapterCapability[]
}

/** Adapter descriptor surfaced through `harness.inspect()`. */
export interface AdapterInspection {
  readonly kind: 'storage' | 'sandbox' | 'workspace' | 'feedback' | 'model' | 'memory'
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
