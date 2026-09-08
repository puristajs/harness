import { describe, expect, it, vi } from 'vitest'

import { defineAgent } from '../src/definitions/agent.js'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import * as rootExports from '../src/index.js'
import * as integratorExports from '../src/integrator/index.js'
import { isHarnessTargetContract } from '../src/integrator/index.js'

function copyOwnDescriptors(value: object): object {
	const copy = {}
	for (const key of Reflect.ownKeys(value)) {
		Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(value, key)!)
	}
	return Object.freeze(copy)
}

describe('integrator target-contract authenticity', () => {
	it('accepts only the original agent and workflow contracts', () => {
		const agent = defineAgent('authenticAgent', { instructions: 'Answer.' })
		const workflow = defineWorkflow('authenticWorkflow', { async handler({ input }) { return input } })

		for (const contract of [agent.contract, workflow.contract]) {
			expect(isHarnessTargetContract(contract)).toBe(true)
		}
	})

	it('rejects plain, spread, reflective-descriptor, wrong-kind, and definition-object forgeries', () => {
		const agent = defineAgent('protectedAgent', { instructions: 'Answer.' })
		const tool = defineTool('notATarget', {
			description: 'Not a target.', input: agent.input, output: agent.output,
			async handler(_context, input) { return input },
		})
		const values = [
			{ kind: 'agent', id: agent.id },
			{ ...agent.contract },
			copyOwnDescriptors(agent.contract),
			tool,
			agent,
			{ ...agent },
			copyOwnDescriptors(agent),
		]

		for (const value of values) {
			expect(isHarnessTargetContract(value)).toBe(false)
		}
	})

	it('rejects an original contract created by another package instance', async () => {
		vi.resetModules()
		const foreignAgentModule = await import('../src/definitions/agent.js?foreign-package-instance')
		const foreign = foreignAgentModule.defineAgent('foreignAgent', { instructions: 'Answer.' })

		expect(isHarnessTargetContract(foreign.contract)).toBe(false)
	})

	it('exposes only the predicate from the integrator subpath and no root identity seam', () => {
		expect(rootExports).not.toHaveProperty('isHarnessTargetContract')
		expect(rootExports).not.toHaveProperty('assertHarnessTargetContract')
		expect(integratorExports).toHaveProperty('isHarnessTargetContract', isHarnessTargetContract)
		expect(integratorExports).not.toHaveProperty('assertHarnessTargetContract')
		expect(integratorExports).not.toHaveProperty('getDefinitionIdentity')
		expect(integratorExports).not.toHaveProperty('definitionReference')
		expect(integratorExports).not.toHaveProperty('targetContractToken')
	})
})
