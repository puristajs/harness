import { modelProviderContract } from '@purista/harness/testing'
import { describe, expect, it } from 'vitest'

import { openai, type OpenAiClient } from '../src/index.js'

/** Offline OpenAI chat-completions fake serving the shared provider contract fixtures. */
function fakeClient(): OpenAiClient {
  async function* streamChunks(content: string, finishReason: string) {
    yield { choices: [{ delta: { content } }] }
    yield { choices: [{ delta: {}, finish_reason: finishReason }] }
    yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }
  }

  return {
    chat: {
      completions: {
        create: async (payload) => {
          const stream = readField(payload, 'stream') === true
          const content = readField(payload, 'response_format') ? '{"ok":true}' : 'ok'
          if (stream) return streamChunks(content, 'stop')
          return {
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          }
        }
      }
    },
    embeddings: {
      create: async (payload) => {
        const input = readField(payload, 'input')
        const values = Array.isArray(input) ? input : [input]
        return {
          data: values.map((_, index) => ({ index, embedding: [index + 0.1, index + 0.2] })),
          usage: { prompt_tokens: values.length },
        }
      },
    }
  }
}

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

modelProviderContract(() => openai({ client: fakeClient() }), {
  capabilities: ['text', 'text_stream', 'object', 'object_stream', 'embeddings']
})

describe('OpenAI callable operation parity', () => {
  it('exposes exactly the operations implemented by the adapter', () => {
    const provider = openai({ client: fakeClient() })
    const operationMethods = ['text', 'textStream', 'object', 'objectStream', 'embed', 'rerank', 'image', 'speech', 'video', 'videoStream'] as const

    expect(operationMethods.filter((method) => typeof provider[method] === 'function')).toEqual([
      'text', 'textStream', 'object', 'objectStream', 'embed', 'image', 'speech', 'video', 'videoStream',
    ])
  })
})
