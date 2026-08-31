import { describe, expect, it } from 'vitest'

import * as adapterEntry from '../src/adapter/index.js'

const EXPECTED_ADAPTER_EXPORTS = [
  'asExternalWaitResolved',
  'assertSessionSandboxBindingTransition',
  'createExternalWaitCancellation',
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
  it('exports exactly the supported adapter-author helpers', () => {
    expect(Object.keys(adapterEntry).sort()).toEqual([...EXPECTED_ADAPTER_EXPORTS].sort())
  })
})
