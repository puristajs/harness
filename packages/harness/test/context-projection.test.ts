import { expect, it } from 'vitest'
import { ModelError, defineHarness, projectToolResults, validateContextProjection } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import type { ModelMessage, ObjectRequest, ObjectResponse } from '../src/index.js'

it('prunes oversized UTF-8 tool results deterministically without breaking the tool-call id', () => {
  const messages: ModelMessage[] = [{ role: 'tool', toolCallId: 'call-1', content: 'é'.repeat(80) }]
  const policy = { toolResultPruner: { maxBytes: 96, headBytes: 12, tailBytes: 12 } }
  const projected = projectToolResults(messages, policy)
  expect(projected[0]?.toolCallId).toBe('call-1')
  expect(projected[0]?.content).toContain('UTF-8 bytes omitted')
  expect(projected).toEqual(projectToolResults(projected, policy))
})

it('accounts for the exact custom marker and omission annotation bytes', () => {
  const marker = 'x'.repeat(80)
  const policy = { toolResultPruner: { maxBytes: 128, headBytes: 12, tailBytes: 12, marker } }
  // The old fixed 64-byte allowance accepted this policy even though rendering
  // its custom marker could exceed the configured cap.
  expect(validateContextProjection(policy)).toBe(false)

  const validPolicy = { toolResultPruner: { maxBytes: 128, headBytes: 12, tailBytes: 12, marker: 'x'.repeat(48) } }
  expect(validateContextProjection(validPolicy)).toBe(true)
  const projected = projectToolResults([{ role: 'tool', toolCallId: 'call-1', content: 'é'.repeat(200) }], validPolicy)
  expect(Buffer.byteLength(projected[0]?.content ?? '', 'utf8')).toBeLessThanOrEqual(validPolicy.toolResultPruner.maxBytes)
})

class ContextLengthProvider extends FakeModelProvider {
  private failed = false

  override async object<T extends import('../src/index.js').JsonValue = import('../src/index.js').JsonValue>(request: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    if (!this.failed) {
      this.failed = true
      this.requests.push(request)
      throw new ModelError('Context window exceeded.', {
        provider: 'test', model: 'test', method: 'object', reason: 'context_length_exceeded'
      })
    }
    return await super.object(request)
  }
}

it('retries exactly once with a transient projected request after a context-length failure', async () => {
  const provider = new ContextLengthProvider()
  provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const harness = defineHarness()
    .defaults({ contextProjection: { toolResultPruner: { maxBytes: 96, headBytes: 12, tailBytes: 12 } } })
    .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
    .agents({ answer: { model: 'fast', instructions: 'Answer.', builtinTools: false } })
    .build()
  const session = await harness.getSession('projection')
  await session.replaceHistory([{
    role: 'tool',
    content: '',
    toolResults: [{ toolCallId: 'call-1', output: { text: 'é'.repeat(80) } }]
  }])

  await expect(session.agents.answer.prompt('question')).resolves.toBe('done')
  expect(provider.requests).toHaveLength(2)
  const firstTool = provider.requests[0]?.messages.find((message) => message.role === 'tool')
  const retryTool = provider.requests[1]?.messages.find((message) => message.role === 'tool')
  expect(firstTool?.content).not.toContain('UTF-8 bytes omitted')
  expect(retryTool?.content).toContain('UTF-8 bytes omitted')
  expect((await session.history.list()).find((message) => message.role === 'tool')?.toolResults?.[0]?.output).toEqual({ text: 'é'.repeat(80) })
})
