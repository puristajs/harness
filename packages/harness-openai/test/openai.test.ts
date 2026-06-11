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
              usage: { prompt_tokens: 4, completion_tokens: 2 }
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
    expect(response.usage.totalTokens).toBe(6)
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
        providerBody: '{"ok":'
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
        providerBody: '{"ok":'
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
        providerBody: '{"query":'
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
              usage: { input_tokens: 4, output_tokens: 2 },
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
    expect(response.usage.totalTokens).toBe(6)
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
          output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"hi"}' }],
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
      finishReason: 'tool_calls'
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
