import type { Logger } from '../logger/index.js'
import type { JsonValue } from '../models/json.js'
import { SandboxConflictError, SandboxStateLostError, serializeError } from '../errors/index.js'
import type { DurableWorkspacePolicy, DurableWorkspace, WorkspaceHandle } from '../ports/workspace.js'
import type { HarnessStorage } from '../storage/types.js'
import { createDurableWorkflowContext, type DurableWorkflowContext } from './steps.js'
import { telemetryErrorType } from '../telemetry/index.js'
import type { SandboxOwner, SandboxPartition } from '../sandbox/ownership.js'

/** Run-id format accepted for durable invocations. */
export const DURABLE_RUN_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/

/** Caller-supplied durable invocation options (mirror of `InvokeOptions.durable`). */
export interface DurableInvokeOptions {
  runId: string
  workerId?: string
  stepId?: string
  attempt?: number
  workspacePolicy?: Partial<DurableWorkspacePolicy>
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

/**
 * Acquires a Harness storage lease for a workflow run and, when a durable
 * workspace is configured, starts or resumes it and links each
 * new step checkpoint to a workspace checkpoint (spec 21 §16.1).
 */
export async function beginDurableWorkflow(args: {
  storage: HarnessStorage
  workspace?: DurableWorkspace
  durable: DurableInvokeOptions
  defaultWorkerId: string
  sessionId: string
  workflowId: string
  input: JsonValue
  signal: AbortSignal
  logger: Logger
  harnessName: string
  sandbox: { owner: SandboxOwner; partition: SandboxPartition; policyDigest: string; partitions?: () => readonly SandboxPartition[] }
  /** Rejects a checkpoint before workspace state is copied when caller work is still mutating its partitions. */
  beforeStepCheckpoint?: () => Promise<void> | void
}): Promise<DurableWorkflowBinding> {
  const { storage, workspace, durable, sessionId, workflowId, input, signal, logger, harnessName, sandbox, beforeStepCheckpoint } = args
  const workerId = durable.workerId ?? args.defaultWorkerId

  const lease = await storage.acquireRun({
    runId: durable.runId,
    sessionId,
    workerId,
    stepId: durable.stepId ?? workflowId,
    input,
    ...(durable.attempt !== undefined ? { attempt: durable.attempt } : {})
  })

  let handle: WorkspaceHandle | undefined
  if (workspace) {
    try {
      const priorReplay = lease.checkpoint?.replay
      if (lease.resumed && (!priorReplay?.workspaceRef || !priorReplay.checkpointRef)) {
        throw new SandboxStateLostError('A committed workspace checkpoint is required to recover this run.', {
          reason: 'durable_workspace_recovery_unavailable', lifetime: 'run'
        })
      }
      if (lease.resumed && priorReplay?.workspaceRef && priorReplay.checkpointRef) {
        if (priorReplay.sandboxPolicyDigest !== sandbox.policyDigest) {
          throw new SandboxConflictError('policy_changed')
        }
        handle = await workspace.resumeWorkspace({
          workspaceRef: priorReplay.workspaceRef,
          checkpointRef: priorReplay.checkpointRef,
          runId: lease.runId,
          sessionId,
          attempt: lease.attempt,
          idempotencyKey: `${lease.runId}:${lease.attempt}:resume`,
          signal
        })
      } else {
        handle = await workspace.startWorkspace({
          runId: lease.runId,
          sessionId,
          workflowId,
          workerId,
          attempt: lease.attempt,
          idempotencyKey: `${lease.runId}:start`,
          sandboxOwner: sandbox.owner,
          sandboxPolicyDigest: sandbox.policyDigest,
          ...(durable.workspacePolicy ? { policy: durable.workspacePolicy } : {}),
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
  const priorReplayForWorkspace = lease.checkpoint?.replay
  let priorPinnedCheckpointRef: string | undefined
  if (priorReplayForWorkspace && priorReplayForWorkspace.workspaceRef === activeHandle?.workspaceRef) {
    priorPinnedCheckpointRef = priorReplayForWorkspace.checkpointRef
  }
  const onStepCommit = workspace && activeHandle
    ? async (commit: { stepId: string; sequence: number; attempt: number; output: JsonValue }) => {
        await beforeStepCheckpoint?.()
        const checkpoint = await workspace.pauseWorkspace({
          handle: activeHandle,
          sandboxPartitions: [...(sandbox.partitions?.() ?? [sandbox.partition])],
          stepId: commit.stepId,
          sequence: commit.sequence,
          attempt: commit.attempt,
          checkpointPayload: commit.output,
          reason: 'step_completed',
          idempotencyKey: `${lease.runId}:${commit.attempt}:pause:${commit.stepId}`,
          signal
        })
        await workspace.pinCheckpoint({
          workspaceRef: checkpoint.workspaceRef,
          checkpointRef: checkpoint.checkpointRef,
          runId: lease.runId,
          idempotencyKey: `${lease.runId}:${commit.attempt}:pin:${checkpoint.checkpointRef}`,
          signal
        })
        return {
          runId: lease.runId,
          sessionId,
          sandboxPolicyDigest: checkpoint.sandboxPolicyDigest,
          sandboxPartitions: checkpoint.sandboxPartitions,
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

  const onStepCommitted = workspace && activeHandle
    ? async (checkpoint: { replay?: import('../ports/workspace.js').DurableReplayCheckpoint }): Promise<void> => {
        const current = checkpoint.replay
        if (!current?.workspaceRef || !current.checkpointRef) return
        if (priorPinnedCheckpointRef && priorPinnedCheckpointRef !== current.checkpointRef) {
          await workspace.releaseCheckpoint({
            workspaceRef: activeHandle.workspaceRef,
            checkpointRef: priorPinnedCheckpointRef,
            runId: lease.runId,
            idempotencyKey: `${lease.runId}:${lease.attempt}:release:${priorPinnedCheckpointRef}`,
            signal
          })
        }
        priorPinnedCheckpointRef = current.checkpointRef
      }
    : undefined
  const ctx = createDurableWorkflowContext(storage, lease, {
    ...(onStepCommit ? { onStepCommit } : {}),
    ...(onStepCommitted ? { onStepCommitted } : {})
  })
  const autoCleanup = workspace?.info.policy.retention?.cleanupMode === 'adapter_automatic'
  let settled = false
  // Workspaces that bind run sandboxes to active directories (LocalDirectoryWorkspace)
  // expose an unbind hook so the binding never outlives the durable run.
  const releaseRunBinding = (): void => {
    const candidate = workspace as { releaseRunBinding?: (runId: string, owner: SandboxOwner) => void } | undefined
    candidate?.releaseRunBinding?.(lease.runId, sandbox.owner)
  }

  return {
    runId: lease.runId,
    attempt: lease.attempt,
    resumed: lease.resumed,
    step: ctx.step,
    async finishSuccess(output: JsonValue): Promise<void> {
      await storage.finishRun(lease.runId, { status: 'succeeded', output })
      settled = true
      if (workspace && activeHandle) {
        await workspace.finish({ workspaceRef: activeHandle.workspaceRef, runId: lease.runId, status: 'succeeded', idempotencyKey: `${lease.runId}:finish:succeeded`, signal })
        if (priorPinnedCheckpointRef) await workspace.releaseCheckpoint({ workspaceRef: activeHandle.workspaceRef, checkpointRef: priorPinnedCheckpointRef, runId: lease.runId, idempotencyKey: `${lease.runId}:release:terminal`, signal })
      }
      if (workspace && activeHandle && autoCleanup) {
        try {
          await workspace.cleanupWorkspace({
            workspaceRef: activeHandle.workspaceRef,
            reason: 'terminal_success',
            idempotencyKey: `${lease.runId}:cleanup`
          })
        } catch (error) {
          // The business outcome is already committed. Operators may retry
          // idempotent workspace cleanup; replay must not rerun the business work.
          logger.warn('Terminal workspace cleanup failed.', { error_type: telemetryErrorType(error) })
        }
      }
    },
    async finishCancelled(error: unknown): Promise<void> {
      await storage.finishRun(lease.runId, { status: 'cancelled', error: serializeError(error) })
      settled = true
      if (workspace && activeHandle) {
        try {
          await workspace.finish({ workspaceRef: activeHandle.workspaceRef, runId: lease.runId, status: 'cancelled', idempotencyKey: `${lease.runId}:finish:cancelled`, signal })
          if (priorPinnedCheckpointRef) await workspace.releaseCheckpoint({ workspaceRef: activeHandle.workspaceRef, checkpointRef: priorPinnedCheckpointRef, runId: lease.runId, idempotencyKey: `${lease.runId}:release:terminal`, signal })
          await workspace.abortWorkspace({
            workspaceRef: activeHandle.workspaceRef,
            runId: lease.runId,
            sessionId,
            reason: 'cancelled',
            idempotencyKey: `${lease.runId}:abort`
          })
        } catch (cleanupError) {
          logger.warn('Cancelled workspace cleanup failed.', { error_type: telemetryErrorType(cleanupError) })
        }
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
