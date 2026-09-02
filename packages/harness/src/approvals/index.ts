import { createHash } from 'node:crypto'

import type { DecisionEvidence } from '../decisions/types.js'
import { HarnessError } from '../errors/harness-error.js'
import type { JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import type { ModelMessage, ProviderContinuation, ToolCallSpec } from '../ports/model-provider.js'

/** One model-requested tool call that requires a human decision. */
export interface ToolApprovalRequest {
  readonly approvalId: string
  readonly runId: string
  readonly agentId: string
  readonly workflowId?: string
  readonly invocationId: string
  readonly step: number
  readonly toolId: string
  readonly callId: string
  readonly input: JsonValue
  readonly demands: readonly DecisionEvidence[]
}

/** Durable public interruption returned when one tool batch needs approval. */
export interface ToolApprovalInterrupt {
  readonly type: 'tool-approval'
  readonly id: string
  readonly revision: string
  readonly requests: readonly ToolApprovalRequest[]
}

/** One authenticated decision supplied when resuming a tool-approval interrupt. */
export interface ToolApprovalDecision {
  readonly approvalId: string
  readonly approved: boolean
  readonly reason?: string
}

/** Consumer-owned resume envelope for an interrupted approval batch. */
export interface ToolApprovalResume {
  readonly type: 'tool-approval'
  readonly runId: string
  readonly interruptId: string
  readonly revision: string
  readonly eventId: string
  readonly decisions: readonly ToolApprovalDecision[]
}

/** Private serialized default-agent state needed to continue without another model call. */
export interface PendingAgentApprovalState {
  readonly input: JsonValue
  readonly step: number
  readonly modelAlias: string
  readonly modelMessages: readonly ModelMessage[]
  readonly emitted: readonly Message[]
  readonly toolCalls: readonly ToolCallSpec[]
  readonly providerContinuation?: ProviderContinuation
}

/** Private storage payload for one suspended default-agent run. */
export interface ToolApprovalCheckpoint {
  readonly schemaVersion: 1
  readonly interrupt: ToolApprovalInterrupt
  readonly state: PendingAgentApprovalState
}

/** Internal control-flow error used to stop before any tool in the batch runs. */
export class ToolApprovalPendingError extends HarnessError {
  public readonly interrupt: ToolApprovalInterrupt
  public state?: PendingAgentApprovalState

  public constructor(
    requests: readonly ToolApprovalRequest[],
    public readonly toolCalls: readonly ToolCallSpec[],
  ) {
    const sorted = [...requests].sort((left, right) => left.approvalId.localeCompare(right.approvalId))
    const first = sorted[0]
    if (!first) throw new TypeError('At least one approval request is required.')
    const id = `approval_batch_${createHash('sha256')
      .update(JSON.stringify([first.runId, first.invocationId, first.step, sorted.map(request => request.approvalId)]))
      .digest('hex')}`
    const revision = createHash('sha256')
      .update(
        JSON.stringify(
          sorted.map(request => [
            request.approvalId,
            request.toolId,
            request.callId,
            request.input,
            request.demands.map(demand => demand.decisionId),
          ]),
        ),
      )
      .digest('hex')
    super({
      code: 'TOOL_APPROVAL_PENDING',
      category: 'state',
      retriable: true,
      message: 'Tool execution is waiting for approval.',
      meta: { interruptId: id, revision, requestCount: sorted.length },
    })
    this.interrupt = Object.freeze({
      type: 'tool-approval',
      id,
      revision,
      requests: Object.freeze(sorted),
    })
  }

  /** Attach the provider-neutral agent continuation before the session persists the interrupt. */
  public attachState(state: PendingAgentApprovalState): this {
    this.state = Object.freeze(state)
    return this
  }
}
