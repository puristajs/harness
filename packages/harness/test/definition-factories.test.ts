import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { HarnessConfigError } from '../src/errors/index.js'
import { agentGuardrailsBinding } from '../src/harness/defineHarness.js'
import {
	defineAgent,
	defineMcpServer,
	defineSkill,
	defineTool,
	defineWorkflow,
} from '../src/definitions/index.js'
import { getDefinitionIdentity, hasDefinitionIdentity, sameDefinitionIdentity } from '../src/definitions/identity.js'

const inputSchema = z.object({ message: z.string() })
const outputSchema = z.object({ answer: z.string() })

describe('composable definition factories', () => {
	it.each([
		['tool', () => defineTool('NotLowerCamel', { description: 'test', input: inputSchema, output: outputSchema, async handler(_context, input) { return { answer: input.message } } })],
		['MCP server', () => defineMcpServer('with-hyphen', { tools: { lookup: { remoteName: 'lookup', description: 'test', input: inputSchema, output: outputSchema } } })],
		['agent', () => defineAgent('_agent', { instructions: 'test' })],
		['workflow', () => defineWorkflow('workflow.dot', { input: inputSchema, output: outputSchema, async handler({ input }) { return { answer: input.message } } })],
	])('rejects an invalid %s id synchronously', (_name, create) => {
		expect(create).toThrow(HarnessConfigError)
	})

	it.each(['Uppercase', 'with_underscore', '-leading', 'trailing-', 'double--hyphen', 'a'.repeat(65)])(
		'rejects the invalid Skill id %s',
		id => expect(() => defineSkill(id, { directory: new URL('./fixture/', import.meta.url) })).toThrow(HarnessConfigError),
	)

	it('creates frozen values with private, reference-stable identities', () => {
		const first = defineAgent('assistant', { instructions: 'Help.' })
		const second = defineAgent('assistant', { instructions: 'Help.' })

		expect(Object.isFrozen(first)).toBe(true)
		expect(Object.isFrozen(first.contract)).toBe(true)
		expect(hasDefinitionIdentity(first)).toBe(true)
		expect(sameDefinitionIdentity(first, first)).toBe(true)
		expect(sameDefinitionIdentity(first, second)).toBe(false)
		expect(sameDefinitionIdentity(first, first.contract)).toBe(true)
		expect(hasDefinitionIdentity({ ...first })).toBe(false)
	})

	it('brands every leaf definition without exposing identity through an object copy', () => {
		const tool = defineTool('lookup', {
			description: 'Look up a message.', input: inputSchema, output: outputSchema,
			async handler(_context, input) { return { answer: input.message } },
		})
		const skill = defineSkill('support-policy', { directory: new URL('./support-policy/', import.meta.url) })
		const mcp = defineMcpServer('knowledge', {
			tools: { search: { remoteName: 'search', description: 'Search.', input: inputSchema, output: outputSchema } },
		})
		const workflow = defineWorkflow('resolveCase', {
			input: inputSchema, output: outputSchema,
			async handler({ input }) { return { answer: input.message } },
		})

		for (const definition of [tool, skill, mcp, mcp.tools.search, workflow]) {
			expect(hasDefinitionIdentity(definition)).toBe(true)
			expect(hasDefinitionIdentity({ ...definition })).toBe(false)
		}
		expect(sameDefinitionIdentity(workflow, workflow.contract)).toBe(true)
	})

	it('uses the minimal text-agent contract defaults', async () => {
		const agent = defineAgent('assistant', { instructions: 'Answer concisely.' })

		expect(agent.kind).toBe('agent')
		expect(agent.id).toBe('assistant')
		expect(agent.model).toBe('primary')
		expect(await agent.input['~standard'].validate('hello')).toEqual({ value: 'hello' })
		expect(await agent.output['~standard'].validate('hello')).toEqual({ value: 'hello' })
		expect(agent.contract).toMatchObject({
			kind: 'agent', id: 'assistant', executionModes: ['run', 'stream'],
			updates: 'text-delta', interrupts: ['tool-approval'],
		})
	})

	it('derives structured mode from any explicit output schema and retains schema identity', () => {
		const explicitStringOutput = z.string()
		const agent = defineAgent('classify', {
			input: inputSchema,
			output: explicitStringOutput,
			instructions: 'Classify.',
			prompt: input => ({ role: 'user', content: input.message }),
		})

		expect(agent.input).toBe(inputSchema)
		expect(agent.output).toBe(explicitStringOutput)
		expect(agent.contract.output).toBe(explicitStringOutput)
		expect(agent.contract.updates).toBe('object-snapshot')
	})

	it('validates prompt messages before they can reach a provider', () => {
		const safe = defineAgent('classify', {
			input: inputSchema,
			instructions: 'Classify.',
			prompt: input => ({ role: 'user', content: input.message }),
		})
		expect(() => safe.prompt({ message: 'hello' })).not.toThrow()

		const unsafe = defineAgent('unsafeAtRuntime', {
			input: inputSchema,
			instructions: 'Classify.',
			prompt: (() => ({ role: 'assistant', content: 'unsafe' })) as never,
		})
		expect(() => unsafe.prompt({ message: 'hello' })).toThrow()
	})

	it.each([
		{ role: 'user', content: [{ kind: 'text' }] },
		{ role: 'user', content: [{ kind: 'image', mimeType: 'image/png' }] },
		{ role: 'user', content: [{ kind: 'image_url', url: 42 }] },
		{ role: 'user', content: [{ kind: 'audio', mimeType: 'audio/wav', dataBase64: 'AA==', extra: true }] },
		{ role: 'user', content: [{ kind: 'file', mimeType: 'text/plain', dataBase64: 42 }] },
		{ role: 'user', content: [{ kind: 'file_url', url: 'https://example.com/a.txt', filename: 42 }] },
		{ role: 'user', content: 'hello', extra: true },
	])('rejects an invalid prompt payload before provider use %#', message => {
		const agent = defineAgent('invalidPromptPayload', {
			input: inputSchema,
			instructions: 'Read the content.',
			inputCapabilities: ['vision_input', 'audio_input', 'file_input'],
			prompt: (() => message) as never,
		})
		expect(() => agent.prompt({ message: 'hello' })).toThrow(HarnessConfigError)
	})

	it('freezes explicit agent collections and loop settings', () => {
		const tool = defineTool('lookup', {
			description: 'Look up a message.', input: inputSchema, output: outputSchema,
			async handler(_context, input) { return { answer: input.message } },
		})
		const skill = defineSkill('support-policy', { directory: new URL('./support-policy/', import.meta.url) })
		const helper = defineAgent('helper', { instructions: 'Help.' })
		const agent = defineAgent('assistant', {
			instructions: 'Answer.', tools: [tool], skills: [skill], subagents: { helper },
			loop: { maxSteps: 8, maxToolCalls: 12, maxSubagentCalls: 3, maxParallelSubagents: 1, maxDepth: 1 },
		})

		expect(Object.isFrozen(agent.tools)).toBe(true)
		expect(Object.isFrozen(agent.skills)).toBe(true)
		expect(Object.isFrozen(agent.subagents)).toBe(true)
		expect(Object.isFrozen(agent.loop)).toBe(true)
	})

	it.each([
		{ maxSteps: 0 }, { maxToolCalls: -1 }, { maxSubagentCalls: 1.5 },
		{ maxParallelSubagents: Number.NaN }, { maxDepth: 0 },
	])('rejects invalid loop settings %#', loop => {
		expect(() => defineAgent('invalidLoop', { instructions: 'test', loop })).toThrow(HarnessConfigError)
	})

	it('copies and freezes tool requirements without changing caller-owned schemas', () => {
		const requires = { memory: ['memory.kv'] as const, sandbox: ['sandbox.exec'] as const }
		const handler = async (_context: unknown, input: { message: string }) => ({ answer: input.message })
		const inputWasFrozen = Object.isFrozen(inputSchema)
		const outputWasFrozen = Object.isFrozen(outputSchema)
		const tool = defineTool('calculateRisk', {
			description: 'Calculate risk.', input: inputSchema, output: outputSchema, requires,
			handler,
		})

		expect(tool.input).toBe(inputSchema)
		expect(tool.output).toBe(outputSchema)
		expect(tool.handler).toBe(handler)
		expect(tool.requires).not.toBe(requires)
		expect(Object.isFrozen(tool)).toBe(true)
		expect(Object.isFrozen(tool.requires)).toBe(true)
		expect(Object.isFrozen(tool.requires.memory)).toBe(true)
		expect(Object.isFrozen(tool.requires.sandbox)).toBe(true)
		expect(Object.isFrozen(inputSchema)).toBe(inputWasFrozen)
		expect(Object.isFrozen(outputSchema)).toBe(outputWasFrozen)
	})

	it.each([
		{ memory: 'memory.kv' as never },
		{ memory: ['memory.unknown' as never] },
		{ sandbox: 'sandbox.fs' as never },
		{ sandbox: ['storage.persistent' as never] },
	])('rejects invalid tool requirements %#', requires => {
		expect(() => defineTool('invalidRequirements', {
			description: 'Invalid.', input: inputSchema, output: outputSchema, requires,
			async handler(_context, input) { return { answer: input.message } },
		})).toThrow(HarnessConfigError)
	})

	it('defines transport-free MCP tools and freezes their local map', () => {
		const mcp = defineMcpServer('knowledge', {
			tools: { searchKnowledge: {
				remoteName: 'search_knowledge', description: 'Search approved knowledge.', input: inputSchema, output: outputSchema,
			} },
		})

		expect(mcp.id).toBe('knowledge')
		expect(Object.isFrozen(mcp)).toBe(true)
		expect(Object.isFrozen(mcp.tools)).toBe(true)
		expect(Object.isFrozen(mcp.tools.searchKnowledge)).toBe(true)
		expect(mcp.tools.searchKnowledge.id).toBe('searchKnowledge')
		expect(mcp.tools.searchKnowledge.remoteName).toBe('search_knowledge')
		expect(mcp.tools.searchKnowledge.input).toBe(inputSchema)
		expect(mcp.tools.searchKnowledge.output).toBe(outputSchema)
		expect(getDefinitionIdentity(mcp.tools.searchKnowledge)?.owner).toBe(mcp)
		expect(Object.isFrozen(getDefinitionIdentity(mcp.tools.searchKnowledge)?.owner)).toBe(true)
		expect(mcp).not.toHaveProperty('url')
		expect(mcp).not.toHaveProperty('command')
	})

	it('rejects invalid MCP local tool ids', () => {
		expect(() => defineMcpServer('knowledge', {
			tools: { 'bad-name': { remoteName: 'lookup', description: 'test', input: inputSchema, output: outputSchema } },
		})).toThrow(HarnessConfigError)
	})

	it('accepts only the closed Skill runtime set', () => {
		const skill = defineSkill('transaction-analysis', {
			directory: new URL('./transaction-analysis/', import.meta.url), runtimes: ['python', 'shell'],
		})

		expect(skill.runtimes).toEqual(['python', 'shell'])
		expect(Object.isFrozen(skill.runtimes)).toBe(true)
		expect(() => defineSkill('invalid-runtime', {
			directory: new URL('./fixture/', import.meta.url), runtimes: ['ruby' as never],
		})).toThrow(HarnessConfigError)
	})

	it('snapshots a Skill directory URL without exposing mutable definition state', () => {
		const directory = new URL('./transaction-analysis/', import.meta.url)
		const expectedHref = directory.href
		const skill = defineSkill('transaction-analysis', { directory })

		directory.pathname = '/changed-by-caller/'
		const exposed = skill.directory
		exposed.pathname = '/changed-by-consumer/'
		expect(skill.directory.href).toBe(expectedHref)
	})

	it('snapshots permissions, sandbox policy, model aliases, and opaque Guardrail bindings', () => {
		const allow = ['echo *']
		const permissions = { bash: { mode: 'allow' as const, allow } }
		const sandbox = { group: 'analysis' }
		const memory = {
			capabilities: ['memory.kv'] as const,
			embedding: { model: 'embeddings' },
			summary: { model: 'summary', everyTurns: 2 },
		}
		const interceptor = { id: 'bankingGuardrails' }
		const replacement = { id: 'replacement' }
		const binding = { [agentGuardrailsBinding]: interceptor }
		const agent = defineAgent('snapshotAgent', {
			instructions: 'Answer.', permissions, sandbox, memory, guardrails: binding,
		})

		allow.push('rm *')
		sandbox.group = 'changed'
		memory.embedding.model = 'changed'
		memory.summary.model = 'changed'
		binding[agentGuardrailsBinding] = replacement

		expect(agent.permissions).not.toBe(permissions)
		expect(agent.permissions?.bash).toEqual({ mode: 'allow', allow: ['echo *'] })
		expect(Object.isFrozen(agent.permissions)).toBe(true)
		expect(Object.isFrozen(typeof agent.permissions?.bash === 'object' ? agent.permissions.bash.allow : undefined)).toBe(true)
		expect(agent.sandbox).toEqual({ group: 'analysis' })
		expect(Object.isFrozen(agent.sandbox)).toBe(true)
		expect(agent.memory?.embedding?.model).toBe('embeddings')
		expect(agent.memory?.summary?.model).toBe('summary')
		expect(agent.guardrails).not.toBe(binding)
		expect(agent.guardrails?.[agentGuardrailsBinding]).toBe(interceptor)
		expect(Object.isFrozen(agent.guardrails)).toBe(true)
	})

	it.each([
		{ capabilities: 'memory.kv' as never },
		{ capabilities: ['memory.unknown' as never] },
		{ capabilities: ['memory.kv'] as const, embedding: { model: 'BadAlias' } },
		{ capabilities: ['memory.kv'] as const, embedding: { model: 'embeddings', extra: true } as never },
		{ capabilities: ['memory.kv'] as const, summary: { model: 'summary', unknown: true } as never },
	])('rejects invalid agent memory configuration %#', memory => {
		expect(() => defineAgent('invalidMemory', { instructions: 'test', memory })).toThrow(HarnessConfigError)
	})

	it('rejects an invalid Guardrail binding', () => {
		expect(() => defineAgent('invalidGuardrails', {
			instructions: 'test', guardrails: { [agentGuardrailsBinding]: { id: '' } },
		})).toThrow(HarnessConfigError)
	})

	it.each([
		{ permissions: { bash: { mode: 'invalid' } } as never },
		{ permissions: { bash: { mode: 'allow', allow: 'echo *' } } as never },
		{ sandbox: { group: '' } as never },
		{ sandbox: { group: 'analysis', unknown: true } as never },
	])('rejects invalid agent policy configuration %#', options => {
		expect(() => defineAgent('invalidAgentPolicy', {
			instructions: 'test', ...options,
		})).toThrow(HarnessConfigError)
	})

	it('preserves workflow schemas and exact declared allowlists', () => {
		const agent = defineAgent('assistant', { instructions: 'Help.' })
		const workflow = defineWorkflow('resolveCase', {
			input: inputSchema, output: outputSchema, agents: { assistant: agent },
			models: { embeddings: { alias: 'embeddings', capabilities: ['embeddings'] } },
			async handler({ input }) { return { answer: input.message } },
		})

		expect(workflow.input).toBe(inputSchema)
		expect(workflow.output).toBe(outputSchema)
		expect(workflow.contract).toMatchObject({
			kind: 'workflow', id: 'resolveCase', executionModes: ['run', 'stream'],
			updates: 'none', interrupts: ['tool-approval', 'external-wait'],
		})
		expect(workflow.agents.assistant).toBe(agent)
		expect(Object.isFrozen(workflow.agents)).toBe(true)
		expect(Object.isFrozen(workflow.models)).toBe(true)
		expect(Object.isFrozen(workflow.models.embeddings.capabilities)).toBe(true)
	})

	it('snapshots workflow model aliases and sandbox policy', () => {
		const model = { alias: 'embeddings', capabilities: ['embeddings'] as ['embeddings'] }
		const sandbox = { group: 'analysis' }
		const workflow = defineWorkflow('snapshotWorkflow', {
			input: inputSchema, output: outputSchema, models: { embeddings: model }, sandbox,
			async handler({ input }) { return { answer: input.message } },
		})

		model.alias = 'changed'
		model.capabilities[0] = 'rerank'
		sandbox.group = 'changed'
		expect(workflow.models.embeddings).toEqual({ alias: 'embeddings', capabilities: ['embeddings'] })
		expect(workflow.sandbox).toEqual({ group: 'analysis' })
		expect(Object.isFrozen(workflow.sandbox)).toBe(true)
	})

	it.each([
		{ alias: 'embeddings', capabilities: [] as never },
		{ alias: 'embeddings', capabilities: 'embeddings' as never },
		{ alias: 'embeddings', capabilities: ['unknown' as never] },
		{ alias: 'BadAlias', capabilities: ['embeddings'] as const },
		{ alias: undefined as never, capabilities: ['embeddings'] as const },
	])('rejects invalid workflow model capabilities %#', model => {
		expect(() => defineWorkflow('invalidWorkflowModel', {
			input: inputSchema, output: outputSchema, models: { embeddings: model },
			async handler({ input }) { return { answer: input.message } },
		})).toThrow(HarnessConfigError)
	})
})
