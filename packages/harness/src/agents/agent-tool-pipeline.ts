import type { ToolApprovalDecision, ToolApprovalRequest } from '../approvals/index.js'
import type { AppliedApprovalDecisionV1 } from '../storage/types.js'
import type { PreparedToolCheckpointEntryV1 } from '../approvals/prepared-tool-checkpoint.js'
import { freezePreparedToolCheckpointEntry } from '../approvals/prepared-tool-checkpoint.js'
import { createDecisionEvidence, runDecisionOperation } from '../decisions/index.js'
import { decisionResultSchema } from '../decisions/schemas.js'
import type { DecisionEvidence, DecisionOccurrence } from '../decisions/types.js'
import { AgentLoopBudgetError, DecisionBlockedError, DecisionEvaluationError, HarnessTargetRouteReceiptMismatchError, OperationCancelledError, PermissionDeniedError, PolicyDeniedError, ToolError, ToolNotFoundError, ValidationError, serializeError } from '../errors/index.js'
import { OperationTimeoutError } from '../errors/index.js'
import type { AgentExecutionInterceptor, AgentExecutionInterceptorContext, AgentPermissions } from './guardrails.js'
import { agentGuardrailsBinding } from './guardrails.js'
import type { ConversationHistory } from '../runtime/session-contracts.js'
import { enforceToolGovernance } from '../governance/index.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type { ToolCallSpec, ModelMessage } from '../ports/model-provider.js'
import { abortError, withAbortSignal } from '../runtime/abort.js'
import { validateSchema } from '../schema/validation.js'
import type { AnyAgentDefinition } from '../definitions/types.js'
import type { AgentEventSink, AgentPipelineEvent } from '../definitions/execution-events.js'
import type { AgentExecutableBinding, AgentToolInvocationContext } from '../tools/bindings.js'
import { createHarnessChildTargetInterruptionGroup, isHarnessChildTargetInterruption } from '../runtime/steps.js'
import type { ModelHandle } from '../models/registry.js'
import type { MemoryFacade } from '../ports/memory.js'
import type { Logger } from '../logger/index.js'
import type { Metrics, TelemetryShim } from '../telemetry/index.js'

/** @internal Resources exposed only to interceptor hooks, never tool bindings. */
export interface AgentInterceptorRuntimeProjection {
	readonly history: ConversationHistory
	readonly models: Readonly<Record<string, ModelHandle>>
	readonly memory: MemoryFacade
	readonly metrics: Metrics
	readonly logger: Logger
	readonly telemetry: TelemetryShim
}

export interface AgentToolPipelineOptions {
	readonly agent: AnyAgentDefinition
	readonly calls: readonly ToolCallSpec[]
	readonly bindings: Readonly<Record<string, AgentExecutableBinding>>
	readonly invocation: Omit<AgentToolInvocationContext, 'step' | 'toolId' | 'callId' | 'signal'> & { readonly signal: AbortSignal }
	readonly interceptorRuntime: AgentInterceptorRuntimeProjection
	readonly step: number
	readonly toolTimeoutMs: number
	readonly decisionTimeoutMs: number
	readonly sink: AgentEventSink
	readonly agentInput: JsonValue
	readonly suppliedDecisions?: readonly ToolApprovalDecision[]
	readonly remainingToolCalls: number
	readonly remainingSubagentCalls: number
	readonly maxToolCalls: number
	readonly maxSubagentCalls: number
	readonly maxParallelToolCalls: number
	readonly maxParallelSubagents: number
	readonly onChildInterruption?: (entry: Extract<PreparedToolCheckpointEntryV1, { readonly state: 'suspended-child' }>) => Promise<void> | void
	readonly onEntry?: (entry: PreparedToolCheckpointEntryV1) => Promise<void> | void
	readonly resumeSuspendedChild?: (entry: Extract<PreparedToolCheckpointEntryV1, { readonly state: 'suspended-child' }>) => Promise<JsonValue>
}

export type StrictAgentHookResult =
	| undefined
	| Readonly<{ decision: 'allow'; reasonCode?: string }>
	| Readonly<{ decision: 'block'; reasonCode?: string }>
	| Readonly<{ decision: 'transform'; value: JsonValue; reasonCode?: string }>

/** @internal Runs one Guardrail decision with the inherited bounded lifecycle and strict result parsing. */
export async function runStrictAgentHook(options: Readonly<{
	interceptorId: string
	phase: 'input' | 'before_model' | 'after_model' | 'tool_input' | 'tool_output' | 'output'
	occurrence: DecisionOccurrence
	signal: AbortSignal
	deadline?: number
	decisionTimeoutMs: number
	allowTransform: boolean
	transform?(value: JsonValue): JsonValue | Promise<JsonValue>
	invoke(decision: Readonly<{ signal: AbortSignal; deadline: number }>): unknown | Promise<unknown>
}>): Promise<StrictAgentHookResult> {
	const evidence = createDecisionEvidence({ occurrence: options.occurrence,
		source: { kind: 'interceptor', id: options.interceptorId }, phase: options.phase, ordinal: 0 })
	const ownDeadline = Date.now() + options.decisionTimeoutMs
	const deadline = options.deadline === undefined ? ownDeadline : Math.min(ownDeadline, options.deadline)
	let raw: unknown
	try {
		raw = await runDecisionOperation({ signal: options.signal, deadline }, signal => options.invoke(Object.freeze({ signal, deadline })))
	} catch (error) {
		if (error instanceof OperationCancelledError || error instanceof DecisionBlockedError || error instanceof DecisionEvaluationError) throw error
		if (error instanceof OperationTimeoutError) {
			if (error.meta?.['scope'] !== 'decision') throw error
			throw new DecisionEvaluationError(evidence, 'callback_timeout', error)
		}
		throw new DecisionEvaluationError(evidence, 'callback_failed', error)
	}
	if (raw === undefined) return undefined
	if (!isPlainRecord(raw)) throw new DecisionEvaluationError(evidence, 'invalid_result')
	if (raw['decision'] === 'transform') {
		if (!options.allowTransform || !hasOnlyKeys(raw, ['decision', 'value', 'reasonCode'])) {
			throw new DecisionEvaluationError(evidence, options.allowTransform ? 'invalid_transform' : 'invalid_result')
		}
		if (!isJsonValue(raw['value']) || !validReasonCode(raw['reasonCode'])) throw new DecisionEvaluationError(evidence, 'invalid_transform')
		let transformed = raw['value']
		try { if (options.transform) transformed = await options.transform(transformed) }
		catch (error) {
			if (error instanceof OperationCancelledError || error instanceof OperationTimeoutError) throw error
			throw new DecisionEvaluationError(evidence, 'invalid_transform', error)
		}
		if (!isJsonValue(transformed)) throw new DecisionEvaluationError(evidence, 'invalid_transform')
		return Object.freeze({ decision: 'transform', value: freezeJson(copyJson(transformed)), ...(raw['reasonCode'] === undefined ? {} : { reasonCode: raw['reasonCode'] }) })
	}
	const parsed = decisionResultSchema.safeParse(raw)
	if (!parsed.success) throw new DecisionEvaluationError(evidence, 'invalid_result')
	return Object.freeze({ decision: parsed.data.decision,
		...(parsed.data.reasonCode === undefined ? {} : { reasonCode: parsed.data.reasonCode }) })
}

interface PreparedToolLifecycle {
	readonly signal: AbortSignal
	readonly deadline?: number
	dispose(): void
}

export type PreparedAgentToolCall = Readonly<{
	readonly call: ToolCallSpec
	readonly binding: AgentExecutableBinding
	readonly input: JsonValue
	readonly entry: Extract<PreparedToolCheckpointEntryV1, { readonly state: 'ready' }>
	readonly approval?: ToolApprovalRequest
	readonly lifecycle: PreparedToolLifecycle
}> | Readonly<{
	readonly call: ToolCallSpec
	readonly entry: Extract<PreparedToolCheckpointEntryV1, { readonly state: 'recoverable' | 'denied' }>
}>

/** Preflights a complete provider batch in call order before any tool effect starts. */
export async function prepareAgentToolBatch(options: AgentToolPipelineOptions): Promise<readonly PreparedAgentToolCall[]> {
	if (options.calls.length > options.remainingToolCalls) throw new AgentLoopBudgetError('Agent tool-call budget exceeded.', {
		agent_id: options.agent.id, reason: 'max_tool_calls', limit: options.maxToolCalls,
	})
	const subagentCount = options.calls.filter(call => options.bindings[call.name]?.implementationKind === 'subagent').length
	if (subagentCount > 0 && options.invocation.remainingDepth === 0) throw new AgentLoopBudgetError('Agent delegation depth budget exceeded.', {
		agent_id: options.agent.id, reason: 'max_depth', limit: options.invocation.depth + options.invocation.remainingDepth,
	})
	if (subagentCount > options.remainingSubagentCalls) throw new AgentLoopBudgetError('Agent subagent-call budget exceeded.', {
		agent_id: options.agent.id, reason: 'max_subagent_calls', limit: options.maxSubagentCalls,
	})
	const prepared: PreparedAgentToolCall[] = []
	try {
		for (const call of options.calls) prepared.push(await prepareOne(options, call))
		return Object.freeze(prepared)
	} catch (error) {
		for (const item of prepared) if ('lifecycle' in item) item.lifecycle.dispose()
		throw error
	}
}

/** Executes only an already preflighted batch through the sole common pipeline. */
export async function executePreparedAgentToolBatch(
	options: AgentToolPipelineOptions,
	prepared: readonly PreparedAgentToolCall[],
): Promise<readonly Readonly<{ entry: PreparedToolCheckpointEntryV1; message: Extract<ModelMessage, { role: 'tool' }> }>[]> {
	const results: Array<Readonly<{ entry: PreparedToolCheckpointEntryV1; message: Extract<ModelMessage, { role: 'tool' }> }>> = []
	let offset = 0
	while (offset < prepared.length) {
		const slice: PreparedAgentToolCall[] = []
		let subagents = 0
		while (offset < prepared.length && slice.length < Math.max(1, options.maxParallelToolCalls)) {
			const candidate = prepared[offset]!
			const isSubagent = 'binding' in candidate && candidate.binding.implementationKind === 'subagent'
			if (isSubagent && subagents >= Math.max(1, options.maxParallelSubagents)) break
			slice.push(candidate)
			if (isSubagent) subagents += 1
			offset += 1
		}
		const settled = await Promise.allSettled(slice.map(item => executeOne(options, item)))
		for (const result of settled) if (result.status === 'fulfilled') results.push(result.value)
		const firstFailure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
		if (firstFailure) {
			const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			const childInterruptions = failures.flatMap(result => isHarnessChildTargetInterruption(result.reason) ? [result.reason] : [])
			if (childInterruptions.length === failures.length && childInterruptions.length > 1) {
				throw createHarnessChildTargetInterruptionGroup(childInterruptions)
			}
			throw firstFailure.reason
		}
	}
	return Object.freeze(results)
}

/**
 * @internal Restores one persisted prepared batch without repeating preflight.
 * Stored completed/recoverable/denied entries are replayed as model messages;
 * only ready entries receive a fresh bounded lifecycle and may execute.
 */
export async function resumePreparedAgentToolBatch(
	options: AgentToolPipelineOptions,
	entries: readonly PreparedToolCheckpointEntryV1[],
	decisions: readonly AppliedApprovalDecisionV1[],
): Promise<readonly Readonly<{ entry: PreparedToolCheckpointEntryV1; message: Extract<ModelMessage, { role: 'tool' }> }>[]> {
	const decisionById = new Map(decisions.map(decision => [decision.approvalId, decision.approved] as const))
	const replayed = new Map<string, Readonly<{ entry: PreparedToolCheckpointEntryV1; message: Extract<ModelMessage, { role: 'tool' }> }>>()
	const executable: PreparedAgentToolCall[] = []
	for (const entry of entries) {
		if (entry.state === 'completed') {
			replayed.set(entry.call.id, Object.freeze({ entry, message: entry.modelMessage }))
			continue
		}
		if (entry.state === 'recoverable' || entry.state === 'denied') {
			const message = Object.freeze({ role: 'tool' as const, toolCallId: entry.call.id, content: JSON.stringify({ error: entry.error }) })
			replayed.set(entry.call.id, Object.freeze({ entry, message }))
			continue
		}
		if (entry.state === 'suspended-child') {
			if (options.resumeSuspendedChild === undefined) throw new ValidationError('Prepared child continuation requires leaf-first resume.', {
				where: 'invoke_options', issues: { reason: 'suspended_child_requires_leaf_resume' },
			})
			let childOutput: JsonValue
			try {
				childOutput = await options.resumeSuspendedChild(entry)
			} catch (error) {
				if (isTerminalLifecycleError(error)) {
					try {
						await options.sink.emit({ type: 'tool.finished', agentId: options.agent.id,
							toolId: entry.bindingId, callId: entry.call.id, error: serializeError(error) })
					} catch { /* preserve the terminal lifecycle identity */ }
				}
				throw error
			}
			const completed = await completeSuspendedAgentTool(options, entry, childOutput)
			replayed.set(entry.call.id, completed)
			continue
		}
		const binding = options.bindings[entry.bindingId]
		if (!binding || binding.id !== entry.bindingId || binding.contractDigest !== entry.bindingContractDigest || binding.id !== entry.call.name) {
			throw new ValidationError('Prepared tool binding is unavailable.', {
				where: 'invoke_options', issues: { reason: 'prepared_tool_binding_mismatch' },
			})
		}
		if (entry.approvalId !== undefined) {
			const approved = decisionById.get(entry.approvalId)
			if (approved === undefined) throw new ValidationError('Prepared approval decision is missing.', {
				where: 'invoke_options', issues: { reason: 'prepared_approval_decision_missing' },
			})
			await options.sink.emit({ type: 'approval.responded', agentId: options.agent.id,
				invocationId: options.invocation.invocationId, toolId: binding.id, callId: entry.call.id,
				step: options.step, approvalId: entry.approvalId, approved })
			if (!approved) {
				executable.push(recoverable(entry.call, 'transformed', new ToolError(
					'Tool approval was rejected.', { tool_id: binding.id, tool_kind: 'approval' },
				)))
				continue
			}
		}
		const lifecycle = boundedSignal(options.invocation.signal, options.toolTimeoutMs, options.invocation.deadline)
		executable.push(Object.freeze({ call: entry.call, binding, input: entry.input, entry, lifecycle }))
	}
	const executed = await executePreparedAgentToolBatch(options, Object.freeze(executable))
	for (const result of executed) replayed.set(result.entry.call.id, result)
	return Object.freeze(entries.map(entry => {
		const result = replayed.get(entry.call.id)
		if (!result) throw new TypeError('Prepared tool result is unavailable.')
		return result
	}))
}

/** @internal Completes a started subagent tool occurrence after its leaf resumes. */
export async function completeSuspendedAgentTool(
	options: AgentToolPipelineOptions,
	entry: Extract<PreparedToolCheckpointEntryV1, { readonly state: 'suspended-child' }>,
	childOutput: JsonValue,
): Promise<Readonly<{ entry: PreparedToolCheckpointEntryV1; message: Extract<ModelMessage, { role: 'tool' }> }>> {
	const binding = options.bindings[entry.bindingId]
	if (!binding || (binding.implementationKind !== 'subagent' && binding.implementationKind !== 'host') || binding.id !== entry.bindingId
		|| binding.id !== entry.call.name || binding.contractDigest !== entry.bindingContractDigest) {
		throw new ValidationError('Prepared child binding is unavailable.', {
			where: 'invoke_options', issues: { reason: 'prepared_child_binding_mismatch' },
		})
	}
	const lifecycle = boundedSignal(options.invocation.signal, options.toolTimeoutMs, options.invocation.deadline)
	try {
		let output: JsonValue = childOutput
		if (binding.outputValidation === 'required') {
			const parsed = await withAbortSignal(lifecycle.signal, 'tool', 'Tool output validation was cancelled.', () => validateSchema(
				binding.output, output, { where: 'tool_output', message: 'Tool output validation failed.', assertNotAborted: () => assertActive(lifecycle.signal) },
			))
			if (!isJsonValue(parsed)) throw new ValidationError('Tool output validation failed.', { where: 'tool_output', issues: { reason: 'non_json_tool_output' } })
			output = parsed
		}
		if (!isJsonValue(output)) throw new ValidationError('Tool output validation failed.', {
			where: 'tool_output', issues: { reason: 'non_json_tool_output' },
		})
		const interceptor = options.agent.guardrails?.[agentGuardrailsBinding] as AgentExecutionInterceptor | undefined
		if (interceptor?.afterTool) {
			const outputSnapshot = freezeJson(copyJson(output))
			const result = await runStrictAgentHook({ interceptorId: interceptor.id, phase: 'tool_output',
				occurrence: occurrence(options, binding.id, entry.call.id), signal: lifecycle.signal,
				decisionTimeoutMs: options.decisionTimeoutMs, allowTransform: true,
				...(lifecycle.deadline === undefined ? {} : { deadline: lifecycle.deadline }),
				invoke: decision => interceptor.afterTool?.(interceptorContext(options, interceptor, decision, {
					toolId: binding.id, callId: entry.call.id, output: outputSnapshot,
				})) })
			if (result?.decision === 'block') throw blocked(options, interceptor, 'tool_output', binding.id, entry.call.id, result.reasonCode)
			if (result?.decision === 'transform') output = result.value
		}
		const message = Object.freeze({ role: 'tool' as const, toolCallId: entry.call.id, content: JSON.stringify(output) })
		const completed = freezePreparedToolCheckpointEntry({ state: 'completed', call: entry.call, input: entry.input,
			bindingId: binding.id, bindingContractDigest: binding.contractDigest, toolStarted: true,
			outcome: Object.freeze({ status: 'completed', output }), modelMessage: message })
		await withAbortSignal(lifecycle.signal, 'tool', 'Tool lifecycle event emission was cancelled.', () => options.sink.emit({
			type: 'tool.finished', agentId: options.agent.id, toolId: binding.id, callId: entry.call.id, output,
		}))
		await options.onEntry?.(completed)
		return Object.freeze({ entry: completed, message })
	} finally { lifecycle.dispose() }
}

async function prepareOne(options: AgentToolPipelineOptions, providerCall: ToolCallSpec): Promise<PreparedAgentToolCall> {
	const lifecycle = boundedSignal(options.invocation.signal, options.toolTimeoutMs, options.invocation.deadline)
	let call = freezeCall(providerCall)
	const binding = options.bindings[call.name]
	if (!binding) {
		lifecycle.dispose()
		return recoverable(call, 'provider', new ToolNotFoundError('Model referenced an unavailable tool.', { tool_id: call.name, where: 'model_response' }))
	}
	let wireInput = call.arguments
	let argumentsTransformed = false
	const interceptor = options.agent.guardrails?.[agentGuardrailsBinding] as AgentExecutionInterceptor | undefined
	if (interceptor?.beforeTool) {
		try {
			const result = await runStrictAgentHook({ interceptorId: interceptor.id, phase: 'tool_input', occurrence: occurrence(options, binding.id, call.id),
				signal: lifecycle.signal, decisionTimeoutMs: options.decisionTimeoutMs, allowTransform: true,
				...(lifecycle.deadline === undefined ? {} : { deadline: lifecycle.deadline }),
				invoke: decision => interceptor.beforeTool?.(interceptorContext(options, interceptor, decision, { toolId: binding.id, callId: call.id, input: wireInput })) })
			if (result?.decision === 'block') throw blocked(options, interceptor, 'tool_input', binding.id, call.id, result.reasonCode)
			if (result?.decision === 'transform') {
				wireInput = result.value
				argumentsTransformed = true
			}
		} catch (error) {
			lifecycle.dispose()
			throw error
		}
	}
	if (!isJsonValue(wireInput)) {
		lifecycle.dispose()
		return recoverable(call, 'provider', new ValidationError('Tool input validation failed.', { where: 'tool_input', issues: { reason: 'non_json_wire_input' } }))
	}
	const frozenWireInput = freezeJson(copyJson(wireInput))
	const transformedCall = Object.freeze({ ...call, arguments: frozenWireInput })
	let input: JsonValue
	try {
		input = freezeJson(copyJson(await withAbortSignal(lifecycle.signal, 'tool', 'Tool preflight was cancelled.', () => validateSchema(binding.input, frozenWireInput, {
			where: 'tool_input', message: 'Tool input validation failed.', assertNotAborted: () => assertActive(lifecycle.signal),
		}))))
	} catch (error) {
		if (isTerminalLifecycleError(error)) {
			lifecycle.dispose()
			throw error
		}
		lifecycle.dispose()
		return recoverable(transformedCall, argumentsTransformed ? 'transformed' : 'provider', error)
	}
	try {
		await withAbortSignal(lifecycle.signal, 'tool', 'Tool preflight was cancelled.', () => options.sink.emit({
			type: 'tool.input.available', agentId: options.agent.id, toolId: binding.id, callId: call.id, input,
		}))
	} catch (error) {
		lifecycle.dispose()
		throw error
	}
	let governance: Awaited<ReturnType<typeof enforceToolGovernance>>
	try { governance = await withAbortSignal(lifecycle.signal, 'tool', 'Tool preflight was cancelled.', () => enforceToolGovernance({
		agentId: options.agent.id, runId: options.invocation.runId, rootRunId: options.invocation.rootRunId,
		agentRunId: options.invocation.runId,
		...(options.invocation.parentRunId === undefined ? {} : { parentRunId: options.invocation.parentRunId }),
		...(options.invocation.parentInvocationId === undefined ? {} : { parentInvocationId: options.invocation.parentInvocationId }),
		sessionId: options.invocation.sessionId,
		...(options.invocation.workflowId === undefined ? {} : { workflowId: options.invocation.workflowId }),
		invocationId: options.invocation.invocationId, step: options.step, signal: lifecycle.signal,
		decisionTimeoutMs: options.decisionTimeoutMs,
		...(lifecycle.deadline === undefined ? {} : { deadline: lifecycle.deadline }), metadata: options.invocation.metadata,
		telemetry: options.invocation.telemetry, eventSink: options.sink, toolId: binding.id, callId: call.id, input,
		...(options.agent.permissions === undefined ? {} : { permissions: options.agent.permissions as AgentPermissions }),
		...(options.agent.governance === undefined ? {} : { governance: options.agent.governance }),
	}, options.suppliedDecisions)) } catch (error) {
		if (error instanceof PermissionDeniedError || error instanceof PolicyDeniedError) {
			lifecycle.dispose()
			return denied(transformedCall, input, error)
		}
		lifecycle.dispose()
		throw error
	}
	if (governance?.decision === 'rejected') {
		lifecycle.dispose()
		return recoverable(transformedCall, argumentsTransformed ? 'transformed' : 'provider', new ToolError(
			'Tool approval was rejected.', { tool_id: binding.id, tool_kind: 'approval' },
		))
	}
	const approval = governance?.decision === 'approval_required' ? governance.request : undefined
	const entry = freezePreparedToolCheckpointEntry(Object.freeze({
		state: 'ready' as const, call: transformedCall, input, bindingId: binding.id,
		bindingContractDigest: binding.contractDigest, ...(approval === undefined ? {} : { approvalId: approval.approvalId }),
	})) as Extract<PreparedToolCheckpointEntryV1, { state: 'ready' }>
	return Object.freeze({ call: transformedCall, binding, input, entry, lifecycle, ...(approval === undefined ? {} : { approval }) })
}

async function executeOne(options: AgentToolPipelineOptions, prepared: PreparedAgentToolCall) {
	if (!('binding' in prepared)) {
		const serialized = prepared.entry.error
		await options.sink.emit({ type: 'tool.finished', agentId: options.agent.id, toolId: prepared.call.name, callId: prepared.call.id, error: serialized })
		await options.onEntry?.(prepared.entry)
		return Object.freeze({ entry: prepared.entry, message: Object.freeze({ role: 'tool' as const, toolCallId: prepared.call.id, content: JSON.stringify({ error: serialized }) }) })
	}
	const { binding, call, input } = prepared
	const signal = prepared.lifecycle.signal
	const invocation = Object.freeze({ ...options.invocation, step: options.step, toolId: binding.id, callId: call.id, signal,
		...(prepared.lifecycle.deadline === undefined ? {} : { deadline: prepared.lifecycle.deadline }) })
	let finishAttempted = false
	const emitFinished = async (event: Extract<AgentPipelineEvent, { readonly type: 'tool.finished' }>): Promise<void> => {
		if (finishAttempted) throw new TypeError('tool.finished has already been attempted for this tool occurrence.')
		finishAttempted = true
		const emission = options.sink.emit(event)
		await withAbortSignal(signal, 'tool', 'Tool lifecycle event emission was cancelled.', () => emission)
	}
	try {
		assertActive(signal)
		if (binding.beforeInvoke !== undefined) {
			await withAbortSignal(signal, 'tool', 'Tool launch authorization was cancelled.', () => binding.beforeInvoke!(invocation))
		}
	} catch (error) {
		binding.afterInvoke?.(invocation)
		prepared.lifecycle.dispose()
		throw error
	}
	try {
		await withAbortSignal(signal, 'tool', 'Tool lifecycle event emission was cancelled.', () => options.sink.emit({
			type: 'tool.started', agentId: options.agent.id, toolId: binding.id, callId: call.id, input: call.arguments,
		}))
		let output: unknown
		try {
			output = await withAbortSignal(signal, 'tool', 'Tool execution was cancelled.', () => binding.invokeValidated(invocation, input, call.arguments))
			if (binding.outputValidation === 'required') {
				output = await withAbortSignal(signal, 'tool', 'Tool output validation was cancelled.', () => validateSchema(binding.output, output, { where: 'tool_output', message: 'Tool output validation failed.', assertNotAborted: () => assertActive(signal) }))
			} else if (!isJsonValue(output)) {
				throw new ValidationError('Tool output validation failed.', { where: 'tool_output', issues: { reason: 'non_json_target_output' } })
			}
			if (!isJsonValue(output)) throw new ValidationError('Tool output validation failed.', {
				where: 'tool_output', issues: { reason: 'non_json_tool_output' },
			})
			const interceptor = options.agent.guardrails?.[agentGuardrailsBinding] as AgentExecutionInterceptor | undefined
			if (interceptor?.afterTool) {
				const outputSnapshot = freezeJson(copyJson(output))
				const result = await runStrictAgentHook({ interceptorId: interceptor.id, phase: 'tool_output', occurrence: occurrence(options, binding.id, call.id),
					signal, decisionTimeoutMs: options.decisionTimeoutMs, allowTransform: true,
					...(prepared.lifecycle.deadline === undefined ? {} : { deadline: prepared.lifecycle.deadline }),
					invoke: decision => interceptor.afterTool?.(interceptorContext(options, interceptor, decision, {
						toolId: binding.id, callId: call.id, output: outputSnapshot,
					})) })
				if (result?.decision === 'block') throw blocked(options, interceptor, 'tool_output', binding.id, call.id, result.reasonCode)
				if (result?.decision === 'transform') output = result.value
			}
			if (!isJsonValue(output)) throw new ValidationError('Tool output validation failed.', { where: 'tool_output', issues: { reason: 'non_json_tool_output' } })
		} catch (error) {
			if (isHarnessChildTargetInterruption(error)) {
				const entry = freezePreparedToolCheckpointEntry({ state: 'suspended-child', call, input, bindingId: binding.id,
					bindingContractDigest: binding.contractDigest, toolStarted: true, childInvocationId: error.childInvocationId,
					childRunId: error.outcome.runId }) as Extract<PreparedToolCheckpointEntryV1, { readonly state: 'suspended-child' }>
				await observeChildInterruption(options.onChildInterruption, entry, signal)
				await observeChildInterruption(options.onEntry, entry, signal)
				throw error
			}
			if (isTerminalLifecycleError(error)) {
				try {
					await emitFinished({ type: 'tool.finished', agentId: options.agent.id, toolId: binding.id, callId: call.id, error: serializeError(error) })
				} catch { /* preserve the terminal lifecycle or decision identity */ }
				throw error
			}
			const normalized = error instanceof Error && ('code' in error) ? error : new ToolError('Tool execution failed.', { tool_id: binding.id, tool_kind: binding.implementationKind }, error)
			const serialized = serializeError(normalized)
			await emitFinished({ type: 'tool.finished', agentId: options.agent.id, toolId: binding.id, callId: call.id, error: serialized })
			const message = Object.freeze({ role: 'tool' as const, toolCallId: call.id, content: JSON.stringify({ error: serialized }) })
			const entry = freezePreparedToolCheckpointEntry({ state: 'completed', call, input, bindingId: binding.id,
				bindingContractDigest: binding.contractDigest, toolStarted: true, outcome: Object.freeze({ status: 'failed', error: serialized }), modelMessage: message })
			await options.onEntry?.(entry)
			return Object.freeze({ entry, message })
		}
		const parsed = output
		const message = Object.freeze({ role: 'tool' as const, toolCallId: call.id, content: JSON.stringify(parsed) })
		const entry = freezePreparedToolCheckpointEntry({ state: 'completed', call, input, bindingId: binding.id,
			bindingContractDigest: binding.contractDigest, toolStarted: true, outcome: Object.freeze({ status: 'completed', output: parsed }), modelMessage: message })
		await emitFinished({ type: 'tool.finished', agentId: options.agent.id, toolId: binding.id, callId: call.id, output: parsed })
		await options.onEntry?.(entry)
		return Object.freeze({ entry, message })
	} finally {
		binding.afterInvoke?.(invocation)
		prepared.lifecycle.dispose()
	}
}

function interceptorContext<Extra extends object>(
	options: AgentToolPipelineOptions,
	interceptor: AgentExecutionInterceptor,
	decision: Readonly<{ signal: AbortSignal; deadline: number }>,
	extra: Extra,
): AgentExecutionInterceptorContext<JsonValue> & Extra {
	return {
		agentInput: options.agentInput,
		interceptorId: interceptor.id,
		invocationId: options.invocation.invocationId,
		step: options.step,
		model: options.agent.model,
		agentId: options.agent.id,
		...(options.invocation.workflowId === undefined ? {} : { workflowId: options.invocation.workflowId }),
		runId: options.invocation.runId,
		sessionId: options.invocation.sessionId,
		history: options.interceptorRuntime.history,
		memory: options.interceptorRuntime.memory,
		metadata: options.invocation.metadata,
		metrics: options.interceptorRuntime.metrics,
		models: options.interceptorRuntime.models,
		signal: decision.signal,
		decision,
		logger: options.interceptorRuntime.logger,
		telemetry: options.interceptorRuntime.telemetry,
		...extra,
	}
}

function occurrence(options: AgentToolPipelineOptions, toolId: string, callId: string) {
	return { invocationId: options.invocation.invocationId, runId: options.invocation.runId, agentId: options.agent.id,
		sessionId: options.invocation.sessionId, ...(options.invocation.workflowId === undefined ? {} : { workflowId: options.invocation.workflowId }),
		toolId, callId, step: options.step }
}

function blocked(
	options: AgentToolPipelineOptions,
	interceptor: AgentExecutionInterceptor,
	phase: 'tool_input' | 'tool_output',
	toolId: string,
	callId: string,
	reasonCode?: string,
): DecisionBlockedError {
	return new DecisionBlockedError(createDecisionEvidence({ occurrence: occurrence(options, toolId, callId),
		source: { kind: 'interceptor', id: interceptor.id }, phase, ordinal: 0, ...(reasonCode === undefined ? {} : { reasonCode }) }))
}

async function observeChildInterruption(
	observer: ((entry: Extract<PreparedToolCheckpointEntryV1, { readonly state: 'suspended-child' }>) => Promise<void> | void) | undefined,
	entry: Extract<PreparedToolCheckpointEntryV1, { readonly state: 'suspended-child' }>,
	signal: AbortSignal,
): Promise<void> {
	if (observer === undefined) return
	try {
		await withAbortSignal(signal, 'tool', 'Child-interruption observation was cancelled.', async () => { await observer(entry) })
	} catch {
		// Observers cannot replace the branded child-interruption control flow.
	}
}

function assertActive(signal: AbortSignal): void { if (signal.aborted) throw abortError(signal, 'tool', 'Tool execution was cancelled.') }
function boundedSignal(parent: AbortSignal, timeoutMs: number, parentDeadline?: number): PreparedToolLifecycle {
	const startedAt = Date.now()
	const toolDeadline = timeoutMs === 0 ? undefined : startedAt + timeoutMs
	const deadline = parentDeadline === undefined ? toolDeadline : toolDeadline === undefined ? parentDeadline : Math.min(parentDeadline, toolDeadline)
	if (timeoutMs === 0) return { signal: parent, ...(deadline === undefined ? {} : { deadline }), dispose() {} }
	const controller = new AbortController()
	const onAbort = () => controller.abort(parent.reason)
	parent.addEventListener('abort', onAbort, { once: true })
	if (parent.aborted) onAbort()
	const timer = setTimeout(() => controller.abort(new OperationTimeoutError('Tool execution timed out.', { scope: 'tool', timeout_ms: timeoutMs })), timeoutMs)
	return { signal: controller.signal, ...(deadline === undefined ? {} : { deadline }), dispose() { clearTimeout(timer); parent.removeEventListener('abort', onAbort) } }
}
function freezeJson<T extends JsonValue>(value: T): T {
	if (value !== null && typeof value === 'object') {
		for (const child of Object.values(value)) freezeJson(child)
		Object.freeze(value)
	}
	return value
}
function copyJson<T extends JsonValue>(value: T): T {
	if (Array.isArray(value)) return value.map(child => copyJson(child)) as T
	if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyJson(child)])) as T
	return value
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys)
	return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key))
}

function validReasonCode(value: unknown): value is string | undefined {
	if (value === undefined) return true
	return decisionResultSchema.safeParse({ decision: 'allow', reasonCode: value }).success
}

function freezeCall(call: ToolCallSpec): ToolCallSpec {
	if (!isJsonValue(call.arguments)) throw new ValidationError('Model tool arguments must be JSON.', {
		where: 'model_response', issues: { reason: 'non_json_tool_arguments' },
	})
	return Object.freeze({ id: call.id, name: call.name, arguments: freezeJson(copyJson(call.arguments)) })
}

function recoverable(
	call: ToolCallSpec,
	argumentsStage: 'provider' | 'transformed',
	error: unknown,
): PreparedAgentToolCall {
	const serialized = serializeError(error)
	return Object.freeze({ call, entry: freezePreparedToolCheckpointEntry({ state: 'recoverable', call, argumentsStage, error: serialized }) as Extract<PreparedToolCheckpointEntryV1, { state: 'recoverable' }> })
}

function denied(call: ToolCallSpec, input: JsonValue, error: unknown): PreparedAgentToolCall {
	const serialized = serializeError(error)
	return Object.freeze({ call, entry: freezePreparedToolCheckpointEntry({ state: 'denied', call, input, error: serialized }) as Extract<PreparedToolCheckpointEntryV1, { state: 'denied' }> })
}

function isTerminalLifecycleError(error: unknown): error is OperationCancelledError | OperationTimeoutError | DecisionBlockedError | DecisionEvaluationError | HarnessTargetRouteReceiptMismatchError {
	return error instanceof OperationCancelledError || error instanceof OperationTimeoutError
		|| error instanceof DecisionBlockedError || error instanceof DecisionEvaluationError
		|| error instanceof HarnessTargetRouteReceiptMismatchError
}
