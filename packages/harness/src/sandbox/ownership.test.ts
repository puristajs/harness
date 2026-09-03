import { describe, expect, it } from 'vitest'

import {
  sandboxBindingOptionsSchema,
  sandboxOwnerSchema,
  sandboxPartitionSchema,
  sandboxScopeSchema,
  sessionOptionsSchema,
  sessionSandboxBindingSchema
} from './ownership.js'

const owner = {
  namespace: 'acme',
  id: 'customer-42',
  instanceId: '01JQ7Z9Q69STZ33MGH6V5ASR7J'
} as const

describe('sandbox ownership contracts', () => {
  it('accepts exact owner incarnations with absent or present identity', () => {
    expect(sandboxOwnerSchema.parse(owner)).toEqual(owner)
    expect(sandboxOwnerSchema.parse({ ...owner, identity: { tenantId: 'tenant-1', principalId: 'principal-1' } })).toEqual({
      ...owner,
      identity: { tenantId: 'tenant-1', principalId: 'principal-1' }
    })
    expect(() => sandboxOwnerSchema.parse({ ...owner, identity: { tenantId: undefined } })).toThrow()
  })

  it('rejects malformed owner keys without normalizing identity or accepting unknown fields', () => {
    expect(() => sandboxOwnerSchema.parse({ ...owner, instanceId: owner.instanceId.toLowerCase() })).toThrow()
    expect(() => sandboxOwnerSchema.parse({ ...owner, instanceId: `Z${owner.instanceId.slice(1)}` })).toThrow()
    expect(() => sandboxOwnerSchema.parse({ ...owner, namespace: 'acme\u0000' })).toThrow()
    expect(() => sandboxOwnerSchema.parse({ ...owner, identity: { tenantId: 'tenant-1', extra: true } })).toThrow()
    expect(() => sandboxOwnerSchema.parse({ ...owner, extra: true })).toThrow()
  })

  it('keeps partitions and lifetime/run-id coupling closed', () => {
    expect(sandboxPartitionSchema.parse({ kind: 'agent', harnessName: 'support', id: 'triage' })).toEqual({ kind: 'agent', harnessName: 'support', id: 'triage' })
    expect(sandboxScopeSchema.parse({ owner, partition: { kind: 'shared' }, lifetime: 'session' })).toEqual({ owner, partition: { kind: 'shared' }, lifetime: 'session' })
    expect(sandboxScopeSchema.parse({ owner, partition: { kind: 'group', id: 'reviewers' }, lifetime: 'run', runId: 'run-1' })).toEqual({ owner, partition: { kind: 'group', id: 'reviewers' }, lifetime: 'run', runId: 'run-1' })
    expect(() => sandboxScopeSchema.parse({ owner, partition: { kind: 'shared' }, lifetime: 'session', runId: 'run-1' })).toThrow()
    expect(() => sandboxScopeSchema.parse({ owner, partition: { kind: 'shared' }, lifetime: 'run' })).toThrow()
  })

  it('validates configured sharing groups and immutable binding fields', () => {
    expect(sandboxBindingOptionsSchema.parse({ groups: ['reviewers'], defaultPolicy: { group: 'reviewers' } })).toEqual({ groups: ['reviewers'], defaultPolicy: { group: 'reviewers' } })
    expect(() => sandboxBindingOptionsSchema.parse({ groups: ['reviewers', 'reviewers'] })).toThrow()
    expect(() => sandboxBindingOptionsSchema.parse({ groups: ['reviewers'], defaultPolicy: { group: 'authors' } })).toThrow()
    expect(sessionSandboxBindingSchema.parse({ owner, relation: 'borrowed', registration: 'registered', policyDigest: 'policy_abc', disposed: false })).toEqual({
      owner,
      relation: 'borrowed',
      registration: 'registered',
      policyDigest: 'policy_abc',
      disposed: false
    })
    expect(() => sessionSandboxBindingSchema.parse({ owner, relation: 'borrowed', registration: 'pending', policyDigest: 'policy_abc', disposed: false })).toThrow()
  })

  it('keeps session options as a strict data-only boundary', () => {
    expect(sessionOptionsSchema.parse({ identity: { tenantId: 'tenant-1' }, sandboxOwner: owner })).toEqual({ identity: { tenantId: 'tenant-1' }, sandboxOwner: owner })
    expect(() => sessionOptionsSchema.parse({ sandboxOwner: owner, legacySandboxId: 'sandbox-1' })).toThrow()
  })
})
