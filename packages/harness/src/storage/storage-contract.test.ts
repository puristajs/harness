import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe } from 'vitest'

import { harnessStorageContract } from '../testing/harnessStorageContract.js'
import { InMemoryHarnessStorage } from '../storage/in-memory.js'
import { sqliteHarnessStorage } from '../storage/sqlite.js'

describe('InMemoryHarnessStorage', () => {
  harnessStorageContract(() => new InMemoryHarnessStorage())
})

describe('SqliteHarnessStorage', () => {
  harnessStorageContract(async () => sqliteHarnessStorage({
    file: join(await mkdtemp(join(tmpdir(), 'purista-state-contract-')), 'state.sqlite')
  }))
})
