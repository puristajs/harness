# OpenTelemetry conventions

**Purpose.** Authoritative enumeration of every span, metric, attribute key,
event, and log correlation field emitted by the harness. Implementation agents
MUST emit exactly these names.

The harness emits OTel GenAI semantic conventions as the primary shape and can
also emit OpenInference attributes for interoperability. Both shapes are derived
from one internal telemetry record so paired values cannot drift.

## Tracer / meter

- Tracer name: `'@purista/harness'`
- Meter name: `'@purista/harness'`
- Tracer and meter version: `HARNESS_VERSION`

Core depends only on `@opentelemetry/api` and semantic-convention constants. It
does not initialize exporters or SDK providers.

## Telemetry flavor

```ts
type TelemetryFlavor = 'dual' | 'gen_ai_only' | 'openinference_only'
```

| Flavor | Emission |
| --- | --- |
| `dual` | Emit both OTel GenAI and OpenInference attributes where a mapping exists. Default. |
| `gen_ai_only` | Emit OTel GenAI and `harness.*` attributes only. |
| `openinference_only` | Emit OpenInference and `harness.*` attributes only. |

For OpenInference-only span kinds with no OTel equivalent (`RETRIEVER`,
`RERANKER`, `GUARDRAIL`, `EVALUATOR`, `PROMPT`), the harness emits only
OpenInference attributes in `dual` and `openinference_only`. The harness does
not invent matching `gen_ai.*` names.

## Content capture

```ts
type ContentCaptureMode = 'NO_CONTENT' | 'SPAN_ONLY' | 'EVENT_ONLY' | 'SPAN_AND_EVENT'
```

Default: env `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, else
`NO_CONTENT`.

| Mode | Span attributes | Span events |
| --- | --- | --- |
| `NO_CONTENT` | Content, tool arguments, tool results, documents, and files omitted. | No content-bearing span events are emitted by core. |
| `SPAN_ONLY` | Reserved in v1; core still omits content attributes. | No content-bearing span events are emitted by core. |
| `EVENT_ONLY` | Content attributes omitted. | Reserved in v1; core still emits no content-bearing span events. |
| `SPAN_AND_EVENT` | Reserved in v1; core still omits content attributes. | Reserved in v1; core still emits no content-bearing span events. |

Structured objects, prompts, documents, tool parameters, tool results, file
content, memory keys, memory values, memory search queries, memory search
results, and model outputs are content. Operational metadata such as ids, token
counts, finish reasons, dimensions, scores, memory hit booleans, result counts,
and hashed keys is not content.

The enum is intentionally present before broad content telemetry is implemented
so applications and adapters can pass a stable policy value. In v1, selecting a
non-`NO_CONTENT` mode causes content capture only for the memory facade rules in
[20-memory-adapters](./20-memory-adapters.md). Core still omits prompt, output,
tool argument, tool result, expected-output, context, and file content.

## Attribute value types

All OTel attribute values are one of:

| Type | Notes |
| --- | --- |
| string | UTF-8 |
| integer | 64-bit integer |
| double | floating point |
| boolean | true/false |
| string[] | OTel arrays, used only where semconv expects arrays |

Undefined values are dropped.

## Common attributes

Every harness-created span carries when available:

| Key | Type |
| --- | --- |
| `harness.name` | string |
| `harness.session.id` | string |
| `harness.run.id` | string |
| `harness.workflow.id` | string |
| `harness.agent.id` | string |

`InvokeOptions.metadata` scalar entries are emitted as
`harness.metadata.<key>` only when the metadata key and value pass the rules in
[19-ai-eval-core](./19-ai-eval-core.md).

## Span name mapping

| Harness span | Span name | Required semantic shape |
| --- | --- | --- |
| Outermost prompt/run | `harness.session.prompt` | `harness.*` |
| Workflow run | `harness.workflow.run` | `harness.*`, OpenInference `CHAIN` in `dual`/`openinference_only` |
| Agent run | `invoke_agent {agent.name}` | GenAI `invoke_agent`, OpenInference `AGENT` |
| Model call | `{operation} {request.model}` | GenAI model operation, OpenInference `LLM`/`EMBEDDING`/`RERANKER` |
| Tool call | `execute_tool {tool.name}` | GenAI `execute_tool`, OpenInference `TOOL` |
| Policy evaluation | `harness.policy.evaluate` | OpenInference `GUARDRAIL` in `dual`/`openinference_only` |
| Memory operation | `harness.memory.{operation}` | `harness.*` |
| Workspace operation | `harness.workspace.{operation}` | `harness.*` |
| Sandbox exec | `harness.sandbox.exec` | `harness.*` |
| State op | `harness.state.op` | `harness.*` |
| Prompt candidate evaluation | `harness.eval.candidate` | OpenInference `EVALUATOR` in `dual`/`openinference_only` |
| Durable runtime operation | `harness.runtime.{operation}` | `harness.*` |
| Context checkpoint operation | `harness.context_checkpoint.{operation}` | `harness.*` |
| Local sandbox operation | `harness.local_sandbox.{operation}` | `harness.*` |

## GenAI operations

The harness uses only these `gen_ai.operation.name` values:

| Operation | Used for |
| --- | --- |
| `chat` | Chat-style text and object generation implemented through chat. |
| `text_completion` | Legacy completion providers. |
| `embeddings` | Embedding model calls. |
| `generate_content` | Multimodal generation when the provider uses this operation. |
| `invoke_agent` | One harness agent invocation. |
| `execute_tool` | One tool invocation. |

`rerank` and `object_generation` are not `gen_ai.operation.name` values. Rerank
spans use OpenInference `RERANKER` plus `harness.model.method = "rerank"`.
Object generation uses the provider's underlying GenAI operation, usually
`chat`, plus `harness.model.method = "object"` or `"object_stream"`.

## OpenInference span kinds

The harness emits:

| `openinference.span.kind` | Harness operation |
| --- | --- |
| `CHAIN` | Workflow run |
| `AGENT` | Agent run |
| `LLM` | Text/object model call |
| `EMBEDDING` | Embedding model call |
| `RERANKER` | Rerank model call |
| `TOOL` | Tool call |
| `GUARDRAIL` | Optional governance policy evaluation |
| `EVALUATOR` | Prompt candidate evaluation helper |

The harness does not emit `RETRIEVER` or `PROMPT` in v1 because core has no
retrieval store or prompt store. `GUARDRAIL` is emitted only when optional
governance is configured.

## Agent span attributes

Span: `invoke_agent {agent.name}`

| Canonical field | GenAI key | OpenInference key | Harness key |
| --- | --- | --- | --- |
| Operation/kind | `gen_ai.operation.name = "invoke_agent"` | `openinference.span.kind = "AGENT"` | |
| Agent name | `gen_ai.agent.name` | `metadata.agent_name` | |
| Agent id | `gen_ai.agent.id` | `metadata.agent_id` | `harness.agent.id` |
| Agent version | `gen_ai.agent.version` when configured | `metadata.agent_version` | |
| Description | `gen_ai.agent.description` | | |
| Model alias | | | `harness.agent.model` |
| Has custom handler | | | `harness.agent.has_handler` |

## Model span attributes

Span: `{operation} {request.model}`

| Canonical field | GenAI key | OpenInference key | Harness key |
| --- | --- | --- | --- |
| Operation/kind | `gen_ai.operation.name` | `openinference.span.kind` | |
| Provider | `gen_ai.provider.name` and legacy `gen_ai.system` | `llm.provider` | |
| Request model | `gen_ai.request.model` | `llm.model_name` | |
| Response model | `gen_ai.response.model` | | |
| Temperature | `gen_ai.request.temperature` | `llm.invocation_parameters` JSON string | |
| Max tokens | `gen_ai.request.max_tokens` | `llm.invocation_parameters` JSON string | |
| Top P | `gen_ai.request.top_p` | `llm.invocation_parameters` JSON string | |
| Response id | `gen_ai.response.id` | | |
| Finish reasons | `gen_ai.response.finish_reasons` | `llm.output_messages.0.message.finish_reason` when content capture permits output attributes | |
| Input tokens | `gen_ai.usage.input_tokens` | `llm.token_count.prompt` | |
| Output tokens | `gen_ai.usage.output_tokens` | `llm.token_count.completion` | |
| Total tokens | derived sum, not a GenAI attribute | `llm.token_count.total` | |
| Cache read input tokens | `gen_ai.usage.cache_read.input_tokens` | `llm.token_count.prompt_details.cache_read` | |
| Cache creation input tokens | `gen_ai.usage.cache_creation.input_tokens` | | |
| Reasoning output tokens | `gen_ai.usage.reasoning.output_tokens` | `llm.token_count.completion_details.reasoning` | |
| Alias | | | `harness.model.alias` |
| Method | | | `harness.model.method` |

`harness.model.method` is one of
`'text' | 'text_stream' | 'object' | 'object_stream' | 'embed' | 'rerank'`.

Provider adapters must set `gen_ai.provider.name` and `gen_ai.system` to the
same provider id for v1 compatibility. `gen_ai.provider.name` is canonical;
`gen_ai.system` remains for older backends.

## Tool span attributes

Span: `execute_tool {tool.name}`

| Canonical field | GenAI key | OpenInference key | Harness key |
| --- | --- | --- | --- |
| Operation/kind | `gen_ai.operation.name = "execute_tool"` | `openinference.span.kind = "TOOL"` | |
| Tool name | `gen_ai.tool.name` | `tool.name` | |
| Tool call id | `gen_ai.tool.call.id` | `tool.call.id` | `harness.tool.call_id` |
| Tool description | | `tool.description` | |
| Tool parameters | event content when enabled | `tool.parameters` JSON string when span content enabled | |
| Tool result | event content when enabled | `output.value` JSON string when span content enabled | |
| Tool type | | | `gen_ai.tool.type`, `harness.tool.type` |
| Tool id | | | `harness.tool.id` |
| MCP server | | | `harness.mcp.server` |
| MCP tool | | | `harness.mcp.tool` |
| MCP transport | | | `harness.mcp.transport` |
| Permission mode | | | `harness.permission.mode` |
| Permission decision | | | `harness.permission.decision` |

Tool calls are represented as separate child spans. The harness must not use
only OpenInference indexed tool-call attributes on a parent LLM span.

## Governance policy span attributes

Span: `harness.policy.evaluate`

Emitted only when `.governance(...)` is configured.

| Key | Type |
| --- | --- |
| `openinference.span.kind` | string, `GUARDRAIL` in `dual`/`openinference_only` |
| `harness.policy.engine` | string |
| `harness.policy.name` | string |
| `harness.policy.version` | string |
| `harness.policy.rule_id` | string |
| `harness.policy.effect` | string, one of `allow`, `deny`, `require_approval`, `audit` |
| `harness.policy.phase` | string, `pre` or `post` |
| `harness.policy.enforced` | boolean |
| `harness.policy.mode` | string, `enforce` or `shadow` |
| `harness.policy.risk_level` | string |
| `harness.tool.id` | string |
| `harness.agent.id` | string |
| `harness.session.id` | string |
| `harness.run.id` | string |
| `error.type` | string, failure only |

Policy spans never emit raw policy input, tool input, tool output, prompts,
completion content, approval comments, headers, credentials, or sandbox output.

## Evaluator span attributes

Span: `harness.eval.candidate`

Emitted by `evaluatePromptCandidates`.

| Key | Type |
| --- | --- |
| `openinference.span.kind` | string, `EVALUATOR` |
| `harness.eval.candidate.id` | string |
| `harness.eval.item.id` | string |
| `harness.eval.score` | double |
| `harness.eval.passed` | boolean |

No prompt, input, expected output, or context content is emitted by v1 core,
regardless of `contentCaptureMode`.

## Memory span attributes

Spans: `harness.memory.get`, `harness.memory.set`, `harness.memory.delete`,
`harness.memory.list`, `harness.memory.search`.

Memory spans use only `harness.*` attributes. The harness does not emit
OpenInference `RETRIEVER` in v1 because memory search is a generic adapter
operation, not a full retrieval pipeline contract.

| Key | Type | Notes |
| --- | --- | --- |
| `harness.memory.provider` | string | `MemoryAdapter.info.id` |
| `harness.memory.operation` | string | `get`, `set`, `delete`, `list`, `search` |
| `harness.memory.scope` | string | `run`, `session`, `agent`, `user`, `tenant` |
| `harness.memory.capability` | string | Primary required capability for the operation |
| `harness.memory.key_hash` | string | SHA-256 hex of key for key-based operations |
| `harness.memory.hit` | boolean | `get` only |
| `harness.memory.result_count` | integer | `list` and `search` only |
| `harness.memory.content_captured` | boolean | true only when raw content is emitted |
| `harness.session.id` | string | when available |
| `harness.run.id` | string | when available |
| `harness.agent.id` | string | when available |
| `harness.workflow.id` | string | when available |
| `error.type` | string | failure only |

Raw memory keys, values, queries, result values, tags, metadata, user ids, and
tenant ids are content. They MUST be omitted when `contentCaptureMode` is
`NO_CONTENT`; see [20-memory-adapters](./20-memory-adapters.md) for the exact
opt-in capture behavior.

## Sandbox and state spans

### `harness.workspace.{operation}`

Workspace spans use only `harness.*` attributes. Operation is one of `start`,
`pause`, `resume`, `abort`, `cleanup`, or `inspect`.

| Key | Type | Notes |
| --- | --- | --- |
| `harness.workspace.adapter` | string | `DurableWorkspaceStore.info.id` |
| `harness.workspace.operation` | string | `start`, `pause`, `resume`, `abort`, `cleanup`, `inspect` |
| `harness.workspace.state` | string | lifecycle state returned by the adapter |
| `harness.workspace.ref_hash` | string | SHA-256 hex of `workspaceRef` |
| `harness.workspace.checkpoint_ref_hash` | string | SHA-256 hex of `checkpointRef` when available |
| `harness.workspace.persistent` | boolean | store survives process exit |
| `harness.workspace.attempt` | integer | start/pause/resume only |
| `harness.workspace.sequence` | integer | pause only |
| `harness.workflow.step_id` | string | pause only |
| `harness.workspace_store.checkpoint_ref_hash` | string | SHA-256 hex of `snapshotRef` when available |
| `harness.workspace_store.cleanup.reason` | string | cleanup reason when operation is `cleanup` |
| `harness.workspace_store.quota` | string | quota id when a quota is checked or exceeded |
| `harness.run.id` | string | when available |
| `harness.session.id` | string | when available |
| `harness.workflow.id` | string | when available |
| `harness.agent.id` | string | when available |
| `error.type` | string | failure only |

Raw workspace, checkpoint, and snapshot references are content-sensitive
operational identifiers. They are returned to callers and persisted in
checkpoint records; spans, metrics, and logs emit only hashes.

### `harness.sandbox.exec`

| Key | Type |
| --- | --- |
| `harness.exec.exit_code` | integer |
| `harness.exec.duration` | double seconds |

### `harness.runtime.{operation}`

Operation is one of `start`, `load_checkpoint`, `checkpoint`, or `finish`.

| Key | Type |
| --- | --- |
| `harness.runtime.adapter` | string |
| `harness.runtime.operation` | string |
| `harness.runtime.persistent` | boolean |
| `harness.runtime.resumed` | boolean, start only |
| `harness.runtime.attempt` | integer |
| `harness.runtime.sequence` | integer, checkpoint only |
| `harness.runtime.step_id` | string, checkpoint only |
| `harness.run.id` | string |
| `harness.run.status` | string, finish only |
| `harness.session.id` | string |
| `error.type` | string, failure only |

### `harness.context_checkpoint.{operation}`

Operation is one of `write`, `read`, `list`, or `delete`.

| Key | Type |
| --- | --- |
| `harness.context_checkpoint.adapter` | string |
| `harness.context_checkpoint.operation` | string |
| `harness.context_checkpoint.kind` | string, when available |
| `harness.context_checkpoint.ref_hash` | string, when available |
| `harness.context_checkpoint.sequence` | integer, when available |
| `harness.context_checkpoint.result_count` | integer, list only |
| `harness.context_checkpoint.limit` | integer, list only |
| `harness.context_checkpoint.payload_size_bytes` | integer, write only |
| `harness.run.id` | string, when available |
| `harness.session.id` | string, when available |
| `harness.workflow.id` | string, when available |
| `harness.agent.id` | string, when available |
| `error.type` | string, failure only |

Context checkpoint payload content is never emitted by core.

### `harness.local_sandbox.{operation}`

Operation is one of `open`, `read`, `read_text`, `write`, `remove`, `list`,
`stat`, `exists`, `mount`, or `exec`. All attribute keys use the
`harness.sandbox.*` namespace.

| Key | Type |
| --- | --- |
| `harness.sandbox.adapter` | string |
| `harness.sandbox.operation` | string |
| `harness.sandbox.exec_enabled` | boolean |
| `harness.sandbox.write_bytes` | integer, write only |
| `harness.sandbox.recursive` | boolean, list/remove only |
| `harness.sandbox.has_glob` | boolean, list only |
| `harness.sandbox.file_count` | integer, mount only |
| `harness.sandbox.has_cwd` | boolean, exec only |
| `harness.sandbox.has_stdin` | boolean, exec only |
| `harness.workspace.ref_hash` | string, open only, when bound to a durable workspace |
| `harness.run.id` | string, open only |
| `harness.session.id` | string, open only |
| `error.type` | string, failure only |

### `harness.state.op`

| Key | Type |
| --- | --- |
| `harness.state.op_name` | string |

State persistence failures are also tracked via the
`harness.events.persist_errors` counter.

## Content events

When flavor includes GenAI, model and tool spans emit OTel content events.

Legacy event names:

- `gen_ai.system.message`
- `gen_ai.user.message`
- `gen_ai.assistant.message`
- `gen_ai.tool.message`
- `gen_ai.choice`

Latest experimental event:

- `gen_ai.client.inference.operation.details`

v1 core does not emit these content events. Future implementations that add
content events must follow `contentCaptureMode` and preserve `NO_CONTENT` as the
default.

## Errors

On span failure, set:

| Key | Type |
| --- | --- |
| `error.type` | string, the `HarnessError.code` |
| `harness.error.code` | string, same as `error.type` |
| `harness.error.category` | string |
| `harness.error.retriable` | boolean |

For model/provider failures, the following sanitized operational attributes may
also be set when present in the error meta. These are diagnostic metadata, not
content: the provider body is redacted with the content-aware sanitizer, so
prompt/completion/tool content never appears regardless of content-capture mode.

| Key | Type |
| --- | --- |
| `harness.error.scope` | string |
| `harness.error.timeout_ms` | number |
| `harness.error.provider` / `harness.error.model` | string |
| `harness.error.model_provider_status` | number |
| `harness.error.model_provider_code` / `_type` / `_param` / `_request_id` / `_message` | string |
| `harness.error.model_provider_body` | string (content-redacted JSON) |
| `harness.error.model_retry_kind` | string |
| `harness.error.model_retry_after_ms` | number |
| `harness.error.model_retry_attempt` / `_max_attempts` | number |

Call `recordException(err)` for the thrown error. Span status is `ERROR` on
failure and `OK` on success.

## Metrics

All durations are seconds. Token counts use unit `{token}`.

Token usage is always attached to model spans when the provider returns usage:
GenAI keys use `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, and
`gen_ai.usage.total_tokens`; provider detail fields additionally use
`gen_ai.usage.cache_read.input_tokens`,
`gen_ai.usage.cache_creation.input_tokens`, and
`gen_ai.usage.reasoning.output_tokens` when present. OpenInference keys use
`llm.token_count.prompt`, `llm.token_count.completion`,
`llm.token_count.total`, and available prompt/completion detail fields.
Metrics are emitted in addition to those span
attributes because production backends may sample or drop spans while still
aggregating metrics.

### GenAI metrics

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `gen_ai.client.token.usage` | Histogram | `{token}` | `gen_ai.provider.name`, `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.token.type` |
| `gen_ai.client.operation.duration` | Histogram | `s` | `gen_ai.provider.name`, `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.response.model`, `error.type` |

### Harness metrics

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `harness.agent.iterations` | Histogram | `1` | `harness.agent.id`, `harness.session.id`, `harness.run.id` |
| `harness.model.retries` | Counter | `1` | `model.provider`, `model.method`, `gen_ai.request.model`, `harness.model.retry.reason` |
| `harness.model.retry.delay` | Histogram | `s` | `model.provider`, `model.method`, `gen_ai.request.model` |
| `harness.tool.duration` | Histogram | `s` | `gen_ai.tool.name`, `harness.tool.type`, `harness.run.id`, `harness.session.id` |
| `harness.run.duration` | Histogram | `s` | `harness.workflow.id`, `harness.session.id`, `error.type` |
| `harness.run.errors` | Counter | `1` | `harness.workflow.id`, `error.type` |
| `harness.events.persist_errors` | Counter | `1` | `harness.session.id`, `harness.run.id` |
| `harness.permission.denials` | Counter | `1` | `gen_ai.tool.name`, `harness.agent.id`, `harness.session.id` |
| `harness.policy.evaluations` | Counter | `1` | `harness.policy.engine`, `harness.policy.effect`, `harness.policy.enforced`, `harness.policy.mode`, `harness.policy.phase`, `harness.agent.id`, `harness.tool.id`, `error.type` |
| `harness.policy.denials` | Counter | `1` | `harness.policy.engine`, `harness.policy.rule_id`, `harness.agent.id`, `harness.tool.id` |
| `harness.approval.requests` | Counter | `1` | `harness.policy.engine`, `harness.policy.rule_id`, `harness.agent.id`, `harness.tool.id`, `harness.approval.status` |
| `harness.eval.candidate.score` | Histogram | `1` | `harness.eval.candidate.id` |
| `harness.memory.operation.duration` | Histogram | `s` | `harness.memory.provider`, `harness.memory.operation`, `harness.memory.scope`, `error.type` |
| `harness.memory.operations` | Counter | `1` | `harness.memory.provider`, `harness.memory.operation`, `harness.memory.scope`, `harness.memory.hit`, `error.type` |
| `harness.memory.search.results` | Histogram | `1` | `harness.memory.provider`, `harness.memory.scope` |
| `harness.workspace.operation.duration` | Histogram | `s` | `harness.workspace.adapter`, `harness.workspace.operation`, `harness.workspace.state`, `error.type` |
| `harness.workspace.operations` | Counter | `1` | `harness.workspace.adapter`, `harness.workspace.operation`, `harness.workspace.state`, `error.type` |
| `harness.workspace.bytes` | Histogram | `By` | `harness.workspace.adapter`, `harness.workspace.operation` |
| `harness.workspace_store.cleanup.failures` | Counter | `1` | `harness.workspace.adapter`, `harness.workspace_store.cleanup.reason`, `error.type` |
| `harness.workspace_store.quota.exceeded` | Counter | `1` | `harness.workspace.adapter`, `harness.workspace_store.quota` |
| `harness.runtime.operation.duration` | Histogram | `s` | `harness.runtime.adapter`, `harness.runtime.operation`, `error.type` |
| `harness.runtime.operations` | Counter | `1` | `harness.runtime.adapter`, `harness.runtime.operation`, `error.type` |
| `harness.context_checkpoint.operation.duration` | Histogram | `s` | `harness.context_checkpoint.adapter`, `harness.context_checkpoint.operation`, `error.type` |
| `harness.context_checkpoint.operations` | Counter | `1` | `harness.context_checkpoint.adapter`, `harness.context_checkpoint.operation`, `error.type` |
| `harness.local_sandbox.operation.duration` | Histogram | `s` | `harness.sandbox.adapter`, `harness.sandbox.operation`, `harness.sandbox.exec_enabled`, `error.type` |
| `harness.local_sandbox.operations` | Counter | `1` | `harness.sandbox.adapter`, `harness.sandbox.operation`, `harness.sandbox.exec_enabled`, `error.type` |

No `_ms` instruments exist.

Developer-defined metrics use the `Metrics` helper exposed on workflow,
custom-agent, TypeScript-tool, and memory adapter contexts. Application metric
names should use an application prefix such as `app.` or a service-specific
namespace to avoid colliding with `gen_ai.*` and `harness.*` instruments.

## Log fields

Every harness-emitted log line carries when applicable:

| Field | Source |
| --- | --- |
| `harness` | `HarnessOptions.name` |
| `session_id` | active session |
| `run_id` | active run |
| `agent_id` | active agent |
| `workflow_id` | active workflow |
| `tool_id` | active tool |
| `policy_name` | active governance policy |
| `policy_rule_id` | active governance rule |
| `trace_id` | active OTel trace |
| `span_id` | active OTel span |
| `duration_seconds` | operation duration |
| `harness.warning.code` | warning code when applicable |

Known warning codes:

- `INVALID_TRACE_CONTEXT`
- `WORKSPACE_EPHEMERAL_FALLBACK`

## Cross-references

- [03-foundation](./03-foundation.md)
- [09-agents](./09-agents.md)
- [10-workflows](./10-workflows.md)
- [12-streaming](./12-streaming.md)
- [19-ai-eval-core](./19-ai-eval-core.md)
- [21-durable-workspaces](./21-durable-workspaces.md)
