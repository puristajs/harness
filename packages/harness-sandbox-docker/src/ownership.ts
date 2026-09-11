import { createHash, randomUUID } from 'node:crypto'
import {
  HarnessConfigError,
  SandboxConflictError,
  SandboxPermissionDeniedError,
  SandboxQuotaExceededError,
  SandboxStateLostError,
  type HarnessIdentity,
  type SandboxAdministrationOptions,
  type SandboxOwner,
  type SandboxOwnerRegistrationOptions,
  type SandboxResourceSummary,
  type SandboxScope,
  type SandboxSelector,
} from '@purista/harness'
import { z } from 'zod'
import { Records } from './records.js'

const DEFAULT_MAX_CATALOG_ENTRIES = 10_000
const DEFAULT_SELECTOR_REVOCATION_RESERVE = 256
const DEFAULT_MAX_ACTIVE_SANDBOXES = 64

type DockerResourceState = SandboxResourceSummary['state']

const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/
const CANONICAL_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const SANDBOX_GROUP_ID = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/
const ownerString = z.string().refine(value => value.length > 0 && Buffer.byteLength(value) <= 256 && !CONTROL_CHARACTER.test(value))
const privateReference = z.string().min(1).max(4_096).refine(value => !CONTROL_CHARACTER.test(value))
const identitySchema = z.union([
  z.strictObject({}),
  z.strictObject({ tenantId: ownerString }),
  z.strictObject({ principalId: ownerString }),
  z.strictObject({ tenantId: ownerString, principalId: ownerString }),
])
const ownerSchema = z.strictObject({
  namespace: ownerString,
  id: ownerString,
  instanceId: z.string().regex(CANONICAL_ULID),
  identity: identitySchema.optional(),
})
const partitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('shared') }),
  z.strictObject({ kind: z.literal('group'), id: z.string().regex(SANDBOX_GROUP_ID) }),
  z.strictObject({ kind: z.literal('agent'), harnessName: ownerString, id: ownerString }),
  z.strictObject({ kind: z.literal('workflow'), harnessName: ownerString, id: ownerString }),
])
const scopeSchema = z.union([
  z.strictObject({ owner: ownerSchema, partition: partitionSchema, lifetime: z.literal('session') }),
  z.strictObject({ owner: ownerSchema, partition: partitionSchema, lifetime: z.literal('run'), runId: ownerString }),
])
const selectorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('owner'), owner: ownerSchema }),
  z.strictObject({ kind: z.literal('tenant'), namespace: ownerString, tenantId: ownerString }),
  z.strictObject({ kind: z.literal('principal'), namespace: ownerString, tenantId: ownerString.optional(), principalId: ownerString }),
])
const summarySchema = z.strictObject({
  resourceId: privateReference,
  kind: z.literal('sandbox'),
  owner: ownerSchema,
  scope: scopeSchema,
  state: z.enum(['provisioning', 'active', 'paused', 'terminal', 'state_lost', 'cleanup_pending', 'deleted']),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  pinned: z.boolean(),
})
const cleanupSchema = z.strictObject({
  claimId: z.string().uuid().optional(),
  stopped: z.boolean(),
  containerRemoved: z.boolean(),
  volumeRemoved: z.boolean(),
})
const journalSchema = z.strictObject({
  version: z.literal(1),
  owners: z.array(z.strictObject({ key: z.string().regex(/^[a-f0-9]{64}$/), owner: ownerSchema, state: z.enum(['active', 'revoked']) })),
  resources: z.array(z.strictObject({
    ownerKey: z.string().regex(/^[a-f0-9]{64}$/),
    summary: summarySchema,
    label: z.string().regex(/^[a-f0-9]{64}$/),
    containerName: privateReference,
    volumeName: privateReference,
    cleanup: cleanupSchema.optional(),
  })),
  revocations: z.array(z.strictObject({
    key: z.string().regex(/^[a-f0-9]{64}$/),
    selector: selectorSchema,
    reservedOwnerKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })),
  purges: z.array(z.strictObject({
    selector: selectorSchema,
    idempotencyKey: privateReference,
    selectorKey: z.string().regex(/^[a-f0-9]{64}$/),
    reservedOwnerKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    deletedResources: z.number().int().nonnegative(),
  })),
})

type DurableJournal = z.infer<typeof journalSchema>
type DurableResource = DurableJournal['resources'][number]
type DurablePurge = DurableJournal['purges'][number]

export interface DockerTrackedResourceInput {
  readonly summary: SandboxResourceSummary & { readonly kind: 'sandbox'; readonly scope: SandboxScope }
  readonly label: string
  readonly containerName: string
  readonly volumeName: string
}

export interface DockerTrackedResource extends DockerTrackedResourceInput {
  readonly ownerKey: string
}

export interface DockerPurgeProgress {
  readonly selector: SandboxSelector
  readonly idempotencyKey: string
  readonly selectorKey: string
  readonly reservedOwnerKey?: string
  readonly deletedResources: number
}

export type DockerCleanupClaim =
  | { readonly state: 'claimed'; readonly resource: DockerTrackedResource; readonly claimId: string; readonly stopped: boolean; readonly containerRemoved: boolean; readonly volumeRemoved: boolean }
  | { readonly state: 'busy' | 'provisioning' | 'deleted' }

interface ResolvedCatalogOptions {
  readonly maxCatalogEntries: number
  readonly selectorRevocationReserve: number
  readonly maxActiveSandboxes: number
}

/**
 * Docker-private durable owner and resource authority.
 *
 * Provider references remain in this root-private, atomically replaced
 * journal. Docker listing and labels are never a recovery authority.
 */
export class DockerOwnershipJournal {
  private readonly options: ResolvedCatalogOptions

  public constructor(private readonly records: Records, options: SandboxAdministrationOptions = {}) {
    this.options = resolveOptions(options)
  }

  public labelFor(owner: SandboxOwner): string { return this.ownerKey(owner) }

  public async registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void> {
    await this.records.withJournalLock(async () => {
      const stored = await this.records.readJournal()
      if (stored === undefined) {
        if (options.mode !== 'create' || await this.records.ownerRegistrationCount() !== 0) throw stateLost()
        await this.records.registerOwner(options.owner, 'create')
        const state = emptyJournal()
        this.registerInState(state, options.owner, 'create')
        await this.records.writeJournal(state)
        return
      }
      const state = this.parse(stored)
      const current = state.owners.find(entry => entry.key === this.ownerKey(options.owner))
      if (current?.state === 'revoked' || this.isOwnerRevoked(state, options.owner)) throw new SandboxPermissionDeniedError('owner_revoked')
      await this.records.registerOwner(options.owner, options.mode)
      if (!current) {
        if (options.mode === 'attach') throw stateLost()
        this.registerInState(state, options.owner, 'create')
        await this.records.writeJournal(state)
      }
    })
  }

  public async assertAttachment(owner: SandboxOwner, actor?: HarnessIdentity): Promise<void> {
    const state = await this.read()
    this.assertOwnerAttached(state, owner)
    if (actor && this.isActorRevoked(state, owner.namespace, actor)) throw new SandboxPermissionDeniedError('principal_revoked')
  }

  public async trackResource(input: DockerTrackedResourceInput): Promise<DockerTrackedResource> {
    return await this.mutate(async state => {
      const owner = input.summary.owner
      this.assertOwnerAttached(state, owner)
      const ownerKey = this.ownerKey(owner)
      if (input.label !== ownerKey || !sameOwner(input.summary.scope.owner, owner)) throw new SandboxPermissionDeniedError('scope_mismatch')
      if (state.resources.some(entry => entry.summary.resourceId === input.summary.resourceId)) {
        throw new SandboxConflictError('binding_changed')
      }
      this.assertNormalCapacity(state, 1)
      this.assertActiveCapacity(state)
      const resource: DockerTrackedResource = { ...input, ownerKey }
      state.resources.push(resourceToDurable(resource))
      return resource
    })
  }

  public async resource(resourceId: string): Promise<DockerTrackedResource | undefined> {
    const record = (await this.read()).resources.find(entry => entry.summary.resourceId === resourceId)
    return record === undefined ? undefined : resourceFromDurable(record)
  }

  public async assertResource(resourceId: string, scope: SandboxScope): Promise<DockerTrackedResource> {
    const resource = await this.resource(resourceId)
    if (!resource || !sameScope(resource.summary.scope, scope)) throw stateLost()
    return resource
  }

  public async markActive(resourceId: string): Promise<void> { await this.updateState(resourceId, 'active') }
  public async markCleanupPending(resourceId: string): Promise<void> { await this.updateState(resourceId, 'cleanup_pending') }
  public async markDeleted(resourceId: string): Promise<void> { await this.updateState(resourceId, 'deleted') }

  /** Serializes one catalog resource across adapter instances while its engine effects run. */
  public async withCleanupLock<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
    return await this.records.withResourceLock(resourceId, operation)
  }

  /** Claims one resource cleanup and records durable progress before engine effects begin. */
  public async claimCleanup(resourceId: string): Promise<DockerCleanupClaim> {
    return await this.mutate(async state => {
      const resource = state.resources.find(entry => entry.summary.resourceId === resourceId)
      if (!resource) throw stateLost()
      if (resource.summary.state === 'deleted') return { state: 'deleted' }
      if (resource.summary.state === 'provisioning') {
        resource.summary = { ...resource.summary, state: 'cleanup_pending', updatedAt: new Date().toISOString() }
        return { state: 'provisioning' }
      }
      if (resource.summary.state !== 'cleanup_pending') {
        resource.summary = { ...resource.summary, state: 'cleanup_pending', updatedAt: new Date().toISOString() }
      }
      const cleanup = {
        claimId: randomUUID(),
        stopped: resource.cleanup?.stopped ?? false,
        containerRemoved: resource.cleanup?.containerRemoved ?? false,
        volumeRemoved: resource.cleanup?.volumeRemoved ?? false,
      }
      resource.cleanup = cleanup
      return { state: 'claimed', resource: resourceFromDurable(resource), claimId: cleanup.claimId,
        stopped: cleanup.stopped, containerRemoved: cleanup.containerRemoved, volumeRemoved: cleanup.volumeRemoved }
    })
  }

  /** Confirms one completed engine effect while retaining the claim for remaining effects. */
  public async confirmCleanupStep(resourceId: string, claimId: string, step: 'stopped' | 'containerRemoved' | 'volumeRemoved'): Promise<void> {
    await this.mutate(async state => {
      const resource = state.resources.find(entry => entry.summary.resourceId === resourceId)
      if (!resource?.cleanup || resource.cleanup.claimId !== claimId) throw new SandboxConflictError('binding_changed')
      resource.cleanup[step] = true
    })
  }

  /** Releases an uncompleted claim so a later bounded sweep or purge can retry it. */
  public async releaseCleanupClaim(resourceId: string, claimId: string): Promise<void> {
    await this.mutate(async state => {
      const resource = state.resources.find(entry => entry.summary.resourceId === resourceId)
      if (!resource || resource.summary.state === 'deleted' || resource.cleanup?.claimId !== claimId) return
      resource.cleanup = { ...resource.cleanup, claimId: undefined }
    })
  }

  /** Completes cleanup only after all provider effects were durably confirmed by its claim. */
  public async completeCleanup(resourceId: string, claimId: string): Promise<void> {
    await this.mutate(async state => {
      const resource = state.resources.find(entry => entry.summary.resourceId === resourceId)
      if (!resource?.cleanup || resource.cleanup.claimId !== claimId
        || !resource.cleanup.stopped || !resource.cleanup.containerRemoved || !resource.cleanup.volumeRemoved) {
        throw new SandboxConflictError('binding_changed')
      }
      resource.summary = { ...resource.summary, state: 'deleted', updatedAt: new Date().toISOString() }
      resource.cleanup = undefined
    })
  }

  public async revoke(selector: SandboxSelector): Promise<void> {
    await this.mutate(async state => { this.revokeInState(state, selector) })
  }

  public async beginPurge(selector: SandboxSelector, idempotencyKey: string): Promise<DockerPurgeProgress> {
    return await this.mutate(async state => {
      const existing = state.purges.find(entry => entry.idempotencyKey === idempotencyKey)
      const selectorKey = this.selectorKey(selector)
      if (existing) {
        if (existing.selectorKey !== selectorKey) throw new SandboxConflictError('idempotency_conflict')
        return purgeFromDurable(existing)
      }
      const reservedOwnerKey = this.reservedOwnerKey(state, selector)
      const hasRevocation = state.revocations.some(entry => entry.key === selectorKey)
      const requiredSlots = (hasRevocation || reservedOwnerKey !== undefined ? 0 : 1) + (reservedOwnerKey === undefined ? 1 : 0)
      this.assertAbsoluteCapacity(state, requiredSlots)
      this.revokeInState(state, selector)
      const progress: DurablePurge = { selector: selectorToDurable(selector), selectorKey, idempotencyKey, ...(reservedOwnerKey === undefined ? {} : { reservedOwnerKey }), deletedResources: 0 }
      state.purges.push(progress)
      return purgeFromDurable(progress)
    })
  }

  public async incrementDeleted(idempotencyKey: string): Promise<void> {
    await this.mutate(async state => {
      const progress = state.purges.find(entry => entry.idempotencyKey === idempotencyKey)
      if (!progress) throw stateLost()
      progress.deletedResources += 1
    })
  }

  public async purgeProgress(idempotencyKey: string): Promise<DockerPurgeProgress> {
    const progress = (await this.read()).purges.find(entry => entry.idempotencyKey === idempotencyKey)
    if (!progress) throw stateLost()
    return purgeFromDurable(progress)
  }

  public async resourcesFor(selector: SandboxSelector): Promise<DockerTrackedResource[]> {
    return (await this.read()).resources.filter(resource => matchesSelector(ownerFromDurable(resource.summary.owner), selector)).map(resourceFromDurable)
  }

  public async pendingResources(): Promise<DockerTrackedResource[]> {
    return (await this.read()).resources.filter(resource => resource.summary.state === 'cleanup_pending').map(resourceFromDurable)
  }

  public async remainingResources(selector: SandboxSelector): Promise<number> {
    return (await this.resourcesFor(selector)).filter(resource => resource.summary.state !== 'deleted').length
  }

  public selectorDigest(selector: SandboxSelector): string { return this.selectorKey(selector) }

  private async updateState(resourceId: string, state: DockerResourceState): Promise<void> {
    await this.mutate(async journal => {
      const resource = journal.resources.find(entry => entry.summary.resourceId === resourceId)
      if (!resource) throw stateLost()
      if (!canTransition(resource.summary.state, state)) throw new SandboxConflictError('binding_changed')
      resource.summary = { ...resource.summary, state, updatedAt: new Date().toISOString() }
    })
  }

  private async mutate<T>(operation: (state: DurableJournal) => Promise<T>): Promise<T> {
    return await this.records.withJournalLock(async () => {
      const state = this.parseRequired(await this.records.readJournal())
      const result = await operation(state)
      this.validate(state)
      await this.records.writeJournal(state)
      return result
    })
  }

  private async read(): Promise<DurableJournal> { return this.parseRequired(await this.records.readJournal()) }
  private parseRequired(value: unknown | undefined): DurableJournal { if (value === undefined) throw stateLost(); return this.parse(value) }
  private parse(value: unknown): DurableJournal {
    const parsed = journalSchema.safeParse(value)
    if (!parsed.success) throw invalidJournal()
    this.validate(parsed.data)
    return parsed.data
  }

  private validate(state: DurableJournal): void {
    const ownerKeys = new Set<string>()
    for (const owner of state.owners) {
      if (owner.key !== this.ownerKey(ownerFromDurable(owner.owner)) || ownerKeys.has(owner.key)) throw invalidJournal()
      ownerKeys.add(owner.key)
    }
    const resourceIds = new Set<string>()
    for (const resource of state.resources) {
      if (resourceIds.has(resource.summary.resourceId) || resource.ownerKey !== this.ownerKey(ownerFromDurable(resource.summary.owner))
        || resource.label !== resource.ownerKey || !ownerKeys.has(resource.ownerKey)
        || !sameOwner(ownerFromDurable(resource.summary.scope.owner), ownerFromDurable(resource.summary.owner))) throw invalidJournal()
      resourceIds.add(resource.summary.resourceId)
    }
    const revocationKeys = new Set<string>()
    for (const revocation of state.revocations) {
      if (revocation.key !== this.selectorKey(selectorFromDurable(revocation.selector)) || revocationKeys.has(revocation.key)
        || (revocation.reservedOwnerKey !== undefined && !ownerKeys.has(revocation.reservedOwnerKey))) throw invalidJournal()
      revocationKeys.add(revocation.key)
    }
    const purgeKeys = new Set<string>()
    for (const purge of state.purges) {
      if (purge.selectorKey !== this.selectorKey(selectorFromDurable(purge.selector)) || purgeKeys.has(purge.idempotencyKey)
        || !revocationKeys.has(purge.selectorKey)
        || (purge.reservedOwnerKey !== undefined && !ownerKeys.has(purge.reservedOwnerKey))) throw invalidJournal()
      purgeKeys.add(purge.idempotencyKey)
    }
    if (this.occupiedSlots(state) > this.options.maxCatalogEntries) throw invalidJournal()
  }

  private registerInState(state: DurableJournal, owner: SandboxOwner, mode: 'create' | 'attach'): void {
    const key = this.ownerKey(owner)
    const current = state.owners.find(entry => entry.key === key)
    if (current?.state === 'revoked' || this.isOwnerRevoked(state, owner)) throw new SandboxPermissionDeniedError('owner_revoked')
    if (current) return
    if (mode === 'attach') throw stateLost()
    this.assertNormalCapacity(state, 3)
    state.owners.push({ key, owner: ownerToDurable(owner), state: 'active' })
  }

  private assertOwnerAttached(state: DurableJournal, owner: SandboxOwner): void {
    const record = state.owners.find(entry => entry.key === this.ownerKey(owner))
    if (!record) throw stateLost()
    if (record.state === 'revoked' || this.isOwnerRevoked(state, owner)) throw new SandboxPermissionDeniedError('owner_revoked')
  }

  private revokeInState(state: DurableJournal, selector: SandboxSelector): void {
    const key = this.selectorKey(selector)
    if (!state.revocations.some(entry => entry.key === key)) {
      const reservedOwnerKey = this.reservedOwnerKey(state, selector)
      if (reservedOwnerKey === undefined) this.assertAbsoluteCapacity(state, 1)
      state.revocations.push({ key, selector: selectorToDurable(selector), ...(reservedOwnerKey === undefined ? {} : { reservedOwnerKey }) })
    }
    for (const owner of state.owners) if (matchesSelector(ownerFromDurable(owner.owner), selector)) owner.state = 'revoked'
  }

  private isOwnerRevoked(state: DurableJournal, owner: SandboxOwner): boolean {
    return state.revocations.some(record => matchesSelector(owner, selectorFromDurable(record.selector)))
  }

  private isActorRevoked(state: DurableJournal, namespace: string, actor: HarnessIdentity): boolean {
    return state.revocations.some(({ selector }) => selector.kind === 'principal'
      && selector.namespace === namespace && selector.principalId === actor.principalId && selector.tenantId === actor.tenantId
      && (selector.tenantId === undefined) === (actor.tenantId === undefined))
  }

  private assertActiveCapacity(state: DurableJournal): void {
    const active = state.resources.filter(resource => resource.summary.state !== 'deleted').length
    if (active >= this.options.maxActiveSandboxes) throw new SandboxQuotaExceededError({ quota: 'active_sandboxes', limit: this.options.maxActiveSandboxes, actual: active })
  }

  private assertNormalCapacity(state: DurableJournal, required: number): void {
    const limit = this.options.maxCatalogEntries - this.options.selectorRevocationReserve
    if (this.occupiedSlots(state) + required > limit) throw new SandboxQuotaExceededError({ quota: 'catalog_entries', limit, actual: this.occupiedSlots(state) })
  }

  private assertAbsoluteCapacity(state: DurableJournal, required: number): void {
    if (this.occupiedSlots(state) + required > this.options.maxCatalogEntries) {
      throw new SandboxQuotaExceededError({ quota: 'catalog_entries', limit: this.options.maxCatalogEntries, actual: this.occupiedSlots(state) })
    }
  }

  private occupiedSlots(state: DurableJournal): number {
    return state.owners.length * 3 + state.resources.length
      + state.revocations.filter(record => record.reservedOwnerKey === undefined).length
      + state.purges.filter(progress => progress.reservedOwnerKey === undefined).length
  }

  private reservedOwnerKey(state: DurableJournal, selector: SandboxSelector): string | undefined {
    if (selector.kind !== 'owner') return undefined
    const key = this.ownerKey(selector.owner)
    return state.owners.some(owner => owner.key === key) ? key : undefined
  }

  private ownerKey(owner: SandboxOwner): string {
    return digest([owner.namespace, owner.id, owner.instanceId, owner.identity !== undefined, owner.identity?.tenantId ?? null, owner.identity?.principalId ?? null])
  }

  private selectorKey(selector: SandboxSelector): string {
    if (selector.kind === 'owner') return digest(['owner', this.ownerKey(selector.owner)])
    if (selector.kind === 'tenant') return digest(['tenant', selector.namespace, selector.tenantId])
    return digest(['principal', selector.namespace, selector.tenantId !== undefined, selector.tenantId ?? null, selector.principalId])
  }
}

function emptyJournal(): DurableJournal { return { version: 1, owners: [], resources: [], revocations: [], purges: [] } }

function ownerToDurable(owner: SandboxOwner): DurableResource['summary']['owner'] {
  const identity = owner.identity
  const base = { namespace: owner.namespace, id: owner.id, instanceId: owner.instanceId }
  if (identity === undefined) return base
  if (identity.tenantId !== undefined && identity.principalId !== undefined) return { ...base, identity: { tenantId: identity.tenantId, principalId: identity.principalId } }
  if (identity.tenantId !== undefined) return { ...base, identity: { tenantId: identity.tenantId } }
  if (identity.principalId !== undefined) return { ...base, identity: { principalId: identity.principalId } }
  return { ...base, identity: {} }
}

function ownerFromDurable(owner: DurableResource['summary']['owner']): SandboxOwner {
  const identity = owner.identity
  if (identity === undefined) return { namespace: owner.namespace, id: owner.id, instanceId: owner.instanceId }
  if ('tenantId' in identity && 'principalId' in identity) return { namespace: owner.namespace, id: owner.id, instanceId: owner.instanceId, identity: { tenantId: identity.tenantId, principalId: identity.principalId } }
  if ('tenantId' in identity) return { namespace: owner.namespace, id: owner.id, instanceId: owner.instanceId, identity: { tenantId: identity.tenantId } }
  if ('principalId' in identity) return { namespace: owner.namespace, id: owner.id, instanceId: owner.instanceId, identity: { principalId: identity.principalId } }
  return { namespace: owner.namespace, id: owner.id, instanceId: owner.instanceId, identity: {} }
}

function scopeToDurable(scope: SandboxScope): DurableResource['summary']['scope'] {
  const partition = scope.partition.kind === 'shared' ? { kind: 'shared' as const }
    : scope.partition.kind === 'group' ? { kind: 'group' as const, id: scope.partition.id }
      : { kind: scope.partition.kind, harnessName: scope.partition.harnessName, id: scope.partition.id }
  return scope.lifetime === 'run'
    ? { owner: ownerToDurable(scope.owner), partition, lifetime: 'run', runId: scope.runId }
    : { owner: ownerToDurable(scope.owner), partition, lifetime: 'session' }
}

function scopeFromDurable(scope: DurableResource['summary']['scope']): SandboxScope {
  const partition = scope.partition.kind === 'shared' ? { kind: 'shared' as const }
    : scope.partition.kind === 'group' ? { kind: 'group' as const, id: scope.partition.id }
      : { kind: scope.partition.kind, harnessName: scope.partition.harnessName, id: scope.partition.id }
  return scope.lifetime === 'run'
    ? { owner: ownerFromDurable(scope.owner), partition, lifetime: 'run', runId: scope.runId }
    : { owner: ownerFromDurable(scope.owner), partition, lifetime: 'session' }
}

function selectorToDurable(selector: SandboxSelector): DurablePurge['selector'] {
  if (selector.kind === 'owner') return { kind: 'owner', owner: ownerToDurable(selector.owner) }
  if (selector.kind === 'tenant') return { kind: 'tenant', namespace: selector.namespace, tenantId: selector.tenantId }
  return selector.tenantId === undefined
    ? { kind: 'principal', namespace: selector.namespace, principalId: selector.principalId }
    : { kind: 'principal', namespace: selector.namespace, tenantId: selector.tenantId, principalId: selector.principalId }
}

function selectorFromDurable(selector: DurablePurge['selector']): SandboxSelector {
  if (selector.kind === 'owner') return { kind: 'owner', owner: ownerFromDurable(selector.owner) }
  if (selector.kind === 'tenant') return { kind: 'tenant', namespace: selector.namespace, tenantId: selector.tenantId }
  return selector.tenantId === undefined
    ? { kind: 'principal', namespace: selector.namespace, principalId: selector.principalId }
    : { kind: 'principal', namespace: selector.namespace, tenantId: selector.tenantId, principalId: selector.principalId }
}

function resourceToDurable(resource: DockerTrackedResource): DurableResource {
  return {
    ownerKey: resource.ownerKey,
    label: resource.label,
    containerName: resource.containerName,
    volumeName: resource.volumeName,
    summary: {
      resourceId: resource.summary.resourceId,
      kind: 'sandbox',
      owner: ownerToDurable(resource.summary.owner),
      scope: scopeToDurable(resource.summary.scope),
      state: resource.summary.state,
      createdAt: resource.summary.createdAt,
      updatedAt: resource.summary.updatedAt,
      pinned: resource.summary.pinned,
    },
  }
}
function resourceFromDurable(resource: DurableResource): DockerTrackedResource {
  return { ownerKey: resource.ownerKey, label: resource.label, containerName: resource.containerName, volumeName: resource.volumeName, summary: {
    resourceId: resource.summary.resourceId,
    kind: 'sandbox',
    owner: ownerFromDurable(resource.summary.owner),
    scope: scopeFromDurable(resource.summary.scope),
    state: resource.summary.state,
    createdAt: resource.summary.createdAt,
    updatedAt: resource.summary.updatedAt,
    pinned: resource.summary.pinned,
  } }
}
function purgeFromDurable(progress: DurablePurge): DockerPurgeProgress {
  return { selector: selectorFromDurable(progress.selector), idempotencyKey: progress.idempotencyKey, selectorKey: progress.selectorKey,
    ...(progress.reservedOwnerKey === undefined ? {} : { reservedOwnerKey: progress.reservedOwnerKey }), deletedResources: progress.deletedResources }
}
function canTransition(from: DockerResourceState, to: DockerResourceState): boolean {
  if (from === 'provisioning') return to === 'active' || to === 'paused' || to === 'terminal' || to === 'cleanup_pending'
  if (from === 'active' || from === 'paused' || from === 'terminal' || from === 'state_lost') return to === 'cleanup_pending'
  if (from === 'cleanup_pending') return to === 'cleanup_pending' || to === 'deleted'
  return false
}
function resolveOptions(input: SandboxAdministrationOptions): ResolvedCatalogOptions {
  const maxCatalogEntries = input.maxCatalogEntries ?? DEFAULT_MAX_CATALOG_ENTRIES
  const selectorRevocationReserve = input.selectorRevocationReserve ?? DEFAULT_SELECTOR_REVOCATION_RESERVE
  const maxActiveSandboxes = input.maxActiveSandboxes ?? DEFAULT_MAX_ACTIVE_SANDBOXES
  if (![maxCatalogEntries, selectorRevocationReserve, maxActiveSandboxes].every(value => Number.isSafeInteger(value) && value > 0)
    || selectorRevocationReserve + 2 >= maxCatalogEntries) throw new HarnessConfigError('Docker sandbox administration configuration is invalid.', { reason: 'invalid_administration_configuration' })
  return { maxCatalogEntries, selectorRevocationReserve, maxActiveSandboxes }
}
function matchesSelector(owner: SandboxOwner, selector: SandboxSelector): boolean {
  if (selector.kind === 'owner') return sameOwner(owner, selector.owner)
  if (selector.kind === 'tenant') return owner.namespace === selector.namespace && owner.identity?.tenantId === selector.tenantId
  return owner.namespace === selector.namespace && owner.identity?.principalId === selector.principalId
    && owner.identity?.tenantId === selector.tenantId && (owner.identity?.tenantId === undefined) === (selector.tenantId === undefined)
}
function sameOwner(left: SandboxOwner, right: SandboxOwner): boolean {
  return left.namespace === right.namespace && left.id === right.id && left.instanceId === right.instanceId
    && left.identity?.tenantId === right.identity?.tenantId && left.identity?.principalId === right.identity?.principalId
    && (left.identity === undefined) === (right.identity === undefined)
}
function sameScope(left: SandboxScope, right: SandboxScope): boolean {
  if (!sameOwner(left.owner, right.owner) || left.lifetime !== right.lifetime) return false
  if (left.lifetime === 'run' && (right.lifetime !== 'run' || left.runId !== right.runId)) return false
  if (left.partition.kind !== right.partition.kind) return false
  if (left.partition.kind === 'shared') return true
  if (left.partition.kind === 'group') return right.partition.kind === 'group' && left.partition.id === right.partition.id
  return (right.partition.kind === 'agent' || right.partition.kind === 'workflow')
    && left.partition.harnessName === right.partition.harnessName && left.partition.id === right.partition.id
}
function digest(value: readonly (string | boolean | null)[]): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function stateLost(): SandboxStateLostError {
  return new SandboxStateLostError('Docker sandbox ownership metadata is missing; no resource was adopted.', { reason: 'owner_missing', lifetime: 'session', adapter_id: 'docker' })
}
function invalidJournal(): SandboxStateLostError {
  return new SandboxStateLostError('Docker sandbox ownership metadata is invalid; no resource was adopted.', { reason: 'lifecycle_state_missing', lifetime: 'session', adapter_id: 'docker' })
}
