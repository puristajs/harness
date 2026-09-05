import type { z } from 'zod'

import type { DecisionExecutionContext } from '../decisions/types.js'
import type { ProviderContinuation } from '../decisions/types.js'
import type { agentPermissionsSchema, decisionResultSchema, permissionPolicySchema } from '../decisions/schemas.js'
import type { AgentExecutionRequirements } from '../harness/agent-requirements.js'
import type { Logger } from '../logger/index.js'
import type { JsonValue } from '../models/json.js'
import type { ModelHandle } from '../models/registry.js'
import type { MemoryFacade } from '../ports/memory.js'
import type { FinishReason, ModelCallOptions, ModelMessage, ModelOutcome, ModelToolSpec, TokenUsage, ToolCallSpec } from '../ports/model-provider.js'
import type { Metrics, TelemetryShim } from '../telemetry/index.js'
import type { ConversationHistory } from '../runtime/session-contracts.js'

/** Permission modes for sandbox-mutating tools. */
export type PermissionMode = Extract<z.infer<typeof permissionPolicySchema>, string>
/** Structured permission policy for one tool family. */
export type PermissionPolicy = Exclude<z.infer<typeof permissionPolicySchema>, string>
/** Per-agent permission configuration for built-in mutating tools. */
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>

/** A model request after agent preparation and governance tool exposure. */
export interface AgentModelRequest {
	readonly messages: readonly ModelMessage[]
	readonly tools: readonly ModelToolSpec[]
	readonly schema?: JsonValue
	readonly call?: ModelCallOptions
}

/** Sanitized provider-neutral response exposed to post-model interceptors. */
export type AgentModelResponse =
	| Readonly<{ content: string; toolCalls: readonly ToolCallSpec[]; usage: TokenUsage; finishReason: FinishReason; outcome?: ModelOutcome; providerContinuation?: ProviderContinuation }>
	| Readonly<{ object: JsonValue; toolCalls: readonly ToolCallSpec[]; usage: TokenUsage; finishReason: FinishReason; outcome?: ModelOutcome; providerContinuation?: ProviderContinuation }>

/** Content-free context common to every standard-loop interceptor hook. */
export interface AgentExecutionInterceptorContext<Input = JsonValue> {
	readonly agentInput: Input
	readonly interceptorId: string
	readonly invocationId: string
	readonly step: number
	readonly model?: string
	readonly agentId: string
	readonly workflowId?: string
	readonly runId: string
	readonly sessionId: string
	readonly history: ConversationHistory
	readonly memory: MemoryFacade
	readonly metadata: Readonly<Record<string, JsonValue>>
	readonly metrics: Metrics
	readonly models: Readonly<Record<string, ModelHandle>>
	readonly signal: AbortSignal
	readonly decision: DecisionExecutionContext
	readonly logger: Logger
	readonly telemetry: TelemetryShim
}

/** A content-free allow or block result from one interceptor. */
export type AgentInterceptorDecision = z.infer<typeof decisionResultSchema>
/** A phase-specific replacement from one interceptor. */
export type AgentInterceptorTransform<T> = Omit<AgentInterceptorDecision, 'decision'> & { readonly decision: 'transform'; readonly value: T }
/** Allow, block, or replace a value at an interception point. */
export type AgentExecutionInterception<T> = AgentInterceptorDecision | AgentInterceptorTransform<T>

/** Context for validating or transforming the validated agent input. */
export interface AgentBeforeInputInterceptorContext<Input = JsonValue> extends AgentExecutionInterceptorContext<Input> { readonly input: Input }
/** Context for validating or transforming a prepared model request. */
export interface AgentBeforeModelInterceptorContext<Input = JsonValue> extends AgentExecutionInterceptorContext<Input> { readonly request: AgentModelRequest }
/** Context for validating a provider-neutral model response. */
export interface AgentAfterModelInterceptorContext<Input = JsonValue> extends AgentExecutionInterceptorContext<Input> { readonly request: AgentModelRequest; readonly response: AgentModelResponse }
/** Context for validating or transforming one parsed tool input. */
export interface AgentBeforeToolInterceptorContext<Input = JsonValue> extends AgentExecutionInterceptorContext<Input> { readonly toolId: string; readonly callId: string; readonly input: JsonValue }
/** Context for validating or transforming one validated tool output. */
export interface AgentAfterToolInterceptorContext<Input = JsonValue> extends AgentExecutionInterceptorContext<Input> { readonly toolId: string; readonly callId: string; readonly output: JsonValue }
/** Context for validating or transforming the final agent output. */
export interface AgentBeforeOutputInterceptorContext<Input = JsonValue> extends AgentExecutionInterceptorContext<Input> { readonly output: JsonValue }

/**
 * Ordered, fail-closed interception points for the standard agent loop.
 *
 * @example
 * ```ts
 * const guard: AgentExecutionInterceptor = {
 *   id: 'reject-empty-output',
 *   beforeOutput: ({ output }) => output === ''
 *     ? { decision: 'block', reasonCode: 'empty_output' }
 *     : { decision: 'allow' },
 * }
 * ```
 */
export interface AgentExecutionInterceptor<Requirements extends AgentExecutionRequirements | undefined = AgentExecutionRequirements | undefined> {
	readonly id: string
	readonly requirements?: Requirements
	beforeInput?(context: AgentBeforeInputInterceptorContext): AgentExecutionInterception<JsonValue> | void | Promise<AgentExecutionInterception<JsonValue> | void>
	beforeModel?(context: AgentBeforeModelInterceptorContext): AgentExecutionInterception<{ readonly messages: readonly ModelMessage[] }> | void | Promise<AgentExecutionInterception<{ readonly messages: readonly ModelMessage[] }> | void>
	afterModel?(context: AgentAfterModelInterceptorContext): AgentInterceptorDecision | void | Promise<AgentInterceptorDecision | void>
	beforeTool?(context: AgentBeforeToolInterceptorContext): AgentExecutionInterception<JsonValue> | void | Promise<AgentExecutionInterception<JsonValue> | void>
	afterTool?(context: AgentAfterToolInterceptorContext): AgentExecutionInterception<JsonValue> | void | Promise<AgentExecutionInterception<JsonValue> | void>
	beforeOutput?(context: AgentBeforeOutputInterceptorContext): AgentExecutionInterception<JsonValue> | void | Promise<AgentExecutionInterception<JsonValue> | void>
}

/** Opaque integration key implemented by optional Guardrails packages. */
export const agentGuardrailsBinding = Symbol('@purista/harness/agent-guardrails-binding')

/** Provider-neutral optional Guardrails binding for a v4 agent. */
export interface AgentGuardrailsBinding<Requirements extends AgentExecutionRequirements | undefined = AgentExecutionRequirements | undefined> {
	readonly [agentGuardrailsBinding]: AgentExecutionInterceptor<Requirements>
}
