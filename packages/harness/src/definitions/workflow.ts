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
	WorkflowDefinition,
	WorkflowModelMap,
	WorkflowOptions,
} from './types.js'

const workflowFields = [
	'input', 'output', 'description', 'agents', 'models', 'agentCalls', 'childTaskSandboxGroups', 'sandbox', 'maxDepth', 'workspace', 'durable', 'handler',
] as const
const modelCapabilities: readonly ModelCapability[] = Object.freeze([
	'text', 'text_stream', 'object', 'object_stream', 'tool_use', 'vision_input', 'audio_input', 'file_input',
	'embeddings', 'rerank', 'image_generation', 'speech_generation', 'video_generation',
])

/**
 * Defines one typed custom orchestration workflow.
 *
 * Only agents and models listed in the definition are visible in the handler
 * context. Agent calls require stable `callId` values for replay-safe dispatch.
 *
 * @example
 * ```ts
 * const answerCase = defineWorkflow('answerCase', {
 *   input: caseInput,
 *   output: caseOutput,
 *   agents: { answer: answerAgent },
 *   async handler(context) {
 *     return context.agents.answer.run(context.input, { callId: 'answer' })
 *   },
 * })
 * ```
 */
export function defineWorkflow<
	const Id extends string,
	Input extends ModelSchema,
	Output extends ModelSchema,
	const Agents extends WorkflowAgentMap | undefined = undefined,
	const Models extends WorkflowModelMap | undefined = undefined,
	const ChildTaskSandboxGroups extends readonly string[] = readonly [],
	const Workspace extends true | undefined = undefined,
	const Durable extends true | undefined = undefined,
	const Sandbox extends SandboxPolicy | undefined = undefined,
>(
	id: Id,
	options: WorkflowOptions<Input, Output, Agents, Models, ChildTaskSandboxGroups, Workspace, Durable, Sandbox> & Readonly<{
		input: JsonSchemaBoundary<Input>
		output: JsonSchemaBoundary<Output>
	}>,
): WorkflowDefinition<Id, Input, Output, Agents, Models, ChildTaskSandboxGroups, Workspace, Durable, Sandbox> {
	assertDefinitionId(id, 'workflow.id')
	assertKnownFields(options, workflowFields, 'workflow', id)
	assertModelSchema(options.input, 'workflow.input', id)
	assertModelSchema(options.output, 'workflow.output', id)
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
	const models = copyModels(options.models, id) as Models
	const childTaskSandboxGroups = copyChildTaskSandboxGroups(options.childTaskSandboxGroups, id) as ChildTaskSandboxGroups
	const sandbox = snapshotSandboxPolicy(options.sandbox, id)
	const identity = createDefinitionIdentity('workflow', id)
	const contract = attachDefinitionIdentity({
		kind: 'workflow' as const,
		id,
		...(options.description === undefined ? {} : { description: options.description }),
		input: options.input,
		output: options.output,
		executionModes: Object.freeze(['run', 'stream'] as const),
		updates: 'none' as const,
		interrupts: Object.freeze(['tool-approval', 'external-wait'] as const),
	}, identity)
	Object.defineProperty(contract, '$infer', {
		value: Object.freeze({}), enumerable: false, configurable: false, writable: false,
	})
	Object.freeze(contract)

	const value = {
		kind: 'workflow' as const,
		id,
		...(options.description === undefined ? {} : { description: options.description }),
		input: options.input,
		output: options.output,
		...(agents === undefined ? {} : { agents }),
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
	return freezeDefinition(value, identity) as unknown as WorkflowDefinition<Id, Input, Output, Agents, Models, ChildTaskSandboxGroups, Workspace, Durable, Sandbox>
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
	if (typeof agents !== 'object' || agents === null || Array.isArray(agents)) throw invalidWorkflowConfig(workflowId, 'workflow.agents')
	const copy: Record<string, A[keyof A]> = {}
	for (const [name, agent] of Object.entries(agents) as [string, A[keyof A]][]) {
		assertDefinitionId(name, `workflow.${workflowId}.agents`)
		const identity = getDefinitionIdentity(agent)
		if (identity?.kind !== 'agent' || getDefinitionIdentity(agent.contract)?.token !== identity.token) {
			throw new HarnessConfigError('Workflow agents must be exact package-owned definitions.', {
				reason: 'foreign_definition', path: `workflow.${workflowId}.agents.${name}`, id: workflowId,
			})
		}
		copy[name] = agent
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
		assertDefinitionId(model.alias, `workflow.${workflowId}.models.${name}.alias`)
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
		copy[name] = Object.freeze({ alias: model.alias, capabilities: Object.freeze([...model.capabilities]) })
	}
	return Object.freeze(copy) as M
}

function snapshotSandboxPolicy(policy: WorkflowOptions<any, any, any, any, any, any, any, any>['sandbox'], id: string) {
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
