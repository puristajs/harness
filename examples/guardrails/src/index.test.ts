import { expect, it } from 'vitest'
import { runGuardrailsExample } from './index.js'

it('runs with the Harness test adapter and no network dependency', async () => {
  await expect(runGuardrailsExample()).resolves.toBe('The safe answer.')
})
