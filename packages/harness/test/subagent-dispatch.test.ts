import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineAgent } from '../src/definitions/agent.js'
import { AgentLoopBudgetError, OperationCancelledError, OperationTimeoutError, ToolError, ValidationError } from '../src/errors/index.js'
import { createSubagentBinding } from '../src/runtime/subagent-execution.js'
import { isHarnessChildTargetInterruption } from '../src/runtime/steps.js'

function runtimeEvents(events: readonly any[]) {
	return events.map((event, index) => ({ eventId: `event-${index + 1}`, sequence: index + 1, ...event }))
}
function streamResult(events: readonly any[]) {
	const rootRunId = events[0]?.runId
	const terminal = events.findLast(event => event.type === 'run.finished' && event.runId === rootRunId)
	return terminal === undefined ? new Promise<never>(() => {}) : Promise.resolve(terminal.outcome)
}
function childStream(events: readonly any[], correlation?: { parentRunId: string; parentInvocationId: string }) {
	const authored = runtimeEvents(events)
	return { result: streamResult(authored), cancel: vi.fn(async () => {}), async *[Symbol.asyncIterator]() { yield* authored.map(event => ({ ...event, ...correlation })) } }
}
function trackedStream(events: readonly any[], failAt?: number) {
	const authored = runtimeEvents(events)
	let index = 0
	const cancel = vi.fn(async () => {})
	const close = vi.fn(async () => ({ done: true as const, value: undefined }))
	const iterator = {
		async next() {
			if (failAt === index) throw new Error('iterator failed')
			if (index >= authored.length) return { done: true as const, value: undefined }
			return { done: false as const, value: authored[index++] }
		},
		return: close,
	}
	return { stream: { result: streamResult(authored), cancel, [Symbol.asyncIterator]: () => iterator }, cancel, close }
}
function context(open: any, overrides: Record<string, unknown> = {}) {
	const correlatedOpen = async (request: any) => {
		const stream = await open(request)
		const producerResult = stream.result
		return {
			result: producerResult.then((outcome: any) => ({ ...outcome, runId: request.invocation.invocationId })),
			cancel: (reason?: string) => stream.cancel(reason),
			[Symbol.asyncIterator]() {
				const iterator = stream[Symbol.asyncIterator]()
				let authoredDirectRunId: string | undefined
				return {
					async next() {
						const result = await iterator.next()
						if (result.done) return result
						const raw = result.value
						authoredDirectRunId ??= raw.runId
					const preserve = raw.__preserveParent === true || Object.hasOwn(raw, 'parentRunId') || Object.hasOwn(raw, 'parentInvocationId')
					const preserveRunId = raw.__preserveRunId === true
					const { __preserveParent: _preserve, __preserveRunId: _preserveRunId, ...authoredEvent } = raw
					const directRunId = preserveRunId ? authoredDirectRunId : request.invocation.invocationId
					const event = preserveRunId ? authoredEvent : {
						...authoredEvent,
						runId: authoredEvent.runId === authoredDirectRunId ? directRunId : authoredEvent.runId,
						...(authoredEvent.parentRunId === authoredDirectRunId ? { parentRunId: directRunId } : {}),
						...(authoredEvent.outcome?.runId === authoredDirectRunId
							? { outcome: { ...authoredEvent.outcome, runId: directRunId } } : {}),
					}
						return { done: false as const, value: preserve ? event : { ...event, parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId } }
					},
					return: iterator.return?.bind(iterator),
				}
			},
		}
	}
	return { harnessName: 'h', sessionId: 'parent-session', runId: 'parent-run', rootRunId: 'root-run', invocationId: 'parent-invocation',
		agentId: 'parent', depth: 1, remainingDepth: 2, step: 1, toolId: 'analyst', callId: 'call-1', signal: new AbortController().signal,
		metadata: {}, logger: {}, metrics: {}, telemetry: {}, memory: {}, sandbox: {}, targetDispatcher: { assertTarget: target => testRoute(target), open: correlatedOpen }, relayChildEvent: vi.fn(async () => {}),
		checkpointStep: async (_id: string, work: () => Promise<unknown>) => work(), ...overrides }
}
function testRoute(target: { readonly kind: 'agent' | 'workflow'; readonly id: string }) {
	return { schemaVersion: 1 as const, kind: 'harness_target_route' as const, target: { kind: target.kind, id: target.id }, bindingDigest: `sha256:${'0'.repeat(64)}` }
}


describe('subagent execution', () => {
	it('creates a finalized binding, dispatches wire input, derives stable lineage, and relays the child stream', async () => {
		const child = defineAgent('riskAnalyst', { description: 'Analyze risk.', instructions: 'Analyze.', input: z.object({ value: z.string() }), output: z.object({ answer: z.string() }), prompt: value => ({ role: 'user', content: value.value }) })
		const events = [
			{ type: 'agent.started', runId: 'child-run', agentId: child.id, at: '2026-01-01T00:00:00.000Z' },
			{ type: 'run.finished', runId: 'child-run', at: '2026-01-01T00:00:00.000Z', outcome: { status: 'completed', runId: 'child-run', output: { answer: 'safe' } } },
		]
		const open = vi.fn(async request => childStream(events, { parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId }))
		const binding = createSubagentBinding('analyst', child)
		const identity = Object.freeze({ tenantId: 'tenant', principalId: 'principal' })
		const trace = Object.freeze({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' })
		const runtime = context(open, { identity, trace })
		await expect(binding.invokeValidated(runtime as never, { value: 'parsed' }, { value: 'wire' })).resolves.toEqual({ answer: 'safe' })
		const request = open.mock.calls[0]![0]
		expect(request.input).toEqual({ value: 'wire' })
		expect(request.invocation).toMatchObject({ parentRunId: 'parent-run', parentAgentId: 'parent', rootRunId: 'root-run', depth: 2, remainingDepth: 1 })
		expect(request.invocation.identity).toBe(identity)
		expect(request.invocation.trace).toBe(trace)
		expect(runtime.relayChildEvent).toHaveBeenCalledTimes(2)
		expect(runtime.relayChildEvent.mock.calls.map(([event]) => event.type)).toEqual(['agent.started', 'run.finished'])
		expect(binding).toMatchObject({ id: 'analyst', description: 'Analyze risk.', implementationKind: 'subagent', outputValidation: 'already-validated-target' })
		expect(Object.isFrozen(binding)).toBe(true)

		const repeat = context(open)
		await binding.invokeValidated(repeat as never, { value: 'parsed' }, { value: 'wire' })
		expect(open.mock.calls[1]![0].invocation).toMatchObject({ sessionId: request.invocation.sessionId, invocationId: request.invocation.invocationId })
		const otherCall = context(open, { callId: 'call-2' })
		await binding.invokeValidated(otherCall as never, { value: 'parsed' }, { value: 'wire' })
		expect(open.mock.calls[2]![0].invocation.invocationId).not.toBe(request.invocation.invocationId)
	})

	it('relays nested run terminals while consuming only the direct child terminal as its outcome', async () => {
		const child = defineAgent('workflowLikeChild', { instructions: 'Coordinate nested work.' })
		const events = [
			{ type: 'agent.started', eventId: 'root-1', sequence: 1, runId: 'child-run', agentId: child.id, at: 'x' },
			{ type: 'run.started', eventId: 'nested-1', sequence: 1, runId: 'nested-run', at: 'x',
				parentRunId: 'child-run', parentInvocationId: 'nested-invocation' },
			{ type: 'run.finished', eventId: 'nested-2', sequence: 2, runId: 'nested-run', at: 'x',
				parentRunId: 'child-run', parentInvocationId: 'nested-invocation',
				outcome: { status: 'completed', runId: 'nested-run', output: 'nested-result' } },
			{ type: 'run.finished', eventId: 'root-2', sequence: 2, runId: 'child-run', at: 'x',
				outcome: { status: 'completed', runId: 'child-run', output: 'root-result' } },
		]
		const runtime = context(async () => childStream(events))
		await expect(createSubagentBinding('workflowLikeDelegate', child).invokeValidated(runtime as never, 'x', 'x'))
			.resolves.toBe('root-result')
		expect(runtime.relayChildEvent.mock.calls.map(([event]) => event.type)).toEqual([
			'agent.started', 'run.started', 'run.finished', 'run.finished',
		])
		expect(runtime.relayChildEvent.mock.calls[0]![0].runId).toMatch(/^invocation_/)
		expect(runtime.relayChildEvent.mock.calls[3]![0].runId).toBe(runtime.relayChildEvent.mock.calls[0]![0].runId)
		expect(runtime.relayChildEvent.mock.calls[1]![0].runId).toBe('nested-run')
	})

	it('enforces descendant start, parent lifetime, and monotonic per-run sequences', async () => {
		const child = defineAgent('strictNestedChild', { instructions: 'Coordinate nested work.' })
		const cases = [
			[
				{ type: 'agent.started', eventId: 'root-1', sequence: 1, runId: 'child-run', agentId: child.id, at: 'x' },
				{ type: 'agent.started', eventId: 'nested-1', sequence: 1, runId: 'nested-run', agentId: child.id, at: 'x', parentRunId: 'child-run', parentInvocationId: 'nested-invocation' },
			],
			[
				{ type: 'agent.started', eventId: 'root-1', sequence: 1, runId: 'child-run', agentId: child.id, at: 'x' },
				{ type: 'run.started', eventId: 'nested-1', sequence: 2, runId: 'nested-run', at: 'x', parentRunId: 'child-run', parentInvocationId: 'nested-invocation' },
			],
			[
				{ type: 'agent.started', eventId: 'root-1', sequence: 1, runId: 'child-run', agentId: child.id, at: 'x' },
				{ type: 'agent.finished', eventId: 'root-duplicate', sequence: 1, runId: 'child-run', agentId: child.id, at: 'x' },
			],
			[
				{ type: 'agent.started', eventId: 'root-1', sequence: 1, runId: 'child-run', agentId: child.id, at: 'x' },
				{ type: 'run.started', eventId: 'nested-1', sequence: 1, runId: 'nested-run', at: 'x', parentRunId: 'child-run', parentInvocationId: 'nested-invocation' },
				{ type: 'run.finished', eventId: 'nested-2', sequence: 2, runId: 'nested-run', at: 'x', parentRunId: 'child-run', parentInvocationId: 'nested-invocation', outcome: { status: 'completed', runId: 'nested-run', output: 'done' } },
				{ type: 'run.started', eventId: 'grandchild-1', sequence: 1, runId: 'grandchild-run', at: 'x', parentRunId: 'nested-run', parentInvocationId: 'grandchild-invocation' },
			],
			[
				{ type: 'agent.started', eventId: 'root-1', sequence: 1, runId: 'child-run', agentId: child.id, at: 'x' },
				{ type: 'run.started', eventId: 'nested-1', sequence: 1, runId: 'nested-run', at: 'x', parentRunId: 'child-run', parentInvocationId: 'nested-invocation' },
				{ type: 'run.finished', eventId: 'root-2', sequence: 2, runId: 'child-run', at: 'x', outcome: { status: 'completed', runId: 'child-run', output: 'unsafe' } },
			],
		] as const
		for (const events of cases) {
			const tracked = trackedStream(events)
			const runtime = context(async () => tracked.stream)
			await expect(createSubagentBinding('strictNestedDelegate', child).invokeValidated(runtime as never, 'x', 'x'))
				.rejects.toBeInstanceOf(ValidationError)
			expect(tracked.cancel).toHaveBeenCalledTimes(1)
			expect(tracked.close).toHaveBeenCalledTimes(1)
		}

		const validGap = context(async () => childStream([
			{ type: 'agent.started', eventId: 'root-1', sequence: 1, runId: 'child-run', agentId: child.id, at: 'x' },
			{ type: 'run.started', eventId: 'nested-1', sequence: 1, runId: 'nested-run', at: 'x', parentRunId: 'child-run', parentInvocationId: 'nested-invocation' },
			{ type: 'run.finished', eventId: 'nested-7', sequence: 7, runId: 'nested-run', at: 'x', parentRunId: 'child-run', parentInvocationId: 'nested-invocation', outcome: { status: 'completed', runId: 'nested-run', output: 'done' } },
			{ type: 'run.finished', eventId: 'root-2', sequence: 2, runId: 'child-run', at: 'x', outcome: { status: 'completed', runId: 'child-run', output: 'root-result' } },
		]))
		await expect(createSubagentBinding('validGapDelegate', child).invokeValidated(validGap as never, 'x', 'x'))
			.resolves.toBe('root-result')
	})

	it('uses override, child, and exact fallback descriptions', () => {
		const described = defineAgent('described', { description: 'Child description.', instructions: 'Help.' })
		const bare = defineAgent('bareChild', { instructions: 'Help.' })
		expect(createSubagentBinding('a', { agent: described, description: 'Override.' }).description).toBe('Override.')
		expect(createSubagentBinding('b', described).description).toBe('Child description.')
		expect(createSubagentBinding('c', bare).description).toBe('Delegate to the "bareChild" agent.')
	})

	it('rejects exhausted depth before opening dispatch with the absolute ceiling', async () => {
		const child = defineAgent('child', { instructions: 'Help.' })
		const open = vi.fn()
		const binding = createSubagentBinding('child', child)
		await expect(binding.invokeValidated(context(open, { depth: 3, remainingDepth: 0 }) as never, 'x', 'x')).rejects.toMatchObject({
			constructor: AgentLoopBudgetError, meta: { reason: 'max_depth', limit: 3 },
		})
		expect(open).not.toHaveBeenCalled()
	})

	it.each([
		['missing', [], ValidationError],
		['duplicate', [
			{ type: 'run.finished', runId: 'r', at: 'x', outcome: { status: 'completed', runId: 'r', output: 'one' } },
			{ type: 'run.finished', runId: 'r', at: 'x', outcome: { status: 'completed', runId: 'r', output: 'two' } },
		], ValidationError],
		['cancelled', [{ type: 'run.finished', runId: 'r', at: 'x', outcome: { status: 'cancelled', runId: 'r', error: { code: 'X', message: 'secret' } } }], OperationCancelledError],
		['failed', [{ type: 'run.finished', runId: 'r', at: 'x', outcome: { status: 'failed', runId: 'r', error: { code: 'EVIL', message: 'secret', meta: { secret: true } } } }], ToolError],
	])('maps the %s child terminal safely', async (_name, events, ErrorType) => {
		const child = defineAgent('child', { instructions: 'Help.' })
		const binding = createSubagentBinding('delegate', child)
		await expect(binding.invokeValidated(context(async () => childStream(events)) as never, 'x', 'x')).rejects.toMatchObject({ constructor: ErrorType })
	})

	it('does not trust transported failure fields as local ToolError metadata', async () => {
		const child = defineAgent('failedChild', { instructions: 'Help.' })
		const binding = createSubagentBinding('safeDelegate', child)
		let thrown: unknown
		try { await binding.invokeValidated(context(async () => childStream([{ type: 'run.finished', runId: 'r', at: 'x', outcome: {
			status: 'failed', runId: 'r', error: { code: 'OPERATION_CANCELLED', category: 'cancelled', message: 'secret', meta: { principalId: 'secret' } },
		} }])) as never, 'x', 'x') } catch (error) { thrown = error }
		expect(thrown).toMatchObject({ constructor: ToolError, message: 'Subagent execution failed.', meta: { tool_id: 'safeDelegate', tool_kind: 'subagent' } })
		expect((thrown as ToolError).meta).toEqual({ tool_id: 'safeDelegate', tool_kind: 'subagent' })
	})

	it('cancels a non-cooperative child stream and preserves canonical cancellation', async () => {
		const child = defineAgent('slowChild', { instructions: 'Help.' })
		const cancel = vi.fn(async () => {})
		const close = vi.fn(async () => ({ done: true as const, value: undefined }))
		const hanging = { result: new Promise<never>(() => {}), cancel, [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<any>>(() => {}), return: close } } }
		const controller = new AbortController()
		const binding = createSubagentBinding('slowDelegate', child)
		const execution = binding.invokeValidated(context(async () => hanging, { signal: controller.signal }) as never, 'x', 'x').catch(error => error)
		await Promise.resolve()
		controller.abort('private reason')
		await expect(execution).resolves.toMatchObject({ constructor: OperationCancelledError, message: 'Subagent execution was cancelled.', meta: { scope: 'agent' } })
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(close).toHaveBeenCalledTimes(1)
	})

	it('preserves a canonical timeout while cleaning a non-cooperative child stream', async () => {
		const child = defineAgent('timedChild', { instructions: 'Help.' })
		const controller = new AbortController()
		const cancel = vi.fn(async () => {})
		const close = vi.fn(async () => ({ done: true as const, value: undefined }))
		const hanging = { result: new Promise<never>(() => {}), cancel, [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<any>>(() => {}), return: close } } }
		const timeout = new OperationTimeoutError('Tool execution timed out.', { scope: 'tool', timeout_ms: 5 })
		const execution = createSubagentBinding('timedDelegate', child).invokeValidated(context(async () => hanging, { signal: controller.signal }) as never, 'x', 'x').catch(error => error)
		await Promise.resolve()
		controller.abort(timeout)
		await expect(execution).resolves.toBe(timeout)
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(close).toHaveBeenCalledTimes(1)
	})

	it.each([
		['duplicate terminal', [
			{ type: 'run.finished', runId: 'r', at: 'x', outcome: { status: 'completed', runId: 'r', output: 'one' } },
			{ type: 'run.finished', runId: 'r', at: 'x', outcome: { status: 'completed', runId: 'r', output: 'two' } },
		], 0],
		['event after terminal', [
			{ type: 'run.finished', runId: 'r', at: 'x', outcome: { status: 'completed', runId: 'r', output: 'one' } },
			{ type: 'agent.started', runId: 'r', agentId: 'child', at: 'x' },
		], 0],
		['malformed event', [{ type: 'made.up', runId: 'r' }], 0],
		['partial known event', [{ type: 'agent.started', runId: 'r', at: 'x' }], 0],
		['malformed terminal', [{ type: 'run.finished', runId: 'r', at: 'x', extra: true, outcome: { status: 'completed', runId: 'r', output: 'x' } }], 0],
		['malformed interrupt', [{ type: 'run.finished', runId: 'r', at: 'x', outcome: { status: 'interrupted', runId: 'r', interrupt: { type: 'tool-approval', id: 'a', requests: [] } } }], 0],
	] as const)('rejects %s before unsafe relay and cleans up', async (_name, events, relayCount) => {
		const child = defineAgent('protocolChild', { instructions: 'Help.' })
		const tracked = trackedStream(events)
		const runtime = context(async () => tracked.stream)
		await expect(createSubagentBinding('protocolDelegate', child).invokeValidated(runtime as never, 'x', 'x')).rejects.toBeInstanceOf(ValidationError)
		expect(runtime.relayChildEvent).toHaveBeenCalledTimes(relayCount)
		expect(tracked.cancel).toHaveBeenCalledTimes(1)
		expect(tracked.close).toHaveBeenCalledTimes(1)
	})

	it('rejects inconsistent run correlation without relaying the bad event', async () => {
		const child = defineAgent('correlationChild', { instructions: 'Help.' })
		const tracked = trackedStream([
			{ type: 'agent.started', runId: 'first-run', agentId: child.id, at: 'x' },
			{ type: 'run.finished', runId: 'other-run', at: 'x', outcome: { status: 'completed', runId: 'other-run', output: 'ok' } },
		])
		const runtime = context(async () => tracked.stream)
		await expect(createSubagentBinding('correlationDelegate', child).invokeValidated(runtime as never, 'x', 'x')).rejects.toBeInstanceOf(ValidationError)
		expect(runtime.relayChildEvent).toHaveBeenCalledTimes(1)
		expect(tracked.cancel).toHaveBeenCalledTimes(1)
		expect(tracked.close).toHaveBeenCalledTimes(1)
	})

	it('rejects a dispatcher that substitutes the runtime-authored direct run id', async () => {
		const child = defineAgent('substitutedRunChild', { instructions: 'Help.' })
		const tracked = trackedStream([{ type: 'run.finished', runId: 'substituted-run', __preserveRunId: true, at: 'x',
			outcome: { status: 'completed', runId: 'substituted-run', output: 'unsafe' } }])
		const runtime = context(async () => tracked.stream)
		await expect(createSubagentBinding('substitutedRunDelegate', child).invokeValidated(runtime as never, 'x', 'x'))
			.rejects.toBeInstanceOf(ValidationError)
		expect(runtime.relayChildEvent).not.toHaveBeenCalled()
		expect(tracked.cancel).toHaveBeenCalledTimes(1)
		expect(tracked.close).toHaveBeenCalledTimes(1)
	})

	it('rejects a producer result that disagrees with the direct terminal before relaying it', async () => {
		const child = defineAgent('mismatchedResultChild', { instructions: 'Help.' })
		const tracked = trackedStream([{ type: 'run.finished', runId: 'r', at: 'x',
			outcome: { status: 'completed', runId: 'r', output: 'event-output' } }])
		Object.defineProperty(tracked.stream, 'result', {
			value: Promise.resolve({ status: 'completed', runId: 'r', output: 'result-output' }),
		})
		const runtime = context(async () => tracked.stream)
		await expect(createSubagentBinding('mismatchedResultDelegate', child).invokeValidated(runtime as never, 'x', 'x'))
			.rejects.toMatchObject({ meta: { issues: { reason: 'invalid_terminal' } } })
		expect(runtime.relayChildEvent).not.toHaveBeenCalled()
		expect(tracked.cancel).toHaveBeenCalledTimes(1)
		expect(tracked.close).toHaveBeenCalledTimes(1)
	})

	it('observes producer result rejection while the iterator hangs and awaits cleanup', async () => {
		const child = defineAgent('rejectedResultChild', { instructions: 'Help.' })
		const cancel = vi.fn(async () => {})
		const close = vi.fn(async () => ({ done: true as const, value: undefined }))
		const primary = new Error('private producer failure')
		const stream = {
			result: Promise.reject(primary),
			cancel,
			[Symbol.asyncIterator]() {
				return { next: () => new Promise<IteratorResult<any>>(() => {}), return: close }
			},
		}
		const execution = createSubagentBinding('rejectedResultDelegate', child)
			.invokeValidated(context(async () => stream) as never, 'x', 'x')
		await expect(execution).rejects.toBe(primary)
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(close).toHaveBeenCalledTimes(1)
	})

	it('rejects and cleans up when iteration ends after a terminal but producer result remains pending', async () => {
		const child = defineAgent('pendingResultChild', { instructions: 'Help.' })
		const tracked = trackedStream([{ type: 'run.finished', runId: 'r', at: 'x',
			outcome: { status: 'completed', runId: 'r', output: 'event-output' } }])
		Object.defineProperty(tracked.stream, 'result', { value: new Promise<never>(() => {}) })
		const runtime = context(async () => tracked.stream)
		await expect(createSubagentBinding('pendingResultDelegate', child).invokeValidated(runtime as never, 'x', 'x'))
			.rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { issues: { reason: 'missing_terminal' } } })
		expect(runtime.relayChildEvent).not.toHaveBeenCalled()
		expect(tracked.cancel).toHaveBeenCalledTimes(1)
		expect(tracked.close).toHaveBeenCalledTimes(1)
	})

	it.each([
		['both parent fields missing', { __preserveParent: true }],
		['parent invocation missing', { parentRunId: 'parent-run' }],
		['wrong parent run', { parentRunId: 'wrong', parentInvocationId: 'wrong' }],
		['wrong parent invocation', { parentRunId: 'parent-run', parentInvocationId: 'wrong' }],
	] as const)('rejects %s before relaying', async (_name, parent) => {
		const child = defineAgent('parentCorrelationChild', { instructions: 'Help.' })
		const tracked = trackedStream([{ type: 'agent.started', runId: 'r', agentId: child.id, at: 'x', ...parent }])
		const runtime = context(async () => tracked.stream)
		await expect(createSubagentBinding('parentCorrelationDelegate', child).invokeValidated(runtime as never, 'x', 'x'))
			.rejects.toBeInstanceOf(ValidationError)
		expect(runtime.relayChildEvent).not.toHaveBeenCalled()
	})

	it('relays nested child-task lifecycle only with exact immediate-parent correlation', async () => {
		const child = defineAgent('nestedTaskCorrelationChild', { instructions: 'Help.' })
		const tracked = trackedStream([
			{ type: 'run.started', sequence: 1, runId: 'r', at: 'x' },
			{ type: 'run.started', sequence: 1, runId: 'nested', parentRunId: 'r', parentInvocationId: 'nested-invocation', at: 'x' },
			{ type: 'child_task.started', sequence: 2, runId: 'nested', parentRunId: 'r', parentInvocationId: 'nested-invocation',
				taskId: 'task', at: 'x', workflowId: 'flow', agentId: 'worker', contextPolicy: 'isolated', mode: 'one_shot' },
			{ type: 'run.finished', sequence: 3, runId: 'nested', parentRunId: 'r', parentInvocationId: 'nested-invocation', at: 'x',
				outcome: { status: 'completed', runId: 'nested', output: 'nested-output' } },
			{ type: 'run.finished', sequence: 2, runId: 'r', at: 'x', outcome: { status: 'completed', runId: 'r', output: 'output' } },
		])
		const runtime = context(async () => tracked.stream)
		await expect(createSubagentBinding('nestedTaskCorrelationDelegate', child).invokeValidated(runtime as never, 'x', 'x'))
			.resolves.toBe('output')
		const childTask = runtime.relayChildEvent.mock.calls.map(([event]) => event)
			.find(event => event.type === 'child_task.started')
		expect(childTask).toMatchObject({ runId: 'nested', parentRunId: expect.any(String), parentInvocationId: 'nested-invocation' })
	})

	it('cleans up iterator and relay failures without masking the primary error', async () => {
		const child = defineAgent('cleanupChild', { instructions: 'Help.' })
		const iteratorFailure = trackedStream([], 0)
		await expect(createSubagentBinding('iteratorDelegate', child).invokeValidated(context(async () => iteratorFailure.stream) as never, 'x', 'x')).rejects.toThrow('iterator failed')
		expect(iteratorFailure.cancel).toHaveBeenCalledTimes(1)
		expect(iteratorFailure.close).toHaveBeenCalledTimes(1)

		const relayFailure = trackedStream([{ type: 'agent.started', runId: 'r', agentId: child.id, at: 'x' }])
		const runtime = context(async () => relayFailure.stream, { relayChildEvent: vi.fn(async () => { throw new Error('relay failed') }) })
		await expect(createSubagentBinding('relayDelegate', child).invokeValidated(runtime as never, 'x', 'x')).rejects.toThrow('relay failed')
		expect(runtime.relayChildEvent).toHaveBeenCalledTimes(1)
		expect(relayFailure.cancel).toHaveBeenCalledTimes(1)
		expect(relayFailure.close).toHaveBeenCalledTimes(1)
	})

	it('awaits asynchronous cancel and iterator cleanup before rethrowing the exact primary error', async () => {
		const child = defineAgent('deferredCleanupChild', { instructions: 'Help.' })
		const primary = new Error('primary iterator failure')
		let resolveCancel!: () => void
		let resolveReturn!: () => void
		const cancel = vi.fn(() => new Promise<void>(resolve => { resolveCancel = resolve }))
		const close = vi.fn(() => new Promise<IteratorResult<any>>(resolve => { resolveReturn = () => resolve({ done: true, value: undefined }) }))
		const stream = { result: new Promise<never>(() => {}), cancel, [Symbol.asyncIterator]() { return { next: async () => { throw primary }, return: close } } }
		let settled = false
		const execution = createSubagentBinding('deferredCleanupDelegate', child).invokeValidated(context(async () => stream) as never, 'x', 'x')
			.then(() => undefined, error => error).finally(() => { settled = true })
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1))
		expect(close).toHaveBeenCalledTimes(1)
		expect(settled).toBe(false)
		resolveCancel()
		await Promise.resolve()
		expect(settled).toBe(false)
		resolveReturn()
		await expect(execution).resolves.toBe(primary)
	})

	it('throws the private child interruption with child invocation id', async () => {
		const child = defineAgent('child', { instructions: 'Help.' })
		const binding = createSubagentBinding('delegate', child)
		let thrown: unknown
		try { await binding.invokeValidated(context(async () => childStream([{ type: 'run.finished', runId: 'r', at: 'x', outcome: { status: 'interrupted', runId: 'r', interrupt: { type: 'tool-approval', id: 'a', revision: 'v1', requests: [] } } }])) as never, 'x', 'x') } catch (error) { thrown = error }
		expect(isHarnessChildTargetInterruption(thrown)).toBe(true)
		expect(thrown).toMatchObject({ childInvocationId: expect.any(String), outcome: { status: 'interrupted' } })
	})
})
