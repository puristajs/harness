import { Buffer } from 'node:buffer'
import type {
  AdapterCallContext,
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
import {
  BaseModelProvider,
  parseProviderJson,
  safePartialJson,
  toTokenUsage,
  withoutObjectTool
} from '@purista/harness'
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type BedrockRuntimeClientConfig
} from '@aws-sdk/client-bedrock-runtime'

/** Configuration for the Amazon Bedrock model provider factory. */
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
    const { input, requestOptions } = toConverseRequest(req, false)
    const response = await this.client.send(new ConverseCommand(input as any), { ...requestOptions, abortSignal: req.signal })
    const toolCalls = extractToolCalls(response, req, 'text')
    return {
      content: outputText(response),
      ...(toolCalls ? { toolCalls } : {}),
      usage: toBedrockUsage(response.usage),
      finishReason: toFinishReason(response.stopReason),
      outcome: toOutcome(response.stopReason),
      raw: response
    }
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
    req.signal.throwIfAborted()
    const { input, requestOptions } = toConverseRequest(req, false)
    const response = await this.client.send(new ConverseStreamCommand(input as any), { ...requestOptions, abortSignal: req.signal })
    const toolState = new Map<number, { id: string; name: string; input: string }>()
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finishReason: TextResponse['finishReason'] = 'stop'
    let providerFinishReason: unknown

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
        usage = toBedrockUsage(event.metadata.usage)
      }
      if (event.messageStop?.stopReason) {
        providerFinishReason = event.messageStop.stopReason
        finishReason = toFinishReason(providerFinishReason)
      }
    }

    yield { kind: 'finish', usage, finishReason, outcome: streamOutcome(finishReason, providerFinishReason) }
  }

  protected override async doObject<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    req.signal.throwIfAborted()
    const { input, requestOptions } = toConverseRequest(req, true)
    const response = await this.client.send(new ConverseCommand(input as any), { ...requestOptions, abortSignal: req.signal })
    const toolUse = response.output?.message?.content?.find((block: any) => block.toolUse?.name === 'harness_response')?.toolUse
    const toolCalls = withoutObjectTool(extractToolCalls(response, req, 'object'))
    const object = (toolUse?.input ?? parseJson(outputText(response) || '{}', req, 'object')) as T
    return {
      object,
      ...(toolCalls ? { toolCalls } : {}),
      usage: toBedrockUsage(response.usage),
      finishReason: toFinishReason(response.stopReason),
      outcome: toOutcome(response.stopReason),
      raw: response
    }
  }

  protected override async *doObjectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    req.signal.throwIfAborted()
    const { input, requestOptions } = toConverseRequest(req, true)
    const response = await this.client.send(new ConverseStreamCommand(input as any), { ...requestOptions, abortSignal: req.signal })
    let text = ''
    let objectInput = ''
    let objectBlockIndex: number | undefined
    const toolState = new Map<number, { id: string; name: string; input: string }>()
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let finishReason: TextResponse['finishReason'] = 'stop'
    let providerFinishReason: unknown

    for await (const event of response.stream ?? []) {
      req.signal.throwIfAborted()
      if (event.contentBlockDelta?.delta?.text) {
        text += event.contentBlockDelta.delta.text
        yield { kind: 'partial', partial: safePartialJson(text) }
      }
      if (event.contentBlockStart?.start?.toolUse) {
        // Only the synthetic `harness_response` block carries the structured
        // object; other tool blocks are real tool calls and must not bleed
        // into the object JSON (parity with the OpenAI/Azure adapters).
        const blockIndex = event.contentBlockStart.contentBlockIndex ?? 0
        if (event.contentBlockStart.start.toolUse.name === 'harness_response' && objectBlockIndex === undefined) {
          objectBlockIndex = blockIndex
        } else {
          toolState.set(blockIndex, {
            id: String(event.contentBlockStart.start.toolUse.toolUseId),
            name: String(event.contentBlockStart.start.toolUse.name),
            input: ''
          })
        }
      }
      if (event.contentBlockDelta?.delta?.toolUse?.input) {
        const blockIndex = event.contentBlockDelta.contentBlockIndex ?? 0
        const state = toolState.get(blockIndex)
        if (state) {
          state.input += event.contentBlockDelta.delta.toolUse.input
        } else {
          objectInput += event.contentBlockDelta.delta.toolUse.input
          yield { kind: 'partial', partial: safePartialJson(objectInput) }
        }
      }
      if (event.contentBlockStop) {
        const state = toolState.get(event.contentBlockStop.contentBlockIndex ?? 0)
        if (state) {
          yield { kind: 'tool_call', call: { id: state.id, name: state.name, arguments: parseJson(state.input || '{}', req, 'objectStream') } }
          toolState.delete(event.contentBlockStop.contentBlockIndex ?? 0)
        }
      }
      if (event.metadata?.usage) {
        usage = toBedrockUsage(event.metadata.usage)
      }
      if (event.messageStop?.stopReason) {
        providerFinishReason = event.messageStop.stopReason
        finishReason = toFinishReason(providerFinishReason)
      }
    }

    const object = parseJson(objectInput || text || '{}', req, 'objectStream') as T
    yield { kind: 'finish', object, usage, finishReason, outcome: streamOutcome(finishReason, providerFinishReason) }
  }
}

/** Narrow Amazon Bedrock Runtime SDK surface accepted for test or custom transport injection. */
export type BedrockClient = {
  /** Sends a Bedrock runtime command with optional cancellation. */
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<any>
}

type ChatRequest = TextRequest | ObjectRequest

function toBedrockUsage(usage: any): TokenUsage {
  return toTokenUsage(usage?.inputTokens, usage?.outputTokens, usage?.totalTokens, {
    cachedInputTokens: usage?.cacheReadInputTokens,
    cacheCreationInputTokens: usage?.cacheWriteInputTokens
  })
}

function toClientOptions(options: BedrockFactoryOptions): BedrockRuntimeClientConfig {
  const { client: _client, harnessLogger: _harnessLogger, telemetry: _telemetry, harnessTimeoutMs: _harnessTimeoutMs, ...clientOptions } = options
  return { maxAttempts: 1, ...clientOptions }
}

/**
 * Builds the Converse request body and extracts `requestOptions`, which are
 * per-request SDK transport options (mirroring the other adapters) and must
 * not leak into the Converse request body.
 */
function toConverseRequest(req: ChatRequest, forceObject: boolean): { input: Record<string, unknown>; requestOptions?: Record<string, unknown> } {
  const providerOptions = {
    ...(req.defaults?.providerOptions ?? {}),
    ...(req.call?.providerOptions ?? {})
  } as Record<string, unknown> & { requestOptions?: Record<string, unknown> }
  const { requestOptions, ...bodyOptions } = providerOptions
  const { system, messages } = toBedrockMessages(req.messages)
  const modelTools = toTools(req.tools) ?? []
  const tools = forceObject ? [...modelTools, toObjectTool(req as ObjectRequest)] : modelTools
  const forceObjectTool = forceObject && modelTools.length === 0

  const input = {
    modelId: req.model,
    messages,
    ...(system.length > 0 ? { system } : {}),
    ...(tools.length > 0 ? { toolConfig: { tools, ...(forceObjectTool ? { toolChoice: { tool: { name: 'harness_response' } } } : {}) } } : {}),
    inferenceConfig: {
      ...((req.call?.maxTokens ?? req.defaults?.maxTokens) !== undefined ? { maxTokens: req.call?.maxTokens ?? req.defaults?.maxTokens } : {}),
      ...((req.call?.temperature ?? req.defaults?.temperature) !== undefined ? { temperature: req.call?.temperature ?? req.defaults?.temperature } : {}),
      ...((req.call?.topP ?? req.defaults?.topP) !== undefined ? { topP: req.call?.topP ?? req.defaults?.topP } : {}),
      ...((req.call?.stopSequences ?? req.defaults?.stopSequences) !== undefined ? { stopSequences: req.call?.stopSequences ?? req.defaults?.stopSequences } : {})
    },
    ...bodyOptions
  }
  return { input, ...(requestOptions ? { requestOptions } : {}) }
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

const MALFORMED_JSON_MESSAGE = 'Amazon Bedrock returned malformed structured JSON.'

function callContext(req: ChatRequest, method: string): AdapterCallContext {
  return { provider: 'bedrock', model: req.model, method }
}

function parseJson(content: string, req: ChatRequest, method: string): JsonValue {
  return parseProviderJson(content, callContext(req, method), MALFORMED_JSON_MESSAGE)
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
    case 'malformed_model_output':
    case 'malformed_tool_use':
      return 'malformed'
    case 'model_context_window_exceeded':
      return 'context_limit'
    default:
      return 'error'
  }
}

function toOutcome(value: unknown): NonNullable<TextResponse['outcome']> {
  const finishReason = toFinishReason(value)
  return {
    finishReason,
    ...(typeof value === 'string' ? { providerFinishReason: value } : {})
  }
}

/**
 * Stream outcome built from the tracked finish reason; `providerFinishReason`
 * is omitted entirely when the provider never sent a stop reason.
 */
function streamOutcome(finishReason: TextResponse['finishReason'], providerFinishReason: unknown): NonNullable<TextResponse['outcome']> {
  return {
    finishReason,
    ...(typeof providerFinishReason === 'string' ? { providerFinishReason } : {})
  }
}
