import { describe, expect, it } from 'vitest'

import type { SessionRecord } from '../models/state.js'
import {
  acknowledgeSandboxOwnerRegistration,
  createSessionSandboxBinding,
  sandboxScopeForBinding
} from './sandboxBindings.js'

const record: SessionRecord = {
  id: 'session-1',
  instanceId: '01J00000000000000000000001',
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
  runCount: 0,
  identity: { tenantId: 'tenant-1', principalId: 'principal-1' }
}

describe('session sandbox bindings', () => {
  it('derives an immutable pending implicit owner without allocating a partition', () => {
    const binding = createSessionSandboxBinding({ harnessName: 'support', record })

    expect(binding).toMatchObject({
      owner: {
        namespace: 'support',
        id: 'session-1',
        instanceId: '01J00000000000000000000001',
        identity: { tenantId: 'tenant-1', principalId: 'principal-1' }
      },
      relation: 'owned',
      registration: 'pending',
      disposed: false
    })
    expect(binding.policyDigest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps explicit owners borrowed and registration-complete', () => {
    const owner = {
      namespace: 'customer',
      id: 'conversation-1',
      instanceId: '01J00000000000000000000002',
      identity: { tenantId: 'tenant-1' }
    } as const

    const binding = createSessionSandboxBinding({ harnessName: 'support', record, sandboxOwner: owner })

    expect(binding).toMatchObject({ owner, relation: 'borrowed', registration: 'registered', disposed: false })
    expect(acknowledgeSandboxOwnerRegistration(binding)).toEqual(binding)
  })

  it('acknowledges only the pending registration while preserving the owner tuple', () => {
    const pending = createSessionSandboxBinding({ harnessName: 'support', record })
    const registered = acknowledgeSandboxOwnerRegistration(pending)

    expect(registered).toEqual({ ...pending, registration: 'registered' })
    expect(registered.owner).toEqual(pending.owner)
    expect(registered.policyDigest).toBe(pending.policyDigest)
  })

  it('constructs owner-scoped session and run keys without session topology fields', () => {
    const binding = acknowledgeSandboxOwnerRegistration(createSessionSandboxBinding({ harnessName: 'support', record }))

    expect(sandboxScopeForBinding(binding, { kind: 'shared' }, 'session')).toEqual({
      owner: binding.owner,
      partition: { kind: 'shared' },
      lifetime: 'session'
    })
    expect(sandboxScopeForBinding(binding, { kind: 'agent', harnessName: 'support', id: 'triage' }, 'run', 'run-1')).toEqual({
      owner: binding.owner,
      partition: { kind: 'agent', harnessName: 'support', id: 'triage' },
      lifetime: 'run',
      runId: 'run-1'
    })
  })
})
