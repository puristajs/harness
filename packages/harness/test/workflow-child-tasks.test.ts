import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { StateError } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { defineAgent as defineAgentV4 } from '../src/definitions/agent.js'
import { defineTool as defineToolV4 } from '../src/definitions/tool.js'
import { defineWorkflow as defineWorkflowV4 } from '../src/definitions/workflow.js'
import { defineHarness as defineHarnessV4 } from '../src/definitions/harness.js'
import type { AnyWorkflowDefinition } from '../src/definitions/types.js'
import type { ExecutionEvent } from '../src/definitions/execution-events.js'
import type { HarnessTargetDispatcher } from '../src/ports/target-dispatcher.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'
import { createWorkflowExecutionRuntime } from '../src/workflows/index.js'
import { compileDefinitionGraph } from '../src/runtime/compiled-graph.js'

function persistentStorage(): InMemoryHarnessStorage {
	const storage = new InMemoryHarnessStorage()
	const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
	Object.defineProperty(storage, 'capabilities', { value: capabilities })
	Object.defineProperty(storage, 'info', { value: Object.freeze({ ...storage.info, capabilities }) })
	return storage
}

function terminalStream(request: Parameters<HarnessTargetDispatcher['open']>[0], output: unknown) {
	const runId = request.invocation.invocationId
	const outcome = { status: 'completed' as const, runId, output }
	return { result: Promise.resolve(outcome), async *[Symbol.asyncIterator]() { yield { eventId: 'event-1', sequence: 1, type: 'run.finished', runId, parentRunId: request.invocation.parentRunId,
		parentInvocationId: request.invocation.invocationId, at: 'now', outcome } as ExecutionEvent }, async cancel() {} }
}

function approvalFor(workflow: AnyWorkflowDefinition) {
	return compileDefinitionGraph({ workflows: [workflow] }).approval.agents
}

describe('v4 workflow child-task runtime', () => {
	it('awaits child launch authorization before direct budgets and background persistence', async () => {
		const agent = defineAgentV4('authorizedWorker', { input: z.string(), output: z.string(), instructions: 'Work.',
			prompt: input => ({ role: 'user', content: input }) })
		const workflow = defineWorkflowV4('authorizedFlow', { input: z.string(), output: z.string(), agents: [agent],
			agentCalls: { maxCalls: 1, maxParallel: 1 }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage()
		let allowed = false
		let opened = 0
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage,
			targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 'done') as never } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'workflow-invocation',
			depth: 0, remainingDepth: 1, defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 },
			prepareChildLaunch: async () => { if (!allowed) throw new StateError('revoked', { op: 'getSession', reason: 'session_identity_mismatch' }) },
		})
		await expect(runtime.agents[agent.id].run('direct', { callId: 'direct-denied' })).rejects.toMatchObject({ code: 'STATE_ERROR' })
		expect(opened).toBe(0)
		expect(runtime.agentCallBudgetState().usedCalls).toBe(0)
		await expect(runtime.childTasks.start(agent.id, 'background', { callId: 'background-denied' })).rejects.toMatchObject({ code: 'STATE_ERROR' })
		expect(opened).toBe(0)
		expect(await storage.listRuns('session')).toEqual([])
		expect(runtime.agentCallBudgetState().usedCalls).toBe(0)
		allowed = true
		await expect(runtime.agents[agent.id].run('direct', { callId: 'direct-allowed' })).resolves.toBe('done')
	})

	it.each(['failed', 'cancelled'] as const)('runs background cleanup after the %s terminal record is persisted', async status => {
		const suffix = status === 'failed' ? 'Failed' : 'Cancelled'
		const agent = defineAgentV4(`terminal${suffix}`, { input: z.string(), output: z.string(), instructions: 'Work.',
			prompt: input => ({ role: 'user', content: input }) })
		const workflow = defineWorkflowV4(`terminalFlow${suffix}`, { input: z.string(), output: z.string(), agents: [agent],
			async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage()
		const observed: string[] = []
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage,
			targetDispatcher: { open: async request => {
				const outcome = { status, runId: request.invocation.invocationId,
					error: { code: status === 'cancelled' ? 'OPERATION_CANCELLED' : 'INTERNAL_ERROR', message: 'safe' } }
				return { result: Promise.resolve(outcome), async *[Symbol.asyncIterator]() {
				yield { eventId: 'terminal-event', sequence: 1, type: 'run.finished', runId: request.invocation.invocationId,
					parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId, at: 'now',
					outcome }
			}, async cancel() {} }
			} },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'workflow-invocation',
			depth: 0, remainingDepth: 1, defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 },
			onChildTaskTerminal: async childSessionId => {
				const rows = await storage.listRuns('session')
				expect(rows).toEqual([expect.objectContaining({ status })])
				observed.push(childSessionId)
			},
		})
		const task = await runtime.childTasks.start(agent.id, 'input', { callId: `task-${status}` })
		await expect(task.result()).rejects.toBeDefined()
		expect(observed).toEqual([expect.stringMatching(/^session_/)])
	})

	it('passes only a declared child-task sandbox policy to the selected child invocation', async () => {
		const agent = defineAgentV4('sandboxedWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('sandboxedFlow', { input: z.string(), output: z.string(), agents: [agent],
			childTaskSandboxGroups: ['reviewers'] as const, async handler({ input }) { return input } })
		const selected: Array<{ invocationId: string; policy: unknown }> = []
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {},
			targetDispatcher: { open: async request => terminalStream(request, 'done') as never },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'workflow-invocation',
			depth: 0, remainingDepth: 1, defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 },
			prepareChildLaunch: async request => { selected.push({ invocationId: request.childInvocationId, policy: request.policy }) },
		})
		const task = await runtime.childTasks.start(agent.id, 'input', { callId: 'task', sandbox: { group: 'reviewers' } })
		await expect(task.result()).resolves.toBe('done')
		expect(selected).toEqual([{ invocationId: expect.stringMatching(/^invocation_/), policy: { group: 'reviewers' } }])
		await expect(runtime.childTasks.start(agent.id, 'input', { callId: 'bad', sandbox: { group: 'admins' } } as never))
			.rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { issues: { reason: 'invalid_child_task_context' } } })
	})

	it('exposes a completed standalone child through its session owner after the workflow returns', async () => {
		const provider = new FakeModelProvider()
		provider.enqueueText({ content: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		const worker = defineAgentV4('worker', { input: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		let taskId = ''
		const launch = defineWorkflowV4('launch', { input: z.string(), output: z.string(), agents: [worker], durable: true,
			async handler({ childTasks, input }) {
				const task = await childTasks.start(worker.id, input, { callId: 'background', idempotencyKey: 'background' })
				taskId = task.id
				await task.result()
				return task.id
			},
		})
		const storage = persistentStorage()
		const harness = await defineHarnessV4({ name: 'standaloneChild', revision: 'v1' }).addWorkflow(launch)
			.getInstance({ storage, model: { provider, model: 'fake' } })
		const session = await harness.getSession('owner')
		const outcome = await session.workflows.launch.run('input')
		expect(outcome).toMatchObject({ status: 'completed', output: taskId })
		const recovered = await session.childTasks.get(taskId)
		expect(recovered).toBeDefined()
		await expect(recovered?.result()).resolves.toBe('done')
		await expect(recovered?.status()).resolves.toMatchObject({ status: 'succeeded', descriptor: {
			workflowId: 'launch', workflowInvocationId: expect.any(String), callId: 'background', agentId: 'worker', modelAlias: 'primary',
		} })
		await harness.close()
	})

	it('settles a one-shot task and persists the exact child-task record', async () => {
		const agent = defineAgentV4('v4worker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('v4flow', { input: z.string(), output: z.string(), agents: [agent], async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage()
		const events: ExecutionEvent[] = []
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, targetDispatcher: { open: async request => terminalStream(request, 'done') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { events.push(event) } })
		const task = await runtime.childTasks.start(agent.id, 'input', { callId: 'task' })
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
		const workflow = defineWorkflowV4('approvalFlow', { input: z.string(), output: z.string(), agents: [agent], async handler({ input }) { return input } })
		let opened = 0; const events: ExecutionEvent[] = []; const storage = new InMemoryHarnessStorage()
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, targetDispatcher: { open: async () => { opened += 1; throw new Error('unexpected') } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { events.push(event) } })
		await expect(runtime.childTasks.start(agent.id, 'input', { callId: 'task' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { issues: { reason: 'approval_capable_child_task_unsupported' } } })
		expect(opened).toBe(0); expect(events).toHaveLength(0); await expect(storage.listRuns('session')).resolves.toEqual([])
	})

	it('rejects exhausted child-task depth before reservation, storage, event, or dispatch', async () => {
		const agent = defineAgentV4('depthWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('depthFlow', { input: z.string(), output: z.string(), agents: [agent], async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0; const events: ExecutionEvent[] = []
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, targetDispatcher: { open: async () => { opened += 1; throw new Error('unexpected') } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 3, remainingDepth: 0,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { events.push(event) } })
		await expect(runtime.childTasks.start(agent.id, 'input', { callId: 'task' })).rejects.toMatchObject({ code: 'AGENT_LOOP_BUDGET_EXCEEDED', meta: { reason: 'max_depth', limit: 3 } })
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 0 }); expect(opened).toBe(0); expect(events).toEqual([])
		await expect(storage.listRuns('session')).resolves.toEqual([])
	})

	it('uses one lifetime timeout and exposes typed continuable FIFO turns', async () => {
		const agent = defineAgentV4('chatWorker', { input: z.string(), output: z.string(), instructions: 'Chat.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('chatFlow', { input: z.string(), output: z.string(), agents: [agent], async handler({ input }) { return input } })
		const seen: string[] = []; const sessions: string[] = []
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, targetDispatcher: { open: async request => { seen.push(request.input as string); sessions.push(request.invocation.sessionId); return terminalStream(request, `${request.input}!`) as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 3, maxParallelWorkflowAgentCalls: 1 } })
		const task = await runtime.childTasks.start(agent.id, 'first', { callId: 'chat', mode: 'continuable' })
		await expect(task.send('second')).resolves.toBe('second!')
		await expect(task.close()).resolves.toBe('second!')
		await expect(task.result()).resolves.toBe('second!')
		expect(seen).toEqual(['first', 'second'])
		expect(new Set(sessions)).toEqual(new Set([sessions[0]]))
		expect(sessions[0]).not.toBe('session')
		await expect(task.send('late')).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'terminal' } })
	})

	it('authorizes each continuable send before reservation and rolls back a queued revoked send', async () => {
		const agent = defineAgentV4('revocableWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('revocableFlow', { input: z.string(), output: z.string(), agents: [agent],
			agentCalls: { maxCalls: 2, maxParallel: 1 }, async handler({ input }) { return input } })
		let finishInitial!: () => void
		const initialGate = new Promise<void>(resolve => { finishInitial = resolve })
		let initialOpened!: () => void
		const openedInitial = new Promise<void>(resolve => { initialOpened = resolve })
		let sendAccepted!: () => void
		const accepted = new Promise<void>(resolve => { sendAccepted = resolve })
		let allowed = true
		let authorizations = 0
		let opened = 0
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {},
			targetDispatcher: { open: async request => {
				opened += 1
				if (opened === 1) {
					initialOpened()
					const source = terminalStream(request, 'first!')
					return { result: source.result, async *[Symbol.asyncIterator]() { await initialGate; yield* source }, async cancel() {} } as never
				}
				return terminalStream(request, `${request.input}!`) as never
			} },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation',
			depth: 0, remainingDepth: 1, defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 },
			prepareChildLaunch: async () => {},
			authorizeChildLaunch: async () => {
				authorizations += 1
				if (authorizations === 3) sendAccepted()
				if (!allowed) throw new StateError('revoked', { op: 'getSession', reason: 'session_identity_mismatch' })
			},
		})
		const task = await runtime.childTasks.start(agent.id, 'first', { callId: 'chat', mode: 'continuable' })
		await openedInitial
		const beforeInvalid = authorizations
		expect(() => (task as { send(value: unknown): Promise<unknown> }).send(() => undefined)).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
		expect(authorizations).toBe(beforeInvalid)
		const denied = task.send('second')
		await accepted
		allowed = false
		finishInitial()
		await expect(denied).rejects.toMatchObject({ code: 'STATE_ERROR' })
		await expect(task.result()).rejects.toMatchObject({ code: 'WORKFLOW_MANAGED_CALL_FAILED' })
		expect(opened).toBe(1)
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 1 })
	})

	it('keeps continuable sends FIFO and lets cancellation overtake an uncommitted close', async () => {
		const agent = defineAgentV4('raceWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('raceFlow', { input: z.string(), output: z.string(), agents: [agent], async handler({ input }) { return input } })
		const opened: string[] = []
		let slowOpened!: () => void
		const slowStarted = new Promise<void>(resolve => { slowOpened = resolve })
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, targetDispatcher: { open: async request => {
			opened.push(request.input as string)
			if (request.input === 'slow') { slowOpened(); return new Promise((_resolve, reject) => request.invocation.signal.addEventListener('abort', () => reject(request.invocation.signal.reason), { once: true })) }
			return terminalStream(request, `${request.input}!`) as any
		} }, signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 3, maxParallelWorkflowAgentCalls: 1 } })
		const task = await runtime.childTasks.start(agent.id, 'first', { callId: 'race', mode: 'continuable' }) as ContinuableChildTaskHandle<string, string>
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
		const workflow = defineWorkflowV4('reasonFlow', { input: z.string(), output: z.string(), agents: [agent], durable: true, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0
		const build = (signal = new AbortController().signal) => createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, durable: true,
			targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 'done') as any } }, signal,
			sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 4, maxParallelWorkflowAgentCalls: 1 } })
		await expect(build().childTasks.start(agent.id, 'x', { callId: 'bad id', idempotencyKey: 'stable' })).rejects.toMatchObject({ meta: { issues: { reason: 'invalid_workflow_call_id' } } })
		await expect(build().childTasks.start(agent.id, 'x', { callId: 'ok', idempotencyKey: 'bad key' })).rejects.toMatchObject({ meta: { issues: { reason: 'invalid_child_task_idempotency_key' } } })
		await expect(build().childTasks.start(agent.id, 'x', { callId: 'ok' })).rejects.toMatchObject({ meta: { issues: { reason: 'child_task_idempotency_key_required' } } })
		await expect(build().childTasks.start(agent.id, 'x', { callId: 'ok', mode: 'continuable' } as any)).rejects.toMatchObject({ meta: { issues: { reason: 'durable_continuable_child_task_unsupported' } } })
		await expect(build().childTasks.start(agent.id, 'x', { callId: 'ok', idempotencyKey: 'stable', timeoutMs: 0 })).rejects.toMatchObject({ meta: { issues: { reason: 'invalid_child_task_timeout' } } })
		await expect(build().childTasks.start(agent.id, 'x', { callId: 'ok', idempotencyKey: 'stable', context: 'shared' } as any)).rejects.toMatchObject({ meta: { issues: { reason: 'invalid_child_task_context' } } })
		const first = await build().childTasks.start(agent.id, 'x', { callId: 'ok', idempotencyKey: 'stable' }); await first.result()
		const aborted = new AbortController(); aborted.abort('late')
		await expect((await build(aborted.signal).childTasks.start(agent.id, 'x', { callId: 'ok', idempotencyKey: 'stable' })).result()).resolves.toBe('done')
		expect(opened).toBe(1)
	})

	it('replays durable terminal handles and detects stable tuple collisions', async () => {
		const agent = defineAgentV4('durableWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('durableFlow', { input: z.string(), output: z.string(), agents: [agent], durable: true, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0
		const build = () => createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, durable: true, targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 'persisted') as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'durable-parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 } })
		const first = await build().childTasks.start(agent.id, 'same', { callId: 'task', idempotencyKey: 'stable' })
		await expect(first.result()).resolves.toBe('persisted')
		const replay = await build().childTasks.start(agent.id, 'same', { callId: 'task', idempotencyKey: 'stable' })
		expect(replay.id).toBe(first.id)
		await expect(replay.result()).resolves.toBe('persisted')
		expect(opened).toBe(1)
		await expect(build().childTasks.start(agent.id, 'changed', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({
			code: 'CHILD_TASK_CONFLICT', meta: { reason: 'idempotency_key_reused', agent_id: 'durableWorker', call_id: 'task' },
		})
	})

	it('validates durable task persisted identity before reconstruction', async () => {
		const agent = defineAgentV4('strictWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('strictFlow', { input: z.string(), output: z.string(), agents: [agent], durable: true, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage()
		const build = () => createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, durable: true, targetDispatcher: { open: async request => terminalStream(request, 'valid') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 } })
		const task = await build().childTasks.start(agent.id, 'input', { callId: 'task', idempotencyKey: 'stable' }); await task.result()
		const stored = await storage.getRun(task.id); expect(stored).toBeDefined()
		const originalGet = storage.getRun.bind(storage)
		for (const timestamp of ['', 'not-a-timestamp', '2026-01-01T00:00:00Z']) {
			storage.getRun = async id => id === task.id ? { ...stored!, startedAt: timestamp, metadata: { ...stored!.metadata!, createdAt: timestamp } } : originalGet(id)
			await expect(build().childTasks.start(agent.id, 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
			storage.getRun = async id => id === task.id ? { ...stored!, finishedAt: timestamp } : originalGet(id)
			await expect(build().childTasks.start(agent.id, 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
		}
		storage.getRun = async id => id === task.id ? { ...stored!, output: () => 42 } as any : originalGet(id)
		await expect(build().childTasks.start(agent.id, 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
		storage.getRun = async id => id === task.id ? { ...stored!, metadata: { ...stored!.metadata!, idempotencyKey: 'other' } } : originalGet(id)
		await expect(build().childTasks.start(agent.id, 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_CONFLICT', meta: { reason: 'idempotency_key_reused' } })
		storage.getRun = async id => id === task.id ? { ...stored!, id: 'task_wrong' } : originalGet(id)
		await expect(build().childTasks.start(agent.id, 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
		storage.getRun = async id => id === task.id ? { ...stored!, metadata: { ...stored!.metadata!, workflowInvocationId: 'other-invocation' } } : originalGet(id)
		await expect(build().childTasks.start(agent.id, 'input', { callId: 'task', idempotencyKey: 'stable' })).rejects.toMatchObject({ code: 'CHILD_TASK_STATE_ERROR', meta: { reason: 'invalid_record' } })
	})

	it('does not re-run a transforming output schema for persisted task replay', async () => {
		const agent = defineAgentV4('transformTaskWorker', { input: z.string(), output: z.string().transform(Number), responseMode: 'text', instructions: 'Transform once.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('transformTaskFlow', { input: z.string(), output: z.string(), agents: [agent], durable: true, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0
		const build = () => createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, durable: true, targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 9) as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 } })
		await expect((await build().childTasks.start(agent.id, '9', { callId: 'task', idempotencyKey: 'stable' })).result()).resolves.toBe(9)
		await expect((await build().childTasks.start(agent.id, '9', { callId: 'task', idempotencyKey: 'stable' })).result()).resolves.toBe(9)
		expect(opened).toBe(1)
	})

	it('rolls back task admission and resident state when start persistence fails', async () => {
		const agent = defineAgentV4('rollbackWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('rollbackFlow', { input: z.string(), output: z.string(), agents: [agent], agentCalls: { maxCalls: 1, maxParallel: 1 }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); const originalCreate = storage.createRun.bind(storage); let failCreate = true; let opened = 0
		storage.createRun = async record => { if (failCreate) throw new Error('storage unavailable'); return originalCreate(record) }
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 'done') as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		await expect(runtime.childTasks.start(agent.id, 'input', { callId: 'retry' })).rejects.toThrow('storage unavailable')
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 0 }); expect(opened).toBe(0)
		failCreate = false
		const retried = await runtime.childTasks.start(agent.id, 'input', { callId: 'retry' })
		await expect(retried.result()).resolves.toBe('done')
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 1 }); expect(opened).toBe(1)
	})

	it('closes a partially persisted task when the start event fails', async () => {
		const agent = defineAgentV4('eventWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('eventFlow', { input: z.string(), output: z.string(), agents: [agent], agentCalls: { maxCalls: 1, maxParallel: 1 }, async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); let opened = 0; let failEvent = true; const emitted: string[] = []
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, targetDispatcher: { open: async request => { opened += 1; return terminalStream(request, 'done') as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { emitted.push(event.type); if (failEvent && event.type === 'child_task.started') throw new StateError('Event storage failed.', { op: 'appendEvents', reason: 'backend_failure' }) } })
		await expect(runtime.childTasks.start(agent.id, 'input', { callId: 'event' })).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'appendEvents', reason: 'backend_failure' } })
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 0 }); expect(opened).toBe(0)
		expect(emitted).not.toContain('child_task.settled')
		await expect(storage.listRuns('session')).resolves.toEqual([expect.objectContaining({ status: 'cancelled', error: expect.objectContaining({ code: 'OPERATION_CANCELLED' }) })])
		failEvent = false
		const retried = await runtime.childTasks.start(agent.id, 'input', { callId: 'event' })
		await expect(retried.result()).resolves.toBe('done')
		expect(runtime.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 1 }); expect(opened).toBe(1)
	})

	it('serializes terminal persistence so a racing cancellation waits and committed success wins', async () => {
		const agent = defineAgentV4('commitRaceWorker', { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('commitRaceFlow', { input: z.string(), output: z.string(), agents: [agent], async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); const originalFinish = storage.finishRun.bind(storage)
		let enteredFinish!: () => void; let releaseFinish!: () => void
		const finishEntered = new Promise<void>(resolve => { enteredFinish = resolve }); const finishGate = new Promise<void>(resolve => { releaseFinish = resolve })
		storage.finishRun = async (id, patch) => { enteredFinish(); await finishGate; return originalFinish(id, patch) }
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, targetDispatcher: { open: async request => terminalStream(request, 'done') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		const task = await runtime.childTasks.start(agent.id, 'input', { callId: 'race' })
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
		const workflow = defineWorkflowV4('commitFailureFlow', { input: z.string(), output: z.string(), agents: [agent], async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage(); const originalFinish = storage.finishRun.bind(storage)
		storage.finishRun = async () => { throw new StateError('Run persistence failed.', { op: 'finishRun', reason: 'backend_failure' }) }
		const withStorage = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, targetDispatcher: { open: async request => terminalStream(request, 'done') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		const storageTask = await withStorage.childTasks.start(agent.id, 'input', { callId: 'storage-failure' })
		await expect(storageTask.result()).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'finishRun' } })
		await expect(storageTask.status()).resolves.toMatchObject({ status: 'failed', error: { code: 'STATE_ERROR' } })
		storage.finishRun = originalFinish
		await expect(storage.getRun(storageTask.id)).resolves.toMatchObject({ status: 'running' })

		const withoutStorage = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, targetDispatcher: { open: async request => terminalStream(request, 'done') as any },
			signal: new AbortController().signal, sessionId: 'session', runId: 'other-parent', rootRunId: 'root', invocationId: 'other-invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { if (event.type === 'child_task.settled') throw new StateError('Event persistence failed.', { op: 'appendEvents', reason: 'backend_failure' }) } })
		const eventTask = await withoutStorage.childTasks.start(agent.id, 'input', { callId: 'event-failure' })
		await expect(eventTask.result()).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'appendEvents' } })
		await expect(eventTask.status()).resolves.toMatchObject({ status: 'failed', error: { code: 'STATE_ERROR' } })
	})

	it('times out a non-cooperative one-shot task across its whole lifetime', async () => {
		const agent = defineAgentV4('slowWorker', { input: z.string(), output: z.string(), instructions: 'Wait.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflowV4('timeoutFlow', { input: z.string(), output: z.string(), agents: [agent], async handler({ input }) { return input } })
		const storage = new InMemoryHarnessStorage()
		const runtime = createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, targetDispatcher: { open: async () => new Promise(() => {}) },
			signal: new AbortController().signal, sessionId: 'session', runId: 'parent', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 } })
		const task = await runtime.childTasks.start(agent.id, 'input', { callId: 'slow', timeoutMs: 5 })
		await expect(task.result()).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', meta: { scope: 'child_task', timeout_ms: 5 } })
		await expect(task.status()).resolves.toMatchObject({ status: 'failed', error: { code: 'OPERATION_TIMEOUT' } })
		await expect(storage.getRun(task.id)).resolves.toMatchObject({ status: 'failed', error: { code: 'OPERATION_TIMEOUT' } })
	})

	it('reconstructs failed and cancelled durable terminals with fixed local classes', async () => {
		for (const terminal of ['failed', 'cancelled'] as const) {
			const agent = defineAgentV4(`terminalWorker${terminal}`, { input: z.string(), output: z.string(), instructions: 'Work.', prompt: value => ({ role: 'user', content: value }) })
			const workflow = defineWorkflowV4(`terminalFlow${terminal}`, { input: z.string(), output: z.string(), agents: [agent], durable: true, async handler({ input }) { return input } })
			const storage = new InMemoryHarnessStorage(); let opened = 0
			const controller = new AbortController()
			const build = () => createWorkflowExecutionRuntime({ workflow, approval: approvalFor(workflow), models: {}, storage, durable: true, targetDispatcher: { open: async request => {
				opened += 1
				const outcome = terminal === 'failed'
						? { status: 'failed', runId: request.invocation.invocationId, error: { code: 'REMOTE', message: 'private' } }
						: { status: 'cancelled', runId: request.invocation.invocationId, error: { code: 'REMOTE', message: 'private' } }
				return { result: Promise.resolve(outcome), async *[Symbol.asyncIterator]() { yield { eventId: 'event-1', sequence: 1, type: 'run.finished', runId: request.invocation.invocationId, parentRunId: request.invocation.parentRunId,
					parentInvocationId: request.invocation.invocationId, at: 'now', outcome } as ExecutionEvent }, async cancel() {} } as never
			} }, signal: controller.signal, sessionId: 'session', runId: `parent-${terminal}`, rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
				defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 } })
			const first = await build().childTasks.start(agent.id, 'input', { callId: 'task', idempotencyKey: 'stable' })
			await expect(first.result()).rejects.toMatchObject({ code: terminal === 'failed' ? 'WORKFLOW_MANAGED_CALL_FAILED' : 'OPERATION_CANCELLED' })
			const replay = await build().childTasks.start(agent.id, 'input', { callId: 'task', idempotencyKey: 'stable' })
			await expect(replay.result()).rejects.toMatchObject({ code: terminal === 'failed' ? 'WORKFLOW_MANAGED_CALL_FAILED' : 'OPERATION_CANCELLED' })
			expect(opened).toBe(1)
		}
	})
})
