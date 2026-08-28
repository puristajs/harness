import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BaseModelProvider, InMemoryHarnessStorage, ModelError, defineHarness, inMemorySandbox, retainCompleteTurns, type Message, type ObjectRequest, type ObjectResponse } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { FakeHarnessStorage } from '../src/testing/fakeHarnessStorage.js'
import { createSessionSandboxBinding } from '../src/sessions/sandboxBindings.js'

function message(id: string, role: Message['role'], content: string): Message {
  return { id, sessionId: 'history', role, content, timestamp: '2026-08-19T00:00:00.000Z' }
}

function buildHarness(provider = new FakeModelProvider(), historyRetention?: { maxTurns?: number; maxBytes?: number }) {
  return defineHarness()
    .storage(new InMemoryHarnessStorage())
    .defaults(historyRetention ? { historyRetention } : {})
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agents({ answer: { model: 'fake', instructions: 'Answer.', builtinTools: false, input: z.string(), output: z.string() } })
    .build()
}

describe('durable conversation history', () => {
  it('retains whole newest turns rather than arbitrary individual messages', () => {
    const retained = retainCompleteTurns([
      message('user-1', 'user', 'first'),
      message('assistant-1', 'assistant', 'first answer'),
      message('user-2', 'user', 'second'),
      message('assistant-2', 'assistant', 'second answer')
    ], { maxTurns: 1 })

    expect(retained.map((entry) => entry.id)).toEqual(['user-2', 'assistant-2'])
  })

  it('rejects a newest complete turn that cannot fit without splitting it', () => {
    expect(() => retainCompleteTurns([
      message('user-1', 'user', 'x'.repeat(500)),
      message('assistant-1', 'assistant', 'done')
    ], { maxBytes: 20 })).toThrow(/newest complete conversation turn/i)
  })

  it('persists user and assistant as one rolling durable turn without duplicating rebuilt instructions', async () => {
    const provider = new FakeModelProvider()
    provider.enqueue({ object: 'first', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    provider.enqueue({ object: 'second', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const harness = buildHarness(provider, { maxTurns: 1 })
    const session = await harness.getSession('history')

    await session.agents.answer.prompt('first question')
    await session.agents.answer.prompt('second question')

    expect((await session.history.list()).map((entry) => [entry.role, entry.content])).toEqual([
      ['user', 'second question'],
      ['assistant', '"second"']
    ])
    expect(provider.requests[1]?.messages.filter((entry) => entry.role === 'system')).toHaveLength(1)
  })

  it('deduplicates a successful queue redelivery by caller-owned idempotency key', async () => {
    const provider = new FakeModelProvider()
    provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const harness = buildHarness(provider)
    const session = await harness.getSession('delivery')

    await expect(session.agents.answer.prompt('work', { idempotencyKey: 'queue-message-1' })).resolves.toBe('done')
    await expect(session.agents.answer.prompt('work', { idempotencyKey: 'queue-message-1' })).resolves.toBe('done')

    expect(provider.requests).toHaveLength(1)
    expect((await session.history.list()).map((entry) => entry.role)).toEqual(['user', 'assistant'])
  })

  it('scopes an idempotency key to its session and agent instead of rejecting another conversation', async () => {
    const provider = new FakeModelProvider()
    provider.enqueue({ object: 'first', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    provider.enqueue({ object: 'second', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const harness = buildHarness(provider)
    const first = await harness.getSession('first-conversation')
    const second = await harness.getSession('second-conversation')

    await expect(first.agents.answer.prompt('work', { idempotencyKey: 'queue-message-1' })).resolves.toBe('first')
    await expect(second.agents.answer.prompt('work', { idempotencyKey: 'queue-message-1' })).resolves.toBe('second')

    expect(provider.requests).toHaveLength(2)
    expect((await first.history.list()).map((entry) => entry.role)).toEqual(['user', 'assistant'])
    expect((await second.history.list()).map((entry) => entry.role)).toEqual(['user', 'assistant'])
  })

  it('replays a terminal stream lifecycle for an idempotent delivery without storage writes', async () => {
    const provider = new FakeModelProvider()
    const storage = new FakeHarnessStorage()
    provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const harness = defineHarness()
      .storage(storage)
      .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
      .agents({ answer: { model: 'fake', instructions: 'Answer.', builtinTools: false, input: z.string(), output: z.string() } })
      .build()
    const session = await harness.getSession('stream-redelivery')
    const options = { idempotencyKey: 'queue-message-stream' }

    await session.agents.answer.prompt('work', options)
    storage.resetOps()
    const events = []
    for await (const event of session.agents.answer.stream('work', options)) events.push(event)

    expect(events).toMatchObject([
      { type: 'run.started', runId: directAgentRunId('stream-redelivery', 'answer', 'queue-message-stream') },
      { type: 'run.finished', runId: directAgentRunId('stream-redelivery', 'answer', 'queue-message-stream'), output: 'done' }
    ])
    // Instance validation may read the session; replay still performs no writes.
    expect(storage.ops.filter(operation => operation !== 'getSession')).toEqual(['getRun'])
    expect(provider.requests).toHaveLength(1)
  })

  it('recovers a committed transcript after a crash before run terminalization without a second model call', async () => {
    const provider = new FakeModelProvider()
    const storage = new InMemoryHarnessStorage()
    const key = 'queue-message-2'
    const runId = directAgentRunId('crash-recovery', 'answer', key)
    const instanceId = '01J00000000000000000000004'
    await storage.upsertSession({
      id: 'crash-recovery',
      instanceId,
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
      runCount: 0,
      sandboxBinding: createSessionSandboxBinding({
        harnessName: 'agent-harness',
        record: { id: 'crash-recovery', instanceId }
      })
    }, 'create')
    await storage.createRun({ id: runId, sessionId: 'crash-recovery', kind: 'agent', target: 'answer', startedAt: '2026-08-19T00:00:00.000Z', status: 'running', input: 'work' })
    await storage.appendMessages('crash-recovery', [
      { ...message(`msg_${runId}_01_user`, 'user', 'work'), sessionId: 'crash-recovery', runId },
      { ...message(`msg_${runId}_99_assistant_final`, 'assistant', '"done"'), sessionId: 'crash-recovery', runId }
    ])
    const sandbox = inMemorySandbox()
    const sandboxScope = { owner: { namespace: 'agent-harness', id: 'crash-recovery', instanceId }, partition: { kind: 'shared' as const }, lifetime: 'session' as const }
    await sandbox.registerOwner({ owner: sandboxScope.owner, mode: 'create' })
    await sandbox.open({
      scope: sandboxScope,
      mode: 'create'
    })
    const harness = defineHarness()
      .storage(storage)
      .sandbox(sandbox)
      .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
      .agents({ answer: { model: 'fake', instructions: 'Answer.', builtinTools: false, input: z.string(), output: z.string() } })
      .build()
    const session = await harness.getSession('crash-recovery')

    await expect(session.agents.answer.prompt('work', { idempotencyKey: key })).resolves.toBe('done')
    expect(provider.requests).toHaveLength(0)
    await expect(storage.getRun(runId)).resolves.toMatchObject({ status: 'succeeded', output: 'done' })
  })
})

function directAgentRunId(sessionId: string, agentId: string, idempotencyKey: string): string {
  return `agent_${createHash('sha256').update(JSON.stringify([sessionId, agentId, idempotencyKey])).digest('hex')}`
}

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
  expect((await session.history.list()).map((entry) => entry.role)).toEqual(['user', 'assistant'])
})
