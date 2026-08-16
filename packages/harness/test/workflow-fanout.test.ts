import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineHarness, inMemorySandbox } from '../src/index.js'
import { recordEvents } from '../src/testing/recordEvents.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

describe('workflow fan-out', () => {
  it('queues typed child invocations within the workflow delegation ceiling and preserves input order', async () => {
    let active = 0
    let peak = 0
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agents(({ agent }) => ({
        worker: agent({
          model: 'fake', input: z.number(), output: z.number(), builtinTools: false, instructions: 'Return input.',
          handler: async (ctx) => {
            active += 1
            peak = Math.max(peak, active)
            await new Promise((resolve) => setTimeout(resolve, (4 - ctx.input) * 4))
            active -= 1
            return ctx.input * 2
          }
        })
      }))
      .workflows(({ workflow }) => ({
        fan: workflow({
          input: z.array(z.number()), output: z.array(z.number()),
          delegation: { agents: ['worker'], maxParallelChildAgentCalls: 2 },
          handler: (ctx) => ctx.fanOut(ctx.input, (item) => ctx.agents.worker(item), { concurrency: 10 })
        })
      }))
      .build()

    const session = await harness.getSession('fanout')
    const events = await recordEvents(session.workflows.fan.stream([1, 2, 3]))

    expect(peak).toBe(2)
    expect(events.find((event) => event.type === 'fanout.started')).toMatchObject({ count: 3, concurrency: 2 })
    expect(events.find((event) => event.type === 'fanout.finished')).toMatchObject({ count: 3, status: 'succeeded' })
    const finished = events.find((event) => event.type === 'run.finished')
    expect(finished).toMatchObject({ output: [2, 4, 6] })
    await harness.shutdown()
  })

  it('rejects invalid fan-out concurrency before starting work', async () => {
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agents(({ agent }) => ({
        worker: agent({ model: 'fake', input: z.string(), output: z.string(), builtinTools: false, instructions: 'Return input.', handler: async (ctx) => ctx.input })
      }))
      .workflows(({ workflow }) => ({
        invalid: workflow({
          input: z.string(), output: z.array(z.string()), delegation: { agents: ['worker'] },
          handler: (ctx) => ctx.fanOut([ctx.input], (item) => ctx.agents.worker(item), { concurrency: 0 })
        })
      }))
      .build()

    const session = await harness.getSession('fanout-invalid')
    await expect(session.workflows.invalid.prompt('x')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await harness.shutdown()
  })
})
