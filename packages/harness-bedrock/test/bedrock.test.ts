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
          usage: { inputTokens: 4, outputTokens: 2 }
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
    expect(response.usage.totalTokens).toBe(6)
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
        providerBody: '{"ok":'
      }
    })
  })
})
