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
  WorkspaceStartOptions
} from '../ports/workspace.js'

interface StoredWorkspace {
  workspaceRef: string
  state: 'active' | 'paused' | 'aborted' | 'cleanup_pending' | 'cleaned'
  runId: string
  sessionId: string
  attempt: number
  createdAt: string
  updatedAt: string
  metadata: Record<string, JsonValue>
  checkpoints: WorkspaceCheckpoint[]
}

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
    policy: {
      retention: {
        pausedTtlMs: 86_400_000,
        terminalFailureTtlMs: 86_400_000,
        terminalSuccessTtlMs: 0,
        cleanupMode: 'manual_only'
      },
      quota: { maxActiveWorkspaces: 100, maxWorkspaceBytes: 10_000_000 }
    }
  } satisfies DurableWorkspaceStoreInfo

  public readonly capabilities = this.info.capabilities
  private readonly workspaces = new Map<string, StoredWorkspace>()
  private nextId = 1

  public configureHarnessContext(): void {}

  public async startWorkspace(opts: WorkspaceStartOptions): Promise<WorkspaceHandle> {
    opts.signal?.throwIfAborted()
    const workspaceRef = `workspace_${this.nextId++}`
    const now = new Date().toISOString()
    const metadata = { ...(opts.metadata ?? {}) }
    const workspace: StoredWorkspace = {
      workspaceRef,
      state: 'active',
      runId: opts.runId,
      sessionId: opts.sessionId,
      attempt: opts.attempt,
      createdAt: now,
      updatedAt: now,
      metadata,
      checkpoints: []
    }
    this.workspaces.set(workspaceRef, workspace)
    return { workspaceRef, runId: opts.runId, sessionId: opts.sessionId, state: 'active', startedAt: now, attempt: opts.attempt, metadata }
  }

  public async pauseWorkspace(opts: WorkspacePauseOptions): Promise<WorkspaceCheckpoint> {
    opts.signal?.throwIfAborted()
    const workspace = this.requireWorkspace(opts.handle.workspaceRef)
    workspace.state = 'paused'
    workspace.updatedAt = new Date().toISOString()
    const checkpoint: WorkspaceCheckpoint = {
      workspaceRef: workspace.workspaceRef,
      checkpointRef: `${workspace.workspaceRef}:checkpoint:${opts.sequence}`,
      runId: workspace.runId,
      sessionId: workspace.sessionId,
      stepId: opts.stepId,
      sequence: opts.sequence,
      attempt: opts.attempt,
      committedAt: workspace.updatedAt,
      metadata: {
        reason: opts.reason,
        ...(opts.checkpointPayload !== undefined ? { checkpointPayload: opts.checkpointPayload } : {})
      }
    }
    workspace.checkpoints.push(checkpoint)
    return checkpoint
  }

  public async resumeWorkspace(opts: WorkspaceResumeOptions): Promise<WorkspaceHandle> {
    opts.signal?.throwIfAborted()
    const workspace = this.requireWorkspace(opts.workspaceRef)
    if (opts.checkpointRef && !workspace.checkpoints.some((checkpoint) => checkpoint.checkpointRef === opts.checkpointRef)) {
      throw new Error(`Unknown workspace checkpoint: ${opts.checkpointRef}`)
    }
    workspace.state = 'active'
    workspace.runId = opts.runId
    workspace.sessionId = opts.sessionId
    workspace.attempt = opts.attempt
    workspace.updatedAt = new Date().toISOString()
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

  public async abortWorkspace(opts: WorkspaceAbortOptions): Promise<WorkspaceAbortResult> {
    opts.signal?.throwIfAborted()
    const workspace = this.requireWorkspace(opts.workspaceRef)
    workspace.state = 'aborted'
    workspace.updatedAt = new Date().toISOString()
    return { workspaceRef: opts.workspaceRef, state: 'aborted', abortedAt: workspace.updatedAt }
  }

  public async cleanupWorkspace(opts: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult> {
    opts.signal?.throwIfAborted()
    const workspace = this.requireWorkspace(opts.workspaceRef)
    workspace.state = 'cleaned'
    workspace.updatedAt = new Date().toISOString()
    this.workspaces.delete(opts.workspaceRef)
    return { workspaceRef: opts.workspaceRef, state: 'cleaned', completedAt: workspace.updatedAt }
  }

  public async inspectWorkspace(opts: WorkspaceInspectionOptions): Promise<WorkspaceInspection> {
    opts.signal?.throwIfAborted()
    const workspaceRef = opts.workspaceRef ?? this.findWorkspaceByCheckpoint(opts.checkpointRef)
    const workspace = this.requireWorkspace(workspaceRef)
    const latest = workspace.checkpoints.at(-1)
    return {
      workspaceRef: workspace.workspaceRef,
      state: workspace.state,
      checkpoints: workspace.checkpoints,
      ...(latest ? { currentCheckpointRef: latest.checkpointRef } : {}),
      retention: this.info.policy.retention,
      quota: this.info.policy.quota,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      metadata: workspace.metadata
    }
  }

  private findWorkspaceByCheckpoint(checkpointRef: string | undefined): string {
    if (!checkpointRef) throw new Error('workspaceRef or checkpointRef is required.')
    const found = [...this.workspaces.values()].find((workspace) => workspace.checkpoints.some((checkpoint) => checkpoint.checkpointRef === checkpointRef))
    if (!found) throw new Error(`Unknown workspace checkpoint: ${checkpointRef}`)
    return found.workspaceRef
  }

  private requireWorkspace(workspaceRef: string): StoredWorkspace {
    const workspace = this.workspaces.get(workspaceRef)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceRef}`)
    return workspace
  }
}

/** Creates a fresh in-process durable workspace store. */
export function inMemoryDurableWorkspaceStore(): DurableWorkspaceStore {
  return new InMemoryDurableWorkspaceStore()
}
