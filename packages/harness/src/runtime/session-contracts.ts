import type { ChildTaskHandle, ChildTaskStatus } from '../definitions/types.js'
import type { JsonValue } from '../models/json.js'
import type { Message, RunStatus, SerializedError } from '../models/state.js'
import type { TokenUsage } from '../ports/model-provider.js'

/** Conversation history accessor for one session thread. */
export interface ConversationHistory {
	list(options?: Readonly<{ limit?: number; before?: string }>): Promise<Message[]>
}

/** Content-safe task lookup surface owned by a session. */
export interface SessionChildTasks {
	get(id: string): Promise<ChildTaskHandle<JsonValue> | undefined>
	list(options?: Readonly<{ limit?: number; before?: string }>): Promise<readonly ChildTaskStatus[]>
}

/** Content-free aggregate for one persisted run. */
export interface RunSummary {
	readonly runId: string
	readonly sessionId: string
	readonly status: RunStatus
	readonly startedAt: string
	readonly finishedAt?: string
	readonly tokenTotals: TokenUsage
	readonly modelCalls: number
	readonly toolCalls: number
	readonly agentCalls: number
	readonly error?: SerializedError
}
