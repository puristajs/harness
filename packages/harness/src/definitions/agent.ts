import { z } from 'zod'

import { HarnessConfigError } from '../errors/index.js'
import { agentPermissionsSchema } from '../decisions/schemas.js'
import { agentGuardrailsBinding, type AgentGuardrailsBinding, type AgentPermissions } from '../harness/defineHarness.js'
import { agentExecutionRequirementsSchema } from '../harness/agent-requirements.js'
import type { Infer, ModelSchema } from '../schema/index.js'
import {
	assertDefinitionId,
	assertKnownFields,
	assertModelSchema,
	assertNonemptyText,
	assertPositiveInteger,
	attachDefinitionIdentity,
	createDefinitionIdentity,
	freezeDefinition,
} from './identity.js'
import type {
	AgentDefinition,
	AgentInputCapability,
	AgentMemoryPolicy,
	AgentOptions,
	AgentPrompt,
	AgentSubagentMap,
	AnyToolDefinition,
	SkillDefinition,
} from './types.js'
import type { MemoryCapability } from '../ports/memory/types.js'

const defaultStringInput = z.string()
const defaultStringOutput = z.string()
const supportedInputCapabilities: readonly AgentInputCapability[] = Object.freeze(['vision_input', 'audio_input', 'file_input'])
const supportedMemoryCapabilities: readonly MemoryCapability[] = Object.freeze([
	'memory.kv', 'memory.list', 'memory.delete', 'memory.ttl', 'memory.text_search',
	'memory.vector_search', 'memory.hybrid_search', 'memory.persistent', 'memory.multi_instance',
])
const agentFields = [
	'description', 'model', 'input', 'output', 'instructions', 'prompt', 'inputCapabilities', 'tools', 'skills',
	'guardrails', 'permissions', 'subagents', 'loop', 'memory', 'sandbox', 'workspace', 'durable',
] as const

type ResolvedInput<Input extends ModelSchema | undefined> = Input extends ModelSchema ? Input : typeof defaultStringInput
type ResolvedOutput<Output extends ModelSchema | undefined> = Output extends ModelSchema ? Output : typeof defaultStringOutput
type ResolvedUpdates<Output extends ModelSchema | undefined> = Output extends ModelSchema ? 'object-snapshot' : 'text-delta'
type ResolvedPrompt<
	Input extends ModelSchema | undefined,
	Capabilities extends readonly AgentInputCapability[],
> = [Input] extends [undefined]
	? undefined
	: AgentPrompt<Infer<ResolvedInput<Input>>, Capabilities>

/**
 * Defines one standard bounded model-loop agent.
 *
 * Omit schemas for a string-to-string agent using the `primary` model alias.
 * Supplying an input schema requires a pure prompt mapper, and supplying any
 * output schema selects structured generation and object-snapshot updates.
 *
 * @example
 * ```ts
 * const assistant = defineAgent('assistant', {
 *   instructions: 'Answer clearly and concisely.',
 * })
 * ```
 *
 * @example
 * ```ts
 * const classify = defineAgent('classify', {
 *   input: z.object({ message: z.string() }),
 *   output: z.object({ category: z.string() }),
 *   instructions: 'Classify the message.',
 *   prompt: input => ({ role: 'user', content: input.message }),
 * })
 * ```
 */
export function defineAgent<
	const Id extends string,
	Input extends ModelSchema | undefined = undefined,
	Output extends ModelSchema | undefined = undefined,
	const Model extends string = 'primary',
	const Tools extends readonly AnyToolDefinition[] | undefined = undefined,
	const Skills extends readonly SkillDefinition[] | undefined = undefined,
	const Subagents extends AgentSubagentMap | undefined = undefined,
	const Capabilities extends readonly AgentInputCapability[] = readonly [],
	const Memory extends AgentMemoryPolicy<readonly MemoryCapability[]> | undefined = undefined,
	const Guardrails extends AgentGuardrailsBinding<any> | undefined = undefined,
	const Permissions extends AgentPermissions | undefined = undefined,
	const Workspace extends true | undefined = undefined,
	const Durable extends true | undefined = undefined,
>(
	id: Id,
	options: AgentOptions<Input, Output, Model, Tools, Skills, Subagents, Capabilities, Memory, Guardrails, Permissions, Workspace, Durable>,
): AgentDefinition<
	Id,
	ResolvedInput<Input>,
	ResolvedOutput<Output>,
	Model,
	Tools,
	Skills,
	Subagents,
	Capabilities,
	ResolvedUpdates<Output>,
	ResolvedPrompt<Input, Capabilities>,
	Memory, Guardrails, Permissions, Workspace, Durable
> {
	assertDefinitionId(id, 'agent.id')
	assertKnownFields(options, agentFields, 'agent', id)
	assertNonemptyText(options.instructions, 'agent.instructions', id)
	if (options.description !== undefined) assertNonemptyText(options.description, 'agent.description', id)
	const model = options.model ?? 'primary'
	assertDefinitionId(model, 'agent.model')
	if (options.workspace !== undefined && options.workspace !== true) throw invalidPresenceFlag(id, 'agent.workspace')
	if (options.durable !== undefined && options.durable !== true) throw invalidPresenceFlag(id, 'agent.durable')

	const input = options.input ?? defaultStringInput
	const output = options.output ?? defaultStringOutput
	assertModelSchema(input, 'agent.input', id)
	assertModelSchema(output, 'agent.output', id)
	if (options.input !== undefined && typeof options.prompt !== 'function') {
		throw new HarnessConfigError('An agent with an input schema requires a prompt mapper.', {
			reason: 'missing_agent_prompt', path: 'agent.prompt', id,
		})
	}

	const capabilities = copyInputCapabilities(options.inputCapabilities, id)
	const prompt = options.prompt === undefined
		? undefined
		: wrapPrompt(options.prompt as unknown as AgentPrompt<unknown, readonly AgentInputCapability[]>, capabilities ?? [], id)
	const tools = options.tools === undefined ? undefined : Object.freeze([...options.tools]) as Tools
	const skills = options.skills === undefined ? undefined : Object.freeze([...options.skills]) as Skills
	const subagents = copySubagents(options.subagents, id) as Subagents
	const loop = copyLoop(options.loop, id)
	const memory = copyMemory(options.memory, id) as Memory
	const permissions = snapshotPermissions(options.permissions, id) as Permissions
	const sandbox = snapshotSandboxPolicy(options.sandbox, id)
	const guardrails = snapshotGuardrails(options.guardrails, id) as Guardrails

	const identity = createDefinitionIdentity('agent', id)
	const contract = attachDefinitionIdentity({
		kind: 'agent' as const,
		id,
		...(options.description === undefined ? {} : { description: options.description }),
		input,
		output,
		executionModes: Object.freeze(['run', 'stream'] as const),
		updates: (options.output === undefined ? 'text-delta' : 'object-snapshot') as ResolvedUpdates<Output>,
		interrupts: Object.freeze(['tool-approval'] as const),
	}, identity)
	Object.freeze(contract)

	const value = {
		kind: 'agent' as const,
		id,
		...(options.description === undefined ? {} : { description: options.description }),
		model: model as Model,
		input,
		output,
		instructions: options.instructions,
		...(capabilities === undefined ? {} : { inputCapabilities: capabilities }),
		...(prompt === undefined ? {} : { prompt }),
		...(tools === undefined ? {} : { tools }),
		...(skills === undefined ? {} : { skills }),
		...(guardrails === undefined ? {} : { guardrails }),
		...(permissions === undefined ? {} : { permissions }),
		...(subagents === undefined ? {} : { subagents }),
		...(loop === undefined ? {} : { loop }),
		...(memory === undefined ? {} : { memory }),
		...(sandbox === undefined ? {} : { sandbox }),
		...(options.workspace === undefined ? {} : { workspace: options.workspace }),
		...(options.durable === undefined ? {} : { durable: options.durable }),
		contract,
	}
	return freezeDefinition(value, identity) as unknown as AgentDefinition<
		Id, ResolvedInput<Input>, ResolvedOutput<Output>, Model, Tools, Skills, Subagents, Capabilities,
		ResolvedUpdates<Output>, ResolvedPrompt<Input, Capabilities>, Memory, Guardrails, Permissions, Workspace, Durable
	>
}

function copyInputCapabilities<const C extends readonly AgentInputCapability[]>(
	configured: C | undefined,
	id: string,
): C | undefined {
	if (configured === undefined) return undefined
	if (!Array.isArray(configured)) {
		throw new HarnessConfigError('Agent input capabilities must be an array.', {
			reason: 'invalid_agent_input_capability', path: 'agent.inputCapabilities', id,
		})
	}
	for (const capability of configured) {
		if (!supportedInputCapabilities.includes(capability)) {
			throw new HarnessConfigError('Agent input capability is not supported.', {
				reason: 'invalid_agent_input_capability', path: 'agent.inputCapabilities', id,
			})
		}
	}
	return Object.freeze([...configured]) as unknown as C
}

function wrapPrompt(
	prompt: AgentPrompt<unknown, readonly AgentInputCapability[]>,
	capabilities: readonly AgentInputCapability[],
	id: string,
): AgentPrompt<unknown, readonly AgentInputCapability[]> {
	return input => {
		const result = prompt(input)
		const messages = Array.isArray(result) ? result : [result]
		for (const message of messages) validateUserMessage(message, capabilities, id)
		return result
	}
}

function validateUserMessage(value: unknown, capabilities: readonly AgentInputCapability[], id: string): void {
	if (typeof value !== 'object' || value === null || (value as { role?: unknown }).role !== 'user') {
		throw invalidPrompt(id)
	}
	assertKnownFields(value, ['role', 'content'], 'agent.prompt.message', id)
	const content = (value as { content?: unknown }).content
	if (typeof content === 'string') return
	if (!Array.isArray(content) || content.length === 0) throw invalidPrompt(id)
	for (const part of content) {
		validatePromptPart(part, capabilities, id)
	}
}

function validatePromptPart(value: unknown, capabilities: readonly AgentInputCapability[], id: string): void {
	if (!isPlainObject(value) || typeof value['kind'] !== 'string') throw invalidPrompt(id)
	const kind = value['kind']
	if (kind === 'text') {
		assertKnownFields(value, ['kind', 'text'], 'agent.prompt.content', id)
		if (typeof value['text'] !== 'string') throw invalidPrompt(id)
		return
	}
	if (kind === 'image') {
		assertKnownFields(value, ['kind', 'mimeType', 'dataBase64'], 'agent.prompt.content', id)
		assertPromptStrings(value, ['mimeType', 'dataBase64'], id)
		if (!capabilities.includes('vision_input')) throw invalidPrompt(id)
		return
	}
	if (kind === 'image_url') {
		assertKnownFields(value, ['kind', 'url', 'mimeType'], 'agent.prompt.content', id)
		assertPromptStrings(value, ['url'], id)
		assertOptionalPromptString(value, 'mimeType', id)
		if (!capabilities.includes('vision_input')) throw invalidPrompt(id)
		return
	}
	if (kind === 'audio') {
		assertKnownFields(value, ['kind', 'mimeType', 'dataBase64'], 'agent.prompt.content', id)
		assertPromptStrings(value, ['mimeType', 'dataBase64'], id)
		if (!capabilities.includes('audio_input')) throw invalidPrompt(id)
		return
	}
	if (kind === 'file') {
		assertKnownFields(value, ['kind', 'mimeType', 'dataBase64', 'filename'], 'agent.prompt.content', id)
		assertPromptStrings(value, ['mimeType', 'dataBase64'], id)
		assertOptionalPromptString(value, 'filename', id)
		if (!capabilities.includes('file_input')) throw invalidPrompt(id)
		return
	}
	if (kind === 'file_url') {
		assertKnownFields(value, ['kind', 'url', 'mimeType', 'filename'], 'agent.prompt.content', id)
		assertPromptStrings(value, ['url'], id)
		assertOptionalPromptString(value, 'mimeType', id)
		assertOptionalPromptString(value, 'filename', id)
		if (!capabilities.includes('file_input')) throw invalidPrompt(id)
		return
	}
	throw invalidPrompt(id)
}

function assertPromptStrings(value: Record<string, unknown>, fields: readonly string[], id: string): void {
	if (fields.some(field => typeof value[field] !== 'string' || (value[field] as string).length === 0)) throw invalidPrompt(id)
}

function assertOptionalPromptString(value: Record<string, unknown>, field: string, id: string): void {
	if (value[field] !== undefined && (typeof value[field] !== 'string' || (value[field] as string).length === 0)) throw invalidPrompt(id)
}

function invalidPrompt(id: string): HarnessConfigError {
	return new HarnessConfigError('Agent prompt must return user messages using only declared input capabilities.', {
		reason: 'invalid_agent_prompt', path: 'agent.prompt', id,
	})
}

function copySubagents<S extends AgentSubagentMap>(subagents: S | undefined, id: string): S | undefined {
	if (subagents === undefined) return undefined
	const copy: Record<string, unknown> = {}
	for (const [name, reference] of Object.entries(subagents)) {
		assertDefinitionId(name, `agent.${id}.subagents`)
		if (typeof reference === 'object' && reference !== null && 'agent' in reference) {
			assertKnownFields(reference, ['agent', 'description'], `agent.${id}.subagents.${name}`, id)
			if (reference.description !== undefined) assertNonemptyText(reference.description, `agent.${id}.subagents.${name}.description`, id)
			copy[name] = Object.freeze({ agent: reference.agent, ...(reference.description === undefined ? {} : { description: reference.description }) })
		} else {
			copy[name] = reference
		}
	}
	return Object.freeze(copy) as S
}

function copyLoop(loop: AgentOptions<any, any, any, any, any, any, any, any>['loop'], id: string) {
	if (loop === undefined) return undefined
	const fields = ['maxSteps', 'maxToolCalls', 'maxSubagentCalls', 'maxParallelSubagents', 'maxDepth'] as const
	assertKnownFields(loop, fields, 'agent.loop', id)
	for (const field of fields) {
		if (loop[field] !== undefined) assertPositiveInteger(loop[field], `agent.loop.${field}`, id)
	}
	return Object.freeze({ ...loop })
}

function copyMemory<M extends AgentMemoryPolicy<readonly MemoryCapability[]>>(memory: M | undefined, id: string): M | undefined {
	if (memory === undefined) return undefined
	if (!isPlainObject(memory)) throw invalidMemory(id, 'agent.memory')
	assertKnownFields(memory, ['capabilities', 'embedding', 'summary'], 'agent.memory', id)
	if (
		!Array.isArray(memory.capabilities)
		|| memory.capabilities.length === 0
		|| new Set(memory.capabilities).size !== memory.capabilities.length
		|| memory.capabilities.some(capability => !supportedMemoryCapabilities.includes(capability))
	) {
		throw invalidMemory(id, 'agent.memory.capabilities')
	}
	if (memory.embedding !== undefined) {
		if (!isPlainObject(memory.embedding)) throw invalidMemory(id, 'agent.memory.embedding')
		assertKnownFields(memory.embedding, ['model'], 'agent.memory.embedding', id)
		assertDefinitionId(memory.embedding.model, 'agent.memory.embedding.model')
	}
	if (memory.summary !== undefined) {
		if (!isPlainObject(memory.summary)) throw invalidMemory(id, 'agent.memory.summary')
		assertKnownFields(memory.summary, ['model', 'everyTurns', 'sourceTurns'], 'agent.memory.summary', id)
		assertDefinitionId(memory.summary.model, 'agent.memory.summary.model')
	}
	if (memory.summary?.everyTurns !== undefined) assertPositiveInteger(memory.summary.everyTurns, 'agent.memory.summary.everyTurns', id)
	if (memory.summary?.sourceTurns !== undefined) assertPositiveInteger(memory.summary.sourceTurns, 'agent.memory.summary.sourceTurns', id)
	return Object.freeze({
		capabilities: Object.freeze([...memory.capabilities]),
		...(memory.embedding === undefined ? {} : { embedding: Object.freeze({ ...memory.embedding }) }),
		...(memory.summary === undefined ? {} : { summary: Object.freeze({ ...memory.summary }) }),
	}) as M
}

function invalidMemory(id: string, path: string): HarnessConfigError {
	return new HarnessConfigError('Agent memory configuration is invalid.', {
		reason: 'invalid_agent_memory', path, id,
	})
}

function snapshotPermissions(permissions: AgentPermissions | undefined, id: string): AgentPermissions | undefined {
	if (permissions === undefined) return undefined
	const parsed = agentPermissionsSchema.safeParse(permissions)
	if (!parsed.success) {
		throw new HarnessConfigError('Agent permissions are invalid.', {
			reason: 'invalid_agent_permissions', path: 'agent.permissions', id,
		})
	}
	const snapshot: Record<string, unknown> = {}
	for (const name of ['bash', 'write', 'edit'] as const) {
		const policy = parsed.data[name]
		if (policy === undefined) continue
		snapshot[name] = typeof policy === 'string'
			? policy
			: Object.freeze({
				mode: policy.mode,
				...(policy.allow === undefined ? {} : { allow: Object.freeze([...policy.allow]) }),
				...(policy.deny === undefined ? {} : { deny: Object.freeze([...policy.deny]) }),
			})
	}
	return Object.freeze(snapshot) as AgentPermissions
}

function snapshotSandboxPolicy(policy: AgentOptions<any, any, any, any, any, any, any, any, any, any, any, any>['sandbox'], id: string) {
	if (policy === undefined || policy === 'inherit' || policy === 'private') return policy
	if (!isPlainObject(policy)) throw invalidSandbox(id)
	assertKnownFields(policy, ['group'], 'agent.sandbox', id)
	if (typeof policy.group !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(policy.group)) throw invalidSandbox(id)
	return Object.freeze({ group: policy.group })
}

function invalidSandbox(id: string): HarnessConfigError {
	return new HarnessConfigError('Agent sandbox policy is invalid.', {
		reason: 'invalid_agent_sandbox', path: 'agent.sandbox', id,
	})
}

function snapshotGuardrails(binding: AgentGuardrailsBinding | undefined, id: string): AgentGuardrailsBinding | undefined {
	if (!isPlainObject(binding) || !(agentGuardrailsBinding in binding)) {
		if (binding === undefined) return undefined
		throw invalidGuardrails(id)
	}
	let interceptor: unknown
	try {
		interceptor = binding[agentGuardrailsBinding]
	} catch {
		throw invalidGuardrails(id)
	}
	if (!isAgentExecutionInterceptor(interceptor)) throw invalidGuardrails(id)
	if (interceptor.requirements !== undefined && !agentExecutionRequirementsSchema.safeParse(interceptor.requirements).success) {
		throw invalidGuardrails(id)
	}
	return Object.freeze({ [agentGuardrailsBinding]: interceptor })
}

function isAgentExecutionInterceptor(value: unknown): value is AgentGuardrailsBinding[typeof agentGuardrailsBinding] {
	if (!isPlainObject(value) || typeof value['id'] !== 'string' || value['id'].length === 0) return false
	return ['beforeInput', 'beforeModel', 'afterModel', 'beforeTool', 'afterTool', 'beforeOutput'].every(
		hook => value[hook] === undefined || typeof value[hook] === 'function',
	)
}

function invalidGuardrails(id: string): HarnessConfigError {
	return new HarnessConfigError('Agent guardrails binding is invalid.', {
		reason: 'invalid_agent_guardrails', path: 'agent.guardrails', id,
	})
}

function invalidPresenceFlag(id: string, path: string): HarnessConfigError {
	return new HarnessConfigError('Agent presence flags can only be literal true.', {
		reason: 'invalid_agent_flag', path, id,
	})
}

function isPlainObject(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
