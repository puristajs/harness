import { describe, expect, it, vi } from 'vitest'

import { ModelError, OperationTimeoutError, serializeError } from '../errors/index.js'
import { JsonLogger, type Logger } from '../logger/index.js'
import { BaseModelProvider } from '../ports/base-model-provider.js'
import type { ObjectRequest, ObjectResponse } from '../ports/model-provider.js'
import type { TelemetryShim } from '../telemetry/index.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'

class TestProvider extends BaseModelProvider {
  public error: unknown
  public delayMs = 0

  constructor(opts: { timeoutMs?: number; telemetry?: TelemetryShim; logger?: Logger } = {}) {
    super({ id: 'test', genAiSystem: 'test', ...opts })
  }

  protected override async doObject<T extends import('./json.js').JsonValue = import('./json.js').JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    }
    if (this.error) throw this.error
    return {
      object: { ok: true } as unknown as T,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: 'stop',
      raw: { secret: 'not logged' }
    }
  }
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
      schema: {},
      signal: new AbortController().signal
    })).rejects.toBeInstanceOf(OperationTimeoutError)
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
})
