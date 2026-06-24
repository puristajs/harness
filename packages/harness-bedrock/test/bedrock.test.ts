import { describe, expect, it } from 'vitest'
import { ModelError } from '@purista/harness'
import { bedrock } from '../src/index.js'

function mockSignal(): AbortSignal {
  return new AbortController().signal
}

describe('bedrock provider factory', () => {
  it('returns provider metadata and maps text response', async () => {
    const provider = bedrock({
      client: {
        send: async () => ({
          output: { message: { content: [{ text: 'hello' }] } },
          stopReason: 'end_turn',
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheWriteInputTokens: 1
          }
        })
      }
    })

    expect(provider.id).toBe('bedrock')
    expect(provider.genAiSystem).toBe('aws.bedrock')

    const response = await provider.text!({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal()
    })

    expect(response.content).toBe('hello')
    expect(response.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 1
    })
    expect(response.finishReason).toBe('stop')
  })

  it('maps object response through a forced tool use', async () => {
    const calls: any[] = []
    const provider = bedrock({
      client: {
        send: async (command: any) => {
          calls.push(command.input)
          return {
            output: { message: { content: [{ toolUse: { toolUseId: 'toolu_1', name: 'harness_response', input: { ok: true } } }] } },
            stopReason: 'tool_use',
            usage: { inputTokens: 3, outputTokens: 2 }
          }
        }
      }
    })

    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
    const response = await provider.object!({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'object please' }],
      schema,
      signal: mockSignal()
    })

    expect(response.object).toEqual({ ok: true })
    expect(response.usage.totalTokens).toBe(5)
    expect(calls[0]).toMatchObject({
      toolConfig: {
        toolChoice: { tool: { name: 'harness_response' } },
        tools: [{ toolSpec: { name: 'harness_response', inputSchema: { json: schema } } }]
      }
    })
  })

  it('maps Bedrock malformed and context stop reasons without losing provider detail', async () => {
    for (const [providerReason, finishReason] of [
      ['malformed_model_output', 'malformed'],
      ['malformed_tool_use', 'malformed'],
      ['model_context_window_exceeded', 'context_limit']
    ] as const) {
      const provider = bedrock({
        client: {
          send: async () => ({
            output: { message: { content: [{ text: 'status' }] } },
            stopReason: providerReason,
            usage: { inputTokens: 1, outputTokens: 1 }
          })
        }
      })

      const response = await provider.text!({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'hi' }],
        signal: mockSignal()
      })

      expect(response.finishReason).toBe(finishReason)
      expect(response.outcome).toMatchObject({ finishReason, providerFinishReason: providerReason })
    }
  })

  it('applies temperature 0 and alias-default sampling params (precedence regression)', async () => {
    const calls: any[] = []
    const provider = bedrock({
      client: {
        send: async (command: any) => {
          calls.push(command.input)
          return { output: { message: { content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
        }
      }
    })

    await provider.text!({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'hi' }],
      call: { temperature: 0 },
      defaults: { topP: 0.9, stopSequences: ['END'] },
      signal: mockSignal()
    })

    expect(calls[0].inferenceConfig.temperature).toBe(0)
    expect(calls[0].inferenceConfig.topP).toBe(0.9)
    expect(calls[0].inferenceConfig.stopSequences).toEqual(['END'])
  })

  it('preserves application tool calls from object responses when tools are supplied', async () => {
    const calls: any[] = []
    const provider = bedrock({
      client: {
        send: async (command: any) => {
          calls.push(command.input)
          return {
            output: { message: { content: [{ toolUse: { toolUseId: 'toolu_search', name: 'search_docs', input: { query: 'harness' } } }] } },
            stopReason: 'tool_use',
            usage: { inputTokens: 3, outputTokens: 2 }
          }
        }
      }
    })

    const response = await provider.object!({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'search first' }],
      schema: { type: 'object' },
      tools: [{ name: 'search_docs', description: 'Search docs.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(response.toolCalls).toEqual([{ id: 'toolu_search', name: 'search_docs', arguments: { query: 'harness' } }])
    expect(calls[0]?.toolConfig.tools.map((tool: any) => tool.toolSpec.name)).toEqual(['search_docs', 'harness_response'])
    expect(calls[0]?.toolConfig).not.toHaveProperty('toolChoice')
  })

  it('passes provider options through to the Converse input', async () => {
    const calls: any[] = []
    const provider = bedrock({
      client: {
        send: async (command: any) => {
          calls.push(command.input)
          return {
            output: { message: { content: [{ text: 'ok' }] } },
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 }
          }
        }
      }
    })

    await provider.text!({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'hi' }],
      defaults: {
        temperature: 0.1,
        providerOptions: {
          additionalModelRequestFields: { top_k: 50 }
        }
      },
      call: {
        providerOptions: {
          performanceConfig: { latency: 'optimized' }
        }
      },
      signal: mockSignal()
    })

    expect(calls[0]).toMatchObject({
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      system: [{ text: 'Be terse.' }],
      inferenceConfig: { temperature: 0.1 },
      additionalModelRequestFields: { top_k: 50 },
      performanceConfig: { latency: 'optimized' }
    })
  })

  it('rejects invalid object JSON with ModelError', async () => {
    const provider = bedrock({
      client: {
        send: async () => ({
          output: { message: { content: [{ text: '{"ok":' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 }
        })
      }
    })

    await expect(
      provider.object!({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'object please' }],
        schema: { type: 'object' },
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      constructor: ModelError,
      meta: {
        provider: 'bedrock',
        method: 'object',
        reason: 'malformed_response',
        // Raw model output never leaks into error metadata (POR-07).
        providerBody: { redacted: true, contentLength: '{"ok":'.length }
      }
    })
  })

  it('passes providerOptions.requestOptions to client.send instead of the Converse body', async () => {
    const calls: Array<{ input: any; options: any }> = []
    const provider = bedrock({
      client: {
        send: async (command: any, options: any) => {
          calls.push({ input: command.input, options })
          return { output: { message: { content: [{ text: 'ok' }] } }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
        }
      }
    })

    await provider.text!({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'hi' }],
      call: {
        providerOptions: {
          performanceConfig: { latency: 'optimized' },
          requestOptions: { requestTimeout: 5_000 }
        }
      },
      signal: mockSignal()
    })

    expect(calls[0]?.input).not.toHaveProperty('requestOptions')
    expect(calls[0]?.input).toMatchObject({ performanceConfig: { latency: 'optimized' } })
    expect(calls[0]?.options).toMatchObject({ requestTimeout: 5_000 })
    expect(calls[0]?.options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('keeps interleaved real tool calls out of the streamed object JSON', async () => {
    async function* stream() {
      // A real application tool call streams before the object block.
      yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'toolu_search', name: 'search_docs' } } } }
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"query":' } } } }
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '"harness"}' } } } }
      yield { contentBlockStop: { contentBlockIndex: 0 } }
      // The synthetic harness_response block carries the structured object.
      yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: 'toolu_obj', name: 'harness_response' } } } }
      yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"ok":' } } } }
      yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: 'true}' } } } }
      yield { contentBlockStop: { contentBlockIndex: 1 } }
      yield { messageStop: { stopReason: 'tool_use' } }
      yield { metadata: { usage: { inputTokens: 5, outputTokens: 9 } } }
    }

    const provider = bedrock({
      client: {
        send: async () => ({ stream: stream() })
      }
    })

    const received: any[] = []
    for await (const chunk of provider.objectStream!({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'object plus tool' }],
      schema: { type: 'object' },
      tools: [{ name: 'search_docs', description: 'Search docs.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })) {
      received.push(chunk)
    }

    const toolCalls = received.filter((chunk) => chunk.kind === 'tool_call')
    expect(toolCalls).toEqual([
      { kind: 'tool_call', call: { id: 'toolu_search', name: 'search_docs', arguments: { query: 'harness' } } }
    ])
    expect(received.at(-1)).toMatchObject({
      kind: 'finish',
      object: { ok: true },
      finishReason: 'tool_calls',
      outcome: { finishReason: 'tool_calls', providerFinishReason: 'tool_use' }
    })
  })

  it('omits providerFinishReason from stream outcomes when the provider never sent one', async () => {
    async function* stream() {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hello' } } }
    }

    const provider = bedrock({
      client: {
        send: async () => ({ stream: stream() })
      }
    })

    const received: any[] = []
    for await (const chunk of provider.textStream!({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal()
    })) {
      received.push(chunk)
    }

    const finish = received.at(-1)
    expect(finish.kind).toBe('finish')
    expect(finish.outcome.providerFinishReason).toBeUndefined()
  })

  it('normalizes AWS SDK throttling errors as retriable rate limits', async () => {
    const provider = bedrock({
      client: {
        send: async () => {
          throw Object.assign(new Error('Too many requests, please wait before trying again.'), {
            name: 'ThrottlingException',
            $metadata: { httpStatusCode: 429 },
            $response: { headers: { 'retry-after': '2', 'x-amzn-requestid': 'req_throttle' } }
          })
        }
      }
    })

    await expect(
      provider.text!({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'hi' }],
        defaults: { retry: false },
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      constructor: ModelError,
      retriable: true,
      meta: {
        status: 429,
        reason: 'rate_limited',
        providerCode: 'ThrottlingException',
        retryAfterMs: 2_000
      }
    })
  })

  it('maps ThrottlingException to a 429 equivalent even without httpStatusCode metadata', async () => {
    const provider = bedrock({
      client: {
        send: async () => {
          throw Object.assign(new Error('Throttled.'), {
            name: 'ThrottlingException',
            $metadata: {}
          })
        }
      }
    })

    await expect(
      provider.text!({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'hi' }],
        defaults: { retry: false },
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      retriable: true,
      meta: { status: 429, reason: 'rate_limited', providerCode: 'ThrottlingException' }
    })
  })

  it('normalizes AWS SDK 400 validation errors as non-retriable http errors', async () => {
    const provider = bedrock({
      client: {
        send: async () => {
          throw Object.assign(new Error('Malformed input request.'), {
            name: 'ValidationException',
            $metadata: { httpStatusCode: 400 }
          })
        }
      }
    })

    await expect(
      provider.text!({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'hi' }],
        defaults: { retry: false },
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      retriable: false,
      meta: { status: 400, reason: 'http_error', providerCode: 'ValidationException' }
    })
  })

  it('normalizes AWS SDK 403 access errors as non-retriable http errors', async () => {
    const provider = bedrock({
      client: {
        send: async () => {
          throw Object.assign(new Error('You do not have access to the model.'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 }
          })
        }
      }
    })

    await expect(
      provider.text!({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'hi' }],
        defaults: { retry: false },
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      retriable: false,
      meta: { status: 403, reason: 'http_error', providerCode: 'AccessDeniedException' }
    })
  })

  it('normalizes AWS SDK 500 errors as retriable provider_unavailable', async () => {
    const provider = bedrock({
      client: {
        send: async () => {
          throw Object.assign(new Error('Internal server error.'), {
            name: 'InternalServerException',
            $metadata: { httpStatusCode: 500 }
          })
        }
      }
    })

    await expect(
      provider.text!({
        model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
        messages: [{ role: 'user', content: 'hi' }],
        defaults: { retry: false },
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      retriable: true,
      meta: { status: 500, reason: 'provider_unavailable', providerCode: 'InternalServerException' }
    })
  })
})
