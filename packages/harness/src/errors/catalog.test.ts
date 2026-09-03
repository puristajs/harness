import { describe, expect, it } from 'vitest'

import {
  HarnessConfigError,
  SandboxConflictError,
  SandboxPermissionDeniedError,
  SandboxQuotaExceededError,
  SandboxStateLostError
} from './catalog.js'
import { serializeError } from './harness-error.js'

describe('sandbox ownership errors', () => {
  it('exposes fixed safe denial metadata without owner or identity values', () => {
    expect(new SandboxPermissionDeniedError('owner_revoked')).toMatchObject({
      code: 'SANDBOX_PERMISSION_DENIED', category: 'permission', retriable: false, message: 'Sandbox access denied.', meta: { reason: 'owner_revoked' }
    })
  })

  it('retries only an active checkpoint conflict', () => {
    expect(new SandboxConflictError('checkpoint_busy').retriable).toBe(true)
    expect(new SandboxConflictError('policy_changed').retriable).toBe(false)
  })

  it('keeps quota and state-loss failures closed and non-retriable', () => {
    expect(new SandboxQuotaExceededError({ quota: 'catalog_entries', limit: 100, actual: 101 })).toMatchObject({
      code: 'SANDBOX_QUOTA_EXCEEDED', category: 'sandbox', retriable: false, message: 'Sandbox quota exceeded.', meta: { quota: 'catalog_entries', limit: 100, actual: 101 }
    })
    expect(new SandboxStateLostError('Owner is missing.', { reason: 'owner_missing', lifetime: 'session' })).toMatchObject({
      code: 'SANDBOX_STATE_LOST', category: 'sandbox', retriable: false, meta: { reason: 'owner_missing', lifetime: 'session' }
    })
  })

  it('rejects JavaScript-only metadata fields before they can cross a public error boundary', () => {
    expect(() => new SandboxPermissionDeniedError('private_owner' as never)).toThrow(HarnessConfigError)
    expect(() => new SandboxConflictError('private_owner' as never)).toThrow(HarnessConfigError)
    expect(() => new SandboxQuotaExceededError({ quota: 'snapshots', limit: 1, owner: 'SENTINEL' } as never)).toThrow(HarnessConfigError)
    expect(serializeError(new SandboxQuotaExceededError({ quota: 'snapshots', limit: 1 }))).toEqual({
      code: 'SANDBOX_QUOTA_EXCEEDED',
      category: 'sandbox',
      retriable: false,
      message: 'Sandbox quota exceeded.',
      meta: { quota: 'snapshots', limit: 1 }
    })
  })
})
