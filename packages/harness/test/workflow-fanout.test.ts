import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineHarness, inMemorySandbox } from '../src/index.js'
import { recordEvents } from '../src/testing/recordEvents.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { defineWorkflow as defineWorkflowV4 } from '../src/definitions/workflow.js'
import { defineAgent as defineAgentV4 } from '../src/definitions/agent.js'
import type { ExecutionEvent } from '../src/definitions/execution-events.js'
import { createWorkflowExecutionRuntime } from '../src/workflows/index.js'

describe('workflow fan-out', () => {
  it('queues typed child invocations within the workflow delegation ceiling and preserves input order', async () => {
    let active = 0
    let peak = 0
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.number(),
        output: z.number(),
        builtinTools: false,
        instructions: 'Return input.',
        handler: async (ctx) => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, (4 - ctx.input) * 4))
          active -= 1
          return ctx.input * 2
        },
      })
      .workflow('fan', {
        input: z.array(z.number()),
        output: z.array(z.number()),
        delegation: { agents: ['worker'], maxParallelChildAgentCalls: 2 },
        handler: (ctx) => ctx.fanOut(ctx.input, (item) => ctx.agents.worker(item), { concurrency: 10 }),
      })
      .build()

    const session = await harness.getSession('fanout')
    const events = await recordEvents(session.workflows.fan.observe([1, 2, 3]))

    expect(peak).toBe(2)
    expect(events.find((event) => event.type === 'fanout.started')).toMatchObject({ count: 3, concurrency: 2 })
    expect(events.find((event) => event.type === 'fanout.finished')).toMatchObject({ count: 3, status: 'succeeded' })
    const finished = events.find((event) => event.type === 'run.finished')
    expect(finished).toMatchObject({ output: [2, 4, 6] })
    await harness.shutdown()
  })

  it('rejects invalid fan-out concurrency before starting work', async () => {
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return input.',
        handler: async (ctx) => ctx.input,
      })
      .workflow('invalid', {
        input: z.string(),
        output: z.array(z.string()),
        delegation: { agents: ['worker'] },
        handler: (ctx) => ctx.fanOut([ctx.input], (item) => ctx.agents.worker(item), { concurrency: 0 }),
      })
      .build()

    const session = await harness.getSession('fanout-invalid')
    await expect(session.workflows.invalid.run('x')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await harness.shutdown()
  })
})

describe('v4 workflow fan-out admission', () => {
	it('bounds workers without consuming workflow agent-call budget', async () => {
		const workflow = defineWorkflowV4('workersOnly', { input: z.string(), output: z.string(), agentCalls: { maxCalls: 1, maxParallel: 2 }, async handler({ input }) { return input } })
		let active = 0; let peak = 0; let opens = 0
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async () => { opens += 1; throw new Error('unexpected') } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'run', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		await expect(runtime.fanOut([1, 2, 3], async item => { active += 1; peak = Math.max(peak, active); await Promise.resolve(); active -= 1; return item * 2 }, { concurrency: 9 })).resolves.toEqual([2, 4, 6])
		expect(peak).toBeLessThanOrEqual(2)
		expect(opens).toBe(0)
	})

	it('lets bounded fan-out workers make agent calls without acquiring a fan-out slot', async () => {
		const agent = defineAgentV4('fanWorker', { input: z.number(), output: z.number(), instructions: 'Work.', prompt: value => ({ role: 'user', content: String(value) }) })
		const workflow = defineWorkflowV4('fanCalls', { input: z.string(), output: z.string(), agents: { worker: agent }, agentCalls: { maxCalls: 3, maxParallel: 2 }, async handler({ input }) { return input } })
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async request => ({
			async *[Symbol.asyncIterator]() { yield { type: 'run.finished', runId: `child-${request.invocation.invocationId}`, parentRunId: request.invocation.parentRunId,
				parentInvocationId: request.invocation.invocationId, at: 'now', outcome: { status: 'completed', runId: `child-${request.invocation.invocationId}`, output: (request.input as number) * 2 } } as ExecutionEvent }, async cancel() {},
		}) as any }, signal: new AbortController().signal, sessionId: 'session', runId: 'run', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 3, maxParallelWorkflowAgentCalls: 2 } })
		await expect(runtime.fanOut([1, 2, 3], (item, index) => runtime.agents.worker.run(item, { callId: `fan-${index}` }), { concurrency: 2 })).resolves.toEqual([2, 4, 6])
	})
})
