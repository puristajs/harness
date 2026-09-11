import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ModelProvider,
  ObjectRequest,
  ObjectResponse,
  ObjectStreamChunk,
  RerankRequest,
  RerankResponse,
  TextRequest,
  TextResponse,
  TextStreamChunk,
} from '../ports/model-provider.js'
import type { JsonValue } from '../models/json.js'

type ScriptedResponse =
  | { method: 'text'; response: TextResponse }
  | { method: 'object'; response: ObjectResponse }
  | { method: 'embed'; response: EmbeddingResponse }
  | { method: 'rerank'; response: RerankResponse }

/** Configures deterministic failure behavior for {@link FakeModelProvider}. */
export interface FakeModelProviderOptions {
  /**
   * Reject a model request unless the matching response was queued explicitly.
   * Enable this in application tests so an extra model round or a wrong model
   * operation cannot fall through to the legacy empty response.
   */
  strict?: boolean
}

/**
 * Deterministic model provider for Harness tests and examples.
 *
 * @example
 * ```ts
 * const provider = new FakeModelProvider({ strict: true })
 * provider.enqueueObject({ object: { priority: 'high' }, finishReason: 'stop' })
 * // Run the Harness interaction, then verify every fixture was consumed.
 * provider.assertExhausted()
 * ```
 */
export class FakeModelProvider implements ModelProvider {
  private queue: ScriptedResponse[] = []
  private textStreamQueue: TextStreamChunk[][] = []
  private objectStreamQueue: ObjectStreamChunk[][] = []
  private readonly strict: boolean

  public readonly requests: Array<TextRequest | ObjectRequest | EmbeddingRequest | RerankRequest> = []
  public readonly id = 'fake'
  public readonly genAiSystem = 'fake'

  public constructor(options: FakeModelProviderOptions = {}) {
    this.strict = options.strict ?? false
  }

  /** Queues the next structured-object response. */
  enqueueObject(response: ObjectResponse): void {
    this.queue.push({ method: 'object', response })
  }
  /** Queues the next text response. */
  enqueueText(response: TextResponse): void {
    this.queue.push({ method: 'text', response })
  }
  /** Queues the next embedding response. */
  enqueueEmbedding(response: EmbeddingResponse): void {
    this.queue.push({ method: 'embed', response })
  }
  /** Queues the next reranking response. */
  enqueueRerank(response: RerankResponse): void {
    this.queue.push({ method: 'rerank', response })
  }
  /** Queues the chunks returned by the next text-stream request. */
  enqueueTextStream(chunks: TextStreamChunk[]): void {
    this.textStreamQueue.push(chunks)
  }
  /** Queues the chunks returned by the next object-stream request. */
  enqueueObjectStream(chunks: ObjectStreamChunk[]): void {
    this.objectStreamQueue.push(chunks)
  }

  /** Backward-compatible helper for older tests during the object migration. */
  enqueue(response: ObjectResponse): void {
    this.enqueueObject(response)
  }

  /**
   * Verifies that the test consumed every queued response.
   * Call this after the Harness interaction to detect missing model rounds.
   */
  assertExhausted(): void {
    const remaining = this.queue.length + this.textStreamQueue.length + this.objectStreamQueue.length
    if (remaining === 0) return
    throw new Error(`FakeModelProvider has ${remaining} unconsumed scripted response${remaining === 1 ? '' : 's'}.`)
  }

  async text(req: TextRequest): Promise<TextResponse> {
    this.requests.push(req)
    const next = this.queue.shift()
    if (next?.method === 'text') return next.response
    if (next) this.queue.unshift(next)
    this.rejectUnexpected('text', next?.method)
    return { content: '', usage: emptyUsage(), toolCalls: [], finishReason: 'stop' }
  }

  async *textStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
    this.requests.push(req)
    const chunks = this.textStreamQueue.shift()
    if (!chunks) this.rejectUnexpected('textStream')
    for (const chunk of chunks ?? [{ kind: 'finish', usage: emptyUsage(), finishReason: 'stop' }]) {
      yield chunk
    }
  }

  async object<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.requests.push(req)
    const next = this.queue.shift()
    if (next?.method === 'object') return next.response as ObjectResponse<T>
    if (next) this.queue.unshift(next)
    this.rejectUnexpected('object', next?.method)
    return { object: '' as T, usage: emptyUsage(), toolCalls: [], finishReason: 'stop' }
  }

  async *objectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    this.requests.push(req)
    const chunks = this.objectStreamQueue.shift()
    if (!chunks) this.rejectUnexpected('objectStream')
    for (const chunk of chunks ?? [{ kind: 'finish', object: '' as T, usage: emptyUsage(), finishReason: 'stop' }]) {
      yield chunk as ObjectStreamChunk<T>
    }
  }

  async embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.requests.push(req)
    const next = this.queue.shift()
    if (next?.method === 'embed') return next.response
    if (next) this.queue.unshift(next)
    this.rejectUnexpected('embed', next?.method)
    const inputCount = Array.isArray(req.input) ? req.input.length : 1
    return {
      embeddings: Array.from({ length: inputCount }, (_, index) => ({ index, vector: [0] })),
      usage: emptyUsage(),
    }
  }

  async rerank(req: RerankRequest): Promise<RerankResponse> {
    this.requests.push(req)
    const next = this.queue.shift()
    if (next?.method === 'rerank') return next.response
    if (next) this.queue.unshift(next)
    this.rejectUnexpected('rerank', next?.method)
    return {
      results: req.documents
        .map((document, index) => ({
          id: document.id,
          index,
          score: req.documents.length - index,
          ...(document.metadata ? { metadata: document.metadata } : {}),
        }))
        .slice(0, req.topN ?? req.documents.length),
    }
  }

  private rejectUnexpected(received: string, queued?: ScriptedResponse['method']): void {
    if (!this.strict) return
    const detail = queued ? ` The next queued response is for ${queued}.` : ' No response is queued.'
    throw new Error(`FakeModelProvider received an unexpected ${received} request.${detail}`)
  }
}

function emptyUsage(): { inputTokens: number; outputTokens: number; totalTokens: number } {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}
