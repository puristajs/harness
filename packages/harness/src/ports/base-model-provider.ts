import { ModelCapabilityError, ModelError, OperationCancelledError, OperationTimeoutError, HarnessError, sanitizeForLog, sanitizeProviderBody, sanitizeProviderMessage } from '../errors/index.js'
import type { Span } from '@opentelemetry/api'
import type { Logger } from '../logger/index.js'
import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ModelProvider,
  ModelRetryPolicy,
  ModelRetrySetting,
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

type ResolvedRetryPolicy = Required<Omit<ModelRetryPolicy, 'retryOn' | 'maxDeferredDelayMs'>> & {
  maxDeferredDelayMs?: number
  retryOn: Required<NonNullable<ModelRetryPolicy['retryOn']>>
}

const DEFAULT_RETRY_POLICY: ResolvedRetryPolicy = {
  maxAttempts: 3,
  maxActiveElapsedMs: 60_000,
  maxActiveDelayMs: 20_000,
  respectRetryAfter: true,
  minDelayMs: 500,
  maxDelayMs: 8_000,
  longRetry: 'error',
  retryOn: {
    network: true,
    timeout: true,
    rateLimit: true,
    serverError: true
  }
}

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

  protected getLogger(): Logger | undefined {
    return this.logger
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
        : status === 429
          ? 'rate_limited'
          : typeof status === 'number' && status >= 500
            ? 'provider_unavailable'
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
      const retry = resolveRetryPolicy(req)
      let attempt = 1
      while (true) {
        const next = this.withTimeout(req, method)
        try {
          const operation = fn(next.req)
          const result = await (next.timeoutPromise ? Promise.race([operation, next.timeoutPromise]) : operation)
          this.telemetry?.recordHistogram('harness.model.duration', (Date.now() - started) / 1000, attrs)
          this.recordUsage(method, req.model, result)
          return result
        } catch (error) {
          const normalized = this.normalizeError(error, method, next.req)
          const decision = retryDecision(normalized, retry, attempt, started)
          if (decision.action === 'retry') {
            this.telemetry?.recordCounter('harness.model.retries', 1, { ...attrs, 'harness.model.retry.reason': decision.reason })
            this.telemetry?.recordHistogram('harness.model.retry.delay', decision.delayMs / 1000, attrs)
            this.logger?.warn('Retrying model provider call.', {
              provider: this.id,
              model: req.model,
              method,
              attempt,
              nextAttempt: attempt + 1,
              delayMs: decision.delayMs,
              reason: decision.reason
            })
            next.cleanup()
            await sleep(decision.delayMs, req.signal)
            attempt += 1
            continue
          }

          const finalError = decorateRetryMeta(normalized, decision.retryKind, attempt, retry.maxAttempts, decision.delayMs)
          span?.setAttributes?.(modelErrorTelemetryAttrs(finalError))
          this.telemetry?.recordCounter('harness.model.errors', 1, { ...attrs, 'error.code': finalError.code })
          this.logger?.error('Model provider call failed.', {
            provider: this.id,
            model: req.model,
            method,
            error: sanitizeForLog({ code: finalError.code, category: finalError.category, retriable: finalError.retriable, meta: finalError.meta })
          })
          throw finalError
        } finally {
          next.cleanup()
        }
      }
    }
    return this.telemetry ? this.telemetry.span(`harness.model.${method}`, attrs, execute) : execute()
  }

  private stream<T>(method: ProviderMethod, req: ProviderRequest, fn: (req: ProviderRequest) => AsyncIterable<T>): AsyncIterable<T> {
    req.signal.throwIfAborted()
    const attrs = this.attrs(method, req)
    const started = Date.now()
    const iterate = async function* (this: BaseModelProvider, span?: Span): AsyncIterable<T> {
      const retry = resolveRetryPolicy(req)
      let attempt = 1
      let emitted = false
      while (true) {
        const next = this.withTimeout(req, method)
        try {
          for await (const chunk of fn(next.req)) {
            next.req.signal.throwIfAborted()
            emitted = true
            yield chunk
          }
          this.telemetry?.recordHistogram('harness.model.duration', (Date.now() - started) / 1000, attrs)
          return
        } catch (error) {
          const normalized = this.normalizeError(error, method, next.req)
          const decision = emitted ? { action: 'fail' as const, retryKind: 'none' as const } : retryDecision(normalized, retry, attempt, started)
          if (decision.action === 'retry') {
            this.telemetry?.recordCounter('harness.model.retries', 1, { ...attrs, 'harness.model.retry.reason': decision.reason })
            this.telemetry?.recordHistogram('harness.model.retry.delay', decision.delayMs / 1000, attrs)
            this.logger?.warn('Retrying model provider stream before first chunk.', {
              provider: this.id,
              model: req.model,
              method,
              attempt,
              nextAttempt: attempt + 1,
              delayMs: decision.delayMs,
              reason: decision.reason
            })
            next.cleanup()
            await sleep(decision.delayMs, req.signal)
            attempt += 1
            continue
          }

          const finalError = decorateRetryMeta(normalized, decision.retryKind, attempt, retry.maxAttempts, 'delayMs' in decision ? decision.delayMs : undefined)
          span?.setAttributes?.(modelErrorTelemetryAttrs(finalError))
          this.telemetry?.recordCounter('harness.model.errors', 1, { ...attrs, 'error.code': finalError.code })
          this.logger?.error('Model provider stream failed.', {
            provider: this.id,
            model: req.model,
            method,
            error: sanitizeForLog({ code: finalError.code, category: finalError.category, retriable: finalError.retriable, meta: finalError.meta })
          })
          throw finalError
        } finally {
          next.cleanup()
        }
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
    'harness.error.model_provider_body': jsonTelemetryAttr(meta?.['providerBody']),
    'harness.error.model_retry_kind': stringTelemetryAttr(meta?.['retryKind']),
    'harness.error.model_retry_after_ms': numberTelemetryAttr(meta?.['retryAfterMs']),
    'harness.error.model_retry_attempt': numberTelemetryAttr(meta?.['retryAttempt']),
    'harness.error.model_retry_max_attempts': numberTelemetryAttr(meta?.['retryMaxAttempts'])
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
  retryAfterMs?: number
  rateLimit?: { scope?: 'requests' | 'input_tokens' | 'output_tokens' | 'tokens' | 'unknown'; limit?: number; remaining?: number; resetAt?: string }
} {
  const record = asRecord(error)
  if (!record) return {}
  const response = asRecord(record['response'])
  const errorBody = asRecord(record['error'])
  const headers = normalizeHeaders(record['headers'] ?? response?.['headers'])
  const retryAfterMs = headers ? parseRetryAfterMs(headers) : undefined
  const rateLimit = headers ? parseRateLimit(headers) : undefined
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
    ...(providerBody !== undefined ? { providerBody } : {}),
    ...(headers ? { providerHeaders: headers } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(rateLimit ? { rateLimit } : {})
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
  const headersLike = value as { forEach?: (callback: (value: string, key: string) => void) => void; entries?: () => Iterable<[string, string]>; get?: (key: string) => string | null } | undefined
  if (headersLike?.forEach) {
    const headers: Record<string, string> = {}
    headersLike.forEach((headerValue, key) => {
      const normalizedKey = key.toLowerCase()
      if (!isSensitiveHeader(normalizedKey)) headers[normalizedKey] = String(headerValue).slice(0, 2000)
    })
    return Object.keys(headers).length > 0 ? headers : undefined
  }
  if (headersLike?.entries) {
    const headers: Record<string, string> = {}
    for (const [key, headerValue] of headersLike.entries()) {
      const normalizedKey = key.toLowerCase()
      if (!isSensitiveHeader(normalizedKey)) headers[normalizedKey] = String(headerValue).slice(0, 2000)
    }
    return Object.keys(headers).length > 0 ? headers : undefined
  }
  const record = asRecord(value)
  if (!record) return undefined
  const headers: Record<string, string> = {}
  for (const [key, headerValue] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase()
    if (isSensitiveHeader(normalizedKey)) continue
    if (typeof headerValue === 'string' || typeof headerValue === 'number' || typeof headerValue === 'boolean') {
      headers[normalizedKey] = String(headerValue).slice(0, 2000)
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function sanitizeJsonLike(value: unknown): unknown {
  return sanitizeProviderBody(value)
}

function resolveRetryPolicy(req: ProviderRequest): ResolvedRetryPolicy {
  const setting = req.call?.retry ?? ('defaults' in req ? req.defaults?.retry : undefined) ?? true
  if (setting === false) {
    return { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 }
  }
  if (setting === true || setting === undefined) {
    return DEFAULT_RETRY_POLICY
  }
  return {
    ...DEFAULT_RETRY_POLICY,
    ...setting,
    maxAttempts: setting.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    maxActiveElapsedMs: setting.maxActiveElapsedMs ?? DEFAULT_RETRY_POLICY.maxActiveElapsedMs,
    maxActiveDelayMs: setting.maxActiveDelayMs ?? DEFAULT_RETRY_POLICY.maxActiveDelayMs,
    minDelayMs: setting.minDelayMs ?? DEFAULT_RETRY_POLICY.minDelayMs,
    maxDelayMs: setting.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    respectRetryAfter: setting.respectRetryAfter ?? DEFAULT_RETRY_POLICY.respectRetryAfter,
    longRetry: setting.longRetry ?? DEFAULT_RETRY_POLICY.longRetry,
    retryOn: {
      ...DEFAULT_RETRY_POLICY.retryOn,
      ...(setting.retryOn ?? {})
    }
  }
}

function isSensitiveHeader(key: string): boolean {
  return key === 'authorization'
    || key === 'proxy-authorization'
    || key === 'x-api-key'
    || key === 'api-key'
    || key === 'openai-api-key'
    || key.endsWith('-api-key')
}

function retryDecision(
  error: HarnessError,
  policy: ResolvedRetryPolicy,
  attempt: number,
  startedAt: number
): { action: 'retry'; delayMs: number; reason: string } | { action: 'fail'; retryKind: 'none' | 'deferred'; delayMs?: number } {
  if (attempt >= policy.maxAttempts) return { action: 'fail', retryKind: 'none' }
  const reason = retryReason(error, policy)
  if (!reason) return { action: 'fail', retryKind: 'none' }
  const providerDelay = policy.respectRetryAfter ? retryAfterFromError(error) : undefined
  const delayMs = providerDelay ?? computedBackoffMs(policy, attempt)
  const elapsed = Date.now() - startedAt
  if (delayMs > policy.maxActiveDelayMs || elapsed + delayMs > policy.maxActiveElapsedMs) {
    const deferredAllowed = providerDelay !== undefined && (policy.maxDeferredDelayMs === undefined || providerDelay <= policy.maxDeferredDelayMs)
    return { action: 'fail', retryKind: deferredAllowed ? 'deferred' : 'none', delayMs }
  }
  return { action: 'retry', delayMs, reason }
}

function retryReason(error: HarnessError, policy: ResolvedRetryPolicy): string | undefined {
  if (error instanceof OperationTimeoutError) return policy.retryOn.timeout ? 'timeout' : undefined
  if (!(error instanceof ModelError)) return undefined
  const meta = asRecord(error.meta)
  const status = typeof meta?.['status'] === 'number' ? meta['status'] : undefined
  const reason = typeof meta?.['reason'] === 'string' ? meta['reason'] : undefined
  if ((reason === 'network' || status === 408 || status === 409) && policy.retryOn.network) return reason ?? `http_${status}`
  if ((reason === 'rate_limited' || status === 429) && policy.retryOn.rateLimit) return 'rate_limited'
  if ((reason === 'provider_unavailable' || (typeof status === 'number' && status >= 500)) && policy.retryOn.serverError) return 'provider_unavailable'
  return undefined
}

function retryAfterFromError(error: HarnessError): number | undefined {
  const meta = asRecord(error.meta)
  const value = meta?.['retryAfterMs']
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function computedBackoffMs(policy: ResolvedRetryPolicy, attempt: number): number {
  const base = Math.min(policy.maxDelayMs, policy.minDelayMs * (2 ** Math.max(0, attempt - 1)))
  const jitter = 0.75 + Math.random() * 0.25
  return Math.max(0, Math.floor(base * jitter))
}

function decorateRetryMeta(error: HarnessError, retryKind: 'none' | 'deferred', attempt: number, maxAttempts: number, delayMs: number | undefined): HarnessError {
  if (!(error instanceof ModelError)) return error
  const meta = {
    ...(error.meta ?? {}),
    retryKind,
    retryAttempt: attempt,
    retryMaxAttempts: maxAttempts,
    ...(delayMs !== undefined ? { retryAfterMs: delayMs } : {})
  } as ConstructorParameters<typeof ModelError>[1]
  return new ModelError(error.message, meta, error.cause ?? error)
}

function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
  const retryAfterMs = parsePositiveNumber(headers['retry-after-ms'])
  if (retryAfterMs !== undefined) return retryAfterMs
  const retryAfter = headers['retry-after']
  if (!retryAfter) return undefined
  const seconds = parsePositiveNumber(retryAfter)
  if (seconds !== undefined) return seconds * 1000
  const date = Date.parse(retryAfter)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

function parseRateLimit(headers: Record<string, string>): { scope?: 'requests' | 'input_tokens' | 'output_tokens' | 'tokens' | 'unknown'; limit?: number; remaining?: number; resetAt?: string } | undefined {
  const limit = parsePositiveNumber(headers['x-ratelimit-limit-requests'] ?? headers['anthropic-ratelimit-requests-limit'])
  const remaining = parsePositiveNumber(headers['x-ratelimit-remaining-requests'] ?? headers['anthropic-ratelimit-requests-remaining'])
  const resetAt = parseResetAt(headers['anthropic-ratelimit-requests-reset'] ?? headers['x-ratelimit-reset-requests'])
  if (limit === undefined && remaining === undefined && resetAt === undefined) return undefined
  return {
    scope: 'requests',
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetAt ? { resetAt } : {})
  }
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function parseResetAt(value: string | undefined): string | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

async function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) return
  if (signal.aborted) throw new OperationCancelledError('Model retry was cancelled.', { scope: 'model' }, signal.reason)
  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      reject(new OperationCancelledError('Model retry was cancelled.', { scope: 'model' }, signal.reason))
    }
    timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
