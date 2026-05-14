# Public API Overview

This page summarizes the public surface most application developers need. The
full contract is specified in [specs/13-public-api.md](../../specs/13-public-api.md).

## Packages

| Package | Purpose |
|---|---|
| `@purista/harness` | Core runtime: builder, sessions, agents, workflows, tools, sandbox, state, telemetry, errors. |
| `@purista/harness-openai` | OpenAI model provider adapter. |
| `@purista/harness-anthropic` | Anthropic model provider adapter. |
| `@purista/harness-bedrock` | Amazon Bedrock model provider adapter. |
| `@purista/harness-azure-foundry` | Azure AI Foundry model provider adapter. |

## Application API

```ts
const harness = defineHarness({ name: 'my-service' })
  .runtime(...)
  .requires(...)
  .models(...)
  .tools(...)
  .skills(...)
  .agents(...)
  .workflows(...)
  .build()

const session = await harness.getSession('tenant:user:thread')
const answer = await session.agents.answerer.prompt(input)
const report = await session.workflows.research_report.prompt(input)
await harness.shutdown()
```

`runtime(...)` and `requires(...)` are optional. Omit them for the simple
in-process default.

## Main Types

| Type | What It Represents |
|---|---|
| `Harness<S>` | Built runtime with `getSession`, `shutdown`, and `$infer`. |
| `HarnessInspection` | Data-only adapter and capability snapshot returned by `harness.inspect()`. |
| `Session<S>` | Operational context exposing `agents`, `workflows`, `history`, `memory`, `getRunSummary`, and `close`. |
| `AgentInvoker` | `prompt(input)` and `stream(input)` for direct agent runs. |
| `WorkflowInvoker` | `prompt(input)` and `stream(input)` for workflow runs. |
| `ModelProvider` | Adapter interface implemented by provider packages for text, object, multimodal, embedding, and rerank operations. |
| `StateStore` | Persistence port for sessions, runs, messages, and events. |
| `Sandbox` / `SandboxSession` | File and optional command execution boundary. |
| `ToolDefinition` | TypeScript, MCP stdio, or MCP HTTP tool config. |
| `AdapterCapability` | Stable non-model adapter capability id such as `sandbox.snapshot` or `runtime.checkpoint`. |
| `DurableRuntime` | Optional checkpoint/lease runtime contract for durable use cases. |
| `FeedbackRecord` | Optional feedback signal attached to harness-native ids. |

## Adapter Capabilities

```ts
const harness = defineHarness()
  .runtime(inMemoryDurableRuntime())
  .requires(['sandbox.fs', 'runtime.checkpoint'])
  .models(...)
  .agents(...)
  .build()

const inspection = harness.inspect()
console.log(inspection.capabilities)
```

`harness.inspect()` is synchronous and data-only. It does not open sessions,
call networks, or mutate adapters. Missing required adapter capabilities fail
during `build()` with `HarnessConfigError`.

## Tool Definitions

```mermaid
flowchart LR
  ToolDefinition --> Ts["TypeScript tool"]
  ToolDefinition --> Stdio["MCP stdio"]
  ToolDefinition --> Http["MCP HTTP"]
  Ts --> Sandbox["Sandbox context"]
  Stdio --> Sandbox
  Http --> Remote["Remote MCP server"]
```

TypeScript tools validate with Zod before and after handler execution.

MCP stdio tools:

- include `kind: 'mcp_stdio'`;
- can include `install`;
- run install and execution through the active sandbox executor.

MCP HTTP tools:

- include `kind: 'mcp_http'`;
- call a remote streamable HTTP MCP endpoint;
- support `none`, `bearer`, `oauth2`, `api_key`, and `basic` auth.

## Run Events

Streaming invokers yield `RunEvent` values:

| Event | Meaning |
|---|---|
| `run.started` | Run record exists and execution began. |
| `agent.started` / `agent.finished` | Agent lifecycle. |
| `tool.started` / `tool.finished` | Tool lifecycle and normalized errors. |
| `model.message` | Persisted model message metadata. |
| `run.finished` | Final output or serialized error. |
| `stream.overflow` | Stream buffer dropped old events. |

`model.object.partial`, `model.object`,
`model.embedding.completed`, and `model.rerank.completed` are provider-neutral
runtime events when the configured provider path supports those operations.
They remain harness events, not a Vercel stream protocol.

## Run Summary

```ts
const summary = await session.getRunSummary(runId)
```

`getRunSummary` reads the configured `StateStore` and returns status, start and
finish timestamps, model/tool/agent call counts, token totals, and any
serialized run error. It does not require an OpenTelemetry backend.

Persisted event payloads are redacted even when telemetry content capture is
enabled. Usage counts and operational metadata remain available for summaries
and dashboards.

## Invoke Options

```ts
await session.agents.answerer.prompt(input, {
  timeoutMs: 30_000,
  historyWindow: 20,
  traceparent: req.headers.get('traceparent') ?? undefined,
  tracestate: req.headers.get('tracestate') ?? undefined,
  metadata: { tenantId: 'tenant-a' }
})
```

`traceparent` and `tracestate` follow W3C Trace Context. Valid values become the
parent context for the root run span and all child spans. Invalid values are
ignored with a warning log and do not fail the run.

`metadata` is JSON-serializable scalar application context exposed to workflow
handlers and custom agent handlers. Do not put secrets, prompts, or user content
in metadata.

## Metrics

Workflow handlers, custom agent handlers, and TypeScript tool handlers receive a
scoped `ctx.metrics` helper:

```ts
interface Metrics {
  counter(name: string, value?: number, attrs?: SpanAttrs): void
  histogram(name: string, value: number, attrs?: SpanAttrs): void
  duration<T>(name: string, attrs: SpanAttrs | undefined, fn: () => Promise<T>): Promise<T>
}
```

Use it for application-owned measurements, for example queue sizes, business
outcomes, or workflow step durations. The helper records through the harness
OpenTelemetry meter and adds the active harness/session/run attributes.

Token usage remains on model spans using GenAI and OpenInference attributes.
The harness also emits token usage metrics so aggregate usage can remain
available even when trace storage samples or drops spans.

## Model Provider Operations

Provider packages implement the operations they support and declare matching
alias capabilities:

```ts
interface ModelProvider {
  text?(req: TextRequest): Promise<TextResponse>
  textStream?(req: TextRequest): AsyncIterable<TextStreamChunk>
  object?<T>(req: ObjectRequest<T>): Promise<ObjectResponse<T>>
  objectStream?<T>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>>
  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>
  rerank?(req: RerankRequest): Promise<RerankResponse>
}
```

Use `object` and `object_stream` for structured outputs. Use `embeddings` and
`rerank` for retrieval workflows; storage and retrieval policy stay outside
core.

## Error Families

All harness errors include `code`, `category`, `retriable`, `message`, and
optional `meta`.

Common codes:

- `VALIDATION_ERROR`
- `MODEL_ERROR`
- `MODEL_CAPABILITY_ERROR`
- `TOOL_ERROR`
- `TOOL_NOT_FOUND`
- `MCP_PROTOCOL_ERROR`
- `MCP_AUTH_ERROR`
- `SANDBOX_NO_EXECUTOR`
- `OPERATION_TIMEOUT`
- `OPERATION_CANCELLED`
- `SESSION_BUSY`

## Telemetry Options

```ts
defineHarness()
  .telemetry({
    flavor: 'dual',
    contentCaptureMode: 'NO_CONTENT'
  })
```

`flavor` controls emitted attribute namespaces:

| Flavor | Attributes |
|---|---|
| `dual` | GenAI and OpenInference attributes. |
| `gen_ai_only` | GenAI attributes only. |
| `openinference_only` | OpenInference attributes only. |

`contentCaptureMode` accepts `NO_CONTENT`, `SPAN_ONLY`, `EVENT_ONLY`, or
`SPAN_AND_EVENT`. The default is `NO_CONTENT`. In v1 core, all modes keep
prompt, output, tool argument/result, context, and file content out of spans,
span events, and persisted StateStore events. Memory content follows the
memory-facade capture policy: `NO_CONTENT` emits no raw memory content, while
non-`NO_CONTENT` modes opt into the bounded memory fields defined by the specs.

## Eval Helpers

```ts
import { evaluateDeterministicScorer, evaluatePromptCandidates } from '@purista/harness'

const scores = await evaluatePromptCandidates({
  candidates: [{ id: 'concise', prompt: 'Answer in one paragraph.' }],
  items: [{ id: 'item-1', input: { question: 'What changed?' } }],
  runCandidate: async (candidate, item) => runPrompt(candidate.prompt, item.input),
  scorer: async (target) => evaluateDeterministicScorer({
    type: 'contains',
    path: '/answer',
    value: 'changed'
  }, target),
  signal: new AbortController().signal
})
```

`evaluatePromptCandidates` is deterministic: it evaluates candidates in input
order, items in input order, and sorts final scores by mean score descending,
pass rate descending, then candidate id ascending.

`@purista/harness/testing` exports `evaluateDeterministicScorer(...)` for
unit-testing `regex`, `contains`, `json-schema`, and `attribute-equality`
scorers without invoking a model provider.

The `json-schema` scorer is a deterministic subset, not a full JSON Schema
draft implementation. It supports `type`, `const`, `enum`, object
`properties`, object `required`, and `additionalProperties: false`.

## OpenAI Adapter

```ts
import { openai } from '@purista/harness-openai'

const provider = openai({
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_BASE_URL
})
```

The adapter extends `BaseModelProvider`, inherits harness logger/telemetry, and
normalizes provider HTTP/network errors into `ModelError` with actionable
metadata.

## Provider Addons

The provider addons share the same harness `ModelProvider` boundary. Each
adapter is intentionally thin over the provider's official SDK and passes
provider-specific options through instead of recreating provider feature
matrices in harness code.

```ts
import { anthropic } from '@purista/harness-anthropic'
import { bedrock } from '@purista/harness-bedrock'
import { azureFoundry } from '@purista/harness-azure-foundry'

const claude = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
const aws = bedrock({ region: process.env.AWS_REGION ?? 'us-east-1' })
const azure = azureFoundry({
  endpoint: process.env.AZURE_AI_ENDPOINT!,
  apiKey: process.env.AZURE_AI_API_KEY!
})
```

Declare only the capabilities supported by the selected provider model or
endpoint. The adapter package does not infer model-specific capability truth.

## Type Inference

The builder preserves literal keys across models, tools, skills, agents, and
workflows. Invalid references, such as an agent pointing at a missing model or
tool, should fail at the builder call site.

Use `harness.$infer` for compile-time inspection of the configured surface.
