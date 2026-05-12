# Models

**Purpose.** Defines the model alias config, the `ModelProvider` port with full
TS signatures, provider feature descriptors, capability declaration and
enforcement, and `ModelDefaults`.

## Capabilities (closed enum)

```ts
type ModelCapability =
  | 'text'
  | 'text_stream'
  | 'object'
  | 'object_stream'
  | 'tool_use'
  | 'vision_input'
  | 'audio_input'
  | 'file_input'
  | 'embeddings'
  | 'rerank'
```

`tool_use`, `vision_input`, `audio_input`, and `file_input` are marker
capabilities. The other entries correspond to model-handle operations. Calling
an operation or using a content part that requires an unclaimed capability
throws [`ModelCapabilityError`](./15-error-catalog.md) before provider I/O.
Capabilities are policy: TypeScript model handles and request shapes are
projected from the declared capability list. An alias without `embeddings` does
not expose `embed`; an alias without `rerank` does not expose `rerank`; an alias
without `tool_use` cannot pass `tools` or tool-role messages; an alias without
`vision_input`, `audio_input`, or `file_input` cannot pass those content parts.

`json` and `json_stream` are no longer public capability names. Structured
output is called object generation because callers request a typed object that
validates against a schema. The implementation may keep temporary internal
aliases during migration, but public docs, exports, examples, and type tests use
`object` and `object_stream`.

## Alias config

```ts
interface ModelAlias {
  provider: ModelProvider
  model: string
  capabilities: readonly ModelCapability[]
  defaults?: ModelDefaults
  /** Free-form provider-specific options, passed to the provider unchanged. */
  providerOptions?: Record<string, unknown>
}

interface ModelDefaults {
  temperature?: number          // 0..2
  maxTokens?: number            // positive int
  topP?: number                 // 0..1
  stopSequences?: string[]
  /** Provider-specific knobs. Use this for reasoning effort, etc. */
  providerOptions?: Record<string, unknown>
}
```

Aliases are registered via `defineHarness().models({...})`. Each key is the
alias id referenced by agents (`AgentDefinition.model`) and workflow handlers.

## Provider feature descriptor

Provider packages may expose an optional data-only descriptor. It is for local
inspection, debugging, and adapter selection; it must not perform network calls.

```ts
interface ModelProviderInfo {
  providerId: string
  genAiSystem: string
  packageName?: string
  packageVersion?: string
  models?: Record<string, ModelFeatureSet>
}

interface ModelFeatureSet {
  capabilities: readonly ModelCapability[]
  contextWindow?: number
  maxOutputTokens?: number
  supportedInputParts?: readonly ContentPartKind[]
  supportedOutputModes?: readonly OutputMode[]
}

type ContentPartKind = 'text' | 'image' | 'audio' | 'file'
type OutputMode = 'text' | 'object' | 'embedding' | 'rerank'
```

Provider descriptors may be included in `harness.inspect()` output.

## `ModelProvider` port

Adapter packages SHOULD extend `BaseModelProvider` instead of implementing this
interface from scratch. The base class owns timeout/cancellation, safe logging,
tracing/metrics, error normalization, and common response validation for all
operations. Concrete adapters implement provider-specific request/response
mapping in protected methods such as `doText`, `doObject`, `doTextStream`,
`doObjectStream`, `doEmbed`, and `doRerank`.

At harness composition time, `BaseModelProvider` instances automatically inherit
the harness logger, telemetry shim, and `defaults.modelTimeoutMs` unless the
adapter explicitly set its own value.

Adapters SHOULD stay thin over official provider SDKs. Prefer passing SDK
constructor options and per-call provider options through to the official SDK
instead of recreating provider-specific features in harness code. The adapter's
main responsibility is mapping between harness-neutral request/response shapes
and the provider SDK's request/response shapes.

```ts
interface ModelProvider {
  readonly id: string
  /**
   * Provider identifier used for `gen_ai.provider.name` and legacy
   * `gen_ai.system`, e.g. 'openai', 'anthropic', 'azure.ai.openai'.
   * The harness asserts this is set when
   * emitting model-call spans. See [14-otel-conventions](./14-otel-conventions.md).
   */
  readonly genAiSystem: string
  readonly info?: ModelProviderInfo

  text?(req: TextRequest): Promise<TextResponse>
  textStream?(req: TextRequest): AsyncIterable<TextStreamChunk>

  object?<T = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>>
  objectStream?<T = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>>

  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>
  rerank?(req: RerankRequest): Promise<RerankResponse>

  close?(): Promise<void>
}

abstract class BaseModelProvider implements ModelProvider {
  readonly id: string
  readonly genAiSystem: string
  readonly info?: ModelProviderInfo
  text(req: TextRequest): Promise<TextResponse>
  textStream(req: TextRequest): AsyncIterable<TextStreamChunk>
  object<T = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>>
  objectStream<T = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>>
  embed(req: EmbeddingRequest): Promise<EmbeddingResponse>
  rerank(req: RerankRequest): Promise<RerankResponse>
}
```

## Common request shape

```ts
interface BaseRequest {
  model: string                          // resolved alias.model
  messages: ModelMessage[]
  defaults?: ModelDefaults                // resolved alias.defaults overrides
  call?: ModelCallOptions                 // per-call overrides
  signal: AbortSignal
  /** Trace context propagation. Providers treat it as opaque pass-through. */
  traceparent?: string
}

interface ModelCallOptions {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  providerOptions?: Record<string, unknown>
}

type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | ContentPart[]; toolCalls?: ToolCallSpec[] }
  | { role: 'tool'; toolCallId: string; content: string }

type ContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; dataBase64: string }
  | { kind: 'image_url'; url: string; mimeType?: string }
  | { kind: 'audio'; mimeType: string; dataBase64: string }
  | { kind: 'file'; mimeType: string; dataBase64: string; filename?: string }
  | { kind: 'file_url'; url: string; mimeType?: string; filename?: string }

interface ToolCallSpec {
  id: string
  name: string
  arguments: JsonValue
}
```

Content-part capability rules:

- `image` and `image_url` require `vision_input`.
- `audio` requires `audio_input`.
- `file` and `file_url` require `file_input`.
- Providers may reject URL parts if a specific SDK/model cannot consume remote
  URLs.
- Data-bearing parts are always omitted from persisted run-event payloads in v1.
  Telemetry content capture controls spans and span events only.
- Sandbox files are never implicitly uploaded. Applications or provider
  adapters must explicitly convert files into supported content parts.

## Text

```ts
interface TextRequest extends BaseRequest {
  tools?: ModelToolSpec[]                 // requires capability 'tool_use'
}
interface TextResponse {
  content: string
  toolCalls?: ToolCallSpec[]
  usage: TokenUsage
  finishReason: FinishReason
  raw?: unknown
}
type TextStreamChunk =
  | { kind: 'delta'; text: string }
  | { kind: 'tool_call'; call: ToolCallSpec }
  | { kind: 'finish'; usage: TokenUsage; finishReason: FinishReason }

type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'
interface TokenUsage { inputTokens: number; outputTokens: number; totalTokens: number }

interface ModelToolSpec {
  name: string
  description: string
  parameters: JsonValue                   // JSON Schema
}
```

## Object generation

```ts
interface ObjectRequest<T = JsonValue> extends BaseRequest {
  schema: JsonValue                       // JSON Schema for the response
  schemaName?: string
  tools?: ModelToolSpec[]                 // requires capability 'tool_use'
}
interface ObjectResponse<T = JsonValue> {
  object: T
  toolCalls?: ToolCallSpec[]
  usage: TokenUsage
  finishReason: FinishReason
  raw?: unknown
}
type ObjectStreamChunk<T = JsonValue> =
  | { kind: 'partial'; partial: JsonValue }
  | { kind: 'delta'; path: readonly (string | number)[]; value: JsonValue }
  | { kind: 'tool_call'; call: ToolCallSpec }
  | { kind: 'finish'; object: T; usage: TokenUsage; finishReason: FinishReason }
```

The harness validates final objects against the requested schema when a schema
validator is available in core. Provider packages may use stricter native schema
support, but harness-level validation remains the final provider-neutral guard.

## Embeddings

```ts
interface EmbeddingRequest {
  model: string
  input: string | readonly string[]
  dimensions?: number
  call?: ModelCallOptions
  signal: AbortSignal
  traceparent?: string
}

interface EmbeddingResponse {
  embeddings: readonly Embedding[]
  usage: TokenUsage
  raw?: unknown
}

interface Embedding {
  index: number
  vector: readonly number[]
}
```

Rules:

- Requires `embeddings`.
- Empty input fails validation before provider I/O.
- The response order must match input order and count.
- `dimensions`, when provided, must be a positive integer.
- Vector database storage remains outside core.

## Reranking

```ts
interface RerankRequest {
  model: string
  query: string
  documents: readonly RerankDocument[]
  topN?: number
  call?: ModelCallOptions
  signal: AbortSignal
  traceparent?: string
}

interface RerankDocument {
  id: string
  text: string
  metadata?: Record<string, JsonValue>
}

interface RerankResponse {
  results: readonly RerankResult[]
  usage?: TokenUsage
  raw?: unknown
}

interface RerankResult {
  id: string
  index: number
  score: number
  metadata?: Record<string, JsonValue>
}
```

Rules:

- Requires `rerank`.
- `query` and `documents` must be non-empty.
- Document ids must be unique.
- `topN` must be a positive integer and cannot exceed document count.
- Results must point back to submitted documents by `id` and `index`.
- Results are sorted descending by score. If a provider cannot guarantee
  ordering, the provider package sorts before returning.
- RAG pipelines remain application/workflow code, not a core abstraction.

## Models access on agent/workflow context

The context exposes `models` keyed by registered alias id. Each alias handle
exposes only the operation shapes allowed by that alias's declared capability
policy:

```ts
interface ModelHandle<A extends ModelAlias> {
  text(req: TextRequestInputFor<A>): Promise<TextResponse>
  textStream(req: TextRequestInputFor<A>): AsyncIterable<TextStreamChunk>

  object<T = JsonValue>(req: ObjectRequestInputFor<A, T>): Promise<ObjectResponse<T>>
  objectStream<T = JsonValue>(req: ObjectRequestInputFor<A, T>): AsyncIterable<ObjectStreamChunk<T>>

  embed(req: Omit<EmbeddingRequest, 'model' | 'signal'>): Promise<EmbeddingResponse>
  rerank(req: Omit<RerankRequest, 'model' | 'signal'>): Promise<RerankResponse>
}
```

The harness injects `model`, `signal`, trace context, and merged defaults per
call. If the alias does not claim the capability for the method invoked, throw
`ModelCapabilityError`. If the provider does not implement the method, throw
`ModelCapabilityError` with `meta.reason: 'method_missing'`.

The displayed `ModelHandle` is conceptual. The actual exported type omits every
method whose operation capability is absent and narrows `TextRequestInputFor`
and `ObjectRequestInputFor` by marker capabilities.

TypeScript projection is a developer-experience guard, not the only safety
mechanism. Runtime gates remain mandatory because capability arrays may be
assembled dynamically, widened by user code, or called from JavaScript.

## Capability enforcement

| Method or input                      | Required capability |
|--------------------------------------|---------------------|
| `models[alias].text`                 | `'text'`            |
| `models[alias].textStream`           | `'text_stream'`     |
| `models[alias].object`               | `'object'`          |
| `models[alias].objectStream`         | `'object_stream'`   |
| `models[alias].embed`                | `'embeddings'`      |
| `models[alias].rerank`               | `'rerank'`          |
| any call with `tools[]`              | also `'tool_use'`   |
| any call with image/image_url input  | also `'vision_input'` |
| any call with audio input            | also `'audio_input'` |
| any call with file/file_url input    | also `'file_input'` |

## Defaults resolution

Per call, the effective options are computed:

```
effective = { ...alias.defaults, ...req.call }
```

Then pass `effective.providerOptions` through verbatim. `temperature`,
`maxTokens`, `topP`, and `stopSequences` map to first-class fields on the
provider's request. `EmbeddingRequest` and `RerankRequest` receive the same
`call.providerOptions` pass-through path, but generation-only knobs may be
ignored by adapters if the provider operation does not support them.

## Errors

- `ModelCapabilityError` — alias missing capability or provider missing method.
- `ValidationError` — invalid model request or response shape detected before
  provider I/O or during provider-neutral validation.
- `ModelError` — provider-side failure (HTTP error, malformed response).
  `retriable` is `true` for 5xx/network; `false` for 4xx other than 429 (429 is
  retriable). Provider implementations MUST map "context length exceeded"
  responses (e.g. OpenAI `context_length_exceeded`) to `ModelError` with
  `meta.reason: 'context_length_exceeded'` and `retriable: false`. See the full
  reason enum in [15-error-catalog](./15-error-catalog.md).
- `OperationTimeoutError` — exceeded `defaults.modelTimeoutMs`.
- `OperationCancelledError` — abort signaled.

## Cross-references

- [02-harness-config](./02-harness-config.md) — `.models(...)` builder method.
- [09-agents](./09-agents.md) — how the default loop accesses models.
- [12-streaming](./12-streaming.md) — `RunEvent` variants for model operations.
- [14-otel-conventions](./14-otel-conventions.md) — GenAI spans and metrics.
- [15-error-catalog](./15-error-catalog.md).
