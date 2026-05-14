import { ModelCapabilityError } from '../errors/index.js'
import {
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT
} from '@opentelemetry/semantic-conventions/incubating'
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ContentPart,
  ModelAlias,
  ModelCallOptions,
  ModelCapability,
  ModelToolSpec,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
  RerankRequest,
  RerankResponse,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  ToolCallSpec
} from '../ports/model-provider.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'
import type { JsonValue } from './json.js'

export interface ModelInvokeContext {
  harnessName: string
  sessionId: string
  runId: string
  workflowId?: string
  agentId?: string
}

interface HandleRequest {
  messages?: TextRequest['messages']
  call?: ModelCallOptions | undefined
  tools?: TextRequest['tools'] | undefined
  schema?: ObjectRequest['schema'] | undefined
  input?: EmbeddingRequest['input'] | undefined
  dimensions?: EmbeddingRequest['dimensions'] | undefined
  query?: RerankRequest['query'] | undefined
  documents?: RerankRequest['documents'] | undefined
  topN?: RerankRequest['topN'] | undefined
}

type TextPart = Extract<ContentPart, { kind: 'text' }>
type VisionPart = Extract<ContentPart, { kind: 'image' | 'image_url' }>
type AudioPart = Extract<ContentPart, { kind: 'audio' }>
type FilePart = Extract<ContentPart, { kind: 'file' | 'file_url' }>
type EmbeddingRequestInput = Omit<EmbeddingRequest, 'model' | 'signal'>
type RerankRequestInput = Omit<RerankRequest, 'model' | 'signal'>
type AliasCapabilities<A> = A extends { capabilities: readonly (infer C)[] } ? C : never
type HasCapability<A, C extends ModelCapability> = C extends AliasCapabilities<A> ? true : false
type ContentPartFor<A> =
  | TextPart
  | (HasCapability<A, 'vision_input'> extends true ? VisionPart : never)
  | (HasCapability<A, 'audio_input'> extends true ? AudioPart : never)
  | (HasCapability<A, 'file_input'> extends true ? FilePart : never)
type ToolCallsFor<A> = HasCapability<A, 'tool_use'> extends true ? { toolCalls?: ToolCallSpec[] } : { toolCalls?: never }
type ToolInputFor<A> = HasCapability<A, 'tool_use'> extends true ? { tools?: ModelToolSpec[] | undefined } : { tools?: never }
type ModelMessageFor<A> =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPartFor<A>[] }
  | ({ role: 'assistant'; content: string | ContentPartFor<A>[] } & ToolCallsFor<A>)
  | (HasCapability<A, 'tool_use'> extends true ? { role: 'tool'; toolCallId: string; content: string } : never)
type TextRequestInputFor<A> = Omit<TextRequest, 'model' | 'signal' | 'defaults' | 'messages' | 'tools'> & {
  messages: ModelMessageFor<A>[]
} & ToolInputFor<A>
type ObjectRequestInputFor<A, T extends JsonValue = JsonValue> = Omit<ObjectRequest<T>, 'model' | 'signal' | 'defaults' | 'messages' | 'tools'> & {
  messages: ModelMessageFor<A>[]
} & ToolInputFor<A>

type TextModelMethods<A> = {
  /** Executes a single text generation request. */
  text(req: TextRequestInputFor<A>, signal: AbortSignal, ctx?: ModelInvokeContext): Promise<TextResponse>
}

type TextStreamModelMethods<A> = {
  /** Executes a streaming text generation request. */
  textStream(req: TextRequestInputFor<A>, signal: AbortSignal, ctx?: ModelInvokeContext): AsyncIterable<TextStreamChunk>
}

type ObjectModelMethods<A> = {
  /** Executes a single structured object generation request. */
  object<T extends JsonValue = JsonValue>(req: ObjectRequestInputFor<A, T>, signal: AbortSignal, ctx?: ModelInvokeContext): Promise<ObjectResponse<T>>
}

type ObjectStreamModelMethods<A> = {
  /** Executes a streaming structured object generation request. */
  objectStream<T extends JsonValue = JsonValue>(req: ObjectRequestInputFor<A, T>, signal: AbortSignal, ctx?: ModelInvokeContext): AsyncIterable<ObjectStreamChunk<T>>
}

type EmbeddingModelMethods = {
  /** Generates embeddings for one or more input strings. */
  embed(req: EmbeddingRequestInput, signal: AbortSignal, ctx?: ModelInvokeContext): Promise<EmbeddingResponse>
}

type RerankModelMethods = {
  /** Reranks documents for a query. */
  rerank(req: RerankRequestInput, signal: AbortSignal, ctx?: ModelInvokeContext): Promise<RerankResponse>
}

/**
 * Bound model handle produced by {@link createModelRegistry}.
 *
 * The visible methods are a type-level projection of the alias capability
 * policy. For example, aliases without `'embeddings'` do not expose `embed`.
 */
export type ModelHandle<A extends { capabilities: readonly ModelCapability[] } = { capabilities: readonly ModelCapability[] }> =
  (HasCapability<A, 'text'> extends true ? TextModelMethods<A> : {}) &
  (HasCapability<A, 'text_stream'> extends true ? TextStreamModelMethods<A> : {}) &
  (HasCapability<A, 'object'> extends true ? ObjectModelMethods<A> : {}) &
  (HasCapability<A, 'object_stream'> extends true ? ObjectStreamModelMethods<A> : {}) &
  (HasCapability<A, 'embeddings'> extends true ? EmbeddingModelMethods : {}) &
  (HasCapability<A, 'rerank'> extends true ? RerankModelMethods : {})

/**
 * Creates per-alias model handles that enforce capability gates before provider invocation.
 *
 * @example
 * ```ts
 * const registry = createModelRegistry({
 *   assistant: { provider, model: 'gpt-4.1-mini', capabilities: ['text'] }
 * })
 * const out = await registry.assistant.text({ messages: [{ role: 'user', content: 'hi' }] }, new AbortController().signal)
 * ```
 */
export function createModelRegistry<const M extends Record<string, ModelAlias>>(
  aliases: M,
  options: { telemetry?: TelemetryShim; harnessName?: string } = {}
): { readonly [K in keyof M]: ModelHandle<M[K]> } {
  return Object.fromEntries(
    Object.entries(aliases).map(([aliasKey, alias]) => [aliasKey, createHandle(aliasKey, alias, options)])
  ) as unknown as { readonly [K in keyof M]: ModelHandle<M[K]> }
}

function createHandle(aliasKey: string, alias: ModelAlias, options: { telemetry?: TelemetryShim; harnessName?: string }): ModelHandle {
  return {
    text(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'text', req)
      if (!alias.provider.text) throw methodMissing(aliasKey, 'text')
      const fullReq: TextRequest = {
        model: alias.model,
        messages: req.messages,
        ...(req.call ? { call: req.call } : {}),
        ...(mergeDefaults(alias, req.call) ? { defaults: mergeDefaults(alias, req.call) } : {}),
        ...(req.tools ? { tools: req.tools } : {}),
        signal,
        traceparent: req.traceparent ?? options.telemetry?.currentTraceparent()
      }
      return withModelSpan(options, aliasKey, alias, 'text', ctx, () => alias.provider.text!(fullReq))
    },
    textStream(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'text_stream', req)
      if (!alias.provider.textStream) throw methodMissing(aliasKey, 'textStream')
      const fullReq: TextRequest = {
        model: alias.model,
        messages: req.messages,
        ...(req.call ? { call: req.call } : {}),
        ...(mergeDefaults(alias, req.call) ? { defaults: mergeDefaults(alias, req.call) } : {}),
        ...(req.tools ? { tools: req.tools } : {}),
        signal,
        traceparent: req.traceparent ?? options.telemetry?.currentTraceparent()
      }
      return withModelStreamSpan(options, aliasKey, alias, 'text_stream', ctx, () => alias.provider.textStream!(fullReq))
    },
    object<T extends JsonValue = JsonValue>(req: Omit<ObjectRequest<T>, 'model' | 'signal' | 'defaults'>, signal: AbortSignal, ctx?: ModelInvokeContext) {
      ensureCapabilities(aliasKey, alias, 'object', req)
      if (!alias.provider.object) throw methodMissing(aliasKey, 'object')
      const fullReq: ObjectRequest<T> = {
        model: alias.model,
        messages: req.messages,
        ...(req.call ? { call: req.call } : {}),
        ...(mergeDefaults(alias, req.call) ? { defaults: mergeDefaults(alias, req.call) } : {}),
        ...(req.tools ? { tools: req.tools } : {}),
        schema: req.schema,
        ...(req.schemaName ? { schemaName: req.schemaName } : {}),
        signal,
        traceparent: req.traceparent ?? options.telemetry?.currentTraceparent()
      }
      return withModelSpan(options, aliasKey, alias, 'object', ctx, () => alias.provider.object!(fullReq))
    },
    objectStream<T extends JsonValue = JsonValue>(req: Omit<ObjectRequest<T>, 'model' | 'signal' | 'defaults'>, signal: AbortSignal, ctx?: ModelInvokeContext) {
      ensureCapabilities(aliasKey, alias, 'object_stream', req)
      if (!alias.provider.objectStream) throw methodMissing(aliasKey, 'objectStream')
      const fullReq: ObjectRequest<T> = {
        model: alias.model,
        messages: req.messages,
        ...(req.call ? { call: req.call } : {}),
        ...(mergeDefaults(alias, req.call) ? { defaults: mergeDefaults(alias, req.call) } : {}),
        ...(req.tools ? { tools: req.tools } : {}),
        schema: req.schema,
        ...(req.schemaName ? { schemaName: req.schemaName } : {}),
        signal,
        traceparent: req.traceparent ?? options.telemetry?.currentTraceparent()
      }
      return withModelStreamSpan(options, aliasKey, alias, 'object_stream', ctx, () => alias.provider.objectStream!(fullReq))
    },
    embed(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'embeddings', req)
      if (!alias.provider.embed) throw methodMissing(aliasKey, 'embed')
      const fullReq: EmbeddingRequest = {
        model: alias.model,
        input: req.input,
        ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}),
        ...(req.call ? { call: req.call } : {}),
        signal,
        traceparent: req.traceparent ?? options.telemetry?.currentTraceparent()
      }
      return withModelSpan(options, aliasKey, alias, 'embeddings', ctx, () => alias.provider.embed!(fullReq))
    },
    rerank(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'rerank', req)
      if (!alias.provider.rerank) throw methodMissing(aliasKey, 'rerank')
      const fullReq: RerankRequest = {
        model: alias.model,
        query: req.query,
        documents: req.documents,
        ...(req.topN !== undefined ? { topN: req.topN } : {}),
        ...(req.call ? { call: req.call } : {}),
        signal,
        traceparent: req.traceparent ?? options.telemetry?.currentTraceparent()
      }
      return withModelSpan(options, aliasKey, alias, 'rerank', ctx, () => alias.provider.rerank!(fullReq))
    }
  }
}

function withModelStreamSpan<T>(
  options: { telemetry?: TelemetryShim; harnessName?: string },
  aliasKey: string,
  alias: ModelAlias,
  method: ModelCapability,
  ctx: ModelInvokeContext | undefined,
  fn: () => AsyncIterable<T>
): AsyncIterable<T> {
  if (!options.telemetry) return fn()
  const started = Date.now()
  const attrs = modelSpanAttrs(options, aliasKey, alias, method, ctx)
  return streamWithTelemetry(options.telemetry, `chat ${alias.model}`, attrs, async function* (span) {
    let lastUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined
    let lastFinishReason: string | undefined
    for await (const chunk of fn()) {
      const current = chunk as { usage?: typeof lastUsage; finishReason?: string }
      if (current.usage) lastUsage = current.usage
      if (current.finishReason) lastFinishReason = current.finishReason
      yield chunk
    }
    if (lastUsage) {
      span.setAttributes({
        [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: lastUsage.inputTokens,
        [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: lastUsage.outputTokens,
        'gen_ai.usage.total_tokens': lastUsage.totalTokens,
        'llm.token_count.prompt': lastUsage.inputTokens,
        'llm.token_count.completion': lastUsage.outputTokens,
        'llm.token_count.total': lastUsage.totalTokens
      })
      options.telemetry?.recordCounter('gen_ai.client.token.usage', lastUsage.inputTokens, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT })
      options.telemetry?.recordCounter('gen_ai.client.token.usage', lastUsage.outputTokens, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT })
    }
    if (lastFinishReason) span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [lastFinishReason])
    options.telemetry?.recordHistogram('gen_ai.client.operation.duration', (Date.now() - started) / 1000, attrs)
  })
}

async function* streamWithTelemetry<T>(
  telemetry: TelemetryShim,
  name: string,
  attrs: SpanAttrs,
  iterate: (span: Parameters<TelemetryShim['span']>[2] extends (span: infer S) => Promise<unknown> ? S : never) => AsyncIterable<T>
): AsyncIterable<T> {
  const queue: T[] = []
  let done = false
  let failure: unknown
  let notify: (() => void) | undefined
  const wake = () => {
    notify?.()
    notify = undefined
  }
  const producer = telemetry.span(name, attrs, async (span) => {
    for await (const chunk of iterate(span as never)) {
      queue.push(chunk)
      wake()
    }
  }).catch((error) => {
    failure = error
  }).finally(() => {
    done = true
    wake()
  })

  while (!done || queue.length > 0) {
    const next = queue.shift()
    if (next !== undefined) {
      yield next
      continue
    }
    if (failure) throw failure
    await new Promise<void>((resolve) => { notify = resolve })
  }

  await producer
  if (failure) throw failure
}

async function withModelSpan<T>(
  options: { telemetry?: TelemetryShim; harnessName?: string },
  aliasKey: string,
  alias: ModelAlias,
  method: ModelCapability,
  ctx: ModelInvokeContext | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!options.telemetry) return fn()
  const started = Date.now()
  const attrs = modelSpanAttrs(options, aliasKey, alias, method, ctx)

  return options.telemetry.span(`chat ${alias.model}`, attrs, async (span) => {
    const result = await fn()
    const usage = (result as { usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; finishReason?: string }).usage
    const finishReason = (result as { finishReason?: string }).finishReason
    if (usage) {
      span.setAttributes({
        [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.inputTokens,
        [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
        'gen_ai.usage.total_tokens': usage.totalTokens,
        'llm.token_count.prompt': usage.inputTokens,
        'llm.token_count.completion': usage.outputTokens,
        'llm.token_count.total': usage.totalTokens
      })
      options.telemetry?.recordCounter('gen_ai.client.token.usage', usage.inputTokens, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT })
      options.telemetry?.recordCounter('gen_ai.client.token.usage', usage.outputTokens, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT })
    }
    if (finishReason) span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [finishReason])
    options.telemetry?.recordHistogram('gen_ai.client.operation.duration', (Date.now() - started) / 1000, attrs)
    return result
  })
}

function modelSpanAttrs(
  options: { telemetry?: TelemetryShim; harnessName?: string },
  aliasKey: string,
  alias: ModelAlias,
  method: ModelCapability,
  ctx: ModelInvokeContext | undefined
): SpanAttrs {
  return {
    'harness.name': ctx?.harnessName ?? options.harnessName,
    'harness.session.id': ctx?.sessionId,
    'harness.run.id': ctx?.runId,
    'harness.workflow.id': ctx?.workflowId,
    'harness.agent.id': ctx?.agentId,
    'harness.model.alias': aliasKey,
    'harness.model.method': method,
    'gen_ai.operation.name': genAiOperationName(method),
    'openinference.span.kind': openInferenceSpanKind(method),
    [ATTR_GEN_AI_SYSTEM]: alias.provider.genAiSystem,
    'gen_ai.provider.name': alias.provider.genAiSystem,
    [ATTR_GEN_AI_REQUEST_MODEL]: alias.model,
    'model.provider': alias.provider.id,
    'llm.provider': alias.provider.genAiSystem,
    'llm.model_name': alias.model
  }
}

function genAiOperationName(method: ModelCapability): string | undefined {
  if (method === 'embeddings') return 'embeddings'
  if (method === 'rerank') return undefined
  return 'chat'
}

function openInferenceSpanKind(method: ModelCapability): string {
  if (method === 'embeddings') return 'EMBEDDING'
  if (method === 'rerank') return 'RERANKER'
  return 'LLM'
}

/**
 * Validates alias capabilities for the requested operation.
 *
 * Throws {@link ModelCapabilityError} when required capabilities are missing.
 */
function ensureCapabilities(aliasKey: string, alias: ModelAlias, method: ModelCapability, req: HandleRequest): void {
  if (!alias.capabilities.includes(method)) {
    throw new ModelCapabilityError('Model alias does not provide requested capability.', {
      alias: aliasKey,
      method,
      reason: 'missing_capability'
    })
  }

  if (req.tools && req.tools.length > 0 && !alias.capabilities.includes('tool_use')) {
    throw new ModelCapabilityError('Model alias does not support tool use.', {
      alias: aliasKey,
      method,
      reason: 'missing_capability'
    })
  }

  const parts = (req.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content : [])
  const hasImageInput = parts.some((part) => part.kind === 'image' || part.kind === 'image_url')
  if (hasImageInput && !alias.capabilities.includes('vision_input')) {
    throw new ModelCapabilityError('Model alias does not support vision input.', {
      alias: aliasKey,
      method,
      reason: 'missing_capability'
    })
  }

  const hasAudioInput = parts.some((part) => part.kind === 'audio')
  if (hasAudioInput && !alias.capabilities.includes('audio_input')) {
    throw new ModelCapabilityError('Model alias does not support audio input.', {
      alias: aliasKey,
      method,
      reason: 'missing_capability'
    })
  }

  const hasFileInput = parts.some((part) => part.kind === 'file' || part.kind === 'file_url')
  if (hasFileInput && !alias.capabilities.includes('file_input')) {
    throw new ModelCapabilityError('Model alias does not support file input.', {
      alias: aliasKey,
      method,
      reason: 'missing_capability'
    })
  }
}

/** Builds a standardized capability error when provider methods are missing. */
function methodMissing(alias: string, method: string): ModelCapabilityError {
  return new ModelCapabilityError('Model provider method is not implemented.', {
    alias,
    method,
    reason: 'method_missing'
  })
}

/** Merges alias defaults with per-call overrides. */
function mergeDefaults(alias: ModelAlias, call?: ModelCallOptions): ModelAlias['defaults'] | undefined {
  const merged: ModelAlias['defaults'] = {
    ...(alias.defaults ?? {}),
    ...(call ?? {}),
    providerOptions: {
      ...(alias.defaults?.providerOptions ?? {}),
      ...(call?.providerOptions ?? {})
    }
  }
  const hasTopLevel =
    merged.temperature !== undefined
    || merged.maxTokens !== undefined
    || merged.topP !== undefined
    || merged.stopSequences !== undefined
    || Object.keys(merged.providerOptions ?? {}).length > 0
  return hasTopLevel ? merged : undefined
}
