import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineWorkflow as defineWorkflowV4 } from '../src/definitions/workflow.js'
import { defineAgent as defineAgentV4 } from '../src/definitions/agent.js'
import type { ExecutionEvent } from '../src/definitions/execution-events.js'
import { createWorkflowExecutionRuntime } from '../src/workflows/index.js'

describe('v4 workflow fan-out admission', () => {
	it('bounds workers, preserves input order, and does not consume the workflow agent-call budget', async () => {
		const workflow = defineWorkflowV4('workersOnly', { input: z.string(), output: z.string(), agentCalls: { maxCalls: 1, maxParallel: 2 }, async handler({ input }) { return input } })
		let active = 0; let peak = 0; let opens = 0
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async () => { opens += 1; throw new Error('unexpected') } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'run', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		await expect(runtime.fanOut([1, 2, 3], async item => {
			active += 1
			peak = Math.max(peak, active)
			await new Promise(resolve => setTimeout(resolve, (4 - item) * 4))
			active -= 1
			return item * 2
		}, { concurrency: 9 })).resolves.toEqual([2, 4, 6])
		expect(peak).toBeLessThanOrEqual(2)
		expect(peak).toBe(2)
		expect(opens).toBe(0)
	})

	it('rejects invalid concurrency before starting work', async () => {
		const workflow = defineWorkflowV4('invalidConcurrency', {
			input: z.string(), output: z.string(),
			async handler({ input }) { return input },
		})
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async () => { throw new Error('unexpected') } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'run', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		await expect(runtime.fanOut(['x'], async value => value, { concurrency: 0 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
	})

	it('lets bounded fan-out workers make agent calls without acquiring a fan-out slot', async () => {
		const agent = defineAgentV4('fanWorker', { input: z.number(), output: z.number(), instructions: 'Work.', prompt: value => ({ role: 'user', content: String(value) }) })
		const workflow = defineWorkflowV4('fanCalls', { input: z.string(), output: z.string(), agents: [agent], agentCalls: { maxCalls: 3, maxParallel: 2 }, async handler({ input }) { return input } })
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async request => {
			const outcome = { status: 'completed' as const, runId: request.invocation.invocationId, output: (request.input as number) * 2 }
			return {
			result: Promise.resolve(outcome),
			async *[Symbol.asyncIterator]() { yield { eventId: 'event-1', sequence: 1, type: 'run.finished', runId: request.invocation.invocationId, parentRunId: request.invocation.parentRunId,
				parentInvocationId: request.invocation.invocationId, at: 'now', outcome } as ExecutionEvent }, async cancel() {},
			}
		} }, signal: new AbortController().signal, sessionId: 'session', runId: 'run', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 3, maxParallelWorkflowAgentCalls: 2 } })
		await expect(runtime.fanOut([1, 2, 3], (item, index) => runtime.agents.fanWorker.run(item, { callId: `fan-${index}` }), { concurrency: 2 })).resolves.toEqual([2, 4, 6])
	})
})
