import { finishReasonSchema, tokenUsageSchema } from '../ports/model-provider.js'
import type { FinishReason, ModelCallOptions, ModelOutcome, ModelToolSpec, ProviderContinuation, TokenUsage, ToolCallSpec, ModelMessage } from '../ports/model-provider.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type { SerializedError } from '../models/state.js'
import { HarnessConfigError } from '../errors/index.js'
import { parseProviderContinuation } from '../decisions/index.js'

export type PreparedToolCheckpointEntryV1 =
	| Readonly<{ state: 'recoverable'; call: ToolCallSpec; argumentsStage: 'provider' | 'transformed'; error: SerializedError }>
	| Readonly<{ state: 'denied'; call: ToolCallSpec; input: JsonValue; error: SerializedError }>
	| Readonly<{ state: 'ready'; call: ToolCallSpec; input: JsonValue; bindingId: string; bindingContractDigest: string; approvalId?: string }>
	| Readonly<{ state: 'completed'; call: ToolCallSpec; input: JsonValue; bindingId: string; bindingContractDigest: string; toolStarted: true; outcome: Readonly<{ status: 'completed'; output: JsonValue }> | Readonly<{ status: 'failed'; error: SerializedError }>; modelMessage: Extract<ModelMessage, { role: 'tool' }> }>
	| Readonly<{ state: 'suspended-child'; call: ToolCallSpec; input: JsonValue; bindingId: string; bindingContractDigest: string; toolStarted: true; childInvocationId: string; childRunId: string }>

export interface SuspendedAgentTurnStateV1 {
	readonly rootRunId: string
	readonly agentRunId: string
	readonly sessionId: string
	readonly agentId: string
	readonly workflowId?: string
	readonly parentRunId?: string
	readonly parentInvocationId?: string
	readonly invocationId: string
	readonly step: number
	readonly modelAlias: string
	readonly input: JsonValue
	readonly messages: readonly ModelMessage[]
	readonly providerContinuation?: ProviderContinuation
	readonly entries: readonly PreparedToolCheckpointEntryV1[]
	readonly agentStarted: true
}

export type AcceptedModelTurnOperationV1 = 'text' | 'object' | 'textStream' | 'objectStream'

/** @internal Durable cursor written before post-model callbacks or effects. */
export interface AcceptedModelTurnCursorV1 {
	readonly schemaVersion: 1
	readonly kind: 'accepted_model_turn'
	readonly phase: 'after_model' | 'continue_turn'
	readonly rootRunId: string
	readonly agentRunId: string
	readonly sessionId: string
	readonly agentId: string
	readonly workflowId?: string
	readonly parentRunId?: string
	readonly parentInvocationId?: string
	readonly invocationId: string
	readonly step: number
	readonly modelAlias: string
	readonly input: JsonValue
	readonly mode: 'run' | 'stream'
	readonly operation: AcceptedModelTurnOperationV1
	readonly streamId?: string
	readonly request: Readonly<{ readonly messages: readonly ModelMessage[]; readonly tools: readonly ModelToolSpec[]; readonly schema?: JsonValue; readonly call?: ModelCallOptions }>
	readonly response: Readonly<
		| { readonly content: string; readonly toolCalls: readonly ToolCallSpec[]; readonly usage: TokenUsage; readonly finishReason: FinishReason; readonly outcome?: ModelOutcome }
		| { readonly object: JsonValue; readonly toolCalls: readonly ToolCallSpec[]; readonly usage: TokenUsage; readonly finishReason: FinishReason; readonly outcome?: ModelOutcome }
	>
	readonly providerContinuation?: ProviderContinuation
	readonly agentStarted: true
}

export type AgentContinuationStateV1 = SuspendedAgentTurnStateV1 | AcceptedModelTurnCursorV1

/** @internal Freezes one data-only prepared entry after rejecting continuation leakage. */
export function freezePreparedToolCheckpointEntry(entry: PreparedToolCheckpointEntryV1): PreparedToolCheckpointEntryV1 {
	if (containsProviderContinuation(entry) || 'definition' in entry || 'binding' in entry) invalidCheckpoint()
	return deepFreezeJsonCopy(entry) as PreparedToolCheckpointEntryV1
}

/** @internal Validates continuation only in the dedicated suspended-turn field. */
export function freezeSuspendedAgentTurnState(state: SuspendedAgentTurnStateV1): SuspendedAgentTurnStateV1 {
	if (containsProviderContinuation(state.messages) || containsProviderContinuation(state.entries)) invalidCheckpoint()
	const callIds = state.entries.map(entry => entry.call.id)
	if (state.providerContinuation !== undefined && parseProviderContinuation(state.providerContinuation, callIds) === undefined) invalidCheckpoint()
	return deepFreezeJsonCopy(state) as SuspendedAgentTurnStateV1
}

/** @internal Freezes a strict accepted provider turn without duplicating continuation data. */
export function freezeAcceptedModelTurnCursor(state: AcceptedModelTurnCursorV1): AcceptedModelTurnCursorV1 {
	if (!isJsonValue(state) || !plain(state) || !exact(state, ['schemaVersion', 'kind', 'phase', 'rootRunId', 'agentRunId', 'sessionId',
		'agentId', 'workflowId', 'parentRunId', 'parentInvocationId', 'invocationId', 'step', 'modelAlias', 'input', 'mode', 'operation',
		'streamId', 'request', 'response', 'providerContinuation', 'agentStarted'])) invalidCheckpoint()
	if (state.schemaVersion !== 1 || state.kind !== 'accepted_model_turn' || !['after_model', 'continue_turn'].includes(state.phase)
		|| ![state.rootRunId, state.agentRunId, state.sessionId, state.agentId, state.invocationId, state.modelAlias].every(validId)
		|| ![state.workflowId, state.parentRunId, state.parentInvocationId, state.streamId].every(value => value === undefined || validId(value))
		|| !Number.isSafeInteger(state.step) || state.step < 1 || state.agentStarted !== true || !isJsonValue(state.input)
		|| !validPersistedRequest(state.request) || !validPersistedResponse(state.response)) invalidCheckpoint()
	if (containsProviderContinuation(state.request) || containsProviderContinuation(state.response)) invalidCheckpoint()
	if (!['run', 'stream'].includes(state.mode) || !['text', 'object', 'textStream', 'objectStream'].includes(state.operation)) invalidCheckpoint()
	const streaming = state.operation === 'textStream' || state.operation === 'objectStream'
	if (streaming !== (state.mode === 'stream') || streaming !== (state.streamId !== undefined)) invalidCheckpoint()
	const text = state.operation === 'text' || state.operation === 'textStream'
	if (text !== ('content' in state.response) || text === ('schema' in state.request)) invalidCheckpoint()
	if (state.providerContinuation !== undefined && parseProviderContinuation(state.providerContinuation, state.response.toolCalls.map(call => call.id)) === undefined) invalidCheckpoint()
	return deepFreezeJsonCopy(state) as AcceptedModelTurnCursorV1
}

function validPersistedRequest(value: unknown): value is AcceptedModelTurnCursorV1['request'] {
	if (!plain(value) || !exact(value, ['messages', 'tools', 'schema', 'call']) || !Array.isArray(value['messages'])
		|| !value['messages'].every(validMessage) || !Array.isArray(value['tools']) || !value['tools'].every(validTool)
		|| (value['schema'] !== undefined && !isJsonValue(value['schema']))) return false
	if (value['call'] !== undefined) {
		if (!plain(value['call']) || !exact(value['call'], ['temperature', 'maxTokens', 'topP', 'stopSequences', 'parallelToolCalls', 'retry', 'providerOptions'])
			|| !isJsonValue(value['call']) || !validCallOptions(value['call'])) return false
	}
	return true
}

function validCallOptions(value: Record<string, unknown>): boolean {
	if (!['temperature', 'maxTokens', 'topP'].every(key => value[key] === undefined || (typeof value[key] === 'number' && Number.isFinite(value[key])))
		|| (value['stopSequences'] !== undefined && (!Array.isArray(value['stopSequences']) || !value['stopSequences'].every(item => typeof item === 'string')))
		|| (value['parallelToolCalls'] !== undefined && typeof value['parallelToolCalls'] !== 'boolean')
		|| (value['providerOptions'] !== undefined && (!plain(value['providerOptions']) || !isJsonValue(value['providerOptions'])))) return false
	const retry = value['retry']
	if (retry === undefined || typeof retry === 'boolean') return true
	if (!plain(retry) || !exact(retry, ['maxAttempts', 'maxActiveElapsedMs', 'maxActiveDelayMs', 'maxDeferredDelayMs', 'respectRetryAfter',
		'minDelayMs', 'maxDelayMs', 'retryOn', 'longRetry'])) return false
	for (const key of ['maxAttempts', 'maxActiveElapsedMs', 'maxActiveDelayMs', 'maxDeferredDelayMs', 'minDelayMs', 'maxDelayMs']) {
		if (retry[key] !== undefined && (typeof retry[key] !== 'number' || !Number.isFinite(retry[key]))) return false
	}
	if (retry['respectRetryAfter'] !== undefined && typeof retry['respectRetryAfter'] !== 'boolean') return false
	if (retry['longRetry'] !== undefined && !['error', 'defer'].includes(String(retry['longRetry']))) return false
	const retryOn = retry['retryOn']
	return retryOn === undefined || (plain(retryOn) && exact(retryOn, ['network', 'timeout', 'rateLimit', 'serverError'])
		&& Object.values(retryOn).every(setting => typeof setting === 'boolean'))
}

function validPersistedResponse(value: unknown): value is AcceptedModelTurnCursorV1['response'] {
	if (!plain(value) || !exact(value, ['content', 'object', 'toolCalls', 'usage', 'finishReason', 'outcome'])
		|| (('content' in value) === ('object' in value)) || !Array.isArray(value['toolCalls']) || !value['toolCalls'].every(validCall)
		|| !validUsage(value['usage']) || !finishReasonSchema.safeParse(value['finishReason']).success
		|| (value['outcome'] !== undefined && !validOutcome(value['outcome']))) return false
	return typeof value['content'] === 'string' || isJsonValue(value['object'])
}

function validUsage(value: unknown): boolean {
	return plain(value) && exact(value, ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens'])
		&& tokenUsageSchema.safeParse(value).success
}

function validOutcome(value: unknown): boolean {
	if (!plain(value) || !exact(value, ['finishReason', 'providerFinishReason', 'providerStatus', 'retryable', 'retryKind', 'retryAfterMs', 'rateLimit', 'details'])
		|| !finishReasonSchema.safeParse(value['finishReason']).success
		|| (value['providerFinishReason'] !== undefined && typeof value['providerFinishReason'] !== 'string')
		|| (value['providerStatus'] !== undefined && typeof value['providerStatus'] !== 'string')
		|| (value['retryable'] !== undefined && typeof value['retryable'] !== 'boolean')
		|| (value['retryKind'] !== undefined && !['none', 'active', 'deferred'].includes(String(value['retryKind'])))
		|| (value['retryAfterMs'] !== undefined && (typeof value['retryAfterMs'] !== 'number' || !Number.isFinite(value['retryAfterMs'])))) return false
	if (value['rateLimit'] !== undefined) {
		const rate = value['rateLimit']
		if (!plain(rate) || !exact(rate, ['scope', 'limit', 'remaining', 'resetAt'])
			|| (rate['scope'] !== undefined && !['requests', 'input_tokens', 'output_tokens', 'tokens', 'unknown'].includes(String(rate['scope'])))
			|| (rate['limit'] !== undefined && (typeof rate['limit'] !== 'number' || !Number.isFinite(rate['limit'])))
			|| (rate['remaining'] !== undefined && (typeof rate['remaining'] !== 'number' || !Number.isFinite(rate['remaining'])))
			|| (rate['resetAt'] !== undefined && typeof rate['resetAt'] !== 'string')) return false
	}
	return value['details'] === undefined || (plain(value['details']) && isJsonValue(value['details']))
}

function validTool(value: unknown): boolean {
	return plain(value) && exact(value, ['name', 'description', 'parameters']) && validId(value['name'])
		&& typeof value['description'] === 'string' && isJsonValue(value['parameters'])
}

function validCall(value: unknown): boolean {
	return plain(value) && exact(value, ['id', 'name', 'arguments']) && validId(value['id']) && validId(value['name']) && isJsonValue(value['arguments'])
}

function validMessage(value: unknown): boolean {
	if (!plain(value) || typeof value['role'] !== 'string') return false
	if (value['role'] === 'system') return exact(value, ['role', 'content']) && typeof value['content'] === 'string'
	if (value['role'] === 'user') return exact(value, ['role', 'content']) && validContent(value['content'])
	if (value['role'] === 'tool') return exact(value, ['role', 'toolCallId', 'content']) && validId(value['toolCallId']) && typeof value['content'] === 'string'
	if (value['role'] !== 'assistant' || !exact(value, ['role', 'content', 'toolCalls'])) return false
	return validContent(value['content']) && (value['toolCalls'] === undefined || (Array.isArray(value['toolCalls']) && value['toolCalls'].every(validCall)))
}

function validContent(value: unknown): boolean {
	if (typeof value === 'string') return true
	return Array.isArray(value) && value.every(part => {
		if (!plain(part) || typeof part['kind'] !== 'string') return false
		if (part['kind'] === 'text') return exact(part, ['kind', 'text']) && typeof part['text'] === 'string'
		if (part['kind'] === 'image' || part['kind'] === 'audio') return exact(part, ['kind', 'mimeType', 'dataBase64']) && typeof part['mimeType'] === 'string' && typeof part['dataBase64'] === 'string'
		if (part['kind'] === 'image_url') return exact(part, ['kind', 'url', 'mimeType']) && typeof part['url'] === 'string' && (part['mimeType'] === undefined || typeof part['mimeType'] === 'string')
		if (part['kind'] === 'file') return exact(part, ['kind', 'mimeType', 'dataBase64', 'filename']) && typeof part['mimeType'] === 'string'
			&& typeof part['dataBase64'] === 'string' && (part['filename'] === undefined || typeof part['filename'] === 'string')
		if (part['kind'] === 'file_url') return exact(part, ['kind', 'url', 'mimeType', 'filename']) && typeof part['url'] === 'string'
			&& (part['mimeType'] === undefined || typeof part['mimeType'] === 'string') && (part['filename'] === undefined || typeof part['filename'] === 'string')
		return false
	})
}

function plain(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function exact(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key))
}

function validId(value: unknown): value is string {
	return typeof value === 'string' && Array.from(value).length > 0 && Array.from(value).length <= 200 && !/\p{Cc}/u.test(value)
}

function containsProviderContinuation(value: unknown, ancestors = new Set<object>()): boolean {
	if (value === null || typeof value !== 'object') return false
	if (ancestors.has(value)) return true
	ancestors.add(value)
	try {
		if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, 'providerContinuation')) return true
		return Object.values(value).some(child => containsProviderContinuation(child, ancestors))
	} finally { ancestors.delete(value) }
}

function deepFreezeJsonCopy(value: unknown): unknown {
	if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeJsonCopy))
	if (value !== null && typeof value === 'object') {
		const copy: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value)) copy[key] = deepFreezeJsonCopy(child)
		return Object.freeze(copy)
	}
	return value
}

function invalidCheckpoint(): never {
	throw new HarnessConfigError('Prepared tool checkpoint is invalid.', { reason: 'invalid_prepared_tool_checkpoint' })
}
