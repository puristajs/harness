import { describe, expect, it } from 'vitest'
import { ModelError } from '@purista/harness'
import { anthropic } from '../src/index.js'

function mockSignal(): AbortSignal {
  return new AbortController().signal
}

describe('anthropic provider factory', () => {
  it('returns provider metadata and maps text response', async () => {
    const provider = anthropic({
      client: {
        messages: {
          create: async () => ({
            content: [{ type: 'text', text: 'hello' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 4,
              output_tokens: 2,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 1
            }
          })
        }
      }
    })

    expect(provider.id).toBe('anthropic')
    expect(provider.genAiSystem).toBe('anthropic')

    const response = await provider.text!({
      model: 'claude-sonnet-4-5',
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
    const provider = anthropic({
      client: {
        messages: {
          create: async (payload: any) => {
            calls.push(payload)
            return {
              content: [{ type: 'tool_use', id: 'toolu_1', name: 'harness_response', input: { ok: true } }],
              stop_reason: 'tool_use',
              usage: { input_tokens: 3, output_tokens: 2 }
            }
          }
        }
      }
    })

    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } }
    const response = await provider.object!({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'object please' }],
      schema,
      signal: mockSignal()
    })

    expect(response.object).toEqual({ ok: true })
    expect(response.usage.totalTokens).toBe(5)
    expect(calls[0]).toMatchObject({
      tool_choice: { type: 'tool', name: 'harness_response' },
      tools: [{ name: 'harness_response', input_schema: schema }]
    })
  })

  it('maps modern Anthropic stop reasons without losing provider detail', async () => {
    for (const [providerReason, finishReason] of [
      ['pause_turn', 'pause'],
      ['refusal', 'refusal'],
      ['model_context_window_exceeded', 'context_limit']
    ] as const) {
      const provider = anthropic({
        client: {
          messages: {
            create: async () => ({
              content: [{ type: 'text', text: 'status' }],
              stop_reason: providerReason,
              usage: { input_tokens: 1, output_tokens: 1 }
            })
          }
        }
      })

      const response = await provider.text!({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        signal: mockSignal()
      })

      expect(response.finishReason).toBe(finishReason)
      expect(response.outcome).toMatchObject({ finishReason, providerFinishReason: providerReason })
    }
  })

  it('applies temperature 0 and alias-default sampling params (precedence regression)', async () => {
    const calls: any[] = []
    const provider = anthropic({
      client: {
        messages: {
          create: async (payload: any) => {
            calls.push(payload)
            return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
          }
        }
      } as any
    })

    await provider.text!({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      call: { temperature: 0 },
      defaults: { topP: 0.9, stopSequences: ['END'] },
      signal: mockSignal()
    })

    expect(calls[0].temperature).toBe(0)
    expect(calls[0].top_p).toBe(0.9)
    expect(calls[0].stop_sequences).toEqual(['END'])
  })

  it('preserves application tool calls from object responses when tools are supplied', async () => {
    const calls: any[] = []
    const provider = anthropic({
      client: {
        messages: {
          create: async (payload: any) => {
            calls.push(payload)
            return {
              content: [{ type: 'tool_use', id: 'toolu_search', name: 'search_docs', input: { query: 'harness' } }],
              stop_reason: 'tool_use',
              usage: { input_tokens: 3, output_tokens: 2 }
            }
          }
        }
      }
    })

    const response = await provider.object!({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'search first' }],
      schema: { type: 'object' },
      tools: [{ name: 'search_docs', description: 'Search docs.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(response.toolCalls).toEqual([{ id: 'toolu_search', name: 'search_docs', arguments: { query: 'harness' } }])
    expect(calls[0]?.tools.map((tool: any) => tool.name)).toEqual(['search_docs', 'harness_response'])
    expect(calls[0]).not.toHaveProperty('tool_choice')
  })

  it('maps first-class parallelToolCalls to Anthropic tool_choice', async () => {
    const calls: any[] = []
    const provider = anthropic({
      client: {
        messages: {
          create: async (payload: any) => {
            calls.push(payload)
            return {
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 }
            }
          }
        }
      }
    })

    await provider.text!({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: { parallelToolCalls: true },
      call: { parallelToolCalls: false },
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(calls[0]?.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
  })

  it('lets Anthropic providerOptions.tool_choice override first-class parallelToolCalls', async () => {
    const calls: any[] = []
    const provider = anthropic({
      client: {
        messages: {
          create: async (payload: any) => {
            calls.push(payload)
            return {
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 }
            }
          }
        }
      }
    })

    await provider.text!({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      defaults: {
        parallelToolCalls: false,
        providerOptions: { tool_choice: { type: 'any' } }
      },
      tools: [{ name: 'lookup', description: 'Lookup.', parameters: { type: 'object' } }],
      signal: mockSignal()
    })

    expect(calls[0]?.tool_choice).toEqual({ type: 'any' })
  })

  it('passes provider options through to the official SDK payload and request options', async () => {
    const calls: Array<{ payload: any; options: any }> = []
    const provider = anthropic({
      client: {
        messages: {
          create: async (payload: any, options: any) => {
            calls.push({ payload, options })
            return {
              content: [{ type: 'text', text: 'ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 }
            }
          }
        }
      }
    })

    await provider.text!({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'system', content: 'Be terse.' }, { role: 'user', content: 'hi' }],
      defaults: {
        temperature: 0.1,
        providerOptions: {
          thinking: { type: 'disabled' }
        }
      },
      call: {
        providerOptions: {
          metadata: { user_id: 'u1' },
          requestOptions: { headers: { 'x-test': 'yes' } }
        }
      },
      signal: mockSignal()
    })

    expect(calls[0]?.payload).toMatchObject({
      model: 'claude-sonnet-4-5',
      system: 'Be terse.',
      temperature: 0.1,
      thinking: { type: 'disabled' },
      metadata: { user_id: 'u1' }
    })
    expect(calls[0]?.options).toMatchObject({ headers: { 'x-test': 'yes' } })
    expect(calls[0]?.options.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects invalid final object stream JSON with ModelError', async () => {
    async function* chunks() {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '{"ok":' } }
    }

    const provider = anthropic({
      client: {
        messages: {
          create: async () => chunks()
        }
      }
    })

    await expect(async () => {
      for await (const _chunk of provider.objectStream!({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'object please' }],
        schema: { type: 'object' },
        signal: mockSignal()
      })) {
        // consume the stream to force the final parse
      }
    }).rejects.toMatchObject({
      constructor: ModelError,
      meta: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        method: 'objectStream',
        reason: 'malformed_response',
        // Raw model output never leaks into error metadata (POR-07).
        providerBody: { redacted: true, contentLength: '{"ok":'.length }
      }
    })
  })

  it('keeps interleaved real tool calls out of the streamed object JSON', async () => {
    async function* chunks() {
      yield { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } }
      // A real application tool call streams before the object block.
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_search', name: 'search_docs', input: {} } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"harness"}' } }
      yield { type: 'content_block_stop', index: 0 }
      // The synthetic harness_response block carries the structured object.
      yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_obj', name: 'harness_response', input: {} } }
      yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"ok":' } }
      yield { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'true}' } }
      yield { type: 'content_block_stop', index: 1 }
      yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }
    }

    const provider = anthropic({
      client: {
        messages: {
          create: async () => chunks()
        }
      }
    })

    const received: any[] = []
    for await (const chunk of provider.objectStream!({
      model: 'claude-sonnet-4-5',
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
    const finish = received.at(-1)
    expect(finish).toMatchObject({
      kind: 'finish',
      object: { ok: true },
      finishReason: 'tool_calls',
      outcome: { finishReason: 'tool_calls', providerFinishReason: 'tool_use' }
    })
  })

  it('omits providerFinishReason from stream outcomes when the provider never sent one', async () => {
    async function* chunks() {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }
    }

    const provider = anthropic({
      client: {
        messages: {
          create: async () => chunks()
        }
      }
    })

    const received: any[] = []
    for await (const chunk of provider.textStream!({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      signal: mockSignal()
    })) {
      received.push(chunk)
    }

    const finish = received.at(-1)
    expect(finish.kind).toBe('finish')
    expect(finish.outcome.providerFinishReason).toBeUndefined()
  })
})
