import { describe, expect, it } from 'vitest'
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
})
