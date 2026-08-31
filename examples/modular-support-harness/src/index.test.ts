import { describe, expect, it } from 'vitest'
import type {
  JsonValue,
  ModelProvider,
  ObjectRequest,
  ObjectResponse
} from '@purista/harness'
import {
  assertDiagnosticInvariants,
  assertReplayConsumed,
  createReplayInteractionRecorder,
  replayModelProvider
} from '@purista/harness/testing'
import { createModularSupportHarness } from './index.js'

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
}

describe('modular support harness', () => {
  it('composes reusable modules while the application owns its workflow', async () => {
    const harness = createModularSupportHarness(new SupportProvider())
    const session = await harness.getSession('module-test')

    await expect(session.workflows.answer_support_ticket.run({ customer: 'Acme', question: 'I cannot sign in.' })).resolves.toMatchObject({ priority: 'normal' })
    await expect(session.memory.read<{ customer: string }>('last_ticket')).resolves.toEqual({ customer: 'Acme' })
    expect(harness.inspect().modules.map((module) => module.id)).toEqual(['support.models', 'support.agents'])

    await harness.shutdown()
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
    const recordedHarness = createModularSupportHarness(recorder.wrap(new SupportProvider()))
    const recordedSession = await recordedHarness.getSession('recorded')
    await recordedSession.workflows.answer_support_ticket.run({ customer: 'Acme', question: 'I cannot sign in.' })
    const fixture = recorder.fixture('support-login-v1')
    await recordedHarness.shutdown()

    const replay = replayModelProvider(fixture)
    const replayHarness = createModularSupportHarness(replay)
    const replaySession = await replayHarness.getSession('replay')
    await expect(replaySession.workflows.answer_support_ticket.run({ customer: 'Any customer', question: 'Different prompt is safe for this fixture.' })).resolves.toMatchObject({ priority: 'normal' })
    assertReplayConsumed(replay)
    assertDiagnosticInvariants({ inspection: replayHarness.inspect() }, [{
      id: 'support-module-provenance',
      check: ({ inspection }) => inspection.modules.some((module) => module.id === 'support.agents')
        ? undefined
        : { path: 'inspection.modules', message: 'Expected support.agents provenance.' }
    }])
    await replayHarness.shutdown()
  })
})
