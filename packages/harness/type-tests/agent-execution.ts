import { z } from 'zod'
import { defineAgent } from '../src/definitions/agent.js'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { defineHarness } from '../src/definitions/harness.js'
import type { Schema } from '../src/schema/index.js'
import type { HarnessExecutionCaller } from '../src/definitions/index.js'
import type { HarnessTargetRunOutcome } from '../src/runtime/outcomes.js'
import type {
	HarnessTargetExecutionTerminalOutcome,
	HarnessTargetExecutionEvent,
	HarnessTargetStream,
} from '../src/definitions/execution-events.js'
import type { HarnessTargetInvoker } from '../src/runtime/standalone-instance.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

const lookup = defineTool('lookup', { description: 'Lookup.', input: z.object({ id: z.string() }), output: z.object({ value: z.string() }), async handler(_context, input) { return { value: input.id } } })
const agent = defineAgent('typed', { instructions: 'Lookup.', tools: [lookup], output: z.string(), governance: ({ native, rule }) => ({
	policies: [native({ id: 'policy', rules: [rule({ id: 'allow', tools: ['lookup'], effect: 'allow' })] })],
}) })
const update: 'text-delta' = agent.contract.updates
const output: string = null as never as typeof agent.contract.$infer.output
void update; void output

const agentCaller: HarnessExecutionCaller = { kind: 'agent', agentId: 'typed', workflowId: 'owner' }
const workflowCaller: HarnessExecutionCaller = { kind: 'workflow', workflowId: 'orchestrate' }
// @ts-expect-error workflow callers cannot contain an agent id
const mixedCaller: HarnessExecutionCaller = { kind: 'workflow', workflowId: 'orchestrate', agentId: 'typed' }
// @ts-expect-error an execution caller always names exactly one owning kind
const absentCaller: HarnessExecutionCaller = { kind: 'agent' }
void agentCaller; void workflowCaller; void mixedCaller; void absentCaller

const noInterruptAgent = defineAgent('noInterrupt', { instructions: 'Answer.' })
const approvalAgent = defineAgent('approvalAgent', { instructions: 'Review.', tools: [lookup], governance: ({ native, rule }) => ({
	policies: [native({ id: 'approval', rules: [rule({ id: 'review', tools: ['lookup'], effect: 'require_approval' })] })],
}) })
const externalWaitWorkflow = defineWorkflow('externalWaitWorkflow', { durable: true, async handler({ input }) { return input } })
declare const plainInvoker: HarnessTargetInvoker<typeof noInterruptAgent.contract>
declare const approvalInvoker: HarnessTargetInvoker<typeof approvalAgent.contract>
declare const externalWaitInvoker: HarnessTargetInvoker<typeof externalWaitWorkflow.contract>
const plainRun = plainInvoker.run('question')
const plainStream = plainInvoker.stream('question')
const approvalStream = approvalInvoker.stream('question')
const externalWaitStream = externalWaitInvoker.stream('question')
type _PlainRun = Expect<Equal<typeof plainRun, Promise<HarnessTargetRunOutcome<typeof noInterruptAgent.contract>>>>
type _PlainStream = Expect<Equal<typeof plainStream, HarnessTargetStream<typeof noInterruptAgent.contract>>>
type _PlainTerminal = Expect<Equal<typeof plainStream.result, Promise<HarnessTargetExecutionTerminalOutcome<typeof noInterruptAgent.contract>>>>
type _ApprovalInterrupt = Expect<Equal<Extract<Awaited<typeof approvalStream.result>, { status: 'interrupted' }>['interrupt'],
	import('../src/approvals/index.js').ToolApprovalInterrupt>>
type _ExternalWaitInterrupt = Expect<Equal<Extract<Awaited<typeof externalWaitStream.result>, { status: 'interrupted' }>['interrupt'],
	Extract<import('../src/runtime/outcomes.js').HarnessInterrupt, { type: 'external-wait' }>>>
// @ts-expect-error a target with no reachable approval cannot accept resume
plainInvoker.run('question', { resume: { type: 'tool-approval', runId: 'r', interruptId: 'i', revision: 'v', eventId: 'e', decisions: [] } })

type PlainEvent = HarnessTargetExecutionEvent<typeof noInterruptAgent.contract>
const plainTerminal: PlainEvent = { type: 'run.finished', eventId: 'e', sequence: 2, runId: 'r', at: 'x', outcome: { status: 'completed', runId: 'r', output: 'ok' } }
// @ts-expect-error text agent root events cannot expose object snapshots
const plainObjectUpdate: PlainEvent = { type: 'output.object.snapshot', eventId: 'e', sequence: 2, runId: 'r', id: 'o', caller: { kind: 'agent', agentId: 'noInterrupt' }, value: {} }
// @ts-expect-error root events cannot carry one-sided parent correlation
const invalidRootParent: PlainEvent = { ...plainTerminal, parentRunId: 'parent' }
void plainRun; void plainStream; void approvalStream; void externalWaitStream; void plainTerminal; void plainObjectUpdate; void invalidRootParent

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
