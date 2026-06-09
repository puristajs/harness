import { describe, expect, it } from 'vitest'

import { ModelCapabilityError } from '../errors/index.js'
import type { ModelProvider, TextRequest, TextResponse } from '../ports/model-provider.js'
import { createModelRegistry } from './registry.js'

class FakeProvider implements ModelProvider {
  public readonly id = 'fake'
  public readonly genAiSystem = 'fake'
  public requests: TextRequest[] = []

  public async text(req: TextRequest): Promise<TextResponse> {
    this.requests.push(req)
    return {
      content: req.model,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop'
    }
  }
}

describe('createModelRegistry', () => {
  it('gates missing capability', async () => {
    const registry = createModelRegistry({
      a: { provider: new FakeProvider(), model: 'm', capabilities: ['object'] }
    })
    const handle = registry['a'] as any

    expect(() => handle?.text({ messages: [], call: {} }, AbortSignal.abort())).toThrow(ModelCapabilityError)
  })

  it('gates multimodal content part capabilities', async () => {
    const registry = createModelRegistry({
      a: { provider: new FakeProvider(), model: 'm', capabilities: ['text'] }
    })
    const handle = registry['a'] as any

    expect(() => handle?.text({ messages: [{ role: 'user', content: [{ kind: 'audio', mimeType: 'audio/wav', dataBase64: 'abc' }] }] }, AbortSignal.abort())).toThrow(ModelCapabilityError)
  })

  it('gates missing provider method when claimed', async () => {
    const registry = createModelRegistry({
      a: { provider: new FakeProvider(), model: 'm', capabilities: ['text_stream'] }
    })
    const handle = registry['a']

    expect(() => handle?.textStream({ messages: [] }, AbortSignal.abort())).toThrow(ModelCapabilityError)
  })

  it('merges defaults and invokes provider', async () => {
    const provider = new FakeProvider()
    const registry = createModelRegistry({
      a: {
        provider,
        model: 'model-x',
        capabilities: ['text'],
        defaults: { temperature: 0.2, providerOptions: { a: true } }
      }
    })
    const handle = registry['a']

    const result = await handle!.text(
      { messages: [{ role: 'user', content: 'hi' }], call: { topP: 0.1, providerOptions: { b: true } } },
      AbortSignal.abort()
    )

    expect(result.content).toBe('model-x')
  })

  it('preserves parallelToolCalls defaults without other generation options', async () => {
    const provider = new FakeProvider()
    const registry = createModelRegistry({
      a: {
        provider,
        model: 'model-x',
        capabilities: ['text', 'tool_use'],
        defaults: { parallelToolCalls: false }
      }
    })
    const handle = registry['a']

    await handle!.text(
      { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }] },
      AbortSignal.abort()
    )

    expect(provider.requests[0]?.defaults?.parallelToolCalls).toBe(false)
  })
})
