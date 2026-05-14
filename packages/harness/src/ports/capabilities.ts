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
  /** Runtime can commit stable checkpoints. */
  | 'runtime.checkpoint'
  /** Runtime can retry durable boundaries. */
  | 'runtime.retry'
  /** Runtime can coordinate distributed session/run ownership. */
  | 'runtime.distributed_lock'
  /** Runtime can resume from committed checkpoints. */
  | 'runtime.resume_from_checkpoint'
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
  readonly kind: 'state' | 'sandbox' | 'runtime' | 'feedback' | 'model' | 'memory'
  readonly id: string
  readonly capabilities: readonly AdapterCapability[]
  readonly metadata?: Record<string, unknown>
}

/** Data-only snapshot of resolved harness setup. */
export interface HarnessInspection {
  readonly name: string
  readonly capabilities: readonly AdapterCapability[]
  readonly requiredCapabilities: readonly AdapterCapability[]
  readonly adapters: readonly AdapterInspection[]
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
