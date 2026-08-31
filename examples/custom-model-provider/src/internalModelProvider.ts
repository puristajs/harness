import {
  BaseModelProvider,
  type JsonValue,
  type ObjectRequest,
  type ObjectResponse,
  type TokenUsage,
} from '@purista/harness'

export interface InternalJsonRequest {
  model: string
  messages: ObjectRequest['messages']
  schema: JsonValue
  signal: AbortSignal
}

export interface InternalJsonResult {
  value: JsonValue
  inputTokens: number
  outputTokens: number
  stopReason: 'complete' | 'limit'
}

export interface InternalJsonClient {
  generateJson(request: InternalJsonRequest): Promise<InternalJsonResult>
  close?(): Promise<void>
}

export class InternalModelProvider extends BaseModelProvider {
  public constructor(private readonly client: InternalJsonClient) {
    super({ id: 'internal-gateway', genAiSystem: 'internal-gateway' })
  }

  protected override async doObject<T extends JsonValue = JsonValue>(
    request: ObjectRequest<T>,
  ): Promise<ObjectResponse<T>> {
    const result = await this.client.generateJson({
      model: request.model,
      messages: request.messages,
      schema: request.schema,
      signal: request.signal,
    })
    const finishReason = result.stopReason === 'complete' ? 'stop' : 'length'
    const usage: TokenUsage = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.inputTokens + result.outputTokens,
    }

    return {
      object: result.value as T,
      usage,
      finishReason,
      outcome: {
        finishReason,
        providerFinishReason: result.stopReason,
      },
    }
  }

  public async close(): Promise<void> {
    await this.client.close?.()
  }
}
