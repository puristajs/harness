import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createHash } from 'node:crypto'

import { defineAgent } from '../src/definitions/agent.js'
import { defineHarness, getHarnessRuntimeBlueprint } from '../src/definitions/harness.js'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import type { ToolApprovalResume } from '../src/approvals/index.js'
import type { HarnessExecutionCaller } from '../src/definitions/types.js'
import {
	HarnessConfigError, HarnessTargetRouteReceiptMismatchError, HostNestedTargetError, InternalError,
	OperationCancelledError, ValidationError,
} from '../src/errors/index.js'
import {
	assertHarnessHostToolOwner, createHostOwnerToken, defineHostTool, instantiateHostedHarness,
	visitHostedHarnessTargets,
	type HarnessHostContextRequest, type HarnessNestedTargetInvoker,
} from '../src/integrator/index.js'
import { hostToolOwner, isHostOwnerToken } from '../src/integrator/host-tool.js'
import type { ExecutionEvent } from '../src/definitions/execution-events.js'
import type {
	AnyHarnessTargetContract, HarnessTargetDispatcher, HarnessTargetDispatchRequest, HarnessTargetDispatchStream,
	HarnessTargetRouteReceiptV1, PersistedHarnessTargetDispatchRequest,
} from '../src/ports/target-dispatcher.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { createTelemetryShim, OtelTelemetryShim } from '../src/telemetry/index.js'
import { canonicalJson } from '../src/runtime/canonical-json.js'
import type { RunCheckpoint } from '../src/storage/execution.js'
import type { JsonValue } from '../src/models/json.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const trace = Object.freeze({
	traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
	tracestate: 'vendor=value',
})
const allowHostedTarget = () => {}

function persistentStorage(): InMemoryHarnessStorage {
	const storage = new InMemoryHarnessStorage()
	const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
	Object.defineProperty(storage, 'capabilities', { value: capabilities })
	Object.defineProperty(storage, 'info', { value: Object.freeze({ ...storage.info, capabilities }) })
	return storage
}

function logger() {
	const value = {
		trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
		child() { return value },
	}
	return value
}

function descriptorGraphContains(root: unknown, target: unknown): boolean {
	const pending = [root]
	const seen = new WeakSet<object>()
	while (pending.length > 0) {
		const current = pending.pop()
		if (current === target) return true
		if ((typeof current !== 'object' || current === null) && typeof current !== 'function') continue
		if (seen.has(current)) continue
		seen.add(current)
		for (const key of Reflect.ownKeys(current)) {
			const descriptor = Object.getOwnPropertyDescriptor(current, key)
			if (descriptor && 'value' in descriptor) pending.push(descriptor.value)
		}
	}
	return false
}

function checkpointKey(kind: 'call' | 'step', hostToolInvocationId: string, id: string): string {
	const tag = kind === 'call' ? 'harness.host-call-key.v1' : 'harness.host-step-key.v1'
	const digest = createHash('sha256').update(canonicalJson([tag, hostToolInvocationId, id])).digest('hex')
	return `host:${kind}:${digest}`
}

function routeFor(target: AnyHarnessTargetContract, fill = 'a'): HarnessTargetRouteReceiptV1 {
	return Object.freeze({ schemaVersion: 1, kind: 'harness_target_route',
		target: Object.freeze({ kind: target.kind, id: target.id }), bindingDigest: `sha256:${fill.repeat(64)}` })
}

function storedRouteFor(kind: 'agent' | 'workflow', id: string, fill = 'a'): HarnessTargetRouteReceiptV1 {
	return Object.freeze({ schemaVersion: 1, kind: 'harness_target_route',
		target: Object.freeze({ kind, id }), bindingDigest: `sha256:${fill.repeat(64)}` })
}

function dispatchStream<Output>(events: readonly ExecutionEvent<Output>[], cancel: (reason?: string) => Promise<void> = async () => {}) {
	const directRunId = events[0]?.runId
	const terminal = events.findLast(event => event.type === 'run.finished' && event.runId === directRunId)
	return Object.freeze({
		result: terminal === undefined ? new Promise<never>(() => {}) : Promise.resolve(terminal.outcome),
		cancel,
		async *[Symbol.asyncIterator]() { yield* events },
	})
}

function dispatcherFor(target: ReturnType<typeof defineAgent>, onOpen: (request: HarnessTargetDispatchRequest<typeof target.contract>) => void) {
	let opens = 0
	let assertions = 0
	let closes = 0
	const route = routeFor(target.contract)
	const dispatcher: HarnessTargetDispatcher & { close(): Promise<void> } = {
		assertTarget(candidate) {
			assertions += 1
			if (candidate !== target.contract) throw new ValidationError('Unknown target.', {
				where: 'invoke_options', issues: { reason: 'unknown_target' },
			})
			return route
		},
		async open(request) {
			dispatcher.assertTarget(request.target)
			opens += 1
			onOpen(request as HarnessTargetDispatchRequest<typeof target.contract>)
			const runId = request.invocation.invocationId
			const parentRunId = request.invocation.parentRunId
			const parentInvocationId = request.invocation.invocationId
			const events: readonly ExecutionEvent<string>[] = Object.freeze([
				Object.freeze({ type: 'run.started', eventId: `${runId}:1`, sequence: 1, runId, parentRunId,
					parentInvocationId, at: '2026-01-01T00:00:00.000Z' }),
				Object.freeze({ type: 'run.finished', eventId: `${runId}:2`, sequence: 2, runId, parentRunId,
					parentInvocationId, at: '2026-01-01T00:00:01.000Z',
					outcome: Object.freeze({ status: 'completed', runId, output: 'child-answer' }) }),
			])
			return dispatchStream(events)
		},
		async openPersisted(request) {
			if (canonicalJson(request.route) !== canonicalJson(route)) throw new Error('unexpected route')
			return dispatcher.open({ target: target.contract, input: request.wireInput, invocation: request.invocation })
		},
		async close() { closes += 1 },
	}
	return { dispatcher, counts: () => ({ opens, assertions, closes }) }
}

function correlateRemoteStream<Output, Interrupt>(
	stream: HarnessTargetDispatchStream<Output, Interrupt>,
	invocation: HarnessTargetDispatchRequest<AnyHarnessTargetContract>['invocation'],
): HarnessTargetDispatchStream<Output, Interrupt> {
	return Object.freeze({
		result: stream.result,
		cancel: (reason?: string) => stream.cancel(reason),
		async *[Symbol.asyncIterator]() {
			for await (const event of stream) yield event.runId === invocation.invocationId
				? Object.freeze({ ...event, parentRunId: invocation.parentRunId, parentInvocationId: invocation.invocationId })
				: event
		},
	})
}

async function interruptedRemoteHostFixture(options: Readonly<{ leafCount?: number; callerWorkflowId?: string; catchNestedTerminal?: boolean }> = {}) {
	const leafCount = options.leafCount ?? 1
	interface HostInvocation { readonly generation?: string }
	interface HostContext {
		readonly generation: string
		readonly nestedTargets: HarnessNestedTargetInvoker
		readonly checkpointStep: HarnessHostContextRequest<HostInvocation>['checkpointStep']
	}
	const storage = persistentStorage()
	const owner = createHostOwnerToken<HostContext>()
	let remoteEffectCalls = 0
	let managedEffects = 0
	const hostContextInvocations: HostInvocation[] = []
	const hostCallers: unknown[] = []
	const remoteEffect = defineTool('bash', {
		description: 'One approval-controlled remote effect.', input: z.string(), output: z.string(),
		async handler(_context, input) { remoteEffectCalls += 1; return `approved:${input}` },
	})
	const child = defineAgent('remoteApprovalChild', {
		input: z.string(), instructions: 'Use the approval effect.', tools: [remoteEffect],
		permissions: { bash: 'require_approval' },
		prompt: input => ({ role: 'user', content: input }),
	})
	const hostTool = defineHostTool(owner, 'remoteChildHost', {
		description: 'Invoke the remote child.', input: z.string(), output: z.string(),
		async handler(context) {
			await context.checkpointStep('before-remote-child', async () => { managedEffects += 1; return 'prepared' })
			try {
				const output = await context.nestedTargets.run(child.contract, 'original-remote-wire-input', { callId: 'remote-child-call' })
				return `${context.generation}:${output}`
			} catch (error) {
				if (options.catchNestedTerminal && (error instanceof HostNestedTargetError || error instanceof OperationCancelledError)) return error.code
				throw error
			}
		},
	})
	const parent = defineAgent('remoteApprovalParent', {
		input: z.string(), instructions: 'Use the host tool.', tools: [hostTool], subagents: { child },
		prompt: input => ({ role: 'user', content: input }),
	})
	const childDefinition = defineHarness({ name: 'remoteApprovalReceiver', revision: 'v1' }).addAgent(child)
	const parentDefinition = defineHarness({ name: 'remoteApprovalCaller', revision: 'v1' }).addAgent(child).addAgent(parent)
	const route = routeFor(child.contract, 'd')
	let currentRoute = route
	let remoteInstance: Awaited<ReturnType<typeof instantiateHostedHarness>> | undefined
	let freshOpens = 0
	let persistedDispatchEffects = 0
	const persistedRequests: PersistedHarnessTargetDispatchRequest[] = []
	const remoteBindings = {
		hostOwner: owner,
		targetDispatcher: undefined as unknown as HarnessTargetDispatcher,
		projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
		projectTraceContext: () => undefined,
		createHostContext: request => Object.freeze({ generation: 'remote', nestedTargets: request.nestedTargets,
			checkpointStep: request.checkpointStep }),
		logger: logger(), telemetry: createTelemetryShim(),
	}
	const dispatcher: HarnessTargetDispatcher = {
		assertTarget(target) {
			if (target !== child.contract) throw new ValidationError('Unknown target.', {
				where: 'invoke_options', issues: { reason: 'unknown_target' },
			})
			return currentRoute
		},
		async open(request) {
			dispatcher.assertTarget(request.target)
			freshOpens += 1
			if (remoteInstance === undefined) throw new Error('Remote instance is unavailable.')
			const { identity: _identity, trace: _trace, ...invocation } = request.invocation
			const opened = await remoteInstance.streamDispatched({ delivery: 'fresh', target: child.contract,
				wireInput: request.input as string, input: request.input as string,
				invocation, hostInvocation: {} })
			return correlateRemoteStream(opened, request.invocation)
		},
		async openPersisted(request) {
			persistedRequests.push(request)
			if (canonicalJson(request.route) !== canonicalJson(currentRoute)) {
				throw new HarnessTargetRouteReceiptMismatchError({ reason: 'route_receipt_mismatch',
					target_kind: request.route.target.kind, target_id: request.route.target.id })
			}
			persistedDispatchEffects += 1
			if (remoteInstance === undefined) throw new Error('Remote instance is unavailable.')
			const { identity: _identity, trace: _trace, ...invocation } = request.invocation
			const opened = await remoteInstance.streamDispatched({ delivery: 'resume', target: child.contract,
				wireInput: request.wireInput as string, invocation, resume: request.resume, hostInvocation: {} })
			return correlateRemoteStream(opened, request.invocation)
		},
	}
	remoteBindings.targetDispatcher = dispatcher

	const startRemote = async (provider: FakeModelProvider) => {
		await remoteInstance?.close()
		remoteInstance = await instantiateHostedHarness(childDefinition,
			{ model: { provider, model: 'fake' }, storage }, remoteBindings)
	}
	const stopRemote = async () => { await remoteInstance?.close(); remoteInstance = undefined }
	const startParent = (provider: FakeModelProvider) => instantiateHostedHarness(parentDefinition,
		{ model: { provider, model: 'fake' }, storage }, {
			hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => undefined,
			createHostContext(request: HarnessHostContextRequest<HostInvocation>) {
				hostContextInvocations.push(request.hostInvocation)
				hostCallers.push(request.caller)
				return Object.freeze({ generation: request.hostInvocation.generation ?? 'initial', nestedTargets: request.nestedTargets,
					checkpointStep: request.checkpointStep })
			},
			logger: logger(), telemetry: createTelemetryShim(),
		})
	const firstRemoteProvider = new FakeModelProvider({ strict: true })
	for (let index = 0; index < leafCount; index += 1) firstRemoteProvider.enqueueText({ content: '', toolCalls: [
		{ id: `remote-effect-call-${index + 1}`, name: remoteEffect.id, arguments: `transfer-${index + 1}` },
	], usage, finishReason: 'tool_calls' })
	await startRemote(firstRemoteProvider)
	const firstParentProvider = new FakeModelProvider({ strict: true })
	firstParentProvider.enqueueText({ content: '', toolCalls: Array.from({ length: leafCount }, (_unused, index) =>
		({ id: `host-call-${index + 1}`, name: hostTool.id, arguments: `start-${index + 1}` })), usage, finishReason: 'tool_calls' })
	const firstParent = await startParent(firstParentProvider)
	const rootInvocation = options.callerWorkflowId === undefined ? undefined : Object.freeze({ sessionId: 'remote-route-session',
		invocationId: 'workflow-parent-agent-run', rootRunId: 'workflow-root-run', parentRunId: 'workflow-run',
		parentWorkflowId: options.callerWorkflowId, depth: 1, remainingDepth: 3, signal: new AbortController().signal })
	let interrupted: any
	if (rootInvocation === undefined) interrupted = await firstParent.runHosted({ delivery: 'fresh', target: parent.contract, wireInput: 'root-input', input: 'root-input',
		invokeOptions: { sessionId: 'remote-route-session', idempotencyKey: 'stable-remote-route-run' }, hostInvocation: {}, authorize: allowHostedTarget })
	else {
		const opened = await firstParent.streamDispatched({ delivery: 'fresh', target: parent.contract, wireInput: 'root-input', input: 'root-input',
			invocation: rootInvocation, hostInvocation: {} })
		for await (const event of opened) if (event.type === 'run.finished' && event.runId === rootInvocation.invocationId) interrupted = event.outcome
	}
	if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') {
		throw new Error('Expected remote child approval interruption.')
	}
	await firstParent.close()
	await remoteInstance.close()
	remoteInstance = undefined

	return {
		storage, owner, child, parent, parentDefinition, interrupted, route, rootInvocation,
		startRemote,
		stopRemote,
		startParent,
		setRoute(next: HarnessTargetRouteReceiptV1) { currentRoute = next },
		counts: () => ({ freshOpens, persistedDispatchEffects, remoteEffectCalls, managedEffects,
			hostContextInvocations, hostCallers, persistedRequests }),
	}
}

describe('hosted Harness runtime', () => {
	it('visits the authentic compiled target closure once in deterministic root-aware order', () => {
		const alpha = defineAgent('alphaDependency', { instructions: 'Dependency.' })
		const zulu = defineAgent('zuluRoot', { instructions: 'Root.', subagents: { alpha } })
		const beta = defineWorkflow('betaRoot', { agents: [alpha], async handler() { return 'done' } })
		const definition = defineHarness({ name: 'visitorHarness', revision: 'v1' }).addAgent(zulu).addWorkflow(beta)
		const entries: Array<Readonly<{ target: AnyHarnessTargetContract; visibility: 'root' | 'dependency' }>> = []

		expect(visitHostedHarnessTargets(definition, entry => entries.push(entry))).toBeUndefined()
		expect(entries.map(entry => [entry.target.kind, entry.target.id, entry.visibility])).toEqual([
			['agent', 'alphaDependency', 'dependency'],
			['agent', 'zuluRoot', 'root'],
			['workflow', 'betaRoot', 'root'],
		])
		expect(entries.map(entry => entry.target)).toEqual([alpha.contract, zulu.contract, beta.contract])
		expect(entries.every(entry => Object.isFrozen(entry))).toBe(true)
		expect(entries.map(entry => Reflect.ownKeys(entry))).toEqual([
			['target', 'visibility'], ['target', 'visibility'], ['target', 'visibility'],
		])

		const emptyVisitor = vi.fn()
		expect(visitHostedHarnessTargets(defineHarness({ name: 'emptyVisitorHarness' }), emptyVisitor)).toBeUndefined()
		expect(emptyVisitor).not.toHaveBeenCalled()
	})

	it('preflights definition authenticity before callbacks and propagates visitor failure exactly', () => {
		const dependency = defineAgent('visitorFailureDependency', { instructions: 'Dependency.' })
		const root = defineWorkflow('visitorFailureRoot', { agents: [dependency], async handler() { return 'done' } })
		const definition = defineHarness({ name: 'visitorFailureHarness', revision: 'v1' }).addWorkflow(root)
		const callback = vi.fn()
		const reflected = {}
		for (const key of Reflect.ownKeys(definition)) {
			Object.defineProperty(reflected, key, Object.getOwnPropertyDescriptor(definition, key)!)
		}
		Object.freeze(reflected)

		for (const candidate of [{ ...definition }, reflected, { kind: 'harness', name: definition.name }]) {
			expect(() => visitHostedHarnessTargets(candidate as typeof definition, callback)).toThrow(expect.objectContaining({
				code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'foreign_definition', path: 'definition' },
			}))
		}
		expect(callback).not.toHaveBeenCalled()

		const sentinel = new Error('visitor failed')
		let callbacks = 0
		expect(() => visitHostedHarnessTargets(definition, () => {
			callbacks += 1
			throw sentinel
		})).toThrow(sentinel)
		expect(callbacks).toBe(1)
	})

	it('dispatches an authentic dependency-only graph target while keeping hosted root entrypoints root-only', async () => {
		const dependency = defineAgent('hostedDependencyOnly', { instructions: 'Answer.' })
		const root = defineWorkflow('hostedDependencyRoot', { agents: [dependency], async handler() { return 'root' } })
		const definition = defineHarness({ name: 'hostedDependencyGraph', revision: 'v1' }).addWorkflow(root)
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: 'dependency answer', toolCalls: [], usage, finishReason: 'stop' })
		const unused = defineAgent('hostedDependencyDispatcherUnused', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const owner = createHostOwnerToken<object>()
		const instance = await instantiateHostedHarness(definition, { model: { provider, model: 'fake' } }, {
			hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => undefined, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim(),
		})
		const opened = await instance.streamDispatched({ delivery: 'fresh', target: dependency.contract,
			wireInput: 'question', input: 'question', invocation: {
				sessionId: 'dependency-session', invocationId: 'dependency-run', rootRunId: 'root-run', parentRunId: 'root-run',
				parentWorkflowId: root.id, depth: 1, remainingDepth: 1, signal: new AbortController().signal,
			}, hostInvocation: {} })
		await expect(opened.result).resolves.toMatchObject({ status: 'completed', runId: 'dependency-run', output: 'dependency answer' })
		for await (const _event of opened) void _event
		await expect(instance.runHosted({ delivery: 'fresh', target: dependency.contract, wireInput: 'question', input: 'question',
			invokeOptions: { sessionId: 'root-only-session' }, hostInvocation: {}, authorize: allowHostedTarget } as never))
			.rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { issues: { reason: 'unknown_hosted_target' } } })
		await expect(instance.streamDispatched({ delivery: 'fresh', target: { ...dependency.contract },
			wireInput: 'question', input: 'question', invocation: {
				sessionId: 'copied-session', invocationId: 'copied-run', rootRunId: 'root-run', parentRunId: 'root-run',
				parentWorkflowId: root.id, depth: 1, remainingDepth: 1, signal: new AbortController().signal,
			}, hostInvocation: {} } as never))
			.rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { issues: { reason: 'unknown_hosted_target' } } })
		const reflectiveCopy = {}
		for (const key of Reflect.ownKeys(dependency.contract)) {
			Object.defineProperty(reflectiveCopy, key, Object.getOwnPropertyDescriptor(dependency.contract, key)!)
		}
		Object.freeze(reflectiveCopy)
		await expect(instance.streamDispatched({ delivery: 'fresh', target: reflectiveCopy,
			wireInput: 'question', input: 'question', invocation: {
				sessionId: 'reflective-session', invocationId: 'reflective-run', rootRunId: 'root-run', parentRunId: 'root-run',
				parentWorkflowId: root.id, depth: 1, remainingDepth: 1, signal: new AbortController().signal,
			}, hostInvocation: {} } as never))
			.rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { issues: { reason: 'unknown_hosted_target' } } })
		await instance.close()
	})

	it('owns exact terminal results for hosted root and dispatched streams independently of iteration', async () => {
		const workflow = defineWorkflow('hostedResultWorkflow', { input: z.string(), output: z.string(),
			async handler({ input }) { return `done:${input}` } })
		const definition = defineHarness({ name: 'hostedResultHarness', revision: 'v1' }).addWorkflow(workflow)
		const unused = defineAgent('unusedHostedResultTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const owner = createHostOwnerToken<object>()
		const instance = await instantiateHostedHarness(definition, { storage: persistentStorage() }, {
			hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => undefined, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim(),
		})
		const hosted = await instance.streamHosted({ delivery: 'fresh', target: workflow.contract, wireInput: 'root', input: 'root',
			invokeOptions: { sessionId: 'hosted-result-root' }, hostInvocation: {}, authorize: allowHostedTarget })
		const hostedOutcome = await hosted.result
		expect(hostedOutcome).toMatchObject({ status: 'completed', output: 'done:root' })
		const hostedEvents = []
		for await (const event of hosted) hostedEvents.push(event)
		expect(hostedEvents.at(-1)).toMatchObject({ type: 'run.finished', outcome: hostedOutcome })

		const invocation = Object.freeze({ sessionId: 'hosted-result-dispatched', invocationId: 'hosted-result-child-run',
			rootRunId: 'hosted-result-root-run', parentRunId: 'hosted-result-parent-run', parentWorkflowId: 'outerWorkflow',
			depth: 1, remainingDepth: 2, signal: new AbortController().signal })
		const dispatched = await instance.streamDispatched({ delivery: 'fresh', target: workflow.contract,
			input: 'child', wireInput: 'child', invocation, hostInvocation: {} })
		const dispatchedOutcome = await dispatched.result
		expect(dispatchedOutcome).toEqual({ status: 'completed', runId: invocation.invocationId, output: 'done:child' })
		const dispatchedEvents = []
		for await (const event of dispatched) dispatchedEvents.push(event)
		expect(dispatchedEvents.at(-1)).toMatchObject({ type: 'run.finished', outcome: dispatchedOutcome })
		await instance.close()
	})

	it('runs a workflow-declared host tool with workflow target context and caller events', async () => {
		interface HostContext { readonly marker: string; readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<HostContext>()
		let hostEffects = 0
		const child = defineAgent('directWorkflowHostChild', { input: z.string(), output: z.string(), instructions: 'Child.', prompt: input => ({ role: 'user', content: input }) })
		const hosted = defineHostTool(owner, 'workflowHostEffect', { description: 'Run a host effect.', input: z.string(), output: z.string(),
			async handler(context, input) { hostEffects += 1; const first = await context.nestedTargets.run(child.contract, input, { callId: 'nested' }); const replay = await context.nestedTargets.run(child.contract, input, { callId: 'nested' }); return `${context.marker}:${first}:${replay}` } })
		const workflow = defineWorkflow('directHostedWorkflow', { input: z.string(), output: z.string(), tools: [hosted], durable: true,
			async handler({ input, tools }) { return tools.workflowHostEffect.run(input, { callId: 'host-effect' }) } })
		const definition = defineHarness({ name: 'directHostedWorkflowHarness', revision: 'v1' }).addWorkflow(workflow)
		const { dispatcher, counts } = dispatcherFor(child, () => {})
		const storage = persistentStorage()
		const projectedTargets: unknown[] = []; const projectedCallers: unknown[] = []
		const instance = await instantiateHostedHarness(definition, { storage }, {
			hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => trace,
			createHostContext: request => { projectedTargets.push(request.target); projectedCallers.push(request.caller); return { marker: 'host', nestedTargets: request.nestedTargets } },
			logger: logger(), telemetry: createTelemetryShim(),
		})
		const result = await instance.runHosted({ delivery: 'fresh', target: workflow.contract, wireInput: 'value', input: 'value', invokeOptions: { sessionId: 'workflow-host-session' }, hostInvocation: {}, authorize: allowHostedTarget })
		expect(result).toMatchObject({ status: 'completed', output: 'host:child-answer:child-answer' })
		expect(hostEffects).toBe(1)
		expect(counts().opens).toBe(1)
		expect(projectedTargets).toEqual([{ kind: 'workflow', id: 'directHostedWorkflow' }])
		expect(projectedCallers).toEqual([{ kind: 'workflow', workflowId: 'directHostedWorkflow' }])
		const events = await storage.listEvents(result.runId)
		expect(events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: 'tool.started', payload: expect.objectContaining({ caller: { kind: 'workflow', workflowId: 'directHostedWorkflow' }, toolId: 'workflowHostEffect', callId: 'host-effect' }) }),
		]))
		await instance.close()
	})

	it('preserves workflow caller lineage for failed nested-target replay', async () => {
		interface HostContext { readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<HostContext>()
		const child = defineAgent('workflowFailureChild', { input: z.string(), output: z.string(), instructions: 'Fail.', prompt: input => ({ role: 'user', content: input }) })
		let opens = 0
		const dispatcher: HarnessTargetDispatcher = {
			assertTarget: target => routeFor(target, 'f'),
			async open(request) { opens += 1; const runId = request.invocation.invocationId; return dispatchStream([{
				type: 'run.finished', eventId: `${runId}:1`, sequence: 1, runId,
					parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId, at: 'now',
					outcome: { status: 'failed', runId, error: { code: 'REMOTE', message: 'secret', category: 'internal', retriable: false } } } as ExecutionEvent<string>]) },
			async openPersisted() { throw new Error('unexpected persisted open') },
		}
		const tool = defineHostTool(owner, 'workflowFailureHost', { description: 'Fail nested.', input: z.string(), output: z.string(), async handler(context, input) {
			for (let attempt = 0; attempt < 2; attempt += 1) await expect(context.nestedTargets.run(child.contract, input, { callId: 'failed' })).rejects.toMatchObject({
				code: 'HOST_NESTED_TARGET_FAILED', meta: { caller: { kind: 'workflow', workflowId: 'workflowFailure' }, caller_run_id: expect.any(String) },
			})
			return 'handled'
		} })
		const workflow = defineWorkflow('workflowFailure', { input: z.string(), output: z.string(), tools: [tool], durable: true,
			async handler({ input, tools }) { return tools.workflowFailureHost.run(input, { callId: 'host' }) } })
		const instance = await instantiateHostedHarness(defineHarness({ name: 'workflowFailureHarness', revision: 'v1' }).addWorkflow(workflow), { storage: persistentStorage() }, {
			hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => undefined,
			createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
		})
		await expect(instance.runHosted({ delivery: 'fresh', target: workflow.contract, wireInput: 'go', input: 'go', invokeOptions: { sessionId: 'workflow-failure-session' }, hostInvocation: {}, authorize: allowHostedTarget }))
			.resolves.toMatchObject({ status: 'completed', output: 'handled' })
		expect(opens).toBe(1)
		await instance.close()
	})

	it('resumes a workflow-originated interrupted host child with workflow caller lineage', async () => {
		interface HostContext { readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<HostContext>()
		let approvedEffects = 0
		const effect = defineTool('bash', { description: 'Approve.', input: z.string(), output: z.string(),
			async handler(_context, input) { approvedEffects += 1; return input } })
		const child = defineAgent('workflowInterruptedChild', { input: z.string(), output: z.string(), instructions: 'Approve.', tools: [effect],
			permissions: { bash: 'require_approval' }, prompt: input => ({ role: 'user', content: input }) })
		const hostTool = defineHostTool(owner, 'workflowInterruptedHost', { description: 'Call child.', input: z.string(), output: z.string(),
			async handler(context, input) { return context.nestedTargets.run(child.contract, input, { callId: 'nested-child' }) } })
		const workflow = defineWorkflow('workflowInterrupted', { input: z.string(), output: z.string(), tools: [hostTool], agents: [child], durable: true,
			async handler({ input, tools }) { return tools.workflowInterruptedHost.run(input, { callId: 'host-call' }) } })
		const definition = defineHarness({ name: 'workflowInterruptedHarness', revision: 'v1', defaults: { maxDepth: 3 } }).addAgent(child).addWorkflow(workflow)
		const storage = persistentStorage(); const route = routeFor(child.contract, '9')
		let current: Awaited<ReturnType<typeof instantiateHostedHarness>> | undefined
		const callers: unknown[] = []
		const dispatcher: HarnessTargetDispatcher = {
			assertTarget(target) { if (target !== child.contract) throw new Error('unexpected target'); return route },
			async open(request) {
				if (current === undefined) throw new Error('runtime unavailable')
				const { identity: _identity, trace: _trace, ...invocation } = request.invocation
				return correlateRemoteStream(await current.streamDispatched({ delivery: 'fresh', target: child.contract,
					wireInput: request.input as string, input: request.input as string, invocation, hostInvocation: {} }), request.invocation)
			},
			async openPersisted(request) {
				if (current === undefined) throw new Error('runtime unavailable')
				const { identity: _identity, trace: _trace, ...invocation } = request.invocation
				return correlateRemoteStream(await current.streamDispatched({ delivery: 'resume', target: child.contract,
					wireInput: request.wireInput as string, invocation, resume: request.resume, hostInvocation: {} }), request.invocation)
			},
		}
		const bindings = { hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => trace,
			createHostContext: (request: HarnessHostContextRequest<object>) => { callers.push(request.caller); return { nestedTargets: request.nestedTargets } },
			logger: logger(), telemetry: createTelemetryShim() }
		const firstProvider = new FakeModelProvider({ strict: true })
		firstProvider.enqueueText({ content: '', toolCalls: [{ id: 'approval-call', name: effect.id, arguments: 'go' }], usage, finishReason: 'tool_calls' })
		current = await instantiateHostedHarness(definition, { model: { provider: firstProvider, model: 'fake' }, storage }, bindings)
		const interrupted = await current.runHosted({ delivery: 'fresh', target: workflow.contract, wireInput: 'go', input: 'go', invokeOptions: {
			sessionId: 'workflow-interrupted-session', idempotencyKey: 'workflow-interrupted-root',
		}, hostInvocation: {}, authorize: allowHostedTarget })
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('Expected workflow host interruption.')
		await current.close()
		const approval = interrupted.interrupt.requests[0]!
		const repeatedProvider = new FakeModelProvider({ strict: true })
		repeatedProvider.enqueueText({ content: '', toolCalls: [{ id: 'approval-call-2', name: effect.id, arguments: 'go-again' }], usage, finishReason: 'tool_calls' })
		current = await instantiateHostedHarness(definition, { model: { provider: repeatedProvider, model: 'fake' }, storage }, bindings)
		const interruptedAgain = await current.runHosted({ delivery: 'resume', target: workflow.contract, wireInput: 'go', invokeOptions: {
			sessionId: 'workflow-interrupted-session', resume: {
				type: 'tool-approval', runId: interrupted.runId, interruptId: interrupted.interrupt.id,
				revision: interrupted.interrupt.revision, eventId: 'workflow-interrupted-resume-1',
				decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {}, authorize: allowHostedTarget })
		if (interruptedAgain.status !== 'interrupted' || interruptedAgain.interrupt.type !== 'tool-approval') throw new Error('Expected repeated workflow host interruption.')
		await current.close()
		const resumedProvider = new FakeModelProvider({ strict: true })
		resumedProvider.enqueueText({ content: 'child-complete', toolCalls: [], usage, finishReason: 'stop' })
		current = await instantiateHostedHarness(definition, { model: { provider: resumedProvider, model: 'fake' }, storage }, bindings)
		const repeatedApproval = interruptedAgain.interrupt.requests[0]!
		await expect(current.runHosted({ delivery: 'resume', target: workflow.contract, wireInput: 'go', invokeOptions: {
			sessionId: 'workflow-interrupted-session', resume: {
				type: 'tool-approval', runId: interruptedAgain.runId, interruptId: interruptedAgain.interrupt.id,
				revision: interruptedAgain.interrupt.revision, eventId: 'workflow-interrupted-resume-2',
				decisions: [{ approvalId: repeatedApproval.approvalId, approved: true }],
			},
		}, hostInvocation: {}, authorize: allowHostedTarget })).resolves.toMatchObject({ status: 'completed', output: 'child-complete' })
		expect(approvedEffects).toBe(2)
		expect(callers).toEqual(callers.map(() => ({ kind: 'workflow', workflowId: 'workflowInterrupted' })))
		const lifecycle = (await storage.listEvents(interrupted.runId)).filter(event => {
			const payload = event.payload as Record<string, unknown>
			return ['tool.input.available', 'tool.started', 'tool.finished'].includes(event.type)
				&& payload['toolId'] === 'workflowInterruptedHost' && payload['callId'] === 'host-call'
		})
		expect(lifecycle.map(event => event.type)).toEqual(['tool.input.available', 'tool.started', 'tool.finished'])
		await current.close()
	})

	it('preserves an agent caller workflow id through hosted interruption and rejects tampering before effects', async () => {
		const fixture = await interruptedRemoteHostFixture({ callerWorkflowId: 'outerWorkflow' })
		const checkpoint = await fixture.storage.loadCheckpoint(fixture.interrupted.runId, 'harness:interrupt:v1')
		if (checkpoint?.output === undefined || fixture.rootInvocation === undefined) throw new Error('Expected hosted lineage checkpoint.')
		const original = structuredClone(checkpoint.output) as Record<string, any>
		expect(original['continuation']['children'][0]['frame']['caller']).toEqual({
			kind: 'agent', agentId: fixture.parent.id, workflowId: 'outerWorkflow',
		})
		const tampered = structuredClone(original) as Record<string, any>
		tampered['continuation']['children'][0]['frame']['caller']['workflowId'] = 'tamperedWorkflow'
		const originalLoad = fixture.storage.loadCheckpoint.bind(fixture.storage)
		const originalAcquire = fixture.storage.acquireRun.bind(fixture.storage)
		const loadSpy = vi.spyOn(fixture.storage, 'loadCheckpoint').mockImplementation(async (runId, stepId) => {
			const value = await originalLoad(runId, stepId)
			return runId === fixture.interrupted.runId && stepId === 'harness:interrupt:v1' && value !== undefined
				? Object.freeze({ ...value, output: tampered }) : value
		})
		const acquireSpy = vi.spyOn(fixture.storage, 'acquireRun').mockImplementation(async request => {
			const lease = await originalAcquire(request)
			if (request.runId !== fixture.interrupted.runId || lease.checkpoint === undefined) return lease
			const selected = Object.freeze({ ...lease.checkpoint, output: tampered })
			return Object.freeze({ ...lease, checkpoint: selected,
				checkpoints: Object.freeze(lease.checkpoints.map(item => item.stepId === selected.stepId ? selected : item)) })
		})
		const approval = fixture.interrupted.interrupt.requests[0]!
		const tamperParent = await fixture.startParent(new FakeModelProvider({ strict: true }))
		const consumeTampered = async () => {
			const stream = await tamperParent.streamDispatched({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input',
				invocation: fixture.rootInvocation, resume: { type: 'tool-approval', runId: fixture.interrupted.runId,
					interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision, eventId: 'workflow-lineage-tamper',
					decisions: [{ approvalId: approval.approvalId, approved: true }] }, hostInvocation: {},
			})
			for await (const _event of stream) void _event
		}
		await expect(consumeTampered()).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'invalid_checkpoint' } })
		expect(fixture.counts()).toMatchObject({ persistedDispatchEffects: 0, remoteEffectCalls: 0 })
		await tamperParent.close(); loadSpy.mockRestore(); acquireSpy.mockRestore(); await fixture.stopRemote()
	})

	it('resumes a hosted agent caller with its exact workflow id', async () => {
		const fixture = await interruptedRemoteHostFixture({ callerWorkflowId: 'outerWorkflow' })
		if (fixture.rootInvocation === undefined) throw new Error('Expected workflow caller invocation.')
		const approval = fixture.interrupted.interrupt.requests[0]!
		const remoteProvider = new FakeModelProvider({ strict: true })
		remoteProvider.enqueueText({ content: 'remote-complete', toolCalls: [], usage, finishReason: 'stop' })
		await fixture.startRemote(remoteProvider)
		const parentProvider = new FakeModelProvider({ strict: true })
		parentProvider.enqueueText({ content: 'parent-complete', toolCalls: [], usage, finishReason: 'stop' })
		const parent = await fixture.startParent(parentProvider)
		const resumed = await parent.streamDispatched({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input',
			invocation: fixture.rootInvocation, resume: { type: 'tool-approval', runId: fixture.interrupted.runId,
				interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision, eventId: 'workflow-lineage-resume',
				decisions: [{ approvalId: approval.approvalId, approved: true }] }, hostInvocation: {},
		})
		let outcome: unknown
		for await (const event of resumed) if (event.type === 'run.finished' && event.runId === fixture.interrupted.runId) outcome = event.outcome
		expect(outcome).toMatchObject({ status: 'completed', output: 'parent-complete' })
		expect(fixture.counts().hostCallers).toEqual(fixture.counts().hostCallers.map(() => ({
			kind: 'agent', agentId: fixture.parent.id, workflowId: 'outerWorkflow',
		})))
		await parent.close(); await fixture.stopRemote()
	})

	it.each(['failed', 'cancelled'] as const)('commits a resumed hosted child %s terminal before the host handler replays it', async status => {
		const fixture = await interruptedRemoteHostFixture({ catchNestedTerminal: true })
		const remoteProvider = new FakeModelProvider({ strict: true })
		vi.spyOn(remoteProvider, 'text').mockRejectedValue(status === 'cancelled'
			? new OperationCancelledError('cancelled', { scope: 'agent' }) : new Error('private provider failure'))
		await fixture.startRemote(remoteProvider)
		const parentProvider = new FakeModelProvider({ strict: true })
		parentProvider.enqueueText({ content: 'parent-complete', toolCalls: [], usage, finishReason: 'stop' })
		const committed: any[] = []
		const originalCommit = fixture.storage.commitCheckpoint.bind(fixture.storage)
		vi.spyOn(fixture.storage, 'commitCheckpoint').mockImplementation(async checkpoint => {
			if ((checkpoint.output as any)?.kind === 'host_nested_target') committed.push(checkpoint.output)
			return originalCommit(checkpoint)
		})
		const parent = await fixture.startParent(parentProvider)
		const approval = fixture.interrupted.interrupt.requests[0]!
		await expect(parent.runHosted({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId, interruptId: fixture.interrupted.interrupt.id,
				revision: fixture.interrupted.interrupt.revision, eventId: `resumed-${status}`,
				decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {}, authorize: allowHostedTarget })).resolves.toMatchObject({ status: 'completed', output: 'parent-complete' })
		expect(committed).toEqual([expect.objectContaining({ kind: 'host_nested_target', outcome: expect.objectContaining({ status }) })])
		expect(JSON.stringify(parentProvider.requests[0])).toContain(status === 'cancelled' ? 'OPERATION_CANCELLED' : 'HOST_NESTED_TARGET_FAILED')
		await parent.close(); await fixture.stopRemote()
	})

	it('requires factory-authentic owners and rejects a different owner before runtime initialization', async () => {
		interface Context { readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<Context>()
		const otherOwner = createHostOwnerToken<Context>()
		expect(Object.isFrozen(owner)).toBe(true)
		expect(() => defineHostTool({} as never, 'forged', {
			description: 'Forged.', input: z.string(), output: z.string(), async handler(_context, input) { return input },
		})).toThrow(HarnessConfigError)

		const hosted = defineHostTool(owner, 'hostedLookup', {
			description: 'Call the host.', input: z.string(), output: z.string(), async handler(_context, input) { return input },
		})
		const infer = Object.getOwnPropertyDescriptor(hosted, '$infer')
		expect(infer).toMatchObject({ enumerable: false, configurable: false, writable: false })
		expect(Object.isFrozen(infer?.value)).toBe(true)
		expect({ ...hosted }).not.toHaveProperty('$infer')
		const agent = defineAgent('ownerAgent', { instructions: 'Call.', tools: [hosted] })
		const definition = defineHarness({ name: 'ownerHarness', revision: 'v1' }).addAgent(agent)
		let initialized = 0
		const provider = new FakeModelProvider()
		const target = defineAgent('unusedTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(target, () => { initialized += 1 })
		await expect(instantiateHostedHarness(definition, {
			model: { provider, model: 'fake' }, storage: persistentStorage(),
		}, {
			hostOwner: otherOwner, targetDispatcher: dispatcher,
			projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => undefined,
			createHostContext: () => ({ nestedTargets: {} as HarnessNestedTargetInvoker }), logger: logger(), telemetry: createTelemetryShim(),
		})).rejects.toMatchObject({ meta: { reason: 'host_owner_mismatch', path: 'hostOwner', id: 'hostedLookup' } })
		expect(initialized).toBe(0)

		const copiedOwner = Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(owner)))
		const portable = defineHarness({ name: 'portableHostedOwner' }).addAgent(defineAgent('portableHostedOwnerAgent', {
			instructions: 'Answer.',
		}))
		let configReads = 0
		const unreadConfig = new Proxy({}, { get() { configReads += 1; throw new Error('runtime config was read') } })
		await expect(instantiateHostedHarness(portable, unreadConfig as never, {
			hostOwner: copiedOwner as never, targetDispatcher: dispatcher,
			projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => undefined,
			createHostContext: () => ({ nestedTargets: {} as HarnessNestedTargetInvoker }), logger: logger(), telemetry: createTelemetryShim(),
		})).rejects.toMatchObject({ meta: { reason: 'invalid_host_binding', path: 'hostBindings.hostOwner' } })
		expect(configReads).toBe(0)
		expect(initialized).toBe(0)
	})

	it('authenticates host-tool ownership with the same sorted preflight used by hosted instantiation', () => {
		const owner = createHostOwnerToken<object>()
		const otherOwner = createHostOwnerToken<object>()
		const owned = defineHostTool(owner, 'zOwned', {
			description: 'Owned.', input: z.string(), output: z.string(), async handler(_context, input) { return input },
		})
		const foreign = defineHostTool(otherOwner, 'aForeign', {
			description: 'Foreign.', input: z.string(), output: z.string(), async handler(_context, input) { return input },
		})
		const ownedDefinition = defineHarness({ name: 'ownedPreflight', revision: 'v1' }).addAgent(defineAgent('ownedPreflightAgent', {
			instructions: 'Call.', tools: [owned],
		}))
		const blueprint = getHarnessRuntimeBlueprint(ownedDefinition)!
		const inspection = ownedDefinition.inspect()
		expect(descriptorGraphContains(ownedDefinition, blueprint)).toBe(false)
		expect(descriptorGraphContains(ownedDefinition, blueprint.graph)).toBe(false)
		expect(ownedDefinition.inspect()).toEqual(inspection)
		const definition = defineHarness({ name: 'ownerPreflight', revision: 'v1' }).addAgent(defineAgent('ownerPreflightAgent', {
			instructions: 'Call.', tools: [owned, foreign],
		}))

		expect(assertHarnessHostToolOwner(ownedDefinition, owner)).toBeUndefined()
		expect(() => assertHarnessHostToolOwner(definition, owner)).toThrowError(expect.objectContaining({
			meta: { reason: 'host_owner_mismatch', path: 'hostOwner', id: 'aForeign' },
		}))
		expect(() => assertHarnessHostToolOwner({ ...definition } as never, owner)).toThrowError(expect.objectContaining({
			meta: { reason: 'foreign_definition', path: 'definition' },
		}))
		expect(() => assertHarnessHostToolOwner(definition, {} as never)).toThrowError(expect.objectContaining({
			meta: { reason: 'invalid_host_binding', path: 'hostOwner' },
		}))
		const copiedOwner = Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(owner)))
		expect(isHostOwnerToken(copiedOwner)).toBe(false)
		expect(() => defineHostTool(copiedOwner as never, 'copiedOwnerTool', {
			description: 'Copied owner.', input: z.string(), output: z.string(), async handler(_context, input) { return input },
		})).toThrowError(expect.objectContaining({ meta: { reason: 'invalid_host_binding', path: 'hostOwner' } }))
		const portableDefinition = defineHarness({ name: 'portableOwnerPreflight' }).addAgent(defineAgent('portableOwnerAgent', {
			instructions: 'Answer.',
		}))
		expect(() => assertHarnessHostToolOwner(portableDefinition, copiedOwner as never)).toThrowError(expect.objectContaining({
			meta: { reason: 'invalid_host_binding', path: 'hostOwner' },
		}))
		expect(() => assertHarnessHostToolOwner(ownedDefinition, copiedOwner as never)).toThrowError(expect.objectContaining({
			meta: { reason: 'invalid_host_binding', path: 'hostOwner' },
		}))
		const copiedTool = Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(owned)))
		expect(hostToolOwner(copiedTool)).toBeUndefined()
		const copiedToolDefinition = defineHarness({ name: 'copiedToolPreflight', revision: 'v1' }).addAgent(defineAgent('copiedToolAgent', {
			instructions: 'Call.', tools: [copiedTool as never],
		}))
		expect(() => assertHarnessHostToolOwner(copiedToolDefinition, owner)).toThrowError(expect.objectContaining({
			meta: { reason: 'host_owner_mismatch', path: 'hostOwner', id: 'zOwned' },
		}))
		const copiedDefinition = Object.freeze(Object.defineProperties({}, Object.getOwnPropertyDescriptors(ownedDefinition)))
		expect(() => assertHarnessHostToolOwner(copiedDefinition as never, owner)).toThrowError(expect.objectContaining({
			meta: { reason: 'foreign_definition', path: 'definition' },
		}))
	})

	it('validates hosted requests before projecting, projects once, and does not reparse validated root input', async () => {
		let transforms = 0
		const input = z.string().transform(value => { transforms += 1; return value.length })
		const agent = defineAgent('validatedRoot', {
			input, instructions: 'Answer.', prompt: value => ({ role: 'user', content: String(value) }),
		})
		const definition = defineHarness({ name: 'validatedHosted' }).addAgent(agent)
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		const storage = persistentStorage()
		const authorizations: unknown[] = []
		let identities = 0
		let traces = 0
		const unused = defineAgent('unusedValidationTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const owner = createHostOwnerToken<object>()
		const instance = await instantiateHostedHarness(definition, { model: { provider, model: 'fake' }, storage }, {
			hostOwner: owner, targetDispatcher: dispatcher,
			projectIdentity: () => { identities += 1; return { tenantId: 'tenant-a', principalId: 'principal-a' } },
			projectTraceContext: () => { traces += 1; return trace }, createHostContext: () => ({}),
			logger: logger(), telemetry: createTelemetryShim(),
		})
		const invalidRequests: ReadonlyArray<readonly [Record<PropertyKey, unknown>, string]> = [
			[{ target: agent.contract, wireInput: 'hello', input: 5, invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: {}, authorize: allowHostedTarget }, 'delivery'],
			[{ delivery: 'fresh', wireInput: 'hello', input: 5, invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: {}, authorize: allowHostedTarget }, 'target'],
			[{ delivery: 'fresh', target: agent.contract, input: 5, invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: {}, authorize: allowHostedTarget }, 'wireInput'],
			[{ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5, hostInvocation: {}, authorize: allowHostedTarget }, 'invokeOptions'],
			[{ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5, invokeOptions: { sessionId: 'hosted-session' }, authorize: allowHostedTarget }, 'hostInvocation'],
			[{ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5, invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: {} }, 'authorize'],
			[{ delivery: 'fresh', target: agent.contract, wireInput: 'hello', invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: {}, authorize: allowHostedTarget }, 'input'],
			[{ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5, invokeOptions: { sessionId: 'hosted-session', resume: undefined }, hostInvocation: {}, authorize: allowHostedTarget }, 'resume'],
			[{ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5, invokeOptions: { sessionId: 'hosted-session', resumeIdentity: undefined }, hostInvocation: {}, authorize: allowHostedTarget }, 'resumeIdentity'],
			[{ delivery: 'resume', target: agent.contract, wireInput: 'hello', input: undefined, invokeOptions: { sessionId: 'hosted-session', resume: {} }, hostInvocation: {}, authorize: allowHostedTarget }, 'input'],
			[{ delivery: 'resume', target: agent.contract, wireInput: 'hello', invokeOptions: { sessionId: 'hosted-session', resume: {}, idempotencyKey: undefined }, hostInvocation: {}, authorize: allowHostedTarget }, 'idempotencyKey'],
			[{ delivery: 'resume', target: agent.contract, wireInput: 'hello', invokeOptions: { sessionId: 'hosted-session', resume: undefined }, hostInvocation: {}, authorize: allowHostedTarget }, 'resume'],
			[{ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5, invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: {}, authorize: allowHostedTarget, extra: true }, 'extra'],
		]
		for (const [request, field] of invalidRequests) {
			await expect(instance.runHosted(request as never)).rejects.toMatchObject({
				code: 'VALIDATION_ERROR', meta: { issues: { reason: 'invalid_hosted_request', field } },
			})
		}
		expect({ identities, traces }).toEqual({ identities: 0, traces: 0 })
		await expect(instance.runHosted({ delivery: 'fresh', target: { ...agent.contract } as never, wireInput: 5, input: 5,
			invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: Object.freeze({ token: 'opaque' }), authorize: allowHostedTarget }))
			.rejects.toBeInstanceOf(ValidationError)
		expect({ identities, traces }).toEqual({ identities: 0, traces: 0 })
		await expect(instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: new Date() as never, input: new Date() as never,
			invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: Object.freeze({ token: 'opaque' }), authorize: allowHostedTarget }))
			.rejects.toBeInstanceOf(ValidationError)
		const boundaryAuthorize = vi.fn()
		const hiddenWireInput = Object.defineProperty({}, 'secret', { enumerable: false, value: 'private' })
		const hiddenValidatedInput = Object.defineProperty([], '0', { enumerable: false, value: 'private' })
		for (const request of [
			{ delivery: 'fresh', target: agent.contract, wireInput: hiddenWireInput, input: 5,
				invokeOptions: { sessionId: 'hidden-wire-session' }, hostInvocation: {}, authorize: boundaryAuthorize },
			{ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: hiddenValidatedInput,
				invokeOptions: { sessionId: 'hidden-input-session' }, hostInvocation: {}, authorize: boundaryAuthorize },
		] as const) {
			await expect(instance.runHosted(request as never)).rejects.toMatchObject({
				code: 'VALIDATION_ERROR', meta: { issues: { reason: 'non_json_input' } },
			})
		}
		expect(boundaryAuthorize).not.toHaveBeenCalled()
		expect({ identities, traces }).toEqual({ identities: 0, traces: 0 })
		for (const field of ['traceparent', 'tracestate'] as const) {
			await expect(instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 5, input: 5, invokeOptions: {
				sessionId: 'hosted-session', [field]: 'caller-owned',
			} as never, hostInvocation: Object.freeze({ token: 'opaque' }), authorize: allowHostedTarget })).rejects.toMatchObject({
				meta: { where: 'invoke_options', issues: { reason: 'host_owned_trace_context', field } },
			})
		}
		const aborted = new AbortController()
		aborted.abort('private cancellation detail')
		await expect(instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 5, input: 5,
			invokeOptions: { sessionId: 'hosted-session', signal: aborted.signal }, hostInvocation: Object.freeze({ token: 'opaque' }), authorize: allowHostedTarget }))
			.rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
		expect({ identities, traces }).toEqual({ identities: 0, traces: 0 })
		const denied = new Error('host business authorization denied')
		await expect(instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5,
			invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: Object.freeze({ token: 'opaque' }), authorize: () => { throw denied } }))
			.rejects.toBe(denied)
		expect(await storage.getSession('hosted-session')).toBeUndefined()
		expect(await storage.listRuns('hosted-session')).toEqual([])
		expect({ identities, traces, transforms }).toEqual({ identities: 1, traces: 1, transforms: 0 })
		const cancelledAfterAuthorization = new AbortController()
		await expect(instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5,
			invokeOptions: { sessionId: 'post-authorization-cancel', signal: cancelledAfterAuthorization.signal }, hostInvocation: {},
			authorize: () => { cancelledAfterAuthorization.abort('private post-authorization cancellation') },
		})).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
		expect(await storage.getSession('post-authorization-cancel')).toBeUndefined()
		expect(await storage.listRuns('post-authorization-cancel')).toEqual([])
		await expect(instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5,
			invokeOptions: { sessionId: 'post-authorization-timeout', timeoutMs: 1 }, hostInvocation: {},
			authorize: async () => { await new Promise(resolve => setTimeout(resolve, 5)) },
		})).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
		expect(await storage.getSession('post-authorization-timeout')).toBeUndefined()
		expect(await storage.listRuns('post-authorization-timeout')).toEqual([])

		await expect(instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5,
			invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: Object.freeze({ token: 'opaque' }), authorize: request => {
				authorizations.push(request)
				expect(Object.isFrozen(request)).toBe(true)
			} }))
			.resolves.toMatchObject({ status: 'completed', output: 'done' })
		expect({ identities, traces, transforms }).toEqual({ identities: 4, traces: 4, transforms: 0 })
		expect(authorizations).toEqual([{ delivery: 'fresh', target: agent.contract, input: 5 }])
		expect(await storage.listRuns('hosted-session')).toEqual([
			expect.objectContaining({ kind: 'agent', input: 'hello', validatedInput: 5 }),
		])
		await instance.close()
	})

	it('validates dispatched delivery before projection and preserves fresh wire input without reparsing', async () => {
		let transforms = 0
		let identities = 0
		let traces = 0
		const input = z.string().transform(value => { transforms += 1; return value.length })
		const owner = createHostOwnerToken<object>()
		const unusedHostTool = defineHostTool(owner, 'unusedDispatchedHostTool', {
			description: 'Unused.', input: z.string(), output: z.string(), async handler(_context, value) { return value },
		})
		const agent = defineAgent('dispatchedValidatedRoot', {
			input, instructions: 'Answer.', tools: [unusedHostTool], prompt: value => ({ role: 'user', content: String(value) }),
		})
		const definition = defineHarness({ name: 'dispatchedValidatedHarness', revision: 'v1' }).addAgent(agent)
		const storage = persistentStorage()
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		const unused = defineAgent('unusedDispatchedTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const instance = await instantiateHostedHarness(definition, { model: { provider, model: 'fake' }, storage }, {
			hostOwner: owner, targetDispatcher: dispatcher,
			projectIdentity: () => { identities += 1; return { tenantId: 'tenant-a', principalId: 'principal-a' } },
			projectTraceContext: () => { traces += 1; return trace }, createHostContext: () => ({}),
			logger: logger(), telemetry: createTelemetryShim(),
		})
		const invocation = Object.freeze({ sessionId: 'dispatched-session', invocationId: 'dispatched-child-run',
			rootRunId: 'dispatched-root-run', parentRunId: 'dispatched-parent-run', parentAgentId: 'parent-agent',
			depth: 1, remainingDepth: 2, signal: new AbortController().signal })
		await expect(instance.streamDispatched({ delivery: 'resume', target: agent.contract, wireInput: 'hello', invocation,
			resume: { type: 'tool-approval', runId: invocation.invocationId, interruptId: 'interrupt', revision: 'revision',
				eventId: 'event', decisions: [
					{ approvalId: 'duplicate', approved: true }, { approvalId: 'duplicate', approved: false },
				] }, hostInvocation: {},
		})).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'decision_set_mismatch' } })
		await expect(instance.streamDispatched({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5,
			invocation: { ...invocation, identity: { tenantId: 'caller-controlled' } }, hostInvocation: {},
		} as never)).rejects.toMatchObject({ meta: { issues: { reason: 'invalid_hosted_dispatch_request', field: 'invocation.identity' } } })
		expect({ identities, traces, transforms }).toEqual({ identities: 0, traces: 0, transforms: 0 })

		const stream = await instance.streamDispatched({ delivery: 'fresh', target: agent.contract,
			wireInput: 'hello', input: 5, invocation, hostInvocation: {} })
		let terminal: ExecutionEvent<number> | undefined
		for await (const event of stream) if (event.type === 'run.finished') terminal = event
		expect(terminal).toMatchObject({ type: 'run.finished', outcome: { status: 'completed', output: 'done' } })
		expect((await storage.getRun(invocation.invocationId))?.input).toBe('hello')
		expect({ identities, traces, transforms }).toEqual({ identities: 1, traces: 1, transforms: 0 })
		await instance.close()
	})

	it('restores and authorizes the stored validated root input before resuming or replaying a terminal result', async () => {
		let transforms = 0
		let effects = 0
		const input = z.string().transform(value => { transforms += 1; return value.length })
		const effect = defineTool('bash', { description: 'Approval effect.', input: z.string(), output: z.string(),
			async handler(_context, value) { effects += 1; return value } })
		const agent = defineAgent('hostedResumeRoot', { input, instructions: 'Use the effect.', tools: [effect],
			permissions: { bash: 'require_approval' }, prompt: value => ({ role: 'user', content: String(value) }) })
		const definition = defineHarness({ name: 'hostedResumeHarness', revision: 'v1' }).addAgent(agent)
		const storage = persistentStorage()
		const unused = defineAgent('unusedResumeDispatchTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const owner = createHostOwnerToken<object>()
		const bindings = { hostOwner: owner, targetDispatcher: dispatcher,
			projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => undefined, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim() }

		const firstProvider = new FakeModelProvider({ strict: true })
		firstProvider.enqueueText({ content: '', toolCalls: [{ id: 'effect-call', name: effect.id, arguments: 'run' }], usage, finishReason: 'tool_calls' })
		let instance = await instantiateHostedHarness(definition, { model: { provider: firstProvider, model: 'fake' }, storage }, bindings)
		const interrupted = await instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 5,
			invokeOptions: { sessionId: 'hosted-resume-session' }, hostInvocation: {}, authorize: allowHostedTarget })
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('Expected approval interruption.')
		await instance.close()
		const approval = interrupted.interrupt.requests[0]!
		const resume = Object.freeze({ type: 'tool-approval' as const, runId: interrupted.runId,
			interruptId: interrupted.interrupt.id, revision: interrupted.interrupt.revision, eventId: 'hosted-resume-event',
			decisions: Object.freeze([{ approvalId: approval.approvalId, approved: true }]) })
		const authorized: unknown[] = []
		const resumedProvider = new FakeModelProvider({ strict: true })
		resumedProvider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		instance = await instantiateHostedHarness(definition, { model: { provider: resumedProvider, model: 'fake' }, storage }, bindings)
		await expect(instance.runHosted({ delivery: 'resume', target: agent.contract, wireInput: 'hello',
			invokeOptions: { sessionId: 'hosted-resume-session', resume }, hostInvocation: {}, authorize: request => { authorized.push(request) } }))
			.resolves.toMatchObject({ status: 'completed', output: 'done' })
		expect(authorized).toEqual([{ delivery: 'resume', target: agent.contract, input: 5 }])
		expect({ transforms, effects }).toEqual({ transforms: 0, effects: 1 })
		expect(await storage.loadCheckpoint(interrupted.runId, 'harness:interrupt:v1')).toBeUndefined()
		await instance.close()

		const replayProvider = new FakeModelProvider({ strict: true })
		instance = await instantiateHostedHarness(definition, { model: { provider: replayProvider, model: 'fake' }, storage }, bindings)
		const eventsBeforeReplay = await storage.listEvents(interrupted.runId)
		const acquireRun = vi.spyOn(storage, 'acquireRun')
		const originalGetRun = storage.getRun.bind(storage)
		let terminalReads = 0
		const deletingGetRun = vi.spyOn(storage, 'getRun').mockImplementation(async runId => {
			const run = await originalGetRun(runId)
			terminalReads += 1
			return terminalReads === 2 ? undefined : run
		})
		const staleAuthorizer = vi.fn()
		await expect(instance.runHosted({ delivery: 'resume', target: agent.contract, wireInput: 'hello',
			invokeOptions: { sessionId: 'hosted-resume-session', resume }, hostInvocation: {}, authorize: staleAuthorizer }))
			.rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'stale_continuation' } })
		expect(staleAuthorizer).toHaveBeenCalledOnce()
		expect(await storage.listEvents(interrupted.runId)).toEqual(eventsBeforeReplay)
		expect({ transforms, effects }).toEqual({ transforms: 0, effects: 1 })
		deletingGetRun.mockRestore()
		const replayAuthorizer = vi.fn()
		await expect(instance.runHosted({ delivery: 'resume', target: agent.contract, wireInput: 'hello',
			invokeOptions: { sessionId: 'hosted-resume-session', resume }, hostInvocation: {}, authorize: replayAuthorizer }))
			.resolves.toMatchObject({ status: 'completed', output: 'done' })
		expect(replayAuthorizer).toHaveBeenCalledWith({ delivery: 'resume', target: agent.contract, input: 5 })
		expect({ transforms, effects }).toEqual({ transforms: 0, effects: 1 })
		const concurrentAuthorizer = vi.fn(async () => { await Promise.resolve() })
		const replayRequest = () => instance.runHosted({ delivery: 'resume' as const, target: agent.contract, wireInput: 'hello',
			invokeOptions: { sessionId: 'hosted-resume-session', resume }, hostInvocation: {}, authorize: concurrentAuthorizer })
		await expect(Promise.all([replayRequest(), replayRequest()])).resolves.toEqual([
			expect.objectContaining({ status: 'completed', output: 'done' }),
			expect.objectContaining({ status: 'completed', output: 'done' }),
		])
		expect(concurrentAuthorizer).toHaveBeenCalledTimes(2)
		expect(acquireRun).not.toHaveBeenCalled()
		expect(await storage.listEvents(interrupted.runId)).toEqual(eventsBeforeReplay)
		expect(replayProvider.requests).toHaveLength(0)
		acquireRun.mockRestore()
		await instance.close()
	})

	it('uses the current reviewer for authorization and host bindings while stored-run-owner execution keeps the creation identity', async () => {
		interface HostInvocation {
			readonly tenantId: string
			readonly principalId: string
			readonly token: string
		}
		interface HostContext { readonly token: string }
		const owner = createHostOwnerToken<HostContext>()
		const effects: string[] = []
		const publicObservability: unknown[] = []
		const spanSpy = vi.spyOn(OtelTelemetryShim.prototype, 'span').mockImplementation(async (name, attrs, fn) => {
			publicObservability.push({ kind: 'span', name, attrs })
			const span = {
				setAttribute() { return span }, setAttributes(next: Record<string, unknown>) { publicObservability.push(next); return span },
				addEvent() { return span }, addLink() { return span }, addLinks() { return span }, updateName() { return span },
				recordException(error: unknown) { publicObservability.push(error) }, setStatus(status: unknown) { publicObservability.push(status); return span },
				end() {}, isRecording() { return true }, spanContext() { return { traceId: '', spanId: '', traceFlags: 0 } },
			} as never
			return fn(span)
		})
		const histogramSpy = vi.spyOn(OtelTelemetryShim.prototype, 'recordHistogram').mockImplementation((name, value, attrs) => {
			publicObservability.push({ kind: 'histogram', name, value, attrs })
		})
		const counterSpy = vi.spyOn(OtelTelemetryShim.prototype, 'recordCounter').mockImplementation((name, value, attrs) => {
			publicObservability.push({ kind: 'counter', name, value, attrs })
		})
		const publicLogs: unknown[] = []
		const capturedLogger = {
			trace(message: string, fields?: Record<string, unknown>) { publicLogs.push({ message, fields }) },
			debug(message: string, fields?: Record<string, unknown>) { publicLogs.push({ message, fields }) },
			info(message: string, fields?: Record<string, unknown>) { publicLogs.push({ message, fields }) },
			warn(message: string, fields?: Record<string, unknown>) { publicLogs.push({ message, fields }) },
			error(message: string, fields?: Record<string, unknown>) { publicLogs.push({ message, fields }) },
			fatal(message: string, fields?: Record<string, unknown>) { publicLogs.push({ message, fields }) },
			child(fields: Record<string, unknown>) { publicLogs.push({ child: fields }); return capturedLogger },
		}
		const effect = defineHostTool(owner, 'bash', {
			description: 'An approval-controlled host effect.', input: z.string(), output: z.string(),
			async handler(context, value) { effects.push(context.token); return value },
		})
		const agent = defineAgent('storedOwnerRoot', {
			input: z.string(), instructions: 'Use the reviewed effect.', tools: [effect],
			permissions: { bash: 'require_approval' }, prompt: value => ({ role: 'user', content: value }),
		})
		const definition = defineHarness({ name: 'storedOwnerHarness', revision: 'v1' }).addAgent(agent)
		const storage = persistentStorage()
		const unused = defineAgent('unusedStoredOwnerDispatchTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const bindings = {
			hostOwner: owner, targetDispatcher: dispatcher,
			projectIdentity: (invocation: HostInvocation) => Object.freeze({ tenantId: invocation.tenantId, principalId: invocation.principalId }),
			projectTraceContext: () => undefined,
			createHostContext: (request: HarnessHostContextRequest<HostInvocation>) => Object.freeze({ token: request.hostInvocation.token }),
			logger: capturedLogger, telemetry: createTelemetryShim(),
		}
		const creator = Object.freeze({ tenantId: 'tenant-a-private', principalId: 'owner-private', token: 'creator-host-context' })
		const firstProvider = new FakeModelProvider({ strict: true })
		firstProvider.enqueueText({ content: '', toolCalls: [{ id: 'reviewed-effect-call', name: effect.id, arguments: 'run' }], usage, finishReason: 'tool_calls' })
		let instance = await instantiateHostedHarness(definition, { model: { provider: firstProvider, model: 'fake' }, storage }, bindings)
		const interrupted = await instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'wire-request', input: 'validated-input-private',
			invokeOptions: { sessionId: 'stored-owner-session' }, hostInvocation: creator, authorize: allowHostedTarget })
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('Expected approval interruption.')
		await instance.close()
		const approval = interrupted.interrupt.requests[0]!
		const resume = Object.freeze({ type: 'tool-approval' as const, runId: interrupted.runId,
			interruptId: interrupted.interrupt.id, revision: interrupted.interrupt.revision, eventId: 'stored-owner-resume-event',
			decisions: Object.freeze([{ approvalId: approval.approvalId, approved: true }]) })
		const resumedProvider = new FakeModelProvider({ strict: true })
		resumedProvider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		instance = await instantiateHostedHarness(definition, { model: { provider: resumedProvider, model: 'fake' }, storage }, bindings)
		const rejectedAuthorizer = vi.fn()
		const reviewer = Object.freeze({ tenantId: 'tenant-a-private', principalId: 'reviewer-private', token: 'reviewer-host-context' })
		const currentCallerError = await instance.runHosted({ delivery: 'resume', target: agent.contract, wireInput: 'wire-request',
			invokeOptions: { sessionId: 'stored-owner-session', resume }, hostInvocation: reviewer, authorize: rejectedAuthorizer })
			.catch(error => error)
		expect(currentCallerError).toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'session_identity_mismatch' } })
		for (const malformedReviewer of [
			{ tenantId: '', principalId: 'reviewer-private', token: 'empty-tenant-host-context' },
			{ tenantId: 'tenant-a-private', principalId: '', token: 'empty-principal-host-context' },
		]) {
			const malformedError = await instance.runHosted({ delivery: 'resume', target: agent.contract, wireInput: 'wire-request',
				invokeOptions: { sessionId: 'stored-owner-session', resume }, hostInvocation: malformedReviewer,
				authorize: rejectedAuthorizer }).catch(error => error)
			expect(malformedError).toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'session_identity_mismatch' } })
		}
		const crossTenantError = await instance.runHosted({ delivery: 'resume', target: agent.contract, wireInput: 'wire-request',
			invokeOptions: { sessionId: 'stored-owner-session', resume, resumeIdentity: 'stored-run-owner' },
			hostInvocation: { tenantId: 'tenant-b-private', principalId: 'reviewer-private', token: 'cross-tenant-host-context' }, authorize: rejectedAuthorizer })
			.catch(error => error)
		expect(crossTenantError).toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'session_identity_mismatch' } })
		expect(rejectedAuthorizer).not.toHaveBeenCalled()
		const authorized = vi.fn()
		const completed = await instance.runHosted({ delivery: 'resume', target: agent.contract, wireInput: 'wire-request',
			invokeOptions: { sessionId: 'stored-owner-session', resume, resumeIdentity: 'stored-run-owner' },
			hostInvocation: reviewer, authorize: authorized })
		expect(completed).toMatchObject({ status: 'completed', output: 'done' })
		expect(authorized).toHaveBeenCalledWith({ delivery: 'resume', target: agent.contract, input: 'validated-input-private' })
		expect(effects).toEqual(['reviewer-host-context'])
		expect((await storage.getSession('stored-owner-session'))?.identity).toEqual({ tenantId: 'tenant-a-private', principalId: 'owner-private' })
		const publicProjection = JSON.stringify({ completed, currentCallerError, crossTenantError,
			events: await storage.listEvents(interrupted.runId), inspection: definition.inspect(), publicLogs, publicObservability })
		for (const secret of ['tenant-a-private', 'tenant-b-private', 'owner-private', 'reviewer-private', 'validated-input-private']) {
			expect(publicProjection).not.toContain(secret)
		}
		await instance.close()
		spanSpy.mockRestore()
		histogramSpy.mockRestore()
		counterSpy.mockRestore()
	})

	it.each(['failed', 'cancelled'] as const)('reauthorizes and replays a hosted root %s terminal without a lease or execution', async status => {
		const effect = defineTool('bash', { description: 'Approval effect.', input: z.string(), output: z.string(),
			async handler(_context, value) { return value } })
		const agent = defineAgent(`terminalReplay${status}`, { input: z.string(), instructions: 'Use the effect.', tools: [effect],
			permissions: { bash: 'require_approval' }, prompt: value => ({ role: 'user', content: value }) })
		const definition = defineHarness({ name: `terminalReplayHarness${status}`, revision: 'v1' }).addAgent(agent)
		const storage = persistentStorage()
		const unused = defineAgent(`unusedTerminalReplay${status}`, { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const owner = createHostOwnerToken<object>()
		const bindings = { hostOwner: owner, targetDispatcher: dispatcher,
			projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => undefined, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim() }
		const firstProvider = new FakeModelProvider({ strict: true })
		firstProvider.enqueueText({ content: '', toolCalls: [{ id: `terminal-${status}-call`, name: effect.id, arguments: 'run' }], usage, finishReason: 'tool_calls' })
		let instance = await instantiateHostedHarness(definition, { model: { provider: firstProvider, model: 'fake' }, storage }, bindings)
		const interrupted = await instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'request', input: 'request',
			invokeOptions: { sessionId: `terminal-${status}-session` }, hostInvocation: {}, authorize: allowHostedTarget })
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('Expected approval interruption.')
		await instance.close()
		const approval = interrupted.interrupt.requests[0]!
		const resume = Object.freeze({ type: 'tool-approval' as const, runId: interrupted.runId,
			interruptId: interrupted.interrupt.id, revision: interrupted.interrupt.revision, eventId: `terminal-${status}-resume-event`,
			decisions: Object.freeze([{ approvalId: approval.approvalId, approved: true }]) })
		const terminalProvider = new FakeModelProvider({ strict: true })
		vi.spyOn(terminalProvider, 'text').mockRejectedValue(status === 'cancelled'
			? new OperationCancelledError('cancelled', { scope: 'agent' }) : new Error('private provider failure'))
		instance = await instantiateHostedHarness(definition, { model: { provider: terminalProvider, model: 'fake' }, storage }, bindings)
		const expectedCode = status === 'cancelled' ? 'OPERATION_CANCELLED' : 'INTERNAL_ERROR'
		await expect(instance.runHosted({ delivery: 'resume', target: agent.contract, wireInput: 'request',
			invokeOptions: { sessionId: `terminal-${status}-session`, resume }, hostInvocation: {}, authorize: allowHostedTarget }))
			.rejects.toMatchObject({ code: expectedCode })
		await instance.close()
		expect((await storage.getRun(interrupted.runId))?.status).toBe(status)
		expect(await storage.loadCheckpoint(interrupted.runId, 'harness:interrupt:v1')).toBeUndefined()
		const eventsBeforeReplay = await storage.listEvents(interrupted.runId)
		const acquireRun = vi.spyOn(storage, 'acquireRun')
		const replayProvider = new FakeModelProvider({ strict: true })
		instance = await instantiateHostedHarness(definition, { model: { provider: replayProvider, model: 'fake' }, storage }, bindings)
		const authorize = vi.fn()
		await expect(instance.runHosted({ delivery: 'resume', target: agent.contract, wireInput: 'request',
			invokeOptions: { sessionId: `terminal-${status}-session`, resume }, hostInvocation: {}, authorize }))
			.rejects.toMatchObject({ code: expectedCode })
		expect(authorize).toHaveBeenCalledWith({ delivery: 'resume', target: agent.contract, input: 'request' })
		expect(acquireRun).not.toHaveBeenCalled()
		expect(await storage.listEvents(interrupted.runId)).toEqual(eventsBeforeReplay)
		expect(replayProvider.requests).toHaveLength(0)
		acquireRun.mockRestore()
		await instance.close()
	})

	it.each(['run', 'stream'] as const)('releases the hosted lease when %s replays the prior approval receipt', async mode => {
		const storage = persistentStorage()
		let effects = 0
		const effect = defineTool('bash', { description: 'Approval effect.', input: z.string(), output: z.string(),
			async handler(_context, value) { effects += 1; return value } })
		const agent = defineAgent(`hostedPriorReceipt${mode}`, { input: z.string(), instructions: 'Use effects.', tools: [effect],
			permissions: { bash: 'require_approval' }, prompt: value => ({ role: 'user', content: value }) })
		const definition = defineHarness({ name: `hostedPriorReceiptHarness${mode}`, revision: 'v1' }).addAgent(agent)
		const unused = defineAgent(`unusedPriorReceipt${mode}`, { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const bindings = { hostOwner: createHostOwnerToken<object>(), targetDispatcher: dispatcher,
			projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => undefined, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim() }
		const firstProvider = new FakeModelProvider({ strict: true })
		for (const [id, argument] of [['first-call', 'first'], ['second-call', 'second']] as const) {
			if (mode === 'run') {
				firstProvider.enqueueText({ content: '', toolCalls: [{ id, name: effect.id, arguments: argument }], usage, finishReason: 'tool_calls' })
			} else {
				firstProvider.enqueueTextStream([
					{ kind: 'tool_call', call: { id, name: effect.id, arguments: argument } },
					{ kind: 'finish', usage, finishReason: 'tool_calls' },
				])
			}
		}
		let instance = await instantiateHostedHarness(definition, { model: { provider: firstProvider, model: 'fake' }, storage }, bindings)
		const invokeFresh = async () => {
			const request = { delivery: 'fresh' as const, target: agent.contract, wireInput: 'start', input: 'start',
				invokeOptions: { sessionId: `hosted-prior-receipt-${mode}` }, hostInvocation: {}, authorize: allowHostedTarget }
			if (mode === 'run') return instance.runHosted(request)
			const stream = await instance.streamHosted(request)
			for await (const _event of stream) { /* consume the complete transport stream */ }
			return stream.result
		}
		const invokeResume = async (resume: ToolApprovalResume) => {
			const request = { delivery: 'resume' as const, target: agent.contract, wireInput: 'start',
				invokeOptions: { sessionId: `hosted-prior-receipt-${mode}`, resume }, hostInvocation: {}, authorize: allowHostedTarget }
			if (mode === 'run') return instance.runHosted(request)
			const stream = await instance.streamHosted(request)
			for await (const _event of stream) { /* consume the complete transport stream */ }
			return stream.result
		}
		const first = await invokeFresh()
		if (first.status !== 'interrupted' || first.interrupt.type !== 'tool-approval') {
			throw new Error(`Expected first approval interruption, received ${JSON.stringify(first)}.`)
		}
		const firstResume = Object.freeze({ type: 'tool-approval' as const, runId: first.runId,
			interruptId: first.interrupt.id, revision: first.interrupt.revision, eventId: 'first-hosted-resume',
			decisions: Object.freeze([{ approvalId: first.interrupt.requests[0]!.approvalId, approved: true }]) })
		const second = await invokeResume(firstResume)
		if (second.status !== 'interrupted' || second.interrupt.type !== 'tool-approval') throw new Error('Expected second approval interruption.')
		await instance.close()

		const finalProvider = new FakeModelProvider({ strict: true })
		if (mode === 'run') finalProvider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		else finalProvider.enqueueTextStream([{ kind: 'delta', text: 'done' }, { kind: 'finish', usage, finishReason: 'stop' }])
		instance = await instantiateHostedHarness(definition, { model: { provider: finalProvider, model: 'fake' }, storage }, bindings)
		await expect(invokeResume(firstResume)).resolves.toEqual(second)
		expect(finalProvider.requests).toHaveLength(0)
		const secondResume = Object.freeze({ type: 'tool-approval' as const, runId: second.runId,
			interruptId: second.interrupt.id, revision: second.interrupt.revision, eventId: 'second-hosted-resume',
			decisions: Object.freeze([{ approvalId: second.interrupt.requests[0]!.approvalId, approved: true }]) })
		await expect(invokeResume(secondResume)).resolves.toMatchObject({ status: 'completed', output: 'done' })
		expect(effects).toBe(2)
		expect(finalProvider.requests).toHaveLength(1)
		await instance.close()
	})

	it('loses a post-authorization resume race before events or execution effects', async () => {
		let effects = 0
		const effect = defineTool('bash', { description: 'Approval effect.', input: z.string(), output: z.string(),
			async handler(_context, value) { effects += 1; return value } })
		const agent = defineAgent('authorizationRaceRoot', { input: z.string(), instructions: 'Use the effect.', tools: [effect],
			permissions: { bash: 'require_approval' }, prompt: value => ({ role: 'user', content: value }) })
		const definition = defineHarness({ name: 'authorizationRaceHarness', revision: 'v1' }).addAgent(agent)
		const storage = persistentStorage()
		const unused = defineAgent('unusedAuthorizationRaceTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const owner = createHostOwnerToken<object>()
		const bindings = { hostOwner: owner, targetDispatcher: dispatcher,
			projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => undefined, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim() }
		const firstProvider = new FakeModelProvider({ strict: true })
		firstProvider.enqueueText({ content: '', toolCalls: [{ id: 'authorization-race-call', name: effect.id, arguments: 'run' }], usage, finishReason: 'tool_calls' })
		let instance = await instantiateHostedHarness(definition, { model: { provider: firstProvider, model: 'fake' }, storage }, bindings)
		const interrupted = await instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'request', input: 'request',
			invokeOptions: { sessionId: 'authorization-race-session' }, hostInvocation: {}, authorize: allowHostedTarget })
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('Expected approval interruption.')
		await instance.close()
		const approval = interrupted.interrupt.requests[0]!
		const resume = Object.freeze({ type: 'tool-approval' as const, runId: interrupted.runId,
			interruptId: interrupted.interrupt.id, revision: interrupted.interrupt.revision, eventId: 'authorization-race-resume-event',
			decisions: Object.freeze([{ approvalId: approval.approvalId, approved: true }]) })
		const resumedProvider = new FakeModelProvider({ strict: true })
		resumedProvider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		instance = await instantiateHostedHarness(definition, { model: { provider: resumedProvider, model: 'fake' }, storage }, bindings)
		let releaseAuthorizers!: () => void
		const bothAuthorized = new Promise<void>(resolve => { releaseAuthorizers = resolve })
		let authorizationCount = 0
		const authorize = vi.fn(async () => {
			authorizationCount += 1
			if (authorizationCount === 2) releaseAuthorizers()
			await bothAuthorized
		})
		const request = () => instance.runHosted({ delivery: 'resume' as const, target: agent.contract, wireInput: 'request',
			invokeOptions: { sessionId: 'authorization-race-session', resume }, hostInvocation: {}, authorize })
		const results = await Promise.allSettled([request(), request()])
		expect(authorize).toHaveBeenCalledTimes(2)
		expect(results.filter(result => result.status === 'fulfilled')).toEqual([
			expect.objectContaining({ value: expect.objectContaining({ status: 'completed', output: 'done' }) }),
		])
		expect(results.filter(result => result.status === 'rejected')).toEqual([
			expect.objectContaining({ reason: expect.objectContaining({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'invalid_checkpoint' } }) }),
		])
		expect(resumedProvider.requests).toHaveLength(1)
		expect(effects).toBe(1)
		await instance.close()
	})

	it('binds opaque host context per call and replays an equal nested call without another dispatch', async () => {
		interface HostInvocation { readonly token: string }
		interface HostContext { readonly token: string; readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<HostContext>()
		const child = defineAgent('hostChild', { input: z.string(), output: z.string(), instructions: 'Child.',
			prompt: input => ({ role: 'user', content: input }) })
		const hostTool = defineHostTool(owner, 'hostLookup', {
			description: 'Call one hosted child.', input: z.string(), output: z.string(),
			async handler(context, input) {
				const first = await context.nestedTargets.run(child.contract, input, { callId: 'same-child' })
				const replay = await context.nestedTargets.run(child.contract, input, { callId: 'same-child' })
				return `${context.token}:${first}:${replay}`
			},
		})
		const parent = defineAgent('hostParent', { input: z.string(), instructions: 'Use the host tool.', tools: [hostTool],
			prompt: input => ({ role: 'user', content: input }) })
		const definition = defineHarness({ name: 'hostCalls', revision: 'v1' }).addAgent(child).addAgent(parent)
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'provider-host-call', name: hostTool.id, arguments: 'question' }], usage, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'complete', toolCalls: [], usage, finishReason: 'stop' })
		const seen: Array<HarnessTargetDispatchRequest<typeof child.contract>> = []
		const dispatch = dispatcherFor(child, request => { seen.push(request) })
		const boundLogger = Object.assign(logger(), { close: vi.fn(async () => {}) })
		const boundTelemetry = Object.assign(createTelemetryShim(), { close: vi.fn(async () => {}) })
		let contextRequests = 0
		const hostInvocation = Object.freeze({ token: 'opaque-host-token' })
		const instance = await instantiateHostedHarness(definition, {
			model: { provider, model: 'fake' }, storage: persistentStorage(),
		}, {
			hostOwner: owner, targetDispatcher: dispatch.dispatcher,
			projectIdentity: invocation => ({ tenantId: invocation.token, principalId: 'principal-a' }),
			projectTraceContext: () => trace,
			createHostContext(request: HarnessHostContextRequest<HostInvocation>) {
				contextRequests += 1
				expect(request.hostInvocation).toBe(hostInvocation)
				expect(Object.isFrozen(request)).toBe(true)
				return Object.freeze({ token: request.hostInvocation.token, nestedTargets: request.nestedTargets })
			},
			logger: boundLogger, telemetry: boundTelemetry,
		})
		await expect(instance.runHosted({ delivery: 'fresh', target: parent.contract, wireInput: 'question', input: 'question',
			invokeOptions: { sessionId: 'host-call-session' }, hostInvocation, authorize: allowHostedTarget }))
			.resolves.toMatchObject({ status: 'completed', output: 'complete' })
		expect(contextRequests).toBe(1)
		expect(dispatch.counts()).toMatchObject({ opens: 1, assertions: 3 })
		expect(seen).toHaveLength(1)
		expect(seen[0]?.invocation.identity).toEqual({ tenantId: 'opaque-host-token', principalId: 'principal-a' })
		expect(Object.isFrozen(seen[0]?.invocation.identity)).toBe(true)
		expect(seen[0]?.invocation.trace).toEqual(trace)
		await instance.close()
		expect(dispatch.counts().closes).toBe(0)
		expect(boundLogger.close).not.toHaveBeenCalled()
		expect(boundTelemetry.close).not.toHaveBeenCalled()
	})

	it('persists lease-backed host call and step checkpoints with exact projections', async () => {
		interface HostContext {
			readonly runId: string
			readonly hostToolInvocationId: string
			readonly nestedTargets: HarnessNestedTargetInvoker
			readonly checkpointStep: HarnessHostContextRequest<unknown>['checkpointStep']
		}
		const storage = persistentStorage()
		const owner = createHostOwnerToken<HostContext>()
		const child = defineAgent('checkpointChild', { input: z.string(), output: z.string(), instructions: 'Child.',
			prompt: input => ({ role: 'user', content: input }) })
		let managedEffects = 0
		let capturedCall: RunCheckpoint | undefined
		let capturedStep: RunCheckpoint | undefined
		const hostTool = defineHostTool(owner, 'checkpointHost', {
			description: 'Checkpoint host work.', input: z.string(), output: z.string(),
			async handler(context) {
				await context.checkpointStep('managed-effect', async () => { managedEffects += 1; return { written: true } })
				const first = await context.nestedTargets.run(child.contract, 'child-input', { callId: 'stable-child' })
				const replay = await context.nestedTargets.run(child.contract, 'child-input', { callId: 'stable-child' })
				capturedStep = await storage.loadCheckpoint(context.runId,
					checkpointKey('step', context.hostToolInvocationId, 'managed-effect'))
				capturedCall = await storage.loadCheckpoint(context.runId,
					checkpointKey('call', context.hostToolInvocationId, 'stable-child'))
				return `${first}:${replay}`
			},
		})
		const parent = defineAgent('checkpointParent', { input: z.string(), instructions: 'Use host.', tools: [hostTool],
			prompt: input => ({ role: 'user', content: input }) })
		const definition = defineHarness({ name: 'hostCheckpointHarness', revision: 'v1' }).addAgent(child).addAgent(parent)
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'host-tool-call', name: hostTool.id, arguments: 'tool-input' }], usage, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		const dispatch = dispatcherFor(child, () => {})
		const instance = await instantiateHostedHarness(definition,
			{ model: { provider, model: 'fake' }, storage }, {
				hostOwner: owner, targetDispatcher: dispatch.dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
				projectTraceContext: () => undefined,
				createHostContext: request => Object.freeze({ runId: request.runId,
					hostToolInvocationId: request.hostToolInvocationId, nestedTargets: request.nestedTargets,
					checkpointStep: request.checkpointStep }), logger: logger(), telemetry: createTelemetryShim(),
			})
		await expect(instance.runHosted({ delivery: 'fresh', target: parent.contract, wireInput: 'root-input', input: 'root-input',
			invokeOptions: { sessionId: 'checkpoint-session' }, hostInvocation: {}, authorize: allowHostedTarget }))
			.resolves.toMatchObject({ status: 'completed', output: 'done' })
		expect(managedEffects).toBe(1)
		expect(dispatch.counts().opens).toBe(1)
		expect(capturedStep).toMatchObject({ stepId: expect.stringMatching(/^host:step:/), input: 'root-input',
			output: { written: true } })
		expect(capturedStep?.metadata).toEqual({ checkpointKind: 'host_step', schemaVersion: 1 })
		expect(capturedCall).toMatchObject({ stepId: expect.stringMatching(/^host:call:/), input: 'root-input',
			metadata: { checkpointKind: 'host_nested_target', schemaVersion: 1 }, output: {
				schemaVersion: 1, kind: 'host_nested_target', toolCallId: 'host-tool-call', callId: 'stable-child',
				target: { kind: 'agent', id: child.id }, input: 'child-input',
				outcome: { status: 'completed', output: 'child-answer' },
				lineage: { callerRunId: expect.any(String), hostToolInvocationId: expect.any(String),
					childRunId: expect.any(String), childInvocationId: expect.any(String) },
			} })
		expect(Object.keys(capturedCall?.metadata ?? {})).toEqual(['checkpointKind', 'schemaVersion'])
		await instance.close()
	})

	it('checks exact target identity before replay conflicts and gives target mismatch precedence', async () => {
		interface HostContext { readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<HostContext>()
		const firstChild = defineAgent('firstConflictChild', { input: z.string(), output: z.string(), instructions: 'First.',
			prompt: input => ({ role: 'user', content: input }) })
		const secondChild = defineAgent('secondConflictChild', { input: z.string(), output: z.string(), instructions: 'Second.',
			prompt: input => ({ role: 'user', content: input }) })
		let assertions = 0
		let opens = 0
		const targets = new Set([firstChild.contract, secondChild.contract])
		const routes = new Map<AnyHarnessTargetContract, HarnessTargetRouteReceiptV1>([
			[firstChild.contract, routeFor(firstChild.contract, 'b')], [secondChild.contract, routeFor(secondChild.contract, 'c')],
		])
		const dispatcher: HarnessTargetDispatcher = {
			assertTarget(target) {
				assertions += 1
				if (!targets.has(target as never)) throw new ValidationError('Unknown target.', {
					where: 'invoke_options', issues: { reason: 'unknown_target' },
				})
				return routes.get(target)!
			},
			async open(request) {
				dispatcher.assertTarget(request.target)
				opens += 1
				const runId = request.invocation.invocationId
				const events: readonly ExecutionEvent<string>[] = [
					{ type: 'run.started', eventId: `${runId}:1`, sequence: 1, runId,
						parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId,
						at: '2026-01-01T00:00:00.000Z' },
					{ type: 'run.finished', eventId: `${runId}:2`, sequence: 2, runId,
						parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId,
						at: '2026-01-01T00:00:01.000Z', outcome: { status: 'completed', runId, output: 'ok' } },
				]
				return dispatchStream(events)
			},
			async openPersisted() { throw new Error('unexpected persisted open') },
		}
		const hostTool = defineHostTool(owner, 'conflictHost', { description: 'Exercise replay conflicts.', input: z.string(), output: z.string(),
			async handler(context) {
				await context.nestedTargets.run(firstChild.contract, 'first-input', { callId: 'same' })
				await expect(context.nestedTargets.run({ ...firstChild.contract } as never, 'changed', { callId: 'same' }))
					.rejects.toMatchObject({ meta: { issues: { reason: 'unknown_target' } } })
				await expect(context.nestedTargets.run(secondChild.contract, 'changed', { callId: 'same' }))
					.rejects.toMatchObject({ code: 'HOST_NESTED_TARGET_REPLAY_CONFLICT', meta: { reason: 'target_mismatch',
						expected_target_id: firstChild.id, received_target_id: secondChild.id } })
				await expect(context.nestedTargets.run(firstChild.contract, 'changed', { callId: 'same' }))
					.rejects.toMatchObject({ code: 'HOST_NESTED_TARGET_REPLAY_CONFLICT', meta: { reason: 'input_mismatch' } })
				return 'checked'
			} })
		const parent = defineAgent('conflictParent', { instructions: 'Use host.', tools: [hostTool] })
		const definition = defineHarness({ name: 'hostConflictHarness', revision: 'v1' })
			.addAgent(firstChild).addAgent(secondChild).addAgent(parent)
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'conflict-tool-call', name: hostTool.id, arguments: 'go' }], usage, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		const instance = await instantiateHostedHarness(definition,
			{ model: { provider, model: 'fake' }, storage: persistentStorage() }, {
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => undefined,
				createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
			})
		await expect(instance.runHosted({ delivery: 'fresh', target: parent.contract, wireInput: 'go', input: 'go',
			invokeOptions: { sessionId: 'conflict-session' }, hostInvocation: {}, authorize: allowHostedTarget })).resolves.toMatchObject({ status: 'completed' })
		expect(opens).toBe(1)
		expect(assertions).toBe(5)
		await instance.close()
	})

	it('persists and reconstructs failed and cancelled nested terminals without redispatch', async () => {
		interface HostContext { readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<HostContext>()
		const failedChild = defineAgent('failedHostChild', { input: z.string(), output: z.string(), instructions: 'Fail.',
			prompt: input => ({ role: 'user', content: input }) })
		const cancelledChild = defineAgent('cancelledHostChild', { input: z.string(), output: z.string(), instructions: 'Cancel.',
			prompt: input => ({ role: 'user', content: input }) })
		let opens = 0
		const routes = new Map<AnyHarnessTargetContract, HarnessTargetRouteReceiptV1>([
			[failedChild.contract, routeFor(failedChild.contract, 'd')], [cancelledChild.contract, routeFor(cancelledChild.contract, 'e')],
		])
		const dispatcher: HarnessTargetDispatcher = {
			assertTarget(target) {
				if (target !== failedChild.contract && target !== cancelledChild.contract) throw new ValidationError('Unknown target.', {
					where: 'invoke_options', issues: { reason: 'unknown_target' },
				})
				return routes.get(target)!
			},
			async open(request) {
				dispatcher.assertTarget(request.target)
				opens += 1
				const runId = request.invocation.invocationId
				const outcome = request.target === cancelledChild.contract
					? { status: 'cancelled' as const, runId, error: { code: 'OPERATION_CANCELLED', message: 'remote detail', category: 'cancelled', retriable: false } }
					: { status: 'failed' as const, runId, error: { code: 'REMOTE_FAILURE', message: 'remote detail', category: 'internal', retriable: false } }
				const events: readonly ExecutionEvent<string>[] = [
					{ type: 'run.started', eventId: `${runId}:1`, sequence: 1, runId,
						parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId,
						at: '2026-01-01T00:00:00.000Z' },
					{ type: 'run.finished', eventId: `${runId}:2`, sequence: 2, runId,
						parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId,
						at: '2026-01-01T00:00:01.000Z', outcome } as ExecutionEvent<string>,
				]
				return dispatchStream(events)
			},
			async openPersisted() { throw new Error('unexpected persisted open') },
		}
		const observed: string[] = []
		const hostTool = defineHostTool(owner, 'terminalHost', { description: 'Handle child terminals.', input: z.string(), output: z.string(),
			async handler(context) {
				for (const [target, expected] of [[failedChild.contract, HostNestedTargetError], [cancelledChild.contract, OperationCancelledError]] as const) {
					for (let attempt = 0; attempt < 2; attempt += 1) {
						try { await context.nestedTargets.run(target, 'input', { callId: target.id }) }
						catch (error) {
							expect(error).toBeInstanceOf(expected)
							expect(JSON.stringify(error)).not.toContain('remote detail')
							observed.push(`${target.id}:${attempt}`)
						}
					}
				}
				return 'handled'
			} })
		const parent = defineAgent('terminalParent', { instructions: 'Use host.', tools: [hostTool] })
		const definition = defineHarness({ name: 'hostTerminalHarness', revision: 'v1' })
			.addAgent(failedChild).addAgent(cancelledChild).addAgent(parent)
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'terminal-tool-call', name: hostTool.id, arguments: 'go' }], usage, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		const instance = await instantiateHostedHarness(definition,
			{ model: { provider, model: 'fake' }, storage: persistentStorage() }, {
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => undefined,
				createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
			})
		await expect(instance.runHosted({ delivery: 'fresh', target: parent.contract, wireInput: 'go', input: 'go',
			invokeOptions: { sessionId: 'terminal-session' }, hostInvocation: {}, authorize: allowHostedTarget })).resolves.toMatchObject({ status: 'completed' })
		expect(observed).toEqual(['failedHostChild:0', 'failedHostChild:1', 'cancelledHostChild:0', 'cancelledHostChild:1'])
		expect(opens).toBe(2)
		await instance.close()
	})

	it('rejects a concurrent distinct nested call before a second dispatch', async () => {
		interface HostContext { readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<HostContext>()
		const child = defineAgent('concurrentHostChild', { input: z.string(), output: z.string(), instructions: 'Child.',
			prompt: input => ({ role: 'user', content: input }) })
		let release!: () => void
		const blocked = new Promise<void>(resolve => { release = resolve })
		let opens = 0
		const route = routeFor(child.contract, 'f')
		const dispatcher: HarnessTargetDispatcher = {
			assertTarget(target) { if (target !== child.contract) throw new Error('unexpected target'); return route },
			async open(request) {
				opens += 1
				await blocked
				const runId = request.invocation.invocationId
				const events: readonly ExecutionEvent<string>[] = [
					{ type: 'run.started', eventId: `${runId}:1`, sequence: 1, runId,
						parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId,
						at: '2026-01-01T00:00:00.000Z' },
					{ type: 'run.finished', eventId: `${runId}:2`, sequence: 2, runId,
						parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId,
						at: '2026-01-01T00:00:01.000Z', outcome: { status: 'completed', runId, output: 'ok' } },
				]
				return dispatchStream(events)
			},
			async openPersisted() { throw new Error('unexpected persisted open') },
		}
		const hostTool = defineHostTool(owner, 'concurrentHost', { description: 'Reject fan-out.', input: z.string(), output: z.string(),
			async handler(context) {
				const first = context.nestedTargets.run(child.contract, 'first', { callId: 'first' })
				await expect(context.nestedTargets.run(child.contract, 'changed', { callId: 'first' })).rejects.toMatchObject({
					code: 'HOST_NESTED_TARGET_REPLAY_CONFLICT', meta: { reason: 'input_mismatch' },
				})
				await expect(context.nestedTargets.run(child.contract, 'second', { callId: 'second' })).rejects.toMatchObject({
					meta: { where: 'invoke_options', issues: { reason: 'concurrent_host_nested_target' } },
				})
				release()
				await first
				return 'done'
			} })
		const parent = defineAgent('concurrentParent', { instructions: 'Use host.', tools: [hostTool] })
		const definition = defineHarness({ name: 'concurrentHostHarness', revision: 'v1' }).addAgent(child).addAgent(parent)
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'concurrent-tool-call', name: hostTool.id, arguments: 'go' }], usage, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		const instance = await instantiateHostedHarness(definition,
			{ model: { provider, model: 'fake' }, storage: persistentStorage() }, {
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => undefined,
				createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
			})
		await expect(instance.runHosted({ delivery: 'fresh', target: parent.contract, wireInput: 'go', input: 'go',
			invokeOptions: { sessionId: 'concurrent-session' }, hostInvocation: {}, authorize: allowHostedTarget })).resolves.toMatchObject({ status: 'completed' })
		expect(opens).toBe(1)
		await instance.close()
	})

	it('rejects a host nested target at the delegation depth ceiling before dispatch', async () => {
		interface HostContext { readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<HostContext>()
		const child = defineAgent('depthCeilingHostChild', { input: z.string(), output: z.string(), instructions: 'Child.',
			prompt: input => ({ role: 'user', content: input }) })
		let opens = 0
		const dispatcher: HarnessTargetDispatcher = {
			assertTarget(target) { if (target !== child.contract) throw new Error('unexpected target'); return routeFor(child.contract, 'depth') },
			async open() { opens += 1; throw new Error('dispatch must not open') },
			async openPersisted() { throw new Error('unexpected persisted open') },
		}
		const hostTool = defineHostTool(owner, 'depthCeilingHost', { description: 'Check nested depth.', input: z.string(), output: z.string(),
			async handler(context) {
				await expect(context.nestedTargets.run(child.contract, 'blocked', { callId: 'depth-child' })).rejects.toMatchObject({
					code: 'AGENT_LOOP_BUDGET_EXCEEDED', meta: { reason: 'max_depth', limit: 1 },
				})
				return 'blocked'
			} })
		const parent = defineAgent('depthCeilingParent', { instructions: 'Use host.', tools: [hostTool] })
		const definition = defineHarness({ name: 'depthCeilingHostHarness', revision: 'v1', defaults: { maxDepth: 1 } })
			.addAgent(child).addAgent(parent)
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'depth-tool-call', name: hostTool.id, arguments: 'go' }], usage, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'done', toolCalls: [], usage, finishReason: 'stop' })
		const instance = await instantiateHostedHarness(definition,
			{ model: { provider, model: 'fake' }, storage: persistentStorage() }, {
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => undefined,
				createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
			})
		const stream = await instance.streamDispatched({ delivery: 'fresh', target: parent.contract, wireInput: 'go', input: 'go',
			invocation: { sessionId: 'depth-ceiling-session', invocationId: 'depth-ceiling-run', rootRunId: 'depth-root-run',
				parentRunId: 'depth-parent-run', parentAgentId: 'depth-parent-agent', depth: 1, remainingDepth: 0,
				signal: new AbortController().signal }, hostInvocation: {} })
		let terminal: ExecutionEvent | undefined
		for await (const event of stream) if (event.type === 'run.finished') terminal = event
		expect(terminal).toMatchObject({ outcome: { status: 'completed' } })
		expect(opens).toBe(0)
		await instance.close()
	})

	it('cancels the active host child stream once when its parent is aborted', async () => {
		interface HostContext { readonly nestedTargets: HarnessNestedTargetInvoker }
		const owner = createHostOwnerToken<HostContext>()
		const child = defineAgent('cancelledByParentChild', { input: z.string(), output: z.string(), instructions: 'Wait.',
			prompt: input => ({ role: 'user', content: input }) })
		const route = routeFor(child.contract, 'c')
		let opened!: () => void
		const didOpen = new Promise<void>(resolve => { opened = resolve })
		let release!: () => void
		const released = new Promise<void>(resolve => { release = resolve })
		const cancel = vi.fn(async () => { release() })
		const dispatcher: HarnessTargetDispatcher = {
			assertTarget(target) { if (target !== child.contract) throw new Error('unexpected target'); return route },
			async open(request) {
				opened()
				const runId = request.invocation.invocationId
				return {
					result: new Promise<never>(() => {}),
					cancel,
					async *[Symbol.asyncIterator]() {
						yield { type: 'run.started', eventId: `${runId}:1`, sequence: 1, runId,
							parentRunId: request.invocation.parentRunId, parentInvocationId: request.invocation.invocationId,
							at: '2026-01-01T00:00:00.000Z' } as ExecutionEvent<string>
						await released
					},
				}
			},
			async openPersisted() { throw new Error('unexpected persisted open') },
		}
		const hostTool = defineHostTool(owner, 'parentCancellationHost', { description: 'Wait for child.', input: z.string(), output: z.string(),
			async handler(context) { return context.nestedTargets.run(child.contract, 'wait', { callId: 'waiting-child' }) } })
		const parent = defineAgent('parentCancellationAgent', { input: z.string(), instructions: 'Use host.', tools: [hostTool],
			prompt: input => ({ role: 'user', content: input }) })
		const definition = defineHarness({ name: 'parentCancellationHarness', revision: 'v1' }).addAgent(child).addAgent(parent)
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'cancel-host-call', name: hostTool.id, arguments: 'go' }], usage, finishReason: 'tool_calls' })
		const instance = await instantiateHostedHarness(definition,
			{ model: { provider, model: 'fake' }, storage: persistentStorage() }, {
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }), projectTraceContext: () => undefined,
				createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
			})
		const controller = new AbortController()
		const running = instance.runHosted({ delivery: 'fresh', target: parent.contract, wireInput: 'go', input: 'go',
			invokeOptions: { sessionId: 'parent-cancellation-session', signal: controller.signal }, hostInvocation: {}, authorize: allowHostedTarget })
		await didOpen
		controller.abort('private parent cancellation detail')
		const cancellation = await running.then(() => undefined, error => error)
		expect(cancellation).toMatchObject({ code: 'OPERATION_CANCELLED', category: 'cancelled' })
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(cancellation)).not.toContain('private parent cancellation detail')
		await instance.close()
	})

	it('rejects mixed host owners and ordinary standalone construction before initialization', async () => {
		const firstOwner = createHostOwnerToken<object>()
		const secondOwner = createHostOwnerToken<object>()
		const alpha = defineHostTool(firstOwner, 'alphaOwnerTool', { description: 'Alpha.', input: z.string(), output: z.string(),
			async handler(_context, input) { return input } })
		const beta = defineHostTool(secondOwner, 'betaOwnerTool', { description: 'Beta.', input: z.string(), output: z.string(),
			async handler(_context, input) { return input } })
		const agent = defineAgent('mixedOwnerAgent', { instructions: 'Use host.', tools: [alpha, beta] })
		const definition = defineHarness({ name: 'mixedOwnerHarness', revision: 'v1' }).addAgent(agent)
		let configReads = 0
		const config = Object.defineProperty({}, 'model', { enumerable: true, get() { configReads += 1; return undefined } })
		const unused = defineAgent('unusedMixedOwnerTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		await expect(instantiateHostedHarness(definition, config as never, {
			hostOwner: firstOwner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => undefined, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim(),
		})).rejects.toMatchObject({ meta: { reason: 'host_owner_mismatch', id: 'betaOwnerTool' } })
		expect(configReads).toBe(0)
		expect(() => definition.getInstance({ model: { provider: new FakeModelProvider(), model: 'fake' },
			storage: persistentStorage() })).toThrow(expect.objectContaining({ meta: expect.objectContaining({ reason: 'standalone_host_tools_unsupported' }) }))
	})

	it('sanitizes projector throws after request validation', async () => {
		const agent = defineAgent('projectorFailure', { instructions: 'Answer.' })
		const definition = defineHarness({ name: 'projectorFailureHarness' }).addAgent(agent)
		const unused = defineAgent('unusedProjectorTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const instance = await instantiateHostedHarness(definition, { model: { provider: new FakeModelProvider(), model: 'fake' } }, {
			hostOwner: createHostOwnerToken(), targetDispatcher: dispatcher,
			projectIdentity: () => { throw new Error('private identity detail') }, projectTraceContext: () => undefined,
			createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim(),
		})
		const error = await instance.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'hello', input: 'hello', invokeOptions: { sessionId: 'failure-session' }, hostInvocation: {}, authorize: allowHostedTarget })
			.then(() => undefined, value => value)
		expect(error).toBeInstanceOf(InternalError)
		expect(JSON.stringify(error)).not.toContain('private identity detail')
		await instance.close()
	})

	it('includes the host checkpoint contract in durable graph compatibility', async () => {
		const storage = persistentStorage()
		const owner = createHostOwnerToken<object>()
		const transfer = defineTool('bash', { description: 'Transfer.', input: z.string(), output: z.string(),
			async handler(_context, input) { return input } })
		const firstAgent = defineAgent('digestAgent', { input: z.string(), instructions: 'Transfer.', tools: [transfer],
			permissions: { bash: 'require_approval' }, prompt: input => ({ role: 'user', content: input }) })
		const firstDefinition = defineHarness({ name: 'hostDigestHarness', revision: 'v1' }).addAgent(firstAgent)
		const unused = defineAgent('unusedDigestTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const bindings = {
			hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => undefined, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim(),
		}
		const firstProvider = new FakeModelProvider({ strict: true })
		firstProvider.enqueueText({ content: '', toolCalls: [{ id: 'approval-call', name: transfer.id, arguments: '€10' }],
			usage, finishReason: 'tool_calls' })
		const first = await instantiateHostedHarness(firstDefinition, { model: { provider: firstProvider, model: 'fake' }, storage }, bindings)
		const interrupted = await first.runHosted({ delivery: 'fresh', target: firstAgent.contract, wireInput: 'send', input: 'send',
			invokeOptions: { sessionId: 'digest-session', idempotencyKey: 'stable-digest-run' }, hostInvocation: {}, authorize: allowHostedTarget })
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('Expected approval interruption.')
		await first.close()

		const hostTool = defineHostTool(owner, 'addedHostTool', { description: 'Host.', input: z.string(), output: z.string(),
			async handler(_context, input) { return input } })
		const changedAgent = defineAgent('digestAgent', { input: z.string(), instructions: 'Transfer.', tools: [transfer, hostTool],
			permissions: { bash: 'require_approval' }, prompt: input => ({ role: 'user', content: input }) })
		const changedDefinition = defineHarness({ name: 'hostDigestHarness', revision: 'v1' }).addAgent(changedAgent)
		const changed = await instantiateHostedHarness(changedDefinition,
			{ model: { provider: new FakeModelProvider(), model: 'fake' }, storage }, bindings)
		const request = interrupted.interrupt.requests[0]!
		await expect(changed.runHosted({ delivery: 'resume', target: changedAgent.contract, wireInput: 'send', invokeOptions: {
			sessionId: 'digest-session', resume: {
				type: 'tool-approval', runId: interrupted.runId, interruptId: interrupted.interrupt.id,
				revision: interrupted.interrupt.revision, eventId: 'digest-resume-event',
				decisions: [{ approvalId: request.approvalId, approved: true }],
			},
		}, hostInvocation: {}, authorize: allowHostedTarget })).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'graph_mismatch' } })
		await changed.close()
	})

	it('resumes an interrupted remote host child through its exact persisted route after a fresh hosted assembly', async () => {
		const fixture = await interruptedRemoteHostFixture()
		const checkpointSequences: number[] = []
		const commitCheckpoint = fixture.storage.commitCheckpoint.bind(fixture.storage)
		vi.spyOn(fixture.storage, 'commitCheckpoint').mockImplementation(async checkpoint => {
			if (checkpoint.runId === fixture.interrupted.runId) checkpointSequences.push(checkpoint.sequence)
			return commitCheckpoint(checkpoint)
		})
		const replaceCheckpoint = fixture.storage.replaceCheckpoint.bind(fixture.storage)
		vi.spyOn(fixture.storage, 'replaceCheckpoint').mockImplementation(async request => {
			if (request.runId === fixture.interrupted.runId) checkpointSequences.push(request.replacement.sequence)
			return replaceCheckpoint(request)
		})
		const remoteProvider = new FakeModelProvider({ strict: true })
		remoteProvider.enqueueText({ content: 'remote-complete', toolCalls: [], usage, finishReason: 'stop' })
		await fixture.startRemote(remoteProvider)
		const parentProvider = new FakeModelProvider({ strict: true })
		parentProvider.enqueueText({ content: 'parent-complete', toolCalls: [], usage, finishReason: 'stop' })
		const parent = await fixture.startParent(parentProvider)
		const approval = fixture.interrupted.interrupt.requests[0]!
		const rootResumeEventId = 'remote-root-resume-event'
		const rootDecisions = [{ approvalId: approval.approvalId, approved: true }] as const

		await expect(parent.runHosted({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId,
				interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision,
				eventId: rootResumeEventId, decisions: rootDecisions,
			},
		}, hostInvocation: {}, authorize: allowHostedTarget })).resolves.toEqual({ status: 'completed', runId: fixture.interrupted.runId, output: 'parent-complete' })
		expect(remoteProvider.requests).toHaveLength(1)
		expect(parentProvider.requests).toHaveLength(1)

		const counts = fixture.counts()
		expect(counts.freshOpens).toBe(1)
		expect(counts.persistedDispatchEffects).toBe(1)
		expect(counts.remoteEffectCalls).toBe(1)
		expect(counts.persistedRequests).toHaveLength(1)
		const persisted = counts.persistedRequests[0]!
		expect(persisted.route).toEqual(fixture.route)
		expect(persisted.wireInput).toBe('original-remote-wire-input')
		expect(persisted.resume).toEqual({
			type: 'tool-approval', runId: approval.agentRunId,
			interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision,
			eventId: `event_${createHash('sha256').update(canonicalJson([
				'harness.child-resume-event.v1', rootResumeEventId, approval.agentRunId, fixture.interrupted.interrupt.id,
			])).digest('hex')}`,
			decisions: rootDecisions,
		})
		expect(new Set(checkpointSequences).size).toBe(checkpointSequences.length)
		expect(checkpointSequences).toEqual([...checkpointSequences].sort((left, right) => left - right))
		await parent.close()
		await fixture.stopRemote()
	})

	it('partitions one complete root decision set across two interrupted host leaves', async () => {
		const fixture = await interruptedRemoteHostFixture({ leafCount: 2 })
		expect(fixture.interrupted.interrupt.requests).toHaveLength(2)
		const remoteProvider = new FakeModelProvider({ strict: true })
		remoteProvider.enqueueText({ content: 'first-complete', toolCalls: [], usage, finishReason: 'stop' })
		remoteProvider.enqueueText({ content: 'second-complete', toolCalls: [], usage, finishReason: 'stop' })
		await fixture.startRemote(remoteProvider)
		const parentProvider = new FakeModelProvider({ strict: true })
		parentProvider.enqueueText({ content: 'parent-complete', toolCalls: [], usage, finishReason: 'stop' })
		const parent = await fixture.startParent(parentProvider)
		const decisions = fixture.interrupted.interrupt.requests.map(request => ({ approvalId: request.approvalId, approved: true as const }))

		await expect(parent.runHosted({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId,
				interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision,
				eventId: 'two-leaf-root-resume', decisions,
			},
		}, hostInvocation: { generation: 'two-leaf-resume' }, authorize: allowHostedTarget })).resolves.toEqual({
			status: 'completed', runId: fixture.interrupted.runId, output: 'parent-complete',
		})
		const counts = fixture.counts()
		expect(counts.persistedRequests).toHaveLength(2)
		const approvalByRun = new Map(fixture.interrupted.interrupt.requests.map(request => [request.agentRunId, request.approvalId]))
		for (const request of counts.persistedRequests) {
			expect(request.resume.decisions).toEqual([{ approvalId: approvalByRun.get(request.resume.runId), approved: true }])
		}
		expect(new Set(counts.persistedRequests.map(request => request.resume.decisions[0]!.approvalId))).toEqual(new Set(decisions.map(decision => decision.approvalId)))
		expect(counts).toMatchObject({ freshOpens: 2, persistedDispatchEffects: 2, remoteEffectCalls: 2, managedEffects: 2 })
		await parent.close()
		await fixture.stopRemote()
	})

	it('persists a new host continuation when the resumed remote child interrupts again', async () => {
		const fixture = await interruptedRemoteHostFixture()
		const firstApproval = fixture.interrupted.interrupt.requests[0]!
		const secondRemoteProvider = new FakeModelProvider({ strict: true })
		secondRemoteProvider.enqueueText({ content: '', toolCalls: [
			{ id: 'remote-effect-call-2', name: 'bash', arguments: 'confirm-transfer' },
		], usage, finishReason: 'tool_calls' })
		await fixture.startRemote(secondRemoteProvider)
		const secondParent = await fixture.startParent(new FakeModelProvider({ strict: true }))
		const interruptedAgain = await secondParent.runHosted({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId, interruptId: fixture.interrupted.interrupt.id,
				revision: fixture.interrupted.interrupt.revision, eventId: 'first-repeated-resume',
				decisions: [{ approvalId: firstApproval.approvalId, approved: true }],
			},
		}, hostInvocation: { generation: 'second' }, authorize: allowHostedTarget })
		if (interruptedAgain.status !== 'interrupted' || interruptedAgain.interrupt.type !== 'tool-approval') {
			throw new Error('Expected the resumed child to interrupt again.')
		}
		expect(interruptedAgain.interrupt.id).not.toBe(fixture.interrupted.interrupt.id)
		await secondParent.close()

		const finalRemoteProvider = new FakeModelProvider({ strict: true })
		finalRemoteProvider.enqueueText({ content: 'remote-complete', toolCalls: [], usage, finishReason: 'stop' })
		await fixture.startRemote(finalRemoteProvider)
		const finalParentProvider = new FakeModelProvider({ strict: true })
		finalParentProvider.enqueueText({ content: 'parent-complete', toolCalls: [], usage, finishReason: 'stop' })
		const finalParent = await fixture.startParent(finalParentProvider)
		const secondApproval = interruptedAgain.interrupt.requests[0]!
		await expect(finalParent.runHosted({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', resume: {
				type: 'tool-approval', runId: interruptedAgain.runId, interruptId: interruptedAgain.interrupt.id,
				revision: interruptedAgain.interrupt.revision, eventId: 'second-repeated-resume',
				decisions: [{ approvalId: secondApproval.approvalId, approved: true }],
			},
		}, hostInvocation: { generation: 'final' }, authorize: allowHostedTarget })).resolves.toEqual({ status: 'completed', runId: interruptedAgain.runId, output: 'parent-complete' })
		expect(fixture.counts()).toMatchObject({ freshOpens: 1, persistedDispatchEffects: 2, remoteEffectCalls: 2,
			managedEffects: 1, hostContextInvocations: [{}, { generation: 'final' }] })
		expect(JSON.stringify(finalParentProvider.requests[0])).toContain('final:remote-complete')
		const hostStarts = (await fixture.storage.listEvents(interruptedAgain.runId)).filter(event => event.type === 'tool.started'
			&& (event.payload as Record<string, unknown>)['toolId'] === 'remoteChildHost')
		expect(hostStarts).toHaveLength(1)
		await finalParent.close()
		await fixture.stopRemote()
	})

	it('resumes an agent-to-host-to-workflow approval tree leaf first after restart', async () => {
		interface HostContext { readonly nestedTargets: HarnessNestedTargetInvoker }
		const storage = persistentStorage()
		const owner = createHostOwnerToken<HostContext>()
		let approvedEffects = 0
		const effect = defineTool('bash', { description: 'Approval effect.', input: z.string(), output: z.string(),
			async handler(_context, input) { approvedEffects += 1; return `approved:${input}` } })
		const leaf = defineAgent('workflowApprovalLeaf', { input: z.string(), output: z.string(), instructions: 'Use effect.',
			tools: [effect], permissions: { bash: 'require_approval' }, prompt: input => ({ role: 'user', content: input }) })
		const middle = defineAgent('workflowApprovalMiddle', { input: z.string(), output: z.string(), instructions: 'Delegate.',
			subagents: { leaf }, prompt: input => ({ role: 'user', content: input }) })
		const workflow = defineWorkflow('hostedApprovalWorkflow', { input: z.string(), output: z.string(), agents: [middle], durable: true,
			async handler(context) { return context.agents.workflowApprovalMiddle.run(context.input, { callId: 'workflow-middle' }) } })
		const hostTool = defineHostTool(owner, 'workflowHostTool', { description: 'Invoke workflow.', input: z.string(), output: z.string(),
			async handler(context, input) { return context.nestedTargets.run(workflow.contract, input, { callId: 'host-workflow' }) } })
		const parentAgent = defineAgent('workflowHostParent', { input: z.string(), output: z.string(), instructions: 'Use host.', tools: [hostTool, effect], permissions: { bash: 'require_approval' },
			prompt: input => ({ role: 'user', content: input }) })
		const receiverDefinition = defineHarness({ name: 'workflowHostReceiver', revision: 'v1', defaults: { maxDepth: 4 } })
			.addAgent(leaf).addAgent(middle).addWorkflow(workflow)
		const parentDefinition = defineHarness({ name: 'workflowHostCaller', revision: 'v1', defaults: { maxDepth: 3 } })
			.addAgent(leaf).addAgent(middle).addWorkflow(workflow).addAgent(parentAgent)
		const routes = new Map<AnyHarnessTargetContract, HarnessTargetRouteReceiptV1>([
			[leaf.contract, routeFor(leaf.contract, '1')], [middle.contract, routeFor(middle.contract, '2')],
			[workflow.contract, routeFor(workflow.contract, '3')],
		])
		const persistedTraces: unknown[] = []
		let receiver: Awaited<ReturnType<typeof instantiateHostedHarness>> | undefined
		const dispatcher: HarnessTargetDispatcher = {
			assertTarget(target) {
				const route = routes.get(target)
				if (route === undefined) throw new Error('unexpected target')
				return route
			},
			async open(request) {
				if (receiver === undefined) throw new Error('receiver unavailable')
				const { identity: _identity, trace: _trace, ...invocation } = request.invocation
				if (request.target === workflow.contract) return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'fresh',
					target: workflow.contract, wireInput: request.input as string, input: request.input as string, invocation, hostInvocation: {} }), request.invocation)
				if (request.target === middle.contract) return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'fresh',
					target: middle.contract, wireInput: request.input as string, input: request.input as string, invocation, hostInvocation: {} }), request.invocation)
				return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'fresh', target: leaf.contract,
					wireInput: request.input as string, input: request.input as string, invocation, hostInvocation: {} }), request.invocation)
			},
			async openPersisted(request) {
				if (receiver === undefined) throw new Error('receiver unavailable')
				persistedTraces.push(request.invocation.trace)
				const { identity: _identity, trace: _trace, ...invocation } = request.invocation
				if (request.route.target.kind === 'workflow') return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'resume',
					target: workflow.contract, wireInput: request.wireInput as string, invocation, resume: request.resume, hostInvocation: {} }), request.invocation)
				if (request.route.target.id === middle.id) return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'resume',
					target: middle.contract, wireInput: request.wireInput as string, invocation, resume: request.resume, hostInvocation: {} }), request.invocation)
				return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'resume', target: leaf.contract,
					wireInput: request.wireInput as string, invocation, resume: request.resume, hostInvocation: {} }), request.invocation)
			},
		}
		const bindings = { hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => trace, createHostContext: (request: HarnessHostContextRequest<object>) => ({ nestedTargets: request.nestedTargets }),
			logger: logger(), telemetry: createTelemetryShim() }
		const firstReceiverProvider = new FakeModelProvider({ strict: true })
		firstReceiverProvider.enqueueText({ content: '', toolCalls: [{ id: 'workflow-leaf-call', name: 'leaf', arguments: 'transfer' }], usage, finishReason: 'tool_calls' })
		firstReceiverProvider.enqueueText({ content: '', toolCalls: [{ id: 'workflow-effect-call', name: effect.id, arguments: 'transfer' }], usage, finishReason: 'tool_calls' })
		receiver = await instantiateHostedHarness(receiverDefinition,
			{ model: { provider: firstReceiverProvider, model: 'fake' }, storage }, bindings)
		const firstParentProvider = new FakeModelProvider({ strict: true })
		firstParentProvider.enqueueText({ content: '', toolCalls: [{ id: 'workflow-host-call', name: hostTool.id, arguments: 'transfer' }], usage, finishReason: 'tool_calls' })
		const firstParent = await instantiateHostedHarness(parentDefinition,
			{ model: { provider: firstParentProvider, model: 'fake' }, storage }, bindings)
		const interrupted = await firstParent.runHosted({ delivery: 'fresh', target: parentAgent.contract, wireInput: 'transfer', input: 'transfer',
			invokeOptions: { sessionId: 'workflow-host-session', idempotencyKey: 'workflow-host-root' }, hostInvocation: {}, authorize: allowHostedTarget })
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('Expected workflow leaf approval.')
		const checkpoint = await storage.loadCheckpoint(interrupted.runId, 'harness:interrupt:v1')
		if (checkpoint?.output === undefined) throw new Error('Expected workflow approval checkpoint.')
		const agentRuns = new Map<string, string>()
		type AgentRunNode = Readonly<{ frame?: Readonly<{ kind?: string; runId?: string; state?: Readonly<{ agentId?: string }> }>; children?: readonly JsonValue[] }>
		const visit = (value: JsonValue): void => {
			if (value === null || typeof value !== 'object') return
			const node = value as AgentRunNode
			if (node.frame?.kind === 'agent' && node.frame.runId !== undefined && node.frame.state?.agentId !== undefined) {
				agentRuns.set(node.frame.state.agentId, node.frame.runId)
			}
			for (const child of node.children ?? []) visit(child)
		}
		const continuation = (checkpoint.output as Readonly<{ continuation?: JsonValue }>).continuation
		if (continuation === undefined) throw new Error('Expected nested approval continuation.')
		visit(continuation)
		const middleRunId = agentRuns.get(middle.id)
		const leafRunId = agentRuns.get(leaf.id)
		if (middleRunId === undefined || leafRunId === undefined) throw new Error('Expected nested agent frames.')
		const freshEventCounts = new Map<string, number>()
		for (const [agentId, childRunId] of [[middle.id, middleRunId], [leaf.id, leafRunId]] as const) {
			const events = await storage.listEvents(childRunId)
			freshEventCounts.set(childRunId, events.length)
			const callerEvents = events.filter(event => ['model.completed', 'tool.input.available', 'tool.started'].includes(event.type))
			expect(callerEvents.length).toBeGreaterThan(0)
			for (const event of callerEvents) {
				expect((event.payload as Readonly<{ caller?: HarnessExecutionCaller }>).caller)
					.toEqual({ kind: 'agent', agentId, workflowId: workflow.id })
				expect(event.runId).toBe(childRunId)
			}
		}
		await firstParent.close()
		await receiver.close()

		const resumedReceiverProvider = new FakeModelProvider({ strict: true })
		resumedReceiverProvider.enqueueText({ content: 'workflow-leaf-complete', toolCalls: [], usage, finishReason: 'stop' })
		resumedReceiverProvider.enqueueText({ content: 'workflow-middle-complete', toolCalls: [], usage, finishReason: 'stop' })
		receiver = await instantiateHostedHarness(receiverDefinition,
			{ model: { provider: resumedReceiverProvider, model: 'fake' }, storage }, bindings)
		const resumedParentProvider = new FakeModelProvider({ strict: true })
		resumedParentProvider.enqueueText({ content: 'workflow-parent-complete', toolCalls: [], usage, finishReason: 'stop' })
		const resumedParent = await instantiateHostedHarness(parentDefinition,
			{ model: { provider: resumedParentProvider, model: 'fake' }, storage }, bindings)
		const approval = interrupted.interrupt.requests[0]!
		await expect(resumedParent.runHosted({ delivery: 'resume', target: parentAgent.contract, wireInput: 'transfer', invokeOptions: {
			sessionId: 'workflow-host-session', resume: {
				type: 'tool-approval', runId: interrupted.runId, interruptId: interrupted.interrupt.id,
				revision: interrupted.interrupt.revision, eventId: 'workflow-host-resume',
				decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {}, authorize: allowHostedTarget })).resolves.toEqual({ status: 'completed', runId: interrupted.runId, output: 'workflow-parent-complete' })
		expect(approvedEffects).toBe(1)
		expect(resumedReceiverProvider.requests).toHaveLength(2)
		expect(persistedTraces.length).toBeGreaterThan(0)
		expect(persistedTraces).toEqual(persistedTraces.map(() => trace))
		expect(resumedParentProvider.requests).toHaveLength(1)
		for (const [agentId, childRunId] of [[middle.id, middleRunId], [leaf.id, leafRunId]] as const) {
			const events = (await storage.listEvents(childRunId)).slice(freshEventCounts.get(childRunId))
			const callerEvents = events.filter(event => ['model.completed', 'tool.input.available', 'tool.started', 'tool.finished'].includes(event.type))
			expect(callerEvents.length).toBeGreaterThan(0)
			for (const event of callerEvents) {
				expect((event.payload as Readonly<{ caller?: HarnessExecutionCaller }>).caller)
					.toEqual({ kind: 'agent', agentId, workflowId: workflow.id })
				expect(event.runId).toBe(childRunId)
			}
		}
		await resumedParent.close()
		await receiver.close()
	})

	it('restarts a hosted workflow-to-agent child through the persisted inner route twice', async () => {
		const storage = persistentStorage()
		const owner = createHostOwnerToken<object>()
		let receiver: Awaited<ReturnType<typeof instantiateHostedHarness>> | undefined
		const persistedRequests: PersistedHarnessTargetDispatchRequest[] = []
		let effectCalls = 0
		const effect = defineTool('bash', { description: 'Approve the child effect.', input: z.string(), output: z.string(),
			async handler(_context, input) { effectCalls += 1; return `approved:${input}` } })
		const child = defineAgent('persistedWorkflowChild', { input: z.string(), output: z.string(), instructions: 'Use the approval effect.',
			tools: [effect], permissions: { bash: 'require_approval' }, prompt: input => ({ role: 'user', content: input }) })
		const workflow = defineWorkflow('persistedWorkflowParent', { input: z.string(), output: z.string(), agents: [child], durable: true,
			async handler({ input, agents }) { return agents.persistedWorkflowChild.run(input, { callId: 'persisted-child-call' }) } })
		const callerDefinition = defineHarness({ name: 'persistedWorkflowCaller', revision: 'v1' }).addWorkflow(workflow)
		const receiverDefinition = defineHarness({ name: 'persistedWorkflowReceiver', revision: 'v1' }).addAgent(child)
		const route = routeFor(child.contract, '7')
		const dispatcher: HarnessTargetDispatcher = {
			assertTarget(target) {
				if (target !== child.contract) throw new Error('unexpected target')
				return route
			},
			async open(request) {
				if (request.target !== child.contract || receiver === undefined) throw new Error('unexpected fresh target')
				const { identity: _identity, trace: _trace, ...invocation } = request.invocation
				return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'fresh', target: child.contract,
					wireInput: request.input as string, input: request.input as string, invocation, hostInvocation: {} }), request.invocation)
			},
			async openPersisted(request) {
				persistedRequests.push(request)
				expect(request.route).toEqual(route)
				expect(request.route.target).toEqual({ kind: 'agent', id: child.id })
				expect(request.wireInput).toBe('child-wire')
				if (receiver === undefined) throw new Error('receiver unavailable')
				const { identity: _identity, trace: _trace, ...invocation } = request.invocation
				return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'resume', target: child.contract,
					wireInput: request.wireInput as string, invocation, resume: request.resume, hostInvocation: {} }), request.invocation)
			},
		}
		const bindings = { hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }),
			projectTraceContext: () => trace, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim() }
		const startReceiver = async (provider: FakeModelProvider) => {
			receiver = await instantiateHostedHarness(receiverDefinition, { model: { provider, model: 'fake' }, storage }, bindings)
		}
		const startCaller = async () => instantiateHostedHarness(callerDefinition,
			{ model: { provider: new FakeModelProvider({ strict: true }), model: 'fake' }, storage }, bindings)

		const firstProvider = new FakeModelProvider({ strict: true })
		firstProvider.enqueueText({ content: '', toolCalls: [{ id: 'workflow-child-approval-1', name: effect.id, arguments: 'first' }], usage, finishReason: 'tool_calls' })
		await startReceiver(firstProvider)
		let caller = await startCaller()
		const first = await caller.runHosted({ delivery: 'fresh', target: workflow.contract, wireInput: 'child-wire', input: 'child-wire',
			invokeOptions: { sessionId: 'persisted-workflow-session', idempotencyKey: 'persisted-workflow-run' }, hostInvocation: {}, authorize: allowHostedTarget })
		if (first.status !== 'interrupted' || first.interrupt.type !== 'tool-approval') throw new Error('Expected first child approval interruption.')
		await caller.close()
		await receiver?.close()

		const secondProvider = new FakeModelProvider({ strict: true })
		secondProvider.enqueueText({ content: '', toolCalls: [{ id: 'workflow-child-approval-2', name: effect.id, arguments: 'second' }], usage, finishReason: 'tool_calls' })
		await startReceiver(secondProvider)
		caller = await startCaller()
		const firstApproval = first.interrupt.requests[0]!
		const second = await caller.runHosted({ delivery: 'resume', target: workflow.contract, wireInput: 'child-wire', invokeOptions: {
			sessionId: 'persisted-workflow-session', resume: { type: 'tool-approval', runId: first.runId, interruptId: first.interrupt.id,
				revision: first.interrupt.revision, eventId: 'persisted-workflow-resume-1', decisions: [{ approvalId: firstApproval.approvalId, approved: true }] },
		}, hostInvocation: {}, authorize: allowHostedTarget })
		if (second.status !== 'interrupted' || second.interrupt.type !== 'tool-approval') throw new Error('Expected second child approval interruption.')
		await caller.close()
		await receiver?.close()

		const finalProvider = new FakeModelProvider({ strict: true })
		finalProvider.enqueueText({ content: 'child-complete', toolCalls: [], usage, finishReason: 'stop' })
		await startReceiver(finalProvider)
		caller = await startCaller()
		const secondApproval = second.interrupt.requests[0]!
		await expect(caller.runHosted({ delivery: 'resume', target: workflow.contract, wireInput: 'child-wire', invokeOptions: {
			sessionId: 'persisted-workflow-session', resume: { type: 'tool-approval', runId: second.runId, interruptId: second.interrupt.id,
				revision: second.interrupt.revision, eventId: 'persisted-workflow-resume-2', decisions: [{ approvalId: secondApproval.approvalId, approved: true }] },
		}, hostInvocation: {}, authorize: allowHostedTarget })).resolves.toMatchObject({ status: 'completed', output: 'child-complete' })
		expect(persistedRequests).toHaveLength(2)
		expect(persistedRequests.map(request => ({ route: request.route, wireInput: request.wireInput }))).toEqual([
			{ route, wireInput: 'child-wire' }, { route, wireInput: 'child-wire' },
		])
		expect(effectCalls).toBe(2)
		await caller.close()
		await receiver?.close()
	})

	it('rejects a changed current remote route before input conflict or child resume effects', async () => {
		const fixture = await interruptedRemoteHostFixture()
		fixture.setRoute(routeFor(fixture.child.contract, 'e'))
		const parentProvider = new FakeModelProvider({ strict: true })
		const parent = await fixture.startParent(parentProvider)
		const approval = fixture.interrupted.interrupt.requests[0]!

		await expect(parent.runHosted({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId,
				interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision,
				eventId: 'changed-route-resume-event', decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {}, authorize: allowHostedTarget })).rejects.toMatchObject({
			code: 'HARNESS_TARGET_ROUTE_RECEIPT_MISMATCH',
			meta: { reason: 'route_receipt_mismatch', target_kind: 'agent', target_id: fixture.child.id },
		})
		const counts = fixture.counts()
		expect(counts.freshOpens).toBe(1)
		expect(counts.persistedRequests).toHaveLength(1)
		expect(counts.persistedDispatchEffects).toBe(0)
		expect(counts.remoteEffectCalls).toBe(0)
		const routeFailures = (await fixture.storage.listEvents(fixture.interrupted.runId))
			.filter(event => event.type === 'tool.finished'
				&& (event.payload as Record<string, any>)['error']?.['code'] === 'HARNESS_TARGET_ROUTE_RECEIPT_MISMATCH')
		expect(routeFailures).toHaveLength(1)
		expect(parentProvider.requests).toHaveLength(0)
		await parent.close()
	})

	it.each([
		['run id', (descriptor: Record<string, unknown>) => { descriptor['runId'] = 'tampered-child-run' }],
		['interrupt id', (descriptor: Record<string, unknown>) => { descriptor['interruptId'] = 'tampered-interrupt' }],
		['revision', (descriptor: Record<string, unknown>) => { descriptor['revision'] = 'tampered-revision' }],
		['approval ids', (descriptor: Record<string, unknown>) => { descriptor['approvalIds'] = ['tampered-approval'] }],
		['route without wire input', (descriptor: Record<string, unknown>) => {
			descriptor['route'] = storedRouteFor('agent', 'remoteApprovalChild', 'b')
		}],
		['wire input without route', (descriptor: Record<string, unknown>) => { descriptor['wireInput'] = 'tampered-wire-input' }],
		['route target', (descriptor: Record<string, unknown>) => {
			descriptor['route'] = storedRouteFor('agent', 'tamperedTarget', 'c')
			descriptor['wireInput'] = 'tampered-wire-input'
		}],
		['non-json wire input', (descriptor: Record<string, unknown>) => {
			descriptor['route'] = storedRouteFor('agent', 'remoteApprovalChild', 'd')
			descriptor['wireInput'] = new Date()
		}],
		['unknown field', (descriptor: Record<string, unknown>) => { descriptor['unknown'] = true }],
	])('rejects a tampered persisted child resume descriptor (%s) before persisted dispatch', async (_label, tamper) => {
		const fixture = await interruptedRemoteHostFixture()
		const checkpoint = await fixture.storage.loadCheckpoint(fixture.interrupted.runId, 'harness:interrupt:v1')
		if (checkpoint === undefined || checkpoint.output === undefined) throw new Error('Expected root interruption checkpoint.')
		const output = structuredClone(checkpoint.output) as Record<string, any>
		const descriptor = output['continuation']['children'][0]['children'][0]['resumeDescriptor'] as Record<string, unknown>
		tamper(descriptor)
		const originalLoad = fixture.storage.loadCheckpoint.bind(fixture.storage)
		vi.spyOn(fixture.storage, 'loadCheckpoint').mockImplementation(async (runId, stepId) => {
			const stored = await originalLoad(runId, stepId)
			return runId === fixture.interrupted.runId && stepId === 'harness:interrupt:v1' && stored !== undefined
				? Object.freeze({ ...stored, output }) : stored
		})
		const originalAcquire = fixture.storage.acquireRun.bind(fixture.storage)
		vi.spyOn(fixture.storage, 'acquireRun').mockImplementation(async request => {
			const lease = await originalAcquire(request)
			if (request.runId !== fixture.interrupted.runId || lease.checkpoint === undefined) return lease
			const selected = Object.freeze({ ...lease.checkpoint, output })
			return Object.freeze({ ...lease, checkpoint: selected,
				checkpoints: Object.freeze(lease.checkpoints.map(current => current.stepId === selected.stepId ? selected : current)),
			})
		})
		const parent = await fixture.startParent(new FakeModelProvider({ strict: true }))
		const approval = fixture.interrupted.interrupt.requests[0]!
		await expect(parent.runHosted({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId,
				interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision,
				eventId: `tampered-${_label.replaceAll(' ', '-')}`,
				decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {}, authorize: allowHostedTarget })).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'invalid_checkpoint' } })
		expect(fixture.counts().persistedRequests).toHaveLength(0)
		expect(fixture.counts().persistedDispatchEffects).toBe(0)
		expect(fixture.counts().remoteEffectCalls).toBe(0)
		await parent.close()
	})

	it.each([
		['host occurrence', (output: Record<string, any>) => {
			output['continuation']['children'][0]['frame']['hostToolInvocationId'] = 'invocation_tampered-host'
		}],
		['child invocation', (output: Record<string, any>) => {
			const host = output['continuation']['children'][0]
			host['frame']['activeNestedCall']['childInvocationId'] = 'invocation_tampered-child'
			host['children'][0]['frame']['invocationId'] = 'invocation_tampered-child'
			output['continuation']['frame']['state']['entries'][0]['childInvocationId'] = 'invocation_tampered-child'
		}],
		['child session', (output: Record<string, any>) => {
			const host = output['continuation']['children'][0]
			host['frame']['activeNestedCall']['childSessionId'] = 'session_tampered-child'
			host['children'][0]['frame']['state']['sessionId'] = 'session_tampered-child'
		}],
		['child run', (output: Record<string, any>) => {
			const host = output['continuation']['children'][0]
			host['frame']['activeNestedCall']['childRunId'] = 'run_tampered-child'
			host['children'][0]['frame']['runId'] = 'run_tampered-child'
			host['children'][0]['resumeDescriptor']['runId'] = 'run_tampered-child'
			output['continuation']['frame']['state']['entries'][0]['childRunId'] = 'run_tampered-child'
		}],
		['target', (output: Record<string, any>) => {
			const host = output['continuation']['children'][0]
			host['frame']['activeNestedCall']['target']['id'] = 'tamperedTarget'
			host['frame']['activeNestedCall']['route']['target']['id'] = 'tamperedTarget'
			host['children'][0]['frame']['state']['agentId'] = 'tamperedTarget'
		}],
		['tool call', (output: Record<string, any>) => {
			output['continuation']['children'][0]['frame']['callId'] = 'tampered-tool-call'
		}],
	] as const)('rejects tampered persisted host correlation (%s) before checkpoint mutation or dispatch', async (_label, tamper) => {
		const fixture = await interruptedRemoteHostFixture()
		const checkpoint = await fixture.storage.loadCheckpoint(fixture.interrupted.runId, 'harness:interrupt:v1')
		if (checkpoint === undefined || checkpoint.output === undefined) throw new Error('Expected root interruption checkpoint.')
		const output = structuredClone(checkpoint.output) as Record<string, any>
		tamper(output)
		const originalLoad = fixture.storage.loadCheckpoint.bind(fixture.storage)
		vi.spyOn(fixture.storage, 'loadCheckpoint').mockImplementation(async (runId, stepId) => {
			const stored = await originalLoad(runId, stepId)
			return runId === fixture.interrupted.runId && stepId === 'harness:interrupt:v1' && stored !== undefined
				? Object.freeze({ ...stored, output }) : stored
		})
		const originalAcquire = fixture.storage.acquireRun.bind(fixture.storage)
		vi.spyOn(fixture.storage, 'acquireRun').mockImplementation(async request => {
			const lease = await originalAcquire(request)
			if (request.runId !== fixture.interrupted.runId || lease.checkpoint === undefined) return lease
			const selected = Object.freeze({ ...lease.checkpoint, output })
			return Object.freeze({ ...lease, checkpoint: selected,
				checkpoints: Object.freeze(lease.checkpoints.map(current => current.stepId === selected.stepId ? selected : current)),
			})
		})
		const replace = vi.spyOn(fixture.storage, 'replaceCheckpoint')
		const parent = await fixture.startParent(new FakeModelProvider({ strict: true }))
		const approval = fixture.interrupted.interrupt.requests[0]!
		await expect(parent.runHosted({ delivery: 'resume', target: fixture.parent.contract, wireInput: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId, interruptId: fixture.interrupted.interrupt.id,
				revision: fixture.interrupted.interrupt.revision, eventId: `tampered-correlation-${_label.replaceAll(' ', '-')}`,
				decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {}, authorize: allowHostedTarget })).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'invalid_checkpoint' } })
		expect(replace).not.toHaveBeenCalled()
		expect(fixture.counts()).toMatchObject({ persistedDispatchEffects: 0, remoteEffectCalls: 0 })
		await parent.close()
	})
})
