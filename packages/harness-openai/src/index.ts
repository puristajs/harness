import type {
  AdapterCallContext,
  BaseModelProviderOptions,
  EmbeddingRequest,
  EmbeddingResponse,
  ImageProviderResponse,
  ImageRequest,
  ModelMessage,
  ModelProvider,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
  ProviderContinuation,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  ToolCallSpec,
  TokenUsage,
  SpeechProviderResponse,
  SpeechRequest,
  VideoProviderResponse,
  VideoProviderStreamChunk,
  VideoRequest,
  JsonValue
} from '@purista/harness'
import {
  BaseModelProvider,
  ModelError,
  accumulateStreamToolCallDeltas,
  createStreamToolCallState,
  finalizeStreamToolCalls,
  isJsonValue,
  malformedResponseError,
  parseProviderJson,
  parseProviderContinuation,
  safePartialJson,
  sanitizeProviderMessage,
  toTokenUsage
} from '@purista/harness'
import OpenAI, { type ClientOptions } from 'openai'

/**
 * Configuration for the OpenAI model provider factory.
 */
export interface OpenAiFactoryOptions extends ClientOptions {
  /**
   * OpenAI API surface used for text/object generation.
   *
   * Use `responses` for reasoning models that require the Responses API for
   * function tools with reasoning effort, such as `gpt-5.5`. The default keeps
   * existing OpenAI-compatible chat-completions endpoints working.
   */
  api?: 'chat_completions' | 'responses'
  /**
   * Request field used for the Harness `maxTokens` setting on the Chat
   * Completions API. The compatibility-preserving default is `max_tokens`.
   *
   * Set `max_completion_tokens` for a native OpenAI Chat Completions model
   * that requires the newer field. Keep `max_tokens` for an
   * OpenAI-compatible endpoint unless that endpoint documents the newer
   * field. The Responses API always uses `max_output_tokens` instead.
   */
  chatCompletionMaxTokensParameter?: 'max_tokens' | 'max_completion_tokens'
  /** Optional injected client for tests or custom transport behavior. */
  client?: OpenAiClient
  /** Optional adapter-level logger override. Defaults to the harness logger when registered. */
  harnessLogger?: BaseModelProviderOptions['logger']
  /** Optional adapter-level telemetry override. Defaults to the harness telemetry shim when registered. */
  telemetry?: BaseModelProviderOptions['telemetry']
  /** Optional adapter-level timeout override. Defaults to the harness model timeout when registered. */
  harnessTimeoutMs?: number
}

/**
 * Creates an OpenAI-backed harness `ModelProvider`.
 *
 * Execution model:
 * - In-process adapter code
 * - External network calls to OpenAI chat completions or responses endpoint
 * - AsyncIterable streaming for `textStream` and `objectStream`
 *
 * @example
 * ```ts
 * import { z } from 'zod'
 * import { defineHarness } from '@purista/harness'
 * import { openai } from '@purista/harness-openai'
 *
 * const harness = defineHarness()
 *   .models({
 *     assistant: {
 *       provider: openai({ apiKey: process.env.OPENAI_API_KEY }),
 *       model: 'gpt-4.1-mini',
 *       capabilities: ['object']
 *     }
 *   })
 *   .agents({
 *     assistant: {
 *       model: 'assistant',
 *       instructions: 'Answer in one sentence.'
 *     }
 *   })
 *   .workflows({
 *     summarize: {
 *       input: z.string(),
 *       output: z.string(),
 *       delegation: { agents: ['assistant'] },
 *       handler: (ctx) => ctx.agents.assistant(ctx.input)
 *     }
 *   })
 *   .build()
 *
 * const session = await harness.getSession('demo')
 * const response = await session.workflows.summarize.run('Summarize this issue.')
 * ```
 */
export function openai(options: OpenAiFactoryOptions = {}): ModelProvider {
  return new OpenAiModelProvider(options)
}

class OpenAiModelProvider extends BaseModelProvider {
  private readonly client: OpenAiClient

  public constructor(private readonly options: OpenAiFactoryOptions) {
    super({
      id: 'openai',
      genAiSystem: 'openai',
      ...(options.harnessLogger ? { logger: options.harnessLogger } : {}),
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
      ...(options.harnessTimeoutMs !== undefined ? { timeoutMs: options.harnessTimeoutMs } : options.timeout !== undefined ? { timeoutMs: options.timeout } : {})
    })
    this.client = options.client ?? (new OpenAI(toClientOptions(options)) as unknown as OpenAiClient)
  }

  protected override async doText(req: TextRequest): Promise<TextResponse> {
      req.signal.throwIfAborted()
      if (this.options.api === 'responses') {
        const response = await createResponse(this.client, req, false, 'text')
        throwIfResponsesFailure(response, req, 'text')
        return mapResponsesTextResponse(response, req)
      }
      const response = await createChatCompletion(this.client, req, false, this.getLogger(), this.options.chatCompletionMaxTokensParameter)
      return mapChatTextResponse(response, req)
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
      req.signal.throwIfAborted()
      if (this.options.api === 'responses') {
        yield * streamResponsesText(this.client, req)
        return
      }
      const stream = await createChatCompletion(this.client, req, true, this.getLogger(), this.options.chatCompletionMaxTokensParameter)
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      let finishReason: TextResponse['finishReason'] = 'stop'
      let providerFinishReason: unknown
      const toolState = createStreamToolCallState()
      for await (const chunk of stream) {
        req.signal.throwIfAborted()
        // The usage chunk arrives with an empty choices array, so read it first.
        if (chunk.usage) {
          usage = toChatUsage(chunk.usage)
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.delta?.content) {
          yield { kind: 'delta', text: choice.delta.content }
        }
        if (choice.delta?.tool_calls) {
          accumulateStreamToolCallDeltas(toolState, choice.delta.tool_calls)
        }
        if (choice.finish_reason) {
          providerFinishReason = choice.finish_reason
          finishReason = toFinishReason(providerFinishReason)
        }
      }
      for (const call of finalizeStreamToolCalls(toolState, callContext(req, 'textStream'), MALFORMED_TOOL_ARGS_MESSAGE)) {
        yield { kind: 'tool_call', call }
      }
      yield { kind: 'finish', usage, finishReason, outcome: toOutcome(finishReason, providerFinishReason) }
  }

  protected override async doObject<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
      req.signal.throwIfAborted()
      if (this.options.api === 'responses') {
        const response = await createResponse(this.client, req, false, 'object')
        throwIfResponsesFailure(response, req, 'object')
        const content = extractResponsesText(response)
        const toolCalls = extractResponsesToolCalls(response, req, 'object')
        const providerContinuation = toResponsesProviderContinuation(response.output, toolCalls, req, 'object')
        return {
        object: parseJson(content || '{}', req, 'object') as T,
        ...(toolCalls ? { toolCalls } : {}),
        ...(providerContinuation ? { providerContinuation } : {}),
        usage: toResponsesUsage(response.usage),
        finishReason: toResponsesFinishReason(response),
        outcome: toResponsesOutcome(response),
        raw: response
      }
      }
      const response = await createChatCompletion(this.client, req, false, this.getLogger(), this.options.chatCompletionMaxTokensParameter)
      const textContent = response.choices[0]?.message?.content ?? '{}'
      const toolCalls = extractChatToolCalls(response, req, 'object')
      return {
        object: parseJson(textContent, req, 'object') as T,
        ...(toolCalls ? { toolCalls } : {}),
        usage: toChatUsage(response.usage),
        finishReason: toFinishReason(response.choices[0]?.finish_reason),
        outcome: toOutcome(toFinishReason(response.choices[0]?.finish_reason), response.choices[0]?.finish_reason),
        raw: response
      }
  }

  protected override async *doObjectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
      req.signal.throwIfAborted()
      let partial = ''
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      let finishReason: TextResponse['finishReason'] = 'stop'
      let providerFinishReason: unknown
      const toolState = createStreamToolCallState()
      if (this.options.api === 'responses') {
        yield * streamResponsesObject<T>(this.client, req)
        return
      }
      const stream = await createChatCompletion(this.client, req, true, this.getLogger(), this.options.chatCompletionMaxTokensParameter)
      for await (const chunk of stream) {
        req.signal.throwIfAborted()
        if (chunk.usage) {
          usage = toChatUsage(chunk.usage)
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.delta?.content) {
          partial += choice.delta.content
          yield { kind: 'partial', partial: safePartialJson(partial) }
        }
        if (choice.delta?.tool_calls) {
          accumulateStreamToolCallDeltas(toolState, choice.delta.tool_calls)
        }
        if (choice.finish_reason) {
          providerFinishReason = choice.finish_reason
          finishReason = toFinishReason(providerFinishReason)
        }
      }
      for (const call of finalizeStreamToolCalls(toolState, callContext(req, 'objectStream'), MALFORMED_TOOL_ARGS_MESSAGE)) {
        yield { kind: 'tool_call', call }
      }
      const object = parseJson(partial || '{}', req, 'objectStream') as T
      yield { kind: 'finish', object, usage, finishReason, outcome: toOutcome(finishReason, providerFinishReason) }
  }

  protected override async doEmbed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    req.signal.throwIfAborted()
    const providerOptions = {
      ...(req.call?.providerOptions ?? {})
    } as Record<string, unknown> & { requestOptions?: Record<string, unknown> }
    const { requestOptions, ...bodyOptions } = providerOptions
    const response = await this.client.embeddings.create({
      model: req.model,
      input: req.input,
      ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}),
      ...bodyOptions
    }, { ...requestOptions, signal: req.signal })

    return {
      embeddings: response.data.map((item: any) => ({ index: item.index, vector: item.embedding })),
      usage: toTokenUsage(response.usage?.prompt_tokens, 0),
      raw: response
    }
  }

  protected override async doImage(req: ImageRequest): Promise<ImageProviderResponse> {
    req.signal.throwIfAborted()
    if (!this.client.images) throw this.methodMissing('image')
    const { requestOptions, ...bodyOptions } = mediaProviderOptions(req)
    const response = await this.client.images.generate({
      model: req.model,
      prompt: req.prompt,
      ...(req.count !== undefined ? { n: req.count } : {}),
      ...(req.size ? { size: req.size } : {}),
      ...(req.outputFormat ? { output_format: req.outputFormat } : {}),
      ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
      ...bodyOptions,
    }, { ...requestOptions, signal: req.signal })
    const mediaType = imageMediaType(req.outputFormat)
    const artifacts = await Promise.all((response.data ?? []).map(async (item: any, index: number) => ({
      body: await openAiMediaBody(item, req.signal),
      mediaType,
      filename: `image-${index + 1}.${imageExtension(mediaType)}`,
    })))
    if (artifacts.length === 0) {
      throw malformedResponseError(callContext(req, 'image'), 'OpenAI returned no generated image.', response, undefined)
    }
    return { artifacts, raw: response }
  }

  protected override async doSpeech(req: SpeechRequest): Promise<SpeechProviderResponse> {
    req.signal.throwIfAborted()
    if (!this.client.audio?.speech) throw this.methodMissing('speech')
    const { requestOptions, ...bodyOptions } = mediaProviderOptions(req)
    const outputFormat = req.outputFormat ?? 'mp3'
    const response = await this.client.audio.speech.create({
      model: req.model,
      input: req.text,
      voice: req.voice ?? 'alloy',
      ...(req.instructions ? { instructions: req.instructions } : {}),
      ...(req.speed !== undefined ? { speed: req.speed } : {}),
      response_format: outputFormat,
      ...bodyOptions,
    }, { ...requestOptions, signal: req.signal })
    const body = new Uint8Array(await response.arrayBuffer())
    return {
      artifact: {
        body,
        mediaType: audioMediaType(outputFormat),
        filename: `speech.${outputFormat}`,
        size: body.byteLength,
      },
    }
  }

  protected override async doVideo(req: VideoRequest): Promise<VideoProviderResponse> {
    for await (const chunk of this.doVideoStream(req)) {
      if (chunk.kind === 'finish') return { artifact: chunk.artifact, ...(chunk.raw ? { raw: chunk.raw } : {}) }
    }
    throw malformedResponseError(callContext(req, 'video'), 'OpenAI video generation ended without an artifact.', {}, undefined)
  }

  protected override async *doVideoStream(req: VideoRequest): AsyncIterable<VideoProviderStreamChunk> {
    req.signal.throwIfAborted()
    if (!this.client.videos) throw this.methodMissing('videoStream')
    const { requestOptions, pollIntervalMs, ...bodyOptions } = mediaProviderOptions(req)
    const inputReference = req.inputReference ? await toOpenAiVideoReference(req.inputReference, req.signal) : undefined
    let job = await this.client.videos.create({
      model: req.model,
      prompt: req.prompt,
      ...(inputReference ? { input_reference: inputReference } : {}),
      ...(req.durationSeconds !== undefined ? { seconds: String(req.durationSeconds) } : {}),
      ...(req.size ? { size: req.size } : {}),
      ...bodyOptions,
    }, { ...requestOptions, signal: req.signal })
    yield { kind: 'queued' }
    let lastProgress = -1
    while (job?.status !== 'completed') {
      req.signal.throwIfAborted()
      if (job?.status === 'failed' || job?.error) {
        throw new ModelError('OpenAI video generation failed.', {
          provider: 'openai',
          model: req.model,
          method: 'video',
          reason: 'provider_unavailable',
          ...(typeof job?.error?.code === 'string' ? { providerCode: job.error.code } : {}),
          ...(typeof job?.error?.message === 'string' ? { providerMessage: sanitizeProviderMessage(job.error.message) } : {}),
        })
      }
      const progress = typeof job?.progress === 'number' ? Math.max(0, Math.min(100, job.progress)) : undefined
      if (progress !== undefined && progress !== lastProgress) {
        lastProgress = progress
        yield { kind: 'progress', progress }
      }
      await abortableDelay(normalizePollInterval(pollIntervalMs), req.signal)
      job = await this.client.videos.retrieve(String(job.id), { ...requestOptions, signal: req.signal })
    }
    const response = await this.client.videos.downloadContent(String(job.id), undefined, { ...requestOptions, signal: req.signal })
    const body = new Uint8Array(await response.arrayBuffer())
    yield {
      kind: 'finish',
      artifact: { body, mediaType: 'video/mp4', filename: `${String(job.id)}.mp4`, size: body.byteLength },
      raw: job,
    }
  }
}

type ChatRequest = TextRequest | ObjectRequest
type OpenAiRequest = ChatRequest | ImageRequest | SpeechRequest | VideoRequest

/** Narrow OpenAI SDK surface accepted for test or custom transport injection. */
export type OpenAiClient = {
  /** Chat Completions API operations used by the adapter. */
  chat: {
    completions: {
      create(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
    }
  }
  /** Optional Responses API operations used when Responses mode is selected. */
  responses?: {
    create(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
  }
  /** Embeddings API operations used by embedding model bindings. */
  embeddings: {
    create(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
  }
  /** Optional Images API operations used by image-generation bindings. */
  images?: {
    generate(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
  }
  /** Optional Audio API operations used by speech-generation bindings. */
  audio?: {
    speech?: {
      create(payload: unknown, options?: { signal?: AbortSignal }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
    }
  }
  /** Optional Videos API operations used by video-generation bindings. */
  videos?: {
    create(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
    retrieve(id: string, options?: { signal?: AbortSignal }): Promise<any>
    downloadContent(id: string, query?: unknown, options?: { signal?: AbortSignal }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
  }
}

function mediaProviderOptions(req: ImageRequest | SpeechRequest | VideoRequest): Record<string, any> & {
  requestOptions?: Record<string, unknown>
  pollIntervalMs?: number
} {
  return { ...(req.call?.providerOptions ?? {}) }
}

async function openAiMediaBody(item: any, signal: AbortSignal): Promise<Uint8Array> {
  if (typeof item?.b64_json === 'string') return new Uint8Array(Buffer.from(item.b64_json, 'base64'))
  if (typeof item?.url === 'string') {
    const response = await fetch(item.url, { signal })
    if (!response.ok) throw new Error(`OpenAI media download failed with HTTP ${response.status}.`)
    return new Uint8Array(await response.arrayBuffer())
  }
  throw new Error('OpenAI media response contains neither base64 data nor a URL.')
}

function imageMediaType(format: string | undefined): string {
  switch (format?.toLowerCase()) {
    case 'jpeg':
    case 'jpg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    default: return 'image/png'
  }
}

function imageExtension(mediaType: string): string {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)
}

function audioMediaType(format: string): string {
  switch (format.toLowerCase()) {
    case 'mp3': return 'audio/mpeg'
    case 'opus': return 'audio/opus'
    case 'aac': return 'audio/aac'
    case 'flac': return 'audio/flac'
    case 'wav': return 'audio/wav'
    case 'pcm': return 'audio/L16'
    default: return `audio/${format.toLowerCase()}`
  }
}

async function toOpenAiVideoReference(
  input: NonNullable<VideoRequest['inputReference']>,
  signal: AbortSignal,
): Promise<File> {
  if (input.kind === 'image') {
    return new File([Buffer.from(input.dataBase64, 'base64')], 'reference-image', { type: input.mimeType })
  }
  const response = await fetch(input.url, { signal })
  if (!response.ok) throw new Error(`Video reference download failed with HTTP ${response.status}.`)
  const mediaType = input.mimeType ?? response.headers.get('content-type') ?? 'application/octet-stream'
  return new File([await response.arrayBuffer()], 'reference-image', { type: mediaType })
}

function normalizePollInterval(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 100 ? Math.floor(value) : 1_000
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function toClientOptions(options: OpenAiFactoryOptions): ClientOptions {
  const {
    api: _api,
    chatCompletionMaxTokensParameter: _chatCompletionMaxTokensParameter,
    client: _client,
    harnessLogger: _harnessLogger,
    telemetry: _telemetry,
    harnessTimeoutMs: _harnessTimeoutMs,
    ...clientOptions
  } = options
  return { maxRetries: 0, ...clientOptions }
}

function mapChatTextResponse(response: any, req: TextRequest): TextResponse {
  const toolCalls = extractChatToolCalls(response, req, 'text')
  const providerFinishReason = response.choices[0]?.finish_reason
  const finishReason = toFinishReason(providerFinishReason)
  return {
    content: response.choices[0]?.message?.content ?? '',
    ...(toolCalls ? { toolCalls } : {}),
    usage: toChatUsage(response.usage),
    finishReason,
    outcome: toOutcome(finishReason, providerFinishReason),
    raw: response
  }
}

function extractChatToolCalls(response: any, req: ChatRequest, method: string): ToolCallSpec[] | undefined {
  const toolCalls = response.choices[0]?.message?.tool_calls
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined
  }

  return toolCalls
    .filter((call: any) => call?.id && call?.function?.name)
    .map((call: any) => ({
      id: String(call.id),
      name: String(call.function.name),
      arguments: parseToolArgs(call.function.arguments, req, method)
    }))
}

async function createChatCompletion(
  client: any,
  req: ChatRequest,
  stream: boolean,
  logger?: BaseModelProviderOptions['logger'],
  chatCompletionMaxTokensParameter: 'max_tokens' | 'max_completion_tokens' = 'max_tokens'
): Promise<any> {
  const messages = toOpenAiMessages(req.messages)
  const providerOptions = {
    ...(req.defaults?.providerOptions ?? {}),
    ...(req.call?.providerOptions ?? {})
  } as Record<string, unknown> & { requestOptions?: Record<string, unknown> }
  const { requestOptions, ...bodyOptions } = providerOptions
  const normalizedBodyOptions = omitUnsupportedChatCompletionOptions(bodyOptions, req, logger)

  const maxTokens = req.call?.maxTokens ?? req.defaults?.maxTokens

  return client.chat.completions.create({
    model: req.model,
    messages,
    stream,
    // OpenAI only emits a usage chunk during streaming when this is set.
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    tools: toTools(req.tools),
    temperature: req.call?.temperature ?? req.defaults?.temperature,
    ...(maxTokens !== undefined ? { [chatCompletionMaxTokensParameter]: maxTokens } : {}),
    top_p: req.call?.topP ?? req.defaults?.topP,
    stop: req.call?.stopSequences ?? req.defaults?.stopSequences,
    ...(req.tools && (req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls) !== undefined ? { parallel_tool_calls: req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls } : {}),
    response_format: toResponseFormat(req),
    ...normalizedBodyOptions
  }, { ...requestOptions, signal: req.signal })
}

async function createResponse(client: any, req: ChatRequest, stream: boolean, method: string): Promise<any> {
  if (!client.responses?.create) {
    throw new ModelError('OpenAI client does not expose the Responses API.', {
      provider: 'openai',
      model: req.model,
      method: stream ? ('schema' in req ? 'objectStream' : 'textStream') : ('schema' in req ? 'object' : 'text'),
      reason: 'unstructured_response',
      providerBody: { api: 'responses' }
    })
  }

  const stopSequences = req.call?.stopSequences ?? req.defaults?.stopSequences
  if (stopSequences && stopSequences.length > 0) {
    throw new ModelError('OpenAI Responses API does not support stop sequences.', {
      provider: 'openai',
      model: req.model,
      method,
      reason: 'unsupported_request_option',
      providerBody: { api: 'responses', option: 'stopSequences' }
    })
  }

  const providerOptions = {
    ...(req.defaults?.providerOptions ?? {}),
    ...(req.call?.providerOptions ?? {})
  } as Record<string, unknown> & { requestOptions?: Record<string, unknown> }
  const { requestOptions, ...bodyOptions } = toResponsesProviderOptions(providerOptions)

  return client.responses.create({
    model: req.model,
    input: toResponsesInput(req.messages, req, method),
    stream,
    tools: toResponsesTools(req.tools),
    temperature: req.call?.temperature ?? req.defaults?.temperature,
    max_output_tokens: req.call?.maxTokens ?? req.defaults?.maxTokens,
    top_p: req.call?.topP ?? req.defaults?.topP,
    parallel_tool_calls: req.tools && (req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls) !== undefined ? req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls : undefined,
    text: toResponsesTextFormat(req),
    ...bodyOptions
  }, { ...requestOptions, signal: req.signal })
}

function omitUnsupportedChatCompletionOptions(bodyOptions: Record<string, unknown>, req: ChatRequest, logger?: BaseModelProviderOptions['logger']): Record<string, unknown> {
  if (!req.tools || req.tools.length === 0 || !('reasoning_effort' in bodyOptions)) return bodyOptions
  const { reasoning_effort: _reasoningEffort, ...rest } = bodyOptions
  logger?.warn('OpenAI reasoning_effort dropped for chat completions with tools.', {
    provider: 'openai',
    model: req.model,
    api: 'chat_completions',
    reason: 'reasoning_effort_not_supported_with_tools',
    recommendation: "Use openai({ api: 'responses' }) for reasoning models that require tools with reasoning effort."
  })
  return rest
}

function toResponsesProviderOptions(providerOptions: Record<string, unknown> & { requestOptions?: Record<string, unknown> }): Record<string, unknown> & { requestOptions?: Record<string, unknown> } {
  const { reasoning_effort: reasoningEffort, reasoning, ...rest } = providerOptions
  if (reasoningEffort !== undefined && reasoning === undefined) {
    return { ...rest, reasoning: { effort: reasoningEffort } }
  }
  return { ...rest, ...(reasoning !== undefined ? { reasoning } : {}) }
}

function toResponseFormat(req: ChatRequest): unknown {
  if (!('schema' in req)) return undefined
  return {
    type: 'json_schema',
    json_schema: {
      name: 'harness_response',
      strict: false,
      schema: req.schema
    }
  }
}

function toResponsesTextFormat(req: ChatRequest): unknown {
  if (!('schema' in req)) return undefined
  return {
    format: {
      type: 'json_schema',
      name: 'harness_response',
      strict: false,
      schema: req.schema
    }
  }
}

function toOpenAiMessages(messages: ModelMessage[]): any[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : '',
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments)
          }
        }))
      }
    }

    if (typeof message.content === 'string' || message.role === 'tool') {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.content
        }
      }
      return { role: message.role, content: message.content }
    }

    return {
      role: message.role,
      content: message.content.map((part) => {
        if (part.kind === 'text') {
          return { type: 'text', text: part.text }
        }
        if (part.kind === 'image') {
          return {
            type: 'image_url',
            image_url: {
              url: `data:${part.mimeType};base64,${part.dataBase64}`
            }
          }
        }
        if (part.kind === 'image_url') {
          return {
            type: 'image_url',
            image_url: {
              url: part.url
            }
          }
        }
        return { type: 'text', text: `[unsupported ${part.kind} content omitted]` }
      })
    }
  })
}

function toResponsesInput(messages: ModelMessage[], req: ChatRequest, method: string): any[] {
  const input: any[] = []
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content
      })
      continue
    }

    if (message.role === 'assistant' && message.providerContinuation?.providerId === 'openai') {
      const continuation = parseProviderContinuation(message.providerContinuation, (message.toolCalls ?? []).map((call) => call.id))
      if (!continuation) throw invalidProviderContinuation(req, method)
      validateOpenAiContinuation(continuation, req, method)
      if (continuation.items.length > 0) {
        input.push(...toOpenAiContinuationInput(message, req, method))
        continue
      }
    }

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      if (typeof message.content === 'string' && message.content.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: message.content
        })
      }
      for (const call of message.toolCalls) {
        // The Responses API only accepts an `fc_…` item id on `function_call`
        // input items; the harness tool-call id is the `call_…` value, so the
        // optional item id is omitted, mirroring `function_call_output`.
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments)
        })
      }
      continue
    }

    input.push({
      type: 'message',
      role: message.role,
      content: toResponsesMessageContent(message)
    })
  }
  return input
}

function toResponsesMessageContent(message: ModelMessage): any[] | string {
  if (typeof message.content === 'string') {
    return message.content
  }

  return message.content.map((part) => {
    if (part.kind === 'text') {
      return { type: 'input_text', text: part.text }
    }
    if (part.kind === 'image') {
      return {
        type: 'input_image',
        image_url: `data:${part.mimeType};base64,${part.dataBase64}`
      }
    }
    if (part.kind === 'image_url') {
      return {
        type: 'input_image',
        image_url: part.url
      }
    }
    return { type: 'input_text', text: `[unsupported ${part.kind} content omitted]` }
  })
}

function toTools(tools: TextRequest['tools'] | ObjectRequest['tools']): any[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
}

function toResponsesTools(tools: TextRequest['tools'] | ObjectRequest['tools']): any[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false
  }))
}

function mapResponsesTextResponse(response: any, req: TextRequest): TextResponse {
  const toolCalls = extractResponsesToolCalls(response, req, 'text')
  const providerContinuation = toResponsesProviderContinuation(response.output, toolCalls, req, 'text')
  return {
    content: extractResponsesText(response),
    ...(toolCalls ? { toolCalls } : {}),
    ...(providerContinuation ? { providerContinuation } : {}),
    usage: toResponsesUsage(response.usage),
    finishReason: toResponsesFinishReason(response),
    outcome: toResponsesOutcome(response),
    raw: response
  }
}

function toResponsesProviderContinuation(
  output: unknown,
  toolCalls: ToolCallSpec[] | undefined,
  req: ChatRequest,
  method: string
): ProviderContinuation | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined
  if (!Array.isArray(output)) throw invalidProviderContinuation(req, method)

  const items: ProviderContinuation['items'][number][] = []
  let assistantContentCaptured = false
  for (const outputItem of output) {
    if (!isOpenAiRecord(outputItem)) throw invalidProviderContinuation(req, method)
    if (outputItem['type'] === 'reasoning') {
      if (!isStrictJsonValue(outputItem)) throw invalidProviderContinuation(req, method)
      items.push({ kind: 'opaque', data: outputItem })
      continue
    }
    if (outputItem['type'] === 'function_call') {
      if (typeof outputItem['call_id'] !== 'string' || outputItem['call_id'].length === 0 || typeof outputItem['name'] !== 'string' || outputItem['name'].length === 0) {
        throw invalidProviderContinuation(req, method)
      }
      if (outputItem['id'] !== undefined && typeof outputItem['id'] !== 'string') throw invalidProviderContinuation(req, method)
      items.push({
        kind: 'tool_call',
        callId: outputItem['call_id'],
        ...(typeof outputItem['id'] === 'string' ? { data: { itemId: outputItem['id'] } } : {})
      })
      continue
    }
    if (outputItem['type'] === 'message') {
      if (!assistantContentCaptured) {
        items.push({ kind: 'assistant_content' })
        assistantContentCaptured = true
      }
      continue
    }
    throw invalidProviderContinuation(req, method)
  }

  const continuation = { providerId: 'openai', items }
  const parsed = parseProviderContinuation(continuation, toolCalls.map((call) => call.id))
  if (!parsed) throw invalidProviderContinuation(req, method)
  validateOpenAiContinuation(parsed, req, method)
  return parsed
}

function toOpenAiContinuationInput(message: Extract<ModelMessage, { role: 'assistant' }>, req: ChatRequest, method: string): any[] {
  const toolCalls = message.toolCalls ?? []
  const continuation = parseProviderContinuation(message.providerContinuation, toolCalls.map((call) => call.id))
  if (!continuation) throw invalidProviderContinuation(req, method)
  validateOpenAiContinuation(continuation, req, method)

  const calls = new Map(toolCalls.map((call) => [call.id, call]))
  const input: any[] = []
  for (const item of continuation.items) {
    if (item.kind === 'opaque') {
      input.push(item.data)
      continue
    }
    if (item.kind === 'assistant_content') {
      if (typeof message.content === 'string' ? message.content.length > 0 : message.content.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: typeof message.content === 'string' ? message.content : toResponsesMessageContent(message)
        })
      }
      continue
    }
    const call = calls.get(item.callId)
    if (!call) throw invalidProviderContinuation(req, method)
    const itemId = openAiToolCallItemId(item.data, req, method)
    input.push({
      type: 'function_call',
      ...(itemId ? { id: itemId } : {}),
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments)
    })
  }
  return input
}

function validateOpenAiContinuation(
  continuation: ProviderContinuation,
  req: ChatRequest,
  method: string
): void {
  for (const item of continuation.items) {
    if (item.kind === 'opaque') {
      if (!isOpenAiRecord(item.data) || item.data['type'] !== 'reasoning' || !isJsonValue(item.data)) throw invalidProviderContinuation(req, method)
      continue
    }
    if (item.kind === 'tool_call') openAiToolCallItemId(item.data, req, method)
  }
}

function openAiToolCallItemId(data: JsonValue | undefined, req: ChatRequest, method: string): string | undefined {
  if (data === undefined) return undefined
  if (!isOpenAiRecord(data) || !isJsonValue(data)) throw invalidProviderContinuation(req, method)
  const keys = Object.keys(data)
  if (keys.length !== 1 || keys[0] !== 'itemId' || typeof data['itemId'] !== 'string' || data['itemId'].length === 0) {
    throw invalidProviderContinuation(req, method)
  }
  return data['itemId']
}

function isOpenAiRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStrictJsonValue(value: unknown): value is JsonValue {
  return isJsonValue(value)
}

function invalidProviderContinuation(req: ChatRequest, method: string): ModelError {
  return new ModelError('OpenAI provider continuation is invalid.', {
    provider: 'openai',
    model: req.model,
    method,
    reason: 'invalid_provider_continuation'
  })
}

async function* streamResponsesText(client: any, req: TextRequest): AsyncIterable<TextStreamChunk> {
  const stream = await createResponse(client, req, true, 'textStream')
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let finishReason: TextResponse['finishReason'] = 'stop'
  let outcome: NonNullable<TextResponse['outcome']> = toOutcome('stop')
  let completedOutput: unknown
  const toolState: ResponsesStreamToolCallState = new Map()

  for await (const event of stream) {
    req.signal.throwIfAborted()
    if (event.type === 'response.output_text.delta') {
      yield { kind: 'delta', text: event.delta }
    } else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      accumulateResponsesToolCallItem(toolState, event)
    } else if (event.type === 'response.function_call_arguments.delta') {
      accumulateResponsesToolCallDelta(toolState, event)
    } else if (event.type === 'response.function_call_arguments.done') {
      accumulateResponsesToolCallDone(toolState, event)
    } else if (event.type === 'response.completed') {
      usage = toResponsesUsage(event.response?.usage)
      finishReason = toResponsesFinishReason(event.response)
      outcome = toResponsesOutcome(event.response)
      completedOutput = event.response?.output
    } else if (event.type === 'response.failed') {
      // A genuine provider failure must surface as an error so base retry and
      // normalization apply, matching the chat-completions path.
      throw responsesFailureError(event.response, req, 'textStream')
    } else if (event.type === 'response.incomplete') {
      usage = toResponsesUsage(event.response?.usage)
      finishReason = toResponsesFinishReason(event.response)
      outcome = toResponsesOutcome(event.response)
    }
  }

  const toolCalls = finalizeResponsesStreamToolCalls(toolState, req, 'textStream')
  for (const call of toolCalls) {
    yield { kind: 'tool_call', call }
  }
  const providerContinuation = toResponsesProviderContinuation(completedOutput, toolCalls, req, 'textStream')
  yield { kind: 'finish', usage, finishReason, outcome, ...(providerContinuation ? { providerContinuation } : {}) }
}

async function* streamResponsesObject<T extends JsonValue = JsonValue>(client: any, req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
  const stream = await createResponse(client, req, true, 'objectStream')
  let partial = ''
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let finishReason: TextResponse['finishReason'] = 'stop'
  let outcome: NonNullable<TextResponse['outcome']> = toOutcome('stop')
  let completedOutput: unknown
  const toolState: ResponsesStreamToolCallState = new Map()

  for await (const event of stream) {
    req.signal.throwIfAborted()
    if (event.type === 'response.output_text.delta') {
      partial += event.delta
      yield { kind: 'partial', partial: safePartialJson(partial) }
    } else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      accumulateResponsesToolCallItem(toolState, event)
    } else if (event.type === 'response.function_call_arguments.delta') {
      accumulateResponsesToolCallDelta(toolState, event)
    } else if (event.type === 'response.function_call_arguments.done') {
      accumulateResponsesToolCallDone(toolState, event)
    } else if (event.type === 'response.completed') {
      usage = toResponsesUsage(event.response?.usage)
      finishReason = toResponsesFinishReason(event.response)
      outcome = toResponsesOutcome(event.response)
      completedOutput = event.response?.output
    } else if (event.type === 'response.failed') {
      // A genuine provider failure must surface as an error so base retry and
      // normalization apply, matching the chat-completions path.
      throw responsesFailureError(event.response, req, 'objectStream')
    } else if (event.type === 'response.incomplete') {
      usage = toResponsesUsage(event.response?.usage)
      finishReason = toResponsesFinishReason(event.response)
      outcome = toResponsesOutcome(event.response)
    }
  }

  const toolCalls = finalizeResponsesStreamToolCalls(toolState, req, 'objectStream')
  for (const call of toolCalls) {
    yield { kind: 'tool_call', call }
  }
  const object = parseJson(partial || '{}', req, 'objectStream') as T
  const providerContinuation = toResponsesProviderContinuation(completedOutput, toolCalls, req, 'objectStream')
  yield { kind: 'finish', object, usage, finishReason, outcome, ...(providerContinuation ? { providerContinuation } : {}) }
}

function extractResponsesText(response: any): string {
  if (typeof response.output_text === 'string') return response.output_text
  const parts: string[] = []
  for (const item of response.output ?? []) {
    if (item?.type !== 'message') continue
    for (const content of item.content ?? []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text)
      }
    }
  }
  return parts.join('')
}

function extractResponsesToolCalls(response: any, req: ChatRequest, method: string): ToolCallSpec[] | undefined {
  const toolCalls = (response.output ?? []).filter((item: any) => item?.type === 'function_call' && item.call_id && item.name)
  if (toolCalls.length === 0) return undefined
  return toolCalls.map((call: any) => ({
    id: String(call.call_id),
    name: String(call.name),
    arguments: parseToolArgs(call.arguments, req, method)
  }))
}

type ResponsesStreamToolCallState = Map<number, { id?: string; name?: string; args: string }>

function accumulateResponsesToolCallItem(state: ResponsesStreamToolCallState, event: any): void {
  if (event.item?.type !== 'function_call') return
  const index = typeof event.output_index === 'number' ? event.output_index : 0
  const existing = state.get(index) ?? { args: '' }
  if (event.item.call_id) existing.id = String(event.item.call_id)
  if (event.item.name) existing.name = String(event.item.name)
  if (typeof event.item.arguments === 'string') existing.args = event.item.arguments
  state.set(index, existing)
}

function accumulateResponsesToolCallDelta(state: ResponsesStreamToolCallState, event: any): void {
  const index = typeof event.output_index === 'number' ? event.output_index : 0
  const existing = state.get(index) ?? { args: '' }
  if (typeof event.delta === 'string') existing.args += event.delta
  state.set(index, existing)
}

function accumulateResponsesToolCallDone(state: ResponsesStreamToolCallState, event: any): void {
  const index = typeof event.output_index === 'number' ? event.output_index : 0
  const existing = state.get(index) ?? { args: '' }
  // `event.item_id` is the `fc_…` item id, not the `call_…` id required for
  // `function_call_output`, so the call id only ever comes from the
  // `response.output_item.added`/`done` events.
  if (event.name) existing.name = String(event.name)
  if (typeof event.arguments === 'string') existing.args = event.arguments
  state.set(index, existing)
}

function finalizeResponsesStreamToolCalls(state: ResponsesStreamToolCallState, req: ChatRequest, method: string): ToolCallSpec[] {
  return [...state.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, call]) => call.name)
    .map(([, call]) => {
      if (!call.id) {
        throw malformedResponseError(callContext(req, method), 'OpenAI streamed a function call without a call_id.', call, undefined)
      }
      return {
        id: call.id,
        name: call.name as string,
        arguments: parseToolArgs(call.args || undefined, req, method)
      }
    })
}

const MALFORMED_TOOL_ARGS_MESSAGE = 'OpenAI returned malformed tool-call argument JSON.'
const MALFORMED_OBJECT_MESSAGE = 'OpenAI returned malformed structured object JSON.'

function callContext(req: OpenAiRequest, method: string): AdapterCallContext {
  return { provider: 'openai', model: req.model, method }
}

/** Throws when a non-streaming Responses result reports a provider failure. */
function throwIfResponsesFailure(response: any, req: ChatRequest, method: string): void {
  if (response?.status === 'failed' || response?.error) {
    throw responsesFailureError(response, req, method)
  }
}

/**
 * Maps a failed Responses-API result into a `ModelError` so the base
 * provider's retry classification and normalization apply.
 */
function responsesFailureError(response: any, req: ChatRequest, method: string): ModelError {
  const providerCode = typeof response?.error?.code === 'string' ? response.error.code : undefined
  const rawMessage = typeof response?.error?.message === 'string' ? response.error.message : undefined
  const reason = providerCode === 'rate_limit_exceeded'
    ? 'rate_limited'
    : providerCode === 'server_error'
      ? 'provider_unavailable'
      : 'http_error'
  return new ModelError('OpenAI reported a failed response.', {
    provider: 'openai',
    model: req.model,
    method,
    reason,
    ...(providerCode ? { providerCode } : {}),
    ...(rawMessage ? { providerMessage: sanitizeProviderMessage(rawMessage) } : {})
  })
}

function parseToolArgs(argumentsText: string | undefined, req: ChatRequest, method: string): JsonValue {
  return parseProviderJson(argumentsText || '{}', callContext(req, method), MALFORMED_TOOL_ARGS_MESSAGE)
}

function parseJson(content: string, req: ChatRequest, method: string): JsonValue {
  return parseProviderJson(content, callContext(req, method), MALFORMED_OBJECT_MESSAGE)
}

function toResponsesUsage(usage: any): TokenUsage {
  return toTokenUsage(usage?.input_tokens, usage?.output_tokens, usage?.total_tokens, {
    cachedInputTokens: usage?.input_tokens_details?.cached_tokens,
    reasoningTokens: usage?.output_tokens_details?.reasoning_tokens
  })
}

function toChatUsage(usage: any): TokenUsage {
  return toTokenUsage(usage?.prompt_tokens, usage?.completion_tokens, usage?.total_tokens, {
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens
  })
}

function toFinishReason(value: unknown): TextResponse['finishReason'] {
  switch (value) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
      return value
    case 'function_call':
      return 'tool_calls'
    default:
      return 'error'
  }
}

function toResponsesFinishReason(response: any): TextResponse['finishReason'] {
  if (!response) return 'error'
  if ((response.output ?? []).some((item: any) => item?.type === 'function_call')) return 'tool_calls'
  const incompleteReason = response.incomplete_details?.reason
  if (incompleteReason === 'max_output_tokens') return 'length'
  if (incompleteReason === 'content_filter') return 'content_filter'
  switch (response.status) {
    case 'completed':
      return 'stop'
    case 'incomplete':
      return 'length'
    default:
      return response.error ? 'error' : 'stop'
  }
}

function toOutcome(finishReason: TextResponse['finishReason'], providerFinishReason?: unknown, details?: Record<string, JsonValue>): NonNullable<TextResponse['outcome']> {
  return {
    finishReason,
    ...(typeof providerFinishReason === 'string' ? { providerFinishReason } : {}),
    ...(details ? { details } : {})
  }
}

function toResponsesOutcome(response: any): NonNullable<TextResponse['outcome']> {
  const finishReason = toResponsesFinishReason(response)
  const details = response?.incomplete_details || response?.error
    ? {
        ...(response.incomplete_details ? { incompleteDetails: response.incomplete_details as JsonValue } : {}),
        ...(response.error ? { error: response.error as JsonValue } : {})
      }
    : undefined
  return {
    finishReason,
    ...(typeof response?.status === 'string' ? { providerStatus: response.status, providerFinishReason: response.status } : {}),
    ...(details ? { details } : {})
  }
}
