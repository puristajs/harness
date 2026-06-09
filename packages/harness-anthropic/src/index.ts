import type {
  BaseModelProviderOptions,
  ContentPart,
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
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'

export interface AnthropicFactoryOptions extends ClientOptions {
  /** Optional injected client for tests or custom transport behavior. */
  client?: AnthropicClient
  /** Optional adapter-level logger override. Defaults to the harness logger when registered. */
  harnessLogger?: BaseModelProviderOptions['logger']
  /** Optional adapter-level telemetry override. Defaults to the harness telemetry shim when registered. */
  telemetry?: BaseModelProviderOptions['telemetry']
  /** Optional adapter-level timeout override. Defaults to the harness model timeout when registered. */
  harnessTimeoutMs?: number
}

/**
 * Creates an Anthropic-backed harness `ModelProvider`.
 *
 * @example
 * ```ts
 * import { anthropic } from '@purista/harness-anthropic'
 *
 * const provider = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
 * ```
 */
export function anthropic(options: AnthropicFactoryOptions = {}): ModelProvider {
  return new AnthropicModelProvider(options)
}

class AnthropicModelProvider extends BaseModelProvider {
  private readonly client: AnthropicClient

  public constructor(private readonly options: AnthropicFactoryOptions) {
    super({
      id: 'anthropic',
      genAiSystem: 'anthropic',
      ...(options.harnessLogger ? { logger: options.harnessLogger } : {}),
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
      ...(options.harnessTimeoutMs !== undefined ? { timeoutMs: options.harnessTimeoutMs } : options.timeout !== undefined ? { timeoutMs: options.timeout } : {})
    })
    this.client = options.client ?? new Anthropic(toClientOptions(options))
  }

  protected override async doText(req: TextRequest): Promise<TextResponse> {
    req.signal.throwIfAborted()
    const response = await createMessage(this.client, req, false)
    const toolCalls = extractToolCalls(response, req, 'text')
    return {
      content: response.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') ?? '',
      ...(toolCalls ? { toolCalls } : {}),
      usage: toUsage(response.usage?.input_tokens, response.usage?.output_tokens),
      finishReason: toFinishReason(response.stop_reason),
      raw: response
    }
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
    req.signal.throwIfAborted()
    const stream = await createMessage(this.client, req, true)
    const toolState = new Map<number, { id: string; name: string; input: string }>()
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finishReason: TextResponse['finishReason'] = 'stop'

    for await (const event of stream) {
      req.signal.throwIfAborted()
      if (event.type === 'message_start') {
        usage = toUsage(event.message?.usage?.input_tokens, event.message?.usage?.output_tokens)
      } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        toolState.set(event.index, {
          id: String(event.content_block.id),
          name: String(event.content_block.name),
          input: JSON.stringify(event.content_block.input ?? {})
        })
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') {
          yield { kind: 'delta', text: event.delta.text }
        } else if (event.delta?.type === 'input_json_delta') {
          const state = toolState.get(event.index)
          if (state) state.input += event.delta.partial_json
        }
      } else if (event.type === 'content_block_stop') {
        const state = toolState.get(event.index)
        if (state) {
          yield { kind: 'tool_call', call: { id: state.id, name: state.name, arguments: parseJson(state.input, req, 'textStream') } }
          toolState.delete(event.index)
        }
      } else if (event.type === 'message_delta') {
        finishReason = toFinishReason(event.delta?.stop_reason)
        usage = toUsage(usage.inputTokens, event.usage?.output_tokens ?? usage.outputTokens)
      }
    }

    yield { kind: 'finish', usage, finishReason }
  }

  protected override async doObject<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    req.signal.throwIfAborted()
    const response = await createMessage(this.client, req, false, true)
    const toolUse = response.content?.find((block: any) => block.type === 'tool_use' && block.name === 'harness_response')
    const toolCalls = withoutObjectTool(extractToolCalls(response, req, 'object'))
    const object = (toolUse?.input ?? parseJson(response.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('') || '{}', req, 'object')) as T
    return {
      object,
      ...(toolCalls ? { toolCalls } : {}),
      usage: toUsage(response.usage?.input_tokens, response.usage?.output_tokens),
      finishReason: toFinishReason(response.stop_reason),
      raw: response
    }
  }

  protected override async *doObjectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    req.signal.throwIfAborted()
    const stream = await createMessage(this.client, req, true, true)
    let text = ''
    let objectInput = ''
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finishReason: TextResponse['finishReason'] = 'stop'

    for await (const event of stream) {
      req.signal.throwIfAborted()
      if (event.type === 'message_start') {
        usage = toUsage(event.message?.usage?.input_tokens, event.message?.usage?.output_tokens)
      } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use' && event.content_block.name === 'harness_response') {
        objectInput = JSON.stringify(event.content_block.input ?? {})
      } else if (event.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta') {
          text += event.delta.text
          yield { kind: 'partial', partial: safePartialJson(text) }
        } else if (event.delta?.type === 'input_json_delta') {
          objectInput += event.delta.partial_json
          yield { kind: 'partial', partial: safePartialJson(objectInput) }
        }
      } else if (event.type === 'message_delta') {
        finishReason = toFinishReason(event.delta?.stop_reason)
        usage = toUsage(usage.inputTokens, event.usage?.output_tokens ?? usage.outputTokens)
      }
    }

    const object = parseJson(objectInput || text || '{}', req, 'objectStream') as T
    yield { kind: 'finish', object, usage, finishReason }
  }
}

export type AnthropicClient = {
  messages: {
    create(payload: unknown, options?: { signal?: AbortSignal }): Promise<any>
  }
}

type ChatRequest = TextRequest | ObjectRequest

function toClientOptions(options: AnthropicFactoryOptions): ClientOptions {
  const { client: _client, harnessLogger: _harnessLogger, telemetry: _telemetry, harnessTimeoutMs: _harnessTimeoutMs, ...clientOptions } = options
  return clientOptions
}

async function createMessage(client: AnthropicClient, req: ChatRequest, stream: boolean, forceObject = false): Promise<any> {
  const providerOptions = {
    ...(req.defaults?.providerOptions ?? {}),
    ...(req.call?.providerOptions ?? {})
  } as Record<string, unknown> & { requestOptions?: Record<string, unknown>; tool_choice?: unknown }
  const { requestOptions, tool_choice: providerToolChoice, ...bodyOptions } = providerOptions
  const { system, messages } = toAnthropicMessages(req.messages)
  const modelTools = toTools(req.tools) ?? []
  const tools = forceObject ? [...modelTools, toObjectTool(req as ObjectRequest)] : modelTools
  const forceObjectTool = forceObject && modelTools.length === 0
  const toolChoice = anthropicToolChoice(providerToolChoice, forceObjectTool, req.call?.parallelToolCalls ?? req.defaults?.parallelToolCalls)

  return client.messages.create({
    model: req.model,
    messages,
    stream,
    max_tokens: req.call?.maxTokens ?? req.defaults?.maxTokens ?? 1024,
    ...(system ? { system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(req.call?.temperature ?? req.defaults?.temperature !== undefined ? { temperature: req.call?.temperature ?? req.defaults?.temperature } : {}),
    ...(req.call?.topP ?? req.defaults?.topP !== undefined ? { top_p: req.call?.topP ?? req.defaults?.topP } : {}),
    ...(req.call?.stopSequences ?? req.defaults?.stopSequences ? { stop_sequences: req.call?.stopSequences ?? req.defaults?.stopSequences } : {}),
    ...bodyOptions
  }, { ...requestOptions, signal: req.signal })
}

function anthropicToolChoice(providerToolChoice: unknown, forceObjectTool: boolean, parallelToolCalls: boolean | undefined): unknown {
  if (providerToolChoice !== undefined) return providerToolChoice
  if (forceObjectTool) return { type: 'tool', name: 'harness_response' }
  if (parallelToolCalls === false) return { type: 'auto', disable_parallel_tool_use: true }
  return undefined
}

function toAnthropicMessages(messages: ModelMessage[]): { system?: string; messages: any[] } {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n')
  const converted = messages.filter((message) => message.role !== 'system').map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]
      }
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: [
          ...(typeof message.content === 'string' && message.content ? [{ type: 'text', text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }))
        ]
      }
    }
    return {
      role: message.role,
      content: typeof message.content === 'string' ? message.content : message.content.map(toContentBlock)
    }
  })
  return {
    ...(system ? { system } : {}),
    messages: converted
  }
}

function toContentBlock(part: ContentPart): any {
  if (part.kind === 'text') return { type: 'text', text: part.text }
  if (part.kind === 'image') {
    return { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.dataBase64 } }
  }
  if (part.kind === 'image_url') {
    return { type: 'image', source: { type: 'url', url: part.url } }
  }
  return { type: 'text', text: `[unsupported ${part.kind} content omitted]` }
}

function toTools(tools: ChatRequest['tools']): any[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }))
}

function toObjectTool(req: ObjectRequest): any {
  return {
    name: 'harness_response',
    description: 'Return the structured response object.',
    input_schema: req.schema
  }
}

function extractToolCalls(response: any, req: ChatRequest, method: string): ToolCallSpec[] | undefined {
  const calls = response.content?.filter((block: any) => block.type === 'tool_use' && block.name && block.id)
  if (!calls || calls.length === 0) return undefined
  return calls.map((call: any) => ({
    id: String(call.id),
    name: String(call.name),
    arguments: typeof call.input === 'string' ? parseJson(call.input, req, method) : call.input ?? {}
  }))
}

function withoutObjectTool(calls: ToolCallSpec[] | undefined): ToolCallSpec[] | undefined {
  const filtered = calls?.filter((call) => call.name !== 'harness_response')
  return filtered && filtered.length > 0 ? filtered : undefined
}

function parseJson(content: string, req: ChatRequest, method: string): JsonValue {
  try {
    return JSON.parse(content)
  } catch (error) {
    throw malformedResponseError(req, method, 'Anthropic returned malformed structured JSON.', content, error)
  }
}

function malformedResponseError(req: ChatRequest, method: string, message: string, body: unknown, cause: unknown): ModelError {
  return new ModelError(message, {
    provider: 'anthropic',
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
  return { inputTokens: input, outputTokens: output, totalTokens: input + output }
}

function toFinishReason(value: unknown): TextResponse['finishReason'] {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
    default:
      return 'error'
  }
}
