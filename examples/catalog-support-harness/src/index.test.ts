import { describe, expect, it } from 'vitest'
import type {
  JsonValue,
  ModelProvider,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
} from '@purista/harness'
import {
  assertReplayConsumed,
  createReplayInteractionRecorder,
  replayModelProvider
} from '@purista/harness/testing'
import { createCatalogSupportHarness } from './index.js'

class SupportProvider implements ModelProvider {
  readonly id = 'support-example'
  readonly genAiSystem = 'support-example'

  async object<T extends JsonValue = JsonValue>(_request: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    return {
      object: {
        answer: 'Reset your password once more, then use the link from the newest email.',
        priority: 'normal'
      } as unknown as T,
      usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
      finishReason: 'stop'
    }
  }

  async *objectStream<T extends JsonValue = JsonValue>(request: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    const response = await this.object(request)
    yield { kind: 'finish', object: response.object, finishReason: response.finishReason, usage: response.usage }
  }
}

describe('catalog support harness', () => {
  it('composes a reusable catalog while the application owns its workflow', async () => {
    const harness = await createCatalogSupportHarness(new SupportProvider())
    const session = await harness.getSession('catalog-test')

    await expect(session.workflows.answerSupportTicket.run({ customer: 'Acme', question: 'I cannot sign in.' })).resolves.toMatchObject({ status: 'completed', output: { priority: 'normal' } })

    await harness.close()
  })

  it('records a sanitized fixture that deterministically replays the workflow', async () => {
    const recorder = createReplayInteractionRecorder({
      sanitize(value) {
        if (typeof value === 'object' && value !== null && 'messages' in value) {
          return { ...(value as Record<string, unknown>), messages: '[redacted]' }
        }
        return value
      }
    })
    const recordedHarness = await createCatalogSupportHarness(recorder.wrap(new SupportProvider()))
    const recordedSession = await recordedHarness.getSession('recorded')
    await recordedSession.workflows.answerSupportTicket.run({ customer: 'Acme', question: 'I cannot sign in.' })
    const fixture = recorder.fixture('support-login-v1')
    await recordedHarness.close()

    const replay = replayModelProvider(fixture)
    const replayHarness = await createCatalogSupportHarness(replay)
    const replaySession = await replayHarness.getSession('replay')
    await expect(replaySession.workflows.answerSupportTicket.run({ customer: 'Any customer', question: 'Different prompt is safe for this fixture.' })).resolves.toMatchObject({ status: 'completed', output: { priority: 'normal' } })
    assertReplayConsumed(replay)
    await replayHarness.close()
  })
})
