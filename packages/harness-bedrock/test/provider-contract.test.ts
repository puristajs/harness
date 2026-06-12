import { ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime'
import { modelProviderContract } from '@purista/harness/testing'

import { bedrock } from '../src/index.js'

/** Offline Bedrock Converse fake serving the shared provider contract fixtures. */
function fakeClient() {
  async function* textStreamEvents() {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'ok' } } }
    yield { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }
    yield { messageStop: { stopReason: 'end_turn' } }
  }

  async function* objectStreamEvents() {
    yield { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'toolu_1', name: 'harness_response' } } } }
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"ok":true}' } } } }
    yield { contentBlockStop: { contentBlockIndex: 0 } }
    yield { metadata: { usage: { inputTokens: 1, outputTokens: 1 } } }
    yield { messageStop: { stopReason: 'tool_use' } }
  }

  return {
    send: async (command: unknown) => {
      const input = (command as { input?: { toolConfig?: { tools?: Array<{ toolSpec?: { name?: string } }> } } }).input
      const objectMode = input?.toolConfig?.tools?.some((tool) => tool.toolSpec?.name === 'harness_response') === true
      if (command instanceof ConverseStreamCommand) {
        return { stream: objectMode ? objectStreamEvents() : textStreamEvents() }
      }
      if (objectMode) {
        return {
          output: { message: { content: [{ toolUse: { toolUseId: 'toolu_1', name: 'harness_response', input: { ok: true } } }] } },
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1 }
        }
      }
      return {
        output: { message: { content: [{ text: 'ok' }] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 }
      }
    }
  }
}

modelProviderContract(() => bedrock({ client: fakeClient() as never }), {
  capabilities: ['text', 'text_stream', 'object', 'object_stream']
})
