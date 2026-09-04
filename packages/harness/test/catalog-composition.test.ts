import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { HarnessConfigError } from '../src/errors/index.js'
import { agentGuardrailsBinding } from '../src/harness/defineHarness.js'
import { defineAgent } from '../src/definitions/agent.js'
import { defineCatalog } from '../src/definitions/catalog.js'
import { defineHarness } from '../src/definitions/harness.js'
import { attachDefinitionIdentity, createDefinitionIdentity, hasDefinitionIdentity } from '../src/definitions/identity.js'
import { defineMcpServer } from '../src/definitions/mcp-server.js'
import { defineSkill } from '../src/definitions/skill.js'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { compileDefinitionGraph, type DefinitionDependencyReader } from '../src/runtime/compiled-graph.js'

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
		expect(harness.use(catalog).catalog.requirements).toEqual(catalog.requirements)
	})

	it('retains catalog identity provenance across immutable Harness composition', () => {
		const first = defineCatalog('sharedCatalog', {})
		const conflicting = defineCatalog('sharedCatalog', {})
		const harness = defineHarness({ name: 'catalogConsumer' }).use(first)

		expect(() => harness.use(first)).not.toThrow()
		expect(reasonOf(() => harness.use(conflicting))).toBe('duplicate_definition')
		expect(() => harness.use(conflicting)).toThrow(HarnessConfigError)
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
					memory: ['memory.text_search'], sandbox: ['sandbox.fs'], skillRuntimes: ['node'],
					durable: true, workspace: true, artifacts: true,
				},
			} },
		})
		const requirements = defineHarness({ name: 'guardedHarness' }).addAgent(guarded).requirements
		expect(requirements.models.guardModel).toEqual({ capabilities: ['text'] })
		expect(requirements.memory.capabilities).toEqual(['memory.text_search'])
		expect(requirements.sandbox.capabilities).toEqual(['sandbox.fs'])
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
		expect(defineHarness({ name: 'approvalHarness' }).addAgent(approval).requirements.storage.durable).toBe(true)
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
		expect(catalog.agents.assistant).toBe(value.assistant)
		expect(catalog.agents.helper).toBe(value.helper)
		expect(catalog.tools.lookup).toBe(value.lookup)
		expect(catalog.skills['support-policy']).toBe(value.policy)
		expect(catalog.mcpServers.knowledge).toBe(value.knowledge)
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
			sandbox: { capabilities: ['sandbox.exec'] },
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
		expect(Object.keys(catalog.agents)).toEqual(['assistant', 'helper'])
	})

	it('allows equal MCP local names on distinct owning servers and preserves both owners', () => {
		const first = defineMcpServer('first', { tools: { search: { remoteName: 'one', description: 'One.', input, output } } })
		const second = defineMcpServer('second', { tools: { search: { remoteName: 'two', description: 'Two.', input, output } } })
		const catalog = defineCatalog('servers', { mcpServers: [second, first] })

		expect(catalog.mcpServers.first.tools.search).toBe(first.tools.search)
		expect(catalog.mcpServers.second.tools.search).toBe(second.tools.search)
		expect(catalog.tools).not.toHaveProperty('search')
		expect(catalog.requirements.mcpServers).toEqual(['first', 'second'])
	})

	it.each([
		['foreign_definition', () => defineCatalog('foreign', { agents: [{ kind: 'agent', id: 'fake' } as never] })],
		['foreign_definition', () => {
			const original = defineAgent('copied', { instructions: 'Original.' })
			return defineCatalog('copied', { agents: [{ ...original }] as never })
		}],
		['foreign_definition', () => {
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
		const base = defineHarness({ name: 'banking' })
		const viaCatalog = base.use(packaged)
		const direct = base.addWorkflow(value.resolve)

		expect(viaCatalog.catalog).toEqual(direct.catalog)
		expect(viaCatalog.requirements).toEqual(direct.requirements)
		expect(base.catalog.workflows).toEqual({})
		expect(Object.isFrozen(base)).toBe(true)
		expect(Object.isFrozen(viaCatalog)).toBe(true)
		expect(viaCatalog.contracts.workflows.resolve).toBe(value.resolve.contract)
	})

	it('requires a valid Harness name and accepts an empty Harness', () => {
		expect(() => defineHarness({} as never)).toThrow(HarnessConfigError)
		expect(() => defineHarness({ name: 'NotLowerCamel' })).toThrow(HarnessConfigError)
		expect(() => defineCatalog('invalid', null as never)).toThrow(HarnessConfigError)
		const harness = defineHarness({ name: 'empty' })
		expect(harness.catalog).toMatchObject({ tools: {}, agents: {}, workflows: {} })
		expect(harness.$infer).toEqual({})
		expect(Object.isFrozen(harness.$infer)).toBe(true)
	})

	it('returns a frozen sanitized inspection without executable or prompt material', () => {
		const value = fixture()
		const inspection = defineHarness({ name: 'banking' }).addWorkflow(value.resolve).inspect()
		const serialized = JSON.stringify(inspection)

		expect(inspection.definitions).toEqual({
			tools: ['lookup'], skills: ['support-policy'], mcpServers: ['knowledge'],
			agents: ['assistant', 'helper'], workflows: ['resolve'],
		})
		expect(inspection.targets.agents.map(target => target.id)).toEqual(['assistant', 'helper'])
		expect(inspection.targets.workflows.map(target => target.id)).toEqual(['resolve'])
		expect(inspection.targets.workflows[0]?.interrupts).toEqual(['external-wait', 'tool-approval'])
		expect(serialized).not.toContain('Answer.')
		expect(serialized).not.toContain('support-policy/')
		expect(serialized).not.toContain('handler')
		expect(serialized).not.toContain('prompt')
		expect(Object.isFrozen(inspection)).toBe(true)
		expect(Object.isFrozen(inspection.targets.agents)).toBe(true)
	})
})
