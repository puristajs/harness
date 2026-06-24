import { describe, expect, it } from 'vitest'
import { ModelError } from '@purista/harness'
import { openai } from '../src/index.js'

function mockSignal(): AbortSignal {
  return new AbortController().signal
}

describe('openai provider factory', () => {
  it('returns provider metadata and maps text response', async () => {
    const provider = openai({
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [
                {
                  message: { content: 'hello' },
                  finish_reason: 'stop'
                }
              ],
              usage: {
                prompt_tokens: 4,
                completion_tokens: 2,
                prompt_tokens_details: { cached_tokens: 3 },
                completion_tokens_details: { reasoning_tokens: 1 }
              }
            })
          }
        }
      } as any
    })

    expect(provider.id).toBe('openai')
    expect(provider.genAiSystem).toBe('openai')

    const response = await provider.text!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal()
    })

    expect(response.content).toBe('hello')
    expect(response.usage).toMatchObject({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
      cachedInputTokens: 3,
      reasoningTokens: 1
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
            }
          }
        }
      } as any
    })

    await expect(
      provider.text!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hi' }],
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      meta: { reason: 'context_length_exceeded' }
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
                headers: { 'x-request-id': 'req_123' }
              })
              throw error
            }
          }
        }
      } as any
    })

    await expect(
      provider.text!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'hi' }],
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      meta: {
        status: 400,
        reason: 'http_error',
        providerCode: 'invalid_request_error',
        providerType: 'invalid_request_error',
        providerParam: 'messages',
        providerRequestId: 'req_123',
        providerMessage: 'Invalid messages',
        providerBody: { message: 'Invalid messages', type: 'invalid_request_error', param: 'messages' }
      }
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
                  finish_reason: 'stop'
                }
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 }
              }
            }
          }
        }
      } as any
    })

    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
    const response = await provider.object!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'object please' }],
      schema,
      signal: mockSignal()
    })

    expect(response.object).toEqual({ ok: true })
    expect(response.usage.totalTokens).toBe(5)
    expect(calls[0]?.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'harness_response',
        strict: false,
        schema
      }
    })
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
                  finish_reason: 'stop'
                }
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 }
            })
          }
        }
      } as any
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
        provider: 'openai',
        model: 'gpt-4.1-mini',
        method: 'object',
        reason: 'malformed_response',
        providerBody: { redacted: true, contentLength: 6 }
      }
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
            create: async () => chunks()
          }
        }
      } as any
    })

    await expect(async () => {
      for await (const _chunk of provider.objectStream!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'object please' }],
        schema: { type: 'object' },
        signal: mockSignal()
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
        providerBody: { redacted: true, contentLength: 6 }
      }
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
                    tool_calls: [{
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'lookup',
                        arguments: '{"query":'
                      }
                    }]
                  },
                  finish_reason: 'tool_calls'
                }
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 }
            })
          }
        }
      } as any
    })

    await expect(
      provider.text!({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'use a tool' }],
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      constructor: ModelError,
      meta: {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        method: 'text',
        reason: 'malformed_response',
        providerBody: { redacted: true, contentLength: 9 }
      }
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
                      { id: 'call_1', type: 'function', function: { name: 'search_docs', arguments: '{"query":"harness"}' } },
                      { id: 'call_2', type: 'function', function: { name: 'read_doc', arguments: '{"id":"intro"}' } }
                    ]
                  },
                  finish_reason: 'tool_calls'
                }
              ],
              usage: { prompt_tokens: 3, completion_tokens: 2 }
            })
          }
        }
      } as any
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
                usage: { prompt_tokens: 1, completion_tokens: 1 }
              }
            }
          }
        }
      } as any
    })

    await provider.text!({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: { parallelToolCalls: true },
      call: { parallelToolCalls: false },
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(calls[0]?.payload.parallel_tool_calls).toBe(false)
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
                usage: { prompt_tokens: 1, completion_tokens: 1 }
              }
            }
          }
        }
      } as any
    })

    await provider.text!({
      model: 'gpt-5-mini',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: {
        temperature: 0.1,
        providerOptions: {
          parallel_tool_calls: false,
          service_tier: 'default'
        }
      },
      call: {
        providerOptions: {
          seed: 123,
          requestOptions: {
            headers: { 'x-test': 'yes' }
          }
        }
      },
      signal: mockSignal()
    })

    expect(calls[0]?.payload).toMatchObject({
      model: 'gpt-5-mini',
      temperature: 0.1,
      parallel_tool_calls: false,
      service_tier: 'default',
      seed: 123
    })
    expect(calls[0]?.options).toMatchObject({
      headers: { 'x-test': 'yes' }
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
      child: () => logger
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
                usage: { prompt_tokens: 1, completion_tokens: 1 }
              }
            }
          }
        }
      } as any
    })

    await provider.text!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: {
        providerOptions: { reasoning_effort: 'medium' }
      },
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(calls[0]?.payload.reasoning_effort).toBeUndefined()
    expect(warnings[0]).toMatchObject({
      msg: 'OpenAI reasoning_effort dropped for chat completions with tools.',
      fields: {
        provider: 'openai',
        model: 'gpt-5.5',
        api: 'chat_completions',
        reason: 'reasoning_effort_not_supported_with_tools'
      }
    })
  })

  it('routes reasoning tool calls through the Responses API when configured', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return {
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }],
                  status: 'completed',
                  role: 'assistant'
                }
              ],
              usage: {
                input_tokens: 4,
                output_tokens: 2,
                input_tokens_details: { cached_tokens: 3 },
                output_tokens_details: { reasoning_tokens: 1 }
              },
              status: 'completed'
            }
          }
        }
      } as any
    })

    const response = await provider.object!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'object please' }],
      schema: { type: 'object' },
      defaults: {
        providerOptions: { reasoning_effort: 'medium' },
        parallelToolCalls: true
      },
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(response.object).toEqual({ ok: true })
    expect(response.usage).toMatchObject({
      totalTokens: 6,
      cachedInputTokens: 3,
      reasoningTokens: 1
    })
    expect(calls[0]?.payload).toMatchObject({
      model: 'gpt-5.5',
      reasoning: { effort: 'medium' },
      parallel_tool_calls: true,
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup.', parameters: { type: 'object' }, strict: false }],
      text: {
        format: {
          type: 'json_schema',
          name: 'harness_response',
          strict: false,
          schema: { type: 'object' }
        }
      }
    })
  })

  it('captures Responses API output items on tool-call responses as providerItems', async () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"hi"}', status: 'completed' }
    ]
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: {
          create: async () => ({
            output,
            usage: { input_tokens: 4, output_tokens: 2 },
            status: 'completed'
          })
        }
      } as any
    })

    const response = await provider.text!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(response.toolCalls).toEqual([{ id: 'call_1', name: 'lookup', arguments: { query: 'hi' } }])
    expect(response.providerItems).toEqual({ providerId: 'openai', items: output })
  })

  it('omits providerItems on Responses API responses without tool calls', async () => {
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: {
          create: async () => ({
            output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
            usage: { input_tokens: 4, output_tokens: 2 },
            status: 'completed'
          })
        }
      } as any
    })

    const response = await provider.text!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal()
    })

    expect(response.providerItems).toBeUndefined()
  })

  it('maps Responses API incomplete details into length outcome metadata', async () => {
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: {
          create: async () => ({
            output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] }],
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 4, output_tokens: 2 },
            status: 'incomplete'
          })
        }
      } as any
    })

    const response = await provider.object!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'object please' }],
      schema: { type: 'object' },
      signal: mockSignal()
    })

    expect(response.finishReason).toBe('length')
    expect(response.outcome).toMatchObject({
      finishReason: 'length',
      providerStatus: 'incomplete',
      providerFinishReason: 'incomplete',
      details: { incompleteDetails: { reason: 'max_output_tokens' } }
    })
  })

  it('throws ModelError for failed non-streaming Responses API results', async () => {
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: {
          create: async () => ({
            output: [],
            status: 'failed',
            error: { code: 'server_error', message: 'The model failed to generate a response.' },
            usage: { input_tokens: 4, output_tokens: 0 }
          })
        }
      } as any
    })

    await expect(
      provider.text!({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        defaults: { retry: false },
        signal: mockSignal()
      })
    ).rejects.toMatchObject({
      constructor: ModelError,
      retriable: true,
      meta: {
        provider: 'openai',
        method: 'text',
        reason: 'provider_unavailable',
        providerCode: 'server_error',
        providerMessage: 'The model failed to generate a response.'
      }
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
          usage: { input_tokens: 4, output_tokens: 1 }
        }
      }
    }

    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: { create: async () => chunks() }
      } as any
    })

    await expect(async () => {
      for await (const _chunk of provider.objectStream!({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'object please' }],
        schema: { type: 'object' },
        defaults: { retry: false },
        signal: mockSignal()
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
        providerCode: 'rate_limit_exceeded'
      }
    })
  })

  it('replays own providerItems verbatim instead of reconstructing the assistant turn', async () => {
    const turnItems = [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"hi"}', status: 'completed' }
    ]
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return {
              output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }],
              usage: { input_tokens: 4, output_tokens: 2 },
              status: 'completed'
            }
          }
        }
      } as any
    })

    await provider.text!({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'use a tool' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { query: 'hi' } }],
          providerItems: { providerId: 'openai', items: turnItems }
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"answer":42}' }
      ],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'use a tool' },
      ...turnItems,
      { type: 'function_call_output', call_id: 'call_1', output: '{"answer":42}' }
    ])
  })

  it('ignores foreign providerItems and reconstructs the assistant turn', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return {
              output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }],
              usage: { input_tokens: 4, output_tokens: 2 },
              status: 'completed'
            }
          }
        }
      } as any
    })

    await provider.text!({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'use a tool' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: { query: 'hi' } }],
          providerItems: { providerId: 'anthropic', items: [{ type: 'thinking', thinking: 'hmm' }] }
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"answer":42}' }
      ],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'use a tool' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"hi"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"answer":42}' }
    ])
  })

  it('reconstructs Responses API tool-call round-trip input without a function_call item id', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return {
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: 'done', annotations: [] }],
                  status: 'completed',
                  role: 'assistant'
                }
              ],
              usage: { input_tokens: 4, output_tokens: 2 },
              status: 'completed'
            }
          }
        }
      } as any
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
            { id: 'call_2', name: 'search_docs', arguments: { query: 'harness' } }
          ]
        },
        { role: 'tool', toolCallId: 'call_1', content: '{"title":"Agent Harness"}' },
        { role: 'tool', toolCallId: 'call_2', content: '{"hits":[]}' }
      ],
      tools: [
        { name: 'read_wiki_page', description: 'Read one page.', parameters: { type: 'object' } },
        { name: 'search_docs', description: 'Search docs.', parameters: { type: 'object' } }
      ],
      signal: mockSignal()
    })

    expect(calls[0]?.payload.input).toEqual([
      { type: 'message', role: 'user', content: 'read a page' },
      { type: 'message', role: 'assistant', content: 'Looking it up.' },
      { type: 'function_call', call_id: 'call_1', name: 'read_wiki_page', arguments: '{"slug":"agent-harness"}' },
      { type: 'function_call', call_id: 'call_2', name: 'search_docs', arguments: '{"query":"harness"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"title":"Agent Harness"}' },
      { type: 'function_call_output', call_id: 'call_2', output: '{"hits":[]}' }
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
          arguments: ''
        }
      }
      yield {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"query"'
      }
      yield {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'fc_1',
        name: 'lookup',
        arguments: '{"query":"hi"}'
      }
      yield {
        type: 'response.completed',
        response: {
          output: [
            { type: 'reasoning', id: 'rs_1', summary: [] },
            { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"hi"}', status: 'completed' }
          ],
          usage: { input_tokens: 5, output_tokens: 2 },
          status: 'completed'
        }
      }
    }
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: { create: async () => chunks() }
      } as any
    })

    const out: any[] = []
    for await (const chunk of provider.textStream!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })) {
      out.push(chunk)
    }

    expect(out.find((chunk) => chunk.kind === 'tool_call')?.call).toEqual({
      id: 'call_1',
      name: 'lookup',
      arguments: { query: 'hi' }
    })
    expect(out.find((chunk) => chunk.kind === 'finish')).toMatchObject({
      usage: { totalTokens: 7 },
      finishReason: 'tool_calls',
      providerItems: {
        providerId: 'openai',
        items: [
          { type: 'reasoning', id: 'rs_1', summary: [] },
          { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"query":"hi"}', status: 'completed' }
        ]
      }
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
        arguments: '{"query":"hi"}'
      }
      yield {
        type: 'response.completed',
        response: {
          output: [],
          usage: { input_tokens: 5, output_tokens: 2 },
          status: 'completed'
        }
      }
    }
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: { create: async () => chunks() }
      } as any
    })

    await expect(async () => {
      for await (const _chunk of provider.textStream!({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'use a tool' }],
        tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
        signal: mockSignal()
      })) {
        // consume the stream to force tool-call finalization
      }
    }).rejects.toMatchObject({
      constructor: ModelError,
      meta: {
        provider: 'openai',
        model: 'gpt-5.5',
        method: 'textStream',
        reason: 'malformed_response'
      }
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
          status: 'completed'
        }
      }
    }
    const provider = openai({
      api: 'responses',
      client: {
        chat: { completions: { create: async () => { throw new Error('unexpected chat completions call') } } },
        responses: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return chunks()
          }
        }
      } as any
    })

    const out: any[] = []
    for await (const chunk of provider.textStream!({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal()
    })) {
      out.push(chunk)
    }

    expect(calls[0]?.payload).toMatchObject({
      model: 'gpt-5.5',
      stream: true
    })
    expect(calls[0]?.payload.stream_options).toBeUndefined()
    expect(out).toContainEqual({ kind: 'delta', text: 'hello' })
    expect(out.find((chunk) => chunk.kind === 'finish')).toMatchObject({
      usage: { totalTokens: 5 },
      finishReason: 'stop'
    })
  })

  it('accumulates fragmented streaming tool calls, usage, and finish reason', async () => {
    let payload: any
    async function* chunks() {
      // First fragment: id + name, empty args.
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup', arguments: '' } }] } }] }
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
        chat: { completions: { create: async (p: any) => { payload = p; return chunks() } } }
      } as any
    })

    const out: any[] = []
    for await (const chunk of provider.textStream!({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: 'use a tool' }],
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
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
                usage: { prompt_tokens: 1, completion_tokens: 1 }
              }
            }
          }
        }
      } as any
    })

    await provider.object!({
      model: 'gpt-5-mini',
      messages: [
        { role: 'user', content: 'read a page' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_wiki_page', arguments: { slug: 'agent-harness' } }] },
        { role: 'tool', toolCallId: 'call_1', content: '{"title":"Agent Harness"}' }
      ],
      schema: { type: 'object' },
      signal: mockSignal()
    })

    expect(calls[0]?.payload.messages).toEqual([
      { role: 'user', content: 'read a page' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read_wiki_page',
            arguments: '{"slug":"agent-harness"}'
          }
        }]
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"title":"Agent Harness"}' }
    ])
  })
})
