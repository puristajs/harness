import type { JsonValue } from '../models/json.js'
import type { DurableReplayCheckpoint } from '../ports/workspace.js'
import type { HarnessStorage } from '../storage/types.js'
import type { DurableRunLease, RunCheckpoint } from '../storage/execution.js'
import { abortError } from './abort.js'
import type { RunOutcome } from './outcomes.js'
import type { SuspendedAgentTurnStateV1 } from '../approvals/prepared-tool-checkpoint.js'
import { ToolApprovalPendingError, type ToolApprovalInterrupt } from '../approvals/index.js'
import type { HarnessExecutionCaller } from '../definitions/types.js'

const harnessChildTargetInterruptionBrand: unique symbol = Symbol('harness.child-target-interruption')
const harnessChildTargetInterruptionGroupBrand: unique symbol = Symbol('harness.child-target-interruption-group')
const harnessChildTargetInterruptionState: unique symbol = Symbol('harness.child-target-interruption-state')
export interface HarnessChildTargetInterruption {
	readonly [harnessChildTargetInterruptionBrand]: true
	readonly [harnessChildTargetInterruptionState]: { preparedState?: SuspendedAgentTurnStateV1; hostFrame?: SuspendedHostToolFrameV1 }
	readonly childInvocationId: string
	readonly resumeDescriptor: ChildApprovalResumeDescriptorV1
	readonly outcome: Extract<RunOutcome<never>, { readonly status: 'interrupted' }>
	readonly preparedState: SuspendedAgentTurnStateV1 | undefined
	readonly hostFrame: SuspendedHostToolFrameV1 | undefined
}

/** @internal One parent batch containing multiple independently resumable child leaves. */
export interface HarnessChildTargetInterruptionGroup {
	readonly [harnessChildTargetInterruptionGroupBrand]: true
	readonly interruptions: readonly HarnessChildTargetInterruption[]
	readonly interrupt: HarnessChildTargetInterruption['outcome']['interrupt']
}

/** @internal Control value propagated by either one interrupted child or a sibling group. */
export type HarnessChildTargetInterruptionControl = HarnessChildTargetInterruption | HarnessChildTargetInterruptionGroup

/** @internal Content-free data required to resume one exact interrupted child. */
export interface ChildApprovalResumeDescriptorV1 {
	readonly schemaVersion: 1
	readonly kind: 'child_approval_resume'
	readonly runId: string
	readonly interruptId: string
	readonly revision: string
	readonly approvalIds: readonly string[]
}

/** @internal Exact persisted parent frame for an interrupted host nested call. */
export interface SuspendedHostToolFrameV1 {
	readonly kind: 'host-tool'
	readonly runId: string
	readonly caller: HarnessExecutionCaller
	readonly invocationId: string
	readonly hostToolInvocationId: string
	readonly toolId: string
	readonly callId: string
	readonly input: JsonValue
	readonly bindingId: string
	readonly bindingContractDigest: string
	readonly toolStarted: true
	readonly activeNestedCall: Readonly<{
		readonly callId: string
		readonly target: Readonly<{ kind: 'agent' | 'workflow'; id: string }>
		readonly route: import('../ports/target-dispatcher.js').HarnessTargetRouteReceiptV1
		readonly input: JsonValue
		readonly childRunId: string
		readonly childInvocationId: string
		readonly childSessionId: string
		readonly childInterruptId: string
		readonly childInterruptRevision: string
	}>
}

/** @internal Creates the only trusted child-interruption control value. */
export function createHarnessChildTargetInterruption(
	childInvocationId: string,
	outcome: Extract<RunOutcome<never>, { readonly status: 'interrupted' }>,
): HarnessChildTargetInterruption {
	if (childInvocationId.length === 0) throw new TypeError('Child invocation id is required.')
	if (outcome.interrupt.type !== 'tool-approval') throw new TypeError('Child interruption is not approval-resumable.')
	const approvalIds = [...outcome.interrupt.requests.map(request => request.approvalId)].sort(codePointCompare)
	if (new Set(approvalIds).size !== approvalIds.length) throw new TypeError('Child approval interruption is invalid.')
	const resumeDescriptor = Object.freeze({ schemaVersion: 1 as const, kind: 'child_approval_resume' as const,
		runId: outcome.runId, interruptId: outcome.interrupt.id, revision: outcome.interrupt.revision,
		approvalIds: Object.freeze(approvalIds) })
	const state: { preparedState?: SuspendedAgentTurnStateV1; hostFrame?: SuspendedHostToolFrameV1 } = {}
	return Object.freeze({ [harnessChildTargetInterruptionBrand]: true as const, [harnessChildTargetInterruptionState]: state,
		childInvocationId, resumeDescriptor, outcome, get preparedState() { return state.preparedState }, get hostFrame() { return state.hostFrame } })
}

/** @internal Combines concurrently interrupted siblings without losing their individual resume descriptors. */
export function createHarnessChildTargetInterruptionGroup(
	interruptions: readonly HarnessChildTargetInterruption[],
): HarnessChildTargetInterruptionGroup {
	if (interruptions.length < 2) throw new TypeError('At least two child interruptions are required.')
	const childInvocationIds = interruptions.map(interruption => interruption.childInvocationId)
	if (new Set(childInvocationIds).size !== childInvocationIds.length) throw new TypeError('Child interruptions must be distinct.')
	const requests = interruptions.flatMap(interruption => {
		if (interruption.outcome.interrupt.type !== 'tool-approval') throw new TypeError('Child interruption is not approval-resumable.')
		return interruption.outcome.interrupt.requests
	})
	const approvalIds = requests.map(request => request.approvalId)
	if (new Set(approvalIds).size !== approvalIds.length) throw new TypeError('Child approval interruption ownership overlaps.')
	const interrupt = new ToolApprovalPendingError(requests, Object.freeze([])).interrupt
	return Object.freeze({ [harnessChildTargetInterruptionGroupBrand]: true as const,
		interruptions: Object.freeze([...interruptions]), interrupt })
}

/** @internal Attaches the host parent frame without changing the interruption identity. */
export function attachHarnessChildTargetHostFrame(
	interruption: HarnessChildTargetInterruption,
	frame: SuspendedHostToolFrameV1,
): HarnessChildTargetInterruption {
	interruption[harnessChildTargetInterruptionState].hostFrame = frame
	return interruption
}

/** @internal Attaches the parent frame without changing the branded control identity. */
export function attachHarnessChildTargetInterruptionState(
	interruption: HarnessChildTargetInterruptionControl,
	state: SuspendedAgentTurnStateV1,
): HarnessChildTargetInterruptionControl {
	for (const leaf of harnessChildTargetInterruptions(interruption)) {
		leaf[harnessChildTargetInterruptionState].preparedState = state
	}
	return interruption
}

/** @internal Recognizes child interruption by package-private brand only. */
export function isHarnessChildTargetInterruption(value: unknown): value is HarnessChildTargetInterruption {
	return typeof value === 'object' && value !== null
		&& (value as Partial<HarnessChildTargetInterruption>)[harnessChildTargetInterruptionBrand] === true
}

/** @internal Recognizes either form of child-interruption control. */
export function isHarnessChildTargetInterruptionControl(value: unknown): value is HarnessChildTargetInterruptionControl {
	return isHarnessChildTargetInterruption(value) || typeof value === 'object' && value !== null
		&& (value as Partial<HarnessChildTargetInterruptionGroup>)[harnessChildTargetInterruptionGroupBrand] === true
}

/** @internal Returns the ordered leaf controls owned by a child interruption. */
export function harnessChildTargetInterruptions(
	value: HarnessChildTargetInterruptionControl,
): readonly HarnessChildTargetInterruption[] {
	return isHarnessChildTargetInterruption(value) ? Object.freeze([value]) : value.interruptions
}

/** @internal Returns the public root interrupt represented by one or more child leaves. */
export function harnessChildTargetInterrupt(
	value: HarnessChildTargetInterruptionControl,
): ToolApprovalInterrupt {
	const interrupt = isHarnessChildTargetInterruption(value) ? value.outcome.interrupt : value.interrupt
	if (interrupt.type !== 'tool-approval') throw new TypeError('Child interruption is not approval-resumable.')
	return interrupt
}

function codePointCompare(left: string, right: string): number {
	const a = Array.from(left, char => char.codePointAt(0)!)
	const b = Array.from(right, char => char.codePointAt(0)!)
	for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index]! - b[index]!
	return a.length - b.length
}

/** Contract-only checkpoint function supplied by the durable execution owner. */
export interface HarnessCheckpointStep {
	<T extends JsonValue>(stepId: string, handler: () => Promise<T>, options?: DurableStepOptions): Promise<T>
}

/** @internal H4-008-provided access to namespaced workflow child-call checkpoints. */
export interface WorkflowChildCheckpointAccess {
	readonly rootInput: JsonValue
	load(stepId: string): Promise<RunCheckpoint | undefined>
	commit(stepId: string, output: JsonValue, metadata: Readonly<{ checkpointKind: 'workflow_call' | 'workflow_call_publication' | 'workflow_call_publication_ack' | 'host_nested_target'; schemaVersion: 1 }>): Promise<void>
}

/** @internal Persistable cumulative workflow agent-call budget owned by H4-008 continuation state. */
export interface WorkflowAgentCallBudgetStateV1 {
	readonly schemaVersion: 1
	readonly usedCalls: number
}

const STEP_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/

/** Metadata describing a new step checkpoint about to be committed. */
export interface DurableStepCommit {
  readonly stepId: string
  readonly sequence: number
  readonly attempt: number
  readonly output: JsonValue
}

/** Optional hooks for binding recoverable steps to a durable workspace. */
export interface DurableWorkflowContextOptions {
  /** Active workflow signal used to stop retry attempts and backoff promptly. */
  readonly signal?: AbortSignal
  /**
   * Invoked before each NEW step checkpoint is committed (never on replay). The
   * returned record is stored on the storage checkpoint's `replay` field so a
   * later resume can locate the durable workspace checkpoint. This enforces the
   * "workspace state first, storage checkpoint second" ordering.
   */
  readonly onStepCommit?: (commit: DurableStepCommit) => Promise<DurableReplayCheckpoint | undefined>
  /** Runs only after the corresponding storage checkpoint is durably committed. */
  readonly onStepCommitted?: (checkpoint: RunCheckpoint) => Promise<void>
	/** @internal Optional metadata projection for runtime-owned step namespaces. */
	readonly checkpointMetadata?: (stepId: string) => Readonly<Record<string, JsonValue>> | undefined
	/** @internal Shared run-scoped allocator when multiple checkpoint namespaces coexist. */
	readonly nextSequence?: () => number
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

/** Creates a durable workflow context bound to an acquired storage lease. */
export function createDurableWorkflowContext(
  storage: Pick<HarnessStorage, 'commitCheckpoint'>,
  lease: DurableRunLease,
  options: DurableWorkflowContextOptions = {},
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
    async step<T extends JsonValue>(
      stepId: string,
      fn: () => Promise<T>,
      stepOptions: DurableStepOptions = {},
    ): Promise<T> {
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

      const output = await runStepWithRetry(fn, stepOptions.retry, options.signal)
      assertJsonSerializable(output, stepId)
	  sequence = options.nextSequence?.() ?? sequence + 1
      // Workspace state is written before the storage checkpoint, and the
      // returned reference is linked on that checkpoint.
      const replayCheckpoint = options.onStepCommit
        ? await options.onStepCommit({ stepId, sequence, attempt: lease.attempt, output })
        : undefined
	  const metadata = options.checkpointMetadata?.(stepId)
      const checkpoint: RunCheckpoint = {
        runId: lease.runId,
        sessionId: lease.sessionId,
        leaseId: lease.leaseId,
        workerId: lease.workerId,
        stepId,
        input: lease.run.input,
        attempt: lease.attempt,
        sequence,
        output,
        ...(replayCheckpoint ? { replay: replayCheckpoint } : {}),
		...(metadata === undefined ? {} : { metadata }),
      }
      await storage.commitCheckpoint(checkpoint)
      await options.onStepCommitted?.(checkpoint)
      return output
    },
  }
}

export async function runStepWithRetry<T>(
  fn: () => Promise<T>,
  retry: DurableStepRetrySetting | undefined,
  signal?: AbortSignal,
): Promise<T> {
  const policy = normalizeRetryPolicy(retry)
  let attempt = 0
  let lastError: unknown

  while (attempt < policy.maxAttempts) {
    throwIfStepAborted(signal)
    attempt += 1
    try {
      return await fn()
    } catch (error) {
      lastError = error
      throwIfStepAborted(signal)
      if (attempt >= policy.maxAttempts) break
      if (policy.shouldRetry && !(await policy.shouldRetry(error, attempt))) break
      throwIfStepAborted(signal)
      await sleep(retryDelayMs(policy, attempt), signal)
    }
  }

  throw lastError
}

function normalizeRetryPolicy(
  retry: DurableStepRetrySetting | undefined,
): Required<Omit<DurableStepRetryPolicy, 'shouldRetry'>> & Pick<DurableStepRetryPolicy, 'shouldRetry'> {
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
    ...(retry.shouldRetry ? { shouldRetry: retry.shouldRetry } : {}),
  }
}

function clampPositiveInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1
}

function retryDelayMs(
  policy: Required<Omit<DurableStepRetryPolicy, 'shouldRetry'>> & Pick<DurableStepRetryPolicy, 'shouldRetry'>,
  attempt: number,
): number {
  if (policy.maxDelayMs === 0) return 0
  const base = policy.backoff === 'fixed' ? policy.minDelayMs : policy.minDelayMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(policy.maxDelayMs, base)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    throwIfStepAborted(signal)
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timeout) clearTimeout(timeout)
      reject(abortError(signal!, 'workflow', 'Workflow step retry was cancelled.'))
    }
    timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function throwIfStepAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal, 'workflow', 'Workflow step retry was cancelled.')
  }
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
