import { OperationCancelledError, WorkspaceError, WorkspaceQuotaExceededError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type {
  DurableWorkspace,
  DurableWorkspaceInfo,
  WorkspaceAbortOptions,
  WorkspaceAbortResult,
  WorkspaceCheckpoint,
  WorkspaceCleanupOptions,
  WorkspaceCleanupResult,
  WorkspaceFinishOptions,
  WorkspaceHandle,
  WorkspaceInspection,
  WorkspaceInspectionOptions,
  WorkspacePinOptions,
  WorkspacePauseOptions,
  WorkspaceReleasePinOptions,
  WorkspaceResumeOptions,
  WorkspaceStartOptions
} from '../ports/workspace.js'
import type { DurableWorkspacePolicy } from '../ports/workspace.js'
import type { SandboxAdministration, WorkspaceAdministrationOptions } from '../sandbox/administration.js'
import { InMemoryPrivateCatalogStorage } from '../sandbox/adapter-catalog.js'
import { PrivateSandboxCatalog } from '../sandbox/catalog.js'
import type { SandboxOwner } from '../sandbox/ownership.js'
import { cleanupEligibleAt, resolveLocalWorkspacePolicy } from '../local/workspace-retention.js'

type WorkspaceLifecycle = 'active' | 'paused' | 'terminal' | 'aborted' | 'cleanup_pending' | 'cleaned'
type WorkspaceOpKind = 'pause' | 'resume' | 'abort' | 'cleanup' | 'finish'

/** Idempotency record keyed by `idempotencyKey`; carries identity so replays validate kind + run/session (spec 21 §9). */
interface StoredOpResult {
  kind: WorkspaceOpKind
  runId: string
  sessionId: string
  workspaceRef: string
  result: WorkspaceCheckpoint | WorkspaceHandle | WorkspaceAbortResult | WorkspaceCleanupResult
}

interface StoredWorkspace {
  workspaceRef: string
  state: WorkspaceLifecycle
  runId: string
  sessionId: string
  sandboxOwner: SandboxOwner
  sandboxPolicyDigest: string
  attempt: number
  createdAt: string
  updatedAt: string
  metadata: Record<string, JsonValue>
  checkpoints: WorkspaceCheckpoint[]
  bytes: number
  pins: Set<string>
  terminal?: { status: 'succeeded' | 'failed' | 'cancelled'; finishedAt: string }
}

/** Optional bounded configuration for the deterministic in-memory workspace. */
export interface InMemoryDurableWorkspaceOptions {
  policy?: Partial<DurableWorkspacePolicy>
  administration?: WorkspaceAdministrationOptions
}

/** In-process durable workspace for local development, examples, and tests. */
export class InMemoryDurableWorkspace implements DurableWorkspace {
  public readonly info: DurableWorkspaceInfo
  public readonly administration: SandboxAdministration

  public readonly capabilities: readonly import('../ports/capabilities.js').AdapterCapability[]
  private readonly workspaces = new Map<string, StoredWorkspace>()
  private readonly startKeys = new Map<string, { workspaceRef: string; runId: string; sessionId: string }>()
  private readonly opResults = new Map<string, StoredOpResult>()
  private readonly catalog: PrivateSandboxCatalog
  private nextId = 1

  public constructor(options: InMemoryDurableWorkspaceOptions = {}) {
    const policy = resolveLocalWorkspacePolicy(options.policy)
    this.info = {
      id: 'in_memory_workspace', packageName: '@purista/harness',
      capabilities: ['workspace.durable', 'workspace.checkpoint', 'workspace.resume', 'workspace.abort', 'workspace.cleanup', 'workspace.inspect', 'workspace.retention', 'workspace.quota'],
      policy
    }
    this.capabilities = this.info.capabilities
    this.catalog = new PrivateSandboxCatalog(new InMemoryPrivateCatalogStorage(), {
      ...(options.administration ? { administration: options.administration } : {}),
      callbacks: { deleteResource: async (resource) => await this.deleteCatalogResource(resource.resourceId, resource.kind, resource.owner) }
    })
    this.administration = this.catalog
  }

  public configureHarnessContext(): void {}

  public async startWorkspace(opts: WorkspaceStartOptions): Promise<WorkspaceHandle> {
    throwIfAborted(opts.signal)

    // Idempotent start: a repeated key replays the same workspace; a key reused
    // with a different identity is a conflict.
    const prior = this.startKeys.get(opts.idempotencyKey)
    if (prior) {
      if (prior.runId !== opts.runId || prior.sessionId !== opts.sessionId) {
        throw new WorkspaceError('Workspace start idempotency key reused with a different run/session.', {
          reason: 'idempotency_conflict',
          workspace_ref: prior.workspaceRef,
          run_id: opts.runId,
          session_id: opts.sessionId
        })
      }
      const existing = this.workspaces.get(prior.workspaceRef)
      if (existing) {
        if (ownerKey(existing.sandboxOwner) !== ownerKey(opts.sandboxOwner) || existing.sandboxPolicyDigest !== opts.sandboxPolicyDigest) {
          throw new WorkspaceError('Workspace owner or durable partition policy changed.', {
            reason: 'idempotency_conflict', workspace_ref: existing.workspaceRef, run_id: opts.runId
          })
        }
        return this.toHandle(existing)
      }
    }

    const activeCount = [...this.workspaces.values()].filter((w) => w.state === 'active' || w.state === 'paused').length
    const quota = this.info.policy.quota!
    if (activeCount >= quota.maxActiveWorkspaces!) {
      throw new WorkspaceQuotaExceededError('Active workspace quota exceeded.', {
        quota: 'maxActiveWorkspaces',
        limit: quota.maxActiveWorkspaces!,
        actual: activeCount,
        run_id: opts.runId,
        session_id: opts.sessionId
      })
    }

    const workspaceRef = `workspace_${this.nextId++}`
    const now = new Date().toISOString()
    const workspace: StoredWorkspace = {
      workspaceRef,
      state: 'active',
      runId: opts.runId,
      sessionId: opts.sessionId,
      sandboxOwner: opts.sandboxOwner,
      sandboxPolicyDigest: opts.sandboxPolicyDigest,
      attempt: opts.attempt,
      createdAt: now,
      updatedAt: now,
      metadata: { ...(opts.metadata ?? {}) },
      checkpoints: [],
      bytes: 0,
      pins: new Set()
    }
    this.workspaces.set(workspaceRef, workspace)
    this.startKeys.set(opts.idempotencyKey, { workspaceRef, runId: opts.runId, sessionId: opts.sessionId })
    await this.catalog.registerOwner({ owner: opts.sandboxOwner, mode: 'create', ...(opts.signal ? { signal: opts.signal } : {}) })
    await this.catalog.provision({ resourceId: workspaceRef, kind: 'workspace', owner: opts.sandboxOwner, pinned: false, idempotencyKey: workspaceRef })
    await this.catalog.activate(workspaceRef)
    return this.toHandle(workspace)
  }

  public async pauseWorkspace(opts: WorkspacePauseOptions): Promise<WorkspaceCheckpoint> {
    throwIfAborted(opts.signal)
    const replay = this.opResults.get(opts.idempotencyKey)
    if (replay) {
      assertReplayMatches(replay, 'pause', opts.handle.runId, opts.handle.sessionId)
      return replay.result as WorkspaceCheckpoint
    }

    const workspace = this.requireLiveWorkspace(opts.handle.workspaceRef)

    const payloadBytes = opts.checkpointPayload === undefined ? 0 : byteLength(opts.checkpointPayload)
    const quota = this.info.policy.quota!
    if (payloadBytes > quota.maxCheckpointPayloadBytes!) {
      throw new WorkspaceQuotaExceededError('Checkpoint payload exceeds the size quota.', {
        quota: 'maxCheckpointPayloadBytes',
        limit: quota.maxCheckpointPayloadBytes!,
        actual: payloadBytes,
        workspace_ref: workspace.workspaceRef
      })
    }
    await this.reserveCheckpoint(workspace, payloadBytes)

    const committedAt = new Date().toISOString()
    workspace.state = 'paused'
    workspace.updatedAt = committedAt
    workspace.bytes += payloadBytes
    const checkpoint: WorkspaceCheckpoint = {
      workspaceRef: workspace.workspaceRef,
      checkpointRef: `${workspace.workspaceRef}:checkpoint:${opts.sequence}`,
      runId: workspace.runId,
      sessionId: workspace.sessionId,
      sandboxPolicyDigest: workspace.sandboxPolicyDigest,
      sandboxPartitions: canonicalPartitions(opts.sandboxPartitions),
      stepId: opts.stepId,
      sequence: opts.sequence,
      attempt: opts.attempt,
      committedAt,
      sizeBytes: payloadBytes,
      metadata: {
        reason: opts.reason,
        ...(opts.checkpointPayload !== undefined ? { checkpointPayload: opts.checkpointPayload } : {})
      }
    }
    workspace.checkpoints.push(checkpoint)
    await this.catalog.provision({ resourceId: checkpoint.checkpointRef, kind: 'snapshot', owner: workspace.sandboxOwner, pinned: false, sizeBytes: payloadBytes, idempotencyKey: checkpoint.checkpointRef })
    await this.catalog.activate(checkpoint.checkpointRef)
    this.opResults.set(opts.idempotencyKey, { kind: 'pause', runId: opts.handle.runId, sessionId: opts.handle.sessionId, workspaceRef: workspace.workspaceRef, result: checkpoint })
    return checkpoint
  }

  public async resumeWorkspace(opts: WorkspaceResumeOptions): Promise<WorkspaceHandle> {
    throwIfAborted(opts.signal)
    const replay = this.opResults.get(opts.idempotencyKey)
    if (replay) {
      assertReplayMatches(replay, 'resume', opts.runId, opts.sessionId)
      return replay.result as WorkspaceHandle
    }

    const workspace = this.workspaces.get(opts.workspaceRef)
    if (!workspace || workspace.state === 'cleaned') {
      throw new WorkspaceError('Workspace not found.', { reason: 'not_found', workspace_ref: opts.workspaceRef })
    }
    if (workspace.state === 'aborted') {
      throw new WorkspaceError('Workspace was aborted and cannot resume.', { reason: 'aborted', workspace_ref: opts.workspaceRef })
    }
    if (workspace.state === 'terminal') {
      throw new WorkspaceError('Workspace has a terminal durable result.', { reason: 'aborted', workspace_ref: opts.workspaceRef })
    }
    if (this.isExpired(workspace)) {
      throw new WorkspaceError('Workspace has expired.', { reason: 'expired', workspace_ref: opts.workspaceRef })
    }
    if (opts.checkpointRef && !workspace.checkpoints.some((checkpoint) => checkpoint.checkpointRef === opts.checkpointRef)) {
      throw new WorkspaceError('Workspace checkpoint not found.', { reason: 'missing_checkpoint', workspace_ref: opts.workspaceRef, checkpoint_ref: opts.checkpointRef })
    }

    workspace.state = 'active'
    workspace.runId = opts.runId
    workspace.sessionId = opts.sessionId
    workspace.attempt = opts.attempt
    workspace.updatedAt = new Date().toISOString()
    const handle = this.toHandle(workspace)
    this.opResults.set(opts.idempotencyKey, { kind: 'resume', runId: opts.runId, sessionId: opts.sessionId, workspaceRef: workspace.workspaceRef, result: handle })
    return handle
  }

  public async abortWorkspace(opts: WorkspaceAbortOptions): Promise<WorkspaceAbortResult> {
    throwIfAborted(opts.signal)
    const replay = this.opResults.get(opts.idempotencyKey)
    if (replay) {
      assertReplayMatches(replay, 'abort', opts.runId, opts.sessionId)
      return replay.result as WorkspaceAbortResult
    }

    const workspace = this.workspaces.get(opts.workspaceRef)
    if (!workspace || workspace.state === 'cleaned') {
      throw new WorkspaceError('Workspace not found.', { reason: 'not_found', workspace_ref: opts.workspaceRef })
    }
    const abortedAt = new Date().toISOString()
    workspace.state = 'aborted'
    workspace.updatedAt = abortedAt
    const eligibleAt = cleanupEligibleAt(this.info.policy.retention!, 'aborted', abortedAt)
    const result: WorkspaceAbortResult = { workspaceRef: opts.workspaceRef, state: 'aborted', abortedAt, ...(eligibleAt ? { cleanupEligibleAt: eligibleAt } : {}) }
    await this.catalog.setResourceState(workspace.workspaceRef, 'terminal')
    await this.catalog.setResourceExpiry(workspace.workspaceRef, eligibleAt)
    for (const checkpoint of workspace.checkpoints) await this.catalog.setResourceExpiry(checkpoint.checkpointRef, eligibleAt)
    this.opResults.set(opts.idempotencyKey, { kind: 'abort', runId: opts.runId, sessionId: opts.sessionId, workspaceRef: opts.workspaceRef, result })
    return result
  }

  public async pinCheckpoint(opts: WorkspacePinOptions): Promise<void> {
    throwIfAborted(opts.signal)
    const workspace = this.requireWorkspaceForRun(opts.workspaceRef, opts.runId)
    if (!workspace.checkpoints.some((checkpoint) => checkpoint.checkpointRef === opts.checkpointRef)) {
      throw new WorkspaceError('Workspace checkpoint not found.', { reason: 'missing_checkpoint', workspace_ref: opts.workspaceRef, checkpoint_ref: opts.checkpointRef })
    }
    workspace.pins.add(opts.checkpointRef)
    await this.catalog.setSnapshotPinned(opts.checkpointRef, true)
  }

  public async releaseCheckpoint(opts: WorkspaceReleasePinOptions): Promise<void> {
    throwIfAborted(opts.signal)
    this.requireWorkspaceForRun(opts.workspaceRef, opts.runId).pins.delete(opts.checkpointRef)
    await this.catalog.setSnapshotPinned(opts.checkpointRef, false)
  }

  public async finish(opts: WorkspaceFinishOptions): Promise<void> {
    throwIfAborted(opts.signal)
    const workspace = this.requireWorkspaceForRun(opts.workspaceRef, opts.runId)
    if (workspace.terminal && workspace.terminal.status !== opts.status) {
      throw new WorkspaceError('Workspace terminal outcome conflicts with the recorded result.', { reason: 'idempotency_conflict', workspace_ref: opts.workspaceRef, run_id: opts.runId })
    }
    if (workspace.terminal) return
    const finishedAt = new Date().toISOString()
    workspace.terminal = { status: opts.status, finishedAt }
    workspace.state = 'terminal'
    workspace.updatedAt = finishedAt
    await this.catalog.setResourceState(workspace.workspaceRef, 'terminal')
    const expiresAt = cleanupEligibleAt(this.info.policy.retention!, 'terminal', finishedAt, opts.status)
    await this.catalog.setResourceExpiry(workspace.workspaceRef, expiresAt)
    for (const checkpoint of workspace.checkpoints) await this.catalog.setResourceExpiry(checkpoint.checkpointRef, expiresAt)
  }

  public async cleanupWorkspace(opts: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult> {
    throwIfAborted(opts.signal)
    const replay = this.opResults.get(opts.idempotencyKey)
    if (replay) return replay.result as WorkspaceCleanupResult

    const workspace = this.workspaces.get(opts.workspaceRef)
    const completedAt = new Date().toISOString()
    // Cleanup is idempotent: an already-cleaned (or unknown) workspace returns a
    // terminal cleaned result rather than throwing.
    if (!workspace || workspace.state === 'cleaned') {
      const result: WorkspaceCleanupResult = { workspaceRef: opts.workspaceRef, state: 'cleaned', completedAt, deletedBytes: 0, deletedFiles: 0 }
      this.opResults.set(opts.idempotencyKey, { kind: 'cleanup', runId: workspace?.runId ?? '', sessionId: workspace?.sessionId ?? '', workspaceRef: opts.workspaceRef, result })
      return result
    }
    const deletedBytes = workspace.bytes
    const deletedFiles = workspace.checkpoints.length
    const checkpoints = [...workspace.checkpoints]
    const { runId, sessionId } = workspace
    workspace.state = 'cleaned'
    workspace.updatedAt = completedAt
    workspace.checkpoints = []
    workspace.bytes = 0
    // A cleaned workspace keeps only its slim terminal record; idempotency
    // entries referencing it are evicted so the store does not grow unbounded.
    this.evictWorkspaceOps(opts.workspaceRef)
    await this.catalog.markDeleted(workspace.workspaceRef)
    for (const checkpoint of checkpoints) await this.catalog.markDeleted(checkpoint.checkpointRef)
    const result: WorkspaceCleanupResult = { workspaceRef: opts.workspaceRef, state: 'cleaned', completedAt, deletedBytes, deletedFiles }
    this.opResults.set(opts.idempotencyKey, { kind: 'cleanup', runId, sessionId, workspaceRef: opts.workspaceRef, result })
    return result
  }

  public async inspectWorkspace(opts: WorkspaceInspectionOptions): Promise<WorkspaceInspection> {
    throwIfAborted(opts.signal)
    const workspaceRef = opts.workspaceRef ?? this.findWorkspaceByCheckpoint(opts.checkpointRef)
    const workspace = this.workspaces.get(workspaceRef)
    if (!workspace) {
      throw new WorkspaceError('Workspace not found.', { reason: 'not_found', workspace_ref: workspaceRef })
    }
    const latest = workspace.checkpoints.at(-1)
    const expiresAt = workspace.state === 'aborted'
      ? cleanupEligibleAt(this.info.policy.retention!, 'aborted', workspace.updatedAt)
      : workspace.state === 'terminal' && workspace.terminal
        ? cleanupEligibleAt(this.info.policy.retention!, 'terminal', workspace.terminal.finishedAt, workspace.terminal.status)
        : undefined
    return {
      workspaceRef: workspace.workspaceRef,
      state: workspace.state,
      checkpoints: workspace.checkpoints,
      ...(latest ? { currentCheckpointRef: latest.checkpointRef } : {}),
      sandboxOwner: workspace.sandboxOwner,
      sandboxPolicyDigest: workspace.sandboxPolicyDigest,
      ...(workspace.terminal ? { terminal: workspace.terminal } : {}),
      ...(expiresAt ? { expiresAt, cleanupEligibleAt: expiresAt } : {}),
      retention: this.info.policy.retention!,
      quota: this.info.policy.quota!,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      metadata: workspace.metadata
    }
  }

  private toHandle(workspace: StoredWorkspace): WorkspaceHandle {
    return {
      workspaceRef: workspace.workspaceRef,
      runId: workspace.runId,
      sessionId: workspace.sessionId,
      sandboxOwner: workspace.sandboxOwner,
      sandboxPolicyDigest: workspace.sandboxPolicyDigest,
      state: 'active',
      startedAt: workspace.updatedAt,
      attempt: workspace.attempt,
      metadata: workspace.metadata
    }
  }

  private isExpired(_workspace: StoredWorkspace): boolean { return false }

  private async reserveCheckpoint(workspace: StoredWorkspace, payloadBytes: number): Promise<void> {
    const quota = this.info.policy.quota!
    if (payloadBytes > quota.maxSnapshotBytes!) {
      throw new WorkspaceQuotaExceededError('Workspace snapshot exceeds the size quota.', { quota: 'maxSnapshotBytes', limit: quota.maxSnapshotBytes!, actual: payloadBytes, workspace_ref: workspace.workspaceRef })
    }
    const candidates = workspace.checkpoints.slice(0, -1).filter((checkpoint) => !workspace.pins.has(checkpoint.checkpointRef))
    while ((workspace.checkpoints.length + 1 > quota.maxSnapshotsPerWorkspace! || workspace.bytes + payloadBytes > quota.maxRetainedSnapshotBytes!) && candidates.length > 0) {
      const checkpoint = candidates.shift()!
      workspace.checkpoints = workspace.checkpoints.filter((item) => item.checkpointRef !== checkpoint.checkpointRef)
      workspace.bytes -= checkpoint.sizeBytes ?? 0
      await this.catalog.markDeleted(checkpoint.checkpointRef)
    }
    if (workspace.checkpoints.length + 1 > quota.maxSnapshotsPerWorkspace!) {
      throw new WorkspaceQuotaExceededError('Workspace snapshot count quota exceeded.', { quota: 'maxSnapshotsPerWorkspace', limit: quota.maxSnapshotsPerWorkspace!, actual: workspace.checkpoints.length + 1, workspace_ref: workspace.workspaceRef })
    }
    if (workspace.bytes + payloadBytes > quota.maxRetainedSnapshotBytes!) {
      throw new WorkspaceQuotaExceededError('Workspace retained snapshot byte quota exceeded.', { quota: 'maxRetainedSnapshotBytes', limit: quota.maxRetainedSnapshotBytes!, actual: workspace.bytes + payloadBytes, workspace_ref: workspace.workspaceRef })
    }
  }

  private async deleteCatalogResource(resourceId: string, kind: 'sandbox' | 'workspace' | 'snapshot', owner: SandboxOwner): Promise<void> {
    if (kind === 'workspace') {
      const workspace = this.workspaces.get(resourceId)
      if (workspace && ownerKey(workspace.sandboxOwner) !== ownerKey(owner)) throw new WorkspaceError('Workspace owner does not match its catalog record.', { reason: 'idempotency_conflict', workspace_ref: resourceId })
      if (workspace) {
        workspace.state = 'cleaned'
        workspace.bytes = 0
        workspace.checkpoints = []
        this.evictWorkspaceOps(resourceId)
      }
      return
    }
    if (kind !== 'snapshot') return
    for (const workspace of this.workspaces.values()) {
      if (ownerKey(workspace.sandboxOwner) !== ownerKey(owner)) continue
      const checkpoint = workspace.checkpoints.find((item) => item.checkpointRef === resourceId)
      if (!checkpoint) continue
      workspace.checkpoints = workspace.checkpoints.filter((item) => item.checkpointRef !== resourceId)
      workspace.pins.delete(resourceId)
      workspace.bytes -= checkpoint.sizeBytes ?? 0
      return
    }
  }

  private findWorkspaceByCheckpoint(checkpointRef: string | undefined): string {
    if (!checkpointRef) {
      throw new WorkspaceError('workspaceRef or checkpointRef is required.', { reason: 'invalid_reference' })
    }
    const found = [...this.workspaces.values()].find((workspace) => workspace.checkpoints.some((checkpoint) => checkpoint.checkpointRef === checkpointRef))
    if (!found) {
      throw new WorkspaceError('Workspace checkpoint not found.', { reason: 'invalid_reference', checkpoint_ref: checkpointRef })
    }
    return found.workspaceRef
  }

  private evictWorkspaceOps(workspaceRef: string): void {
    for (const [key, entry] of this.startKeys) {
      if (entry.workspaceRef === workspaceRef) this.startKeys.delete(key)
    }
    for (const [key, value] of this.opResults) {
      if (value.workspaceRef === workspaceRef) this.opResults.delete(key)
    }
  }

  private requireLiveWorkspace(workspaceRef: string): StoredWorkspace {
    const workspace = this.workspaces.get(workspaceRef)
    if (!workspace || workspace.state === 'cleaned') {
      throw new WorkspaceError('Workspace not found.', { reason: 'not_found', workspace_ref: workspaceRef })
    }
    if (workspace.state === 'aborted') {
      throw new WorkspaceError('Workspace was aborted.', { reason: 'aborted', workspace_ref: workspaceRef })
    }
    return workspace
  }

  private requireWorkspaceForRun(workspaceRef: string, runId: string): StoredWorkspace {
    const workspace = this.workspaces.get(workspaceRef)
    if (!workspace || workspace.state === 'cleaned') {
      throw new WorkspaceError('Workspace not found.', { reason: 'not_found', workspace_ref: workspaceRef })
    }
    if (workspace.runId !== runId) {
      throw new WorkspaceError('Workspace belongs to another durable run.', { reason: 'idempotency_conflict', workspace_ref: workspaceRef, run_id: runId })
    }
    return workspace
  }
}

/**
 * Guards a persisted-op replay: a stored entry may only replay when it belongs
 * to the same operation kind and run/session identity, otherwise the reused key
 * is an `idempotency_conflict` (spec 21 §9).
 */
function assertReplayMatches(op: StoredOpResult, kind: WorkspaceOpKind, runId: string, sessionId: string): void {
  if (op.kind !== kind || op.runId !== runId || op.sessionId !== sessionId) {
    throw new WorkspaceError(`Workspace ${kind} idempotency key reused with a different operation or run/session.`, {
      reason: 'idempotency_conflict',
      workspace_ref: op.workspaceRef,
      run_id: runId,
      session_id: sessionId
    })
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OperationCancelledError('Workspace operation was cancelled.', { scope: 'workspace' })
  }
}

function byteLength(value: JsonValue): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return 0
  }
}

function canonicalPartitions(partitions: readonly import('../sandbox/ownership.js').SandboxPartition[]): readonly import('../sandbox/ownership.js').SandboxPartition[] {
  const keyed = new Map<string, import('../sandbox/ownership.js').SandboxPartition>()
  for (const partition of partitions) keyed.set(JSON.stringify(partition), partition)
  return [...keyed.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, partition]) => partition)
}

function ownerKey(owner: SandboxOwner): string { return JSON.stringify(owner) }

/** Creates a fresh in-process durable workspace. */
export function inMemoryDurableWorkspace(options: InMemoryDurableWorkspaceOptions = {}): DurableWorkspace {
  return new InMemoryDurableWorkspace(options)
}
