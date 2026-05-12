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
- when: `defineHarness` validation fails (schema, capability mismatch, id collision, reserved prefix, missing model alias, agent/model capability mismatch, etc.).
- meta: `path?: string` (config path), `id?: string`, `reason: string`.

### `ValidationError`
- code: `VALIDATION_ERROR`
- category: `validation`
- retriable: `false`
- when: Zod or JSON Schema parse failure on tool/agent/workflow/MCP input/output, memory key, memory value, model request/response shape, structured object validation, embedding/rerank input invariants, or per-call `timeoutMs` invariants.
- meta: `where: 'agent_input'|'agent_output'|'workflow_input'|'workflow_output'|'tool_input'|'tool_output'|'mcp_input'|'mcp_output'|'model_request'|'model_response'|'memory_key'|'memory_value'|'message'|'session_history'|'invoke_options'|'eval_input'`, `issues: unknown`.

### `PermissionDeniedError`
- code: `PERMISSION_DENIED`
- category: `permission`
- retriable: `false`
- when: An agent's permission policy denied a tool call (mode `'deny'`, an `'ask'` hook returned `'deny'`, or the hook itself failed). Recoverable in the loop: the harness informs the model via a tool result message and continues the run.
- meta: `tool_name: string`, `agent_id: string`, `reason?: 'mode_deny'|'hook_deny'|'hook_failed'`.

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

### `ModelError`
- code: `MODEL_ERROR`
- category: `model`
- retriable: dynamic — `true` for HTTP 5xx, network errors, HTTP 429; `false` for 4xx (except 429).
- when: Provider failed, or harness detected a structurally invalid response (e.g. default loop expecting `object` in an `ObjectResponse` and finding none, embedding count mismatch, rerank result id mismatch).
- meta: `provider: string`, `model: string`, `method: string`, `status?: number`, `reason?: 'http_error'|'network'|'unstructured_response'|'malformed_response'|'context_length_exceeded'|'embedding_count_mismatch'|'rerank_result_mismatch'`.

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
- when: agent calls unknown skill id.
- meta: `skill_id: string`.

### `SkillManifestError`
- code: `SKILL_MANIFEST_ERROR`
- category: `config`
- retriable: `false`
- when: `SKILL.md` invalid (missing file, invalid YAML frontmatter, name does not match config key, directory missing, reserved name).
- meta: `skill_id?: string`, `directory: string`, `reason: 'missing_skill_md'|'invalid_frontmatter'|'name_mismatch'|'directory_missing'|'reserved_name'`.

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
- when: default loop iterations > `agentMaxIterations`.
- meta: `agent_id: string`, `reason: 'iterations_exceeded'`, `limit: number`.

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
- when: StateStore returned undefined for an id that was expected to exist (rare; mostly internal).
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
- when: StateStore backend failure, or duplicate message id on `appendMessages`. Also propagated when `createRun` fails (in which case the harness emits no spans/events for that run).
- meta: `op: 'getSession'|'upsertSession'|'closeSession'|'appendMessages'|'listMessages'|'clearMessages'|'createRun'|'finishRun'|'getRun'|'listRuns'|'appendEvents'|'listEvents'`, `reason?: 'duplicate_message_id'|string`.

### `OperationTimeoutError`
- code: `OPERATION_TIMEOUT`
- category: `timeout`
- retriable: `true`
- when: any timed budget elapsed.
- meta: `scope: 'run'|'model'|'tool'|'sandbox_run'`, `timeout_ms: number`.

### `OperationCancelledError`
- code: `OPERATION_CANCELLED`
- category: `cancelled`
- retriable: `false`
- when: AbortSignal aborted (including pre-aborted signals at entry points).
- meta: `scope: 'run'|'workflow'|'agent'|'model'|'tool'|'sandbox'`.

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
- `TELEMETRY_CAPTURE_CONTENT_DEPRECATED` — both `captureContent` and `contentCaptureMode` were supplied; `contentCaptureMode` wins.
- `INVALID_TRACE_CONTEXT` — `InvokeOptions.traceparent`/`tracestate` could not be extracted; the run starts a new trace.

## Cross-references

- [03-foundation](./03-foundation.md) — `HarnessError` base, categories.
- [13-public-api](./13-public-api.md) — error class export list.
