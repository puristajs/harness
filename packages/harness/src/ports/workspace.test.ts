import { expect, it } from 'vitest'

import { HarnessConfigError } from '../errors/index.js'
import { durableWorkspaceStoreContract, inMemoryDurableWorkspaceStore } from '../testing/index.js'
import type { DurableWorkspaceStore } from './workspace.js'
import { validateDurableWorkspaceStore } from './workspace.js'

durableWorkspaceStoreContract(() => inMemoryDurableWorkspaceStore())

it('rejects workspace stores without durable workspace capability', () => {
  const adapter = inMemoryDurableWorkspaceStore()
  const invalid: DurableWorkspaceStore = {
    ...adapter,
    info: {
      ...adapter.info,
      capabilities: ['workspace_store.checkpoint']
    },
    capabilities: ['workspace_store.checkpoint']
  }

  expect(() => validateDurableWorkspaceStore(invalid)).toThrow(HarnessConfigError)
})

it('rejects workspace stores with divergent capability declarations', () => {
  const adapter = inMemoryDurableWorkspaceStore()
  const invalid: DurableWorkspaceStore = {
    ...adapter,
    capabilities: [...adapter.info.capabilities, 'workspace_store.encrypted_storage']
  }

  expect(() => validateDurableWorkspaceStore(invalid)).toThrow(HarnessConfigError)
})
