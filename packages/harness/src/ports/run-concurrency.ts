import type { HarnessExecutionCaller, HarnessTargetKind } from '../definitions/types.js'
import type { HarnessIdentity } from '../identity/index.js'

/** One cancellation-aware request to admit a root execution tree. */
export interface RunConcurrencyRequest {
	readonly harnessName: string
	readonly sessionId: string
	readonly runId: string
	readonly rootRunId: string
	readonly target: Readonly<{ kind: HarnessTargetKind; id: string }>
	readonly caller: HarnessExecutionCaller
	readonly identity?: HarnessIdentity
	readonly parentRunId?: string
	readonly depth: number
	readonly deadline?: number
	readonly signal: AbortSignal
}

/** Capacity lease held for one root execution tree. */
export interface RunConcurrencyLease {
	release(): void | Promise<void>
}

/** Runtime port for root execution-tree concurrency. */
export interface RunConcurrency {
	acquire(request: RunConcurrencyRequest): Promise<RunConcurrencyLease>
}

export { inMemoryRunConcurrency } from '../runtime/run-concurrency.js'
export type { InMemoryRunConcurrencyOptions } from '../runtime/run-concurrency.js'
