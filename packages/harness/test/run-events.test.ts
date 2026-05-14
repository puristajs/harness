import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { defineHarness, inMemorySandbox, InMemoryStateStore } from '../src/index.js'

describe('run event persistence privacy', () => {
  it('redacts output content by default and keeps envelope fields outside payload', async () => {
    const state = new InMemoryStateStore()
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .state(state)
      .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({ wf: { input: z.string(), output: z.string(), handler: async (ctx) => `secret:${ctx.input}` } })
      .build()

    const session = await harness.getSession('s1')
    await session.workflows.wf.prompt('payload')
    const run = (await state.listRuns('s1'))[0]!
    const events = await state.listEvents(run.id)

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.finished', payload: { output: '[redacted]' } })
    ]))
    expect(JSON.stringify(events)).not.toContain('secret:payload')
    expect(events.some((event) => Object.prototype.hasOwnProperty.call(event.payload as object, 'runId'))).toBe(false)
    expect(events.some((event) => Object.prototype.hasOwnProperty.call(event.payload as object, 'at'))).toBe(false)
  })

  it('keeps persisted event content redacted even when a non-default telemetry content policy is configured', async () => {
    const state = new InMemoryStateStore()
    const harness = defineHarness()
      .telemetry({ contentCaptureMode: 'SPAN_AND_EVENT' })
      .sandbox(inMemorySandbox())
      .state(state)
      .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({ wf: { input: z.string(), output: z.string(), handler: async (ctx) => `secret:${ctx.input}` } })
      .build()

    const session = await harness.getSession('s1')
    await session.workflows.wf.prompt('payload')
    const run = (await state.listRuns('s1'))[0]!
    const events = await state.listEvents(run.id)

    expect(JSON.stringify(events)).not.toContain('secret:payload')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.finished', payload: { output: '[redacted]' } })
    ]))
  })
})
