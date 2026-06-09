import { describe } from 'vitest'
import { bashSandbox, inMemorySandbox } from '../src/sandbox/index.js'
import { sandboxContract } from '../src/testing/sandboxContract.js'

describe('inMemorySandbox', () => {
  sandboxContract(() => inMemorySandbox(), { executor: 'unavailable' })
})

describe('bashSandbox', () => {
  sandboxContract(() => bashSandbox(), { executor: 'available' })
})

import { expect, it } from 'vitest'

it('glob list is anchored and does not throw on regex metacharacters', async () => {
  const sandbox = inMemorySandbox()
  const session = await sandbox.open({ sessionId: 's', runId: 'r' })
  await session.write('/a.ts', 'x')
  await session.write('/a.tsx', 'x')
  await session.write('/b.json', 'x')

  const ts = await session.list('/', { recursive: true, glob: '*.ts' })
  // Anchored: *.ts must NOT match a.tsx
  expect(ts.map((e) => e.path).sort()).toEqual(['/a.ts'])

  // A pattern with a regex metacharacter must not throw a SyntaxError.
  await expect(session.list('/', { recursive: true, glob: 'a[.ts' })).resolves.toBeDefined()
  await session.close?.()
})
