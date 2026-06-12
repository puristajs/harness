import { OperationCancelledError, WorkspaceError, WorkspaceQuotaExceededError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type {
  DurableWorkspaceStore,
  DurableWorkspaceStoreInfo,
  WorkspaceAbortOptions,
  WorkspaceAbortResult,
  WorkspaceCheckpoint,
  WorkspaceCleanupOptions,
  WorkspaceCleanupResult,
  WorkspaceHandle,
  WorkspaceInspection,
  WorkspaceInspectionOptions,
  WorkspacePauseOptions,
  WorkspaceResumeOptions,
  WorkspaceRetentionPolicy,
  WorkspaceStartOptions
} from '../ports/workspace.js'

type WorkspaceLifecycle = 'active' | 'paused' | 'aborted' | 'cleanup_pending' | 'cleaned'
type WorkspaceOpKind = 'pause' | 'resume' | 'abort' | 'cleanup'

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
  attempt: number
  createdAt: string
  updatedAt: string
  metadata: Record<string, JsonValue>
  checkpoints: WorkspaceCheckpoint[]
  bytes: number
}

const RETENTION: WorkspaceRetentionPolicy = {
  pausedTtlMs: 86_400_000,
  terminalFailureTtlMs: 86_400_000,
  terminalSuccessTtlMs: 0,
  abortedTtlMs: 86_400_000,
  cleanupMode: 'manual_only'
}
const QUOTA = { maxActiveWorkspaces: 100, maxWorkspaceBytes: 10_000_000, maxCheckpointPayloadBytes: 1_000_000 } as const

/** In-process durable workspace store for local development, examples, and tests. */
export class InMemoryDurableWorkspaceStore implements DurableWorkspaceStore {
  public readonly info = {
    id: 'in_memory_workspace_store',
    packageName: '@purista/harness',
    capabilities: [
      'workspace_store.durable',
      'workspace_store.checkpoint',
      'workspace_store.resume',
      'workspace_store.abort',
      'workspace_store.cleanup',
      'workspace_store.inspect',
      'workspace_store.retention',
      'workspace_store.quota'
    ] as const,
    policy: { retention: RETENTION, quota: { maxActiveWorkspaces: QUOTA.maxActiveWorkspaces, maxWorkspaceBytes: QUOTA.maxWorkspaceBytes } }
  } satisfies DurableWorkspaceStoreInfo

  public readonly capabilities = this.info.capabilities
  private readonly workspaces = new Map<string, StoredWorkspace>()
  private readonly startKeys = new Map<string, { workspaceRef: string; runId: string; sessionId: string }>()
  private readonly opResults = new Map<string, StoredOpResult>()
  private nextId = 1

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
      if (existing) return this.toHandle(existing)
    }

    const activeCount = [...this.workspaces.values()].filter((w) => w.state === 'active' || w.state === 'paused').length
    if (activeCount >= QUOTA.maxActiveWorkspaces) {
      throw new WorkspaceQuotaExceededError('Active workspace quota exceeded.', {
        quota: 'maxActiveWorkspaces',
        limit: QUOTA.maxActiveWorkspaces,
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
      attempt: opts.attempt,
      createdAt: now,
      updatedAt: now,
      metadata: { ...(opts.metadata ?? {}) },
      checkpoints: [],
      bytes: 0
    }
    this.workspaces.set(workspaceRef, workspace)
    this.startKeys.set(opts.idempotencyKey, { workspaceRef, runId: opts.runId, sessionId: opts.sessionId })
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
    if (payloadBytes > QUOTA.maxCheckpointPayloadBytes) {
      throw new WorkspaceQuotaExceededError('Checkpoint payload exceeds the size quota.', {
        quota: 'maxCheckpointPayloadBytes',
        limit: QUOTA.maxCheckpointPayloadBytes,
        actual: payloadBytes,
        workspace_ref: workspace.workspaceRef
      })
    }
    if (workspace.bytes + payloadBytes > QUOTA.maxWorkspaceBytes) {
      throw new WorkspaceQuotaExceededError('Workspace byte quota exceeded.', {
        quota: 'maxWorkspaceBytes',
        limit: QUOTA.maxWorkspaceBytes,
        actual: workspace.bytes + payloadBytes,
        workspace_ref: workspace.workspaceRef
      })
    }

    const committedAt = new Date().toISOString()
    workspace.state = 'paused'
    workspace.updatedAt = committedAt
    workspace.bytes += payloadBytes
    const expiresAt = expiryFor('paused', committedAt)
    const checkpoint: WorkspaceCheckpoint = {
      workspaceRef: workspace.workspaceRef,
      checkpointRef: `${workspace.workspaceRef}:checkpoint:${opts.sequence}`,
      runId: workspace.runId,
      sessionId: workspace.sessionId,
      stepId: opts.stepId,
      sequence: opts.sequence,
      attempt: opts.attempt,
      committedAt,
      ...(expiresAt ? { expiresAt } : {}),
      sizeBytes: payloadBytes,
      metadata: {
        reason: opts.reason,
        ...(opts.checkpointPayload !== undefined ? { checkpointPayload: opts.checkpointPayload } : {})
      }
    }
    workspace.checkpoints.push(checkpoint)
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
    const cleanupEligibleAt = expiryFor('aborted', abortedAt)
    const result: WorkspaceAbortResult = { workspaceRef: opts.workspaceRef, state: 'aborted', abortedAt, ...(cleanupEligibleAt ? { cleanupEligibleAt } : {}) }
    this.opResults.set(opts.idempotencyKey, { kind: 'abort', runId: opts.runId, sessionId: opts.sessionId, workspaceRef: opts.workspaceRef, result })
    return result
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
    const { runId, sessionId } = workspace
    workspace.state = 'cleaned'
    workspace.updatedAt = completedAt
    workspace.checkpoints = []
    workspace.bytes = 0
    // A cleaned workspace keeps only its slim terminal record; idempotency
    // entries referencing it are evicted so the store does not grow unbounded.
    this.evictWorkspaceOps(opts.workspaceRef)
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
    const expiresAt = expiryFor(workspace.state, workspace.updatedAt)
    return {
      workspaceRef: workspace.workspaceRef,
      state: workspace.state,
      checkpoints: workspace.checkpoints,
      ...(latest ? { currentCheckpointRef: latest.checkpointRef } : {}),
      ...(expiresAt ? { expiresAt, cleanupEligibleAt: expiresAt } : {}),
      retention: this.info.policy.retention,
      quota: this.info.policy.quota,
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
      state: 'active',
      startedAt: workspace.updatedAt,
      attempt: workspace.attempt,
      metadata: workspace.metadata
    }
  }

  private isExpired(workspace: StoredWorkspace): boolean {
    const expiresAt = expiryFor(workspace.state, workspace.updatedAt)
    return expiresAt !== undefined && Date.parse(expiresAt) <= Date.now()
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

function ttlForState(state: WorkspaceLifecycle): number | undefined {
  switch (state) {
    case 'paused':
      return RETENTION.pausedTtlMs
    case 'aborted':
      return RETENTION.abortedTtlMs ?? RETENTION.terminalFailureTtlMs
    default:
      return undefined
  }
}

function expiryFor(state: WorkspaceLifecycle, fromIso: string): string | undefined {
  const ttl = ttlForState(state)
  if (ttl === undefined || ttl <= 0) return undefined
  return new Date(Date.parse(fromIso) + ttl).toISOString()
}

function byteLength(value: JsonValue): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return 0
  }
}

/** Creates a fresh in-process durable workspace store. */
export function inMemoryDurableWorkspaceStore(): DurableWorkspaceStore {
  return new InMemoryDurableWorkspaceStore()
}
