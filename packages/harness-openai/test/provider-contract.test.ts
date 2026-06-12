import { modelProviderContract } from '@purista/harness/testing'

import { openai } from '../src/index.js'

/** Offline OpenAI chat-completions fake serving the shared provider contract fixtures. */
function fakeClient() {
  async function* streamChunks(content: string, finishReason: string) {
    yield { choices: [{ delta: { content } }] }
    yield { choices: [{ delta: {}, finish_reason: finishReason }] }
    yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }
  }

  return {
    chat: {
      completions: {
        create: async (payload: { stream?: boolean; response_format?: unknown }) => {
          const content = payload.response_format ? '{"ok":true}' : 'ok'
          if (payload.stream) return streamChunks(content, 'stop')
          return {
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          }
        }
      }
    }
  }
}

modelProviderContract(() => openai({ client: fakeClient() as never }), {
  capabilities: ['text', 'text_stream', 'object', 'object_stream']
})
