import type { JsonValue } from '../models/json.js'
import type { Infer, ModelSchema, Schema } from '../schema/index.js'
import type { DecisionExecutionContext } from '../decisions/types.js'
import type { GovernanceAuditSink, GovernanceDecision, GovernanceEffect, GovernanceExposureEffect, GovernanceMode } from '../harness/defineHarness.js'
import type { AnyAgentDefinition, AnyToolDefinition, AgentSubagentMap, SkillDefinition } from '../definitions/types.js'

export type GovernanceToolDefinition = Readonly<{ id: string; input: ModelSchema; output: Schema }>
export type GovernanceToolMap = Readonly<Record<string, GovernanceToolDefinition>>
type ToolId<Tools extends GovernanceToolMap> = keyof Tools & string
type ToolInput<Tools extends GovernanceToolMap, Id extends ToolId<Tools>> = Infer<Tools[Id]['input']>

export type GovernanceContext<Tools extends GovernanceToolMap, Id extends ToolId<Tools> = ToolId<Tools>> =
	Id extends ToolId<Tools> ? Readonly<{
		toolId: Id
		input: ToolInput<Tools, Id>
		callId: string
		invocationId: string
		agentId: string
		runId: string
		sessionId: string
		workflowId?: string
		step: number
		metadata: Readonly<Record<string, JsonValue>>
		signal: AbortSignal
		deadline: number
	}> : never

export interface GovernancePolicyEvaluator<Tools extends GovernanceToolMap> {
	readonly id: string
	readonly version?: string
	readonly engine?: string
	readonly effects: readonly [GovernanceEffect, ...GovernanceEffect[]]
	evaluate(context: GovernanceContext<Tools>): GovernanceDecision | readonly GovernanceDecision[] | undefined |
		Promise<GovernanceDecision | readonly GovernanceDecision[] | undefined>
}

export interface NativePolicyRuleForTool<Tools extends GovernanceToolMap, Id extends ToolId<Tools>> {
	readonly id: string
	readonly description?: string
	readonly effect: GovernanceEffect
	readonly tools?: readonly Id[]
	readonly when?: (context: GovernanceContext<Tools, Id>) => boolean | Promise<boolean>
	readonly reasonCode?: GovernanceDecision['reasonCode']
}

export type NativePolicyRule<Tools extends GovernanceToolMap> = NativePolicyRuleForTool<Tools, ToolId<Tools>>
export interface NativePolicyDefinition<Tools extends GovernanceToolMap> {
	readonly kind: 'native'
	readonly id: string
	readonly version?: string
	readonly description?: string
	readonly effects: readonly GovernanceEffect[]
	readonly rules: readonly NativePolicyRule<Tools>[]
}

export interface GovernanceToolExposureContext<Tools extends GovernanceToolMap, Id extends ToolId<Tools>> extends DecisionExecutionContext {
	readonly toolId: Id
	readonly agentId: string
	readonly runId: string
	readonly sessionId: string
	readonly workflowId?: string
	readonly step: number
	readonly metadata: Readonly<Record<string, JsonValue>>
}
export interface GovernanceToolExposureRule<Tools extends GovernanceToolMap, Id extends ToolId<Tools> = ToolId<Tools>> {
	readonly id: string
	readonly description?: string
	readonly effect: GovernanceExposureEffect
	readonly tools?: readonly Id[]
	readonly when?: (context: GovernanceToolExposureContext<Tools, Id>) => boolean | Promise<boolean>
}
export interface GovernanceToolExposurePolicy<Tools extends GovernanceToolMap> {
	readonly id?: string
	readonly version?: string
	readonly defaultEffect?: GovernanceExposureEffect
	readonly rules?: readonly GovernanceToolExposureRule<Tools>[]
}

export interface GovernanceConfig<Tools extends GovernanceToolMap> {
	readonly enabled?: boolean
	readonly mode?: GovernanceMode
	readonly defaultEffect?: 'allow' | 'deny'
	readonly policies?: readonly (NativePolicyDefinition<Tools> | GovernancePolicyEvaluator<Tools>)[]
	readonly exposure?: GovernanceToolExposurePolicy<Tools>
	readonly audit?: GovernanceAuditSink
}

/** Native policy authoring derives effects from rules and never accepts a second declaration. */
export type NativePolicyAuthoringDefinition<Tools extends GovernanceToolMap> =
	Omit<NativePolicyDefinition<Tools>, 'effects'> & Readonly<{ effects?: never }>

/** Closed governance shape accepted while defining an agent. */
export type AgentGovernanceAuthoringConfig<Tools extends GovernanceToolMap> =
	Omit<GovernanceConfig<Tools>, 'policies'> & Readonly<{
		policies?: readonly (NativePolicyAuthoringDefinition<Tools> | GovernancePolicyEvaluator<Tools>)[]
	}>

export interface GovernanceDefinitionHelpers<Tools extends GovernanceToolMap> {
	rule<const Ids extends readonly ToolId<Tools>[]>(definition: NativePolicyRuleForTool<Tools, NoInfer<Ids[number]>> & { tools: Ids }): NativePolicyRule<Tools>
	rule(definition: NativePolicyRuleForTool<Tools, ToolId<Tools>> & { tools?: undefined }): NativePolicyRule<Tools>
	exposureRule<const Ids extends readonly ToolId<Tools>[]>(definition: GovernanceToolExposureRule<Tools, NoInfer<Ids[number]>> & { tools: Ids }): GovernanceToolExposureRule<Tools>
	exposureRule(definition: GovernanceToolExposureRule<Tools, ToolId<Tools>> & { tools?: undefined }): GovernanceToolExposureRule<Tools>
	native<const Definition extends Omit<NativePolicyDefinition<Tools>, 'kind' | 'effects'>>(definition: Definition): Definition & {
		readonly kind: 'native'
	}
	adapter<const Definition extends GovernancePolicyEvaluator<Tools>>(definition: Definition): Definition
}

type ExplicitToolMap<Tools extends readonly AnyToolDefinition[]> = Readonly<{ [Tool in Tools[number] as Tool['id']]: Tool }>
type ReferencedAgent<Reference> = Reference extends Readonly<{ agent: infer Agent extends AnyAgentDefinition }> ? Agent : Reference extends AnyAgentDefinition ? Reference : never
type SkillTool<Skills extends readonly SkillDefinition[]> = Skills extends readonly [] ? {} : {
	readonly read_skill: Readonly<{ id: 'read_skill'; input: ModelSchema; output: Schema }>
}
type SubagentTools<Subagents extends AgentSubagentMap> = Readonly<{ [Name in keyof Subagents]: Readonly<{
	id: Name & string
	input: ReferencedAgent<Subagents[Name]>['input']
	output: ReferencedAgent<Subagents[Name]>['output']
}> }>

export type AgentModelToolMap<Tools, Skills, Subagents> = Readonly<
	ExplicitToolMap<Tools extends readonly AnyToolDefinition[] ? Tools : readonly []>
	& SkillTool<Skills extends readonly SkillDefinition[] ? Skills : readonly []>
	& SubagentTools<Subagents extends AgentSubagentMap ? Subagents : Readonly<Record<never, never>>>
>

export type AgentGovernanceInput<Tools, Skills, Subagents> =
	| AgentGovernanceAuthoringConfig<AgentModelToolMap<Tools, Skills, Subagents>>
	| ((helpers: GovernanceDefinitionHelpers<AgentModelToolMap<Tools, Skills, Subagents>>) => AgentGovernanceAuthoringConfig<AgentModelToolMap<Tools, Skills, Subagents>>)

type ResolvedNativePolicy<Policy> = Policy extends Readonly<{
	kind: 'native'
	rules: infer Rules extends readonly Readonly<{ effect: GovernanceEffect }>[]
}> ? Omit<Policy, 'effects'> & Readonly<{
	effects: readonly Extract<Rules[number]['effect'], GovernanceEffect>[]
}> : Policy

/** Definition-time projection after native rule effects have been derived. */
export type ResolvedAgentGovernance<Config> = Config extends Readonly<{ policies?: infer Policies }>
	? Omit<Config, 'policies'> & (Policies extends readonly unknown[]
		? Readonly<{ policies: Readonly<{ [Index in keyof Policies]: ResolvedNativePolicy<Policies[Index]> }> }>
		: Readonly<{ policies?: undefined }>)
	: Config
