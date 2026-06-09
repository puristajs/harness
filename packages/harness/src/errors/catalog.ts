import { HarnessError } from './harness-error.js'

/** Configuration validation and assembly failures. */
export class HarnessConfigError extends HarnessError {
  public constructor(message: string, meta: { reason: string; path?: string; id?: string }, cause?: unknown) {
    super({ code: 'HARNESS_CONFIG_ERROR', category: 'config', retriable: false, message, meta, cause })
  }
}

/** Harness validation failures for inputs, outputs, and payload schemas. */
export class ValidationError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      where:
        /** Agent input schema validation failed. */ | 'agent_input'
        /** Agent output schema validation failed. */ | 'agent_output'
        /** Workflow input schema validation failed. */ | 'workflow_input'
        /** Workflow output schema validation failed. */ | 'workflow_output'
        /** Tool input schema validation failed. */ | 'tool_input'
        /** Tool output schema validation failed. */ | 'tool_output'
        /** MCP request schema validation failed. */ | 'mcp_input'
        /** MCP response schema validation failed. */ | 'mcp_output'
        /** Model provider response shape is invalid. */ | 'model_response'
        /** Session memory key is invalid. */ | 'memory_key'
        /** Session memory value is invalid or non-serializable. */ | 'memory_value'
        /** Session memory scope is invalid or unsupported. */ | 'memory_scope'
        /** Session memory options are invalid or unsupported. */ | 'memory_write_options'
        /** Session memory listing options are invalid. */ | 'memory_list_options'
        /** Session memory search query is invalid. */ | 'memory_search_query'
        /** Message envelope validation failed. */ | 'message'
        /** Session history shape validation failed. */ | 'session_history'
        /** Invocation options are invalid. */ | 'invoke_options'
        /** Evaluation helper input is invalid. */ | 'eval_input'
      issues: unknown
    },
    cause?: unknown
  ) {
    super({ code: 'VALIDATION_ERROR', category: 'validation', retriable: false, message, meta, cause })
  }
}

/** Tool execution denied by policy or approval hook. */
export class PermissionDeniedError extends HarnessError {
  public constructor(message: string, meta: { tool_name: string; agent_id: string; reason?: 'mode_deny' | 'hook_deny' | 'hook_failed' }, cause?: unknown) {
    super({ code: 'PERMISSION_DENIED', category: 'permission', retriable: false, message, meta, cause })
  }
}

/** Sandbox filesystem or command execution failed. */
export class SandboxError extends HarnessError {
  public constructor(message: string, meta: { reason: 'invalid_path' | 'exec_failed' | 'fs_failed' | string; stdout?: string; stderr?: string }, cause?: unknown) {
    super({ code: 'SANDBOX_ERROR', category: 'sandbox', retriable: true, message, meta, cause })
  }
}

/** Sandbox session has no command executor available. */
export class SandboxNoExecutorError extends HarnessError {
  public constructor(message: string, meta: { session_id: string }, cause?: unknown) {
    super({ code: 'SANDBOX_NO_EXECUTOR', category: 'sandbox', retriable: false, message, meta, cause })
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
        | 'unstructured_response'
        | 'malformed_response'
        | 'context_length_exceeded'
        | 'embedding_count_mismatch'
        | 'rerank_result_mismatch'
      providerCode?: string
      providerType?: string
      providerParam?: string
      providerRequestId?: string
      providerMessage?: string
      providerBody?: unknown
      providerHeaders?: Record<string, string>
    },
    cause?: unknown
  ) {
    const retriable =
      meta.reason === 'network'
      || meta.status === 429
      || (typeof meta.status === 'number' && meta.status >= 500)
    super({ code: 'MODEL_ERROR', category: 'model', retriable, message, meta, cause })
  }
}

/** Requested model capability is not available for alias/provider method. */
export class ModelCapabilityError extends HarnessError {
  public constructor(message: string, meta: { alias: string; method: string; reason: 'missing_capability' | 'method_missing' }, cause?: unknown) {
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
      cause
    })
  }
}

/** Tool reference was not found in registry, allowlist, or model response mapping. */
export class ToolNotFoundError extends HarnessError {
  public constructor(message: string, meta: { tool_id: string; where: 'registry' | 'agent_allowlist' | 'model_response' }, cause?: unknown) {
    super({ code: 'TOOL_NOT_FOUND', category: 'tool', retriable: false, message, meta, cause })
  }
}

/** Skill id was not found in configured skill set. */
export class SkillNotFoundError extends HarnessError {
  public constructor(message: string, meta: { skill_id: string }, cause?: unknown) {
    super({ code: 'SKILL_NOT_FOUND', category: 'skill', retriable: false, message, meta, cause })
  }
}

/** Skill manifest/frontmatter/config validation failure. */
export class SkillManifestError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      directory?: string
      reason:
        | 'missing_skill_md'
        | 'invalid_frontmatter'
        | 'missing_description'
        | 'invalid_name'
        | 'name_mismatch'
        | 'directory_missing'
        | 'reserved_name'
        | 'skill_not_declared'
        | 'skill_read_tool_missing'
        | 'skill_sandbox_unsupported'
        | 'untrusted_project_skill'
        | 'collision_shadowed'
        | 'scan_limit_reached'
      skill_id?: string
      source?: string
      agent_id?: string
    },
    cause?: unknown
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
  public constructor(message: string, meta: { agent_id: string; reason: 'iterations_exceeded'; limit: number }, cause?: unknown) {
    super({ code: 'AGENT_LOOP_BUDGET_EXCEEDED', category: 'validation', retriable: false, message, meta, cause })
  }
}

/** Session attempted to invoke unknown workflow id. */
export class WorkflowNotFoundError extends HarnessError {
  public constructor(message: string, meta: { workflow_id: string }, cause?: unknown) {
    super({ code: 'WORKFLOW_NOT_FOUND', category: 'validation', retriable: false, message, meta, cause })
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
    meta: { session_id: string; reason?: 'concurrent_run' | 'history_clear_during_run' | 'history_replace_during_run' },
    cause?: unknown
  ) {
    super({ code: 'SESSION_BUSY', category: 'session', retriable: true, message, meta, cause })
  }
}

/** State backend operation failed. */
export class StateError extends HarnessError {
  public constructor(
    message: string,
    meta: {
      op:
        | 'getSession' | 'upsertSession' | 'closeSession' | 'appendMessages' | 'listMessages'
        | 'clearMessages' | 'createRun' | 'finishRun' | 'getRun' | 'listRuns' | 'appendEvents' | 'listEvents'
        | 'memory.get' | 'memory.set' | 'memory.delete' | 'memory.list' | 'memory.search'
      reason?: 'duplicate_message_id' | string
      adapter?: 'memory' | string
      memory_provider?: string
    },
    cause?: unknown
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
    cause?: unknown
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
    cause?: unknown
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
    cause?: unknown
  ) {
    super({ code: 'WORKSPACE_CLEANUP_ERROR', category: 'workspace', retriable: true, message, meta, cause })
  }
}

/** Timed execution budget expired. */
export class OperationTimeoutError extends HarnessError {
  public constructor(message: string, meta: { scope: 'run' | 'model' | 'tool' | 'sandbox_run' | 'memory' | 'workspace'; timeout_ms: number }, cause?: unknown) {
    super({ code: 'OPERATION_TIMEOUT', category: 'timeout', retriable: true, message, meta, cause })
  }
}

/** Operation cancelled by abort signal or explicit cancellation path. */
export class OperationCancelledError extends HarnessError {
  public constructor(message: string, meta: { scope: 'run' | 'workflow' | 'agent' | 'model' | 'tool' | 'sandbox' | 'memory' | 'workspace' }, cause?: unknown) {
    super({ code: 'OPERATION_CANCELLED', category: 'cancelled', retriable: false, message, meta, cause })
  }
}

/** MCP transport/protocol failure. */
export class McpProtocolError extends HarnessError {
  public constructor(message: string, meta: { tool_id: string; transport: 'stdio' | 'http'; phase: 'connect' | 'list' | 'call' }, cause?: unknown) {
    super({ code: 'MCP_PROTOCOL_ERROR', category: 'tool', retriable: true, message, meta, cause })
  }
}

/** Supported MCP HTTP authentication kinds. */
export type McpAuthKind =
  /** No authentication. */ 'none'
  /** Bearer token auth. */ | 'bearer'
  /** OAuth2 access token auth. */ | 'oauth2'
  /** API key auth. */ | 'api_key'
  /** Basic auth. */ | 'basic'

/** MCP authentication/authorization failure. */
export class McpAuthError extends HarnessError {
  public constructor(message: string, meta: { tool_id: string; auth_kind: McpAuthKind; status?: number }, cause?: unknown) {
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
