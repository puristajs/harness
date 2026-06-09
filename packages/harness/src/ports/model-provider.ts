import type { JsonValue } from '../models/json.js'

/**
 * Model capabilities declared by aliases in `.models(...)`.
 */
export type ModelCapability =
  /** Synchronous plain text generation. */
  'text'
  /** Streaming plain text generation. */
  | 'text_stream'
  /** Synchronous structured object generation. */
  | 'object'
  /** Streaming structured object generation. */
  | 'object_stream'
  /** Function/tool calling support. */
  | 'tool_use'
  /** Image input understanding. */
  | 'vision_input'
  /** Audio input understanding. */
  | 'audio_input'
  /** File input understanding. */
  | 'file_input'
  /** Embedding vector generation. */
  | 'embeddings'
  /** Document reranking. */
  | 'rerank'

/** Default generation parameters applied per alias. */
export interface ModelDefaults {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  /** Whether providers should allow the model to emit multiple independent tool calls in one turn. */
  parallelToolCalls?: boolean
  providerOptions?: Record<string, unknown>
}

/** Per-call generation overrides. */
export interface ModelCallOptions {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  /** Overrides whether providers should allow multiple tool calls in one model turn. */
  parallelToolCalls?: boolean
  providerOptions?: Record<string, unknown>
}

/** Tool call envelope emitted by model adapters. */
export interface ToolCallSpec {
  id: string
  name: string
  arguments: JsonValue
}

/** Multimodal message content part. */
export type ContentPart =
  /** Plain text input content. */
  | { kind: 'text'; text: string }
  /** Inline image content encoded as base64 data. */
  | { kind: 'image'; mimeType: string; dataBase64: string }
  /** Remote image reference. */
  | { kind: 'image_url'; url: string; mimeType?: string }
  /** Inline audio content encoded as base64 data. */
  | { kind: 'audio'; mimeType: string; dataBase64: string }
  /** Inline file content encoded as base64 data. */
  | { kind: 'file'; mimeType: string; dataBase64: string; filename?: string }
  /** Remote file reference. */
  | { kind: 'file_url'; url: string; mimeType?: string; filename?: string }

/** Optional data-only model feature descriptor exposed by provider packages. */
export interface ModelProviderInfo {
  providerId: string
  genAiSystem: string
  packageName?: string
  packageVersion?: string
  models?: Record<string, ModelFeatureSet>
}

/** Static capabilities known for a provider model. */
export interface ModelFeatureSet {
  capabilities: readonly ModelCapability[]
  contextWindow?: number
  maxOutputTokens?: number
  supportedInputParts?: readonly ContentPartKind[]
  supportedOutputModes?: readonly OutputMode[]
}

/** Provider-neutral input content part kinds. */
export type ContentPartKind = 'text' | 'image' | 'audio' | 'file'

/** Provider-neutral output operation modes. */
export type OutputMode = 'text' | 'object' | 'embedding' | 'rerank'

/** Message schema shared across provider adapters. */
export type ModelMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | ContentPart[]; toolCalls?: ToolCallSpec[] }
  | { role: 'tool'; toolCallId: string; content: string }

/** Base request shape for all model-provider methods. */
export interface BaseRequest {
  model: string
  messages: ModelMessage[]
  defaults?: ModelDefaults | undefined
  call?: ModelCallOptions | undefined
  signal: AbortSignal
  traceparent?: string | undefined
}

/** Token usage accounting normalized across providers. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/** Normalized finish reasons from model providers. */
export type FinishReason =
  /** Natural model stop sequence. */
  'stop'
  /** Token budget reached. */
  | 'length'
  /** Model requested tool calls. */
  | 'tool_calls'
  /** Provider content filter interrupted generation. */
  | 'content_filter'
  /** Provider or adapter error fallback. */
  | 'error'

/** Tool declaration exposed to model adapters. */
export interface ModelToolSpec {
  name: string
  description: string
  parameters: JsonValue
}

/** Request for text/text-stream model methods. */
export interface TextRequest extends BaseRequest {
  tools?: ModelToolSpec[] | undefined
}

/** Response from synchronous text generation. */
export interface TextResponse {
  content: string
  toolCalls?: ToolCallSpec[]
  usage: TokenUsage
  finishReason: FinishReason
  raw?: unknown
}

/** Stream chunk from text-stream generation. */
export type TextStreamChunk =
  | { kind: 'delta'; text: string }
  | { kind: 'tool_call'; call: ToolCallSpec }
  | { kind: 'finish'; usage: TokenUsage; finishReason: FinishReason }

/** Request for object/object-stream model methods. */
export interface ObjectRequest<T extends JsonValue = JsonValue> extends BaseRequest {
  schema: JsonValue
  schemaName?: string
  tools?: ModelToolSpec[] | undefined
}

/** Response from synchronous structured object generation. */
export interface ObjectResponse<T extends JsonValue = JsonValue> {
  object: T
  toolCalls?: ToolCallSpec[]
  usage: TokenUsage
  finishReason: FinishReason
  raw?: unknown
}

/** Stream chunk from structured object streaming. */
export type ObjectStreamChunk<T extends JsonValue = JsonValue> =
  | { kind: 'partial'; partial: JsonValue }
  | { kind: 'delta'; path: readonly (string | number)[]; value: JsonValue }
  | { kind: 'tool_call'; call: ToolCallSpec }
  | { kind: 'finish'; object: T; usage: TokenUsage; finishReason: FinishReason }

/** Request for embedding generation. */
export interface EmbeddingRequest {
  model: string
  input: string | readonly string[]
  dimensions?: number
  call?: ModelCallOptions | undefined
  signal: AbortSignal
  traceparent?: string | undefined
}

/** Response from embedding generation. */
export interface EmbeddingResponse {
  embeddings: readonly Embedding[]
  usage: TokenUsage
  raw?: unknown
}

/** Single embedding vector with input-order index. */
export interface Embedding {
  index: number
  vector: readonly number[]
}

/** Request for document reranking. */
export interface RerankRequest {
  model: string
  query: string
  documents: readonly RerankDocument[]
  topN?: number
  call?: ModelCallOptions | undefined
  signal: AbortSignal
  traceparent?: string | undefined
}

/** Rerankable document. */
export interface RerankDocument {
  id: string
  text: string
  metadata?: Record<string, JsonValue>
}

/** Response from document reranking. */
export interface RerankResponse {
  results: readonly RerankResult[]
  usage?: TokenUsage
  raw?: unknown
}

/** Single rerank result referencing one submitted document. */
export interface RerankResult {
  id: string
  index: number
  score: number
  metadata?: Record<string, JsonValue>
}

/** Provider adapter interface implemented by packages such as `@purista/harness-openai`. */
export interface ModelProvider {
  readonly id: string
  readonly genAiSystem: string
  readonly info?: ModelProviderInfo
  text?(req: TextRequest): Promise<TextResponse>
  textStream?(req: TextRequest): AsyncIterable<TextStreamChunk>
  object?<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>>
  objectStream?<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>>
  embed?(req: EmbeddingRequest): Promise<EmbeddingResponse>
  rerank?(req: RerankRequest): Promise<RerankResponse>
  close?(): Promise<void>
}

/** Alias entry used in harness model configuration. */
export interface ModelAlias {
  provider: ModelProvider
  model: string
  capabilities: readonly ModelCapability[]
  defaults?: ModelDefaults
  providerOptions?: Record<string, unknown>
}
