import { HarnessConfigError } from '../errors/index.js'
import type { Infer, InferIn, ModelSchema } from '../schema/index.js'
import { compileDefinitionGraph, type CompiledDefinitionGraph, type DefinitionGraphRoots } from '../runtime/compiled-graph.js'
import type { RuntimeRequirements, RuntimeRequirementsFor } from '../runtime/runtime-requirements.js'
import { assertDefinitionId, assertKnownFields, createDefinitionIdentity, freezeDefinition } from './identity.js'
import type { DefinitionReference } from './identity.js'
import type {
	AnyAgentDefinition,
	AnyNonMcpToolDefinition,
	AnyWorkflowDefinition,
	HarnessTargetContract,
	McpServerDefinition,
	McpToolDefinition,
	SkillDefinition,
} from './types.js'

type EmptyMap = Readonly<Record<never, never>>
declare class HarnessCatalogBrand<Id extends string> { private readonly __catalogDefinition: Id }
type IdMap<Values extends readonly { readonly id: string }[] | undefined> =
	Values extends readonly { readonly id: string }[]
		? Readonly<{ [Definition in Values[number] as Definition['id']]: Definition }>
		: EmptyMap
type ArrayValue<Values> = Values extends readonly unknown[] ? Values[number] : never
type MapValue<Map> = Map extends Readonly<Record<string, unknown>> ? Map[keyof Map] : never
type ReferencedAgent<Reference> = Reference extends AnyAgentDefinition
	? Reference
	: Reference extends { readonly agent: infer Agent extends AnyAgentDefinition } ? Agent : never
type DirectSubagents<Agent> = Agent extends { readonly subagents: infer Subagents extends Readonly<Record<string, unknown>> }
	? ReferencedAgent<MapValue<Subagents>>
	: never
type AgentClosure<Agent, SeenIds extends string = never> = Agent extends AnyAgentDefinition
	? Agent['id'] extends SeenIds ? never : Agent | AgentClosure<DirectSubagents<Agent>, SeenIds | Agent['id']>
	: never
type WorkflowAgents<Workflow> = Workflow extends { readonly agents: infer Agents extends Readonly<Record<string, AnyAgentDefinition>> }
	? MapValue<Agents>
	: never
type AllAgents<Agents, Workflows> = AgentClosure<ArrayValue<Agents> | WorkflowAgents<ArrayValue<Workflows>>>
type AgentTools<Agent> = Agent extends { readonly tools: infer Tools extends readonly unknown[] } ? ArrayValue<Tools> : never
type AgentSkills<Agent> = Agent extends { readonly skills: infer Skills extends readonly unknown[] } ? ArrayValue<Skills> : never
type AllTools<Tools, Agents> = ArrayValue<Tools> | AgentTools<Agents>
type AllNonMcpTools<Tools, Agents> = Extract<AllTools<Tools, Agents>, AnyNonMcpToolDefinition>
type AllMcpTools<Tools, Agents> = Extract<AllTools<Tools, Agents>, McpToolDefinition>
type AllSkills<Skills, Agents> = Extract<ArrayValue<Skills> | AgentSkills<Agents>, SkillDefinition>
type DefinitionIds<Definitions> = Definitions extends { readonly id: infer Id extends string } ? Id : never
type UnionIdMap<Definitions> = Readonly<{
	[Id in DefinitionIds<Definitions>]: Extract<Definitions, { readonly id: Id }>
}>
type McpOwner<Tool> = Tool extends McpToolDefinition<any, any, any, infer Owner> ? Owner : never
type InferredMcpServers<Tools> = UnionIdMap<McpOwner<Tools>>
type MergeMaps<Left, Right> = Readonly<Omit<Left, keyof Right> & Right>

/** Exact target contracts derived from the definitions in a catalog. */
export type HarnessContracts<
	Agents extends Readonly<Record<string, AnyAgentDefinition>> = Readonly<Record<string, AnyAgentDefinition>>,
	Workflows extends Readonly<Record<string, AnyWorkflowDefinition>> = Readonly<Record<string, AnyWorkflowDefinition>>,
> = Readonly<{
	agents: Readonly<{ [Key in keyof Agents]: Agents[Key]['contract'] }>
	workflows: Readonly<{ [Key in keyof Workflows]: Workflows[Key]['contract'] }>
}>

type AnyHarnessTargetContract = HarnessTargetContract<any, any, ModelSchema, ModelSchema, any, any>

/** Input and output types inferred from an exact map of target contracts. */
export type HarnessTargetInferMap<Targets extends Readonly<Record<string, AnyHarnessTargetContract>>> = Readonly<{
	[Key in keyof Targets]: Readonly<{
		input: InferIn<Targets[Key]['input']>
		output: Infer<Targets[Key]['output']>
	}>
}>

/** Compile-time invocation and runtime-requirement projection of a Harness. */
export type HarnessInfer<
	Contracts extends HarnessContracts<any, any>,
	Requirements extends RuntimeRequirements,
> = Readonly<{
	agents: HarnessTargetInferMap<Contracts['agents']>
	workflows: HarnessTargetInferMap<Contracts['workflows']>
	requirements: Requirements
}>

/** Immutable typed view of a complete compiled definition graph. */
export interface HarnessCatalogView<
	Tools extends Readonly<Record<string, AnyNonMcpToolDefinition>> = Readonly<Record<string, AnyNonMcpToolDefinition>>,
	Skills extends Readonly<Record<string, SkillDefinition>> = Readonly<Record<string, SkillDefinition>>,
	McpServers extends Readonly<Record<string, McpServerDefinition<any, any>>> = Readonly<Record<string, McpServerDefinition<any, any>>>,
	Agents extends Readonly<Record<string, AnyAgentDefinition>> = Readonly<Record<string, AnyAgentDefinition>>,
	Workflows extends Readonly<Record<string, AnyWorkflowDefinition>> = Readonly<Record<string, AnyWorkflowDefinition>>,
	Requirements extends RuntimeRequirements = RuntimeRequirements,
> {
	readonly tools: Tools
	readonly skills: Skills
	readonly mcpServers: McpServers
	readonly agents: Agents
	readonly workflows: Workflows
	readonly contracts: HarnessContracts<Agents, Workflows>
	readonly requirements: Requirements
}

/** Frozen reusable definition package. */
export type HarnessCatalogDefinition<
	Id extends string,
	View extends HarnessCatalogView,
> = Readonly<{ readonly kind: 'catalog'; readonly id: Id }> & View & DefinitionReference<'catalog', Id> & HarnessCatalogBrand<Id>

/** Concise array authoring input for one reusable catalog. */
export interface CatalogOptions<
	Tools extends readonly AnyNonMcpToolDefinition[] | undefined = undefined,
	Skills extends readonly SkillDefinition[] | undefined = undefined,
	McpServers extends readonly McpServerDefinition<any, any>[] | undefined = undefined,
	Agents extends readonly AnyAgentDefinition[] | undefined = undefined,
	Workflows extends readonly AnyWorkflowDefinition[] | undefined = undefined,
> {
	readonly tools?: Tools
	readonly skills?: Skills
	readonly mcpServers?: McpServers
	readonly agents?: Agents
	readonly workflows?: Workflows
}

export type CatalogViewForRoots<
	Tools extends readonly AnyNonMcpToolDefinition[] | undefined,
	Skills extends readonly SkillDefinition[] | undefined,
	McpServers extends readonly McpServerDefinition<any, any>[] | undefined,
	Agents extends readonly AnyAgentDefinition[] | undefined,
	Workflows extends readonly AnyWorkflowDefinition[] | undefined,
	AgentDefinitions extends AnyAgentDefinition = AllAgents<Agents, Workflows>,
	ToolDefinitions = AllTools<Tools, AgentDefinitions>,
	NonMcpTools extends AnyNonMcpToolDefinition = AllNonMcpTools<Tools, AgentDefinitions>,
	McpTools extends McpToolDefinition = AllMcpTools<Tools, AgentDefinitions>,
	ToolMap extends Readonly<Record<string, AnyNonMcpToolDefinition>> = UnionIdMap<NonMcpTools>,
	SkillMap extends Readonly<Record<string, SkillDefinition>> = UnionIdMap<AllSkills<Skills, AgentDefinitions>>,
	ExplicitMcpMap extends Readonly<Record<string, McpServerDefinition<any, any>>> = IdMap<McpServers>,
	McpMap extends Readonly<Record<string, McpServerDefinition<any, any>>> = MergeMaps<InferredMcpServers<McpTools>, ExplicitMcpMap>,
	AgentMap extends Readonly<Record<string, AnyAgentDefinition>> = UnionIdMap<AgentDefinitions>,
	WorkflowMap extends Readonly<Record<string, AnyWorkflowDefinition>> = IdMap<Workflows>,
> = HarnessCatalogView<
	ToolMap,
	SkillMap,
	McpMap,
	AgentMap,
	WorkflowMap,
	RuntimeRequirementsFor<ToolMap, SkillMap, McpMap, AgentMap, WorkflowMap, McpTools>
>

/**
 * Packages immutable definitions in exact readonly id-keyed maps.
 * Dependencies are collected recursively by hidden identity.
 *
 * @example
 * ```ts
 * const catalog = defineCatalog('support', { agents: [supportAgent] })
 * const harness = defineHarness({ name: 'app' }).use(catalog)
 * ```
 */
export function defineCatalog<
	const Id extends string,
	const Tools extends readonly AnyNonMcpToolDefinition[] | undefined = undefined,
	const Skills extends readonly SkillDefinition[] | undefined = undefined,
	const McpServers extends readonly McpServerDefinition<any, any>[] | undefined = undefined,
	const Agents extends readonly AnyAgentDefinition[] | undefined = undefined,
	const Workflows extends readonly AnyWorkflowDefinition[] | undefined = undefined,
>(
	id: Id,
	options: CatalogOptions<Tools, Skills, McpServers, Agents, Workflows>,
): HarnessCatalogDefinition<Id, CatalogViewForRoots<Tools, Skills, McpServers, Agents, Workflows>> {
	assertDefinitionId(id, 'catalog.id')
	if (typeof options !== 'object' || options === null || Array.isArray(options)) {
		throw new HarnessConfigError('Catalog options must be an object.', {
			reason: 'foreign_definition', path: 'catalog', id,
		})
	}
	assertKnownFields(options, ['tools', 'skills', 'mcpServers', 'agents', 'workflows'], 'catalog', id)
	for (const [field, values] of Object.entries(options)) {
		if (!Array.isArray(values)) {
			throw new HarnessConfigError('Catalog definition groups must be arrays.', {
				reason: 'foreign_definition', path: `catalog.${field}`, id,
			})
		}
	}
	const graph = compileDefinitionGraph(options as DefinitionGraphRoots)
	return freezeDefinition(
		{ kind: 'catalog' as const, id, ...createCatalogView(graph) },
		createDefinitionIdentity('catalog', id),
	) as HarnessCatalogDefinition<
		Id,
		CatalogViewForRoots<Tools, Skills, McpServers, Agents, Workflows>
	>
}

/** @internal Builds a public authoring view from one private compiled graph. */
export function createCatalogView(graph: CompiledDefinitionGraph): HarnessCatalogView {
	const agentContracts = Object.freeze(Object.fromEntries(
		Object.entries(graph.agents).map(([id, agent]) => [id, agent.contract]),
	))
	const workflowContracts = Object.freeze(Object.fromEntries(
		Object.entries(graph.workflows).map(([id, workflow]) => [id, workflow.contract]),
	))
	return Object.freeze({
		tools: graph.tools,
		skills: graph.skills,
		mcpServers: graph.mcpServers,
		agents: graph.agents,
		workflows: graph.workflows,
		contracts: Object.freeze({ agents: agentContracts, workflows: workflowContracts }),
		requirements: graph.requirements,
	})
}
