import { HarnessConfigError } from '../errors/catalog.js'
import type { JsonValue } from '../models/json.js'
import type { AdapterCapabilities, AdapterCapability } from './capabilities.js'
import type { HarnessAdapterContext } from './harness-context.js'

/** Typed long-horizon record written explicitly by workflow or agent code. */
export interface ContextCheckpoint {
  /** Stable run id this checkpoint belongs to. */
  runId: string
  /** Stable session id this checkpoint belongs to. */
  sessionId: string
  /** Workflow id when written from a workflow context. */
  workflowId?: string
  /** Agent id when written from an agent context. */
  agentId?: string
  /** Monotonic sequence selected by caller or policy. */
  sequence: number
  /** Checkpoint purpose. */
  kind: 'summary' | 'handoff' | 'goal_state'
  /** JSON payload. Never emitted in harness telemetry. */
  payload: JsonValue
  /** UTF-8 JSON payload size. */
  payloadSizeBytes: number
  /** ISO timestamp. */
  createdAt: string
  /** Privacy-safe operational metadata only. */
  metadata?: Record<string, JsonValue>
}

/** Stable reference to one context checkpoint. */
export interface ContextCheckpointRef {
  runId: string
  sessionId: string
  sequence: number
  kind: ContextCheckpoint['kind']
}

/** Query accepted by context checkpoint stores. */
export interface ContextCheckpointQuery {
  runId?: string
  sessionId?: string
  workflowId?: string
  agentId?: string
  kind?: ContextCheckpoint['kind']
  limit?: number
  signal?: AbortSignal
}

/** Data-only descriptor for a context checkpoint store. */
export interface ContextCheckpointStoreInfo {
  id: string
  packageName: string
  capabilities: readonly AdapterCapability[]
}

/** Adapter port for explicit context checkpoint persistence. */
export interface ContextCheckpointStore extends AdapterCapabilities {
  readonly info: ContextCheckpointStoreInfo
  configureHarnessContext?(context: HarnessAdapterContext): void
  write(checkpoint: ContextCheckpoint, opts?: { signal?: AbortSignal }): Promise<void>
  list(query: ContextCheckpointQuery): Promise<readonly ContextCheckpoint[]>
  read(ref: ContextCheckpointRef): Promise<ContextCheckpoint | undefined>
  delete(ref: ContextCheckpointRef): Promise<void>
  close?(): Promise<void>
}

const adapterIdPattern = /^[a-z][a-z0-9_.-]{1,63}$/

/** Validates the context checkpoint adapter descriptor at harness build time. */
export function validateContextCheckpointStore(adapter: ContextCheckpointStore): void {
  if (!adapterIdPattern.test(adapter.info.id)) {
    throw new HarnessConfigError('Context checkpoint store id is invalid.', {
      reason: 'invalid_context_checkpoint_store',
      path: 'checkpoints.info.id',
      id: adapter.info.id
    })
  }
  if (!adapter.info.packageName.trim()) {
    throw new HarnessConfigError('Context checkpoint store packageName is required.', {
      reason: 'invalid_context_checkpoint_store',
      path: 'checkpoints.info.packageName',
      id: adapter.info.id
    })
  }
  if (!adapter.info.capabilities.includes('context_checkpoint.write')) {
    throw new HarnessConfigError('Context checkpoint store must support context_checkpoint.write.', {
      reason: 'invalid_context_checkpoint_store',
      path: 'checkpoints.info.capabilities',
      id: adapter.info.id
    })
  }
  if (adapter.info.capabilities.some((capability) => !adapter.capabilities.includes(capability))) {
    throw new HarnessConfigError('Context checkpoint store capabilities must include info.capabilities.', {
      reason: 'invalid_context_checkpoint_store',
      path: 'checkpoints.capabilities',
      id: adapter.info.id
    })
  }
}
