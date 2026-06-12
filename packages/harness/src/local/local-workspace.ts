import { mkdir, rm, cp, readFile, writeFile, readdir, rename, stat, realpath } from 'node:fs/promises'
import { resolve, join, dirname, sep } from 'node:path'
import { ulid } from '../ulid/index.js'
import { OperationCancelledError, WorkspaceCleanupError, WorkspaceError, WorkspaceQuotaExceededError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'
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
import { sha256Hex } from './ref-hash.js'

type WorkspaceState = 'active' | 'paused' | 'aborted' | 'cleaned'

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
  attempt: number
  createdAt: string
  updatedAt: string
  metadata?: Record<string, JsonValue>
  checkpoints: WorkspaceCheckpoint[]
  ops?: Record<string, PersistedWorkspaceOp>
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

/** Refs are always `workspace_${ulid()}`; anything else is rejected before path use (spec 22 §4). */
const WORKSPACE_REF_PATTERN = /^workspace_[A-Z0-9]+$/

/** Host-directory durable workspace store used by localDurableExecution. */
export class LocalDirectoryWorkspaceStore implements DurableWorkspaceStore {
  public readonly info: DurableWorkspaceStoreInfo
  public readonly capabilities: readonly AdapterCapability[]
  private readonly root: string
  private readonly coordinator: LocalWorkspaceCoordinator | undefined
  /** In-process lookup caches; the persisted `meta.json` files stay authoritative. */
  private readonly runIdIndex = new Map<string, string>()
  private readonly opKeyIndex = new Map<string, string>()
  private telemetry: TelemetryShim | undefined

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

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.telemetry = context.telemetry
  }

  /** Drops the run→sandbox coordinator binding once a durable run is finished/disposed. */
  public releaseRunBinding(runId: string, sessionId: string): void {
    this.coordinator?.unbind(runId, sessionId)
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
        this.coordinator?.bind(opts.runId, opts.sessionId, handle.workspaceRef, this.activePath(handle.workspaceRef))
        recordAttrs({ 'harness.workspace.state': 'active', 'harness.workspace.ref_hash': sha256Hex(handle.workspaceRef) })
        return handle
      }
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
      const handle = toHandle(meta)
      this.persistOp(meta, opts.idempotencyKey, { kind: 'start', runId: opts.runId, sessionId: opts.sessionId, result: handle })
      await this.writeMeta(meta)
      this.coordinator?.bind(opts.runId, opts.sessionId, meta.workspaceRef, this.activePath(meta.workspaceRef))
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
      const checkpointRef = `checkpoint_${opts.sequence}_${ulid()}`
      const checkpointPath = this.checkpointPath(meta.workspaceRef, checkpointRef)
      await rm(checkpointPath, { recursive: true, force: true })
      await mkdir(dirname(checkpointPath), { recursive: true })
      await cp(this.activePath(meta.workspaceRef), checkpointPath, { recursive: true, force: true })
      const sizeBytes = await directorySize(checkpointPath)
      const maxWorkspaceBytes = this.info.policy.quota?.maxWorkspaceBytes
      if (maxWorkspaceBytes !== undefined && sizeBytes > maxWorkspaceBytes) {
        await rm(checkpointPath, { recursive: true, force: true })
        this.telemetry?.recordCounter('harness.workspace_store.quota.exceeded', 1, {
          'harness.workspace.adapter': this.info.id,
          'harness.workspace.operation': 'pause',
          'harness.workspace_store.quota': 'maxWorkspaceBytes'
        })
        recordAttrs({ 'harness.workspace_store.quota': 'maxWorkspaceBytes' })
        throw new WorkspaceQuotaExceededError('Workspace byte quota exceeded.', {
          quota: 'maxWorkspaceBytes',
          limit: maxWorkspaceBytes,
          actual: sizeBytes,
          workspace_ref: meta.workspaceRef
        })
      }
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
      this.persistOp(meta, opts.idempotencyKey, { kind: 'pause', runId: meta.runId, sessionId: meta.sessionId, result: checkpoint })
      await this.writeMeta(meta)
      this.telemetry?.recordHistogram('harness.workspace.bytes', sizeBytes, {
        'harness.workspace.adapter': this.info.id,
        'harness.workspace.operation': 'pause'
      })
      recordAttrs({ 'harness.workspace.state': 'paused', 'harness.workspace.checkpoint_ref_hash': sha256Hex(checkpointRef) })
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
        this.coordinator?.bind(opts.runId, opts.sessionId, meta.workspaceRef, this.activePath(meta.workspaceRef))
        recordAttrs({ 'harness.workspace.state': meta.state })
        return handle
      }
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
      const handle = toHandle(meta)
      this.persistOp(meta, opts.idempotencyKey, { kind: 'resume', runId: opts.runId, sessionId: opts.sessionId, result: handle })
      await this.writeMeta(meta)
      this.coordinator?.bind(opts.runId, opts.sessionId, meta.workspaceRef, this.activePath(meta.workspaceRef))
      recordAttrs({ 'harness.workspace.state': 'active' })
      return handle
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
        this.coordinator?.unbind(opts.runId, opts.sessionId)
        return replay.result as WorkspaceAbortResult
      }
      meta.state = 'aborted'
      meta.updatedAt = now()
      const result: WorkspaceAbortResult = { workspaceRef: opts.workspaceRef, state: 'aborted', abortedAt: meta.updatedAt }
      this.persistOp(meta, opts.idempotencyKey, { kind: 'abort', runId: opts.runId, sessionId: opts.sessionId, result })
      await this.writeMeta(meta)
      this.coordinator?.unbind(opts.runId, opts.sessionId)
      recordAttrs({ 'harness.workspace.state': 'aborted' })
      return result
    })
  }

  public async cleanupWorkspace(opts: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult> {
    return this.workspaceSpan('cleanup', {
      'harness.workspace.ref_hash': sha256Hex(opts.workspaceRef),
      'harness.workspace_store.cleanup.reason': opts.reason
    }, async (recordAttrs) => {
      throwIfAborted(opts.signal)
      const root = this.workspacePath(opts.workspaceRef)
      try {
        // Realpath jail: only delete when the addressed directory truly resolves
        // inside `<root>/workspaces` (spec 22 §4).
        const target = await assertInsideRealpath(this.root, root)
        if (target) await rm(target, { recursive: true, force: true })
      } catch (error) {
        this.telemetry?.recordCounter('harness.workspace_store.cleanup.failures', 1, {
          'harness.workspace.adapter': this.info.id,
          'harness.workspace.operation': 'cleanup',
          'harness.workspace_store.cleanup.reason': opts.reason,
          'error.type': error instanceof Error ? error.name : 'unknown'
        })
        if (error instanceof WorkspaceError) throw error
        throw new WorkspaceCleanupError('Workspace cleanup failed.', { reason: 'backend_failure', workspace_ref: opts.workspaceRef }, error)
      }
      this.evictFromIndexes(opts.workspaceRef)
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
      recordAttrs({ 'harness.workspace.state': meta.state, 'harness.workspace.ref_hash': sha256Hex(workspaceRef) })
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
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    total += entry.isDirectory() ? await directorySize(full) : (await stat(full)).size
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

export function localDirectoryWorkspaceStore(options: LocalDirectoryWorkspaceStoreOptions): DurableWorkspaceStore {
  return new LocalDirectoryWorkspaceStore(options)
}
