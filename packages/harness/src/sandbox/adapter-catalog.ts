import { createHash } from 'node:crypto'

import { SandboxPermissionDeniedError, SandboxStateLostError } from '../errors/index.js'
import type { HarnessIdentity } from '../identity/index.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { SandboxAdministration, SandboxResourceSummary } from './administration.js'
import { PrivateSandboxCatalog, type PrivateCatalogStorage } from './catalog.js'
import { sandboxScopeKey, validateSandboxOpenOptions, validateSandboxTerminateOptions } from './lifecycle.js'
import { withSandboxTelemetry } from './telemetry.js'
import type { SandboxOpenOptions, SandboxOpenResult, SandboxSessionBase, SandboxTerminateOptions } from './index.js'
import type { SandboxOwnerRegistrationOptions, SandboxScope } from './ownership.js'

/** In-process storage for bounded non-durable adapter catalogs. */
export class InMemoryPrivateCatalogStorage implements PrivateCatalogStorage {
  private value: string | undefined
  private tail: Promise<void> = Promise.resolve()

  public async read(): Promise<string | undefined> { return this.value }
  public async write(value: string): Promise<void> { this.value = value }
  public async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous.catch(() => undefined)
    try { return await operation() } finally { release() }
  }
}

/** Private catalog admission shared by the built-in and fake sandbox adapters. */
export class SandboxAdapterCatalog {
  private context: HarnessAdapterContext | undefined
  private adapterId = 'sandbox_adapter'
  public readonly administration: SandboxAdministration

  public constructor(private readonly catalog: PrivateSandboxCatalog) {
    this.administration = {
      list: async (options) => await this.instrument('list', async () => await this.catalog.list(options)),
      purge: async (options) => await this.instrument('purge', async () => await this.catalog.purge(options)),
      sweep: async (options) => await this.instrument('sweep', async () => await this.catalog.sweep(options)),
      deleteSnapshot: async (options) => await this.instrument('delete_snapshot', async () => await this.catalog.deleteSnapshot(options))
    }
  }

  /** Creates the bounded, process-local catalog used by built-in and fake adapters. */
  public static inMemory(onDelete: (resource: SandboxResourceSummary, signal?: AbortSignal) => Promise<void>): SandboxAdapterCatalog {
    return new SandboxAdapterCatalog(new PrivateSandboxCatalog(new InMemoryPrivateCatalogStorage(), { callbacks: { deleteResource: onDelete } }))
  }

  public async registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void> {
    await this.instrument('register_owner', async () => await this.catalog.registerOwner(options))
  }

  /** Receives the Harness telemetry context from the concrete adapter. */
  public configureHarnessContext(context: HarnessAdapterContext, adapterId: string): void {
    this.context = context
    this.adapterId = adapterId
  }

  public async open<C extends readonly AdapterCapability[], S extends SandboxSessionBase>(
    options: SandboxOpenOptions,
    allocate: () => Promise<CatalogSandboxOpenResult<C, S>>,
  ): Promise<CatalogSandboxOpenResult<C, S>> {
    validateSandboxOpenOptions(options)
    assertActor(options.scope, options.identity)
    await this.catalog.assertActorActive(options.scope.owner, options.identity)
    await this.catalog.registerOwner({ owner: options.scope.owner, mode: 'attach', ...(options.signal ? { signal: options.signal } : {}) })
    const existing = await this.find(options.scope)
    if (options.mode === 'attach') {
      if (!existing || existing.state !== 'active') throw stateLost(options.scope)
      return await this.withActorFence(options, await allocate())
    }
    if (options.mode === 'restore') return await this.withActorFence(options, await allocate())
    // Another caller may have committed provisioning intent and still be
    // allocating. The concrete lifecycle decides whether that intent can be
    // attached/reconciled; it must fail closed if its own durable state is gone.
    if (existing && existing.state !== 'active' && existing.state !== 'provisioning') throw stateLost(options.scope)
    if (!existing) {
      const resourceId = resourceIdFor(options.scope)
      await this.catalog.provision({ resourceId, kind: 'sandbox', owner: options.scope.owner, scope: options.scope, pinned: false, idempotencyKey: resourceId })
      try {
        const opened = await allocate()
        await this.catalog.activate(resourceId)
        return this.withActorFence(options, opened)
      } catch (error) {
        await this.catalog.terminalize(options.scope)
        throw error
      }
    }
    return await this.withActorFence(options, await allocate())
  }

  public async terminate(options: SandboxTerminateOptions, terminate: () => Promise<void>): Promise<void> {
    validateSandboxTerminateOptions(options)
    await terminate()
    await this.catalog.terminalize(options.scope)
  }

  private async find(scope: SandboxScope): Promise<SandboxResourceSummary | undefined> {
    const page = await this.catalog.list({ selector: { kind: 'owner', owner: scope.owner }, kind: 'sandbox', limit: 1_000 })
    return page.items.find((item) => item.scope !== undefined && sandboxScopeKey(item.scope) === sandboxScopeKey(scope))
  }

  private async instrument<T>(operation: Parameters<typeof withSandboxTelemetry>[2], action: () => Promise<T>): Promise<T> {
    return await withSandboxTelemetry(this.context?.telemetry, this.adapterId, operation, action)
  }

  private withActorFence<C extends readonly AdapterCapability[], S extends SandboxSessionBase>(
    options: SandboxOpenOptions,
    opened: CatalogSandboxOpenResult<C, S>
  ): CatalogSandboxOpenResult<C, S> {
    return {
      ...opened,
      assertActive: async () => {
        opened.assertActive()
        await this.catalog.assertAttachmentActive(options.scope, options.identity)
      }
    }
  }
}

/** Adapter-internal lifecycle result before the port supplies process preservation semantics. */
export type CatalogSandboxOpenResult<C extends readonly AdapterCapability[], S extends SandboxSessionBase> = {
  readonly session: S
  readonly disposition: SandboxOpenResult<C>['disposition']
  readonly assertActive: () => void | Promise<void>
}

function resourceIdFor(scope: SandboxScope): string {
  return `sandbox_${createHash('sha256').update(sandboxScopeKey(scope)).digest('hex')}`
}

function assertActor(scope: SandboxScope, actor: HarnessIdentity | undefined): void {
  const owner = scope.owner.identity
  if (!owner) {
    if (actor?.tenantId !== undefined || actor?.principalId !== undefined) throw new SandboxPermissionDeniedError('scope_mismatch')
    return
  }
  if (owner.tenantId !== actor?.tenantId) throw new SandboxPermissionDeniedError('scope_mismatch')
  if (owner.principalId !== undefined && owner.principalId !== actor?.principalId) throw new SandboxPermissionDeniedError('scope_mismatch')
}

function stateLost(scope: SandboxScope): SandboxStateLostError {
  return new SandboxStateLostError('Sandbox owner or partition state is unavailable.', { reason: 'owner_missing', lifetime: scope.lifetime })
}
