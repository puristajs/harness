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
- when: Zod or JSON Schema parse failure on tool/agent/workflow/MCP input/output, memory key/value/scope/options/query, model response shape, structured object validation, embedding/rerank input invariants, or per-call `timeoutMs` invariants.
- meta: `where: 'agent_input'|'agent_output'|'workflow_input'|'workflow_output'|'tool_input'|'tool_output'|'mcp_input'|'mcp_output'|'model_response'|'memory_key'|'memory_value'|'memory_scope'|'memory_write_options'|'memory_list_options'|'memory_search_query'|'message'|'session_history'|'invoke_options'|'eval_input'`, `issues: unknown`.

### `PermissionDeniedError`
- code: `PERMISSION_DENIED`
- category: `permission`
- retriable: `false`
- when: An enforced permission denied a tool occurrence or its combined immediate approval was rejected. This is a recoverable safe tool result, while malformed decision callbacks are terminal decision-evaluation failures.
- constructor: `PermissionDeniedError(evidence, cause?)`.
- message: fixed `Permission denied.`
- meta: exactly `{evidence: DecisionEvidence}`, validated before serialization; causes are omitted.

### `PolicyDeniedError`
- code: `POLICY_DENIED`
- category: `permission`
- retriable: `false`
- when: configured governance denied a tool call, rejected required approval, or required approval without an approval provider. Recoverable in the default loop: the harness informs the model via a tool result message and continues the run.
- constructor: `PolicyDeniedError(evidence, reason, cause?)`.
- message: fixed `Tool call denied by governance policy.`
- meta: exactly `{evidence: DecisionEvidence, reason: 'policy_deny'|'approval_rejected'|'approval_unavailable'}`, validated before serialization; causes are omitted.

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
- when: `SandboxSession.exec` is invoked on a session whose `executor === 'unavailable'` (e.g. the in-memory files-only fallback when `just-bash` is not installed).
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
- when: default loop iterations exceed the effective agent budget (`agent.maxSteps` when configured, otherwise `defaults.agentMaxIterations`).
- meta: `agent_id: string`, `reason: 'iterations_exceeded'`, `limit: number`.

### `DelegationPolicyError`
- code: `DELEGATION_POLICY_ERROR`
- category: `validation`
- retriable: `false`
- when: a workflow-local `ctx.agents.<id>(...)` call violates the workflow delegation policy or the effective delegation budgets.
- meta: `workflow_id: string`, `agent_id: string`, `reason: 'delegation_disabled'|'agent_not_allowed'|'max_child_agent_calls_exceeded'|'max_parallel_child_agent_calls_exceeded'|'max_delegation_depth_exceeded'|'model_alias_not_allowed'`, `limit?: number`, `model_alias?: string`.

### `WorkflowNotFoundError`
- code: `WORKFLOW_NOT_FOUND`
- category: `validation`
- retriable: `false`
- when: session accessed via unknown workflow id.
- meta: `workflow_id: string`.

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
- meta: `op: 'getSession'|'upsertSession'|'closeSession'|'appendMessages'|'listMessages'|'clearMessages'|'replaceMessages'|'createRun'|'finishRun'|'getRun'|'listRuns'|'appendEvents'|'listEvents'|'contextCheckpointWrite'|'contextCheckpointRead'|'contextCheckpointList'|'contextCheckpointDelete'|'memory.get'|'memory.set'|'memory.delete'|'memory.list'|'memory.search'`, `reason?: 'duplicate_message_id'|'terminal_run_exists'|'checkpoint_conflict'|string`, `adapter?: 'memory'|string`, `memory_provider?: string`.

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
- meta: `scope: 'run'|'model'|'tool'|'decision'|'sandbox_run'|'memory'|'workspace'|'evaluation_run'|'evaluation_task'|'evaluation_scorer'`, `timeout_ms: number`.

### `OperationCancelledError`
- code: `OPERATION_CANCELLED`
- category: `cancelled`
- retriable: `false`
- when: AbortSignal aborted (including pre-aborted signals at entry points).
- meta: `scope: 'run'|'workflow'|'agent'|'model'|'tool'|'sandbox'|'memory'|'workspace'|'evaluation'`.

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
