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
 * - External network calls to OpenAI-compatible chat completions endpoint
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
      const response = await createChatCompletion(this.client, req, false)
      return mapTextResponse(response, req)
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
      req.signal.throwIfAborted()
      const stream = await createChatCompletion(this.client, req, true)
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
      const response = await createChatCompletion(this.client, req, false)
      const textContent = response.choices[0]?.message?.content ?? '{}'
      const toolCalls = extractToolCalls(response, req, 'object')
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
      const stream = await createChatCompletion(this.client, req, true)
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
  embeddings: {
    create(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
  }
}

function toClientOptions(options: OpenAiFactoryOptions): ClientOptions {
  const { client: _client, harnessLogger: _harnessLogger, telemetry: _telemetry, harnessTimeoutMs: _harnessTimeoutMs, ...clientOptions } = options
  return clientOptions
}

function mapTextResponse(response: any, req: TextRequest): TextResponse {
  const toolCalls = extractToolCalls(response, req, 'text')
  return {
    content: response.choices[0]?.message?.content ?? '',
    ...(toolCalls ? { toolCalls } : {}),
    usage: toUsage(response.usage?.prompt_tokens, response.usage?.completion_tokens),
    finishReason: toFinishReason(response.choices[0]?.finish_reason),
    raw: response
  }
}

function extractToolCalls(response: any, req: ChatRequest, method: string): ToolCallSpec[] | undefined {
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

async function createChatCompletion(client: any, req: ChatRequest, stream: boolean): Promise<any> {
  const messages = toOpenAiMessages(req.messages)
  const providerOptions = {
    ...(req.defaults?.providerOptions ?? {}),
    ...(req.call?.providerOptions ?? {})
  } as Record<string, unknown> & { requestOptions?: Record<string, unknown> }
  const { requestOptions, ...bodyOptions } = providerOptions

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
    ...bodyOptions
  }, { ...requestOptions, signal: req.signal })
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
