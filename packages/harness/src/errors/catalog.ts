import { HarnessError } from './harness-error.js'
import { decisionEvidenceSchema, decisionFailureKindSchema, policyDenialReasonSchema } from '../decisions/schemas.js'
import { z } from 'zod'
import type { DecisionEvidence, DecisionFailureKind } from '../decisions/types.js'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Stable locations for public value-schema validation failures. */
export type ValidationWhere =
  | 'agent_input'
  | 'agent_output'
  | 'workflow_input'
  | 'workflow_output'
  | 'tool_input'
  | 'tool_output'
  | 'mcp_input'
  | 'mcp_output'
  | 'model_request'
  | 'model_response'
  | 'memory_key'
  | 'memory_value'
  | 'memory_scope'
  | 'memory_write_options'
  | 'memory_list_options'
  | 'memory_search_query'
  | 'message'
  | 'session_history'
  | 'invoke_options'
  | 'eval_input'
  | 'sandbox_options'

/** Configuration validation and assembly failures. */
export class HarnessConfigError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      reason: string
      path?: string
      id?: string
      module_id?: string
      schemaBoundary?: 'agent_output' | 'tool_input'
      schemaVendor?: string
      schemaTarget?: 'draft-2020-12'
    },
    cause?: unknown,
  ) {
    super({ code: 'HARNESS_CONFIG_ERROR', category: 'config', retriable: false, message, meta, cause })
  }
}

/** Harness validation failures for inputs, outputs, and payload schemas. */
export class ValidationError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      where: ValidationWhere
      issues: unknown
    },
    cause?: unknown,
  ) {
    super({ code: 'VALIDATION_ERROR', category: 'validation', retriable: false, message, meta, cause })
  }
}

/** Provider capacity was not admitted and the caller may retry after a delay. */
export class ModelAdmissionRejectedError extends HarnessError {
  public readonly retryAfterMs: number

  public constructor(
    retryAfterMs: number,
    meta: { providerId: string; model: string; credentialScope: string; operation: string },
    cause?: unknown,
  ) {
    super({
      code: 'MODEL_ADMISSION_REJECTED',
      category: 'model',
      retriable: true,
      message: 'Model provider capacity is not currently available.',
      meta: { ...meta, retryAfterMs },
      cause,
    })
    this.retryAfterMs = retryAfterMs
  }
}

/** Complete agent-loop capacity was not admitted and the caller may retry. */
export class AgentAdmissionRejectedError extends HarnessError {
  public constructor(options: Readonly<{ retryAfterMs?: number }> = {}) {
    if (!isPlainRecord(options) || Reflect.ownKeys(options).some(key => typeof key !== 'string' || key !== 'retryAfterMs')) {
      throw new HarnessConfigError('Agent admission rejection options are invalid.', {
        reason: 'invalid_agent_admission_rejection', path: 'agentAdmission.retryAfterMs',
      })
    }
    const retryAfterMs = options.retryAfterMs
    if (retryAfterMs !== undefined && (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0)) {
      throw new HarnessConfigError('Agent admission retryAfterMs must be a positive safe integer.', {
        reason: 'invalid_agent_admission_rejection', path: 'agentAdmission.retryAfterMs',
      })
    }
    super({
      code: 'AGENT_ADMISSION_REJECTED', category: 'admission', retriable: true,
      message: 'Agent admission capacity is exhausted.',
      meta: { reason: 'capacity_exhausted', ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
    })
  }
}

/** Tool execution denied by a configured coarse permission. */
export class PermissionDeniedError extends HarnessError {
  public constructor(evidence: DecisionEvidence, cause?: unknown) {
    super({
      code: 'PERMISSION_DENIED',
      category: 'permission',
      retriable: false,
      message: 'Permission denied.',
      meta: { evidence: parseDecisionEvidence(evidence) },
      cause,
    })
  }
}

/** Tool execution denied by a configured governance policy or approval decision. */
export class PolicyDeniedError extends HarnessError {
  public constructor(evidence: DecisionEvidence, reason: z.output<typeof policyDenialReasonSchema>, cause?: unknown) {
    const parsedReason = policyDenialReasonSchema.safeParse(reason)
    if (!parsedReason.success) throw decisionConfigError()
    super({
      code: 'POLICY_DENIED',
      category: 'permission',
      retriable: false,
      message: 'Tool call denied by governance policy.',
      meta: { evidence: parseDecisionEvidence(evidence), reason: parsedReason.data },
      cause,
    })
  }
}

/** A decision boundary explicitly blocked execution. */
export class DecisionBlockedError extends HarnessError {
  public constructor(evidence: DecisionEvidence, cause?: unknown) {
    const safeEvidence = parseDecisionEvidence(evidence)
    super({
      code: 'DECISION_BLOCKED',
      category: 'interceptor',
      retriable: false,
      message: 'Decision blocked execution.',
      meta: { evidence: safeEvidence },
      cause,
    })
  }
}

/** A decision callback failed closed before it could safely continue. */
export class DecisionEvaluationError extends HarnessError {
  public constructor(evidence: DecisionEvidence, failureKind: DecisionFailureKind, cause?: unknown) {
    const safeEvidence = parseDecisionEvidence(evidence)
    const safeFailureKind = parseDecisionFailureKind(failureKind)
    super({
      code: 'DECISION_EVALUATION_ERROR',
      category: 'interceptor',
      retriable: false,
      message: 'Decision evaluation failed closed.',
      meta: { evidence: safeEvidence, failureKind: safeFailureKind },
      cause,
    })
  }
}

function parseDecisionEvidence(value: unknown): DecisionEvidence {
  try {
    return decisionEvidenceSchema.parse(value)
  } catch {
    throw decisionConfigError()
  }
}

function parseDecisionFailureKind(value: unknown): DecisionFailureKind {
  try {
    return decisionFailureKindSchema.parse(value)
  } catch {
    throw decisionConfigError()
  }
}

function decisionConfigError(): HarnessConfigError {
  return new HarnessConfigError('Decision evidence configuration is invalid.', { reason: 'invalid_decision_evidence' })
}

const sandboxPermissionDeniedReasonSchema = z.enum([
  'scope_mismatch',
  'owner_not_authorized',
  'owner_revoked',
  'principal_revoked',
])
const sandboxConflictReasonSchema = z.enum([
  'binding_changed',
  'policy_changed',
  'checkpoint_busy',
  'snapshot_pinned',
  'idempotency_conflict',
])
const sandboxQuotaMetadataSchema = z.strictObject({
  quota: z.enum(['catalog_entries', 'active_sandboxes', 'snapshots', 'snapshot_bytes']),
  limit: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  actual: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
})

function parseSandboxErrorMetadata<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new HarnessConfigError('Sandbox error metadata is invalid.', { reason: 'invalid_sandbox_error_metadata' })
}

/** Sandbox filesystem or command execution failed. */
export class SandboxError extends HarnessError {
  public constructor(
    message: string,
    meta: { reason: 'invalid_path' | 'exec_failed' | 'fs_failed' | string; stdout?: string; stderr?: string },
    cause?: unknown,
  ) {
    super({ code: 'SANDBOX_ERROR', category: 'sandbox', retriable: true, message, meta, cause })
  }
}

/** Sandbox session has no command executor available. */
export class SandboxNoExecutorError extends HarnessError {
  public constructor(message: string, meta: { session_id: string }, cause?: unknown) {
    super({ code: 'SANDBOX_NO_EXECUTOR', category: 'sandbox', retriable: false, message, meta, cause })
  }
}

/** Sandbox ownership or acting-principal admission was denied without leaking owner data. */
export class SandboxPermissionDeniedError extends HarnessError {
  public constructor(reason: z.input<typeof sandboxPermissionDeniedReasonSchema>, cause?: unknown) {
    super({
      code: 'SANDBOX_PERMISSION_DENIED',
      category: 'permission',
      retriable: false,
      message: 'Sandbox access denied.',
      meta: { reason: parseSandboxErrorMetadata(sandboxPermissionDeniedReasonSchema, reason) },
      cause,
    })
  }
}

/** A sandbox mutation conflicts with an immutable binding, active checkpoint, or snapshot state. */
export class SandboxConflictError extends HarnessError {
  public constructor(reason: z.input<typeof sandboxConflictReasonSchema>, cause?: unknown) {
    const safeReason = parseSandboxErrorMetadata(sandboxConflictReasonSchema, reason)
    super({
      code: 'SANDBOX_CONFLICT',
      category: 'sandbox',
      retriable: safeReason === 'checkpoint_busy',
      message: 'Sandbox operation conflicts with current state.',
      meta: { reason: safeReason },
      cause,
    })
  }
}

/** A finite sandbox catalog, active allocation, or snapshot capacity was exhausted. */
export class SandboxQuotaExceededError extends HarnessError {
  public constructor(meta: z.input<typeof sandboxQuotaMetadataSchema>, cause?: unknown) {
    super({
      code: 'SANDBOX_QUOTA_EXCEEDED',
      category: 'sandbox',
      retriable: false,
      message: 'Sandbox quota exceeded.',
      meta: parseSandboxErrorMetadata(sandboxQuotaMetadataSchema, meta),
      cause,
    })
  }
}

/** A known sandbox scope cannot be attached or safely recovered. */
export class SandboxStateLostError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      reason:
        | 'lifecycle_state_missing'
        | 'provider_missing'
        | 'durable_workspace_required'
        | 'durable_workspace_recovery_unavailable'
        | 'owner_missing'
        | 'scope_terminated'
        | 'creation_indeterminate'
      lifetime: 'session' | 'run'
      adapter_id?: string
    },
    cause?: unknown,
  ) {
    super({ code: 'SANDBOX_STATE_LOST', category: 'sandbox', retriable: false, message, meta, cause })
  }
}

/** Model/provider call failed or returned unsupported output shape. */
export class ModelError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      provider: string
      model: string
      method: string
      status?: number
      reason?:
        | 'http_error'
        | 'network'
        | 'rate_limited'
        | 'provider_unavailable'
        | 'unstructured_response'
        | 'malformed_response'
        | 'context_length_exceeded'
        | 'embedding_count_mismatch'
        | 'rerank_result_mismatch'
        | 'invalid_provider_continuation'
        | 'unsupported_request_option'
      retryKind?: 'none' | 'active' | 'deferred'
      retryAfterMs?: number
      retryAttempt?: number
      retryMaxAttempts?: number
      rateLimit?: unknown
      providerCode?: string
      providerType?: string
      providerParam?: string
      providerRequestId?: string
      providerMessage?: string
      providerBody?: unknown
      providerHeaders?: Record<string, string>
    },
    cause?: unknown,
  ) {
    const retriable =
      meta.reason === 'network' ||
      meta.reason === 'rate_limited' ||
      meta.reason === 'provider_unavailable' ||
      meta.status === 429 ||
      meta.status === 408 ||
      meta.status === 409 ||
      (typeof meta.status === 'number' && meta.status >= 500)
    super({ code: 'MODEL_ERROR', category: 'model', retriable, message, meta, cause })
  }
}

/** Requested model capability is not available for alias/provider method. */
export class ModelCapabilityError extends HarnessError {
  public constructor(
    message: string,
    meta: { alias: string; method: string; reason: 'missing_capability' | 'method_missing' },
    cause?: unknown,
  ) {
    super({ code: 'MODEL_CAPABILITY_ERROR', category: 'model', retriable: false, message, meta, cause })
  }
}

/** Tool execution failed with wrapped/normalized cause information. */
export class ToolError extends HarnessError {
  public constructor(message: string, meta: { tool_id: string; tool_kind: string }, cause?: unknown) {
    super({
      code: 'TOOL_ERROR',
      category: 'tool',
      retriable: cause instanceof HarnessError ? cause.retriable : false,
      message,
      meta,
      cause,
    })
  }
}

/** Tool reference was not found in registry, allowlist, or model response mapping. */
export class ToolNotFoundError extends HarnessError {
  public constructor(
    message: string,
    meta: { tool_id: string; where: 'registry' | 'agent_allowlist' | 'model_response' },
    cause?: unknown,
  ) {
    super({ code: 'TOOL_NOT_FOUND', category: 'tool', retriable: false, message, meta, cause })
  }
}

/** Skill id was not found in configured skill set. */
export class SkillNotFoundError extends HarnessError {
  public constructor(message: string, meta: { skill_id: string; agent_id?: string }, cause?: unknown) {
    super({ code: 'SKILL_NOT_FOUND', category: 'skill', retriable: false, message, meta, cause })
  }
}

/** Stable reasons emitted while loading or mounting one v4 Agent Skill. */
export type SkillManifestErrorReason =
  | 'invalid_skill_url'
  | 'directory_missing'
  | 'missing_skill_md'
  | 'invalid_frontmatter'
  | 'missing_description'
  | 'invalid_name'
  | 'name_mismatch'
  | 'unsafe_skill_entry'
  | 'invalid_skill_path'
  | 'invalid_skill_encoding'
  | 'skill_file_too_large'
  | 'scan_limit_reached'
  | 'readonly_mount_unsupported'

/** Skill manifest/frontmatter/config validation failure. */
export class SkillManifestError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      directory?: string
      reason: SkillManifestErrorReason
      skill_id?: string
      path?: string
    },
    cause?: unknown,
  ) {
    super({ code: 'SKILL_MANIFEST_ERROR', category: 'config', retriable: false, message, meta, cause })
  }
}

/** Workflow referenced an unknown agent id. */
export class AgentNotFoundError extends HarnessError {
  public constructor(message: string, meta: { agent_id: string }, cause?: unknown) {
    super({ code: 'AGENT_NOT_FOUND', category: 'validation', retriable: false, message, meta, cause })
  }
}

/** Agent exceeded configured loop iteration/step budget. */
export class AgentLoopBudgetError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      agent_id: string
      reason: 'max_steps' | 'max_tool_calls' | 'max_subagent_calls' | 'max_depth'
      limit: number
    },
    cause?: unknown,
  ) {
    super({ code: 'AGENT_LOOP_BUDGET_EXCEEDED', category: 'validation', retriable: false, message, meta, cause })
  }
}

/** Workflow child-agent delegation was denied or exceeded a configured budget. */
export class DelegationPolicyError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      workflow_id: string
      agent_id: string
      reason:
        | 'delegation_disabled'
        | 'agent_not_allowed'
        | 'max_child_agent_calls_exceeded'
        | 'max_parallel_child_agent_calls_exceeded'
        | 'max_delegation_depth_exceeded'
        | 'model_alias_not_allowed'
      limit?: number
      model_alias?: string
    },
    cause?: unknown,
  ) {
    super({ code: 'DELEGATION_POLICY_ERROR', category: 'validation', retriable: false, message, meta, cause })
  }
}

/** Session attempted to invoke unknown workflow id. */
export class WorkflowNotFoundError extends HarnessError {
  public constructor(message: string, meta: { workflow_id: string }, cause?: unknown) {
    super({ code: 'WORKFLOW_NOT_FOUND', category: 'validation', retriable: false, message, meta, cause })
  }
}

/** A public approval resume does not match the current durable continuation. */
export class ApprovalResumeError extends HarnessError {
	public constructor(reason:
		| 'invalid_resume' | 'run_mismatch' | 'input_mismatch' | 'interrupt_mismatch'
		| 'revision_mismatch' | 'graph_mismatch' | 'session_identity_mismatch'
		| 'invalid_checkpoint' | 'event_conflict' | 'decision_set_mismatch' | 'stale_continuation') {
		super({ code: 'APPROVAL_RESUME_ERROR', category: 'validation', retriable: false,
			message: 'Tool approval resume is invalid.', meta: { reason } })
	}
}

/** One workflow call id was reused for another logical child call. */
export class WorkflowCallReplayConflictError extends HarnessError {
	public constructor(meta: {
		reason: 'operation_mismatch' | 'target_mismatch' | 'input_mismatch' | 'idempotency_key_mismatch' | 'options_mismatch'
		workflow_id: string
		call_id: string
		expected_operation: 'agent_run' | 'child_task_start'
		received_operation: 'agent_run' | 'child_task_start'
		expected_target_kind: 'agent'
		expected_target_id: string
		received_target_kind: 'agent'
		received_target_id: string
	}) {
		super({ code: 'WORKFLOW_CALL_REPLAY_CONFLICT', category: 'validation', retriable: false,
			message: 'Workflow call id conflicts with an existing logical child call.', meta })
	}
}

/** One logical workflow invocation exhausted its agent-call budget. */
export class WorkflowAgentCallBudgetError extends HarnessError {
	public constructor(meta: { workflow_id: string; agent_id: string; reason: 'max_calls' | 'max_parallel'; limit: number }) {
		super({ code: 'WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED', category: 'validation', retriable: false,
			message: 'Workflow agent-call budget exceeded.', meta })
	}
}

/** An agent target selected by workflow orchestration returned a failed terminal. */
export class WorkflowChildTargetError extends HarnessError {
	public constructor(meta:
		| { reason: 'agent_call_failed'; workflow_id: string; call_id: string; target_kind: 'agent'; target_id: string }
		| { reason: 'child_task_failed'; workflow_id: string; call_id: string; task_id: string; target_kind: 'agent'; target_id: string }, cause?: unknown) {
		super({ code: 'WORKFLOW_CHILD_TARGET_FAILED', category: 'internal', retriable: false,
			message: 'Workflow child target failed.', meta, cause })
	}
}

/** A durable task id was reused with another stable start tuple. */
export class ChildTaskConflictError extends HarnessError {
	public constructor(meta: { reason: 'idempotency_key_reused'; workflow_id: string; parent_run_id: string; task_id: string; agent_id: string; call_id: string }) {
		super({ code: 'CHILD_TASK_CONFLICT', category: 'validation', retriable: false,
			message: 'Child-task idempotency key conflicts with an existing task.', meta })
	}
}

/** A child-task record or live handle is unavailable in the requested state. */
export class ChildTaskStateError extends HarnessError {
	public constructor(meta: { reason: 'invalid_record'; task_id: string }
		| { reason: 'recovery_required' | 'closing' | 'terminal'; task_id: string; workflow_id: string; agent_id: string }) {
		super({ code: 'CHILD_TASK_STATE_ERROR', category: 'state', retriable: false,
			message: 'Child task is not available in the requested state.', meta })
	}
}

/** Session id not found in backing store. */
export class SessionNotFoundError extends HarnessError {
  public constructor(message: string, meta: { session_id: string }, cause?: unknown) {
    super({ code: 'SESSION_NOT_FOUND', category: 'session', retriable: false, message, meta, cause })
  }
}

/** Session is currently busy and cannot accept concurrent mutation/run operations. */
export class SessionBusyError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      session_id: string
      reason?:
        | 'concurrent_run'
        | 'session_release_in_progress'
        | 'history_clear_during_run'
        | 'history_replace_during_run'
    },
    cause?: unknown,
  ) {
    super({ code: 'SESSION_BUSY', category: 'session', retriable: true, message, meta, cause })
  }
}

/** Harness storage or scoped-memory backend operation failed. */
export class StateError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      op:
        | 'getSession'
        | 'upsertSession'
        | 'closeSession'
        | 'appendMessages'
        | 'listMessages'
        | 'clearMessages'
        | 'replaceMessages'
        | 'createRun'
        | 'finishRun'
        | 'getRun'
        | 'listRuns'
        | 'appendEvents'
        | 'listEvents'
        | 'acquireRun'
		| 'replaceCheckpoint'
		| 'finalizeRun'
        | 'loadCheckpoint'
        | 'commitCheckpoint'
        | 'withSessionLock'
        | 'registerWait'
        | 'getWait'
        | 'signalWait'
        | 'cancelWait'
        | 'memory.get'
        | 'memory.set'
        | 'memory.delete'
        | 'memory.list'
        | 'memory.search'
      reason?: 'duplicate_message_id' | string
      adapter?: 'memory' | string
      memory_provider?: string
    },
    cause?: unknown,
  ) {
    super({ code: 'STATE_ERROR', category: 'state', retriable: true, message, meta, cause })
  }
}

/** Durable workspace lifecycle, consistency, inspection, or backend failure. */
export class WorkspaceError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      reason:
        | 'idempotency_conflict'
        | 'not_found'
        | 'aborted'
        | 'expired'
        | 'missing_checkpoint'
        | 'backend_failure'
        | 'unsupported_operation'
        | 'invalid_reference'
        | 'checkpoint_conflict'
        | 'cleanup_pending'
      workspace_ref?: string
      checkpoint_ref?: string
      snapshot_ref?: string
      run_id?: string
      session_id?: string
    },
    cause?: unknown,
  ) {
    const retriable = meta.reason === 'backend_failure' || meta.reason === 'cleanup_pending'
    super({ code: 'WORKSPACE_ERROR', category: 'workspace', retriable, message, meta, cause })
  }
}

/** Durable workspace quota would be or was exceeded. */
export class WorkspaceQuotaExceededError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      quota: string
      limit?: number
      actual?: number
      partial?: boolean
      workspace_ref?: string
      run_id?: string
      session_id?: string
    },
    cause?: unknown,
  ) {
    super({ code: 'WORKSPACE_QUOTA_EXCEEDED', category: 'workspace', retriable: false, message, meta, cause })
  }
}

/** Durable workspace cleanup could not complete in the current attempt. */
export class WorkspaceCleanupError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      reason: 'backend_failure' | 'partial_delete' | 'invalid_reference'
      workspace_ref: string
      remaining_refs?: readonly string[]
      retry_after_ms?: number
    },
    cause?: unknown,
  ) {
    super({ code: 'WORKSPACE_CLEANUP_ERROR', category: 'workspace', retriable: true, message, meta, cause })
  }
}

/** Timed execution budget expired. */
export class OperationTimeoutError extends HarnessError {
  public constructor(
    message: string,
    meta: { scope: 'run' | 'model' | 'tool' | 'decision' | 'sandbox_run' | 'memory' | 'workspace' | 'child_task'; timeout_ms: number },
    cause?: unknown,
  ) {
    super({ code: 'OPERATION_TIMEOUT', category: 'timeout', retriable: true, message, meta, cause })
  }
}

/** Operation cancelled by abort signal or explicit cancellation path. */
export class OperationCancelledError extends HarnessError {
  public constructor(
    message: string,
    meta: { scope: 'run' | 'workflow' | 'agent' | 'model' | 'tool' | 'sandbox' | 'memory' | 'workspace' | 'child_task' },
    cause?: unknown,
  ) {
    super({ code: 'OPERATION_CANCELLED', category: 'cancelled', retriable: false, message, meta, cause })
  }
}

/** MCP transport/protocol failure. */
export class McpProtocolError extends HarnessError {
  public constructor(
    message: string,
    meta: { tool_id: string; transport: 'stdio' | 'http'; phase: 'connect' | 'list' | 'call' },
    cause?: unknown,
  ) {
    super({ code: 'MCP_PROTOCOL_ERROR', category: 'tool', retriable: true, message, meta, cause })
  }
}

/** Supported MCP HTTP authentication kinds. */
export type McpAuthKind =
  /** No authentication. */
  | 'none'
  /** Bearer token auth. */
  | 'bearer'
  /** OAuth2 access token auth. */
  | 'oauth2'
  /** API key auth. */
  | 'api_key'
  /** Basic auth. */
  | 'basic'

/** MCP authentication/authorization failure. */
export class McpAuthError extends HarnessError {
  public constructor(
    message: string,
    meta: { tool_id: string; auth_kind: McpAuthKind; status?: number },
    cause?: unknown,
  ) {
    const retriable = typeof meta.status === 'number' ? meta.status >= 500 : false
    super({ code: 'MCP_AUTH_ERROR', category: 'tool', retriable, message, meta, cause })
  }
}

/** Unexpected internal harness invariant failure. */
export class InternalError extends HarnessError {
  public constructor(message: string, meta?: Record<string, unknown>, cause?: unknown) {
    super({ code: 'INTERNAL_ERROR', category: 'internal', retriable: false, message, ...(meta ? { meta } : {}), cause })
  }
}
