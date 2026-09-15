import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineAgent } from '../src/definitions/agent.js'
import { HarnessConfigError } from '../src/errors/index.js'
import { defineTool } from '../src/definitions/tool.js'

describe('v4 agent execution definitions', () => {
	it('snapshots agent governance and derives native effects', () => {
		const lookup = defineTool('lookup', { description: 'Lookup.', input: z.object({ id: z.string() }), output: z.string(), async handler() { return 'ok' } })
		const agent = defineAgent('governed', { model: 'chat', instructions: 'Use tools.', tools: [lookup], governance: ({ native, rule }) => ({
			policies: [native({ id: 'review-lookups', rules: [rule({ id: 'review', tools: ['lookup'], effect: 'require_approval' })] })],
		}) })
		expect(agent.governance?.policies?.[0]?.effects).toEqual(['require_approval'])
		expect(Object.isFrozen(agent.governance?.policies?.[0]?.effects)).toBe(true)
	})

	it('rejects unknown selectors and external evaluators without declared effects', () => {
		const lookup = defineTool('lookup', { description: 'Lookup.', input: z.string(), output: z.string(), async handler(input) { return input } })
		expect(() => defineAgent('badSelector', { model: 'chat', instructions: 'Use tools.', tools: [lookup], governance: {
			policies: [{ kind: 'native', id: 'policy', effects: ['allow'], rules: [{ id: 'rule', tools: ['missing'], effect: 'allow' }] }],
		} as never })).toThrow(HarnessConfigError)
		expect(() => defineAgent('badEvaluator', { model: 'chat', instructions: 'Use tools.', governance: {
			policies: [{ id: 'external', evaluate: () => ({ effect: 'allow' }) }],
		} as never })).toThrow(HarnessConfigError)
	})

	it.each([
		{ policies: [{ kind: 'native', id: 'policy', rules: [{ id: '', effect: 'allow' }] }] },
		{ policies: [{ kind: 'native', id: 'policy', version: '', rules: [{ id: 'rule', effect: 'allow' }] }] },
		{ policies: [{ id: 'external', effects: [], evaluate: () => ({ effect: 'allow' }) }] },
		{ policies: [{ id: 'external', effects: ['allow', 'allow'], evaluate: () => ({ effect: 'allow' }) }] },
		{ policies: [{ id: 'external', engine: '\u0000bad', effects: ['allow'], evaluate: () => ({ effect: 'allow' }) }] },
		{ policies: [{ kind: 'native', id: 'policy', rules: [{ id: 'rule', description: ' ', effect: 'allow' }] }] },
		{ policies: [{ kind: 'native', id: 'policy', rules: [{ id: 'rule', effect: 'allow', reasonCode: 'Bad-Code' }] }] },
		{ exposure: { rules: [{ id: 'rule', effect: 'hide', unknown: true }] } },
	])('rejects recursively malformed governance %#', governance => {
		expect(() => defineAgent('malformedGovernance', { model: 'chat', instructions: 'Reject.', governance: governance as never })).toThrow(HarnessConfigError)
	})

	it('rejects class-instance governance records', () => {
		class GovernanceRecord { enabled = true }
		expect(() => defineAgent('classGovernance', { model: 'chat', instructions: 'Reject.', governance: new GovernanceRecord() as never })).toThrow(HarnessConfigError)
	})

	it('rejects symbol keys at every governance object boundary', () => {
		const hidden = Symbol('hidden')
		const governance = { enabled: true, [hidden]: true }
		const nested = { policies: [{ kind: 'native', id: 'policy', rules: [{ id: 'rule', effect: 'allow', [hidden]: true }] }] }
		expect(() => defineAgent('symbolGovernance', { model: 'chat', instructions: 'Reject.', governance: governance as never })).toThrow(HarnessConfigError)
		expect(() => defineAgent('nestedSymbolGovernance', { model: 'chat', instructions: 'Reject.', governance: nested as never })).toThrow(HarnessConfigError)
	})

	it.each([
		[{ policies: [
			{ kind: 'native', id: 'duplicatePolicy', rules: [{ id: 'firstRule', effect: 'allow' }] },
			{ kind: 'native', id: 'duplicatePolicy', rules: [{ id: 'secondRule', effect: 'allow' }] },
		] }, 'agent.governance.policies.1.id'],
		[{ policies: [{ kind: 'native', id: 'nativePolicy', rules: [
			{ id: 'duplicateRule', effect: 'allow' }, { id: 'duplicateRule', effect: 'deny' },
		] }] }, 'agent.governance.policies.0.rules.1.id'],
		[{ exposure: { id: 'exposurePolicy', rules: [
			{ id: 'duplicateExposure', effect: 'expose' }, { id: 'duplicateExposure', effect: 'hide' },
		] } }, 'agent.governance.exposure.rules.1.id'],
	])('rejects duplicate effective governance source ids at the deterministic path %#', (governance, path) => {
		expect(() => defineAgent('duplicateGovernance', { model: 'chat', instructions: 'Reject.', governance: governance as never })).toThrow(expect.objectContaining({
			constructor: HarnessConfigError, meta: expect.objectContaining({ path }),
		}))
	})

	it.each([
		{ policies: [{ kind: 'native', id: 'mismatchPolicy', effects: ['allow'], rules: [{ id: 'reviewRule', effect: 'require_approval' }] }] },
		{ policies: [{ kind: 'native', id: 'mismatchPolicy', effects: ['require_approval'], rules: [{ id: 'allowRule', effect: 'allow' }] }] },
	])('rejects a separately authored native effects declaration %#', governance => {
		expect(() => defineAgent('mismatchedEffects', { model: 'chat', instructions: 'Reject.', governance: governance as never })).toThrow(expect.objectContaining({
			constructor: HarnessConfigError, meta: expect.objectContaining({ path: 'agent.governance.policies.0' }),
		}))
	})
})
