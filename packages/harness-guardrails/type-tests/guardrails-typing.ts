import { z } from 'zod'
import { defineHarness, type ModelProvider } from '@purista/harness'
import { defineGuardrailAction, defineGuardrails, sensitiveDataToolRail, type GuardrailActionContext, type GuardrailActionDefinition, type GuardrailEvaluator } from '../src/index.js'

const inputAction = defineGuardrailAction({
  phase: 'input', valueSchema: z.string(),
  evaluate: ({ value }) => ({ decision: 'transform', target: 'user_message', value: value.trim() })
})
void inputAction

const structuredSchema = z.strictObject({ value: z.string() })
const structuredAction = defineGuardrailAction({
  phase: 'tool_input', tools: ['write'], valueSchema: structuredSchema,
  evaluate: ({ value }) => ({ decision: 'transform', target: 'tool_input', value })
})
void structuredAction

const decisionOnly = defineGuardrailAction({ phase: 'retrieval', mayTransform: false, evaluate: () => ({ decision: 'block', reasonCode: 'restricted' }) })
void decisionOnly

const extractedSchema = z.string()
type ExtractedEvaluator = GuardrailActionDefinition<'input', typeof extractedSchema>['evaluate']
const extractedEvaluator: ExtractedEvaluator = ({ value }) => ({ decision: 'transform', target: 'user_message', value: value.trim() })
const extractedDefinition: GuardrailActionDefinition<'input', typeof extractedSchema> = {
  phase: 'input', valueSchema: extractedSchema, evaluate: extractedEvaluator
}
defineGuardrailAction<'input', typeof extractedSchema>(extractedDefinition)

// @ts-expect-error a generic input evaluator cannot narrow JsonValue to string without a schema.
const unsafeNarrowedEvaluator: GuardrailEvaluator<'input'> = (_context: GuardrailActionContext<'input', string>) => ({ decision: 'allow' })
void unsafeNarrowedEvaluator

// @ts-expect-error a phase-specific target cannot cross into another phase.
defineGuardrailAction({ phase: 'input', evaluate: () => ({ decision: 'transform', target: 'bot_message', value: 'unsafe' }) })
// @ts-expect-error `mayTransform: false` excludes transform results.
defineGuardrailAction({ phase: 'output', mayTransform: false, evaluate: () => ({ decision: 'transform', target: 'bot_message', value: 'unsafe' }) })
declare const dynamicBoolean: boolean
// @ts-expect-error dynamic transform permission must be narrowed before construction.
defineGuardrailAction({ phase: 'input', mayTransform: dynamicBoolean, evaluate: () => ({ decision: 'allow' }) })
// @ts-expect-error non-tool phases cannot select tools.
defineGuardrailAction({ phase: 'input', tools: ['write'], evaluate: () => ({ decision: 'allow' }) })
// @ts-expect-error tool phases require a nonempty exact tool selector.
defineGuardrailAction({ phase: 'tool_input', evaluate: () => ({ decision: 'allow' }) })
// @ts-expect-error structured codecs require an explicit schema.
sensitiveDataToolRail({ detector: {} as never, phase: 'tool_input', tools: ['write'], policy: 'input', operation: 'mask', codec: {} as never })

const phaseCorrelatedActions = {
  'check input': defineGuardrailAction({ phase: 'input', evaluate: () => ({ decision: 'allow' }) }),
  'check output': defineGuardrailAction({ phase: 'output', evaluate: () => ({ decision: 'allow' }) })
}

defineGuardrails({ config: { rails: { input: { flows: ['check input'] }, output: { flows: ['check output'] } } }, actions: phaseCorrelatedActions })
defineGuardrails({ config: { rails: { input: {
  // @ts-expect-error flow IDs must be declared in the action map.
  flows: ['check inpoot']
} } }, actions: phaseCorrelatedActions })
defineGuardrails({ config: { rails: { input: {
  // @ts-expect-error an output action cannot be configured for input.
  flows: ['check output']
} } }, actions: phaseCorrelatedActions })

declare const provider: ModelProvider
const rails = defineGuardrails({ config: { rails: {} }, actions: {} })
const harness = defineHarness()
  .models({ assistant: { provider, model: 'test', capabilities: ['object'] } })
  .agents(({ agent }) => ({ answer: rails.attach(agent({ model: 'assistant', input: z.string(), output: z.object({ answer: z.string() }), builtinTools: false, instructions: ({ input }) => input.toUpperCase() })) })).build()
const session = await harness.getSession('attached-types')
const output: { answer: string } = await session.agents.answer.prompt('question')
void output
// @ts-expect-error attachment preserves the agent's string input schema.
session.agents.answer.prompt(123)
// @ts-expect-error attachment preserves the agent's structured output schema.
const wrongOutput: string = await session.agents.answer.prompt('question')
void wrongOutput
