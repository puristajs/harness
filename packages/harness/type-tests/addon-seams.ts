import { z } from 'zod'

import {
	defineAgent,
	defineHarness,
	defineTool,
	normalizeHarnessTraceContext,
	type AgentExecutionRequirements,
	type AgentGuardrailsBinding,
	type AnyNonMcpToolDefinition,
	type GovernanceContext,
	type GovernanceDefinitionHelpers,
	type GovernanceEffect,
	type GovernancePolicyEvaluator,
	type GovernanceToolMap,
	type HarnessTraceContext,
	type Infer,
	type JsonValue,
	type Schema,
} from '../src/index.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

const trace: HarnessTraceContext = normalizeHarnessTraceContext({
	traceparent: '00-00000000000000000000000000000001-0000000000000001-03',
})
const traceparent: string = trace.traceparent
// @ts-expect-error normalized trace carriers are immutable
trace.traceparent = traceparent

const lookup = defineTool('lookup', {
	description: 'Look up one record.',
	input: z.object({ id: z.string() }),
	output: z.object({ value: z.string() }),
	async handler(_context, input) { return { value: input.id } },
})
const transfer = defineTool('transfer', {
	description: 'Transfer one amount.',
	input: z.object({ amount: z.number() }),
	output: z.object({ accepted: z.boolean() }),
	async handler() { return { accepted: true } },
})

const nonMcpTool: AnyNonMcpToolDefinition = lookup
void nonMcpTool

const evaluator: GovernancePolicyEvaluator<{ readonly lookup: typeof lookup }> = {
	id: 'typed-policy',
	effects: ['allow'],
	evaluate(context) {
		const toolId: 'lookup' = context.toolId
		const input: { id: string } = context.input
		const activeTraceparent: string | undefined = context.traceparent
		void toolId; void input; void activeTraceparent
		return { effect: 'allow' }
	},
}
void evaluator

const emptyEffects: GovernancePolicyEvaluator<{ readonly lookup: typeof lookup }> = {
	id: 'invalid-policy',
	// @ts-expect-error external governance evaluators declare a nonempty effect tuple
	effects: [],
	evaluate: () => ({ effect: 'allow' }),
}
void emptyEffects

type AddonRequirements = AgentExecutionRequirements<
	readonly ['lookup'],
	readonly [Readonly<{ alias: 'guardModel'; capabilities: readonly ['object'] }>],
	readonly [],
	readonly ['sandbox.readonly_mount']
>
declare const addonGuardrails: AgentGuardrailsBinding<AddonRequirements>
const guardedAgent = defineAgent('guardedAgent', {
	model: 'chat',
	instructions: 'Answer safely.',
	tools: [lookup],
	guardrails: addonGuardrails,
})
const guardedHarness = defineHarness({ name: 'guardedHarness' }).addAgent(guardedAgent)
type _ExactGuardModelCapability = Expect<Equal<
	typeof guardedHarness.$infer.requirements.models.guardModel.capabilities[number],
	'object'
>>
type _ExactGuardSandboxCapability = Expect<Equal<
	typeof guardedHarness.$infer.requirements.sandbox.capabilities[number],
	'sandbox.readonly_mount'
>>

type ExternalPolicyOptions<
	Tools extends GovernanceToolMap,
	ResultSchema extends Schema,
	Effects extends readonly [GovernanceEffect, ...GovernanceEffect[]],
> = Readonly<{
	effects: Effects
	resultSchema: ResultSchema
	mapInput(context: GovernanceContext<Tools>): JsonValue | undefined
	mapDecision(result: Infer<ResultSchema>, context: GovernanceContext<Tools>): Readonly<{ effect: Effects[number] }> | undefined
}>

declare function externalPolicy<
	Tools extends GovernanceToolMap,
	const ResultSchema extends Schema,
	const Effects extends readonly [GovernanceEffect, ...GovernanceEffect[]],
>(
	helpers: Pick<GovernanceDefinitionHelpers<Tools>, 'adapter'>,
	options: ExternalPolicyOptions<Tools, ResultSchema, Effects>,
): GovernancePolicyEvaluator<Tools>

defineAgent('externalPolicyAgent', {
	model: 'chat',
	instructions: 'Use an external policy.',
	tools: [lookup, transfer],
	governance: helpers => ({ policies: [externalPolicy(helpers, {
		effects: ['allow'],
		resultSchema: z.object({ allowed: z.boolean() }),
		mapInput(context) {
			const toolId: 'lookup' | 'transfer' = context.toolId
			if (context.toolId === 'lookup') {
				const id: string = context.input.id
				// @ts-expect-error correlated lookup input has no amount field
				context.input.amount
				void id
			} else {
				const amount: number = context.input.amount
				// @ts-expect-error correlated transfer input has no id field
				context.input.id
				void amount
			}
			void toolId
			return undefined
		},
		mapDecision(result, context) {
			const allowed: boolean = result.allowed
			const toolId: 'lookup' | 'transfer' = context.toolId
			void allowed; void toolId
			return { effect: 'allow' }
		},
	})] }),
})
