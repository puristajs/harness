import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineAgent, defineHarness } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/index.js'

describe('v4 Harness lifecycle entrypoint', () => {
  it('binds a portable definition and executes its typed agent', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObject({
      object: { answer: 'ready' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    const answer = defineAgent('answer', {
      input: z.string(), output: z.object({ answer: z.string() }),
      instructions: 'Answer briefly.', prompt: input => ({ role: 'user', content: input }),
    })
    const instance = await defineHarness({ name: 'lifecycleHarness' }).addAgent(answer)
      .getInstance({ model: { provider, model: 'fake' } })
    const session = await instance.getSession('conversation')

    await expect(session.agents.answer.run('status')).resolves.toMatchObject({
      status: 'completed', output: { answer: 'ready' },
    })
    expect((await session.history.list()).map(message => message.role)).toEqual(expect.arrayContaining(['user', 'assistant']))
    await session.destroy()
    await instance.close()
  })

  it('exposes the same target through the cancellable v4 event stream', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueTextStream([
      { kind: 'delta', text: 'hello' },
      { kind: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' },
    ])
    const answer = defineAgent('streamAnswer', {
      input: z.string(), instructions: 'Answer briefly.', prompt: input => ({ role: 'user', content: input }),
    })
    const instance = await defineHarness({ name: 'streamLifecycleHarness' }).addAgent(answer)
      .getInstance({ model: { provider, model: 'fake' } })
    const session = await instance.getSession('stream-conversation')
    const stream = session.agents.streamAnswer.stream('status')
    const events = []
    for await (const event of stream) events.push(event)

    expect(events.map(event => event.type)).toEqual(expect.arrayContaining([
      'run.started', 'output.text.delta', 'run.finished',
    ]))
    expect(events.at(-1)).toMatchObject({ type: 'run.finished', outcome: { status: 'completed', output: 'hello' } })
    await session.destroy()
    await instance.close()
  })
})
