import { modelProviderContract } from '@purista/harness/testing'

import { anthropic } from '../src/index.js'

/** Offline Anthropic messages fake serving the shared provider contract fixtures. */
function fakeClient() {
  async function* textStreamEvents() {
    yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
  }

  async function* objectStreamEvents() {
    yield { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'harness_response', input: {} } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"ok":true}' } }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }
  }

  return {
    messages: {
      create: async (payload: { stream?: boolean; tools?: Array<{ name: string }> }) => {
        const objectMode = payload.tools?.some((tool) => tool.name === 'harness_response') === true
        if (payload.stream) return objectMode ? objectStreamEvents() : textStreamEvents()
        if (objectMode) {
          return {
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'harness_response', input: { ok: true } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        }
        return {
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      }
    }
  }
}

modelProviderContract(() => anthropic({ client: fakeClient() as never }), {
  capabilities: ['text', 'text_stream', 'object', 'object_stream']
})
