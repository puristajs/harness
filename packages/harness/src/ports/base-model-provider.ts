import { ModelCapabilityError, ModelError, OperationCancelledError, OperationTimeoutError, HarnessError, sanitizeForLog, sanitizeProviderBody, sanitizeProviderMessage } from '../errors/index.js'
import type { Span } from '@opentelemetry/api'
import type { Logger } from '../logger/index.js'
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
  TextStreamChunk
} from './model-provider.js'
import type { JsonValue } from '../models/json.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'
import type { HarnessAdapterContext } from './harness-context.js'

export interface BaseModelProviderOptions {
  id: string
  genAiSystem: string
  logger?: Logger
  telemetry?: TelemetryShim
  timeoutMs?: number
}

type ProviderMethod = 'text' | 'textStream' | 'object' | 'objectStream' | 'embed' | 'rerank'
type ProviderRequest = TextRequest | ObjectRequest | EmbeddingRequest | RerankRequest

/**
 * Base class for model adapters.
 *
 * Adapter packages should map provider-specific requests/responses in protected
 * `do*` methods. The base class owns cross-cutting harness behavior:
 * cancellation, timeout, safe logs, metrics/spans, and error normalization.
 */
export abstract class BaseModelProvider implements ModelProvider {
  public readonly id: string
  public readonly genAiSystem: string
  private logger: Logger | undefined
  private telemetry: TelemetryShim | undefined
  private timeoutMs: number | undefined

  protected constructor(options: BaseModelProviderOptions) {
    this.id = options.id
    this.genAiSystem = options.genAiSystem
    this.logger = options.logger
    this.telemetry = options.telemetry
    this.timeoutMs = options.timeoutMs
  }

  /**
   * Called by the harness during composition so adapters automatically inherit
   * harness-level logging, telemetry, and timeout defaults. Explicit adapter
   * constructor options win over inherited values.
   */
  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.logger ??= context.logger
    this.telemetry ??= context.telemetry
    if (this.timeoutMs === undefined) {
      this.timeoutMs = context.defaults.modelTimeoutMs
    }
  }

  public text(req: TextRequest): Promise<TextResponse> {
    return this.call('text', req, (next) => this.doText(next as TextRequest))
  }

  public textStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
    return this.stream('textStream', req, (next) => this.doTextStream(next as TextRequest))
  }

  public object<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    return this.call('object', req, (next) => this.doObject(next as ObjectRequest<T>))
  }

  public objectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    return this.stream('objectStream', req, (next) => this.doObjectStream(next as ObjectRequest<T>))
  }

  public embed(req: EmbeddingRequest): Promise<EmbeddingResponse> {
    return this.call('embed', req, (next) => this.doEmbed(next as EmbeddingRequest))
  }

  public rerank(req: RerankRequest): Promise<RerankResponse> {
    return this.call('rerank', req, (next) => this.doRerank(next as RerankRequest))
  }

  protected doText(_req: TextRequest): Promise<TextResponse> {
    throw this.methodMissing('text')
  }

  protected doTextStream(_req: TextRequest): AsyncIterable<TextStreamChunk> {
    throw this.methodMissing('textStream')
  }

  protected doObject<T extends JsonValue = JsonValue>(_req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    throw this.methodMissing('object')
  }

  protected doObjectStream<T extends JsonValue = JsonValue>(_req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    throw this.methodMissing('objectStream')
  }

  protected doEmbed(_req: EmbeddingRequest): Promise<EmbeddingResponse> {
    throw this.methodMissing('embed')
  }

  protected doRerank(_req: RerankRequest): Promise<RerankResponse> {
    throw this.methodMissing('rerank')
  }

  protected normalizeError(error: unknown, method: ProviderMethod, req: ProviderRequest): HarnessError {
    if (error instanceof HarnessError) return error
    if (req.signal.aborted || isAbortError(error)) {
      return new OperationCancelledError('Model call was cancelled.', { scope: 'model' }, error)
    }

    const details = extractProviderErrorDetails(error)
    const status = details.status
    const code = details.providerCode
    const reason =
      code === 'context_length_exceeded'
        ? 'context_length_exceeded'
        : status !== undefined
          ? 'http_error'
          : 'network'

    return new ModelError(modelErrorMessage(details), {
      provider: this.id,
      model: req.model,
      method,
      ...(status !== undefined ? { status } : {}),
      ...details,
      reason
    }, error)
  }

  private async call<T>(method: ProviderMethod, req: ProviderRequest, fn: (req: ProviderRequest) => Promise<T>): Promise<T> {
    req.signal.throwIfAborted()
    const attrs = this.attrs(method, req)
    const started = Date.now()
    const execute = async (span?: Span): Promise<T> => {
      const next = this.withTimeout(req, method)
      try {
        const operation = fn(next.req)
        const result = await (next.timeoutPromise ? Promise.race([operation, next.timeoutPromise]) : operation)
        this.telemetry?.recordHistogram('harness.model.duration', (Date.now() - started) / 1000, attrs)
        this.recordUsage(method, req.model, result)
        return result
      } catch (error) {
        const normalized = this.normalizeError(error, method, next.req)
        span?.setAttributes?.(modelErrorTelemetryAttrs(normalized))
        this.telemetry?.recordCounter('harness.model.errors', 1, { ...attrs, 'error.code': normalized.code })
        this.logger?.error('Model provider call failed.', {
          provider: this.id,
          model: req.model,
          method,
          error: sanitizeForLog({ code: normalized.code, category: normalized.category, retriable: normalized.retriable, meta: normalized.meta })
        })
        throw normalized
      } finally {
        next.cleanup()
      }
    }
    return this.telemetry ? this.telemetry.span(`harness.model.${method}`, attrs, execute) : execute()
  }

  private stream<T>(method: ProviderMethod, req: ProviderRequest, fn: (req: ProviderRequest) => AsyncIterable<T>): AsyncIterable<T> {
    req.signal.throwIfAborted()
    const attrs = this.attrs(method, req)
    const started = Date.now()
    const iterate = async function* (this: BaseModelProvider, span?: Span): AsyncIterable<T> {
      const next = this.withTimeout(req, method)
      try {
        for await (const chunk of fn(next.req)) {
          next.req.signal.throwIfAborted()
          yield chunk
        }
        this.telemetry?.recordHistogram('harness.model.duration', (Date.now() - started) / 1000, attrs)
      } catch (error) {
        const normalized = this.normalizeError(error, method, next.req)
        span?.setAttributes?.(modelErrorTelemetryAttrs(normalized))
        this.telemetry?.recordCounter('harness.model.errors', 1, { ...attrs, 'error.code': normalized.code })
        this.logger?.error('Model provider stream failed.', {
          provider: this.id,
          model: req.model,
          method,
          error: sanitizeForLog({ code: normalized.code, category: normalized.category, retriable: normalized.retriable, meta: normalized.meta })
        })
        throw normalized
      } finally {
        next.cleanup()
      }
    }.bind(this)

    if (!this.telemetry) return iterate()
    return streamWithSpan(this.telemetry, `harness.model.${method}`, attrs, iterate)
  }

  private withTimeout<T extends ProviderRequest>(req: T, method: ProviderMethod): { req: T; timeoutPromise?: Promise<never>; cleanup: () => void } {
    if (!this.timeoutMs || this.timeoutMs <= 0) {
      return { req, cleanup: () => undefined }
    }

    const controller = new AbortController()
    const relay = () => controller.abort(req.signal.reason)
    req.signal.addEventListener('abort', relay, { once: true })
    if (req.signal.aborted) relay()
    let rejectTimeout: ((error: OperationTimeoutError) => void) | undefined
    const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject })
    const timeout = setTimeout(() => {
      const error = new OperationTimeoutError('Model call timed out.', { scope: 'model', timeout_ms: this.timeoutMs as number })
      controller.abort(error)
      rejectTimeout?.(error)
    }, this.timeoutMs)

    return {
      req: { ...req, signal: controller.signal },
      timeoutPromise,
      cleanup: () => {
        clearTimeout(timeout)
        req.signal.removeEventListener('abort', relay)
      }
    }
  }

  private methodMissing(method: ProviderMethod): ModelCapabilityError {
    return new ModelCapabilityError('Model provider method is not implemented.', {
      alias: this.id,
      method,
      reason: 'method_missing'
    })
  }

  private attrs(method: ProviderMethod, req: ProviderRequest): SpanAttrs {
    return {
      'gen_ai.system': this.genAiSystem,
      'gen_ai.request.model': req.model,
      'model.provider': this.id,
      'model.method': method
    }
  }

  private recordUsage(method: ProviderMethod, model: string, result: unknown): void {
    const usage = (result as { usage?: { inputTokens: number; outputTokens: number; totalTokens: number } }).usage
    if (!usage) return
    const attrs = { 'gen_ai.system': this.genAiSystem, 'gen_ai.request.model': model, 'model.provider': this.id, 'model.method': method }
    this.telemetry?.recordCounter('harness.model.tokens.input', usage.inputTokens, attrs)
    this.telemetry?.recordCounter('harness.model.tokens.output', usage.outputTokens, attrs)
    this.telemetry?.recordCounter('harness.model.tokens.total', usage.totalTokens, attrs)
  }
}

async function* streamWithSpan<T>(
  telemetry: TelemetryShim,
  name: string,
  attrs: SpanAttrs,
  iterate: (span?: Span) => AsyncIterable<T>
): AsyncIterable<T> {
  const queue: T[] = []
  let done = false
  let failure: unknown
  let notify: (() => void) | undefined
  const wake = () => {
    notify?.()
    notify = undefined
  }

  const producer = telemetry.span(name, attrs, async (span) => {
    for await (const chunk of iterate(span)) {
      queue.push(chunk)
      wake()
    }
  }).catch((error) => {
    failure = error
  }).finally(() => {
    done = true
    wake()
  })

  while (!done || queue.length > 0) {
    const next = queue.shift()
    if (next !== undefined) {
      yield next
      continue
    }
    if (failure) throw failure
    await new Promise<void>((resolve) => { notify = resolve })
  }

  await producer
  if (failure) throw failure
}

function isAbortError(error: unknown): boolean {
  const value = error as { name?: unknown; code?: unknown }
  return value?.name === 'AbortError' || value?.code === 'ABORT_ERR'
}

function modelErrorMessage(details: ReturnType<typeof extractProviderErrorDetails>): string {
  const parts = ['Model provider call failed']
  const qualifiers = [
    details.status !== undefined ? `HTTP ${details.status}` : undefined,
    details.providerCode,
    details.providerType,
    details.providerParam
  ].filter((part): part is string => Boolean(part))
  if (qualifiers.length > 0) parts.push(`(${qualifiers.join(', ')})`)
  if (details.providerMessage) parts.push(`: ${details.providerMessage.slice(0, 500)}`)
  return `${parts.join('')}.`
}

function modelErrorTelemetryAttrs(error: HarnessError): SpanAttrs {
  const meta = asRecord(error.meta)
  return {
    'harness.error.provider': stringTelemetryAttr(meta?.['provider']),
    'harness.error.model': stringTelemetryAttr(meta?.['model']),
    'harness.error.model_provider_status': numberTelemetryAttr(meta?.['status']),
    'harness.error.model_provider_code': stringTelemetryAttr(meta?.['providerCode']),
    'harness.error.model_provider_type': stringTelemetryAttr(meta?.['providerType']),
    'harness.error.model_provider_param': stringTelemetryAttr(meta?.['providerParam']),
    'harness.error.model_provider_request_id': stringTelemetryAttr(meta?.['providerRequestId']),
    'harness.error.model_provider_message': stringTelemetryAttr(meta?.['providerMessage']),
    'harness.error.model_provider_body': jsonTelemetryAttr(meta?.['providerBody'])
  }
}

function stringTelemetryAttr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 4000) : undefined
}

function numberTelemetryAttr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function jsonTelemetryAttr(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value).slice(0, 8000)
  } catch {
    return undefined
  }
}

function extractProviderErrorDetails(error: unknown): {
  status?: number
  providerCode?: string
  providerType?: string
  providerParam?: string
  providerRequestId?: string
  providerMessage?: string
  providerBody?: unknown
  providerHeaders?: Record<string, string>
} {
  const record = asRecord(error)
  if (!record) return {}
  const response = asRecord(record['response'])
  const errorBody = asRecord(record['error'])
  const headers = normalizeHeaders(record['headers'] ?? response?.['headers'])
  const providerBody = sanitizeJsonLike(
    record['body'] ?? response?.['body'] ?? response?.['data'] ?? record['error']
  )

  const status = numberField(record, 'status')
    ?? numberField(record, 'statusCode')
    ?? numberField(response, 'status')
    ?? numberField(response, 'statusCode')
  const providerCode = stringField(record, 'code') ?? stringField(errorBody, 'code')
  const providerType = stringField(record, 'type') ?? stringField(errorBody, 'type')
  const providerParam = stringField(record, 'param') ?? stringField(errorBody, 'param')
  const providerRequestId = stringField(record, 'request_id')
    ?? stringField(record, 'requestID')
    ?? headers?.['x-request-id']
    ?? headers?.['request-id']
  const providerMessageRaw = stringField(errorBody, 'message') ?? stringField(record, 'message')
  const providerMessage = providerMessageRaw ? sanitizeProviderMessage(providerMessageRaw) : undefined

  return {
    ...(status !== undefined ? { status } : {}),
    ...(providerCode ? { providerCode } : {}),
    ...(providerType ? { providerType } : {}),
    ...(providerParam ? { providerParam } : {}),
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(providerMessage ? { providerMessage } : {}),
    ...(providerBody !== undefined ? { providerBody } : {})
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const headers: Record<string, string> = {}
  for (const [key, headerValue] of Object.entries(record)) {
    if (typeof headerValue === 'string' || typeof headerValue === 'number' || typeof headerValue === 'boolean') {
      headers[key.toLowerCase()] = String(headerValue).slice(0, 2000)
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function sanitizeJsonLike(value: unknown): unknown {
  return sanitizeProviderBody(value)
}
