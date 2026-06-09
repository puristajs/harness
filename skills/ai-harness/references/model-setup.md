# Model Setup

## Contents
- OpenAI Provider
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

## OpenAI Provider
Install the provider addon only when needed:

```bash
npm install @purista/harness @purista/harness-openai zod
```

Register OpenAI or an OpenAI-compatible endpoint:

```ts
import { openai } from '@purista/harness-openai'

.models({
  assistant: {
    provider: openai({
      apiKey: process.env.OPENAI_API_KEY!,
      baseURL: process.env.OPENAI_BASE_URL,
      organization: process.env.OPENAI_ORG,
      project: process.env.OPENAI_PROJECT
    }),
    model: process.env.OPENAI_MODEL ?? 'gpt-5-mini',
    capabilities: ['object', 'tool_use'],
    defaults: {
      maxTokens: 1200,
      temperature: 0.2,
      providerOptions: { reasoning_effort: 'low' }
    },
    providerOptions: { serviceTier: 'default' }
  }
})
```

Provider factory options are OpenAI SDK `ClientOptions` plus optional `client`, `harnessLogger`, `telemetry`, and `harnessTimeoutMs` for tests or adapter-level overrides.

## Anthropic Provider
Install and register Anthropic independently:

```bash
npm install @purista/harness @purista/harness-anthropic zod
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
npm install @purista/harness @purista/harness-bedrock zod
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
npm install @purista/harness @purista/harness-azure-foundry zod
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
  defaults: {
    temperature: 0.2,
    maxTokens: 1200,
    topP: 0.9,
    stopSequences: ['</final>'],
    parallelToolCalls: true,
    providerOptions: {}
  },
  providerOptions: {}
}
```

`defaults` are merged with per-call `call` options. Use `parallelToolCalls` on the alias for agent-loop defaults and direct model call overrides when needed. `call.providerOptions` overrides or extends `defaults.providerOptions` for provider-specific escape hatches.

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

## Direct Model Calls In Workflows Or Custom Agents
Workflow handlers expose `ctx.agents` and `ctx.models`. Custom agent handlers expose `ctx.models`, memory/history/session/run/signal, and validated input. The current implementation does not expose custom tool handles or skill handles on custom handler context.

```ts
.workflows(({ workflow }) => ({
  retrieve_and_answer: workflow({
    input: z.object({ question: z.string() }),
    output: z.object({ answer: z.string() }),
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
}))
```

The extra context argument is optional, but pass it in low-level model calls when you want correlation attributes on model spans.

## Multimodal Input
Model messages can include `ContentPart[]` for user and assistant content. Declare the matching input capability:

```ts
await ctx.models.vision.object({
  messages: [{
    role: 'user',
    content: [
      { kind: 'text', text: 'Extract the invoice total.' },
      { kind: 'image_url', url: invoiceUrl, mimeType: 'image/png' }
    ]
  }],
  schema: invoiceSchemaJson,
  schemaName: 'InvoiceExtraction'
}, ctx.signal)
```

Inline data parts use base64 fields. The harness does not implicitly upload sandbox files; application code or the provider adapter must convert files into supported content parts.

## Embeddings And Rerank
Embeddings and rerank are provider operations, not hidden prompt features:

```ts
const vectors = await ctx.models.retrieval.embed({
  input: ['first document', 'second document'],
  dimensions: 1536
}, ctx.signal)

const ranked = await ctx.models.ranker.rerank({
  query: 'refund policy',
  documents: [
    { id: 'a', text: 'Refunds are available for 30 days.' },
    { id: 'b', text: 'Shipping times vary by region.' }
  ],
  topN: 1
}, ctx.signal)
```

Rules enforced by the harness include non-empty input, unique rerank document ids, valid `topN`, and provider method presence.

## Provider Capability Truth
Do not declare a capability because the provider brand generally supports it. Declare it only when the concrete adapter method and selected provider model/endpoint support it. If an alias declares `embeddings` but the provider does not implement `embed`, runtime throws `ModelCapabilityError` with `reason: 'method_missing'`.
