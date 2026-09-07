import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineAgent } from '../src/definitions/agent.js'
import type { ChildTaskHandle } from '../src/definitions/types.js'
import { defineHarness } from '../src/definitions/harness.js'
import { defineSkill } from '../src/definitions/skill.js'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { OperationCancelledError, SessionBusyError } from '../src/errors/index.js'
import {
	inMemorySandbox,
	type Sandbox,
	type SandboxOpenOptions,
	type SandboxOpenResult,
	type SandboxScope,
	type SandboxSession,
	type SandboxTerminateOptions,
} from '../src/sandbox/index.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { OtelTelemetryShim } from '../src/telemetry/shim.js'

function persistentStorage(): TrackingHarnessStorage {
	const storage = new TrackingHarnessStorage()
	const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
	Object.defineProperties(storage, {
		capabilities: { value: capabilities },
		info: { value: Object.freeze({ ...storage.info, capabilities }) },
	})
	return storage
}

class TrackingHarnessStorage extends InMemoryHarnessStorage {
	public closeSessionCalls = 0

	public override async closeSession(id: string, expectedInstanceId: string): Promise<void> {
		this.closeSessionCalls += 1
		await super.closeSession(id, expectedInstanceId)
	}
}

class TrackingSandbox implements Sandbox {
	public readonly capabilities = ['sandbox.fs', 'sandbox.exec'] as const
	public openCalls = 0
	public closeCalls = 0
	public readonly ownerRegistrations: Parameters<Sandbox['registerOwner']>[0][] = []
	public readonly openedScopes: SandboxScope[] = []
	public readonly terminatedScopes: SandboxScope[] = []
	public failNextOwnerRegistration: Error | undefined
	public failNextSessionClose: Error | undefined
	public failNextTermination: Error | undefined
	public failConfiguration: Error | undefined
	private readonly delegate = inMemorySandbox()

	public get administration() {
		return this.delegate.administration
	}

	public configureHarnessContext(): void {
		if (this.failConfiguration !== undefined) throw this.failConfiguration
	}

	public async registerOwner(options: Parameters<Sandbox['registerOwner']>[0]): Promise<void> {
		this.ownerRegistrations.push(options)
		const failure = this.failNextOwnerRegistration
		this.failNextOwnerRegistration = undefined
		if (failure !== undefined) throw failure
		await this.delegate.registerOwner(options)
	}

	public async open(options: SandboxOpenOptions): Promise<SandboxOpenResult<readonly ['sandbox.fs', 'sandbox.exec']>> {
		this.openCalls += 1
		this.openedScopes.push(options.scope)
		const opened = await this.delegate.open(options)
		const session = opened.session as SandboxSession
		return {
			...opened,
			session: new Proxy(session, {
				get: (target, property) => {
					if (property === 'close') return async () => {
						this.closeCalls += 1
						const failure = this.failNextSessionClose
						this.failNextSessionClose = undefined
						if (failure !== undefined) throw failure
						await target.close()
					}
					const value = Reflect.get(target, property, target)
					return typeof value === 'function' ? value.bind(target) : value
				},
			}) as SandboxOpenResult<readonly ['sandbox.fs', 'sandbox.exec']>['session'],
		}
	}

	public async terminate(options: SandboxTerminateOptions): Promise<void> {
		this.terminatedScopes.push(options.scope)
		const failure = this.failNextTermination
		this.failNextTermination = undefined
		if (failure !== undefined) throw failure
		await this.delegate.terminate(options)
	}
}

function lifecycleDefinitions() {
	const inspect = defineTool('inspect', {
		description: 'Inspect one value.', input: z.string(), output: z.string(),
		requires: { sandbox: ['sandbox.fs'] },
		async handler(_context, input) { return input },
	})
	const owner = defineAgent('owner', {
		instructions: 'Provide a short answer.',
		tools: [inspect],
	})
	const echo = defineWorkflow('echo', {
		input: z.string(), output: z.string(), durable: true,
		async handler({ input }) { return input },
	})
	return { owner, echo }
}

async function buildLifecycleHarness(
	storage = persistentStorage(),
	sandbox = new TrackingSandbox(),
) {
	const { owner, echo } = lifecycleDefinitions()
	const provider = new FakeModelProvider()
	const harness = await defineHarness({ name: 'sessionLifecycle', revision: 'v1' })
		.addAgent(owner).addWorkflow(echo)
		.getInstance({ storage, sandbox, model: { provider, model: 'fake' } })
	return { harness, storage, sandbox, provider }
}

describe('v4 session lifecycle', () => {
	it('rolls back owned resources when startup fails after resource initialization', async () => {
		const close = vi.spyOn(InMemoryHarnessStorage.prototype, 'close')
		const missing = defineSkill('missing-startup-skill', { directory: new URL('./fixtures/does-not-exist/', import.meta.url) })
		const agent = defineAgent('startupFailure', { instructions: 'Fail while loading the Skill.', skills: [missing] })
		try {
			await expect(defineHarness({ name: 'startupRollback' }).addAgent(agent).getInstance({
				model: { provider: new FakeModelProvider(), model: 'fake' },
			})).rejects.toBeInstanceOf(Error)
			expect(close).toHaveBeenCalledTimes(1)
		} finally {
			close.mockRestore()
		}
	})

	it('rolls back when adapter configuration fails and preserves reverse cleanup failure order', async () => {
		const configureFailure = new Error('sandbox configuration failed')
		const sandbox = new TrackingSandbox()
		sandbox.failConfiguration = configureFailure
		const inspect = defineTool('startupSandbox', { description: 'Require sandbox.', input: z.string(), output: z.string(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(_context, input) { return input } })
		const agent = defineAgent('configurationFailure', { instructions: 'Fail during configuration.', tools: [inspect] })
		const close = vi.spyOn(InMemoryHarnessStorage.prototype, 'close')
		try {
			await expect(defineHarness({ name: 'configurationRollback' }).addAgent(agent).getInstance({
				model: { provider: new FakeModelProvider(), model: 'fake' }, sandbox,
			})).rejects.toBe(configureFailure)
			expect(close).toHaveBeenCalledTimes(1)
		} finally {
			close.mockRestore()
		}

		const initializerFailure = defineSkill('aggregate-startup-failure', { directory: new URL('./fixtures/also-missing/', import.meta.url) })
		const aggregateAgent = defineAgent('aggregateStartupFailure', { instructions: 'Fail while loading.', skills: [initializerFailure] })
		const cleanupFailure = new Error('owned storage cleanup failed')
		const failingClose = vi.spyOn(InMemoryHarnessStorage.prototype, 'close').mockRejectedValueOnce(cleanupFailure)
		try {
			const rejected = await defineHarness({ name: 'aggregateStartupRollback' }).addAgent(aggregateAgent).getInstance({
				model: { provider: new FakeModelProvider(), model: 'fake' },
			}).catch(error => error)
			expect(rejected).toBeInstanceOf(AggregateError)
			expect(rejected.message).toBe('Harness initialization failed and rollback cleanup failed.')
			expect(rejected.errors).toHaveLength(2)
			expect(rejected.errors[0]).toMatchObject({ code: 'SKILL_MANIFEST_ERROR' })
			expect(rejected.errors[1]).toBe(cleanupFailure)
		} finally {
			failingClose.mockRestore()
		}
	})

	it('nests content-free target lifecycle spans and marks failure and cancellation', async () => {
		type RecordedSpan = { name: string; phase: 'start' | 'end'; attrs: Record<string, unknown>; status?: { code: number; message?: string } }
		const records: RecordedSpan[] = []
		const stack: string[] = []
		const spanSpy = vi.spyOn(OtelTelemetryShim.prototype, 'span').mockImplementation(async (name, attrs, fn) => {
			const record: RecordedSpan = { name, phase: 'start', attrs: { ...attrs } }
			records.push(record)
			stack.push(name)
			const span = {
				setAttribute() { return span }, setAttributes(next: Record<string, unknown>) { Object.assign(record.attrs, next); return span },
				addEvent() { return span }, addLink() { return span }, addLinks() { return span }, updateName() { return span },
				recordException() {}, setStatus(status: { code: number; message?: string }) { record.status = status; return span },
				end() {}, isRecording() { return true }, spanContext() { return { traceId: '', spanId: '', traceFlags: 0 } },
			} as never
			try { return await fn(span) } finally {
				expect(stack.pop()).toBe(name)
				records.push({ name, phase: 'end', attrs: {} })
			}
		})
		const success = defineWorkflow('spanSuccess', { input: z.string(), output: z.string(), async handler({ input }) { return input } })
		const failure = defineWorkflow('spanFailure', { input: z.string(), output: z.string(), async handler() { throw new Error('private failure text') } })
		let entered!: () => void
		const cancellationStarted = new Promise<void>(resolve => { entered = resolve })
		const cancelled = defineWorkflow('spanCancelled', { input: z.string(), output: z.string(), async handler({ signal }) {
			entered()
			return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
		} })
		const harness = await defineHarness({ name: 'lifecycleSpans' }).addWorkflow(success).addWorkflow(failure).addWorkflow(cancelled).getInstance({})
		try {
			const session = await harness.getSession('span-session')
			await expect(session.workflows.spanSuccess.run('public')).resolves.toMatchObject({ status: 'completed' })
			await expect(session.workflows.spanFailure.run('private input')).rejects.toThrow('private failure text')
			const controller = new AbortController()
			const running = session.workflows.spanCancelled.run('private input', { signal: controller.signal })
			await cancellationStarted
			controller.abort()
			await expect(running).rejects.toBeInstanceOf(OperationCancelledError)

			const lifecycle = records.filter(record => record.name === 'harness.session.run' || record.name === 'harness.workflow.run')
			expect(lifecycle.map(record => `${record.phase}:${record.name}`)).toEqual([
				'start:harness.session.run', 'start:harness.workflow.run', 'end:harness.workflow.run', 'end:harness.session.run',
				'start:harness.session.run', 'start:harness.workflow.run', 'end:harness.workflow.run', 'end:harness.session.run',
				'start:harness.session.run', 'start:harness.workflow.run', 'end:harness.workflow.run', 'end:harness.session.run',
			])
			const failedTargets = lifecycle.filter(record => record.phase === 'start' && record.name === 'harness.workflow.run' && record.status?.code === 2)
			expect(failedTargets).toHaveLength(2)
			expect(JSON.stringify(lifecycle)).not.toContain('private')
		} finally {
			await harness.close()
			spanSpy.mockRestore()
		}
	})

	it('registers an implicit owner before allocating sandbox compute', async () => {
		const { harness, storage, sandbox } = await buildLifecycleHarness()
		const session = await harness.getSession('owner-before-compute')

		expect(sandbox.ownerRegistrations).toEqual([
			expect.objectContaining({ mode: 'create', owner: expect.objectContaining({ id: 'owner-before-compute' }) }),
		])
		expect(sandbox.openCalls).toBe(0)
		await expect(storage.getSession('owner-before-compute')).resolves.toMatchObject({
			sandboxBinding: { relation: 'owned', registration: 'registered' },
		})

		await session.destroy()
		expect(storage.closeSessionCalls).toBe(1)
		expect(sandbox.terminatedScopes).toHaveLength(1)
		await harness.close()
	})

	it('rolls back a failed owner registration and permits a clean retry', async () => {
		const storage = persistentStorage()
		const sandbox = new TrackingSandbox()
		sandbox.failNextOwnerRegistration = new Error('owner registration unavailable')
		const { owner, echo } = lifecycleDefinitions()
		const harness = await defineHarness({ name: 'registrationRollback', revision: 'v1' })
			.addAgent(owner).addWorkflow(echo)
			.getInstance({ storage, sandbox, model: { provider: new FakeModelProvider(), model: 'fake' } })

		await expect(harness.getSession('registration-retry')).rejects.toThrow('owner registration unavailable')
		await expect(storage.getSession('registration-retry')).resolves.toBeUndefined()
		const session = await harness.getSession('registration-retry')
		expect(sandbox.ownerRegistrations.map(request => request.mode)).toEqual(['create', 'create'])
		await expect(storage.getSession('registration-retry')).resolves.toMatchObject({
			sandboxBinding: { registration: 'registered' },
		})
		await session.destroy()
		await harness.close()
	})

	it('fails borrowed-owner authorization closed before registration or target effects', async () => {
		const owner = Object.freeze({ namespace: 'external', id: 'shared', instanceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
			identity: Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }) })
		const storage = persistentStorage()
		const sandbox = new TrackingSandbox()
		await sandbox.registerOwner({ owner, mode: 'create' })
		let calls = 0
		let decision: 'allow' | 'deny' | 'throw' = 'allow'
		const inspect = defineTool('borrowedInspect', { description: 'Inspect.', input: z.string(), output: z.string(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(_context, input) { return input } })
		const agent = defineAgent('borrowedAgent', { instructions: 'Reply.', tools: [inspect] })
		const durableMarker = defineWorkflow('durableMarker', { input: z.string(), output: z.string(), durable: true,
			async handler({ input }) { return input } })
		const provider = new FakeModelProvider({ strict: true })
		const harness = await defineHarness({ name: 'borrowedAuthorization', revision: 'v1' }).addAgent(agent).addWorkflow(durableMarker).getInstance({ storage, sandbox,
			model: { provider, model: 'fake' }, sandboxBinding: { async authorizeOwner() {
				calls += 1
				if (decision === 'throw') throw new Error('private authorization diagnostics')
				return decision === 'allow'
			} } })

		await expect(harness.getSession('wrong-scope', { identity: { tenantId: 'tenant-b', principalId: 'principal-a' }, sandboxOwner: owner }))
			.rejects.toMatchObject({ code: 'SANDBOX_PERMISSION_DENIED', meta: { reason: 'scope_mismatch' } })
		expect(calls).toBe(0)
		await expect(storage.getSession('wrong-scope')).resolves.toBeUndefined()

		decision = 'deny'
		await expect(harness.getSession('denied', { identity: owner.identity, sandboxOwner: owner }))
			.rejects.toMatchObject({ code: 'SANDBOX_PERMISSION_DENIED', meta: { reason: 'owner_not_authorized' } })
		await expect(storage.getSession('denied')).resolves.toBeUndefined()

		decision = 'throw'
		await expect(harness.getSession('thrown', { identity: owner.identity, sandboxOwner: owner }))
			.rejects.toMatchObject({ code: 'SANDBOX_PERMISSION_DENIED', message: 'Sandbox access denied.', meta: { reason: 'owner_not_authorized' } })
		await expect(storage.getSession('thrown')).resolves.toBeUndefined()

		decision = 'allow'
		const session = await harness.getSession('authorized', { identity: owner.identity, sandboxOwner: owner })
		const afterSession = calls
		decision = 'deny'
		await expect(session.agents.borrowedAgent.run('blocked')).rejects.toMatchObject({
			code: 'SANDBOX_PERMISSION_DENIED', meta: { reason: 'owner_not_authorized' },
		})
		expect(calls).toBeGreaterThan(afterSession)
		expect(sandbox.openCalls).toBe(0)
		decision = 'allow'
		await session.destroy()
		await harness.close()
	})

	it('reauthorizes a borrowed owner for child launch and approval resume without opening unused compute', async () => {
		const owner = Object.freeze({ namespace: 'external', id: 'shared-reentry', instanceId: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
			identity: Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }) })
		const storage = persistentStorage()
		const sandbox = new TrackingSandbox()
		await sandbox.registerOwner({ owner, mode: 'create' })
		let authorizations = 0
		let denyAuthorizationAt = Number.POSITIVE_INFINITY
		let effects = 0
		const marker = defineTool('sandboxMarker', { description: 'Require sandbox.', input: z.string(), output: z.string(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(_context, input) { return input } })
		const unused = defineAgent('unusedSandboxAgent', { instructions: 'Unused.', tools: [marker] })
		const effect = defineTool('bash', { description: 'Approved effect.', input: z.string(), output: z.string(),
			async handler(_context, input) { effects += 1; return input } })
		const reviewer = defineAgent('borrowedReviewer', { instructions: 'Review.', tools: [effect], permissions: { bash: 'require_approval' } })
		const child = defineAgent('borrowedChild', { instructions: 'Reply.' })
		const parent = defineWorkflow('borrowedParent', { input: z.string(), output: z.string(), agents: [child],
			async handler({ input, agents }) { return agents.borrowedChild.run(input, { callId: 'child-call' }) } })
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'approval-call', name: 'bash', arguments: 'approved' }],
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'reviewed', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		provider.enqueueText({ content: 'child-result', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		const harness = await defineHarness({ name: 'borrowedReentry', revision: 'v1' }).addAgent(unused).addAgent(reviewer).addWorkflow(parent)
			.getInstance({ storage, sandbox, model: { provider, model: 'fake' }, sandboxBinding: { authorizeOwner() {
				authorizations += 1
				return authorizations !== denyAuthorizationAt
			} } })
		const session = await harness.getSession('borrowed-reentry', { identity: owner.identity, sandboxOwner: owner })
		const interrupted = await session.agents.borrowedReviewer.run('start')
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('expected approval')
		const beforeResume = authorizations
		await expect(session.agents.borrowedReviewer.run('start', { resume: { type: 'tool-approval', runId: interrupted.runId,
			interruptId: interrupted.interrupt.id, revision: interrupted.interrupt.revision, eventId: 'borrowed-resume',
			decisions: [{ approvalId: interrupted.interrupt.requests[0]!.approvalId, approved: true }] } }))
			.resolves.toMatchObject({ status: 'completed', output: 'reviewed' })
		expect(authorizations).toBeGreaterThan(beforeResume)
		const beforeChild = authorizations
		await expect(session.workflows.borrowedParent.run('child')).resolves.toMatchObject({ status: 'completed', output: 'child-result' })
		expect(authorizations).toBeGreaterThan(beforeChild)
		denyAuthorizationAt = authorizations + 2
		await expect(session.workflows.borrowedParent.run('revoked-child')).rejects.toMatchObject({
			code: 'SANDBOX_PERMISSION_DENIED', meta: { reason: 'owner_not_authorized' },
		})
		expect(effects).toBe(1)
		expect(sandbox.openCalls).toBe(0)
		await session.destroy()
		await harness.close()
	})

	it('reauthorizes the original borrowed owner before a recursively inherited subagent effect', async () => {
		const owner = Object.freeze({ namespace: 'external', id: 'recursive-shared', instanceId: '01ARZ3NDEKTSV4RRFFQ69G5FB1',
			identity: Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }) })
		const sandbox = new TrackingSandbox()
		let allowed = true
		let effects = 0
		const effect = defineTool('recursiveBorrowedEffect', { description: 'Record one effect.', input: z.string(), output: z.string(),
			async handler(_context, input) { effects += 1; return input } })
		const leaf = defineAgent('recursiveBorrowedLeaf', { instructions: 'Run the effect.', tools: [effect] })
		const middle = defineAgent('recursiveBorrowedMiddle', { instructions: 'Delegate.', subagents: { leaf } })
		const workflow = defineWorkflow('recursiveBorrowedFlow', { input: z.string(), output: z.string(), agents: [middle],
			sandbox: { group: 'reviewers' }, async handler({ agents, input }) { return agents.recursiveBorrowedMiddle.run(input, { callId: 'middle' }) } })
		class RevokingProvider extends FakeModelProvider {
			public calls = 0
			public override async text(request: Parameters<FakeModelProvider['text']>[0]) {
				this.calls += 1
				const response = await super.text(request)
				if (response.toolCalls?.some(call => call.name === 'leaf')) allowed = false
				return response
			}
		}
		const provider = new RevokingProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'delegate', name: 'leaf', arguments: 'blocked' }],
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		const harness = await defineHarness({ name: 'recursiveBorrowed', revision: 'v1', defaults: { maxDepth: 3 } }).addWorkflow(workflow).getInstance({
			storage: persistentStorage(), model: { provider, model: 'fake' }, sandbox, sandboxBinding: { groups: ['reviewers'] as const,
				authorizeOwner: () => allowed },
		})
		const session = await harness.getSession('recursive-borrowed', { identity: owner.identity, sandboxOwner: owner })
		await sandbox.registerOwner({ owner, mode: 'create' })
		await sandbox.open({ scope: Object.freeze({ owner, partition: Object.freeze({ kind: 'group' as const, id: 'reviewers' }), lifetime: 'session' as const }),
			mode: 'create', identity: owner.identity })
		await expect(session.workflows.recursiveBorrowedFlow.run('start')).rejects.toMatchObject({
			code: 'WORKFLOW_MANAGED_CALL_FAILED', meta: { operation: 'agent_run', target_kind: 'agent', target_id: 'recursiveBorrowedMiddle' },
		})
		expect(provider.calls).toBe(1)
		expect(effects).toBe(0)
		allowed = true
		await session.destroy()
		await harness.close()
	})

	it('locks a session for one root run without leaking rejected caller listeners', async () => {
		let entered!: () => void
		const started = new Promise<void>(resolve => { entered = resolve })
		const hanging = defineWorkflow('hanging', {
			input: z.string(), output: z.string(),
			async handler({ input, signal }) {
				entered()
				await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
				return input
			},
		})
		const harness = await defineHarness({ name: 'busySession' }).addWorkflow(hanging).getInstance({})
		const session = await harness.getSession('busy')
		const firstController = new AbortController()
		const first = session.workflows.hanging.run('first', { signal: firstController.signal }).catch(error => error)
		await started

		const rejectedController = new AbortController()
		expect(() => session.workflows.hanging.stream('second', { signal: rejectedController.signal })).toThrow(SessionBusyError)
		expect(getEventListeners(rejectedController.signal, 'abort')).toHaveLength(0)
		await expect(session.release()).rejects.toBeInstanceOf(SessionBusyError)

		firstController.abort(new OperationCancelledError('Caller cancelled the run.', { scope: 'run' }))
		await expect(first).resolves.toBeInstanceOf(OperationCancelledError)
		await session.destroy()
		await harness.close()
	})

	it('releases live resources while retaining history, runs, and a reopenable session', async () => {
		const { harness, storage, sandbox, provider } = await buildLifecycleHarness()
		const session = await harness.getSession('release-and-reopen')
		await session.replaceHistory([{ role: 'user', content: 'remember this' }])
		provider.enqueueText({ content: 'first', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		await expect(session.agents.owner.run('first')).resolves.toMatchObject({
			status: 'completed', output: 'first',
		})

		await Promise.all([session.release(), session.release()])
		expect(sandbox.openCalls).toBe(1)
		expect(sandbox.closeCalls).toBe(1)
		expect(storage.closeSessionCalls).toBe(0)
		await expect(storage.getSession('release-and-reopen')).resolves.toMatchObject({ runCount: 1 })
		await expect(storage.listMessages('release-and-reopen')).resolves.toEqual(expect.arrayContaining([
			expect.objectContaining({ content: 'remember this' }),
		]))
		await expect(storage.listRuns('release-and-reopen')).resolves.toHaveLength(1)
		expect(() => session.workflows.echo.stream('stale')).toThrowError(expect.objectContaining({
			code: 'STATE_ERROR', meta: expect.objectContaining({ reason: 'session_released' }),
		}))

		const reopened = await harness.getSession('release-and-reopen')
		provider.enqueueText({ content: 'second', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		await expect(reopened.agents.owner.run('second')).resolves.toMatchObject({
			status: 'completed', output: 'second',
		})
		await expect(storage.getSession('release-and-reopen')).resolves.toMatchObject({ runCount: 2 })
		await reopened.destroy()
		await harness.close()
	})

	it('keeps failed cleanup retryable for session release and instance close', async () => {
		const sandbox = new TrackingSandbox()
		const { harness, provider } = await buildLifecycleHarness(persistentStorage(), sandbox)
		const session = await harness.getSession('retry-cleanup')
		provider.enqueueText({ content: 'opened', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		await session.agents.owner.run('open')

		sandbox.failNextSessionClose = new Error('first session close failed')
		await expect(session.release()).rejects.toThrow('first session close failed')
		await expect(session.release()).resolves.toBeUndefined()
		expect(sandbox.closeCalls).toBe(2)

		const reopened = await harness.getSession('retry-cleanup')
		provider.enqueueText({ content: 'reopened', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		await reopened.agents.owner.run('open again')
		sandbox.failNextSessionClose = new Error('first instance close failed')
		await expect(harness.close()).rejects.toThrow('Harness close failed.')
		await expect(harness.close()).resolves.toBeUndefined()
		expect(sandbox.closeCalls).toBe(4)
	})

	it('coalesces direct-agent idempotent run and stream delivery independently of observation', async () => {
		let release!: () => void
		const gate = new Promise<void>(resolve => { release = resolve })
		class DeferredProvider extends FakeModelProvider {
			public calls = 0
			public override async *textStream() {
				this.calls += 1
				await gate
				yield { kind: 'delta' as const, text: 'once' }
				yield { kind: 'finish' as const, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' as const }
			}
		}
		const provider = new DeferredProvider({ strict: true })
		const agent = defineAgent('idempotentAgent', { instructions: 'Reply once.' })
		const harness = await defineHarness({ name: 'directIdempotency' }).addAgent(agent)
			.getInstance({ model: { provider, model: 'fake' } })
		const session = await harness.getSession('direct-idempotency')

		const first = session.agents.idempotentAgent.stream('same', { idempotencyKey: 'delivery:1' })
		const firstIterator = first[Symbol.asyncIterator]()
		await expect(firstIterator.next()).resolves.toMatchObject({ done: false, value: { type: 'run.started' } })
		await firstIterator.return?.()
		const second = session.agents.idempotentAgent.stream('same', { idempotencyKey: 'delivery:1' })
		const joined = session.agents.idempotentAgent.run('same', { idempotencyKey: 'delivery:1' })
		expect(() => session.agents.idempotentAgent.stream('changed', { idempotencyKey: 'delivery:1' }))
			.toThrowError(expect.objectContaining({ code: 'STATE_ERROR', meta: expect.objectContaining({ reason: 'run_conflict' }) }))
		release()
		await expect(joined).resolves.toMatchObject({ status: 'completed', output: 'once' })
		const secondEvents = []; for await (const event of second) secondEvents.push(event)
		expect(secondEvents.map(event => event.type)).toEqual(['run.started', 'run.finished'])
		expect(provider.calls).toBe(1)

		const replay = []; for await (const event of session.agents.idempotentAgent.stream('same', { idempotencyKey: 'delivery:1' })) replay.push(event)
		expect(replay.map(event => event.type)).toEqual(['run.started', 'run.finished'])
		expect(provider.calls).toBe(1)
		await session.destroy()
		await harness.close()
	})

	it('does not allocate sandbox compute for an agent without sandbox-using bindings', async () => {
		const sandbox = new TrackingSandbox()
		const inspect = defineTool('sandboxRequirement', { description: 'Require sandbox.', input: z.string(), output: z.string(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(_context, input) { return input } })
		const sandboxAgent = defineAgent('sandboxConsumer', { instructions: 'Use tools.', tools: [inspect] })
		const plainAgent = defineAgent('plainAgent', { instructions: 'Reply.' })
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: 'plain', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		const harness = await defineHarness({ name: 'targetSandboxLaziness' }).addAgent(sandboxAgent).addAgent(plainAgent)
			.getInstance({ sandbox, model: { provider, model: 'fake' } })
		const session = await harness.getSession('plain-agent')
		await expect(session.agents.plainAgent.run('hello')).resolves.toMatchObject({ status: 'completed', output: 'plain' })
		expect(sandbox.openCalls).toBe(0)
		await session.destroy()
		await harness.close()
	})

	it('shares an explicit child group with its parent owner while keeping the default child task isolated', async () => {
		const observations: boolean[] = []
		const writeFile = defineTool('writeSharedFile', { description: 'Write a test file.', input: z.string(), output: z.string(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(context, input) { await context.sandbox.write('/shared.txt', input); return input } })
		const inspectFile = defineTool('inspectSharedFile', { description: 'Inspect a test file.', input: z.string(), output: z.boolean(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(context, input) { const exists = await context.sandbox.exists(input); observations.push(exists); return exists } })
		const writer = defineAgent('groupWriter', { instructions: 'Write once.', tools: [writeFile], sandbox: { group: 'reviewers' } })
		const reader = defineAgent('childReader', { instructions: 'Inspect once.', tools: [inspectFile] })
		const workflow = defineWorkflow('childSandboxVisibility', { input: z.string(), output: z.string(), agents: [reader],
			sandbox: { group: 'reviewers' }, childTaskSandboxGroups: ['reviewers'] as const, async handler({ agents, childTasks, input }) {
				await agents.childReader.run(input, { callId: 'inline' })
				const shared = await childTasks.start('childReader', input, { callId: 'shared', sandbox: { group: 'reviewers' } })
				await shared.result()
				const isolated = await childTasks.start('childReader', input, { callId: 'isolated' })
				await isolated.result()
				return input
			} })
		const provider = new FakeModelProvider({ strict: true })
		const response = (content: string, toolCalls: readonly { id: string; name: string; arguments: string }[] = []) => ({
			content, toolCalls, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: toolCalls.length > 0 ? 'tool_calls' as const : 'stop' as const,
		})
		provider.enqueueText(response('', [{ id: 'write-1', name: 'writeSharedFile', arguments: 'visible' }]))
		provider.enqueueText(response('written'))
		provider.enqueueText(response('', [{ id: 'read-inline', name: 'inspectSharedFile', arguments: '/shared.txt' }]))
		provider.enqueueText(response('inline'))
		provider.enqueueText(response('', [{ id: 'read-shared', name: 'inspectSharedFile', arguments: '/shared.txt' }]))
		provider.enqueueText(response('shared'))
		provider.enqueueText(response('', [{ id: 'read-isolated', name: 'inspectSharedFile', arguments: '/shared.txt' }]))
		provider.enqueueText(response('isolated'))
		const sandbox = new TrackingSandbox()
		const harness = await defineHarness({ name: 'childSandboxScopes' }).addAgent(writer).addWorkflow(workflow).getInstance({
			model: { provider, model: 'fake' }, sandbox, sandboxBinding: { groups: ['reviewers'] as const },
		})
		const session = await harness.getSession('sandbox-owner')
		await expect(session.agents.groupWriter.run('write')).resolves.toMatchObject({ status: 'completed' })
		sandbox.failNextTermination = new Error('retry isolated child termination')
		await expect(session.workflows.childSandboxVisibility.run('/shared.txt')).resolves.toMatchObject({ status: 'completed' })
		expect(observations).toEqual([true, true, false])
		expect(sandbox.terminatedScopes.filter(scope => scope.lifetime === 'run')).toEqual([
			expect.objectContaining({ partition: { kind: 'shared' } }),
		])
		expect(sandbox.terminatedScopes.some(scope => scope.partition.kind === 'group')).toBe(false)
		await session.destroy()
		await harness.close()
		expect(sandbox.terminatedScopes.filter(scope => scope.lifetime === 'run')).toHaveLength(2)
	})

	it('inherits the exact caller sandbox for subagents while honoring a private child override', async () => {
		const observations: boolean[] = []
		const writeFile = defineTool('writeForSubagent', { description: 'Write a test file.', input: z.string(), output: z.string(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(context, input) { await context.sandbox.write('/shared.txt', input); return input } })
		const inspectFile = defineTool('inspectForSubagent', { description: 'Inspect a test file.', input: z.string(), output: z.boolean(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(context, input) { const exists = await context.sandbox.exists(input); observations.push(exists); return exists } })
		const inherited = defineAgent('inheritedSubagent', { instructions: 'Inspect once.', tools: [inspectFile] })
		const isolated = defineAgent('privateSubagent', { instructions: 'Inspect once.', tools: [inspectFile], sandbox: 'private' })
		const parent = defineAgent('sandboxParent', { instructions: 'Write, then delegate twice.', tools: [writeFile],
			subagents: { inherited, isolated }, sandbox: { group: 'reviewers' } })
		const provider = new FakeModelProvider({ strict: true })
		const response = (content: string, toolCalls: readonly { id: string; name: string; arguments: string }[] = []) => ({
			content, toolCalls, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: toolCalls.length > 0 ? 'tool_calls' as const : 'stop' as const,
		})
		provider.enqueueText(response('', [{ id: 'write', name: 'writeForSubagent', arguments: 'visible' }]))
		provider.enqueueText(response('', [{ id: 'delegate-inherited', name: 'inherited', arguments: '/shared.txt' }]))
		provider.enqueueText(response('', [{ id: 'inspect-inherited', name: 'inspectForSubagent', arguments: '/shared.txt' }]))
		provider.enqueueText(response('inherited complete'))
		provider.enqueueText(response('', [{ id: 'delegate-private', name: 'isolated', arguments: '/shared.txt' }]))
		provider.enqueueText(response('', [{ id: 'inspect-private', name: 'inspectForSubagent', arguments: '/shared.txt' }]))
		provider.enqueueText(response('private complete'))
		provider.enqueueText(response('done'))
		const sandbox = new TrackingSandbox()
		const harness = await defineHarness({ name: 'subagentSandboxScopes', revision: 'v1' }).addAgent(parent).getInstance({
			storage: persistentStorage(), model: { provider, model: 'fake' }, sandbox, sandboxBinding: { groups: ['reviewers'] as const },
		})
		const session = await harness.getSession('subagent-owner')
		await expect(session.agents.sandboxParent.run('start')).resolves.toMatchObject({ status: 'completed', output: 'done' })
		expect(observations).toEqual([true, false])
		await session.destroy()
		await harness.close()
	})

	it('preserves the resolved workflow sandbox recursively through an agent and its subagents', async () => {
		const observations: boolean[] = []
		const writeFile = defineTool('writeRecursiveFile', { description: 'Write a test file.', input: z.string(), output: z.string(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(context, input) { await context.sandbox.write('/nested.txt', input); return input } })
		const inspectFile = defineTool('inspectRecursiveFile', { description: 'Inspect a test file.', input: z.string(), output: z.boolean(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(context, input) { const exists = await context.sandbox.exists(input); observations.push(exists); return exists } })
		const writer = defineAgent('recursiveWriter', { instructions: 'Write once.', tools: [writeFile], sandbox: { group: 'reviewers' } })
		const inheritedLeaf = defineAgent('recursiveInheritedLeaf', { instructions: 'Inspect once.', tools: [inspectFile] })
		const privateLeaf = defineAgent('recursivePrivateLeaf', { instructions: 'Inspect once.', tools: [inspectFile], sandbox: 'private' })
		const middle = defineAgent('recursiveMiddle', { instructions: 'Delegate twice.', subagents: { inheritedLeaf, privateLeaf } })
		const workflow = defineWorkflow('recursiveSandboxFlow', { input: z.string(), output: z.string(), agents: [middle],
			sandbox: { group: 'reviewers' }, async handler({ agents, input }) { await agents.recursiveMiddle.run(input, { callId: 'middle' }); return input } })
		const provider = new FakeModelProvider({ strict: true })
		const response = (content: string, toolCalls: readonly { id: string; name: string; arguments: string }[] = []) => ({
			content, toolCalls, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: toolCalls.length > 0 ? 'tool_calls' as const : 'stop' as const,
		})
		provider.enqueueText(response('', [{ id: 'write', name: 'writeRecursiveFile', arguments: 'visible' }]))
		provider.enqueueText(response('written'))
		provider.enqueueText(response('', [{ id: 'delegate-inherited', name: 'inheritedLeaf', arguments: '/nested.txt' }]))
		provider.enqueueText(response('', [{ id: 'inspect-inherited', name: 'inspectRecursiveFile', arguments: '/nested.txt' }]))
		provider.enqueueText(response('inherited complete'))
		provider.enqueueText(response('', [{ id: 'delegate-private', name: 'privateLeaf', arguments: '/nested.txt' }]))
		provider.enqueueText(response('', [{ id: 'inspect-private', name: 'inspectRecursiveFile', arguments: '/nested.txt' }]))
		provider.enqueueText(response('private complete'))
		provider.enqueueText(response('middle complete'))
		const sandbox = new TrackingSandbox()
		const harness = await defineHarness({ name: 'recursiveSandboxScopes', revision: 'v1', defaults: { maxDepth: 3 } }).addAgent(writer).addWorkflow(workflow).getInstance({
			storage: persistentStorage(), model: { provider, model: 'fake' }, sandbox, sandboxBinding: { groups: ['reviewers'] as const },
		})
		const session = await harness.getSession('recursive-owner')
		await expect(session.agents.recursiveWriter.run('write')).resolves.toMatchObject({ status: 'completed' })
		await expect(session.workflows.recursiveSandboxFlow.run('/nested.txt')).resolves.toMatchObject({ status: 'completed' })
		expect(observations).toEqual([true, false])
		await session.destroy()
		await harness.close()
	})

	it('resumes a nested approval with the same borrowed inherited and private sandbox scopes', async () => {
		const owner = Object.freeze({ namespace: 'external', id: 'approval-scope', instanceId: '01ARZ3NDEKTSV4RRFFQ69G5FB2',
			identity: Object.freeze({ tenantId: 'tenant-a', principalId: 'principal-a' }) })
		const sandbox = new TrackingSandbox()
		await sandbox.registerOwner({ owner, mode: 'create' })
		const sharedScope = Object.freeze({ owner, partition: Object.freeze({ kind: 'group' as const, id: 'reviewers' }), lifetime: 'session' as const })
		const shared = await sandbox.open({ scope: sharedScope, mode: 'create', identity: owner.identity })
		await shared.session.write('/approval.txt', 'visible')
		const privateScope = Object.freeze({ owner, partition: Object.freeze({ kind: 'agent' as const,
			harnessName: 'nestedApprovalSandbox', id: 'approvalPrivateLeaf' }), lifetime: 'session' as const })
		await sandbox.open({ scope: privateScope, mode: 'create', identity: owner.identity })
		const visibility: boolean[] = []
		let effects = 0
		let authorizations = 0
		let authorizationsAtEffect = 0
		const inspectGroup = defineTool('inspectInheritedGroup', { description: 'Inspect inherited group state.', input: z.string(), output: z.boolean(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(context, input) { const exists = await context.sandbox.exists(input); visibility.push(exists); return exists } })
		const approvedEffect = defineTool('bash', { description: 'Inspect private state after approval.', input: z.string(), output: z.boolean(),
			requires: { sandbox: ['sandbox.fs'] }, async handler(context, input) {
				authorizationsAtEffect = authorizations
				effects += 1
				const exists = await context.sandbox.exists(input)
				visibility.push(exists)
				return exists
			} })
		const reviewer = defineAgent('approvalPrivateLeaf', { instructions: 'Run the approved inspection.', tools: [approvedEffect],
			permissions: { bash: 'require_approval' }, sandbox: 'private' })
		const middle = defineAgent('approvalInheritedMiddle', { instructions: 'Inspect, then delegate.', tools: [inspectGroup], subagents: { reviewer } })
		const workflow = defineWorkflow('nestedApprovalScope', { input: z.string(), output: z.string(), agents: [middle],
			sandbox: { group: 'reviewers' }, async handler({ agents, input }) { return agents.approvalInheritedMiddle.run(input, { callId: 'middle' }) } })
		const provider = new FakeModelProvider({ strict: true })
		const response = (content: string, toolCalls: readonly { id: string; name: string; arguments: string }[] = []) => ({
			content, toolCalls, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: toolCalls.length > 0 ? 'tool_calls' as const : 'stop' as const,
		})
		provider.enqueueText(response('', [{ id: 'inspect-group', name: 'inspectInheritedGroup', arguments: '/approval.txt' }]))
		provider.enqueueText(response('', [{ id: 'delegate', name: 'reviewer', arguments: '/approval.txt' }]))
		provider.enqueueText(response('', [{ id: 'approve', name: 'bash', arguments: '/approval.txt' }]))
		provider.enqueueText(response('leaf complete'))
		provider.enqueueText(response('middle complete'))
		const storage = persistentStorage()
		const harness = await defineHarness({ name: 'nestedApprovalSandbox', revision: 'v1', defaults: { maxDepth: 3 } })
			.addWorkflow(workflow).getInstance({ storage, sandbox, model: { provider, model: 'fake' },
				sandboxBinding: { groups: ['reviewers'] as const, authorizeOwner: () => { authorizations += 1; return true } } })
		const session = await harness.getSession('nested-approval', { identity: owner.identity, sandboxOwner: owner })
		const interrupted = await session.workflows.nestedApprovalScope.run('/approval.txt')
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('expected nested approval')
		expect(visibility).toEqual([true])
		expect(effects).toBe(0)
		const privateScopesBefore = sandbox.openedScopes.filter(scope => scope.partition.kind === 'agent')
		expect(privateScopesBefore).toHaveLength(2)
		expect(privateScopesBefore.every(scope => JSON.stringify(scope) === JSON.stringify(privateScope))).toBe(true)
		const beforeResume = authorizations
		await expect(session.workflows.nestedApprovalScope.run('/approval.txt', { resume: {
			type: 'tool-approval', runId: interrupted.runId, interruptId: interrupted.interrupt.id,
			revision: interrupted.interrupt.revision, eventId: 'nested-borrowed-resume',
			decisions: [{ approvalId: interrupted.interrupt.requests[0]!.approvalId, approved: true }],
		} })).resolves.toMatchObject({ status: 'completed', output: 'middle complete' })
		expect(effects).toBe(1)
		expect(authorizationsAtEffect).toBeGreaterThan(beforeResume)
		expect(visibility).toEqual([true, false])
		expect(sandbox.openedScopes.filter(scope => scope.partition.kind === 'agent')
			.every(scope => JSON.stringify(scope) === JSON.stringify(privateScope))).toBe(true)
		await session.destroy()
		await harness.close()
	})

	it('streams nested workflow events with exact immediate-parent correlation in execution order', async () => {
		const leaf = defineAgent('eventLeaf', { instructions: 'Finish.' })
		const middle = defineAgent('eventMiddle', { instructions: 'Delegate.', subagents: { leaf } })
		const workflow = defineWorkflow('eventWorkflow', { input: z.string(), output: z.string(), agents: [middle],
			async handler({ agents, input }) { return agents.eventMiddle.run(input, { callId: 'middle' }) } })
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'delegate', name: 'leaf', arguments: 'child' }],
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'leaf complete', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		provider.enqueueText({ content: 'middle complete', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		const harness = await defineHarness({ name: 'nestedEventCorrelation', revision: 'v1', defaults: { maxDepth: 3 } })
			.addWorkflow(workflow).getInstance({ storage: persistentStorage(), model: { provider, model: 'fake' } })
		const session = await harness.getSession('nested-events')
		const events: Array<{ type: string; runId: string; parentRunId?: string; parentInvocationId?: string }> = []
		for await (const event of session.workflows.eventWorkflow.stream('start')) events.push(event)
		const rootStarted = events.find(event => event.type === 'run.started' && event.parentRunId === undefined)!
		const directStarted = events.find(event => event.type === 'run.started' && event.parentRunId === rootStarted.runId)!
		const descendantStarted = events.find(event => event.type === 'run.started' && event.parentRunId === directStarted.runId)!
		expect(rootStarted.parentInvocationId).toBeUndefined()
		expect(directStarted.parentInvocationId).toBe(directStarted.runId)
		expect(descendantStarted.parentInvocationId).toBe(descendantStarted.runId)
		const tuples = [rootStarted, directStarted, descendantStarted].map(event => [event.runId, event.parentRunId, event.parentInvocationId])
		expect(tuples).toEqual([
			[rootStarted.runId, undefined, undefined],
			[directStarted.runId, rootStarted.runId, directStarted.runId],
			[descendantStarted.runId, directStarted.runId, descendantStarted.runId],
		])
		const terminalIndex = (runId: string) => events.findIndex(event => event.type === 'run.finished' && event.runId === runId)
		expect(events.indexOf(rootStarted)).toBeLessThan(events.indexOf(directStarted))
		expect(events.indexOf(directStarted)).toBeLessThan(events.indexOf(descendantStarted))
		expect(terminalIndex(descendantStarted.runId)).toBeLessThan(terminalIndex(directStarted.runId))
		expect(terminalIndex(directStarted.runId)).toBeLessThan(terminalIndex(rootStarted.runId))
		await session.destroy()
		await harness.close()
	})

	it('destroys the active session generation and its persisted state', async () => {
		const { harness, storage, sandbox, provider } = await buildLifecycleHarness()
		const session = await harness.getSession('destroyed')
		await session.replaceHistory([{ role: 'user', content: 'delete me' }])
		provider.enqueueText({ content: 'delete run', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		await session.agents.owner.run('delete run')

		await session.destroy()

		await expect(storage.getSession('destroyed')).resolves.toBeUndefined()
		await expect(storage.listMessages('destroyed')).resolves.toEqual([])
		await expect(storage.listRuns('destroyed')).resolves.toEqual([])
		expect(sandbox.closeCalls).toBe(1)
		expect(sandbox.terminatedScopes).toHaveLength(1)
		await harness.close()
	})

	it('cancels and waits for an active root before closing instance resources', async () => {
		let entered!: () => void
		const started = new Promise<void>(resolve => { entered = resolve })
		let finishCleanup!: () => void
		const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
		const workflow = defineWorkflow('closing', {
			input: z.string(), output: z.string(),
			async handler({ signal }) {
				entered()
				await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
				await cleanup
				throw new OperationCancelledError('Run was cancelled.', { scope: 'run' })
			},
		})
		const harness = await defineHarness({ name: 'closeWaits' }).addWorkflow(workflow).getInstance({})
		const session = await harness.getSession('closing')
		const running = session.workflows.closing.run('wait')
		await started
		let closed = false
		const closing = harness.close().then(() => { closed = true })
		await Promise.resolve()
		expect(closed).toBe(false)

		finishCleanup()
		await expect(running).rejects.toBeInstanceOf(OperationCancelledError)
		await expect(closing).resolves.toBeUndefined()
		expect(closed).toBe(true)
	})

	it('cancels a resident child task before releasing its owner session', async () => {
		let markStarted!: () => void
		const started = new Promise<void>(resolve => { markStarted = resolve })
		class BlockingProvider extends FakeModelProvider {
			public override async text(): Promise<never> {
				markStarted()
				return new Promise<never>(() => undefined)
			}
		}
		const worker = defineAgent('worker', {
			input: z.string(), instructions: 'Wait.', prompt: value => ({ role: 'user', content: value }),
		})
		let task: ChildTaskHandle<string> | undefined
		const launch = defineWorkflow('launch', {
			input: z.string(), output: z.string(), agents: [worker], durable: true,
			async handler({ childTasks, input }) {
				task = await childTasks.start('worker', input, { callId: 'background', idempotencyKey: 'background' })
				void task.result().catch(() => undefined)
				return task.id
			},
		})
		const storage = persistentStorage()
		const harness = await defineHarness({ name: 'releaseChild', revision: 'v1' }).addWorkflow(launch)
			.getInstance({ storage, model: { provider: new BlockingProvider(), model: 'fake' } })
		const session = await harness.getSession('release-child')
		await session.workflows.launch.run('work')
		await started

		await session.release()

		await expect(task?.status()).resolves.toMatchObject({ status: 'cancelled' })
		await harness.close()
	})
})
