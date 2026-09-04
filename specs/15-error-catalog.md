# Error catalog

**Purpose.** Authoritative catalog of every error class, its code, category, retriable flag, when it is thrown, and `meta` fields. All extend `HarnessError` (defined in [03-foundation](./03-foundation.md)).

## Conventions

- `code` is SCREAMING_SNAKE_CASE.
- `retriable` is locked per class (no per-instance overrides except where noted in "When").
- `meta` keys are stable; consumers can rely on their presence on the listed classes.
- When a subclass wraps another error, `cause` carries the original.
- Every entry below lists: class, code, category, retriable, when-thrown, meta.

## `isHarnessError`

```ts
function isHarnessError(value: unknown): value is HarnessError
```

Returns `true` iff `value` is an instance of `HarnessError` (i.e. any error class in this catalog). Useful for narrowing thrown unknowns at call sites.

## Catalog

### `HarnessConfigError`
- code: `HARNESS_CONFIG_ERROR`
- category: `config`
- retriable: `false`
- when: `defineHarness` validation fails (schema, capability mismatch, id collision, reserved prefix, missing model alias, agent/model capability mismatch, etc.); also thrown at workflow call time when `opts.durable` is supplied without an executable `.storage(...)` (`reason:'durable_runtime_required'`).
- meta: `path?: string` (config path), `id?: string`, `reason: string` (e.g. `'duplicate_adapter'`, `'duplicate_module'`, `'duplicate_definition'`, `'invalid_module'`, `'invalid_context_projection'`, `'missing_required_capability'`, `'invalid_workspace_store'`, `'invalid_context_checkpoint_store'`, `'durable_runtime_required'`, `'sqlite_unavailable'`).

### Testing-only errors

`ReplayFixtureError` and `DiagnosticInvariantError` are exported only from
`@purista/harness/testing`. Their exact codes, reason values, and content-free
metadata are locked in [13-public-api](./13-public-api.md) §"Testing replay and
diagnostic contracts". They do not extend the production `HarnessError`
taxonomy and are never emitted by normal harness execution.

### `ValidationError`
- code: `VALIDATION_ERROR`
- category: `validation`
- retriable: `false`
- when: Standard Schema or JSON Schema validation failure on tool/agent/workflow/MCP input/output, memory key/value/scope/options/query, model response shape, structured object validation, embedding/rerank input invariants, or per-call `timeoutMs` invariants.
- meta: `where: 'agent_input'|'agent_output'|'workflow_input'|'workflow_output'|'tool_input'|'tool_output'|'mcp_input'|'mcp_output'|'model_response'|'memory_key'|'memory_value'|'memory_scope'|'memory_write_options'|'memory_list_options'|'memory_search_query'|'message'|'session_history'|'invoke_options'|'eval_input'`. For public Standard Schema boundaries, `issues` is exactly `{count:number,truncated:boolean}`; vendor messages, paths, values and causes are private and omitted. Validator throws and non-JSON successful transforms map to the `InternalError` reasons locked in [39-standard-schema-boundaries](./39-standard-schema-boundaries/03-contracts/runtime-validation.md).
- workflow/child-task invoke-option issues are content-free and exactly one of
  `{reason:'invalid_workflow_call_id'}`, `{reason:'invalid_child_task_idempotency_key'}`,
  `{reason:'child_task_idempotency_key_required'}`,
  `{reason:'durable_continuable_child_task_unsupported'}`,
  `{reason:'invalid_child_task_timeout'}`,
  `{reason:'invalid_child_task_context'}`, or
  `{reason:'approval_capable_child_task_unsupported'}`.
- supplying `InvokeOptions.durable` to a target without `durable:true` uses the
  content-free issue `{reason:'target_not_durable'}`.

### `PermissionDeniedError`
- code: `PERMISSION_DENIED`
- category: `permission`
- retriable: `false`
- when: An enforced coarse permission denied a tool occurrence. This is a recoverable safe tool result, while malformed policy decisions are terminal decision-evaluation failures.
- constructor: `PermissionDeniedError(evidence, cause?)`.
- message: fixed `Permission denied.`
- meta: exactly `{evidence: DecisionEvidence}`, validated before serialization; causes are omitted.

### `PolicyDeniedError`
- code: `POLICY_DENIED`
- category: `permission`
- retriable: `false`
- when: configured governance denied a tool call. Recoverable in the default loop: the harness informs the model via a tool result message and continues the run. A resumed rejected approval is represented by a recoverable `ToolError` with `tool_kind: 'approval'`.
- constructor: `PolicyDeniedError(evidence, reason, cause?)`.
- message: fixed `Tool call denied by governance policy.`
- meta: exactly `{evidence: DecisionEvidence, reason: 'policy_deny'}`, validated before serialization; causes are omitted.

### Decision boundary errors

`DecisionBlockedError` and `DecisionEvaluationError` are terminal non-retriable interceptor-category errors with fixed messages and validated evidence. The [decision evidence contract](./37-decision-boundaries/03-contracts/decisions.md) defines exact codes, fields and failure kinds for core and addons. GuardrailsConfigError remains addon-owned for configuration failures. ExternalWaitError adds invalid_snapshot for malformed adapter records; wait request/signal validation uses invalid_request.

### `SandboxError`
- code: `SANDBOX_ERROR`
- category: `sandbox`
- retriable: `true` (transient; subprocess failures often retry-able)
- when: Sandbox FS or `exec` fails for non-timeout reasons (invalid path, backend I/O failure, subprocess crash, malformed result, etc.).
- meta: `reason: 'invalid_path'|'exec_failed'|'fs_failed'|string`, `stdout?: string`, `stderr?: string`.

### `SandboxNoExecutorError`
- code: `SANDBOX_NO_EXECUTOR`
- category: `sandbox`
- retriable: `false`
- when: `SandboxSession.exec` is invoked on a session whose `executor === 'unavailable'` (e.g. the in-memory files-and-search fallback when `just-bash` is not installed).
- meta: `session_id: string`.

### `SandboxStateLostError`
- code: `SANDBOX_STATE_LOST`
- category: `sandbox`
- retriable: `false`
- when: a Sandbox adapter lacks lifecycle state for an existing scope or
  authoritatively reports that known provider compute is missing, and Harness
  has not established and authorized recovery from a committed durable
  workspace.
- meta: `reason: 'lifecycle_state_missing'|'provider_missing'|'durable_workspace_required'|'durable_workspace_recovery_unavailable'`, `lifetime: 'session'|'run'`, `adapter_id: string`.
- forbidden meta: logical scope fields, tenant/principal values, generation,
  lease/fence values, provider references, checkpoint references, paths,
  commands, content, credentials, and provider response bodies.

Provider outage, timeout, quota, unauthorized, and cancellation retain their
existing error classification and must not be converted to state loss.

### `ModelError`
- code: `MODEL_ERROR`
- category: `model`
- retriable: dynamic — `true` for network errors, HTTP 408/409/429,
  `reason:'rate_limited'`, `reason:'provider_unavailable'`, and HTTP 5xx;
  `false` for other 4xx/provider validation failures.
- when: Provider failed, or harness detected a structurally invalid response (e.g. default loop expecting `object` in an `ObjectResponse` and finding none, embedding count mismatch, rerank result id mismatch).
- meta: `provider: string`, `model: string`, `method: string`, `status?: number`,
  `reason?: 'http_error'|'network'|'rate_limited'|'provider_unavailable'|'unstructured_response'|'malformed_response'|'context_length_exceeded'|'embedding_count_mismatch'|'rerank_result_mismatch'`,
  `retryKind?: 'none'|'active'|'deferred'`, `retryAfterMs?: number`,
  `retryAttempt?: number`, `retryMaxAttempts?: number`, `rateLimit?: unknown`,
  `providerCode?: string`, `providerType?: string`, `providerParam?: string`,
  `providerRequestId?: string`, `providerMessage?: string`,
  `providerBody?: unknown`, `providerHeaders?: Record<string,string>`.

### `ModelCapabilityError`
- code: `MODEL_CAPABILITY_ERROR`
- category: `model`
- retriable: `false`
- when: Method called on alias missing the capability, content part requires a missing capability, OR provider doesn't implement claimed method.
- meta: `alias: string`, `method: string`, `reason: 'missing_capability'|'method_missing'`.

### `ToolError`
- code: `TOOL_ERROR`
- category: `tool`
- retriable: passthrough from `cause` if `cause instanceof HarnessError`, else `false`.
- when: TS tool handler threw; MCP tool returned an error envelope.
- meta: `tool_id: string`, `tool_kind: string`.

### `ToolNotFoundError`
- code: `TOOL_NOT_FOUND`
- category: `tool`
- retriable: `false`
- when: agent uses tool id not in registry, or model returned tool name not in agent's allowlist.
- meta: `tool_id: string`, `where: 'registry'|'agent_allowlist'|'model_response'`.

### `SkillNotFoundError`
- code: `SKILL_NOT_FOUND`
- category: `skill`
- retriable: `false`
- when: an agent references a skill id that is not in the resolved skill registry.
- meta: `skill_id: string`, `agent_id?: string`.

### `SkillManifestError`
- code: `SKILL_MANIFEST_ERROR`
- category: `config`
- retriable: `false`
- when: skill directory discovery, `SKILL.md` parsing, validation, trust checks, or required skill activation preconditions fail.
- meta: `skill_id?: string`, `directory?: string`, `source?: string`, `agent_id?: string`, `reason: 'missing_skill_md'|'invalid_frontmatter'|'missing_description'|'invalid_name'|'name_mismatch'|'directory_missing'|'reserved_name'|'skill_not_declared'|'skill_read_tool_missing'|'skill_sandbox_unsupported'|'untrusted_project_skill'|'collision_shadowed'|'scan_limit_reached'`.
- `reserved_name` is also used when a custom tool id collides with a built-in tool name or a skill id, or when a skill id collides with a built-in tool name (tool/skill/built-in share one model-facing namespace). For a tool collision, `skill_id` carries the colliding id and `source` is `'tool'`.

`SkillManifestError` metadata must not include skill body text, supporting file
content, prompts, completions, tool arguments, tool results, credentials,
tokens, raw headers, or attachments.

### `AgentNotFoundError`
- code: `AGENT_NOT_FOUND`
- category: `validation`
- retriable: `false`
- when: workflow references an unknown agent id.
- meta: `agent_id: string`.

### `AgentLoopBudgetError`
- code: `AGENT_LOOP_BUDGET_EXCEEDED`
- category: `validation`
- retriable: `false`
- when: the standard agent loop would exceed the effective local step, tool
  call, subagent call, or delegation-depth budget.
- meta: exactly
  `{agent_id:string,reason:'max_steps'|'max_tool_calls'|'max_subagent_calls'|'max_depth',limit:number}`.
- the operation that would exceed the limit does not start; metadata never
  includes input, output, prompts, messages, tool arguments, or provider data.

### `WorkflowNotFoundError`
- code: `WORKFLOW_NOT_FOUND`
- category: `validation`
- retriable: `false`
- when: session accessed via unknown workflow id.
- meta: `workflow_id: string`.

### `ApprovalResumeError`
- code: `APPROVAL_RESUME_ERROR`
- category: `validation`
- retriable: `false`
- message: fixed `Tool approval resume is invalid.`
- when: a public approval resume is malformed, does not identify the current
  root/session/interruption/deployment graph, conflicts with a prior event, has
  an incomplete decision set, or addresses a consumed continuation.
- meta: exactly `{reason:'invalid_resume'|'run_mismatch'|'input_mismatch'|'interrupt_mismatch'|'revision_mismatch'|'graph_mismatch'|'session_identity_mismatch'|'invalid_checkpoint'|'event_conflict'|'decision_set_mismatch'|'stale_continuation'}`.
- reason precedence is exact: strict resume/options/identifier and raw-JSON
  validation; session, run, and root target; canonical pre-transform root input;
  selection by interrupt id of the terminal receipt, current pending interrupt,
  or retained immediately-prior receipt; revision; graph and session identity;
  checkpoint kind/version; selected receipt or pending-event replay/conflict;
  decision-set equality. A valid input for the right run whose canonical JSON wire value
  differs from the stored root input uses `input_mismatch`. A new event for a
  consumed interrupt uses `stale_continuation` after prior-event handling. On a
  pending run, any well-formed interrupt id that selects neither the current
  interrupt nor the retained immediately-prior receipt is
  `stale_continuation`; the bounded contract does not retain older receipts.
  Metadata never
  includes event ids, decisions, reviewer reason, checkpoint data, digests,
  input, output, prompt, message, credentials, or provider continuation.

### `WorkflowCallReplayConflictError`
- code: `WORKFLOW_CALL_REPLAY_CONFLICT`
- category: `validation`
- retriable: `false`
- when: one workflow invocation reuses a `callId` across direct-agent calls or
  child-task starts with another operation, target, canonical JSON wire input,
  normalized options, or idempotency key. Equal concurrent tuples coalesce and
  do not throw this error.
- message: fixed `Workflow call id conflicts with an existing logical child call.`
- meta: exactly `{reason:'operation_mismatch'|'target_mismatch'|'input_mismatch'|'idempotency_key_mismatch'|'options_mismatch',workflow_id:string,call_id:string,expected_operation:'agent_run'|'child_task_start',received_operation:'agent_run'|'child_task_start',expected_target_kind:'agent',expected_target_id:string,received_target_kind:'agent',received_target_id:string}`.
- when multiple fields differ, reason precedence is operation, target, input,
  idempotency key, then remaining normalized options.
- forbidden meta: input, output, canonical JSON, digests, prompts, messages,
  credentials, or provider payloads.

### `WorkflowAgentCallBudgetError`
- code: `WORKFLOW_AGENT_CALL_BUDGET_EXCEEDED`
- category: `validation`
- retriable: `false`
- when: one logical workflow invocation exceeds its effective total agent-call
  budget, or a direct awaited agent call cannot enter immediately because the
  effective parallel ceiling is full or a queued child-task turn has priority.
- message: fixed `Workflow agent-call budget exceeded.`
- meta: exactly `{workflow_id:string,agent_id:string,reason:'max_calls'|'max_parallel',limit:number}`.
- forbidden meta: input, output, call id, idempotency key, queue contents,
  prompts, messages, credentials, and provider payloads.

### `WorkflowChildTargetError`
- code: `WORKFLOW_CHILD_TARGET_FAILED`
- category: `internal`
- retriable: `false`
- when: an agent target selected by a direct workflow call or child task
  returns a validated `failed` terminal. The transported error remains an
  untrusted private cause and is never reconstructed as its remote class.
- message: fixed `Workflow child target failed.`
- meta: exactly the discriminated union
  `{reason:'agent_call_failed',workflow_id:string,call_id:string,target_kind:'agent',target_id:string}`
  or
  `{reason:'child_task_failed',workflow_id:string,call_id:string,task_id:string,target_kind:'agent',target_id:string}`.
- forbidden meta: transported code, category, message or metadata; input,
  output, canonical JSON, prompts, credentials, and provider payloads.

### `ChildTaskConflictError`
- code: `CHILD_TASK_CONFLICT`
- category: `validation`
- retriable: `false`
- when: a durable task id derived from `(parentRunId,idempotencyKey)` already
  exists but its persisted start tuple differs by call id, agent, input, mode,
  timeout, or context.
- message: fixed `Child-task idempotency key conflicts with an existing task.`
- meta: exactly `{reason:'idempotency_key_reused',workflow_id:string,parent_run_id:string,task_id:string,agent_id:string,call_id:string}`.
- `agent_id` and `call_id` are always the received attempted values, never the
  values from the existing record.
- forbidden meta: idempotency key, input, output, canonical JSON, hashes,
  prompts, messages, credentials, and provider payloads.

### `ChildTaskStateError`
- code: `CHILD_TASK_STATE_ERROR`
- category: `state`
- retriable: `false`
- when: a matching durable task is running but not resident in this Harness
  instance, a persisted child-task record is malformed, or an operation is
  attempted after the continuable task begins closing or reaches terminal
  state.
- message: fixed `Child task is not available in the requested state.`
- meta: exactly the discriminated union
  `{reason:'invalid_record',task_id:string}` or
  `{reason:'recovery_required'|'closing'|'terminal',task_id:string,workflow_id:string,agent_id:string}`.
- forbidden meta: input, output, task error details, idempotency key, prompts,
  messages, credentials, and provider payloads.

### `SessionNotFoundError`
- code: `SESSION_NOT_FOUND`
- category: `session`
- retriable: `false`
- when: HarnessStorage returned undefined for an id that was expected to exist (rare; mostly internal).
- meta: `session_id: string`.

### `SessionBusyError`
- code: `SESSION_BUSY`
- category: `session`
- retriable: `true`
- when: a second concurrent run starts on the same session (sessions are serial-only), or `Session.clearHistory` / `Session.replaceHistory` is called while a run is in flight.
- meta: `session_id: string`, `reason?: 'concurrent_run' | 'history_clear_during_run' | 'history_replace_during_run'`.

### `StateError`
- code: `STATE_ERROR`
- category: `state`
- retriable: `true`
- when: HarnessStorage, context-checkpoint, or memory backend failure, or duplicate message id on `appendMessages`/`replaceMessages`. Also propagated when `createRun` fails (in which case the harness emits no spans/events for that run).
- meta: `op: 'getSession'|'invoke'|'upsertSession'|'closeSession'|'appendMessages'|'listMessages'|'clearMessages'|'replaceMessages'|'createRun'|'finishRun'|'finalizeRun'|'getRun'|'listRuns'|'appendEvents'|'listEvents'|'acquireRun'|'loadCheckpoint'|'commitCheckpoint'|'replaceCheckpoint'|'contextCheckpointWrite'|'contextCheckpointRead'|'contextCheckpointList'|'contextCheckpointDelete'|'memory.get'|'memory.set'|'memory.delete'|'memory.list'|'memory.search'`, `reason?: 'duplicate_message_id'|'terminal_run_exists'|'checkpoint_conflict'|'run_conflict'|'run_not_found'|'acquisition_conflict'|'lease_conflict'|'active_lease_requires_finalize'|'event_conflict'|'event_sequence_conflict'|'instance_closed'|string`, `adapter?: 'memory'|string`, `memory_provider?: string`.

### `WorkspaceError`
- code: `WORKSPACE_ERROR`
- category: `workspace`
- retriable: dynamic — `true` for backend failure and cleanup-pending states; `false` for invalid reference, idempotency conflict, aborted, expired, and missing checkpoint.
- when: Durable workspace lifecycle, consistency, inspection, or adapter backend failure outside quota and cleanup-specific failures.
- meta: `reason: 'idempotency_conflict'|'not_found'|'aborted'|'expired'|'missing_checkpoint'|'backend_failure'|'unsupported_operation'|'invalid_reference'|'checkpoint_conflict'|'cleanup_pending'`, `workspace_ref?: string`, `checkpoint_ref?: string`, `snapshot_ref?: string`, `run_id?: string`, `session_id?: string`.

### `WorkspaceQuotaExceededError`
- code: `WORKSPACE_QUOTA_EXCEEDED`
- category: `workspace`
- retriable: `false`
- when: A durable workspace quota would be exceeded or was exceeded during an operation that the adapter rolled back or marked orphaned.
- meta: `quota: string`, `limit?: number`, `actual?: number`, `partial?: boolean`, `workspace_ref?: string`, `run_id?: string`, `session_id?: string`.

### `WorkspaceCleanupError`
- code: `WORKSPACE_CLEANUP_ERROR`
- category: `workspace`
- retriable: `true`
- when: `cleanupWorkspace` fails after deletion cannot complete in the current attempt.
- meta: `reason: 'backend_failure'|'partial_delete'|'invalid_reference'`, `workspace_ref: string`, `remaining_refs?: readonly string[]`, `retry_after_ms?: number`.

### `OperationTimeoutError`
- code: `OPERATION_TIMEOUT`
- category: `timeout`
- retriable: `true`
- when: any timed budget elapsed.
- meta: `scope: 'run'|'model'|'tool'|'decision'|'sandbox_run'|'memory'|'workspace'|'child_task'|'evaluation_run'|'evaluation_task'|'evaluation_scorer'`, `timeout_ms: number`.

### `OperationCancelledError`
- code: `OPERATION_CANCELLED`
- category: `cancelled`
- retriable: `false`
- when: AbortSignal aborted (including pre-aborted signals at entry points).
- meta: `scope: 'run'|'workflow'|'agent'|'model'|'tool'|'sandbox'|'memory'|'workspace'|'child_task'|'evaluation'`.

Generic evaluation callbacks use these existing error classes as abort reasons.
The runner serializes terminal callback errors into the content-free
`EvaluationErrorRecord` from
[35-generic-evaluation-runs](./35-generic-evaluation-runs.md); it does not add an
evaluation-specific public error class.

### `McpProtocolError`
- code: `MCP_PROTOCOL_ERROR`
- category: `tool`
- retriable: `true`
- when: MCP connection failure, tool-list discovery failure, malformed envelope, transport error, or stdio child process death during a call.
- meta: `tool_id: string`, `transport: 'stdio'|'http'`, `phase: 'connect'|'list'|'call'`.

### `McpAuthError`
- code: `MCP_AUTH_ERROR`
- category: `tool`
- retriable: dynamic — `true` for 5xx; `false` for 401/403.
- when: MCP HTTP auth failed.
- meta: `tool_id: string`, `auth_kind: McpAuth['kind']`, `status?: number`.

### `InternalError`
- code: `INTERNAL_ERROR`
- category: `internal`
- retriable: `false`
- when: an invariant violation, bug, or unexpected throw the harness cannot classify.
- meta: free-form.

## Log codes (not error classes)

The following codes are emitted in log records but are NOT thrown as `HarnessError` instances:

- `STREAM_SUBSCRIBER_FAILED` — a run-event consumer's `take()` threw. The harness removes the subscription, logs `warn` with this code, and the run continues. See [12-streaming](./12-streaming.md) §"Subscriber failures".
- `INVALID_TRACE_CONTEXT` — `InvokeOptions.traceparent`/`tracestate` could not be extracted; the run starts a new trace.

## Cross-references

- [03-foundation](./03-foundation.md) — `HarnessError` base, categories.
- [13-public-api](./13-public-api.md) — error class export list.
- [21-durable-workspaces](./21-durable-workspaces.md) — durable workspace error semantics.
