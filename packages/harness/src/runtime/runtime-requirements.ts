import { agentGuardrailsBinding } from '../agents/guardrails.js'
import type { AgentExecutionRequirements } from '../harness/agent-requirements.js'
import type { AgentGuardrailsBinding } from '../agents/guardrails.js'
import type { MemoryCapability } from '../ports/memory/types.js'
import type { ModelCapability } from '../ports/model-provider.js'
import type {
	AnyAgentDefinition,
	AnyNonMcpToolDefinition,
	AnyWorkflowDefinition,
	HostToolDefinition,
	McpServerDefinition,
	McpToolDefinition,
	SandboxCapabilityId,
	SkillDefinition,
	SkillRuntimeId,
} from '../definitions/types.js'
import { getDefinitionIdentity } from '../definitions/identity.js'
import type { CompiledApprovalInventory } from './compiled-graph.js'

/** Deterministic deployment requirements derived from a completed definition graph. */
export interface RuntimeRequirements<
	Models extends Readonly<Record<string, Readonly<{ capabilities: readonly ModelCapability[] }>>> = Readonly<Record<string, Readonly<{ capabilities: readonly ModelCapability[] }>>>,
	McpServerId extends string = string,
	RuntimeId extends SkillRuntimeId = SkillRuntimeId,
	RequiredMemoryCapability extends MemoryCapability = MemoryCapability,
	MemoryModelAlias extends string = string,
	RequiredSandboxCapability extends SandboxCapabilityId = SandboxCapabilityId,
	SandboxGroup extends string = string,
	SandboxRequired extends boolean = boolean,
	HostToolId extends string = string,
	Durable extends boolean = boolean,
	Workspace extends boolean = boolean,
	Artifacts extends boolean = boolean,
> {
	readonly models: Models
	readonly mcpServers: readonly McpServerId[]
	readonly skillRuntimes: readonly RuntimeId[]
	readonly storage: Readonly<{ durable: Durable }>
	readonly memory: Readonly<{
		capabilities: readonly RequiredMemoryCapability[]
		modelAliases: readonly MemoryModelAlias[]
	}>
	readonly sandbox: Readonly<{
		capabilities: readonly RequiredSandboxCapability[]
		requiredGroups: readonly SandboxGroup[]
		required: SandboxRequired
	}>
	readonly workspace: Workspace
	readonly artifacts: Artifacts
	readonly hostTools: readonly HostToolId[]
}

type Values<Map> = Map extends Readonly<Record<string, unknown>> ? Map[keyof Map] : never
type ToolMemoryCapabilities<Tool> = Tool extends { readonly requires: { readonly memory: readonly (infer Capability)[] } }
	? Extract<Capability, MemoryCapability>
	: never
type ToolSandboxCapabilities<Tool> = Tool extends { readonly requires: { readonly sandbox: readonly (infer Capability)[] } }
	? Extract<Capability, SandboxCapabilityId>
	: never
type SkillRuntimes<Skill> = Skill extends SkillDefinition<string, infer Runtimes>
	? Extract<Runtimes[number], SkillRuntimeId>
	: never
type RuntimeSkillSandboxCapabilities<Skill> = [SkillRuntimes<Skill>] extends [never]
	? never
	: 'sandbox.fs' | 'sandbox.readonly_mount'
type AgentMemory<Agent> = Agent extends { readonly memory: infer Memory } ? Memory : never
type AgentMemoryCapabilities<Agent> = AgentMemory<Agent> extends { readonly capabilities: readonly (infer Capability)[] }
	? Extract<Capability, MemoryCapability>
	: never
type AgentMemoryAliases<Agent> =
	[AgentMemory<Agent>] extends [never]
		? never
		: | (AgentMemory<Agent> extends { readonly embedding: { readonly model: infer Alias } } ? Extract<Alias, string> : never)
			| (AgentMemory<Agent> extends { readonly summary: { readonly model: infer Alias } } ? Extract<Alias, string> : never)
type AgentGuardrailRequirements<Agent> = Agent extends { readonly guardrails: AgentGuardrailsBinding<infer Requirements> }
	? Extract<Requirements, AgentExecutionRequirements>
	: never
type GuardrailArrayMember<Agent, Key extends keyof AgentExecutionRequirements> =
	AgentGuardrailRequirements<Agent> extends infer Requirements
		? Requirements extends AgentExecutionRequirements
			? Key extends keyof Requirements
				? NonNullable<Requirements[Key]> extends readonly (infer Member)[] ? Member : never
				: never
			: never
		: never
type HasAgentTools<Agent> = Agent extends { readonly tools: infer Tools extends readonly unknown[] }
	? Tools[number] extends never ? never : 'tool_use'
	: never
type HasAgentSubagents<Agent> = Agent extends { readonly subagents: infer Subagents extends Readonly<Record<string, unknown>> }
	? keyof Subagents extends never ? never : 'tool_use'
	: never
type HasAgentSkills<Agent> = Agent extends { readonly skills: infer Skills extends readonly unknown[] }
	? Skills[number] extends never ? never : 'tool_use'
	: never
type AgentMainCapabilities<Agent> = Agent extends AnyAgentDefinition
	? (
		Agent['contract']['updates'] extends 'text-delta' ? 'text' | 'text_stream' : 'object' | 'object_stream'
	) | HasAgentTools<Agent> | HasAgentSubagents<Agent> | HasAgentSkills<Agent> | NonNullable<Agent['inputCapabilities']>[number]
	: never
type AgentEmbeddingModelEntry<Agent> = [AgentMemory<Agent>] extends [never]
	? never
	: AgentMemory<Agent> extends { readonly embedding: { readonly model: infer Alias extends string } }
		? { readonly alias: Alias; readonly capability: 'embeddings' }
		: never
type AgentSummaryModelEntry<Agent> = [AgentMemory<Agent>] extends [never]
	? never
	: AgentMemory<Agent> extends { readonly summary: { readonly model: infer Alias extends string } }
		? { readonly alias: Alias; readonly capability: 'object' }
		: never
type GuardrailModelEntries<Agent> = GuardrailArrayMember<Agent, 'models'> extends infer Model
	? Model extends { readonly alias: infer Alias extends string; readonly capabilities: readonly (infer Capability)[] }
		? { readonly alias: Alias; readonly capability: Extract<Capability, ModelCapability> }
		: never
	: never
type AgentModelEntries<Agent> = Agent extends { readonly model: infer ModelAlias extends string }
	? | { readonly alias: ModelAlias; readonly capability: AgentMainCapabilities<Agent> }
		| AgentEmbeddingModelEntry<Agent>
		| AgentSummaryModelEntry<Agent>
		| GuardrailModelEntries<Agent>
	: never
type WorkflowModelEntries<Workflow> = Workflow extends { readonly models: infer Models extends Readonly<Record<string, unknown>> }
	? Values<Models> extends infer Model
		? Model extends { readonly alias: infer Alias extends string; readonly capabilities: readonly (infer Capability)[] }
			? { readonly alias: Alias; readonly capability: Extract<Capability, ModelCapability> }
			: never
		: never
	: never
type ModelAliases<Entries> = Entries extends { readonly alias: infer Alias extends string } ? Alias : never
type ModelCapabilitiesFor<Entries, Alias extends string> = Entries extends {
	readonly alias: Alias
	readonly capability: infer Capability
} ? Extract<Capability, ModelCapability> : never
type RequirementModels<Entries> = Readonly<{
	[Alias in ModelAliases<Entries>]: Readonly<{ capabilities: readonly ModelCapabilitiesFor<Entries, Alias>[] }>
}>
type McpOwnerIds<Tool> = Tool extends McpToolDefinition<any, any, any, infer Owner> ? Owner['id'] : never
type HostToolIds<Tool> = Tool extends HostToolDefinition<infer Id, any, any, any> ? Id : never
type IsTrue<Value> = true extends Value ? true : false
type IsPresent<Value> = [Value] extends [never] ? false : true
type AgentSelectedToolIds<Agent> = Agent extends { readonly tools: readonly (infer Tool)[] }
	? Tool extends { readonly id: infer Id extends string } ? Id : never
	: never
type AgentSelectedTools<Agent> = Agent extends { readonly tools: readonly (infer Tool)[] } ? Tool : never
type AgentSelectedSkills<Agent> = Agent extends { readonly skills: readonly (infer Skill)[] } ? Skill : never
type ApprovalPermission<Value> = Extract<Value, 'require_approval' | { readonly mode: 'require_approval' }> extends never ? never : true
type AgentApproval<Agent> = Agent extends { readonly permissions: infer Permissions }
	? AgentSelectedToolIds<Agent> extends infer Id
		? Id extends keyof Permissions ? ApprovalPermission<Permissions[Id]> : never
		: never
	: never
type GovernancePolicyEffects<Agent> = Agent extends { readonly governance: { readonly policies?: readonly (infer Policy)[] } }
	? Policy extends { readonly kind: 'native'; readonly rules: readonly (infer Rule)[] }
		? Rule extends { readonly effect: infer Effect } ? Effect : never
		: Policy extends { readonly effects: readonly (infer Effect)[] } ? Effect : never
	: never
type AgentGovernanceApproval<Agent> = Extract<GovernancePolicyEffects<Agent>, 'require_approval'> extends never ? never : true
type AgentHostTool<Agent> = Agent extends { readonly tools: readonly (infer Tool)[] }
	? Tool extends HostToolDefinition<any, any, any, any> ? true : never
	: never
type AgentDurability<Agent> =
	| (Agent extends { readonly durable: true } ? true : never)
	| (Agent extends { readonly subagents: infer Subagents extends Readonly<Record<string, unknown>> }
		? keyof Subagents extends never ? never : true
		: never)
	| ([AgentGuardrailRequirements<Agent>] extends [never] ? never : AgentGuardrailRequirements<Agent> extends { readonly durable: true } ? true : never)
	| AgentApproval<Agent>
	| AgentGovernanceApproval<Agent>
	| AgentHostTool<Agent>
type WorkflowDurability<Workflow> = Workflow extends { readonly durable: true } ? true : never
type AgentWorkspace<Agent> =
	| (Agent extends { readonly workspace: true } ? true : never)
	| ([AgentGuardrailRequirements<Agent>] extends [never] ? never : AgentGuardrailRequirements<Agent> extends { readonly workspace: true } ? true : never)
type WorkflowWorkspace<Workflow> = Workflow extends { readonly workspace: true } ? true : never
type SandboxGroupOf<Definition> = Definition extends { readonly sandbox: { readonly group: infer Group extends string } } ? Group : never
type WorkflowChildSandboxGroups<Definition> = Definition extends { readonly childTaskSandboxGroups: readonly (infer Group extends string)[] } ? Group : never
type HasExplicitSandboxPolicy<Definition> = Definition extends { readonly sandbox: unknown } ? true : never
type HasWorkflowChildSandboxGroups<Definition> = Definition extends { readonly childTaskSandboxGroups: readonly [string, ...string[]] } ? true : never
type WorkspaceSandboxCapability<Agent, Workflow> = IsTrue<AgentWorkspace<Agent> | WorkflowWorkspace<Workflow>> extends true
	? 'sandbox.workspace_binding'
	: never
type GuardrailArtifacts<Agent> = [AgentGuardrailRequirements<Agent>] extends [never]
	? never
	: AgentGuardrailRequirements<Agent> extends { readonly artifacts: true } ? true : never
type AgentMedia<Agent> = AgentModelEntries<Agent> extends { readonly capability: infer Capability }
	? Extract<Capability, 'image_generation' | 'speech_generation' | 'video_generation'> extends never ? never : true
	: never
type WorkflowMedia<Workflow> = WorkflowModelEntries<Workflow> extends { readonly capability: infer Capability }
	? Extract<Capability, 'image_generation' | 'speech_generation' | 'video_generation'> extends never ? never : true
	: never

/** Exact static requirement projection for one complete typed catalog view. */
export type RuntimeRequirementsFor<
	Tools extends Readonly<Record<string, AnyNonMcpToolDefinition>>,
	Skills extends Readonly<Record<string, SkillDefinition>>,
	McpServers extends Readonly<Record<string, McpServerDefinition<any, any>>>,
	Agents extends Readonly<Record<string, AnyAgentDefinition>>,
	Workflows extends Readonly<Record<string, AnyWorkflowDefinition>>,
	SelectedMcpTools = never,
> = RuntimeRequirements<
	RequirementModels<AgentModelEntries<Values<Agents>> | WorkflowModelEntries<Values<Workflows>>>,
	(keyof McpServers & string) | McpOwnerIds<SelectedMcpTools | Extract<AgentSelectedTools<Values<Agents>>, McpToolDefinition>>,
		SkillRuntimes<Values<Skills> | Extract<AgentSelectedSkills<Values<Agents>>, SkillDefinition>> | Extract<GuardrailArrayMember<Values<Agents>, 'skillRuntimes'>, SkillRuntimeId>,
		ToolMemoryCapabilities<Values<Tools> | Extract<AgentSelectedTools<Values<Agents>>, AnyNonMcpToolDefinition>> | AgentMemoryCapabilities<Values<Agents>> | Extract<GuardrailArrayMember<Values<Agents>, 'memory'>, MemoryCapability>,
	AgentMemoryAliases<Values<Agents>>,
		ToolSandboxCapabilities<Values<Tools> | Extract<AgentSelectedTools<Values<Agents>>, AnyNonMcpToolDefinition>> | RuntimeSkillSandboxCapabilities<Values<Skills> | Extract<AgentSelectedSkills<Values<Agents>>, SkillDefinition>> | Extract<GuardrailArrayMember<Values<Agents>, 'sandbox'>, SandboxCapabilityId>
			| WorkspaceSandboxCapability<Values<Agents>, Values<Workflows>>,
		SandboxGroupOf<Values<Agents> | Values<Workflows>> | WorkflowChildSandboxGroups<Values<Workflows>>,
		IsPresent<
			ToolSandboxCapabilities<Values<Tools> | Extract<AgentSelectedTools<Values<Agents>>, AnyNonMcpToolDefinition>> | RuntimeSkillSandboxCapabilities<Values<Skills> | Extract<AgentSelectedSkills<Values<Agents>>, SkillDefinition>>
			| Extract<GuardrailArrayMember<Values<Agents>, 'sandbox'>, SandboxCapabilityId>
			| WorkspaceSandboxCapability<Values<Agents>, Values<Workflows>>
			| HasExplicitSandboxPolicy<Values<Agents> | Values<Workflows>>
			| HasWorkflowChildSandboxGroups<Values<Workflows>>
		>,
		HostToolIds<Values<Tools> | Extract<AgentSelectedTools<Values<Agents>>, AnyNonMcpToolDefinition>>,
		IsTrue<AgentDurability<Values<Agents>> | WorkflowDurability<Values<Workflows>>>,
		IsTrue<AgentWorkspace<Values<Agents>> | WorkflowWorkspace<Values<Workflows>>>,
		IsTrue<GuardrailArtifacts<Values<Agents>> | AgentMedia<Values<Agents>> | WorkflowMedia<Values<Workflows>>>
	>

/** @internal Definition maps consumed by canonical requirement derivation. */
export interface RuntimeRequirementSources {
	readonly tools: Readonly<Record<string, AnyNonMcpToolDefinition>>
	readonly skills: Readonly<Record<string, SkillDefinition>>
	readonly mcpServers: Readonly<Record<string, McpServerDefinition<any, any>>>
	readonly agents: Readonly<Record<string, AnyAgentDefinition>>
	readonly workflows: Readonly<Record<string, AnyWorkflowDefinition>>
}

/** @internal Derives and deeply freezes canonical runtime requirements. */
export function deriveRuntimeRequirements(sources: RuntimeRequirementSources, approval: CompiledApprovalInventory): RuntimeRequirements {
	const modelCapabilities = new Map<string, Set<ModelCapability>>()
	const memoryCapabilities = new Set<MemoryCapability>()
	const memoryModelAliases = new Set<string>()
	const sandboxCapabilities = new Set<SandboxCapabilityId>()
	const skillRuntimes = new Set<SkillRuntimeId>()
	const hostTools = new Set<string>()
	const sandboxGroups = new Set<string>()
	let durable = false
	let workspace = false
	let artifactsRequired = false
	let sandboxRequired = false

	const addModel = (alias: string, capabilities: readonly ModelCapability[]) => {
		const selected = modelCapabilities.get(alias) ?? new Set<ModelCapability>()
		for (const capability of capabilities) selected.add(capability)
		modelCapabilities.set(alias, selected)
	}

	for (const tool of Object.values(sources.tools)) {
		const identity = getDefinitionIdentity(tool)
		if (identity?.kind === 'host-tool') { hostTools.add(tool.id); durable = true }
		const requires = 'requires' in tool ? tool.requires : undefined
		for (const capability of requires?.memory ?? []) memoryCapabilities.add(capability)
		for (const capability of requires?.sandbox ?? []) sandboxCapabilities.add(capability)
	}
	for (const skill of Object.values(sources.skills)) {
		for (const runtime of skill.runtimes ?? []) skillRuntimes.add(runtime)
		if ((skill.runtimes?.length ?? 0) > 0) {
			sandboxRequired = true
			sandboxCapabilities.add('sandbox.fs')
			sandboxCapabilities.add('sandbox.readonly_mount')
		}
	}
	for (const agent of Object.values(sources.agents)) {
		const capabilities: ModelCapability[] = agent.contract.updates === 'text-delta'
			? ['text', 'text_stream']
			: ['object', 'object_stream']
		if ((agent.tools?.length ?? 0) > 0 || (agent.skills?.length ?? 0) > 0 || Object.keys(agent.subagents ?? {}).length > 0) capabilities.push('tool_use')
		capabilities.push(...(agent.inputCapabilities ?? []))
		addModel('model' in agent ? agent.model : 'primary', capabilities)

		for (const capability of agent.memory?.capabilities ?? []) memoryCapabilities.add(capability)
		if (agent.memory?.embedding !== undefined) {
			memoryModelAliases.add(agent.memory.embedding.model)
			addModel(agent.memory.embedding.model, ['embeddings'])
		}
		if (agent.memory?.summary !== undefined) {
			memoryModelAliases.add(agent.memory.summary.model)
			addModel(agent.memory.summary.model, ['object'])
		}
		const interceptor = agent.guardrails?.[agentGuardrailsBinding]
		for (const model of interceptor?.requirements?.models ?? []) addModel(model.alias, model.capabilities)
		for (const capability of interceptor?.requirements?.memory ?? []) memoryCapabilities.add(capability)
		for (const capability of interceptor?.requirements?.sandbox ?? []) sandboxCapabilities.add(capability)
		for (const runtime of interceptor?.requirements?.skillRuntimes ?? []) skillRuntimes.add(runtime)
		if (interceptor?.requirements?.durable === true) durable = true
		if (interceptor?.requirements?.workspace === true) workspace = true
		if (interceptor?.requirements?.artifacts === true) artifactsRequired = true
		if (approval.agents[agent.id]?.reachable === true) durable = true
		if (Object.keys(agent.subagents ?? {}).length > 0) durable = true
		if (agent.durable === true) durable = true
		if (agent.workspace === true) workspace = true
		if (agent.sandbox !== undefined) sandboxRequired = true
		if (typeof agent.sandbox === 'object') sandboxGroups.add(agent.sandbox.group)
	}
	for (const workflow of Object.values(sources.workflows)) {
		const models = Object.values(workflow.models ?? {}) as readonly Readonly<{
			alias: string
			capabilities: readonly ModelCapability[]
		}>[]
		for (const model of models) addModel(model.alias, model.capabilities)
		if (workflow.durable === true) durable = true
		if (approval.workflows[workflow.id]?.reachable === true) durable = true
		if (workflow.workspace === true) workspace = true
		if (workflow.sandbox !== undefined) sandboxRequired = true
		if (typeof workflow.sandbox === 'object') sandboxGroups.add(workflow.sandbox.group)
		for (const group of workflow.childTaskSandboxGroups ?? []) sandboxGroups.add(group)
		if ((workflow.childTaskSandboxGroups?.length ?? 0) > 0) sandboxRequired = true
	}
	if (workspace) sandboxCapabilities.add('sandbox.workspace_binding')
	if (sandboxCapabilities.size > 0 || skillRuntimes.size > 0 || workspace) sandboxRequired = true

	const models: Record<string, Readonly<{ capabilities: readonly ModelCapability[] }>> = {}
	for (const alias of [...modelCapabilities.keys()].sort()) {
		models[alias] = Object.freeze({ capabilities: sorted(modelCapabilities.get(alias)!) })
	}
	const artifacts = artifactsRequired || Object.values(models).some(model => model.capabilities.some(capability => (
		capability === 'image_generation' || capability === 'speech_generation' || capability === 'video_generation'
	)))

	return Object.freeze({
		models: Object.freeze(models),
		mcpServers: sorted(Object.keys(sources.mcpServers)),
		skillRuntimes: sorted(skillRuntimes),
		storage: Object.freeze({ durable }),
		memory: Object.freeze({ capabilities: sorted(memoryCapabilities), modelAliases: sorted(memoryModelAliases) }),
		sandbox: Object.freeze({ capabilities: sorted(sandboxCapabilities), requiredGroups: sorted(sandboxGroups), required: sandboxRequired }),
		workspace,
		artifacts,
		hostTools: sorted(hostTools),
	})
}

function sorted<T extends string>(values: Iterable<T>): readonly T[] {
	return Object.freeze([...values].sort())
}
