import { randomUUID } from 'node:crypto'
import {
  OperationCancelledError,
  SandboxError,
  ValidationError,
  sandboxListOptionsSchema,
  sandboxOwnerRegistrationOptionsSchema,
  sandboxPurgeOptionsSchema,
  sandboxSnapshotDeleteOptionsSchema,
  sandboxSweepOptionsSchema,
  withSandboxTelemetry,
  type SandboxListOptions,
  type SandboxOwnerRegistrationOptions,
  type SandboxPurgeOptions,
  type SandboxPurgeResult,
  type SandboxResourcePage,
  type SandboxSnapshotDeleteOptions,
  type SandboxSweepOptions,
  type SandboxSweepResult,
  type HarnessAdapterContext,
  type SandboxTelemetryOperation
} from '@purista/harness'
import { checkCancelled } from './transport.js'
import { DockerOwnershipJournal, type DockerPurgeProgress } from './ownership.js'

const DEFAULT_PAGE_LIMIT = 100
const MAXIMUM_PAGE_LIMIT = 1_000
const CLEANUP_RETRY_AFTER_MS = 1_000

/** Private engine actions used only by the Docker catalog cleanup coordinator. */
export interface DockerCleanupDriver {
  stopContainer(name: string, signal?: AbortSignal): Promise<void>
  removeContainer(name: string, signal?: AbortSignal): Promise<void>
  removeVolume(name: string, signal?: AbortSignal): Promise<void>
}

/**
 * Private administration foundation for the existing Docker adapter.
 *
 * The later port cutover owns its public attachment. This class deliberately
 * returns only catalog summaries and never raw engine references.
 */
export class DockerAdministration {
  private readonly cursors = new DockerCursorStore()
  private context: HarnessAdapterContext | undefined

  public constructor(
    private readonly journal: DockerOwnershipJournal,
    private readonly driver: DockerCleanupDriver
  ) {}

  /** Receives content-free Harness telemetry when this adapter is composed. */
  public configureHarnessContext(context: HarnessAdapterContext): void { this.context = context }

  /** Registers immutable ownership through the same public telemetry contract. */
  public async registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void> {
    await this.instrument('register_owner', async () => {
      const input = parseOptions(sandboxOwnerRegistrationOptionsSchema, options)
      checkCancelled(input.signal)
      await this.journal.registerOwner(input)
    })
  }

  public async list(options: SandboxListOptions): Promise<SandboxResourcePage> {
    return await this.instrument('list', async () => {
      const input = parseOptions(sandboxListOptionsSchema, options)
      const limit = input.limit
      const cursor = input.cursor === undefined ? undefined : this.cursors.readList(input.cursor, this.journal.selectorDigest(input.selector), input.kind)
      checkCancelled(input.signal)
      const records = (await this.journal.resourcesFor(input.selector))
        .filter(record => input.kind === undefined || record.summary.kind === input.kind)
        .sort((left, right) => left.summary.resourceId.localeCompare(right.summary.resourceId))
        .filter(record => cursor === undefined || record.summary.resourceId > cursor.afterResourceId)
      const items = records.slice(0, limit).map(record => record.summary)
      const last = items.at(-1)
      return {
        items,
        ...(last && records.length > items.length ? { nextCursor: this.cursors.createList(this.journal.selectorDigest(input.selector), input.kind, last.resourceId) } : {})
      }
    })
  }

  public async purge(options: SandboxPurgeOptions): Promise<SandboxPurgeResult> {
    return await this.instrument('purge', async () => {
      const input = parseOptions(sandboxPurgeOptionsSchema, options)
      const limit = input.limit
      checkCancelled(input.signal)
      const progress = await this.journal.beginPurge(input.selector, input.idempotencyKey)
      const records = (await this.journal.resourcesFor(input.selector)).filter(record => record.summary.state !== 'deleted').slice(0, limit)
      for (const resource of records) {
        await this.cleanup(resource.summary.resourceId, progress, input.signal)
        if (input.signal?.aborted) break
      }
      const remainingResources = await this.journal.remainingResources(input.selector)
      const persisted = await this.journal.purgeProgress(progress.idempotencyKey)
      if (remainingResources === 0) return { state: 'completed', deletedResources: persisted.deletedResources, remainingResources }
      return { state: 'cleanup_pending', deletedResources: persisted.deletedResources, remainingResources, retryAfterMs: CLEANUP_RETRY_AFTER_MS }
    })
  }

  public async sweep(options: SandboxSweepOptions = {}): Promise<SandboxSweepResult> {
    return await this.instrument('sweep', async () => {
      const input = parseOptions(sandboxSweepOptionsSchema, options)
      const limit = input.limit
      const afterResourceId = input.cursor === undefined ? undefined : this.cursors.readSweep(input.cursor)
      checkCancelled(input.signal)
      const records = (await this.journal.pendingResources())
        .sort((left, right) => left.summary.resourceId.localeCompare(right.summary.resourceId))
        .filter(resource => afterResourceId === undefined || resource.summary.resourceId > afterResourceId)
        .slice(0, limit)
      let deletedResources = 0
      let pendingResources = 0
      for (const resource of records) {
        const result = await this.cleanup(resource.summary.resourceId, undefined, input.signal)
        deletedResources += result === 'deleted' ? 1 : 0
        pendingResources += result === 'pending' ? 1 : 0
      }
      const last = records.at(-1)
      return {
        examinedResources: records.length,
        deletedResources,
        pendingResources,
        ...(last && (await this.journal.pendingResources()).some(resource => resource.summary.resourceId > last.summary.resourceId)
          ? { nextCursor: this.cursors.createSweep(last.summary.resourceId) }
          : {})
      }
    })
  }

  /** Docker exposes no snapshot capability, so no adapter-owned snapshot can exist. */
  public async deleteSnapshot(options: SandboxSnapshotDeleteOptions): Promise<void> {
    await this.instrument('delete_snapshot', async () => {
      const input = parseOptions(sandboxSnapshotDeleteOptionsSchema, options)
      checkCancelled(input.signal)
    })
  }

  /** Cleans one catalog-owned resource without broad owner revocation. */
  public async cleanupResource(resourceId: string, signal?: AbortSignal): Promise<'deleted' | 'pending'> {
    return await this.cleanup(resourceId, undefined, signal)
  }

  private async cleanup(
    resourceId: string,
    progress: DockerPurgeProgress | undefined,
    signal?: AbortSignal
  ): Promise<'deleted' | 'pending'> {
    try {
      return await this.journal.withCleanupLock(resourceId, async () => {
        const claim = await this.journal.claimCleanup(resourceId)
        if (claim.state !== 'claimed') return 'pending'
        try {
          if (!claim.stopped) {
            checkCancelled(signal)
            await this.driver.stopContainer(claim.resource.containerName, signal)
            await this.journal.confirmCleanupStep(resourceId, claim.claimId, 'stopped')
          }
          if (!claim.containerRemoved) {
            checkCancelled(signal)
            await this.driver.removeContainer(claim.resource.containerName, signal)
            await this.journal.confirmCleanupStep(resourceId, claim.claimId, 'containerRemoved')
          }
          if (!claim.volumeRemoved) {
            checkCancelled(signal)
            await this.driver.removeVolume(claim.resource.volumeName, signal)
            await this.journal.confirmCleanupStep(resourceId, claim.claimId, 'volumeRemoved')
          }
          await this.journal.completeCleanup(resourceId, claim.claimId)
          if (progress) await this.journal.incrementDeleted(progress.idempotencyKey)
          return 'deleted'
        } catch (error) {
          await this.journal.releaseCleanupClaim(resourceId, claim.claimId)
          if (error instanceof OperationCancelledError && progress === undefined) throw error
          return 'pending'
        }
      })
    } catch (error) {
      if (error instanceof OperationCancelledError && progress === undefined) throw error
      // Another local adapter is still executing the same exact resource
      // cleanup. Its durable progress is the retry authority.
      if (error instanceof SandboxError && error.meta?.['reason'] === 'ownership_conflict') return 'pending'
      throw error
    }
  }

  private async instrument<T>(operation: SandboxTelemetryOperation, action: () => Promise<T>): Promise<T> {
    return await withSandboxTelemetry(this.context?.telemetry, 'docker', operation, action)
  }
}

type DockerCursor =
  | { readonly version: 1; readonly kind: 'list'; readonly selectorDigest: string; readonly resourceKind?: string; readonly afterResourceId: string }
  | { readonly version: 1; readonly kind: 'sweep'; readonly afterResourceId: string }

/** Bounded process-local opaque cursors bind each page request to its exact filter. */
class DockerCursorStore {
  private readonly entries = new Map<string, DockerCursor>()

  public createList(selectorDigest: string, resourceKind: string | undefined, afterResourceId: string): string {
    return this.create({ version: 1, kind: 'list', selectorDigest, ...(resourceKind === undefined ? {} : { resourceKind }), afterResourceId })
  }

  public readList(value: string, selectorDigest: string, resourceKind: string | undefined): { readonly afterResourceId: string } {
    const cursor = this.read(value)
    if (cursor.kind !== 'list' || cursor.selectorDigest !== selectorDigest || cursor.resourceKind !== resourceKind) throw invalidCursor()
    return { afterResourceId: cursor.afterResourceId }
  }

  public createSweep(afterResourceId: string): string {
    return this.create({ version: 1, kind: 'sweep', afterResourceId })
  }

  public readSweep(value: string): string {
    const cursor = this.read(value)
    if (cursor.kind !== 'sweep' || cursor.version !== 1) throw invalidCursor()
    return cursor.afterResourceId
  }

  private create(cursor: DockerCursor): string {
    if (this.entries.size >= 1_024) {
      const first = this.entries.keys().next().value
      if (first !== undefined) this.entries.delete(first)
    }
    const token = randomUUID()
    this.entries.set(token, cursor)
    return token
  }

  private read(value: string): DockerCursor {
    if (value.length === 0 || Buffer.byteLength(value) > 4_096) throw invalidCursor()
    const cursor = this.entries.get(value)
    if (!cursor || cursor.version !== 1) throw invalidCursor()
    return cursor
  }
}

function parseOptions<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ValidationError('Sandbox administration options are invalid.', { where: 'sandbox_options', issues: ['request'] })
  return parsed.data
}

function invalidCursor(): ValidationError {
  return new ValidationError('Sandbox administration options are invalid.', { where: 'sandbox_options', issues: ['cursor'] })
}
