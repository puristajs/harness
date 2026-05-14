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
content, and model outputs are content. Operational metadata such as ids, token
counts, finish reasons, dimensions, and scores is not content.

The enum is intentionally present before content telemetry is implemented so
applications and adapters can pass a stable policy value. In v1, selecting a
non-`NO_CONTENT` mode never causes core to emit prompt, output, tool argument,
tool result, expected-output, context, file, or memory content.

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
| Sandbox exec | `harness.sandbox.exec` | `harness.*` |
| State op | `harness.state.op` | `harness.*` |
| Prompt candidate evaluation | `harness.eval.candidate` | OpenInference `EVALUATOR` in `dual`/`openinference_only` |

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
| `EVALUATOR` | Prompt candidate evaluation helper |

The harness does not emit `RETRIEVER`, `GUARDRAIL`, or `PROMPT` in v1 because
core has no retrieval store, guardrail engine, or prompt store.

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
| Cached input tokens | `gen_ai.input.usage.details.cache_read_tokens` | `llm.token_count.prompt_details.cache_read` | |
| Reasoning tokens | `gen_ai.output.usage.details.reasoning_tokens` | `llm.token_count.completion_details.reasoning` | |
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

## Sandbox and state spans

### `harness.sandbox.exec`

| Key | Type |
| --- | --- |
| `harness.exec.exit_code` | integer |
| `harness.exec.duration` | double seconds |

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

Call `recordException(err)` for the thrown error. Span status is `ERROR` on
failure and `OK` on success.

## Metrics

All durations are seconds. Token counts use unit `{token}`.

### GenAI metrics

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `gen_ai.client.token.usage` | Histogram | `{token}` | `gen_ai.provider.name`, `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.token.type` |
| `gen_ai.client.operation.duration` | Histogram | `s` | `gen_ai.provider.name`, `gen_ai.system`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.response.model`, `error.type` |

### Harness metrics

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `harness.agent.iterations` | Histogram | `1` | `harness.agent.id`, `harness.session.id`, `harness.run.id` |
| `harness.tool.duration` | Histogram | `s` | `gen_ai.tool.name`, `harness.tool.type`, `harness.run.id`, `harness.session.id` |
| `harness.run.duration` | Histogram | `s` | `harness.workflow.id`, `harness.session.id`, `error.type` |
| `harness.run.errors` | Counter | `1` | `harness.workflow.id`, `error.type` |
| `harness.events.persist_errors` | Counter | `1` | `harness.session.id`, `harness.run.id` |
| `harness.permission.denials` | Counter | `1` | `gen_ai.tool.name`, `harness.agent.id`, `harness.session.id` |
| `harness.eval.candidate.score` | Histogram | `1` | `harness.eval.candidate.id` |

No `_ms` instruments exist.

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
| `trace_id` | active OTel trace |
| `span_id` | active OTel span |
| `duration_seconds` | operation duration |
| `harness.warning.code` | warning code when applicable |

Known warning codes:

- `INVALID_TRACE_CONTEXT`

## Cross-references

- [03-foundation](./03-foundation.md)
- [09-agents](./09-agents.md)
- [10-workflows](./10-workflows.md)
- [12-streaming](./12-streaming.md)
- [19-ai-eval-core](./19-ai-eval-core.md)
