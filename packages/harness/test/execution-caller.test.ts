import { describe, expect, it } from 'vitest'

import { projectHarnessExecutionCaller } from '../src/runtime/execution-caller.js'

describe('Harness execution caller projection', () => {
	it('copies and freezes exact agent and workflow callers', () => {
		const agent = projectHarnessExecutionCaller({ kind: 'agent', agentId: 'worker', workflowId: 'flow' })
		const workflow = projectHarnessExecutionCaller({ kind: 'workflow', workflowId: 'flow' })
		expect(agent).toEqual({ kind: 'agent', agentId: 'worker', workflowId: 'flow' })
		expect(workflow).toEqual({ kind: 'workflow', workflowId: 'flow' })
		expect(Object.isFrozen(agent)).toBe(true)
		expect(Object.isFrozen(workflow)).toBe(true)
	})

	it.each([
		{},
		{ kind: 'agent' },
		{ kind: 'workflow' },
		{ kind: 'agent', agentId: 'agent', workflowId: 'flow', extra: true },
		{ kind: 'workflow', workflowId: 'flow', agentId: 'agent' },
	])('rejects erased neither, incomplete, mixed, and widened callers', value => {
		expect(() => projectHarnessExecutionCaller(value)).toThrow(TypeError)
	})
})
