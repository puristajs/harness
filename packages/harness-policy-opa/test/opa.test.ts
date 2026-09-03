import type {
  BuilderState,
  GovernanceContext,
  GovernancePolicyEvaluator,
  JsonValue,
} from '@purista/harness'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createOpaClient,
  OPA_DEFAULT_MAX_RESPONSE_BYTES,
  OpaClientError,
  opaPolicy,
  OpaPolicyError,
  type OpaPolicyRegistrar,
} from '../src/index.js'
import { FakeOpaDataApi } from '../src/testing/index.js'
import { RecordingTelemetry } from '@purista/harness/testing'

describe('createOpaClient', () => {
  it('propagates only W3C trace context to a trusted OPA endpoint', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueDecision({ allow: true })
    const telemetry = new RecordingTelemetry()
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch })
    client.configureHarnessContext({
      harnessName: 'telemetry-test', logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } },
      telemetry, metrics: { counter() {}, histogram() {}, duration: async (_name, _attrs, action) => action() },
      contentCaptureMode: 'NO_CONTENT',
      defaults: { agentMaxIterations: 1, runTimeoutMs: 1, toolTimeoutMs: 1, decisionTimeoutMs: 1, skillTimeoutMs: 1, modelTimeoutMs: 1, maxParallelToolCalls: 1 },
    })

    await telemetry.span('parent', {}, async () => client.query(['policy'], { secret: 'must-not-appear' }))
    expect(api.requests[0]?.init.headers).toMatchObject({
      traceparent: '00-00000000000000000000000000000001-0000000000000001-01',
    })
    expect(JSON.stringify(telemetry)).not.toContain('must-not-appear')
  })

  it('sends the narrow Data API request and decodes result plus decision id', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueResponse({ result: { allow: true }, decision_id: 'decision-1', future_metadata: true })
    const client = createOpaClient({
      baseUrl: 'https://opa.example.test/root',
      headers: { authorization: 'Bearer test-only-secret' },
      fetch: api.fetch,
    })

    await expect(client.query(['bank', 'tenant policy'], { amount: 42 })).resolves.toEqual({
      defined: true,
      result: { allow: true },
      decisionId: 'decision-1',
    })
    expect(api.requests).toHaveLength(1)
    expect(api.requests[0]).toMatchObject({
      url: 'https://opa.example.test/root/v1/data/bank/tenant%20policy',
      init: {
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({
          authorization: 'Bearer test-only-secret',
          'content-type': 'application/json',
        }),
      },
    })
    expect(JSON.parse(String(api.requests[0]?.init.body))).toEqual({ input: { amount: 42 } })
    api.assertExhausted()
  })

  it('distinguishes an undefined document from a defined JSON null result', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueUndefinedDecision({ decisionId: 'undefined-1' })
    api.enqueueDecision(null)
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch })

    await expect(client.query(['missing'], {})).resolves.toEqual({
      defined: false,
      decisionId: 'undefined-1',
    })
    await expect(client.query(['null'], {})).resolves.toEqual({ defined: true, result: null })
    api.assertExhausted()
  })

  it('validates fixed URL, headers, limits, input, and path segments before transport', async () => {
    expect(() => createOpaClient({ baseUrl: '/relative' })).toThrow('absolute HTTP(S)')
    expect(() => createOpaClient({ baseUrl: 'ftp://opa.example.test/' })).toThrow('credential-free HTTP(S)')
    expect(() => createOpaClient({ baseUrl: 'https://user:secret@opa.example.test/' })).toThrow('credential-free HTTP(S)')
    expect(() => createOpaClient({ baseUrl: 'https://opa.example.test/?tenant=x' })).toThrow('credential-free HTTP(S)')
    expect(() => createOpaClient({ baseUrl: 'https://opa.example.test/#fragment' })).toThrow('credential-free HTTP(S)')
    expect(() => createOpaClient({ baseUrl: 'https://opa.example.test/', headers: { 'content-type': 'text/plain' } })).toThrow('transport headers')
    expect(() => createOpaClient({ baseUrl: 'https://opa.example.test/', headers: { authorization: 'bad\nheader' } })).toThrow('transport headers')
    expect(() => createOpaClient({ baseUrl: 'https://opa.example.test/', timeoutMs: 0 })).toThrow('positive safe integer')
    expect(() => createOpaClient({ baseUrl: 'https://opa.example.test/', maxResponseBytes: 4_194_305 })).toThrow('4 MiB')

    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch })
    await expect(client.query([] as never, {})).rejects.toThrow('at least one')
    await expect(client.query(['..'], {})).rejects.toThrow('invalid path segment')
    await expect(client.query(['a/b'], {})).rejects.toThrow('invalid path segment')
    await expect(client.query(['valid'], undefined as never)).rejects.toThrow('JSON-compatible')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [{ error: 'synthetic-secret' }, { status: 503 }, 'http'],
    [{ result: true }, { headers: { 'content-type': 'text/plain' } }, 'invalid_content_type'],
    [['not-an-envelope'], {}, 'malformed_response'],
    [{ decision_id: '' }, {}, 'malformed_response'],
    [{ decision_id: 42 }, {}, 'malformed_response'],
  ] as const)('normalizes unsafe response %j as %s', async (body, options, kind) => {
    const api = new FakeOpaDataApi()
    api.enqueueResponse(body, options)
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch })

    const error = await client.query(['policy'], {}).catch((failure: unknown) => failure)
    expect(error).toEqual(expect.objectContaining({ kind, message: 'Open Policy Agent request failed.' }))
    expect(JSON.stringify(error)).not.toContain('synthetic-secret')
  })

  it('enforces the streamed body bound even when Content-Length is missing or false', async () => {
    const tooLarge = JSON.stringify({ result: 'x'.repeat(64) })
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(tooLarge.slice(0, 20)))
        controller.enqueue(new TextEncoder().encode(tooLarge.slice(20)))
        controller.close()
      },
    })
    const client = createOpaClient({
      baseUrl: 'https://opa.example.test/',
      maxResponseBytes: 32,
      fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json', 'content-length': '1' } }),
    })

    await expect(client.query(['policy'], {})).rejects.toMatchObject({ kind: 'response_too_large' })

    const declared = createOpaClient({
      baseUrl: 'https://opa.example.test/',
      maxResponseBytes: OPA_DEFAULT_MAX_RESPONSE_BYTES,
      fetch: async () => new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': String(OPA_DEFAULT_MAX_RESPONSE_BYTES + 1) },
      }),
    })
    await expect(declared.query(['policy'], {})).rejects.toMatchObject({ kind: 'response_too_large' })
  })

  it('classifies parent cancellation, deadline expiry, and transport failure without retrying', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch })
    await expect(client.query(['policy'], {}, { signal: aborted.signal, deadline: Date.now() + 1_000 })).rejects.toMatchObject({ kind: 'aborted' })
    expect(fetch).not.toHaveBeenCalled()

    const nonCooperative = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined))
    const timed = createOpaClient({ baseUrl: 'https://opa.example.test/', timeoutMs: 5, fetch: nonCooperative })
    await expect(timed.query(['policy'], {})).rejects.toMatchObject({ kind: 'deadline_exceeded' })
    expect(nonCooperative).toHaveBeenCalledTimes(1)

    const failed = new FakeOpaDataApi()
    failed.enqueueTransportError(new Error('private transport detail'))
    const transport = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: failed.fetch })
    await expect(transport.query(['policy'], {})).rejects.toEqual(expect.objectContaining({
      kind: 'transport',
      message: 'Open Policy Agent request failed.',
    } satisfies Partial<OpaClientError>))
  })
})

describe('opaPolicy', () => {
  it('skips non-applicable input and maps only validated transformed results', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueDecision({ allowed: true })
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch })
    const policy = opaPolicy(registrar(), {
      id: 'transfer-policy',
      version: '2026.08.30',
      client,
      decisionPath: ['bank', 'transfer'],
      mapInput: (context) => context.toolId === 'transfer' ? { amount: context.input } : undefined,
      resultSchema: z.object({ allowed: z.boolean() }).transform((value) => ({
        effect: value.allowed ? 'allow' as const : 'deny' as const,
      })),
      mapDecision: async (result) => ({ effect: result.effect, ruleId: 'opa-transfer' }),
    })

    await expect(policy.evaluate(context('other', 1))).resolves.toBeUndefined()
    expect(api.requests).toHaveLength(0)
    await expect(policy.evaluate(context('transfer', 42))).resolves.toEqual({
      effect: 'allow',
      ruleId: 'opa-transfer',
    })
    expect(JSON.parse(String(api.requests[0]?.init.body))).toEqual({ input: { amount: 42 } })
    api.assertExhausted()
  })

  it('treats an undefined OPA result as an unmatched evaluator', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueUndefinedDecision()
    const policy = simplePolicy(api)
    await expect(policy.evaluate(context('transfer', 1))).resolves.toBeUndefined()
  })

  it.each([
    ['input_mapping', () => simplePolicy(new FakeOpaDataApi(), { mapInput: () => { throw new Error('private input') } })],
    ['non_json_input', () => simplePolicy(new FakeOpaDataApi(), { mapInput: () => 1n as unknown as JsonValue })],
    ['decision_mapping', () => {
      const api = new FakeOpaDataApi()
      api.enqueueDecision({ effect: 'allow' })
      return simplePolicy(api, { mapDecision: () => { throw new Error('private decision') } })
    }],
  ] as const)('normalizes %s failures without retaining callback content', async (kind, make) => {
    const policy = make!()
    const error = await Promise.resolve(policy.evaluate(context('transfer', 1))).catch((failure: unknown) => failure)
    expect(error).toEqual(expect.objectContaining({ kind, message: 'Open Policy Agent policy mapping failed.' }))
    expect(JSON.stringify(error)).not.toContain('private')
  })

  it('rejects invalid Standard Schema outcomes and schema-thrown content safely', async () => {
    const scenarios = [
      z.object({ effect: z.literal('allow') }),
      { '~standard': { version: 1, vendor: 'test', validate: () => { throw new Error('private schema') } } },
      { '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message: 'private issue' }] }) } },
      { '~standard': { version: 1, vendor: 'test', validate: () => ({ value: new Date() }) } },
      { '~standard': { version: 1, vendor: 'test', validate: () => null } },
    ] as const

    for (const schema of scenarios) {
      const api = new FakeOpaDataApi()
      api.enqueueDecision({ effect: schema === scenarios[0] ? 'deny' : 'allow' })
      const policy = opaPolicy(registrar(), {
        id: 'schema-policy',
        client: createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch }),
        decisionPath: ['schema'],
        mapInput: () => ({}),
        resultSchema: schema as never,
        mapDecision: () => ({ effect: 'allow' }),
      })
      await expect(policy.evaluate(context('transfer', 1))).rejects.toMatchObject({ kind: 'result_validation' })
    }
  })

  it('validates policy construction and preserves already normalized errors', async () => {
    expect(() => opaPolicy(registrar(), {
      id: 'invalid\nid',
      client: {} as never,
      decisionPath: ['policy'],
      mapInput: () => ({}),
      resultSchema: z.object({}),
      mapDecision: () => undefined,
    })).toThrow('without control characters')

    const normalized = new OpaPolicyError('input_mapping')
    const policy = simplePolicy(new FakeOpaDataApi(), { mapInput: () => { throw normalized } })
    await expect(policy.evaluate(context('transfer', 1))).rejects.toBe(normalized)
  })
})

describe('FakeOpaDataApi', () => {
  it('is strict, detects unused fixtures, and resets all state', async () => {
    const api = new FakeOpaDataApi()
    await expect(api.fetch('https://opa.example.test/', {})).rejects.toThrow('unqueued request')
    api.enqueueDecision(true)
    expect(() => api.assertExhausted()).toThrow('unused scripted response')
    api.reset()
    expect(api.requests).toEqual([])
    expect(() => api.assertExhausted()).not.toThrow()
  })
})

function registrar(): OpaPolicyRegistrar<BuilderState> {
  return {
    adapter<const P extends GovernancePolicyEvaluator<BuilderState>>(definition: P): P {
      return definition
    },
  }
}

function context(toolId: string, input: JsonValue): GovernanceContext {
  return {
    toolId: toolId as never,
    input,
    callId: 'call-1',
    invocationId: 'invocation-1',
    agentId: 'agent-1',
    runId: 'run-1',
    sessionId: 'session-1',
    step: 0,
    metadata: {},
    signal: new AbortController().signal,
    deadline: Date.now() + 1_000,
  }
}

function simplePolicy(
  api: FakeOpaDataApi,
  overrides: {
    mapInput?: () => JsonValue | undefined
    mapDecision?: () => { effect: 'allow' }
  } = {},
): GovernancePolicyEvaluator {
  return opaPolicy(registrar(), {
    id: 'simple-policy',
    client: createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch }),
    decisionPath: ['simple'],
    mapInput: overrides.mapInput ?? (() => ({})),
    resultSchema: z.object({ effect: z.literal('allow') }),
    mapDecision: overrides.mapDecision ?? (() => ({ effect: 'allow' })),
  })
}
