import { describe, expect, it } from 'vitest'
import { runLimited } from '../src/agents/index.js'

describe('runLimited', () => {
  it('processes every element, including undefined values', async () => {
    const seen: unknown[] = []
    const results = await runLimited([1, undefined, 3], 2, async (item) => {
      seen.push(item)
      return item === undefined ? 'gap' : item * 10
    })
    expect(seen).toHaveLength(3)
    expect(results).toEqual([10, 'gap', 30])
  })

  it('preserves input order and bounds concurrency', async () => {
    let active = 0
    let maxActive = 0
    const results = await runLimited([10, 20, 30, 40, 50], 2, async (item) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return item / 10
    })
    expect(results).toEqual([1, 2, 3, 4, 5])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('returns an empty array for empty input', async () => {
    await expect(runLimited([], 4, async () => 'never')).resolves.toEqual([])
  })
})
