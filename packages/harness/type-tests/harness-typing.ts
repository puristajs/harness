import { z } from 'zod'
import { type as arkType } from 'arktype'
import { toStandardJsonSchema } from '@valibot/to-json-schema'
import * as v from 'valibot'
import { agentGuardrailsBinding, defineHarness, defineHarnessModule } from '../src/harness/defineHarness.js'
import { createModelRegistry } from '../src/models/registry.js'
import {
	bashSandbox,
	createDeterministicEvaluationScorer,
	createDecisionEvidence,
	inMemoryDurableWorkspace,
	inMemoryHarnessStorage,
	inMemoryMemoryEngine,
	inMemorySandbox,
	isExecCapableSession,
	isJsonValue,
	isSpawnCapableSession,
	isTextSearchCapableSession,
	PermissionDeniedError,
	PolicyDeniedError,
	runDecisionOperation,
	runEvaluation,
	scoreEvaluation,
} from '../src/index.js'
import type {
	AgentPermissions,
	BuilderState,
	GovernanceApprovalProvider,
	GovernanceApprovalSubject,
	Harness,
	HarnessBuilder,
	ModelsConfig,
	PermissionPolicy,
	RunOutcome,
} from '../src/harness/defineHarness.js'
import type { AdapterCapability, HarnessInspection } from '../src/ports/capabilities.js'
import type {
	AgentExecutionRequirements,
	DecisionEvidence,
	DecisionExecutionContext,
	DecisionOccurrence,
	DecisionSource,
	EvaluationObservation,
	EvaluationScorer,
	HibernateCapableSandbox,
	JsonValue,
	MemoryEngine,
	ModelAlias,
	ModelProvider,
	ObjectRequest,
	ObjectResponse,
	ResumeCapableSandbox,
	Sandbox,
	SandboxResumeOptions,
	SandboxScope,
	SandboxSessionBase,
	SandboxSessionFor,
	SnapshotCapableSandbox,
	SnapshotResult,
	ToolHandlerContext,
	TsToolDefinition,
	TelemetryShim,
} from '../src/index.js'
import type { Logger } from '../src/logger/index.js'
import type { ExternalWaitResolved, ExternalWaitSnapshot } from '../src/storage/external-wait.js'
import type { Infer as HarnessInfer, InferIn as HarnessInferIn, ModelSchema, Schema } from '../src/index.js'

const readonlyPermission: PermissionPolicy = {
	mode: 'require_approval',
	allow: ['npm test'] as const,
	deny: ['rm *'] as const,
}
const readonlyAgentPermissions: AgentPermissions = { bash: readonlyPermission }
// @ts-expect-error permission allowlists remain read-only public configuration.
readonlyPermission.allow?.push('npm run *')
// @ts-expect-error decision-boundaries: removed API permission modes do not accept ask.
const invalidPermission: AgentPermissions = { write: 'ask' }

const waitingWait: ExternalWaitSnapshot = {
	waitId: 'wait',
	kind: 'human_review',
	schemaVersion: 'v1',
	definitionVersion: 'v1',
	deadline: '2030-01-01T00:00:00.000Z',
	status: 'waiting',
	createdAt: '2029-01-01T00:00:00.000Z',
}
// @ts-expect-error a workflow wait can only resolve to a terminal wait state.
const unresolvedWait: ExternalWaitResolved = waitingWait
void unresolvedWait
const automaticExpiry: ExternalWaitResolved = {
	waitId: 'wait',
	kind: 'human_review',
	schemaVersion: 'v1',
	definitionVersion: 'v1',
	deadline: '2030-01-01T00:00:00.000Z',
	status: 'expired',
	createdAt: '2029-01-01T00:00:00.000Z',
	resolvedAt: '2030-01-01T00:00:00.000Z',
}
// @ts-expect-error non-expiry terminal states require an opaque event id.
const missingTerminalEvent: ExternalWaitResolved = { ...automaticExpiry, status: 'approved' }
void missingTerminalEvent

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false

type EvaluationAssessment = { readonly expected: string }
type EvaluationOutput = { readonly answer: string }
type EvaluationScorerContext = { readonly retrievedIds: readonly string[] }

const exactMatchScorer = createDeterministicEvaluationScorer<
	EvaluationAssessment,
	EvaluationOutput,
	EvaluationScorerContext
>({
	id: 'exact-match',
	version: 'v1',
	dimension: { id: 'correct', kind: 'boolean' },
	evaluate: observation => ({
		outcome: 'scored',
		dimensionId: 'correct',
		kind: 'boolean',
		value: observation.output.answer === observation.assessment?.expected,
	}),
})

const typedEvaluationScorer: EvaluationScorer<EvaluationAssessment, EvaluationOutput, EvaluationScorerContext> =
	exactMatchScorer
const typedObservation: EvaluationObservation<EvaluationAssessment, EvaluationOutput, EvaluationScorerContext> = {
	id: 'observation-1',
	datasetId: 'support',
	datasetVersion: 'v1',
	caseId: 'case-1',
	candidateId: 'candidate',
	candidateVersion: 'v1',
	taskId: 'answer',
	taskVersion: 'v1',
	trialId: 'default',
	trialOrdinal: 0,
	output: { answer: 'approved' },
	assessment: { expected: 'approved' },
	scorerContext: { retrievedIds: ['doc-1'] },
}

const evaluatedRun = runEvaluation({
	runId: 'evaluation-run',
	dataset: {
		id: 'support',
		version: 'v1',
		cases: [{ id: 'case-1', input: { question: 'status' }, assessment: { expected: 'approved' } }],
	},
	candidates: [{ id: 'candidate', version: 'v1', config: { prompt: 'answer' } }],
	task: {
		id: 'answer',
		version: 'v1',
		async run(target) {
			const question: string = target.input.question
			// @ts-expect-error assessment material is scorer-only.
			target.assessment
			return { output: { answer: question === 'status' ? 'approved' : 'unknown' }, scorerContext: { retrievedIds: [] } }
		},
	},
	scorers: [typedEvaluationScorer],
})
const rescoredRun = scoreEvaluation({
	runId: 'rescore-run',
	observations: [typedObservation],
	scorers: [typedEvaluationScorer],
})
void evaluatedRun
void rescoredRun

const decisionOccurrence: DecisionOccurrence = { invocationId: 'invocation-1', step: 0 }
const decisionSource: DecisionSource = { kind: 'interceptor', id: 'typed-boundary' }
const decisionEvidence: DecisionEvidence = createDecisionEvidence({
	occurrence: decisionOccurrence,
	source: decisionSource,
	phase: 'input',
	ordinal: 0,
})
const decisionExecution: DecisionExecutionContext = { signal: new AbortController().signal, deadline: Date.now() + 100 }
const decisionResult: Promise<string> = runDecisionOperation(decisionExecution, async () => decisionEvidence.decisionId)
void decisionResult
new PermissionDeniedError(decisionEvidence)
new PolicyDeniedError(decisionEvidence, 'policy_deny')
// @ts-expect-error denial messages are fixed and callers provide evidence, not prose.
new PermissionDeniedError('private prose')
// @ts-expect-error policy denial classifications are closed.
new PolicyDeniedError(decisionEvidence, 'private prose')
const opaqueValue: unknown = { safe: true }
if (isJsonValue(opaqueValue)) {
	const narrowedJson: JsonValue = opaqueValue
	void narrowedJson
}
// @ts-expect-error decision sources are closed and do not accept arbitrary metadata.
const invalidDecisionSource: DecisionSource = { kind: 'interceptor', id: 'typed-boundary', metadata: {} }
void invalidDecisionSource

defineHarness().storage(inMemoryHarnessStorage())
defineHarness().workspace(inMemoryDurableWorkspace())

async function snapshotCapabilityTypes(
	sandbox: SnapshotCapableSandbox & ResumeCapableSandbox & HibernateCapableSandbox,
	session: SandboxSessionBase,
	scope: SandboxScope,
) {
	const snapshot = await sandbox.snapshot(session)
	const resumed = await sandbox.resume({ snapshotId: snapshot.snapshotId, scope })
	await resumed.readText('/workspace/file.txt')
	// @ts-expect-error optional snapshot resume does not guarantee an executor
	await resumed.exec('echo hi')
	await sandbox.hibernate(session)
	// @ts-expect-error resume requires full target identity, not unscoped session/run ids
	const invalid: SandboxResumeOptions = { snapshotId: snapshot.snapshotId, sessionId: 'session', runId: 'run' }
	// @ts-expect-error snapshot metadata must contain JSON values
	const invalidMetadata: SnapshotResult = { snapshotId: 'snapshot', metadata: { callback: () => {} } }
	return { resumed, invalid, invalidMetadata }
}

async function sessionStorageTypes() {
	const storage = inMemoryHarnessStorage()
	const record = {
		id: 'session',
		instanceId: '01J00000000000000000000001',
		createdAt: '2026-08-26T00:00:00.000Z',
		updatedAt: '2026-08-26T00:00:00.000Z',
		runCount: 0,
		sandboxBinding: {
			owner: { namespace: 'type-test', id: 'session', instanceId: '01J00000000000000000000001' },
			relation: 'owned' as const,
			registration: 'pending' as const,
			policyDigest: 'a'.repeat(64),
			disposed: false,
		},
	}
	const inserted: boolean = await storage.upsertSession(record, 'create')
	await storage.upsertSession(record, 'update')
	// @ts-expect-error writes must declare creation versus update authority
	await storage.upsertSession(record)
	await storage.closeSession(record.id, record.instanceId)
	// @ts-expect-error destructive close requires the expected record instance
	await storage.closeSession(record.id)
	await storage.upsertSession(
		// @ts-expect-error every persisted session requires an opaque instance id and sandbox binding
		{ id: 'session', createdAt: record.createdAt, updatedAt: record.updatedAt, runCount: 0 },
		'create',
	)
	return inserted
}

// @ts-expect-error clean-break API: structured persistence is configured through storage
defineHarness().state(inMemoryHarnessStorage())
// @ts-expect-error clean-break API: durable execution is a HarnessStorage responsibility
defineHarness().runtime({})
// @ts-expect-error clean-break API: external waits are a HarnessStorage responsibility
defineHarness().externalWait({})
// @ts-expect-error clean-break API: context checkpoints were removed
defineHarness().checkpoints({})
// @ts-expect-error clean-break API: durable files are configured through workspace
defineHarness().workspaceStore(inMemoryDurableWorkspace())

const provider: ModelProvider = {
	id: 'type-test-provider',
	genAiSystem: 'type-test',
	async object<T extends JsonValue = JsonValue>(_req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
		return {
			object: 'ok' as unknown as T,
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			finishReason: 'stop',
		}
	},
}

const arktypeTicket = arkType({
	ticketId: 'string',
	detail: { tags: 'string[]' },
})
const valibotTicket = v.object({
	ticketId: v.string(),
	detail: v.object({ tags: v.array(v.string()) }),
})
const valibotModelTicket = toStandardJsonSchema(valibotTicket)
const zodTransformedOutput = z.string().transform(value => value.length)

const _arktypeValidationSchema: Schema = arktypeTicket
const _arktypeModelSchema: ModelSchema = arktypeTicket
const _valibotValidationSchema: Schema = valibotTicket
const _valibotModelSchema: ModelSchema = valibotModelTicket
const _zodTransformInput: Expect<Equal<HarnessInferIn<typeof zodTransformedOutput>, string>> = true
const _zodTransformOutput: Expect<Equal<HarnessInfer<typeof zodTransformedOutput>, number>> = true

const crossVendorHarness = defineHarness()
	.models({ assistant: { provider, model: 'cross-vendor', capabilities: ['object'] } })
	.tools({
		arktype_lookup: {
			description: 'Looks up a ticket with an ArkType input contract.',
			input: arktypeTicket,
			output: valibotTicket,
			handler: async (_ctx, input) => ({ ticketId: input.ticketId, detail: { tags: input.detail.tags } }),
		},
		valibot_lookup: {
			description: 'Looks up a ticket with a Standard JSON Schema Valibot input contract.',
			input: valibotModelTicket,
			output: arktypeTicket,
			handler: async (_ctx, input) => ({ ticketId: input.ticketId, detail: { tags: input.detail.tags } }),
		},
	})
	.agent('ark_default', {
		model: 'assistant',
		input: valibotTicket,
		output: arktypeTicket,
		instructions: ({ input }) => input.ticketId,
	})
	.agent('valibot_handler', {
		input: arktypeTicket,
		output: zodTransformedOutput,
		handler: async ({ input }) => input.ticketId,
	})
	.workflow('valibot_workflow', {
		input: valibotTicket,
		output: arktypeTicket,
		handler: async ({ input }) => ({ ticketId: input.ticketId, detail: { tags: input.detail.tags } }),
	})
	.build()

type CrossVendorDefaultInput = typeof crossVendorHarness.$infer.agents.ark_default.input
type CrossVendorDefaultOutput = typeof crossVendorHarness.$infer.agents.ark_default.output
type CrossVendorHandlerOutput = typeof crossVendorHarness.$infer.agents.valibot_handler.output
type CrossVendorWorkflowInput = typeof crossVendorHarness.$infer.workflows.valibot_workflow.input
const _crossVendorDefaultInput: Expect<
	Equal<CrossVendorDefaultInput, { ticketId: string; detail: { tags: string[] } }>
> = true
const _crossVendorDefaultOutput: Expect<
	Equal<CrossVendorDefaultOutput, { ticketId: string; detail: { tags: string[] } }>
> = true
const _crossVendorHandlerOutput: Expect<Equal<CrossVendorHandlerOutput, number>> = true
const _crossVendorWorkflowInput: Expect<
	Equal<CrossVendorWorkflowInput, { ticketId: string; detail: { tags: string[] } }>
> = true
void _arktypeValidationSchema
void _arktypeModelSchema
void _valibotValidationSchema
void _valibotModelSchema
void _zodTransformInput
void _zodTransformOutput
void _crossVendorDefaultInput
void _crossVendorDefaultOutput
void _crossVendorHandlerOutput
void _crossVendorWorkflowInput

const directGuardrails = {
	[agentGuardrailsBinding]: { id: 'type-test-guardrails' },
}
const registrationHarness = defineHarness()
	.models({ assistant: { provider, model: 'registration-model', capabilities: ['object'] } })
	.agent('classify', {
		model: 'assistant',
		input: z.object({ text: z.string() }),
		output: z.object({ category: z.string() }),
		instructions: ({ input }) => input.text,
		guardrails: directGuardrails,
	})
	.agents({
		summarize: {
			model: 'assistant',
			input: z.object({ text: z.string() }),
			output: z.object({ summary: z.string() }),
			instructions: 'Summarize the text.',
		},
	})
	.workflow('classify_request', {
		input: z.object({ text: z.string() }),
		output: z.object({ category: z.string() }),
		handler: async ({ input, agents }) => agents.classify(input),
	})
	.workflows({
		summarize_request: {
			input: z.object({ text: z.string() }),
			output: z.object({ summary: z.string() }),
			handler: async () => ({ summary: 'ready' }),
		},
	})
	.agent('route', {
		model: 'assistant',
		input: z.object({ category: z.string() }),
		output: z.object({ queue: z.string() }),
		instructions: ({ input }) => input.category,
	})
	.build()

type RegistrationAgentIds = keyof typeof registrationHarness.$infer.agents
type RegistrationWorkflowIds = keyof typeof registrationHarness.$infer.workflows
const _registrationAgentIds: Expect<Equal<RegistrationAgentIds, 'classify' | 'summarize' | 'route'>> = true
const _registrationWorkflowIds: Expect<Equal<RegistrationWorkflowIds, 'classify_request' | 'summarize_request'>> = true
const _pluralAgentInput: Expect<Equal<typeof registrationHarness.$infer.agents.summarize.input, { text: string }>> =
	true
const _pluralWorkflowOutput: Expect<
	Equal<typeof registrationHarness.$infer.workflows.summarize_request.output, { summary: string }>
> = true
void _registrationAgentIds
void _registrationWorkflowIds
void _pluralAgentInput
void _pluralWorkflowOutput

defineHarness()
	.models({ assistant: { provider, model: 'callback-removal', capabilities: ['object'] } })
	// @ts-expect-error agent callback identity helpers were removed.
	.agents(() => ({ answer: { model: 'assistant', instructions: 'Answer.' } }))

defineHarness()
	// @ts-expect-error workflow callback identity helpers were removed.
	.workflows(() => ({ run: { handler: async () => 'done' } }))

defineHarness()
	.models({ assistant: { provider, model: 'custom-handler-controls', capabilities: ['object'] } })
	// @ts-expect-error custom handlers cannot configure default-loop Guardrails.
	.agent('custom', {
		model: 'assistant',
		handler: async ({ input }: { input: string }) => input,
		guardrails: directGuardrails,
	})

const nonJsonDate = z.date()
const stringOutput = z.string()
type _StringJsonOutput = Expect<Equal<HarnessInfer<typeof stringOutput> extends JsonValue ? true : false, true>>
type _DateJsonOutput = Expect<Equal<HarnessInfer<typeof nonJsonDate> extends JsonValue ? true : false, false>>
const invalidNonJsonTool: TsToolDefinition<typeof nonJsonDate, typeof stringOutput> = {
	description: 'This declaration must never typecheck.',
	// @ts-expect-error validated schema output must be a JSON value.
	input: nonJsonDate,
	output: stringOutput,
	handler: async () => 'never',
}
void invalidNonJsonTool

const modelModule = defineHarnessModule<{}>()('support-models', {
	register(builder) {
		return builder.models({ support: { provider, model: 'support-model', capabilities: ['object'] } })
	},
})

type SupportModelsState = { models: { support: ModelAlias } }
const agentModule = defineHarnessModule<SupportModelsState>()('support-agent', {
	register(builder) {
		return builder.agent('respond', {
			model: 'support',
			input: z.object({ question: z.string() }),
			output: z.object({ answer: z.string() }),
			instructions: 'Answer the support question.',
		})
	},
})

const moduleHarness = defineHarness().use(modelModule).use(agentModule).build()
type ModuleAgentInput = typeof moduleHarness.$infer.agents.respond.input
const _moduleAgentInputExact: Expect<Equal<ModuleAgentInput, { question: string }>> = true
void moduleHarness.getSession('typed-session', { identity: { tenantId: 'acme' } })
// @ts-expect-error clean-break API: identity belongs in SessionOptions.
void moduleHarness.getSession('typed-session', { tenantId: 'acme' })

const interceptorHarness = defineHarness()
	.models({ guarded: { provider, model: 'guarded-model', capabilities: ['object'] } })
	.agent('guarded', {
		model: 'guarded',
		input: z.object({ question: z.string() }),
		output: z.object({ answer: z.string() }),
		builtinTools: false,
		instructions: ({ input }) => input.question,
		interceptors: [
			{
				id: 'typed-boundary',
				beforeInput: ctx => {
					const _inputExact: Expect<Equal<typeof ctx.input, { question: string }>> = true
					return { decision: 'transform', value: { question: ctx.input.question.trim() } }
				},
				afterModel: ctx => {
					const _agentInputExact: Expect<Equal<typeof ctx.agentInput, { question: string }>> = true
					const _responseIsNotAny: IsAny<typeof ctx.response> extends true ? 'any' : 'ok' = 'ok'
					return { decision: 'allow' }
				},
			},
		],
	})
	.build()

const _interceptorAgentInputExact: Expect<
	Equal<typeof interceptorHarness.$infer.agents.guarded.input, { question: string }>
> = true

const interceptorRequirements: AgentExecutionRequirements = {
	tools: ['read'],
	models: [{ alias: 'guarded', capabilities: ['object'] }],
}
void interceptorRequirements
const emptyInterceptorTools: AgentExecutionRequirements = { tools: [] }
const invalidInterceptorCapability: AgentExecutionRequirements = {
	// @ts-expect-error requirements reuse the closed model capability vocabulary.
	models: [{ alias: 'guarded', capabilities: ['json'] }],
}
void emptyInterceptorTools
void invalidInterceptorCapability

defineHarnessModule<{}>()('no-build-module', {
	register(builder) {
		// @ts-expect-error static module builders intentionally cannot build a harness
		builder.build()
		return builder.models({ local: { provider, model: 'local', capabilities: ['object'] } })
	},
})

const harness = defineHarness()
	.memory(inMemoryMemoryEngine())
	.models({
		assistant: { provider, model: 'type-test-model', capabilities: ['object'] },
		reviewer: { provider, model: 'type-test-reviewer-model', capabilities: ['object'] },
	})
	.tools({
		transfer_funds: {
			description: 'Transfer funds between accounts.',
			input: z.object({ amount: z.number(), balance: z.number() }),
			output: z.object({ approved: z.boolean() }),
			handler: async () => ({ approved: true }),
		},
	})
	.agent('planner', {
		input: z.object({ task: z.string(), priority: z.number() }),
		output: z.object({ plan: z.string(), accepted: z.boolean() }),
		handler: async ctx => {
			type Input = typeof ctx.input
			const _inputIsNotAny: IsAny<Input> extends true ? 'any' : 'ok' = 'ok'
			const _inputExact: Expect<Equal<Input, { task: string; priority: number }>> = true
			await ctx.memory.run.write('plan_input', { task: ctx.input.task })
			await ctx.memory.agent?.write('last_priority', ctx.input.priority)
			return { plan: ctx.input.task, accepted: ctx.input.priority > 0 }
		},
	})
	.workflow('prepare', {
		input: z.object({ task: z.string() }),
		output: z.object({ plan: z.string(), accepted: z.boolean() }),
		delegation: {
			agents: ['planner'],
			agentModelAliases: { planner: ['assistant', 'reviewer'] },
			maxChildAgentCalls: 2,
			maxParallelChildAgentCalls: 1,
		},
		handler: async ctx => {
			type Input = typeof ctx.input
			const _inputIsNotAny: IsAny<Input> extends true ? 'any' : 'ok' = 'ok'
			const _inputExact: Expect<Equal<Input, { task: string }>> = true
			const _loggerIsLogger: Expect<Equal<typeof ctx.logger, Logger>> = true
			const _telemetryIsTyped: Expect<Equal<typeof ctx.telemetry, TelemetryShim>> = true
			ctx.logger.debug('workflow handler logging is typed')
			await ctx.memory.session.write('workflow_task', { task: ctx.input.task })
			await ctx.memory.run.write('workflow_seen', true)
			await ctx.memory.principal().write('workflow_principal', 'ok')

			const plan = await ctx.agents.planner({ task: ctx.input.task, priority: 1 })
			type PlanOutput = typeof plan
			const _agentOutputExact: Expect<Equal<PlanOutput, { plan: string; accepted: boolean }>> = true
			const reviewedPlan = await ctx.agents.planner({ task: ctx.input.task, priority: 1 }, { model: 'reviewer' })
			const _reviewedAgentOutputExact: Expect<Equal<typeof reviewedPlan, { plan: string; accepted: boolean }>> = true
			// @ts-expect-error workflow-local agent model overrides must use configured model aliases
			await ctx.agents.planner({ task: ctx.input.task, priority: 1 }, { model: 'missing' })

			const background = await ctx.childTasks.start('planner', { task: ctx.input.task, priority: 1 })
			const backgroundResult = background.result()
			const _backgroundOutputExact: Expect<
				Equal<typeof backgroundResult, Promise<{ plan: string; accepted: boolean }>>
			> = true
			const continuable = await ctx.childTasks.start(
				'planner',
				{ task: ctx.input.task, priority: 1 },
				{ mode: 'continuable' },
			)
			const continuableResult = continuable.send({ task: ctx.input.task, priority: 2 })
			const _continuableOutputExact: Expect<
				Equal<typeof continuableResult, Promise<{ plan: string; accepted: boolean }>>
			> = true
			// @ts-expect-error continuable task turns retain the selected agent input schema
			await continuable.send({ task: ctx.input.task })
			await continuable.close()
			await ctx.fanOut([1, 2], async value => value * 2, { concurrency: 1 })

			return plan
		},
	})
	.workflow('invalid_output', {
		input: z.object({ task: z.string() }),
		output: z.object({ plan: z.string(), accepted: z.boolean() }),
		// @ts-expect-error workflow handlers must return the sibling output schema type
		handler: async ctx => ctx.input.task,
	})
	.governance(({ native, rule }) => ({
		defaultEffect: 'allow',
		policies: [
			native({
				id: 'typed-bank-policy',
				rules: [
					rule({
						id: 'insufficient-funds',
						effect: 'deny',
						tools: ['transfer_funds'],
						when: ctx => {
							type Input = typeof ctx.input
							const _inputIsNotAny: IsAny<Input> extends true ? 'any' : 'ok' = 'ok'
							const _inputExact: Expect<Equal<Input, { amount: number; balance: number }>> = true
							return ctx.input.balance < ctx.input.amount
						},
					}),
					rule({
						id: 'bad-field',
						effect: 'deny',
						tools: ['transfer_funds'],
						// @ts-expect-error governance predicates use the selected tool input schema
						when: ctx => ctx.input.currency === 'EUR',
					}),
				],
			}),
		],
	}))
	.build()

defineHarness()
	.models({
		assistant: { provider, model: 'type-test-model', capabilities: ['object', 'tool_use'] },
	})
	.tools({
		transfer_funds: {
			description: 'Transfer funds.',
			input: z.object({ amount: z.number(), balance: z.number() }),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
		},
	})
	.agent('banker', {
		model: 'assistant',
		input: z.string(),
		output: z.string(),
		tools: ['transfer_funds'],
		builtinTools: false,
		instructions: 'Transfer funds.',
	})
	.governance(({ exposureRule }) => {
		exposureRule({
			id: 'bad-exposure-tool',
			effect: 'hide',
			// @ts-expect-error governance exposure rules must reference known tools
			tools: ['missing_tool'],
		})
		return {
			exposure: {
				rules: [
					exposureRule({
						id: 'hide-transfers',
						effect: 'hide',
						tools: ['transfer_funds'],
						when: ctx => {
							type ToolId = typeof ctx.toolId
							const _toolIdExact: Expect<Equal<ToolId, 'transfer_funds'>> = true
							return ctx.step >= 0
						},
					}),
				],
			},
		}
	})
	.build()

type PrepareInput = typeof harness.$infer.workflows.prepare.input
type PrepareOutput = typeof harness.$infer.workflows.prepare.output
type PlannerInput = typeof harness.$infer.agents.planner.input
type PlannerOutput = typeof harness.$infer.agents.planner.output

const _workflowInputExact: Expect<Equal<PrepareInput, { task: string }>> = true
const _workflowOutputExact: Expect<Equal<PrepareOutput, { plan: string; accepted: boolean }>> = true
const _agentInputExact: Expect<Equal<PlannerInput, { task: string; priority: number }>> = true
const _agentOutputExact: Expect<Equal<PlannerOutput, { plan: string; accepted: boolean }>> = true

async function invokeWorkflow() {
	const session = await harness.getSession('type-test')
	const agentOutput = await session.agents.planner.run({ task: 'ship typing', priority: 1 })
	const _agentInvokeOutputExact: Expect<
		Equal<typeof agentOutput, RunOutcome<{ plan: string; accepted: boolean }>>
	> = true

	// @ts-expect-error agent run input must match the sibling input schema
	await session.agents.planner.run({ task: 'missing priority' })

	const output = await session.workflows.prepare.run({ task: 'ship typing' })
	const _outputExact: Expect<Equal<typeof output, RunOutcome<{ plan: string; accepted: boolean }>>> = true

	// @ts-expect-error workflow run input must match the sibling input schema
	await session.workflows.prepare.run({ topic: 'wrong key' })
}

type CapabilityAwareBuilder<S extends BuilderState> = Omit<HarnessBuilder<S>, 'build' | 'models'> & {
	requires(required: readonly AdapterCapability[]): CapabilityAwareBuilder<S>
	models<const M extends ModelsConfig>(models: M): CapabilityAwareBuilder<S & { models: M }>
	build(): Harness<S> & { inspect(): HarnessInspection }
}

const futureCapabilityHarness = (defineHarness() as CapabilityAwareBuilder<{}>)
	.requires(['sandbox.snapshot', 'sandbox.resume', 'storage.checkpoint'])
	.models({
		assistant: { provider, model: 'type-test-model', capabilities: ['object'] },
	})
	.build()

const futureCapabilities = futureCapabilityHarness.inspect().capabilities
type AdapterCapabilityList = readonly AdapterCapability[]
const _futureCapabilitiesExact: Expect<Equal<typeof futureCapabilities, AdapterCapabilityList>> = true

// @ts-expect-error requires only accepts stable AdapterCapability values
const _invalidFutureRequirement: AdapterCapability = 'sandbox.teleport'
const _validMemoryRequirement: AdapterCapability = 'memory.persistent'

const capabilityRegistry = createModelRegistry({
	textOnly: { provider, model: 'type-test-model', capabilities: ['text'] },
	streamReady: { provider, model: 'type-test-model', capabilities: ['text_stream'] },
	embeddingReady: { provider, model: 'type-test-model', capabilities: ['text', 'embeddings'] },
})

capabilityRegistry['textOnly']!.text({ messages: [] }, new AbortController().signal)
// @ts-expect-error tools require the tool_use marker capability
capabilityRegistry['textOnly']!.text({ messages: [], tools: [] }, new AbortController().signal)
capabilityRegistry['textOnly']!.text(
	// @ts-expect-error image parts require the vision_input marker capability
	{ messages: [{ role: 'user', content: [{ kind: 'image_url', url: 'https://example.com/image.png' }] }] },
	new AbortController().signal,
)
// @ts-expect-error embeddings are not exposed unless the alias declares the embeddings capability
capabilityRegistry['textOnly']!.embed({ input: 'hello' }, new AbortController().signal)
capabilityRegistry['embeddingReady']!.embed({ input: 'hello' }, new AbortController().signal)
// @ts-expect-error rerank is not exposed unless the alias declares the rerank capability
capabilityRegistry['embeddingReady']!.rerank({ query: 'hello', documents: [] }, new AbortController().signal)
capabilityRegistry['streamReady']!.textStream({ messages: [] }, new AbortController().signal, { emitRunEvents: true })
capabilityRegistry['streamReady']!.textStream({ messages: [] }, new AbortController().signal, {
	emitRunEvents: true,
	// @ts-expect-error streamId is harness-generated and not caller-provided
	streamId: 'public-answer',
})
capabilityRegistry['streamReady']!.textStream({ messages: [] }, new AbortController().signal, {
	emitRunEvents: true,
	// @ts-expect-error app-specific stream names belong in the integration layer
	streamKey: 'public-answer',
})

const richCapabilityRegistry = createModelRegistry({
	visionToolModel: { provider, model: 'type-test-model', capabilities: ['text', 'tool_use', 'vision_input'] },
})

richCapabilityRegistry['visionToolModel']!.text(
	{
		messages: [{ role: 'user', content: [{ kind: 'image_url', url: 'https://example.com/image.png' }] }],
		tools: [],
	},
	new AbortController().signal,
)
richCapabilityRegistry['visionToolModel']!.text(
	// @ts-expect-error audio parts require the audio_input marker capability
	{ messages: [{ role: 'user', content: [{ kind: 'audio', mimeType: 'audio/wav', dataBase64: 'abc' }] }] },
	new AbortController().signal,
)

async function sandboxCapabilityTypes() {
	const session = (
		await inMemorySandbox().open({
			scope: {
				owner: { namespace: 'type-test', id: 'type-session', instanceId: '01J00000000000000000000000' },
				partition: { kind: 'shared' },
				lifetime: 'run',
				runId: 'type-run',
			},
			mode: 'create',
		})
	).session
	await session.readText('/workspace/file.txt')
	await session.searchText({ path: '/workspace', pattern: 'needle', syntax: 'literal', caseSensitive: true, maxResults: 10 })
	// @ts-expect-error non-executable sandbox sessions do not expose exec
	await session.exec('echo hi')
}

const sessionSandboxScope: SandboxScope = {
	owner: { namespace: 'types', id: 'session', instanceId: '01J00000000000000000000000' },
	partition: { kind: 'shared' },
	lifetime: 'session',
}
// @ts-expect-error a session scope cannot carry a run id
const invalidSessionSandboxScope: SandboxScope = { ...sessionSandboxScope, runId: 'run' }
// @ts-expect-error run scopes require a run id
const invalidRunSandboxScope: SandboxScope = { ...sessionSandboxScope, lifetime: 'run' }
// @ts-expect-error child tasks always have a run lifetime
const invalidChildSandboxScope: SandboxScope = { ...sessionSandboxScope, partition: { kind: 'unknown' } }
// @ts-expect-error unsupported sandbox configuration is rejected in the clean API
bashSandbox({ network: { deny: ['https://example.com'] } })
// @ts-expect-error filesystem limits do not promise host-memory isolation
bashSandbox({ executionLimits: { memoryMb: 128 } })

declare const processSandbox: Sandbox<readonly ['sandbox.fs', 'sandbox.exec', 'sandbox.spawn']>
declare const dynamicSandbox: Sandbox
export function inferredPublicSandboxResult() {
	return inMemorySandbox().open({ scope: sessionSandboxScope, mode: 'create' })
}
export function inferredPublicDynamicSandboxResult() {
	return dynamicSandbox.open({ scope: sessionSandboxScope, mode: 'attach' })
}
// @ts-expect-error auto-detection cannot be given fabricated capability types
defineHarness().sandbox<readonly ['sandbox.fs', 'sandbox.spawn']>()
async function inferredSandboxOperations() {
	const precise = (await processSandbox.open({ scope: sessionSandboxScope, mode: 'create' })).session
	await precise.exec('echo hi')
	await precise.spawn('server', { args: ['--stdio'] })
	const dynamic = (await dynamicSandbox.open({ scope: sessionSandboxScope, mode: 'attach' })).session
	await dynamic.readText('/workspace/file')
	// @ts-expect-error widened capabilities do not guarantee an executor
	await dynamic.exec('echo hi')
	// @ts-expect-error widened capabilities do not guarantee process spawning
	await dynamic.spawn('server')
	if (isExecCapableSession(dynamic)) await dynamic.exec('echo hi')
	if (isSpawnCapableSession(dynamic)) await dynamic.spawn('server')
}
type _SandboxSessionNeverAny = Expect<Equal<IsAny<SandboxSessionFor<readonly AdapterCapability[]>>, false>>
const widenedFilesAdapter: Sandbox = inMemorySandbox()
async function partiallyKnownCapabilities(
	session: SandboxSessionFor<readonly ['sandbox.fs', 'sandbox.exec' | 'sandbox.spawn']>,
) {
	// @ts-expect-error a union capability is not a guarantee that exec is present
	await session.exec('echo hi')
	// @ts-expect-error a union capability is not a guarantee that spawn is present
	await session.spawn('server')
}

defineHarness()
	.sandbox(inMemorySandbox())
	.tools({
		files_only: {
			description: 'Read files with precise sandbox types',
			input: z.string(),
			output: z.string(),
			handler: async ctx => {
				const executor: 'unavailable' = ctx.sandbox.executor
				await ctx.sandbox.searchText({ path: '/workspace', pattern: 'needle', syntax: 'literal', caseSensitive: true, maxResults: 10 })
				// @ts-expect-error registered non-executable sandbox does not provide exec
				await ctx.sandbox.exec('echo hi')
				// @ts-expect-error registered files-only sandbox does not provide spawn
				await ctx.sandbox.spawn('server')
				return ctx.sandbox.readText('/workspace/file')
			},
		},
	})
defineHarness()
	.sandbox(processSandbox)
	.models({ primary: { provider, model: 'type-test-model', capabilities: ['text'] } })
	.tools({
		process_tool: {
			description: 'Process capabilities survive subsequent builder calls',
			input: z.string(),
			output: z.string(),
			handler: async ctx => {
				type _InferredSandboxNotAny = Expect<Equal<IsAny<typeof ctx.sandbox>, false>>
				await ctx.sandbox.spawn('server')
				return (await ctx.sandbox.exec('echo hi')).stdout
			},
		},
	})
defineHarness().tools({
	default_sandbox: {
		description: 'Auto-detected capabilities must be narrowed',
		input: z.string(),
		output: z.string(),
		handler: async ctx => {
			// @ts-expect-error auto-detection does not guarantee exec
			await ctx.sandbox.exec('echo hi')
			if (isTextSearchCapableSession(ctx.sandbox)) await ctx.sandbox.searchText({ path: '/', pattern: 'x', syntax: 'literal', caseSensitive: true, maxResults: 1 })
			return isExecCapableSession(ctx.sandbox) ? (await ctx.sandbox.exec('echo hi')).stdout : 'files only'
		},
	},
})
declare const shellTool: TsToolDefinition<
	z.ZodString,
	z.ZodString,
	ToolHandlerContext<readonly ['sandbox.fs', 'sandbox.exec']>
>
// @ts-expect-error unregistered native definitions cannot cross a builder boundary.
defineHarness().sandbox(inMemorySandbox()).tools({ shell_tool: shellTool })
declare const reusableFilesTool: TsToolDefinition<z.ZodString, z.ZodString>
defineHarness().sandbox(inMemorySandbox()).tools({ reusable_files_tool: reusableFilesTool })
declare const chosenSandbox: Sandbox<readonly ['sandbox.fs']> | Sandbox<readonly ['sandbox.fs', 'sandbox.exec']>
defineHarness()
	.sandbox(chosenSandbox)
	.tools({
		conditional_adapter: {
			description: 'A runtime adapter choice preserves only guaranteed operations',
			input: z.string(),
			output: z.string(),
			handler: async ctx => {
				// @ts-expect-error one branch is files-only, so exec requires narrowing
				await ctx.sandbox.exec('echo hi')
				return ctx.sandbox.readText('/workspace/file')
			},
		},
	})

const sandboxTypeModule = defineHarnessModule()('sandbox-types', {
	register: builder => builder.models({ moduleModel: { provider, model: 'type-test-model', capabilities: ['text'] } }),
})

const callbackToolsModule = defineHarnessModule()('callback-tools', {
	register: builder =>
		builder.tools({
			module_lookup: {
				description: 'A static module registers native tools directly.',
				input: z.object({ id: z.string() }),
				output: z.object({ value: z.string() }),
				handler: async (_ctx, input) => ({ value: input.id }),
			},
		}),
})

defineHarness().use(callbackToolsModule).build()

defineHarness().tool('inferred_tool', {
		description: 'Contextually typed native tool.',
		input: z.object({ query: z.string().default('all') }),
		output: z.object({ count: z.coerce.number() }),
		handler: async (_ctx, input) => {
			type Input = typeof input
			const _inputExact: Expect<Equal<Input, { query: string }>> = true
			// @ts-expect-error native handler input is inferred from its schema.
			input.missing
			return { count: '1' }
		},
})

defineHarness().tool('invalid_output', {
	description: 'Output checking remains schema-derived.',
	// @ts-expect-error the incompatible handler makes this native definition fail overload resolution.
	input: z.string(),
	output: z.object({ value: z.string() }),
	handler: async (_ctx, input) => ({ unexpected: input }),
})

const directToolModule = defineHarnessModule()('direct-tool', {
	register: builder =>
		builder.tool('module_echo', {
			description: 'Static modules use the same direct tool API.',
			input: z.string(),
			output: z.string(),
			handler: async (_ctx, input) => input,
		}),
})
void directToolModule

defineHarness().tool('raw_native', {
	description: 'Direct native definitions cross the builder boundary without branding.',
	input: z.string(),
	output: z.string(),
	handler: async (_ctx, input) => input,
})
defineHarness()
	.sandbox(processSandbox)
	.use(sandboxTypeModule)
	.tools({
		preserved_capabilities: {
			description: 'Module composition preserves the configured sandbox',
			input: z.string(),
			output: z.string(),
			handler: async ctx => {
				await ctx.sandbox.spawn('server')
				return (await ctx.sandbox.exec('echo hi')).stdout
			},
		},
	})

const transformedInvocationHarness = defineHarness()
	.models({ transformed: { provider, model: 'type-test-model', capabilities: ['object'] } })
	.agent('worker', {
		input: z.string().transform(Number),
		output: z.string().transform(Number),
		handler: async ctx => {
			const _contextInput: Expect<Equal<typeof ctx.input, number>> = true
			return String(ctx.input)
		},
	})
	.workflow('delegated', {
		input: z.string().default('3').transform(Number),
		output: z.string().transform(Number),
		delegation: { agents: ['worker'] },
		handler: async ctx => {
			const _workflowContextInput: Expect<Equal<typeof ctx.input, number>> = true
			const delegated: number = await ctx.agents.worker('5')
			const child = await ctx.childTasks.start('worker', '5')
			const childResult: Promise<number> = child.result()
			void delegated
			void childResult
			// @ts-expect-error delegated agent invocation accepts the raw input schema type.
			await ctx.agents.worker(5)
			// @ts-expect-error child tasks retain the delegated agent raw input schema type.
			await ctx.childTasks.start('worker', 5)
			return '6'
		},
	})
	.build()

type TransformedAgentInput = typeof transformedInvocationHarness.$infer.agents.worker.input
type TransformedAgentOutput = typeof transformedInvocationHarness.$infer.agents.worker.output
type TransformedWorkflowInput = typeof transformedInvocationHarness.$infer.workflows.delegated.input
type TransformedWorkflowOutput = typeof transformedInvocationHarness.$infer.workflows.delegated.output
const _transformedAgentInput: Expect<Equal<TransformedAgentInput, string>> = true
const _transformedAgentOutput: Expect<Equal<TransformedAgentOutput, number>> = true
const _transformedWorkflowInput: Expect<Equal<TransformedWorkflowInput, string | undefined>> = true
const _transformedWorkflowOutput: Expect<Equal<TransformedWorkflowOutput, number>> = true

const portableDefinition = defineHarness({ name: 'portable-type-test' })
	.requireModels({
		primary: { capabilities: ['object'] as const },
		embeddings: { capabilities: ['embeddings'] as const },
	})
	.agent('portable_agent', {
		model: 'primary',
		input: z.object({ question: z.string() }),
		output: z.object({ answer: z.string() }),
		instructions: 'Answer the question.',
	})
	.agent('portable_handler', {
		input: z.string(),
		output: z.string(),
		handler: async ctx => {
			await ctx.models.embeddings.embed({ input: ctx.input }, ctx.signal)
			return ctx.input
		},
	})
	.define()

portableDefinition.getInstance({
	models: {
		primary: { provider, model: 'primary-model' },
		embeddings: { provider, model: 'embedding-model' },
	},
})
// @ts-expect-error every required alias needs a runtime binding
portableDefinition.getInstance({ models: { primary: { provider, model: 'primary-model' } } })
portableDefinition.getInstance({
	models: {
		// @ts-expect-error runtime bindings cannot replace definition-time capabilities
		primary: { provider, model: 'primary-model', capabilities: ['text'] },
		embeddings: { provider, model: 'embedding-model' },
	},
})

defineHarness()
	.models({
		textOnly: { provider, model: 'type-test-model', capabilities: ['text'] },
		embeddingReady: { provider, model: 'type-test-model', capabilities: ['text', 'embeddings'] },
	})
	.agent('typed_models', {
		input: z.string(),
		output: z.string(),
		handler: async ctx => {
			await ctx.models.textOnly.text({ messages: [] }, ctx.signal)
			// @ts-expect-error handler model handles only expose declared capabilities
			await ctx.models.textOnly.embed({ input: 'hello' }, ctx.signal)
			await ctx.models.embeddingReady.embed({ input: 'hello' }, ctx.signal)
			return ctx.input
		},
	})
	.workflow('typed_workflow_models', {
		input: z.string(),
		output: z.string(),
		handler: async ctx => {
			await ctx.models.textOnly.text({ messages: [] }, ctx.signal)
			// @ts-expect-error workflow model handles only expose declared capabilities
			await ctx.models.textOnly.embed({ input: 'hello' }, ctx.signal)
			await ctx.models.embeddingReady.embed({ input: 'hello' }, ctx.signal)
			return ctx.input
		},
	})

const vectorMemoryEngine = inMemoryMemoryEngine() as unknown as MemoryEngine<
	readonly ['memory.kv', 'memory.list', 'memory.delete', 'memory.vector_search']
>
defineHarness()
	.models({
		memoryEmbedding: { provider, model: 'type-test-model', capabilities: ['embeddings'] },
		memorySummary: { provider, model: 'type-test-model', capabilities: ['object'] },
		textOnlyMemory: { provider, model: 'type-test-model', capabilities: ['text'] },
	})
	.memory(model => ({ engine: vectorMemoryEngine, embedding: model.memoryEmbedding, summary: model.memorySummary }))

defineHarness()
	.models({ memoryEmbedding: { provider, model: 'type-test-model', capabilities: ['embeddings'] } })
	.memory(model => ({
		engine: inMemoryMemoryEngine(),
		// @ts-expect-error embedding configuration requires a vector-search engine
		embedding: model.memoryEmbedding,
	}))

defineHarness()
	.models({ assistant: { provider, model: 'type-test-model', capabilities: ['object', 'tool_use'] } })
	.tools({
		transfer: {
			description: 'Transfer.',
			input: z.object({ amount: z.number() }),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
		},
		archive: {
			description: 'Archive.',
			input: z.object({ ticket: z.string() }),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
		},
	})
	.agent('governance_types', {
		model: 'assistant',
		input: z.string(),
		output: z.string(),
		instructions: 'Use a tool.',
		tools: ['transfer', 'archive'],
	})
	.governance(({ native, rule }) => ({
		policies: [
			native({
				id: 'selector-types',
				rules: [
					{
						id: 'raw-narrow-rule',
						effect: 'audit',
						// @ts-expect-error raw stored rules must accept the full correlated context union.
						when: (ctx: { toolId: 'transfer'; input: { amount: number } }) => ctx.input.amount > 0,
					},
					rule({
						id: 'multi-tool-rule',
						effect: 'audit',
						tools: ['transfer', 'archive'] as const,
						when: ctx => {
							if (ctx.toolId === 'transfer') return ctx.input.amount > 0
							if (ctx.toolId === 'archive') return ctx.input.ticket.length > 0
							return false
						},
					}),
					rule({
						id: 'no-selector-full-union',
						effect: 'audit',
						when: ctx => {
							// @ts-expect-error input is correlated and requires toolId narrowing.
							return ctx.input.amount > 0
						},
					}),
					rule({
						id: 'selector-mismatch',
						effect: 'audit',
						// @ts-expect-error selector cannot be inferred from an incompatible predicate.
						tools: ['archive'] as const,
						// @ts-expect-error a transfer-only predicate cannot be selected for archive.
						when: (ctx: { toolId: 'transfer'; input: { amount: number } }) => ctx.input.amount > 0,
					}),
				],
			}),
		],
	}))

const approvalSubjectBuilder = defineHarness()
	.models({ approval_subject_model: { provider, model: 'type-test-model', capabilities: ['object'] } })
	.tools({
		approval_transfer: {
			description: 'Transfer.',
			input: z.object({ amount: z.number() }),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
		},
		approval_archive: {
			description: 'Archive.',
			input: z.object({ ticket: z.string() }),
			output: z.object({ ok: z.boolean() }),
			handler: async () => ({ ok: true }),
		},
	})
type ApprovalSubjectState = typeof approvalSubjectBuilder extends HarnessBuilder<infer S> ? S : never
declare const approvalSubject: GovernanceApprovalSubject<ApprovalSubjectState>
if (approvalSubject.toolId === 'approval_transfer') approvalSubject.input.amount
if (approvalSubject.toolId === 'approval_archive') approvalSubject.input.ticket

approvalSubjectBuilder.governance({
	approval: {
		async request(request, execution) {
			const signal: AbortSignal = execution.signal
			const deadline: number = execution.deadline
			void signal
			void deadline
			// @ts-expect-error the input must be narrowed by its correlated tool id.
			request.subject.input.amount
			if (request.subject.toolId === 'approval_transfer') {
				const amount: number = request.subject.input.amount
				void amount
				// @ts-expect-error transfer input does not contain archive fields.
				request.subject.input.ticket
			}
			if (request.subject.toolId === 'approval_archive') {
				const ticket: string = request.subject.input.ticket
				void ticket
				// @ts-expect-error archive input does not contain transfer fields.
				request.subject.input.amount
			}
			// @ts-expect-error execution is a bounded callback context, not arbitrary configuration.
			execution.missing
			return { decision: 'approved' }
		},
	},
})

const standaloneApprovalProvider: GovernanceApprovalProvider = {
	async request(request, execution) {
		const toolId: string = request.subject.toolId
		const signal: AbortSignal = execution.signal
		void toolId
		void signal
		return { decision: 'approved' }
	},
}
approvalSubjectBuilder.governance({ approval: standaloneApprovalProvider })
approvalSubjectBuilder.governance(() => ({
	approval: {
		async request(request, execution) {
			if (request.subject.toolId === 'approval_transfer') {
				const amount: number = request.subject.input.amount
				void amount
				// @ts-expect-error helper callback retains the selected tool input shape.
				request.subject.input.ticket
			}
			const deadline: number = execution.deadline
			void deadline
			return { decision: 'approved' }
		},
	},
}))

declare const toolSpecificApprovalProvider: GovernanceApprovalProvider<ApprovalSubjectState>
// @ts-expect-error an adapter for a specific tool set cannot handle arbitrary builder subjects.
const unsafeStandaloneApprovalProvider: GovernanceApprovalProvider = toolSpecificApprovalProvider
void unsafeStandaloneApprovalProvider

// Clean API contract: singular `.tool` provides exact contextual inference,
// while plural `.tools` carries an already-authored record through unchanged.
const cleanApiPretypedTools: Record<'pretyped_echo', TsToolDefinition<z.ZodObject<{ value: z.ZodString }>, z.ZodObject<{ value: z.ZodString }>>> = {
	pretyped_echo: {
		description: 'A pretyped native tool map.',
		input: z.object({ value: z.string() }),
		output: z.object({ value: z.string() }),
		handler: async (_ctx, input) => input,
	},
}
const cleanApiPluralToolBuilder = defineHarness().tools(cleanApiPretypedTools)
type CleanApiPluralToolState = typeof cleanApiPluralToolBuilder extends HarnessBuilder<infer S> ? S : never
const _cleanApiPluralToolsPreserved: Expect<Equal<CleanApiPluralToolState['tools'], typeof cleanApiPretypedTools>> = true
void _cleanApiPluralToolsPreserved

defineHarness().tool('clean_api_singular_tool', {
	description: 'A singular native tool with exact contextual types.',
	input: z.object({ query: z.string().default('all') }),
	output: z.object({ count: z.coerce.number() }),
	handler: async (ctx, input) => {
		const _inputExact: Expect<Equal<typeof input, { query: string }>> = true
		const _loggerExact: Expect<Equal<typeof ctx.logger, Logger>> = true
		const _telemetryExact: Expect<Equal<typeof ctx.telemetry, TelemetryShim>> = true
		ctx.logger.info('clean api singular tool')
		ctx.telemetry.recordCounter('app.clean_api_tool.calls', 1, {})
		// @ts-expect-error singular tool handler input is inferred from its sibling schema.
		input.missing
		return { count: '1' }
	},
})

defineHarness()
	// @ts-expect-error plural tool registration accepts a pretyped record, not a callback helper.
	.tools(() => ({ callback_tool: cleanApiPretypedTools.pretyped_echo }))

const allModuleFacadeMethods = defineHarnessModule()('clean-api-facade-methods', {
	register(builder) {
		const configured = builder
			.model('module_primary', { provider, model: 'type-test-model', capabilities: ['object'] })
			.models({ module_secondary: { provider, model: 'type-test-model', capabilities: ['object'] } })
			.tool('module_singular_tool', {
				description: 'Module singular tool.',
				input: z.string(),
				output: z.string(),
				handler: async (_ctx, input) => input,
			})
			.tools(cleanApiPretypedTools)
			.skill('module-skill', { directory: '/does/not/matter' })
			.skills({ 'module-skill-two': { directory: '/does/not/matter' } })
			.agent('module_agent', { model: 'module_primary', instructions: 'Answer.' })
			.agents({ module_agent_two: { model: 'module_primary', instructions: 'Answer too.' } })
			.workflow('module_workflow', { input: z.string(), output: z.string(), handler: async ctx => ctx.input })
			.workflows({ module_workflow_two: { input: z.string(), output: z.string(), handler: async ctx => ctx.input } })

		// @ts-expect-error static module facades contribute definitions only; they cannot build harnesses.
		configured.build()
		// @ts-expect-error static module facades cannot compose other modules.
		configured.use(allModuleFacadeMethods)
		return configured
	},
})
void allModuleFacadeMethods

async function cleanApiLegacySurfaceIsAbsent(): Promise<void> {
	const session = await harness.getSession('clean-api-legacy-surface')
	// @ts-expect-error public agent invokers expose run/stream, not prompt.
	await session.agents.planner.prompt({ task: 'ship typing', priority: 1 })
	// @ts-expect-error public workflow invokers expose run/stream, not prompt.
	await session.workflows.prepare.prompt({ task: 'ship typing' })
	// @ts-expect-error sessions expose release/destroy, not close.
	await session.close()
}
void cleanApiLegacySurfaceIsAbsent
