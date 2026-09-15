import { describe, expect, it } from 'vitest'

import {
  sandboxAdministrationOptionsSchema,
  sandboxListOptionsSchema,
  sandboxPurgeResultSchema,
  sandboxResourceSummarySchema,
  sandboxSelectorSchema,
  sandboxSnapshotPolicySchema,
  workspaceAdministrationOptionsSchema
} from './administration.js'

const owner = {
  namespace: 'acme',
  id: 'customer-42',
  instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7J'
} as const

describe('sandbox administration contracts', () => {
  it('accepts only exact owner, tenant, and principal selectors', () => {
    expect(sandboxSelectorSchema.parse({ kind: 'owner', owner })).toEqual({ kind: 'owner', owner })
    expect(sandboxSelectorSchema.parse({ kind: 'tenant', namespace: 'acme', tenantId: 'tenant-1' })).toEqual({ kind: 'tenant', namespace: 'acme', tenantId: 'tenant-1' })
    expect(sandboxSelectorSchema.parse({ kind: 'principal', namespace: 'acme', principalId: 'principal-1' })).toEqual({ kind: 'principal', namespace: 'acme', principalId: 'principal-1' })
    expect(() => sandboxSelectorSchema.parse({ kind: 'all', namespace: 'acme' })).toThrow()
    expect(() => sandboxSelectorSchema.parse({ kind: 'principal', namespace: 'acme', principalId: 'principal-1', extra: true })).toThrow()
  })

  it('enforces bounded pagination and does not accept arbitrary cursor data', () => {
    expect(sandboxListOptionsSchema.parse({ selector: { kind: 'owner', owner }, limit: 1000 })).toEqual({ selector: { kind: 'owner', owner }, limit: 1000 })
    expect(() => sandboxListOptionsSchema.parse({ selector: { kind: 'owner', owner }, limit: 0 })).toThrow()
    expect(() => sandboxListOptionsSchema.parse({ selector: { kind: 'owner', owner }, limit: 1001 })).toThrow()
    expect(() => sandboxListOptionsSchema.parse({ selector: { kind: 'owner', owner }, cursor: 'x'.repeat(4097) })).toThrow()
  })

  it('enforces finite catalog and snapshot option bounds', () => {
    expect(sandboxAdministrationOptionsSchema.parse({ maxCatalogEntries: 10, selectorRevocationReserve: 7, maxActiveSandboxes: 3 })).toEqual({ maxCatalogEntries: 10, selectorRevocationReserve: 7, maxActiveSandboxes: 3 })
    expect(() => sandboxAdministrationOptionsSchema.parse({ maxCatalogEntries: 9, selectorRevocationReserve: 7 })).toThrow()
    expect(() => workspaceAdministrationOptionsSchema.parse({ maxCatalogEntries: 1.5 })).toThrow()
    expect(sandboxSnapshotPolicySchema.parse({ maxSnapshotsPerOwner: 32, maxRetainedSnapshotBytes: 1_073_741_824, maxSnapshotBytes: 268_435_456, unpinnedTtlMs: 604_800_000 })).toEqual({
      maxSnapshotsPerOwner: 32,
      maxRetainedSnapshotBytes: 1_073_741_824,
      maxSnapshotBytes: 268_435_456,
      unpinnedTtlMs: 604_800_000
    })
    expect(() => sandboxSnapshotPolicySchema.parse({ maxSnapshotBytes: 0 })).toThrow()
  })

  it('keeps purge completion accounting truthful', () => {
    expect(sandboxPurgeResultSchema.parse({ state: 'cleanup_pending', deletedResources: 2, remainingResources: 1, retryAfterMs: 500 })).toEqual({
      state: 'cleanup_pending', deletedResources: 2, remainingResources: 1, retryAfterMs: 500
    })
    expect(() => sandboxPurgeResultSchema.parse({ state: 'completed', deletedResources: 2, remainingResources: 0, retryAfterMs: 500 })).toThrow()
    expect(() => sandboxPurgeResultSchema.parse({ state: 'cleanup_pending', deletedResources: 2, remainingResources: 1 })).toThrow()
  })

  it('does not let a summary associate a scope with another owner incarnation', () => {
    const summary = {
      resourceId: 'resource-1',
      kind: 'sandbox',
      owner,
      scope: { owner, partition: { kind: 'shared' }, lifetime: 'session' },
      state: 'active',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      pinned: false
    }
    expect(sandboxResourceSummarySchema.parse(summary)).toEqual(summary)
    expect(() => sandboxResourceSummarySchema.parse({ ...summary, scope: { ...summary.scope, owner: { ...owner, instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7K' } } })).toThrow()
    expect(() => sandboxResourceSummarySchema.parse({ ...summary, kind: 'workspace' })).toThrow()
  })
})
