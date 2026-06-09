import type {
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
  ToolCallSpec
} from '@purista/harness'
import { BaseModelProvider, ModelError } from '@purista/harness'
import ModelClient, { type ModelClientOptions } from '@azure-rest/ai-inference'
import { AzureKeyCredential, type KeyCredential, type TokenCredential } from '@azure/core-auth'
import { createSseStream } from '@azure/core-sse'

export interface AzureFoundryFactoryOptions extends ModelClientOptions {
  /** Azure AI Foundry model endpoint. Not required when `client` is injected. */
  endpoint?: string
  /** Azure AI Foundry API key. Ignored when `credential` or `client` is provided. */
  apiKey?: string
  /** Azure credential, for example `DefaultAzureCredential`. */
  credential?: TokenCredential | KeyCredential
  /** Optional injected client for tests or custom transport behavior. */
  client?: AzureFoundryClient
  /** Optional adapter-level logger override. Defaults to the harness logger when registered. */
  harnessLogger?: BaseModelProviderOptions['logger']
  /** Optional adapter-level telemetry override. Defaults to the harness telemetry shim when registered. */
  telemetry?: BaseModelProviderOptions['telemetry']
  /** Optional adapter-level timeout override. Defaults to the harness model timeout when registered. */
  harnessTimeoutMs?: number
}

/**
 * Creates an Azure AI Foundry-backed harness `ModelProvider`.
 *
 * @example
 * ```ts
 * import { azureFoundry } from '@purista/harness-azure-foundry'
 *
 * const provider = azureFoundry({
 *   endpoint: process.env.AZURE_AI_ENDPOINT,
 *   apiKey: process.env.AZURE_AI_API_KEY
 * })
 * ```
 */
export function azureFoundry(options: AzureFoundryFactoryOptions = {}): ModelProvider {
  return new AzureFoundryModelProvider(options)
}

class AzureFoundryModelProvider extends BaseModelProvider {
  private readonly client: AzureFoundryClient

  public constructor(private readonly options: AzureFoundryFactoryOptions) {
    super({
      id: 'azure-foundry',
      genAiSystem: 'azure.ai.inference',
      ...(options.harnessLogger ? { logger: options.harnessLogger } : {}),
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
      ...(options.harnessTimeoutMs !== undefined ? { timeoutMs: options.harnessTimeoutMs } : {})
    })
    this.client = options.client ?? createClient(options)
  }

  protected override async doText(req: TextRequest): Promise<TextResponse> {
    req.signal.throwIfAborted()
    const response = await postChat(this.client, req, false)
    const body = ensureOk(response)
    const choice = body.choices?.[0]
    const toolCalls = extractToolCalls(choice?.message?.tool_calls, req, 'text')
    return {
      content: choice?.message?.content ?? '',
      ...(toolCalls ? { toolCalls } : {}),
      usage: toUsage(body.usage?.prompt_tokens, body.usage?.completion_tokens, body.usage?.total_tokens),
      finishReason: toFinishReason(choice?.finish_reason),
      raw: response
    }
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
    req.signal.throwIfAborted()
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finishReason: TextResponse['finishReason'] = 'stop'
    const toolState: StreamToolCallState = new Map()

    for await (const event of streamChat(this.client, req, false)) {
      req.signal.throwIfAborted()
      const data = parseStreamData(event, req, 'textStream')
      if (!data) continue
      for (const choice of data.choices ?? []) {
        if (choice.delta?.content) {
          yield { kind: 'delta', text: choice.delta.content }
        }
        if (choice.delta?.tool_calls) {
          accumulateToolCallDeltas(toolState, choice.delta.tool_calls)
        }
        if (choice.finish_reason) {
          finishReason = toFinishReason(choice.finish_reason)
        }
      }
      if (data.usage) {
        usage = toUsage(data.usage.prompt_tokens, data.usage.completion_tokens, data.usage.total_tokens)
      }
    }

    for (const call of finalizeStreamToolCalls(toolState, req, 'textStream')) {
      yield { kind: 'tool_call', call }
    }
    yield { kind: 'finish', usage, finishReason }
  }

  protected override async doObject<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    req.signal.throwIfAborted()
    const response = await postChat(this.client, req, false)
    const body = ensureOk(response)
    const choice = body.choices?.[0]
    const text = choice?.message?.content ?? '{}'
    const toolCalls = extractToolCalls(choice?.message?.tool_calls, req, 'object')
    return {
      object: parseJson(text, req, 'object') as T,
      ...(toolCalls ? { toolCalls } : {}),
      usage: toUsage(body.usage?.prompt_tokens, body.usage?.completion_tokens, body.usage?.total_tokens),
      finishReason: toFinishReason(choice?.finish_reason),
      raw: response
    }
  }

  protected override async *doObjectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    req.signal.throwIfAborted()
    let partial = ''
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finishReason: TextResponse['finishReason'] = 'stop'
    const toolState: StreamToolCallState = new Map()

    for await (const event of streamChat(this.client, req, true)) {
      req.signal.throwIfAborted()
      const data = parseStreamData(event, req, 'objectStream')
      if (!data) continue
      for (const choice of data.choices ?? []) {
        if (choice.delta?.content) {
          partial += choice.delta.content
          yield { kind: 'partial', partial: safePartialJson(partial) }
        }
        if (choice.delta?.tool_calls) {
          accumulateToolCallDeltas(toolState, choice.delta.tool_calls)
        }
        if (choice.finish_reason) {
          finishReason = toFinishReason(choice.finish_reason)
        }
      }
      if (data.usage) {
        usage = toUsage(data.usage.prompt_tokens, data.usage.completion_tokens, data.usage.total_tokens)
      }
    }

    for (const call of finalizeStreamToolCalls(toolState, req, 'objectStream')) {
      yield { kind: 'tool_call', call }
    }
    const object = parseJson(partial || '{}', req, 'objectStream') as T
    yield { kind: 'finish', object, usage, finishReason }
  }

  protected override async doEmbed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    req.signal.throwIfAborted()
    const providerOptions = {
      ...(req.call?.providerOptions ?? {})
    } as Record<string, unknown> & { requestOptions?: Record<string, unknown> }
    const { requestOptions, ...bodyOptions } = providerOptions
    const response = await this.client.path('/embeddings').post({
      body: {
        model: req.model,
        input: Array.isArray(req.input) ? [...req.input] : [req.input],
        ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}),
        ...bodyOptions
      },
      ...requestOptions,
      abortSignal: req.signal
    })
    const body = ensureOk(response)
    return {
      embeddings: body.data.map((item: any) => ({
        index: item.index,
        vector: Array.isArray(item.embedding) ? item.embedding : []
      })),
      usage: toUsage(body.usage?.prompt_tokens, 0, body.usage?.total_tokens),
      raw: response
    }
  }
}

export type AzureFoundryClient = {
  path(path: '/chat/completions' | '/embeddings'): {
    post(options: unknown): Promise<any> & { asNodeStream?: () => Promise<any> }
  }
}

type ChatRequest = TextRequest | ObjectRequest

function createClient(options: AzureFoundryFactoryOptions): AzureFoundryClient {
  const { endpoint, apiKey, credential, client: _client, harnessLogger: _harnessLogger, telemetry: _telemetry, harnessTimeoutMs: _harnessTimeoutMs, ...clientOptions } = options
  if (!endpoint) {
    throw new Error('Azure AI Foundry endpoint is required when no client is injected.')
  }
  const auth = credential ?? (apiKey ? new AzureKeyCredential(apiKey) : undefined)
  if (!auth) {
    throw new Error('Azure AI Foundry apiKey or credential is required when no client is injected.')
  }
  return ModelClient(endpoint, auth, clientOptions) as unknown as AzureFoundryClient
}

async function postChat(client: AzureFoundryClient, req: ChatRequest, stream: boolean): Promise<any> {
  const providerOptions = {
    ...(req.defaults?.providerOptions ?? {}),
    ...(req.call?.providerOptions ?? {})
  } as Record<string, unknown> & { requestOptions?: Record<string, unknown> }
  const { requestOptions, ...bodyOptions } = providerOptions
  return client.path('/chat/completions').post({
    body: {
      model: req.model,
      messages: toAzureMessages(req.messages),
      stream,
      // Only emits a usage event during streaming when this is set.
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      tools: toTools(req.tools),
      temperature: req.call?.temperature ?? req.defaults?.temperature,
      max_tokens: req.call?.maxTokens ?? req.defaults?.maxTokens,
      top_p: req.call?.topP ?? req.defaults?.topP,
      stop: req.call?.stopSequences ?? req.defaults?.stopSequences,
      ...(req.tools && (req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls) !== undefined ? { parallel_tool_calls: req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls } : {}),
      response_format: toResponseFormat(req),
      ...bodyOptions
    },
    ...requestOptions,
    abortSignal: req.signal
  })
}

async function* streamChat(client: AzureFoundryClient, req: ChatRequest, objectMode: boolean): AsyncIterable<unknown> {
  const response = await postChat(client, req, true)
  const nodeResponse = typeof response.asNodeStream === 'function' ? await response.asNodeStream() : response
  if (nodeResponse.status && nodeResponse.status !== '200' && nodeResponse.status !== 200) {
    throw azureFailure(nodeResponse, 'Azure AI Foundry streaming request failed.')
  }
  if (nodeResponse.body?.[Symbol.asyncIterator]) {
    const sses = createSseStream(nodeResponse.body)
    for await (const event of sses) {
      if (event.data === '[DONE]') break
      yield event.data
    }
    return
  }
  for await (const event of nodeResponse.body ?? []) {
    yield event
  }
}

function ensureOk(response: any): any {
  if (response.status && response.status !== '200' && response.status !== 200) {
    throw azureFailure(response, 'Azure AI Foundry request failed.')
  }
  return response.body ?? response
}

/**
 * Build an error that preserves the HTTP status (and body/headers) so the base
 * provider's `normalizeError` can classify retriability (429/5xx) instead of
 * misclassifying every failure as a non-retriable network error.
 */
function azureFailure(response: any, fallbackMessage: string): Error {
  const status = Number(response?.status)
  const body = response?.body
  const message = (body?.error?.message ?? body?.message) as string | undefined
  return Object.assign(new Error(message ?? fallbackMessage), {
    ...(Number.isFinite(status) ? { status } : {}),
    ...(body?.error ? { error: body.error } : body !== undefined ? { body } : {}),
    ...(response?.headers ? { headers: response.headers } : {})
  })
}

function toAzureMessages(messages: ModelMessage[]): any[] {
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
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    }
    return {
      role: message.role,
      content: typeof message.content === 'string' ? message.content : message.content.map(toContentItem)
    }
  })
}

function toContentItem(part: ContentPart): any {
  if (part.kind === 'text') return { type: 'text', text: part.text }
  if (part.kind === 'image') return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.dataBase64}` } }
  if (part.kind === 'image_url') return { type: 'image_url', image_url: { url: part.url } }
  if (part.kind === 'audio') return { type: 'input_audio', input_audio: { data: part.dataBase64, format: part.mimeType.split('/')[1] ?? 'wav' } }
  return { type: 'text', text: `[unsupported ${part.kind} content omitted]` }
}

function toTools(tools: ChatRequest['tools']): any[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))
}

function toResponseFormat(req: ChatRequest): unknown {
  if (!('schema' in req)) return undefined
  return {
    type: 'json_schema',
    json_schema: {
      name: req.schemaName ?? 'harness_response',
      strict: false,
      schema: req.schema
    }
  }
}

function extractToolCalls(toolCalls: unknown, req: ChatRequest, method: string): ToolCallSpec[] | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined
  return toolCalls
    .filter((call: any) => call?.id && call?.function?.name)
    .map((call: any) => ({
      id: String(call.id),
      name: String(call.function.name),
      arguments: parseJson(call.function.arguments ?? '{}', req, method)
    }))
}

/**
 * Per-index accumulator for streamed tool-call fragments (OpenAI-compatible
 * delta format): the first delta carries `index`/`id`/`function.name`, later
 * deltas carry only `index` and argument fragments. Concatenate by index and
 * parse arguments once at stream end.
 */
type StreamToolCallState = Map<number, { id?: string; name?: string; args: string }>

function accumulateToolCallDeltas(state: StreamToolCallState, deltas: any[]): void {
  for (const delta of deltas) {
    const index = typeof delta?.index === 'number' ? delta.index : 0
    const existing = state.get(index) ?? { args: '' }
    if (delta?.id) existing.id = String(delta.id)
    if (delta?.function?.name) existing.name = String(delta.function.name)
    if (typeof delta?.function?.arguments === 'string') existing.args += delta.function.arguments
    state.set(index, existing)
  }
}

function finalizeStreamToolCalls(state: StreamToolCallState, req: ChatRequest, method: string): ToolCallSpec[] {
  return [...state.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, call]) => call.id && call.name)
    .map(([, call]) => ({
      id: call.id as string,
      name: call.name as string,
      arguments: parseJson(call.args || '{}', req, method)
    }))
}

function parseStreamData(event: unknown, req: ChatRequest, method: string): any | undefined {
  if (event === '[DONE]') return undefined
  if (typeof event === 'string') return parseJson(event, req, method)
  return event
}

function parseJson(content: string, req: ChatRequest, method: string): JsonValue {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw malformedResponseError(req, method, 'Azure AI Foundry returned malformed JSON.', content, error)
  }
}

function malformedResponseError(req: ChatRequest, method: string, message: string, body: unknown, cause: unknown): ModelError {
  return new ModelError(message, {
    provider: 'azure-foundry',
    model: req.model,
    method,
    reason: 'malformed_response',
    providerBody: body
  }, cause)
}

function safePartialJson(content: string): JsonValue {
  try {
    return JSON.parse(content)
  } catch {
    return { _partial: content }
  }
}

function toUsage(inputTokens?: number, outputTokens?: number, totalTokens?: number): TokenUsage {
  const input = inputTokens ?? 0
  const output = outputTokens ?? 0
  return { inputTokens: input, outputTokens: output, totalTokens: totalTokens ?? input + output }
}

function toFinishReason(value: unknown): TextResponse['finishReason'] {
  switch (value) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
      return 'tool_calls'
    case 'content_filter':
      return 'content_filter'
    default:
      return 'error'
  }
}
