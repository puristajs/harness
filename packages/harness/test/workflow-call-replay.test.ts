import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineAgent } from '../src/definitions/agent.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import type { ExecutionEvent } from '../src/definitions/execution-events.js'
import type { HarnessTargetDispatcher, HarnessTargetDispatchStream } from '../src/ports/target-dispatcher.js'
import { isHarnessChildTargetInterruption } from '../src/runtime/steps.js'
import type { RunCheckpoint } from '../src/storage/execution.js'
import { createWorkflowExecutionRuntime } from '../src/workflows/index.js'

function stream(events: readonly ExecutionEvent[]): HarnessTargetDispatchStream<any> {
	return { async *[Symbol.asyncIterator]() { yield* events }, async cancel() {} }
}

function completed(parentRunId: string, childInvocationId: string, output: unknown, runId = 'child-run'): HarnessTargetDispatchStream<any> {
	return stream([{ type: 'run.finished', runId, parentRunId, parentInvocationId: childInvocationId, at: '2026-01-01T00:00:00.000Z', outcome: { status: 'completed', runId, output } } as ExecutionEvent])
}

const worker = defineAgent('worker', { input: z.record(z.string(), z.string()), output: z.string(), instructions: 'Work.', prompt: () => ({ role: 'user', content: 'work' }) })
const other = defineAgent('other', { input: z.record(z.string(), z.string()), output: z.string(), instructions: 'Other.', prompt: () => ({ role: 'user', content: 'work' }) })

function runtime(open: HarnessTargetDispatcher['open'], checkpoint?: { load(stepId: string): Promise<RunCheckpoint | undefined>; commit(stepId: string, output: any, metadata: any): Promise<void> }, workflow = defineWorkflow('flow', {
	input: z.string(), output: z.string(), agents: { worker, other }, async handler({ input }) { return input },
})) {
	return createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open }, signal: new AbortController().signal,
		sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 2,
		defaults: { maxWorkflowAgentCalls: 32, maxParallelWorkflowAgentCalls: 8 }, ...(checkpoint === undefined ? {} : { checkpoint: { rootInput: 'root', ...checkpoint } }) })
}

describe('v4 workflow direct-call replay', () => {
	it('coalesces equal canonical tuples and conflicts before another dispatch', async () => {
		let opened = 0
		const value = runtime(async request => { opened += 1; await Promise.resolve(); return completed(request.invocation.parentRunId, request.invocation.invocationId, 'ok') })
		await expect(Promise.all([
			value.agents.worker.run({ b: '2', a: '1' }, { callId: 'same' }),
			value.agents.worker.run({ a: '1', b: '2' }, { callId: 'same' }),
		])).resolves.toEqual(['ok', 'ok'])
		expect(opened).toBe(1)
		await expect(value.agents.other.run({ a: 'changed' }, { callId: 'same' })).rejects.toMatchObject({
			code: 'WORKFLOW_CALL_REPLAY_CONFLICT', meta: { reason: 'target_mismatch', call_id: 'same' },
		})
		expect(opened).toBe(1)
	})

	it('persists and replays completed terminals from the workflow call namespace', async () => {
		let opened = 0
		let stored: RunCheckpoint | undefined
		const checkpoint = {
			async load(stepId: string) { expect(stepId).toBe('workflow:call:answer'); return stored },
			async commit(stepId: string, output: any, metadata: any) { stored = { runId: 'workflow-run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: 1, output, metadata } },
		}
		const open: HarnessTargetDispatcher['open'] = async request => { opened += 1; return completed(request.invocation.parentRunId, request.invocation.invocationId, 'saved') as any }
		await expect(runtime(open, checkpoint).agents.worker.run({ a: '1' }, { callId: 'answer' })).resolves.toBe('saved')
		await expect(runtime(open, checkpoint).agents.worker.run({ a: '1' }, { callId: 'answer' })).resolves.toBe('saved')
		expect(stored?.stepId).toBe('workflow:call:answer')
		expect(stored?.metadata).toEqual({ checkpointKind: 'workflow_child_call', schemaVersion: 1 })
		expect(opened).toBe(1)
	})

	it('resolves terminal replay before current cancellation and rejects a non-JSON stored output', async () => {
		let stored: RunCheckpoint | undefined
		let opened = 0
		const checkpoint = {
			async load() { return stored },
			async commit(stepId: string, output: any, metadata: any) {
				stored = { runId: 'workflow-run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: 1, output, metadata }
			},
		}
		const open: HarnessTargetDispatcher['open'] = async request => { opened += 1; return completed(request.invocation.parentRunId, request.invocation.invocationId, 'saved') as any }
		await expect(runtime(open, checkpoint).agents.worker.run({ a: '1' }, { callId: 'answer' })).resolves.toBe('saved')
		const aborted = new AbortController(); aborted.abort('late caller')
		const replay = createWorkflowExecutionRuntime({ workflow: defineWorkflow('flow', { input: z.string(), output: z.string(), agents: { worker }, async handler({ input }) { return input } }), models: {},
			targetDispatcher: { open }, signal: aborted.signal, sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 2,
			defaults: { maxWorkflowAgentCalls: 32, maxParallelWorkflowAgentCalls: 8 }, checkpoint: { rootInput: 'root', ...checkpoint } })
		await expect(replay.agents.worker.run({ a: '1' }, { callId: 'answer' })).resolves.toBe('saved')
		expect(opened).toBe(1)

		stored = { ...stored!, output: { ...(stored!.output as any), outcome: { status: 'completed', output: () => 42 } } as any }
		const corrupt = runtime(open, checkpoint)
		await expect(corrupt.agents.worker.run({ a: '1' }, { callId: 'answer' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'workflow_output' } })
		expect(opened).toBe(1)
	})

	it('does not re-run transforming output schemas for live or persisted direct replay', async () => {
		const transformed = defineAgent('transformed', { input: z.string(), output: z.string().transform(Number), instructions: 'Transform once.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflow('transformFlow', { input: z.string(), output: z.string(), agents: { transformed }, durable: true, async handler({ input }) { return input } })
		let stored: RunCheckpoint | undefined; let opened = 0
		const checkpoint = { async load() { return stored }, async commit(stepId: string, output: any, metadata: any) { stored = { runId: 'workflow-run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: 1, output, metadata } } }
		const build = () => createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async request => { opened += 1; return completed(request.invocation.parentRunId, request.invocation.invocationId, 7) as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 }, checkpoint: { rootInput: 'root', ...checkpoint } })
		await expect(build().agents.transformed.run('7', { callId: 'transform' })).resolves.toBe(7)
		await expect(build().agents.transformed.run('7', { callId: 'transform' })).resolves.toBe(7)
		expect(opened).toBe(1)
	})

	it('does not retain a new call-table entry when cancellation wins before admission', async () => {
		let opened = 0
		const value = runtime(async request => { opened += 1; return completed(request.invocation.parentRunId, request.invocation.invocationId, 'ok') as any })
		const aborted = new AbortController(); aborted.abort('before call')
		await expect(value.agents.worker.run({ a: '1' }, { callId: 'retry', signal: aborted.signal })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
		await expect(value.agents.worker.run({ a: '1' }, { callId: 'retry' })).resolves.toBe('ok')
		expect(opened).toBe(1)
	})

	it('restores cumulative workflow call budget and isolates nested sessions and depth', async () => {
		const workflow = defineWorkflow('budgetResume', { input: z.string(), output: z.string(), agents: { worker }, agentCalls: { maxCalls: 2, maxParallel: 2 }, async handler({ input }) { return input } })
		const seen: Array<{ sessionId: string; depth: number; remainingDepth: number }> = []
		const open: HarnessTargetDispatcher['open'] = async request => {
			seen.push(request.invocation)
			return completed(request.invocation.parentRunId, request.invocation.invocationId, 'ok') as any
		}
		const first = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open }, signal: new AbortController().signal,
			sessionId: 'parent-session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 3, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 2 } })
		await first.agents.worker.run({ a: '1' }, { callId: 'one' })
		expect(first.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 1 })
		const resumed = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open }, signal: new AbortController().signal,
			sessionId: 'parent-session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 3, remainingDepth: 1,
			restoredAgentCallBudget: first.agentCallBudgetState(), defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 2 } })
		await resumed.agents.worker.run({ a: '2' }, { callId: 'two' })
		await expect(resumed.agents.worker.run({ a: '3' }, { callId: 'three' })).rejects.toMatchObject({ code: 'WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED', meta: { reason: 'max_calls', limit: 2 } })
		expect(seen).toHaveLength(2)
		expect(seen[0]).toMatchObject({ depth: 4, remainingDepth: 0 })
		expect(seen[0]!.sessionId).not.toBe('parent-session')
		expect(seen[1]!.sessionId).not.toBe(seen[0]!.sessionId)

		const exhausted = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open }, signal: new AbortController().signal,
			sessionId: 'parent-session', runId: 'other-run', rootRunId: 'root-run', invocationId: 'other-invocation', depth: 4, remainingDepth: 0,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 2 } })
		await expect(exhausted.agents.worker.run({ a: 'x' }, { callId: 'depth' })).rejects.toMatchObject({ code: 'AGENT_LOOP_BUDGET_EXCEEDED', meta: { reason: 'max_depth', limit: 4 } })
		expect(seen).toHaveLength(2)
	})

	it('uses exact configured budget metadata and keeps child interruptions as private control', async () => {
		let resolveFirst!: () => void
		const first = new Promise<void>(resolve => { resolveFirst = resolve })
		let count = 0
		const limited = defineWorkflow('limited', { input: z.string(), output: z.string(), agents: { worker }, agentCalls: { maxCalls: 2, maxParallel: 1 }, async handler({ input }) { return input } })
		const value = runtime(async request => { count += 1; if (count === 1) await first; return completed(request.invocation.parentRunId, request.invocation.invocationId, 'ok') as any }, undefined, limited)
		const pending = value.agents.worker.run({ a: '1' }, { callId: 'one' })
		await expect(value.agents.worker.run({ a: '2' }, { callId: 'two' })).rejects.toMatchObject({ code: 'WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED', meta: { reason: 'max_parallel', limit: 1 } })
		resolveFirst(); await pending
		await expect(value.agents.worker.run({ a: '3' }, { callId: 'three' })).resolves.toBe('ok')
		await expect(value.agents.worker.run({ a: '4' }, { callId: 'four' })).rejects.toMatchObject({ code: 'WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED', meta: { reason: 'max_calls', limit: 2 } })
		const interrupted = runtime(async request => stream([{ type: 'run.finished', runId: 'child', parentRunId: request.invocation.parentRunId,
			parentInvocationId: request.invocation.invocationId, at: 'now', outcome: { status: 'interrupted', runId: 'child', interrupt: { type: 'external-wait', id: 'wait', revision: 'r1', kind: 'review', schemaVersion: '1', definitionVersion: '1', deadline: 'later' } } }]) as any)
		await interrupted.agents.worker.run({ a: '1' }, { callId: 'interrupt' }).catch(error => expect(isHarnessChildTargetInterruption(error)).toBe(true))
		expect(interrupted.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 1 })
	})

	it('rejects malformed restored budget snapshots before exposing execution', () => {
		const workflow = defineWorkflow('budgetValidation', { input: z.string(), output: z.string(), agents: { worker }, agentCalls: { maxCalls: 2, maxParallel: 1 }, async handler({ input }) { return input } })
		const create = (restoredAgentCallBudget: any) => createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { open: async () => { throw new Error('unexpected') } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'run', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 }, restoredAgentCallBudget })
		expect(() => create({ schemaVersion: 1, usedCalls: 3 })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR', meta: { where: 'workflow_output', issues: { reason: 'invalid_checkpoint' } } }))
		expect(() => create({ schemaVersion: 1, usedCalls: 1, extra: true })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }))
	})

	it('commits failed and cancelled outcomes before exposing fixed local errors', async () => {
		for (const status of ['failed', 'cancelled'] as const) {
			let stored: RunCheckpoint | undefined; let opened = 0
			const checkpoint = { async load() { return stored }, async commit(stepId: string, output: any, metadata: any) { stored = { runId: 'workflow-run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: 1, output, metadata } } }
			const open: HarnessTargetDispatcher['open'] = async request => {
				opened += 1
				return stream([{ type: 'run.finished', runId: 'child', parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId,
					at: 'now', outcome: status === 'failed' ? { status, runId: 'child', error: { code: 'REMOTE_SECRET', message: 'do not trust' } }
						: { status, runId: 'child', error: { code: 'REMOTE_CANCEL', message: 'do not trust' } } } as ExecutionEvent]) as any
			}
			const first = runtime(open, checkpoint).agents.worker.run({ a: '1' }, { callId: `terminal-${status}` })
			await expect(first).rejects.toMatchObject({ code: status === 'failed' ? 'WORKFLOW_CHILD_TARGET_FAILED' : 'OPERATION_CANCELLED' })
			const replay = runtime(open, checkpoint).agents.worker.run({ a: '1' }, { callId: `terminal-${status}` })
			await expect(replay).rejects.toMatchObject({ code: status === 'failed' ? 'WORKFLOW_CHILD_TARGET_FAILED' : 'OPERATION_CANCELLED' })
			expect(opened).toBe(1)
		}
	})

	it('shares one call-id namespace between direct calls and task starts', async () => {
		const value = runtime(async request => completed(request.invocation.parentRunId, request.invocation.invocationId, 'ok') as any)
		await value.agents.worker.run({ a: '1' }, { callId: 'shared' })
		await expect(value.childTasks.start('worker', { a: '1' }, { callId: 'shared' })).rejects.toMatchObject({
			code: 'WORKFLOW_CALL_REPLAY_CONFLICT', meta: { reason: 'operation_mismatch' },
		})
	})
})
