import { z } from 'zod'

import { HarnessConfigError } from '../errors/index.js'
import { agentPermissionsSchema } from '../decisions/schemas.js'
import { agentGuardrailsBinding, type AgentGuardrailsBinding, type AgentPermissions } from '../harness/defineHarness.js'
import { agentExecutionRequirementsSchema } from '../harness/agent-requirements.js'
import type { Infer, JsonSchemaBoundary, ModelSchema } from '../schema/index.js'
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
	UserModelMessage,
} from './types.js'
import type { MemoryCapability } from '../ports/memory/types.js'
import type { AgentGovernanceInput, GovernanceConfig, GovernanceDefinitionHelpers, GovernanceToolMap, ResolvedAgentGovernance } from '../governance/types.js'

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
	'governance',
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
type ResolvedGovernance<Value> = ResolvedAgentGovernance<Value extends (...args: never[]) => infer Config ? Config : Value>

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
	const Governance extends AgentGovernanceInput<Tools, Skills, Subagents> | undefined = AgentGovernanceInput<Tools, Skills, Subagents> | undefined,
	const Workspace extends true | undefined = undefined,
	const Durable extends true | undefined = undefined,
>(
	id: Id,
	options: AgentOptions<Input, Output, Model, Tools, Skills, Subagents, Capabilities, Memory, Guardrails, Permissions, Governance, Workspace, Durable>
		& ([Input] extends [ModelSchema] ? Readonly<{ input: JsonSchemaBoundary<Extract<Input, ModelSchema>> }> : unknown)
		& ([Output] extends [ModelSchema] ? Readonly<{ output: JsonSchemaBoundary<Extract<Output, ModelSchema>> }> : unknown),
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
	Memory, Guardrails, Permissions, ResolvedGovernance<Governance>, Workspace, Durable
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
	const governance = resolveGovernance(options.governance, id, new Set([
		...(tools ?? []).map(tool => tool.id),
		...((skills?.length ?? 0) > 0 ? ['read_skill'] : []),
		...Object.keys(subagents ?? {}),
	])) as ResolvedGovernance<Governance>

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
		...(governance === undefined ? {} : { governance }),
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
		ResolvedUpdates<Output>, ResolvedPrompt<Input, Capabilities>, Memory, Guardrails, Permissions, ResolvedGovernance<Governance>, Workspace, Durable
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
		return validateAgentPromptResult(result, capabilities, id)
	}
}

/** @internal Revalidates and snapshots prompt output immediately before provider use. */
export function validateAgentPromptResult(
	value: unknown,
	capabilities: readonly AgentInputCapability[],
	id: string,
): readonly UserModelMessage<readonly AgentInputCapability[]>[] {
	const messages = Array.isArray(value) ? value : [value]
	if (messages.length === 0) throw invalidPrompt(id)
	return Object.freeze(messages.map(message => {
		validateUserMessage(message, capabilities, id)
		const content = (message as UserModelMessage<readonly AgentInputCapability[]>).content
		return Object.freeze({ role: 'user' as const, content: typeof content === 'string'
			? content
			: Object.freeze(content.map(part => Object.freeze({ ...part }))) })
	}))
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

function snapshotSandboxPolicy(policy: AgentOptions<any, any, any, any, any, any, any, any, any, any, any, any, any>['sandbox'], id: string) {
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

function resolveGovernance(
	input: unknown,
	id: string,
	toolIds: ReadonlySet<string>,
): GovernanceConfig<GovernanceToolMap> | undefined {
	if (input === undefined) return undefined
	const helpers: GovernanceDefinitionHelpers<GovernanceToolMap> = Object.freeze({
		rule: (definition: unknown) => definition,
		exposureRule: (definition: unknown) => definition,
		native: (definition: object) => ({ ...definition, kind: 'native' as const }),
		adapter: (definition: unknown) => definition,
	}) as GovernanceDefinitionHelpers<GovernanceToolMap>
	let configured: unknown
	try { configured = typeof input === 'function' ? input(helpers as never) : input } catch (error) {
		throw new HarnessConfigError('Agent governance configuration failed.', {
			reason: 'invalid_agent_governance', path: 'agent.governance', id,
		}, error)
	}
	if (!isPlainObject(configured)) throw invalidGovernance(id, 'agent.governance')
	assertGovernanceFields(configured, ['enabled', 'mode', 'defaultEffect', 'policies', 'exposure', 'audit'], 'agent.governance', id)
	if (configured['enabled'] !== undefined && typeof configured['enabled'] !== 'boolean') throw invalidGovernance(id, 'agent.governance.enabled')
	if (configured['mode'] !== undefined && (typeof configured['mode'] !== 'string' || !['enforce', 'shadow'].includes(configured['mode']))) throw invalidGovernance(id, 'agent.governance.mode')
	if (configured['defaultEffect'] !== undefined && (typeof configured['defaultEffect'] !== 'string' || !['allow', 'deny'].includes(configured['defaultEffect']))) throw invalidGovernance(id, 'agent.governance.defaultEffect')
	const policies = configured['policies'] === undefined ? undefined : snapshotGovernancePolicies(configured['policies'], id, toolIds)
	const exposure = configured['exposure'] === undefined ? undefined : snapshotExposure(configured['exposure'], id, toolIds)
	const audit = configured['audit']
	if (audit !== undefined && (!isPlainObject(audit)
		|| Reflect.ownKeys(audit).some(key => key !== 'record') || typeof audit['record'] !== 'function')) {
		throw invalidGovernance(id, 'agent.governance.audit')
	}
	return Object.freeze({
		...(configured['enabled'] === undefined ? {} : { enabled: configured['enabled'] as boolean }),
		...(configured['mode'] === undefined ? {} : { mode: configured['mode'] as 'enforce' | 'shadow' }),
		...(configured['defaultEffect'] === undefined ? {} : { defaultEffect: configured['defaultEffect'] as 'allow' | 'deny' }),
		...(policies === undefined ? {} : { policies }),
		...(exposure === undefined ? {} : { exposure }),
		...(audit === undefined ? {} : { audit: Object.freeze({ record: audit['record'] }) }),
	}) as GovernanceConfig<GovernanceToolMap>
}

function snapshotGovernancePolicies(value: unknown, id: string, toolIds: ReadonlySet<string>): readonly unknown[] {
	if (!Array.isArray(value)) throw invalidGovernance(id, 'agent.governance.policies')
	const policyIds = new Set<string>()
	return Object.freeze(value.map((policy, index) => {
		const path = `agent.governance.policies.${index}`
		if (!isPlainObject(policy) || !validConfigurationId(policy['id']) || ['governance.default', 'governance.exposure'].includes(policy['id'])) throw invalidGovernance(id, path)
		if (policyIds.has(policy['id'])) throw invalidGovernance(id, `${path}.id`)
		policyIds.add(policy['id'])
		if (policy['kind'] === 'native') {
			assertGovernanceFields(policy, ['kind', 'id', 'version', 'description', 'rules'], path, id)
			validateGovernanceTextFields(policy, path, id, ['version', 'description'])
			if (!Array.isArray(policy['rules']) || policy['rules'].length === 0) throw invalidGovernance(id, `${path}.rules`)
			const ruleIds = new Set<string>()
			const rules = Object.freeze(policy['rules'].map((rule, ruleIndex) => {
				const rulePath = `${path}.rules.${ruleIndex}`
				const snapshot = snapshotRule(rule, rulePath, id, toolIds)
				if (ruleIds.has(snapshot['id'] as string)) throw invalidGovernance(id, `${rulePath}.id`)
				ruleIds.add(snapshot['id'] as string)
				return snapshot
			}))
			const effects = Object.freeze([...new Set(rules.map(rule => rule['effect']))])
			return Object.freeze({ kind: 'native', id: policy['id'], ...(policy['version'] === undefined ? {} : { version: policy['version'] }),
				...(policy['description'] === undefined ? {} : { description: policy['description'] }), effects, rules })
		}
		assertGovernanceFields(policy, ['id', 'version', 'engine', 'effects', 'evaluate'], path, id)
		if ((policy['version'] !== undefined && !validConfigurationId(policy['version']))
			|| (policy['engine'] !== undefined && !validConfigurationId(policy['engine']))
			|| typeof policy['evaluate'] !== 'function' || !validEffects(policy['effects'], true)) throw invalidGovernance(id, path)
		return Object.freeze({ id: policy['id'], ...(policy['version'] === undefined ? {} : { version: policy['version'] }),
			...(policy['engine'] === undefined ? {} : { engine: policy['engine'] }),
			effects: Object.freeze([...(policy['effects'] as string[])]), evaluate: policy['evaluate'] })
	}))
}

function snapshotRule(value: unknown, path: string, id: string, toolIds: ReadonlySet<string>): Readonly<Record<string, unknown>> {
	if (!isPlainObject(value)) throw invalidGovernance(id, path)
	assertGovernanceFields(value, ['id', 'description', 'effect', 'tools', 'when', 'reasonCode'], path, id)
	if (!validConfigurationId(value['id']) || ['default', 'governance.default', 'governance.exposure'].includes(value['id']) || !validEffects([value['effect']], true)
		|| (value['description'] !== undefined && !validDescription(value['description']))
		|| (value['reasonCode'] !== undefined && !validReasonCode(value['reasonCode']))
		|| (value['when'] !== undefined && typeof value['when'] !== 'function')) throw invalidGovernance(id, path)
	const tools = snapshotSelectors(value['tools'], path, id, toolIds)
	return Object.freeze({ id: value['id'], ...(value['description'] === undefined ? {} : { description: value['description'] }), effect: value['effect'],
		...(tools === undefined ? {} : { tools }), ...(value['when'] === undefined ? {} : { when: value['when'] }),
		...(value['reasonCode'] === undefined ? {} : { reasonCode: value['reasonCode'] }) })
}

function snapshotExposure(value: unknown, id: string, toolIds: ReadonlySet<string>): Readonly<Record<string, unknown>> {
	if (!isPlainObject(value)) throw invalidGovernance(id, 'agent.governance.exposure')
	assertGovernanceFields(value, ['id', 'version', 'defaultEffect', 'rules'], 'agent.governance.exposure', id)
	if ((value['id'] !== undefined && (!validConfigurationId(value['id']) || ['governance.default', 'governance.exposure'].includes(value['id'])))
		|| (value['version'] !== undefined && !validConfigurationId(value['version']))) throw invalidGovernance(id, 'agent.governance.exposure')
	if (value['defaultEffect'] !== undefined && (typeof value['defaultEffect'] !== 'string' || !['expose', 'hide'].includes(value['defaultEffect']))) throw invalidGovernance(id, 'agent.governance.exposure.defaultEffect')
	const rules = value['rules'] === undefined ? undefined : (() => {
		if (!Array.isArray(value['rules'])) throw invalidGovernance(id, 'agent.governance.exposure.rules')
		const ruleIds = new Set<string>()
		return Object.freeze(value['rules'].map((rule, index) => {
			const path = `agent.governance.exposure.rules.${index}`
			if (!isPlainObject(rule)) throw invalidGovernance(id, path)
			assertGovernanceFields(rule, ['id', 'description', 'effect', 'tools', 'when'], path, id)
			if (!validConfigurationId(rule['id']) || ['default', 'governance.default', 'governance.exposure'].includes(rule['id']) || (rule['description'] !== undefined && !validDescription(rule['description']))
				|| typeof rule['effect'] !== 'string' || !['expose', 'hide'].includes(rule['effect']) || (rule['when'] !== undefined && typeof rule['when'] !== 'function')) throw invalidGovernance(id, path)
			if (ruleIds.has(rule['id'])) throw invalidGovernance(id, `${path}.id`)
			ruleIds.add(rule['id'])
			const tools = snapshotSelectors(rule['tools'], path, id, toolIds)
			return Object.freeze({ ...rule, ...(tools === undefined ? {} : { tools }) })
		}))
	})()
	return Object.freeze({ ...value, ...(rules === undefined ? {} : { rules }) })
}

function snapshotSelectors(value: unknown, path: string, id: string, toolIds: ReadonlySet<string>): readonly string[] | undefined {
	if (value === undefined) return undefined
	if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length
		|| value.some(name => typeof name !== 'string' || !toolIds.has(name))) throw invalidGovernance(id, `${path}.tools`)
	return Object.freeze([...value]) as readonly string[]
}

function validEffects(value: unknown, requireNonempty: boolean): value is readonly string[] {
	return Array.isArray(value) && (!requireNonempty || value.length > 0) && new Set(value).size === value.length
		&& value.every(effect => ['allow', 'deny', 'require_approval', 'audit'].includes(effect))
}

function invalidGovernance(id: string, path: string): HarnessConfigError {
	return new HarnessConfigError('Agent governance configuration is invalid.', { reason: 'invalid_agent_governance', path, id })
}

function invalidPresenceFlag(id: string, path: string): HarnessConfigError {
	return new HarnessConfigError('Agent presence flags can only be literal true.', {
		reason: 'invalid_agent_flag', path, id,
	})
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function assertGovernanceFields(value: Record<string, unknown>, fields: readonly string[], path: string, id: string): void {
	const allowed = new Set(fields)
	if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) throw invalidGovernance(id, path)
}

function validConfigurationId(value: unknown): value is string {
	return typeof value === 'string' && Array.from(value).length >= 1 && Array.from(value).length <= 128 && !/\p{Cc}/u.test(value)
}

function validDescription(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

function validReasonCode(value: unknown): value is string {
	return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value)
}

function validateGovernanceTextFields(value: Record<string, unknown>, path: string, id: string, fields: readonly string[]): void {
	for (const field of fields) {
		if (value[field] === undefined) continue
		if (field === 'description' ? !validDescription(value[field]) : !validConfigurationId(value[field])) throw invalidGovernance(id, `${path}.${field}`)
	}
}
