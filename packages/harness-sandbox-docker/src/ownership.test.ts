import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  HarnessConfigError,
  SandboxConflictError,
  SandboxPermissionDeniedError,
  SandboxQuotaExceededError,
  SandboxStateLostError,
  type SandboxAdministrationOptions,
  type SandboxOwner,
} from '@purista/harness'
import { resolveOptions } from './options.js'
import { DockerOwnershipJournal } from './ownership.js'
import { Records } from './records.js'

const roots: string[] = []
const owner = {
  namespace: 'acme', id: 'shared-workspace', instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7J', identity: { tenantId: 'tenant-a' },
} satisfies SandboxOwner
const otherOwner = {
  ...owner, id: 'private-workspace', instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7K', identity: { tenantId: 'tenant-a', principalId: 'principal-b' },
} satisfies SandboxOwner
const unrelatedOwner = {
  ...owner, id: 'unrelated-workspace', instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7M', identity: { tenantId: 'tenant-b' },
} satisfies SandboxOwner

async function journal(options: SandboxAdministrationOptions = {}): Promise<{ root: string; records: Records; journal: DockerOwnershipJournal }> {
  const root = await mkdtemp(join(tmpdir(), 'purista-docker-journal-'))
  roots.push(root)
  const records = new Records(root)
  return { root, records, journal: new DockerOwnershipJournal(records, options) }
}

function resource(resourceId: string, chosenOwner: SandboxOwner, label: string, containerName: string, volumeName: string) {
  return {
    summary: {
      resourceId, kind: 'sandbox' as const, owner: chosenOwner,
      scope: { owner: chosenOwner, partition: { kind: 'shared' as const }, lifetime: 'session' as const },
      state: 'provisioning' as const, createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z', pinned: false,
    },
    label, containerName, volumeName,
  }
}

describe('DockerOwnershipJournal', () => {
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

  it('rejects an unsupported hard Docker volume quota at the existing closed factory boundary', () => {
    expect(() => resolveOptions({
      root: '/private/docker-catalog', image: `sha256:${'a'.repeat(64)}`,
      resources: { // @ts-expect-error Runtime callers can still supply undeclared fields.
        volumeMb: 64 },
    })).toThrow(HarnessConfigError)
  })

  it('never adopts an unknown owner or a resource label that does not match its exact owner incarnation', async () => {
    const { journal: catalog } = await journal()
    const label = catalog.labelFor(owner)
    await expect(catalog.trackResource(resource('sandbox-1', owner, label, 'container-1', 'volume-1'))).rejects.toBeInstanceOf(SandboxStateLostError)

    await catalog.registerOwner({ owner, mode: 'create' })
    await expect(catalog.trackResource(resource('sandbox-1', owner, catalog.labelFor(otherOwner), 'container-1', 'volume-1'))).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
    await expect(catalog.trackResource(resource('sandbox-1', owner, label, 'container-1', 'volume-1'))).resolves.toMatchObject({ summary: { resourceId: 'sandbox-1' } })
  })

  it('persists resource inventory and exact selector revocation across a new adapter instance', async () => {
    const { root, journal: first } = await journal()
    await first.registerOwner({ owner, mode: 'create' })
    await first.trackResource(resource('sandbox-1', owner, first.labelFor(owner), 'private-container', 'private-volume'))
    await first.markActive('sandbox-1')
    await first.revoke({ kind: 'tenant', namespace: 'acme', tenantId: 'tenant-a' })

    const resumed = new DockerOwnershipJournal(new Records(root))
    await expect(resumed.resourcesFor({ kind: 'owner', owner })).resolves.toMatchObject([{ summary: { resourceId: 'sandbox-1', state: 'active' } }])
    await expect(resumed.assertAttachment(owner)).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
    await expect(resumed.registerOwner({ owner: otherOwner, mode: 'create' })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
  })

  it('keeps selector tombstones and principal attachment barriers exact', async () => {
    const { journal: catalog } = await journal()
    await catalog.registerOwner({ owner, mode: 'create' })
    await catalog.registerOwner({ owner: otherOwner, mode: 'create' })
    await catalog.revoke({ kind: 'principal', namespace: 'acme', tenantId: 'tenant-a', principalId: 'principal-a' })

    await expect(catalog.assertAttachment(owner, { tenantId: 'tenant-a', principalId: 'principal-a' })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
    await expect(catalog.assertAttachment(owner, { tenantId: 'tenant-a', principalId: 'principal-b' })).resolves.toBeUndefined()
    await expect(catalog.assertAttachment(otherOwner, { tenantId: 'tenant-a', principalId: 'principal-b' })).resolves.toBeUndefined()
  })

  it('reserves catalog capacity for selector revocation instead of discarding owners or tombstones', async () => {
    const { journal: catalog } = await journal({ maxCatalogEntries: 5, selectorRevocationReserve: 1, maxActiveSandboxes: 4 })
    await catalog.registerOwner({ owner, mode: 'create' })
    await expect(catalog.registerOwner({ owner: otherOwner, mode: 'create' })).rejects.toBeInstanceOf(SandboxQuotaExceededError)
    await expect(catalog.revoke({ kind: 'tenant', namespace: 'acme', tenantId: 'tenant-a' })).resolves.toBeUndefined()
    await expect(catalog.registerOwner({ owner, mode: 'attach' })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
  })

  it('keeps an admitted owner purgeable at normal resource capacity and does not allocate a denied unknown owner', async () => {
    const { journal: fullCatalog } = await journal({ maxCatalogEntries: 5, selectorRevocationReserve: 1, maxActiveSandboxes: 4 })
    await fullCatalog.registerOwner({ owner, mode: 'create' })
    await fullCatalog.trackResource(resource('sandbox-1', owner, fullCatalog.labelFor(owner), 'container-1', 'volume-1'))
    await expect(fullCatalog.beginPurge({ kind: 'owner', owner }, 'owner-purge')).resolves.toBeDefined()

    const { journal: catalog } = await journal({ maxCatalogEntries: 10, selectorRevocationReserve: 1, maxActiveSandboxes: 4 })
    await catalog.registerOwner({ owner, mode: 'create' })
    const blockedOwner = { ...owner, id: 'blocked-workspace', instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7N' }
    await catalog.revoke({ kind: 'tenant', namespace: 'acme', tenantId: 'tenant-a' })
    await expect(catalog.registerOwner({ owner: blockedOwner, mode: 'create' })).rejects.toBeInstanceOf(SandboxPermissionDeniedError)
    await expect(catalog.registerOwner({ owner: unrelatedOwner, mode: 'create' })).resolves.toBeUndefined()
  })

  it('fails closed for malformed or missing private journal metadata without a replacement journal', async () => {
    const { records, journal: catalog } = await journal()
    await catalog.registerOwner({ owner, mode: 'create' })
    await records.writeJournal({ version: 0 })
    await expect(catalog.assertAttachment(owner)).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(catalog.registerOwner({ owner: otherOwner, mode: 'create' })).rejects.toBeInstanceOf(SandboxStateLostError)
  })

  it('fails closed for skipped or final resource lifecycle transitions', async () => {
    const { journal: catalog } = await journal()
    await catalog.registerOwner({ owner, mode: 'create' })
    await catalog.trackResource(resource('sandbox-1', owner, catalog.labelFor(owner), 'container-1', 'volume-1'))
    await expect(catalog.markDeleted('sandbox-1')).rejects.toBeInstanceOf(SandboxConflictError)
    await catalog.markActive('sandbox-1')
    await catalog.markCleanupPending('sandbox-1')
    await catalog.markDeleted('sandbox-1')
    await expect(catalog.markActive('sandbox-1')).rejects.toBeInstanceOf(SandboxConflictError)
  })
})
