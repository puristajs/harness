import { describe, expect, it } from 'vitest'
import { ModelError } from '@purista/harness'
import { openai } from '../src/index.js'

function mockSignal(): AbortSignal {
  return new AbortController().signal
}

// This is the already-compiled Standard JSON Schema cache value supplied by
// the Harness core. Provider adapters must carry it to the SDK untouched.
const distinctiveCompiledSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  $defs: {
    tag: {
      type: 'string',
      pattern: '^[a-z]+$',
    },
  },
  properties: {
    filter: {
      anyOf: [{ $ref: '#/$defs/tag' }, { type: 'null' }],
    },
  },
  required: ['filter'],
  unevaluatedProperties: false,
}

describe('openai provider factory', () => {
  it('maps image bytes without exposing provider URLs', async () => {
    const provider = openai({
      client: {
        images: {
          generate: async (payload: any) => {
            expect(payload).toMatchObject({ model: 'gpt-image-1', prompt: 'A red square', output_format: 'png' })
            return { data: [{ b64_json: Buffer.from([1, 2, 3]).toString('base64') }] }
          },
        },
      } as any,
    })

    const response = await provider.image!({
      model: 'gpt-image-1',
      prompt: 'A red square',
      outputFormat: 'png',
      signal: mockSignal(),
    })

    expect(response.artifacts[0]).toMatchObject({ mediaType: 'image/png', filename: 'image-1.png' })
    expect([...response.artifacts[0]!.body as Uint8Array]).toEqual([1, 2, 3])
  })

  it('maps speech bytes and media type', async () => {
    const provider = openai({
      client: {
        audio: {
          speech: {
            create: async (payload: any) => {
              expect(payload).toMatchObject({ model: 'gpt-4o-mini-tts', input: 'Hello', voice: 'alloy', response_format: 'mp3' })
              return { arrayBuffer: async () => Uint8Array.from([4, 5]).buffer }
            },
          },
        },
      } as any,
    })

    const response = await provider.speech!({
      model: 'gpt-4o-mini-tts',
      text: 'Hello',
      signal: mockSignal(),
    })

    expect(response.artifact).toMatchObject({ mediaType: 'audio/mpeg', filename: 'speech.mp3', size: 2 })
  })

  it('streams a video job and downloads only the completed content', async () => {
    const statuses = [
      { id: 'video-1', status: 'in_progress', progress: 50 },
      { id: 'video-1', status: 'completed', progress: 100 },
    ]
    const provider = openai({
      client: {
        videos: {
          create: async () => ({ id: 'video-1', status: 'queued', progress: 0 }),
          retrieve: async () => statuses.shift(),
          downloadContent: async () => ({ arrayBuffer: async () => Uint8Array.from([6, 7]).buffer }),
        },
      } as any,
    })

    const chunks = []
    for await (const chunk of provider.videoStream!({
      model: 'sora-2',
      prompt: 'A moving square',
      call: { providerOptions: { pollIntervalMs: 100 } },
      signal: mockSignal(),
    })) chunks.push(chunk)

    expect(chunks.map(chunk => chunk.kind)).toEqual(['queued', 'progress', 'progress', 'finish'])
    expect(chunks.at(-1)).toMatchObject({
      kind: 'finish',
      artifact: { mediaType: 'video/mp4', filename: 'video-1.mp4', size: 2 },
    })
  })

  it('returns provider metadata and maps text response', async () => {
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: { content: 'hello' },
                  finish_reason: 'stop',
                },
              ],
              usage: {
                prompt_tokens: 4,
                completion_tokens: 2,
                prompt_tokens_details: { cached_tokens: 3 },
                completion_tokens_details: { reasoning_tokens: 1 },
              },
            }),
          },
        },
      } as any,
    })

    expect(provider.id).toBe('openai')
    expect(provider.genAiSystem).toBe('openai')

    const response = await provider.text!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal(),
    })

    expect(response.content).toBe('hello')
    expect(response.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      cachedInputTokens: 3,
      reasoningTokens: 1,
    })
    expect(response.finishReason).toBe('stop')
  })

  it('maps context_length_exceeded reason on failure', async () => {
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async () => {
              const error = new Error('too long') as Error & { code?: string; meta?: Record<string, unknown> }
              error.code = 'context_length_exceeded'
              throw error
            },
          },
        },
      } as any,
    })

    await expect(
      provider.text!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hi' }],
        signal: mockSignal(),
      }),
    ).rejects.toMatchObject({
      meta: { reason: 'context_length_exceeded' },
    })
  })

  it('preserves OpenAI HTTP error details on failure', async () => {
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async () => {
              const error = Object.assign(new Error('400 Invalid messages'), {
                status: 400,
                code: 'invalid_request_error',
                type: 'invalid_request_error',
                param: 'messages',
                request_id: 'req_123',
                error: { message: 'Invalid messages', type: 'invalid_request_error', param: 'messages' },
                headers: { 'x-request-id': 'req_123' },
              })
              throw error
            },
          },
        },
      } as any,
    })

    await expect(
      provider.text!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hi' }],
        signal: mockSignal(),
      }),
    ).rejects.toMatchObject({
      meta: {
        status: 400,
        reason: 'http_error',
        providerCode: 'invalid_request_error',
        providerType: 'invalid_request_error',
        providerParam: 'messages',
        providerRequestId: 'req_123',
        providerMessage: 'Invalid messages',
        providerBody: { message: 'Invalid messages', type: 'invalid_request_error', param: 'messages' },
      },
    })
  })

  it('maps object response from text content', async () => {
    const calls: any[] = []
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async (payload: any) => {
              calls.push(payload)
              return {
                choices: [
                  {
                    message: { content: '{"ok":true}' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 3, completion_tokens: 2 },
              }
            },
          },
        },
      } as any,
    })

    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
    const response = await provider.object!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'object please' }],
      schema,
      signal: mockSignal(),
    })

    expect(response.object).toEqual({ ok: true })
    expect(response.usage.totalTokens).toBe(5)
    expect(calls[0]?.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'harness_response',
        strict: false,
        schema,
      },
    })
  })

  it('forwards compiled JSON Schema unchanged for object and tool requests', async () => {
    const calls: any[] = []
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async (payload: any) => {
              calls.push(payload)
              return {
                choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }
            },
          },
        },
      } as any,
    })

    await provider.object!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'object please' }],
      schema: distinctiveCompiledSchema,
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: distinctiveCompiledSchema }],
      signal: mockSignal(),
    })

    expect(calls[0]?.response_format.json_schema.schema).toEqual(distinctiveCompiledSchema)
    expect(calls[0]?.tools[0]?.function.parameters).toEqual(distinctiveCompiledSchema)
  })

  it('maps a provider schema rejection without retrying and accepts a later compatible schema', async () => {
    let calls = 0
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async (payload: any) => {
              calls += 1
              if (payload.response_format?.json_schema?.schema === distinctiveCompiledSchema) {
                throw Object.assign(new Error('Unsupported schema keyword.'), {
                  status: 400,
                  code: 'unsupported_schema',
                  type: 'invalid_request_error',
                })
              }
              return {
                choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }
            },
          },
        },
      } as any,
    })

    await expect(
      provider.object!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'object please' }],
        schema: distinctiveCompiledSchema,
        signal: mockSignal(),
      }),
    ).rejects.toMatchObject({
      constructor: ModelError,
      retriable: false,
      meta: {
        provider: 'openai',
        method: 'object',
        status: 400,
        reason: 'http_error',
        providerCode: 'unsupported_schema',
      },
    })
    expect(calls).toBe(1)

    await expect(
      provider.object!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'object please' }],
        schema: { type: 'object' },
        signal: mockSignal(),
      }),
    ).resolves.toMatchObject({ object: { ok: true } })
    expect(calls).toBe(2)
  })

  it('rejects invalid object JSON with ModelError', async () => {
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: { content: '{"ok":' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }),
          },
        },
      } as any,
    })

    await expect(
      provider.object!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'object please' }],
        schema: { type: 'object' },
        signal: mockSignal(),
      }),
    ).rejects.toMatchObject({
      constructor: ModelError,
      meta: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        method: 'object',
        reason: 'malformed_response',
        providerBody: { redacted: true, contentLength: 6 },
      },
    })
  })

  it('rejects invalid final object stream JSON with ModelError', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: '{"ok":' } }] }
      yield { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }
    }

    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async () => chunks(),
          },
        },
      } as any,
    })

    await expect(async () => {
      for await (const _chunk of provider.objectStream!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'object please' }],
        schema: { type: 'object' },
        signal: mockSignal(),
      })) {
        // consume the stream to force the final parse
      }
    }).rejects.toMatchObject({
      constructor: ModelError,
      meta: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        method: 'objectStream',
        reason: 'malformed_response',
        providerBody: { redacted: true, contentLength: 6 },
      },
    })
  })

  it('rejects invalid tool-call argument JSON with ModelError', async () => {
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: '',
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: {
                          name: 'lookup',
                          arguments: '{"query":',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }),
          },
        },
      } as any,
    })

    await expect(
      provider.text!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'use a tool' }],
        signal: mockSignal(),
      }),
    ).rejects.toMatchObject({
      constructor: ModelError,
      meta: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        method: 'text',
        reason: 'malformed_response',
        providerBody: { redacted: true, contentLength: 9 },
      },
    })
  })

  it('preserves multiple application tool calls from object responses', async () => {
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: {
                    content: '{}',
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'search_docs', arguments: '{"query":"harness"}' },
                      },
                      { id: 'call_2', type: 'function', function: { name: 'read_doc', arguments: '{"id":"intro"}' } },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 },
            }),
          },
        },
      } as any,
    })

    const response = await provider.object!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'use tools' }],
      schema: { type: 'object' },
      tools: [
        { name: 'search_docs', description: 'Search docs.', parameters: { type: 'object' } },
        { name: 'read_doc', description: 'Read one doc.', parameters: { type: 'object' } },
      ],
      signal: mockSignal(),
    })

    expect(response.toolCalls).toEqual([
      { id: 'call_1', name: 'search_docs', arguments: { query: 'harness' } },
      { id: 'call_2', name: 'read_doc', arguments: { id: 'intro' } },
    ])
  })

  it('maps first-class parallelToolCalls to OpenAI parallel_tool_calls', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async (payload: any, options: any) => {
              calls.push({ payload, options })
              return {
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }
            },
          },
        },
      } as any,
    })

    await provider.text!({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: { parallelToolCalls: true },
      call: { parallelToolCalls: false },
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })

    expect(calls[0]?.payload.parallel_tool_calls).toBe(false)
  })

  it('uses max_completion_tokens when the native Chat Completions model requires it', async () => {
    const calls: Array<{ payload: any }> = []
    const provider = openai({
      chatCompletionMaxTokensParameter: 'max_completion_tokens',
      client: {
        chat: {
          completions: {
            create: async (payload: any) => {
              calls.push({ payload })
              return {
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }
            },
          },
        },
      } as any,
    })

    await provider.text!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: { maxTokens: 256 },
      signal: mockSignal(),
    })

    expect(calls[0]?.payload).toMatchObject({ max_completion_tokens: 256 })
    expect(calls[0]?.payload).not.toHaveProperty('max_tokens')
  })

  it('passes provider options through to the official SDK payload and request options', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async (payload: any, options: any) => {
              calls.push({ payload, options })
              return {
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }
            },
          },
        },
      } as any,
    })

    await provider.text!({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: {
        temperature: 0.1,
        providerOptions: {
          parallel_tool_calls: false,
          service_tier: 'default',
        },
      },
      call: {
        providerOptions: {
          seed: 123,
          requestOptions: {
            headers: { 'x-test': 'yes' },
          },
        },
      },
      signal: mockSignal(),
    })

    expect(calls[0]?.payload).toMatchObject({
      model: 'gpt-5-mini',
      temperature: 0.1,
      parallel_tool_calls: false,
      service_tier: 'default',
      seed: 123,
    })
    expect(calls[0]?.options).toMatchObject({
      headers: { 'x-test': 'yes' },
    })
    expect(calls[0]?.options.signal).toBeInstanceOf(AbortSignal)
  })

  it('drops reasoning_effort for chat completions with tools and emits a warning', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const warnings: Array<{ msg: string; fields?: Record<string, unknown> }> = []
    const logger = {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }),
      error: () => undefined,
      fatal: () => undefined,
      child: () => logger,
    }
    const provider = openai({
      harnessLogger: logger,
      client: {
        chat: {
          completions: {
            create: async (payload: any, options: any) => {
              calls.push({ payload, options })
              return {
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }
            },
          },
        },
      } as any,
    })

    await provider.text!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: {
        providerOptions: { reasoning_effort: 'medium' },
      },
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })

    expect(calls[0]?.payload.reasoning_effort).toBeUndefined()
    expect(warnings[0]).toMatchObject({
      msg: 'OpenAI reasoning_effort dropped for chat completions with tools.',
      fields: {
        provider: 'openai',
        model: 'gpt-5.5',
        api: 'chat_completions',
        reason: 'reasoning_effort_not_supported_with_tools',
      },
    })
  })

  it('routes reasoning tool calls through the Responses API when configured', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return {
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
                  status: 'completed',
                  role: 'assistant',
                },
              ],
              usage: {
                input_tokens: 4,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 3 },
                output_tokens_details: { reasoning_tokens: 1 },
              },
              status: 'completed',
            }
          },
        },
      } as any,
    })

    const response = await provider.object!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'object please' }],
      schema: { type: 'object' },
      defaults: {
        providerOptions: { reasoning_effort: 'medium' },
        parallelToolCalls: true,
      },
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })

    expect(response.object).toEqual({ ok: true })
    expect(response.usage).toMatchObject({
      totalTokens: 6,
      cachedInputTokens: 3,
      reasoningTokens: 1,
    })
    expect(calls[0]?.payload).toMatchObject({
      model: 'gpt-5.5',
      reasoning: { effort: 'medium' },
      parallel_tool_calls: true,
      tools: [
        { type: 'function', name: 'lookup', description: 'Lookup.', parameters: { type: 'object' }, strict: false },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'harness_response',
          strict: false,
          schema: { type: 'object' },
        },
      },
    })
  })

  it('rejects stop sequences for the Responses API instead of silently dropping them', async () => {
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async () => {
            throw new Error('request must be rejected before it reaches the SDK')
          },
        },
      } as any,
    })

    await expect(provider.text!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: { stopSequences: ['END'] },
      signal: mockSignal(),
    })).rejects.toMatchObject({
      constructor: ModelError,
      retriable: false,
      meta: {
        provider: 'openai',
        model: 'gpt-5.5',
        method: 'text',
        reason: 'unsupported_request_option',
        providerBody: { api: 'responses', option: 'stopSequences' },
      },
    })
  })

  it('maps Responses API tool-call output into a canonical provider continuation', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"query":"hi"}',
        status: 'completed',
      },
    ]
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async () => ({
            output,
            usage: { input_tokens: 4, output_tokens: 2 },
            status: 'completed',
          }),
        },
      } as any,
    })

    const response = await provider.text!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })

    expect(response.toolCalls).toEqual([{ id: 'call_1', name: 'lookup', arguments: { query: 'hi' } }])
    expect(response.providerContinuation).toEqual({
      providerId: 'openai',
      items: [
        { kind: 'opaque', data: { type: 'reasoning', id: 'rs_1', summary: [] } },
        { kind: 'tool_call', callId: 'call_1', data: { itemId: 'fc_1' } },
      ],
    })
  })

  it('omits provider continuation on Responses API responses without tool calls', async () => {
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async () => ({
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'hello', annotations: [] }],
              },
            ],
            usage: { input_tokens: 4, output_tokens: 2 },
            status: 'completed',
          }),
        },
      } as any,
    })

    const response = await provider.text!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal(),
    })

    expect(response.providerContinuation).toBeUndefined()
  })

  it('maps Responses API incomplete details into length outcome metadata', async () => {
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async () => ({
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'incomplete',
                content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
              },
            ],
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 4, output_tokens: 2 },
            status: 'incomplete',
          }),
        },
      } as any,
    })

    const response = await provider.object!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'object please' }],
      schema: { type: 'object' },
      signal: mockSignal(),
    })

    expect(response.finishReason).toBe('length')
    expect(response.outcome).toMatchObject({
      finishReason: 'length',
      providerStatus: 'incomplete',
      providerFinishReason: 'incomplete',
      details: { incompleteDetails: { reason: 'max_output_tokens' } },
    })
  })

  it('throws ModelError for failed non-streaming Responses API results', async () => {
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async () => ({
            output: [],
            status: 'failed',
            error: { code: 'server_error', message: 'The model failed to generate a response.' },
            usage: { input_tokens: 4, output_tokens: 0 },
          }),
        },
      } as any,
    })

    await expect(
      provider.text!({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        defaults: { retry: false },
        signal: mockSignal(),
      }),
    ).rejects.toMatchObject({
      constructor: ModelError,
      retriable: true,
      meta: {
        provider: 'openai',
        method: 'text',
        reason: 'provider_unavailable',
        providerCode: 'server_error',
        providerMessage: 'The model failed to generate a response.',
      },
    })
  })

  it('throws ModelError when a streamed Responses API run emits response.failed', async () => {
    async function* chunks() {
      yield { type: 'response.output_text.delta', delta: '{"ok":' }
      yield {
        type: 'response.failed',
        response: {
          status: 'failed',
          error: { code: 'rate_limit_exceeded', message: 'Rate limit reached.' },
          usage: { input_tokens: 4, output_tokens: 1 },
        },
      }
    }

    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: { create: async () => chunks() },
      } as any,
    })

    await expect(async () => {
      for await (const _chunk of provider.objectStream!({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'object please' }],
        schema: { type: 'object' },
        defaults: { retry: false },
        signal: mockSignal(),
      })) {
        // consume until the failure event surfaces
      }
    }).rejects.toMatchObject({
      constructor: ModelError,
      retriable: true,
      meta: {
        provider: 'openai',
        method: 'objectStream',
        reason: 'rate_limited',
        providerCode: 'rate_limit_exceeded',
      },
    })
  })

  it('reconstructs own provider continuation with current canonical tool arguments', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return {
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'done', annotations: [] }],
                },
              ],
              usage: { input_tokens: 4, output_tokens: 2 },
              status: 'completed',
            }
          },
        },
      } as any,
    })

    await provider.text!({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'use a tool' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { query: 'edited by rail' } }],
          providerContinuation: {
            providerId: 'openai',
            items: [
              { kind: 'opaque', data: { type: 'reasoning', id: 'rs_1', summary: [] } },
              { kind: 'tool_call', callId: 'call_1', data: { itemId: 'fc_1' } },
            ],
          },
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"answer":42}' },
      ],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })

    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'use a tool' },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"edited by rail"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"answer":42}' },
    ])
  })

  it('ignores foreign provider continuation and reconstructs the assistant turn', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return {
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'done', annotations: [] }],
                },
              ],
              usage: { input_tokens: 4, output_tokens: 2 },
              status: 'completed',
            }
          },
        },
      } as any,
    })

    await provider.text!({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'use a tool' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { query: 'hi' } }],
          providerContinuation: {
            providerId: 'anthropic',
            items: [{ kind: 'opaque', data: { type: 'thinking', thinking: 'hmm' } }],
          },
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"answer":42}' },
      ],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })

    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'use a tool' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"hi"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"answer":42}' },
    ])
  })

  it('collapses multiple Responses assistant messages into one ordered content slot', async () => {
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async () => ({
            output: [
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] },
              { type: 'reasoning', id: 'rs_1', summary: [] },
              { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' },
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second' }] },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
            status: 'completed',
          }),
        },
      } as any,
    })

    const response = await provider.text!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })

    expect(response.providerContinuation).toEqual({
      providerId: 'openai',
      items: [
        { kind: 'assistant_content' },
        { kind: 'opaque', data: { type: 'reasoning', id: 'rs_1', summary: [] } },
        { kind: 'tool_call', callId: 'call_1', data: { itemId: 'fc_1' } },
      ],
    })
  })

  it('rejects malformed own continuation before provider I/O', async () => {
    let providerCalls = 0
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async () => {
            providerCalls += 1
            throw new Error('provider must not be called')
          },
        },
      } as any,
    })

    await expect(
      provider.text!({
        model: 'gpt-5.5',
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'lookup', arguments: {} }],
            providerContinuation: {
              providerId: 'openai',
              items: [
                { kind: 'tool_call', callId: 'call_1' },
                { kind: 'tool_call', callId: 'call_1' },
              ],
            },
          },
        ],
        tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
        defaults: { retry: false },
        signal: mockSignal(),
      }),
    ).rejects.toMatchObject({
      constructor: ModelError,
      retriable: false,
      meta: { provider: 'openai', method: 'text', reason: 'invalid_provider_continuation' },
    })
    expect(providerCalls).toBe(0)
  })

  it.each([
    [
      'unknown tool call slot',
      { providerId: 'openai', items: [{ kind: 'tool_call', callId: 'call_unknown' }] },
      [{ id: 'call_1', name: 'lookup', arguments: {} }],
    ],
    [
      'duplicate tool call slot',
      {
        providerId: 'openai',
        items: [
          { kind: 'tool_call', callId: 'call_1' },
          { kind: 'tool_call', callId: 'call_1' },
        ],
      },
      [{ id: 'call_1', name: 'lookup', arguments: {} }],
    ],
    [
      'missing canonical tool call slot',
      { providerId: 'openai', items: [{ kind: 'tool_call', callId: 'call_1' }] },
      [
        { id: 'call_1', name: 'lookup', arguments: {} },
        { id: 'call_2', name: 'lookup', arguments: {} },
      ],
    ],
    [
      'invalid envelope items shape',
      { providerId: 'openai', items: {} },
      [{ id: 'call_1', name: 'lookup', arguments: {} }],
    ],
    [
      'unknown envelope field',
      { providerId: 'openai', items: [{ kind: 'tool_call', callId: 'call_1' }], extra: true },
      [{ id: 'call_1', name: 'lookup', arguments: {} }],
    ],
    [
      'invalid OpenAI slot data',
      { providerId: 'openai', items: [{ kind: 'tool_call', callId: 'call_1', data: { itemId: 'fc_1', extra: true } }] },
      [{ id: 'call_1', name: 'lookup', arguments: {} }],
    ],
    [
      'duplicate assistant-content slot',
      {
        providerId: 'openai',
        items: [{ kind: 'assistant_content' }, { kind: 'assistant_content' }, { kind: 'tool_call', callId: 'call_1' }],
      },
      [{ id: 'call_1', name: 'lookup', arguments: {} }],
    ],
  ])('rejects %s before provider I/O', async (_title, providerContinuation, toolCalls) => {
    let providerCalls = 0
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async () => {
            providerCalls += 1
            throw new Error('provider must not be called')
          },
        },
      } as any,
    })

    await expect(
      provider.text!({
        model: 'gpt-5.5',
        messages: [{ role: 'assistant', content: '', toolCalls, providerContinuation } as any],
        tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
        defaults: { retry: false },
        signal: mockSignal(),
      }),
    ).rejects.toMatchObject({
      constructor: ModelError,
      retriable: false,
      meta: { provider: 'openai', model: 'gpt-5.5', method: 'text', reason: 'invalid_provider_continuation' },
    })
    expect(providerCalls).toBe(0)
  })

  it('uses canonical reconstruction for a valid empty own continuation', async () => {
    const calls: any[] = []
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async (payload: any) => {
            calls.push(payload)
            return { output: [], usage: {}, status: 'completed' }
          },
        },
      } as any,
    })

    await provider.text!({
      model: 'gpt-5.5',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { query: 'current' } }],
          providerContinuation: { providerId: 'openai', items: [] },
        },
      ],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })

    expect(calls).toHaveLength(1)
    expect(calls[0].input).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"current"}' },
    ])
  })

  it.each([
    [
      'textStream',
      async (provider: ReturnType<typeof openai>, request: any) => {
        for await (const _chunk of provider.textStream!(request)) {
          /* consume */
        }
      },
    ],
    [
      'objectStream',
      async (provider: ReturnType<typeof openai>, request: any) => {
        for await (const _chunk of provider.objectStream!({ ...request, schema: { type: 'object' } })) {
          /* consume */
        }
      },
    ],
  ])('rejects malformed own continuation before provider I/O through %s', async (method, invoke) => {
    let providerCalls = 0
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async () => {
            providerCalls += 1
            throw new Error('provider must not be called')
          },
        },
      } as any,
    })
    const request = {
      model: 'gpt-5.5',
      messages: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: {} }],
          providerContinuation: { providerId: 'openai', items: null },
        },
      ],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      defaults: { retry: false },
      signal: mockSignal(),
    }

    await expect(invoke(provider, request)).rejects.toMatchObject({
      constructor: ModelError,
      retriable: false,
      meta: { provider: 'openai', model: 'gpt-5.5', method, reason: 'invalid_provider_continuation' },
    })
    expect(providerCalls).toBe(0)
  })

  it('reconstructs Responses API tool-call round-trip input without a function_call item id', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return {
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'done', annotations: [] }],
                  status: 'completed',
                  role: 'assistant',
                },
              ],
              usage: { input_tokens: 4, output_tokens: 2 },
              status: 'completed',
            }
          },
        },
      } as any,
    })

    await provider.text!({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'read a page' },
        {
          role: 'assistant',
          content: 'Looking it up.',
          toolCalls: [
            { id: 'call_1', name: 'read_wiki_page', arguments: { slug: 'agent-harness' } },
            { id: 'call_2', name: 'search_docs', arguments: { query: 'harness' } },
          ],
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"title":"Agent Harness"}' },
        { role: 'tool', toolCallId: 'call_2', content: '{"hits":[]}' },
      ],
      tools: [
        { name: 'read_wiki_page', description: 'Read one page.', parameters: { type: 'object' } },
        { name: 'search_docs', description: 'Search docs.', parameters: { type: 'object' } },
      ],
      signal: mockSignal(),
    })

    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'read a page' },
      { type: 'message', role: 'assistant', content: 'Looking it up.' },
      { type: 'function_call', call_id: 'call_1', name: 'read_wiki_page', arguments: '{"slug":"agent-harness"}' },
      { type: 'function_call', call_id: 'call_2', name: 'search_docs', arguments: '{"query":"harness"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"title":"Agent Harness"}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"hits":[]}' },
    ])
    // The Responses API rejects `call_…` values as the `function_call` item id.
    for (const item of calls[0]?.payload.input.filter((entry: any) => entry.type === 'function_call')) {
      expect('id' in item).toBe(false)
    }
  })

  it('maps streamed Responses API function calls using call_id', async () => {
    async function* chunks() {
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '',
        },
      }
      yield {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"query"',
      }
      yield {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc_1',
        name: 'lookup',
        arguments: '{"query":"hi"}',
      }
      yield {
        type: 'response.completed',
        response: {
          output: [
            { type: 'reasoning', id: 'rs_1', summary: [] },
            {
              type: 'function_call',
              id: 'fc_1',
              call_id: 'call_1',
              name: 'lookup',
              arguments: '{"query":"hi"}',
              status: 'completed',
            },
          ],
          usage: { input_tokens: 5, output_tokens: 2 },
          status: 'completed',
        },
      }
    }
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: { create: async () => chunks() },
      } as any,
    })

    const out: any[] = []
    for await (const chunk of provider.textStream!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })) {
      out.push(chunk)
    }

    expect(out.find((chunk) => chunk.kind === 'tool_call')?.call).toEqual({
      id: 'call_1',
      name: 'lookup',
      arguments: { query: 'hi' },
    })
    expect(out.find((chunk) => chunk.kind === 'finish')).toMatchObject({
      usage: { totalTokens: 7 },
      finishReason: 'tool_calls',
      providerContinuation: {
        providerId: 'openai',
        items: [
          { kind: 'opaque', data: { type: 'reasoning', id: 'rs_1', summary: [] } },
          { kind: 'tool_call', callId: 'call_1', data: { itemId: 'fc_1' } },
        ],
      },
    })
  })

  it('rejects streamed Responses API function calls that never carry a call_id', async () => {
    async function* chunks() {
      // No response.output_item.added: the only id available is the `fc_…`
      // item id from the arguments.done event, which must never be used as
      // the tool-call id.
      yield {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc_1',
        name: 'lookup',
        arguments: '{"query":"hi"}',
      }
      yield {
        type: 'response.completed',
        response: {
          output: [],
          usage: { input_tokens: 5, output_tokens: 2 },
          status: 'completed',
        },
      }
    }
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: { create: async () => chunks() },
      } as any,
    })

    await expect(async () => {
      for await (const _chunk of provider.textStream!({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'use a tool' }],
        tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
        signal: mockSignal(),
      })) {
        // consume the stream to force tool-call finalization
      }
    }).rejects.toMatchObject({
      constructor: ModelError,
      meta: {
        provider: 'openai',
        model: 'gpt-5.5',
        method: 'textStream',
        reason: 'malformed_response',
      },
    })
  })

  it('does not send chat completions stream_options to Responses API streaming', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    async function* chunks() {
      yield { type: 'response.output_text.delta', delta: 'hello' }
      yield {
        type: 'response.completed',
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
          usage: { input_tokens: 3, output_tokens: 2 },
          status: 'completed',
        },
      }
    }
    const provider = openai({
      api: 'responses',
      client: {
        chat: {
          completions: {
            create: async () => {
              throw new Error('unexpected chat completions call')
            },
          },
        },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return chunks()
          },
        },
      } as any,
    })

    const out: any[] = []
    for await (const chunk of provider.textStream!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal(),
    })) {
      out.push(chunk)
    }

    expect(calls[0]?.payload).toMatchObject({
      model: 'gpt-5.5',
      stream: true,
    })
    expect(calls[0]?.payload.stream_options).toBeUndefined()
    expect(out).toContainEqual({ kind: 'delta', text: 'hello' })
    expect(out.find((chunk) => chunk.kind === 'finish')).toMatchObject({
      usage: { totalTokens: 5 },
      finishReason: 'stop',
    })
  })

  it('accumulates fragmented streaming tool calls, usage, and finish reason', async () => {
    let payload: any
    async function* chunks() {
      // First fragment: id + name, empty args.
      yield {
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '' } }] } }],
      }
      // Argument fragments arrive without id/name.
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"qu' } }] } }] }
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ery":"hi"}' } }] } }] }
      // Finish reason on its own delta.
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      // Usage chunk arrives with an empty choices array.
      yield { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }
    }
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async (p: any) => {
              payload = p
              return chunks()
            },
          },
        },
      } as any,
    })

    const out: any[] = []
    for await (const chunk of provider.textStream!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal(),
    })) {
      out.push(chunk)
    }

    expect(payload.stream_options).toEqual({ include_usage: true })
    const toolCall = out.find((c) => c.kind === 'tool_call')
    expect(toolCall.call).toEqual({ id: 'call_1', name: 'lookup', arguments: { query: 'hi' } })
    const finish = out.find((c) => c.kind === 'finish')
    expect(finish.finishReason).toBe('tool_calls')
    expect(finish.usage.totalTokens).toBe(10)
  })

  it('preserves assistant tool_calls before tool result messages', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async (payload: any, options: any) => {
              calls.push({ payload, options })
              return {
                choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }
            },
          },
        },
      } as any,
    })

    await provider.object!({
      model: 'gpt-5-mini',
      messages: [
        { role: 'user', content: 'read a page' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'read_wiki_page', arguments: { slug: 'agent-harness' } }],
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"title":"Agent Harness"}' },
      ],
      schema: { type: 'object' },
      signal: mockSignal(),
    })

    expect(calls[0]?.payload.messages).toEqual([
      { role: 'user', content: 'read a page' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_wiki_page',
              arguments: '{"slug":"agent-harness"}',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"title":"Agent Harness"}' },
    ])
  })
})
