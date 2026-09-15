import {
  OperationCancelledError,
  WorkspaceError,
  type AdapterCapability,
  type DurableWorkspace,
  type DurableWorkspaceInfo,
  type HarnessAdapterContext,
  type SandboxPartition,
  type SandboxScope,
  type WorkspaceAbortOptions,
  type WorkspaceAbortResult,
  type WorkspaceCheckpoint,
  type WorkspaceCleanupOptions,
  type WorkspaceCleanupResult,
  type WorkspaceFinishOptions,
  type WorkspaceHandle,
  type WorkspaceInspection,
  type WorkspaceInspectionOptions,
  type WorkspacePauseOptions,
  type WorkspacePinOptions,
  type WorkspaceReleasePinOptions,
  type WorkspaceResumeOptions,
  type WorkspaceStartOptions,
} from '@purista/harness'
import { sandboxScopeKey } from '@purista/harness/adapter'
import { KubernetesSandboxAdministration } from './administration.js'
import {
  controlRecordName,
  mutateRecord,
  nowIso,
  ownerLogicalKey,
  type KubernetesSandboxRecord,
  type KubernetesWorkspaceBinding,
  type KubernetesWorkspaceCoordinator,
} from './control.js'
import { kubernetesResourceName, type KubernetesSandboxDriver } from './driver.js'

/** Durable-workspace capabilities implemented with PVC generations and VolumeSnapshots. */
export const KUBERNETES_WORKSPACE_CAPABILITIES = Object.freeze([
  'workspace.durable',
  'workspace.persistent',
  'workspace.checkpoint',
  'workspace.resume',
  'workspace.abort',
  'workspace.cleanup',
  'workspace.inspect',
] as const satisfies readonly AdapterCapability[])

type WorkspaceState = 'active' | 'paused' | 'terminal' | 'aborted' | 'cleaned'
type WorkspaceOperationKind = 'pause' | 'resume' | 'abort' | 'cleanup'

interface PersistedWorkspaceOperation {
  readonly kind: WorkspaceOperationKind
  readonly fingerprint: string
  readonly result: WorkspaceCheckpoint | WorkspaceHandle | WorkspaceAbortResult | WorkspaceCleanupResult
}

/** Persisted, content-free control state for one Kubernetes durable workspace. */
export interface KubernetesWorkspaceRecord {
  /** Record discriminator. */
  readonly kind: 'workspace'
  /** Stable Harness workspace reference. */
  readonly workspaceRef: string
  /** Current lifecycle state. */
  readonly state: WorkspaceState
  /** Durable Harness run that owns the workspace. */
  readonly runId: string
  /** Harness session that owns the run. */
  readonly sessionId: string
  /** Immutable sandbox owner identity. */
  readonly sandboxOwner: WorkspaceHandle['sandboxOwner']
  /** Digest binding the workspace to its sandbox policy. */
  readonly sandboxPolicyDigest: string
  /** Current recovery attempt. */
  readonly attempt: number
  /** Active PVC generation. */
  readonly volumeName: string
  /** Older PVC generations awaiting safe cleanup. */
  readonly retainedVolumes: readonly string[]
  /** Committed VolumeSnapshot checkpoints. */
  readonly checkpoints: readonly WorkspaceCheckpoint[]
  /** Checkpoint identifiers retained by active pins. */
  readonly pins: readonly string[]
  /** Idempotency results for lifecycle operations. */
  readonly operations: Readonly<Record<string, PersistedWorkspaceOperation>>
  /** Sandbox partitions observed for this workspace. */
  readonly sandboxPartitions: readonly SandboxPartition[]
  /** Creation timestamp. */
  readonly createdAt: string
  /** Last control-state update timestamp. */
  readonly updatedAt: string
  /** Application metadata copied from the Harness workspace handle. */
  readonly metadata?: WorkspaceHandle['metadata']
  /** Terminal result when the workflow has finished. */
  readonly terminal?: { readonly status: 'succeeded' | 'failed' | 'cancelled'; readonly finishedAt: string }
}

interface KubernetesWorkspaceBindingRecord {
  readonly kind: 'workspace-binding'
  readonly owner: WorkspaceHandle['sandboxOwner']
  readonly runId: string
  readonly workspaceRef: string
  readonly volumeName: string
  readonly restoreReady: boolean
  readonly updatedAt: string
}

/** Low-level construction options for the Kubernetes durable-workspace adapter. */
export interface KubernetesDurableWorkspaceOptions {
  /** Kubernetes infrastructure boundary. */
  readonly driver: KubernetesSandboxDriver
  /** Stable namespace for all Kubernetes object names owned by this Harness runtime. */
  readonly runtimeId: string
  /** Requested size for each PVC generation. */
  readonly volumeSize: string
  /** StorageClass used for generated PVCs. */
  readonly storageClassName?: string
  /** VolumeSnapshotClass used for checkpoints. */
  readonly snapshotClassName?: string
  /** Maximum wait for snapshot readiness in milliseconds. */
  readonly snapshotReadyTimeoutMs: number
}

/**
 * Durable Kubernetes workspace backed by PVC generations and VolumeSnapshots.
 * Control records use Kubernetes resource-version CAS, so multiple PURISTA
 * service replicas can share the same adapter safely.
 */
export class KubernetesDurableWorkspace implements DurableWorkspace, KubernetesWorkspaceCoordinator {
  /** Capabilities used by Harness build-time validation. */
  public readonly capabilities = KUBERNETES_WORKSPACE_CAPABILITIES
  /** Stable adapter identity and capability metadata. */
  public readonly info: DurableWorkspaceInfo = {
    id: 'kubernetes_workspace',
    packageName: '@purista/harness-sandbox-kubernetes',
    capabilities: KUBERNETES_WORKSPACE_CAPABILITIES,
    policy: {},
  }
  public readonly administration: KubernetesSandboxAdministration
  private logger: HarnessAdapterContext['logger'] | undefined

  /** Creates the low-level workspace adapter; most applications use `kubernetesSandboxRuntime()`. */
  public constructor(private readonly options: KubernetesDurableWorkspaceOptions) {
    this.administration = new KubernetesSandboxAdministration(options.driver)
  }

  /** Receives the Harness logger without changing persisted state. */
  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.logger = context.logger
    this.administration.configureHarnessContext(context)
  }

  /** Resolves the active PVC binding for a run-scoped sandbox attachment. */
  public async bindingForScope(scope: SandboxScope): Promise<KubernetesWorkspaceBinding | undefined> {
    if (scope.lifetime !== 'run') return undefined
    const binding = await this.options.driver.readRecord<KubernetesWorkspaceBindingRecord>(
      bindingRecordName(this.options.runtimeId, scope.owner, scope.runId),
    )
    if (!binding || ownerLogicalKey(binding.value.owner) !== ownerLogicalKey(scope.owner)) return undefined
    const workspace = await this.readWorkspace(binding.value.workspaceRef)
    if (!workspace || workspace.state !== 'active' || workspace.runId !== scope.runId) return undefined
    return {
      workspaceRef: workspace.workspaceRef,
      volumeName: workspace.volumeName,
      restoreReady: binding.value.restoreReady,
    }
  }

  /** Creates the first PVC generation and its fenced workspace control record. */
  public async startWorkspace(options: WorkspaceStartOptions): Promise<WorkspaceHandle> {
    throwIfWorkspaceAborted(options.signal)
    const workspaceRef = workspaceRecordName(this.options.runtimeId, options.idempotencyKey)
    const existing = await this.readWorkspace(workspaceRef)
    if (existing) {
      this.assertStartReplay(existing, options)
      const handle = toHandle(existing)
      await this.writeBinding(existing, true, options.signal)
      return handle
    }

    const timestamp = nowIso()
    const volumeName = workspaceVolumeName(workspaceRef, 1)
    const record: KubernetesWorkspaceRecord = {
      kind: 'workspace',
      workspaceRef,
      state: 'active',
      runId: options.runId,
      sessionId: options.sessionId,
      sandboxOwner: options.sandboxOwner,
      sandboxPolicyDigest: options.sandboxPolicyDigest,
      attempt: options.attempt,
      volumeName,
      retainedVolumes: [volumeName],
      checkpoints: [],
      pins: [],
      operations: {},
      sandboxPartitions: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(options.metadata ? { metadata: options.metadata } : {}),
    }
    const created = await this.options.driver.createRecord(workspaceRef, 'workspace', record)
    const persisted = created ? record : await this.requireWorkspace(workspaceRef)
    this.assertStartReplay(persisted, options)
    await this.options.driver.ensureVolume({
      name: persisted.volumeName,
      size: this.options.volumeSize,
      ...(this.options.storageClassName ? { storageClassName: this.options.storageClassName } : {}),
    })
    await this.writeBinding(persisted, true, options.signal)
    return toHandle(persisted)
  }

  /** Commits a ready VolumeSnapshot checkpoint and pauses the active generation. */
  public async pauseWorkspace(options: WorkspacePauseOptions): Promise<WorkspaceCheckpoint> {
    throwIfWorkspaceAborted(options.signal)
    const fingerprint = operationFingerprint('pause', options.handle.runId, options.handle.sessionId, {
      stepId: options.stepId,
      sequence: options.sequence,
      attempt: options.attempt,
      reason: options.reason,
    })
    const current = await this.requireWorkspace(options.handle.workspaceRef)
    const replay = replayOperation<WorkspaceCheckpoint>(current, options.idempotencyKey, 'pause', fingerprint)
    if (replay) return replay
    this.assertHandle(current, options.handle)
    if (current.state === 'aborted' || current.state === 'terminal') {
      throw new WorkspaceError('Workspace cannot be checkpointed after its terminal transition.', {
        reason: 'aborted', workspace_ref: current.workspaceRef,
      })
    }
    if (current.state === 'cleaned') throw workspaceNotFound(current.workspaceRef)

    const checkpointRef = checkpointRecordName(current.workspaceRef, options.sequence)
    const snapshotRef = snapshotName(current.workspaceRef, options.sequence)
    const prior = current.checkpoints.find((checkpoint) => checkpoint.checkpointRef === checkpointRef)
    if (prior) {
      throw new WorkspaceError('Workspace checkpoint sequence was already committed.', {
        reason: 'checkpoint_conflict', workspace_ref: current.workspaceRef, checkpoint_ref: checkpointRef,
      })
    }

    await this.options.driver.createVolumeSnapshot(snapshotRef, current.volumeName, this.options.snapshotClassName)
    await this.options.driver.waitForVolumeSnapshotReady(snapshotRef, this.options.snapshotReadyTimeoutMs, options.signal)
    const committedAt = nowIso()
    const checkpoint: WorkspaceCheckpoint = {
      workspaceRef: current.workspaceRef,
      checkpointRef,
      snapshotRef,
      runId: current.runId,
      sessionId: current.sessionId,
      sandboxPolicyDigest: current.sandboxPolicyDigest,
      sandboxPartitions: canonicalPartitions(options.sandboxPartitions),
      stepId: options.stepId,
      sequence: options.sequence,
      attempt: options.attempt,
      committedAt,
      ...(options.checkpointPayload === undefined ? {} : {
        sizeBytes: byteLength(options.checkpointPayload),
        metadata: { reason: options.reason },
      }),
    }
    const operation: PersistedWorkspaceOperation = { kind: 'pause', fingerprint, result: checkpoint }
    await mutateRecord<KubernetesWorkspaceRecord>(this.options.driver, current.workspaceRef, 'workspace', (record) => {
      const concurrentReplay = replayOperation<WorkspaceCheckpoint>(record, options.idempotencyKey, 'pause', fingerprint)
      if (concurrentReplay) return record
      if (record.checkpoints.some((item) => item.checkpointRef === checkpointRef)) {
        throw new WorkspaceError('Workspace checkpoint sequence was concurrently committed.', {
          reason: 'checkpoint_conflict', workspace_ref: record.workspaceRef, checkpoint_ref: checkpointRef,
        })
      }
      return {
        ...record,
        state: 'paused',
        checkpoints: [...record.checkpoints, checkpoint],
        sandboxPartitions: canonicalPartitions([...record.sandboxPartitions, ...options.sandboxPartitions]),
        operations: { ...record.operations, [operationKey(options.idempotencyKey)]: operation },
        updatedAt: committedAt,
      }
    }, options.signal)
    return checkpoint
  }

  /** Restores a checkpoint into a new PVC generation and fences the prior attachment. */
  public async resumeWorkspace(options: WorkspaceResumeOptions): Promise<WorkspaceHandle> {
    throwIfWorkspaceAborted(options.signal)
    const fingerprint = operationFingerprint('resume', options.runId, options.sessionId, {
      checkpointRef: options.checkpointRef ?? null,
      snapshotRef: options.snapshotRef ?? null,
      attempt: options.attempt,
    })
    let current = await this.requireWorkspace(options.workspaceRef)
    const replay = replayOperation<WorkspaceHandle>(current, options.idempotencyKey, 'resume', fingerprint)
    if (replay) {
      await this.writeBinding(current, true, options.signal)
      return replay
    }
    if (current.state === 'cleaned') throw workspaceNotFound(current.workspaceRef)
    if (current.state === 'aborted' || current.state === 'terminal') {
      throw new WorkspaceError('Workspace cannot resume after its terminal transition.', {
        reason: 'aborted', workspace_ref: current.workspaceRef,
      })
    }
    const checkpoint = resolveCheckpoint(current, options)
    const nextVolume = workspaceVolumeName(current.workspaceRef, current.retainedVolumes.length + 1)
    if (checkpoint) {
      await this.options.driver.ensureVolume({
        name: nextVolume,
        size: this.options.volumeSize,
        snapshotName: checkpoint.snapshotRef!,
        ...(this.options.storageClassName ? { storageClassName: this.options.storageClassName } : {}),
      })
    } else if (!await this.options.driver.volumeExists(current.volumeName)) {
      throw new WorkspaceError('Workspace has no committed checkpoint from which to recover.', {
        reason: 'missing_checkpoint', workspace_ref: current.workspaceRef,
      })
    }

    await this.fenceSandboxAttachments(current, options.signal)
    const startedAt = nowIso()
    const handle: WorkspaceHandle = {
      workspaceRef: current.workspaceRef,
      runId: options.runId,
      sessionId: options.sessionId,
      sandboxOwner: current.sandboxOwner,
      sandboxPolicyDigest: current.sandboxPolicyDigest,
      state: 'active',
      startedAt,
      attempt: options.attempt,
      ...(current.metadata ? { metadata: current.metadata } : {}),
    }
    const operation: PersistedWorkspaceOperation = { kind: 'resume', fingerprint, result: handle }
    current = (await mutateRecord<KubernetesWorkspaceRecord>(this.options.driver, current.workspaceRef, 'workspace', (record) => {
      const concurrentReplay = replayOperation<WorkspaceHandle>(record, options.idempotencyKey, 'resume', fingerprint)
      if (concurrentReplay) return record
      return {
        ...record,
        state: 'active',
        runId: options.runId,
        sessionId: options.sessionId,
        attempt: options.attempt,
        volumeName: checkpoint ? nextVolume : record.volumeName,
        retainedVolumes: checkpoint ? unique([...record.retainedVolumes, nextVolume]) : record.retainedVolumes,
        operations: { ...record.operations, [operationKey(options.idempotencyKey)]: operation },
        updatedAt: startedAt,
      }
    }, options.signal)).value
    await this.writeBinding(current, true, options.signal)
    return handle
  }

  /** Marks a workspace aborted and applies the requested cleanup policy idempotently. */
  public async abortWorkspace(options: WorkspaceAbortOptions): Promise<WorkspaceAbortResult> {
    throwIfWorkspaceAborted(options.signal)
    const fingerprint = operationFingerprint('abort', options.runId, options.sessionId, { reason: options.reason })
    const current = await this.requireWorkspace(options.workspaceRef)
    const replay = replayOperation<WorkspaceAbortResult>(current, options.idempotencyKey, 'abort', fingerprint)
    if (replay) return replay
    if (current.state === 'cleaned') throw workspaceNotFound(current.workspaceRef)
    const abortedAt = nowIso()
    const result: WorkspaceAbortResult = { workspaceRef: current.workspaceRef, state: 'aborted', abortedAt }
    await this.fenceSandboxAttachments(current, options.signal)
    await mutateRecord<KubernetesWorkspaceRecord>(this.options.driver, current.workspaceRef, 'workspace', (record) => ({
      ...record,
      state: 'aborted',
      operations: {
        ...record.operations,
        [operationKey(options.idempotencyKey)]: { kind: 'abort', fingerprint, result },
      },
      updatedAt: abortedAt,
    }), options.signal)
    return result
  }

  /** Prevents a checkpoint snapshot from being removed while a durable reference needs it. */
  public async pinCheckpoint(options: WorkspacePinOptions): Promise<void> {
    throwIfWorkspaceAborted(options.signal)
    await mutateRecord<KubernetesWorkspaceRecord>(this.options.driver, options.workspaceRef, 'workspace', (record) => {
      this.assertRun(record, options.runId)
      if (!record.checkpoints.some((item) => item.checkpointRef === options.checkpointRef)) {
        throw new WorkspaceError('Workspace checkpoint was not found.', {
          reason: 'missing_checkpoint', workspace_ref: record.workspaceRef, checkpoint_ref: options.checkpointRef,
        })
      }
      return { ...record, pins: unique([...record.pins, options.checkpointRef]), updatedAt: nowIso() }
    }, options.signal)
  }

  /** Releases a previously pinned checkpoint reference. */
  public async releaseCheckpoint(options: WorkspaceReleasePinOptions): Promise<void> {
    throwIfWorkspaceAborted(options.signal)
    await mutateRecord<KubernetesWorkspaceRecord>(this.options.driver, options.workspaceRef, 'workspace', (record) => {
      this.assertRun(record, options.runId)
      return { ...record, pins: record.pins.filter((item) => item !== options.checkpointRef), updatedAt: nowIso() }
    }, options.signal)
  }

  /** Records the terminal workflow status before retention or cleanup proceeds. */
  public async finish(options: WorkspaceFinishOptions): Promise<void> {
    throwIfWorkspaceAborted(options.signal)
    await mutateRecord<KubernetesWorkspaceRecord>(this.options.driver, options.workspaceRef, 'workspace', (record) => {
      this.assertRun(record, options.runId)
      if (record.terminal && record.terminal.status !== options.status) {
        throw new WorkspaceError('Workspace terminal outcome conflicts with the recorded result.', {
          reason: 'idempotency_conflict', workspace_ref: record.workspaceRef, run_id: options.runId,
        })
      }
      if (record.terminal) return record
      const finishedAt = nowIso()
      return { ...record, state: 'terminal', terminal: { status: options.status, finishedAt }, updatedAt: finishedAt }
    }, options.signal)
  }

  /** Deletes eligible Pods, PVC generations, snapshots, and control records idempotently. */
  public async cleanupWorkspace(options: WorkspaceCleanupOptions): Promise<WorkspaceCleanupResult> {
    throwIfWorkspaceAborted(options.signal)
    const current = await this.readWorkspace(options.workspaceRef)
    const completedAt = nowIso()
    if (!current || current.state === 'cleaned') {
      return { workspaceRef: options.workspaceRef, state: 'cleaned', completedAt, deletedBytes: 0, deletedFiles: 0 }
    }
    const fingerprint = operationFingerprint('cleanup', current.runId, current.sessionId, { reason: options.reason })
    const replay = replayOperation<WorkspaceCleanupResult>(current, options.idempotencyKey, 'cleanup', fingerprint)
    if (replay) return replay
    await this.fenceSandboxAttachments(current, options.signal)
    for (const volume of current.retainedVolumes) await this.options.driver.deleteVolume(volume)
    for (const checkpoint of current.checkpoints) {
      if (checkpoint.snapshotRef) await this.options.driver.deleteVolumeSnapshot(checkpoint.snapshotRef)
    }
    const result: WorkspaceCleanupResult = {
      workspaceRef: current.workspaceRef,
      state: 'cleaned',
      completedAt,
      deletedFiles: current.checkpoints.length,
    }
    await mutateRecord<KubernetesWorkspaceRecord>(this.options.driver, current.workspaceRef, 'workspace', (record) => ({
      ...record,
      state: 'cleaned',
      checkpoints: [],
      pins: [],
      operations: {
        ...record.operations,
        [operationKey(options.idempotencyKey)]: { kind: 'cleanup', fingerprint, result },
      },
      updatedAt: completedAt,
    }), options.signal)
    return result
  }

  /** Returns content-free workspace lifecycle and retention metadata for operations. */
  public async inspectWorkspace(options: WorkspaceInspectionOptions): Promise<WorkspaceInspection> {
    throwIfWorkspaceAborted(options.signal)
    const workspace = options.workspaceRef
      ? await this.readWorkspace(options.workspaceRef)
      : await this.findWorkspace(options.checkpointRef, options.snapshotRef)
    if (!workspace) throw workspaceNotFound(options.workspaceRef ?? options.checkpointRef ?? options.snapshotRef ?? 'unknown')
    const latest = workspace.checkpoints.at(-1)
    return {
      workspaceRef: workspace.workspaceRef,
      state: workspace.state,
      checkpoints: workspace.checkpoints,
      ...(latest ? { currentCheckpointRef: latest.checkpointRef } : {}),
      sandboxOwner: workspace.sandboxOwner,
      sandboxPolicyDigest: workspace.sandboxPolicyDigest,
      ...(workspace.terminal ? { terminal: workspace.terminal } : {}),
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      ...(workspace.metadata ? { metadata: workspace.metadata } : {}),
    }
  }

  private async readWorkspace(workspaceRef: string): Promise<KubernetesWorkspaceRecord | undefined> {
    return (await this.options.driver.readRecord<KubernetesWorkspaceRecord>(workspaceRef))?.value
  }

  private async requireWorkspace(workspaceRef: string): Promise<KubernetesWorkspaceRecord> {
    const workspace = await this.readWorkspace(workspaceRef)
    if (!workspace) throw workspaceNotFound(workspaceRef)
    return workspace
  }

  private async findWorkspace(checkpointRef?: string, snapshotRef?: string): Promise<KubernetesWorkspaceRecord | undefined> {
    if (!checkpointRef && !snapshotRef) {
      throw new WorkspaceError('A workspace, checkpoint, or snapshot reference is required.', { reason: 'invalid_reference' })
    }
    const records = await this.options.driver.listRecords()
    return records
      .filter((record) => record.kind === 'workspace')
      .map((record) => record.value as KubernetesWorkspaceRecord)
      .find((workspace) => workspace.checkpoints.some((checkpoint) =>
        checkpoint.checkpointRef === checkpointRef || checkpoint.snapshotRef === snapshotRef))
  }

  private assertStartReplay(workspace: KubernetesWorkspaceRecord, options: WorkspaceStartOptions): void {
    if (
      workspace.runId !== options.runId
      || workspace.sessionId !== options.sessionId
      || ownerLogicalKey(workspace.sandboxOwner) !== ownerLogicalKey(options.sandboxOwner)
      || workspace.sandboxPolicyDigest !== options.sandboxPolicyDigest
    ) {
      throw new WorkspaceError('Workspace start idempotency key was reused for another run or owner.', {
        reason: 'idempotency_conflict', workspace_ref: workspace.workspaceRef,
        run_id: options.runId, session_id: options.sessionId,
      })
    }
  }

  private assertHandle(workspace: KubernetesWorkspaceRecord, handle: WorkspaceHandle): void {
    if (
      workspace.runId !== handle.runId
      || workspace.sessionId !== handle.sessionId
      || ownerLogicalKey(workspace.sandboxOwner) !== ownerLogicalKey(handle.sandboxOwner)
      || workspace.sandboxPolicyDigest !== handle.sandboxPolicyDigest
    ) {
      throw new WorkspaceError('Workspace handle does not match the persisted run.', {
        reason: 'idempotency_conflict', workspace_ref: workspace.workspaceRef,
        run_id: handle.runId, session_id: handle.sessionId,
      })
    }
  }

  private assertRun(workspace: KubernetesWorkspaceRecord, runId: string): void {
    if (workspace.runId !== runId) {
      throw new WorkspaceError('Workspace belongs to another durable run.', {
        reason: 'idempotency_conflict', workspace_ref: workspace.workspaceRef, run_id: runId,
      })
    }
  }

  private async writeBinding(workspace: KubernetesWorkspaceRecord, restoreReady: boolean, signal?: AbortSignal): Promise<void> {
    throwIfWorkspaceAborted(signal)
    const name = bindingRecordName(this.options.runtimeId, workspace.sandboxOwner, workspace.runId)
    const value: KubernetesWorkspaceBindingRecord = {
      kind: 'workspace-binding',
      owner: workspace.sandboxOwner,
      runId: workspace.runId,
      workspaceRef: workspace.workspaceRef,
      volumeName: workspace.volumeName,
      restoreReady,
      updatedAt: nowIso(),
    }
    if (await this.options.driver.createRecord(name, 'workspace-binding', value)) return
    await mutateRecord<KubernetesWorkspaceBindingRecord>(this.options.driver, name, 'workspace-binding', (current) => {
      if (current.workspaceRef !== workspace.workspaceRef || ownerLogicalKey(current.owner) !== ownerLogicalKey(workspace.sandboxOwner)) {
        throw new WorkspaceError('Run scope is already bound to another workspace.', {
          reason: 'idempotency_conflict', workspace_ref: workspace.workspaceRef, run_id: workspace.runId,
        })
      }
      return value
    }, signal)
  }

  private async fenceSandboxAttachments(workspace: KubernetesWorkspaceRecord, signal?: AbortSignal): Promise<void> {
    for (const partition of workspace.sandboxPartitions) {
      throwIfWorkspaceAborted(signal)
      const scope: SandboxScope = { owner: workspace.sandboxOwner, partition, lifetime: 'run', runId: workspace.runId }
      const name = controlRecordName('ph-sbx', `${this.options.runtimeId}:${sandboxScopeKey(scope)}`)
      const sandbox = await this.options.driver.readRecord<KubernetesSandboxRecord>(name)
      if (!sandbox || sandbox.value.state === 'terminated') continue
      if (sandbox.value.podName) await this.options.driver.deletePod(sandbox.value.podName)
      await mutateRecord<KubernetesSandboxRecord>(this.options.driver, name, 'sandbox', (record) => ({
        ...record,
        state: record.state === 'terminated' ? 'terminated' : 'state_lost',
        generation: record.generation + 1,
        updatedAt: nowIso(),
      }), signal)
    }
    this.logger?.debug('Kubernetes workspace fenced previous sandbox attachments.', {
      workspace_ref: workspace.workspaceRef,
      partition_count: workspace.sandboxPartitions.length,
    })
  }
}

function resolveCheckpoint(workspace: KubernetesWorkspaceRecord, options: WorkspaceResumeOptions): WorkspaceCheckpoint | undefined {
  if (!options.checkpointRef && !options.snapshotRef) return undefined
  const checkpoint = workspace.checkpoints.find((item) =>
    (options.checkpointRef === undefined || item.checkpointRef === options.checkpointRef)
    && (options.snapshotRef === undefined || item.snapshotRef === options.snapshotRef))
  if (!checkpoint?.snapshotRef) {
    throw new WorkspaceError('Workspace checkpoint was not found.', {
      reason: 'missing_checkpoint', workspace_ref: workspace.workspaceRef,
      ...(options.checkpointRef ? { checkpoint_ref: options.checkpointRef } : {}),
      ...(options.snapshotRef ? { snapshot_ref: options.snapshotRef } : {}),
    })
  }
  return checkpoint
}

function replayOperation<T>(
  workspace: KubernetesWorkspaceRecord,
  idempotencyKey: string,
  kind: WorkspaceOperationKind,
  fingerprint: string,
): T | undefined {
  const operation = workspace.operations[operationKey(idempotencyKey)]
  if (!operation) return undefined
  if (operation.kind !== kind || operation.fingerprint !== fingerprint) {
    throw new WorkspaceError('Workspace idempotency key was reused for another operation.', {
      reason: 'idempotency_conflict', workspace_ref: workspace.workspaceRef,
    })
  }
  return operation.result as T
}

function operationFingerprint(kind: string, runId: string, sessionId: string, input: unknown): string {
  return JSON.stringify([kind, runId, sessionId, input])
}

function operationKey(idempotencyKey: string): string {
  return controlRecordName('op', idempotencyKey)
}

function workspaceRecordName(runtimeId: string, idempotencyKey: string): string {
  return controlRecordName('ph-wsp', `${runtimeId}:${idempotencyKey}`)
}

function bindingRecordName(runtimeId: string, owner: WorkspaceHandle['sandboxOwner'], runId: string): string {
  return controlRecordName('ph-wbd', `${runtimeId}:${ownerLogicalKey(owner)}:${runId}`)
}

function workspaceVolumeName(workspaceRef: string, generation: number): string {
  return kubernetesResourceName('ph-vol', `${workspaceRef}:${generation}`)
}

function checkpointRecordName(workspaceRef: string, sequence: number): string {
  return controlRecordName('ph-cpt', `${workspaceRef}:${sequence}`)
}

function snapshotName(workspaceRef: string, sequence: number): string {
  return kubernetesResourceName('ph-snp', `${workspaceRef}:${sequence}`)
}

function toHandle(workspace: KubernetesWorkspaceRecord): WorkspaceHandle {
  if (workspace.state === 'cleaned') throw workspaceNotFound(workspace.workspaceRef)
  return {
    workspaceRef: workspace.workspaceRef,
    runId: workspace.runId,
    sessionId: workspace.sessionId,
    sandboxOwner: workspace.sandboxOwner,
    sandboxPolicyDigest: workspace.sandboxPolicyDigest,
    state: 'active',
    startedAt: workspace.updatedAt,
    attempt: workspace.attempt,
    ...(workspace.metadata ? { metadata: workspace.metadata } : {}),
  }
}

function canonicalPartitions(partitions: readonly SandboxPartition[]): readonly SandboxPartition[] {
  const uniquePartitions = new Map<string, SandboxPartition>()
  for (const partition of partitions) uniquePartitions.set(JSON.stringify(partition), partition)
  return [...uniquePartitions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, partition]) => partition)
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)]
}

function workspaceNotFound(reference: string): WorkspaceError {
  return new WorkspaceError('Workspace was not found.', { reason: 'not_found', workspace_ref: reference })
}

function throwIfWorkspaceAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new OperationCancelledError('Kubernetes workspace operation was cancelled.', { scope: 'workspace' })
  }
}
