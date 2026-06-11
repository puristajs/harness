import type {
  BaseModelProviderOptions,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelMessage,
  ModelProvider,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
  TextRequest,
  TextResponse,
  TextStreamChunk,
  ToolCallSpec,
  TokenUsage,
  JsonValue
} from '@purista/harness'
import { BaseModelProvider, ModelError } from '@purista/harness'
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
 *       handler: (ctx) => ctx.agents.assistant(ctx.input)
 *     }
 *   })
 *   .build()
 *
 * const session = await harness.getSession('demo')
 * const response = await session.workflows.summarize.prompt('Summarize this issue.')
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
    this.client = options.client ?? new OpenAI(toClientOptions(options))
  }

  protected override async doText(req: TextRequest): Promise<TextResponse> {
      req.signal.throwIfAborted()
      if (this.options.api === 'responses') {
        const response = await createResponse(this.client, req, false)
        return mapResponsesTextResponse(response, req)
      }
      const response = await createChatCompletion(this.client, req, false, this.getLogger())
      return mapChatTextResponse(response, req)
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
      req.signal.throwIfAborted()
      if (this.options.api === 'responses') {
        yield * streamResponsesText(this.client, req)
        return
      }
      const stream = await createChatCompletion(this.client, req, true, this.getLogger())
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      let finishReason: TextResponse['finishReason'] = 'stop'
      const toolState: StreamToolCallState = new Map()
      for await (const chunk of stream) {
        req.signal.throwIfAborted()
        // The usage chunk arrives with an empty choices array, so read it first.
        if (chunk.usage) {
          usage = toUsage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens)
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
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
      for (const call of finalizeStreamToolCalls(toolState, req, 'textStream')) {
        yield { kind: 'tool_call', call }
      }
      yield { kind: 'finish', usage, finishReason }
  }

  protected override async doObject<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
      req.signal.throwIfAborted()
      if (this.options.api === 'responses') {
        const response = await createResponse(this.client, req, false)
        const content = extractResponsesText(response)
        const toolCalls = extractResponsesToolCalls(response, req, 'object')
        return {
          object: parseJson(content || '{}', req, 'object') as T,
          ...(toolCalls ? { toolCalls } : {}),
          usage: toResponsesUsage(response.usage),
          finishReason: toResponsesFinishReason(response),
          raw: response
        }
      }
      const response = await createChatCompletion(this.client, req, false, this.getLogger())
      const textContent = response.choices[0]?.message?.content ?? '{}'
      const toolCalls = extractChatToolCalls(response, req, 'object')
      return {
        object: parseJson(textContent, req, 'object') as T,
        ...(toolCalls ? { toolCalls } : {}),
        usage: toUsage(response.usage?.prompt_tokens, response.usage?.completion_tokens),
        finishReason: toFinishReason(response.choices[0]?.finish_reason),
        raw: response
      }
  }

  protected override async *doObjectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
      req.signal.throwIfAborted()
      let partial = ''
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      let finishReason: TextResponse['finishReason'] = 'stop'
      const toolState: StreamToolCallState = new Map()
      if (this.options.api === 'responses') {
        yield * streamResponsesObject<T>(this.client, req)
        return
      }
      const stream = await createChatCompletion(this.client, req, true, this.getLogger())
      for await (const chunk of stream) {
        req.signal.throwIfAborted()
        if (chunk.usage) {
          usage = toUsage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens)
        }
        const choice = chunk.choices?.[0]
        if (!choice) continue
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
    const response = await this.client.embeddings.create({
      model: req.model,
      input: req.input,
      ...(req.dimensions !== undefined ? { dimensions: req.dimensions } : {}),
      ...bodyOptions
    }, { ...requestOptions, signal: req.signal })

    return {
      embeddings: response.data.map((item: any) => ({ index: item.index, vector: item.embedding })),
      usage: toUsage(response.usage?.prompt_tokens, 0),
      raw: response
    }
  }
}

type ChatRequest = TextRequest | ObjectRequest
export type OpenAiClient = {
  chat: {
    completions: {
      create(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
    }
  }
  responses?: {
    create(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
  }
  embeddings: {
    create(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
  }
}

function toClientOptions(options: OpenAiFactoryOptions): ClientOptions {
  const { api: _api, client: _client, harnessLogger: _harnessLogger, telemetry: _telemetry, harnessTimeoutMs: _harnessTimeoutMs, ...clientOptions } = options
  return clientOptions
}

function mapChatTextResponse(response: any, req: TextRequest): TextResponse {
  const toolCalls = extractChatToolCalls(response, req, 'text')
  return {
    content: response.choices[0]?.message?.content ?? '',
    ...(toolCalls ? { toolCalls } : {}),
    usage: toUsage(response.usage?.prompt_tokens, response.usage?.completion_tokens),
    finishReason: toFinishReason(response.choices[0]?.finish_reason),
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

async function createChatCompletion(client: any, req: ChatRequest, stream: boolean, logger?: BaseModelProviderOptions['logger']): Promise<any> {
  const messages = toOpenAiMessages(req.messages)
  const providerOptions = {
    ...(req.defaults?.providerOptions ?? {}),
    ...(req.call?.providerOptions ?? {})
  } as Record<string, unknown> & { requestOptions?: Record<string, unknown> }
  const { requestOptions, ...bodyOptions } = providerOptions
  const normalizedBodyOptions = omitUnsupportedChatCompletionOptions(bodyOptions, req, logger)

  return client.chat.completions.create({
    model: req.model,
    messages,
    stream,
    // OpenAI only emits a usage chunk during streaming when this is set.
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    tools: toTools(req.tools),
    temperature: req.call?.temperature ?? req.defaults?.temperature,
    max_tokens: req.call?.maxTokens ?? req.defaults?.maxTokens,
    top_p: req.call?.topP ?? req.defaults?.topP,
    stop: req.call?.stopSequences ?? req.defaults?.stopSequences,
    ...(req.tools && (req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls) !== undefined ? { parallel_tool_calls: req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls } : {}),
    response_format: toResponseFormat(req),
    ...normalizedBodyOptions
  }, { ...requestOptions, signal: req.signal })
}

async function createResponse(client: any, req: ChatRequest, stream: boolean): Promise<any> {
  if (!client.responses?.create) {
    throw new ModelError('OpenAI client does not expose the Responses API.', {
      provider: 'openai',
      model: req.model,
      method: stream ? ('schema' in req ? 'objectStream' : 'textStream') : ('schema' in req ? 'object' : 'text'),
      reason: 'unstructured_response',
      providerBody: { api: 'responses' }
    })
  }

  const providerOptions = {
    ...(req.defaults?.providerOptions ?? {}),
    ...(req.call?.providerOptions ?? {})
  } as Record<string, unknown> & { requestOptions?: Record<string, unknown> }
  const { requestOptions, ...bodyOptions } = toResponsesProviderOptions(providerOptions)

  return client.responses.create({
    model: req.model,
    input: toResponsesInput(req.messages),
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

function toResponsesInput(messages: ModelMessage[]): any[] {
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

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      if (typeof message.content === 'string' && message.content.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: message.content
        })
      }
      for (const call of message.toolCalls) {
        input.push({
          type: 'function_call',
          id: call.id,
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
  return {
    content: extractResponsesText(response),
    ...(toolCalls ? { toolCalls } : {}),
    usage: toResponsesUsage(response.usage),
    finishReason: toResponsesFinishReason(response),
    raw: response
  }
}

async function* streamResponsesText(client: any, req: TextRequest): AsyncIterable<TextStreamChunk> {
  const stream = await createResponse(client, req, true)
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let finishReason: TextResponse['finishReason'] = 'stop'
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
    } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      finishReason = 'error'
    }
  }

  for (const call of finalizeResponsesStreamToolCalls(toolState, req, 'textStream')) {
    yield { kind: 'tool_call', call }
  }
  yield { kind: 'finish', usage, finishReason }
}

async function* streamResponsesObject<T extends JsonValue = JsonValue>(client: any, req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
  const stream = await createResponse(client, req, true)
  let partial = ''
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let finishReason: TextResponse['finishReason'] = 'stop'
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
    } else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
      finishReason = 'error'
    }
  }

  for (const call of finalizeResponsesStreamToolCalls(toolState, req, 'objectStream')) {
    yield { kind: 'tool_call', call }
  }
  const object = parseJson(partial || '{}', req, 'objectStream') as T
  yield { kind: 'finish', object, usage, finishReason }
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
  existing.id ??= String(event.item_id)
  existing.name = String(event.name)
  if (typeof event.arguments === 'string') existing.args = event.arguments
  state.set(index, existing)
}

function finalizeResponsesStreamToolCalls(state: ResponsesStreamToolCallState, req: ChatRequest, method: string): ToolCallSpec[] {
  return [...state.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, call]) => call.id && call.name)
    .map(([, call]) => ({
      id: call.id as string,
      name: call.name as string,
      arguments: parseToolArgs(call.args || undefined, req, method)
    }))
}

/**
 * Per-index accumulator for streamed tool-call fragments. OpenAI streams a
 * tool call across many deltas: the first carries `index`/`id`/`function.name`
 * with partial/empty arguments, later deltas carry only `index` and argument
 * fragments. We must concatenate by index and parse arguments once at the end.
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
      arguments: parseToolArgs(call.args || undefined, req, method)
    }))
}

function parseToolArgs(argumentsText: string | undefined, req: ChatRequest, method: string): JsonValue {
  if (!argumentsText) return {}
  try {
    return JSON.parse(argumentsText)
  } catch (error) {
    throw malformedResponseError(req, method, 'OpenAI returned malformed tool-call argument JSON.', argumentsText, error)
  }
}

function parseJson(content: string, req: ChatRequest, method: string): JsonValue {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw malformedResponseError(req, method, 'OpenAI returned malformed structured object JSON.', content, error)
  }
}

function malformedResponseError(req: ChatRequest, method: string, message: string, body: unknown, cause: unknown): ModelError {
  return new ModelError(message, {
    provider: 'openai',
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

function toUsage(inputTokens?: number, outputTokens?: number): TokenUsage {
  const input = inputTokens ?? 0
  const output = outputTokens ?? 0
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output
  }
}

function toResponsesUsage(usage: any): TokenUsage {
  return toUsage(usage?.input_tokens, usage?.output_tokens)
}

function toFinishReason(value: unknown): TextResponse['finishReason'] {
  switch (value) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
      return value
    default:
      return 'error'
  }
}

function toResponsesFinishReason(response: any): TextResponse['finishReason'] {
  if (!response) return 'error'
  if ((response.output ?? []).some((item: any) => item?.type === 'function_call')) return 'tool_calls'
  switch (response.status) {
    case 'completed':
      return 'stop'
    case 'incomplete':
      return 'length'
    default:
      return response.error ? 'error' : 'stop'
  }
}
