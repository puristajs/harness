import { z } from 'zod'

import { OperationCancelledError, SandboxConflictError, SandboxError, SandboxPermissionDeniedError, SandboxQuotaExceededError, SandboxStateLostError, ValidationError } from '../errors/index.js'
import {
  sandboxAdministrationOptionsSchema,
  sandboxListOptionsSchema,
  sandboxPurgeOptionsSchema,
  sandboxResourceKindSchema,
  sandboxResourceSummarySchema,
  sandboxResourceStateSchema,
  sandboxSelectorSchema,
  sandboxSnapshotDeleteOptionsSchema,
  sandboxSweepOptionsSchema,
  type SandboxAdministrationOptions,
  type SandboxListOptions,
  type SandboxPurgeOptions,
  type SandboxPurgeResult,
  type SandboxResourcePage,
  type SandboxResourceSummary,
  type SandboxSelector,
  type SandboxSnapshotDeleteOptions,
  type SandboxSweepOptions,
  type SandboxSweepResult
} from './administration.js'
import { sandboxScopeKey } from './lifecycle.js'
import { sandboxOwnerRegistrationOptionsSchema, sandboxOwnerSchema, sandboxScopeSchema, type SandboxOwner, type SandboxOwnerRegistrationOptions, type SandboxScope } from './ownership.js'
import type { HarnessIdentity } from '../identity/index.js'

const CATALOG_VERSION = 1
const RETRY_AFTER_MS = 1_000

const createResourceSchema = z.strictObject({
  resourceId: z.string().min(1),
  kind: sandboxResourceKindSchema,
  owner: sandboxOwnerSchema,
  scope: sandboxScopeSchema.optional(),
  pinned: z.boolean().default(false),
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  expiresAt: z.string().datetime({ offset: true }).refine((value) => value.endsWith('Z')).optional(),
  idempotencyKey: z.string().min(1).optional()
}).superRefine((value, context) => {
  if (value.kind === 'sandbox' && value.scope === undefined) context.addIssue({ code: 'custom', path: ['scope'], message: 'Sandbox resources require a scope.' })
  if (value.kind === 'workspace' && value.scope !== undefined) context.addIssue({ code: 'custom', path: ['scope'], message: 'Workspace resources cannot carry a sandbox scope.' })
  if (value.scope && ownerKey(value.owner) !== ownerKey(value.scope.owner)) context.addIssue({ code: 'custom', path: ['scope', 'owner'], message: 'A resource scope must retain the exact owner.' })
})

/** Private resource creation intent persisted before adapter-owned provisioning starts. */
export type PrivateCatalogResource = z.output<typeof createResourceSchema>

const ownerRecordSchema = z.strictObject({ owner: sandboxOwnerSchema, state: z.enum(['active', 'revoking', 'revoked']), createdAt: z.string(), updatedAt: z.string(), version: z.number().int().positive() })
const resourceRecordSchema = z.strictObject({
  resourceId: z.string().min(1), kind: sandboxResourceKindSchema, owner: sandboxOwnerSchema, scope: sandboxScopeSchema.optional(),
  state: sandboxResourceStateSchema, createdAt: z.string(), updatedAt: z.string(), expiresAt: z.string().optional(),
  sizeBytes: z.number().int().min(0).optional(), pinned: z.boolean(), idempotencyKey: z.string().min(1).optional(), version: z.number().int().positive()
})
const barrierSchema = z.strictObject({ selector: sandboxSelectorSchema, createdAt: z.string(), version: z.number().int().positive() })
const purgeRecordSchema = z.strictObject({ selector: sandboxSelectorSchema, idempotencyKey: z.string().min(1), deletedResources: z.number().int().min(0), state: z.enum(['cleanup_pending', 'completed']), updatedAt: z.string(), version: z.number().int().positive() })
const journalSchema = z.strictObject({ version: z.literal(CATALOG_VERSION), owners: z.array(ownerRecordSchema), resources: z.array(resourceRecordSchema), barriers: z.array(barrierSchema), purges: z.array(purgeRecordSchema) })
type Journal = z.output<typeof journalSchema>
type ResourceRecord = z.output<typeof resourceRecordSchema>
type SandboxResourceKind = z.output<typeof sandboxResourceKindSchema>
type SandboxResourceState = z.output<typeof sandboxResourceStateSchema>

/** Minimal persistence boundary for an adapter-private catalog journal. */
export interface PrivateCatalogStorage {
  read(): Promise<string | undefined>
  write(value: string): Promise<void>
  /** Serializes one read-modify-write transaction across catalog clients sharing this authority. */
  exclusive<T>(operation: () => Promise<T>): Promise<T>
}

/** Callback owned by a concrete adapter; it receives no provider reference from the public API. */
export interface PrivateCatalogCallbacks {
  deleteResource?(resource: SandboxResourceSummary, signal?: AbortSignal): Promise<void>
}

/** Adapter-private catalog configuration; never a Harness configuration surface on its own. */
export interface PrivateSandboxCatalogOptions {
  administration?: SandboxAdministrationOptions
  callbacks?: PrivateCatalogCallbacks
  now?: () => Date
}

/**
 * Durable, adapter-private owner catalog. It records only authoritative adapter
 * inventory and never discovers arbitrary host paths as sandbox resources.
 */
export class PrivateSandboxCatalog {
  private readonly options: z.output<typeof sandboxAdministrationOptionsSchema>
  private readonly callbacks: PrivateCatalogCallbacks
  private readonly now: () => Date
  private queue: Promise<void> = Promise.resolve()

  public constructor(private readonly storage: PrivateCatalogStorage, options: PrivateSandboxCatalogOptions = {}) {
    this.options = parseOptions(options.administration)
    this.callbacks = options.callbacks ?? {}
    this.now = options.now ?? (() => new Date())
  }

  /** Registers owner metadata without allocating a workspace, process, or guest file. */
  public async registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void> {
    const input = parseInput(sandboxOwnerRegistrationOptionsSchema, options)
    throwIfAborted(input.signal)
    await this.mutate(async (journal) => {
      throwIfAborted(input.signal)
      if (isRevoked(journal, input.owner)) throw new SandboxPermissionDeniedError('owner_revoked')
      const existing = findOwner(journal, input.owner)
      if (existing) {
        if (existing.state !== 'active') throw new SandboxPermissionDeniedError('owner_revoked')
        return undefined
      }
      if (input.mode === 'attach') throw new SandboxStateLostError('Sandbox owner registration is missing.', { reason: 'owner_missing', lifetime: 'session' })
      assertNormalCapacity(journal, this.options, 1, 1)
      const timestamp = this.timestamp()
      journal.owners.push({ owner: input.owner, state: 'active', createdAt: timestamp, updatedAt: timestamp, version: 1 })
      return undefined
    })
  }

  /**
   * Admits one already-authorized actor to an owner without persisting the
   * actor. The framework owns authorization; the catalog only enforces its
   * durable offboarding barriers.
   */
  public async assertActorActive(owner: SandboxOwner, actor: HarnessIdentity | undefined): Promise<void> {
    const parsedOwner = sandboxOwnerSchema.parse(owner)
    await this.read(async (journal) => {
      if (isActorRevoked(journal, parsedOwner, actor)) throw new SandboxPermissionDeniedError('principal_revoked')
    })
  }

  /**
   * Fences an existing attachment before and after every adapter operation.
   * Principal barriers target the acting attachment without terminating a
   * tenant-owned resource shared by other authorized principals.
   */
  public async assertAttachmentActive(scope: SandboxScope, actor: HarnessIdentity | undefined): Promise<void> {
    const parsedScope = sandboxScopeSchema.parse(scope)
    await this.read(async (journal) => {
      if (isActorRevoked(journal, parsedScope.owner, actor)) throw new SandboxPermissionDeniedError('principal_revoked')
      assertOwnerActive(journal, parsedScope.owner)
      const resource = journal.resources.find((item) => item.kind === 'sandbox' && item.scope && sameScope(item.scope, parsedScope))
      if (!resource || resource.state !== 'active') {
        throw new SandboxStateLostError('Sandbox lifecycle state is unavailable.', { reason: 'lifecycle_state_missing', lifetime: parsedScope.lifetime })
      }
    })
  }

  /** Persists provisioning intent and admits a resource only for an active, unrevoked owner. */
  public async provision(resource: PrivateCatalogResource): Promise<SandboxResourceSummary> {
    const input = parseInput(createResourceSchema, resource)
    return await this.mutate(async (journal) => {
      assertOwnerActive(journal, input.owner)
      const existing = journal.resources.find((item) => item.resourceId === input.resourceId)
      if (existing) {
        if (sameResourceIntent(existing, input)) return toSummary(existing)
        throw new SandboxConflictError('idempotency_conflict')
      }
      if (input.kind === 'sandbox') {
        const active = journal.resources.filter((item) => item.kind === 'sandbox' && item.state !== 'deleted').length
        if (active >= this.options.maxActiveSandboxes) throw new SandboxQuotaExceededError({ quota: 'active_sandboxes', limit: this.options.maxActiveSandboxes, actual: active })
      }
      assertNormalCapacity(journal, this.options, 1)
      const timestamp = this.timestamp()
      const record: ResourceRecord = {
        resourceId: input.resourceId, kind: input.kind, owner: input.owner, state: 'provisioning', createdAt: timestamp, updatedAt: timestamp,
        pinned: input.pinned, version: 1,
        ...(input.scope ? { scope: input.scope } : {}), ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      }
      journal.resources.push(record)
      return toSummary(record)
    })
  }

  /** Marks a previously admitted private resource active after provider allocation succeeds. */
  public async activate(resourceId: string): Promise<void> {
    await this.mutate(async (journal) => {
      const resource = journal.resources.find((item) => item.resourceId === resourceId)
      if (!resource || (resource.state !== 'provisioning' && resource.state !== 'active')) {
        throw new SandboxStateLostError('Sandbox provisioning state is unavailable.', { reason: 'lifecycle_state_missing', lifetime: 'session' })
      }
      if (resource.state === 'active') return undefined
      resource.state = 'active'
      resource.updatedAt = this.timestamp()
      resource.version += 1
    })
  }

  /** Marks one active sandbox partition terminal without deleting its owner or sibling partitions. */
  public async terminalize(scope: SandboxScope): Promise<void> {
    const parsed = sandboxScopeSchema.parse(scope)
    await this.mutate(async (journal) => {
      const resource = journal.resources.find((item) => item.kind === 'sandbox' && item.scope && sameScope(item.scope, parsed))
      if (!resource || resource.state === 'deleted') return undefined
      resource.state = 'terminal'
      resource.updatedAt = this.timestamp()
      resource.version += 1
    })
  }

  /** Adapter-private lifecycle update for a resource already admitted by this catalog. */
  public async setResourceState(resourceId: string, state: Extract<SandboxResourceState, 'active' | 'paused' | 'terminal'>): Promise<void> {
    await this.mutate(async (journal) => {
      const resource = journal.resources.find((item) => item.resourceId === resourceId)
      if (!resource || resource.state === 'deleted') return undefined
      resource.state = state
      resource.updatedAt = this.timestamp()
      resource.version += 1
    })
  }

  /** Adapter-private pin mirror used to make administrative snapshot listings truthful. */
  public async setSnapshotPinned(resourceId: string, pinned: boolean): Promise<void> {
    await this.setResourcePinned(resourceId, pinned)
  }

  /**
   * Adapter-private retention protection for a resource and its owned payload.
   * It is intentionally not an administration API: concrete adapters use it to
   * keep aggregate roots alive while one of their recovery snapshots is pinned.
   */
  public async setResourcePinned(resourceId: string, pinned: boolean): Promise<void> {
    await this.mutate(async (journal) => {
      const resource = journal.resources.find((item) => item.resourceId === resourceId)
      if (!resource || resource.state === 'deleted') return undefined
      resource.pinned = pinned
      resource.updatedAt = this.timestamp()
      resource.version += 1
    })
  }

  /** Adapter-private expiry assignment after a durable terminal transition. */
  public async setResourceExpiry(resourceId: string, expiresAt: string | undefined): Promise<void> {
    await this.mutate(async (journal) => {
      const resource = journal.resources.find((item) => item.resourceId === resourceId)
      if (!resource || resource.state === 'deleted') return undefined
      if (expiresAt === undefined) delete resource.expiresAt
      else resource.expiresAt = z.string().datetime({ offset: true }).parse(expiresAt)
      resource.updatedAt = this.timestamp()
      resource.version += 1
    })
  }

  /** Adapter-private measured size update after a resource has been committed. */
  public async setResourceSize(resourceId: string, sizeBytes: number): Promise<void> {
    await this.mutate(async (journal) => {
      const resource = journal.resources.find((item) => item.resourceId === resourceId)
      if (!resource || resource.state === 'deleted') return undefined
      resource.sizeBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(sizeBytes)
      resource.updatedAt = this.timestamp()
      resource.version += 1
    })
  }

  /** Adapter-private tombstone transition after ordinary lifecycle cleanup. */
  public async markDeleted(resourceId: string): Promise<void> {
    await this.mutate(async (journal) => {
      const resource = journal.resources.find((item) => item.resourceId === resourceId)
      if (!resource || resource.state === 'deleted') return undefined
      resource.state = 'deleted'
      resource.updatedAt = this.timestamp()
      resource.version += 1
    })
  }

  /** Lists stable, bounded adapter-owned inventory for one exact selector. */
  public async list(options: SandboxListOptions): Promise<SandboxResourcePage> {
    const input = parseInput(sandboxListOptionsSchema, options)
    throwIfAborted(input.signal)
    return await this.read(async (journal) => {
      const cursor = input.cursor ? parseCursor(input.cursor) : undefined
      const binding = selectorBinding(input.selector, input.kind)
      if (cursor && cursor.binding !== binding) throw invalidOptions('The sandbox catalog cursor does not match this selector.')
      const candidates = journal.resources.filter((item) => matchesSelector(item.owner, input.selector) && (input.kind === undefined || item.kind === input.kind)).sort((left, right) => left.resourceId.localeCompare(right.resourceId))
      const start = cursor ? candidates.findIndex((item) => item.resourceId === cursor.after) + 1 : 0
      if (cursor && start === 0) throw invalidOptions('The sandbox catalog cursor is invalid.')
      const items = candidates.slice(start, start + input.limit).map(toSummary)
      const tail = candidates[start + items.length]
      return { items, ...(tail ? { nextCursor: encodeCursor(binding, items.at(-1)!.resourceId) } : {}) }
    })
  }

  /** Persists revocation before bounded, retryable resource deletion. */
  public async purge(options: SandboxPurgeOptions): Promise<SandboxPurgeResult> {
    const input = parseInput(sandboxPurgeOptionsSchema, options)
    throwIfAborted(input.signal)
    return await this.transaction(async (journal, persist) => {
      let purge = journal.purges.find((item) => item.idempotencyKey === input.idempotencyKey)
      if (purge && selectorBinding(purge.selector) !== selectorBinding(input.selector)) throw new SandboxConflictError('idempotency_conflict')
      if (!purge) {
        const barrier = journal.barriers.find((item) => selectorBinding(item.selector) === selectorBinding(input.selector))
        assertPurgeCapacity(journal, this.options, (barrier ? 0 : 1) + 1)
        const timestamp = this.timestamp()
        if (!barrier) journal.barriers.push({ selector: input.selector, createdAt: timestamp, version: 1 })
        purge = { selector: input.selector, idempotencyKey: input.idempotencyKey, deletedResources: 0, state: 'cleanup_pending', updatedAt: timestamp, version: 1 }
        journal.purges.push(purge)
        for (const owner of journal.owners) if (matchesSelector(owner.owner, input.selector) && owner.state === 'active') { owner.state = 'revoking'; owner.updatedAt = timestamp; owner.version += 1 }
      }
      const pending = journal.resources.filter((item) => matchesSelector(item.owner, input.selector) && item.state !== 'deleted').sort((left, right) => left.resourceId.localeCompare(right.resourceId))
      const resources = pending.slice(0, input.limit)
      for (const resource of resources) {
        resource.state = 'cleanup_pending'
        resource.updatedAt = this.timestamp()
        resource.version += 1
      }
      await persist()
      for (const resource of resources) {
        if (input.signal?.aborted) break
        try { await this.callbacks.deleteResource?.(toSummary(resource), input.signal) } catch { break }
        if (input.signal?.aborted) break
        resource.state = 'deleted'; resource.updatedAt = this.timestamp(); resource.version += 1
        purge.deletedResources += 1; purge.updatedAt = this.timestamp(); purge.version += 1
        await persist()
      }
      return await this.finishPurge(journal, purge, input.selector, persist)
    })
  }

  /** Deletes one unpinned snapshot only when it belongs to the exact owner incarnation. */
  public async deleteSnapshot(options: SandboxSnapshotDeleteOptions): Promise<void> {
    const input = parseInput(sandboxSnapshotDeleteOptionsSchema, options)
    throwIfAborted(input.signal)
    await this.transaction(async (journal, persist) => {
      const resource = journal.resources.find((item) => item.resourceId === input.snapshotId && item.kind === 'snapshot' && ownerKey(item.owner) === ownerKey(input.owner))
      if (!resource || resource.state === 'deleted') return undefined
      if (resource.pinned) throw new SandboxConflictError('snapshot_pinned')
      resource.state = 'cleanup_pending'; resource.updatedAt = this.timestamp(); resource.version += 1
      await persist()
      try { await this.callbacks.deleteResource?.(toSummary(resource), input.signal) } catch (error) {
        if (error instanceof OperationCancelledError) throw error
        throw new SandboxError('Sandbox snapshot cleanup is pending.', { reason: 'cleanup_pending' }, error)
      }
      resource.state = 'deleted'; resource.updatedAt = this.timestamp(); resource.version += 1
      await persist()
      return undefined
    })
  }

  /** Reconciles bounded expired or pending cleanup resources without crossing owner barriers. */
  public async sweep(options: SandboxSweepOptions = {}): Promise<SandboxSweepResult> {
    const input = parseInput(sandboxSweepOptionsSchema, options)
    throwIfAborted(input.signal)
    return await this.transaction(async (journal, persist) => {
      const cursor = input.cursor ? parseCursor(input.cursor) : undefined
      if (cursor && cursor.binding !== 'sweep') throw invalidOptions('The sandbox catalog cursor is invalid.')
      const timestamp = this.timestamp()
      const candidates = journal.resources.filter((item) => item.state !== 'deleted' && !item.pinned && (item.state === 'cleanup_pending' || (item.expiresAt !== undefined && item.expiresAt <= timestamp))).sort((left, right) => left.resourceId.localeCompare(right.resourceId))
      const start = cursor ? candidates.findIndex((item) => item.resourceId === cursor.after) + 1 : 0
      if (cursor && start === 0) throw invalidOptions('The sandbox catalog cursor is invalid.')
      const selected = candidates.slice(start, start + input.limit)
      let deletedResources = 0
      for (const resource of selected) {
        if (input.signal?.aborted) break
        resource.state = 'cleanup_pending'; resource.updatedAt = this.timestamp(); resource.version += 1
        await persist()
        try { await this.callbacks.deleteResource?.(toSummary(resource), input.signal) } catch { continue }
        if (input.signal?.aborted) break
        resource.state = 'deleted'; resource.updatedAt = this.timestamp(); resource.version += 1; deletedResources += 1
        await persist()
      }
      const pendingResources = journal.resources.filter((item) => item.state === 'cleanup_pending').length
      return { examinedResources: selected.length, deletedResources, pendingResources, ...(selected.length === input.limit ? { nextCursor: encodeCursor('sweep', selected.at(-1)!.resourceId) } : {}) }
    })
  }

  private async finishPurge(journal: Journal, purge: z.output<typeof purgeRecordSchema>, selector: SandboxSelector, persist: () => Promise<void>): Promise<SandboxPurgeResult> {
      const remaining = journal.resources.filter((item) => matchesSelector(item.owner, selector) && item.state !== 'deleted').length
      purge.updatedAt = this.timestamp(); purge.version += 1
      if (remaining === 0) {
        purge.state = 'completed'
        for (const owner of journal.owners) if (matchesSelector(owner.owner, selector)) { owner.state = 'revoked'; owner.updatedAt = this.timestamp(); owner.version += 1 }
        await persist()
        return { state: 'completed', deletedResources: purge.deletedResources, remainingResources: 0 }
      }
      purge.state = 'cleanup_pending'
      await persist()
      return { state: 'cleanup_pending', deletedResources: purge.deletedResources, remainingResources: remaining, retryAfterMs: RETRY_AFTER_MS }
  }

  private async read<T>(operation: (journal: Journal) => Promise<T> | T): Promise<T> { return await this.storage.exclusive(async () => await this.withQueue(async () => await operation(await this.load()))) }
  private async mutate<T>(operation: (journal: Journal) => Promise<T> | T): Promise<T> { return await this.storage.exclusive(async () => await this.withQueue(async () => { const journal = await this.load(); const result = await operation(journal); await this.storage.write(JSON.stringify(journalSchema.parse(journal))); return result })) }
  private async transaction<T>(operation: (journal: Journal, persist: () => Promise<void>) => Promise<T>): Promise<T> { return await this.storage.exclusive(async () => await this.withQueue(async () => { const journal = await this.load(); const persist = async (): Promise<void> => await this.storage.write(JSON.stringify(journalSchema.parse(journal))); return await operation(journal, persist) })) }
  private async load(): Promise<Journal> {
    const value = await this.storage.read()
    if (value === undefined) return { version: CATALOG_VERSION, owners: [], resources: [], barriers: [], purges: [] }
    try { return journalSchema.parse(JSON.parse(value)) } catch { throw new SandboxStateLostError('Sandbox catalog state cannot be recovered.', { reason: 'creation_indeterminate', lifetime: 'session' }) }
  }
  private async withQueue<T>(operation: () => Promise<T>): Promise<T> { const previous = this.queue; let release: () => void = () => undefined; this.queue = new Promise<void>((resolve) => { release = resolve }); await previous; try { return await operation() } finally { release() } }
  private timestamp(): string { return this.now().toISOString() }
}

function parseOptions(value: SandboxAdministrationOptions | undefined): z.output<typeof sandboxAdministrationOptionsSchema> { return parseInput(sandboxAdministrationOptionsSchema, value ?? {}) }
function parseInput<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (parsed.success) return parsed.data; throw invalidOptions('Sandbox options are invalid.') }
function invalidOptions(message: string): ValidationError { return new ValidationError(message, { where: 'sandbox_options', issues: 'invalid_sandbox_options' }) }
function throwIfAborted(signal: AbortSignal | undefined): void { if (signal?.aborted) throw new OperationCancelledError('Sandbox catalog operation was cancelled.', { scope: 'sandbox' }) }
function ownerKey(owner: SandboxOwner): string { return JSON.stringify([owner.namespace, owner.id, owner.instanceId, owner.identity === undefined ? false : true, owner.identity?.tenantId, owner.identity?.principalId]) }
function selectorBinding(selector: SandboxSelector, kind?: SandboxResourceKind): string { return JSON.stringify([selector, kind ?? null]) }
function matchesSelector(owner: SandboxOwner, selector: SandboxSelector): boolean { if (selector.kind === 'owner') return ownerKey(owner) === ownerKey(selector.owner); if (selector.kind === 'tenant') return owner.namespace === selector.namespace && owner.identity?.tenantId === selector.tenantId; return owner.namespace === selector.namespace && owner.identity?.principalId === selector.principalId && owner.identity?.tenantId === selector.tenantId }
function isRevoked(journal: Journal, owner: SandboxOwner): boolean { return journal.barriers.some((item) => matchesSelector(owner, item.selector)) }
function isActorRevoked(journal: Journal, owner: SandboxOwner, actor: HarnessIdentity | undefined): boolean {
  return journal.barriers.some((item) => matchesAttachment(owner, actor, item.selector))
}
function matchesAttachment(owner: SandboxOwner, actor: HarnessIdentity | undefined, selector: SandboxSelector): boolean {
  if (selector.kind !== 'principal') return matchesSelector(owner, selector)
  return owner.namespace === selector.namespace
    && actor?.principalId === selector.principalId
    && actor?.tenantId === selector.tenantId
}
function findOwner(journal: Journal, owner: SandboxOwner): z.output<typeof ownerRecordSchema> | undefined { return journal.owners.find((item) => ownerKey(item.owner) === ownerKey(owner)) }
function assertOwnerActive(journal: Journal, owner: SandboxOwner): void { const record = findOwner(journal, owner); if (!record) throw new SandboxStateLostError('Sandbox owner registration is missing.', { reason: 'owner_missing', lifetime: 'session' }); if (record.state !== 'active' || isRevoked(journal, owner)) throw new SandboxPermissionDeniedError('owner_revoked') }
function entries(journal: Journal): number { return journal.owners.length + journal.resources.length + journal.barriers.length + journal.purges.length }
function assertNormalCapacity(journal: Journal, options: z.output<typeof sandboxAdministrationOptionsSchema>, additions: number, activeOwnerDelta = 0): void { const limit = options.maxCatalogEntries - options.selectorRevocationReserve; const projected = entries(journal) + additions + 2 * (journal.owners.filter((owner) => owner.state === 'active').length + activeOwnerDelta); if (projected > limit) throw new SandboxQuotaExceededError({ quota: 'catalog_entries', limit, actual: projected - additions }) }
function assertPurgeCapacity(journal: Journal, options: z.output<typeof sandboxAdministrationOptionsSchema>, additions: number): void { if (entries(journal) + additions > options.maxCatalogEntries) throw new SandboxQuotaExceededError({ quota: 'catalog_entries', limit: options.maxCatalogEntries, actual: entries(journal) }) }
function sameResourceIntent(record: ResourceRecord, input: PrivateCatalogResource): boolean {
  return record.kind === input.kind
    && ownerKey(record.owner) === ownerKey(input.owner)
    && (record.scope === undefined || input.scope === undefined ? record.scope === input.scope : sameScope(record.scope, input.scope))
    && record.idempotencyKey === input.idempotencyKey
}
function sameScope(left: SandboxScope, right: SandboxScope): boolean { return sandboxScopeKey(left) === sandboxScopeKey(right) }
function toSummary(record: ResourceRecord): SandboxResourceSummary { return sandboxResourceSummarySchema.parse({ resourceId: record.resourceId, kind: record.kind, owner: record.owner, ...(record.scope ? { scope: record.scope } : {}), state: record.state, createdAt: record.createdAt, updatedAt: record.updatedAt, ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}), ...(record.sizeBytes === undefined ? {} : { sizeBytes: record.sizeBytes }), pinned: record.pinned }) }
type Cursor = { version: 1; binding: string; after: string }
function encodeCursor(binding: string, after: string): string { return Buffer.from(JSON.stringify({ version: 1, binding, after } satisfies Cursor)).toString('base64url') }
function parseCursor(value: string): Cursor { try { const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); const parsed = z.strictObject({ version: z.literal(1), binding: z.string().min(1), after: z.string().min(1) }).safeParse(decoded); if (parsed.success) return parsed.data } catch {} throw invalidOptions('The sandbox catalog cursor is invalid.') }
