import { z } from 'zod'
import { defineAgent } from '../src/definitions/agent.js'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { defineHarness } from '../src/definitions/harness.js'
import type { Schema } from '../src/schema/index.js'

const lookup = defineTool('lookup', { description: 'Lookup.', input: z.object({ id: z.string() }), output: z.object({ value: z.string() }), async handler(_context, input) { return { value: input.id } } })
const agent = defineAgent('typed', { instructions: 'Lookup.', tools: [lookup], output: z.string(), governance: ({ native, rule }) => ({
	policies: [native({ id: 'policy', rules: [rule({ id: 'allow', tools: ['lookup'], effect: 'allow' })] })],
}) })
const update: 'object-snapshot' = agent.contract.updates
const output: string = null as never as typeof agent.$infer.output
void update; void output

defineAgent('badTool', { instructions: 'Bad.', tools: [lookup], governance: ({ native, rule }) => ({ policies: [native({ id: 'p', rules: [rule({
	id: 'r',
	// @ts-expect-error governance selectors use only the complete agent binding map
	tools: ['missing'],
	effect: 'allow',
})] })] }) })

// @ts-expect-error external policy evaluators must declare possible effects
defineAgent('badExternal', { instructions: 'Bad.', governance: { policies: [{ id: 'external', evaluate: () => ({ effect: 'allow' }) }] } })

const directNativeEffectsFromRules = defineAgent('directNativeEffectsFromRules', { instructions: 'Typed.', governance: { policies: [{
	kind: 'native', id: 'native', rules: [{ id: 'review', effect: 'require_approval' }],
}] } })
const directNativeDurable: true = defineHarness({ name: 'directNativeHarness', revision: 'v1' }).addAgent(directNativeEffectsFromRules).requirements.storage.durable
void directNativeDurable
defineAgent('badNativeEffectsDeclaration', { instructions: 'Bad.', governance: { policies: [{
	// @ts-expect-error native effects are derived from rules and cannot be authored separately
	kind: 'native', id: 'native', rules: [{ id: 'allow', effect: 'allow' }],
	effects: ['require_approval'],
}] } })

const jsonTransform = z.string().transform(value => ({ value }))
defineTool('jsonTransform', { description: 'JSON transform.', input: jsonTransform, output: jsonTransform, async handler() { return 'output' } })
defineAgent('jsonTransformAgent', { instructions: 'JSON.', input: jsonTransform, output: jsonTransform, prompt: input => ({ role: 'user', content: input.value }) })
defineWorkflow('jsonTransformWorkflow', { input: jsonTransform, output: jsonTransform, async handler() { return 'output' } })

// @ts-expect-error schema transforms may not produce Date instances at a Tool factory
defineTool('dateTool', { description: 'Invalid.', input: z.string().transform(value => new Date(value)), output: z.string(), async handler() { return '' } })
// @ts-expect-error top-level undefined is not a JSON transport value
defineTool('undefinedTool', { description: 'Invalid.', input: z.string(), output: z.undefined(), async handler() { return undefined } })
// @ts-expect-error schema transforms may not produce functions at an Agent factory
defineAgent('functionAgent', { instructions: 'Invalid.', input: z.string().transform(() => () => undefined), prompt: () => ({ role: 'user', content: '' }) })
class NonJsonValue { value = 'x'; method() { return this.value } }
// @ts-expect-error class instances are not valid Workflow transport values
defineWorkflow('classWorkflow', { input: z.string(), output: z.instanceof(NonJsonValue), async handler() { return new NonJsonValue() } })

// @ts-expect-error schema values must remain JSON-shaped
type InvalidSchema = Schema<Date, Date>
void (null as never as InvalidSchema)
