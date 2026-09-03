import type { JsonValue } from '../models/json.js'
import type { RunStatus } from '../models/state.js'
import type { DurableReplayCheckpoint } from '../ports/workspace.js'

/** Non-terminal run states that can be acquired again. */
export type DurableActiveRunStatus = 'running' | 'waiting' | 'interrupted'

/** Terminal run states that can never be resumed. */
export type DurableTerminalRunStatus = Exclude<RunStatus, DurableActiveRunStatus>

/** Complete durable run lifecycle. */
export type DurableRunStatus = DurableActiveRunStatus | DurableTerminalRunStatus

/** Stable identity and immutable input for a recoverable run attempt. */
export interface DurableRunStart {
  readonly runId: string
  readonly sessionId: string
  readonly workerId: string
  readonly stepId: string
  readonly input: JsonValue
  readonly attempt?: number
  readonly metadata?: Record<string, JsonValue>
}

/** Exclusive storage lease for one recoverable run. */
export interface DurableRunLease {
  readonly runId: string
  readonly sessionId: string
  readonly workerId: string
  readonly leaseId: string
  readonly attempt: number
  readonly resumed: boolean
  readonly start: DurableRunStart & { readonly attempt: number }
  readonly checkpoint?: RunCheckpoint
  readonly checkpoints?: readonly RunCheckpoint[]
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
