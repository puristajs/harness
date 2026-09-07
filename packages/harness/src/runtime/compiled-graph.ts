import { HarnessConfigError } from '../errors/index.js'
import { agentGuardrailsBinding } from '../agents/guardrails.js'
import { agentExecutionRequirementsSchema } from '../harness/agent-requirements.js'
import {
	getDefinitionIdentity,
	sameDefinitionIdentity,
	type DefinitionIdentity,
} from '../definitions/identity.js'
import type {
	AnyAgentDefinition,
	AnyNonMcpToolDefinition,
	AnyToolDefinition,
	AnyWorkflowDefinition,
	McpServerDefinition,
	McpToolDefinition,
	SkillDefinition,
} from '../definitions/types.js'
import { deriveRuntimeRequirements, type RuntimeRequirements } from './runtime-requirements.js'

/** @internal Definition roots accepted by the canonical graph compiler. */
export interface DefinitionGraphRoots {
	readonly tools?: readonly AnyNonMcpToolDefinition[]
	readonly skills?: readonly SkillDefinition[]
	readonly mcpServers?: readonly McpServerDefinition<any, any>[]
	readonly agents?: readonly AnyAgentDefinition[]
	readonly workflows?: readonly AnyWorkflowDefinition[]
}

type DefinitionNode =
	| AnyNonMcpToolDefinition
	| McpToolDefinition
	| SkillDefinition
	| McpServerDefinition<any, any>
	| AnyAgentDefinition
	| AnyWorkflowDefinition

/** @internal Dependency record used by the cycle-fixture seam. */
export interface DefinitionDependencies {
	readonly dependencies: readonly DefinitionNode[]
	readonly subagents?: readonly AnyAgentDefinition[]
}

/** @internal Identity-aware dependency reader. Public factories always use the default reader. */
export type DefinitionDependencyReader = (definition: DefinitionNode) => DefinitionDependencies

/** @internal Immutable result shared by catalog and direct Harness composition. */
export interface CompiledDefinitionGraph {
	readonly tools: Readonly<Record<string, AnyNonMcpToolDefinition>>
	readonly skills: Readonly<Record<string, SkillDefinition>>
	readonly mcpServers: Readonly<Record<string, McpServerDefinition<any, any>>>
	readonly agents: Readonly<Record<string, AnyAgentDefinition>>
	readonly workflows: Readonly<Record<string, AnyWorkflowDefinition>>
	readonly requirements: RuntimeRequirements
	readonly approval: CompiledApprovalInventory
}

/** @internal Compiler-owned approval reachability for executable roots. */
export interface CompiledApprovalInventory {
	readonly agents: Readonly<Record<string, Readonly<{ reachable: boolean; agentIds: readonly string[] }>>>
	readonly workflows: Readonly<Record<string, Readonly<{ reachable: boolean; agentIds: readonly string[] }>>>
}

/** @internal Default dependency reader for immutable public definitions. */
export const readDefinitionDependencies: DefinitionDependencyReader = definition => {
	const identity = getDefinitionIdentity(definition)
	if (identity?.kind === 'mcp-tool') {
		return { dependencies: identity.owner === undefined ? [] : [identity.owner as McpServerDefinition<any, any>] }
	}
	if (identity?.kind === 'mcp-server') {
		return { dependencies: Object.values((definition as McpServerDefinition<any, any>).tools) }
	}
	if (identity?.kind === 'agent') {
		const agent = definition as AnyAgentDefinition
		const subagents = Object.values(agent.subagents ?? {}).map(reference => (
			'agent' in reference ? reference.agent : reference
		))
		return {
			dependencies: [...(agent.tools ?? []), ...(agent.skills ?? []), ...subagents],
			subagents,
		}
	}
	if (identity?.kind === 'workflow') {
		return { dependencies: Object.values((definition as AnyWorkflowDefinition).agents ?? {}) }
	}
	return { dependencies: [] }
}

/**
 * @internal Compiles one complete immutable graph in collection and validation phases.
 * The optional reader exists solely for package tests that must forge cycles.
 */
export function compileDefinitionGraph(
	roots: DefinitionGraphRoots,
	dependencyReader: DefinitionDependencyReader = readDefinitionDependencies,
): CompiledDefinitionGraph {
	const byToken = new Map<object, DefinitionNode>()
	const pending: DefinitionNode[] = rootValues(roots)
	const strictPublicShape = dependencyReader === readDefinitionDependencies

	// Phase one: collect the complete recursive closure by private identity.
	while (pending.length > 0) {
		const definition = pending.pop()!
		const identity = requireIdentity(definition)
		if (byToken.has(identity.token)) continue
		byToken.set(identity.token, definition)
		pending.push(...dependencyReader(definition).dependencies)
	}

	// Phase two: validate the completed closure before deriving any public view.
	if (strictPublicShape) {
		for (const definition of byToken.values()) assertDefinitionShape(definition, requireIdentity(definition))
	}
	validateDefinitionCollisions(byToken.values())
	validateAgentCycles(byToken.values(), dependencyReader)
	if (strictPublicShape) validateAgentNamesAndReferences(byToken.values())

	const tools = definitionMap(byToken.values(), ['tool', 'built-in-tool', 'host-tool']) as Readonly<Record<string, AnyNonMcpToolDefinition>>
	const skills = definitionMap(byToken.values(), ['skill']) as Readonly<Record<string, SkillDefinition>>
	const mcpServers = definitionMap(byToken.values(), ['mcp-server']) as Readonly<Record<string, McpServerDefinition<any, any>>>
	const agents = definitionMap(byToken.values(), ['agent']) as Readonly<Record<string, AnyAgentDefinition>>
	const workflows = definitionMap(byToken.values(), ['workflow']) as Readonly<Record<string, AnyWorkflowDefinition>>
	const executable = collectExecutableClosure(roots, dependencyReader)
	const executableTools = definitionMap(executable, ['tool', 'built-in-tool', 'host-tool']) as Readonly<Record<string, AnyNonMcpToolDefinition>>
	const executableSkills = definitionMap(executable, ['skill']) as Readonly<Record<string, SkillDefinition>>
	const executableMcpServers = definitionMap(executable, ['mcp-server']) as Readonly<Record<string, McpServerDefinition<any, any>>>
	const executableAgents = definitionMap(executable, ['agent']) as Readonly<Record<string, AnyAgentDefinition>>
	const executableWorkflows = definitionMap(executable, ['workflow']) as Readonly<Record<string, AnyWorkflowDefinition>>
	const approval = compileApprovalInventory(executableAgents, executableWorkflows)
	const requirements = deriveRuntimeRequirements({
		tools: executableTools, skills: executableSkills, mcpServers: executableMcpServers,
		agents: executableAgents, workflows: executableWorkflows,
	}, approval)

	return Object.freeze({ tools, skills, mcpServers, agents, workflows, requirements, approval })
}

function collectExecutableClosure(roots: DefinitionGraphRoots, dependencyReader: DefinitionDependencyReader): Iterable<DefinitionNode> {
	const byToken = new Map<object, DefinitionNode>()
	const pending: DefinitionNode[] = [...(roots.agents ?? []), ...(roots.workflows ?? [])]
	while (pending.length > 0) {
		const definition = pending.pop()!
		const identity = requireIdentity(definition)
		if (byToken.has(identity.token)) continue
		byToken.set(identity.token, definition)
		pending.push(...dependencyReader(definition).dependencies)
	}
	return Object.freeze([...byToken.values()])
}

function compileApprovalInventory(
	agents: Readonly<Record<string, AnyAgentDefinition>>,
	workflows: Readonly<Record<string, AnyWorkflowDefinition>>,
): CompiledApprovalInventory {
	const memo = new Map<object, readonly string[]>()
	const reachable = (agent: AnyAgentDefinition): readonly string[] => {
		const identity = requireIdentity(agent)
		const known = memo.get(identity.token)
		if (known !== undefined) return known
		memo.set(identity.token, Object.freeze([]))
		const selected = new Set((agent.tools ?? []).map(tool => tool.id))
		const permission = Object.entries(agent.permissions ?? {}).some(([id, value]) => selected.has(id) && (
			value === 'require_approval'
			|| (typeof value === 'object' && value !== null && value.mode === 'require_approval')
		))
		const governance = agent.governance?.policies?.some(policy => policy.effects.includes('require_approval')) === true
		const descendants = Object.values(agent.subagents ?? {}).flatMap(reference => reachable('agent' in reference ? reference.agent : reference))
		const value = Object.freeze([...new Set([...(permission || governance ? [agent.id] : []), ...descendants])].sort(codePointCompare))
		memo.set(identity.token, value)
		return value
	}
	const agentRows = Object.freeze(Object.fromEntries(Object.keys(agents).sort(codePointCompare).map(id => {
		const agentIds = reachable(agents[id]!)
		return [id, Object.freeze({ reachable: agentIds.length > 0, agentIds })]
	})))
	const workflowRows = Object.freeze(Object.fromEntries(Object.keys(workflows).sort(codePointCompare).map(id => {
		const agentIds = Object.freeze([...new Set(Object.values(workflows[id]!.agents ?? {}).flatMap(reachable))].sort(codePointCompare))
		return [id, Object.freeze({ reachable: agentIds.length > 0, agentIds })]
	})))
	return Object.freeze({ agents: agentRows, workflows: workflowRows })
}

function codePointCompare(left: string, right: string): number {
	const a = Array.from(left, value => value.codePointAt(0)!)
	const b = Array.from(right, value => value.codePointAt(0)!)
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!
	return a.length - b.length
}

function validateDefinitionCollisions(definitions: Iterable<DefinitionNode>): void {
	const byAddress = new Map<string, DefinitionNode>()
	for (const definition of definitions) {
		const identity = requireIdentity(definition)
		const address = definitionAddress(identity)
		const existing = byAddress.get(address)
		if (existing !== undefined && !sameDefinitionIdentity(existing, definition)) {
			throw graphError('duplicate_definition', address, identity.id)
		}
		byAddress.set(address, definition)
	}
}

function rootValues(roots: DefinitionGraphRoots): DefinitionNode[] {
	return [
		...(roots.tools ?? []), ...(roots.skills ?? []), ...(roots.mcpServers ?? []),
		...(roots.agents ?? []), ...(roots.workflows ?? []),
	]
}

function requireIdentity(definition: unknown): DefinitionIdentity {
	const identity = getDefinitionIdentity(definition)
	if (identity === undefined) throw graphError('foreign_definition', 'definition')
	return identity
}

function assertDefinitionShape(definition: DefinitionNode, identity: DefinitionIdentity): void {
	if (definition.id !== identity.id || expectedPublicKind(identity.kind) !== definition.kind || !Object.isFrozen(definition)) {
		throw graphError('foreign_definition', `${identity.kind}.${identity.id}`, identity.id)
	}
	if (identity.kind === 'agent' && !('contract' in definition && 'model' in definition)) {
		throw graphError('foreign_definition', `agent.${identity.id}`, identity.id)
	}
	if (identity.kind === 'workflow' && !('contract' in definition && 'handler' in definition)) {
		throw graphError('foreign_definition', `workflow.${identity.id}`, identity.id)
	}
	if (identity.kind === 'mcp-tool') assertMcpOwner(definition as McpToolDefinition, identity)
}

function assertMcpOwner(tool: McpToolDefinition, identity: DefinitionIdentity): void {
	const owner = identity.owner
	const ownerIdentity = getDefinitionIdentity(owner)
	if (
		ownerIdentity?.kind !== 'mcp-server'
		|| !Object.isFrozen(owner)
		|| !Object.values((owner as McpServerDefinition<any, any>).tools).some(candidate => sameDefinitionIdentity(candidate, tool))
	) {
		throw graphError('foreign_definition', `mcpTool.${identity.id}`, identity.id)
	}
}

function expectedPublicKind(kind: DefinitionIdentity['kind']): DefinitionNode['kind'] {
	if (kind === 'tool' || kind === 'built-in-tool' || kind === 'host-tool' || kind === 'mcp-tool') return 'tool'
	if (kind === 'catalog' || kind === 'harness') throw graphError('foreign_definition', kind)
	return kind
}

function definitionAddress(identity: DefinitionIdentity): string {
	if (identity.kind === 'tool' || identity.kind === 'built-in-tool' || identity.kind === 'host-tool') {
		return `tool:${identity.id}`
	}
	if (identity.kind !== 'mcp-tool') return `${identity.kind}:${identity.id}`
	const owner = getDefinitionIdentity(identity.owner)
	if (owner?.kind !== 'mcp-server') throw graphError('foreign_definition', `mcpTool.${identity.id}`, identity.id)
	return `mcp-tool:${owner.id}:${identity.id}`
}

function definitionMap(
	definitions: Iterable<DefinitionNode>,
	kinds: readonly DefinitionIdentity['kind'][],
): Readonly<Record<string, DefinitionNode>> {
	const entries = [...definitions]
		.filter(definition => {
			const identity = getDefinitionIdentity(definition)
			return identity !== undefined && kinds.includes(identity.kind)
		})
		.sort((left, right) => left.id.localeCompare(right.id))
		.map(definition => [definition.id, definition] as const)
	return Object.freeze(Object.fromEntries(entries))
}

function validateAgentCycles(definitions: Iterable<DefinitionNode>, reader: DefinitionDependencyReader): void {
	const agents = [...definitions].filter(definition => getDefinitionIdentity(definition)?.kind === 'agent') as AnyAgentDefinition[]
	const state = new Map<object, 'visiting' | 'visited'>()
	const visit = (agent: AnyAgentDefinition) => {
		const identity = requireIdentity(agent)
		if (state.get(identity.token) === 'visiting') throw graphError('agent_cycle', `agent.${identity.id}`, identity.id)
		if (state.get(identity.token) === 'visited') return
		state.set(identity.token, 'visiting')
		for (const child of reader(agent).subagents ?? []) visit(child)
		state.set(identity.token, 'visited')
	}
	for (const agent of agents) visit(agent)
}

function validateAgentNamesAndReferences(definitions: Iterable<DefinitionNode>): void {
	const agents = [...definitions].filter(definition => getDefinitionIdentity(definition)?.kind === 'agent') as AnyAgentDefinition[]
	for (const agent of agents) {
		const names = new Map<string, string>()
		for (const tool of agent.tools ?? []) {
			requireIdentity(tool)
			claimModelName(names, tool.id, `tool.${tool.id}`, agent.id)
		}
		for (const [name, reference] of Object.entries(agent.subagents ?? {})) {
			const child = 'agent' in reference ? reference.agent : reference
			requireIdentity(child)
			claimModelName(names, name, `subagent.${child.id}`, agent.id)
		}
		const declaredRequirements = agent.guardrails?.[agentGuardrailsBinding].requirements
		const parsedRequirements = declaredRequirements === undefined
			? undefined
			: agentExecutionRequirementsSchema.safeParse(declaredRequirements)
		if (parsedRequirements !== undefined && !parsedRequirements.success) {
			throw graphError('invalid_agent', `agent.${agent.id}.guardrails.requirements`, agent.id)
		}
		const requiredTools = parsedRequirements?.data.tools ?? []
		for (const required of requiredTools) {
			if (!(agent.tools ?? []).some(tool => tool.id === required)) {
				throw graphError('invalid_agent', `agent.${agent.id}.guardrails.requirements.tools.${required}`, required)
			}
		}
	}
}

function claimModelName(names: Map<string, string>, name: string, origin: string, agentId: string): void {
	const previous = names.get(name)
	if (previous !== undefined) {
		throw graphError('model_name_collision', `agent.${agentId}.${name}`, `${previous},${origin}`)
	}
	names.set(name, origin)
}

function graphError(reason: string, path: string, id?: string): HarnessConfigError {
	return new HarnessConfigError('Definition graph validation failed.', {
		reason, path, ...(id === undefined ? {} : { id }),
	})
}
