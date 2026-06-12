import { describe, expect, it } from 'vitest'
import { ModelError } from '@purista/harness'
import { azureFoundry } from '../src/index.js'

function mockSignal(): AbortSignal {
  return new AbortController().signal
}

function client(handler: (path: string, options: any) => Promise<any>) {
  return {
    path: (path: '/chat/completions' | '/embeddings') => ({
      post: (options: any) => handler(path, options)
    })
  }
}

describe('azureFoundry provider factory', () => {
  it('returns provider metadata and maps text response', async () => {
    const provider = azureFoundry({
      client: client(async () => ({
        status: '200',
        body: {
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
        }
      }))
    })

    expect(provider.id).toBe('azure-foundry')
    expect(provider.genAiSystem).toBe('azure.ai.inference')

    const response = await provider.text!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal()
    })

    expect(response.content).toBe('hello')
    expect(response.usage.totalTokens).toBe(6)
    expect(response.finishReason).toBe('stop')
  })

  it('maps object response with JSON schema response format', async () => {
    const calls: Array<{ path: string; options: any }> = []
    const provider = azureFoundry({
      client: client(async (path, options) => {
        calls.push({ path, options })
        return {
          status: '200',
          body: {
            choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
          }
        }
      })
    })

    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
    const response = await provider.object!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'object please' }],
      schema,
      signal: mockSignal()
    })

    expect(response.object).toEqual({ ok: true })
    expect(calls[0]?.path).toBe('/chat/completions')
    expect(calls[0]?.options.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'harness_response',
        strict: false,
        schema
      }
    })
  })

  it('preserves multiple application tool calls from object responses', async () => {
    const provider = azureFoundry({
      client: client(async () => ({
        status: '200',
        body: {
          choices: [
            {
              message: {
                content: '{}',
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'search_docs', arguments: '{"query":"harness"}' } },
                  { id: 'call_2', type: 'function', function: { name: 'read_doc', arguments: '{"id":"intro"}' } }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
        }
      }))
    })

    const response = await provider.object!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'use tools' }],
      schema: { type: 'object' },
      tools: [
        { name: 'search_docs', description: 'Search docs.', parameters: { type: 'object' } },
        { name: 'read_doc', description: 'Read one doc.', parameters: { type: 'object' } }
      ],
      signal: mockSignal()
    })

    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'search_docs', arguments: { query: 'harness' } },
      { id: 'call_2', name: 'read_doc', arguments: { id: 'intro' } }
    ])
  })

  it('maps first-class parallelToolCalls to OpenAI-compatible Azure payloads', async () => {
    const calls: Array<{ options: any }> = []
    const provider = azureFoundry({
      client: client(async (_path, options) => {
        calls.push({ options })
        return {
          status: '200',
          body: {
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }
        }
      })
    })

    await provider.text!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: { parallelToolCalls: true },
      call: { parallelToolCalls: false },
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(calls[0]?.options.body.parallel_tool_calls).toBe(false)
  })

  it('maps embeddings response', async () => {
    const provider = azureFoundry({
      client: client(async () => ({
        status: '200',
        body: {
          data: [{ index: 0, embedding: [0.1, 0.2] }],
          usage: { prompt_tokens: 3, total_tokens: 3 }
        }
      }))
    })

    const response = await provider.embed!({
      model: 'text-embedding-3-small',
      input: 'hello',
      signal: mockSignal()
    })

    expect(response.embeddings).toEqual([{ index: 0, vector: [0.1, 0.2] }])
    expect(response.usage.totalTokens).toBe(3)
  })

  it('passes provider options through to body and request options', async () => {
    const calls: Array<{ options: any }> = []
    const provider = azureFoundry({
      client: client(async (_path, options) => {
        calls.push({ options })
        return {
          status: '200',
          body: {
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }
        }
      })
    })

    await provider.text!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: {
        temperature: 0.1,
        providerOptions: {
          seed: 123
        }
      },
      call: {
        providerOptions: {
          requestOptions: { headers: { 'extra-parameters': 'pass-through' } }
        }
      },
      signal: mockSignal()
    })

    expect(calls[0]?.options.body).toMatchObject({
      model: 'gpt-4.1-mini',
      temperature: 0.1,
      seed: 123
    })
    expect(calls[0]?.options.headers).toEqual({ 'extra-parameters': 'pass-through' })
    expect(calls[0]?.options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('rejects invalid object JSON with ModelError', async () => {
    const provider = azureFoundry({
      client: client(async () => ({
        status: '200',
        body: {
          choices: [{ message: { content: '{"ok":' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }
      }))
    })

    await expect(
      provider.object!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'object please' }],
        schema: { type: 'object' },
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      constructor: ModelError,
      meta: {
        provider: 'azure-foundry',
        method: 'object',
        reason: 'malformed_response',
        // Raw model output never leaks into error metadata (POR-07).
        providerBody: { redacted: true, contentLength: '{"ok":'.length }
      }
    })
  })

  it('omits providerFinishReason from stream outcomes when the provider never sent one', async () => {
    const provider = azureFoundry({
      client: client(async () => ({
        status: 200,
        // A plain array takes the non-SSE event path in streamChat.
        body: [{ choices: [{ delta: { content: 'hello' } }] }]
      }))
    })

    const received: any[] = []
    for await (const chunk of provider.textStream!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal()
    })) {
      received.push(chunk)
    }

    expect(received[0]).toEqual({ kind: 'delta', text: 'hello' })
    const finish = received.at(-1)
    expect(finish.kind).toBe('finish')
    expect(finish.outcome.providerFinishReason).toBeUndefined()
  })

  it('preserves HTTP status so 429 is classified as a retriable rate-limit error', async () => {
    const provider = azureFoundry({
      client: client(async () => ({
        status: 429,
        body: { error: { message: 'rate limited', code: 'TooManyRequests' } }
      }))
    })

    await expect(
      provider.text!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hi' }],
        defaults: { retry: false },
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      constructor: ModelError,
      retriable: true,
      meta: { status: 429, reason: 'rate_limited', providerCode: 'TooManyRequests' }
    })
  })

  it('does not set stream_options on the non-streaming path', async () => {
    let body: any
    const provider = azureFoundry({
      client: client(async (_path, options) => {
        body = options.body
        return { status: 200, body: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} } }
      })
    })
    await provider.text!({ model: 'm', messages: [{ role: 'user', content: 'hi' }], signal: mockSignal() })
    expect(body.stream).toBe(false)
    expect(body.stream_options).toBeUndefined()
  })
})
