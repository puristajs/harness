import type { JsonValue } from '../models/json.js'
import type { ExecutionEvent } from '../definitions/execution-events.js'
import type { HarnessExecutionCaller } from '../definitions/types.js'
import type { RunRecord, RunStatus } from '../models/state.js'
import type { DurableReplayCheckpoint } from '../ports/workspace.js'
import type { RunAcquisitionExpectation } from './types.js'

type WorkflowManagedEvent = ExecutionEvent extends infer Event
	? Event extends ExecutionEvent ? Omit<Event, 'eventId' | 'sequence'> : never
	: never

/** Non-terminal run states that can be acquired again. */
export type DurableActiveRunStatus = 'running' | 'waiting' | 'interrupted'

/** Terminal run states that can never be resumed. */
export type DurableTerminalRunStatus = Exclude<RunStatus, DurableActiveRunStatus>

/** Complete durable run lifecycle. */
export type DurableRunStatus = DurableActiveRunStatus | DurableTerminalRunStatus

/** Exclusive storage lease for one recoverable run. */
export interface DurableRunLease {
  readonly runId: string
  readonly sessionId: string
  readonly workerId: string
  readonly acquisitionId: string
  readonly leaseId: string
  readonly attempt: number
  readonly resumed: boolean
  readonly acquiredFrom: RunAcquisitionExpectation
  readonly run: RunRecord
  readonly checkpoint?: RunCheckpoint
  readonly checkpoints: readonly RunCheckpoint[]
  release(): Promise<void>
}

/** Atomic step boundary persisted by Harness storage. */
export interface RunCheckpoint {
  readonly runId: string
  readonly sessionId: string
  readonly leaseId: string
  readonly workerId: string
  readonly stepId: string
  readonly input: JsonValue
  readonly attempt: number
  readonly sequence: number
  readonly output?: JsonValue
  readonly replay?: DurableReplayCheckpoint
  readonly metadata?: Record<string, JsonValue>
  readonly committedAt?: string
}

/** Operations supported by the replay-safe direct workflow-call boundary. */
export type WorkflowManagedCallOperation =
	| 'agent_run'
	| 'tool_run'
	| 'model_text'
	| 'model_text_stream'
	| 'model_object'
	| 'model_object_stream'
	| 'model_embed'
	| 'model_rerank'
	| 'model_image'
	| 'model_speech'
	| 'model_video'
	| 'model_video_stream'

/** Content-free error persisted for one failed or cancelled managed workflow call. */
export type WorkflowCallStoredErrorV1 =
	| Readonly<{
		code: 'WORKFLOW_MANAGED_CALL_FAILED'; message: 'Workflow managed call failed.'; category: 'internal'; retriable: false
		meta: Readonly<{ reason: 'operation_failed'; workflow_id: string; call_id: string; operation: WorkflowManagedCallOperation; target_kind: 'agent' | 'tool' | 'model'; target_id: string }>
	}>
	| Readonly<{
		code: 'OPERATION_CANCELLED'; message: 'Workflow managed call was cancelled.'; category: 'cancelled'; retriable: false
		meta: Readonly<{ scope: 'agent' | 'tool' | 'model' }>
	}>

/** Exact stored terminal for one replay-safe direct workflow call. */
export type WorkflowCallStoredOutcomeV1 =
  | Readonly<{ status: 'completed'; output: JsonValue }>
  | Readonly<{ status: 'failed'; error: Extract<WorkflowCallStoredErrorV1, { code: 'WORKFLOW_MANAGED_CALL_FAILED' }> }>
  | Readonly<{ status: 'cancelled'; error: Extract<WorkflowCallStoredErrorV1, { code: 'OPERATION_CANCELLED' }> }>

/** Namespaced replay value stored in RunCheckpoint.output. */
export interface WorkflowCallCheckpointV1 {
  readonly schemaVersion: 1
  readonly kind: 'workflow_call'
  readonly callId: string
	readonly operation: WorkflowManagedCallOperation
  readonly target: Readonly<{ kind: 'agent' | 'tool' | 'model'; id: string }>
  readonly input: JsonValue
	readonly outcome: WorkflowCallStoredOutcomeV1
	readonly caller: HarnessExecutionCaller
	readonly correlation: Readonly<{ runId: string; rootRunId: string; workflowInvocationId: string; parentRunId?: string; parentInvocationId?: string }>
	/** Ordered managed events whose durable publication is tracked independently from the terminal effect. */
	readonly publication: Readonly<{ events: readonly WorkflowManagedEvent[] }>
  readonly lineage?: Readonly<{
    rootRunId: string
    workflowRunId: string
    workflowInvocationId: string
    childRunId: string
    childInvocationId: string
  }>
}

/** Durable acknowledgement for one published event in a managed workflow call outbox. */
export interface WorkflowCallPublicationCheckpointV1 {
	readonly schemaVersion: 1
	readonly kind: 'workflow_call_publication'
	readonly callId: string
	readonly operation: WorkflowManagedCallOperation
	readonly target: Readonly<{ kind: 'agent' | 'tool' | 'model'; id: string }>
	readonly eventIndex: number
	readonly eventDigest: string
	readonly allocation: Readonly<{ event: ExecutionEvent; persistedAt: string }>
}

/** Durable acknowledgement that one pre-allocated managed event was appended. */
export interface WorkflowCallPublicationAckCheckpointV1 {
	readonly schemaVersion: 1
	readonly kind: 'workflow_call_publication_ack'
	readonly callId: string
	readonly operation: WorkflowManagedCallOperation
	readonly target: Readonly<{ kind: 'agent' | 'tool' | 'model'; id: string }>
	readonly caller: HarnessExecutionCaller
	readonly correlation: WorkflowCallCheckpointV1['correlation']
	readonly eventIndex: number
	readonly eventId: string
	readonly eventDigest: string
}

/** Exact stored terminal for one host-owned nested target call. */
export type HostNestedTargetStoredOutcomeV1 =
	| Readonly<{ status: 'completed'; output: JsonValue }>
	| Readonly<{ status: 'failed'; error: import('../errors/catalog.js').HostNestedTargetStoredErrorV1 }>
	| Readonly<{ status: 'cancelled'; error: Readonly<{
		code: 'OPERATION_CANCELLED'; message: 'Host nested target call was cancelled.'; category: 'cancelled'; retriable: false
		meta: Readonly<{ scope: 'agent' | 'workflow' }>
	}> }>

/** Namespaced host nested-call replay value stored in RunCheckpoint.output. */
export interface HostNestedTargetCheckpointV1 {
	readonly schemaVersion: 1
	readonly kind: 'host_nested_target'
	readonly toolCallId: string
	readonly callId: string
	readonly target: Readonly<{ kind: 'agent' | 'workflow'; id: string }>
	readonly route: import('../ports/target-dispatcher.js').HarnessTargetRouteReceiptV1
	readonly input: JsonValue
	readonly outcome: HostNestedTargetStoredOutcomeV1
	readonly lineage: Readonly<{
		rootRunId: string; callerRunId: string; hostToolInvocationId: string; childRunId: string; childInvocationId: string
	}>
}

/** Raised when code attempts to resume a terminal run. */
export class DurableTerminalRunError extends Error {
  public constructor(runId: string, status: DurableTerminalRunStatus) {
    super(`Durable run "${runId}" is terminal (${status}) and cannot be resumed.`)
    this.name = 'DurableTerminalRunError'
  }
}

/** Raised when a run or session already has an active owner. */
export class DurableRunLeaseError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'DurableRunLeaseError'
  }
}

export function isTerminalRunStatus(status: DurableRunStatus): status is DurableTerminalRunStatus {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

export function isResumeBlockingRunStatus(status: DurableRunStatus): boolean {
  return isTerminalRunStatus(status)
}

/** Small FIFO mutex shared by local storage implementations. */
export class AsyncMutex {
  private current = Promise.resolve()

  public async lock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.current
    let release: (() => void) | undefined
    this.current = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await fn()
    } finally {
      release?.()
    }
  }
}
