import {
	agentGuardrailsBinding,
	defineAgent,
	defineHarness,
	defineTool,
	type AgentExecutionRequirements,
	type AgentGuardrailsBinding,
} from '@purista/harness'
import { z } from 'zod'
import {
	defineGuardrailAction,
	defineGuardrails,
	modelCheckRail,
	sensitiveDataToolRail,
	type GuardrailAction,
	type GuardrailActionDefinition,
	type GuardrailBindingRequirements,
	type SensitiveDataDetector,
} from '../src/index.js'

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
		? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
			? true
			: false
		: false
type Expect<Value extends true> = Value
type RequirementsOf<Value> = Value extends AgentGuardrailsBinding<infer Requirements> ? Requirements : never

const selectedToolAction = defineGuardrailAction({
	phase: 'tool_input',
	tools: ['zetaTool', 'alphaTool'] as const,
	models: ['safetyModel', 'auditModel'] as const,
	evaluate: () => ({ decision: 'allow' }),
})
type SelectedToolAction = Expect<
	Equal<
		typeof selectedToolAction,
		GuardrailAction<
			'tool_input',
			readonly ['zetaTool', 'alphaTool'],
			readonly ['safetyModel', 'auditModel']
		>
	>
>
void (0 as unknown as SelectedToolAction)

const modelAction = modelCheckRail({
	phase: 'output',
	model: 'reviewModel',
	instructions: 'Review the output.',
})
type ModelAction = Expect<
	Equal<typeof modelAction, GuardrailAction<'output', readonly [], readonly ['reviewModel']>>
>
void (0 as unknown as ModelAction)

declare const detector: SensitiveDataDetector
const selectedSensitiveDataAction = sensitiveDataToolRail({
	detector,
	phase: 'tool_output',
	tools: ['lookupAccount', 'readLedger'] as const,
	policy: 'output',
	operation: 'detect',
	valueSchema: z.object({ value: z.string() }),
	codec: {
		id: 'accountResult',
		extract: value => [{ id: 'value', text: value.value }],
		replace: (value, replacements) => ({ value: replacements[0]?.value ?? value.value }),
	},
})
type SelectedSensitiveDataAction = Expect<
	Equal<
		typeof selectedSensitiveDataAction,
		GuardrailAction<'tool_output', readonly ['lookupAccount', 'readLedger'], readonly []>
	>
>
void (0 as unknown as SelectedSensitiveDataAction)

const extractedInputDefinition: GuardrailActionDefinition<'input'> = {
	phase: 'input',
	models: ['safetyModel'],
	evaluate: () => ({ decision: 'allow' }),
}
const extractedToolDefinition: GuardrailActionDefinition<'tool_input'> = {
	phase: 'tool_input',
	tools: ['lookupAccount'],
	models: ['safetyModel'],
	evaluate: () => ({ decision: 'allow' }),
}
defineGuardrailAction(extractedInputDefinition)
defineGuardrailAction(extractedToolDefinition)

const ignoredRetrievalAction = defineGuardrailAction({
	phase: 'retrieval',
	models: ['retrievalModel'] as const,
	evaluate: () => ({ decision: 'allow' }),
})
const unusedAction = defineGuardrailAction({
	phase: 'input',
	models: ['unusedModel'] as const,
	evaluate: () => ({ decision: 'allow' }),
})

const actions = {
	selectedToolAction,
	modelAction,
	selectedSensitiveDataAction,
	ignoredRetrievalAction,
	unusedAction,
}
const config = {
	rails: {
		tool_input: { flows: ['selectedToolAction'] },
		output: { flows: ['modelAction'] },
		tool_output: { flows: ['selectedSensitiveDataAction'] },
		retrieval: { flows: ['ignoredRetrievalAction'] },
	},
} as const

const rails = defineGuardrails({ actions, config })
type ExpectedRequirements = AgentExecutionRequirements<
	readonly ('zetaTool' | 'alphaTool' | 'lookupAccount' | 'readLedger')[],
	readonly (
		| Readonly<{ alias: 'safetyModel'; capabilities: readonly ['object'] }>
		| Readonly<{ alias: 'auditModel'; capabilities: readonly ['object'] }>
		| Readonly<{ alias: 'reviewModel'; capabilities: readonly ['object'] }>
	)[],
	readonly [],
	readonly [],
	readonly [],
	undefined,
	undefined,
	undefined
>
type FacadeRequirements = typeof rails extends AgentGuardrailsBinding<infer Requirements> ? Requirements : never
type ExactFacadeRequirements = Expect<Equal<FacadeRequirements, ExpectedRequirements>>
type ExactPublicEquation = Expect<Equal<GuardrailBindingRequirements<typeof actions, typeof config>, ExpectedRequirements>>
type ExactBinding = Expect<
	Equal<typeof rails[typeof agentGuardrailsBinding]['requirements'], ExpectedRequirements | undefined>
>
void (0 as unknown as ExactFacadeRequirements)
void (0 as unknown as ExactPublicEquation)
void (0 as unknown as ExactBinding)

const inputOnly = defineGuardrails({ actions, config: { rails: { input: { flows: ['unusedAction'] } } } })
type InputOnly = Expect<Equal<RequirementsOf<typeof inputOnly>, AgentExecutionRequirements<
	readonly never[],
	readonly Readonly<{ alias: 'unusedModel'; capabilities: readonly ['object'] }>[],
	readonly [], readonly [], readonly [], undefined, undefined, undefined
>>>
const outputOnly = defineGuardrails({ actions, config: { rails: { output: { flows: ['modelAction'] } } } })
type OutputOnly = Expect<Equal<RequirementsOf<typeof outputOnly>, AgentExecutionRequirements<
	readonly never[],
	readonly Readonly<{ alias: 'reviewModel'; capabilities: readonly ['object'] }>[],
	readonly [], readonly [], readonly [], undefined, undefined, undefined
>>>
const toolInputOnly = defineGuardrails({
	actions,
	config: { rails: { tool_input: { flows: ['selectedToolAction'] } } },
})
type ToolInputOnly = Expect<Equal<RequirementsOf<typeof toolInputOnly>, AgentExecutionRequirements<
	readonly ('zetaTool' | 'alphaTool')[],
	readonly (
		| Readonly<{ alias: 'safetyModel'; capabilities: readonly ['object'] }>
		| Readonly<{ alias: 'auditModel'; capabilities: readonly ['object'] }>
	)[],
	readonly [], readonly [], readonly [], undefined, undefined, undefined
>>>
const toolOutputOnly = defineGuardrails({
	actions,
	config: { rails: { tool_output: { flows: ['selectedSensitiveDataAction'] } } },
})
type ToolOutputOnly = Expect<Equal<RequirementsOf<typeof toolOutputOnly>, AgentExecutionRequirements<
	readonly ('lookupAccount' | 'readLedger')[], readonly never[], readonly [], readonly [], readonly [],
	undefined, undefined, undefined
>>>
const empty = defineGuardrails({ actions, config: {} })
const retrievalOnly = defineGuardrails({
	actions,
	config: { rails: { retrieval: { flows: ['ignoredRetrievalAction'] } } },
})
type Empty = Expect<Equal<GuardrailBindingRequirements<typeof actions, {}>, undefined>>
type RetrievalOnly = Expect<Equal<
	GuardrailBindingRequirements<
		typeof actions,
		{ readonly rails: { readonly retrieval: { readonly flows: readonly ['ignoredRetrievalAction'] } } }
	>,
	undefined
>>
type EmptyBinding = Expect<Equal<typeof empty[typeof agentGuardrailsBinding]['requirements'], undefined>>
type RetrievalOnlyBinding = Expect<Equal<
	typeof retrievalOnly[typeof agentGuardrailsBinding]['requirements'],
	undefined
>>
void (0 as unknown as InputOnly)
void (0 as unknown as OutputOnly)
void (0 as unknown as ToolInputOnly)
void (0 as unknown as ToolOutputOnly)
void (0 as unknown as Empty)
void (0 as unknown as RetrievalOnly)
void (0 as unknown as EmptyBinding)
void (0 as unknown as RetrievalOnlyBinding)

const zetaTool = defineTool('zetaTool', {
	description: 'Zeta tool.', input: z.string(), output: z.string(), handler: async (_context, input) => input,
})
const alphaTool = defineTool('alphaTool', {
	description: 'Alpha tool.', input: z.string(), output: z.string(), handler: async (_context, input) => input,
})
const lookupAccount = defineTool('lookupAccount', {
	description: 'Lookup account.', input: z.string(), output: z.string(), handler: async (_context, input) => input,
})
const readLedger = defineTool('readLedger', {
	description: 'Read ledger.', input: z.string(), output: z.string(), handler: async (_context, input) => input,
})
const guardedAgent = defineAgent('guardedAgent', {
	model: 'chat',
	instructions: 'Answer safely.',
	tools: [zetaTool, alphaTool, lookupAccount, readLedger],
	guardrails: rails,
})
const guardedHarness = defineHarness({ name: 'guardedHarness' }).addAgent(guardedAgent)
type CompiledGuardModel = Expect<Equal<
	typeof guardedHarness.$infer.requirements.models.auditModel.capabilities[number],
	'object'
>>
void (0 as unknown as CompiledGuardModel)

// @ts-expect-error model selectors must be nonempty when present.
defineGuardrailAction({ phase: 'input', models: [], evaluate: () => ({ decision: 'allow' }) })
declare const widenedTools: readonly string[]
// @ts-expect-error tool selectors must remain nonempty tuples rather than widened arrays.
defineGuardrailAction({ phase: 'tool_input', tools: widenedTools, evaluate: () => ({ decision: 'allow' }) })
// @ts-expect-error tool selectors must be nonempty.
defineGuardrailAction({ phase: 'tool_input', tools: [], evaluate: () => ({ decision: 'allow' }) })
declare const widenedModels: readonly string[]
// @ts-expect-error model selectors must remain nonempty tuples rather than widened arrays.
defineGuardrailAction({ phase: 'input', models: widenedModels, evaluate: () => ({ decision: 'allow' }) })
// @ts-expect-error tools are forbidden outside tool phases.
defineGuardrailAction({ phase: 'output', tools: ['write'], evaluate: () => ({ decision: 'allow' }) })
