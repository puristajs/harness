import { HarnessConfigError } from '../errors/catalog.js'
import type { DurableWorkspacePolicy, WorkspaceQuotaPolicy, WorkspaceRetentionPolicy } from '../ports/workspace.js'

const DAY_MS = 86_400_000

/** Finite retention defaults for the local and in-memory durable workspaces. */
export const localWorkspaceDefaults = {
  retention: {
    cleanupMode: 'application_scheduled' as const,
    terminalSuccessTtlMs: 7 * DAY_MS,
    terminalFailureTtlMs: 7 * DAY_MS,
    abortedTtlMs: 7 * DAY_MS
  },
  quota: {
    maxActiveWorkspaces: 32,
    maxPausedWorkspaces: 32,
    maxConcurrentResumes: 4,
    maxSnapshotsPerWorkspace: 32,
    maxRetainedSnapshotBytes: 1_073_741_824,
    maxSnapshotBytes: 268_435_456,
    maxCheckpointPayloadBytes: 1_048_576
  }
} as const

/**
 * Resolves the deliberately small first-local-adapter policy matrix.
 *
 * Live workspace expiry and live-filesystem byte limits are rejected instead
 * of being accepted as unenforceable hints. Applications schedule cleanup by
 * calling the adapter administration surface.
 */
export function resolveLocalWorkspacePolicy(policy: Partial<DurableWorkspacePolicy> | undefined): DurableWorkspacePolicy {
  const retention = resolveRetention(policy?.retention)
  const quota = resolveQuota(policy?.quota)
  const encryption = policy?.encryption ?? {
    encryptedAtRest: false,
    keyScope: 'application' as const,
    rotationSupported: false,
    metadataEncrypted: false
  }
  return { retention, quota, encryption }
}

/** Returns terminal/aborted cleanup eligibility; active and paused workspaces never expire here. */
export function cleanupEligibleAt(retention: WorkspaceRetentionPolicy, state: 'terminal' | 'aborted', finishedAt: string, status?: 'succeeded' | 'failed' | 'cancelled'): string | undefined {
  const ttl = state === 'aborted'
    ? retention.abortedTtlMs
    : status === 'succeeded'
      ? retention.terminalSuccessTtlMs
      : retention.terminalFailureTtlMs
  return ttl === undefined ? undefined : new Date(Date.parse(finishedAt) + ttl).toISOString()
}

function resolveRetention(value: WorkspaceRetentionPolicy | undefined): WorkspaceRetentionPolicy {
  if (!value) return { ...localWorkspaceDefaults.retention }
  if (value.cleanupMode === 'adapter_automatic') throw unsupported('retention.cleanupMode')
  // A local directory has no durable liveness authority. Treating elapsed time
  // or a process restart as proof of an orphan would violate the recovery
  // guarantee, so this policy is rejected rather than advertised as a hint.
  if (value.orphanTtlMs !== undefined) throw unsupported('retention.orphanTtlMs')
  const hasLiveTtl = value.activeTtlMs !== undefined || value.pausedTtlMs !== undefined || value.maxTtlMs !== undefined
  if (hasLiveTtl) throw unsupported('retention')
  if (value.cleanupMode === 'manual_only') {
    if (hasRetentionTtl(value)) throw unsupported('retention')
    return { cleanupMode: 'manual_only' }
  }
  return {
    cleanupMode: 'application_scheduled',
    terminalSuccessTtlMs: positive(value.terminalSuccessTtlMs, 'retention.terminalSuccessTtlMs') ?? localWorkspaceDefaults.retention.terminalSuccessTtlMs,
    terminalFailureTtlMs: positive(value.terminalFailureTtlMs, 'retention.terminalFailureTtlMs') ?? localWorkspaceDefaults.retention.terminalFailureTtlMs,
    abortedTtlMs: positive(value.abortedTtlMs, 'retention.abortedTtlMs') ?? localWorkspaceDefaults.retention.abortedTtlMs
  }
}

function resolveQuota(value: WorkspaceQuotaPolicy | undefined): WorkspaceQuotaPolicy {
  if (value?.maxWorkspaceBytes !== undefined || value?.maxWorkspaceFiles !== undefined || value?.maxSingleFileBytes !== undefined || value?.maxWorkspaceAgeMs !== undefined) {
    throw unsupported('quota')
  }
  return {
    maxActiveWorkspaces: positive(value?.maxActiveWorkspaces, 'quota.maxActiveWorkspaces') ?? localWorkspaceDefaults.quota.maxActiveWorkspaces,
    maxPausedWorkspaces: positive(value?.maxPausedWorkspaces, 'quota.maxPausedWorkspaces') ?? localWorkspaceDefaults.quota.maxPausedWorkspaces,
    maxConcurrentResumes: positive(value?.maxConcurrentResumes, 'quota.maxConcurrentResumes') ?? localWorkspaceDefaults.quota.maxConcurrentResumes,
    maxSnapshotsPerWorkspace: positive(value?.maxSnapshotsPerWorkspace, 'quota.maxSnapshotsPerWorkspace') ?? localWorkspaceDefaults.quota.maxSnapshotsPerWorkspace,
    maxRetainedSnapshotBytes: positive(value?.maxRetainedSnapshotBytes, 'quota.maxRetainedSnapshotBytes') ?? localWorkspaceDefaults.quota.maxRetainedSnapshotBytes,
    maxSnapshotBytes: positive(value?.maxSnapshotBytes, 'quota.maxSnapshotBytes') ?? localWorkspaceDefaults.quota.maxSnapshotBytes,
    maxCheckpointPayloadBytes: positive(value?.maxCheckpointPayloadBytes, 'quota.maxCheckpointPayloadBytes') ?? localWorkspaceDefaults.quota.maxCheckpointPayloadBytes
  }
}

function hasRetentionTtl(value: WorkspaceRetentionPolicy): boolean {
  return value.terminalSuccessTtlMs !== undefined || value.terminalFailureTtlMs !== undefined || value.abortedTtlMs !== undefined
}

function positive(value: number | undefined, path: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(path)
  return value
}

function unsupported(path: string): HarnessConfigError {
  return new HarnessConfigError('The local durable workspace does not support this policy field.', { reason: 'unsupported_workspace_policy', path })
}

function invalid(path: string): HarnessConfigError {
  return new HarnessConfigError('Workspace policy is invalid.', { reason: 'invalid_workspace_policy', path })
}
