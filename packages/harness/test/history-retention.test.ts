import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BaseModelProvider, InMemoryStateStore, ModelError, defineHarness, retainCompleteTurns, type Message, type ObjectRequest, type ObjectResponse } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

function message(id: string, role: Message['role'], content: string): Message {
  return { id, sessionId: 'history', role, content, timestamp: '2026-08-19T00:00:00.000Z' }
}

function buildHarness(provider = new FakeModelProvider(), historyRetention?: { maxTurns?: number; maxBytes?: number }) {
  return defineHarness()
    .state(new InMemoryStateStore())
    .defaults(historyRetention ? { historyRetention } : {})
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agents({ answer: { model: 'fake', instructions: 'Answer.', builtinTools: false, input: z.string(), output: z.string() } })
    .build()
}

describe('durable conversation history', () => {
  it('retains whole newest turns rather than arbitrary individual messages', () => {
    const retained = retainCompleteTurns([
      message('system-1', 'system', 'rules'),
      message('user-1', 'user', 'first'),
      message('assistant-1', 'assistant', 'first answer'),
      message('system-2', 'system', 'rules'),
      message('user-2', 'user', 'second'),
      message('assistant-2', 'assistant', 'second answer')
    ], { maxTurns: 1 })

    expect(retained.map((entry) => entry.id)).toEqual(['system-2', 'user-2', 'assistant-2'])
  })

  it('rejects a newest complete turn that cannot fit without splitting it', () => {
    expect(() => retainCompleteTurns([
      message('user-1', 'user', 'x'.repeat(500)),
      message('assistant-1', 'assistant', 'done')
    ], { maxBytes: 20 })).toThrow(/newest complete conversation turn/i)
  })

  it('persists system, user, and assistant as one rolling durable turn', async () => {
    const provider = new FakeModelProvider()
    provider.enqueue({ object: 'first', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    provider.enqueue({ object: 'second', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const harness = buildHarness(provider, { maxTurns: 1 })
    const session = await harness.getSession('history')

    await session.agents.answer.prompt('first question')
    await session.agents.answer.prompt('second question')

    expect((await session.history.list()).map((entry) => [entry.role, entry.content])).toEqual([
      ['system', 'Answer.'],
      ['user', 'second question'],
      ['assistant', '"second"']
    ])
  })

  it('deduplicates a successful queue redelivery by caller-owned idempotency key', async () => {
    const provider = new FakeModelProvider()
    provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const harness = buildHarness(provider)
    const session = await harness.getSession('delivery')

    await expect(session.agents.answer.prompt('work', { idempotencyKey: 'queue-message-1' })).resolves.toBe('done')
    await expect(session.agents.answer.prompt('work', { idempotencyKey: 'queue-message-1' })).resolves.toBe('done')

    expect(provider.requests).toHaveLength(1)
    expect((await session.history.list()).map((entry) => entry.role)).toEqual(['system', 'user', 'assistant'])
  })

  it('recovers a committed transcript after a crash before run terminalization without a second model call', async () => {
    const provider = new FakeModelProvider()
    const state = new InMemoryStateStore()
    const key = 'queue-message-2'
    const runId = `agent_answer_${key}`
    await state.upsertSession({ id: 'crash-recovery', createdAt: '2026-08-19T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z', runCount: 0 })
    await state.createRun({ id: runId, sessionId: 'crash-recovery', kind: 'agent', target: 'answer', startedAt: '2026-08-19T00:00:00.000Z', status: 'running', input: 'work' })
    await state.appendMessages('crash-recovery', [
      { ...message(`msg_${runId}_00_system`, 'system', 'Answer.'), sessionId: 'crash-recovery', runId },
      { ...message(`msg_${runId}_01_user`, 'user', 'work'), sessionId: 'crash-recovery', runId },
      { ...message(`msg_${runId}_99_assistant_final`, 'assistant', '"done"'), sessionId: 'crash-recovery', runId }
    ])
    const harness = defineHarness()
      .state(state)
      .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
      .agents({ answer: { model: 'fake', instructions: 'Answer.', builtinTools: false, input: z.string(), output: z.string() } })
      .build()
    const session = await harness.getSession('crash-recovery')

    await expect(session.agents.answer.prompt('work', { idempotencyKey: key })).resolves.toBe('done')
    expect(provider.requests).toHaveLength(0)
    await expect(state.getRun(runId)).resolves.toMatchObject({ status: 'succeeded', output: 'done' })
  })
})

class RetryBeforeOutputProvider extends BaseModelProvider {
  public attempts = 0

  public constructor() { super({ id: 'retry-before-output', genAiSystem: 'test' }) }

  protected override async doObject<T extends import('../src/index.js').JsonValue = import('../src/index.js').JsonValue>(_request: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.attempts += 1
    if (this.attempts === 1) {
      throw new ModelError('Temporary network failure.', { provider: this.id, model: 'fake', method: 'object', reason: 'network' })
    }
    return { object: 'recovered' as T, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
  }
}

it('does not persist duplicate messages when the model retries before producing output', async () => {
  const provider = new RetryBeforeOutputProvider()
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'], retry: { minDelayMs: 0, maxDelayMs: 0 } } })
    .agents({ answer: { model: 'fake', instructions: 'Answer.', builtinTools: false } })
    .build()
  const session = await harness.getSession('retry')

  await expect(session.agents.answer.prompt('question')).resolves.toBe('recovered')
  expect(provider.attempts).toBe(2)
  expect((await session.history.list()).map((entry) => entry.role)).toEqual(['system', 'user', 'assistant'])
})
