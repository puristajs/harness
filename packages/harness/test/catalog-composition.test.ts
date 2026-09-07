import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createHash } from 'node:crypto'

import { HarnessConfigError, OperationCancelledError } from '../src/errors/index.js'
import { agentGuardrailsBinding } from '../src/agents/guardrails.js'
import { defineAgent } from '../src/definitions/agent.js'
import { defineCatalog } from '../src/definitions/catalog.js'
import { defineHarness } from '../src/definitions/harness.js'
import { attachDefinitionIdentity, createDefinitionIdentity, hasDefinitionIdentity } from '../src/definitions/identity.js'
import { defineMcpServer } from '../src/definitions/mcp-server.js'
import { defineSkill } from '../src/definitions/skill.js'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { compileDefinitionGraph, type DefinitionDependencyReader } from '../src/runtime/compiled-graph.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import type { HarnessAdapterContext } from '../src/harness/adapter-context.js'
import { canonicalJson } from '../src/runtime/canonical-json.js'
import { inMemorySandbox } from '../src/sandbox/index.js'
import { compiledGraphTargetPolicyPreimage } from '../src/runtime/standalone-instance.js'
import { agentExecutionRequirementsSchema } from '../src/harness/agent-requirements.js'

const input = z.object({ message: z.string() })
const output = z.object({ answer: z.string() })

function reasonOf(run: () => unknown): string | undefined {
	try {
		run()
	} catch (error) {
		if (error instanceof HarnessConfigError) return error.meta?.['reason'] as string | undefined
		throw error
	}
	return undefined
}

function fixture() {
	const lookup = defineTool('lookup', {
		description: 'Look up one record.', input, output,
		requires: { memory: ['memory.kv'], sandbox: ['sandbox.exec'] },
		async handler(_context, value) { return { answer: value.message } },
	})
	const policy = defineSkill('support-policy', {
		directory: new URL('./support-policy/', import.meta.url), runtimes: ['python'],
	})
	const knowledge = defineMcpServer('knowledge', {
		tools: { search: { remoteName: 'search', description: 'Search.', input, output } },
	})
	const helper = defineAgent('helper', { instructions: 'Help.', model: 'fast' })
	const assistant = defineAgent('assistant', {
		input, output, instructions: 'Answer.', prompt: value => ({ role: 'user', content: value.message }),
		tools: [lookup, knowledge.tools.search], skills: [policy], subagents: { helper },
		inputCapabilities: ['vision_input'],
		memory: { capabilities: ['memory.vector_search'], embedding: { model: 'embeddings' } },
		guardrails: { [agentGuardrailsBinding]: {
			id: 'bankingGuardrails',
			requirements: { tools: ['lookup'], models: [{ alias: 'guard', capabilities: ['text'] }] },
		} },
		workspace: true, durable: true,
	})
	const resolve = defineWorkflow('resolve', {
		input, output, agents: { assistant },
		models: { image: { alias: 'image', capabilities: ['image_generation'] } },
		async handler({ input: value }) { return { answer: value.message } },
	})
	return { lookup, policy, knowledge, helper, assistant, resolve }
}

describe('catalog composition and graph compilation', () => {
	it('accepts the read-only mount capability in interceptor requirements', () => {
		expect(agentExecutionRequirementsSchema.parse({
			sandbox: ['sandbox.readonly_mount'],
		})).toEqual({ sandbox: ['sandbox.readonly_mount'] })
	})

	it('keeps child-task sandbox groups out of the workflow target-policy digest tuple', () => {
		const worker = defineAgent('digestWorker', { instructions: 'Work.' })
		const workflow = defineWorkflow('digestWorkflow', { input: z.string(), output: z.string(), agents: { worker },
			childTaskSandboxGroups: ['reviewers'] as const, sandbox: { group: 'workflow-scope' }, durable: true,
			async handler({ input }) { return input } })
		const rows = compiledGraphTargetPolicyPreimage(compileDefinitionGraph({ workflows: [workflow] }))
		expect(rows.find(row => Array.isArray(row) && row[0] === 'workflow')).toEqual([
			'workflow', 'digestWorkflow', [null, null], null, ['group', 'workflow-scope'], false, true,
		])
	})
	it('creates a valid frozen empty catalog', () => {
		const catalog = defineCatalog('empty', {})
		const harness = defineHarness({ name: 'emptyHarness' })

		expect(catalog).toMatchObject({ kind: 'catalog', id: 'empty' })
		for (const map of [catalog.tools, catalog.skills, catalog.mcpServers, catalog.agents, catalog.workflows]) {
			expect(map).toEqual({})
			expect(Object.isFrozen(map)).toBe(true)
		}
		expect(Object.isFrozen(catalog)).toBe(true)
		expect(Object.isFrozen(catalog.contracts)).toBe(true)
		expect(Object.isFrozen(catalog.requirements)).toBe(true)
		expect(hasDefinitionIdentity(catalog)).toBe(true)
		expect(hasDefinitionIdentity(harness)).toBe(true)
		expect(hasDefinitionIdentity({ ...catalog })).toBe(false)
		expect(hasDefinitionIdentity({ ...harness })).toBe(false)
		expect(harness.requirements.storage.durable).toBe(false)
		expect(harness.requirements.workspace).toBe(false)
		expect(harness.requirements.artifacts).toBe(false)
	})

	it('rejects structural and spread catalog copies at the Harness boundary', () => {
		const catalog = defineCatalog('authentic', {})
		const harness = defineHarness({ name: 'consumer' })
		expect(reasonOf(() => harness.use({ ...catalog } as never))).toBe('foreign_definition')
		expect(reasonOf(() => harness.use({ kind: 'catalog', id: 'fake', ...catalog } as never))).toBe('foreign_definition')
		expect(reasonOf(() => harness.use(Object.freeze(Object.create(catalog)) as never))).toBe('foreign_definition')
		expect(() => harness.use(catalog)).toThrow(expect.objectContaining({ meta: expect.objectContaining({ reason: 'catalog_has_no_targets' }) }))
	})

	it('retains catalog identity provenance across immutable Harness composition', () => {
		const root = defineAgent('sharedRoot', { instructions: 'Help.' })
		const first = defineCatalog('sharedCatalog', { agents: [root] })
		const conflicting = defineCatalog('sharedCatalog', { agents: [root] })
		const harness = defineHarness({ name: 'catalogConsumer' }).use(first)

		expect(() => harness.use(first)).not.toThrow()
		expect(reasonOf(() => harness.use(conflicting))).toBe('duplicate_definition')
		expect(() => harness.use(conflicting)).toThrow(HarnessConfigError)
	})

	it('keeps catalog exports explicit and exposes Harness roots without a public closure', () => {
		const leaf = defineTool('catalogLeaf', {
			description: 'Leaf.', input, output,
			async handler(_context, value) { return { answer: value.message } },
		})
		const dependency = defineAgent('catalogDependency', { instructions: 'Help.' })
		const root = defineAgent('catalogRoot', { instructions: 'Delegate.', subagents: { helper: { agent: dependency, description: 'Help.' } } })
		const catalog = defineCatalog('explicitOnly', { tools: [leaf], agents: [root] })
		const harness = defineHarness({ name: 'rootOnly', revision: 'v1' }).use(catalog)

		expect(catalog.tools.catalogLeaf).toBe(leaf)
		expect(catalog.agents.catalogRoot).toBe(root)
		expect(catalog.agents).not.toHaveProperty('catalogDependency')
		expect(catalog.requirements.models).toHaveProperty('primary')
		expect(harness.contracts.agents).toHaveProperty('catalogRoot')
		expect(harness.contracts.agents).not.toHaveProperty('catalogDependency')
		expect(harness).not.toHaveProperty('catalog')
		expect(harness.inspect()).toMatchObject({
			roots: { agents: [{ id: 'catalogRoot' }], workflows: [] },
			dependencies: { agents: ['catalogDependency'], tools: [], skills: [], mcpServers: [], workflows: [] },
		})
	})

	it('merges every Guardrail runtime requirement and freezes the normalized view', () => {
		const selected = defineTool('selected', {
			description: 'Selected.', input, output,
			async handler(_context, value) { return { answer: value.message } },
		})
		const guarded = defineAgent('fullyGuarded', {
			instructions: 'Guard.', tools: [selected],
			guardrails: { [agentGuardrailsBinding]: {
				id: 'fullRequirements',
				requirements: {
					tools: ['selected'], models: [{ alias: 'guardModel', capabilities: ['text'] }],
					memory: ['memory.text_search'], sandbox: ['sandbox.fs', 'sandbox.readonly_mount'], skillRuntimes: ['node'],
					durable: true, workspace: true, artifacts: true,
				},
			} },
		})
		const requirements = defineHarness({ name: 'guardedHarness', revision: 'v1' }).addAgent(guarded).requirements
		expect(requirements.models.guardModel).toEqual({ capabilities: ['text'] })
		expect(requirements.memory.capabilities).toEqual(['memory.text_search'])
		expect(requirements.sandbox.capabilities).toEqual(['sandbox.fs', 'sandbox.readonly_mount', 'sandbox.workspace_binding'])
		expect(requirements.skillRuntimes).toEqual(['node'])
		expect(requirements.storage.durable).toBe(true)
		expect(requirements.workspace).toBe(true)
		expect(requirements.artifacts).toBe(true)
		expect(Object.isFrozen(requirements.storage)).toBe(true)
	})

	it.each([
		{ tools: [] },
		{ memory: ['memory.unknown'] },
		{ sandbox: ['storage.persistent'] },
		{ skillRuntimes: ['ruby'] },
		{ models: [{ alias: 'BadAlias', capabilities: ['text'] }] },
		{ models: [{ alias: 'guard', capabilities: ['text', 'text'] }] },
		{ durable: false },
		{ unknown: true },
	] as const)('rejects an invalid Guardrail requirement declaration %#', requirements => {
		expect(() => defineAgent('invalidGuardrail', {
			instructions: 'Guard.', guardrails: {
				[agentGuardrailsBinding]: { id: 'invalid', requirements } as never,
			},
	})).toThrow(HarnessConfigError)
	})

	it('derives approval durability and rejects false definition presence flags', () => {
		const bash = defineTool('bash', {
			description: 'Run.', input, output,
			async handler(_context, value) { return { answer: value.message } },
		})
		const approval = defineAgent('approval', {
			instructions: 'Ask.', tools: [bash], permissions: { bash: 'require_approval' },
		})
		const parent = defineAgent('parentApproval', { instructions: 'Delegate.', subagents: { child: approval } })
		const workflow = defineWorkflow('approvalRoot', { input: z.string(), output: z.string(), agents: { parent }, async handler() { return 'done' } })
		const compiled = compileDefinitionGraph({ workflows: [workflow] })
		expect(compiled.approval.agents.parentApproval).toEqual({ reachable: true, agentIds: ['approval'] })
		expect(compiled.approval.workflows.approvalRoot).toEqual({ reachable: true, agentIds: ['approval'] })
		expect(Object.isFrozen(compiled.approval.workflows.approvalRoot?.agentIds)).toBe(true)
		expect(defineHarness({ name: 'approvalHarness', revision: 'v1' }).addAgent(approval).requirements.storage.durable).toBe(true)
		expect(() => defineAgent('badFlagAgent', { instructions: 'Bad.', durable: false } as never)).toThrow(HarnessConfigError)
		expect(() => defineWorkflow('badFlagWorkflow', {
			input, output, workspace: false, async handler() { return { answer: 'bad' } },
		} as never)).toThrow(HarnessConfigError)
		expect(() => defineAgent('duplicateMemory', {
			instructions: 'Bad.', memory: { capabilities: ['memory.kv', 'memory.kv'] },
		})).toThrow(HarnessConfigError)
		expect(() => defineWorkflow('duplicateModelCapability', {
			input, output, models: { media: { alias: 'media', capabilities: ['image_generation', 'image_generation'] } },
			async handler() { return { answer: 'bad' } },
		})).toThrow(HarnessConfigError)
	})

	it('maps arrays by literal id and retains the exact original frozen definitions', () => {
		const value = fixture()
		const catalog = defineCatalog('bankingAi', {
			tools: [value.lookup], skills: [value.policy], mcpServers: [value.knowledge],
			agents: [value.helper], workflows: [value.resolve],
		})

		expect(catalog.tools.lookup).toBe(value.lookup)
		expect(catalog.skills['support-policy']).toBe(value.policy)
		expect(catalog.mcpServers.knowledge).toBe(value.knowledge)
		expect(catalog.agents.helper).toBe(value.helper)
		expect(catalog.workflows.resolve).toBe(value.resolve)
		expect(catalog.mcpServers.knowledge.tools.search).toBe(value.knowledge.tools.search)
		expect(catalog.tools).not.toHaveProperty('search')
		expect(catalog.contracts.agents.helper).toBe(value.helper.contract)
		expect(catalog.contracts.workflows.resolve).toBe(value.resolve.contract)
	})

	it('recursively collects agent and workflow dependencies and normalizes requirements', () => {
		const value = fixture()
		const catalog = defineCatalog('bankingAi', { workflows: [value.resolve] })

		expect(catalog.workflows.resolve).toBe(value.resolve)
		expect(catalog.agents).toEqual({})
		expect(catalog.tools).toEqual({})
		expect(catalog.skills).toEqual({})
		expect(catalog.mcpServers).toEqual({})
		expect(catalog.tools).not.toHaveProperty('search')
		expect(catalog.requirements).toEqual({
			models: {
				embeddings: { capabilities: ['embeddings'] },
				fast: { capabilities: ['text', 'text_stream'] },
				guard: { capabilities: ['text'] },
				image: { capabilities: ['image_generation'] },
				primary: { capabilities: ['object', 'object_stream', 'tool_use', 'vision_input'] },
			},
			mcpServers: ['knowledge'],
			skillRuntimes: ['python'],
			storage: { durable: true },
			memory: { capabilities: ['memory.kv', 'memory.vector_search'], modelAliases: ['embeddings'] },
			sandbox: { capabilities: ['sandbox.exec', 'sandbox.fs', 'sandbox.readonly_mount', 'sandbox.workspace_binding'], requiredGroups: [], required: true },
			workspace: true,
			artifacts: true,
			hostTools: [],
		})
		for (const value of Object.values(catalog.requirements.models)) expect(Object.isFrozen(value.capabilities)).toBe(true)
		expect(Object.keys(catalog.requirements.models)).toEqual(['embeddings', 'fast', 'guard', 'image', 'primary'])
		expect(Object.isFrozen(catalog.requirements.memory)).toBe(true)
		expect(Object.isFrozen(catalog.requirements.sandbox)).toBe(true)
	})

	it('deduplicates repeated references by hidden identity', () => {
		const value = fixture()
		const catalog = defineCatalog('deduplicated', {
			tools: [value.lookup, value.lookup], agents: [value.assistant, value.assistant],
		})
		expect(Object.keys(catalog.tools)).toEqual(['lookup'])
		expect(Object.keys(catalog.agents)).toEqual(['assistant'])
	})

	it('allows equal MCP local names on distinct owning servers and preserves both owners', () => {
		const first = defineMcpServer('first', { tools: { search: { remoteName: 'one', description: 'One.', input, output } } })
		const second = defineMcpServer('second', { tools: { search: { remoteName: 'two', description: 'Two.', input, output } } })
		const catalog = defineCatalog('servers', { mcpServers: [second, first] })

		expect(catalog.mcpServers.first.tools.search).toBe(first.tools.search)
		expect(catalog.mcpServers.second.tools.search).toBe(second.tools.search)
		expect(catalog.tools).not.toHaveProperty('search')
		expect(catalog.requirements.mcpServers).toEqual([])
	})

	it.each([
		['foreign_definition', () => defineCatalog('foreign', { agents: [{ kind: 'agent', id: 'fake' } as never] })],
		['foreign_definition', () => {
			const original = defineAgent('copied', { instructions: 'Original.' })
			return defineCatalog('copied', { agents: [{ ...original }] as never })
		}],
		['invalid_agent', () => {
			const guarded = defineAgent('guarded', {
				instructions: 'Guarded.',
				guardrails: { [agentGuardrailsBinding]: { id: 'requiresMissing', requirements: { tools: ['missing'] } } },
			})
			return defineCatalog('missingGuardrailTool', { agents: [guarded] })
		}],
		['duplicate_definition', () => defineCatalog('duplicate', { agents: [
			defineAgent('same', { instructions: 'One.' }), defineAgent('same', { instructions: 'Two.' }),
		] })],
		['duplicate_definition', () => {
			const portable = defineTool('sameTool', {
				description: 'Portable.', input, output, async handler(_context, value) { return { answer: value.message } },
			})
			const host = attachDefinitionIdentity({
				kind: 'tool' as const, id: 'sameTool', description: 'Host.', input, output,
				async handler(_context: unknown, value: { message: string }) { return { answer: value.message } },
			}, createDefinitionIdentity('host-tool', 'sameTool'))
			Object.freeze(host)
			return defineCatalog('toolKinds', { tools: [portable, host as never] })
		}],
		['model_name_collision', () => {
			const tool = defineTool('helper', { description: 'Tool.', input, output, async handler(_context, value) { return { answer: value.message } } })
			const helper = defineAgent('helperAgent', { instructions: 'Help.' })
			const parent = defineAgent('parent', { instructions: 'Parent.', tools: [tool], subagents: { helper } })
			return defineCatalog('collision', { agents: [parent] })
		}],
		['model_name_collision', () => {
			const first = defineMcpServer('firstCollision', { tools: { search: { remoteName: 'one', description: 'One.', input, output } } })
			const second = defineMcpServer('secondCollision', { tools: { search: { remoteName: 'two', description: 'Two.', input, output } } })
			const parent = defineAgent('mcpCollision', { instructions: 'Search.', tools: [first.tools.search, second.tools.search] })
			return defineCatalog('mcpCollision', { agents: [parent] })
		}],
	] as const)('fails graph validation with stable reason %s', (reason, create) => {
		expect(reasonOf(create)).toBe(reason)
	})

	it('reports an absent Guardrail tool under the agent requirements path', () => {
		const guarded = defineAgent('guarded', {
			instructions: 'Guarded.',
			guardrails: { [agentGuardrailsBinding]: { id: 'requiresMissing', requirements: { tools: ['missing'] } } },
		})
		expect(() => defineCatalog('missingGuardrailTool', { agents: [guarded] })).toThrow(expect.objectContaining({
			meta: {
				reason: 'invalid_agent',
				path: 'agent.guarded.guardrails.requirements.tools.missing',
				id: 'missing',
			},
		}))
	})

	it('detects forged cycles through only the package-private dependency-reader seam', () => {
		const first = attachDefinitionIdentity({ kind: 'agent', id: 'first' }, createDefinitionIdentity('agent', 'first'))
		const second = attachDefinitionIdentity({ kind: 'agent', id: 'second' }, createDefinitionIdentity('agent', 'second'))
		Object.freeze(first)
		Object.freeze(second)
		const reader: DefinitionDependencyReader = definition => ({
			dependencies: definition === first ? [second] : definition === second ? [first] : [],
			subagents: definition === first ? [second] : definition === second ? [first] : [],
		})

		expect(reasonOf(() => compileDefinitionGraph({ agents: [first as never] }, reader))).toBe('agent_cycle')
	})

	it('keeps catalog availability separate from an agent access list', () => {
		const visible = defineTool('visible', { description: 'Visible.', input, output, async handler(_context, value) { return { answer: value.message } } })
		const unavailable = defineTool('unavailable', { description: 'Unavailable.', input, output, async handler(_context, value) { return { answer: value.message } } })
		const agent = defineAgent('assistant', { instructions: 'Answer.', tools: [visible] })
		const catalog = defineCatalog('access', { tools: [unavailable], agents: [agent] })

		expect(catalog.tools.unavailable).toBe(unavailable)
		expect(agent.tools).toEqual([visible])
	})

	it('composes direct additions and catalogs through equivalent immutable compilation', () => {
		const value = fixture()
		const packaged = defineCatalog('bankingAi', { workflows: [value.resolve] })
		const base = defineHarness({ name: 'banking', revision: 'v1' })
		const viaCatalog = base.use(packaged)
		const direct = base.addWorkflow(value.resolve)

		expect(viaCatalog.requirements).toEqual(direct.requirements)
		expect(base.contracts.workflows).toEqual({})
		expect(Object.isFrozen(base)).toBe(true)
		expect(Object.isFrozen(viaCatalog)).toBe(true)
		expect(viaCatalog.contracts.workflows.resolve).toBe(value.resolve.contract)
	})

	it('executes direct and catalog-composed targets through the same exact frozen surface', async () => {
		const echo = defineWorkflow('runtimeParityEcho', { input, output,
			async handler({ input: value }) { return { answer: value.message } },
		})
		const catalog = defineCatalog('runtimeParityCatalog', { workflows: [echo] })
		const definitions = [
			defineHarness({ name: 'directRuntimeParity' }).addWorkflow(echo),
			defineHarness({ name: 'catalogRuntimeParity' }).use(catalog),
		]
		for (const definition of definitions) {
			const instance = await definition.getInstance({})
			const session = await instance.getSession('runtime-parity-session')
			expect(Object.keys(instance)).toEqual(['getSession', 'close'])
			expect(Object.keys(session)).toEqual(['id', 'agents', 'workflows', 'childTasks', 'memory', 'history', 'getRunSummary', 'clearHistory', 'replaceHistory', 'release', 'destroy'])
			expect(Object.isFrozen(instance)).toBe(true)
			expect(Object.isFrozen(session)).toBe(true)
			expect(Object.isFrozen(session.agents)).toBe(true)
			expect(Object.isFrozen(session.workflows)).toBe(true)
			expect(Object.isFrozen(session.workflows.runtimeParityEcho)).toBe(true)
			await expect(session.workflows.runtimeParityEcho.run({ message: 'same' })).resolves.toMatchObject({
				status: 'completed', output: { answer: 'same' },
			})
			await session.destroy()
			await instance.close()
		}
	})

	it('binds the public session memory facade to the active session id', async () => {
		const instance = await defineHarness({ name: 'sessionMemory' }).getInstance({})
		const session = await instance.getSession('session-memory-id')

		await expect(session.memory.write('preference', { language: 'en' })).resolves.toBeUndefined()
		await expect(session.memory.read('preference')).resolves.toEqual({ language: 'en' })

		await session.destroy()
		await instance.close()
	})

	it('requires a valid Harness name and accepts an empty Harness', () => {
		expect(() => defineHarness({} as never)).toThrow(HarnessConfigError)
		expect(() => defineHarness({ name: 'NotLowerCamel' })).toThrow(HarnessConfigError)
		expect(() => defineCatalog('invalid', null as never)).toThrow(HarnessConfigError)
		const harness = defineHarness({ name: 'empty' })
		expect(harness.contracts).toMatchObject({ agents: {}, workflows: {} })
		expect(harness.$infer).toEqual({})
		expect(Object.isFrozen(harness.$infer)).toBe(true)
	})

	it('assembles one immutable definition-keyed standalone runtime', async () => {
		const echo = defineWorkflow('echo', {
			input, output,
			async handler({ input: value }) { return { answer: value.message } },
		})
		const instance = await defineHarness({ name: 'standalone' }).addWorkflow(echo).getInstance({})
		const session = await instance.getSession('sessionA')

		expect(Object.isFrozen(instance)).toBe(true)
		expect(Object.isFrozen(session)).toBe(true)
		expect(Object.isFrozen(session.workflows)).toBe(true)
		expect(Object.keys(session.workflows)).toEqual(['echo'])
		await expect(session.workflows.echo.run({ message: 'hello' })).resolves.toEqual({
			status: 'completed', runId: expect.stringMatching(/^run_/), output: { answer: 'hello' },
		})

		const events = []
		for await (const event of session.workflows.echo.stream({ message: 'stream' })) events.push(event)
		expect(events.map(event => event.type)).toEqual(['run.started', 'run.finished'])
		expect(events.map(event => event.sequence)).toEqual([1, 2])
		expect(events.map(event => event.eventId)).toEqual(events.map(event => expect.stringMatching(/^event_/)))
		expect(events.every(event => !('parentRunId' in event) && !('parentInvocationId' in event))).toBe(true)
		expect(events.at(-1)).toMatchObject({ outcome: { status: 'completed', output: { answer: 'stream' } } })

		await session.destroy()
		await instance.close()
		await expect(instance.close()).resolves.toBeUndefined()
	})

	it('publishes only the stored session winner and opens sandbox compute lazily', async () => {
		const storage = persistentStorage()
		const backing = inMemorySandbox()
		const ownerModes: string[] = []
		let opens = 0
		const sandbox = {
			...backing,
			async registerOwner(request: Parameters<typeof backing.registerOwner>[0]) {
				ownerModes.push(request.mode)
				await backing.registerOwner(request)
			},
			async open(request: Parameters<typeof backing.open>[0]) {
				opens += 1
				return backing.open(request)
			},
		}
		const sandboxProbe = defineTool('sandboxProbe', { description: 'Require the session sandbox.', input, output,
			requires: { sandbox: ['sandbox.fs'] }, async handler(_context, value) { return { answer: value.message } },
		})
		const sandboxAgent = defineAgent('sandboxAgent', { input: z.string(), output: z.string(),
			instructions: 'Keep the sandbox available.', tools: [sandboxProbe], prompt: message => ({ role: 'user', content: message }),
		})
		const echo = defineWorkflow('lazyEcho', { input, output, agents: { sandboxAgent }, durable: true,
			async handler(context) { return { answer: await context.agents.sandboxAgent.run(context.input.message, { callId: 'sandbox-agent' }) } },
		})
		const definition = defineHarness({ name: 'lazySessionHarness', revision: 'v1' }).addWorkflow(echo)
		const model = new FakeModelProvider({ strict: true })
		model.enqueueText({ content: 'one', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		model.enqueueText({ content: 'two', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		const firstInstance = await definition.getInstance({ storage, sandbox, model: { provider: model, model: 'fake' } })
		const first = await firstInstance.getSession('shared-session')
		const secondFacade = await firstInstance.getSession('shared-session')
		expect(first).not.toBe(secondFacade)
		expect(opens).toBe(0)
		expect(ownerModes).toEqual(['create'])
		expect(await storage.getSession('shared-session')).toMatchObject({ runCount: 0, sandboxBinding: { registration: 'registered' } })

		await expect(first.workflows.lazyEcho.run({ message: 'one' })).resolves.toMatchObject({ status: 'completed' })
		expect(opens).toBe(1)
		expect(ownerModes).toEqual(['create'])
		expect(await storage.getSession('shared-session')).toMatchObject({ runCount: 1 })
		await first.release()

		const secondInstance = await definition.getInstance({ storage, sandbox, model: { provider: model, model: 'fake' } })
		const reopened = await secondInstance.getSession('shared-session')
		expect(ownerModes).toEqual(['create'])
		expect(opens).toBe(1)
		await expect(reopened.workflows.lazyEcho.run({ message: 'two' })).resolves.toMatchObject({ status: 'completed' })
		expect(opens).toBe(2)
		expect(ownerModes).toEqual(['create'])
		expect(await storage.getSession('shared-session')).toMatchObject({ runCount: 2 })
		await reopened.destroy()
		expect(await storage.getSession('shared-session')).toBeUndefined()
		await firstInstance.close()
		await secondInstance.close()
	})

	it('cancels and waits for live roots before closing session resources', async () => {
		let entered!: () => void
		const started = new Promise<void>(resolve => { entered = resolve })
		let finishCleanup!: () => void
		const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
		const workflow = defineWorkflow('closingWorkflow', { input, output,
			async handler({ signal }) {
				entered()
				await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
				await cleanup
				throw new OperationCancelledError('Run was cancelled.', { scope: 'run' })
			},
		})
		const instance = await defineHarness({ name: 'closingHarness' }).addWorkflow(workflow).getInstance({})
		const session = await instance.getSession('closing-session')
		const running = session.workflows.closingWorkflow.run({ message: 'wait' })
		await started
		let closed = false
		const closing = instance.close().then(() => { closed = true })
		await Promise.resolve()
		expect(closed).toBe(false)
		finishCleanup()
		await expect(running).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
		await expect(closing).resolves.toBeUndefined()
		expect(closed).toBe(true)
	})

	it('applies the validated telemetry content policy to configured adapters', async () => {
		let configured: HarnessAdapterContext | undefined
		const storage = persistentStorage()
		const configureStorage = storage.configureHarnessContext.bind(storage)
		storage.configureHarnessContext = (context: HarnessAdapterContext) => { configureStorage(context); configured = context }
		const echo = defineWorkflow('echo', { input, output, durable: true,
			async handler({ input: value }) { return { answer: value.message } },
		})
		const instance = await defineHarness({ name: 'telemetryConfig', revision: 'v1' }).addWorkflow(echo)
			.getInstance({ storage, telemetry: { contentCaptureMode: 'EVENT_ONLY', flavor: 'gen_ai_only' } })

		expect(configured?.contentCaptureMode).toBe('EVENT_ONLY')
		await instance.close()
	})

	it('locks one session for the full root execution and retains canonical wire input', async () => {
		let release!: () => void
		const gate = new Promise<void>(resolve => { release = resolve })
		const transformed = defineWorkflow('transformed', {
			input: z.string().transform(value => value.length), output: z.number(),
			async handler({ input: value }) { await gate; return value },
		})
		const instance = await defineHarness({ name: 'locked' }).addWorkflow(transformed).getInstance({})
		const session = await instance.getSession('serial')
		const first = session.workflows.transformed.run('hello')

		expect(() => session.workflows.transformed.stream('second')).toThrowError(expect.objectContaining({ code: 'SESSION_BUSY' }))
		expect(() => session.clearHistory()).toThrowError(expect.objectContaining({ code: 'SESSION_BUSY' }))
		release()
		await expect(first).resolves.toMatchObject({ status: 'completed', output: 5 })
		await session.destroy()
		await instance.close()
	})

	it('lease-backs durable workflow roots and finalizes their event atomically', async () => {
		const storage = persistentStorage()
		const durable = defineWorkflow('durableEcho', {
			input, output, durable: true,
			async handler({ input: value }) { return { answer: value.message } },
		})
		const instance = await defineHarness({ name: 'durableStandalone', revision: 'release-1' })
			.addWorkflow(durable).getInstance({ storage })
		const session = await instance.getSession('durableSession')
		const invocation = { durable: { runId: 'durable-run-1' } } as const

		await expect(session.workflows.durableEcho.run({ message: 'first' }, invocation)).resolves.toEqual({
			status: 'completed', runId: 'durable-run-1', output: { answer: 'first' },
		})
		expect(await storage.getRun('durable-run-1')).toMatchObject({ status: 'succeeded', revision: 3, input: { message: 'first' } })
		expect((await storage.listEvents('durable-run-1')).map(event => event.sequence)).toEqual([1, 2])
		await expect(session.workflows.durableEcho.run({ message: 'changed' }, invocation)).rejects.toMatchObject({
			code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' },
		})

		await session.destroy()
		await instance.close()
	})

	it('fences an approval-capable root before effects and persists its interruption', async () => {
		const storage = persistentStorage()
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'call-1', name: 'bash', arguments: '€10' }],
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		let executions = 0
		const transfer = defineTool('bash', { description: 'Transfer funds.', input: z.string(), output: z.string(),
			async handler(_context, value) { executions += 1; return value } })
		const agent = defineAgent('reviewTransfer', {
			input: z.string(), output: z.string(), instructions: 'Use the transfer tool.', tools: [transfer],
			permissions: { bash: 'require_approval' }, prompt: value => ({ role: 'user', content: value }),
		})
		const instance = await defineHarness({ name: 'approvalStandalone', revision: 'release-1' }).addAgent(agent)
			.getInstance({ model: { provider, model: 'fake' }, storage })
		const session = await instance.getSession('approvalSession')

		const outcome = await session.agents.reviewTransfer.run('send')
		expect(outcome).toMatchObject({ status: 'interrupted', interrupt: { type: 'tool-approval', requests: [expect.objectContaining({ toolId: 'bash' })] } })
		expect(executions).toBe(0)
		expect(await storage.getRun(outcome.runId)).toMatchObject({ status: 'interrupted', input: 'send' })
		expect(await storage.loadCheckpoint(outcome.runId, 'harness:interrupt:v1')).toMatchObject({
			output: { schemaVersion: 1, rootTarget: { kind: 'agent', id: 'reviewTransfer' }, nextEventSequence: expect.any(Number) },
		})

		await session.destroy()
		await instance.close()
	})

	it('resumes an approved prepared tool once without repeating model preflight', async () => {
		const storage = persistentStorage()
		const lifecycle: string[] = []
		const replaceCheckpoint = storage.replaceCheckpoint.bind(storage)
		storage.replaceCheckpoint = async request => {
			const output = request.replacement.output as Record<string, unknown>
			const continuation = output['continuation'] as { frame?: { state?: { phase?: string } } } | undefined
			if (output['kind'] === 'harness_post_approval') lifecycle.push(`checkpoint:${continuation?.frame?.state?.phase ?? 'prepared'}`)
			return replaceCheckpoint(request)
		}
		const appendEvents = storage.appendEvents.bind(storage)
		storage.appendEvents = async (runId, events) => {
			if (events.some(event => event.type === 'model.completed')) lifecycle.push('event:model.completed')
			return appendEvents(runId, events)
		}
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'call-1', name: 'bash', arguments: '€10' }],
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'transferred', toolCalls: [],
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		let executions = 0
		let rootParses = 0
		let toolParses = 0
		const rootInput = z.string().transform(value => { rootParses += 1; return value })
		const toolInput = z.string().transform(value => { toolParses += 1; return value })
		const transfer = defineTool('bash', { description: 'Transfer funds.', input: toolInput, output: z.string(),
			async handler(_context, value) { executions += 1; return value } })
		const agent = defineAgent('reviewTransfer', {
			input: rootInput, output: z.string(), instructions: 'Use the transfer tool.', tools: [transfer],
			permissions: { bash: 'require_approval' }, prompt: value => ({ role: 'user', content: value }),
			guardrails: { [agentGuardrailsBinding]: { id: 'resumeOrder', afterModel() { lifecycle.push('hook:afterModel'); return { decision: 'allow' } } } } as never,
		})
		const instance = await defineHarness({ name: 'approvalResume', revision: 'release-1' }).addAgent(agent)
			.getInstance({ model: { provider, model: 'fake' }, storage })
		const session = await instance.getSession('approvalResumeSession')
		const interrupted = await session.agents.reviewTransfer.run('send')
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('expected approval interruption')
		const request = interrupted.interrupt.requests[0]!
		lifecycle.length = 0

		const resume = {
			type: 'tool-approval', runId: interrupted.runId, interruptId: interrupted.interrupt.id,
			revision: interrupted.interrupt.revision, eventId: 'resume-event-1',
			decisions: [{ approvalId: request.approvalId, approved: true }],
		} as const
		await expect(session.agents.reviewTransfer.run('send', { resume })).resolves.toEqual({ status: 'completed', runId: interrupted.runId, output: 'transferred' })
		expect(lifecycle).toEqual(['checkpoint:after_model', 'event:model.completed', 'hook:afterModel', 'checkpoint:continue_turn'])
		expect(executions).toBe(1)
		expect(rootParses).toBe(1)
		expect(toolParses).toBe(1)
		expect(await storage.getRun(interrupted.runId)).toMatchObject({ status: 'succeeded', approvalReceipt: {
			interruptId: interrupted.interrupt.id, resumeEventId: 'resume-event-1', decisions: [{ approvalId: request.approvalId, approved: true }],
		} })
		await expect(session.agents.reviewTransfer.run('send', { resume })).resolves.toEqual({ status: 'completed', runId: interrupted.runId, output: 'transferred' })
		await expect(session.agents.reviewTransfer.run('send', { resume: { ...resume,
			decisions: [{ approvalId: request.approvalId, approved: false }],
		} })).rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'event_conflict' } })
		await expect(session.agents.reviewTransfer.run('send', { resume: { ...resume, eventId: 'resume-event-2' } }))
			.rejects.toMatchObject({ code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'stale_continuation' } })
		expect(executions).toBe(1)

		await session.destroy()
		await instance.close()
	})

	it('rejects a forged post-approval cursor that no longer owns its decision set', async () => {
		const storage = persistentStorage()
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'cursor-call', name: 'bash', arguments: 'input' }],
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		let afterModel = 0
		const effect = defineTool('bash', { description: 'Effect.', input: z.string(), output: z.string(), async handler() { return 'unused' } })
		const agent = defineAgent('cursorRestart', { instructions: 'Use effect.', input: z.string(), output: z.string(), tools: [effect], prompt: value => ({ role: 'user', content: value }),
			permissions: { bash: 'require_approval' },
			guardrails: { [agentGuardrailsBinding]: { id: 'cursorRestartGuard', afterModel() { afterModel += 1; return { decision: 'allow' } } } } as never })
		const instance = await defineHarness({ name: 'cursorRestartHarness', revision: 'release-1' }).addAgent(agent)
			.getInstance({ model: { provider, model: 'fake' }, storage })
		const session = await instance.getSession('cursorRestartSession')
		const interrupted = await session.agents.cursorRestart.run('start')
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('expected interruption')
		const checkpoint = await storage.loadCheckpoint(interrupted.runId, 'harness:interrupt:v1')
		const run = await storage.getRun(interrupted.runId)
		if (!checkpoint || !run) throw new Error('expected durable interruption state')
		const pending = checkpoint.output as any
		const request = interrupted.interrupt.requests[0]!
		const decisions = [{ approvalId: request.approvalId, approved: true }] as const
		const workerId = 'crash-worker'
		const acquisitionId = `acq_${createHash('sha256').update(canonicalJson(['harness-run-acquisition-v1', 'resume', run.id,
			run.sessionId, workerId, run.revision, 'interrupted', checkpoint.stepId, checkpoint.sequence, null])).digest('hex')}`
		const lease = await storage.acquireRun({ mode: 'resume', runId: run.id, sessionId: run.sessionId, workerId,
			acquisitionId, expected: { revision: run.revision, status: 'interrupted', checkpoint: { stepId: checkpoint.stepId, sequence: checkpoint.sequence } } })
		const previous = pending.continuation.frame.state
		const cursor = { schemaVersion: 1, kind: 'accepted_model_turn', phase: 'after_model', rootRunId: run.id, agentRunId: run.id,
			 sessionId: run.sessionId, agentId: agent.id, invocationId: run.id,
			step: previous.step + 1, modelAlias: 'primary', input: previous.input, mode: 'run', operation: 'object',
			request: { messages: previous.messages, tools: [], schema: {} },
			response: { object: 'from durable cursor', toolCalls: [], usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, finishReason: 'stop' },
			agentStarted: true }
		const post = { schemaVersion: 1, kind: 'harness_post_approval', rootRunId: run.id, sessionId: run.sessionId,
			interruptId: interrupted.interrupt.id, resumeEventId: 'cursor-resume-event', decisions,
			deploymentRevision: pending.deploymentRevision, compiledGraphDigest: pending.compiledGraphDigest,
			sessionIdentityDigest: pending.sessionIdentityDigest,
			continuation: { frame: { ...pending.continuation.frame, state: cursor }, children: [] },
			nextEventSequence: pending.nextEventSequence, startedAgentRunIds: pending.startedAgentRunIds }
		await storage.replaceCheckpoint({ runId: run.id, sessionId: run.sessionId, stepId: checkpoint.stepId,
			expectedSequence: checkpoint.sequence, leaseId: lease.leaseId, workerId: lease.workerId,
			replacement: { ...checkpoint, leaseId: lease.leaseId, workerId: lease.workerId, attempt: lease.attempt,
				sequence: checkpoint.sequence + 1, output: post } })
		const acceptedEventId = `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', run.id,
			pending.nextEventSequence, 'model.completed'])).digest('hex')}`
		await storage.appendEvents(run.id, [{ id: acceptedEventId, runId: run.id, sequence: pending.nextEventSequence,
			at: '2026-09-05T00:00:00.000Z', type: 'model.completed', payload: {
				agentId: agent.id, modelAlias: 'primary', operation: 'object', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, finishReason: 'stop' } }])
		await lease.release()
		const resume = { type: 'tool-approval', runId: run.id, interruptId: interrupted.interrupt.id,
			revision: interrupted.interrupt.revision, eventId: 'cursor-resume-event', decisions } as const

		await expect(session.agents.cursorRestart.run('start', { resume })).rejects.toMatchObject({
			code: 'APPROVAL_RESUME_ERROR', meta: { reason: 'invalid_checkpoint' },
		})
		expect(provider.requests).toHaveLength(1)
		expect(afterModel).toBe(1)
		expect((await storage.listEvents(run.id)).filter(event => event.type === 'model.completed')).toHaveLength(2)
		expect(await storage.loadCheckpoint(run.id, 'harness:interrupt:v1')).toBeDefined()
		await session.destroy()
		await instance.close()
	})

	it('replays only the immediately prior approval receipt as the current interruption', async () => {
		const storage = persistentStorage()
		const provider = new FakeModelProvider({ strict: true })
		for (const [id, argument] of [['first-call', 'first'], ['second-call', 'second']] as const) provider.enqueueText({ content: '',
			toolCalls: [{ id, name: 'bash', arguments: argument }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		let effects = 0
		const effect = defineTool('bash', { description: 'Effect.', input: z.string(), output: z.string(), async handler(_context, value) { effects += 1; return value } })
		const agent = defineAgent('receiptReplay', { instructions: 'Use effects.', tools: [effect], permissions: { bash: 'require_approval' } })
		const instance = await defineHarness({ name: 'receiptReplayHarness', revision: 'release-1' }).addAgent(agent)
			.getInstance({ model: { provider, model: 'fake' }, storage })
		const session = await instance.getSession('receiptReplaySession')
		const first = await session.agents.receiptReplay.run('start')
		if (first.status !== 'interrupted' || first.interrupt.type !== 'tool-approval') throw new Error('expected first interruption')
		const firstResume = { type: 'tool-approval', runId: first.runId, interruptId: first.interrupt.id, revision: first.interrupt.revision,
			eventId: 'first-resume-event', decisions: [{ approvalId: first.interrupt.requests[0]!.approvalId, approved: true }] } as const
		const second = await session.agents.receiptReplay.run('start', { resume: firstResume })
		if (second.status !== 'interrupted' || second.interrupt.type !== 'tool-approval') throw new Error('expected second interruption')
		const beforeReplayEvents = await storage.listEvents(first.runId)
		await expect(session.agents.receiptReplay.run('start', { resume: firstResume })).resolves.toEqual(second)
		expect(provider.requests).toHaveLength(2)
		expect(effects).toBe(1)
		expect(await storage.listEvents(first.runId)).toEqual(beforeReplayEvents)
		const secondResume = { type: 'tool-approval', runId: second.runId, interruptId: second.interrupt.id, revision: second.interrupt.revision,
			eventId: 'second-resume-event', decisions: [{ approvalId: second.interrupt.requests[0]!.approvalId, approved: true }] } as const
		await expect(session.agents.receiptReplay.run('start', { resume: secondResume })).resolves.toMatchObject({ status: 'completed', output: 'done' })
		expect(effects).toBe(2)
		await session.destroy()
		await instance.close()
	})

	it('resumes an interrupted subagent leaf before completing its parent tool', async () => {
		const storage = persistentStorage()
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'delegate-1', name: 'reviewer', arguments: 'child input' }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'effect-1', name: 'bash', arguments: 'approved input' }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'child done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		provider.enqueueText({ content: 'parent done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		let effects = 0
		const effect = defineTool('bash', { description: 'Approved effect.', input: z.string(), output: z.string(),
			async handler(_context, value) { effects += 1; return value } })
		const child = defineAgent('childReviewer', { instructions: 'Review.', tools: [effect], permissions: { bash: 'require_approval' } })
		const parent = defineAgent('parentReviewer', { instructions: 'Delegate.', subagents: { reviewer: child } })
		const instance = await defineHarness({ name: 'nestedResume', revision: 'release-1' }).addAgent(parent)
			.getInstance({ model: { provider, model: 'fake' }, storage })
		const session = await instance.getSession('nestedSession')
		const interrupted = await session.agents.parentReviewer.run('start')
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('expected interruption')
		const request = interrupted.interrupt.requests[0]!
		const outcome = await session.agents.parentReviewer.run('start', { resume: { type: 'tool-approval', runId: interrupted.runId,
			interruptId: interrupted.interrupt.id, revision: interrupted.interrupt.revision, eventId: 'nested-resume-event',
			decisions: [{ approvalId: request.approvalId, approved: true }] } })

		expect(outcome).toMatchObject({ status: 'completed', output: 'parent done' })
		expect(effects).toBe(1)
		await session.destroy()
		await instance.close()
	})

	it('re-enters a durable workflow through its saved agent call and restores the cumulative call budget', async () => {
		const storage = persistentStorage()
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: '', toolCalls: [{ id: 'effect-call', name: 'bash', arguments: 'approved input' }],
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
		provider.enqueueText({ content: 'child done', toolCalls: [],
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		let effects = 0
		let handlerEntries = 0
		let inputParses = 0
		const effect = defineTool('bash', { description: 'Approved effect.', input: z.string(), output: z.string(),
			async handler(_context, value) { effects += 1; return value } })
		const reviewer = defineAgent('workflowReviewer', { input: z.string(), output: z.string(), instructions: 'Review.',
			tools: [effect], permissions: { bash: 'require_approval' }, prompt: value => ({ role: 'user', content: value }) })
		const workflow = defineWorkflow('approvalWorkflow', {
			input: z.string().transform(value => { inputParses += 1; return value }), output: z.string(), durable: true,
			agents: { reviewer }, agentCalls: { maxCalls: 1, maxParallel: 1 },
			async handler({ agents }) {
				handlerEntries += 1
				const result = await agents.reviewer.run('review', { callId: 'review-call' })
				let budgetRestored = false
				try { await agents.reviewer.run('must-not-dispatch', { callId: 'second-call' }) }
				catch (error) { budgetRestored = error !== null && typeof error === 'object' && 'code' in error && error.code === 'WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED' }
				return `${result}:${budgetRestored ? 'budget-restored' : 'budget-reset'}`
			},
		})
		const instance = await defineHarness({ name: 'workflowApprovalResume', revision: 'release-1' }).addWorkflow(workflow)
			.getInstance({ model: { provider, model: 'fake' }, storage })
		const session = await instance.getSession('workflowApprovalSession')
		const durable = { durable: { runId: 'workflow-approval-run' } } as const
		const interrupted = await session.workflows.approvalWorkflow.run('start', durable)
		if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('expected workflow interruption')
		const request = interrupted.interrupt.requests[0]!
		const resumed = await session.workflows.approvalWorkflow.run('start', { ...durable, resume: {
			type: 'tool-approval', runId: interrupted.runId, interruptId: interrupted.interrupt.id,
			revision: interrupted.interrupt.revision, eventId: 'workflow-resume-event',
			decisions: [{ approvalId: request.approvalId, approved: true }],
		} })

		expect(resumed).toEqual({ status: 'completed', runId: interrupted.runId, output: 'child done:budget-restored' })
		expect(handlerEntries).toBe(2)
		expect(effects).toBe(1)
		expect(inputParses).toBe(1)
		expect(provider.requests).toHaveLength(2)
		expect(await storage.getRun(interrupted.runId)).toMatchObject({ status: 'succeeded', output: 'child done:budget-restored' })
		await session.destroy()
		await instance.close()
	})

	it('keeps an explicitly selected root stream mode while nested targets default to aggregate execution', async () => {
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueTextStream([
			{ kind: 'delta', text: 'streamed' },
			{ kind: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' },
		])
		const agent = defineAgent('streamRoot', { instructions: 'Stream.' })
		const instance = await defineHarness({ name: 'streamRootHarness' }).addAgent(agent)
			.getInstance({ model: { provider, model: 'fake' } })
		const session = await instance.getSession('streamRootSession')
		const events = []
		for await (const event of session.agents.streamRoot.stream('start')) events.push(event)
		expect(events.some(event => event.type === 'output.text.delta' && event.delta === 'streamed')).toBe(true)
		expect(events.at(-1)).toMatchObject({ type: 'run.finished', outcome: { status: 'completed', output: 'streamed' } })
		await session.destroy()
		await instance.close()
	})

	it('returns a frozen sanitized inspection without executable or prompt material', () => {
		const value = fixture()
		const inspection = defineHarness({ name: 'banking', revision: 'v1' }).addWorkflow(value.resolve).inspect()
		const serialized = JSON.stringify(inspection)

		expect(inspection.dependencies).toEqual({
			tools: ['lookup'], skills: ['support-policy'], mcpServers: ['knowledge'],
			agents: ['assistant', 'helper'], workflows: [],
		})
		expect(inspection.roots.agents).toEqual([])
		expect(inspection.roots.workflows.map(target => target.id)).toEqual(['resolve'])
		expect(inspection.roots.workflows[0]?.interrupts).toEqual([])
		expect(serialized).not.toContain('Answer.')
		expect(serialized).not.toContain('support-policy/')
		expect(serialized).not.toContain('handler')
		expect(serialized).not.toContain('prompt')
		expect(Object.isFrozen(inspection)).toBe(true)
		expect(Object.isFrozen(inspection.roots.agents)).toBe(true)
	})
})

function persistentStorage(): InMemoryHarnessStorage {
	const storage = new InMemoryHarnessStorage()
	const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
	Object.defineProperty(storage, 'capabilities', { value: capabilities })
	Object.defineProperty(storage, 'info', { value: Object.freeze({ ...storage.info, capabilities }) })
	return storage
}
