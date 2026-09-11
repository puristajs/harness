import { describe, expect, it, vi } from 'vitest'

const constructorCalls: any[] = []

vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(options: unknown) {
      constructorCalls.push(options)
    }
  }
}))

describe('openai SDK client options', () => {
  it('disables SDK retries by default so the harness owns retry budgets', async () => {
    const { openai } = await import('../src/index.js')
    constructorCalls.length = 0

    openai({ apiKey: 'test-key' })

    expect(constructorCalls).toHaveLength(1)
    expect(constructorCalls[0]).toMatchObject({ apiKey: 'test-key', maxRetries: 0 })
  })

  it('keeps explicit user maxRetries as an SDK escape hatch', async () => {
    const { openai } = await import('../src/index.js')
    constructorCalls.length = 0

    openai({ apiKey: 'test-key', maxRetries: 5 })

    expect(constructorCalls[0]).toMatchObject({ maxRetries: 5 })
  })

  it('does not pass adapter-only options to the SDK client', async () => {
    const { openai } = await import('../src/index.js')
    constructorCalls.length = 0

    openai({
      apiKey: 'test-key',
      api: 'responses',
      chatCompletionMaxTokensParameter: 'max_completion_tokens',
      harnessTimeoutMs: 1000,
    })

    expect(constructorCalls[0]).not.toHaveProperty('api')
    expect(constructorCalls[0]).not.toHaveProperty('chatCompletionMaxTokensParameter')
    expect(constructorCalls[0]).not.toHaveProperty('harnessTimeoutMs')
  })
})
