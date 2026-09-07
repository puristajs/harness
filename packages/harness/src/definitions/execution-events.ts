import type { DecisionEvidence } from '../decisions/types.js'
import type { ChildTaskContextPolicy, ChildTaskMode, HarnessExecutionCaller } from './types.js'
import type { GovernanceEffect, GovernanceExposureEffect } from '../governance/types.js'
import type { HarnessInterrupt, RunOutcome } from '../runtime/outcomes.js'
import type { JsonValue } from '../models/json.js'
import type { Message, SerializedError } from '../models/state.js'
import type { ArtifactReference } from '../ports/artifact-store.js'
import type { FinishReason, TokenUsage } from '../ports/model-provider.js'
import type { ExternalWaitOutcome } from '../storage/external-wait.js'

/** Ordered inventory of every event discriminator emitted by Harness v4. */
export const harnessExecutionEventTypesV1 = Object.freeze([
	'run.started', 'run.finished', 'agent.started', 'agent.finished', 'model.message', 'model.completed',
	'model.embedding.completed', 'model.rerank.completed', 'model.output.text.delta', 'model.output.object.snapshot', 'output.text.delta', 'output.object.snapshot',
	'output.file', 'output.progress', 'tool.input.available', 'tool.started', 'tool.finished',
	'policy.exposure', 'policy.evaluated', 'approval.requested', 'approval.responded',
	'external_wait.requested', 'external_wait.waiting', 'external_wait.resolved', 'fanout.started',
	'fanout.finished', 'child_task.started', 'child_task.settled', 'stream.overflow',
] as const)
/** Event discriminator accepted by the Harness v4 execution protocol. */
export type HarnessExecutionEventType = typeof harnessExecutionEventTypesV1[number]
/**
 * Identity and nesting fields shared by every execution event.
 *
 * @example
 * ```ts
 * const isRootEvent = (event: ExecutionEventCorrelation) => event.parentRunId === undefined
 * ```
 */
export type ExecutionEventCorrelation = Readonly<{
	readonly eventId: string
	readonly sequence: number
	readonly runId: string
	readonly parentRunId?: string
	readonly parentInvocationId?: string
}>
type ExecutionTerminalOutcome<Output, Interrupt> = RunOutcome<Output, Interrupt>
	| Readonly<{ status: 'failed'; runId: string; error: SerializedError }>
	| Readonly<{ status: 'cancelled'; runId: string; error: SerializedError }>

type ModelExecutionCorrelation =
	| Readonly<{ caller: Extract<HarnessExecutionCaller, { kind: 'agent' }>; callId?: string }>
	| Readonly<{ caller: Extract<HarnessExecutionCaller, { kind: 'workflow' }>; callId: string }>
type AgentModelExecutionCorrelation = Extract<ModelExecutionCorrelation, { caller: { kind: 'agent' } }>
type WorkflowModelExecutionCorrelation = Extract<ModelExecutionCorrelation, { caller: { kind: 'workflow' } }>

type EventBody<Output, Interrupt> =
	| Readonly<{ type: 'run.started'; at: string }>
	| Readonly<{ type: 'run.finished'; at: string; outcome: ExecutionTerminalOutcome<Output, Interrupt> }>
	| Readonly<{ type: 'agent.started'; agentId: string; at: string; workflowId?: string; parentAgentId?: string; delegationCallId?: string; delegationDepth?: number; modelAlias?: string }>
	| Readonly<{ type: 'agent.finished'; agentId: string; at: string; workflowId?: string; parentAgentId?: string; delegationCallId?: string; delegationDepth?: number; modelAlias?: string; output?: JsonValue; error?: SerializedError }>
	| Readonly<{ type: 'model.message'; caller: Extract<HarnessExecutionCaller, { kind: 'agent' }>; message: Message }>
	| (Readonly<{ type: 'model.completed'; modelAlias: string; streamId?: string; operation: 'text' | 'object' | 'textStream' | 'objectStream'; usage?: TokenUsage; finishReason?: FinishReason }> & ModelExecutionCorrelation)
	| (Readonly<{ type: 'model.embedding.completed'; modelAlias: string; count: number; dimensions?: number; usage?: TokenUsage }> & ModelExecutionCorrelation)
	| (Readonly<{ type: 'model.rerank.completed'; modelAlias: string; count: number; topN?: number; usage?: TokenUsage }> & ModelExecutionCorrelation)
	| (Readonly<{ type: 'model.output.text.delta'; id: string; modelAlias: string; delta: string }> & WorkflowModelExecutionCorrelation)
	| (Readonly<{ type: 'model.output.object.snapshot'; id: string; modelAlias: string; value: JsonValue }> & WorkflowModelExecutionCorrelation)
	| (Readonly<{ type: 'output.text.delta'; id: string; modelAlias?: string; delta: string }> & AgentModelExecutionCorrelation)
	| (Readonly<{ type: 'output.object.snapshot'; id: string; modelAlias?: string; value: JsonValue }> & AgentModelExecutionCorrelation)
	| (Readonly<{ type: 'output.file'; id: string; modelAlias: string; operation: 'image' | 'speech' | 'video'; artifact: ArtifactReference }> & ModelExecutionCorrelation)
	| (Readonly<{ type: 'output.progress'; id: string; modelAlias: string; operation: 'video'; state: 'queued' | 'running'; progress?: number }> & ModelExecutionCorrelation)
	| Readonly<{ type: 'tool.input.available'; caller: HarnessExecutionCaller; toolId: string; callId: string; input: JsonValue }>
	| Readonly<{ type: 'tool.started'; caller: HarnessExecutionCaller; toolId: string; callId: string; input: JsonValue }>
	| Readonly<{ type: 'tool.finished'; caller: HarnessExecutionCaller; toolId: string; callId: string; output?: JsonValue; error?: SerializedError }>
	| Readonly<{ type: 'policy.exposure'; agentId: string; invocationId: string; toolId: string; step: number; evidence: DecisionEvidence; effect: GovernanceExposureEffect; enforced: boolean }>
	| Readonly<{ type: 'policy.evaluated'; agentId: string; invocationId: string; toolId: string; callId: string; step: number; evidence: DecisionEvidence; effect: GovernanceEffect; enforced: boolean }>
	| Readonly<{ type: 'approval.requested'; agentId: string; invocationId: string; toolId: string; callId: string; step: number; approvalId: string; demands: readonly DecisionEvidence[] }>
	| Readonly<{ type: 'approval.responded'; agentId: string; invocationId: string; toolId: string; callId: string; step: number; approvalId: string; approved: boolean }>
	| Readonly<{ type: 'external_wait.requested'; at: string; waitId: string; kind: string; schemaVersion: string; definitionVersion: string; deadline: string }>
	| Readonly<{ type: 'external_wait.waiting'; at: string; waitId: string; kind: string; deadline: string }>
	| Readonly<{ type: 'external_wait.resolved'; at: string; waitId: string; kind: string; outcome: ExternalWaitOutcome; deadline: string }>
	| Readonly<{ type: 'fanout.started'; batchId: string; at: string; count: number; concurrency: number }>
	| Readonly<{ type: 'fanout.finished'; batchId: string; at: string; count: number; status: 'succeeded' | 'failed' | 'cancelled' }>
	| Readonly<{ type: 'child_task.started'; taskId: string; at: string; parentRunId: string; workflowId: string; agentId: string; modelAlias?: string; contextPolicy: ChildTaskContextPolicy; mode: ChildTaskMode }>
	| Readonly<{ type: 'child_task.settled'; taskId: string; at: string; parentRunId: string; workflowId: string; agentId: string; status: 'succeeded' | 'failed' | 'cancelled'; error?: SerializedError }>
	| Readonly<{ type: 'stream.overflow'; at: string; dropped: number }>

/**
 * One provider-neutral event emitted during a Harness target invocation.
 * Narrow on `type` before accessing the event-specific payload.
 *
 * @example
 * ```ts
 * for await (const event of stream) {
 *   if (event.type === 'output.text.delta') process.stdout.write(event.delta)
 * }
 * ```
 */
export type ExecutionEvent<Output = JsonValue, Interrupt = HarnessInterrupt> = ExecutionEventCorrelation & EventBody<Output, Interrupt>

/**
 * Ordered target execution events plus explicit execution cancellation.
 *
 * Returning from an iterator stops local observation only. Call {@link cancel}
 * when the target itself must be cancelled, such as when a transport client
 * disconnects.
 */
export interface HarnessTargetStream<Output> extends AsyncIterable<ExecutionEvent<Output>> {
	/** Request target cancellation and resolve once the request is accepted. */
	cancel(reason?: string): Promise<void>
}
export type AgentPipelineEventType = Extract<EventBody<JsonValue, HarnessInterrupt>['type'],
	'agent.started' | 'agent.finished' | 'model.message' | 'model.completed' | 'output.text.delta' | 'output.object.snapshot' |
	'tool.input.available' | 'tool.started' | 'tool.finished' | 'policy.exposure' | 'policy.evaluated' |
	'approval.requested' | 'approval.responded'>
export type AgentPipelineEvent = Extract<EventBody<JsonValue, HarnessInterrupt>, { readonly type: AgentPipelineEventType }>
export interface AgentEventSink { emit(event: AgentPipelineEvent): Promise<void> }
