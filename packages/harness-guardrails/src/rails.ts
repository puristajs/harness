import { createTelemetryShim, OperationCancelledError } from '@purista/harness'
import type {
  AgentAfterModelInterceptorContext,
  AgentAfterToolInterceptorContext,
  AgentBeforeInputInterceptorContext,
  AgentBeforeToolInterceptorContext,
  AgentDefinition,
  AgentExecutionInterceptor,
  BuilderState,
  JsonValue,
  Logger,
  ModelMessage,
  ObjectResponse,
  TelemetryShim
} from '@purista/harness'
import { z } from 'zod'
import { GuardrailBlockedError, GuardrailsConfigError, GuardrailEvaluationError, type GuardrailPhase } from './errors.js'
import type { NeMoGuardrailsConfig } from './config.js'

export type GuardrailTransformTarget = 'user_message' | 'bot_message' | 'tool_input' | 'tool_output' | 'relevant_chunks'

/** A deterministic, content-free result from one application-owned rail action. */
export type GuardrailOutcome =
  | { decision: 'allow' }
  | { decision: 'block'; reasonCode?: string }
  | { decision: 'transform'; target: GuardrailTransformTarget; value: JsonValue; reasonCode?: string }

/** Stable content-free action context provided to an application-defined rail. */
export interface GuardrailActionContext {
  railId: string
  phase: GuardrailPhase
  value: JsonValue
  agentId?: string
  runId?: string
  sessionId?: string
  workflowId?: string
  toolId?: string
  callId?: string
  modelAlias?: string
  signal?: AbortSignal
  models?: Record<string, GuardrailModelHandle>
  modelAliases?: Readonly<Record<string, string>>
  telemetry?: TelemetryShim
  logger?: Logger
}

/** Small provider-neutral model surface available to model-backed rail actions. */
export interface GuardrailModelHandle {
  object(request: { messages: readonly ModelMessage[]; schema: JsonValue }, signal?: AbortSignal): Promise<ObjectResponse<JsonValue>>
}

/** Application-owned deterministic or model-backed rail action. */
export interface GuardrailAction {
  /** Set `false` only when the action can never return a transform outcome. */
  mayTransform?: boolean
  /** Maximum evaluation time in milliseconds. Defaults to the guardrails-level 10 second budget. */
  timeoutMs?: number
  evaluate(ctx: GuardrailActionContext): GuardrailOutcome | Promise<GuardrailOutcome>
}

export type GuardrailActions = Readonly<Record<string, GuardrailAction>>

/** Process-level observability used when a rail runs outside a Harness interceptor. */
export interface GuardrailsObservability {
  telemetry?: TelemetryShim
  logger?: Logger
}

/** Run-scoped dependencies for standalone evaluation, especially retrieval rails. */
export interface GuardrailExecutionContext {
  agentId?: string
  runId?: string
  sessionId?: string
  workflowId?: string
  toolId?: string
  callId?: string
  modelAlias?: string
  signal?: AbortSignal
  models?: Record<string, GuardrailModelHandle>
  telemetry?: TelemetryShim
  logger?: Logger
}

export interface DefineGuardrailsOptions {
  config: NeMoGuardrailsConfig
  actions: GuardrailActions
  /** Optional aliases from NeMo model `type` values to configured Harness aliases. */
  modelAliases?: Readonly<Record<string, string>>
  /** Content-free telemetry and structured logging used outside attached default-loop agents, such as retrieval rails. */
  observability?: GuardrailsObservability
  /** Maximum evaluation time for actions without an action-level override. Defaults to 10_000 milliseconds. */
  actionTimeoutMs?: number
}

type CompiledRail = { id: string; phase: GuardrailPhase; action: GuardrailAction }
const DEFAULT_ACTION_TIMEOUT_MS = 10_000

/**
 * Compiles portable NeMo-shaped rail configuration into one ordered Harness
 * interceptor. No provider, vector database, Colang runtime, Python action, or
 * server is constructed from configuration.
 */
export class Guardrails {
  private readonly rails: ReadonlyMap<GuardrailPhase, readonly CompiledRail[]>
  private readonly modelAliases: Readonly<Record<string, string>>
  private readonly observability: Required<Pick<GuardrailsObservability, 'telemetry'>> & Pick<GuardrailsObservability, 'logger'>
  private readonly actionTimeoutMs: number

  public constructor(options: DefineGuardrailsOptions) {
    this.modelAliases = options.modelAliases ?? {}
    this.observability = {
      telemetry: options.observability?.telemetry ?? createTelemetryShim(),
      ...(options.observability?.logger ? { logger: options.observability.logger } : {})
    }
    this.actionTimeoutMs = requireTimeout(options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, 'actionTimeoutMs')
    this.rails = compileRails(options.config, options.actions)
  }

  /** Returns a normal Harness default-loop definition with this guardrail interceptor appended. */
  public attach<const D extends AgentDefinition<BuilderState, z.ZodTypeAny, z.ZodTypeAny>>(definition: D): D {
    if (definition.handler) {
      throw new GuardrailsConfigError('Guardrails attach only supports default-loop agents; custom handlers own their model and tool lifecycle.', { reason: 'custom_handler_unsupported' })
    }
    return {
      ...definition,
      interceptors: [...(definition.interceptors ?? []), this.interceptor() as AgentExecutionInterceptor]
    } as D
  }

  /**
   * Applies configured retrieval rails to caller-owned chunks. Supply the
   * workflow/transport run context to correlate standalone retrieval checks;
   * configured process-level observability is used as a safe fallback.
   */
  public async filterRetrievedChunks(chunks: readonly JsonValue[], execution: GuardrailExecutionContext = {}): Promise<JsonValue[]> {
    let current = [...chunks] as JsonValue
    for (const rail of this.rails.get('retrieval') ?? []) {
      const outcome = await this.evaluate(rail, current, this.withExecutionContext({ ...execution, railId: rail.id, phase: 'retrieval', value: current }))
      if (outcome.decision === 'block') {
        throw new GuardrailBlockedError({ rail_id: rail.id, phase: 'retrieval', ...(outcome.reasonCode ? { reason_code: outcome.reasonCode } : {}) })
      }
      if (outcome.decision === 'transform') current = outcome.value
    }
    return current as JsonValue[]
  }

  private interceptor(): AgentExecutionInterceptor<any, any> {
    return {
      id: 'purista.guardrails',
      beforeInput: async (ctx) => this.applyInput(ctx),
      afterModel: async (ctx) => this.applyOutput(ctx),
      beforeTool: async (ctx) => this.applyToolInput(ctx),
      afterTool: async (ctx) => this.applyToolOutput(ctx)
    }
  }

  private async applyInput(ctx: AgentBeforeInputInterceptorContext<any, JsonValue>): Promise<{ decision: 'allow' } | { decision: 'block' } | { decision: 'transform'; value: JsonValue }> {
    return this.apply('input', ctx.input, contextFromAgent(ctx, 'input'))
  }

  private async applyOutput(ctx: AgentAfterModelInterceptorContext<any, JsonValue>): Promise<{ decision: 'allow' } | { decision: 'block' } | { decision: 'transform'; value: ObjectResponse<JsonValue> }> {
    const result = await this.apply('output', ctx.response.object ?? null, contextFromAgent(ctx, 'output'))
    if (result.decision !== 'transform') return result
    return { decision: 'transform', value: { ...ctx.response, object: result.value } }
  }

  private async applyToolInput(ctx: AgentBeforeToolInterceptorContext<any, JsonValue>): Promise<{ decision: 'allow' } | { decision: 'block' } | { decision: 'transform'; value: JsonValue }> {
    return this.apply('tool_input', ctx.input, contextFromAgent(ctx, 'tool_input', ctx.toolId, ctx.callId))
  }

  private async applyToolOutput(ctx: AgentAfterToolInterceptorContext<any, JsonValue>): Promise<{ decision: 'allow' } | { decision: 'block' } | { decision: 'transform'; value: JsonValue }> {
    return this.apply('tool_output', ctx.output, contextFromAgent(ctx, 'tool_output', ctx.toolId, ctx.callId))
  }

  private async apply(phase: GuardrailPhase, initial: JsonValue, base: GuardrailActionContext): Promise<{ decision: 'allow' } | { decision: 'block' } | { decision: 'transform'; value: JsonValue }> {
    let current = initial
    for (const rail of this.rails.get(phase) ?? []) {
      const outcome = await this.evaluate(rail, current, this.withExecutionContext({ ...base, railId: rail.id, value: current }))
      if (outcome.decision === 'allow') continue
      if (outcome.decision === 'block') return { decision: 'block' }
      current = outcome.value
    }
    return current === initial ? { decision: 'allow' } : { decision: 'transform', value: current }
  }

  private async evaluate(rail: CompiledRail, value: JsonValue, context: GuardrailActionContext): Promise<GuardrailOutcome> {
    const attrs = guardrailAttributes(rail)
    const started = Date.now()
    try {
      const outcome = await context.telemetry!.span(`evaluate_guardrail ${rail.id}`, attrs, async (span) => {
        try {
          const result = await evaluateAction(rail, {
            ...context,
            value,
            modelAliases: this.modelAliases,
            ...(context.models ? { models: context.models } : {})
          }, this.actionTimeoutMs)
          validateOutcome(rail, result)
          span.setAttributes(outcomeAttributes(result))
          return result
        } catch (error) {
          const classified = asGuardrailEvaluationError(rail, error)
          span.setAttribute('harness.guardrail.outcome', 'error')
          throw classified
        }
      })
      this.recordOutcome(context, attrs, outcome, started)
      return outcome
    } catch (error) {
      const classified = asGuardrailEvaluationError(rail, error)
      this.recordFailure(context, attrs, classified, started)
      context.logger?.error('Harness guardrail evaluation failed closed.', {
        guardrail_id: rail.id,
        guardrail_phase: rail.phase,
        guardrail_outcome: 'error',
        error_code: classified.code
      })
      throw classified
    }
  }

  private withExecutionContext(context: GuardrailActionContext): GuardrailActionContext {
    return {
      ...context,
      telemetry: context.telemetry ?? this.observability.telemetry,
      ...(context.logger ?? this.observability.logger ? { logger: context.logger ?? this.observability.logger } : {})
    }
  }

  private recordOutcome(context: GuardrailActionContext, attrs: Record<string, string>, outcome: GuardrailOutcome, started: number): void {
    const outcomeAttrs = { ...attrs, ...outcomeAttributes(outcome) }
    context.telemetry!.recordCounter('harness.guardrail.evaluations', 1, outcomeAttrs)
    context.telemetry!.recordHistogram('harness.guardrail.duration', (Date.now() - started) / 1000, outcomeAttrs)
    if (outcome.decision === 'block') {
      context.logger?.warn('Harness guardrail blocked execution.', {
        guardrail_id: attrs['harness.guardrail.id'],
        guardrail_phase: attrs['harness.guardrail.phase'],
        guardrail_outcome: outcome.decision,
        ...(outcome.reasonCode ? { guardrail_reason_code: outcome.reasonCode } : {})
      })
    } else if (outcome.decision === 'transform') {
      context.logger?.info('Harness guardrail transformed a value.', {
        guardrail_id: attrs['harness.guardrail.id'],
        guardrail_phase: attrs['harness.guardrail.phase'],
        guardrail_outcome: outcome.decision,
        ...(outcome.reasonCode ? { guardrail_reason_code: outcome.reasonCode } : {})
      })
    }
  }

  private recordFailure(context: GuardrailActionContext, attrs: Record<string, string>, error: GuardrailEvaluationError, started: number): void {
    const outcomeAttrs = { ...attrs, 'harness.guardrail.outcome': 'error', 'error.type': error.code }
    context.telemetry!.recordCounter('harness.guardrail.evaluations', 1, outcomeAttrs)
    context.telemetry!.recordHistogram('harness.guardrail.duration', (Date.now() - started) / 1000, outcomeAttrs)
  }
}

/** Compiles configuration and returns the optional guardrail addon facade. */
export function defineGuardrails(options: DefineGuardrailsOptions): Guardrails {
  return new Guardrails(options)
}

/** Model-backed self-check action using an explicitly configured Harness alias. */
export function modelCheckRail(options: { model: string; instructions: string }): GuardrailAction {
  return {
    mayTransform: false,
    async evaluate(ctx) {
      const model = ctx.models?.[ctx.modelAliases?.[options.model] ?? options.model]
      if (!model) throw new GuardrailEvaluationError('Configured guardrail model alias is unavailable.', { rail_id: ctx.railId, phase: ctx.phase, reason: 'action_failed' })
      const response = await model.object({
        messages: [
          { role: 'system', content: options.instructions },
          { role: 'user', content: JSON.stringify(ctx.value) }
        ],
        schema: z.toJSONSchema(z.object({ allow: z.boolean() })) as JsonValue
      }, ctx.signal)
      const result = z.object({ allow: z.boolean() }).parse(response.object)
      return result.allow ? { decision: 'allow' } : { decision: 'block', reasonCode: 'model_denied' }
    }
  }
}

function compileRails(config: NeMoGuardrailsConfig, actions: GuardrailActions): ReadonlyMap<GuardrailPhase, readonly CompiledRail[]> {
  const compiled = new Map<GuardrailPhase, readonly CompiledRail[]>()
  for (const phase of ['input', 'output', 'tool_input', 'tool_output', 'retrieval'] as const) {
    const rails = (config.rails[phase]?.flows ?? []).map((id) => {
      const action = actions[id]
      if (!action) throw new GuardrailsConfigError('A configured rail flow has no application-owned action.', { reason: 'action_missing', flow_id: id })
      if (action.timeoutMs !== undefined) requireTimeout(action.timeoutMs, `actions.${id}.timeoutMs`)
      return { id, phase, action }
    })
    if (rails.length > 0) compiled.set(phase, rails)
  }
  return compiled
}

function contextFromAgent(ctx: AgentBeforeInputInterceptorContext<any, JsonValue> | AgentAfterModelInterceptorContext<any, JsonValue> | AgentBeforeToolInterceptorContext<any, JsonValue> | AgentAfterToolInterceptorContext<any, JsonValue>, phase: GuardrailPhase, toolId?: string, callId?: string): GuardrailActionContext {
  return {
    railId: '',
    phase,
    value: null,
    agentId: ctx.agentId,
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    ...(ctx.workflowId ? { workflowId: ctx.workflowId } : {}),
    ...(toolId ? { toolId } : {}),
    ...(callId ? { callId } : {}),
    ...(ctx.model ? { modelAlias: ctx.model } : {}),
    signal: ctx.signal,
    models: ctx.models as Record<string, GuardrailModelHandle>,
    telemetry: ctx.telemetry,
    logger: ctx.logger
  }
}

function targetFor(phase: GuardrailPhase): GuardrailTransformTarget {
  if (phase === 'input') return 'user_message'
  if (phase === 'output') return 'bot_message'
  if (phase === 'tool_input') return 'tool_input'
  if (phase === 'tool_output') return 'tool_output'
  return 'relevant_chunks'
}

function guardrailAttributes(rail: CompiledRail): Record<string, string> {
  return {
    'harness.guardrail.id': rail.id,
    'harness.guardrail.phase': rail.phase,
    'openinference.span.kind': 'GUARDRAIL'
  }
}

function outcomeAttributes(outcome: GuardrailOutcome): Record<string, string> {
  return {
    'harness.guardrail.outcome': outcome.decision,
    ...(outcome.decision !== 'allow' && outcome.reasonCode ? { 'harness.guardrail.reason_code': outcome.reasonCode } : {})
  }
}

function validateOutcome(rail: CompiledRail, outcome: GuardrailOutcome): asserts outcome is GuardrailOutcome {
  if (!outcome || !['allow', 'block', 'transform'].includes(outcome.decision)) throw invalidOutcome(rail, 'invalid_outcome')
  if (outcome.decision === 'allow') return
  if (outcome.reasonCode !== undefined && !isReasonCode(outcome.reasonCode)) throw invalidOutcome(rail, 'invalid_outcome')
  if (outcome.decision === 'block') return
  if (rail.action.mayTransform === false) throw invalidOutcome(rail, 'invalid_outcome')
  if (outcome.target !== targetFor(rail.phase)) throw invalidOutcome(rail, 'unsupported_transform')
  if (rail.phase === 'retrieval' && !Array.isArray(outcome.value)) throw invalidOutcome(rail, 'invalid_outcome')
}

function invalidOutcome(rail: CompiledRail, reason: 'invalid_outcome' | 'unsupported_transform'): GuardrailEvaluationError {
  return new GuardrailEvaluationError('Guardrail action returned an unsupported outcome.', { rail_id: rail.id, phase: rail.phase, reason })
}

function asGuardrailEvaluationError(rail: CompiledRail, error: unknown): GuardrailEvaluationError {
  if (error instanceof GuardrailEvaluationError) return error
  if (error instanceof OperationCancelledError) throw error
  return new GuardrailEvaluationError('Guardrail action failed closed.', { rail_id: rail.id, phase: rail.phase, reason: 'action_failed' }, error)
}

async function evaluateAction(rail: CompiledRail, context: GuardrailActionContext, defaultTimeoutMs: number): Promise<GuardrailOutcome> {
  const timeoutMs = rail.action.timeoutMs ?? defaultTimeoutMs
  const controller = new AbortController()
  const parent = context.signal
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const boundary = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      const error = parent?.reason instanceof Error ? parent.reason : new OperationCancelledError('Guardrail evaluation was cancelled.', { scope: 'run' }, parent?.reason)
      controller.abort(error)
      reject(error)
    }
    if (parent?.aborted) return onAbort()
    if (parent) parent.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      const error = new GuardrailEvaluationError('Guardrail action timed out and was blocked.', { rail_id: rail.id, phase: rail.phase, reason: 'action_timeout' })
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([Promise.resolve(rail.action.evaluate({ ...context, signal: controller.signal })), boundary])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (parent && onAbort) parent.removeEventListener('abort', onAbort)
  }
}

function requireTimeout(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new GuardrailsConfigError('Guardrail action timeout must be a positive safe integer.', { reason: 'invalid_timeout', field })
  return value
}

function isReasonCode(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value)
}
