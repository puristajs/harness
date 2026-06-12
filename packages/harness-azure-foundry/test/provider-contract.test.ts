import { modelProviderContract } from '@purista/harness/testing'

import { azureFoundry } from '../src/index.js'

/**
 * Offline Azure AI Foundry fake serving the shared provider contract fixtures.
 * Streaming surfaces require an SSE node stream and stay covered by the
 * adapter-specific tests; the shared contract runs the request/response paths.
 */
function fakeClient() {
  return {
    path: (path: '/chat/completions' | '/embeddings') => ({
      post: async (options: { body: { response_format?: unknown; input?: string[] } }) => {
        if (path === '/embeddings') {
          return {
            status: '200',
            body: {
              data: (options.body.input ?? ['']).map((_, index) => ({ index, embedding: [0.1, 0.2] })),
              usage: { prompt_tokens: 1, total_tokens: 1 }
            }
          }
        }
        const content = options.body.response_format ? '{"ok":true}' : 'ok'
        return {
          status: '200',
          body: {
            choices: [{ message: { content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }
        }
      }
    })
  }
}

modelProviderContract(() => azureFoundry({ client: fakeClient() as never }), {
  capabilities: ['text', 'object', 'embeddings']
})
