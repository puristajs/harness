import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createHash } from 'node:crypto'

import { defineAgent } from '../src/definitions/agent.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { defineTool } from '../src/definitions/tool.js'
import type { ExecutionEvent } from '../src/definitions/execution-events.js'
import type { HarnessTargetDispatcher, HarnessTargetDispatchStream } from '../src/ports/target-dispatcher.js'
import type { JsonValue } from '../src/models/json.js'
import type { HarnessInterrupt } from '../src/runtime/outcomes.js'
import { isHarnessChildTargetInterruption } from '../src/runtime/steps.js'
import type { RunCheckpoint } from '../src/storage/execution.js'
import { createWorkflowExecutionRuntime } from '../src/workflows/index.js'
import { bindPortableTool } from '../src/tools/bindings.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'

function stream(events: readonly ExecutionEvent[]): HarnessTargetDispatchStream<JsonValue, HarnessInterrupt> {
	const authored = events.map((event, index) => ({ eventId: `event-${index + 1}`, sequence: index + 1, ...event })) as ExecutionEvent[]
	const directRunId = authored[0]?.runId
	const terminal = authored.findLast(event => event.type === 'run.finished' && event.runId === directRunId)
	return {
		result: terminal === undefined ? new Promise<never>(() => {}) : Promise.resolve(terminal.outcome),
		async *[Symbol.asyncIterator]() { yield* authored }, async cancel() {},
	}
}

function completed(parentRunId: string, childInvocationId: string, output: unknown, runId = childInvocationId): HarnessTargetDispatchStream<JsonValue, HarnessInterrupt> {
	return stream([{ type: 'run.finished', runId, parentRunId, parentInvocationId: childInvocationId, at: '2026-01-01T00:00:00.000Z', outcome: { status: 'completed', runId, output } } as ExecutionEvent])
}

const worker = defineAgent('worker', { model: 'chat', input: z.record(z.string(), z.string()), output: z.string(), instructions: 'Work.', prompt: () => ({ role: 'user', content: 'work' }) })
const other = defineAgent('other', { model: 'chat', input: z.record(z.string(), z.string()), output: z.string(), instructions: 'Other.', prompt: () => ({ role: 'user', content: 'work' }) })

function runtime(open: HarnessTargetDispatcher['open'], checkpoint?: { load(stepId: string): Promise<RunCheckpoint | undefined>; commit(stepId: string, output: any, metadata: any): Promise<void> }, workflow = defineWorkflow('flow', {
	input: z.string(), output: z.string(), agents: [worker, other], async handler({ input }) { return input },
})) {
	return createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { assertTarget: target => testRoute(target), open }, signal: new AbortController().signal,
		sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 2,
		defaults: { maxWorkflowAgentCalls: 32, maxParallelWorkflowAgentCalls: 8 }, ...(checkpoint === undefined ? {} : { checkpoint: { rootInput: 'root', ...checkpoint } }) })
}
function testRoute(target: { readonly kind: 'agent' | 'workflow'; readonly id: string }) {
	return { schemaVersion: 1 as const, kind: 'harness_target_route' as const, target: { kind: target.kind, id: target.id }, bindingDigest: `sha256:${'0'.repeat(64)}` }
}


describe('v4 workflow direct-call replay', () => {
	const modelWorkflow = defineWorkflow('modelFlow', { input: z.string(), output: z.string(), models: { scoped: { alias: 'chat', capabilities: ['text', 'text_stream', 'object', 'object_stream', 'embeddings', 'rerank', 'image_generation', 'speech_generation', 'video_generation'] } }, async handler({ input }) { return input } })
	function modelRuntime(handle: unknown, options: { load?: (stepId: string) => Promise<RunCheckpoint | undefined>; commit?: (stepId: string, output: any, metadata: any) => Promise<void>; emit?: (event: any) => Promise<void> } = {}) {
		return createWorkflowExecutionRuntime({ workflow: modelWorkflow, models: { scoped: handle } as never,
			toolContext: { caller: { kind: 'workflow', workflowId: 'modelFlow' }, harnessName: 'modelHarness' } as never,
			targetDispatcher: { assertTarget: target => testRoute(target), open: async () => { throw new Error('unexpected dispatch') } }, signal: new AbortController().signal,
			sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 1,
			identity: { tenantId: 'tenant' }, trace: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 },
			...(options.commit === undefined && options.load === undefined ? {} : { checkpoint: { rootInput: 'root', load: options.load ?? (async () => undefined), commit: options.commit ?? (async () => {}) } }),
			...(options.emit === undefined ? {} : { emit: options.emit }) })
	}

	it('rejects every incomplete or malformed finite workflow model stream before checkpointing', async () => {
		const finish = { kind: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
		const cases = [
			['textStream', []],
			['textStream', [{ kind: 'unknown' }]],
			['textStream', [finish, finish]],
			['textStream', [finish, { kind: 'delta', text: 'late' }]],
			['objectStream', []],
			['objectStream', [{ kind: 'unknown' }]],
			['objectStream', [{ ...finish, object: {} }, { ...finish, object: {} }]],
			['objectStream', [{ ...finish, object: {} }, { kind: 'partial', partial: {} }]],
		] as const
		for (const [index, [method, chunks]] of cases.entries()) {
			let commits = 0
			const handle = { async *[method]() { yield* chunks } }
			const model = (modelRuntime(handle, { commit: async () => { commits += 1 } }).models as any).scoped
			const consume = async () => { for await (const _chunk of model[method]({ messages: [], schema: {} }, { callId: `${method}-${index}` })) void _chunk }
			await expect(consume()).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'model_response' } })
			expect(commits).toBe(0)
		}
	})

	it('folds object deltas into ordered snapshots and emits completion only after a valid finish', async () => {
		const events: any[] = []; const order: string[] = []
		const handle = { async *objectStream() {
			yield { kind: 'partial', partial: { answer: { value: 1 } } }
			yield { kind: 'delta', path: ['answer', 'value'], value: 2 }
			yield { kind: 'finish', object: { answer: { value: 2 } }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
		} }
		const model = (modelRuntime(handle, { commit: async () => { order.push('checkpoint') }, emit: async event => { events.push(event); order.push(event.type) } }).models as any).scoped
		const chunks = []; for await (const chunk of model.objectStream({ messages: [], schema: {} }, { callId: 'object-delta' })) chunks.push(chunk)
		expect(chunks).toHaveLength(3)
		expect(events.filter(event => event.type === 'model.output.object.snapshot').map(event => event.value)).toEqual([
			{ answer: { value: 1 } }, { answer: { value: 2 } },
		])
		expect(events.filter(event => event.type === 'model.completed')).toHaveLength(1)
		expect(order).toEqual(['checkpoint', 'model.output.object.snapshot', 'checkpoint', 'model.output.object.snapshot', 'checkpoint', 'model.completed', 'checkpoint'])
	})

	it('rejects hostile object deltas without mutation, events, or checkpoints and creates null-prototype snapshots', async () => {
		const finish = { kind: 'finish', object: {}, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
		const hostile = [
			['__proto__', 'polluted'], ['prototype', 'polluted'], ['constructor', 'prototype'],
			[-1], [Number.MAX_SAFE_INTEGER + 1], [1],
		] as const
		for (const [index, path] of hostile.entries()) {
			const source = { safe: true }; let commits = 0; const events: unknown[] = []
			const handle = { async *objectStream() { yield { kind: 'partial', partial: source }; yield { kind: 'delta', path, value: true }; yield finish } }
			const model = (modelRuntime(handle, { commit: async () => { commits += 1 }, emit: async event => { events.push(event) } }).models as any).scoped
			const consume = async () => { for await (const _chunk of model.objectStream({ messages: [], schema: {} }, { callId: `hostile-${index}` })) void _chunk }
			await expect(consume()).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'model_response' } })
			expect(source).toEqual({ safe: true }); expect(commits).toBe(0); expect(events).toEqual([])
		}
		const snapshots: any[] = []
		const handle = { async *objectStream() {
			yield { kind: 'delta', path: ['answer', 'items', 0], value: { ok: true } }
			yield { ...finish, object: { answer: { items: [{ ok: true }] } } }
		} }
		const model = (modelRuntime(handle, { emit: async event => { if (event.type === 'model.output.object.snapshot') snapshots.push(event.value) } }).models as any).scoped
		for await (const _chunk of model.objectStream({ messages: [], schema: {} }, { callId: 'safe-own' })) void _chunk
		expect(Object.getPrototypeOf(snapshots[0])).toBeNull()
		expect(Object.getPrototypeOf(snapshots[0].answer)).toBeNull()
		expect(Object.prototype.hasOwnProperty.call(snapshots[0].answer, 'items')).toBe(true)
	})

	it('validates the exact finite workflow video stream grammar before events or checkpoints', async () => {
		const artifact = { id: 'video', url: 'https://example.test/video', mediaType: 'video/mp4' }
		const cases = [
			[], [{ kind: 'unknown' }], [{ kind: 'queued', extra: true }], [{ kind: 'progress', progress: 0.5 }, { kind: 'finish', artifact }],
			[{ kind: 'queued' }, { kind: 'queued' }, { kind: 'finish', artifact }], [{ kind: 'progress', progress: -1 }],
			[{ kind: 'progress', progress: 2 }], [{ kind: 'finish' }], [{ kind: 'finish', artifact, extra: true }],
			[{ kind: 'finish', artifact }, { kind: 'finish', artifact }], [{ kind: 'finish', artifact }, { kind: 'progress', progress: 1 }],
		] as const
		for (const [index, chunks] of cases.entries()) {
			let commits = 0; const events: unknown[] = []
			const handle = { async *videoStream() { yield* chunks } }
			const model = (modelRuntime(handle, { commit: async () => { commits += 1 }, emit: async event => { events.push(event) } }).models as any).scoped
			const consume = async () => { for await (const _chunk of model.videoStream({ prompt: 'video' }, { callId: `video-invalid-${index}` })) void _chunk }
			await expect(consume()).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'model_response' } })
			expect(commits).toBe(0); expect(events).toEqual([])
		}
	})

	it('recovers durable managed event publication without rerunning the effect or recommitting the outcome', async () => {
		const chunks = [{ kind: 'delta', text: 'a' }, { kind: 'delta', text: 'b' },
			{ kind: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }] as const
		let effects = 0; let failed = false; const emitted: string[] = []; const stored = new Map<string, RunCheckpoint>(); let outcomeCommits = 0
		const checkpoint = {
			async load(stepId: string) { return stored.get(stepId) },
			async commit(stepId: string, output: any, metadata: any) {
				if (stepId === 'workflow:call:recover-events') outcomeCommits += 1
				stored.set(stepId, { runId: 'workflow-run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: stored.size + 1, output, metadata })
			},
		}
		const options = { checkpoint: { rootInput: 'root', ...checkpoint }, emit: async (event: any) => {
			if (!failed && event.type === 'model.output.text.delta' && event.delta === 'b') { failed = true; throw new Error('event backend failed') }
			emitted.push(`${event.type}${event.delta === undefined ? '' : `:${event.delta}`}`)
		} }
		const build = () => createWorkflowExecutionRuntime({ workflow: modelWorkflow, models: { scoped: { async *textStream() { effects += 1; yield* chunks } } } as never,
			toolContext: { caller: { kind: 'workflow', workflowId: 'modelFlow' }, harnessName: 'modelHarness' } as never,
			targetDispatcher: { assertTarget: target => testRoute(target), open: async () => { throw new Error('unexpected') } }, signal: new AbortController().signal,
			sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, ...options })
		const consume = async (value: ReturnType<typeof build>) => { const output = []; for await (const chunk of (value.models as any).scoped.textStream({ messages: [] }, { callId: 'recover-events' })) output.push(chunk); return output }
		const first = build()
		await expect(consume(first)).rejects.toThrow('event backend failed')
		await expect(consume(first)).resolves.toEqual(chunks)
		await expect(consume(build())).resolves.toEqual(chunks)
		expect(effects).toBe(1); expect(outcomeCommits).toBe(1)
		expect(emitted).toEqual(['model.output.text.delta:a', 'model.output.text.delta:b', 'model.completed'])
	})

	it('preserves nested raw data, propagates model correlation, and uses artifact ids in output events', async () => {
		let observed: any; const events: any[] = []
		const handle = {
			async object(_request: unknown, _signal: AbortSignal, context: unknown) { observed = context; return { object: { raw: 'application-data' }, raw: { provider: true }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' } },
			async image() { return { artifacts: [{ id: 'artifact-one', url: 'https://example.test/one', mediaType: 'image/png' }] } },
		}
		const model = (modelRuntime(handle, { emit: async event => { events.push(event) } }).models as any).scoped
		await expect(model.object({ messages: [], schema: {} }, { callId: 'structured' })).resolves.toEqual(expect.objectContaining({ object: { raw: 'application-data' } }))
		expect(observed).toMatchObject({ callId: 'structured', caller: { kind: 'workflow', workflowId: 'modelFlow' }, identity: { tenantId: 'tenant' }, trace: { traceparent: expect.any(String) } })
		expect(observed).not.toHaveProperty('raw')
		await model.image({ prompt: 'image' }, { callId: 'image' })
		expect(events.find(event => event.type === 'output.file')).toMatchObject({ id: 'artifact-one', artifact: { id: 'artifact-one' }, callId: 'image' })
	})

	it('never recasts successful checkpoint or event persistence failures as operation failures', async () => {
		const response = { content: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
		for (const failureAt of ['checkpoint', 'event'] as const) {
			const sentinel = new Error(`${failureAt}-failed`); let commits = 0
			const model = (modelRuntime({ async text() { return response } }, {
				commit: async () => { commits += 1; if (failureAt === 'checkpoint') throw sentinel },
				emit: async () => { if (failureAt === 'event') throw sentinel },
			}).models as any).scoped
			await expect(model.text({ messages: [] }, { callId: failureAt })).rejects.toBe(sentinel)
			expect(commits).toBe(1)
		}
	})

	it('commits a successful workflow tool at most once when checkpoint or terminal-event persistence fails', async () => {
		const tool = defineTool('persistenceTool', { description: 'Persist.', input: z.string(), output: z.string(), async handler(_context, input) { return input } })
		const workflow = defineWorkflow('persistenceFlow', { input: z.string(), output: z.string(), tools: [tool], async handler({ input }) { return input } })
		for (const failureAt of ['checkpoint', 'event'] as const) {
			const sentinel = new Error(`${failureAt}-failed`); let commits = 0
			const value = createWorkflowExecutionRuntime({ workflow, models: {}, toolBindings: { persistenceTool: bindPortableTool(tool) },
				toolContext: { caller: { kind: 'workflow', workflowId: 'persistenceFlow' }, harnessName: 'harness',
					telemetry: { span: async (_name: string, _attrs: unknown, effect: () => Promise<unknown>) => effect() } } as never,
				targetDispatcher: { assertTarget: target => testRoute(target), open: async () => { throw new Error('unexpected') } }, signal: new AbortController().signal,
				sessionId: 'session', runId: 'run', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
				defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, checkpoint: { rootInput: 'root', load: async () => undefined,
					commit: async stepId => { if (stepId.startsWith('workflow:call:')) commits += 1; if (failureAt === 'checkpoint' && stepId.startsWith('workflow:call:')) throw sentinel } },
				emit: async event => { if (failureAt === 'event' && event.type === 'tool.finished') throw sentinel },
			})
			await expect(value.tools.persistenceTool.run('ok', { callId: failureAt })).rejects.toBe(sentinel)
			expect(commits).toBe(1)
		}
	})

	it('recovers a workflow tool terminal publication with one matched lifecycle and one effect', async () => {
		let effects = 0; let failTerminal = true; let outcomeCommits = 0; const events: string[] = []; const stored = new Map<string, RunCheckpoint>()
		const tool = defineTool('publishedTool', { description: 'Publish.', input: z.string(), output: z.string(),
			async handler(_context, input) { effects += 1; return input } })
		const workflow = defineWorkflow('publishedFlow', { input: z.string(), output: z.string(), tools: [tool], async handler({ input }) { return input } })
		const build = () => createWorkflowExecutionRuntime({ workflow, models: {}, toolBindings: { publishedTool: bindPortableTool(tool) },
			toolContext: { caller: { kind: 'workflow', workflowId: 'publishedFlow' }, harnessName: 'harness',
				telemetry: { span: async (_name: string, _attrs: unknown, effect: () => Promise<unknown>) => effect() } } as never,
			targetDispatcher: { assertTarget: target => testRoute(target), open: async () => { throw new Error('unexpected') } }, signal: new AbortController().signal,
			sessionId: 'session', runId: 'run', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, checkpoint: { rootInput: 'root',
				load: async stepId => stored.get(stepId), commit: async (stepId, output, metadata) => {
					if (stepId === 'workflow:call:published') outcomeCommits += 1
					stored.set(stepId, { runId: 'run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId,
						input: 'root', attempt: 1, sequence: stored.size + 1, output, metadata })
				} }, emit: async event => {
				if (event.type === 'tool.finished' && failTerminal) { failTerminal = false; throw new Error('terminal publication failed') }
				events.push(event.type)
			},
		})
		const first = build()
		await expect(first.tools.publishedTool.run('ok', { callId: 'published' })).rejects.toThrow('terminal publication failed')
		await expect(first.tools.publishedTool.run('ok', { callId: 'published' })).resolves.toBe('ok')
		await expect(build().tools.publishedTool.run('ok', { callId: 'published' })).resolves.toBe('ok')
		expect(effects).toBe(1); expect(outcomeCommits).toBe(1)
		expect(events).toEqual(['tool.input.available', 'tool.started', 'tool.finished'])
	})

	it.each(['append', 'ack'] as const)('preallocates a stable event id and recovers an actual storage %s failure without repeating the effect', async failureAt => {
		const storage = new InMemoryHarnessStorage()
		await storage.createRun({ id: 'run', sessionId: 'session', kind: 'workflow', target: 'stableFlow', startedAt: '2026-01-01T00:00:00.000Z', input: 'root', validatedInput: 'root' })
		const append = storage.appendEvents.bind(storage)
		let fail = true; const appendedIds: string[] = []; const publicationOrder: string[] = []
		storage.appendEvents = async (runId, events) => {
			if (events[0]?.type === 'tool.finished') { appendedIds.push(events[0].id); publicationOrder.push(`append:${events[0].id}`) }
			if (failureAt === 'append' && fail && events[0]?.type === 'tool.finished') { fail = false; throw new Error('real append failed') }
			await append(runId, events)
		}
		let effects = 0; let sequence = 0; const liveStreams: string[][] = []; const stored = new Map<string, RunCheckpoint>()
		const tool = defineTool('stableTool', { description: 'Stable.', input: z.string(), output: z.string(), async handler(_context, input) { effects += 1; return input } })
		const workflow = defineWorkflow('stableFlow', { input: z.string(), output: z.string(), durable: true, tools: [tool], async handler({ input }) { return input } })
		const build = () => {
			const live: string[] = []
			liveStreams.push(live)
			return createWorkflowExecutionRuntime({ workflow, models: {}, toolBindings: { stableTool: bindPortableTool(tool) },
			toolContext: { caller: { kind: 'workflow', workflowId: 'stableFlow' }, harnessName: 'harness', telemetry: { span: async (_name: string, _attrs: unknown, effect: () => Promise<unknown>) => effect() } } as never,
			targetDispatcher: { assertTarget: target => testRoute(target), open: async () => { throw new Error('unexpected') } }, signal: new AbortController().signal,
			sessionId: 'session', runId: 'run', rootRunId: 'run', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, checkpoint: { rootInput: 'root', load: async id => stored.get(id),
				commit: async (stepId, output, metadata) => {
					if (metadata.checkpointKind === 'workflow_call_publication' && (output as any).eventIndex === 2) publicationOrder.push(`allocate:${(output as any).allocation.event.eventId}`)
					if (metadata.checkpointKind === 'workflow_call_publication_ack' && (output as any).eventIndex === 2) publicationOrder.push(`ack:${(output as any).eventId}`)
					if (failureAt === 'ack' && fail && metadata.checkpointKind === 'workflow_call_publication_ack' && stepId.includes(':ack') && (output as any).eventIndex === 2) { fail = false; throw new Error('ack failed') }
					stored.set(stepId, { runId: 'run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: stored.size + 1, output, metadata })
				} },
			allocateManagedEvent: async event => {
				sequence += 1
				const eventId = `event_${createHash('sha256').update(JSON.stringify(['harness.event.v1', 'run', sequence, event.type])).digest('hex')}`
				return { event: { ...event, eventId, sequence }, persistedAt: '2026-01-01T00:00:00.000Z' } as never
			},
			appendManagedEvent: async allocation => storage.appendEvents('run', [{ id: allocation.event.eventId, sequence: allocation.event.sequence,
				runId: 'run', at: allocation.persistedAt, type: allocation.event.type, payload: {} }]),
				deliverManagedEvent: allocation => { live.push(allocation.event.type); if (allocation.event.type === 'tool.finished') publicationOrder.push(`live:${allocation.event.eventId}`) },
			})
		}
		const first = build()
		await expect(first.tools.stableTool.run('ok', { callId: 'stable' })).rejects.toThrow(failureAt === 'append' ? 'real append failed' : 'ack failed')
		await expect(build().tools.stableTool.run('ok', { callId: 'stable' })).resolves.toBe('ok')
		await expect(build().tools.stableTool.run('ok', { callId: 'stable' })).resolves.toBe('ok')
		expect(effects).toBe(1)
		expect(new Set(appendedIds)).toHaveLength(1)
		const terminalId = appendedIds[0]!
		expect(publicationOrder[0]).toBe(`allocate:${terminalId}`)
		expect(publicationOrder.at(-1)).toBe(`live:${terminalId}`)
		expect(await storage.listEvents('run')).toHaveLength(3)
		expect(liveStreams.slice(0, 3)).toEqual([
			['tool.input.available', 'tool.started'],
			['tool.input.available', 'tool.started', 'tool.finished'],
			['tool.input.available', 'tool.started', 'tool.finished'],
		])
		const publicationKey = [...stored.keys()].find(key => key.startsWith('workflow:publication:') && !key.endsWith(':ack'))!
		const publication = stored.get(publicationKey)!
		const output = structuredClone(publication.output) as any
		output.allocation.event.callId = 'forged'
		stored.set(publicationKey, { ...publication, output })
		await expect(build().tools.stableTool.run('ok', { callId: 'stable' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'workflow_output' } })
		expect(effects).toBe(1)
		expect(liveStreams.at(-1)).toEqual([])
	})

	it('memoizes ephemeral failures and retries only missing post-effect publication', async () => {
		let toolEffects = 0; const toolEvents: string[] = []
		const tool = defineTool('ephemeralTool', { description: 'Fails.', input: z.string(), output: z.string(), async handler() { toolEffects += 1; throw new Error('effect failed') } })
		const workflow = defineWorkflow('ephemeralFlow', { input: z.string(), output: z.string(), tools: [tool], async handler({ input }) { return input } })
		const value = createWorkflowExecutionRuntime({ workflow, models: {}, toolBindings: { ephemeralTool: bindPortableTool(tool) },
			toolContext: { caller: { kind: 'workflow', workflowId: 'ephemeralFlow' }, harnessName: 'harness', telemetry: { span: async (_name: string, _attrs: unknown, effect: () => Promise<unknown>) => effect() } } as never,
			targetDispatcher: { assertTarget: target => testRoute(target), open: async () => { throw new Error('unexpected') } }, signal: new AbortController().signal,
			sessionId: 'session', runId: 'run', rootRunId: 'root', invocationId: 'invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, emit: async event => { toolEvents.push(event.type) } })
		await expect(value.tools.ephemeralTool.run('x', { callId: 'failure' })).rejects.toMatchObject({ code: 'WORKFLOW_MANAGED_CALL_FAILED' })
		await expect(value.tools.ephemeralTool.run('x', { callId: 'failure' })).rejects.toMatchObject({ code: 'WORKFLOW_MANAGED_CALL_FAILED' })
		expect(toolEffects).toBe(1)
		expect(toolEvents).toEqual(['tool.input.available', 'tool.started', 'tool.finished'])

		let modelEffects = 0; let failPublication = true; const modelEvents: string[] = []
		const model = (modelRuntime({ async text() { modelEffects += 1; return { content: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' } } }, {
			emit: async event => { if (failPublication) { failPublication = false; throw new Error('publish failed') }; modelEvents.push(event.type) },
		}).models as any).scoped
		await expect(model.text({ messages: [] }, { callId: 'ephemeral-publish' })).rejects.toThrow('publish failed')
		await expect(model.text({ messages: [] }, { callId: 'ephemeral-publish' })).resolves.toMatchObject({ content: 'ok' })
		expect(modelEffects).toBe(1)
		expect(modelEvents).toEqual(['model.completed'])
		let failedModelEffects = 0
		const failedModel = (modelRuntime({ async text() { failedModelEffects += 1; throw new Error('provider failed') } }).models as any).scoped
		await expect(failedModel.text({ messages: [] }, { callId: 'ephemeral-model-failure' })).rejects.toMatchObject({ code: 'WORKFLOW_MANAGED_CALL_FAILED' })
		await expect(failedModel.text({ messages: [] }, { callId: 'ephemeral-model-failure' })).rejects.toMatchObject({ code: 'WORKFLOW_MANAGED_CALL_FAILED' })
		expect(failedModelEffects).toBe(1)
	})

	it('rejects corrupt managed model caller, correlation, identity, result, and stream checkpoints before publication or effect', async () => {
		const checkpoints = new Map<string, RunCheckpoint>(); let effects = 0
		const chunks = [{ kind: 'delta', text: 'ok' }, { kind: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }]
		const seed = (modelRuntime({ async *textStream() { effects += 1; yield* chunks } }, {
			load: async id => checkpoints.get(id), commit: async (stepId, output, metadata) => checkpoints.set(stepId, { runId: 'workflow-run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: checkpoints.size + 1, output, metadata }),
		}).models as any).scoped
		for await (const _chunk of seed.textStream({ messages: [] }, { callId: 'corrupt-stream' })) void _chunk
		const original = checkpoints.get('workflow:call:corrupt-stream')!
		const cases = [
			{ ...structuredClone(original.output), caller: {} },
			{ ...structuredClone(original.output), caller: { kind: 'workflow', workflowId: 'modelFlow', agentId: 'forged' } },
			{ ...structuredClone(original.output), correlation: { runId: 'other', rootRunId: 'root-run', workflowInvocationId: 'workflow-invocation' } },
			{ ...structuredClone(original.output), callId: 'other' },
			{ ...structuredClone(original.output), outcome: { status: 'completed', output: 5 } },
			{ ...structuredClone(original.output), outcome: { status: 'completed', output: [{ kind: 'delta', text: 'missing finish' }] } },
		]
		for (const [index, output] of cases.entries()) {
			const emitted: unknown[] = []
			const corrupt = (modelRuntime({ async *textStream() { effects += 1; yield* chunks } }, {
				load: async id => id === 'workflow:call:corrupt-stream' ? { ...original, output } : checkpoints.get(id),
				emit: async event => { emitted.push(event) },
			}).models as any).scoped
			const consume = async () => { for await (const _chunk of corrupt.textStream({ messages: [] }, { callId: 'corrupt-stream' })) void _chunk }
			await expect(consume(), `corrupt case ${index}`).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'workflow_output' } })
			expect(emitted).toEqual([])
		}
		expect(effects).toBe(1)
	})

	it('persists and replays every scoped model operation with exact workflow caller context', async () => {
		const artifact = { id: 'artifact', url: 'https://example.test/artifact', mediaType: 'application/octet-stream' }
		const cases = [
			['model_text', (model: any, callId: string) => model.text({ messages: [] }, { callId })],
			['model_text_stream', async (model: any, callId: string) => { const output = []; for await (const chunk of model.textStream({ messages: [] }, { callId })) output.push(chunk); return output }],
			['model_object', (model: any, callId: string) => model.object({ messages: [], schema: {} }, { callId })],
			['model_object_stream', async (model: any, callId: string) => { const output = []; for await (const chunk of model.objectStream({ messages: [], schema: {} }, { callId })) output.push(chunk); return output }],
			['model_embed', (model: any, callId: string) => model.embed({ input: 'text' }, { callId })],
			['model_rerank', (model: any, callId: string) => model.rerank({ query: 'q', documents: [{ id: 'one', text: 'one' }] }, { callId })],
			['model_image', (model: any, callId: string) => model.image({ prompt: 'image' }, { callId })],
			['model_speech', (model: any, callId: string) => model.speech({ text: 'speak' }, { callId })],
			['model_video', (model: any, callId: string) => model.video({ prompt: 'video' }, { callId })],
			['model_video_stream', async (model: any, callId: string) => { const output = []; for await (const chunk of model.videoStream({ prompt: 'video' }, { callId })) output.push(chunk); return output }],
		] as const
		for (const [operation, invoke] of cases) {
			let effects = 0
			let context: any
			const stored = new Map<string, RunCheckpoint>()
			const value = (output: unknown) => { effects += 1; return output }
			const handle = {
				async text(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; return value({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }) },
				async *textStream(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; value(null); yield { kind: 'delta', text: 'ok' }; yield { kind: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' } },
				async object(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; return value({ object: { ok: true }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }) },
				async *objectStream(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; value(null); yield { kind: 'partial', partial: { ok: true } }; yield { kind: 'finish', object: { ok: true }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' } },
				async embed(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; return value({ embeddings: [{ index: 0, vector: [1] }], usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } }) },
				async rerank(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; return value({ results: [{ id: 'one', index: 0, score: 1 }] }) },
				async image(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; return value({ artifacts: [artifact] }) },
				async speech(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; return value({ artifact }) },
				async video(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; return value({ artifact }) },
				async *videoStream(_request: unknown, _signal: AbortSignal, modelContext: unknown) { context = modelContext; value(null); yield { kind: 'queued' }; yield { kind: 'finish', artifact } },
			}
			const workflow = defineWorkflow('modelFlow', { input: z.string(), output: z.string(), models: { scoped: { alias: 'chat', capabilities: ['text', 'text_stream', 'object', 'object_stream', 'embeddings', 'rerank', 'image_generation', 'speech_generation', 'video_generation'] } }, async handler({ input }) { return input } })
			const checkpoint = { async load(stepId: string) { return stored.get(stepId) }, async commit(stepId: string, output: any, metadata: any) { stored.set(stepId, { runId: 'workflow-run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: stored.size + 1, output, metadata }) } }
			const build = (caller: unknown = { kind: 'workflow', workflowId: 'modelFlow' }) => createWorkflowExecutionRuntime({ workflow, models: { scoped: handle } as never, toolContext: { caller, harnessName: 'modelHarness' } as never,
				targetDispatcher: { assertTarget: target => testRoute(target), open: async () => { throw new Error('unexpected dispatch') } }, signal: new AbortController().signal,
				sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 1,
				defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, checkpoint: { rootInput: 'root', ...checkpoint } })
			await invoke((build().models as any).scoped, operation)
			await invoke((build().models as any).scoped, operation)
			expect(effects).toBe(1)
			expect(context).toMatchObject({ caller: { kind: 'workflow', workflowId: 'modelFlow' }, harnessName: 'modelHarness', runId: 'workflow-run' })
			expect(Object.isFrozen(context.caller)).toBe(true)
			expect(stored.get(`workflow:call:${operation}`)?.output).toMatchObject({ operation, target: { kind: 'model', id: 'chat' }, outcome: { status: 'completed' } })
			await expect(invoke((build({ kind: 'workflow', workflowId: 'modelFlow', agentId: 'forged' }).models as any).scoped, operation)).rejects.toBeInstanceOf(TypeError)
			expect(effects).toBe(1)
		}
	})

	it('persists and replays a validated workflow tool before any duplicate handler effect', async () => {
		let effects = 0
		let observedCaller: unknown
		const stored = new Map<string, RunCheckpoint>()
		const tool = defineTool('managedTool', { description: 'Managed.', input: z.object({ value: z.string() }), output: z.object({ value: z.string() }),
			async handler(context, input) { effects += 1; observedCaller = context.caller; return { value: input.value.toUpperCase() } } })
		const workflow = defineWorkflow('toolReplay', { input: z.string(), output: z.string(), tools: [tool], async handler({ input }) { return input } })
		const checkpoint = { async load(stepId: string) { return stored.get(stepId) }, async commit(stepId: string, output: any, metadata: any) { stored.set(stepId, { runId: 'workflow-run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: stored.size + 1, output, metadata }) } }
		const build = (caller: unknown = { kind: 'workflow', workflowId: 'toolReplay' }) => createWorkflowExecutionRuntime({ workflow, models: {},
			toolBindings: { managedTool: bindPortableTool(tool) }, toolContext: { caller, harnessName: 'toolHarness', sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 1,
				metadata: {}, telemetry: { span: async (_name: string, _attributes: unknown, handler: () => Promise<unknown>) => handler() } } as never,
			targetDispatcher: { assertTarget: target => testRoute(target), open: async () => { throw new Error('unexpected dispatch') } }, signal: new AbortController().signal,
			sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 1, maxParallelWorkflowAgentCalls: 1 }, checkpoint: { rootInput: 'root', ...checkpoint } })
		await expect(build().tools.managedTool.run({ value: 'ok' }, { callId: 'tool-call' })).resolves.toEqual({ value: 'OK' })
		await expect(build().tools.managedTool.run({ value: 'ok' }, { callId: 'tool-call' })).resolves.toEqual({ value: 'OK' })
		expect(effects).toBe(1)
		expect(observedCaller).toEqual({ kind: 'workflow', workflowId: 'toolReplay' })
		expect(Object.isFrozen(observedCaller)).toBe(true)
		expect(stored.get('workflow:call:tool-call')?.output).toMatchObject({ operation: 'tool_run', target: { kind: 'tool', id: 'managedTool' }, outcome: { status: 'completed', output: { value: 'OK' } } })
		await expect(build().tools.managedTool.run({ value: 'changed' }, { callId: 'tool-call' })).rejects.toMatchObject({ code: 'WORKFLOW_CALL_REPLAY_CONFLICT', meta: { reason: 'input_mismatch' } })
		expect(effects).toBe(1)
		await expect(build({ kind: 'workflow', workflowId: 'toolReplay', agentId: 'forged' }).tools.managedTool.run({ value: 'ok' }, { callId: 'tool-call' })).rejects.toBeInstanceOf(TypeError)
		expect(effects).toBe(1)
	})

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
		expect(stored?.metadata).toEqual({ checkpointKind: 'workflow_call', schemaVersion: 1 })
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
		const replay = createWorkflowExecutionRuntime({ workflow: defineWorkflow('flow', { input: z.string(), output: z.string(), agents: [worker], async handler({ input }) { return input } }), models: {},
			targetDispatcher: { assertTarget: target => testRoute(target), open }, signal: aborted.signal, sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 2,
			defaults: { maxWorkflowAgentCalls: 32, maxParallelWorkflowAgentCalls: 8 }, checkpoint: { rootInput: 'root', ...checkpoint } })
		await expect(replay.agents.worker.run({ a: '1' }, { callId: 'answer' })).resolves.toBe('saved')
		expect(opened).toBe(1)

		stored = { ...stored!, output: { ...(stored!.output as any), outcome: { status: 'completed', output: () => 42 } } as any }
		const corrupt = runtime(open, checkpoint)
		await expect(corrupt.agents.worker.run({ a: '1' }, { callId: 'answer' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'workflow_output' } })
		expect(opened).toBe(1)
	})

	it('does not re-run transforming output schemas for live or persisted direct replay', async () => {
		const transformed = defineAgent('transformed', { model: 'chat', input: z.string(), output: z.string().transform(Number), responseMode: 'text', instructions: 'Transform once.', prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflow('transformFlow', { input: z.string(), output: z.string(), agents: [transformed], durable: true, async handler({ input }) { return input } })
		let stored: RunCheckpoint | undefined; let opened = 0
		const checkpoint = { async load() { return stored }, async commit(stepId: string, output: any, metadata: any) { stored = { runId: 'workflow-run', sessionId: 'session', leaseId: 'lease', workerId: 'worker', stepId, input: 'root', attempt: 1, sequence: 1, output, metadata } } }
		const build = () => createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { assertTarget: target => testRoute(target), open: async request => { opened += 1; return completed(request.invocation.parentRunId, request.invocation.invocationId, 7) as any } },
			signal: new AbortController().signal, sessionId: 'session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 0, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 1 }, checkpoint: { rootInput: 'root', ...checkpoint } })
		await expect(build().agents.transformed.run('7', { callId: 'transform' })).resolves.toBe(7)
		await expect(build().agents.transformed.run('7', { callId: 'transform' })).resolves.toBe(7)
		expect(opened).toBe(1)
	})

	it('rejects removed per-call signals before creating a call-table entry', async () => {
		let opened = 0
		const value = runtime(async request => { opened += 1; return completed(request.invocation.parentRunId, request.invocation.invocationId, 'ok') as any })
		const aborted = new AbortController(); aborted.abort('before call')
		await expect(value.agents.worker.run({ a: '1' }, { callId: 'retry', signal: aborted.signal } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
		await expect(value.agents.worker.run({ a: '1' }, { callId: 'retry' })).resolves.toBe('ok')
		expect(opened).toBe(1)
	})

	it('restores cumulative workflow call budget and isolates nested sessions and depth', async () => {
		const workflow = defineWorkflow('budgetResume', { input: z.string(), output: z.string(), agents: [worker], agentCalls: { maxCalls: 2, maxParallel: 2 }, async handler({ input }) { return input } })
		const seen: Array<{ sessionId: string; depth: number; remainingDepth: number }> = []
		const open: HarnessTargetDispatcher['open'] = async request => {
			seen.push(request.invocation)
			return completed(request.invocation.parentRunId, request.invocation.invocationId, 'ok') as any
		}
		const first = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { assertTarget: target => testRoute(target), open }, signal: new AbortController().signal,
			sessionId: 'parent-session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 3, remainingDepth: 1,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 2 } })
		await first.agents.worker.run({ a: '1' }, { callId: 'one' })
		expect(first.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 1 })
		const resumed = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { assertTarget: target => testRoute(target), open }, signal: new AbortController().signal,
			sessionId: 'parent-session', runId: 'workflow-run', rootRunId: 'root-run', invocationId: 'workflow-invocation', depth: 3, remainingDepth: 1,
			restoredAgentCallBudget: first.agentCallBudgetState(), defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 2 } })
		await resumed.agents.worker.run({ a: '2' }, { callId: 'two' })
		await expect(resumed.agents.worker.run({ a: '3' }, { callId: 'three' })).rejects.toMatchObject({ code: 'WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED', meta: { reason: 'max_calls', limit: 2 } })
		expect(seen).toHaveLength(2)
		expect(seen[0]).toMatchObject({ depth: 4, remainingDepth: 0 })
		expect(seen[0]!.sessionId).not.toBe('parent-session')
		expect(seen[1]!.sessionId).not.toBe(seen[0]!.sessionId)

		const exhausted = createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { assertTarget: target => testRoute(target), open }, signal: new AbortController().signal,
			sessionId: 'parent-session', runId: 'other-run', rootRunId: 'root-run', invocationId: 'other-invocation', depth: 4, remainingDepth: 0,
			defaults: { maxWorkflowAgentCalls: 2, maxParallelWorkflowAgentCalls: 2 } })
		await expect(exhausted.agents.worker.run({ a: 'x' }, { callId: 'depth' })).rejects.toMatchObject({ code: 'AGENT_LOOP_BUDGET_EXCEEDED', meta: { reason: 'max_depth', limit: 4 } })
		expect(seen).toHaveLength(2)
	})

	it('uses exact configured budget metadata and keeps child interruptions as private control', async () => {
		let resolveFirst!: () => void
		const first = new Promise<void>(resolve => { resolveFirst = resolve })
		let count = 0
		const limited = defineWorkflow('limited', { input: z.string(), output: z.string(), agents: [worker], agentCalls: { maxCalls: 2, maxParallel: 1 }, async handler({ input }) { return input } })
		const value = runtime(async request => { count += 1; if (count === 1) await first; return completed(request.invocation.parentRunId, request.invocation.invocationId, 'ok') as any }, undefined, limited)
		const pending = value.agents.worker.run({ a: '1' }, { callId: 'one' })
		await expect(value.agents.worker.run({ a: '2' }, { callId: 'two' })).rejects.toMatchObject({ code: 'WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED', meta: { reason: 'max_parallel', limit: 1 } })
		resolveFirst(); await pending
		await expect(value.agents.worker.run({ a: '3' }, { callId: 'three' })).resolves.toBe('ok')
		await expect(value.agents.worker.run({ a: '4' }, { callId: 'four' })).rejects.toMatchObject({ code: 'WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED', meta: { reason: 'max_calls', limit: 2 } })
			const interrupted = runtime(async request => stream([{ type: 'run.finished', runId: request.invocation.invocationId,
				parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId, at: 'now',
				outcome: { status: 'interrupted', runId: request.invocation.invocationId,
					interrupt: { type: 'tool-approval', id: 'approval', revision: 'r1', requests: [] } } }]) as any)
		await interrupted.agents.worker.run({ a: '1' }, { callId: 'interrupt' }).catch(error => expect(isHarnessChildTargetInterruption(error)).toBe(true))
		expect(interrupted.agentCallBudgetState()).toEqual({ schemaVersion: 1, usedCalls: 1 })
	})

	it('rejects malformed restored budget snapshots before exposing execution', () => {
		const workflow = defineWorkflow('budgetValidation', { input: z.string(), output: z.string(), agents: [worker], agentCalls: { maxCalls: 2, maxParallel: 1 }, async handler({ input }) { return input } })
		const create = (restoredAgentCallBudget: any) => createWorkflowExecutionRuntime({ workflow, models: {}, targetDispatcher: { assertTarget: target => testRoute(target), open: async () => { throw new Error('unexpected') } },
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
				return stream([{ type: 'run.finished', runId: request.invocation.invocationId, parentRunId: request.invocation.parentRunId,
					parentInvocationId: request.invocation.invocationId, at: 'now',
					outcome: status === 'failed' ? { status, runId: request.invocation.invocationId, error: { code: 'REMOTE_SECRET', message: 'do not trust' } }
						: { status, runId: request.invocation.invocationId, error: { code: 'REMOTE_CANCEL', message: 'do not trust' } } } as ExecutionEvent]) as any
			}
			const first = runtime(open, checkpoint).agents.worker.run({ a: '1' }, { callId: `terminal-${status}` })
			await expect(first).rejects.toMatchObject({ code: status === 'failed' ? 'WORKFLOW_MANAGED_CALL_FAILED' : 'OPERATION_CANCELLED' })
			const replay = runtime(open, checkpoint).agents.worker.run({ a: '1' }, { callId: `terminal-${status}` })
			await expect(replay).rejects.toMatchObject({ code: status === 'failed' ? 'WORKFLOW_MANAGED_CALL_FAILED' : 'OPERATION_CANCELLED' })
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
