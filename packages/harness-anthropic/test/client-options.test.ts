import { describe, expect, it, vi } from 'vitest'

const constructorCalls: any[] = []

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(options: unknown) {
      constructorCalls.push(options)
    }
  }
}))

describe('anthropic SDK client options', () => {
  it('disables SDK retries by default so the harness owns retry budgets', async () => {
    const { anthropic } = await import('../src/index.js')
    constructorCalls.length = 0

    anthropic({ apiKey: 'test-key' })

    expect(constructorCalls).toHaveLength(1)
    expect(constructorCalls[0]).toMatchObject({ apiKey: 'test-key', maxRetries: 0 })
  })

  it('keeps explicit user maxRetries as an SDK escape hatch', async () => {
    const { anthropic } = await import('../src/index.js')
    constructorCalls.length = 0

    anthropic({ apiKey: 'test-key', maxRetries: 4 })

    expect(constructorCalls[0]).toMatchObject({ maxRetries: 4 })
  })

  it('does not construct an SDK client when a client is injected', async () => {
    const { anthropic } = await import('../src/index.js')
    constructorCalls.length = 0

    anthropic({ client: { messages: { create: async () => ({}) } } })

    expect(constructorCalls).toHaveLength(0)
  })
})
