import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defineHarness, inMemorySandbox, InMemoryStateStore } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

describe('emitted message id uniqueness', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('assigns unique ids to messages emitted within the same millisecond', async () => {
    // Freeze the clock so any message id derived from Date.now() alone would collide.
    // ulid() keeps ids unique within a millisecond by incrementing its random suffix.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    const model = new FakeModelProvider()
    model.enqueueObject({ object: 'first', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    model.enqueueObject({ object: 'second', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

    const state = new InMemoryStateStore()
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .state(state)
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools({})
      .skills({})
      .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false } })
      .workflows({
        wf: {
          input: z.string(),
          output: z.string(),
          // Two agent calls in one run emit two assistant messages in the same ms.
          // Before the fix this rejected with StateError "Duplicate message id."
          handler: async (ctx) => {
            const a = await ctx.agents.a1(ctx.input)
            const b = await ctx.agents.a1(ctx.input)
            return `${a},${b}`
          }
        }
      })
      .build()

    const session = await harness.getSession('s1')
    await expect(session.workflows.wf.prompt('go')).resolves.toBe('first,second')

    const messages = await state.listMessages('s1')
    const ids = messages.map((message) => message.id)
    expect(ids.length).toBeGreaterThanOrEqual(2)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
