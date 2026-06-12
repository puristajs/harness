import type { Logger } from '../logger/index.js'
import type { JsonValue } from '../models/json.js'
import { serializeError } from '../errors/index.js'
import type { DurableWorkspaceStore, WorkspaceHandle } from '../ports/workspace.js'
import type { DurableRuntime } from './durable.js'
import { createDurableWorkflowContext, type DurableWorkflowContext } from './steps.js'

/** Run-id format accepted for durable invocations. */
export const DURABLE_RUN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/

/** Caller-supplied durable invocation options (mirror of `InvokeOptions.durable`). */
export interface DurableInvokeOptions {
  runId: string
  workerId?: string
  stepId?: string
  attempt?: number
}

/** Durable binding driving one workflow run's lease and workspace lifecycle. */
export interface DurableWorkflowBinding {
  readonly runId: string
  readonly attempt: number
  readonly resumed: boolean
  readonly step: DurableWorkflowContext['step']
  /** Marks the run successfully terminal and, when policy permits, cleans up the workspace. */
  finishSuccess(output: JsonValue): Promise<void>
  /** Marks the run cancelled-terminal and aborts the workspace (blocks resume). */
  finishCancelled(error: unknown): Promise<void>
  /**
   * Releases the lease without making the run terminal when it was not settled,
   * leaving a failed run resumable by a later retry with the same run id.
   */
  dispose(): Promise<void>
}

/** Narrows a configured runtime adapter to an executable durable runtime. */
export function isExecutableDurableRuntime(runtime: unknown): runtime is DurableRuntime {
  if (!runtime || typeof runtime !== 'object') return false
  const candidate = runtime as Partial<DurableRuntime>
  return typeof candidate.startRun === 'function'
    && typeof candidate.commitCheckpoint === 'function'
    && typeof candidate.finishRun === 'function'
    && typeof candidate.withSessionLock === 'function'
}

/**
 * Acquires a durable runtime lease for a workflow run and, when a workspace
 * store is configured, starts or resumes the durable workspace and links each
 * new step checkpoint to a workspace checkpoint (spec 21 §16.1).
 */
export async function beginDurableWorkflow(args: {
  runtime: DurableRuntime
  workspaceStore?: DurableWorkspaceStore
  durable: DurableInvokeOptions
  defaultWorkerId: string
  sessionId: string
  workflowId: string
  input: JsonValue
  signal: AbortSignal
  logger: Logger
  harnessName: string
}): Promise<DurableWorkflowBinding> {
  const { runtime, workspaceStore, durable, sessionId, workflowId, input, signal, logger, harnessName } = args
  const workerId = durable.workerId ?? args.defaultWorkerId

  const lease = await runtime.startRun({
    runId: durable.runId,
    sessionId,
    workerId,
    stepId: durable.stepId ?? workflowId,
    input,
    ...(durable.attempt !== undefined ? { attempt: durable.attempt } : {})
  })

  let handle: WorkspaceHandle | undefined
  if (workspaceStore) {
    try {
      const priorReplay = lease.checkpoint?.replay
      if (lease.resumed && priorReplay?.workspaceRef) {
        handle = await workspaceStore.resumeWorkspace({
          workspaceRef: priorReplay.workspaceRef,
          ...(priorReplay.checkpointRef ? { checkpointRef: priorReplay.checkpointRef } : {}),
          runId: lease.runId,
          sessionId,
          attempt: lease.attempt,
          idempotencyKey: `${lease.runId}:${lease.attempt}:resume`,
          signal
        })
      } else {
        handle = await workspaceStore.startWorkspace({
          runId: lease.runId,
          sessionId,
          workflowId,
          workerId,
          attempt: lease.attempt,
          idempotencyKey: `${lease.runId}:start`,
          signal
        })
      }
    } catch (workspaceError) {
      // The caller never receives the binding when the workspace phase fails,
      // so release the acquired lease here or it stays locked for the TTL.
      try {
        await lease.release()
      } catch (releaseError) {
        logger.warn('Failed to release durable lease after workspace failure.', {
          harness: harnessName,
          session_id: sessionId,
          run_id: lease.runId,
          workflow_id: workflowId,
          error: serializeError(releaseError)
        })
      }
      throw workspaceError
    }
  }

  const activeHandle = handle
  const onStepCommit = workspaceStore && activeHandle
    ? async (commit: { stepId: string; sequence: number; attempt: number; output: JsonValue }) => {
        const checkpoint = await workspaceStore.pauseWorkspace({
          handle: activeHandle,
          stepId: commit.stepId,
          sequence: commit.sequence,
          attempt: commit.attempt,
          reason: 'step_completed',
          idempotencyKey: `${lease.runId}:${commit.attempt}:pause:${commit.stepId}`,
          signal
        })
        return {
          runId: lease.runId,
          sessionId,
          workerId,
          leaseId: lease.leaseId,
          stepId: commit.stepId,
          sequence: commit.sequence,
          attempt: commit.attempt,
          checkpointRef: checkpoint.checkpointRef,
          workspaceRef: checkpoint.workspaceRef,
          ...(checkpoint.snapshotRef ? { snapshotRef: checkpoint.snapshotRef } : {}),
          schemaVersion: 1 as const,
          committedAt: checkpoint.committedAt,
          ...(checkpoint.expiresAt ? { expiresAt: checkpoint.expiresAt } : {})
        }
      }
    : undefined

  const ctx = createDurableWorkflowContext(runtime, lease, onStepCommit ? { onStepCommit } : {})
  const autoCleanup = workspaceStore?.info.policy.retention?.cleanupMode === 'adapter_automatic'
  let settled = false
  // Stores that bind run sandboxes to active workspaces (localDirectoryWorkspaceStore)
  // expose an unbind hook so the binding never outlives the durable run.
  const releaseRunBinding = (): void => {
    const candidate = workspaceStore as { releaseRunBinding?: (runId: string, sessionId: string) => void } | undefined
    candidate?.releaseRunBinding?.(lease.runId, sessionId)
  }

  return {
    runId: lease.runId,
    attempt: lease.attempt,
    resumed: lease.resumed,
    step: ctx.step,
    async finishSuccess(output: JsonValue): Promise<void> {
      await runtime.finishRun(lease.runId, { status: 'succeeded', output })
      settled = true
      if (workspaceStore && activeHandle && autoCleanup) {
        await workspaceStore.cleanupWorkspace({
          workspaceRef: activeHandle.workspaceRef,
          reason: 'terminal_success',
          idempotencyKey: `${lease.runId}:cleanup`
        })
      }
    },
    async finishCancelled(error: unknown): Promise<void> {
      await runtime.finishRun(lease.runId, { status: 'cancelled', error: serializeError(error) })
      settled = true
      if (workspaceStore && activeHandle) {
        await workspaceStore.abortWorkspace({
          workspaceRef: activeHandle.workspaceRef,
          runId: lease.runId,
          sessionId,
          reason: 'cancelled',
          idempotencyKey: `${lease.runId}:abort`
        })
      }
    },
    async dispose(): Promise<void> {
      releaseRunBinding()
      if (settled) return
      try {
        await lease.release()
      } catch (error) {
        logger.warn('Failed to release durable lease for retry.', {
          harness: harnessName,
          session_id: sessionId,
          run_id: lease.runId,
          workflow_id: workflowId,
          error: serializeError(error)
        })
      }
    }
  }
}
