/** Package-private model-call metadata shared with the session accounting wrapper. */
export interface HarnessModelCallContext {
	readonly harnessName: string
	readonly sessionId: string
	readonly runId: string
	readonly agentId?: string
	readonly workflowId?: string
	readonly modelAlias: string
	readonly streamId?: string
	readonly emitRunEvents: false
}
