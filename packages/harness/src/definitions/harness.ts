import { HarnessConfigError } from '../errors/index.js'
import { compileDefinitionGraph, type DefinitionGraphRoots } from '../runtime/compiled-graph.js'
import type { RuntimeRequirements, RuntimeRequirementsFor } from '../runtime/runtime-requirements.js'
import { instantiateStandaloneHarness, type HarnessInstance } from '../runtime/standalone-instance.js'
import { validateHarnessInstanceConfig, type HarnessInstanceConfig } from '../runtime/instance-config.js'
import {
	resolveHarnessExecutionDefaults,
	type HarnessExecutionDefaults,
	type ResolvedHarnessExecutionDefaults,
} from '../runtime/execution-defaults.js'
import {
	assertDefinitionId,
	assertKnownFields,
	createDefinitionIdentity,
	freezeDefinition,
	getDefinitionIdentity,
	sameDefinitionIdentity,
} from './identity.js'
import type { DefinitionReference } from './identity.js'
import {
	createCatalogView,
	type CatalogDependencyClosure,
	type CatalogViewForRoots,
	type HarnessCatalogDefinition,
	type HarnessCatalogView,
	type HarnessContracts,
	type HarnessInfer,
} from './catalog.js'
import type {
	AnyAgentDefinition,
	AnyWorkflowDefinition,
	HarnessInterruptKind,
	HarnessOutputUpdateKind,
	HarnessTargetKind,
} from './types.js'

type MergeMaps<Left, Right> = Readonly<Omit<Left, keyof Right> & Right>
declare class HarnessDefinitionBrand<Name extends string> { private readonly __harnessDefinition: Name }

type MergedTools<Left extends HarnessCatalogView, Right extends HarnessCatalogView> = MergeMaps<Left['tools'], Right['tools']>
type MergedSkills<Left extends HarnessCatalogView, Right extends HarnessCatalogView> = MergeMaps<Left['skills'], Right['skills']>
type MergedMcp<Left extends HarnessCatalogView, Right extends HarnessCatalogView> = MergeMaps<Left['mcpServers'], Right['mcpServers']>
type MergedAgents<Left extends HarnessCatalogView, Right extends HarnessCatalogView> = MergeMaps<Left['agents'], Right['agents']>
type MergedWorkflows<Left extends HarnessCatalogView, Right extends HarnessCatalogView> = MergeMaps<Left['workflows'], Right['workflows']>
type MergedDependencyClosure<Left extends HarnessCatalogView, Right extends HarnessCatalogView> = CatalogDependencyClosure<Left> | CatalogDependencyClosure<Right>
type ClosureAgentMap<Closure> = Readonly<Record<string, Extract<Closure, AnyAgentDefinition>>>
type MapValue<Map> = Map extends Readonly<Record<string, unknown>> ? Map[keyof Map] : never
type ArrayValue<Values> = Values extends readonly unknown[] ? Values[number] : never
type ReferencedAgent<Reference> = Reference extends AnyAgentDefinition
	? Reference
	: Reference extends { readonly agent: infer Agent extends AnyAgentDefinition } ? Agent : never
type DirectSubagents<Agent> = Agent extends { readonly subagents: infer Subagents extends Readonly<Record<string, unknown>> }
	? ReferencedAgent<MapValue<Subagents>>
	: never
type AgentClosure<Agent, SeenIds extends string = never> = Agent extends AnyAgentDefinition
	? Agent['id'] extends SeenIds ? never : Agent | AgentClosure<DirectSubagents<Agent>, SeenIds | Agent['id']>
	: never
type WorkflowAgents<Workflow> = Workflow extends { readonly agents: infer Agents extends readonly AnyAgentDefinition[] }
	? ArrayValue<Agents>
	: never
type CompiledAgents<Catalog extends HarnessCatalogView> = AgentClosure<
	MapValue<Catalog['agents']> | WorkflowAgents<MapValue<Catalog['workflows']>>
>
/** @internal Exact recursively compiled graph retained for hosted target inference. */
export interface HarnessGraphView<
	Tools extends HarnessCatalogView['tools'] = HarnessCatalogView['tools'],
	Skills extends HarnessCatalogView['skills'] = HarnessCatalogView['skills'],
	McpServers extends HarnessCatalogView['mcpServers'] = HarnessCatalogView['mcpServers'],
	Agents extends HarnessCatalogView['agents'] = HarnessCatalogView['agents'],
	Workflows extends HarnessCatalogView['workflows'] = HarnessCatalogView['workflows'],
	Requirements extends RuntimeRequirements = RuntimeRequirements,
> {
	readonly tools: Tools
	readonly skills: Skills
	readonly mcpServers: McpServers
	readonly agents: Agents
	readonly workflows: Workflows
	readonly requirements: Requirements
}
type HarnessGraphForCatalog<Catalog extends HarnessCatalogView> = HarnessGraphView<
	Catalog['tools'], Catalog['skills'], Catalog['mcpServers'],
	ClosureAgentMap<CompiledAgents<Catalog>>, Catalog['workflows'], Catalog['requirements']
>
declare const harnessCompiledGraphType: unique symbol
type MergeCatalogViews<Left extends HarnessCatalogView, Right extends HarnessCatalogView> = HarnessCatalogView<
	MergedTools<Left, Right>,
	MergedSkills<Left, Right>,
	MergedMcp<Left, Right>,
	MergedAgents<Left, Right>,
	MergedWorkflows<Left, Right>,
	RuntimeRequirementsFor<
		Readonly<Record<never, never>>, Readonly<Record<never, never>>, Readonly<Record<never, never>>,
		ClosureAgentMap<MergedDependencyClosure<Left, Right>>, MergedWorkflows<Left, Right>
	>,
	MergedDependencyClosure<Left, Right>
>

type WithAgent<Catalog extends HarnessCatalogView, Agent extends AnyAgentDefinition> = MergeCatalogViews<
	Catalog, CatalogViewForRoots<undefined, undefined, undefined, readonly [Agent], undefined>
>
type WithWorkflow<Catalog extends HarnessCatalogView, Workflow extends AnyWorkflowDefinition> = MergeCatalogViews<
	Catalog, CatalogViewForRoots<undefined, undefined, undefined, undefined, readonly [Workflow]>
>
type HasExplicitRoot<Roots extends Readonly<Record<string, AnyAgentDefinition | AnyWorkflowDefinition>>> = [keyof Roots] extends [never]
	? false
	: string extends keyof Roots ? false : true
type CatalogHasExecutableRoot<Catalog extends HarnessCatalogView> = Catalog extends HarnessCatalogView
	? HasExplicitRoot<Catalog['agents']> extends true ? true : HasExplicitRoot<Catalog['workflows']>
	: false
type EveryCatalogHasExecutableRoot<Catalog extends HarnessCatalogView> = [Catalog] extends [never]
	? false
	: [CatalogHasExecutableRoot<Catalog>] extends [true] ? true : false
type ExecutableCatalogDefinition<Id extends string, Catalog extends HarnessCatalogView> =
	EveryCatalogHasExecutableRoot<Catalog> extends true ? HarnessCatalogDefinition<Id, Catalog> : never
type UsedCatalogDefinition<Catalog extends HarnessCatalogView, Other extends HarnessCatalogView, Name extends string> =
	Other extends HarnessCatalogView ? HarnessDefinition<MergeCatalogViews<Catalog, Other>, Name> : never

type EmptyCatalogView = HarnessCatalogView<
	Readonly<Record<never, never>>, Readonly<Record<never, never>>, Readonly<Record<never, never>>,
	Readonly<Record<never, never>>, Readonly<Record<never, never>>,
	RuntimeRequirementsFor<
		Readonly<Record<never, never>>, Readonly<Record<never, never>>, Readonly<Record<never, never>>,
		Readonly<Record<never, never>>, Readonly<Record<never, never>>
	>,
	never
>

/** Data-only inspection of one executable Harness target. */
export interface HarnessTargetInspection {
	readonly kind: HarnessTargetKind
	readonly id: string
	readonly executionModes: readonly ['run', 'stream']
	readonly updates: HarnessOutputUpdateKind
	readonly interrupts: readonly HarnessInterruptKind[]
}

/** Sanitized immutable definition and requirement projection. */
export interface HarnessInspection<Requirements extends RuntimeRequirements = RuntimeRequirements> {
	readonly kind: 'harness'
	readonly name: string
	readonly roots: Readonly<{
		agents: readonly HarnessTargetInspection[]
		workflows: readonly HarnessTargetInspection[]
	}>
	readonly dependencies: Readonly<{
		tools: readonly string[]
		skills: readonly string[]
		mcpServers: readonly string[]
		agents: readonly string[]
		workflows: readonly string[]
	}>
	readonly requirements: Requirements
}

/** Immutable composable Harness definition. Runtime binding is added by the instance configuration layer. */
export type HarnessDefinition<
	Catalog extends HarnessCatalogView,
	Name extends string = string,
	Graph extends HarnessGraphView = HarnessGraphForCatalog<Catalog>,
> = {
	readonly kind: 'harness'
	readonly name: Name
	readonly revision?: string
	readonly defaults: Readonly<ResolvedHarnessExecutionDefaults>
	readonly contracts: Catalog['contracts']
	readonly requirements: Catalog['requirements']
	/** @internal Invariant type-only marker for the exact recursively compiled graph. */
	readonly [harnessCompiledGraphType]: (graph: Graph) => Graph
	readonly $infer: HarnessInfer<Catalog['contracts'], Catalog['requirements']>
	inspect(): HarnessInspection<Catalog['requirements']>
	getInstance<const AdditionalGroups extends readonly string[] = readonly []>(
		config: HarnessInstanceConfig<Catalog['requirements'], AdditionalGroups>,
	): Promise<HarnessInstance<Catalog['contracts'], Catalog['requirements']>>
	use<Other extends HarnessCatalogView>(
		catalog: ExecutableCatalogDefinition<string, Other>,
	): UsedCatalogDefinition<Catalog, Other, Name>
	addAgent<Agent extends AnyAgentDefinition>(agent: Agent): HarnessDefinition<WithAgent<Catalog, Agent>, Name>
	addWorkflow<Workflow extends AnyWorkflowDefinition>(workflow: Workflow): HarnessDefinition<WithWorkflow<Catalog, Workflow>, Name>
} & DefinitionReference<'harness', Name> & HarnessDefinitionBrand<Name>

/** Definition-time Harness options. */
export interface HarnessOptions<Name extends string = string> {
	readonly name: Name
	readonly revision?: string
	readonly defaults?: HarnessExecutionDefaults
}

const inferPhantom = Object.freeze({})
type CatalogProvenance = readonly HarnessCatalogDefinition<string, HarnessCatalogView>[]
const harnessRuntimeBlueprint = Symbol('@purista/harness/runtime-blueprint')

/** @internal Exact compiled state retained by a package-owned Harness definition. */
export interface HarnessRuntimeBlueprint {
	readonly name: string
	readonly revision?: string
	readonly defaults: Readonly<ResolvedHarnessExecutionDefaults>
	readonly graph: ReturnType<typeof compileDefinitionGraph>
}

/** @internal Reads the private compiled graph without recompiling the public catalog. */
export function getHarnessRuntimeBlueprint(value: unknown): HarnessRuntimeBlueprint | undefined {
	if (getDefinitionIdentity(value)?.kind !== 'harness' || typeof value !== 'object' || value === null) return undefined
	return (value as { readonly [harnessRuntimeBlueprint]?: HarnessRuntimeBlueprint })[harnessRuntimeBlueprint]
}

/**
 * Starts one immutable Harness definition without a terminal build step.
 *
 * @example
 * ```ts
 * const definition = defineHarness({ name: 'support' }).addAgent(supportAgent)
 * const instance = await definition.getInstance({ model: { provider, model: 'gpt-5' } })
 * ```
 */
export function defineHarness<const Name extends string>(options: HarnessOptions<Name>): HarnessDefinition<EmptyCatalogView, Name> {
	if (typeof options !== 'object' || options === null || Array.isArray(options)) throw invalidHarnessOptions()
	assertKnownFields(options, ['name', 'revision', 'defaults'], 'harness', typeof options.name === 'string' ? options.name : '')
	assertDefinitionId(options.name, 'harness.name')
	if (options.revision !== undefined) assertRevision(options.revision)
	const defaults = resolveHarnessExecutionDefaults(options.defaults)
	return createHarnessDefinition(options.name, {}, Object.freeze([]), options.revision, defaults) as HarnessDefinition<EmptyCatalogView, Name>
}

function createHarnessDefinition<Catalog extends HarnessCatalogView, Name extends string>(
	name: Name,
	roots: DefinitionGraphRoots,
	catalogProvenance: CatalogProvenance = Object.freeze([]),
	revision?: string,
	defaults: Readonly<ResolvedHarnessExecutionDefaults> = resolveHarnessExecutionDefaults(),
): HarnessDefinition<Catalog, Name> {
	const graph = compileDefinitionGraph(roots)
	const catalog = createCatalogView(graph, roots) as Catalog
	if (catalog.requirements.storage.durable && revision === undefined) {
		throw new HarnessConfigError('A deployment revision is required for a resumable Harness.', {
			reason: 'missing_harness_revision', path: 'harness.revision', id: name,
		})
	}
	const withRoots = (addition: DefinitionGraphRoots, provenance: CatalogProvenance = catalogProvenance) => (
		createHarnessDefinition(name, mergeRoots(catalog, addition), provenance, revision, defaults)
	)
	const value = {
		kind: 'harness',
		name,
		...(revision === undefined ? {} : { revision }),
		defaults,
		contracts: catalog.contracts,
		requirements: catalog.requirements,
		$infer: inferPhantom as HarnessInfer<Catalog['contracts'], Catalog['requirements']>,
		inspect: () => inspectHarness(name, catalog, graph),
		getInstance: (config: HarnessInstanceConfig<Catalog['requirements'], readonly string[]>) => instantiateStandaloneHarness({
			name, ...(revision === undefined ? {} : { revision }), defaults, graph,
			bindings: validateHarnessInstanceConfig(graph.requirements, config),
		}) as Promise<HarnessInstance<Catalog['contracts'], Catalog['requirements']>>,
		use: (other: HarnessCatalogDefinition<string, HarnessCatalogView>) => {
			const identity = getDefinitionIdentity(other)
			if (identity?.kind !== 'catalog' || !Object.isFrozen(other)) throw foreignCatalog()
			if (Object.keys(other.agents).length === 0 && Object.keys(other.workflows).length === 0) throw emptyCatalog()
			return withRoots(catalogRoots(other), addCatalogProvenance(catalogProvenance, other)) as never
		},
		addAgent: (agent: AnyAgentDefinition) => withRoots({ agents: [agent] }) as never,
		addWorkflow: (workflow: AnyWorkflowDefinition) => withRoots({ workflows: [workflow] }) as never,
	}
	Object.defineProperty(value, '$infer', {
		value: inferPhantom, enumerable: false, configurable: false, writable: false,
	})
	Object.defineProperty(value, harnessRuntimeBlueprint, {
		value: Object.freeze({ name, ...(revision === undefined ? {} : { revision }), defaults, graph }),
		enumerable: false, configurable: false, writable: false,
	})
	return freezeDefinition(value, createDefinitionIdentity('harness', name)) as unknown as HarnessDefinition<Catalog, Name>
}

function addCatalogProvenance(
	provenance: CatalogProvenance,
	catalog: HarnessCatalogDefinition<string, HarnessCatalogView>,
): CatalogProvenance {
	for (const existing of provenance) {
		if (sameDefinitionIdentity(existing, catalog)) return provenance
		if (existing.id === catalog.id) {
			throw new HarnessConfigError('Catalog definition identity is duplicated.', {
				reason: 'duplicate_definition', path: `catalog.${catalog.id}`, id: catalog.id,
			})
		}
	}
	return Object.freeze([...provenance, catalog])
}

function catalogRoots(catalog: HarnessCatalogView): DefinitionGraphRoots {
	return {
		agents: Object.values(catalog.agents),
		workflows: Object.values(catalog.workflows),
	}
}

function mergeRoots(catalog: HarnessCatalogView, addition: DefinitionGraphRoots): DefinitionGraphRoots {
	const roots = catalogRoots(catalog)
	return {
		agents: [...(roots.agents ?? []), ...(addition.agents ?? [])],
		workflows: [...(roots.workflows ?? []), ...(addition.workflows ?? [])],
	}
}

function inspectHarness<Requirements extends RuntimeRequirements>(
	name: string,
	catalog: HarnessCatalogView<any, any, any, any, any, Requirements>,
	graph: ReturnType<typeof compileDefinitionGraph>,
): HarnessInspection<Requirements> {
	const targetRows = (contracts: Readonly<Record<string, HarnessContracts['agents'][string]>>) => Object.freeze(
		Object.values(contracts).map(contract => Object.freeze({
			kind: contract.kind,
			id: contract.id,
			executionModes: Object.freeze([...contract.executionModes].sort()) as unknown as readonly ['run', 'stream'],
			updates: contract.updates,
			interrupts: Object.freeze([...contract.interrupts].sort()),
		})),
	)
	return Object.freeze({
		kind: 'harness' as const,
		name,
		roots: Object.freeze({
			agents: targetRows(catalog.contracts.agents),
			workflows: targetRows(catalog.contracts.workflows),
		}),
		dependencies: Object.freeze({
			tools: frozenKeys(graph.tools), skills: frozenKeys(graph.skills), mcpServers: frozenKeys(graph.mcpServers),
			agents: frozenDifference(graph.agents, catalog.agents), workflows: frozenDifference(graph.workflows, catalog.workflows),
		}),
		requirements: catalog.requirements,
	})
}

function frozenKeys(value: Readonly<Record<string, unknown>>): readonly string[] {
	return Object.freeze(Object.keys(value).sort())
}

function frozenDifference(value: Readonly<Record<string, unknown>>, roots: Readonly<Record<string, unknown>>): readonly string[] {
	return Object.freeze(Object.keys(value).filter(key => !(key in roots)).sort())
}

function invalidHarnessOptions(): HarnessConfigError {
	return new HarnessConfigError('Harness options must contain a valid name.', {
		reason: 'invalid_definition_id', path: 'harness.name',
	})
}

function assertRevision(value: unknown): asserts value is string {
	if (typeof value !== 'string' || Array.from(value).length < 1 || Array.from(value).length > 128 || /\p{Cc}/u.test(value)) {
		throw new HarnessConfigError('Harness revision is invalid.', {
			reason: 'invalid_harness_revision', path: 'harness.revision',
		})
	}
}

function foreignCatalog(): HarnessConfigError {
	return new HarnessConfigError('Harness catalogs must be created by defineCatalog.', {
		reason: 'foreign_definition', path: 'harness.catalog',
	})
}

function emptyCatalog(): HarnessConfigError {
	return new HarnessConfigError('A catalog used by Harness must expose an executable target.', {
		reason: 'catalog_has_no_targets', path: 'harness.use',
	})
}
