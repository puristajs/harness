import { ModelCapabilityError, ModelError, OperationCancelledError, OperationTimeoutError, HarnessError, sanitizeForLog, sanitizeProviderBody, sanitizeProviderMessage } from '../errors/index.js'
import { redactProviderContent } from '../models/adapter-utils.js'
import { validateModelRetrySetting } from '../models/retry-policy.js'
import { pumpStreamThroughSpan } from '../models/stream-pump.js'
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
  TextStreamChunk,
  TokenUsage
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
    if (error instanceof ModelError) return withRedactedProviderBody(error)
    if (error instanceof HarnessError) return error
    // A base-enforced timeout aborts the request signal with the timeout error
    // as reason. Provider SDKs surface that as a generic abort error, so the
    // timeout classification must win over the cancellation classification to
    // keep stream timeouts retry-eligible per spec 23.
    if (req.signal.reason instanceof OperationTimeoutError) {
      return req.signal.reason
    }
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
          const result = await Promise.race([operation, next.terminationPromise])
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
        let iterator: AsyncIterator<T> | undefined
        let completed = false
        try {
          iterator = fn(next.req)[Symbol.asyncIterator]()
          const activeIterator = iterator
          while (true) {
            // A provider iterator is not required to promptly observe an
            // aborted signal. Race every pending pull so cancellation and the
            // configured model deadline remain terminal even for a
            // non-cooperative stream.
            const pull = Promise.resolve().then(() => activeIterator.next())
            pull.catch(() => undefined)
            const item = await Promise.race([pull, next.terminationPromise])
            if (item.done) {
              completed = true
              break
            }
            next.req.signal.throwIfAborted()
            emitted = true
            yield item.value
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
          // Do not await iterator cleanup: a non-cooperative provider may
          // also leave return() pending after it ignored the abort signal.
          if (!completed) {
            try {
              const close = iterator?.return?.()
              if (close) void close.catch(() => undefined)
            } catch {
              // Iterator cleanup is best effort and must not mask the terminal
              // timeout, cancellation, or provider error.
            }
          }
          next.cleanup()
        }
      }
    }.bind(this)

    if (!this.telemetry) return iterate()
    return pumpStreamThroughSpan(this.telemetry, `harness.model.${method}`, attrs, iterate)
  }

  private withTimeout<T extends ProviderRequest>(req: T, method: ProviderMethod): { req: T; terminationPromise: Promise<never>; cleanup: () => void } {
    const controller = this.timeoutMs && this.timeoutMs > 0 ? new AbortController() : undefined
    const signal = controller?.signal ?? req.signal
    const relay = controller ? () => controller.abort(req.signal.reason) : undefined
    if (relay) {
      req.signal.addEventListener('abort', relay, { once: true })
      if (req.signal.aborted) relay()
    }

    let rejectTermination: ((reason?: unknown) => void) | undefined
    const terminationPromise = new Promise<never>((_, reject) => { rejectTermination = reject })
    const rejectOnAbort = () => rejectTermination?.(signal.reason)
    signal.addEventListener('abort', rejectOnAbort, { once: true })
    if (signal.aborted) rejectOnAbort()
    // Consumers can complete before their signal aborts. Keep a later abort
    // from surfacing as an unhandled promise rejection.
    terminationPromise.catch(() => undefined)

    const timeout = controller
      ? setTimeout(() => {
          controller.abort(new OperationTimeoutError('Model call timed out.', { scope: 'model', timeout_ms: this.timeoutMs as number }))
        }, this.timeoutMs)
      : undefined

    return {
      req: controller ? { ...req, signal } : req,
      terminationPromise,
      cleanup: () => {
        if (timeout) clearTimeout(timeout)
        if (relay) req.signal.removeEventListener('abort', relay)
        signal.removeEventListener('abort', rejectOnAbort)
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
    const usage = (result as { usage?: TokenUsage }).usage
    if (!usage) return
    const attrs = { 'gen_ai.system': this.genAiSystem, 'gen_ai.request.model': model, 'model.provider': this.id, 'model.method': method }
    this.telemetry?.recordCounter('harness.model.tokens.input', usage.inputTokens, attrs)
    this.telemetry?.recordCounter('harness.model.tokens.output', usage.outputTokens, attrs)
    this.telemetry?.recordCounter('harness.model.tokens.total', usage.totalTokens, attrs)
    if (usage.cachedInputTokens !== undefined) {
      this.telemetry?.recordCounter('harness.model.tokens.cache_read_input', usage.cachedInputTokens, attrs)
    }
    if (usage.cacheCreationInputTokens !== undefined) {
      this.telemetry?.recordCounter('harness.model.tokens.cache_creation_input', usage.cacheCreationInputTokens, attrs)
    }
    if (usage.reasoningTokens !== undefined) {
      this.telemetry?.recordCounter('harness.model.tokens.reasoning_output', usage.reasoningTokens, attrs)
    }
  }
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
    'harness.error.model_provider_body': jsonTelemetryAttr(redactProviderContent(meta?.['providerBody'])),
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
  // AWS SDK v3 errors carry status/headers under `$metadata`/`$response`.
  const awsMetadata = asRecord(record['$metadata'])
  const awsResponse = asRecord(record['$response'])
  const headers = normalizeHeaders(record['headers'] ?? response?.['headers'] ?? awsResponse?.['headers'])
  const retryAfterMs = headers ? parseRetryAfterMs(headers) : undefined
  const rateLimit = headers ? parseRateLimit(headers) : undefined
  const providerBody = sanitizeJsonLike(
    record['body'] ?? response?.['body'] ?? response?.['data'] ?? record['error']
  )

  const status = numberField(record, 'status')
    ?? numberField(record, 'statusCode')
    ?? numberField(response, 'status')
    ?? numberField(response, 'statusCode')
    ?? numberField(awsMetadata, 'httpStatusCode')
    ?? (awsMetadata ? statusFromAwsErrorName(stringField(record, 'name')) : undefined)
  const providerCode = stringField(record, 'code')
    ?? stringField(errorBody, 'code')
    ?? (awsMetadata ? stringField(record, 'name') : undefined)
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

/**
 * Well-known AWS SDK error names mapped to their HTTP-equivalent status so
 * retry classification works even when `$metadata.httpStatusCode` is absent.
 */
const AWS_ERROR_NAME_STATUS: Record<string, number> = {
  ThrottlingException: 429,
  TooManyRequestsException: 429,
  ModelNotReadyException: 429,
  ServiceUnavailableException: 503,
  InternalServerException: 500
}

function statusFromAwsErrorName(name: string | undefined): number | undefined {
  return name ? AWS_ERROR_NAME_STATUS[name] : undefined
}

/**
 * Adapter-built errors may carry raw provider/model content in
 * `meta.providerBody`. Re-issue the error with a content-redacted body so logs,
 * spans, and serialized errors never see raw output (POR-07).
 */
function withRedactedProviderBody(error: ModelError): ModelError {
  const meta = asRecord(error.meta)
  if (!meta || meta['providerBody'] === undefined) return error
  return new ModelError(error.message, {
    ...meta,
    providerBody: redactProviderContent(meta['providerBody'])
  } as ConstructorParameters<typeof ModelError>[1], error.cause ?? error)
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
  validateModelRetrySetting(setting)
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
): { action: 'retry'; delayMs: number; reason: string } | { action: 'fail'; retryKind: 'none' | 'active' | 'deferred'; delayMs?: number } {
  const reason = retryReason(error, policy)
  if (!reason) return { action: 'fail', retryKind: 'none' }
  if (attempt >= policy.maxAttempts) {
    return { action: 'fail', retryKind: attempt > 1 ? 'active' : 'none' }
  }
  const providerDelay = policy.respectRetryAfter ? retryAfterFromError(error) : undefined
  const delayMs = providerDelay ?? computedBackoffMs(policy, attempt)
  const elapsed = Date.now() - startedAt
  if (delayMs > policy.maxActiveDelayMs || elapsed + delayMs > policy.maxActiveElapsedMs) {
    // `longRetry: 'defer'` opts into the deferred classification for
    // provider-instructed delays beyond the active budget; the default
    // `'error'` fails immediately with `retryKind: 'none'`.
    const deferredAllowed = policy.longRetry === 'defer'
      && providerDelay !== undefined
      && (policy.maxDeferredDelayMs === undefined || providerDelay <= policy.maxDeferredDelayMs)
    if (deferredAllowed) return { action: 'fail', retryKind: 'deferred', delayMs: providerDelay }
    return { action: 'fail', retryKind: 'none' }
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

function decorateRetryMeta(error: HarnessError, retryKind: 'none' | 'active' | 'deferred', attempt: number, maxAttempts: number, delayMs: number | undefined): HarnessError {
  if (!(error instanceof ModelError)) return error
  const meta = {
    ...(error.meta ?? {}),
    retryKind,
    retryAttempt: attempt,
    retryMaxAttempts: maxAttempts,
    // `retryAfterMs` is only ever the provider-instructed delay carried by a
    // deferred classification; synthetic harness backoff is never written here.
    ...(retryKind === 'deferred' && delayMs !== undefined ? { retryAfterMs: delayMs } : {})
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

type RateLimitScope = 'requests' | 'input_tokens' | 'output_tokens' | 'tokens' | 'unknown'

interface RateLimitBucket {
  scope?: RateLimitScope
  limit?: number
  remaining?: number
  resetAt?: string
}

/**
 * Parses the OpenAI/Azure (`x-ratelimit-*`) and Anthropic
 * (`anthropic-ratelimit-*`) request and token header families. When several
 * buckets are present the exhausted bucket (`remaining === 0`) wins so the
 * reported scope identifies what was actually rate limited.
 */
function parseRateLimit(headers: Record<string, string>): RateLimitBucket | undefined {
  const buckets = [
    parseRateLimitBucket(
      'requests',
      headers['x-ratelimit-limit-requests'] ?? headers['anthropic-ratelimit-requests-limit'],
      headers['x-ratelimit-remaining-requests'] ?? headers['anthropic-ratelimit-requests-remaining'],
      headers['anthropic-ratelimit-requests-reset'] ?? headers['x-ratelimit-reset-requests']
    ),
    parseRateLimitBucket(
      'tokens',
      headers['x-ratelimit-limit-tokens'] ?? headers['anthropic-ratelimit-tokens-limit'],
      headers['x-ratelimit-remaining-tokens'] ?? headers['anthropic-ratelimit-tokens-remaining'],
      headers['anthropic-ratelimit-tokens-reset'] ?? headers['x-ratelimit-reset-tokens']
    ),
    parseRateLimitBucket(
      'input_tokens',
      headers['anthropic-ratelimit-input-tokens-limit'],
      headers['anthropic-ratelimit-input-tokens-remaining'],
      headers['anthropic-ratelimit-input-tokens-reset']
    ),
    parseRateLimitBucket(
      'output_tokens',
      headers['anthropic-ratelimit-output-tokens-limit'],
      headers['anthropic-ratelimit-output-tokens-remaining'],
      headers['anthropic-ratelimit-output-tokens-reset']
    )
  ].filter((bucket): bucket is RateLimitBucket => bucket !== undefined)
  if (buckets.length === 0) return undefined
  return buckets.find((bucket) => bucket.remaining === 0) ?? buckets[0]
}

function parseRateLimitBucket(
  scope: RateLimitScope,
  limitHeader: string | undefined,
  remainingHeader: string | undefined,
  resetHeader: string | undefined
): RateLimitBucket | undefined {
  const limit = parsePositiveNumber(limitHeader)
  const remaining = parsePositiveNumber(remainingHeader)
  const resetAt = parseResetAt(resetHeader)
  if (limit === undefined && remaining === undefined && resetAt === undefined) return undefined
  return {
    scope,
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

/**
 * Shared adapter helpers (`models/adapter-utils.js`) are part of the public
 * model-provider surface so first-party adapter packages consume a single
 * implementation. They are re-exported next to the adapter base class because
 * the ports barrel is the public path for adapter authors.
 */
export * from '../models/adapter-utils.js'

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
