import { describe, expect, it, vi } from 'vitest'

const clientCalls: Array<{ endpoint: unknown; options: unknown }> = []

vi.mock('@azure-rest/ai-inference', () => ({
  default: (endpoint: unknown, _credential: unknown, options: unknown) => {
    clientCalls.push({ endpoint, options })
    return { path: () => ({ post: async () => ({ status: 200, body: {} }) }) }
  }
}))

describe('azureFoundry SDK client options', () => {
  it('disables SDK pipeline retries by default so the harness owns retry budgets', async () => {
    const { azureFoundry } = await import('../src/index.js')
    clientCalls.length = 0

    azureFoundry({ endpoint: 'https://example.cognitiveservices.azure.com', apiKey: 'test-key' })

    expect(clientCalls).toHaveLength(1)
    expect(clientCalls[0]?.options).toMatchObject({ retryOptions: { maxRetries: 0 } })
  })

  it('keeps explicit user retryOptions as an SDK escape hatch', async () => {
    const { azureFoundry } = await import('../src/index.js')
    clientCalls.length = 0

    azureFoundry({
      endpoint: 'https://example.cognitiveservices.azure.com',
      apiKey: 'test-key',
      retryOptions: { maxRetries: 2 }
    })

    expect(clientCalls[0]?.options).toMatchObject({ retryOptions: { maxRetries: 2 } })
  })

  it('does not construct an SDK client when a client is injected', async () => {
    const { azureFoundry } = await import('../src/index.js')
    clientCalls.length = 0

    azureFoundry({ client: { path: () => ({ post: async () => ({ status: 200, body: {} }) }) } as any })

    expect(clientCalls).toHaveLength(0)
  })
})
