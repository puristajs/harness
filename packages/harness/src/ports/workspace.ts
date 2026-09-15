import { HarnessConfigError } from '../errors/catalog.js'
import type { JsonValue } from '../models/json.js'
import type { AdapterCapabilities, AdapterCapability } from './capabilities.js'
import type { HarnessAdapterContext } from './harness-context.js'
import type { SandboxOwner, SandboxPartition } from '../sandbox/ownership.js'
import type { SandboxAdministration } from '../sandbox/administration.js'

export type WorkspaceLifecycleState =
  | 'active'
  | 'paused'
  | 'terminal'
  | 'aborted'
  | 'cleanup_pending'
  | 'cleaned'

export interface WorkspaceRetentionPolicy {
  activeTtlMs?: number
  pausedTtlMs?: number
  terminalSuccessTtlMs?: number
  terminalFailureTtlMs?: number
  abortedTtlMs?: number
  orphanTtlMs?: number
  maxTtlMs?: number
  cleanupMode: 'adapter_automatic' | 'application_scheduled' | 'manual_only'
}

export interface WorkspaceEncryptionInfo {
  encryptedAtRest: boolean
  keyScope: 'adapter' | 'tenant' | 'project' | 'application'
  rotationSupported: boolean
  metadataEncrypted: boolean
}

export interface WorkspaceQuotaPolicy {
  maxWorkspaceBytes?: number
  maxWorkspaceFiles?: number
  maxSingleFileBytes?: number
  maxCheckpointPayloadBytes?: number
  maxSnapshotBytes?: number
  maxActiveWorkspaces?: number
  maxPausedWorkspaces?: number
  maxConcurrentResumes?: number
  maxWorkspaceAgeMs?: number
  maxSnapshotsPerWorkspace?: number
  maxRetainedSnapshotBytes?: number
}

export interface DurableWorkspacePolicy {
  retention?: WorkspaceRetentionPolicy
  encryption?: WorkspaceEncryptionInfo
  quota?: WorkspaceQuotaPolicy
}

export interface DurableWorkspaceInfo {
  id: string
  packageName: string
  capabilities: readonly AdapterCapability[]
  policy: DurableWorkspacePolicy
}

export interface WorkspaceStartOptions {
  runId: string
  sessionId: string
  /** Immutable owner of the run-scoped sandbox tree. */
  sandboxOwner: SandboxOwner
  /** Stable digest of the resolved run partition policy and layout. */
  sandboxPolicyDigest: string
  workflowId?: string
  agentId?: string
  workerId?: string
  attempt: number
  idempotencyKey: string
  metadata?: Record<string, JsonValue>
  policy?: Partial<DurableWorkspacePolicy>
  signal?: AbortSignal
}

export interface WorkspaceHandle {
  workspaceRef: string
  runId: string
  sessionId: string
  sandboxOwner: SandboxOwner
  sandboxPolicyDigest: string
  state: 'active'
  startedAt: string
  attempt: number
  metadata?: Record<string, JsonValue>
}

export interface WorkspacePauseOptions {
  handle: WorkspaceHandle
  /** Exact run partitions captured by this aggregate checkpoint. */
  sandboxPartitions: readonly SandboxPartition[]
  stepId: string
  sequence: number
  attempt: number
  checkpointPayload?: JsonValue
  reason: 'step_completed' | 'manual_pause' | 'timeout' | 'shutdown' | 'retry_boundary'
  idempotencyKey: string
  signal?: AbortSignal
}

export interface WorkspaceCheckpoint {
  workspaceRef: string
  checkpointRef: string
  snapshotRef?: string
  runId: string
  sessionId: string
  sandboxPolicyDigest: string
  /** Sorted, duplicate-free partitions included in this aggregate checkpoint. */
  sandboxPartitions: readonly SandboxPartition[]
  stepId: string
  sequence: number
  attempt: number
  committedAt: string
  expiresAt?: string
  sizeBytes?: number
  metadata?: Record<string, JsonValue>
}

export interface WorkspaceResumeOptions {
  workspaceRef: string
  checkpointRef?: string
  snapshotRef?: string
  runId: string
  sessionId: string
  attempt: number
  idempotencyKey: string
  signal?: AbortSignal
}

export interface WorkspaceAbortOptions {
  workspaceRef: string
  runId: string
  sessionId: string
  reason: 'cancelled' | 'failed' | 'superseded' | 'manual_abort'
  idempotencyKey: string
  signal?: AbortSignal
}

export interface WorkspaceAbortResult {
  workspaceRef: string
  state: 'aborted'
  abortedAt: string
  cleanupEligibleAt?: string
}

export interface WorkspaceCleanupOptions {
  workspaceRef: string
  reason: 'terminal_success' | 'terminal_failure' | 'aborted' | 'expired' | 'orphan' | 'manual'
  idempotencyKey: string
  signal?: AbortSignal
}

export interface WorkspaceCleanupResult {
  workspaceRef: string
  state: 'cleaned' | 'cleanup_pending'
  deletedBytes?: number
  deletedFiles?: number
  completedAt?: string
  retryAfterMs?: number
  partial?: boolean
  remainingRefs?: readonly string[]
}

export interface WorkspaceInspectionOptions {
  workspaceRef?: string
  checkpointRef?: string
  snapshotRef?: string
  signal?: AbortSignal
}

export interface WorkspaceInspection {
  workspaceRef: string
  state: WorkspaceLifecycleState
  checkpoints: readonly WorkspaceCheckpoint[]
  currentCheckpointRef?: string
  sandboxOwner: SandboxOwner
  sandboxPolicyDigest: string
  terminal?: { status: 'succeeded' | 'failed' | 'cancelled'; finishedAt: string }
  retention?: WorkspaceRetentionPolicy
  quota?: WorkspaceQuotaPolicy
  encryption?: WorkspaceEncryptionInfo
  createdAt: string
  updatedAt: string
  expiresAt?: string
  cleanupEligibleAt?: string
  metadata?: Record<string, JsonValue>
}

export interface DurableReplayCheckpoint {
  runId: string
  sessionId: string
  sandboxPolicyDigest: string
  sandboxPartitions: readonly SandboxPartition[]
  workerId?: string
  leaseId?: string
  stepId: string
  sequence: number
  attempt: number
  checkpointRef: string
  workspaceRef?: string
  snapshotRef?: string
  runtimeCheckpointRef?: string
  schemaVersion: 1
  payload?: JsonValue
  payloadSizeBytes?: number
  committedAt: string
  expiresAt?: string
  metadata?: Record<string, JsonValue>
}

/** Pins one checkpoint while a retained run record still depends on it. */
export interface WorkspacePinOptions {
  workspaceRef: string
  checkpointRef: string
  runId: string
  idempotencyKey: string
  signal?: AbortSignal
}

/** Releases a checkpoint only after a replacement or terminal result is durable. */
export interface WorkspaceReleasePinOptions extends WorkspacePinOptions {}

/** Records the durable run's terminal result before releasing recovery pins. */
export interface WorkspaceFinishOptions {
  workspaceRef: string
  runId: string
  status: 'succeeded' | 'failed' | 'cancelled'
  idempotencyKey: string
  signal?: AbortSignal
}

export interface DurableWorkspace extends AdapterCapabilities {
  readonly info: DurableWorkspaceInfo
  /** Trusted operator inventory and bounded cleanup for workspace-owned resources. */
  readonly administration: SandboxAdministration
  configureHarnessContext?(context: HarnessAdapterContext): void
  startWorkspace(opts: WorkspaceStartOptions): Promise<WorkspaceHandle>
  pauseWorkspace(opts: WorkspacePauseOptions): Promise<WorkspaceCheckpoint>
  resumeWorkspace(opts: WorkspaceResumeOptions): Promise<WorkspaceHandle>
  abortWorkspace(opts: WorkspaceAbortOptions): Promise<WorkspaceAbortResult>
  pinCheckpoint(opts: WorkspacePinOptions): Promise<void>
  releaseCheckpoint(opts: WorkspaceReleasePinOptions): Promise<void>
  finish(opts: WorkspaceFinishOptions): Promise<void>
  cleanupWorkspace(opts: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult>
  inspectWorkspace?(opts: WorkspaceInspectionOptions): Promise<WorkspaceInspection>
}

const adapterIdPattern = /^[a-z][a-z0-9_.-]{1,63}$/

export function validateDurableWorkspace(adapter: DurableWorkspace): void {
  if (!adapterIdPattern.test(adapter.info.id)) {
    throw new HarnessConfigError('Workspace id is invalid.', {
      reason: 'invalid_workspace',
      path: 'workspace.info.id',
      id: adapter.info.id
    })
  }
  if (!adapter.info.packageName.trim()) {
    throw new HarnessConfigError('Workspace packageName is required.', {
      reason: 'invalid_workspace',
      path: 'workspace.info.packageName',
      id: adapter.info.id
    })
  }
  if (!adapter.info.capabilities.includes('workspace.durable')) {
    throw new HarnessConfigError('Workspace must support workspace.durable.', {
      reason: 'invalid_workspace',
      path: 'workspace.info.capabilities',
      id: adapter.info.id
    })
  }
  if (adapter.capabilities.length !== adapter.info.capabilities.length || adapter.capabilities.some((capability) => !adapter.info.capabilities.includes(capability))) {
    throw new HarnessConfigError('Workspace capabilities must match info.capabilities.', {
      reason: 'invalid_workspace',
      path: 'workspace.capabilities',
      id: adapter.info.id
    })
  }
}
