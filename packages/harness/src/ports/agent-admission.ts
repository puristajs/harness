/** One cancellation-aware request to admit an agent execution tree. */
export interface AgentAdmissionRequest {
	readonly agentId: string
	readonly rootRunId: string
	readonly parentRunId?: string
	readonly depth: number
	readonly deadline?: number
	readonly signal: AbortSignal
}

/** Capacity lease held for one root agent execution tree. */
export interface AgentAdmissionLease {
	release(): void | Promise<void>
}

/** Runtime port for root and child agent concurrency admission. */
export interface AgentAdmission {
	acquire(request: AgentAdmissionRequest): Promise<AgentAdmissionLease>
}

export { inMemoryAgentAdmission } from '../runtime/agent-admission.js'
export type { InMemoryAgentAdmissionOptions } from '../runtime/agent-admission.js'
