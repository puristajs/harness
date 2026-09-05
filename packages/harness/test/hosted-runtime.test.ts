import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createHash } from 'node:crypto'

import { defineAgent } from '../src/definitions/agent.js'
import { defineHarness } from '../src/definitions/harness.js'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import {
	HarnessConfigError, HarnessTargetRouteReceiptMismatchError, HostNestedTargetError, InternalError,
	OperationCancelledError, ValidationError,
} from '../src/errors/index.js'
import {
	createHostOwnerToken, defineHostTool, instantiateHostedHarness,
	type HarnessHostContextRequest, type HarnessNestedTargetInvoker,
} from '../src/integrator/index.js'
import type { ExecutionEvent } from '../src/definitions/execution-events.js'
import type {
	AnyHarnessTargetContract, HarnessTargetDispatcher, HarnessTargetDispatchRequest, HarnessTargetDispatchStream,
	HarnessTargetRouteReceiptV1, PersistedHarnessTargetDispatchRequest,
} from '../src/ports/target-dispatcher.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { createTelemetryShim } from '../src/telemetry/index.js'
import { canonicalJson } from '../src/runtime/canonical-json.js'
import type { RunCheckpoint } from '../src/storage/execution.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
const trace = Object.freeze({
	traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
	tracestate: 'vendor=value',
})

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

function checkpointKey(kind: 'call' | 'step', hostToolInvocationId: string, id: string): string {
	const tag = kind === 'call' ? 'harness.host-call-key.v1' : 'harness.host-step-key.v1'
	const digest = createHash('sha256').update(canonicalJson([tag, hostToolInvocationId, id])).digest('hex')
	return `host:${kind}:${digest}`
}

function routeFor(target: AnyHarnessTargetContract, fill = 'a'): HarnessTargetRouteReceiptV1 {
	return Object.freeze({ schemaVersion: 1, kind: 'harness_target_route',
		target: Object.freeze({ kind: target.kind, id: target.id }), bindingDigest: `sha256:${fill.repeat(64)}` })
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
			return Object.freeze({
				async cancel() {},
				async *[Symbol.asyncIterator]() { for (const event of events) yield event },
			})
		},
		async openPersisted(request) {
			if (canonicalJson(request.route) !== canonicalJson(route)) throw new Error('unexpected route')
			return dispatcher.open({ target: target.contract, input: request.wireInput, invocation: request.invocation })
		},
		async close() { closes += 1 },
	}
	return { dispatcher, counts: () => ({ opens, assertions, closes }) }
}

function correlateRemoteStream<Output>(
	stream: HarnessTargetDispatchStream<Output>,
	invocation: HarnessTargetDispatchRequest<AnyHarnessTargetContract>['invocation'],
): HarnessTargetDispatchStream<Output> {
	return Object.freeze({
		cancel: (reason?: string) => stream.cancel(reason),
		async *[Symbol.asyncIterator]() {
			for await (const event of stream) yield event.runId === invocation.invocationId
				? Object.freeze({ ...event, parentRunId: invocation.parentRunId, parentInvocationId: invocation.invocationId })
				: event
		},
	})
}

async function interruptedRemoteHostFixture(options: Readonly<{ leafCount?: number }> = {}) {
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
			const output = await context.nestedTargets.run(child.contract, 'original-remote-wire-input', { callId: 'remote-child-call' })
			return `${context.generation}:${output}`
		},
	})
	const parent = defineAgent('remoteApprovalParent', {
		input: z.string(), instructions: 'Use the host tool.', tools: [hostTool],
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
		projectIdentity: () => undefined,
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
			hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => undefined,
			projectTraceContext: () => undefined,
			createHostContext(request: HarnessHostContextRequest<HostInvocation>) {
				hostContextInvocations.push(request.hostInvocation)
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
	const interrupted = await firstParent.runHosted({ target: parent.contract, input: 'root-input',
		invokeOptions: { sessionId: 'remote-route-session', idempotencyKey: 'stable-remote-route-run' }, hostInvocation: {} })
	if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') {
		throw new Error('Expected remote child approval interruption.')
	}
	await firstParent.close()
	await remoteInstance.close()
	remoteInstance = undefined

	return {
		storage, owner, child, parent, parentDefinition, interrupted, route,
		startRemote,
		stopRemote,
		startParent,
		setRoute(next: HarnessTargetRouteReceiptV1) { currentRoute = next },
		counts: () => ({ freshOpens, persistedDispatchEffects, remoteEffectCalls, managedEffects,
			hostContextInvocations, persistedRequests }),
	}
}

describe('hosted Harness runtime', () => {
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
			projectIdentity: () => undefined, projectTraceContext: () => undefined,
			createHostContext: () => ({ nestedTargets: {} as HarnessNestedTargetInvoker }), logger: logger(), telemetry: createTelemetryShim(),
		})).rejects.toMatchObject({ meta: { reason: 'host_owner_mismatch', path: 'hostBindings.hostOwner', id: 'hostedLookup' } })
		expect(initialized).toBe(0)
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
		let identities = 0
		let traces = 0
		const unused = defineAgent('unusedValidationTarget', { instructions: 'Unused.' })
		const { dispatcher } = dispatcherFor(unused, () => {})
		const owner = createHostOwnerToken<object>()
		const instance = await instantiateHostedHarness(definition, { model: { provider, model: 'fake' } }, {
			hostOwner: owner, targetDispatcher: dispatcher,
			projectIdentity: () => { identities += 1; return { tenantId: 'tenant-a', principalId: 'principal-a' } },
			projectTraceContext: () => { traces += 1; return trace }, createHostContext: () => ({}),
			logger: logger(), telemetry: createTelemetryShim(),
		})
		await expect(instance.runHosted({ target: { ...agent.contract } as never, input: 5,
			invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: Object.freeze({ token: 'opaque' }) }))
			.rejects.toBeInstanceOf(ValidationError)
		expect({ identities, traces }).toEqual({ identities: 0, traces: 0 })
		await expect(instance.runHosted({ target: agent.contract, input: new Date() as never,
			invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: Object.freeze({ token: 'opaque' }) }))
			.rejects.toBeInstanceOf(ValidationError)
		expect({ identities, traces }).toEqual({ identities: 0, traces: 0 })
		for (const field of ['traceparent', 'tracestate'] as const) {
			await expect(instance.runHosted({ target: agent.contract, input: 5, invokeOptions: {
				sessionId: 'hosted-session', [field]: 'caller-owned',
			} as never, hostInvocation: Object.freeze({ token: 'opaque' }) })).rejects.toMatchObject({
				meta: { where: 'invoke_options', issues: { reason: 'host_owned_trace_context', field } },
			})
		}
		const aborted = new AbortController()
		aborted.abort('private cancellation detail')
		await expect(instance.runHosted({ target: agent.contract, input: 5,
			invokeOptions: { sessionId: 'hosted-session', signal: aborted.signal }, hostInvocation: Object.freeze({ token: 'opaque' }) }))
			.rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
		expect({ identities, traces }).toEqual({ identities: 0, traces: 0 })

		await expect(instance.runHosted({ target: agent.contract, input: 5,
			invokeOptions: { sessionId: 'hosted-session' }, hostInvocation: Object.freeze({ token: 'opaque' }) }))
			.resolves.toMatchObject({ status: 'completed', output: 'done' })
		expect({ identities, traces, transforms }).toEqual({ identities: 1, traces: 1, transforms: 0 })
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
		})).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'invalid_resume' } })
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
		await expect(instance.runHosted({ target: parent.contract, input: 'question',
			invokeOptions: { sessionId: 'host-call-session' }, hostInvocation }))
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
				hostOwner: owner, targetDispatcher: dispatch.dispatcher, projectIdentity: () => undefined,
				projectTraceContext: () => undefined,
				createHostContext: request => Object.freeze({ runId: request.runId,
					hostToolInvocationId: request.hostToolInvocationId, nestedTargets: request.nestedTargets,
					checkpointStep: request.checkpointStep }), logger: logger(), telemetry: createTelemetryShim(),
			})
		await expect(instance.runHosted({ target: parent.contract, input: 'root-input',
			invokeOptions: { sessionId: 'checkpoint-session' }, hostInvocation: {} }))
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
				lineage: { agentRunId: expect.any(String), hostToolInvocationId: expect.any(String),
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
				return { async cancel() {}, async *[Symbol.asyncIterator]() { yield* events } }
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
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => undefined, projectTraceContext: () => undefined,
				createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
			})
		await expect(instance.runHosted({ target: parent.contract, input: 'go',
			invokeOptions: { sessionId: 'conflict-session' }, hostInvocation: {} })).resolves.toMatchObject({ status: 'completed' })
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
				return { async cancel() {}, async *[Symbol.asyncIterator]() { yield* events } }
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
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => undefined, projectTraceContext: () => undefined,
				createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
			})
		await expect(instance.runHosted({ target: parent.contract, input: 'go',
			invokeOptions: { sessionId: 'terminal-session' }, hostInvocation: {} })).resolves.toMatchObject({ status: 'completed' })
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
				return { async cancel() {}, async *[Symbol.asyncIterator]() { yield* events } }
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
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => undefined, projectTraceContext: () => undefined,
				createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
			})
		await expect(instance.runHosted({ target: parent.contract, input: 'go',
			invokeOptions: { sessionId: 'concurrent-session' }, hostInvocation: {} })).resolves.toMatchObject({ status: 'completed' })
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
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => undefined, projectTraceContext: () => undefined,
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
				hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => undefined, projectTraceContext: () => undefined,
				createHostContext: request => ({ nestedTargets: request.nestedTargets }), logger: logger(), telemetry: createTelemetryShim(),
			})
		const controller = new AbortController()
		const running = instance.runHosted({ target: parent.contract, input: 'go',
			invokeOptions: { sessionId: 'parent-cancellation-session', signal: controller.signal }, hostInvocation: {} })
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
			hostOwner: firstOwner, targetDispatcher: dispatcher, projectIdentity: () => undefined,
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
		const error = await instance.runHosted({ target: agent.contract, input: 'hello', invokeOptions: { sessionId: 'failure-session' }, hostInvocation: {} })
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
			hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => undefined,
			projectTraceContext: () => undefined, createHostContext: () => ({}), logger: logger(), telemetry: createTelemetryShim(),
		}
		const firstProvider = new FakeModelProvider({ strict: true })
		firstProvider.enqueueText({ content: '', toolCalls: [{ id: 'approval-call', name: transfer.id, arguments: '€10' }],
			usage, finishReason: 'tool_calls' })
		const first = await instantiateHostedHarness(firstDefinition, { model: { provider: firstProvider, model: 'fake' }, storage }, bindings)
		const interrupted = await first.runHosted({ target: firstAgent.contract, input: 'send',
			invokeOptions: { sessionId: 'digest-session', idempotencyKey: 'stable-digest-run' }, hostInvocation: {} })
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
		await expect(changed.runHosted({ target: changedAgent.contract, input: 'send', invokeOptions: {
			sessionId: 'digest-session', idempotencyKey: 'stable-digest-run', resume: {
				type: 'tool-approval', runId: interrupted.runId, interruptId: interrupted.interrupt.id,
				revision: interrupted.interrupt.revision, eventId: 'digest-resume-event',
				decisions: [{ approvalId: request.approvalId, approved: true }],
			},
		}, hostInvocation: {} })).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'graph_mismatch' } })
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

		await expect(parent.runHosted({ target: fixture.parent.contract, input: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', idempotencyKey: 'stable-remote-route-run', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId,
				interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision,
				eventId: rootResumeEventId, decisions: rootDecisions,
			},
		}, hostInvocation: {} })).resolves.toEqual({ status: 'completed', runId: fixture.interrupted.runId, output: 'parent-complete' })
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

		await expect(parent.runHosted({ target: fixture.parent.contract, input: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', idempotencyKey: 'stable-remote-route-run', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId,
				interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision,
				eventId: 'two-leaf-root-resume', decisions,
			},
		}, hostInvocation: { generation: 'two-leaf-resume' } })).resolves.toEqual({
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
		const interruptedAgain = await secondParent.runHosted({ target: fixture.parent.contract, input: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', idempotencyKey: 'stable-remote-route-run', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId, interruptId: fixture.interrupted.interrupt.id,
				revision: fixture.interrupted.interrupt.revision, eventId: 'first-repeated-resume',
				decisions: [{ approvalId: firstApproval.approvalId, approved: true }],
			},
		}, hostInvocation: { generation: 'second' } })
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
		await expect(finalParent.runHosted({ target: fixture.parent.contract, input: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', idempotencyKey: 'stable-remote-route-run', resume: {
				type: 'tool-approval', runId: interruptedAgain.runId, interruptId: interruptedAgain.interrupt.id,
				revision: interruptedAgain.interrupt.revision, eventId: 'second-repeated-resume',
				decisions: [{ approvalId: secondApproval.approvalId, approved: true }],
			},
		}, hostInvocation: { generation: 'final' } })).resolves.toEqual({ status: 'completed', runId: interruptedAgain.runId, output: 'parent-complete' })
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
		const workflow = defineWorkflow('hostedApprovalWorkflow', { input: z.string(), output: z.string(), agents: { leaf }, durable: true,
			async handler(context) { return context.agents.leaf.run(context.input, { callId: 'workflow-leaf' }) } })
		const hostTool = defineHostTool(owner, 'workflowHostTool', { description: 'Invoke workflow.', input: z.string(), output: z.string(),
			async handler(context, input) { return context.nestedTargets.run(workflow.contract, input, { callId: 'host-workflow' }) } })
		const parentAgent = defineAgent('workflowHostParent', { input: z.string(), output: z.string(), instructions: 'Use host.', tools: [hostTool],
			prompt: input => ({ role: 'user', content: input }) })
		const receiverDefinition = defineHarness({ name: 'workflowHostReceiver', revision: 'v1', defaults: { maxDepth: 3 } }).addAgent(leaf).addWorkflow(workflow)
		const parentDefinition = defineHarness({ name: 'workflowHostCaller', revision: 'v1', defaults: { maxDepth: 3 } })
			.addAgent(leaf).addWorkflow(workflow).addAgent(parentAgent)
		const routes = new Map<AnyHarnessTargetContract, HarnessTargetRouteReceiptV1>([
			[leaf.contract, routeFor(leaf.contract, '1')], [workflow.contract, routeFor(workflow.contract, '2')],
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
				if (request.target === workflow.contract) {
					return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'fresh', target: workflow.contract,
						wireInput: request.input as string, input: request.input as string, invocation, hostInvocation: {} }), request.invocation)
				}
				return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'fresh', target: leaf.contract,
					wireInput: request.input as string, input: request.input as string, invocation, hostInvocation: {} }), request.invocation)
			},
			async openPersisted(request) {
				if (receiver === undefined) throw new Error('receiver unavailable')
				persistedTraces.push(request.invocation.trace)
				const { identity: _identity, trace: _trace, ...invocation } = request.invocation
				if (request.route.target.kind === 'workflow') {
					return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'resume', target: workflow.contract,
						wireInput: request.wireInput as string, invocation, resume: request.resume, hostInvocation: {} }), request.invocation)
				}
				return correlateRemoteStream(await receiver.streamDispatched({ delivery: 'resume', target: leaf.contract,
					wireInput: request.wireInput as string, invocation, resume: request.resume, hostInvocation: {} }), request.invocation)
			},
		}
		const bindings = { hostOwner: owner, targetDispatcher: dispatcher, projectIdentity: () => undefined,
			projectTraceContext: () => trace, createHostContext: (request: HarnessHostContextRequest<object>) => ({ nestedTargets: request.nestedTargets }),
			logger: logger(), telemetry: createTelemetryShim() }
		const firstReceiverProvider = new FakeModelProvider({ strict: true })
		firstReceiverProvider.enqueueObject({ object: '', toolCalls: [{ id: 'workflow-effect-call', name: effect.id, arguments: 'transfer' }], usage, finishReason: 'tool_calls' })
		receiver = await instantiateHostedHarness(receiverDefinition,
			{ model: { provider: firstReceiverProvider, model: 'fake' }, storage }, bindings)
		const firstParentProvider = new FakeModelProvider({ strict: true })
		firstParentProvider.enqueueObject({ object: '', toolCalls: [{ id: 'workflow-host-call', name: hostTool.id, arguments: 'transfer' }], usage, finishReason: 'tool_calls' })
		const firstParent = await instantiateHostedHarness(parentDefinition,
			{ model: { provider: firstParentProvider, model: 'fake' }, storage }, bindings)
		const interrupted = await firstParent.runHosted({ target: parentAgent.contract, input: 'transfer',
			invokeOptions: { sessionId: 'workflow-host-session', idempotencyKey: 'workflow-host-root' }, hostInvocation: {} })
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('Expected workflow leaf approval.')
		await firstParent.close()
		await receiver.close()

		const resumedReceiverProvider = new FakeModelProvider({ strict: true })
		resumedReceiverProvider.enqueueObject({ object: 'workflow-leaf-complete', toolCalls: [], usage, finishReason: 'stop' })
		receiver = await instantiateHostedHarness(receiverDefinition,
			{ model: { provider: resumedReceiverProvider, model: 'fake' }, storage }, bindings)
		const resumedParentProvider = new FakeModelProvider({ strict: true })
		resumedParentProvider.enqueueObject({ object: 'workflow-parent-complete', toolCalls: [], usage, finishReason: 'stop' })
		const resumedParent = await instantiateHostedHarness(parentDefinition,
			{ model: { provider: resumedParentProvider, model: 'fake' }, storage }, bindings)
		const approval = interrupted.interrupt.requests[0]!
		await expect(resumedParent.runHosted({ target: parentAgent.contract, input: 'transfer', invokeOptions: {
			sessionId: 'workflow-host-session', idempotencyKey: 'workflow-host-root', resume: {
				type: 'tool-approval', runId: interrupted.runId, interruptId: interrupted.interrupt.id,
				revision: interrupted.interrupt.revision, eventId: 'workflow-host-resume',
				decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {} })).resolves.toEqual({ status: 'completed', runId: interrupted.runId, output: 'workflow-parent-complete' })
		expect(approvedEffects).toBe(1)
		expect(resumedReceiverProvider.requests).toHaveLength(1)
		expect(persistedTraces.length).toBeGreaterThan(0)
		expect(persistedTraces).toEqual(persistedTraces.map(() => trace))
		expect(resumedParentProvider.requests).toHaveLength(1)
		await resumedParent.close()
		await receiver.close()
	})

	it('rejects a changed current remote route before input conflict or child resume effects', async () => {
		const fixture = await interruptedRemoteHostFixture()
		fixture.setRoute(routeFor(fixture.child.contract, 'e'))
		const parentProvider = new FakeModelProvider({ strict: true })
		const parent = await fixture.startParent(parentProvider)
		const approval = fixture.interrupted.interrupt.requests[0]!

		await expect(parent.runHosted({ target: fixture.parent.contract, input: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', idempotencyKey: 'stable-remote-route-run', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId,
				interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision,
				eventId: 'changed-route-resume-event', decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {} })).rejects.toMatchObject({
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
		await expect(parent.runHosted({ target: fixture.parent.contract, input: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', idempotencyKey: 'stable-remote-route-run', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId,
				interruptId: fixture.interrupted.interrupt.id, revision: fixture.interrupted.interrupt.revision,
				eventId: `tampered-${_label.replaceAll(' ', '-')}`,
				decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {} })).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'invalid_checkpoint' } })
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
		await expect(parent.runHosted({ target: fixture.parent.contract, input: 'root-input', invokeOptions: {
			sessionId: 'remote-route-session', idempotencyKey: 'stable-remote-route-run', resume: {
				type: 'tool-approval', runId: fixture.interrupted.runId, interruptId: fixture.interrupted.interrupt.id,
				revision: fixture.interrupted.interrupt.revision, eventId: `tampered-correlation-${_label.replaceAll(' ', '-')}`,
				decisions: [{ approvalId: approval.approvalId, approved: true }],
			},
		}, hostInvocation: {} })).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'invalid_checkpoint' } })
		expect(replace).not.toHaveBeenCalled()
		expect(fixture.counts()).toMatchObject({ persistedDispatchEffects: 0, remoteEffectCalls: 0 })
		await parent.close()
	})
})
