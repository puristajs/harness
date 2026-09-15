import { mkdir, rm, cp, readFile, writeFile, readdir, rename, stat, lstat, realpath } from 'node:fs/promises'
import { resolve, join, dirname, sep } from 'node:path'
import { ulid } from '../ulid/index.js'
import { OperationCancelledError, SandboxStateLostError, WorkspaceCleanupError, WorkspaceError, WorkspaceQuotaExceededError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'
import type {
  DurableWorkspacePolicy,
  DurableWorkspace,
  DurableWorkspaceInfo,
  WorkspaceAbortOptions,
  WorkspaceAbortResult,
  WorkspaceCheckpoint,
  WorkspaceCleanupOptions,
  WorkspaceCleanupResult,
  WorkspaceHandle,
  WorkspaceInspection,
  WorkspaceInspectionOptions,
  WorkspaceFinishOptions,
  WorkspacePinOptions,
  WorkspacePauseOptions,
  WorkspaceReleasePinOptions,
  WorkspaceResumeOptions,
  WorkspaceStartOptions
} from '../ports/workspace.js'
import type { SandboxAdministration, WorkspaceAdministrationOptions } from '../sandbox/administration.js'
import type { SandboxOwner, SandboxScope } from '../sandbox/ownership.js'
import { sandboxPartitionSchema } from '../sandbox/ownership.js'
import { sha256Hex } from './ref-hash.js'
import { readLocalWorkspacePartitionManifest, writeLocalWorkspaceRestoreFence } from './local-sandbox-state.js'
import { sandboxScopeKey } from '../sandbox/lifecycle.js'
import { LocalSandboxCatalog } from './local-sandbox-catalog.js'
import { cleanupEligibleAt, resolveLocalWorkspacePolicy } from './workspace-retention.js'

type WorkspaceState = 'active' | 'paused' | 'terminal' | 'aborted' | 'cleaned'

/** Idempotency record persisted with the workspace so replays survive restarts (spec 21 §9). */
interface PersistedWorkspaceOp {
  kind: 'start' | 'pause' | 'resume' | 'abort'
  runId: string
  sessionId: string
  result: WorkspaceHandle | WorkspaceCheckpoint | WorkspaceAbortResult
}

interface WorkspaceMeta {
  workspaceRef: string
  state: WorkspaceState
  runId: string
  sessionId: string
  sandboxOwner: SandboxOwner
  sandboxPolicyDigest: string
  attempt: number
  createdAt: string
  updatedAt: string
  metadata?: Record<string, JsonValue>
  checkpoints: WorkspaceCheckpoint[]
  pins?: string[]
  terminal?: { status: 'succeeded' | 'failed' | 'cancelled'; finishedAt: string }
  ops?: Record<string, PersistedWorkspaceOp>
}

export interface LocalWorkspaceCoordinator {
  bind(runId: string, owner: SandboxOwner, workspaceRef: string, activePath: string, restoreId?: string): void
  get(scope: SandboxScope): { workspaceRef: string; activePath: string; restoreId?: string; writerFence: LocalWorkspaceWriterFence } | undefined
  unbind(runId: string, owner: SandboxOwner): void
  fence<T>(runId: string, owner: SandboxOwner, operation: () => Promise<T>): Promise<T>
}

/** Private run-wide admission fence used only by the paired local adapters. */
export interface LocalWorkspaceWriterFence {
  enter(): Promise<() => void>
  trackProcess(): Promise<() => void>
}

/** Raised only inside local adapter coordination; converted at the workspace boundary. */
export class LocalWorkspaceWriterBusyError extends Error {}

class WorkspaceWriterFence implements LocalWorkspaceWriterFence {
  private readonly queuedAdmissions: Array<() => void> = []
  private activeWriters = 0
  private activeProcesses = 0
  private blocked = false
  private idle: (() => void) | undefined
  private barriers = Promise.resolve()

  public async enter(): Promise<() => void> { return await this.admit(false) }
  public async trackProcess(): Promise<() => void> { return await this.admit(true) }

  public async fence<T>(operation: () => Promise<T>): Promise<T> {
    let releaseBarrier!: () => void
    const barrier = new Promise<void>(resolve => { releaseBarrier = resolve })
    const previous = this.barriers
    this.barriers = previous.then(() => barrier)
    await previous
    this.blocked = true
    try {
      if (this.activeProcesses > 0) throw new LocalWorkspaceWriterBusyError('A local sandbox process is still writing the durable workspace.')
      if (this.activeWriters > 0) await new Promise<void>(resolve => { this.idle = resolve })
      return await operation()
    } finally {
      this.blocked = false
      while (this.queuedAdmissions.length > 0) this.queuedAdmissions.shift()!()
      releaseBarrier()
    }
  }

  private async admit(process: boolean): Promise<() => void> {
    await new Promise<void>(resolve => {
      const grant = (): void => {
        this.activeWriters += 1
        if (process) this.activeProcesses += 1
        resolve()
      }
      if (this.blocked) this.queuedAdmissions.push(grant)
      else grant()
    })
    let released = false
    return () => {
      if (released) return
      released = true
      this.activeWriters -= 1
      if (process) this.activeProcesses -= 1
      if (this.activeWriters === 0) this.idle?.()
      this.idle = undefined
    }
  }
}

export function createLocalWorkspaceCoordinator(): LocalWorkspaceCoordinator {
  const bindings = new Map<string, { runId: string; workspaceRef: string; activePath: string; restoreId?: string; writerFence: WorkspaceWriterFence }>()
  const key = (runId: string, owner: SandboxOwner) => JSON.stringify([runId, owner])
  return {
    bind: (runId, owner, workspaceRef, activePath, restoreId) => {
      const current = bindings.get(key(runId, owner))
      bindings.set(key(runId, owner), { runId, workspaceRef, activePath, writerFence: current?.writerFence ?? new WorkspaceWriterFence(), ...(restoreId ? { restoreId } : {}) })
    },
    get: (scope) => {
      if (scope.lifetime !== 'run') return undefined
      const exact = bindings.get(key(scope.runId, scope.owner))
      if (exact) return exact
      return [...bindings.values()].find((binding) => binding.runId === scope.runId)
    },
    unbind: (runId, owner) => { bindings.delete(key(runId, owner)) },
    fence: async (runId, owner, operation) => {
      const binding = bindings.get(key(runId, owner))
      return binding ? await binding.writerFence.fence(operation) : await operation()
    }
  }
}

export interface LocalDirectoryWorkspaceOptions {
  /** Host root for durable workspaces. */
  root: string
  /** Optional policy metadata reported by the adapter. */
  policy?: Partial<DurableWorkspacePolicy>
  /** Bounded operator catalog configuration for workspace-owned resources. */
  administration?: WorkspaceAdministrationOptions
  /** Internal coordinator shared with localDirectorySandbox. */
  coordinator?: LocalWorkspaceCoordinator
}

/** Refs are always `workspace_${ulid()}`; anything else is rejected before path use (spec 22 §4). */
const WORKSPACE_REF_PATTERN = /^workspace_[A-Z0-9]+$/

/** Host-directory durable workspace used by localDurableExecution. */
export class LocalDirectoryWorkspace implements DurableWorkspace {
  public readonly info: DurableWorkspaceInfo
  public readonly capabilities: readonly AdapterCapability[]
  public readonly administration: SandboxAdministration
  private readonly root: string
  private readonly coordinator: LocalWorkspaceCoordinator | undefined
  private readonly catalog: LocalSandboxCatalog
  /** In-process lookup caches; the persisted `meta.json` files stay authoritative. */
  private readonly runIdIndex = new Map<string, string>()
  private readonly opKeyIndex = new Map<string, string>()
  private activeResumes = 0
  private telemetry: TelemetryShim | undefined

  public constructor(options: LocalDirectoryWorkspaceOptions) {
    this.root = resolve(options.root, 'workspaces')
    this.coordinator = options.coordinator
    const policy = resolveLocalWorkspacePolicy(options.policy)
    const retention = policy.retention!
    const encryption = policy.encryption!
    this.catalog = new LocalSandboxCatalog({
      root: this.root,
      ...(options.administration ? { administration: options.administration } : {}),
      callbacks: { deleteResource: async (resource) => await this.deleteCatalogResource(resource.resourceId, resource.kind, resource.owner) }
    })
    this.administration = this.catalog
    this.info = {
      id: 'local_directory_workspace',
      packageName: '@purista/harness',
      capabilities: [
        'workspace.durable',
        'workspace.persistent',
        'workspace.checkpoint',
        'workspace.resume',
        'workspace.abort',
        'workspace.cleanup',
        'workspace.inspect',
        'workspace.retention'
      ],
      policy: {
        retention,
        encryption,
        quota: policy.quota!
      }
    }
    this.capabilities = this.info.capabilities
  }

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.telemetry = context.telemetry
  }

  /** Drops the run→sandbox coordinator binding once a durable run is finished/disposed. */
  public releaseRunBinding(runId: string, owner: SandboxOwner): void {
    this.coordinator?.unbind(runId, owner)
  }

  public async startWorkspace(opts: WorkspaceStartOptions): Promise<WorkspaceHandle> {
    return this.workspaceSpan('start', {
      'harness.run.id': opts.runId,
      'harness.session.id': opts.sessionId,
      'harness.workspace.attempt': opts.attempt
    }, async (recordAttrs) => {
      throwIfAborted(opts.signal)
      const replayed = await this.findPersistedOp(opts.idempotencyKey)
      if (replayed) {
        if (replayed.runId !== opts.runId || replayed.sessionId !== opts.sessionId) {
          throw new WorkspaceError('Workspace start idempotency key reused with a different run/session.', {
            reason: 'idempotency_conflict',
            workspace_ref: (replayed.result as WorkspaceHandle).workspaceRef,
            run_id: opts.runId,
            session_id: opts.sessionId
          })
        }
        const handle = replayed.result as WorkspaceHandle
        this.coordinator?.bind(opts.runId, handle.sandboxOwner, handle.workspaceRef, this.activePath(handle.workspaceRef))
        recordAttrs({ 'harness.workspace.state': 'active', 'harness.workspace.ref_hash': sha256Hex(handle.workspaceRef) })
        return handle
      }
      const existing = await this.findByRun(opts.runId)
      if (existing && (ownerKey(existing.sandboxOwner) !== ownerKey(opts.sandboxOwner) || existing.sandboxPolicyDigest !== opts.sandboxPolicyDigest)) {
        throw new WorkspaceError('Workspace owner or durable partition policy changed.', {
          reason: 'idempotency_conflict', workspace_ref: existing.workspaceRef, run_id: opts.runId
        })
      }
      const created = existing === undefined
      const meta = existing ?? {
        workspaceRef: `workspace_${ulid()}`,
        state: 'active' as const,
        runId: opts.runId,
        sessionId: opts.sessionId,
        sandboxOwner: opts.sandboxOwner,
        sandboxPolicyDigest: opts.sandboxPolicyDigest,
        attempt: opts.attempt,
        createdAt: now(),
        updatedAt: now(),
        ...(opts.metadata ? { metadata: opts.metadata } : {}),
        checkpoints: []
      }
      if (created) {
        const activeWorkspaces = (await this.scanMetas()).filter((item) => item.state === 'active').length
        const limit = this.info.policy.quota?.maxActiveWorkspaces
        if (limit !== undefined && activeWorkspaces >= limit) {
          throw new WorkspaceQuotaExceededError('Active workspace quota exceeded.', { quota: 'maxActiveWorkspaces', limit, actual: activeWorkspaces })
        }
        await this.catalog.registerOwner({ owner: meta.sandboxOwner, mode: 'create', ...(opts.signal ? { signal: opts.signal } : {}) })
        await this.catalog.provision({ resourceId: meta.workspaceRef, kind: 'workspace', owner: meta.sandboxOwner, pinned: false, idempotencyKey: meta.workspaceRef })
      }
      meta.state = 'active'
      meta.runId = opts.runId
      meta.sessionId = opts.sessionId
      meta.attempt = opts.attempt
      meta.updatedAt = now()
      const handle = toHandle(meta)
      try {
        await mkdir(this.activePath(meta.workspaceRef), { recursive: true })
        await mkdir(join(this.activePath(meta.workspaceRef), 'partitions'), { recursive: true })
        this.persistOp(meta, opts.idempotencyKey, { kind: 'start', runId: opts.runId, sessionId: opts.sessionId, result: handle })
        await this.writeMeta(meta)
        if (created) await this.catalog.activate(meta.workspaceRef)
      } catch (error) {
        if (created) await this.catalog.markDeleted(meta.workspaceRef).catch(() => undefined)
        throw error
      }
      this.coordinator?.bind(opts.runId, meta.sandboxOwner, meta.workspaceRef, this.activePath(meta.workspaceRef))
      recordAttrs({ 'harness.workspace.state': 'active', 'harness.workspace.ref_hash': sha256Hex(meta.workspaceRef) })
      return handle
    })
  }

  public async pauseWorkspace(opts: WorkspacePauseOptions): Promise<WorkspaceCheckpoint> {
    return this.workspaceSpan('pause', {
      'harness.run.id': opts.handle.runId,
      'harness.session.id': opts.handle.sessionId,
      'harness.workspace.ref_hash': sha256Hex(opts.handle.workspaceRef),
      'harness.workspace.attempt': opts.attempt,
      'harness.workspace.sequence': opts.sequence,
      'harness.workflow.step_id': opts.stepId
    }, async (recordAttrs) => {
      throwIfAborted(opts.signal)
      const meta = await this.readMeta(opts.handle.workspaceRef)
      const replay = meta.ops?.[opts.idempotencyKey]
      if (replay) {
        assertReplayMatches(replay, 'pause', opts.handle.runId, opts.handle.sessionId, meta.workspaceRef)
        const checkpoint = replay.result as WorkspaceCheckpoint
        recordAttrs({ 'harness.workspace.state': meta.state, 'harness.workspace.checkpoint_ref_hash': sha256Hex(checkpoint.checkpointRef) })
        return checkpoint
      }
      if (meta.state === 'aborted' || meta.state === 'cleaned') throw new WorkspaceError('Workspace cannot be checkpointed.', { reason: meta.state === 'aborted' ? 'aborted' : 'not_found', workspace_ref: meta.workspaceRef })
      const checkpointPayloadBytes = serializedCheckpointPayloadBytes(opts.checkpointPayload)
      const payloadLimit = this.info.policy.quota?.maxCheckpointPayloadBytes
      if (payloadLimit !== undefined && checkpointPayloadBytes > payloadLimit) {
        throw this.snapshotQuota('maxCheckpointPayloadBytes', payloadLimit, checkpointPayloadBytes, meta.workspaceRef, recordAttrs)
      }
      let checkpoint: WorkspaceCheckpoint
      try {
        checkpoint = await this.coordinator?.fence(meta.runId, meta.sandboxOwner, async () => await this.copyCheckpoint(meta, opts, recordAttrs))
          ?? await this.copyCheckpoint(meta, opts, recordAttrs)
      } catch (error) {
        if (error instanceof LocalWorkspaceWriterBusyError) {
          throw new WorkspaceError('Workspace checkpoint requires all local sandbox processes to finish first.', {
            reason: 'checkpoint_conflict', workspace_ref: meta.workspaceRef, run_id: meta.runId
          })
        }
        throw error
      }
      this.telemetry?.recordHistogram('harness.workspace.bytes', checkpoint.sizeBytes ?? 0, {
        'harness.workspace.adapter': this.info.id,
        'harness.workspace.operation': 'pause'
      })
      recordAttrs({ 'harness.workspace.state': 'paused', 'harness.workspace.checkpoint_ref_hash': sha256Hex(checkpoint.checkpointRef) })
      return checkpoint
    })
  }

  public async resumeWorkspace(opts: WorkspaceResumeOptions): Promise<WorkspaceHandle> {
    return this.workspaceSpan('resume', {
      'harness.run.id': opts.runId,
      'harness.session.id': opts.sessionId,
      'harness.workspace.ref_hash': sha256Hex(opts.workspaceRef),
      'harness.workspace.attempt': opts.attempt,
      ...(opts.checkpointRef ? { 'harness.workspace.checkpoint_ref_hash': sha256Hex(opts.checkpointRef) } : {})
    }, async (recordAttrs) => {
      throwIfAborted(opts.signal)
      const meta = await this.readMeta(opts.workspaceRef)
      const replay = meta.ops?.[opts.idempotencyKey]
      if (replay) {
        assertReplayMatches(replay, 'resume', opts.runId, opts.sessionId, meta.workspaceRef)
        const handle = replay.result as WorkspaceHandle
        this.coordinator?.bind(opts.runId, meta.sandboxOwner, meta.workspaceRef, this.activePath(meta.workspaceRef), opts.idempotencyKey)
        recordAttrs({ 'harness.workspace.state': meta.state })
        return handle
      }
      if (meta.state === 'aborted') throw new WorkspaceError('Workspace was aborted.', { reason: 'aborted', workspace_ref: opts.workspaceRef })
      if (meta.state === 'terminal') throw new WorkspaceError('Workspace has a terminal durable result.', { reason: 'aborted', workspace_ref: opts.workspaceRef })
      if (meta.state === 'cleaned') throw new WorkspaceError('Workspace was cleaned.', { reason: 'not_found', workspace_ref: opts.workspaceRef })
      const checkpoint = opts.checkpointRef ? meta.checkpoints.find((item) => item.checkpointRef === opts.checkpointRef) : meta.checkpoints.at(-1)
      if (opts.checkpointRef && !checkpoint) throw new WorkspaceError('Workspace checkpoint not found.', { reason: 'missing_checkpoint', workspace_ref: opts.workspaceRef, checkpoint_ref: opts.checkpointRef })
      const limit = this.info.policy.quota?.maxConcurrentResumes
      if (limit !== undefined && this.activeResumes >= limit) {
        throw new WorkspaceQuotaExceededError('Concurrent workspace resume quota exceeded.', { quota: 'maxConcurrentResumes', limit, actual: this.activeResumes })
      }
      this.activeResumes += 1
      try {
        if (checkpoint) try {
          if (this.coordinator) {
            await this.coordinator.fence(meta.runId, meta.sandboxOwner, async () => await this.restoreCheckpoint(meta, checkpoint))
          } else {
            await this.restoreCheckpoint(meta, checkpoint)
          }
        } catch (error) {
          if (error instanceof LocalWorkspaceWriterBusyError) {
            throw new WorkspaceError('Workspace restore requires all local sandbox processes to finish first.', {
              reason: 'checkpoint_conflict', workspace_ref: meta.workspaceRef, run_id: meta.runId
            })
          }
          throw error
        }
        await mkdir(join(this.activePath(meta.workspaceRef), 'partitions'), { recursive: true })
        meta.state = 'active'
        meta.runId = opts.runId
        meta.sessionId = opts.sessionId
        meta.attempt = opts.attempt
        meta.updatedAt = now()
        const handle = toHandle(meta)
        this.persistOp(meta, opts.idempotencyKey, { kind: 'resume', runId: opts.runId, sessionId: opts.sessionId, result: handle })
        await this.writeMeta(meta)
        await this.catalog.setResourceState(meta.workspaceRef, 'active')
        this.coordinator?.bind(opts.runId, meta.sandboxOwner, meta.workspaceRef, this.activePath(meta.workspaceRef), checkpoint?.checkpointRef)
        recordAttrs({ 'harness.workspace.state': 'active' })
        return handle
      } finally {
        this.activeResumes -= 1
      }
    })
  }

  public async abortWorkspace(opts: WorkspaceAbortOptions): Promise<WorkspaceAbortResult> {
    return this.workspaceSpan('abort', {
      'harness.run.id': opts.runId,
      'harness.session.id': opts.sessionId,
      'harness.workspace.ref_hash': sha256Hex(opts.workspaceRef)
    }, async (recordAttrs) => {
      throwIfAborted(opts.signal)
      const meta = await this.readMeta(opts.workspaceRef)
      const replay = meta.ops?.[opts.idempotencyKey]
      if (replay) {
        assertReplayMatches(replay, 'abort', opts.runId, opts.sessionId, meta.workspaceRef)
        recordAttrs({ 'harness.workspace.state': 'aborted' })
        this.coordinator?.unbind(opts.runId, meta.sandboxOwner)
        return replay.result as WorkspaceAbortResult
      }
      meta.state = 'aborted'
      meta.updatedAt = now()
      const eligibleAt = cleanupEligibleAt(this.info.policy.retention!, 'aborted', meta.updatedAt)
      const result: WorkspaceAbortResult = { workspaceRef: opts.workspaceRef, state: 'aborted', abortedAt: meta.updatedAt, ...(eligibleAt ? { cleanupEligibleAt: eligibleAt } : {}) }
      this.persistOp(meta, opts.idempotencyKey, { kind: 'abort', runId: opts.runId, sessionId: opts.sessionId, result })
      await this.writeMeta(meta)
      await this.catalog.setResourceState(meta.workspaceRef, 'terminal')
      await this.catalog.setResourceExpiry(meta.workspaceRef, eligibleAt)
      for (const checkpoint of meta.checkpoints) await this.catalog.setResourceExpiry(checkpoint.checkpointRef, eligibleAt)
      this.coordinator?.unbind(opts.runId, meta.sandboxOwner)
      recordAttrs({ 'harness.workspace.state': 'aborted' })
      return result
    })
  }

  public async pinCheckpoint(opts: WorkspacePinOptions): Promise<void> {
    return this.workspaceSpan('pin_checkpoint', { 'harness.workspace.ref_hash': sha256Hex(opts.workspaceRef) }, async () => {
      throwIfAborted(opts.signal)
      const meta = await this.readMeta(opts.workspaceRef)
      this.assertRun(meta, opts.runId)
      if (!meta.checkpoints.some((checkpoint) => checkpoint.checkpointRef === opts.checkpointRef)) {
        throw new WorkspaceError('Workspace checkpoint not found.', { reason: 'missing_checkpoint', workspace_ref: opts.workspaceRef, checkpoint_ref: opts.checkpointRef })
      }
      if (!(meta.pins ?? []).includes(opts.checkpointRef)) {
        // Pin the aggregate root first, then its checkpoint. A crash before
        // metadata persistence can retain harmless extra catalog pins; the
        // opposite order could let a sweep remove the recovery tree.
        await this.catalog.setResourcePinned(meta.workspaceRef, true)
        await this.catalog.setSnapshotPinned(opts.checkpointRef, true)
        meta.pins = [...(meta.pins ?? []), opts.checkpointRef]
        await this.writeMeta(meta)
      }
    })
  }

  public async releaseCheckpoint(opts: WorkspaceReleasePinOptions): Promise<void> {
    return this.workspaceSpan('release_checkpoint', { 'harness.workspace.ref_hash': sha256Hex(opts.workspaceRef) }, async () => {
      throwIfAborted(opts.signal)
      const meta = await this.readMeta(opts.workspaceRef)
      this.assertRun(meta, opts.runId)
      // Release metadata first for the same safety direction as pinning:
      // interruption may over-retain, never under-retain a recovery point.
      meta.pins = (meta.pins ?? []).filter((checkpointRef) => checkpointRef !== opts.checkpointRef)
      await this.writeMeta(meta)
      await this.catalog.setSnapshotPinned(opts.checkpointRef, false)
      if (meta.pins.length === 0) await this.catalog.setResourcePinned(meta.workspaceRef, false)
    })
  }

  public async finish(opts: WorkspaceFinishOptions): Promise<void> {
    return this.workspaceSpan('finish', { 'harness.workspace.ref_hash': sha256Hex(opts.workspaceRef) }, async (recordAttrs) => {
      throwIfAborted(opts.signal)
      const meta = await this.readMeta(opts.workspaceRef)
      this.assertRun(meta, opts.runId)
      if (meta.terminal && meta.terminal.status !== opts.status) {
        throw new WorkspaceError('Workspace terminal outcome conflicts with the recorded result.', { reason: 'idempotency_conflict', workspace_ref: opts.workspaceRef, run_id: opts.runId })
      }
      if (!meta.terminal) {
        const finishedAt = now()
        meta.terminal = { status: opts.status, finishedAt }
        meta.state = 'terminal'
        meta.updatedAt = finishedAt
        await this.writeMeta(meta)
        await this.catalog.setResourceState(meta.workspaceRef, 'terminal')
        const expiresAt = cleanupEligibleAt(this.info.policy.retention!, 'terminal', finishedAt, opts.status)
        await this.catalog.setResourceExpiry(meta.workspaceRef, expiresAt)
        for (const checkpoint of meta.checkpoints) await this.catalog.setResourceExpiry(checkpoint.checkpointRef, expiresAt)
      }
      recordAttrs({ 'harness.workspace.state': 'terminal' })
    })
  }

  public async cleanupWorkspace(opts: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult> {
    return this.workspaceSpan('cleanup', {
      'harness.workspace.ref_hash': sha256Hex(opts.workspaceRef),
      'harness.workspace.cleanup.reason': opts.reason
    }, async (recordAttrs) => {
      throwIfAborted(opts.signal)
      const root = this.workspacePath(opts.workspaceRef)
      const meta = await this.readMeta(opts.workspaceRef).catch(() => undefined)
      try {
        // Realpath jail: only delete when the addressed directory truly resolves
        // inside `<root>/workspaces` (spec 22 §4).
        const target = await assertInsideRealpath(this.root, root)
        if (target) await rm(target, { recursive: true, force: true })
      } catch (error) {
        this.telemetry?.recordCounter('harness.workspace.cleanup.failures', 1, {
          'harness.workspace.adapter': this.info.id,
          'harness.workspace.operation': 'cleanup',
          'harness.workspace.cleanup.reason': opts.reason,
          'error.type': error instanceof Error ? error.name : 'unknown'
        })
        if (error instanceof WorkspaceError) throw error
        throw new WorkspaceCleanupError('Workspace cleanup failed.', { reason: 'backend_failure', workspace_ref: opts.workspaceRef }, error)
      }
      this.evictFromIndexes(opts.workspaceRef)
      await this.catalog.markDeleted(opts.workspaceRef)
      for (const checkpoint of meta?.checkpoints ?? []) await this.catalog.markDeleted(checkpoint.checkpointRef)
      recordAttrs({ 'harness.workspace.state': 'cleaned' })
      return { workspaceRef: opts.workspaceRef, state: 'cleaned', completedAt: now() }
    })
  }

  public async inspectWorkspace(opts: WorkspaceInspectionOptions): Promise<WorkspaceInspection> {
    return this.workspaceSpan('inspect', {
      ...(opts.workspaceRef ? { 'harness.workspace.ref_hash': sha256Hex(opts.workspaceRef) } : {}),
      ...(opts.checkpointRef ? { 'harness.workspace.checkpoint_ref_hash': sha256Hex(opts.checkpointRef) } : {})
    }, async (recordAttrs) => {
      throwIfAborted(opts.signal)
      const workspaceRef = opts.workspaceRef ?? await this.findRefByCheckpoint(opts.checkpointRef)
      const meta = await this.readMeta(workspaceRef)
      const expiresAt = meta.state === 'aborted'
        ? cleanupEligibleAt(this.info.policy.retention!, 'aborted', meta.updatedAt)
        : meta.state === 'terminal' && meta.terminal
          ? cleanupEligibleAt(this.info.policy.retention!, 'terminal', meta.terminal.finishedAt, meta.terminal.status)
          : undefined
      recordAttrs({ 'harness.workspace.state': meta.state, 'harness.workspace.ref_hash': sha256Hex(workspaceRef) })
      return {
        workspaceRef: meta.workspaceRef,
        state: meta.state,
        checkpoints: meta.checkpoints,
        ...(meta.checkpoints.at(-1) ? { currentCheckpointRef: meta.checkpoints.at(-1)!.checkpointRef } : {}),
        sandboxOwner: meta.sandboxOwner,
        sandboxPolicyDigest: meta.sandboxPolicyDigest,
        ...(meta.terminal ? { terminal: meta.terminal } : {}),
        ...(this.info.policy.retention ? { retention: this.info.policy.retention } : {}),
        ...(this.info.policy.quota ? { quota: this.info.policy.quota } : {}),
        ...(this.info.policy.encryption ? { encryption: this.info.policy.encryption } : {}),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        ...(expiresAt ? { expiresAt, cleanupEligibleAt: expiresAt } : {}),
        ...(meta.metadata ? { metadata: meta.metadata } : {})
      }
    })
  }

  private workspacePath(workspaceRef: string): string {
    if (!WORKSPACE_REF_PATTERN.test(workspaceRef)) {
      throw new WorkspaceError('Workspace reference is invalid.', { reason: 'invalid_reference', workspace_ref: workspaceRef })
    }
    return join(this.root, workspaceRef)
  }

  private activePath(workspaceRef: string): string { return join(this.workspacePath(workspaceRef), 'active') }
  private checkpointPath(workspaceRef: string, checkpointRef: string): string { return join(this.workspacePath(workspaceRef), 'checkpoints', checkpointRef) }
  private metaPath(workspaceRef: string): string { return join(this.workspacePath(workspaceRef), 'meta.json') }

  private async readMeta(workspaceRef: string): Promise<WorkspaceMeta> {
    const path = this.metaPath(workspaceRef)
    try {
      return JSON.parse(await readFile(path, 'utf8')) as WorkspaceMeta
    } catch (error) {
      if (error instanceof WorkspaceError) throw error
      throw new WorkspaceError('Workspace not found.', { reason: 'not_found', workspace_ref: workspaceRef }, error)
    }
  }

  /** Crash-atomic meta write: temp file plus rename (spec 21 §9 pause-failure semantics). */
  private async writeMeta(meta: WorkspaceMeta): Promise<void> {
    await mkdir(this.workspacePath(meta.workspaceRef), { recursive: true })
    const path = this.metaPath(meta.workspaceRef)
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(meta, null, 2))
    await rename(tmp, path)
    this.runIdIndex.set(meta.runId, meta.workspaceRef)
    for (const key of Object.keys(meta.ops ?? {})) this.opKeyIndex.set(key, meta.workspaceRef)
  }

  private persistOp(meta: WorkspaceMeta, key: string, op: PersistedWorkspaceOp): void {
    meta.ops = { ...meta.ops, [key]: op }
  }

  private evictFromIndexes(workspaceRef: string): void {
    for (const [runId, ref] of this.runIdIndex) {
      if (ref === workspaceRef) this.runIdIndex.delete(runId)
    }
    for (const [key, ref] of this.opKeyIndex) {
      if (ref === workspaceRef) this.opKeyIndex.delete(key)
    }
  }

  private async findPersistedOp(idempotencyKey: string): Promise<PersistedWorkspaceOp | undefined> {
    const indexed = this.opKeyIndex.get(idempotencyKey)
    if (indexed) {
      const meta = await this.readMeta(indexed).catch(() => undefined)
      const op = meta?.ops?.[idempotencyKey]
      if (op) return op
      this.opKeyIndex.delete(idempotencyKey)
    }
    for (const meta of await this.scanMetas()) {
      const op = meta.ops?.[idempotencyKey]
      if (op) {
        this.opKeyIndex.set(idempotencyKey, meta.workspaceRef)
        return op
      }
    }
    return undefined
  }

  private async findByRun(runId: string): Promise<WorkspaceMeta | undefined> {
    const indexed = this.runIdIndex.get(runId)
    if (indexed) {
      const meta = await this.readMeta(indexed).catch(() => undefined)
      if (meta && meta.runId === runId && meta.state !== 'cleaned') return meta
      this.runIdIndex.delete(runId)
    }
    for (const meta of await this.scanMetas()) {
      if (meta.runId === runId && meta.state !== 'cleaned') {
        this.runIdIndex.set(runId, meta.workspaceRef)
        return meta
      }
    }
    return undefined
  }

  private async findRefByCheckpoint(checkpointRef: string | undefined): Promise<string> {
    if (!checkpointRef) throw new WorkspaceError('workspaceRef or checkpointRef is required.', { reason: 'invalid_reference' })
    for (const meta of await this.scanMetas()) {
      if (meta.checkpoints.some((checkpoint) => checkpoint.checkpointRef === checkpointRef)) return meta.workspaceRef
    }
    throw new WorkspaceError('Workspace checkpoint not found.', { reason: 'missing_checkpoint', checkpoint_ref: checkpointRef })
  }

  private assertRun(meta: WorkspaceMeta, runId: string): void {
    if (meta.runId !== runId) {
      throw new WorkspaceError('Workspace belongs to another durable run.', { reason: 'idempotency_conflict', workspace_ref: meta.workspaceRef, run_id: runId })
    }
  }

  private async copyCheckpoint(meta: WorkspaceMeta, opts: WorkspacePauseOptions, recordAttrs: (extra: SpanAttrs) => void): Promise<WorkspaceCheckpoint> {
    const checkpointRef = `checkpoint_${opts.sequence}_${ulid()}`
    const checkpointPath = this.checkpointPath(meta.workspaceRef, checkpointRef)
    const projectedBytes = await directorySize(this.activePath(meta.workspaceRef))
    await this.reserveCheckpoint(meta, checkpointRef, projectedBytes)
    let sizeBytes: number
    try {
      await rm(checkpointPath, { recursive: true, force: true })
      await mkdir(dirname(checkpointPath), { recursive: true })
      await cp(this.activePath(meta.workspaceRef), checkpointPath, { recursive: true, force: true, dereference: false })
      sizeBytes = await directorySize(checkpointPath)
      const limit = this.info.policy.quota?.maxSnapshotBytes
      if (limit !== undefined && sizeBytes > limit) throw this.snapshotQuota('maxSnapshotBytes', limit, sizeBytes, meta.workspaceRef, recordAttrs)
      await this.catalog.setResourceSize(checkpointRef, sizeBytes)
      await this.catalog.activate(checkpointRef)
    } catch (error) {
      await rm(checkpointPath, { recursive: true, force: true }).catch(() => undefined)
      await this.catalog.markDeleted(checkpointRef).catch(() => undefined)
      throw error
    }
    const persistedPartitions = await readLocalWorkspacePartitionManifest(this.workspacePath(meta.workspaceRef), meta.sandboxOwner, meta.runId)
    const checkpoint: WorkspaceCheckpoint = {
      workspaceRef: meta.workspaceRef,
      checkpointRef,
      snapshotRef: checkpointRef,
      runId: meta.runId,
      sessionId: meta.sessionId,
      sandboxPolicyDigest: meta.sandboxPolicyDigest,
      sandboxPartitions: persistedPartitions ?? canonicalPartitions(opts.sandboxPartitions),
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
    this.persistOp(meta, opts.idempotencyKey, { kind: 'pause', runId: meta.runId, sessionId: meta.sessionId, result: checkpoint })
    await this.writeMeta(meta)
    await this.catalog.setResourceState(meta.workspaceRef, 'paused')
    return checkpoint
  }

  private async reserveCheckpoint(meta: WorkspaceMeta, checkpointRef: string, projectedBytes: number): Promise<void> {
    const quota = this.info.policy.quota!
    const paused = (await this.scanMetas()).filter((item) => item.state === 'paused' && item.workspaceRef !== meta.workspaceRef).length
    if (meta.state !== 'paused' && paused >= quota.maxPausedWorkspaces!) {
      throw new WorkspaceQuotaExceededError('Paused workspace quota exceeded.', { quota: 'maxPausedWorkspaces', limit: quota.maxPausedWorkspaces!, actual: paused })
    }
    if (projectedBytes > quota.maxSnapshotBytes!) throw this.snapshotQuota('maxSnapshotBytes', quota.maxSnapshotBytes!, projectedBytes, meta.workspaceRef)
    let retainedBytes = meta.checkpoints.reduce((total, checkpoint) => total + (checkpoint.sizeBytes ?? 0), 0)
    const removable = meta.checkpoints.slice(0, -1).filter((checkpoint) => !(meta.pins ?? []).includes(checkpoint.checkpointRef))
    while ((meta.checkpoints.length + 1 > quota.maxSnapshotsPerWorkspace! || retainedBytes + projectedBytes > quota.maxRetainedSnapshotBytes!) && removable.length > 0) {
      const checkpoint = removable.shift()!
      await rm(this.checkpointPath(meta.workspaceRef, checkpoint.checkpointRef), { recursive: true, force: true })
      await this.catalog.markDeleted(checkpoint.checkpointRef)
      meta.checkpoints = meta.checkpoints.filter((item) => item.checkpointRef !== checkpoint.checkpointRef)
      retainedBytes -= checkpoint.sizeBytes ?? 0
    }
    if (meta.checkpoints.length + 1 > quota.maxSnapshotsPerWorkspace!) {
      throw this.snapshotQuota('maxSnapshotsPerWorkspace', quota.maxSnapshotsPerWorkspace!, meta.checkpoints.length + 1, meta.workspaceRef)
    }
    if (retainedBytes + projectedBytes > quota.maxRetainedSnapshotBytes!) {
      throw this.snapshotQuota('maxRetainedSnapshotBytes', quota.maxRetainedSnapshotBytes!, retainedBytes + projectedBytes, meta.workspaceRef)
    }
    await this.catalog.provision({ resourceId: checkpointRef, kind: 'snapshot', owner: meta.sandboxOwner, pinned: false, idempotencyKey: checkpointRef })
    await this.writeMeta(meta)
  }

  private snapshotQuota(quota: string, limit: number, actual: number, workspaceRef: string, recordAttrs?: (extra: SpanAttrs) => void): WorkspaceQuotaExceededError {
    this.telemetry?.recordCounter('harness.workspace.quota.exceeded', 1, {
      'harness.workspace.adapter': this.info.id,
      'harness.workspace.operation': 'pause',
      'harness.workspace.quota': quota
    })
    recordAttrs?.({ 'harness.workspace.quota': quota })
    return new WorkspaceQuotaExceededError('Workspace snapshot quota exceeded.', { quota, limit, actual, workspace_ref: workspaceRef })
  }

  private async restoreCheckpoint(meta: WorkspaceMeta, checkpoint: WorkspaceCheckpoint): Promise<void> {
    await this.assertCheckpointRecoverable(meta, checkpoint)
    await writeLocalWorkspaceRestoreFence(this.workspacePath(meta.workspaceRef), checkpoint.checkpointRef)
    await rm(this.activePath(meta.workspaceRef), { recursive: true, force: true })
    await cp(this.checkpointPath(meta.workspaceRef, checkpoint.checkpointRef), this.activePath(meta.workspaceRef), { recursive: true, force: true })
  }

  /** Deletes only an inventory record's owned payload; provider references never enter this path. */
  private async deleteCatalogResource(resourceId: string, kind: 'sandbox' | 'workspace' | 'snapshot', owner: SandboxOwner): Promise<void> {
    if (kind === 'workspace') {
      const meta = await this.readMeta(resourceId).catch(() => undefined)
      if (meta && ownerKey(meta.sandboxOwner) !== ownerKey(owner)) throw new WorkspaceError('Workspace owner does not match its catalog record.', { reason: 'idempotency_conflict', workspace_ref: resourceId })
      const target = await assertInsideRealpath(this.root, this.workspacePath(resourceId))
      if (target) await rm(target, { recursive: true, force: true })
      this.evictFromIndexes(resourceId)
      return
    }
    if (kind !== 'snapshot') return
    for (const meta of await this.scanMetas()) {
      if (ownerKey(meta.sandboxOwner) !== ownerKey(owner)) continue
      const checkpoint = meta.checkpoints.find((item) => item.checkpointRef === resourceId)
      if (!checkpoint) continue
      await rm(this.checkpointPath(meta.workspaceRef, resourceId), { recursive: true, force: true })
      meta.checkpoints = meta.checkpoints.filter((item) => item.checkpointRef !== resourceId)
      meta.pins = (meta.pins ?? []).filter((item) => item !== resourceId)
      meta.updatedAt = now()
      await this.writeMeta(meta)
      return
    }
  }

  /** Verifies every committed partition before mutating the active tree. */
  private async assertCheckpointRecoverable(meta: WorkspaceMeta, checkpoint: WorkspaceCheckpoint): Promise<void> {
    if (checkpoint.sandboxPolicyDigest !== meta.sandboxPolicyDigest) {
      throw new WorkspaceError('Workspace checkpoint policy does not match the active durable workspace.', {
        reason: 'checkpoint_conflict', workspace_ref: meta.workspaceRef, checkpoint_ref: checkpoint.checkpointRef
      })
    }
    const checkpointPath = this.checkpointPath(meta.workspaceRef, checkpoint.checkpointRef)
    try {
      if (!(await stat(checkpointPath)).isDirectory()) throw new Error('Checkpoint root is unavailable')
      // A standalone local workspace has no sandbox attachment authority. Its
      // generic checkpoint remains valid, while a workspace with this private
      // manifest must prove every captured sandbox partition exists.
      if (!await readLocalWorkspacePartitionManifest(this.workspacePath(meta.workspaceRef), meta.sandboxOwner, meta.runId)) return
      for (const partition of checkpoint.sandboxPartitions) {
        const parsed = sandboxPartitionSchema.safeParse(partition)
        if (!parsed.success) throw new Error('Checkpoint partition is invalid')
        const scope: SandboxScope = { owner: meta.sandboxOwner, partition: parsed.data, lifetime: 'run', runId: meta.runId }
        const path = join(checkpointPath, 'partitions', sha256Hex(sandboxScopeKey(scope)), 'workspace')
        if (!(await stat(path)).isDirectory()) throw new Error('Committed partition is unavailable')
      }
    } catch (error) {
      if (error instanceof WorkspaceError || error instanceof SandboxStateLostError) throw error
      throw new SandboxStateLostError('A committed local workspace partition is missing or invalid.', {
        reason: 'durable_workspace_recovery_unavailable', lifetime: 'run', adapter_id: 'local_directory'
      })
    }
  }

  private async scanMetas(): Promise<WorkspaceMeta[]> {
    await mkdir(this.root, { recursive: true })
    const metas: WorkspaceMeta[] = []
    for (const name of await readdir(this.root)) {
      if (!WORKSPACE_REF_PATTERN.test(name)) continue
      const meta = await this.readMeta(name).catch(() => undefined)
      if (meta) metas.push(meta)
    }
    return metas
  }

  private async workspaceSpan<T>(operation: string, attrs: SpanAttrs, fn: (recordAttrs: (extra: SpanAttrs) => void) => Promise<T>): Promise<T> {
    const merged: SpanAttrs = {
      'harness.workspace.adapter': this.info.id,
      'harness.workspace.operation': operation,
      'harness.workspace.persistent': true,
      ...attrs
    }
    const started = Date.now()
    const run = async (span?: { setAttributes(next: Record<string, string | number | boolean | string[]>): unknown }): Promise<T> => {
      const recordAttrs = (extra: SpanAttrs): void => {
        Object.assign(merged, extra)
        span?.setAttributes(definedAttrs(extra))
      }
      try {
        const result = await fn(recordAttrs)
        this.telemetry?.recordCounter('harness.workspace.operations', 1, merged)
        return result
      } finally {
        this.telemetry?.recordHistogram('harness.workspace.operation.duration', (Date.now() - started) / 1000, merged)
      }
    }
    return this.telemetry ? this.telemetry.span(`harness.workspace.${operation}`, merged, (span) => run(span)) : run()
  }
}

/**
 * Guards a persisted-op replay: a stored entry may only replay when it belongs
 * to the same operation kind and run/session identity, otherwise the reused key
 * is an `idempotency_conflict` (spec 21 §9, spec 22 §4).
 */
function assertReplayMatches(op: PersistedWorkspaceOp, kind: PersistedWorkspaceOp['kind'], runId: string, sessionId: string, workspaceRef: string): void {
  if (op.kind !== kind || op.runId !== runId || op.sessionId !== sessionId) {
    throw new WorkspaceError(`Workspace ${kind} idempotency key reused with a different operation or run/session.`, {
      reason: 'idempotency_conflict',
      workspace_ref: workspaceRef,
      run_id: runId,
      session_id: sessionId
    })
  }
}

function definedAttrs(attrs: SpanAttrs): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function toHandle(meta: WorkspaceMeta): WorkspaceHandle {
  return {
    workspaceRef: meta.workspaceRef,
    runId: meta.runId,
    sessionId: meta.sessionId,
    sandboxOwner: meta.sandboxOwner,
    sandboxPolicyDigest: meta.sandboxPolicyDigest,
    state: 'active',
    startedAt: meta.updatedAt,
    attempt: meta.attempt,
    ...(meta.metadata ? { metadata: meta.metadata } : {})
  }
}

function now(): string { return new Date().toISOString() }

function ownerKey(owner: SandboxOwner): string { return JSON.stringify(owner) }

function canonicalPartitions(partitions: readonly import('../sandbox/ownership.js').SandboxPartition[]): readonly import('../sandbox/ownership.js').SandboxPartition[] {
  const members = new Map<string, import('../sandbox/ownership.js').SandboxPartition>()
  for (const partition of partitions) members.set(JSON.stringify(partition), partition)
  return [...members.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, partition]) => partition)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new OperationCancelledError('Workspace operation was cancelled.', { scope: 'workspace' })
}

/** Measures the JSON replay value before a checkpoint copy can reserve disk. */
function serializedCheckpointPayloadBytes(value: JsonValue | undefined): number {
  if (value === undefined) return 0
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

async function directorySize(root: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isSymbolicLink()) throw new WorkspaceError('Workspace checkpoint contains an unsupported symbolic link.', { reason: 'invalid_reference' })
    total += entry.isDirectory() ? await directorySize(full) : (await lstat(full)).size
  }
  return total
}

/**
 * Resolves the cleanup target through `realpath` and verifies it stays inside
 * the store root. Returns `undefined` when the target no longer exists.
 */
async function assertInsideRealpath(root: string, target: string): Promise<string | undefined> {
  const rootReal = await realpath(root).catch(() => undefined)
  if (!rootReal) return undefined
  const targetReal = await realpath(target).catch(() => undefined)
  if (!targetReal) return undefined
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${sep}`)) {
    throw new WorkspaceError('Workspace path escaped local root.', { reason: 'invalid_reference' })
  }
  return targetReal
}

export function localDirectoryWorkspace(options: LocalDirectoryWorkspaceOptions): DurableWorkspace {
  return new LocalDirectoryWorkspace(options)
}
