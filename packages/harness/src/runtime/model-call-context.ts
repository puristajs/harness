import type { HarnessExecutionCaller } from '../definitions/types.js'

/** Package-private model-call metadata shared with the session accounting wrapper. */
export interface HarnessModelCallContext {
	readonly caller: HarnessExecutionCaller
	readonly harnessName: string
	readonly sessionId: string
	readonly runId: string
	readonly modelAlias: string
	readonly streamId?: string
}
