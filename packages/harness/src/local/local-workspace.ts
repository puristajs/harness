import { mkdir, rm, cp, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { ulid } from '../ulid/index.js'
import { OperationCancelledError, WorkspaceError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import type {
  DurableWorkspacePolicy,
  DurableWorkspaceStore,
  DurableWorkspaceStoreInfo,
  WorkspaceEncryptionInfo,
  WorkspaceRetentionPolicy,
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

type WorkspaceState = 'active' | 'paused' | 'aborted' | 'cleanup_pending' | 'cleaned'

interface WorkspaceMeta {
  workspaceRef: string
  state: WorkspaceState
  runId: string
  sessionId: string
  attempt: number
  createdAt: string
  updatedAt: string
  metadata?: Record<string, JsonValue>
  checkpoints: WorkspaceCheckpoint[]
}

export interface LocalWorkspaceCoordinator {
  bind(runId: string, sessionId: string, workspaceRef: string, activePath: string): void
  get(runId: string, sessionId: string): { workspaceRef: string; activePath: string } | undefined
  unbind(runId: string, sessionId: string): void
}

export function createLocalWorkspaceCoordinator(): LocalWorkspaceCoordinator {
  const bindings = new Map<string, { workspaceRef: string; activePath: string }>()
  const key = (runId: string, sessionId: string) => `${sessionId}\n${runId}`
  return {
    bind: (runId, sessionId, workspaceRef, activePath) => bindings.set(key(runId, sessionId), { workspaceRef, activePath }),
    get: (runId, sessionId) => bindings.get(key(runId, sessionId)),
    unbind: (runId, sessionId) => { bindings.delete(key(runId, sessionId)) }
  }
}

export interface LocalDirectoryWorkspaceStoreOptions {
  /** Host root for durable workspaces. */
  root: string
  /** Optional policy metadata reported by the adapter. */
  policy?: Partial<DurableWorkspacePolicy>
  /** Internal coordinator shared with localDirectorySandbox. */
  coordinator?: LocalWorkspaceCoordinator
}

const DEFAULT_POLICY: DurableWorkspacePolicy = {
  retention: { cleanupMode: 'manual_only' },
  encryption: { encryptedAtRest: false, keyScope: 'application', rotationSupported: false, metadataEncrypted: false }
}

/** Host-directory durable workspace store used by localDurableExecution. */
export class LocalDirectoryWorkspaceStore implements DurableWorkspaceStore {
  public readonly info: DurableWorkspaceStoreInfo
  public readonly capabilities: readonly AdapterCapability[]
  private readonly root: string
  private readonly coordinator: LocalWorkspaceCoordinator | undefined
  private readonly opResults = new Map<string, unknown>()

  public constructor(options: LocalDirectoryWorkspaceStoreOptions) {
    this.root = resolve(options.root, 'workspaces')
    this.coordinator = options.coordinator
    const retention: WorkspaceRetentionPolicy = { cleanupMode: options.policy?.retention?.cleanupMode ?? DEFAULT_POLICY.retention!.cleanupMode }
    const encryption: WorkspaceEncryptionInfo = {
      encryptedAtRest: options.policy?.encryption?.encryptedAtRest ?? DEFAULT_POLICY.encryption!.encryptedAtRest,
      keyScope: options.policy?.encryption?.keyScope ?? DEFAULT_POLICY.encryption!.keyScope,
      rotationSupported: options.policy?.encryption?.rotationSupported ?? DEFAULT_POLICY.encryption!.rotationSupported,
      metadataEncrypted: options.policy?.encryption?.metadataEncrypted ?? DEFAULT_POLICY.encryption!.metadataEncrypted
    }
    this.info = {
      id: 'local_directory_workspace_store',
      packageName: '@purista/harness',
      capabilities: [
        'workspace_store.durable',
        'workspace_store.persistent',
        'workspace_store.checkpoint',
        'workspace_store.resume',
        'workspace_store.abort',
        'workspace_store.cleanup',
        'workspace_store.inspect',
        'workspace_store.retention'
      ],
      policy: {
        retention,
        encryption,
        ...(options.policy?.quota ? { quota: options.policy.quota } : {})
      }
    }
    this.capabilities = this.info.capabilities
  }

  public configureHarnessContext(): void {}

  public async startWorkspace(opts: WorkspaceStartOptions): Promise<WorkspaceHandle> {
    throwIfAborted(opts.signal)
    const replay = this.opResults.get(opts.idempotencyKey) as WorkspaceHandle | undefined
    if (replay) return replay
    const existing = await this.findByRun(opts.runId)
    const meta = existing ?? {
      workspaceRef: `workspace_${ulid()}`,
      state: 'active' as const,
      runId: opts.runId,
      sessionId: opts.sessionId,
      attempt: opts.attempt,
      createdAt: now(),
      updatedAt: now(),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      checkpoints: []
    }
    meta.state = 'active'
    meta.runId = opts.runId
    meta.sessionId = opts.sessionId
    meta.attempt = opts.attempt
    meta.updatedAt = now()
    await mkdir(this.activePath(meta.workspaceRef), { recursive: true })
    await mkdir(join(this.activePath(meta.workspaceRef), 'workspace'), { recursive: true })
    await this.writeMeta(meta)
    this.coordinator?.bind(opts.runId, opts.sessionId, meta.workspaceRef, this.activePath(meta.workspaceRef))
    const handle = toHandle(meta)
    this.opResults.set(opts.idempotencyKey, handle)
    return handle
  }

  public async pauseWorkspace(opts: WorkspacePauseOptions): Promise<WorkspaceCheckpoint> {
    throwIfAborted(opts.signal)
    const replay = this.opResults.get(opts.idempotencyKey) as WorkspaceCheckpoint | undefined
    if (replay) return replay
    const meta = await this.readMeta(opts.handle.workspaceRef)
    if (meta.state === 'aborted' || meta.state === 'cleaned') throw new WorkspaceError('Workspace cannot be checkpointed.', { reason: meta.state === 'aborted' ? 'aborted' : 'not_found', workspace_ref: meta.workspaceRef })
    const checkpointRef = `checkpoint_${opts.sequence}_${ulid()}`
    const checkpointPath = this.checkpointPath(meta.workspaceRef, checkpointRef)
    await rm(checkpointPath, { recursive: true, force: true })
    await mkdir(dirname(checkpointPath), { recursive: true })
    await cp(this.activePath(meta.workspaceRef), checkpointPath, { recursive: true, force: true })
    const sizeBytes = await directorySize(checkpointPath)
    const checkpoint: WorkspaceCheckpoint = {
      workspaceRef: meta.workspaceRef,
      checkpointRef,
      snapshotRef: checkpointRef,
      runId: meta.runId,
      sessionId: meta.sessionId,
      stepId: opts.stepId,
      sequence: opts.sequence,
      attempt: opts.attempt,
      committedAt: now(),
      sizeBytes,
      metadata: { reason: opts.reason }
    }
    meta.state = 'paused'
    meta.updatedAt = checkpoint.committedAt
    meta.checkpoints.push(checkpoint)
    await this.writeMeta(meta)
    this.opResults.set(opts.idempotencyKey, checkpoint)
    return checkpoint
  }

  public async resumeWorkspace(opts: WorkspaceResumeOptions): Promise<WorkspaceHandle> {
    throwIfAborted(opts.signal)
    const replay = this.opResults.get(opts.idempotencyKey) as WorkspaceHandle | undefined
    if (replay) return replay
    const meta = await this.readMeta(opts.workspaceRef)
    if (meta.state === 'aborted') throw new WorkspaceError('Workspace was aborted.', { reason: 'aborted', workspace_ref: opts.workspaceRef })
    if (meta.state === 'cleaned') throw new WorkspaceError('Workspace was cleaned.', { reason: 'not_found', workspace_ref: opts.workspaceRef })
    const checkpoint = opts.checkpointRef ? meta.checkpoints.find((item) => item.checkpointRef === opts.checkpointRef) : meta.checkpoints.at(-1)
    if (opts.checkpointRef && !checkpoint) throw new WorkspaceError('Workspace checkpoint not found.', { reason: 'missing_checkpoint', workspace_ref: opts.workspaceRef, checkpoint_ref: opts.checkpointRef })
    if (checkpoint) {
      await rm(this.activePath(meta.workspaceRef), { recursive: true, force: true })
      await cp(this.checkpointPath(meta.workspaceRef, checkpoint.checkpointRef), this.activePath(meta.workspaceRef), { recursive: true, force: true })
    }
    await mkdir(join(this.activePath(meta.workspaceRef), 'workspace'), { recursive: true })
    meta.state = 'active'
    meta.runId = opts.runId
    meta.sessionId = opts.sessionId
    meta.attempt = opts.attempt
    meta.updatedAt = now()
    await this.writeMeta(meta)
    this.coordinator?.bind(opts.runId, opts.sessionId, meta.workspaceRef, this.activePath(meta.workspaceRef))
    const handle = toHandle(meta)
    this.opResults.set(opts.idempotencyKey, handle)
    return handle
  }

  public async abortWorkspace(opts: WorkspaceAbortOptions): Promise<WorkspaceAbortResult> {
    throwIfAborted(opts.signal)
    const meta = await this.readMeta(opts.workspaceRef)
    meta.state = 'aborted'
    meta.updatedAt = now()
    await this.writeMeta(meta)
    this.coordinator?.unbind(opts.runId, opts.sessionId)
    return { workspaceRef: opts.workspaceRef, state: 'aborted', abortedAt: meta.updatedAt }
  }

  public async cleanupWorkspace(opts: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult> {
    throwIfAborted(opts.signal)
    const root = this.workspacePath(opts.workspaceRef)
    await assertInside(this.root, root)
    await rm(root, { recursive: true, force: true })
    return { workspaceRef: opts.workspaceRef, state: 'cleaned', completedAt: now() }
  }

  public async inspectWorkspace(opts: WorkspaceInspectionOptions): Promise<WorkspaceInspection> {
    throwIfAborted(opts.signal)
    const workspaceRef = opts.workspaceRef ?? await this.findRefByCheckpoint(opts.checkpointRef)
    const meta = await this.readMeta(workspaceRef)
    return {
      workspaceRef: meta.workspaceRef,
      state: meta.state,
      checkpoints: meta.checkpoints,
      ...(meta.checkpoints.at(-1) ? { currentCheckpointRef: meta.checkpoints.at(-1)!.checkpointRef } : {}),
      ...(this.info.policy.retention ? { retention: this.info.policy.retention } : {}),
      ...(this.info.policy.quota ? { quota: this.info.policy.quota } : {}),
      ...(this.info.policy.encryption ? { encryption: this.info.policy.encryption } : {}),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      ...(meta.metadata ? { metadata: meta.metadata } : {})
    }
  }

  private workspacePath(workspaceRef: string): string { return join(this.root, workspaceRef) }
  private activePath(workspaceRef: string): string { return join(this.workspacePath(workspaceRef), 'active') }
  private checkpointPath(workspaceRef: string, checkpointRef: string): string { return join(this.workspacePath(workspaceRef), 'checkpoints', checkpointRef) }
  private metaPath(workspaceRef: string): string { return join(this.workspacePath(workspaceRef), 'meta.json') }

  private async readMeta(workspaceRef: string): Promise<WorkspaceMeta> {
    try {
      return JSON.parse(await readFile(this.metaPath(workspaceRef), 'utf8')) as WorkspaceMeta
    } catch (error) {
      throw new WorkspaceError('Workspace not found.', { reason: 'not_found', workspace_ref: workspaceRef }, error)
    }
  }

  private async writeMeta(meta: WorkspaceMeta): Promise<void> {
    await mkdir(this.workspacePath(meta.workspaceRef), { recursive: true })
    await writeFile(this.metaPath(meta.workspaceRef), JSON.stringify(meta, null, 2))
  }

  private async findByRun(runId: string): Promise<WorkspaceMeta | undefined> {
    await mkdir(this.root, { recursive: true })
    const { readdir } = await import('node:fs/promises')
    for (const name of await readdir(this.root)) {
      try {
        const meta = await this.readMeta(name)
        if (meta.runId === runId && meta.state !== 'cleaned') return meta
      } catch {}
    }
    return undefined
  }

  private async findRefByCheckpoint(checkpointRef: string | undefined): Promise<string> {
    if (!checkpointRef) throw new WorkspaceError('workspaceRef or checkpointRef is required.', { reason: 'invalid_reference' })
    await mkdir(this.root, { recursive: true })
    const { readdir } = await import('node:fs/promises')
    for (const name of await readdir(this.root)) {
      try {
        const meta = await this.readMeta(name)
        if (meta.checkpoints.some((checkpoint) => checkpoint.checkpointRef === checkpointRef)) return meta.workspaceRef
      } catch {}
    }
    throw new WorkspaceError('Workspace checkpoint not found.', { reason: 'missing_checkpoint', checkpoint_ref: checkpointRef })
  }
}

function toHandle(meta: WorkspaceMeta): WorkspaceHandle {
  return {
    workspaceRef: meta.workspaceRef,
    runId: meta.runId,
    sessionId: meta.sessionId,
    state: 'active',
    startedAt: meta.updatedAt,
    attempt: meta.attempt,
    ...(meta.metadata ? { metadata: meta.metadata } : {})
  }
}

function now(): string { return new Date().toISOString() }

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationCancelledError('Workspace operation was cancelled.', { scope: 'workspace' })
}

async function directorySize(root: string): Promise<number> {
  const { readdir } = await import('node:fs/promises')
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size
  }
  return total
}

async function assertInside(root: string, target: string): Promise<void> {
  const rootResolved = resolve(root)
  const targetResolved = resolve(target)
  if (targetResolved !== rootResolved && !targetResolved.startsWith(`${rootResolved}/`)) {
    throw new WorkspaceError('Workspace path escaped local root.', { reason: 'invalid_reference' })
  }
}

export function localDirectoryWorkspaceStore(options: LocalDirectoryWorkspaceStoreOptions): DurableWorkspaceStore {
  return new LocalDirectoryWorkspaceStore(options)
}
