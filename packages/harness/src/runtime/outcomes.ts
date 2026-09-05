import type { ToolApprovalInterrupt } from '../approvals/index.js'

/** Durable, authenticated pause that can be resumed without treating it as a failure. */
export type HarnessInterrupt =
	| Readonly<{ type: 'external-wait'; id: string; revision: string; kind: string; schemaVersion: string; definitionVersion: string; deadline: string }>
	| ToolApprovalInterrupt

/** Public result shared by aggregate and streaming target execution. */
export type RunOutcome<Output, Interrupt = HarnessInterrupt> =
	| Readonly<{ status: 'completed'; runId: string; output: Output }>
	| Readonly<{ status: 'interrupted'; runId: string; interrupt: Interrupt }>
