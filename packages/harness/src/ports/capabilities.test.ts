import { describe, expect, it } from 'vitest'

import {
  assertAdapterCapabilities,
  collectAdapterCapabilities,
  hasAdapterCapabilities,
  missingCapabilities,
  uniqueCapabilities,
  validateAdapterCapabilities
} from './capabilities.js'

describe('adapter capabilities', () => {
  it('recognizes only object capability descriptors', () => {
    expect(hasAdapterCapabilities(undefined)).toBe(false)
    expect(hasAdapterCapabilities(null)).toBe(false)
    expect(hasAdapterCapabilities('sandbox.fs')).toBe(false)
    expect(hasAdapterCapabilities({ capabilities: 'sandbox.fs' })).toBe(false)
    expect(hasAdapterCapabilities({ capabilities: ['sandbox.fs'] })).toBe(true)
  })

  it('deduplicates, collects, and compares capabilities in first-seen order', () => {
    expect(uniqueCapabilities(['sandbox.fs', 'sandbox.fs', 'storage.checkpoint'])).toEqual(['sandbox.fs', 'storage.checkpoint'])
    expect(collectAdapterCapabilities([
      { capabilities: ['sandbox.fs', 'sandbox.fs'] as const },
      undefined,
      null,
      { capabilities: ['storage.checkpoint', 'sandbox.fs'] as const }
    ])).toEqual(['sandbox.fs', 'storage.checkpoint'])
    expect(missingCapabilities(['sandbox.fs', 'storage.checkpoint', 'sandbox.fs'], ['sandbox.fs'])).toEqual(['storage.checkpoint'])

    expect(validateAdapterCapabilities(['sandbox.fs', 'storage.checkpoint', 'sandbox.fs'], ['sandbox.fs'])).toEqual({
      required: ['sandbox.fs', 'storage.checkpoint'],
      available: ['sandbox.fs'],
      missing: ['storage.checkpoint'],
      ok: false
    })
    expect(validateAdapterCapabilities(['sandbox.fs'], ['sandbox.fs', 'storage.checkpoint'])).toMatchObject({ ok: true, missing: [] })
  })

  it('throws a caller-provided capability error only when requirements are missing', () => {
    expect(() => assertAdapterCapabilities(['sandbox.fs'], ['sandbox.fs'])).not.toThrow()
    expect(() => assertAdapterCapabilities(['sandbox.fs', 'storage.checkpoint'], ['sandbox.fs'], 'Workspace binding failed.')).toThrow(
      'Workspace binding failed. Missing: storage.checkpoint'
    )
  })
})
