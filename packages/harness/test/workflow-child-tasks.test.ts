import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  defineHarness,
  inMemorySandbox,
  type ChildTaskHandle,
  type ContinuableChildTaskHandle,
  type RunOutcome,
	StateError,
} from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { defineAgent as defineAgentV4 } from '../src/definitions/agent.js'
import { defineTool as defineToolV4 } from '../src/definitions/tool.js'
import { defineWorkflow as defineWorkflowV4 } from '../src/definitions/workflow.js'
import type { ExecutionEvent } from '../src/definitions/execution-events.js'
import type { HarnessTargetDispatcher } from '../src/ports/target-dispatcher.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'
import { createWorkflowExecutionRuntime } from '../src/workflows/index.js'

function completedOutput<T>(outcome: RunOutcome<T>): T {
  if (outcome.status !== 'completed') throw new Error('Expected the test run to complete.')
  return outcome.output
}

describe('workflow child tasks', () => {
  it('starts an isolated, workflow-owned task that can settle after its starter workflow', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObject({
      object: 'done',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    let handle: ChildTaskHandle<string> | undefined
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return done.',
      })
      .workflow('launch', {
        input: z.string(),
        output: z.string(),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => {
          handle = await ctx.childTasks.start('worker', ctx.input)
          return handle.id
        },
      })
      .build()

    const session = await harness.getSession('task-owner')
    await session.replaceHistory([{ role: 'user', content: 'older private parent secret' }])
    const taskId = completedOutput(await session.workflows.launch.run('private parent context'))
    expect(handle?.id).toBe(taskId)
    await expect(handle?.result()).resolves.toBe('done')
    await expect(handle?.status()).resolves.toMatchObject({
      status: 'succeeded',
      descriptor: { contextPolicy: 'isolated', parentRunId: expect.any(String) },
    })

    const summary = await session.getRunSummary(taskId)
    expect(summary).toMatchObject({ status: 'succeeded', agentCalls: 1 })
    // The child's request has only its direct input; parent workflow history is not forwarded.
    expect(provider.requests[0]).toMatchObject({
      messages: expect.not.arrayContaining([expect.objectContaining({ content: 'older private parent secret' })]),
    })
    await harness.shutdown()
  })

  it('cancels a live task without cancelling a later workflow invocation', async () => {
    let handle: ChildTaskHandle<string> | undefined
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Wait.',
        handler: async (ctx) =>
          new Promise<string>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
          }),
      })
      .workflow('launch', {
        input: z.string(),
        output: z.string(),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => {
          handle = await ctx.childTasks.start('worker', ctx.input)
          return handle.id
        },
      })
      .workflow('healthy', { input: z.string(), output: z.string(), handler: async (ctx) => ctx.input })
      .build()

    const session = await harness.getSession('task-cancel')
    const taskId = completedOutput(await session.workflows.launch.run('work'))
    // The task is deliberately independent of its completed starter workflow.
    await expect(session.workflows.healthy.run('next')).resolves.toMatchObject({ status: 'completed', output: 'next' })
    expect(taskId).toMatch(/^task_/)
    await handle?.cancel('test shutdown')
    await expect(handle?.status()).resolves.toMatchObject({ status: 'cancelled' })
    await harness.shutdown()
  })

  it('queues background tasks under the delegation ceiling instead of rejecting them', async () => {
    let active = 0
    let peak = 0
    const handles: ChildTaskHandle<string>[] = []
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Wait.',
        handler: async (ctx) => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 10))
          active -= 1
          return ctx.input
        },
      })
      .workflow('launch', {
        input: z.array(z.string()),
        output: z.array(z.string()),
        delegation: { agents: ['worker'], maxParallelChildAgentCalls: 1 },
        handler: async (ctx) => {
          handles.push(...(await Promise.all(ctx.input.map((input) => ctx.childTasks.start('worker', input)))))
          return handles.map((handle) => handle.id)
        },
      })
      .build()

    const session = await harness.getSession('task-queue')
    await session.workflows.launch.run(['one', 'two'])
    await expect(Promise.all(handles.map((handle) => handle.result()))).resolves.toEqual(['one', 'two'])
    expect(peak).toBe(1)
    await harness.shutdown()
  })

  it('atomically coalesces concurrent starts with the same idempotency key', async () => {
    let executions = 0
    const handles: ChildTaskHandle<string>[] = []
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return.',
        handler: async (ctx) => {
          executions += 1
          await new Promise((resolve) => setTimeout(resolve, 10))
          return ctx.input
        },
      })
      .workflow('launch', {
        input: z.string(),
        output: z.array(z.string()),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => {
          handles.push(
            ...(await Promise.all([
              ctx.childTasks.start('worker', ctx.input, { idempotencyKey: 'same-key' }),
              ctx.childTasks.start('worker', ctx.input, { idempotencyKey: 'same-key' }),
            ])),
          )
          return handles.map((handle) => handle.id)
        },
      })
      .build()
    const session = await harness.getSession('task-idempotency')
    const ids = completedOutput(await session.workflows.launch.run('one'))
    expect(new Set(ids).size).toBe(1)
    await expect(Promise.all(handles.map((handle) => handle.result()))).resolves.toEqual(['one', 'one'])
    expect(executions).toBe(1)
    await harness.shutdown()
  })

  it('keeps a continuable task-owned history and exposes it through the session owner', async () => {
    let task: ContinuableChildTaskHandle<string, string> | undefined
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Echo.',
        handler: async (ctx) => `${(await ctx.history.list()).length}:${ctx.input}`,
      })
      .workflow('launch', {
        input: z.string(),
        output: z.string(),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => {
          task = await ctx.childTasks.start('worker', ctx.input, { mode: 'continuable' })
          return task.id
        },
      })
      .build()

    const session = await harness.getSession('task-continuable')
    const taskId = completedOutput(await session.workflows.launch.run('first'))
    await expect(task?.send('second')).resolves.toBe('2:second')
    await expect(task?.close()).resolves.toBe('2:second')
    await expect(task?.result()).resolves.toBe('2:second')
    await expect(session.childTasks.get(taskId)).resolves.toBeDefined()
    await expect((await session.childTasks.get(taskId))?.result()).resolves.toBe('2:second')
    await expect(session.childTasks.list()).resolves.toContainEqual(
      expect.objectContaining({ status: 'succeeded', descriptor: expect.objectContaining({ mode: 'continuable' }) }),
    )
    await harness.shutdown()
  })
})

function terminalStream(request: Parameters<HarnessTargetDispatcher['open']>[0], output: unknown) {
	return { async *[Symbol.asyncIterator]() { yield { type: 'run.finished', runId: 'task-agent-run', parentRunId: request.invocation.parentRunId,
		parentInvocationId: request.invocation.invocationId, at: 'now', outcome: { status: 'completed', runId: 'task-agent-run', output } } as ExecutionEvent }, async cancel() {} }
}

describe('v4 workflow child-task runtime', () => {
	it('settles a one-shot task and persists the exact child-task record', async () => {
		const agent = defineAgentV4('v4worker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('v4flow', { input: z.string(), output: z.string(), agents: { worker: agent }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage()
		const events: ExecutionEvent[] = []
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, storage, targetDispatcher: { open: async request => terminalStream(request, 'done') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { events.push(event) } })
		const task = await runtime.childTasks.start('worker', 'input', { callId: 'task' })
		await expect(task.result()).resolves.toBe('done')
		await expect(task.status()).resolves.toMatchObject({ status: 'succeeded', descriptor: { callId: 'task', workflowInvocationId: 'workflow-invocation' } })
		await expect(storage.getRun(task.id)).resolves.toMatchObject({ kind: 'child_task', status: 'succeeded', input: 'input', output: 'done',
			metadata: { schemaVersion: 1, kind: 'workflow_child_task', context: 'isolated', mode: 'one_shot' } })
		expect(events.filter(event => event.type === 'child_task.started')).toHaveLength(1)
		expect(events.filter(event => event.type === 'child_task.settled')).toHaveLength(1)
	})

	it('rejects approval-capable tasks before storage, budget, events, or dispatch', async () => {
		const tool = defineToolV4('bash', { description: 'Danger.', input: z.string(), output: z.string(), async handler(_context, input) { return input } })
		const agent = defineAgentV4('approvalWorker', { instructions: 'Ask.', tools: [tool], permissions: { bash: 'require_approval' } })
		const workflow = defineWorkflowV4('approvalFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, async handler({ input }) { return input } })
		let opened = 0; const events: ExecutionEvent[] = []; const storage = new InMemoryHarnessStorage()
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, storage, targetDispatcher: { open: async () => { opened += 1; throw new Error('unexpected') } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { events.push(event) } })
		await expect(runtime.childTasks.start('worker', 'input', { callId: 'task' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { issues: { reason: 'approval_capable_child_task_unsupported' } } })
		expect(opened).toBe(0); expect(events).toHaveLength(0); await expect(storage.listRuns('session')).resolves.toEqual([])
	})

	it('rejects exhausted child-task depth before reservation, storage, event, or dispatch', async () => {
		const agent = defineAgentV4('depthWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('depthFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0; const events: ExecutionEvent[] = []
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, storage, targetDispatcher: { open: async () => { opened += 1; throw new Error('unexpected') } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 3, remainingDepth: 0,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { events.push(event) } })
		await expect(runtime.childTasks.start('worker', 'input', { callId: 'task' })).rejects.toMatchObject({ code: 'AGENT_LOOP_BUDGET_EXCEEDED', meta: { reason: 'max_depth', limit: 3 } })
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 0 }); expect(opened).toBe(0); expect(events).toEqual([])
		await expect(storage.listRuns('session')).resolves.toEqual([])
	})

	it('uses one lifetime timeout and exposes typed continuable FIFO turns', async () => {
		const agent = defineAgentV4('chatWorker', { input: z.string(), output: z.string(), instructions: 'Chat.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('chatFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, async handler({ input }) { return input } })
		const seen: string[] = []; const sessions: string[] = []
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async request => { seen.push(request.input as string); sessions.push(request.invocation.sessionId); return terminalStream(request, `${request.input}!`) as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 3, maxParallelWorkflowAgentCalls: 1 } })
		const task = await runtime.childTasks.start('worker', 'first', { callId: 'chat', mode: 'continuable' })
		await expect(task.send('second')).resolves.toBe('second!')
		await expect(task.close()).resolves.toBe('second!')
		await expect(task.result()).resolves.toBe('second!')
		expect(seen).toEqual(['first', 'second'])
		expect(new Set(sessions)).toEqual(new Set([sessions[0]]))
		expect(sessions[0]).not.toBe('session')
		await expect(task.send('late')).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'terminal' } })
	})

	it('keeps continuable sends FIFO and lets cancellation overtake an uncommitted close', async () => {
		const agent = defineAgentV4('raceWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('raceFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, async handler({ input }) { return input } })
		const opened: string[] = []
		let slowOpened!: () => void
		const slowStarted = new Promise<void>(resolve => { slowOpened = resolve })
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async request => {
			opened.push(request.input as string)
			if (request.input === 'slow') { slowOpened(); return new Promise((_resolve, reject) => request.invocation.signal.addEventListener('abort', () => reject(request.invocation.signal.reason), { once: true })) }
			return terminalStream(request, `${request.input}!`) as any
		} }, signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 3, maxParallelWorkflowAgentCalls: 1 } })
		const task = await runtime.childTasks.start('worker', 'first', { callId: 'race', mode: 'continuable' }) as ContinuableChildTaskHandle<string, string>
		const slow = task.send('slow'); const queued = task.send('queued'); const closing = task.close()
		await slowStarted; await task.cancel()
		await expect(slow).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
		await expect(queued).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
		await expect(closing).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
		await expect(task.result()).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
		expect(opened).toEqual(['first', 'slow'])
		await expect(task.status()).resolves.toMatchObject({ status: 'cancelled' })
	})

	it('uses exact invoke-option reasons and resolves durable replay before cancellation', async () => {
		const agent = defineAgentV4('reasonWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('reasonFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, durable: true, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0
		const build = (signal = new AbortController().signal) => createWorkflowExecutionRuntime({ workflow, models: {}, storage, durable: true,
			targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 'done') as any } }, signal,
			sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 4, maxParallelWorkflowAgentCalls: 1 } })
		await expect(build().childTasks.start('worker', 'x', { callId: 'bad id', idempotencyKey: 'stable' })).rejects.toMatchObject({ meta: { issues: { reason: 'invalid_workflow_call_id' } } })
		await expect(build().childTasks.start('worker', 'x', { callId: 'ok', idempotencyKey: 'bad key' })).rejects.toMatchObject({ meta: { issues: { reason: 'invalid_child_task_idempotency_key' } } })
		await expect(build().childTasks.start('worker', 'x', { callId: 'ok' })).rejects.toMatchObject({ meta: { issues: { reason: 'child_task_idempotency_key_required' } } })
		await expect(build().childTasks.start('worker', 'x', { callId: 'ok', mode: 'continuable' } as any)).rejects.toMatchObject({ meta: { issues: { reason: 'durable_continuable_child_task_unsupported' } } })
		await expect(build().childTasks.start('worker', 'x', { callId: 'ok', idempotencyKey: 'stable', timeoutMs: 0 })).rejects.toMatchObject({ meta: { issues: { reason: 'invalid_child_task_timeout' } } })
		await expect(build().childTasks.start('worker', 'x', { callId: 'ok', idempotencyKey: 'stable', context: 'shared' } as any)).rejects.toMatchObject({ meta: { issues: { reason: 'invalid_child_task_context' } } })
		const first = await build().childTasks.start('worker', 'x', { callId: 'ok', idempotencyKey: 'stable' }); await first.result()
		const aborted = new AbortController(); aborted.abort('late')
		await expect((await build(aborted.signal).childTasks.start('worker', 'x', { callId: 'ok', idempotencyKey: 'stable' })).result()).resolves.toBe('done')
		expect(opened).toBe(1)
	})

	it('replays durable terminal handles and detects stable tuple collisions', async () => {
		const agent = defineAgentV4('durableWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('durableFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, durable: true, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0
		const build = () => createWorkflowExecutionRuntime({ workflow, models: {}, storage, durable: true, targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 'persisted') as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'durable-parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 } })
		const first = await build().childTasks.start('worker', 'same', { callId: 'task', idempotencyKey: 'stable' })
		await expect(first.result()).resolves.toBe('persisted')
		const replay = await build().childTasks.start('worker', 'same', { callId: 'task', idempotencyKey: 'stable' })
		expect(replay.id).toBe(first.id)
		await expect(replay.result()).resolves.toBe('persisted')
		expect(opened).toBe(1)
		await expect(build().childTasks.start('worker', 'changed', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({
			code: 'CHILD_TASK_CONFLICT', meta: { reason: 'idempotency_key_reused', agent_id: 'durableWorker', call_id: 'task' },
		})
	})

	it('validates durable task persisted identity before reconstruction', async () => {
		const agent = defineAgentV4('strictWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('strictFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, durable: true, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage()
		const build = () => createWorkflowExecutionRuntime({ workflow, models: {}, storage, durable: true, targetDispatcher: { open: async request => terminalStream(request, 'valid') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 } })
		const task = await build().childTasks.start('worker', 'input', { callId: 'task', idempotencyKey: 'stable' }); await task.result()
		const stored = await storage.getRun(task.id); expect(stored).toBeDefined()
		const originalGet = storage.getRun.bind(storage)
		for (const timestamp of ['', 'not-a-timestamp', '2026-01-01T00:00:00Z']) {
			storage.getRun = async id => id === task.id ? { ...stored!, startedAt: timestamp, metadata: { ...stored!.metadata!, createdAt: timestamp } } : originalGet(id)
			await expect(build().childTasks.start('worker', 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
			storage.getRun = async id => id === task.id ? { ...stored!, finishedAt: timestamp } : originalGet(id)
			await expect(build().childTasks.start('worker', 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
		}
		storage.getRun = async id => id === task.id ? { ...stored!, output: () => 42 } as any : originalGet(id)
		await expect(build().childTasks.start('worker', 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
		storage.getRun = async id => id === task.id ? { ...stored!, metadata: { ...stored!.metadata!, idempotencyKey: 'other' } } : originalGet(id)
		await expect(build().childTasks.start('worker', 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_CONFLICT', meta: { reason: 'idempotency_key_reused' } })
		storage.getRun = async id => id === task.id ? { ...stored!, id: 'task_wrong' } : originalGet(id)
		await expect(build().childTasks.start('worker', 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
		storage.getRun = async id => id === task.id ? { ...stored!, metadata: { ...stored!.metadata!, workflowInvocationId: 'other-invocation' } } : originalGet(id)
		await expect(build().childTasks.start('worker', 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
	})

	it('does not re-run a transforming output schema for persisted task replay', async () => {
		const agent = defineAgentV4('transformTaskWorker', { input: z.string(), output: z.string().transform(Number), instructions: 'Transform once.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('transformTaskFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, durable: true, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0
		const build = () => createWorkflowExecutionRuntime({ workflow, models: {}, storage, durable: true, targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 9) as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 } })
		await expect((await build().childTasks.start('worker', '9', { callId: 'task', idempotencyKey: 'stable' })).result()).resolves.toBe(9)
		await expect((await build().childTasks.start('worker', '9', { callId: 'task', idempotencyKey: 'stable' })).result()).resolves.toBe(9)
		expect(opened).toBe(1)
	})

	it('rolls back task admission and resident state when start persistence fails', async () => {
		const agent = defineAgentV4('rollbackWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('rollbackFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, agentCalls: { maxCalls: 1, maxParallel: 1 }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); const originalCreate = storage.createRun.bind(storage); let failCreate = true; let opened = 0
		storage.createRun = async record => { if (failCreate) throw new Error('storage unavailable'); return originalCreate(record) }
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, storage, targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 'done') as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		await expect(runtime.childTasks.start('worker', 'input', { callId: 'retry' })).rejects.toThrow('storage unavailable')
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 0 }); expect(opened).toBe(0)
		failCreate = false
		const retried = await runtime.childTasks.start('worker', 'input', { callId: 'retry' })
		await expect(retried.result()).resolves.toBe('done')
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 1 }); expect(opened).toBe(1)
	})

	it('closes a partially persisted task when the start event fails', async () => {
		const agent = defineAgentV4('eventWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('eventFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, agentCalls: { maxCalls: 1, maxParallel: 1 }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0; let failEvent = true; const emitted: string[] = []
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, storage, targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 'done') as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { emitted.push(event.type); if (failEvent && event.type === 'child_task.started') throw new StateError('Event storage failed.', { op: 'appendEvents', reason: 'backend_failure' }) } })
		await expect(runtime.childTasks.start('worker', 'input', { callId: 'event' })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'appendEvents', reason: 'backend_failure' } })
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 0 }); expect(opened).toBe(0)
		expect(emitted).not.toContain('child_task.settled')
		await expect(storage.listRuns('session')).resolves.toEqual([expect.objectContaining({ status: 'cancelled', error: expect.objectContaining({ code: 'OPERATION_CANCELLED' }) })])
		failEvent = false
		const retried = await runtime.childTasks.start('worker', 'input', { callId: 'event' })
		await expect(retried.result()).resolves.toBe('done')
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 1 }); expect(opened).toBe(1)
	})

	it('serializes terminal persistence so a racing cancellation waits and committed success wins', async () => {
		const agent = defineAgentV4('commitRaceWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('commitRaceFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); const originalFinish = storage.finishRun.bind(storage)
		let enteredFinish!: () => void; let releaseFinish!: () => void
		const finishEntered = new Promise<void>(resolve => { enteredFinish = resolve }); const finishGate = new Promise<void>(resolve => { releaseFinish = resolve })
		storage.finishRun = async (id, patch) => { enteredFinish(); await finishGate; return originalFinish(id, patch) }
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, storage, targetDispatcher: { open: async request => terminalStream(request, 'done') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		const task = await runtime.childTasks.start('worker', 'input', { callId: 'race' })
		await finishEntered
		await expect(task.status()).resolves.toMatchObject({ status: 'running' })
		let cancelFinished = false; const cancellation = task.cancel().then(() => { cancelFinished = true })
		await Promise.resolve(); expect(cancelFinished).toBe(false)
		releaseFinish()
		await expect(task.result()).resolves.toBe('done'); await cancellation
		await expect(task.status()).resolves.toMatchObject({ status: 'succeeded' })
		await expect(storage.getRun(task.id)).resolves.toMatchObject({ status: 'succeeded', output: 'done' })
	})

	it('projects terminal storage and event commit failures without a false succeeded status', async () => {
		const agent = defineAgentV4('commitFailureWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('commitFailureFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); const originalFinish = storage.finishRun.bind(storage)
		storage.finishRun = async () => { throw new StateError('Run persistence failed.', { op: 'finishRun', reason: 'backend_failure' }) }
		const withStorage = createWorkflowExecutionRuntime({ workflow, models: {}, storage, targetDispatcher: { open: async request => terminalStream(request, 'done') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		const storageTask = await withStorage.childTasks.start('worker', 'input', { callId: 'storage-failure' })
		await expect(storageTask.result()).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finishRun' } })
		await expect(storageTask.status()).resolves.toMatchObject({ status: 'failed', error: { code: 'STATE_ERROR' } })
		storage.finishRun = originalFinish
		await expect(storage.getRun(storageTask.id)).resolves.toMatchObject({ status: 'running' })

		const withoutStorage = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async request => terminalStream(request, 'done') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'other-parent', rootRunId: 'root', invocationId: 'other-invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { if (event.type === 'child_task.settled') throw new StateError('Event persistence failed.', { op: 'appendEvents', reason: 'backend_failure' }) } })
		const eventTask = await withoutStorage.childTasks.start('worker', 'input', { callId: 'event-failure' })
		await expect(eventTask.result()).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'appendEvents' } })
		await expect(eventTask.status()).resolves.toMatchObject({ status: 'failed', error: { code: 'STATE_ERROR' } })
	})

	it('times out a non-cooperative one-shot task across its whole lifetime', async () => {
		const agent = defineAgentV4('slowWorker', { input: z.string(), output: z.string(), instructions: 'Wait.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('timeoutFlow', { input: z.string(), output: z.string(), agents: { worker: agent }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage()
		const runtime = createWorkflowExecutionRuntime({ workflow, models: {}, storage, targetDispatcher: { open: async () => new Promise(() => {}) },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		const task = await runtime.childTasks.start('worker', 'input', { callId: 'slow', timeoutMs: 5 })
		await expect(task.result()).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', meta: { scope: 'child_task', timeout_ms: 5 } })
		await expect(task.status()).resolves.toMatchObject({ status: 'failed', error: { code: 'OPERATION_TIMEOUT' } })
		await expect(storage.getRun(task.id)).resolves.toMatchObject({ status: 'failed', error: { code: 'OPERATION_TIMEOUT' } })
	})

	it('reconstructs failed and cancelled durable terminals with fixed local classes', async () => {
		for (const terminal of ['failed', 'cancelled'] as const) {
			const agent = defineAgentV4(`terminalWorker${terminal}`, { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
			const workflow = defineWorkflowV4(`terminalFlow${terminal}`, { input: z.string(), output: z.string(), agents: { worker: agent }, durable: true, async handler({ input }) { return input } })
			const storage = new InMemoryHarnessStorage(); let opened = 0
			const controller = new AbortController()
			const build = () => createWorkflowExecutionRuntime({ workflow, models: {}, storage, durable: true, targetDispatcher: { open: async request => {
				opened += 1
				return { async *[Symbol.asyncIterator]() { yield { type: 'run.finished', runId: 'child', parentRunId: request.invocation.parentRunId,
					parentInvocationId: request.invocation.invocationId, at: 'now', outcome: terminal === 'failed'
						? { status: 'failed', runId: 'child', error: { code: 'REMOTE', message: 'private' } }
						: { status: 'cancelled', runId: 'child', error: { code: 'REMOTE', message: 'private' } } } as ExecutionEvent }, async cancel() {} } as any
			} }, signal: controller.signal, sessionId: 'session', runId: `parent-${terminal}`, rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
				defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 } })
			const first = await build().childTasks.start('worker', 'input', { callId: 'task', idempotencyKey: 'stable' })
			await expect(first.result()).rejects.toMatchObject({ code: terminal === 'failed' ? 'WORKFLOW_CHILD_TARGET_FAILED' : 'OPERATION_CANCELLED' })
			const replay = await build().childTasks.start('worker', 'input', { callId: 'task', idempotencyKey: 'stable' })
			await expect(replay.result()).rejects.toMatchObject({ code: terminal === 'failed' ? 'WORKFLOW_CHILD_TARGET_FAILED' : 'OPERATION_CANCELLED' })
			expect(opened).toBe(1)
		}
	})
})
