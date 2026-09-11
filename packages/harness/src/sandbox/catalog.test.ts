import { describe, expect, it } from 'vitest'

import { OperationCancelledError, SandboxConflictError, SandboxPermissionDeniedError, SandboxQuotaExceededError } from '../errors/index.js'
import { PrivateSandboxCatalog, type PrivateCatalogStorage } from './catalog.js'

const owner = (id: string, principalId = 'principal-a') => ({
  namespace: 'example',
  id,
  instanceId: '01J00000000000000000000000',
  identity: { tenantId: 'tenant-a', principalId }
} as const)

const scope = (id: string) => ({ owner: owner(id), partition: { kind: 'shared' as const }, lifetime: 'session' as const })

class MemoryStorage implements PrivateCatalogStorage {
  public value: string | undefined

  public async read(): Promise<string | undefined> { return this.value }
  public async write(value: string): Promise<void> { this.value = value }
  public async exclusive<T>(operation: () => Promise<T>): Promise<T> { return await operation() }
}

describe('PrivateSandboxCatalog', () => {
  it('serializes racing registration and absent-owner purge so the barrier wins', async () => {
    const catalog = new PrivateSandboxCatalog(new MemoryStorage())
    await Promise.all([catalog.registerOwner({ owner: owner('race'), mode: 'create' }), catalog.registerOwner({ owner: owner('race'), mode: 'create' })])
    await Promise.all([catalog.purge({ selector: { kind: 'owner', owner: owner('absent') }, idempotencyKey: 'purge-absent' }), catalog.purge({ selector: { kind: 'owner', owner: owner('absent') }, idempotencyKey: 'purge-absent' })])
    await expect(catalog.registerOwner({ owner: owner('absent'), mode: 'create' })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
  })

  it('keeps exact owner and subject indexes while a principal purge barrier spares other actors', async () => {
    const catalog = new PrivateSandboxCatalog(new MemoryStorage())
    await catalog.registerOwner({ owner: owner('one'), mode: 'create' })
    await catalog.registerOwner({ owner: owner('two', 'principal-b'), mode: 'create' })
    await catalog.provision({ resourceId: 'sandbox-one', kind: 'sandbox', owner: owner('one'), scope: scope('one') })
    await catalog.provision({ resourceId: 'sandbox-two', kind: 'sandbox', owner: owner('two', 'principal-b'), scope: { ...scope('two'), owner: owner('two', 'principal-b') } })

    await catalog.purge({ selector: { kind: 'principal', namespace: 'example', tenantId: 'tenant-a', principalId: 'principal-a' }, idempotencyKey: 'offboard-principal-a' })

    await expect(catalog.registerOwner({ owner: owner('one'), mode: 'create' })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
    await expect(catalog.provision({ resourceId: 'sandbox-one-new', kind: 'sandbox', owner: owner('one'), scope: scope('one') })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
    await expect(catalog.list({ selector: { kind: 'owner', owner: owner('two', 'principal-b') } })).resolves.toMatchObject({ items: [{ resourceId: 'sandbox-two' }] })
  })

  it('treats an omitted principal tenant as exact absence, never a tenant wildcard', async () => {
    const catalog = new PrivateSandboxCatalog(new MemoryStorage())
    const withoutTenant = { namespace: 'example', id: 'absent-tenant', instanceId: '01J00000000000000000000001', identity: { principalId: 'principal-a' } } as const
    await catalog.registerOwner({ owner: withoutTenant, mode: 'create' })
    await catalog.registerOwner({ owner: owner('tenant-bound'), mode: 'create' })
    await catalog.purge({ selector: { kind: 'principal', namespace: 'example', principalId: 'principal-a' }, idempotencyKey: 'purge-absent-tenant' })
    await expect(catalog.registerOwner({ owner: withoutTenant, mode: 'create' })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
    await expect(catalog.provision({ resourceId: 'tenant-bound', kind: 'sandbox', owner: owner('tenant-bound'), scope: scope('tenant-bound') })).resolves.toMatchObject({ resourceId: 'tenant-bound' })
  })

  it('binds opaque cursors to the exact selector and kind', async () => {
    const catalog = new PrivateSandboxCatalog(new MemoryStorage())
    await catalog.registerOwner({ owner: owner('one'), mode: 'create' })
    await catalog.provision({ resourceId: 'a', kind: 'sandbox', owner: owner('one'), scope: scope('one') })
    await catalog.provision({ resourceId: 'c', kind: 'sandbox', owner: owner('one'), scope: scope('one') })
    await catalog.provision({ resourceId: 'b', kind: 'snapshot', owner: owner('one'), pinned: false })
    const page = await catalog.list({ selector: { kind: 'owner', owner: owner('one') }, kind: 'sandbox', limit: 1 })

    await expect(catalog.list({ selector: { kind: 'owner', owner: owner('one') }, kind: 'snapshot', cursor: page.nextCursor })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('persists provisioning intent and retryable partial deletion without resurrection', async () => {
    const storage = new MemoryStorage()
    let attempts = 0
    const catalog = new PrivateSandboxCatalog(storage, { callbacks: {
      deleteResource: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary provider failure')
      }
    } })
    await catalog.registerOwner({ owner: owner('one'), mode: 'create' })
    await catalog.provision({ resourceId: 'sandbox-one', kind: 'sandbox', owner: owner('one'), scope: scope('one') })

    await expect(catalog.purge({ selector: { kind: 'owner', owner: owner('one') }, idempotencyKey: 'purge-one', limit: 1 })).resolves.toMatchObject({ state: 'cleanup_pending', remainingResources: 1 })
    const recovered = new PrivateSandboxCatalog(storage, { callbacks: { deleteResource: async () => undefined } })
    await expect(recovered.purge({ selector: { kind: 'owner', owner: owner('one') }, idempotencyKey: 'purge-one', limit: 1 })).resolves.toMatchObject({ state: 'completed', deletedResources: 1, remainingResources: 0 })
    await expect(recovered.provision({ resourceId: 'sandbox-one', kind: 'sandbox', owner: owner('one'), scope: scope('one') })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
  })

  it('commits a purge barrier before cancellation and retains retryable cleanup state', async () => {
    const storage = new MemoryStorage()
    const controller = new AbortController()
    const catalog = new PrivateSandboxCatalog(storage, { callbacks: { deleteResource: async () => { controller.abort() } } })
    await catalog.registerOwner({ owner: owner('cancel'), mode: 'create' })
    await catalog.provision({ resourceId: 'sandbox-cancel', kind: 'sandbox', owner: owner('cancel'), scope: scope('cancel') })
    await expect(catalog.purge({ selector: { kind: 'owner', owner: owner('cancel') }, idempotencyKey: 'purge-cancel', signal: controller.signal })).resolves.toMatchObject({ state: 'cleanup_pending', remainingResources: 1 })
    await expect(new PrivateSandboxCatalog(storage).registerOwner({ owner: owner('cancel'), mode: 'create' })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
  })

  it('claims cleanup work so concurrent same-key purges never duplicate provider deletion', async () => {
    let release: () => void = () => undefined
    const started = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const catalog = new PrivateSandboxCatalog(new MemoryStorage(), { callbacks: { deleteResource: async () => { calls += 1; await started } } })
    await catalog.registerOwner({ owner: owner('concurrent'), mode: 'create' })
    await catalog.provision({ resourceId: 'sandbox-concurrent', kind: 'sandbox', owner: owner('concurrent'), scope: scope('concurrent') })
    const first = catalog.purge({ selector: { kind: 'owner', owner: owner('concurrent') }, idempotencyKey: 'purge-concurrent' })
    await Promise.resolve()
    const second = catalog.purge({ selector: { kind: 'owner', owner: owner('concurrent') }, idempotencyKey: 'purge-concurrent' })
    release()
    await Promise.all([first, second])
    expect(calls).toBe(1)
  })

  it('detects conflicting resource idempotency and reserves catalog capacity for revocation', async () => {
    const catalog = new PrivateSandboxCatalog(new MemoryStorage(), { administration: { maxCatalogEntries: 6, selectorRevocationReserve: 1, maxActiveSandboxes: 1 } })
    await catalog.registerOwner({ owner: owner('one'), mode: 'create' })
    await catalog.provision({ resourceId: 'sandbox-one', kind: 'sandbox', owner: owner('one'), scope: scope('one'), idempotencyKey: 'create-one' })
    await expect(catalog.provision({ resourceId: 'sandbox-one', kind: 'sandbox', owner: owner('one'), scope: scope('one'), idempotencyKey: 'other-key' })).rejects.toBeInstanceOf(SandboxConflictError)
    await expect(catalog.provision({ resourceId: 'sandbox-two', kind: 'sandbox', owner: owner('one'), scope: scope('one') })).rejects.toBeInstanceOf(SandboxQuotaExceededError)
    await expect(catalog.purge({ selector: { kind: 'owner', owner: owner('one') }, idempotencyKey: 'purge-one' })).resolves.toMatchObject({ state: 'completed' })
  })

  it('keeps an admitted owner purgeable at normal catalog capacity', async () => {
    const catalog = new PrivateSandboxCatalog(new MemoryStorage(), { administration: { maxCatalogEntries: 6, selectorRevocationReserve: 1, maxActiveSandboxes: 2 } })
    await catalog.registerOwner({ owner: owner('reserved'), mode: 'create' })
    await catalog.provision({ resourceId: 'sandbox-reserved', kind: 'sandbox', owner: owner('reserved'), scope: scope('reserved') })
    await catalog.provision({ resourceId: 'snapshot-reserved', kind: 'snapshot', owner: owner('reserved') })
    await expect(catalog.purge({ selector: { kind: 'owner', owner: owner('reserved') }, idempotencyKey: 'purge-reserved' })).resolves.toMatchObject({ state: 'completed' })
  })

  it('stops before a cancelled catalog operation mutates inventory', async () => {
    const catalog = new PrivateSandboxCatalog(new MemoryStorage())
    const controller = new AbortController()
    controller.abort()
    await expect(catalog.list({ selector: { kind: 'owner', owner: owner('one') }, signal: controller.signal })).rejects.toBeInstanceOf(OperationCancelledError)
    await expect(catalog.registerOwner({ owner: owner('one'), mode: 'create', signal: controller.signal })).rejects.toBeInstanceOf(OperationCancelledError)
  })

  it('deletes an unpinned snapshot through the private callback and leaves failed cleanup pending', async () => {
    const deleted: string[] = []
    const catalog = new PrivateSandboxCatalog(new MemoryStorage(), { callbacks: { deleteResource: async (resource) => { deleted.push(resource.resourceId) } } })
    await catalog.registerOwner({ owner: owner('snapshot'), mode: 'create' })
    await catalog.provision({ resourceId: 'snapshot-one', kind: 'snapshot', owner: owner('snapshot') })
    await catalog.deleteSnapshot({ owner: owner('snapshot'), snapshotId: 'snapshot-one' })
    expect(deleted).toEqual(['snapshot-one'])
  })

  it('keeps a snapshot cleanup pending after callback failure and retries it', async () => {
    let attempts = 0
    const catalog = new PrivateSandboxCatalog(new MemoryStorage(), { callbacks: { deleteResource: async () => { attempts += 1; if (attempts === 1) throw new Error('temporary') } } })
    await catalog.registerOwner({ owner: owner('snapshot-retry'), mode: 'create' })
    await catalog.provision({ resourceId: 'snapshot-retry', kind: 'snapshot', owner: owner('snapshot-retry') })
    await expect(catalog.deleteSnapshot({ owner: owner('snapshot-retry'), snapshotId: 'snapshot-retry' })).rejects.toMatchObject({ code: 'SANDBOX_ERROR' })
    await expect(catalog.deleteSnapshot({ owner: owner('snapshot-retry'), snapshotId: 'snapshot-retry' })).resolves.toBeUndefined()
    expect(attempts).toBe(2)
  })

  it('stops a sweep after mid-operation cancellation and leaves later cleanup pending', async () => {
    const controller = new AbortController()
    let calls = 0
    const catalog = new PrivateSandboxCatalog(new MemoryStorage(), { callbacks: { deleteResource: async () => { calls += 1; controller.abort() } } })
    await catalog.registerOwner({ owner: owner('sweep'), mode: 'create' })
    await catalog.provision({ resourceId: 'snapshot-sweep-a', kind: 'snapshot', owner: owner('sweep'), expiresAt: '2020-01-01T00:00:00.000Z' })
    await catalog.provision({ resourceId: 'snapshot-sweep-b', kind: 'snapshot', owner: owner('sweep'), expiresAt: '2020-01-01T00:00:00.000Z' })
    await expect(catalog.sweep({ limit: 2, signal: controller.signal })).resolves.toMatchObject({ deletedResources: 0, pendingResources: 1 })
    expect(calls).toBe(1)
  })
})
