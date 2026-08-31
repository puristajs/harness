import type {
  AdapterCallContext,
  BaseModelProviderOptions,
  ContentPart,
  EmbeddingRequest,
  EmbeddingResponse,
  JsonValue,
  ModelMessage,
  ModelProvider,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  TokenUsage,
  ToolCallSpec,
} from '@purista/harness'
import {
  BaseModelProvider,
  parseProviderJson,
  safePartialJson,
  toTokenUsage,
} from '@purista/harness'
import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai'

/** Configuration for the Google Gemini API model provider factory. */
export interface GoogleFactoryOptions extends GoogleGenAIOptions {
  /** Optional injected client for tests or custom transport behavior. */
  client?: GoogleClient
  /** Optional adapter-level logger override. Defaults to the Harness logger when registered. */
  harnessLogger?: BaseModelProviderOptions['logger']
  /** Optional adapter-level telemetry override. Defaults to Harness telemetry when registered. */
  telemetry?: BaseModelProviderOptions['telemetry']
  /** Optional adapter-level timeout override. Defaults to the Harness model timeout when registered. */
  harnessTimeoutMs?: number
}

/**
 * The narrow official-SDK surface used by this adapter. Inject this only for
 * tests or an application-owned transport wrapper; normal applications pass
 * `apiKey`/Vertex options to {@link google}.
 */
export interface GoogleClient {
  models: {
    generateContent(params: unknown): Promise<any>
    generateContentStream(params: unknown): Promise<AsyncIterable<any>>
    embedContent(params: unknown): Promise<any>
  }
}

/**
 * Creates a Google Gemini API-backed Harness `ModelProvider`.
 *
 * @example
 * ```ts
 * import { google } from '@purista/harness-google'
 *
 * const provider = google({ apiKey: process.env.GEMINI_API_KEY! })
 * ```
 */
export function google(options: GoogleFactoryOptions = {}): ModelProvider {
  return new GoogleModelProvider(options)
}

class GoogleModelProvider extends BaseModelProvider {
  private readonly client: GoogleClient

  public constructor(private readonly options: GoogleFactoryOptions) {
    super({
      id: 'google',
      genAiSystem: 'google.gemini',
      ...(options.harnessLogger ? { logger: options.harnessLogger } : {}),
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
      ...(options.harnessTimeoutMs !== undefined ? { timeoutMs: options.harnessTimeoutMs } : {}),
    })
    this.client = options.client ?? new GoogleGenAI(toClientOptions(options))
  }

  protected override async doText(req: TextRequest): Promise<TextResponse> {
    req.signal.throwIfAborted()
    const response = await this.client.models.generateContent(toGenerateRequest(req))
    return toTextResponse(response, req, 'text')
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
    req.signal.throwIfAborted()
    const stream = await this.client.models.generateContentStream(toGenerateRequest(req))
    const calls = new Map<string, ToolCallSpec>()
    let usage: TokenUsage = emptyUsage()
    let providerFinishReason: unknown

    for await (const chunk of stream) {
      req.signal.throwIfAborted()
      const candidate = firstCandidate(chunk)
      if (candidate?.content?.parts) {
        for (const part of candidate.content.parts) {
          if (typeof part?.text === 'string' && part.text) yield { kind: 'delta', text: part.text }
        }
      }
      for (const call of toToolCalls(chunk, req, 'textStream') ?? []) calls.set(call.id, call)
      if (candidate?.finishReason !== undefined) providerFinishReason = candidate.finishReason
      usage = toGoogleUsage(chunk?.usageMetadata, usage)
    }

    for (const call of calls.values()) yield { kind: 'tool_call', call }
    const finishReason = toFinishReason(providerFinishReason, calls.size > 0)
    yield { kind: 'finish', usage, finishReason, outcome: toOutcome(finishReason, providerFinishReason) }
  }

  protected override async doObject<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    req.signal.throwIfAborted()
    const response = await this.client.models.generateContent(toGenerateRequest(req))
    const candidate = firstCandidate(response)
    const text = textFromCandidate(candidate)
    const toolCalls = toToolCalls(response, req, 'object')
    const finishReason = toFinishReason(candidate?.finishReason, Boolean(toolCalls?.length))
    return {
      object: parseJson(text || '{}', req, 'object') as T,
      ...(toolCalls ? { toolCalls } : {}),
      usage: toGoogleUsage(response?.usageMetadata),
      finishReason,
      outcome: toOutcome(finishReason, candidate?.finishReason),
      raw: response,
    }
  }

  protected override async *doObjectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    req.signal.throwIfAborted()
    const stream = await this.client.models.generateContentStream(toGenerateRequest(req))
    const calls = new Map<string, ToolCallSpec>()
    let text = ''
    let usage: TokenUsage = emptyUsage()
    let providerFinishReason: unknown

    for await (const chunk of stream) {
      req.signal.throwIfAborted()
      const candidate = firstCandidate(chunk)
      const delta = textFromCandidate(candidate)
      if (delta) {
        text += delta
        yield { kind: 'partial', partial: safePartialJson(text) }
      }
      for (const call of toToolCalls(chunk, req, 'objectStream') ?? []) calls.set(call.id, call)
      if (candidate?.finishReason !== undefined) providerFinishReason = candidate.finishReason
      usage = toGoogleUsage(chunk?.usageMetadata, usage)
    }

    for (const call of calls.values()) yield { kind: 'tool_call', call }
    const finishReason = toFinishReason(providerFinishReason, calls.size > 0)
    yield {
      kind: 'finish',
      object: parseJson(text || '{}', req, 'objectStream') as T,
      usage,
      finishReason,
      outcome: toOutcome(finishReason, providerFinishReason),
    }
  }

  protected override async doEmbed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    req.signal.throwIfAborted()
    const providerOptions = mergedProviderOptions(req) as Record<string, unknown>
    const { config: requestedConfig, ...rest } = providerOptions
    const config = {
      ...(requestedConfig && typeof requestedConfig === 'object' ? requestedConfig : {}),
      ...(req.dimensions !== undefined ? { outputDimensionality: req.dimensions } : {}),
      abortSignal: req.signal,
    }
    const response = await this.client.models.embedContent({
      model: req.model,
      contents: Array.isArray(req.input) ? req.input : [req.input],
      config,
      ...rest,
    })
    return {
      embeddings: (response?.embeddings ?? []).map((embedding: any, index: number) => ({
        index,
        vector: Array.isArray(embedding?.values) ? embedding.values : [],
      })),
      usage: emptyUsage(),
      raw: response,
    }
  }
}

type GenerateRequest = TextRequest | ObjectRequest

function toClientOptions(options: GoogleFactoryOptions): GoogleGenAIOptions {
  const {
    client: _client,
    harnessLogger: _harnessLogger,
    telemetry: _telemetry,
    harnessTimeoutMs: _harnessTimeoutMs,
    httpOptions,
    ...clientOptions
  } = options
  return {
    ...clientOptions,
    httpOptions: {
      retryOptions: { attempts: 1 },
      ...httpOptions,
    },
  }
}

function toGenerateRequest(req: GenerateRequest): Record<string, unknown> {
  const providerOptions = mergedProviderOptions(req) as Record<string, unknown>
  const { config: requestedConfig, ...rest } = providerOptions
  const systemInstruction = req.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n')
  const config: Record<string, unknown> = {
    ...(requestedConfig && typeof requestedConfig === 'object' ? requestedConfig : {}),
    ...(systemInstruction ? { systemInstruction } : {}),
    ...((req.call?.temperature ?? req.defaults?.temperature) !== undefined ? { temperature: req.call?.temperature ?? req.defaults?.temperature } : {}),
    ...((req.call?.topP ?? req.defaults?.topP) !== undefined ? { topP: req.call?.topP ?? req.defaults?.topP } : {}),
    ...((req.call?.maxTokens ?? req.defaults?.maxTokens) !== undefined ? { maxOutputTokens: req.call?.maxTokens ?? req.defaults?.maxTokens } : {}),
    ...((req.call?.stopSequences ?? req.defaults?.stopSequences) !== undefined ? { stopSequences: req.call?.stopSequences ?? req.defaults?.stopSequences } : {}),
    ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map(toFunctionDeclaration) }] } : {}),
    ...((req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls) === false && req.tools?.length
      ? { toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } } }
      : {}),
    ...('schema' in req ? { responseMimeType: 'application/json', responseJsonSchema: req.schema } : {}),
    abortSignal: req.signal,
  }
  return {
    model: req.model,
    contents: toGoogleMessages(req.messages),
    config,
    ...rest,
  }
}

function mergedProviderOptions(req: { defaults?: { providerOptions?: Record<string, unknown> } | undefined; call?: { providerOptions?: Record<string, unknown> } | undefined }): Record<string, unknown> {
  return { ...(req.defaults?.providerOptions ?? {}), ...(req.call?.providerOptions ?? {}) }
}

function toGoogleMessages(messages: ModelMessage[]): unknown[] {
  return messages
    .map((message, index) => {
      if (message.role === 'system') return undefined
      if (message.role === 'assistant') {
        return {
          role: 'model',
          parts: [
            ...toMessageParts(message.content),
            ...(message.toolCalls ?? []).map((call) => ({ functionCall: { id: call.id, name: call.name, args: call.arguments } })),
          ],
        }
      }
      if (message.role === 'tool') {
        return {
          role: 'user',
          parts: [{
            functionResponse: {
              id: message.toolCallId,
              name: findToolName(messages, index, message.toolCallId) ?? 'harness_tool',
              response: { output: message.content },
            },
          }],
        }
      }
      return {
        role: 'user',
        parts: toMessageParts(message.content),
      }
    })
    .filter((message): message is NonNullable<typeof message> => message !== undefined)
}

function findToolName(messages: ModelMessage[], before: number, toolCallId: string): string | undefined {
  for (let index = before - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const call = message?.role === 'assistant'
      ? message.toolCalls?.find((candidate) => candidate.id === toolCallId)
      : undefined
    if (call) return call.name
  }
  return undefined
}

function toGoogleParts(parts: ContentPart[]): unknown[] {
  return parts.map((part) => {
    switch (part.kind) {
      case 'text': return { text: part.text }
      case 'image':
      case 'audio':
      case 'file': return { inlineData: { mimeType: part.mimeType, data: part.dataBase64 } }
      case 'image_url':
      case 'file_url': return { fileData: { fileUri: part.url, ...(part.mimeType ? { mimeType: part.mimeType } : {}) } }
    }
  })
}

function toMessageParts(content: string | ContentPart[]): unknown[] {
  return typeof content === 'string' ? (content ? [{ text: content }] : []) : toGoogleParts(content)
}

function toFunctionDeclaration(tool: NonNullable<GenerateRequest['tools']>[number]): Record<string, unknown> {
  return { name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters }
}

function toTextResponse(response: any, req: GenerateRequest, method: string): TextResponse {
  const candidate = firstCandidate(response)
  const toolCalls = toToolCalls(response, req, method)
  const finishReason = toFinishReason(candidate?.finishReason, Boolean(toolCalls?.length))
  return {
    content: textFromCandidate(candidate),
    ...(toolCalls ? { toolCalls } : {}),
    usage: toGoogleUsage(response?.usageMetadata),
    finishReason,
    outcome: toOutcome(finishReason, candidate?.finishReason),
    raw: response,
  }
}

function firstCandidate(response: any): any | undefined {
  return response?.candidates?.[0]
}

function textFromCandidate(candidate: any): string {
  return candidate?.content?.parts
    ?.filter((part: any) => typeof part?.text === 'string' && !part?.thought)
    .map((part: any) => part.text)
    .join('') ?? ''
}

function toToolCalls(response: any, req: GenerateRequest, method: string): ToolCallSpec[] | undefined {
  const parts = firstCandidate(response)?.content?.parts ?? []
  const calls = parts.filter((part: any) => part?.functionCall?.name)
  if (calls.length === 0) return undefined
  return calls.map((part: any, index: number) => ({
    id: String(part.functionCall.id ?? `google_${method}_${index}`),
    name: String(part.functionCall.name),
    arguments: asJsonValue(part.functionCall.args ?? {}, req, method),
  }))
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

function toGoogleUsage(usage: any, fallback: TokenUsage = emptyUsage()): TokenUsage {
  if (!usage) return fallback
  return toTokenUsage(usage.promptTokenCount, usage.responseTokenCount, usage.totalTokenCount, {
    cachedInputTokens: usage.cachedContentTokenCount,
    reasoningTokens: usage.thoughtsTokenCount,
  })
}

function callContext(req: GenerateRequest, method: string): AdapterCallContext {
  return { provider: 'google', model: req.model, method }
}

function asJsonValue(value: unknown, req: GenerateRequest, method: string): JsonValue {
  if (typeof value === 'string') return parseJson(value, req, method)
  return parseJson(JSON.stringify(value), req, method)
}

function parseJson(content: string, req: GenerateRequest, method: string): JsonValue {
  return parseProviderJson(content, callContext(req, method), 'Google Gemini returned malformed JSON.')
}

function toFinishReason(value: unknown, hasToolCalls: boolean): TextResponse['finishReason'] {
  if (hasToolCalls && (value === undefined || value === 'STOP')) return 'tool_calls'
  switch (value) {
    case 'STOP': return 'stop'
    case 'MAX_TOKENS': return 'length'
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT': return 'content_filter'
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL': return 'malformed'
    default: return 'error'
  }
}

function toOutcome(finishReason: TextResponse['finishReason'], providerFinishReason: unknown): NonNullable<TextResponse['outcome']> {
  return {
    finishReason,
    ...(typeof providerFinishReason === 'string' ? { providerFinishReason } : {}),
  }
}
