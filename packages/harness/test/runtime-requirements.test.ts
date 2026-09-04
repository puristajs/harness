import { describe, expect, it } from 'vitest'

import { HarnessConfigError } from '../src/errors/index.js'
import type { RuntimeRequirements } from '../src/runtime/runtime-requirements.js'
import { validateHarnessInstanceConfig } from '../src/runtime/instance-config.js'
import { deriveRuntimeRequirements } from '../src/runtime/runtime-requirements.js'
import { defineSkill } from '../src/definitions/skill.js'
import { defineAgent } from '../src/definitions/agent.js'
import { z } from 'zod'

const emptyRequirements = requirements()

function requirements(overrides: Partial<RuntimeRequirements> = {}): RuntimeRequirements {
	return Object.freeze({
		models: Object.freeze({}), mcpServers: Object.freeze([]), skillRuntimes: Object.freeze([]),
		storage: Object.freeze({ durable: false }),
		memory: Object.freeze({ capabilities: Object.freeze([]), modelAliases: Object.freeze([]) }),
		sandbox: Object.freeze({ capabilities: Object.freeze([]) }), workspace: false, artifacts: false,
		hostTools: Object.freeze([]), ...overrides,
	})
}

function provider(methods: Record<string, unknown> = {}) {
	return { id: 'provider', genAiSystem: 'test', ...methods }
}

function reasonOf(run: () => unknown): string | undefined {
	try { run() } catch (error) {
		if (error instanceof HarnessConfigError) return error.meta?.['reason'] as string | undefined
		throw error
	}
	return undefined
}

function errorOf(run: () => unknown): HarnessConfigError {
	try { run() } catch (error) {
		if (error instanceof HarnessConfigError) return error
		throw error
	}
	throw new Error('Expected HarnessConfigError')
}

describe('exact Harness instance requirements', () => {
	it('derives guidance and runtime Skill requirements without granting execution', () => {
		const guidance = defineSkill('guidance', { directory: new URL('file:///tmp/guidance') })
		const runtime = defineSkill('runtime', { directory: new URL('file:///tmp/runtime'), runtimes: ['python', 'shell'] as const })
		const agent = defineAgent('helper', { instructions: 'Use selected guidance.', skills: [guidance], output: z.string() })
		const required = deriveRuntimeRequirements({ tools: {}, skills: { guidance, runtime }, mcpServers: {}, agents: { helper: agent }, workflows: {} })
		expect(required.skillRuntimes).toEqual(['python', 'shell'])
		expect(required.sandbox.capabilities).toEqual(['sandbox.fs', 'sandbox.readonly_mount'])
		expect(required.models.primary?.capabilities).toContain('tool_use')
		expect(required.sandbox.capabilities).not.toContain('sandbox.exec')
	})
	it('accepts an empty graph, rejects unknown configuration, and freezes a detached snapshot', () => {
		const snapshot = validateHarnessInstanceConfig(emptyRequirements, {})
		expect(snapshot.models).toEqual({})
		expect(Object.isFrozen(snapshot)).toBe(true)
		expect(Object.isFrozen(snapshot.models)).toBe(true)
		const unknown = errorOf(() => validateHarnessInstanceConfig(emptyRequirements, { zzz: true, aaa: true }))
		expect(unknown.meta).toMatchObject({ reason: 'unexpected_runtime_binding', path: 'aaa' })
		expect(reasonOf(() => validateHarnessInstanceConfig(emptyRequirements, null))).toBe('invalid_instance_config')
		expect(reasonOf(() => validateHarnessInstanceConfig(emptyRequirements, new Date()))).toBe('invalid_instance_config')
		expect(reasonOf(() => validateHarnessInstanceConfig(emptyRequirements, { model: {}, models: {} }))).toBe('invalid_instance_config')
	})

	it('normalizes the primary selector, injects capabilities, and preserves provider identity', () => {
		const modelProvider = provider({ text: async () => ({}) })
		const required = requirements({ models: Object.freeze({ primary: Object.freeze({ capabilities: Object.freeze(['text'] as const) }) }) })
		const snapshot = validateHarnessInstanceConfig(required, { model: { provider: modelProvider, model: 'demo' } })
		expect(snapshot.models.primary).toEqual({ provider: modelProvider, model: 'demo', capabilities: ['text'] })
		expect(snapshot.models.primary?.provider).toBe(modelProvider)
		expect(Object.isFrozen(snapshot.models.primary)).toBe(true)
		expect(Object.isFrozen(snapshot.models.primary?.capabilities)).toBe(true)
		expect(reasonOf(() => validateHarnessInstanceConfig(required, {}))).toBe('missing_runtime_binding')
		expect(reasonOf(() => validateHarnessInstanceConfig(required, { models: { primary: {} } }))).toBe('unexpected_runtime_binding')
		expect(reasonOf(() => validateHarnessInstanceConfig(required, { model: { provider: modelProvider, model: 'demo', capabilities: [] } }))).toBe('unexpected_runtime_binding')
		const invalidOptions = errorOf(() => validateHarnessInstanceConfig(required, {
			model: { provider: modelProvider, model: 'demo', providerOptions: { nested: new Map() } },
		}))
		expect(invalidOptions.meta).toMatchObject({ reason: 'invalid_runtime_binding', path: 'model.providerOptions.nested' })
		class CustomOption {}
		expect(errorOf(() => validateHarnessInstanceConfig(required, {
			model: { provider: modelProvider, model: 'demo', defaults: { providerOptions: { custom: new CustomOption() } } },
		})).meta).toMatchObject({ reason: 'invalid_runtime_binding', path: 'model.defaults.providerOptions.custom' })
		const directCycle: Record<string, unknown> = {}
		directCycle.self = directCycle
		expect(errorOf(() => validateHarnessInstanceConfig(required, {
			model: { provider: modelProvider, model: 'demo', providerOptions: directCycle },
		})).meta).toMatchObject({ reason: 'invalid_runtime_binding', path: 'model.providerOptions.self' })
		const nestedCycle: Record<string, unknown> = { child: {} }
		;(nestedCycle.child as Record<string, unknown>).parent = nestedCycle
		expect(errorOf(() => validateHarnessInstanceConfig(required, {
			model: { provider: modelProvider, model: 'demo', providerOptions: nestedCycle },
		})).meta).toMatchObject({ reason: 'invalid_runtime_binding', path: 'model.providerOptions.child.parent' })
		const shared = { value: 'same' }
		const sharedSnapshot = validateHarnessInstanceConfig(required, {
			model: { provider: modelProvider, model: 'demo', providerOptions: { left: shared, right: shared } },
		})
		const copiedOptions = sharedSnapshot.models.primary?.providerOptions as Record<string, unknown>
		expect(copiedOptions.left).toEqual({ value: 'same' })
		expect(copiedOptions.left).not.toBe(copiedOptions.right)
		const invalidRetry = errorOf(() => validateHarnessInstanceConfig(required, {
			model: { provider: modelProvider, model: 'demo', retry: { maxAttempts: 0 } },
		}))
		expect(invalidRetry.meta).toMatchObject({ reason: 'invalid_runtime_binding', path: 'model.retry.maxAttempts' })
	})

	it('requires exact multi-model aliases and validates methods plus optional provider metadata', () => {
		const required = requirements({ models: Object.freeze({
			fast: Object.freeze({ capabilities: Object.freeze(['text_stream'] as const) }),
			primary: Object.freeze({ capabilities: Object.freeze(['text'] as const) }),
		}) })
		const valid = {
			fast: { provider: provider({ textStream: async function* () {} }), model: 'fast-model' },
			primary: { provider: provider({ text: async () => ({}) }), model: 'primary-model' },
		}
		expect(Object.keys(validateHarnessInstanceConfig(required, { models: valid }).models)).toEqual(['fast', 'primary'])
		expect(reasonOf(() => validateHarnessInstanceConfig(required, { models: { primary: valid.primary } }))).toBe('missing_runtime_binding')
		expect(reasonOf(() => validateHarnessInstanceConfig(required, { models: { ...valid, extra: valid.primary } }))).toBe('unexpected_runtime_binding')
		const mixedAliases = errorOf(() => validateHarnessInstanceConfig(required, { models: { aaa: valid.primary, primary: valid.primary } }))
		expect(mixedAliases.meta).toMatchObject({ reason: 'unexpected_runtime_binding', path: 'models.aaa' })
		expect(reasonOf(() => validateHarnessInstanceConfig(required, { models: {
			...valid, fast: { provider: provider(), model: 'fast-model' },
		} }))).toBe('model_capability_mismatch')

		const metadataProvider = provider({
			text: async () => ({}), info: { providerId: 'provider', genAiSystem: 'test', models: { other: { capabilities: ['text'] } } },
		})
		const primaryOnly = requirements({ models: Object.freeze({ primary: Object.freeze({ capabilities: Object.freeze(['text'] as const) }) }) })
		expect(reasonOf(() => validateHarnessInstanceConfig(primaryOnly, {
			model: { provider: metadataProvider, model: 'missing' },
		}))).toBe('model_capability_mismatch')
		const markerRequirements = requirements({ models: Object.freeze({ primary: Object.freeze({ capabilities: Object.freeze(['tool_use'] as const) }) }) })
		expect(validateHarnessInstanceConfig(markerRequirements, { model: { provider: provider(), model: 'marker' } }).models.primary).toBeDefined()
	})

	it('validates required groups without calling or freezing borrowed resources', () => {
		let calls = 0
		const storage = storageAdapter(() => { calls += 1 })
		const memory = memoryAdapter(() => { calls += 1 })
		const sandbox = sandboxAdapter(() => { calls += 1 })
		const workspace = workspaceAdapter(() => { calls += 1 })
		const artifacts = { async publish() { calls += 1; return { id: 'a', url: 'https://example.com/a', mediaType: 'text/plain' } } }
		const required = requirements({
			mcpServers: Object.freeze(['knowledge']), skillRuntimes: Object.freeze(['python']),
			storage: Object.freeze({ durable: true }),
			memory: Object.freeze({ capabilities: Object.freeze(['memory.kv']), modelAliases: Object.freeze([]) }),
			sandbox: Object.freeze({ capabilities: Object.freeze(['sandbox.fs']) }), workspace: true, artifacts: true,
		})
		const headers = { authorization: 'secret' }
		const snapshot = validateHarnessInstanceConfig(required, {
			mcp: { knowledge: { transport: 'http', url: 'https://example.com/mcp', headers } },
			storage, memory, sandbox, workspace, artifacts,
		})
		headers.authorization = 'changed'
		expect(calls).toBe(0)
		expect(snapshot.storage).toBe(storage)
		expect(snapshot.memory).toBe(memory)
		expect(snapshot.sandbox).toBe(sandbox)
		expect(snapshot.workspace).toBe(workspace)
		expect(snapshot.artifacts).toBe(artifacts)
		expect(Object.isFrozen(storage)).toBe(false)
		expect(Object.isFrozen(snapshot.mcp?.knowledge?.headers)).toBe(true)
		expect(snapshot.mcp?.knowledge?.headers?.authorization).toBe('secret')
	})

	it('validates MCP transport branches and treats stdio sandbox independently', () => {
		const required = requirements({ mcpServers: Object.freeze(['knowledge']) })
		expect(reasonOf(() => validateHarnessInstanceConfig(required, { mcp: {
			knowledge: { transport: 'http', url: '/relative' },
		} }))).toBe('invalid_runtime_binding')
		expect(reasonOf(() => validateHarnessInstanceConfig(required, { mcp: {
			knowledge: { transport: 'stdio', command: 'node', sandbox: sandboxAdapter(() => {}, ['sandbox.fs']) },
		} }))).toBe('missing_required_capability')
		expect(reasonOf(() => validateHarnessInstanceConfig(required, { mcp: {
			knowledge: { transport: 'http', url: 'https://example.com/mcp', headers: { authorization: 1 } },
		} }))).toBe('invalid_runtime_binding')
		const mixedIds = requirements({ mcpServers: Object.freeze(['zeta']) })
		const mixedMcp = errorOf(() => validateHarnessInstanceConfig(mixedIds, { mcp: {
			aardvark: { transport: 'http', url: 'https://example.com/mcp' },
		} }))
		expect(mixedMcp.meta).toMatchObject({ reason: 'unexpected_runtime_binding', path: 'mcp.aardvark' })
		const snapshot = validateHarnessInstanceConfig(required, { mcp: {
			knowledge: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' }, sandbox: sandboxAdapter(() => {}, ['sandbox.spawn']) },
		} })
		expect(snapshot.mcp?.knowledge?.transport).toBe('stdio')
	})

	it('uses stable presence and capability errors and validates optional controls', () => {
		const memoryRequired = requirements({ memory: Object.freeze({ capabilities: Object.freeze(['memory.vector_search']), modelAliases: Object.freeze([]) }) })
		expect(reasonOf(() => validateHarnessInstanceConfig(memoryRequired, {}))).toBe('missing_runtime_binding')
		expect(reasonOf(() => validateHarnessInstanceConfig(memoryRequired, { memory: memoryAdapter(() => {}) }))).toBe('missing_required_capability')
		expect(reasonOf(() => validateHarnessInstanceConfig(emptyRequirements, { memory: memoryAdapter(() => {}) }))).toBe('unexpected_runtime_binding')
		expect(reasonOf(() => validateHarnessInstanceConfig(requirements({ hostTools: Object.freeze(['invoke']) }), {}))).toBe('standalone_host_tools_unsupported')
		const runtimeRequired = requirements({ skillRuntimes: Object.freeze(['python']) })
		const { runtimes: _runtimes, ...withoutRuntime } = sandboxAdapter(() => {}, [])
		expect(reasonOf(() => validateHarnessInstanceConfig(runtimeRequired, { sandbox: withoutRuntime }))).toBe('missing_required_capability')
		const sandboxRequired = requirements({ sandbox: Object.freeze({ capabilities: Object.freeze(['sandbox.fs']) }) })
		const superset = sandboxAdapter(() => {}, ['sandbox.fs', 'sandbox.exec'])
		expect(validateHarnessInstanceConfig(sandboxRequired, { sandbox: superset }).sandbox).toBe(superset)
		for (const method of ['list', 'purge', 'sweep', 'deleteSnapshot'] as const) {
			const incomplete = sandboxAdapter(() => {}, ['sandbox.fs'])
			delete incomplete.administration[method]
			expect(errorOf(() => validateHarnessInstanceConfig(sandboxRequired, { sandbox: incomplete })).meta)
				.toMatchObject({ reason: 'invalid_runtime_binding', path: `sandbox.administration.${method}` })
		}
		const durableRequired = requirements({ storage: Object.freeze({ durable: true }) })
		const nonPersistent = storageAdapter(() => {})
		;(nonPersistent.capabilities as string[]).splice(nonPersistent.capabilities.indexOf('storage.persistent'), 1)
		;(nonPersistent.info.capabilities as string[]).splice(nonPersistent.info.capabilities.indexOf('storage.persistent'), 1)
		expect(reasonOf(() => validateHarnessInstanceConfig(durableRequired, { storage: nonPersistent }))).toBe('missing_required_capability')
		const invalidStorage = storageAdapter(() => {})
		invalidStorage.info.id = 'INVALID'
		expect(errorOf(() => validateHarnessInstanceConfig(durableRequired, { storage: invalidStorage })).meta)
			.toMatchObject({ reason: 'invalid_runtime_binding', path: 'storage.info.id' })
		const workspaceRequired = requirements({ workspace: true })
		const invalidWorkspace = workspaceAdapter(() => {})
		;(invalidWorkspace.capabilities as string[]).splice(0)
		;(invalidWorkspace.info.capabilities as string[]).splice(0)
		expect(reasonOf(() => validateHarnessInstanceConfig(workspaceRequired, { workspace: invalidWorkspace }))).toBe('missing_required_capability')
		const artifactsRequired = requirements({ artifacts: true })
		expect(reasonOf(() => validateHarnessInstanceConfig(artifactsRequired, { artifacts: {} }))).toBe('invalid_runtime_binding')

		const snapshot = validateHarnessInstanceConfig(emptyRequirements, {
			agentAdmission: { async acquire() { return { release() {} } } },
			admission: { async acquire() { return { release() {} } } },
			logger: logger(), telemetry: { flavor: 'dual', contentCaptureMode: 'NO_CONTENT' },
		})
		expect(snapshot.agentAdmission).toBeDefined()
		expect(Object.isFrozen(snapshot.telemetry)).toBe(true)
		expect(reasonOf(() => validateHarnessInstanceConfig(emptyRequirements, { telemetry: { flavor: 'invalid' } }))).toBe('invalid_runtime_binding')
		expect(reasonOf(() => validateHarnessInstanceConfig(emptyRequirements, { agentAdmission: {} }))).toBe('invalid_runtime_binding')
		expect(reasonOf(() => validateHarnessInstanceConfig(emptyRequirements, { logger: {} }))).toBe('invalid_runtime_binding')
	})
})

function storageAdapter(touch: () => void) {
	const method = async () => { touch() }
	return {
		info: { id: 'storage', packageName: 'test', capabilities: ['storage.checkpoint', 'storage.retry', 'storage.resume', 'storage.workspace_checkpoint', 'storage.external_wait', 'storage.persistent'] },
		capabilities: ['storage.checkpoint', 'storage.retry', 'storage.resume', 'storage.workspace_checkpoint', 'storage.external_wait', 'storage.persistent'],
		getSession: method, upsertSession: method, closeSession: method, appendMessages: method, listMessages: method,
		clearMessages: method, createRun: method, finishRun: method, getRun: method, listRuns: method,
		appendEvents: method, listEvents: method, acquireRun: method, loadCheckpoint: method, commitCheckpoint: method,
		withSessionLock: method, registerWait: method, getWait: method, signalWait: method, cancelWait: method,
	}
}

function memoryAdapter(touch: () => void) {
	const method = async () => { touch() }
	return { info: { id: 'memory', packageName: 'test' }, capabilities: ['memory.kv', 'memory.list', 'memory.delete'], get: method, put: method, delete: method, list: method }
}

function sandboxAdapter(touch: () => void, capabilities: readonly string[] = ['sandbox.fs']) {
	return {
		capabilities, runtimes: ['python'],
		administration: {
			list: async () => { touch(); return { items: [] } },
			purge: async () => { touch(); return { state: 'completed', deletedResources: 0, remainingResources: 0 } },
			sweep: async () => { touch(); return { examinedResources: 0, deletedResources: 0, pendingResources: 0 } },
			deleteSnapshot: async () => { touch() },
		},
		registerOwner: async () => { touch() }, open: async () => { touch() }, terminate: async () => { touch() },
	}
}

function workspaceAdapter(touch: () => void) {
	const capabilities = ['workspace.durable']
	const method = async () => { touch() }
	return {
		info: { id: 'workspace', packageName: 'test', capabilities, policy: {} }, capabilities, administration: {},
		startWorkspace: method, pauseWorkspace: method, resumeWorkspace: method, abortWorkspace: method,
		pinCheckpoint: method, releaseCheckpoint: method, finish: method, cleanupWorkspace: method,
	}
}

function logger() {
	return { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } }
}
