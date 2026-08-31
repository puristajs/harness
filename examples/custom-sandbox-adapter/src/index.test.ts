import { expect, it } from 'vitest'

import { runCustomSandboxExample } from './index.js'

it('uses and terminates the custom sandbox through a typed tool', async () => {
  await expect(runCustomSandboxExample()).resolves.toEqual({
    output: 'report ready',
    operations: { registered: 1, opened: 1, terminated: 1 },
  })
})
