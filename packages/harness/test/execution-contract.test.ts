import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineHarness, inMemorySandbox } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { HarnessConfigError } from '../src/errors/index.js'
import { defineHarness as defineV4Harness } from '../src/definitions/harness.js'
import { defineAgent as defineV4Agent } from '../src/definitions/agent.js'

describe('portable execution contract', () => {
	it('resolves one frozen v4 defaults snapshot and preserves it through composition', () => {
		const definition = defineV4Harness({ name: 'defaultsHarness', defaults: { maxSteps: 4, historyWindow: 0 } })
		const next = definition.addAgent(defineV4Agent('answerAgent', { instructions: 'Answer.' }))
		expect(definition.defaults).toMatchObject({ maxSteps: 4, historyWindow: 0, maxToolCalls: 32 })
		expect(Object.isFrozen(definition.defaults)).toBe(true)
		expect(next.defaults).toBe(definition.defaults)
		expect(() => defineV4Harness({ name: 'badDefaults', defaults: { maxSteps: 0 } })).toThrow(HarnessConfigError)
	})

	it('rejects symbol and unknown execution-default keys at exact closed paths', () => {
		const hidden = Symbol('hidden')
		for (const [defaults, path] of [
			[{ [hidden]: true }, 'harness.defaults'],
			[{ unexpected: true }, 'harness.defaults.unexpected'],
			[{ contextProjection: { [hidden]: true, toolResultPruner: { maxBytes: 10, headBytes: 4, tailBytes: 4 } } }, 'harness.defaults.contextProjection'],
			[{ contextProjection: { toolResultPruner: { maxBytes: 10, headBytes: 4, tailBytes: 4, unexpected: true } } }, 'harness.defaults.contextProjection.toolResultPruner.unexpected'],
			[{ historyRetention: { maxTurns: 1, [hidden]: true } }, 'harness.defaults.historyRetention'],
		] as const) {
			try {
				defineV4Harness({ name: 'closedDefaults', defaults: defaults as never })
				throw new Error('Expected invalid defaults.')
			} catch (error) {
				expect(error).toBeInstanceOf(HarnessConfigError)
				expect((error as HarnessConfigError).meta).toMatchObject({ reason: 'invalid_execution_defaults', path })
			}
		}
	})
  it('projects only declared text updates and ends with the same completed outcome as run()', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueTextStream([
      { kind: 'delta', text: 'hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'finish', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' },
    ])

    const definition = defineHarness({ name: 'portable-stream' })
      .requireModel('primary', { capabilities: ['text_stream'] })
      .agent('answer', {
        input: z.string(),
        output: z.string(),
        updates: 'text-delta',
        handler: async (ctx) => {
          let output = ''
          for await (const chunk of ctx.models.primary.textStream(
            { messages: [{ role: 'user', content: ctx.input }] },
            ctx.signal,
            { emitRunEvents: true },
          )) {
            if (chunk.kind === 'delta') output += chunk.text
          }
          return output
        },
      })
      .define()

    const harness = await definition.getInstance({
      models: { primary: { provider, model: 'fake' } },
      sandbox: inMemorySandbox(),
    })
    const session = await harness.getSession('execution-stream')
    const events = []
    for await (const event of session.agents.answer.stream('hello')) events.push(event)

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'output.text.delta',
      'output.text.delta',
      'run.finished',
    ])
    expect(events.slice(1, 3)).toEqual([
      expect.objectContaining({ type: 'output.text.delta', delta: 'hel' }),
      expect.objectContaining({ type: 'output.text.delta', delta: 'lo' }),
    ])
    const terminal = events.at(-1)
    expect(terminal).toMatchObject({
      type: 'run.finished',
      outcome: { status: 'completed', output: 'hello' },
    })
    if (terminal?.type === 'run.finished') expect(terminal.runId).toBe(terminal.outcome.runId)

    await harness.shutdown()
  })

  it('keeps model diagnostics out of the portable stream', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObject({
      object: 'done',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ primary: { provider, model: 'fake', capabilities: ['object'] } })
      .agent('answer', {
        model: 'primary',
        input: z.string(),
        output: z.string(),
        instructions: 'Answer.',
        builtinTools: false,
      })
      .build()
    const session = await harness.getSession('diagnostic-split')
    const execution = []
    for await (const event of session.agents.answer.stream('hello')) execution.push(event)

    expect(execution.map((event) => event.type)).toEqual(['run.started', 'run.finished'])
    expect(execution.some((event) => event.type === ('model.completed' as never))).toBe(false)
    await harness.shutdown()
  })
})
