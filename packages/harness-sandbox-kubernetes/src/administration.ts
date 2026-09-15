import {
  sandboxListOptionsSchema,
  sandboxPurgeOptionsSchema,
  sandboxSnapshotDeleteOptionsSchema,
  sandboxSweepOptionsSchema,
  SandboxPermissionDeniedError,
  WorkspaceError,
  withSandboxTelemetry,
  type HarnessAdapterContext,
  type SandboxAdministration,
  type SandboxOwner,
  type SandboxPurgeOptions,
  type SandboxPurgeResult,
  type SandboxResourcePage,
  type SandboxResourceSummary,
  type SandboxSelector,
  type SandboxSnapshotDeleteOptions,
  type SandboxSweepOptions,
  type SandboxSweepResult,
} from '@purista/harness'
import type { KubernetesSandboxDriver, VersionedKubernetesRecord } from './driver.js'
import {
  actorLogicalKey,
  mutateRecord,
  ownerLogicalKey,
  throwIfAborted,
  type KubernetesOwnerRecord,
  type KubernetesSandboxRecord,
} from './control.js'
import type { KubernetesWorkspaceRecord } from './workspace.js'

export class KubernetesSandboxAdministration implements SandboxAdministration {
  private telemetry: HarnessAdapterContext['telemetry'] | undefined

  public constructor(
    private readonly driver: KubernetesSandboxDriver,
    private readonly adapterId = 'kubernetes',
  ) {}

  /** Receives the content-free Harness telemetry bridge. */
  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.telemetry = context.telemetry
  }

  public async list(options: Parameters<typeof sandboxListOptionsSchema.parse>[0]): Promise<SandboxResourcePage> {
    return this.instrument('list', () => this.listUnsafe(options))
  }

  private async listUnsafe(options: Parameters<typeof sandboxListOptionsSchema.parse>[0]): Promise<SandboxResourcePage> {
    const parsed = sandboxListOptionsSchema.parse(options)
    throwIfAborted(parsed.signal)
    const records = (await this.driver.listRecords())
      .flatMap((record) => toSummaries(record))
      .filter((summary) => matchesSelector(summary.owner, parsed.selector))
      .filter((summary) => !parsed.kind || summary.kind === parsed.kind)
      .sort((left, right) => left.resourceId.localeCompare(right.resourceId))
    const start = parsed.cursor ? Math.max(0, records.findIndex((record) => record.resourceId === parsed.cursor) + 1) : 0
    const items = records.slice(start, start + parsed.limit)
    const next = records[start + parsed.limit]
    return { items, ...(next ? { nextCursor: items.at(-1)?.resourceId } : {}) }
  }

  public async purge(options: SandboxPurgeOptions): Promise<SandboxPurgeResult> {
    return this.instrument('purge', () => this.purgeUnsafe(options))
  }

  private async purgeUnsafe(options: SandboxPurgeOptions): Promise<SandboxPurgeResult> {
    const parsed = sandboxPurgeOptionsSchema.parse(options)
    throwIfAborted(parsed.signal)
    const records = await this.driver.listRecords()
    if (parsed.selector.kind === 'principal') {
      await this.revokePrincipal(records, parsed.selector, parsed.signal)
      return { state: 'completed', deletedResources: 0, remainingResources: 0 }
    }

    const targets = records.filter((record) => {
      if (record.kind === 'sandbox') return matchesSelector((record.value as KubernetesSandboxRecord).scope.owner, parsed.selector)
      if (record.kind === 'workspace') return matchesSelector((record.value as KubernetesWorkspaceRecord).sandboxOwner, parsed.selector)
      return false
    })
    let deletedResources = 0
    for (const record of targets.slice(0, parsed.limit)) {
      throwIfAborted(parsed.signal)
      if (record.kind === 'sandbox') {
        const sandbox = record as VersionedKubernetesRecord<KubernetesSandboxRecord>
        if (sandbox.value.podName) await this.driver.deletePod(sandbox.value.podName)
        if (sandbox.value.ownsVolume && sandbox.value.volumeName) await this.driver.deleteVolume(sandbox.value.volumeName)
        await mutateRecord<KubernetesSandboxRecord>(this.driver, sandbox.name, 'sandbox', (current) => ({
          ...current,
          state: 'terminated',
          updatedAt: new Date().toISOString(),
        }), parsed.signal)
      } else {
        const workspace = record as VersionedKubernetesRecord<KubernetesWorkspaceRecord>
        for (const volume of workspace.value.retainedVolumes) await this.driver.deleteVolume(volume)
        for (const checkpoint of workspace.value.checkpoints) {
          if (checkpoint.snapshotRef) await this.driver.deleteVolumeSnapshot(checkpoint.snapshotRef)
        }
        await mutateRecord<KubernetesWorkspaceRecord>(this.driver, workspace.name, 'workspace', (current) => ({
          ...current,
          state: 'cleaned',
          checkpoints: [],
          pins: [],
          updatedAt: new Date().toISOString(),
        }), parsed.signal)
      }
      deletedResources += 1
    }
    const remainingResources = (await this.driver.listRecords()).filter((record) =>
      (record.kind === 'sandbox'
        && matchesSelector((record.value as KubernetesSandboxRecord).scope.owner, parsed.selector)
        && (record.value as KubernetesSandboxRecord).state !== 'terminated')
      || (record.kind === 'workspace'
        && matchesSelector((record.value as KubernetesWorkspaceRecord).sandboxOwner, parsed.selector)
        && (record.value as KubernetesWorkspaceRecord).state !== 'cleaned')).length
    return remainingResources > 0
      ? { state: 'cleanup_pending', deletedResources, remainingResources, retryAfterMs: 1_000 }
      : { state: 'completed', deletedResources, remainingResources: 0 }
  }

  public async sweep(options: SandboxSweepOptions = {}): Promise<SandboxSweepResult> {
    return this.instrument('sweep', () => this.sweepUnsafe(options))
  }

  private async sweepUnsafe(options: SandboxSweepOptions = {}): Promise<SandboxSweepResult> {
    const parsed = sandboxSweepOptionsSchema.parse(options)
    throwIfAborted(parsed.signal)
    return { examinedResources: 0, deletedResources: 0, pendingResources: 0 }
  }

  public async deleteSnapshot(options: SandboxSnapshotDeleteOptions): Promise<void> {
    return this.instrument('delete_snapshot', () => this.deleteSnapshotUnsafe(options))
  }

  private async deleteSnapshotUnsafe(options: SandboxSnapshotDeleteOptions): Promise<void> {
    const parsed = sandboxSnapshotDeleteOptionsSchema.parse(options)
    throwIfAborted(parsed.signal)
    const workspace = (await this.driver.listRecords())
      .filter((record) => record.kind === 'workspace')
      .map((record) => record as VersionedKubernetesRecord<KubernetesWorkspaceRecord>)
      .find((record) => record.value.checkpoints.some((checkpoint) => checkpoint.snapshotRef === parsed.snapshotId))
    if (!workspace || ownerLogicalKey(workspace.value.sandboxOwner) !== ownerLogicalKey(parsed.owner)) {
      throw new SandboxPermissionDeniedError('scope_mismatch')
    }
    const checkpoint = workspace.value.checkpoints.find((item) => item.snapshotRef === parsed.snapshotId)!
    if (workspace.value.pins.includes(checkpoint.checkpointRef)) {
      throw new WorkspaceError('Pinned workspace snapshot cannot be deleted.', {
        reason: 'checkpoint_conflict', workspace_ref: workspace.value.workspaceRef,
        checkpoint_ref: checkpoint.checkpointRef, snapshot_ref: parsed.snapshotId,
      })
    }
    await this.driver.deleteVolumeSnapshot(parsed.snapshotId)
    await mutateRecord<KubernetesWorkspaceRecord>(this.driver, workspace.name, 'workspace', (current) => ({
      ...current,
      checkpoints: current.checkpoints.filter((item) => item.snapshotRef !== parsed.snapshotId),
      updatedAt: new Date().toISOString(),
    }), parsed.signal)
  }

  private async instrument<T>(
    operation: 'list' | 'purge' | 'sweep' | 'delete_snapshot',
    action: () => Promise<T>,
  ): Promise<T> {
    return withSandboxTelemetry(this.telemetry, this.adapterId, operation, action)
  }

  private async revokePrincipal(
    records: readonly VersionedKubernetesRecord[],
    selector: Extract<SandboxSelector, { kind: 'principal' }>,
    signal?: AbortSignal,
  ): Promise<void> {
    const revokedKey = actorLogicalKey({
      ...(selector.tenantId ? { tenantId: selector.tenantId } : {}),
      principalId: selector.principalId,
    })
    const owners = records
      .filter((record) => record.kind === 'owner')
      .map((record) => record as VersionedKubernetesRecord<KubernetesOwnerRecord>)
      .filter((record) => matchesSelector(record.value.owner, selector))
    for (const owner of owners) {
      await mutateRecord<KubernetesOwnerRecord>(this.driver, owner.name, 'owner', (current) => ({
        ...current,
        revokedActors: unique([...current.revokedActors, revokedKey]),
        updatedAt: new Date().toISOString(),
      }), signal)
    }
    for (const record of records) {
      if (record.kind !== 'sandbox') continue
      const sandbox = record as VersionedKubernetesRecord<KubernetesSandboxRecord>
      if (!matchesSelector(sandbox.value.scope.owner, selector)) continue
      await mutateRecord<KubernetesSandboxRecord>(this.driver, sandbox.name, 'sandbox', (current) => ({
        ...current,
        revokedActors: unique([...current.revokedActors, revokedKey]),
        updatedAt: new Date().toISOString(),
      }), signal)
    }
  }
}

function toSummaries(record: VersionedKubernetesRecord): readonly SandboxResourceSummary[] {
  if (record.kind === 'sandbox') return [toSandboxSummary(record as VersionedKubernetesRecord<KubernetesSandboxRecord>)]
  if (record.kind !== 'workspace') return []
  const workspace = (record as VersionedKubernetesRecord<KubernetesWorkspaceRecord>).value
  const workspaceSummary: SandboxResourceSummary = {
    resourceId: workspace.workspaceRef,
    kind: 'workspace',
    owner: workspace.sandboxOwner,
    state: workspace.state === 'active'
      ? 'active'
      : workspace.state === 'paused'
        ? 'paused'
        : workspace.state === 'cleaned'
          ? 'deleted'
          : 'terminal',
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    pinned: false,
  }
  const snapshots: SandboxResourceSummary[] = workspace.checkpoints
    .filter((checkpoint): checkpoint is typeof checkpoint & { snapshotRef: string } => checkpoint.snapshotRef !== undefined)
    .map((checkpoint) => ({
      resourceId: checkpoint.snapshotRef,
      kind: 'snapshot',
      owner: workspace.sandboxOwner,
      state: 'active',
      createdAt: checkpoint.committedAt,
      updatedAt: checkpoint.committedAt,
      ...(checkpoint.sizeBytes !== undefined ? { sizeBytes: checkpoint.sizeBytes } : {}),
      pinned: workspace.pins.includes(checkpoint.checkpointRef),
    }))
  return [workspaceSummary, ...snapshots]
}

function toSandboxSummary(record: VersionedKubernetesRecord<KubernetesSandboxRecord>): SandboxResourceSummary {
  const value = record.value
  return {
    resourceId: record.name,
    kind: 'sandbox',
    owner: value.scope.owner,
    scope: value.scope,
    state: value.state === 'provisioning'
      ? 'provisioning'
      : value.state === 'active'
        ? 'active'
        : value.state === 'state_lost'
          ? 'state_lost'
          : 'terminal',
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    pinned: false,
  }
}

function matchesSelector(owner: SandboxOwner, selector: SandboxSelector): boolean {
  if (selector.kind === 'owner') return ownerLogicalKey(owner) === ownerLogicalKey(selector.owner)
  if (owner.namespace !== selector.namespace) return false
  if (selector.kind === 'tenant') return owner.identity?.tenantId === selector.tenantId
  if (selector.tenantId !== undefined && owner.identity?.tenantId !== selector.tenantId) return false
  return owner.identity?.principalId === selector.principalId || owner.identity?.principalId === undefined
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort()
}
