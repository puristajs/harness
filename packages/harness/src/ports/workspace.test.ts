import { expect, it } from 'vitest'

import { HarnessConfigError } from '../errors/index.js'
import { FakeDurableWorkspaceAdapter, durableWorkspaceAdapterContract } from '../testing/index.js'
import type { DurableWorkspaceAdapter } from './workspace.js'
import { validateDurableWorkspaceAdapter } from './workspace.js'

durableWorkspaceAdapterContract(() => new FakeDurableWorkspaceAdapter())

it('rejects workspace adapters without durable workspace capability', () => {
  const adapter = new FakeDurableWorkspaceAdapter()
  const invalid: DurableWorkspaceAdapter = {
    ...adapter,
    info: {
      ...adapter.info,
      capabilities: ['workspace.snapshot']
    },
    capabilities: ['workspace.snapshot']
  }

  expect(() => validateDurableWorkspaceAdapter(invalid)).toThrow(HarnessConfigError)
})

it('rejects workspace adapters with divergent capability declarations', () => {
  const adapter = new FakeDurableWorkspaceAdapter()
  const invalid: DurableWorkspaceAdapter = {
    ...adapter,
    capabilities: [...adapter.info.capabilities, 'workspace.encrypted_storage']
  }

  expect(() => validateDurableWorkspaceAdapter(invalid)).toThrow(HarnessConfigError)
})
