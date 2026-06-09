import { Buffer } from 'node:buffer'
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
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type BedrockRuntimeClientConfig
} from '@aws-sdk/client-bedrock-runtime'

export interface BedrockFactoryOptions extends BedrockRuntimeClientConfig {
  /** Optional injected client for tests or custom transport behavior. */
  client?: BedrockClient
  /** Optional adapter-level logger override. Defaults to the harness logger when registered. */
  harnessLogger?: BaseModelProviderOptions['logger']
  /** Optional adapter-level telemetry override. Defaults to the harness telemetry shim when registered. */
  telemetry?: BaseModelProviderOptions['telemetry']
  /** Optional adapter-level timeout override. Defaults to the harness model timeout when registered. */
  harnessTimeoutMs?: number
}

/**
 * Creates an Amazon Bedrock-backed harness `ModelProvider`.
 *
 * @example
 * ```ts
 * import { bedrock } from '@purista/harness-bedrock'
 *
 * const provider = bedrock({ region: 'us-east-1' })
 * ```
 */
export function bedrock(options: BedrockFactoryOptions = {}): ModelProvider {
  return new BedrockModelProvider(options)
}

class BedrockModelProvider extends BaseModelProvider {
  private readonly client: BedrockClient

  public constructor(private readonly options: BedrockFactoryOptions) {
    super({
      id: 'bedrock',
      genAiSystem: 'aws.bedrock',
      ...(options.harnessLogger ? { logger: options.harnessLogger } : {}),
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
      ...(options.harnessTimeoutMs !== undefined ? { timeoutMs: options.harnessTimeoutMs } : {})
    })
    this.client = options.client ?? new BedrockRuntimeClient(toClientOptions(options))
  }

  protected override async doText(req: TextRequest): Promise<TextResponse> {
    req.signal.throwIfAborted()
    const response = await this.client.send(new ConverseCommand(toConverseInput(req, false) as any), { abortSignal: req.signal })
    const toolCalls = extractToolCalls(response, req, 'text')
    return {
      content: outputText(response),
      ...(toolCalls ? { toolCalls } : {}),
      usage: toUsage(response.usage?.inputTokens, response.usage?.outputTokens),
      finishReason: toFinishReason(response.stopReason),
      raw: response
    }
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
    req.signal.throwIfAborted()
    const response = await this.client.send(new ConverseStreamCommand(toConverseInput(req, false) as any), { abortSignal: req.signal })
    const toolState = new Map<number, { id: string; name: string; input: string }>()
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finishReason: TextResponse['finishReason'] = 'stop'

    for await (const event of response.stream ?? []) {
      req.signal.throwIfAborted()
      if (event.contentBlockDelta?.delta?.text) {
        yield { kind: 'delta', text: event.contentBlockDelta.delta.text }
      }
      if (event.contentBlockStart?.start?.toolUse) {
        toolState.set(event.contentBlockStart.contentBlockIndex ?? 0, {
          id: String(event.contentBlockStart.start.toolUse.toolUseId),
          name: String(event.contentBlockStart.start.toolUse.name),
          input: ''
        })
      }
      if (event.contentBlockDelta?.delta?.toolUse?.input) {
        const state = toolState.get(event.contentBlockDelta.contentBlockIndex ?? 0)
        if (state) state.input += event.contentBlockDelta.delta.toolUse.input
      }
      if (event.contentBlockStop) {
        const state = toolState.get(event.contentBlockStop.contentBlockIndex ?? 0)
        if (state) {
          yield { kind: 'tool_call', call: { id: state.id, name: state.name, arguments: parseJson(state.input || '{}', req, 'textStream') } }
          toolState.delete(event.contentBlockStop.contentBlockIndex ?? 0)
        }
      }
      if (event.metadata?.usage) {
        usage = toUsage(event.metadata.usage.inputTokens, event.metadata.usage.outputTokens)
      }
      if (event.messageStop?.stopReason) {
        finishReason = toFinishReason(event.messageStop.stopReason)
      }
    }

    yield { kind: 'finish', usage, finishReason }
  }

  protected override async doObject<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    req.signal.throwIfAborted()
    const response = await this.client.send(new ConverseCommand(toConverseInput(req, true) as any), { abortSignal: req.signal })
    const toolUse = response.output?.message?.content?.find((block: any) => block.toolUse?.name === 'harness_response')?.toolUse
    const toolCalls = withoutObjectTool(extractToolCalls(response, req, 'object'))
    const object = (toolUse?.input ?? parseJson(outputText(response) || '{}', req, 'object')) as T
    return {
      object,
      ...(toolCalls ? { toolCalls } : {}),
      usage: toUsage(response.usage?.inputTokens, response.usage?.outputTokens),
      finishReason: toFinishReason(response.stopReason),
      raw: response
    }
  }

  protected override async *doObjectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    req.signal.throwIfAborted()
    const response = await this.client.send(new ConverseStreamCommand(toConverseInput(req, true) as any), { abortSignal: req.signal })
    let text = ''
    let objectInput = ''
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finishReason: TextResponse['finishReason'] = 'stop'

    for await (const event of response.stream ?? []) {
      req.signal.throwIfAborted()
      if (event.contentBlockDelta?.delta?.text) {
        text += event.contentBlockDelta.delta.text
        yield { kind: 'partial', partial: safePartialJson(text) }
      }
      if (event.contentBlockDelta?.delta?.toolUse?.input) {
        objectInput += event.contentBlockDelta.delta.toolUse.input
        yield { kind: 'partial', partial: safePartialJson(objectInput) }
      }
      if (event.metadata?.usage) {
        usage = toUsage(event.metadata.usage.inputTokens, event.metadata.usage.outputTokens)
      }
      if (event.messageStop?.stopReason) {
        finishReason = toFinishReason(event.messageStop.stopReason)
      }
    }

    const object = parseJson(objectInput || text || '{}', req, 'objectStream') as T
    yield { kind: 'finish', object, usage, finishReason }
  }
}

export type BedrockClient = {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any>
}

type ChatRequest = TextRequest | ObjectRequest

function toClientOptions(options: BedrockFactoryOptions): BedrockRuntimeClientConfig {
  const { client: _client, harnessLogger: _harnessLogger, telemetry: _telemetry, harnessTimeoutMs: _harnessTimeoutMs, ...clientOptions } = options
  return clientOptions
}

function toConverseInput(req: ChatRequest, forceObject: boolean): Record<string, unknown> {
  const providerOptions = {
    ...(req.defaults?.providerOptions ?? {}),
    ...(req.call?.providerOptions ?? {})
  } as Record<string, unknown>
  const { system, messages } = toBedrockMessages(req.messages)
  const modelTools = toTools(req.tools) ?? []
  const tools = forceObject ? [...modelTools, toObjectTool(req as ObjectRequest)] : modelTools
  const forceObjectTool = forceObject && modelTools.length === 0

  return {
    modelId: req.model,
    messages,
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { toolConfig: { tools, ...(forceObjectTool ? { toolChoice: { tool: { name: 'harness_response' } } } : {}) } } : {}),
    inferenceConfig: {
      ...(req.call?.maxTokens ?? req.defaults?.maxTokens !== undefined ? { maxTokens: req.call?.maxTokens ?? req.defaults?.maxTokens } : {}),
      ...(req.call?.temperature ?? req.defaults?.temperature !== undefined ? { temperature: req.call?.temperature ?? req.defaults?.temperature } : {}),
      ...(req.call?.topP ?? req.defaults?.topP !== undefined ? { topP: req.call?.topP ?? req.defaults?.topP } : {}),
      ...(req.call?.stopSequences ?? req.defaults?.stopSequences ? { stopSequences: req.call?.stopSequences ?? req.defaults?.stopSequences } : {})
    },
    ...providerOptions
  }
}

function toBedrockMessages(messages: ModelMessage[]): { system: any[]; messages: any[] } {
  const system = messages.filter((message) => message.role === 'system').map((message) => ({ text: message.content }))
  const converted = messages.filter((message) => message.role !== 'system').map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'user',
        content: [{ toolResult: { toolUseId: message.toolCallId, content: [{ text: message.content }] } }]
      }
    }
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: [
          ...(typeof message.content === 'string' && message.content ? [{ text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ toolUse: { toolUseId: call.id, name: call.name, input: call.arguments } }))
        ]
      }
    }
    return {
      role: message.role,
      content: typeof message.content === 'string' ? [{ text: message.content }] : message.content.map(toContentBlock)
    }
  })
  return { system, messages: converted }
}

function toContentBlock(part: ContentPart): any {
  if (part.kind === 'text') return { text: part.text }
  if (part.kind === 'image') {
    const format = part.mimeType.split('/')[1] ?? 'png'
    return { image: { format, source: { bytes: Buffer.from(part.dataBase64, 'base64') } } }
  }
  return { text: `[unsupported ${part.kind} content omitted]` }
}

function toTools(tools: ChatRequest['tools']): any[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.parameters }
    }
  }))
}

function toObjectTool(req: ObjectRequest): any {
  return {
    toolSpec: {
      name: 'harness_response',
      description: 'Return the structured response object.',
      inputSchema: { json: req.schema }
    }
  }
}

function outputText(response: any): string {
  return response.output?.message?.content?.filter((block: any) => typeof block.text === 'string').map((block: any) => block.text).join('') ?? ''
}

function extractToolCalls(response: any, req: ChatRequest, method: string): ToolCallSpec[] | undefined {
  const calls = response.output?.message?.content?.map((block: any) => block.toolUse).filter(Boolean)
  if (!calls || calls.length === 0) return undefined
  return calls.map((call: any) => ({
    id: String(call.toolUseId),
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
    throw malformedResponseError(req, method, 'Amazon Bedrock returned malformed structured JSON.', content, error)
  }
}

function malformedResponseError(req: ChatRequest, method: string, message: string, body: unknown, cause: unknown): ModelError {
  return new ModelError(message, {
    provider: 'bedrock',
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
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'content_filter'
    default:
      return 'error'
  }
}
