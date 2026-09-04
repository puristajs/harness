import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineAgent } from '../src/definitions/agent.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { HarnessConfigError, ValidationError } from '../src/errors/index.js'
import { createLocalTargetDispatcher } from '../src/runtime/local-target-dispatcher.js'

function stream(events: readonly any[]) {
	return { cancel: vi.fn(async () => {}), async *[Symbol.asyncIterator]() { yield* events } }
}

describe('local target dispatcher', () => {
	it('routes by exact hidden contract identity, validates once, and clamps remaining depth', async () => {
		let validations = 0
		const input = z.string().transform(value => { validations += 1; return { value } })
		let outputValidations = 0
		const output = z.string().transform(value => { outputValidations += 1; return { answer: value } })
		const child = defineAgent('child', { instructions: 'Answer.', input, output, prompt: value => ({ role: 'user', content: value.value }), loop: { maxDepth: 2 } })
		const execute = vi.fn(async (request: any) => stream([
			{ type: 'run.finished', runId: 'child-run', at: '2026-01-01T00:00:00.000Z', outcome: { status: 'completed', runId: 'child-run', output: { answer: 'ok' } } },
		]))
		const dispatcher = createLocalTargetDispatcher({ defaultMaxDepth: 5, bindings: [{ definition: child, execute }] })
		const controller = new AbortController()
		const identity = { tenantId: 'tenant', principalId: 'principal' }
		const trace = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }
		const opened = await dispatcher.open({ target: child.contract, input: 'hello', invocation: {
			sessionId: 'session', invocationId: 'invocation', rootRunId: 'root', parentRunId: 'parent', depth: 1,
			remainingDepth: 4, identity, trace, signal: controller.signal,
		} })
		const events = []
		for await (const event of opened) events.push(event)
		expect(validations).toBe(1)
		expect(outputValidations).toBe(0)
		expect(execute).toHaveBeenCalledWith(expect.objectContaining({ input: { value: 'hello' }, invocation: expect.objectContaining({ depth: 1, remainingDepth: 2 }) }))
		const trusted = execute.mock.calls[0]![0].invocation
		expect(trusted.identity).toEqual(identity)
		expect(trusted.identity).not.toBe(identity)
		expect(Object.isFrozen(trusted.identity)).toBe(true)
		expect(trusted.trace).toEqual(trace)
		expect(trusted.trace).not.toBe(trace)
		expect(Object.isFrozen(trusted.trace)).toBe(true)
		expect(Object.isFrozen(trusted)).toBe(true)
		expect(events.at(-1)).toMatchObject({ outcome: { status: 'completed', output: { answer: 'ok' } } })
	})

	it('rejects copied, unknown, and same-address foreign contracts without dispatch', async () => {
		const first = defineAgent('sameId', { instructions: 'First.' })
		const foreign = defineAgent('sameId', { instructions: 'Second.' })
		const execute = vi.fn(async () => stream([]))
		const dispatcher = createLocalTargetDispatcher({ defaultMaxDepth: 1, bindings: [{ definition: first, execute }] })
		const invocation = { sessionId: 's', invocationId: 'i', rootRunId: 'r', parentRunId: 'p', depth: 1, remainingDepth: 0, signal: new AbortController().signal }
		for (const target of [{ ...first.contract }, foreign.contract, defineAgent('other', { instructions: 'Other.' }).contract]) {
			await expect(dispatcher.open({ target: target as never, input: 'x', invocation })).rejects.toMatchObject({ constructor: HarnessConfigError, meta: { reason: 'foreign_definition' } })
		}
		expect(execute).not.toHaveBeenCalled()
	})

	it('rejects invalid wire input at the receiving boundary', async () => {
		const child = defineWorkflow('childWorkflow', { input: z.object({ id: z.string() }), output: z.string(), async handler() { return 'ok' } })
		const dispatcher = createLocalTargetDispatcher({ defaultMaxDepth: 1, bindings: [{ definition: child, execute: async () => stream([]) }] })
		await expect(dispatcher.open({ target: child.contract, input: { id: 1 } as never, invocation: {
			sessionId: 's', invocationId: 'i', rootRunId: 'r', parentRunId: 'p', depth: 1, remainingDepth: 0, signal: new AbortController().signal,
		} })).rejects.toBeInstanceOf(ValidationError)
	})
})
