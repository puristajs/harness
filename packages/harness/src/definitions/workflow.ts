import { z } from 'zod'

import { HarnessConfigError } from '../errors/index.js'
import type { ModelCapability } from '../ports/model-provider.js'
import type { JsonSchemaBoundary, ModelSchema } from '../schema/index.js'
import type { SandboxPolicy } from '../sandbox/ownership.js'
import {
	assertDefinitionId,
	assertKnownFields,
	assertModelSchema,
	assertNonemptyText,
	assertPositiveInteger,
	attachDefinitionIdentity,
	createDefinitionIdentity,
	freezeDefinition,
	getDefinitionIdentity,
} from './identity.js'
import type {
	WorkflowAgentMap,
	WorkflowAgentCallLimits,
	AnyAgentDefinition,
	AnyToolDefinition,
	WorkflowDefinition,
	WorkflowModelMap,
	WorkflowOptions,
	WorkflowToolDefinitions,
} from './types.js'

const workflowFields = [
	'input', 'output', 'description', 'agents', 'tools', 'models', 'agentCalls', 'childTaskSandboxGroups', 'sandbox', 'maxDepth', 'workspace', 'durable', 'handler',
] as const
const defaultStringInput = z.string()
const defaultStringOutput = z.string()
const modelCapabilities: readonly ModelCapability[] = Object.freeze([
	'text', 'text_stream', 'object', 'object_stream', 'tool_use', 'vision_input', 'audio_input', 'file_input',
	'embeddings', 'rerank', 'image_generation', 'speech_generation', 'video_generation',
])

/**
 * Defines one typed custom orchestration workflow.
 *
 * Only agents, tools, and models listed in the definition are visible in the
 * handler context. Managed calls require stable `callId` values for replay.
 *
 * @example
 * ```ts
 * const answerCase = defineWorkflow('answerCase', {
 *   input: caseInput,
 *   output: caseOutput,
 *   agents: [answerAgent],
 *   async handler(context) {
 *     return context.agents.answerAgent.run(context.input, { callId: 'answer' })
 *   },
 * })
 * ```
 */
type ResolvedInput<Input extends ModelSchema | undefined> = Input extends ModelSchema ? Input : typeof defaultStringInput
type ResolvedOutput<Output extends ModelSchema | undefined> = Output extends ModelSchema ? Output : typeof defaultStringOutput

export function defineWorkflow<
	const Id extends string,
	const Input extends ModelSchema | undefined = undefined,
	const Output extends ModelSchema | undefined = undefined,
	const Agents extends WorkflowAgentMap | undefined = undefined,
	const Tools extends WorkflowToolDefinitions | undefined = undefined,
	const Models extends WorkflowModelMap | undefined = undefined,
	const ChildTaskSandboxGroups extends readonly string[] = readonly [],
	const Workspace extends true | undefined = undefined,
	const Durable extends true | undefined = undefined,
	const Sandbox extends SandboxPolicy | undefined = undefined,
>(
	id: Id,
	options: WorkflowOptions<ResolvedInput<Input>, ResolvedOutput<Output>, Agents, Tools, Models, ChildTaskSandboxGroups, Workspace, Durable, Sandbox>
		& ([Input] extends [ModelSchema] ? Readonly<{ input: JsonSchemaBoundary<Extract<Input, ModelSchema>> }> : unknown)
		& ([Output] extends [ModelSchema] ? Readonly<{ output: JsonSchemaBoundary<Extract<Output, ModelSchema>> }> : unknown),
): WorkflowDefinition<Id, ResolvedInput<Input>, ResolvedOutput<Output>, Agents, Tools, Models, ChildTaskSandboxGroups, Workspace, Durable, Sandbox> {
	assertDefinitionId(id, 'workflow.id')
	assertKnownFields(options, workflowFields, 'workflow', id)
	const input = options.input ?? defaultStringInput
	const output = options.output ?? defaultStringOutput
	assertModelSchema(input, 'workflow.input', id)
	assertModelSchema(output, 'workflow.output', id)
	if (options.description !== undefined) assertNonemptyText(options.description, 'workflow.description', id)
	if (typeof options.handler !== 'function') {
		throw new HarnessConfigError('Workflow handler must be a function.', {
			reason: 'invalid_workflow_handler', path: 'workflow.handler', id,
		})
	}
	if (options.maxDepth !== undefined) assertPositiveInteger(options.maxDepth, 'workflow.maxDepth', id)
	const agentCalls = snapshotAgentCalls(options.agentCalls, id)
	if (options.workspace !== undefined && options.workspace !== true) throw invalidWorkflowConfig(id, 'workflow.workspace')
	if (options.durable !== undefined && options.durable !== true) throw invalidWorkflowConfig(id, 'workflow.durable')

	const agents = copyAgents(options.agents, id) as Agents
	const tools = copyTools(options.tools, id) as Tools
	const models = copyModels(options.models, id) as Models
	const childTaskSandboxGroups = copyChildTaskSandboxGroups(options.childTaskSandboxGroups, id) as ChildTaskSandboxGroups
	const sandbox = snapshotSandboxPolicy(options.sandbox, id)
	const interrupts = resolveWorkflowInterrupts(agents, options.durable)
	const identity = createDefinitionIdentity('workflow', id)
	const contract = attachDefinitionIdentity({
		kind: 'workflow' as const,
		id,
		...(options.description === undefined ? {} : { description: options.description }),
		input,
		output,
		executionModes: Object.freeze(['run', 'stream'] as const),
		updates: 'none' as const,
		interrupts,
	}, identity)
	Object.defineProperty(contract, '$infer', {
		value: Object.freeze({}), enumerable: false, configurable: false, writable: false,
	})
	Object.freeze(contract)

	const value = {
		kind: 'workflow' as const,
		id,
		...(options.description === undefined ? {} : { description: options.description }),
		input,
		output,
		...(agents === undefined ? {} : { agents }),
		...(tools === undefined ? {} : { tools }),
		...(models === undefined ? {} : { models }),
		...(agentCalls === undefined ? {} : { agentCalls }),
		...(childTaskSandboxGroups.length === 0 ? {} : { childTaskSandboxGroups }),
		...(sandbox === undefined ? {} : { sandbox }),
		...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
		...(options.workspace === undefined ? {} : { workspace: options.workspace }),
		...(options.durable === undefined ? {} : { durable: options.durable }),
		handler: options.handler,
		contract,
	}
	return freezeDefinition(value, identity) as unknown as WorkflowDefinition<Id, ResolvedInput<Input>, ResolvedOutput<Output>, Agents, Tools, Models, ChildTaskSandboxGroups, Workspace, Durable, Sandbox>
}

function copyTools<T extends WorkflowToolDefinitions>(tools: T | undefined, workflowId: string): T | undefined {
	if (tools === undefined) return undefined
	if (!Array.isArray(tools) || tools.length === 0) throw invalidWorkflowConfig(workflowId, 'workflow.tools')
	const copy: AnyToolDefinition[] = []
	const ids = new Set<string>()
	for (const tool of tools) {
		const identity = getDefinitionIdentity(tool)
		if (identity === undefined || !['tool', 'built-in-tool', 'host-tool', 'mcp-tool'].includes(identity.kind)) {
			throw new HarnessConfigError('Workflow tools must be exact package-owned definitions.', {
				reason: 'foreign_definition', path: `workflow.${workflowId}.tools`, id: workflowId,
			})
		}
		if (ids.has(tool.id)) throw invalidWorkflowConfig(workflowId, 'workflow.tools')
		ids.add(tool.id)
		copy.push(tool)
	}
	return Object.freeze(copy) as unknown as T
}

function resolveWorkflowInterrupts(agents: WorkflowAgentMap | undefined, durable: true | undefined): readonly ('tool-approval' | 'external-wait')[] {
	const approval = Object.values(agents ?? {}).some(agent => agent.contract.interrupts.includes('tool-approval'))
	return Object.freeze([
		...(approval ? ['tool-approval' as const] : []),
		...(durable === true ? ['external-wait' as const] : []),
	])
}

function copyChildTaskSandboxGroups<const Groups extends readonly string[]>(groups: Groups | undefined, id: string): Groups {
	if (groups === undefined) return Object.freeze([]) as unknown as Groups
	if (!Array.isArray(groups) || groups.length === 0 || new Set(groups).size !== groups.length
		|| groups.some(group => typeof group !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(group))) {
		throw invalidWorkflowConfig(id, 'workflow.childTaskSandboxGroups')
	}
	return Object.freeze([...groups]) as unknown as Groups
}

function snapshotAgentCalls(value: WorkflowAgentCallLimits | undefined, id: string) {
	if (value === undefined) return undefined
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidWorkflowConfig(id, 'workflow.agentCalls')
	assertKnownFields(value, ['maxCalls', 'maxParallel'], 'workflow.agentCalls', id)
	if (value.maxCalls !== undefined) assertPositiveInteger(value.maxCalls, 'workflow.agentCalls.maxCalls', id)
	if (value.maxParallel !== undefined) assertPositiveInteger(value.maxParallel, 'workflow.agentCalls.maxParallel', id)
	return Object.freeze({
		...(value.maxCalls === undefined ? {} : { maxCalls: value.maxCalls }),
		...(value.maxParallel === undefined ? {} : { maxParallel: value.maxParallel }),
	})
}

function copyAgents<A extends WorkflowAgentMap>(agents: A | undefined, workflowId: string): A | undefined {
	if (agents === undefined) return undefined
	if (!Array.isArray(agents) || agents.length === 0) throw invalidWorkflowConfig(workflowId, 'workflow.agents')
	const copy: AnyAgentDefinition[] = []
	const ids = new Set<string>()
	for (const agent of agents) {
		const identity = getDefinitionIdentity(agent)
		if (identity?.kind !== 'agent' || getDefinitionIdentity(agent.contract)?.token !== identity.token) {
			throw new HarnessConfigError('Workflow agents must be exact package-owned definitions.', {
				reason: 'foreign_definition', path: `workflow.${workflowId}.agents`, id: workflowId,
			})
		}
		if (ids.has(agent.id)) throw invalidWorkflowConfig(workflowId, 'workflow.agents')
		ids.add(agent.id)
		copy.push(agent)
	}
	return Object.freeze(copy) as unknown as A
}

function copyModels<M extends WorkflowModelMap>(models: M | undefined, workflowId: string): M | undefined {
	if (models === undefined) return undefined
	if (typeof models !== 'object' || models === null || Array.isArray(models)) throw invalidWorkflowConfig(workflowId, 'workflow.models')
	const copy: Record<string, unknown> = {}
	for (const [name, model] of Object.entries(models)) {
		assertDefinitionId(name, `workflow.${workflowId}.models`)
		if (typeof model !== 'object' || model === null || Array.isArray(model)) {
			throw invalidWorkflowConfig(workflowId, `workflow.${workflowId}.models.${name}`)
		}
		assertKnownFields(model, ['alias', 'capabilities'], `workflow.${workflowId}.models.${name}`, workflowId)
		const alias = model.alias ?? name
		assertDefinitionId(alias, `workflow.${workflowId}.models.${name}.alias`)
		if (model.alias === name) throw invalidWorkflowConfig(workflowId, `workflow.${workflowId}.models.${name}.alias`)
		if (
			!Array.isArray(model.capabilities)
			|| model.capabilities.length === 0
			|| new Set(model.capabilities).size !== model.capabilities.length
			|| model.capabilities.some(capability => !modelCapabilities.includes(capability))
		) {
			throw new HarnessConfigError('Workflow model capabilities must be a non-empty array.', {
				reason: 'invalid_workflow_model_capabilities', path: `workflow.${workflowId}.models.${name}.capabilities`, id: workflowId,
			})
		}
		copy[name] = Object.freeze({ ...(model.alias === undefined ? {} : { alias }), capabilities: Object.freeze([...model.capabilities]) })
	}
	return Object.freeze(copy) as M
}

function snapshotSandboxPolicy(policy: WorkflowOptions<any, any, any, any, any, any, any, any, any>['sandbox'], id: string) {
	if (policy === undefined || policy === 'inherit' || policy === 'private') return policy
	if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) throw invalidWorkflowConfig(id, 'workflow.sandbox')
	assertKnownFields(policy, ['group'], 'workflow.sandbox', id)
	if (typeof policy.group !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(policy.group)) {
		throw invalidWorkflowConfig(id, 'workflow.sandbox')
	}
	return Object.freeze({ group: policy.group })
}

function invalidWorkflowConfig(id: string, path: string): HarnessConfigError {
	return new HarnessConfigError('Workflow configuration is invalid.', {
		reason: 'invalid_workflow_config', path, id,
	})
}
