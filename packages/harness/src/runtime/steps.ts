import type { JsonValue } from '../models/json.js'
import type { DurableReplayCheckpoint } from '../ports/workspace.js'
import type { DurableRunLease, DurableRuntime, RunCheckpoint } from './durable.js'

const STEP_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

/** Metadata describing a new step checkpoint about to be committed. */
export interface DurableStepCommit {
  readonly stepId: string
  readonly sequence: number
  readonly attempt: number
  readonly output: JsonValue
}

/** Optional hooks for binding durable steps to a durable workspace store. */
export interface DurableWorkflowContextOptions {
  /**
   * Invoked before each NEW step checkpoint is committed (never on replay). The
   * returned record is stored on the runtime checkpoint's `replay` field so a
   * later resume can locate the durable workspace checkpoint. This enforces the
   * "workspace state first, runtime checkpoint second" ordering (spec 21 §10).
   */
  readonly onStepCommit?: (commit: DurableStepCommit) => Promise<DurableReplayCheckpoint | undefined>
}

/** Retry policy for a single explicit workflow step. */
export type DurableStepRetrySetting = boolean | DurableStepRetryPolicy

/** Provider-neutral retry policy for `ctx.step(...)` boundaries. */
export interface DurableStepRetryPolicy {
  /** Total attempts including the first call. Default: `3`. */
  readonly maxAttempts?: number
  /** Base delay before retrying in milliseconds. Default: `100`. */
  readonly minDelayMs?: number
  /** Maximum delay before retrying in milliseconds. Default: `1_000`. */
  readonly maxDelayMs?: number
  /** Delay strategy. Default: `exponential`. */
  readonly backoff?: 'fixed' | 'exponential'
  /** Optional predicate to suppress retries for non-transient failures. */
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean | Promise<boolean>
}

/** Per-call options for an explicit workflow step. */
export interface DurableStepOptions {
  /** Retry failed step functions before a checkpoint is committed. Default: no retry. */
  readonly retry?: DurableStepRetrySetting
}

/** Durable workflow context that exposes explicit checkpoint boundaries. */
export interface DurableWorkflowContext {
  /** Current durable run lease. */
  readonly lease: DurableRunLease
  /**
   * Runs a JSON-serializable durable step and commits its output as a checkpoint.
   *
   * @example
   * ```ts
   * const prepared = await ctx.step('prepare-inputs', async () => ({ ok: true }))
   * ```
   */
  step<T extends JsonValue>(stepId: string, fn: () => Promise<T>, options?: DurableStepOptions): Promise<T>
}

/** Error thrown when a durable step id is invalid or duplicated. */
export class DurableStepError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'DurableStepError'
  }
}

/** Creates a durable workflow context bound to an acquired runtime lease. */
export function createDurableWorkflowContext(
  runtime: DurableRuntime,
  lease: DurableRunLease,
  options: DurableWorkflowContextOptions = {}
): DurableWorkflowContext {
  const completed = new Set<string>()
  // Committed step outputs from prior attempts, keyed by stepId. On resume,
  // these steps replay their stored output instead of re-running side effects.
  const replay = new Map<string, JsonValue | undefined>()
  for (const checkpoint of lease.checkpoints ?? []) {
    replay.set(checkpoint.stepId, checkpoint.output)
  }
  let sequence = (lease.checkpoints ?? []).reduce((max, checkpoint) => Math.max(max, checkpoint.sequence), 0)

  return {
    lease,
    async step<T extends JsonValue>(stepId: string, fn: () => Promise<T>, stepOptions: DurableStepOptions = {}): Promise<T> {
      validateStepId(stepId)
      if (completed.has(stepId)) {
        throw new DurableStepError(`Duplicate durable step id "${stepId}".`)
      }
      completed.add(stepId)

      // Durable replay: a step committed on a prior attempt returns its stored
      // output without re-executing `fn()` or re-committing a checkpoint.
      if (replay.has(stepId)) {
        return replay.get(stepId) as T
      }

      const output = await runStepWithRetry(fn, stepOptions.retry)
      assertJsonSerializable(output, stepId)
      sequence += 1
      // Workspace state is written before the runtime checkpoint (spec 21 §10),
      // and the returned reference is linked on the runtime checkpoint.
      const replayCheckpoint = options.onStepCommit
        ? await options.onStepCommit({ stepId, sequence, attempt: lease.attempt, output })
        : undefined
      const checkpoint: RunCheckpoint = {
        runId: lease.runId,
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        workerId: lease.workerId,
        stepId,
        input: lease.start.input,
        attempt: lease.attempt,
        sequence,
        output,
        ...(replayCheckpoint ? { replay: replayCheckpoint } : {})
      }
      await runtime.commitCheckpoint(checkpoint)
      return output
    }
  }
}

export async function runStepWithRetry<T>(fn: () => Promise<T>, retry: DurableStepRetrySetting | undefined): Promise<T> {
  const policy = normalizeRetryPolicy(retry)
  let attempt = 0
  let lastError: unknown

  while (attempt < policy.maxAttempts) {
    attempt += 1
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt >= policy.maxAttempts) break
      if (policy.shouldRetry && !await policy.shouldRetry(error, attempt)) break
      await sleep(retryDelayMs(policy, attempt))
    }
  }

  throw lastError
}

function normalizeRetryPolicy(retry: DurableStepRetrySetting | undefined): Required<Omit<DurableStepRetryPolicy, 'shouldRetry'>> & Pick<DurableStepRetryPolicy, 'shouldRetry'> {
  if (!retry) {
    return { maxAttempts: 1, minDelayMs: 0, maxDelayMs: 0, backoff: 'fixed' }
  }
  if (retry === true) {
    return { maxAttempts: 3, minDelayMs: 100, maxDelayMs: 1_000, backoff: 'exponential' }
  }
  return {
    maxAttempts: clampPositiveInteger(retry.maxAttempts ?? 3),
    minDelayMs: Math.max(0, retry.minDelayMs ?? 100),
    maxDelayMs: Math.max(0, retry.maxDelayMs ?? 1_000),
    backoff: retry.backoff ?? 'exponential',
    ...(retry.shouldRetry ? { shouldRetry: retry.shouldRetry } : {})
  }
}

function clampPositiveInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1
}

function retryDelayMs(policy: Required<Omit<DurableStepRetryPolicy, 'shouldRetry'>> & Pick<DurableStepRetryPolicy, 'shouldRetry'>, attempt: number): number {
  if (policy.maxDelayMs === 0) return 0
  const base = policy.backoff === 'fixed'
    ? policy.minDelayMs
    : policy.minDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(policy.maxDelayMs, base)
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validateStepId(stepId: string): void {
  if (!STEP_ID_PATTERN.test(stepId)) {
    throw new DurableStepError(`Invalid durable step id "${stepId}".`)
  }
}

function assertJsonSerializable(value: JsonValue, stepId: string): void {
  try {
    JSON.stringify(value)
  } catch (error) {
    throw new DurableStepError(`Durable step "${stepId}" returned a non-serializable value.`)
  }
}
