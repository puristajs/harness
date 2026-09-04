import type { ProviderContinuation, ToolCallSpec, ModelMessage } from '../ports/model-provider.js'
import type { JsonValue } from '../models/json.js'
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
