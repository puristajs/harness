# Model Setup

## Contents
- OpenAI Provider
- Google Gemini Provider
- Anthropic Provider
- Amazon Bedrock Provider
- Azure AI Foundry Provider
- Alias Shape
- Capabilities
- Direct Model Calls In Workflows Or Custom Agents
- Multimodal Input
- Embeddings And Rerank
- Provider Capability Truth

Use this reference when configuring `.models(...)`, provider packages, direct model calls, multimodal input, embeddings, rerank, or a custom `ModelProvider`.

Provider packages do not select a schema library. Zod is the default in the
examples, while any Standard Schema validator works at Harness validation
boundaries. Model-facing TypeScript-tool input and default-loop output also
need Standard JSON Schema support; Harness projects those definitions once at
build time and adapters receive only the resulting Draft 2020-12 JSON value.

## OpenAI Provider
Install the provider addon only when needed:

```bash
npm install @purista/harness @purista/harness-openai
```

Register a native OpenAI Responses model:

```ts
import { openai } from '@purista/harness-openai'

.models({
  assistant: {
    provider: openai({
      apiKey: process.env.OPENAI_API_KEY!,
      baseURL: process.env.OPENAI_BASE_URL,
      organization: process.env.OPENAI_ORG,
      project: process.env.OPENAI_PROJECT,
      api: 'responses'
    }),
    model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
    capabilities: ['object', 'tool_use'],
    retry: true,
    defaults: {
      maxTokens: 1200,
      temperature: 0.2,
      providerOptions: { reasoning_effort: 'low' }
    },
    providerOptions: { service_tier: 'default' }
  }
})
```

Provider factory options are OpenAI SDK `ClientOptions` plus optional `api`, `chatCompletionMaxTokensParameter`, `client`, `harnessLogger`, `telemetry`, and `harnessTimeoutMs` for tests or adapter-level overrides. `api` defaults to `chat_completions`. For a compatible provider, supply its API key, `baseURL`, and model id and retain that default; the endpoint must implement each Chat Completions operation you enable. `api: 'responses'` is only for the OpenAI Responses API, including reasoning models that need function tools with `providerOptions.reasoning_effort`, such as `gpt-5.5`. Responses maps Harness `maxTokens` to `max_output_tokens` and rejects `stopSequences` because that API has no stop field. Chat Completions keeps the compatibility default `max_tokens`; set `chatCompletionMaxTokensParameter: 'max_completion_tokens'` only when the native OpenAI Chat model requires that field. If Chat Completions receives tools plus `reasoning_effort`, the adapter drops `reasoning_effort` and logs a warning.

## Google Gemini Provider
Install and register Gemini independently:

```bash
npm install @purista/harness @purista/harness-google
```

```ts
import { google } from '@purista/harness-google'

.models({
  assistant: {
    provider: google({ apiKey: process.env.GEMINI_API_KEY! }),
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    capabilities: ['object', 'tool_use', 'vision_input']
  },
  embeddings: {
    provider: google({ apiKey: process.env.GEMINI_API_KEY! }),
    model: process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-2',
    capabilities: ['embeddings']
  }
})
```

The Google adapter uses the official `@google/genai` SDK. It supports text,
structured output, function tools, streams, embeddings, and supported inline
image/audio/file input; it does not provide rerank. `GoogleFactoryOptions`
accepts official client options for Gemini API or Vertex/enterprise deployment.
Declare only capabilities verified for the concrete Google model and endpoint.

## Anthropic Provider
Install and register Anthropic independently:

```bash
npm install @purista/harness @purista/harness-anthropic
```

```ts
import { anthropic } from '@purista/harness-anthropic'

.models({
  assistant: {
    provider: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    capabilities: ['object', 'tool_use']
  }
})
```

## Amazon Bedrock Provider
Install and register Amazon Bedrock Runtime independently:

```bash
npm install @purista/harness @purista/harness-bedrock
```

```ts
import { bedrock } from '@purista/harness-bedrock'

.models({
  assistant: {
    provider: bedrock({ region: process.env.AWS_REGION ?? 'us-east-1' }),
    model: process.env.BEDROCK_MODEL ?? 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    capabilities: ['object', 'tool_use']
  }
})
```

AWS credentials come from the official AWS SDK credential chain.

## Azure AI Foundry Provider
Install and register Azure AI Foundry independently:

```bash
npm install @purista/harness @purista/harness-azure-foundry
```

```ts
import { azureFoundry } from '@purista/harness-azure-foundry'

.models({
  assistant: {
    provider: azureFoundry({
      endpoint: process.env.AZURE_AI_ENDPOINT!,
      apiKey: process.env.AZURE_AI_API_KEY!
    }),
    model: process.env.AZURE_AI_MODEL ?? 'gpt-4.1-mini',
    capabilities: ['object', 'tool_use']
  }
})
```

## Alias Shape
Each `.models(...)` entry is a `ModelAlias`:

```ts
{
  provider: modelProvider,
  model: 'provider-model-name',
  capabilities: ['text', 'object'] as const,
  retry: true,
  defaults: {
    temperature: 0.2,
    maxTokens: 1200,
    topP: 0.9,
    stopSequences: ['</final>'],
    parallelToolCalls: true,
    retry: {
      maxAttempts: 3,
      maxActiveElapsedMs: 60_000,
      maxActiveDelayMs: 20_000,
      respectRetryAfter: true,
      longRetry: 'error'
    },
    providerOptions: {}
  },
  providerOptions: {}
}
```

`defaults` are merged with per-call `call` options. Use `parallelToolCalls` on the alias for agent-loop defaults and direct model call overrides when needed. `call.providerOptions` overrides or extends `defaults.providerOptions` for provider-specific escape hatches.

## Generation Settings And Provider Options

Set the portable request settings in `defaults` or a per-call `call` object:
`maxTokens`, `temperature`, `topP`, `stopSequences`, and
`parallelToolCalls`. A call override wins over the alias default. Do not assume
every model accepts a setting just because an adapter can map it.

- `maxTokens` maps to OpenAI Chat `max_tokens` (or configured
  `max_completion_tokens`), OpenAI Responses `max_output_tokens`, Gemini
  `maxOutputTokens`, Anthropic `max_tokens`, Bedrock
  `inferenceConfig.maxTokens`, and Azure Foundry `max_tokens`. Anthropic gets
  a 1024 adapter fallback when omitted; the others preserve provider defaults.
- `temperature` and `topP` are sampling controls. Alter one, not both, unless
  the selected model documents the combination. Leave them unset for current
  Claude and reasoning-model families that reject sampling controls.
- `stopSequences` is not supported by OpenAI Responses; it is supported by
  the other first-party endpoint shapes subject to their model limits.
- `parallelToolCalls` is a model-selection preference, not Harness execution
  concurrency. Bedrock Converse has no mapping for it; use
  `defaults.maxParallelToolCalls` to bound actual application tool execution.

Use `providerOptions` only for a provider/API/model-specific documented field.
It is shallow-merged from alias-level `providerOptions`, then
`defaults.providerOptions`, then `call.providerOptions`. Do not duplicate a
typed setting there: raw-field collision precedence differs by adapter.

- OpenAI, Anthropic, Bedrock, and Azure reserve `requestOptions` for the SDK
  transport options rather than the provider request body.
- Gemini places `providerOptions.config` in the official SDK generation
  config; use it for a Gemini-only field such as `topK` only when the model
  exposes it.
- Bedrock uses `additionalModelRequestFields` for model-specific Converse
  fields. Azure model-specific pass-through fields also require the documented
  `extra-parameters: pass-through` header in `requestOptions`.

`retry` accepts `true`, `false`, or a policy object. The default is `true`.
The harness retries short transient provider failures and rate limits inside
bounded active budgets. It never sleeps for long provider `Retry-After`
windows: with the default `longRetry: 'error'` those fail immediately with
`retryKind:'none'`; with `longRetry: 'defer'` they surface as `ModelError`
metadata with `retryKind:'deferred'` and the provider-supplied `retryAfterMs`
so queues, durable workers, or application schedulers can decide what to do
(`maxDeferredDelayMs` caps the deferred window). Per-call `call.retry`
overrides alias and default retry settings. Retry policies are runtime
validated: invalid attempt counts, negative budgets, unknown `longRetry`
values, or non-boolean `retryOn` entries fail with `HarnessConfigError` before
provider execution.
Final errors after exhausted active attempts carry `retryKind:'active'` plus
attempt metadata, without inventing a synthetic `retryAfterMs`.

Model responses include `finishReason` for common control flow and may include
`outcome` for provider-specific finish/status details. Use `outcome` for
operations and provider-specific routing, not for prompt/output content.

## Capabilities
Capabilities are enforced at type level and runtime:

| Capability | Exposes / Allows |
|---|---|
| `text` | `ctx.models.alias.text(...)` |
| `text_stream` | `ctx.models.alias.textStream(...)` |
| `object` | `ctx.models.alias.object(...)` and default agent loop structured output |
| `object_stream` | `ctx.models.alias.objectStream(...)` |
| `tool_use` | tool declarations and tool-role messages |
| `vision_input` | `image` and `image_url` content parts |
| `audio_input` | `audio` content parts |
| `file_input` | `file` and `file_url` content parts |
| `embeddings` | `ctx.models.alias.embed(...)` |
| `rerank` | `ctx.models.alias.rerank(...)` |

Use `object` / `object_stream`; do not introduce `json` / `json_stream` capability names.

`text(...)` and `object(...)` are final request-response calls. Use
`textStream(...)` for text deltas and `objectStream(...)` for structured
partials inside custom handlers or workflows. An agent/workflow definition
selects its portable public update mode; `stream(...)` then exposes
`ExecutionEvent` values. Detailed model lifecycle belongs to `observe(...)`.
Frontend protocol and labels belong in a separate application adapter.

## Direct Model Calls In Workflows Or Custom Agents
Workflow handlers expose `ctx.agents` and `ctx.models`. Custom agent handlers expose `ctx.models`, memory/history/session/run/signal, and validated input. The current implementation does not expose custom tool handles or skill handles on custom handler context.

```ts
.workflow('retrieve_and_answer', {
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.string() }),
  delegation: { agents: ['answerer'] },
  handler: async (ctx) => {
      const embedding = await ctx.models.retrieval.embed(
        { input: ctx.input.question },
        ctx.signal,
        { sessionId: ctx.sessionId, runId: ctx.runId, harnessName: 'docs-ai' }
      )

      const docs = await vectorIndex.search(embedding.embeddings[0]!.vector)
      const ranked = await ctx.models.ranker.rerank(
        {
          query: ctx.input.question,
          documents: docs.map((doc) => ({ id: doc.id, text: doc.text })),
          topN: 5
        },
        ctx.signal,
        { sessionId: ctx.sessionId, runId: ctx.runId, harnessName: 'docs-ai' }
      )

      return ctx.agents.answerer({
        question: ctx.input.question,
        evidence: ranked.results.map((hit) => docs[hit.index]!.text)
      }, { signal: ctx.signal })
  }
})
```

The extra context argument is optional, but pass it in low-level model calls when you want correlation attributes on model spans.

## Multimodal Input
Model messages can include `ContentPart[]` for user and assistant content. Declare the matching input capability:

```ts
await ctx.models.vision.object(
	{
		messages: [
			{
				role: 'user',
				content: [
					{ kind: 'text', text: 'Extract the invoice total.' },
					{ kind: 'image_url', url: invoiceUrl, mimeType: 'image/png' },
				],
			},
		],
		schema: invoiceSchemaJson,
		schemaName: 'InvoiceExtraction',
	},
	ctx.signal,
)
```

Inline data parts use base64 fields. The harness does not implicitly upload sandbox files; application code or the provider adapter must convert files into supported content parts.

## Embeddings And Rerank
Embeddings and rerank are provider operations, not hidden prompt features:

```ts
const vectors = await ctx.models.retrieval.embed(
	{
		input: ['first document', 'second document'],
		dimensions: 1536,
	},
	ctx.signal,
)

const ranked = await ctx.models.ranker.rerank(
	{
		query: 'refund policy',
		documents: [
			{ id: 'a', text: 'Refunds are available for 30 days.' },
			{ id: 'b', text: 'Shipping times vary by region.' },
		],
		topN: 1,
	},
	ctx.signal,
)
```

Rules enforced by the harness include non-empty input, unique rerank document ids, valid `topN`, and provider method presence.

## Provider Capability Truth
Do not declare a capability because the provider brand generally supports it. Declare it only when the concrete adapter method and selected provider model/endpoint support it. If an alias declares `embeddings` but the provider does not implement `embed`, runtime throws `ModelCapabilityError` with `reason: 'method_missing'`.
