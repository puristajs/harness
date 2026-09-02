import { describe, expect, it } from 'vitest'

import { HarnessConfigError, ModelCapabilityError } from '../errors/index.js'
import type { ArtifactPublishRequest } from '../ports/artifact-store.js'
import type { ImageRequest, ModelProvider, TextRequest, TextResponse, VideoRequest } from '../ports/model-provider.js'
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

  it('publishes generated bytes and returns only a client-safe artifact reference', async () => {
    let providerRequest: ImageRequest | undefined
    let publishRequest: ArtifactPublishRequest | undefined
    const provider: ModelProvider = {
      id: 'images',
      genAiSystem: 'test',
      image: async request => {
        providerRequest = request
        return {
          artifacts: [{ body: new Uint8Array([1, 2, 3]), mediaType: 'image/png', filename: 'result.png' }],
        }
      },
    }
    const registry = createModelRegistry(
      { image: { provider, model: 'image-model', capabilities: ['image_generation'] } },
      {
        harnessName: 'demo',
        artifacts: {
          publish: async request => {
            publishRequest = request
            return { id: 'artifact-1', url: '/artifacts/artifact-1', mediaType: request.mediaType }
          },
        },
      },
    )

    const response = await registry.image.image(
      { prompt: 'A red square', outputFormat: 'png' },
      new AbortController().signal,
      { runId: 'run-1', sessionId: 'session-1', artifactIdempotencyKey: 'request-1' },
    )

    expect(providerRequest).toMatchObject({ model: 'image-model', prompt: 'A red square', outputFormat: 'png' })
    expect(publishRequest).toMatchObject({
      mediaType: 'image/png',
      filename: 'result.png',
      scope: { harnessName: 'demo', runId: 'run-1', sessionId: 'session-1' },
      idempotencyKey: 'request-1:image:image:0',
    })
    expect(response).toEqual({ artifacts: [{ id: 'artifact-1', url: '/artifacts/artifact-1', mediaType: 'image/png' }] })
    expect(response).not.toHaveProperty('raw')
  })

  it('fails before provider invocation when generated media has no artifact store', async () => {
    let called = false
    const provider: ModelProvider = {
      id: 'images',
      genAiSystem: 'test',
      image: async () => {
        called = true
        return { artifacts: [] }
      },
    }
    const registry = createModelRegistry({
      image: { provider, model: 'image-model', capabilities: ['image_generation'] },
    })

    await expect(registry.image.image({ prompt: 'A red square' }, new AbortController().signal)).rejects.toBeInstanceOf(HarnessConfigError)
    expect(called).toBe(false)
  })

  it('publishes only the terminal video artifact while preserving job progress', async () => {
    const provider: ModelProvider = {
      id: 'video',
      genAiSystem: 'test',
      videoStream: async function* (_request: VideoRequest) {
        yield { kind: 'queued' }
        yield { kind: 'progress', progress: 40 }
        yield { kind: 'finish', artifact: { body: new Uint8Array([4]), mediaType: 'video/mp4' } }
      },
    }
    const registry = createModelRegistry(
      { video: { provider, model: 'video-model', capabilities: ['video_generation'] } },
      {
        artifacts: {
          publish: async request => ({ id: 'video-1', url: '/artifacts/video-1', mediaType: request.mediaType }),
        },
      },
    )

    const chunks = []
    for await (const chunk of registry.video.videoStream(
      { prompt: 'A short animation' },
      new AbortController().signal,
    )) chunks.push(chunk)

    expect(chunks).toEqual([
      { kind: 'queued' },
      { kind: 'progress', progress: 40 },
      { kind: 'finish', artifact: { id: 'video-1', url: '/artifacts/video-1', mediaType: 'video/mp4' } },
    ])
  })
})
