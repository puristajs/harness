import { z } from 'zod'
import type {
  AgentAfterModelInterceptorContext,
  AgentAfterToolInterceptorContext,
  AgentBeforeInputInterceptorContext,
  AgentBeforeToolInterceptorContext,
  AgentDefinition,
  AgentExecutionInterceptor,
  BuilderState,
  JsonValue,
  ModelMessage,
  ObjectResponse
} from '@purista/harness'
import { GuardrailsConfigError, GuardrailEvaluationError, type GuardrailPhase } from './errors.js'
import type { NeMoGuardrailsConfig } from './config.js'

export type GuardrailTransformTarget = 'user_message' | 'bot_message' | 'tool_input' | 'tool_output' | 'relevant_chunks'

export type GuardrailOutcome =
  | { decision: 'allow' }
  | { decision: 'block'; reason?: string }
  | { decision: 'transform'; target: GuardrailTransformTarget; value: JsonValue }

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
  telemetry?: import('@purista/harness').TelemetryShim
}

/** Small provider-neutral model surface available to model-backed rail actions. */
export interface GuardrailModelHandle {
  object(request: { messages: readonly ModelMessage[]; schema: JsonValue }, signal?: AbortSignal): Promise<ObjectResponse<JsonValue>>
}

/** Application-owned deterministic or model-backed rail action. */
export interface GuardrailAction {
  /** Set `false` only when the action can never return a transform outcome. */
  mayTransform?: boolean
  evaluate(ctx: GuardrailActionContext): GuardrailOutcome | Promise<GuardrailOutcome>
}

export type GuardrailActions = Readonly<Record<string, GuardrailAction>>

export interface DefineGuardrailsOptions {
  config: NeMoGuardrailsConfig
  actions: GuardrailActions
  /** Optional aliases from NeMo model `type` values to configured Harness aliases. */
  modelAliases?: Readonly<Record<string, string>>
}

type CompiledRail = { id: string; phase: GuardrailPhase; action: GuardrailAction }

/**
 * Compiles a portable NeMo-shaped rail configuration into one ordered Harness
 * interceptor. No provider, vector database, Colang runtime, Python action, or
 * server is constructed from configuration.
 */
export class Guardrails {
  private readonly rails: ReadonlyMap<GuardrailPhase, readonly CompiledRail[]>
  private readonly modelAliases: Readonly<Record<string, string>>

  public constructor(options: DefineGuardrailsOptions) {
    this.modelAliases = options.modelAliases ?? {}
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

  /** Applies configured retrieval rails to caller-owned chunks; it never creates or queries a vector store. */
  public async filterRetrievedChunks(chunks: readonly JsonValue[]): Promise<JsonValue[]> {
    let current = [...chunks] as JsonValue
    for (const rail of this.rails.get('retrieval') ?? []) {
      const outcome = await this.evaluate(rail, current, { railId: rail.id, phase: 'retrieval', value: current })
      if (outcome.decision === 'block') throw blockedError(rail, 'retrieval')
      if (outcome.decision === 'transform') {
        requireTarget(rail, 'retrieval', outcome.target, 'relevant_chunks')
        if (!Array.isArray(outcome.value)) throw invalidOutcome(rail, 'retrieval', 'invalid_outcome')
        current = outcome.value
      }
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
    const value = await this.apply('input', ctx.input, contextFromAgent(ctx, 'input'))
    return value
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
      const outcome = await this.evaluate(rail, current, { ...base, railId: rail.id, value: current })
      if (outcome.decision === 'allow') continue
      if (outcome.decision === 'block') return { decision: 'block' }
      requireTarget(rail, phase, outcome.target, targetFor(phase))
      current = outcome.value
    }
    return current === initial ? { decision: 'allow' } : { decision: 'transform', value: current }
  }

  private async evaluate(rail: CompiledRail, value: JsonValue, context: GuardrailActionContext): Promise<GuardrailOutcome> {
    try {
      const actionContext: GuardrailActionContext = {
        ...context,
        value,
        modelAliases: this.modelAliases,
        ...(context.models ? { models: context.models } : {})
      }
      const evaluate = async () => await rail.action.evaluate(actionContext)
      const outcome = context.telemetry
        ? await context.telemetry.span(`evaluate_guardrail ${rail.id}`, {
            'harness.guardrail.id': rail.id,
            'harness.guardrail.phase': rail.phase,
            'openinference.span.kind': 'GUARDRAIL'
          }, evaluate)
        : await evaluate()
      if (!outcome || !['allow', 'block', 'transform'].includes(outcome.decision)) throw invalidOutcome(rail, rail.phase, 'invalid_outcome')
      return outcome
    } catch (error) {
      if (error instanceof GuardrailEvaluationError) throw error
      throw new GuardrailEvaluationError('Guardrail action failed closed.', { rail_id: rail.id, phase: rail.phase, reason: 'action_failed' }, error)
    }
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
      return result.allow ? { decision: 'allow' } : { decision: 'block' }
    }
  }
}

function compileRails(config: NeMoGuardrailsConfig, actions: GuardrailActions): ReadonlyMap<GuardrailPhase, readonly CompiledRail[]> {
  const compiled = new Map<GuardrailPhase, readonly CompiledRail[]>()
  for (const phase of ['input', 'output', 'tool_input', 'tool_output', 'retrieval'] as const) {
    const rails = (config.rails[phase]?.flows ?? []).map((id) => {
      const action = actions[id]
      if (!action) throw new GuardrailsConfigError('A configured rail flow has no application-owned action.', { reason: 'action_missing', flow_id: id })
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
    ...(ctx.model ? { modelAlias: thisModelAlias(ctx.model) } : {}),
    signal: ctx.signal,
    models: ctx.models as Record<string, GuardrailModelHandle>,
    telemetry: ctx.telemetry
  }
}

function thisModelAlias(model: string): string { return model }

function targetFor(phase: GuardrailPhase): GuardrailTransformTarget {
  if (phase === 'input') return 'user_message'
  if (phase === 'output') return 'bot_message'
  if (phase === 'tool_input') return 'tool_input'
  if (phase === 'tool_output') return 'tool_output'
  return 'relevant_chunks'
}

function requireTarget(rail: CompiledRail, phase: GuardrailPhase, actual: GuardrailTransformTarget, expected: GuardrailTransformTarget): void {
  if (actual !== expected) throw invalidOutcome(rail, phase, 'unsupported_transform')
}

function blockedError(rail: CompiledRail, phase: GuardrailPhase): GuardrailEvaluationError {
  return new GuardrailEvaluationError('Guardrail blocked retrieval chunks.', { rail_id: rail.id, phase, reason: 'invalid_outcome' })
}

function invalidOutcome(rail: CompiledRail, phase: GuardrailPhase, reason: 'invalid_outcome' | 'unsupported_transform'): GuardrailEvaluationError {
  return new GuardrailEvaluationError('Guardrail action returned an unsupported outcome.', { rail_id: rail.id, phase, reason })
}
