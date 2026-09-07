import { z } from 'zod'

import {
	defineAgent,
	defineHarness,
	defineTool,
	normalizeHarnessTraceContext,
	type AgentExecutionRequirements,
	type AgentGuardrailsBinding,
	type AnyNonMcpToolDefinition,
	type GovernancePolicyEvaluator,
	type HarnessTraceContext,
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
