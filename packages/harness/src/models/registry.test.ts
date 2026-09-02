import { describe, expect, it } from 'vitest'

import { ModelCapabilityError } from '../errors/index.js'
import type { ModelProvider, TextRequest, TextResponse } from '../ports/model-provider.js'
import type { ModelAdmissionRequest } from '../ports/model-admission.js'
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

  it('acquires provider admission by provider, model and credential scope', async () => {
    const acquired: ModelAdmissionRequest[] = []
    let releases = 0
    const provider = new FakeProvider()
    const registry = createModelRegistry(
      {
        a: {
          provider,
          model: 'model-x',
          credentialScope: 'tenant-pool-a',
          capabilities: ['text'],
        },
      },
      {
        admission: {
          acquire: async request => {
            acquired.push(request)
            return { release: () => releases++ }
          },
        },
      },
    )

    await registry.a.text({ messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)

    expect(acquired).toMatchObject([
      {
        providerId: 'fake',
        genAiSystem: 'fake',
        model: 'model-x',
        credentialScope: 'tenant-pool-a',
        operation: 'text',
      },
    ])
    expect(releases).toBe(1)
  })

  it('holds streaming admission until the consumer finishes the stream', async () => {
    let held = false
    const provider: ModelProvider = {
      id: 'stream-provider',
      genAiSystem: 'test',
      textStream: async function* () {
        expect(held).toBe(true)
        yield { kind: 'delta', text: 'hello' }
        yield { kind: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
      },
    }
    const registry = createModelRegistry(
      { a: { provider, model: 'stream-model', capabilities: ['text_stream'] } },
      {
        admission: {
          acquire: async () => {
            held = true
            return { release: () => { held = false } }
          },
        },
      },
    )

    const chunks = []
    for await (const chunk of registry.a.textStream(
      { messages: [{ role: 'user', content: 'hi' }] },
      new AbortController().signal,
    )) chunks.push(chunk)

    expect(chunks).toHaveLength(2)
    expect(held).toBe(false)
  })
})
