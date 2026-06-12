import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe } from 'vitest'

import { stateStoreContract } from '../testing/stateStoreContract.js'
import { InMemoryStateStore } from '../state/in-memory.js'
import { sqliteStateStore } from '../local/sqlite-storage.js'

describe('InMemoryStateStore', () => {
  stateStoreContract(() => new InMemoryStateStore())
})

describe('SqliteHarnessStorage', () => {
  stateStoreContract(async () => sqliteStateStore({
    file: join(await mkdtemp(join(tmpdir(), 'purista-state-contract-')), 'state.sqlite')
  }))
})
