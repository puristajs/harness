import { defineAgent, defineHarness, defineTool, type GovernancePolicyEvaluator } from '@purista/harness'
import { z } from 'zod'
import { createOpaClient, opaPolicy, type OpaPolicyEvaluator } from '../src/index.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T

const transferFunds = defineTool('transferFunds', {
	description: 'Transfer funds.', input: z.object({ amount: z.number(), destination: z.string() }),
	output: z.object({ accepted: z.boolean() }), async handler() { return { accepted: true } },
})
const readBalance = defineTool('readBalance', {
	description: 'Read a balance.', input: z.object({ accountId: z.string() }),
	output: z.object({ balance: z.number() }), async handler() { return { balance: 100 } },
})
const client = createOpaClient({ baseUrl: 'https://opa.example.test/' })

const approvalAgent = defineAgent('approvalAgent', {
	model: 'chat',
	instructions: 'Use the selected tool.', tools: [transferFunds, readBalance],
	governance: helpers => ({ policies: [opaPolicy(helpers, {
		id: 'typedOpaPolicy', effects: ['allow', 'deny', 'require_approval'], client, decisionPath: ['bank', 'tool'],
		mapInput(context) {
			if (context.toolId === 'transferFunds') {
				const amount: number = context.input.amount
				// @ts-expect-error correlated transfer input has no accountId
				context.input.accountId
				return { amount }
			}
			const accountId: string = context.input.accountId
			// @ts-expect-error correlated balance input has no amount
			context.input.amount
			return { accountId }
		},
		resultSchema: z.object({ matched: z.boolean(), effect: z.enum(['allow', 'deny', 'require_approval']) }),
		mapDecision(result, context) {
			const id: 'transferFunds' | 'readBalance' = context.toolId
			const matched: boolean = result.matched
			void id; void matched
			// @ts-expect-error schema output has no prose field
			result.prose
			return result.matched ? { effect: result.effect } : undefined
		},
	})] }),
})

type ApprovalPolicy = NonNullable<typeof approvalAgent.governance>['policies'][0]
type ExactToolMap = Readonly<{ transferFunds: typeof transferFunds; readBalance: typeof readBalance }>
type _ExactEffects = Expect<Equal<ApprovalPolicy['effects'], readonly ['allow', 'deny', 'require_approval']>>
type _PolicyAssignable = Expect<ApprovalPolicy extends GovernancePolicyEvaluator<ExactToolMap> ? true : false>
const approvalHarness = defineHarness({ name: 'approvalHarness' }).addAgent(approvalAgent)
type _ApprovalRequiresDurable = Expect<Equal<typeof approvalHarness.$infer.requirements.storage.durable, true>>

const allowAgent = defineAgent('allowAgent', {
	model: 'chat',
	instructions: 'Read safely.', tools: [readBalance], governance: helpers => ({ policies: [opaPolicy(helpers, {
		id: 'allowPolicy', effects: ['allow'], client, decisionPath: ['allow'], mapInput: () => ({}),
		resultSchema: z.object({ effect: z.literal('allow') }), mapDecision: result => ({ effect: result.effect }),
	})] }),
})
const allowHarness = defineHarness({ name: 'allowHarness' }).addAgent(allowAgent)
type _AllowDoesNotRequireDurable = Expect<Equal<typeof allowHarness.$infer.requirements.storage.durable, false>>

defineAgent('emptyEffects', { model: 'chat', instructions: 'Invalid.', governance: helpers => ({ policies: [
	// @ts-expect-error effects must be a nonempty tuple
	opaPolicy(helpers, { id: 'empty', effects: [], client, decisionPath: ['x'], mapInput: () => ({}), resultSchema: z.object({}), mapDecision: () => undefined }),
] }) })

defineAgent('undeclaredEffect', { model: 'chat', instructions: 'Invalid.', governance: helpers => ({ policies: [
	opaPolicy(helpers, {
		id: 'badEffect', effects: ['allow'], client, decisionPath: ['x'], mapInput: () => ({}), resultSchema: z.object({}),
		// @ts-expect-error decision effects are restricted to the declared tuple
		mapDecision: () => ({ effect: 'deny' }),
	}),
] }) })

const nonJsonSchema = z.custom<Date>()
defineAgent('nonJsonResult', { model: 'chat', instructions: 'Invalid.', governance: helpers => ({ policies: [
	opaPolicy(helpers, {
		id: 'nonJson', effects: ['allow'], client, decisionPath: ['x'], mapInput: () => ({}),
		// @ts-expect-error OPA result schemas cannot produce undefined or non-JSON output
		resultSchema: nonJsonSchema,
		mapDecision: () => undefined,
	}),
] }) })

declare const exactEvaluator: OpaPolicyEvaluator<
	ExactToolMap, readonly ['allow', 'deny']
>
type _DeclaredEffects = Expect<Equal<typeof exactEvaluator.effects, readonly ['allow', 'deny']>>
