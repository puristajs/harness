import { HarnessConfigError, ModelCapabilityError, ModelError } from '../errors/index.js'
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OUTPUT_TYPE,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_REQUEST_STREAM,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  GEN_AI_OUTPUT_TYPE_VALUE_JSON,
  GEN_AI_OUTPUT_TYPE_VALUE_TEXT,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT
} from '@opentelemetry/semantic-conventions/incubating'
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ImageRequest,
  ImageResponse,
  ContentPart,
  ModelAlias,
  ModelCallOptions,
  ModelCapability,
  ModelToolSpec,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
  ProviderContinuation,
  RerankRequest,
  RerankResponse,
  SpeechRequest,
  SpeechResponse,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  TokenUsage,
  ToolCallSpec,
  VideoRequest,
  VideoResponse,
  VideoStreamChunk,
  VideoProviderStreamChunk,
  ProviderArtifact,
} from '../ports/model-provider.js'
import type { ArtifactReference, ArtifactStore } from '../ports/artifact-store.js'
import { telemetryErrorType, type SpanAttrs, type TelemetryShim } from '../telemetry/index.js'
import type { JsonValue } from './json.js'
import { pumpStreamThroughSpan } from './stream-pump.js'
import type {
  ModelAdmission,
  ModelAdmissionLease,
  ModelAdmissionOperation,
} from '../ports/model-admission.js'
import { modelAdmissionKey } from '../ports/model-admission.js'

export interface ModelInvokeContext {
  /** Harness instance name used for telemetry and run-event attribution. */
  harnessName?: string
  /** Session id used for telemetry and run-event attribution. */
  sessionId?: string
  /** Run id used for telemetry and run-event attribution. */
  runId?: string
  /** Workflow id when the model call belongs to a workflow run. */
  workflowId?: string
  /** Agent id when the model call belongs to an agent run. */
  agentId?: string
  /**
   * Mirrors this call's supported result events into the enclosing session
   * `RunEvent` stream. Defaults to `false`.
   *
   * `textStream(...)` and `objectStream(...)` emit consumed stream chunks;
   * `object(...)`, `embed(...)`, and `rerank(...)` emit their respective
   * completion events. The surrounding session supplies the run identity, so
   * callers can opt in without constructing or emitting events themselves.
   */
  emitRunEvents?: boolean
  /** Stable base key used when publishing generated artifacts. */
  artifactIdempotencyKey?: string
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
type ImageRequestInput = Omit<ImageRequest, 'model' | 'signal'>
type SpeechRequestInput = Omit<SpeechRequest, 'model' | 'signal'>
type VideoRequestInput = Omit<VideoRequest, 'model' | 'signal'>
type AliasCapabilities<A> = A extends { capabilities: readonly (infer C)[] } ? C : never
type HasCapability<A, C extends ModelCapability> = C extends AliasCapabilities<A> ? true : false

/** Returns whether a configured alias declares every requested capability. */
export function hasModelCapabilities(
  alias: Pick<ModelAlias, 'capabilities'>,
  capabilities: readonly ModelCapability[]
): boolean {
  return capabilities.every((capability) => alias.capabilities.includes(capability))
}
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
  | ({ role: 'assistant'; content: string | ContentPartFor<A>[]; providerContinuation?: ProviderContinuation } & ToolCallsFor<A>)
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

type ImageModelMethods = {
  /** Generates and publishes one or more images. */
  image(req: ImageRequestInput, signal: AbortSignal, ctx?: ModelInvokeContext): Promise<ImageResponse>
}

type SpeechModelMethods = {
  /** Generates and publishes speech audio. */
  speech(req: SpeechRequestInput, signal: AbortSignal, ctx?: ModelInvokeContext): Promise<SpeechResponse>
}

type VideoModelMethods = {
  /** Generates and publishes a video, waiting for the provider job to finish. */
  video(req: VideoRequestInput, signal: AbortSignal, ctx?: ModelInvokeContext): Promise<VideoResponse>
  /** Streams provider-neutral video job progress and a published terminal artifact. */
  videoStream(req: VideoRequestInput, signal: AbortSignal, ctx?: ModelInvokeContext): AsyncIterable<VideoStreamChunk>
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
  (HasCapability<A, 'rerank'> extends true ? RerankModelMethods : {}) &
  (HasCapability<A, 'image_generation'> extends true ? ImageModelMethods : {}) &
  (HasCapability<A, 'speech_generation'> extends true ? SpeechModelMethods : {}) &
  (HasCapability<A, 'video_generation'> extends true ? VideoModelMethods : {})

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
  options: { telemetry?: TelemetryShim; harnessName?: string; admission?: ModelAdmission; artifacts?: ArtifactStore } = {}
): { readonly [K in keyof M]: ModelHandle<M[K]> } {
  return Object.fromEntries(
    Object.entries(aliases).map(([aliasKey, alias]) => [aliasKey, createHandle(aliasKey, alias, options)])
  ) as unknown as { readonly [K in keyof M]: ModelHandle<M[K]> }
}

function createHandle(
  aliasKey: string,
  alias: ModelAlias,
  options: { telemetry?: TelemetryShim; harnessName?: string; admission?: ModelAdmission; artifacts?: ArtifactStore },
): ModelHandle {
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
      return withModelAdmission(options.admission, alias, 'text', signal, () =>
        withModelSpan(options, aliasKey, alias, 'text', ctx, () => alias.provider.text!(fullReq)),
      )
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
      return withModelAdmissionStream(options.admission, alias, 'text_stream', signal, () =>
        withModelStreamSpan(options, aliasKey, alias, 'text_stream', ctx, () => alias.provider.textStream!(fullReq)),
      )
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
      return withModelAdmission(options.admission, alias, 'object', signal, () =>
        withModelSpan(options, aliasKey, alias, 'object', ctx, () => alias.provider.object!(fullReq)),
      )
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
      return withModelAdmissionStream(options.admission, alias, 'object_stream', signal, () =>
        withModelStreamSpan(options, aliasKey, alias, 'object_stream', ctx, () => alias.provider.objectStream!(fullReq)),
      )
    },
    embed(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'embeddings', req)
      if (!alias.provider.embed) throw methodMissing(aliasKey, 'embed')
      const fullReq: EmbeddingRequest = {
        model: alias.model,
        input: req.input,
        ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}),
        ...(mergeCallOptions(alias, req.call) ? { call: mergeCallOptions(alias, req.call) } : {}),
        signal,
        traceparent: req.traceparent ?? options.telemetry?.currentTraceparent()
      }
      return withModelAdmission(options.admission, alias, 'embeddings', signal, () =>
        withModelSpan(options, aliasKey, alias, 'embeddings', ctx, () => alias.provider.embed!(fullReq)).then(
          (response) => validateEmbeddingResponse(aliasKey, alias, fullReq, response),
        ),
      )
    },
    rerank(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'rerank', req)
      if (!alias.provider.rerank) throw methodMissing(aliasKey, 'rerank')
      const fullReq: RerankRequest = {
        model: alias.model,
        query: req.query,
        documents: req.documents,
        ...(req.topN !== undefined ? { topN: req.topN } : {}),
        ...(mergeCallOptions(alias, req.call) ? { call: mergeCallOptions(alias, req.call) } : {}),
        signal,
        traceparent: req.traceparent ?? options.telemetry?.currentTraceparent()
      }
      return withModelAdmission(options.admission, alias, 'rerank', signal, () =>
        withModelSpan(options, aliasKey, alias, 'rerank', ctx, () => alias.provider.rerank!(fullReq)).then(
          (response) => validateRerankResponse(aliasKey, alias, fullReq, response),
        ),
      )
    },
    async image(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'image_generation', req)
      if (!alias.provider.image) throw methodMissing(aliasKey, 'image')
      const artifacts = requireArtifactStore(options.artifacts, aliasKey, 'image')
      const fullReq: ImageRequest = mediaRequest(alias, req, signal, options.telemetry)
      const response = await withModelAdmission(options.admission, alias, 'image_generation', signal, () =>
        withModelSpan(options, aliasKey, alias, 'image_generation', ctx, () => alias.provider.image!(fullReq)),
      )
      return {
        artifacts: await Promise.all(response.artifacts.map((artifact, index) => publishArtifact(
          artifacts,
          artifact,
          signal,
          ctx,
          `${aliasKey}:image:${index}`,
          options.harnessName,
        ))),
      }
    },
    async speech(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'speech_generation', req)
      if (!alias.provider.speech) throw methodMissing(aliasKey, 'speech')
      const artifacts = requireArtifactStore(options.artifacts, aliasKey, 'speech')
      const fullReq: SpeechRequest = mediaRequest(alias, req, signal, options.telemetry)
      const response = await withModelAdmission(options.admission, alias, 'speech_generation', signal, () =>
        withModelSpan(options, aliasKey, alias, 'speech_generation', ctx, () => alias.provider.speech!(fullReq)),
      )
      return { artifact: await publishArtifact(artifacts, response.artifact, signal, ctx, `${aliasKey}:speech`, options.harnessName) }
    },
    async video(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'video_generation', req)
      if (!alias.provider.video) throw methodMissing(aliasKey, 'video')
      const artifacts = requireArtifactStore(options.artifacts, aliasKey, 'video')
      const fullReq: VideoRequest = mediaRequest(alias, req, signal, options.telemetry)
      const response = await withModelAdmission(options.admission, alias, 'video_generation', signal, () =>
        withModelSpan(options, aliasKey, alias, 'video_generation', ctx, () => alias.provider.video!(fullReq)),
      )
      return { artifact: await publishArtifact(artifacts, response.artifact, signal, ctx, `${aliasKey}:video`, options.harnessName) }
    },
    videoStream(req, signal, ctx) {
      ensureCapabilities(aliasKey, alias, 'video_generation', req)
      if (!alias.provider.videoStream) throw methodMissing(aliasKey, 'videoStream')
      const artifacts = requireArtifactStore(options.artifacts, aliasKey, 'videoStream')
      const fullReq: VideoRequest = mediaRequest(alias, req, signal, options.telemetry)
      return publishVideoStream(
        withModelAdmissionStream(options.admission, alias, 'video_generation', signal, () =>
          withModelStreamSpan(options, aliasKey, alias, 'video_generation', ctx, () => alias.provider.videoStream!(fullReq)),
        ),
        artifacts,
        signal,
        ctx,
        aliasKey,
        options.harnessName,
      )
    }
  }
}

function mediaRequest<T extends ImageRequest | SpeechRequest | VideoRequest>(
  alias: ModelAlias,
  req: Omit<T, 'model' | 'signal'>,
  signal: AbortSignal,
  telemetry?: TelemetryShim,
): T {
  return {
    ...req,
    model: alias.model,
    ...(mergeCallOptions(alias, req.call) ? { call: mergeCallOptions(alias, req.call) } : {}),
    signal,
    traceparent: req.traceparent ?? telemetry?.currentTraceparent(),
  } as T
}

function requireArtifactStore(store: ArtifactStore | undefined, alias: string, method: string): ArtifactStore {
  if (store) return store
  throw new HarnessConfigError('Generated media requires an artifact store.', {
    id: alias,
    path: `models.${alias}.${method}`,
    reason: 'artifact_store_missing',
  })
}

async function publishArtifact(
  store: ArtifactStore,
  artifact: ProviderArtifact,
  signal: AbortSignal,
  ctx: ModelInvokeContext | undefined,
  suffix: string,
  harnessName?: string,
): Promise<ArtifactReference> {
  const resolvedHarnessName = ctx?.harnessName ?? harnessName
  return store.publish({
    body: artifact.body,
    mediaType: artifact.mediaType,
    ...(artifact.filename ? { filename: artifact.filename } : {}),
    ...(artifact.size !== undefined ? { size: artifact.size } : {}),
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
    scope: {
      ...(resolvedHarnessName ? { harnessName: resolvedHarnessName } : {}),
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx?.runId ? { runId: ctx.runId } : {}),
      ...(ctx?.workflowId ? { workflowId: ctx.workflowId } : {}),
      ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    },
    ...(ctx?.artifactIdempotencyKey ? { idempotencyKey: `${ctx.artifactIdempotencyKey}:${suffix}` } : {}),
    signal,
  })
}

async function* publishVideoStream(
  stream: AsyncIterable<VideoProviderStreamChunk>,
  store: ArtifactStore,
  signal: AbortSignal,
  ctx: ModelInvokeContext | undefined,
  alias: string,
  harnessName?: string,
): AsyncIterable<VideoStreamChunk> {
  for await (const chunk of stream) {
    if (chunk.kind !== 'finish') {
      yield chunk
      continue
    }
    yield {
      kind: 'finish',
      artifact: await publishArtifact(store, chunk.artifact, signal, ctx, `${alias}:video`, harnessName),
    }
  }
}

async function withModelAdmission<T>(
  admission: ModelAdmission | undefined,
  alias: ModelAlias,
  operation: ModelAdmissionOperation,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const lease = await acquireModelAdmission(admission, alias, operation, signal)
  try {
    return await run()
  } finally {
    await lease?.release()
  }
}

async function* withModelAdmissionStream<T>(
  admission: ModelAdmission | undefined,
  alias: ModelAlias,
  operation: ModelAdmissionOperation,
  signal: AbortSignal,
  run: () => AsyncIterable<T>,
): AsyncIterable<T> {
  const lease = await acquireModelAdmission(admission, alias, operation, signal)
  try {
    yield* run()
  } finally {
    await lease?.release()
  }
}

function acquireModelAdmission(
  admission: ModelAdmission | undefined,
  alias: ModelAlias,
  operation: ModelAdmissionOperation,
  signal: AbortSignal,
): Promise<ModelAdmissionLease> | undefined {
  if (!admission) return undefined
  return admission.acquire({
    ...modelAdmissionKey(alias.provider, alias.model, alias.credentialScope),
    operation,
    signal,
  })
}

/**
 * Provider-neutral guard: the number of embeddings must match the number of
 * inputs, and indices must cover every input exactly once. Protects callers
 * that associate vectors with inputs by position.
 */
function validateEmbeddingResponse(
  aliasKey: string,
  alias: ModelAlias,
  req: EmbeddingRequest,
  response: EmbeddingResponse
): EmbeddingResponse {
  const expected = Array.isArray(req.input) ? req.input.length : 1
  const indices = new Set(response.embeddings.map((item) => item.index))
  const validIndices = response.embeddings.every((item) => Number.isInteger(item.index) && item.index >= 0 && item.index < expected)
  if (response.embeddings.length !== expected || indices.size !== expected || !validIndices) {
    throw new ModelError('Embedding response does not match the request input count.', {
      provider: alias.provider.id,
      model: alias.model,
      method: 'embed',
      reason: 'embedding_count_mismatch',
      providerBody: { expected, received: response.embeddings.length, alias: aliasKey }
    })
  }
  return response
}

/**
 * Provider-neutral guard: every rerank result must reference a distinct, valid
 * document index, and the count must not exceed the requested document count
 * (or `topN` when supplied).
 */
function validateRerankResponse(
  aliasKey: string,
  alias: ModelAlias,
  req: RerankRequest,
  response: RerankResponse
): RerankResponse {
  const documentCount = req.documents.length
  const limit = req.topN !== undefined ? Math.min(req.topN, documentCount) : documentCount
  const indices = new Set(response.results.map((item) => item.index))
  const validIndices = response.results.every((item) => Number.isInteger(item.index) && item.index >= 0 && item.index < documentCount)
  if (response.results.length > limit || indices.size !== response.results.length || !validIndices) {
    throw new ModelError('Rerank response does not map back to the request documents.', {
      provider: alias.provider.id,
      model: alias.model,
      method: 'rerank',
      reason: 'rerank_result_mismatch',
      providerBody: { documentCount, limit, received: response.results.length, alias: aliasKey }
    })
  }
  return response
}

function withModelStreamSpan<T>(
  options: { telemetry?: TelemetryShim; harnessName?: string },
  aliasKey: string,
  alias: ModelAlias,
  method: ModelCapability,
  ctx: ModelInvokeContext | undefined,
  fn: () => AsyncIterable<T>
): AsyncIterable<T> {
  const telemetry = options.telemetry
  if (!telemetry) return fn()
  const started = Date.now()
  const attrs = modelSpanAttrs(options, aliasKey, alias, method, ctx)
  return pumpStreamThroughSpan(telemetry, modelSpanName(method, alias.model), attrs, async function* (span) {
    let lastUsage: TokenUsage | undefined
    let lastFinishReason: string | undefined
    let firstChunkAt: number | undefined
    let operationError: unknown
    try {
      for await (const chunk of fn()) {
        if (firstChunkAt === undefined) {
          firstChunkAt = Date.now()
          const elapsed = (firstChunkAt - started) / 1000
          span.setAttribute(ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK, elapsed)
          telemetry.recordHistogram('gen_ai.client.operation.time_to_first_chunk', elapsed, attrs)
        }
        const current = chunk as { usage?: typeof lastUsage; finishReason?: string }
        if (current.usage) lastUsage = current.usage
        if (current.finishReason) lastFinishReason = current.finishReason
        yield chunk
      }
      if (lastUsage) {
        span.setAttributes(tokenUsageSpanAttrs(lastUsage))
        recordTokenUsageMetrics(telemetry, attrs, lastUsage)
      }
      if (lastFinishReason) span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [lastFinishReason])
    } catch (error) {
      operationError = error
      throw error
    } finally {
      telemetry.recordHistogram('gen_ai.client.operation.duration', (Date.now() - started) / 1000, {
        ...attrs,
        ...(operationError === undefined ? {} : { [ATTR_ERROR_TYPE]: telemetryErrorType(operationError) })
      })
    }
  })
}

async function withModelSpan<T>(
  options: { telemetry?: TelemetryShim; harnessName?: string },
  aliasKey: string,
  alias: ModelAlias,
  method: ModelCapability,
  ctx: ModelInvokeContext | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const telemetry = options.telemetry
  if (!telemetry) return fn()
  const started = Date.now()
  const attrs = modelSpanAttrs(options, aliasKey, alias, method, ctx)

  return telemetry.span(modelSpanName(method, alias.model), attrs, async (span) => {
    let operationError: unknown
    try {
      const result = await fn()
      const usage = (result as { usage?: TokenUsage; finishReason?: string }).usage
      const finishReason = (result as { finishReason?: string }).finishReason
      if (usage) {
        span.setAttributes(tokenUsageSpanAttrs(usage))
        recordTokenUsageMetrics(telemetry, attrs, usage)
      }
      if (finishReason) span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [finishReason])
      return result
    } catch (error) {
      operationError = error
      throw error
    } finally {
      telemetry.recordHistogram('gen_ai.client.operation.duration', (Date.now() - started) / 1000, {
        ...attrs,
        ...(operationError === undefined ? {} : { [ATTR_ERROR_TYPE]: telemetryErrorType(operationError) })
      })
    }
  })
}

function tokenUsageSpanAttrs(usage: TokenUsage): SpanAttrs {
  return {
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: usage.inputTokens,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
    'gen_ai.usage.total_tokens': usage.totalTokens,
    'llm.token_count.prompt': usage.inputTokens,
    'llm.token_count.completion': usage.outputTokens,
    'llm.token_count.total': usage.totalTokens,
    ...(usage.cachedInputTokens !== undefined ? {
      [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage.cachedInputTokens,
      'llm.token_count.prompt_details.cache_read': usage.cachedInputTokens
    } : {}),
    ...(usage.cacheCreationInputTokens !== undefined ? {
      [ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: usage.cacheCreationInputTokens
    } : {}),
    ...(usage.reasoningTokens !== undefined ? {
      [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: usage.reasoningTokens,
      'llm.token_count.completion_details.reasoning': usage.reasoningTokens
    } : {})
  }
}

function recordTokenUsageMetrics(telemetry: TelemetryShim | undefined, attrs: SpanAttrs, usage: TokenUsage): void {
  telemetry?.recordHistogram('gen_ai.client.token.usage', usage.inputTokens, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT })
  telemetry?.recordHistogram('gen_ai.client.token.usage', usage.outputTokens, { ...attrs, [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT })
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
    ...(ctx?.sessionId ? { [ATTR_GEN_AI_CONVERSATION_ID]: ctx.sessionId } : {}),
    ...(isStreamingCapability(method) ? { [ATTR_GEN_AI_REQUEST_STREAM]: true } : {}),
    ...(modelOutputType(method) ? { [ATTR_GEN_AI_OUTPUT_TYPE]: modelOutputType(method) } : {}),
    'model.provider': alias.provider.id,
    'llm.provider': alias.provider.genAiSystem,
    'llm.model_name': alias.model
  }
}

function modelSpanName(method: ModelCapability, model: string): string {
  return `${genAiOperationName(method) ?? method} ${model}`
}

function isStreamingCapability(method: ModelCapability): boolean {
  return method === 'text_stream' || method === 'object_stream'
}

function modelOutputType(method: ModelCapability): string | undefined {
  if (method === 'text' || method === 'text_stream') return GEN_AI_OUTPUT_TYPE_VALUE_TEXT
  if (method === 'object' || method === 'object_stream') return GEN_AI_OUTPUT_TYPE_VALUE_JSON
  return undefined
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
  if (!hasModelCapabilities(alias, [method])) {
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
  const retry = call?.retry ?? alias.defaults?.retry ?? alias.retry
  const merged: NonNullable<ModelAlias['defaults']> = {
    ...(alias.defaults ?? {}),
    ...(call ?? {}),
    ...(retry !== undefined ? { retry } : {}),
    providerOptions: {
      ...(alias.providerOptions ?? {}),
      ...(alias.defaults?.providerOptions ?? {}),
      ...(call?.providerOptions ?? {})
    }
  }
  const hasTopLevel =
    merged.temperature !== undefined
    || merged.maxTokens !== undefined
    || merged.topP !== undefined
    || merged.stopSequences !== undefined
    || merged.parallelToolCalls !== undefined
    || merged.retry !== undefined
    || Object.keys(merged.providerOptions ?? {}).length > 0
  return hasTopLevel ? merged : undefined
}

function mergeCallOptions(alias: ModelAlias, call?: ModelCallOptions): ModelCallOptions | undefined {
  const retry = call?.retry ?? alias.defaults?.retry ?? alias.retry
  const merged: ModelCallOptions = {
    ...(call ?? {}),
    ...(retry !== undefined ? { retry } : {}),
    providerOptions: {
      ...(alias.providerOptions ?? {}),
      ...(alias.defaults?.providerOptions ?? {}),
      ...(call?.providerOptions ?? {})
    }
  }
  const hasTopLevel =
    merged.temperature !== undefined
    || merged.maxTokens !== undefined
    || merged.topP !== undefined
    || merged.stopSequences !== undefined
    || merged.parallelToolCalls !== undefined
    || merged.retry !== undefined
    || Object.keys(merged.providerOptions ?? {}).length > 0
  return hasTopLevel ? merged : undefined
}
