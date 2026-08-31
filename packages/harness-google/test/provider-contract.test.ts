import { modelProviderContract } from '@purista/harness/testing'

import { google } from '../src/index.js'

/** Offline Gemini fake serving the shared provider contract fixtures. */
function fakeClient() {
  async function* stream(content: string) {
    yield { candidates: [{ content: { parts: [{ text: content }] } }] }
    yield {
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, responseTokenCount: 1, totalTokenCount: 2 },
    }
  }

  return {
    models: {
      generateContent: async (payload: { config?: { responseMimeType?: string } }) => ({
        candidates: [{
          content: { parts: [{ text: payload.config?.responseMimeType ? '{"ok":true}' : 'ok' }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 1, responseTokenCount: 1, totalTokenCount: 2 },
      }),
      generateContentStream: async (payload: { config?: { responseMimeType?: string } }) => stream(payload.config?.responseMimeType ? '{"ok":true}' : 'ok'),
      embedContent: async (payload: { contents: string[] }) => ({
        embeddings: payload.contents.map(() => ({ values: [0.1, 0.2] })),
      }),
    },
  }
}

modelProviderContract(() => google({ client: fakeClient() }), {
  capabilities: ['text', 'text_stream', 'object', 'object_stream', 'embeddings'],
})
