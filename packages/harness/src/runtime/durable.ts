import type { AdapterCapability } from '../ports/capabilities.js'
import type { JsonValue } from '../models/json.js'
import type { RunStatus, SerializedError } from '../models/state.js'
import type { DurableReplayCheckpoint } from '../ports/workspace.js'

/** Non-terminal run status used while durable work can still be resumed. */
export type DurableActiveRunStatus = 'running'

/** Terminal run statuses that must never be resumed by a durable runtime. */
export type DurableTerminalRunStatus = Exclude<RunStatus, DurableActiveRunStatus>

/** Durable run lifecycle status. */
export type DurableRunStatus = DurableActiveRunStatus | DurableTerminalRunStatus

/** Input metadata required to create or retry a durable run. */
export interface DurableRunStart {
  /** Stable run id. Retries of the same logical run must reuse this value. */
  readonly runId: string
  /** Stable session id owned by the run while it mutates session state. */
  readonly sessionId: string
  /** Worker/process id requesting ownership of the run. */
  readonly workerId: string
  /** Initial durable step id. Retried metadata preserves this value. */
  readonly stepId: string
  /** Original run input. Retried metadata preserves this value. */
  readonly input: JsonValue
  /** Optional caller-supplied attempt. The runtime may increase it on retry. */
  readonly attempt?: number
  /** Adapter-neutral metadata persisted with the durable run. */
  readonly metadata?: Record<string, JsonValue>
}

/** Exclusive ownership token returned by a durable runtime. */
export interface DurableRunLease {
  /** Stable run id owned by this lease. */
  readonly runId: string
  /** Stable session id owned by this lease. */
  readonly sessionId: string
  /** Worker/process id that owns this lease. */
  readonly workerId: string
  /** Runtime-issued lease id. */
  readonly leaseId: string
  /** Current attempt number for this run. */
  readonly attempt: number
  /** True when the run has a committed checkpoint to resume from. */
  readonly resumed: boolean
  /** Metadata from the original run start record with runtime attempt applied. */
  readonly start: DurableRunStart & { readonly attempt: number }
  /** Last committed checkpoint, if any. */
  readonly checkpoint?: RunCheckpoint
  /** Releases this in-memory lease without making the run terminal. */
  release(): Promise<void>
}

/** Stable checkpoint boundary committed by a durable runtime. */
export interface RunCheckpoint {
  /** Stable run id. */
  readonly runId: string
  /** Stable session id. */
  readonly sessionId: string
  /** Runtime-issued lease id that owns this checkpoint write. */
  readonly leaseId: string
  /** Worker/process id that owns this checkpoint write. */
  readonly workerId: string
  /** Stable step id for the committed boundary. */
  readonly stepId: string
  /** Original run input associated with this retry chain. */
  readonly input: JsonValue
  /** Attempt that produced this checkpoint. */
  readonly attempt: number
  /** Monotonic checkpoint sequence for the run. */
  readonly sequence: number
  /** JSON-serializable checkpoint payload. */
  readonly output?: JsonValue
  /** Optional durable workspace replay checkpoint linked to this runtime checkpoint. */
  readonly replay?: DurableReplayCheckpoint
  /** Adapter-neutral checkpoint metadata. */
  readonly metadata?: Record<string, JsonValue>
  /** ISO timestamp for the commit. */
  readonly committedAt?: string
}

/** Patch used to make a durable run terminal. */
export interface FinishRunPatch {
  /** Terminal run status. */
  readonly status: DurableTerminalRunStatus
  /** Optional terminal output. */
  readonly output?: JsonValue
  /** Optional terminal error. */
  readonly error?: SerializedError
  /** ISO timestamp for terminal completion. */
  readonly finishedAt?: string
}

/** Optional failure injection settings for the in-memory durable runtime. */
export interface InMemoryDurableRuntimeOptions {
  /**
   * Throws after committing the Nth checkpoint. The checkpoint remains stored,
   * which lets tests prove resume starts from the last consistent boundary.
   */
  readonly failAfterCheckpoint?: number
}

/** Durable runtime adapter contract for checkpointed execution. */
export interface DurableRuntime {
  /** Adapter capabilities supported by this runtime. */
  readonly capabilities: readonly AdapterCapability[]
  /** Starts or retries a run and returns an exclusive lease. */
  startRun(record: DurableRunStart): Promise<DurableRunLease>
  /** Loads the last committed checkpoint for a run. */
  loadCheckpoint(runId: string): Promise<RunCheckpoint | undefined>
  /** Commits a stable checkpoint boundary. */
  commitCheckpoint(checkpoint: RunCheckpoint): Promise<void>
  /** Marks a run terminal and releases any owned lease. */
  finishRun(runId: string, patch: FinishRunPatch): Promise<void>
  /** Executes a callback while holding an exclusive session lock. */
  withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T>
}

/** Error thrown when a terminal durable run is started again. */
export class DurableTerminalRunError extends Error {
  public constructor(runId: string, status: DurableTerminalRunStatus) {
    super(`Durable run "${runId}" is terminal (${status}) and cannot be resumed.`)
    this.name = 'DurableTerminalRunError'
  }
}

/** Error thrown when a durable run/session is already owned by another worker. */
export class DurableRunLeaseError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'DurableRunLeaseError'
  }
}

/** Returns true when a durable run status is terminal. */
export function isTerminalRunStatus(status: DurableRunStatus): status is DurableTerminalRunStatus {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

interface RunState {
  readonly start: DurableRunStart
  status: DurableRunStatus
  attempt: number
  checkpoint?: RunCheckpoint
  finished?: FinishRunPatch
}

interface LeaseState {
  readonly leaseId: string
  readonly runId: string
  readonly sessionId: string
  readonly workerId: string
}

class AsyncMutex {
  private current = Promise.resolve()

  public async lock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.current
    let release: (() => void) | undefined
    this.current = new Promise<void>((resolve) => {
      release = resolve
    })
    await prev
    try {
      return await fn()
    } finally {
      release?.()
    }
  }
}

class InMemoryDurableRuntime implements DurableRuntime {
  public readonly capabilities = [
    'runtime.checkpoint',
    'runtime.retry',
    'runtime.distributed_lock',
    'runtime.resume_from_checkpoint',
    'runtime.workspace_checkpoint'
  ] as const satisfies readonly AdapterCapability[]

  private readonly runs = new Map<string, RunState>()
  private readonly runLeases = new Map<string, LeaseState>()
  private readonly sessionLeases = new Map<string, LeaseState>()
  private readonly sessionLocks = new Map<string, AsyncMutex>()
  private leaseCounter = 0
  private checkpointCommitCount = 0

  public constructor(private readonly options: InMemoryDurableRuntimeOptions = {}) {}

  public async startRun(record: DurableRunStart): Promise<DurableRunLease> {
    return this.withSessionLock(record.sessionId, async () => {
      const current = this.runs.get(record.runId)
      if (current && isTerminalRunStatus(current.status)) {
        throw new DurableTerminalRunError(record.runId, current.status)
      }

      this.assertNoConflictingLease(record)

      const state = current ?? {
        start: record,
        status: 'running',
        attempt: Math.max(1, record.attempt ?? 1)
      } satisfies RunState

      if (current) {
        state.attempt += 1
      }

      this.runs.set(record.runId, state)

      const lease: LeaseState = {
        leaseId: `lease-${++this.leaseCounter}`,
        runId: record.runId,
        sessionId: record.sessionId,
        workerId: record.workerId
      }
      this.runLeases.set(record.runId, lease)
      this.sessionLeases.set(record.sessionId, lease)

      return this.toLease(state, lease)
    })
  }

  public async loadCheckpoint(runId: string): Promise<RunCheckpoint | undefined> {
    return this.runs.get(runId)?.checkpoint
  }

  public async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    await this.withSessionLock(checkpoint.sessionId, async () => {
      const lease = this.runLeases.get(checkpoint.runId)
      if (!lease || lease.leaseId !== checkpoint.leaseId || lease.workerId !== checkpoint.workerId) {
        throw new DurableRunLeaseError(`Durable run "${checkpoint.runId}" is not owned by this lease.`)
      }

      const state = this.runs.get(checkpoint.runId)
      if (!state) {
        throw new DurableRunLeaseError(`Durable run "${checkpoint.runId}" has not been started.`)
      }

      if (isTerminalRunStatus(state.status)) {
        throw new DurableTerminalRunError(checkpoint.runId, state.status)
      }

      const committedAt = checkpoint.committedAt ?? new Date().toISOString()
      state.checkpoint = { ...checkpoint, committedAt }
      this.checkpointCommitCount += 1

      if (this.options.failAfterCheckpoint === this.checkpointCommitCount) {
        this.releaseLease(lease)
        throw new Error(`Injected durable runtime failure after checkpoint ${this.checkpointCommitCount}.`)
      }
    })
  }

  public async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    const state = this.runs.get(runId)
    if (!state) return

    state.status = patch.status
    state.finished = {
      ...patch,
      finishedAt: patch.finishedAt ?? new Date().toISOString()
    }

    const lease = this.runLeases.get(runId)
    if (lease) {
      this.releaseLease(lease)
    }
  }

  public async withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    let lock = this.sessionLocks.get(sessionId)
    if (!lock) {
      lock = new AsyncMutex()
      this.sessionLocks.set(sessionId, lock)
    }

    return lock.lock(fn)
  }

  private assertNoConflictingLease(record: DurableRunStart): void {
    const runLease = this.runLeases.get(record.runId)
    if (runLease && runLease.workerId !== record.workerId) {
      throw new DurableRunLeaseError(`Durable run "${record.runId}" is already owned by worker "${runLease.workerId}".`)
    }

    const sessionLease = this.sessionLeases.get(record.sessionId)
    if (sessionLease && (sessionLease.runId !== record.runId || sessionLease.workerId !== record.workerId)) {
      throw new DurableRunLeaseError(
        `Durable session "${record.sessionId}" is already owned by run "${sessionLease.runId}".`
      )
    }
  }

  private toLease(state: RunState, lease: LeaseState): DurableRunLease {
    return {
      runId: lease.runId,
      sessionId: lease.sessionId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      attempt: state.attempt,
      resumed: Boolean(state.checkpoint),
      start: {
        ...state.start,
        attempt: state.attempt
      },
      ...(state.checkpoint ? { checkpoint: state.checkpoint } : {}),
      release: async () => {
        await this.withSessionLock(lease.sessionId, async () => {
          this.releaseLease(lease)
        })
      }
    }
  }

  private releaseLease(lease: LeaseState): void {
    const activeRunLease = this.runLeases.get(lease.runId)
    if (activeRunLease?.leaseId === lease.leaseId) {
      this.runLeases.delete(lease.runId)
    }

    const activeSessionLease = this.sessionLeases.get(lease.sessionId)
    if (activeSessionLease?.leaseId === lease.leaseId) {
      this.sessionLeases.delete(lease.sessionId)
    }
  }
}

/**
 * Creates a self-contained in-memory durable runtime for tests and prototypes.
 *
 * @example
 * ```ts
 * const runtime = inMemoryDurableRuntime({ failAfterCheckpoint: 1 })
 * const lease = await runtime.startRun({
 *   runId: 'run-1',
 *   sessionId: 'session-1',
 *   workerId: 'worker-1',
 *   stepId: 'draft',
 *   input: { topic: 'durability' }
 * })
 * ```
 */
export function inMemoryDurableRuntime(options?: InMemoryDurableRuntimeOptions): DurableRuntime {
  return new InMemoryDurableRuntime(options)
}
