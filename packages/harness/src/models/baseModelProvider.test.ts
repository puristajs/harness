import { describe, expect, it, vi } from 'vitest'

import { HarnessConfigError, ModelError, OperationCancelledError, OperationTimeoutError, serializeError } from '../errors/index.js'
import { JsonLogger, type Logger } from '../logger/index.js'
import { BaseModelProvider } from '../ports/base-model-provider.js'
import type { ObjectRequest, ObjectResponse, TextRequest, TextStreamChunk } from '../ports/model-provider.js'
import type { TelemetryShim } from '../telemetry/index.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'

class TestProvider extends BaseModelProvider {
  public error: unknown
  public errors: unknown[] = []
  public delayMs = 0
  public calls = 0

  constructor(opts: { timeoutMs?: number; telemetry?: TelemetryShim; logger?: Logger } = {}) {
    super({ id: 'test', genAiSystem: 'test', ...opts })
  }

  protected override async doObject<T extends import('./json.js').JsonValue = import('./json.js').JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    }
    this.calls += 1
    const nextError = this.errors.shift()
    if (nextError) throw nextError
    if (this.error) throw this.error
    return {
      object: { ok: true } as unknown as T,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: 'stop',
      raw: { secret: 'not logged' }
    }
  }
}

class TestStreamProvider extends BaseModelProvider {
  /** Errors thrown before the first chunk, one per attempt. */
  public errorsBeforeFirstChunk: unknown[] = []
  /** Error thrown after the first chunk was yielded. */
  public errorAfterFirstChunk: unknown
  /** Sleeps (without observing the signal) before the first chunk, once per value. */
  public hangsBeforeFirstChunkMs: number[] = []
  /** Sleeps (without observing the signal) between the two chunks. */
  public hangBetweenChunksMs = 0
  public attempts = 0

  constructor(opts: { timeoutMs?: number; telemetry?: TelemetryShim; logger?: Logger } = {}) {
    super({ id: 'test', genAiSystem: 'test', ...opts })
  }

  protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
    this.attempts += 1
    const hangMs = this.hangsBeforeFirstChunkMs.shift()
    if (hangMs) {
      await new Promise((resolve) => setTimeout(resolve, hangMs))
      req.signal.throwIfAborted()
    }
    const nextError = this.errorsBeforeFirstChunk.shift()
    if (nextError) throw nextError
    yield { kind: 'delta', text: 'first' }
    if (this.hangBetweenChunksMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.hangBetweenChunksMs))
    }
    if (this.errorAfterFirstChunk) throw this.errorAfterFirstChunk
    yield { kind: 'delta', text: 'second' }
    yield { kind: 'finish', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' }
  }
}

async function collect(stream: AsyncIterable<TextStreamChunk>): Promise<TextStreamChunk[]> {
  const chunks: TextStreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function harnessContext(logger: Logger, telemetry: TelemetryShim, modelTimeoutMs = 300_000): HarnessAdapterContext {
  return {
    harnessName: 'test',
    logger,
    telemetry,
    defaults: {
      agentMaxIterations: 16,
      runTimeoutMs: 600_000,
      toolTimeoutMs: 120_000,
      skillTimeoutMs: 60_000,
      modelTimeoutMs,
      maxParallelToolCalls: 8
    }
  }
}

describe('BaseModelProvider', () => {
  it('normalizes raw provider failures into ModelError', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('provider failed'), {
      status: 503,
      code: 'server_error',
      type: 'api_error',
      request_id: 'req_base',
      error: { message: 'upstream unavailable', type: 'api_error' },
      headers: { 'x-request-id': 'req_base' }
    })

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: false },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      message: 'Model provider call failed(HTTP 503, server_error, api_error): upstream unavailable.',
      meta: {
        status: 503,
        providerCode: 'server_error',
        providerType: 'api_error',
        providerRequestId: 'req_base',
        providerMessage: 'upstream unavailable',
        providerBody: { message: 'upstream unavailable', type: 'api_error' }
      }
    })
  })

  it('enforces base timeout even when adapter work does not finish', async () => {
    const provider = new TestProvider({ timeoutMs: 5 })
    provider.delayMs = 50

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: false },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toBeInstanceOf(OperationTimeoutError)
  })

  it('actively retries short retriable model failures', async () => {
    const provider = new TestProvider()
    provider.errors.push(Object.assign(new Error('temporary'), { status: 503, error: { message: 'try again' } }))

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 2, minDelayMs: 1, maxDelayMs: 1, maxActiveDelayMs: 10, maxActiveElapsedMs: 1000 } },
      schema: {},
      signal: new AbortController().signal
    })).resolves.toMatchObject({
      object: { ok: true },
      finishReason: 'stop'
    })
    expect(provider.calls).toBe(2)
  })

  it('marks final errors as active when active retry attempts are exhausted', async () => {
    const provider = new TestProvider()
    provider.errors.push(
      Object.assign(new Error('temporary 1'), { status: 503, error: { message: 'try again' } }),
      Object.assign(new Error('temporary 2'), { status: 503, error: { message: 'still down' } })
    )

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 2, minDelayMs: 1, maxDelayMs: 1, maxActiveDelayMs: 10, maxActiveElapsedMs: 1000 } },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      meta: {
        reason: 'provider_unavailable',
        retryKind: 'active',
        retryAttempt: 2,
        retryMaxAttempts: 2
      }
    })
    expect(provider.calls).toBe(2)
  })

  it('turns long provider Retry-After into a deferred retry error with longRetry defer', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('rate limited'), {
      status: 429,
      error: { message: 'too many requests' },
      headers: { 'retry-after': '3600', 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '0' }
    })

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 2, maxActiveDelayMs: 10, maxActiveElapsedMs: 1000, longRetry: 'defer' } },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      meta: {
        reason: 'rate_limited',
        retryKind: 'deferred',
        retryAfterMs: 3_600_000,
        rateLimit: { scope: 'requests', limit: 100, remaining: 0 }
      }
    })
    expect(provider.calls).toBe(1)
  })

  it('fails long provider Retry-After immediately with retryKind none by default (longRetry error)', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('rate limited'), {
      status: 429,
      error: { message: 'too many requests' },
      headers: { 'retry-after': '3600' }
    })

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 2, maxActiveDelayMs: 10, maxActiveElapsedMs: 1000 } },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      meta: {
        reason: 'rate_limited',
        retryKind: 'none'
      }
    })
    expect(provider.calls).toBe(1)
  })

  it('uses retryKind none when the provider delay exceeds maxDeferredDelayMs even with longRetry defer', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('rate limited'), {
      status: 429,
      error: { message: 'too many requests' },
      headers: { 'retry-after': '3600' }
    })

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 2, maxActiveDelayMs: 10, maxActiveElapsedMs: 1000, longRetry: 'defer', maxDeferredDelayMs: 60_000 } },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      meta: {
        reason: 'rate_limited',
        retryKind: 'none'
      }
    })
    expect(provider.calls).toBe(1)
  })

  it('parses retry-after-ms headers as milliseconds for deferred classification', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('rate limited'), {
      status: 429,
      error: { message: 'too many requests' },
      headers: { 'retry-after-ms': '120000' }
    })

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 2, maxActiveDelayMs: 10, maxActiveElapsedMs: 1000, longRetry: 'defer' } },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      meta: { retryKind: 'deferred', retryAfterMs: 120_000 }
    })
    expect(provider.calls).toBe(1)
  })

  it('parses HTTP-date Retry-After headers for deferred classification', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('rate limited'), {
      status: 429,
      error: { message: 'too many requests' },
      headers: { 'retry-after': new Date(Date.now() + 3_600_000).toUTCString() }
    })

    let caught: unknown
    try {
      await provider.object({
        model: 'm',
        messages: [],
        defaults: { retry: { maxAttempts: 2, maxActiveDelayMs: 10, maxActiveElapsedMs: 1000, longRetry: 'defer' } },
        schema: {},
        signal: new AbortController().signal
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ModelError)
    const meta = (caught as ModelError).meta as { retryKind?: string; retryAfterMs?: number }
    expect(meta.retryKind).toBe('deferred')
    expect(meta.retryAfterMs).toBeGreaterThan(3_500_000)
    expect(meta.retryAfterMs).toBeLessThanOrEqual(3_600_000)
  })

  it('never reports synthetic backoff delays as retryAfterMs on final errors', async () => {
    const provider = new TestProvider()
    // No provider Retry-After header: the computed backoff exceeds the active
    // budget, so the call fails without inventing a retryAfterMs value.
    provider.error = Object.assign(new Error('unavailable'), {
      status: 503,
      error: { message: 'down' }
    })

    let caught: unknown
    try {
      await provider.object({
        model: 'm',
        messages: [],
        defaults: { retry: { maxAttempts: 2, minDelayMs: 500, maxDelayMs: 500, maxActiveDelayMs: 1, maxActiveElapsedMs: 1000, longRetry: 'defer' } },
        schema: {},
        signal: new AbortController().signal
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ModelError)
    const meta = (caught as ModelError).meta as { retryKind?: string; retryAfterMs?: number }
    expect(meta.retryKind).toBe('none')
    expect(meta.retryAfterMs).toBeUndefined()
    expect(provider.calls).toBe(1)
  })

  it('throws OperationCancelledError when aborted during the backoff sleep', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('unavailable'), { status: 503 })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 3, minDelayMs: 5_000, maxDelayMs: 5_000, maxActiveDelayMs: 10_000, maxActiveElapsedMs: 60_000 } },
      schema: {},
      signal: controller.signal
    })).rejects.toBeInstanceOf(OperationCancelledError)
    expect(provider.calls).toBe(1)
  })

  it('reports the exhausted token bucket as the rate-limit scope', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('rate limited'), {
      status: 429,
      error: { message: 'token budget exhausted' },
      headers: {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '50',
        'x-ratelimit-limit-tokens': '10000',
        'x-ratelimit-remaining-tokens': '0'
      }
    })

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: false },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      meta: { rateLimit: { scope: 'tokens', limit: 10_000, remaining: 0 } }
    })
  })

  it('parses Anthropic token-bucket rate-limit headers', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('rate limited'), {
      status: 429,
      error: { message: 'input tokens exhausted' },
      headers: {
        'anthropic-ratelimit-requests-limit': '100',
        'anthropic-ratelimit-requests-remaining': '70',
        'anthropic-ratelimit-input-tokens-limit': '20000',
        'anthropic-ratelimit-input-tokens-remaining': '0',
        'anthropic-ratelimit-output-tokens-limit': '8000',
        'anthropic-ratelimit-output-tokens-remaining': '8000'
      }
    })

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: false },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      meta: { rateLimit: { scope: 'input_tokens', limit: 20_000, remaining: 0 } }
    })
  })

  it('redacts adapter-supplied providerBody content on ModelErrors', async () => {
    const provider = new TestProvider()
    provider.error = new ModelError('Provider returned malformed structured JSON.', {
      provider: 'test',
      model: 'm',
      method: 'object',
      reason: 'malformed_response',
      providerBody: '{"secret model output":'
    })

    let caught: unknown
    try {
      await provider.object({
        model: 'm',
        messages: [],
        defaults: { retry: false },
        schema: {},
        signal: new AbortController().signal
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ModelError)
    const meta = (caught as ModelError).meta as { providerBody?: unknown }
    expect(meta.providerBody).toEqual({ redacted: true, contentLength: '{"secret model output":'.length })
    expect(JSON.stringify(serializeError(caught))).not.toContain('secret model output')
  })

  it('honors retry false by throwing immediately', async () => {
    const provider = new TestProvider()
    provider.error = Object.assign(new Error('temporary'), { status: 503 })

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: false },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      meta: { status: 503, retryAttempt: 1, retryMaxAttempts: 1 }
    })
    expect(provider.calls).toBe(1)
  })

  it('rejects invalid per-call retry policies before provider execution', async () => {
    const provider = new TestProvider()

    await expect(provider.object({
      model: 'm',
      messages: [],
      call: { retry: { maxAttempts: 0 } },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toMatchObject({
      meta: {
        reason: 'invalid_model_retry_policy',
        path: 'model.retry.maxAttempts'
      }
    })
    await expect(provider.object({
      model: 'm',
      messages: [],
      call: { retry: { retryOn: { rateLimit: 'yes' as unknown as boolean } } },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toBeInstanceOf(HarnessConfigError)
    expect(provider.calls).toBe(0)
  })

  it('records safe telemetry attributes and token counters', async () => {
    const calls: Array<{ name: string; attrs: Record<string, unknown> }> = []
    const telemetry: TelemetryShim = {
      span: async (_name, _attrs, fn) => fn({ setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() } as any),
      recordHistogram: (name, _value, attrs) => { calls.push({ name, attrs }) },
      recordCounter: (name, _value, attrs) => { calls.push({ name, attrs }) },
      currentTraceparent: () => undefined
    }
    const provider = new TestProvider({ telemetry })

    await provider.object({ model: 'm', messages: [{ role: 'user', content: 'secret prompt' }], schema: {}, signal: new AbortController().signal })

    expect(calls.some((call) => call.name === 'harness.model.tokens.total')).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('secret prompt')
  })

  it('adds provider error details to telemetry attributes', async () => {
    const attrs: Record<string, unknown>[] = []
    const telemetry: TelemetryShim = {
      span: async (_name, _attrs, fn) => fn({ setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn(), setAttributes: (next: Record<string, unknown>) => attrs.push(next) } as any),
      recordHistogram: () => undefined,
      recordCounter: () => undefined,
      currentTraceparent: () => undefined
    }
    const provider = new TestProvider({ telemetry })
    provider.error = Object.assign(new Error('bad request'), {
      status: 400,
      code: 'invalid_request_error',
      type: 'invalid_request_error',
      param: 'messages',
      error: { message: 'Invalid messages', type: 'invalid_request_error', param: 'messages' }
    })

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: false },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toBeInstanceOf(ModelError)

    expect(attrs.at(-1)).toMatchObject({
      'harness.error.model_provider_status': 400,
      'harness.error.model_provider_code': 'invalid_request_error',
      'harness.error.model_provider_type': 'invalid_request_error',
      'harness.error.model_provider_param': 'messages',
      'harness.error.model_provider_message': 'Invalid messages'
    })
  })

  it('redacts sensitive provider error metadata in logs and serialization', async () => {
    const logs: string[] = []
    const provider = new TestProvider({
      logger: new JsonLogger({ level: 'error', out: { write: (chunk) => logs.push(chunk) } })
    })
    provider.error = Object.assign(new Error('bad Bearer sk_live_secret'), {
      status: 400,
      code: 'invalid_request_error',
      request_id: 'req_redact',
      error: {
        message: 'Invalid request Bearer sk_live_secret',
        type: 'invalid_request_error',
        apiKey: 'sk_live_secret',
        messages: [{ role: 'user', content: 'private prompt' }]
      },
      headers: {
        authorization: 'Bearer sk_live_secret',
        'x-request-id': 'req_redact',
        'x-api-key': 'sk_live_secret'
      }
    })

    let caught: unknown
    try {
      await provider.object({
        model: 'm',
        messages: [],
        defaults: { retry: false },
        schema: {},
        signal: new AbortController().signal
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ModelError)
    const serialized = JSON.stringify(serializeError(caught))
    const logJson = logs.join('')
    expect(serialized).toContain('req_redact')
    expect(logJson).toContain('req_redact')
    expect(serialized).not.toContain('sk_live_secret')
    expect(logJson).not.toContain('sk_live_secret')
    expect(serialized).not.toContain('private prompt')
    expect(logJson).not.toContain('private prompt')
    expect(serialized).not.toContain('authorization')
  })

  it('inherits harness logger, telemetry, and timeout when adapter did not set them', async () => {
    const logs: string[] = []
    const counters: string[] = []
    const telemetry: TelemetryShim = {
      span: async (_name, _attrs, fn) => fn({ setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() } as any),
      recordHistogram: () => undefined,
      recordCounter: (name) => { counters.push(name) },
      currentTraceparent: () => undefined
    }
    const provider = new TestProvider()
    provider.delayMs = 50
    provider.configureHarnessContext(harnessContext(new JsonLogger({ level: 'error', out: { write: (chunk) => logs.push(chunk) } }), telemetry, 5))

    await expect(provider.object({
      model: 'm',
      messages: [],
      defaults: { retry: false },
      schema: {},
      signal: new AbortController().signal
    })).rejects.toBeInstanceOf(OperationTimeoutError)

    expect(counters).toContain('harness.model.errors')
    expect(logs.join('')).toContain('Model provider call failed.')
  })

  it('keeps explicit adapter telemetry over inherited harness telemetry', async () => {
    const explicitCounters: string[] = []
    const inheritedCounters: string[] = []
    const explicitTelemetry: TelemetryShim = {
      span: async (_name, _attrs, fn) => fn({ setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() } as any),
      recordHistogram: () => undefined,
      recordCounter: (name) => { explicitCounters.push(name) },
      currentTraceparent: () => undefined
    }
    const inheritedTelemetry: TelemetryShim = {
      span: async (_name, _attrs, fn) => fn({ setStatus: vi.fn(), recordException: vi.fn(), end: vi.fn() } as any),
      recordHistogram: () => undefined,
      recordCounter: (name) => { inheritedCounters.push(name) },
      currentTraceparent: () => undefined
    }
    const provider = new TestProvider({ telemetry: explicitTelemetry })
    provider.configureHarnessContext(harnessContext(new JsonLogger({ level: 'fatal', out: { write: () => undefined } }), inheritedTelemetry))

    await provider.object({ model: 'm', messages: [], schema: {}, signal: new AbortController().signal })

    expect(explicitCounters).toContain('harness.model.tokens.total')
    expect(inheritedCounters).toEqual([])
  })

  it('retries streams only before the first yielded chunk', async () => {
    const provider = new TestStreamProvider()
    provider.errorsBeforeFirstChunk.push(Object.assign(new Error('temporary'), { status: 503 }))

    const chunks = await collect(provider.textStream({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 2, minDelayMs: 1, maxDelayMs: 1, maxActiveDelayMs: 10, maxActiveElapsedMs: 1000 } },
      signal: new AbortController().signal
    }))

    expect(provider.attempts).toBe(2)
    expect(chunks.filter((chunk) => chunk.kind === 'delta')).toHaveLength(2)
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', finishReason: 'stop' })
  })

  it('does not retry streams after the first chunk was yielded', async () => {
    const provider = new TestStreamProvider()
    provider.errorAfterFirstChunk = Object.assign(new Error('mid-stream failure'), { status: 503 })

    await expect(collect(provider.textStream({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 3, minDelayMs: 1, maxDelayMs: 1, maxActiveDelayMs: 10, maxActiveElapsedMs: 1000 } },
      signal: new AbortController().signal
    }))).rejects.toMatchObject({
      meta: { retryKind: 'none' }
    })
    expect(provider.attempts).toBe(1)
  })

  it('classifies a base-enforced stream timeout as OperationTimeoutError, not cancellation', async () => {
    const provider = new TestStreamProvider({ timeoutMs: 10 })
    provider.hangsBeforeFirstChunkMs.push(100)

    await expect(collect(provider.textStream({
      model: 'm',
      messages: [],
      defaults: { retry: false },
      signal: new AbortController().signal
    }))).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(OperationTimeoutError)
      expect((error as OperationTimeoutError).meta).toMatchObject({ scope: 'model' })
      return true
    })
  })

  it('retries a stream timeout before the first chunk', async () => {
    const provider = new TestStreamProvider({ timeoutMs: 25 })
    provider.hangsBeforeFirstChunkMs.push(200)

    const chunks = await collect(provider.textStream({
      model: 'm',
      messages: [],
      defaults: { retry: { maxAttempts: 2, minDelayMs: 1, maxDelayMs: 1, maxActiveDelayMs: 10, maxActiveElapsedMs: 5000 } },
      signal: new AbortController().signal
    }))

    expect(provider.attempts).toBe(2)
    expect(chunks.at(-1)).toMatchObject({ kind: 'finish', finishReason: 'stop' })
  })

  it('does not raise an unhandled rejection when a stream outlives the base timeout', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const provider = new TestStreamProvider({ timeoutMs: 15 })
      provider.hangBetweenChunksMs = 60

      await expect(collect(provider.textStream({
        model: 'm',
        messages: [],
        defaults: { retry: false },
        signal: new AbortController().signal
      }))).rejects.toBeInstanceOf(OperationTimeoutError)

      // Allow any stray rejection from the armed timeout promise to surface.
      await new Promise((resolve) => setTimeout(resolve, 80))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
