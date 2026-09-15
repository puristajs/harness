import {
	agentGuardrailsBinding,
	createDecisionEvidence,
	createTelemetryShim,
	DecisionBlockedError,
	DecisionEvaluationError,
	decisionResultSchema,
	isJsonValue,
	OperationCancelledError,
	OperationTimeoutError,
	runDecisionOperation,
	ulid,
} from '@purista/harness'
import type {
	AgentExecutionRequirements,
	AgentExecutionInterceptor,
	AgentExecutionInterceptorContext,
	AgentGuardrailsBinding,
	DecisionEvidence,
	JsonValue,
	Logger,
	ModelAliasId,
	ModelHandle,
	TelemetryShim,
} from '@purista/harness'
import { z } from 'zod'
import {
	actionMetadata,
	createGuardrailAction,
	isGuardrailAction,
	prepareGuardrailAction,
	validateGuardrailValue,
} from './action.js'
import type { AnyGuardrailAction, GuardrailAction, GuardrailActionDefinition, GuardrailEvaluator } from './action.js'
import { GuardrailsConfigError } from './errors.js'
import {
	guardrailsConfigSchema,
	type GuardrailPhase,
	type GuardrailsConfig,
	type GuardrailsConfigInput,
	type SensitiveDataPolicy,
} from './config-schema.js'
import { sensitiveDataFailureKind, sensitiveDataMetadata } from './sensitive-data.js'

export type { AnyGuardrailAction, GuardrailAction, GuardrailActionDefinition, GuardrailEvaluator } from './action.js'

/** The only transform target allowed for one guardrail phase. */
export type GuardrailTransformTarget<P extends GuardrailPhase = GuardrailPhase> = P extends 'input'
	? 'user_message'
	: P extends 'output'
		? 'bot_message'
		: P extends 'tool_input'
			? 'tool_input'
			: P extends 'tool_output'
				? 'tool_output'
				: 'relevant_chunks'

/** The protected value presented to a rail for one phase. */
export type GuardrailValue<P extends GuardrailPhase = GuardrailPhase> = P extends 'retrieval'
	? readonly JsonValue[]
	: JsonValue

type GuardrailDecision = Readonly<z.infer<typeof decisionResultSchema>>

const guardrailTransformSchema = decisionResultSchema.options[0].extend({
	decision: z.literal('transform'),
	target: z.string(),
	value: z.custom<JsonValue>(isJsonValue),
})

type GuardrailTransform<P extends GuardrailPhase, V> = Readonly<
	Omit<z.infer<typeof guardrailTransformSchema>, 'target' | 'value'>
> & {
	readonly target: GuardrailTransformTarget<P>
	readonly value: V
}

/** A strict allow, block, or phase-targeted replacement from one rail action. */
export type GuardrailOutcome<P extends GuardrailPhase = GuardrailPhase, V = GuardrailValue<P>> =
	| GuardrailDecision
	| GuardrailTransform<P, V>

/** Stable, content-free action context for one configured rail occurrence. */
export interface GuardrailActionContext<P extends GuardrailPhase = GuardrailPhase, V = GuardrailValue<P>> {
	readonly railId: string
	readonly phase: P
	readonly value: V
	readonly invocationId: string
	readonly step: number
	readonly agentId?: string
	readonly runId?: string
	readonly sessionId?: string
	readonly workflowId?: string
	readonly toolId?: string
	readonly callId?: string
	readonly modelAlias?: string
	readonly signal: AbortSignal
	readonly deadline: number
	readonly models?: Readonly<Record<string, ModelHandle<{ readonly capabilities: readonly ['object'] }>>>
	/** Internal policy binding supplied only to built-in sensitive-data actions. */
	readonly sensitiveDataPolicy?: SensitiveDataPolicy
	readonly telemetry: TelemetryShim
	readonly logger?: Logger
}

/** Configured action IDs map to phase-declared application-owned actions. */
export type GuardrailActions = Readonly<Record<string, AnyGuardrailAction>>

type GuardrailActionIdsForPhase<A extends GuardrailActions, P extends GuardrailPhase> = Extract<
	{
		[K in keyof A]-?: A[K] extends { readonly phase: infer ActionPhase } ? (P extends ActionPhase ? K : never) : never
	}[keyof A],
	string
>

type GuardrailPhaseConfigInput<P extends GuardrailPhase> = NonNullable<NonNullable<GuardrailsConfigInput['rails']>[P]>

type GuardrailPhaseConfigFor<A extends GuardrailActions, P extends GuardrailPhase> = Omit<
	GuardrailPhaseConfigInput<P>,
	'flows'
> & {
	readonly flows: readonly GuardrailActionIdsForPhase<A, P>[]
}

/**
 * Inline configuration whose flow IDs are limited to actions declared for the
 * corresponding guardrail phase.
 */
export type GuardrailsConfigFor<A extends GuardrailActions> = Omit<GuardrailsConfigInput, 'rails'> & {
	readonly rails?: {
		readonly [P in GuardrailPhase]?: GuardrailPhaseConfigFor<A, P>
	}
}

/** Process-level observability used outside a Harness interceptor. */
export interface GuardrailsObservability {
	readonly telemetry?: TelemetryShim
	readonly logger?: Logger
}

/** Run-scoped dependencies for standalone retrieval evaluation. */
export interface GuardrailExecutionContext {
	readonly invocationId?: string
	readonly step?: number
	readonly agentId?: string
	readonly runId?: string
	readonly sessionId?: string
	readonly workflowId?: string
	readonly toolId?: string
	readonly callId?: string
	readonly modelAlias?: string
	readonly signal?: AbortSignal
	readonly deadline?: number
	readonly models?: Readonly<Record<string, ModelHandle<{ readonly capabilities: readonly ['object'] }>>>
	readonly telemetry?: TelemetryShim
	readonly logger?: Logger
}

/** Options for compiling canonical guardrail configuration. */
export interface DefineGuardrailsOptions<
	A extends GuardrailActions,
	C extends GuardrailsConfigFor<NoInfer<A>> = GuardrailsConfigFor<NoInfer<A>>,
> {
	readonly config: C
	readonly actions: A
	/** Content-free telemetry and structured logging used outside attached default-loop agents. */
	readonly observability?: GuardrailsObservability
	/** Maximum evaluation time for actions without an action-level override. Defaults to 10_000 milliseconds. */
	readonly actionTimeoutMs?: number
}

type AttachedGuardrailPhase = Exclude<GuardrailPhase, 'retrieval'>

type ConfiguredFlowId<C, P extends AttachedGuardrailPhase> = C extends { readonly rails?: infer Rails }
	? P extends keyof NonNullable<Rails>
		? NonNullable<NonNullable<Rails>[P]> extends {
				readonly flows: readonly (infer Id extends string)[]
			}
			? Id
			: never
		: never
	: never

type AttachedFlowId<C> = {
	[P in AttachedGuardrailPhase]: ConfiguredFlowId<C, P>
}[AttachedGuardrailPhase]

type AttachedAction<A extends GuardrailActions, C> = A[Extract<AttachedFlowId<C>, keyof A>]

type AttachedToolId<A extends GuardrailActions, C> = [AttachedAction<A, C>] extends [never]
	? never
	: AttachedAction<A, C> extends GuardrailAction<infer _Phase, infer Tools, infer _Models>
		? Tools[number]
		: never

type AttachedModelAlias<A extends GuardrailActions, C> = [AttachedAction<A, C>] extends [never]
	? never
	: AttachedAction<A, C> extends GuardrailAction<infer _Phase, infer _Tools, infer Models>
		? Models[number]
		: never

type RequiredGuardrailModel<Alias extends ModelAliasId> = Alias extends Alias
	? Readonly<{ alias: Alias; capabilities: readonly ['object'] }>
	: never

/** Exact Core runtime requirements contributed by configured attached actions. */
export type GuardrailBindingRequirements<
	A extends GuardrailActions,
	C,
	ToolId extends string = AttachedToolId<A, C>,
	ModelAlias extends ModelAliasId = AttachedModelAlias<A, C>,
> = [ToolId | ModelAlias] extends [never]
	? undefined
	: AgentExecutionRequirements<
			readonly ToolId[],
			readonly RequiredGuardrailModel<ModelAlias>[],
			readonly [],
			readonly [],
			readonly [],
			undefined,
			undefined,
			undefined
		>

type SensitiveDataPolicyPhase = 'input' | 'output' | 'retrieval'
type CompiledRail = {
	readonly id: string
	readonly phase: GuardrailPhase
	readonly action: AnyGuardrailAction
	readonly ordinal: number
	readonly sensitiveDataPolicy?: SensitiveDataPolicy
}
type RuntimeOutcome = GuardrailOutcome<GuardrailPhase, JsonValue | readonly JsonValue[]>
const DEFAULT_ACTION_TIMEOUT_MS = 10_000

/** Compiles ordered portable rail configuration into one default-loop interceptor. */
export class Guardrails<A extends GuardrailActions, C extends GuardrailsConfigFor<A>>
	implements AgentGuardrailsBinding<GuardrailBindingRequirements<A, C>>
{
	private readonly rails: ReadonlyMap<GuardrailPhase, readonly CompiledRail[]>
	private readonly observability: Required<Pick<GuardrailsObservability, 'telemetry'>> &
		Pick<GuardrailsObservability, 'logger'>
	private readonly actionTimeoutMs: number

	public constructor(options: DefineGuardrailsOptions<A, C>) {
		this.observability = {
			telemetry: options.observability?.telemetry ?? createTelemetryShim(),
			...(options.observability?.logger ? { logger: options.observability.logger } : {}),
		}
		this.actionTimeoutMs = requireTimeout(options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, 'actionTimeoutMs')
		this.rails = compileRails(compileConfig(options.config), options.actions)
	}

	/** Provider-neutral binding consumed by an agent definition's `guardrails` field. */
	public get [agentGuardrailsBinding](): AgentExecutionInterceptor<GuardrailBindingRequirements<A, C>> {
		return this.interceptor(this.requirementsForAttachedPhases())
	}

	/** Applies configured retrieval rails to caller-owned chunks. */
	public async filterRetrievedChunks(
		chunks: readonly JsonValue[],
		execution: GuardrailExecutionContext = {},
	): Promise<JsonValue[]> {
		this.validateStandaloneRetrievalModels(execution.models)
		const context = this.standaloneContext(execution)
		let current: readonly JsonValue[] = [...chunks]
		for (const rail of this.rails.get('retrieval') ?? []) {
			const outcome = await this.evaluate(
				rail,
				current,
				{ ...context, railId: rail.id, phase: 'retrieval', value: current },
				execution.deadline,
			)
			if (outcome.decision === 'block') throw new DecisionBlockedError(evidenceFor(rail, context, outcome.reasonCode))
			if (outcome.decision === 'transform') current = outcome.value as readonly JsonValue[]
		}
		return [...current]
	}

	private interceptor(
		requirements: GuardrailBindingRequirements<A, C>,
	): AgentExecutionInterceptor<GuardrailBindingRequirements<A, C>> {
		return {
			id: 'purista.guardrails',
			...(requirements ? { requirements } : {}),
			beforeInput: async ctx => this.apply('input', ctx.input, contextFromAgent(ctx, 'input')),
			beforeOutput: async ctx => this.apply('output', ctx.output, contextFromAgent(ctx, 'output')),
			beforeTool: async ctx =>
				this.apply('tool_input', ctx.input, contextFromAgent(ctx, 'tool_input', ctx.toolId, ctx.callId)),
			afterTool: async ctx =>
				this.apply('tool_output', ctx.output, contextFromAgent(ctx, 'tool_output', ctx.toolId, ctx.callId)),
		}
	}

	private async apply(
		phase: Exclude<GuardrailPhase, 'retrieval'>,
		initial: JsonValue,
		base: GuardrailActionContext,
	): Promise<{ decision: 'allow' } | { decision: 'transform'; value: JsonValue }> {
		let current = initial
		for (const rail of this.rails.get(phase) ?? []) {
			if ((phase === 'tool_input' || phase === 'tool_output') && !isSelectedTool(rail.action, base.toolId)) continue
			const outcome = await this.evaluate(rail, current, { ...base, railId: rail.id, phase, value: current })
			if (outcome.decision === 'block') throw new DecisionBlockedError(evidenceFor(rail, base, outcome.reasonCode))
			if (outcome.decision === 'transform') current = outcome.value as JsonValue
		}
		return current === initial ? { decision: 'allow' } : { decision: 'transform', value: current }
	}

	private async evaluate(
		rail: CompiledRail,
		protectedValue: JsonValue | readonly JsonValue[],
		context: GuardrailActionContext,
		standaloneDeadline?: number,
	): Promise<RuntimeOutcome> {
		const evidence = evidenceFor(rail, context)
		const attrs = guardrailAttributes(rail)
		const started = Date.now()
		try {
			const outcome = await context.telemetry.span(`evaluate_guardrail ${rail.id}`, attrs, async span => {
				try {
					const prepared = await prepareGuardrailAction(rail.action, protectedValue)
					if (!prepared) throw new DecisionEvaluationError(evidence, 'invalid_result')
					const ownDeadline = Date.now() + (actionMetadata(rail.action)?.timeoutMs ?? this.actionTimeoutMs)
					// Attached actions inherit enclosing timeout identity through the parent signal.
					// Standalone retrieval has no enclosing timer, so its explicit deadline bounds this operation.
					const operationDeadline = Math.min(standaloneDeadline ?? ownDeadline, ownDeadline)
					const deadline =
						rail.phase === 'retrieval' ? operationDeadline : Math.min(context.deadline, operationDeadline)
					const { models, ...callbackContext } = context
					const projectedModels = projectActionModels(rail.action, models)
					const result = await runDecisionOperation({ signal: context.signal, deadline: operationDeadline }, signal =>
						prepared({
							...callbackContext,
							signal,
							deadline,
							...(projectedModels ? { models: projectedModels } : {}),
							...(rail.sensitiveDataPolicy ? { sensitiveDataPolicy: rail.sensitiveDataPolicy } : {}),
						}),
					)
					const outcome = await validateOutcome(rail, result, evidence)
					span.setAttributes(outcomeAttributes(outcome))
					return outcome
				} catch (error) {
					const classified = classifyEvaluationError(evidence, error)
					span.setAttributes({ 'harness.guardrail.outcome': 'error' })
					throw classified
				}
			})
			this.recordOutcome(context, attrs, outcome, started)
			return outcome
		} catch (error) {
			const classified = classifyEvaluationError(evidence, error)
			this.recordFailure(context, attrs, classified, started)
			context.logger?.error('Harness guardrail evaluation failed closed.', {
				guardrail_id: rail.id,
				guardrail_phase: rail.phase,
				guardrail_outcome: 'error',
				error_code: classified.code,
			})
			throw classified
		}
	}

	private standaloneContext(
		execution: GuardrailExecutionContext,
	): GuardrailActionContext<'retrieval', readonly JsonValue[]> {
		const signal = execution.signal ?? new AbortController().signal
		const deadline = execution.deadline ?? Date.now() + this.actionTimeoutMs
		if (!Number.isFinite(deadline))
			throw new GuardrailsConfigError({ reason: 'invalid_shape', field: 'execution.deadline' })
		return {
			railId: '',
			phase: 'retrieval',
			value: [],
			invocationId: execution.invocationId ?? ulid(),
			step: execution.step ?? 0,
			...(execution.agentId ? { agentId: execution.agentId } : {}),
			...(execution.runId ? { runId: execution.runId } : {}),
			...(execution.sessionId ? { sessionId: execution.sessionId } : {}),
			...(execution.workflowId ? { workflowId: execution.workflowId } : {}),
			...(execution.toolId ? { toolId: execution.toolId } : {}),
			...(execution.callId ? { callId: execution.callId } : {}),
			...(execution.modelAlias ? { modelAlias: execution.modelAlias } : {}),
			signal,
			deadline,
			...(execution.models ? { models: execution.models } : {}),
			telemetry: execution.telemetry ?? this.observability.telemetry,
			...((execution.logger ?? this.observability.logger)
				? { logger: execution.logger ?? this.observability.logger }
				: {}),
		}
	}

	private recordOutcome(
		context: GuardrailActionContext,
		attrs: Record<string, string>,
		outcome: RuntimeOutcome,
		started: number,
	): void {
		const outcomeAttrs = { ...attrs, ...outcomeAttributes(outcome) }
		context.telemetry.recordCounter('harness.guardrail.evaluations', 1, outcomeAttrs)
		context.telemetry.recordHistogram('harness.guardrail.duration', (Date.now() - started) / 1000, outcomeAttrs)
		if (outcome.decision === 'block')
			context.logger?.warn('Harness guardrail blocked execution.', {
				guardrail_id: attrs['harness.guardrail.id'],
				guardrail_phase: attrs['harness.guardrail.phase'],
				guardrail_outcome: outcome.decision,
				...(outcome.reasonCode ? { guardrail_reason_code: outcome.reasonCode } : {}),
			})
		if (outcome.decision === 'transform')
			context.logger?.info('Harness guardrail transformed a value.', {
				guardrail_id: attrs['harness.guardrail.id'],
				guardrail_phase: attrs['harness.guardrail.phase'],
				guardrail_outcome: outcome.decision,
				...(outcome.reasonCode ? { guardrail_reason_code: outcome.reasonCode } : {}),
			})
	}

	private recordFailure(
		context: GuardrailActionContext,
		attrs: Record<string, string>,
		error: DecisionEvaluationError,
		started: number,
	): void {
		const outcomeAttrs = { ...attrs, 'harness.guardrail.outcome': 'error', 'error.type': error.code }
		context.telemetry.recordCounter('harness.guardrail.evaluations', 1, outcomeAttrs)
		context.telemetry.recordHistogram('harness.guardrail.duration', (Date.now() - started) / 1000, outcomeAttrs)
	}

	private requirementsForAttachedPhases(): GuardrailBindingRequirements<A, C> {
		return compileActionRequirements(this.rails, ['input', 'output', 'tool_input', 'tool_output']) as GuardrailBindingRequirements<
			A,
			C
		>
	}

	private validateStandaloneRetrievalModels(
		models: Readonly<Record<string, ModelHandle<{ readonly capabilities: readonly ['object'] }>>> | undefined,
	): void {
		for (const rail of this.rails.get('retrieval') ?? []) {
			for (const modelAlias of actionMetadata(rail.action)?.models ?? []) {
				const handle = models?.[modelAlias]
				if (handle === undefined)
					throw new GuardrailsConfigError({ reason: 'model_missing', field: 'execution.models', modelAlias })
				if (!handle || typeof handle.object !== 'function') {
					throw new GuardrailsConfigError({ reason: 'model_capability_missing', field: 'execution.models', modelAlias })
				}
			}
		}
	}
}

/** Compiles configuration and returns the optional guardrail add-on facade. */
export function defineGuardrails<
	const A extends GuardrailActions,
	const C extends GuardrailsConfigFor<NoInfer<A>>,
>(options: DefineGuardrailsOptions<A, C>): Guardrails<A, C> {
	return new Guardrails(options)
}

const modelCheckResultSchema = z.strictObject({ allow: z.boolean() })

/** Model-backed self-check action using an explicitly configured Harness model alias. */
export function modelCheckRail<const P extends GuardrailPhase, const Model extends ModelAliasId>(options: {
	readonly phase: P
	readonly model: Model
	readonly instructions: string
}): GuardrailAction<P, readonly [], readonly [Model]> {
	const phase = options.phase
	const modelAlias = options.model
	const instructions = options.instructions
	return createGuardrailAction<P, readonly [], readonly [Model]>({
		phase,
		mayTransform: false,
		models: [modelAlias],
		async evaluate(context: GuardrailActionContext<P>) {
			const model = context.models?.[modelAlias]
			if (!model) throw new Error('Configured guardrail model alias is unavailable.')
			const response = await model.object(
				{
					messages: [
						{ role: 'system', content: instructions },
						{ role: 'user', content: JSON.stringify(context.value) },
					],
					schema: z.toJSONSchema(modelCheckResultSchema) as JsonValue,
				},
				context.signal,
			)
			const result = modelCheckResultSchema.parse(response.object)
			return result.allow ? { decision: 'allow' } : { decision: 'block', reasonCode: 'model_denied' }
		},
	})
}

function compileConfig(value: unknown): GuardrailsConfig {
	try {
		if (!isJsonValue(value)) throw new Error('invalid configuration shape')
		const parsed = guardrailsConfigSchema.safeParse(value)
		if (!parsed.success) throw new Error('invalid configuration shape')
		return freezeConfig(parsed.data)
	} catch {
		throw new GuardrailsConfigError({ reason: 'invalid_shape' })
	}
}

function freezeConfig(config: GuardrailsConfig): GuardrailsConfig {
	return freezeConfigValue(structuredClone(config))
}

function freezeConfigValue<T>(value: T): T {
	if (Array.isArray(value)) value.forEach(freezeConfigValue)
	else if (value !== null && typeof value === 'object') Object.values(value as object).forEach(freezeConfigValue)
	return Object.freeze(value) as T
}

function compileRails(
	config: GuardrailsConfig,
	actions: GuardrailActions,
): ReadonlyMap<GuardrailPhase, readonly CompiledRail[]> {
	if (!actions || typeof actions !== 'object' || Array.isArray(actions))
		throw new GuardrailsConfigError({ reason: 'invalid_shape', field: 'actions' })
	const compiled = new Map<GuardrailPhase, readonly CompiledRail[]>()
	for (const phase of ['input', 'output', 'tool_input', 'tool_output', 'retrieval'] as const) {
		const rails = (config.rails[phase]?.flows ?? []).map((id, ordinal) => {
			const action = readAction(actions, id)
			if (action.phase !== phase)
				throw new GuardrailsConfigError({ reason: 'invalid_shape', field: `rails.${phase}.flows`, flowId: id })
			const metadata = actionMetadata(action)
			if (!metadata) throw new GuardrailsConfigError({ reason: 'invalid_action', field: `flows.${id}`, flowId: id })
			if (metadata.timeoutMs !== undefined) requireTimeout(metadata.timeoutMs, `actions.${id}.timeoutMs`)
			const policyPhase = sensitiveDataPolicyPhase(id, action)
			const sensitiveDataPolicy = policyPhase ? config.sensitiveData?.[policyPhase] : undefined
			if (policyPhase && !sensitiveDataPolicy)
				throw new GuardrailsConfigError({ reason: 'missing_policy', field: `rails.${phase}.flows`, flowId: id })
			const supportedEntities = sensitiveDataMetadata(action)?.supportedEntities
			if (
				sensitiveDataPolicy &&
				supportedEntities &&
				sensitiveDataPolicy.entities.some(entity => !supportedEntities.includes(entity))
			)
				throw new GuardrailsConfigError({
					reason: 'unsupported_entity',
					field: `sensitiveData.${policyPhase}.entities`,
					flowId: id,
				})
			return { id, phase, action, ordinal, ...(sensitiveDataPolicy ? { sensitiveDataPolicy } : {}) }
		})
		if (rails.length > 0) compiled.set(phase, rails)
	}
	return compiled
}

function readAction(actions: GuardrailActions, id: string): AnyGuardrailAction {
	try {
		if (!Object.hasOwn(actions, id))
			throw new GuardrailsConfigError({ reason: 'action_missing', field: `flows.${id}`, flowId: id })
		const action = Reflect.get(actions, id)
		if (!action || !isGuardrailAction(action))
			throw new GuardrailsConfigError({ reason: 'invalid_action', field: `flows.${id}`, flowId: id })
		return action
	} catch (error) {
		if (error instanceof GuardrailsConfigError) throw error
		throw new GuardrailsConfigError({ reason: 'invalid_action', field: `flows.${id}`, flowId: id })
	}
}

function sensitiveDataPolicyPhase(flowId: string, action: AnyGuardrailAction): SensitiveDataPolicyPhase | undefined {
	const reserved: Readonly<Record<string, SensitiveDataPolicyPhase>> = {
		'detect sensitive data on input': 'input',
		'mask sensitive data on input': 'input',
		'detect sensitive data on output': 'output',
		'mask sensitive data on output': 'output',
		'detect sensitive data on retrieval': 'retrieval',
		'mask sensitive data on retrieval': 'retrieval',
	}
	const boundPhase = sensitiveDataMetadata(action)?.policyPhase
	if (reserved[flowId] && !boundPhase)
		throw new GuardrailsConfigError({ reason: 'invalid_action', field: `flows.${flowId}`, flowId })
	return boundPhase
}

function contextFromAgent<I>(
	ctx: AgentExecutionInterceptorContext<I>,
	phase: Exclude<GuardrailPhase, 'retrieval'>,
	toolId?: string,
	callId?: string,
): GuardrailActionContext {
	return {
		railId: '',
		phase,
		value: null,
		invocationId: ctx.invocationId,
		step: ctx.step,
		agentId: ctx.agentId,
		runId: ctx.runId,
		sessionId: ctx.sessionId,
		...(ctx.workflowId ? { workflowId: ctx.workflowId } : {}),
		...(toolId ? { toolId } : {}),
		...(callId ? { callId } : {}),
		...(ctx.model ? { modelAlias: ctx.model } : {}),
		signal: ctx.decision.signal,
		deadline: ctx.decision.deadline,
		models: ctx.models,
		telemetry: ctx.telemetry,
		logger: ctx.logger,
	}
}

function evidenceFor(rail: CompiledRail, context: GuardrailActionContext, reasonCode?: string): DecisionEvidence {
	return createDecisionEvidence({
		occurrence: {
			invocationId: context.invocationId,
			step: context.step,
			...(context.runId ? { runId: context.runId } : {}),
			...(context.agentId ? { agentId: context.agentId } : {}),
			...(context.sessionId ? { sessionId: context.sessionId } : {}),
			...(context.workflowId ? { workflowId: context.workflowId } : {}),
			...(context.toolId ? { toolId: context.toolId } : {}),
			...(context.callId ? { callId: context.callId } : {}),
		},
		source: { kind: 'guardrail', id: rail.id, ruleId: rail.id },
		phase: rail.phase,
		ordinal: rail.ordinal,
		...(reasonCode ? { reasonCode } : {}),
	})
}

async function validateOutcome(
	rail: CompiledRail,
	outcome: unknown,
	evidence: DecisionEvidence,
): Promise<RuntimeOutcome> {
	if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome))
		throw new DecisionEvaluationError(evidence, 'invalid_result')
	const result = outcome as Record<string, unknown>
	if (result['decision'] === 'allow' || result['decision'] === 'block') {
		const parsed = decisionResultSchema.safeParse(result)
		if (!parsed.success) throw new DecisionEvaluationError(evidence, 'invalid_result')
		return parsed.data
	}
	const parsed = guardrailTransformSchema.safeParse(result)
	if (!parsed.success) {
		const invalidReason = parsed.error.issues.some(issue => issue.path[0] === 'reasonCode')
		throw new DecisionEvaluationError(evidence, invalidReason ? 'invalid_result' : 'invalid_transform')
	}
	const target = targetFor(rail.phase)
	const metadata = actionMetadata(rail.action)
	if (!metadata || !metadata.mayTransform || parsed.data.target !== target)
		throw new DecisionEvaluationError(evidence, 'invalid_transform')
	if (rail.phase === 'retrieval' && !Array.isArray(parsed.data.value))
		throw new DecisionEvaluationError(evidence, 'invalid_transform')
	const snapshot = snapshotJson(parsed.data.value)
	let value = freezeJson(snapshot)
	if (metadata.valueSchema) {
		const validated = await validateGuardrailValue(metadata.valueSchema, parsed.data.value)
		if (!validated || !jsonEqual(validated, snapshot)) throw new DecisionEvaluationError(evidence, 'invalid_transform')
		value = freezeJson(snapshotJson(validated))
	}
	return {
		decision: 'transform',
		target,
		value,
		...(parsed.data.reasonCode ? { reasonCode: parsed.data.reasonCode } : {}),
	}
}

function classifyEvaluationError(
	evidence: DecisionEvidence,
	error: unknown,
): DecisionEvaluationError | OperationCancelledError | OperationTimeoutError | DecisionBlockedError {
	if (
		error instanceof DecisionEvaluationError ||
		error instanceof DecisionBlockedError ||
		error instanceof OperationCancelledError
	)
		return error
	if (error instanceof OperationTimeoutError)
		return error.meta?.['scope'] === 'decision'
			? new DecisionEvaluationError(evidence, 'callback_timeout', error)
			: error
	return new DecisionEvaluationError(evidence, sensitiveDataFailureKind(error) ?? 'callback_failed', error)
}

function targetFor(phase: GuardrailPhase): GuardrailTransformTarget {
	return phase === 'input'
		? 'user_message'
		: phase === 'output'
			? 'bot_message'
			: phase === 'tool_input'
				? 'tool_input'
				: phase === 'tool_output'
					? 'tool_output'
					: 'relevant_chunks'
}
function isSelectedTool(action: AnyGuardrailAction, toolId: string | undefined): boolean {
	const tools = actionMetadata(action)?.tools
	return !tools || (toolId !== undefined && tools.includes(toolId))
}

function compileActionRequirements(
	rails: ReadonlyMap<GuardrailPhase, readonly CompiledRail[]>,
	phases: readonly Exclude<GuardrailPhase, 'retrieval'>[],
): AgentExecutionRequirements | undefined {
	const toolIds = new Set<string>()
	const modelAliases = new Set<string>()

	for (const phase of phases) {
		for (const rail of rails.get(phase) ?? []) {
			const metadata = actionMetadata(rail.action)
			for (const toolId of metadata?.tools ?? []) {
				toolIds.add(toolId)
			}
			for (const alias of metadata?.models ?? []) {
				modelAliases.add(alias)
			}
		}
	}

	if (toolIds.size === 0 && modelAliases.size === 0) return undefined
	const tools = Object.freeze([...toolIds].sort())
	const models = Object.freeze(
		[...modelAliases].sort().map(alias => Object.freeze({ alias, capabilities: Object.freeze(['object'] as const) })),
	)
	return Object.freeze({
		...(tools.length > 0 ? { tools } : {}),
		...(models.length > 0 ? { models } : {}),
	})
}

function projectActionModels(
	action: AnyGuardrailAction,
	models: Readonly<Record<string, ModelHandle<{ readonly capabilities: readonly ['object'] }>>> | undefined,
): Readonly<Record<string, ModelHandle<{ readonly capabilities: readonly ['object'] }>>> | undefined {
	const aliases = actionMetadata(action)?.models ?? []
	if (aliases.length === 0) return undefined
	const projected: Record<string, ModelHandle<{ readonly capabilities: readonly ['object'] }>> = {}
	for (const alias of aliases) {
		const handle = models?.[alias]
		if (handle !== undefined) projected[alias] = handle
	}
	return Object.freeze(projected)
}
function guardrailAttributes(rail: CompiledRail): Record<string, string> {
	return {
		'harness.guardrail.id': rail.id,
		'harness.guardrail.phase': rail.phase,
		'openinference.span.kind': 'GUARDRAIL',
	}
}
function outcomeAttributes(outcome: RuntimeOutcome): Record<string, string> {
	return {
		'harness.guardrail.outcome': outcome.decision,
		...(outcome.decision !== 'allow' && outcome.reasonCode
			? { 'harness.guardrail.reason_code': outcome.reasonCode }
			: {}),
	}
}
function jsonEqual(left: JsonValue, right: JsonValue | readonly JsonValue[]): boolean {
	if (Object.is(left, right)) return true
	if (Array.isArray(left) && Array.isArray(right))
		return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]!))
	if (
		!left ||
		!right ||
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		Array.isArray(left) ||
		Array.isArray(right)
	)
		return false
	const leftRecord = left as Record<string, JsonValue>
	const rightRecord = right as Record<string, JsonValue>
	const keys = Object.keys(leftRecord)
	return (
		keys.length === Object.keys(rightRecord).length &&
		keys.every(key => Object.hasOwn(rightRecord, key) && jsonEqual(leftRecord[key]!, rightRecord[key]!))
	)
}
function snapshotJson(value: JsonValue | readonly JsonValue[]): JsonValue {
	if (Array.isArray(value)) return value.map(item => snapshotJson(item))
	if (value !== null && typeof value === 'object')
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotJson(item)]))
	return value
}
function freezeJson<T extends JsonValue>(value: T): T {
	if (Array.isArray(value)) value.forEach(freezeJson)
	else if (value !== null && typeof value === 'object') Object.values(value).forEach(freezeJson)
	return Object.freeze(value)
}
function requireTimeout(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new GuardrailsConfigError({ reason: 'invalid_shape', field })
	return value
}
