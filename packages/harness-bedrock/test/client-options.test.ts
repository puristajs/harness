import { describe, expect, it, vi } from 'vitest'

const constructorCalls: any[] = []

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: class MockBedrockRuntimeClient {
    constructor(config: unknown) {
      constructorCalls.push(config)
    }
  },
  ConverseCommand: class MockConverseCommand {
    constructor(public input: unknown) {}
  },
  ConverseStreamCommand: class MockConverseStreamCommand {
    constructor(public input: unknown) {}
  }
}))

describe('bedrock SDK client options', () => {
  it('disables SDK retries by default so the harness owns retry budgets', async () => {
    const { bedrock } = await import('../src/index.js')
    constructorCalls.length = 0

    bedrock({ region: 'us-east-1' })

    expect(constructorCalls).toHaveLength(1)
    expect(constructorCalls[0]).toMatchObject({ region: 'us-east-1', maxAttempts: 1 })
  })

  it('keeps explicit user maxAttempts as an SDK escape hatch', async () => {
    const { bedrock } = await import('../src/index.js')
    constructorCalls.length = 0

    bedrock({ region: 'us-east-1', maxAttempts: 3 })

    expect(constructorCalls[0]).toMatchObject({ maxAttempts: 3 })
  })

  it('does not construct an SDK client when a client is injected', async () => {
    const { bedrock } = await import('../src/index.js')
    constructorCalls.length = 0

    bedrock({ client: { send: async () => ({}) } })

    expect(constructorCalls).toHaveLength(0)
  })
})
