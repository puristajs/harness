import { describe, expect, it } from 'vitest'

import * as adapterEntry from '../src/adapter/index.js'

const EXPECTED_ADAPTER_EXPORTS = [
  'asExternalWaitResolved',
  'assertSessionSandboxBindingTransition',
  'createExternalWaitCancellation',
  'normalizeSkillRuntimes',
  'projectExternalWaitRequest',
  'sandboxScopeKey',
  'sameHarnessIdentity',
  'validateBoundExternalWaitRequest',
  'validateExternalWaitId',
  'validateExternalWaitRegistration',
  'validateExternalWaitSignal',
  'validateExternalWaitSignalResult',
  'validateExternalWaitSnapshot',
  'validateSandboxOpenOptions',
  'validateSandboxScope',
  'validateSandboxTerminateOptions',
]

describe('@purista/harness/adapter', () => {
  it('publishes the canonical runtime normalizer for adapter authors', () => {
    const runtimes = adapterEntry.normalizeSkillRuntimes(['shell', 'node'], true)

    expect(runtimes).toEqual(['node', 'shell'])
    expect(Object.isFrozen(runtimes)).toBe(true)
    expect(() => adapterEntry.normalizeSkillRuntimes(Array(1) as never, true)).toThrowError(
      expect.objectContaining({ meta: { reason: 'invalid_runtime_binding', path: 'sandbox.runtimes' } }),
    )
    let reads = 0
    const changing = Object.defineProperty([], '0', {
      enumerable: true,
      get() { reads += 1; return reads === 1 ? 'node' : 'ruby' },
    })
    Object.defineProperty(changing, 'length', { value: 1 })
    expect(adapterEntry.normalizeSkillRuntimes(changing as never, true)).toEqual(['node'])
    expect(reads).toBe(1)

    const hostile = Object.defineProperty([], '0', {
      enumerable: true,
      get() { throw new Error('private runtime value') },
    })
    let error: unknown
    try { adapterEntry.normalizeSkillRuntimes(hostile as never, true) }
    catch (failure) { error = failure }
    expect(error).toEqual(expect.objectContaining({
      meta: { reason: 'invalid_runtime_binding', path: 'sandbox.runtimes' },
    }))
    expect(JSON.stringify(error)).not.toContain('private runtime value')
  })

  it('exports exactly the supported adapter-author helpers', () => {
    expect(Object.keys(adapterEntry).sort()).toEqual([...EXPECTED_ADAPTER_EXPORTS].sort())
  })
})
