import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createHash } from 'node:crypto'

import { defineAgent } from '../src/definitions/agent.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { HarnessConfigError, HarnessTargetRouteReceiptMismatchError, ValidationError } from '../src/errors/index.js'
import { canonicalJson } from '../src/runtime/canonical-json.js'
import { createLocalTargetDispatcher } from '../src/runtime/local-target-dispatcher.js'

function stream(events: readonly any[]) {
	return { cancel: vi.fn(async () => {}), async *[Symbol.asyncIterator]() { yield* events } }
}

describe('local target dispatcher', () => {
	it('returns the executor stream unchanged so cancellation reaches the target', async () => {
		const child = defineAgent('cancellableChild', { instructions: 'Answer.' })
		const cancel = vi.fn(async (_reason?: string) => {})
		const targetStream = { cancel, async *[Symbol.asyncIterator]() {} }
		const dispatcher = createLocalTargetDispatcher({
			defaultMaxDepth: 1,
			routeBindingRevision: 'deploy-1:graph-a',
			bindings: [{ definition: child, execute: async () => targetStream }],
		})
		const opened = await dispatcher.open({ target: child.contract, input: 'hello', invocation: {
			sessionId: 'session', invocationId: 'child-run', rootRunId: 'root', parentRunId: 'parent',
			parentAgentId: 'parent-agent', depth: 1, remainingDepth: 0, signal: new AbortController().signal,
		} })
		await opened.cancel('transport disconnected')
		expect(opened).toBe(targetStream)
		expect(cancel).toHaveBeenCalledWith('transport disconnected')
	})

	it('routes by exact hidden contract identity, validates once, and clamps remaining depth', async () => {
		let validations = 0
		const input = z.string().transform(value => { validations += 1; return { value } })
		let outputValidations = 0
		const output = z.string().transform(value => { outputValidations += 1; return { answer: value } })
		const child = defineAgent('child', { instructions: 'Answer.', input, output, responseMode: 'text', prompt: value => ({ role: 'user', content: value.value }), loop: { maxDepth: 2 } })
		const execute = vi.fn(async (request: any) => stream([
			{ type: 'run.finished', runId: 'child-run', at: '2026-01-01T00:00:00.000Z', outcome: { status: 'completed', runId: 'child-run', output: { answer: 'ok' } } },
		]))
		const dispatcher = createLocalTargetDispatcher({ defaultMaxDepth: 5, routeBindingRevision: 'deploy-1:graph-a', bindings: [{ definition: child, execute }] })
		const controller = new AbortController()
		const identity = { tenantId: 'tenant', principalId: 'principal' }
		const trace = { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' }
		const opened = await dispatcher.open({ target: child.contract, input: 'hello', invocation: {
			sessionId: 'session', invocationId: 'invocation', rootRunId: 'root', parentRunId: 'parent', parentAgentId: 'parent-agent', depth: 1,
			remainingDepth: 4, identity, trace, signal: controller.signal,
		} })
		const events = []
		for await (const event of opened) events.push(event)
		expect(validations).toBe(1)
		expect(outputValidations).toBe(0)
		expect(execute).toHaveBeenCalledWith(expect.objectContaining({ delivery: 'fresh', input: { value: 'hello' }, wireInput: 'hello', invocation: expect.objectContaining({ depth: 1, remainingDepth: 2 }) }))
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
		const dispatcher = createLocalTargetDispatcher({ defaultMaxDepth: 1, routeBindingRevision: 'deploy-1:graph-a', bindings: [{ definition: first, execute }] })
		const invocation = { sessionId: 's', invocationId: 'i', rootRunId: 'r', parentRunId: 'p', parentAgentId: 'parent-agent', depth: 1, remainingDepth: 0, signal: new AbortController().signal }
		for (const target of [{ ...first.contract }, foreign.contract, defineAgent('other', { instructions: 'Other.' }).contract]) {
			await expect(dispatcher.open({ target: target as never, input: 'x', invocation })).rejects.toMatchObject({ constructor: HarnessConfigError, meta: { reason: 'foreign_definition' } })
		}
		expect(execute).not.toHaveBeenCalled()
	})

	it('rejects invalid wire input at the receiving boundary', async () => {
		const child = defineWorkflow('childWorkflow', { input: z.object({ id: z.string() }), output: z.string(), async handler() { return 'ok' } })
		const dispatcher = createLocalTargetDispatcher({ defaultMaxDepth: 1, routeBindingRevision: 'deploy-1:graph-a', bindings: [{ definition: child, execute: async () => stream([]) }] })
		await expect(dispatcher.open({ target: child.contract, input: { id: 1 } as never, invocation: {
				sessionId: 's', invocationId: 'i', rootRunId: 'r', parentRunId: 'p', parentWorkflowId: 'parent-workflow', depth: 1, remainingDepth: 0, signal: new AbortController().signal,
		} })).rejects.toBeInstanceOf(ValidationError)
	})

	it('returns one canonical deeply frozen route receipt and binds it to the route revision', () => {
		const child = defineAgent('receiptChild', { instructions: 'Answer.' })
		const dispatcher = createLocalTargetDispatcher({
			defaultMaxDepth: 1,
			routeBindingRevision: 'deploy-1:graph-a',
			bindings: [{ definition: child, execute: async () => stream([]) }],
		})
		const receipt = dispatcher.assertTarget(child.contract)
		const expectedDigest = `sha256:${createHash('sha256').update(canonicalJson([
			'harness.target-route-binding.v1', 'harness.local', 'deploy-1:graph-a', 'agent', 'receiptChild',
		])).digest('hex')}`

		expect(receipt).toEqual({
			schemaVersion: 1,
			kind: 'harness_target_route',
			target: { kind: 'agent', id: 'receiptChild' },
			bindingDigest: expectedDigest,
		})
		expect(dispatcher.assertTarget(child.contract)).toBe(receipt)
		expect(Object.isFrozen(receipt)).toBe(true)
		expect(Object.isFrozen(receipt.target)).toBe(true)

		const changed = createLocalTargetDispatcher({
			defaultMaxDepth: 1,
			routeBindingRevision: 'deploy-2:graph-a',
			bindings: [{ definition: child, execute: async () => stream([]) }],
		})
		expect(changed.assertTarget(child.contract).bindingDigest).not.toBe(receipt.bindingDigest)
	})

	it('opens a persisted route without re-running input transforms and forwards the exact resume', async () => {
		let validations = 0
		const child = defineAgent('persistedChild', {
			instructions: 'Answer.',
			input: z.string().transform(value => { validations += 1; return { value } }),
			prompt: value => ({ role: 'user', content: value.value }),
		})
		const execute = vi.fn(async () => stream([]))
		const dispatcher = createLocalTargetDispatcher({
			defaultMaxDepth: 2,
			routeBindingRevision: 'deploy-1:graph-a',
			bindings: [{ definition: child, execute }],
		})
		const route = dispatcher.assertTarget(child.contract)
		const signal = new AbortController().signal
		const resume = Object.freeze({
			type: 'tool-approval' as const,
			runId: 'child-run',
			interruptId: 'interrupt-1',
			revision: 'revision-1',
			eventId: 'event-1',
			decisions: Object.freeze([{ approvalId: 'approval-1', approved: true }]),
		})
		const invocation = { sessionId: 'child-session', invocationId: 'child-run', rootRunId: 'root', parentRunId: 'parent', parentAgentId: 'parent-agent', depth: 1, remainingDepth: 1, signal }

		await dispatcher.openPersisted({ route, wireInput: 'hello', resume, invocation })

		expect(validations).toBe(0)
		expect(execute).toHaveBeenCalledWith(expect.objectContaining({ delivery: 'resume', wireInput: 'hello', resume }))
		expect(execute.mock.calls[0]![0]).not.toHaveProperty('input')
		expect(execute.mock.calls[0]![0].resume).toBe(resume)
	})

	it('rejects malformed, unknown, and revision-stale persisted receipts before validation or execution', async () => {
		let validations = 0
		const child = defineAgent('staleChild', {
			instructions: 'Answer.',
			input: z.string().transform(value => { validations += 1; return value }),
			prompt: value => ({ role: 'user', content: value }),
		})
		const execute = vi.fn(async () => stream([]))
		const current = createLocalTargetDispatcher({ defaultMaxDepth: 1, routeBindingRevision: 'deploy-2', bindings: [{ definition: child, execute }] })
		const prior = createLocalTargetDispatcher({ defaultMaxDepth: 1, routeBindingRevision: 'deploy-1', bindings: [{ definition: child, execute: async () => stream([]) }] })
		const invocation = { sessionId: 's', invocationId: 'child-run', rootRunId: 'root', parentRunId: 'parent', parentAgentId: 'parent-agent', depth: 1, remainingDepth: 0, signal: new AbortController().signal }
		const resume = { type: 'tool-approval' as const, runId: 'child-run', interruptId: 'i', revision: 'r', eventId: 'e', decisions: [] }

		await expect(current.openPersisted({ route: prior.assertTarget(child.contract), wireInput: 'secret', resume, invocation }))
			.rejects.toMatchObject({ constructor: HarnessTargetRouteReceiptMismatchError, code: 'HARNESS_TARGET_ROUTE_RECEIPT_MISMATCH', meta: {
				reason: 'route_receipt_mismatch', target_kind: 'agent', target_id: 'staleChild',
			} })
		await expect(current.openPersisted({ route: { ...current.assertTarget(child.contract), extra: true } as never, wireInput: 'secret', resume, invocation }))
			.rejects.toMatchObject({ constructor: HarnessConfigError, meta: { reason: 'invalid_target_dispatch', path: 'targetDispatcher.route' } })
		expect(validations).toBe(0)
		expect(execute).not.toHaveBeenCalled()
	})

	it('rejects persisted resume run correlation before validation or execution', async () => {
		let validations = 0
		const child = defineWorkflow('resumeChild', {
			input: z.string().transform(value => { validations += 1; return value }),
			output: z.string(), async handler() { return 'ok' },
		})
		const execute = vi.fn(async () => stream([]))
		const dispatcher = createLocalTargetDispatcher({ defaultMaxDepth: 1, routeBindingRevision: 'deploy-1', bindings: [{ definition: child, execute }] })
		await expect(dispatcher.openPersisted({
			route: dispatcher.assertTarget(child.contract), wireInput: 'secret',
			resume: { type: 'tool-approval', runId: 'another-run', interruptId: 'i', revision: 'r', eventId: 'e', decisions: [] },
			invocation: { sessionId: 's', invocationId: 'child-run', rootRunId: 'root', parentRunId: 'parent', parentWorkflowId: 'parent-workflow', depth: 1, remainingDepth: 0, signal: new AbortController().signal },
		})).rejects.toMatchObject({ constructor: HarnessConfigError, meta: { reason: 'invalid_target_dispatch', path: 'targetDispatcher.resume.runId' } })
		expect(validations).toBe(0)
		expect(execute).not.toHaveBeenCalled()
	})

	it('rejects invalid route revisions and duplicate logical routes at construction', () => {
		const first = defineAgent('duplicateRoute', { instructions: 'First.' })
		const second = defineAgent('duplicateRoute', { instructions: 'Second.' })
		expect(() => createLocalTargetDispatcher({ defaultMaxDepth: 1, routeBindingRevision: '', bindings: [] }))
			.toThrowError(HarnessConfigError)
		expect(() => createLocalTargetDispatcher({ defaultMaxDepth: 1, routeBindingRevision: 'deploy-1', bindings: [
			{ definition: first, execute: async () => stream([]) },
			{ definition: second, execute: async () => stream([]) },
		] })).toThrowError(HarnessConfigError)
	})
})
