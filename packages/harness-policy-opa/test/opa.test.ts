import type {
  GovernanceContext,
  GovernanceDefinitionHelpers,
  GovernancePolicyEvaluator,
  GovernanceToolMap,
  JsonValue,
} from '@purista/harness'
import { DecisionEvaluationError, defineAgent, defineHarness, defineTool, normalizeHarnessTraceContext } from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createOpaClient,
  OPA_DEFAULT_MAX_REQUEST_BYTES,
  OPA_DEFAULT_MAX_RESPONSE_BYTES,
  OPA_MAX_REQUEST_BYTES,
  OPA_MAX_RESPONSE_BYTES,
  OpaClientError,
  opaPolicy,
  OpaPolicyError,
} from '../src/index.js'
import { FakeOpaDataApi } from '../src/testing/index.js'

describe('createOpaClient', () => {
  it('snapshots closed client configuration and returns only a frozen query method', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueDecision(true)
    const headers = { 'X-Tenant': 'first', Authorization: 'Bearer private' }
    const options = { baseUrl: 'https://opa.example.test/proxy', headers, fetch: api.fetch }
    const client = createOpaClient(options)
    headers['X-Tenant'] = 'changed'
    options.baseUrl = 'https://attacker.example.test/'

    expect(Object.isFrozen(client)).toBe(true)
    expect(Reflect.ownKeys(client)).toEqual(['query'])
    await client.query(['policy'], {})
    expect(api.requests[0]?.url).toBe('https://opa.example.test/proxy/v1/data/policy')
    expect(api.requests[0]?.init.headers).toEqual({
      authorization: 'Bearer private', 'content-type': 'application/json', 'x-tenant': 'first',
    })
  })

  it('rejects inherited client and execution fields without I/O', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const inheritedClient = Object.create({ baseUrl: 'https://opa.example.test/', fetch }) as never
    expect(() => createOpaClient(inheritedClient)).toThrowError(expect.objectContaining({ kind: 'invalid_configuration' }))
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch })
    const inheritedExecution = Object.create({ signal: new AbortController().signal, deadline: Date.now() + 1_000 }) as never
    await expect(client.query(['policy'], {}, inheritedExecution)).rejects.toMatchObject({ kind: 'invalid_request' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('enforces the serialized request bound and closed execution before any I/O', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch, maxRequestBytes: 20 })
    await expect(client.query(['policy'], 'x'.repeat(32))).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(client.query(['policy'], {}, {
      signal: new AbortController().signal, deadline: Date.now() + 1_000, extra: true,
    } as never)).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(client.query(['policy'], {}, {
      signal: {} as AbortSignal, deadline: Date.now() + 1_000,
    })).rejects.toMatchObject({ kind: 'invalid_request' })
    expect(fetch).not.toHaveBeenCalled()
    expect(OPA_DEFAULT_MAX_REQUEST_BYTES).toBe(1_048_576)
  })

  it('enforces exact request, path-count, and path-segment byte edges', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueDecision(true)
    api.enqueueDecision(true)
    api.enqueueDecision(true)
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch, maxRequestBytes: 16 })
    await expect(client.query(['policy'], 'xxxx')).resolves.toEqual({ defined: true, result: true })
    await expect(client.query(Array.from({ length: 64 }, () => 'a') as never, {})).resolves.toEqual({ defined: true, result: true })
    await expect(client.query(['a'.repeat(256)], {})).resolves.toEqual({ defined: true, result: true })
    await expect(client.query(['policy'], 'xxxxx')).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(client.query(Array.from({ length: 65 }, () => 'a') as never, {})).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(client.query(['a'.repeat(257)], {})).rejects.toMatchObject({ kind: 'invalid_request' })
    expect(api.requests).toHaveLength(3)
  })

  it('reuses Core trace validation and keeps trace state per query', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueDecision(true)
    api.enqueueDecision(true)
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch })
    const accepted = '00-00000000000000000000000000000001-0000000000000001-03'
    expect(normalizeHarnessTraceContext({ traceparent: accepted }).traceparent).toBe(accepted)
    await client.query(['policy'], {}, { signal: new AbortController().signal, deadline: Date.now() + 1_000, traceparent: accepted })
    await client.query(['policy'], {}, { signal: new AbortController().signal, deadline: Date.now() + 1_000 })
    expect(api.requests[0]?.init.headers).toMatchObject({ traceparent: accepted })
    expect(api.requests[1]?.init.headers).not.toHaveProperty('traceparent')

    const fetch = vi.fn<typeof globalThis.fetch>()
    const rejecting = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch })
    for (const traceparent of [
      'ff-00000000000000000000000000000001-0000000000000001-01',
      '00-00000000000000000000000000000000-0000000000000001-01',
      '00-00000000000000000000000000000001-0000000000000000-01',
      `${accepted}\nprivate`,
    ]) {
      expect(() => normalizeHarnessTraceContext({ traceparent })).toThrow()
      await expect(rejecting.query(['policy'], {}, {
        signal: new AbortController().signal, deadline: Date.now() + 1_000, traceparent,
      })).rejects.toMatchObject({ kind: 'invalid_traceparent', message: 'OPA request failed.' })
    }
    for (const traceparent of [42, undefined]) {
      await expect(rejecting.query(['policy'], {}, {
        signal: new AbortController().signal, deadline: Date.now() + 1_000, traceparent,
      } as never)).rejects.toMatchObject({ kind: 'invalid_traceparent', message: 'OPA request failed.' })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('validates UTF-8 limits, normalized header collisions, and reserved trace headers', async () => {
    for (const options of [
      { baseUrl: 'https://opa.example.test/', headers: { TraceParent: 'private' } },
      { baseUrl: 'https://opa.example.test/', headers: { Foo: 'a', foo: 'b' } },
      { baseUrl: 'https://opa.example.test/', headers: { name: 'x'.repeat(8_193) } },
      { baseUrl: 'https://opa.example.test/', headers: { name: '\u0085' } },
    ]) expect(() => createOpaClient(options)).toThrowError(expect.objectContaining({ kind: 'invalid_configuration' }))
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch })
    await expect(client.query(['😀'.repeat(65)], {})).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(client.query(['\u0085'], {})).rejects.toMatchObject({ kind: 'invalid_request' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('enforces exact header count, name, aggregate, and complete forbidden-name boundaries', () => {
    const baseUrl = 'https://opa.example.test/'
    const sixtyFour = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`x${index}`, 'v']))
    expect(() => createOpaClient({ baseUrl, headers: sixtyFour })).not.toThrow()
    expect(() => createOpaClient({ baseUrl, headers: { ['x'.repeat(256)]: 'v' } })).not.toThrow()
    const exactAggregate = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`x${index}`, 'v'.repeat(8_190)]))
    expect(() => createOpaClient({ baseUrl, headers: exactAggregate })).not.toThrow()

    const sixtyFive = { ...sixtyFour, overflow: 'v' }
    const aggregateOverflow = { ...exactAggregate, x0: 'v'.repeat(8_191) }
    for (const headers of [sixtyFive, { ['x'.repeat(257)]: 'v' }, aggregateOverflow]) {
      expect(() => createOpaClient({ baseUrl, headers })).toThrowError(expect.objectContaining({ kind: 'invalid_configuration' }))
    }
    for (const name of [
      'content-type', 'content-length', 'host', 'connection', 'keep-alive', 'proxy-authenticate',
      'proxy-authorization', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'traceparent', 'tracestate',
    ]) expect(() => createOpaClient({ baseUrl, headers: { [name]: 'private' } }))
      .toThrowError(expect.objectContaining({ kind: 'invalid_configuration' }))
  })

  it('enforces exact 8,192-byte base and completed request URL bounds', async () => {
    const prefix = 'https://opa.test/'
    const exactBase = `${prefix}${'a'.repeat(8_192 - prefix.length - 1)}/`
    expect(new TextEncoder().encode(exactBase)).toHaveLength(8_192)
    expect(() => createOpaClient({ baseUrl: exactBase })).not.toThrow()
    expect(() => createOpaClient({ baseUrl: `${exactBase}a` })).toThrowError(expect.objectContaining({ kind: 'invalid_configuration' }))

    const budget = 8_192 - prefix.length - 'v1/data/'.length
    const segments: string[] = []
    let remaining = budget
    while (remaining > 256) { segments.push('a'.repeat(256)); remaining -= 257 }
    segments.push('a'.repeat(remaining))
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"result":true}', { headers: { 'content-type': 'application/json' } }))
    const client = createOpaClient({ baseUrl: prefix, fetch })
    await expect(client.query(segments as never, {})).resolves.toEqual({ defined: true, result: true })
    expect(new TextEncoder().encode(String(fetch.mock.calls[0]?.[0]))).toHaveLength(8_192)
    const overflow = [...segments]
    overflow[overflow.length - 1] += 'a'
    await expect(client.query(overflow as never, {})).rejects.toMatchObject({ kind: 'invalid_request' })
    expect(fetch).toHaveBeenCalledTimes(1)
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
    for (const options of [
      { baseUrl: '/relative' },
      { baseUrl: 'ftp://opa.example.test/' },
      { baseUrl: 'https://user:secret@opa.example.test/' },
      { baseUrl: 'https://opa.example.test/?tenant=x' },
      { baseUrl: 'https://opa.example.test/#fragment' },
      { baseUrl: 'https://opa.example.test/', headers: { 'content-type': 'text/plain' } },
      { baseUrl: 'https://opa.example.test/', headers: { authorization: 'bad\nheader' } },
      { baseUrl: 'https://opa.example.test/', timeoutMs: 0 },
      { baseUrl: 'https://opa.example.test/', maxResponseBytes: OPA_MAX_RESPONSE_BYTES + 1 },
      { baseUrl: 'https://opa.example.test/', maxRequestBytes: OPA_MAX_REQUEST_BYTES + 1 },
      { baseUrl: 'https://opa.example.test/', unknown: true },
    ]) expect(() => createOpaClient(options as never)).toThrowError(expect.objectContaining({ kind: 'invalid_configuration', message: 'OPA request failed.' }))

    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch })
    await expect(client.query([] as never, {})).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(client.query(['..'], {})).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(client.query(['a/b'], {})).rejects.toMatchObject({ kind: 'invalid_request' })
    await expect(client.query(['valid'], undefined as never)).rejects.toMatchObject({ kind: 'invalid_request' })
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
    expect(error).toEqual(expect.objectContaining({ kind, message: 'OPA request failed.' }))
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

  it('releases the response reader and preserves semantic failures over cleanup failures', async () => {
    const tooLarge = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"result":"private-value"}')) },
      cancel() { throw new Error('private cleanup') },
    })
    const client = createOpaClient({
      baseUrl: 'https://opa.example.test/', maxResponseBytes: 8,
      fetch: async () => new Response(tooLarge, { headers: { 'content-type': 'application/json' } }),
    })
    await expect(client.query(['policy'], {})).rejects.toMatchObject({ kind: 'response_too_large', message: 'OPA request failed.' })
    await vi.waitFor(() => expect(tooLarge.locked).toBe(false))
  })

  it('cancels and unlocks a noncooperative response reader when its parent aborts', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"result":')) },
      pull: () => new Promise<void>(() => undefined),
      cancel,
    })
    const parent = new AbortController()
    const client = createOpaClient({
      baseUrl: 'https://opa.example.test/',
      fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
    })
    const pending = client.query(['policy'], {}, { signal: parent.signal, deadline: Date.now() + 1_000 })
    setTimeout(() => parent.abort(), 5)
    await expect(pending).rejects.toMatchObject({ kind: 'aborted' })
    await vi.waitFor(() => {
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(stream.locked).toBe(false)
    })
  })

  it('rejects malformed JSON media-type parameters before reading a response body', async () => {
    for (const contentType of [
      'application/json;', 'application/json; charset', 'application/json; =utf-8',
      'application/json; charset="unterminated', 'application/json; note="a\u007fb"',
    ]) {
      const client = createOpaClient({
        baseUrl: 'https://opa.example.test/',
        fetch: async () => new Response('{"result":true}', { headers: { 'content-type': contentType } }),
      })
      await expect(client.query(['policy'], {})).rejects.toMatchObject({ kind: 'invalid_content_type' })
    }
    const valid = createOpaClient({
      baseUrl: 'https://opa.example.test/',
      fetch: async () => new Response('{"result":true}', { headers: { 'content-type': 'Application/Problem+JSON; profile="safe;v=1"; charset="utf-8"' } }),
    })
    await expect(valid.query(['policy'], {})).resolves.toEqual({ defined: true, result: true })
    const obsText = createOpaClient({
      baseUrl: 'https://opa.example.test/',
      fetch: async () => new Response('{"result":true}', { headers: { 'content-type': 'application/json; note="é"' } }),
    })
    await expect(obsText.query(['policy'], {})).resolves.toEqual({ defined: true, result: true })
  })

  it('does not let nonsettling response cleanup replace the primary HTTP result', async () => {
    const stream = new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => undefined) })
    const client = createOpaClient({
      baseUrl: 'https://opa.example.test/', timeoutMs: 20,
      fetch: async () => new Response(stream, { status: 503, headers: { 'content-type': 'application/json' } }),
    })
    const error = await client.query(['policy'], {}).catch((failure: unknown) => failure)
    expect(error).toEqual(expect.objectContaining({ kind: 'http', status: 503, message: 'OPA request failed.' }))
    expect(Object.hasOwn(error as object, 'status')).toBe(true)
    const nonHttp = new OpaClientError('transport')
    expect(Object.hasOwn(nonHttp, 'status')).toBe(false)
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
      message: 'OPA request failed.',
    } satisfies Partial<OpaClientError>))
  })

  it('gives an already-aborted parent precedence and honors an earlier inherited deadline', async () => {
    const aborted = new AbortController()
    aborted.abort()
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>(() => undefined))
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch, timeoutMs: 1_000 })
    await expect(client.query(['policy'], {}, { signal: aborted.signal, deadline: Date.now() - 1 })).rejects.toMatchObject({ kind: 'aborted' })
    await expect(client.query(['policy'], {}, { signal: new AbortController().signal, deadline: Date.now() - 1 })).rejects.toMatchObject({ kind: 'deadline_exceeded' })
    await expect(client.query(['policy'], {}, { signal: new AbortController().signal, deadline: Date.now() + 5 })).rejects.toMatchObject({ kind: 'deadline_exceeded' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('normalizes response-stream failures and removes the linked parent listener on success', async () => {
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private stream detail')) } })
    const streamClient = createOpaClient({
      baseUrl: 'https://opa.example.test/',
      fetch: async () => new Response(broken, { headers: { 'content-type': 'application/json' } }),
    })
    const streamError = await streamClient.query(['policy'], {}).catch((failure: unknown) => failure)
    expect(streamError).toEqual(expect.objectContaining({ kind: 'transport', message: 'OPA request failed.' }))
    expect(JSON.stringify(streamError)).not.toContain('private')

    const api = new FakeOpaDataApi()
    api.enqueueDecision(true)
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout')
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch })
    await client.query(['policy'], {}, { signal: controller.signal, deadline: Date.now() + 1_000 })
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1])
    expect(clearTimer).toHaveBeenCalled()
    clearTimer.mockRestore()
  })
})

describe('opaPolicy', () => {
  it('lets Core reject an undeclared effect before the tool handler executes', async () => {
    let handlerCalls = 0
    const transfer = defineTool('transferFunds', {
      description: 'Transfer funds.', input: z.object({ amount: z.number() }), output: z.object({ accepted: z.boolean() }),
      async handler() { handlerCalls += 1; return { accepted: true } },
    })
    const agent = defineAgent('governedTransfer', {
      instructions: 'Call transferFunds once.', tools: [transfer], governance: helpers => ({ policies: [opaPolicy(helpers, {
        id: 'forgedEffectPolicy', effects: ['allow'],
        client: { query: async () => ({ defined: true, result: { effect: 'deny' } }) },
        decisionPath: ['policy'], mapInput: () => ({}), resultSchema: z.object({ effect: z.literal('deny') }),
        mapDecision: result => ({ effect: result.effect }) as never,
      })] }),
    })
    const provider = new FakeModelProvider({ strict: true })
    provider.enqueueText({
      content: '', toolCalls: [{ id: 'call-1', name: 'transferFunds', arguments: { amount: 42 } }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls',
    })
    const runtime = await defineHarness({ name: 'opaStrictDecision' }).addAgent(agent)
      .getInstance({ model: { provider, model: 'fake' } })
    const session = await runtime.getSession('strict-decision')
    await expect(session.agents.governedTransfer.run('transfer')).rejects.toMatchObject({
      constructor: DecisionEvaluationError, meta: { failureKind: 'invalid_result' },
    })
    expect(handlerCalls).toBe(0)
    await runtime.close()
  })

  it('isolates active policy traces across hosted runtimes and keeps observability content-free', async () => {
    // Resolve all participants for this boundary test through the installed public
    // package exports so Vite's source-only root alias cannot split definition identity.
    const publicHarness = await import(/* @vite-ignore */ import.meta.resolve('@purista/harness'))
    const publicTesting = await import(/* @vite-ignore */ import.meta.resolve('@purista/harness/testing'))
    const publicIntegrator = await import(/* @vite-ignore */ import.meta.resolve('@purista/harness/integrator'))
    const { defineAgent: definePublicAgent, defineHarness: definePublicHarness, defineTool: definePublicTool } = publicHarness
    const { FakeModelProvider: PublicFakeModelProvider, RecordingTelemetry: PublicRecordingTelemetry } = publicTesting
    const { createHostOwnerToken, instantiateHostedHarness } = publicIntegrator
    const requestTraceparents: string[] = []
    let release!: () => void
    const bothStarted = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
        const traceparent = new Headers(init?.headers).get('traceparent') ?? ''
        requestTraceparents.push(traceparent)
        if (requestTraceparents.length === 2) release()
        await bothStarted
        if (traceparent === '00-11111111111111111111111111111111-1111111111111111-01') {
          return new Response('{"privateHttp":"private-response"}', { status: 503, headers: { 'content-type': 'application/json' } })
        }
        return new Response('{"result":{"effect":"allow","privateResult":"private-result"},"decision_id":"private-decision"}', {
          headers: { 'content-type': 'application/json' },
        })
    })
    const client = createOpaClient({
      baseUrl: 'https://private-opa.example.test/', headers: { authorization: 'Bearer private-credential' }, fetch,
    })
    let handlerCalls = 0
    const lookup = definePublicTool('lookupAccount', {
      description: 'Look up an account.', input: z.object({ accountId: z.string() }), output: z.object({ found: z.boolean() }),
      async handler() { handlerCalls += 1; return { found: true } },
    })
    const agent = definePublicAgent('sharedOpaAgent', {
      instructions: 'Call lookupAccount once.', tools: [lookup], governance: (helpers: Pick<GovernanceDefinitionHelpers<GovernanceToolMap>, 'adapter'>) => ({ policies: [opaPolicy(helpers, {
        id: 'sharedPolicy', effects: ['allow'], client, decisionPath: ['shared'],
        mapInput: context => ({ tool: context.toolId, accountId: (context.input as { accountId: string }).accountId }),
        resultSchema: z.object({ effect: z.literal('allow') }), mapDecision: result => ({ effect: result.effect }),
      })] }),
    })
    const definition = definePublicHarness({ name: 'sharedOpaHarness' }).addAgent(agent)
    const provider = (successful: boolean) => {
      const model = new PublicFakeModelProvider({ strict: true })
      model.enqueueText({ content: '', toolCalls: [{ id: 'call', name: 'lookupAccount', arguments: { accountId: 'private' } }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
      if (successful) model.enqueueText({ content: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
      return model
    }
    const firstTrace = '00-11111111111111111111111111111111-1111111111111111-01'
    const secondTrace = '00-22222222222222222222222222222222-2222222222222222-01'
    class DistinctTelemetry extends PublicRecordingTelemetry {
      readonly #traceparent: string
      #activePolicySpans = 0
      constructor(traceparent: string) { super(); this.#traceparent = traceparent }
      async span<T>(name: string, attrs: Record<string, unknown>, fn: (span: never) => Promise<T>): Promise<T> {
        return super.span(name, attrs, async (span: never) => {
          if (name === 'harness.policy.evaluate') this.#activePolicySpans += 1
          try { return await fn(span) }
          finally { if (name === 'harness.policy.evaluate') this.#activePolicySpans -= 1 }
        })
      }
      currentTraceparent(): string | undefined { return this.#activePolicySpans > 0 ? this.#traceparent : undefined }
    }
    const firstTelemetry = new DistinctTelemetry(firstTrace)
    const secondTelemetry = new DistinctTelemetry(secondTrace)
    const logEntries: unknown[] = []
    const logger = {
      trace: (...args: unknown[]) => { logEntries.push(args) }, debug: (...args: unknown[]) => { logEntries.push(args) },
      info: (...args: unknown[]) => { logEntries.push(args) }, warn: (...args: unknown[]) => { logEntries.push(args) },
      error: (...args: unknown[]) => { logEntries.push(args) }, fatal: (...args: unknown[]) => { logEntries.push(args) }, child() { return this },
    }
    const dispatcher = { assertTarget() { throw new Error('unused dispatcher') }, async open() { throw new Error('unused dispatcher') }, async openPersisted() { throw new Error('unused dispatcher') } }
    const bindings = (telemetry: InstanceType<typeof PublicRecordingTelemetry>) => ({
      hostOwner: createHostOwnerToken(), targetDispatcher: dispatcher,
      projectIdentity: () => undefined, projectTraceContext: () => undefined, createHostContext: () => ({}), logger, telemetry,
    })
    const first = await instantiateHostedHarness(definition, { model: { provider: provider(false), model: 'fake' } }, bindings(firstTelemetry) as never)
    const second = await instantiateHostedHarness(definition, { model: { provider: provider(true), model: 'fake' } }, bindings(secondTelemetry) as never)
    const outcomes = await Promise.allSettled([
      first.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'first', input: 'first',
        invokeOptions: { sessionId: 'first' }, hostInvocation: {}, authorize: () => undefined }),
      second.runHosted({ delivery: 'fresh', target: agent.contract, wireInput: 'second', input: 'second',
        invokeOptions: { sessionId: 'second' }, hostInvocation: {}, authorize: () => undefined }),
    ])
    expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'fulfilled'])
    expect(requestTraceparents.sort()).toEqual([firstTrace, secondTrace].sort())
    expect(handlerCalls).toBe(1)
    const observed = JSON.stringify({ firstTelemetry, secondTelemetry, logEntries, failure: outcomes[0] })
    for (const protectedValue of [
      'private-opa', 'private-credential', 'private-response', 'private-result', 'private-decision', 'private', firstTrace, secondTrace,
    ]) expect(observed).not.toContain(protectedValue)
    expect((firstTelemetry as unknown as { spans: Array<{ name: string }> }).spans.some(span => span.name === 'harness.policy.evaluate')).toBe(true)
    expect((secondTelemetry as unknown as { spans: Array<{ name: string }> }).spans.some(span => span.name === 'harness.policy.evaluate')).toBe(true)
    await Promise.all([first.close(), second.close()])
  })

  it('validates, snapshots, and freezes the exact evaluator without construction I/O', async () => {
    const query = vi.fn<OpaClientQuery>().mockResolvedValue({ defined: true, result: { effect: 'allow' } })
    const client = { query }
    const effects: ['allow', 'deny'] = ['allow', 'deny']
    const decisionPath = ['bank', 'transfer'] as [string, ...string[]]
    const mapInput = vi.fn(() => ({ amount: 42 }))
    const mapDecision = vi.fn(() => ({ effect: 'allow' as const }))
    let adapterCalls = 0
    const adapter: GovernanceDefinitionHelpers<GovernanceToolMap>['adapter'] = <const P extends GovernancePolicyEvaluator<GovernanceToolMap>>(definition: P): P => {
      adapterCalls += 1
      return definition
    }
    const options = {
      id: 'snapshotPolicy', version: '2026.09.07', effects, client, decisionPath, mapInput,
      resultSchema: z.object({ effect: z.literal('allow') }), mapDecision,
    }
    const policy = opaPolicy({ adapter }, options)
    expect(query).not.toHaveBeenCalled()
    expect(adapterCalls).toBe(1)
    expect(Object.isFrozen(policy)).toBe(true)
    expect(Object.isFrozen(policy.effects)).toBe(true)
    expect(Reflect.ownKeys(policy)).toEqual(['id', 'version', 'engine', 'effects', 'evaluate'])
    expect(policy.effects).toEqual(['allow', 'deny'])

    ;(effects as unknown as ('allow' | 'deny')[])[0] = 'deny'
    decisionPath[0] = 'attacker'
    ;(options as unknown as { mapInput: () => { amount: number } }).mapInput = () => ({ amount: 999 })
    ;(options as unknown as { mapDecision: () => { effect: string } }).mapDecision = () => ({ effect: 'deny' })
    await expect(policy.evaluate(context('transfer', 42))).resolves.toEqual({ effect: 'allow' })
    expect(query).toHaveBeenCalledWith(['bank', 'transfer'], { amount: 42 }, expect.objectContaining({
      signal: expect.any(AbortSignal), deadline: expect.any(Number),
    }))
  })

  it('rejects every invalid policy configuration with one fixed safe error', () => {
    const valid = {
      id: 'validPolicy', effects: ['allow'] as const,
      client: { query: async () => ({ defined: false as const }) }, decisionPath: ['policy'] as const,
      mapInput: () => ({}), resultSchema: z.object({}), mapDecision: () => undefined,
    }
    const cases: unknown[] = [
      { ...valid, id: 'bad\nid' },
      { ...valid, version: 'bad\nversion' },
      { ...valid, effects: [] },
      { ...valid, effects: ['allow', 'allow'] },
      { ...valid, effects: ['unknown'] },
      { ...valid, client: {} },
      { ...valid, decisionPath: [] },
      { ...valid, mapInput: 1 },
      { ...valid, resultSchema: {} },
      { ...valid, resultSchema: { '~standard': { vendor: 'test', validate: () => ({ value: {} }) } } },
      { ...valid, resultSchema: { '~standard': { version: 2, vendor: 'test', validate: () => ({ value: {} }) } } },
      { ...valid, resultSchema: { '~standard': { version: 1, validate: () => ({ value: {} }) } } },
      { ...valid, resultSchema: { '~standard': { version: 1, vendor: 42, validate: () => ({ value: {} }) } } },
      { ...valid, mapDecision: 1 },
      { ...valid, configureHarnessContext: () => undefined },
    ]
    for (const candidate of cases) {
      let error: unknown
      try { opaPolicy(helpers(), candidate as never) } catch (failure) { error = failure }
      expect(error).toEqual(expect.objectContaining({ kind: 'invalid_configuration', message: 'OPA policy evaluation failed.' }))
      expect(error).not.toHaveProperty('cause')
    }
  })

  it('validates policy options in precedence order without touching later getters', () => {
    let laterReads = 0
    const candidate = {
      id: 'invalid\nid',
      effects: ['allow'],
      client: { query: async () => ({ defined: false }) },
      decisionPath: ['policy'],
      mapInput: () => ({}),
      resultSchema: z.object({}),
      get mapDecision() { laterReads += 1; throw new Error('private later getter') },
    }
    expect(() => opaPolicy(helpers(), candidate as never)).toThrowError(expect.objectContaining({ kind: 'invalid_configuration' }))
    expect(laterReads).toBe(0)
  })

  it('rejects a policy whose required configuration is inherited', () => {
    const inherited = Object.create({
      id: 'inheritedPolicy', effects: ['allow'], client: { query: async () => ({ defined: false }) },
      decisionPath: ['policy'], mapInput: () => ({}), resultSchema: z.object({}), mapDecision: () => undefined,
    })
    expect(() => opaPolicy(helpers(), inherited as never)).toThrowError(expect.objectContaining({ kind: 'invalid_configuration' }))
  })

  it('reads Standard Schema V1 descriptor accessors once during construction', () => {
    const reads = { standard: 0, version: 0, vendor: 0, validate: 0 }
    const descriptor = Object.defineProperties({}, {
      version: { enumerable: true, get() { reads.version += 1; return 1 } },
      vendor: { enumerable: true, get() { reads.vendor += 1; return 'test' } },
      validate: { enumerable: true, get() { reads.validate += 1; return () => ({ value: {} }) } },
    })
    const schema = Object.defineProperty({}, '~standard', {
      enumerable: true, get() { reads.standard += 1; return descriptor },
    })
    expect(() => opaPolicy(helpers(), {
      id: 'accessorSchema', effects: ['allow'], client: { query: async () => ({ defined: false }) },
      decisionPath: ['policy'], mapInput: () => ({}), resultSchema: schema as never, mapDecision: () => undefined,
    })).not.toThrow()
    expect(reads).toEqual({ standard: 1, version: 1, vendor: 1, validate: 1 })
  })

  it('passes only the current signal, deadline, and traceparent and normalizes custom client failures', async () => {
    const query = vi.fn<OpaClientQuery>().mockResolvedValue({ defined: true, result: { effect: 'allow' } })
    const policy = simplePolicyWithClient({ query })
    const active = context('transfer', 1, '00-00000000000000000000000000000001-0000000000000001-03')
    await policy.evaluate(active)
    expect(query).toHaveBeenCalledWith(['simple'], {}, {
      signal: active.signal, deadline: active.deadline, traceparent: active.traceparent,
    })

    const unsafe = simplePolicyWithClient({ query: async () => { throw new Error('private custom client detail') } })
    const error = await Promise.resolve(unsafe.evaluate(active)).catch((failure: unknown) => failure)
    expect(error).toEqual(expect.objectContaining({ kind: 'transport', message: 'OPA request failed.' }))
    expect(error).not.toHaveProperty('cause')
    expect(JSON.stringify(error)).not.toContain('private')
  })

  it('skips non-applicable input and maps only validated transformed results', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueDecision({ allowed: true })
    const client = createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch })
    const policy = opaPolicy(helpers(), {
      id: 'transfer-policy',
      version: '2026.08.30',
      effects: ['allow', 'deny'],
      client,
      decisionPath: ['bank', 'transfer'],
      mapInput: (context) => context.toolId === 'transfer' ? { amount: context.input as number } : undefined,
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
    expect(error).toEqual(expect.objectContaining({ kind, message: 'OPA policy evaluation failed.' }))
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
      const policy = opaPolicy(helpers(), {
        id: 'schema-policy',
        effects: ['allow'],
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
    expect(() => opaPolicy(helpers(), {
      id: 'invalid\nid',
      effects: ['allow'],
      client: {} as never,
      decisionPath: ['policy'],
      mapInput: () => ({}),
      resultSchema: z.object({}),
      mapDecision: () => undefined,
    })).toThrowError(expect.objectContaining({ kind: 'invalid_configuration', message: 'OPA policy evaluation failed.' }))

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

function helpers(): Pick<GovernanceDefinitionHelpers<GovernanceToolMap>, 'adapter'> {
  return {
    adapter<const P extends GovernancePolicyEvaluator<GovernanceToolMap>>(definition: P): P {
      return definition
    },
  }
}

type OpaClientQuery = (path: readonly [string, ...string[]], input: JsonValue, execution?: {
  signal: AbortSignal; deadline: number; traceparent?: string
}) => Promise<Readonly<{ defined: false; decisionId?: string }> | Readonly<{ defined: true; result: JsonValue; decisionId?: string }>>

function context(toolId: string, input: JsonValue, traceparent?: string): GovernanceContext {
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
    ...(traceparent === undefined ? {} : { traceparent }),
  }
}

function simplePolicyWithClient(client: { query: OpaClientQuery }): GovernancePolicyEvaluator {
  return opaPolicy(helpers(), {
    id: 'custom-client-policy', effects: ['allow'], client,
    decisionPath: ['simple'], mapInput: () => ({}), resultSchema: z.object({ effect: z.literal('allow') }),
    mapDecision: () => ({ effect: 'allow' }),
  })
}

function simplePolicy(
  api: FakeOpaDataApi,
  overrides: {
    mapInput?: () => JsonValue | undefined
    mapDecision?: () => { effect: 'allow' }
  } = {},
): GovernancePolicyEvaluator {
  return opaPolicy(helpers(), {
    id: 'simple-policy',
    effects: ['allow'],
    client: createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch }),
    decisionPath: ['simple'],
    mapInput: overrides.mapInput ?? (() => ({})),
    resultSchema: z.object({ effect: z.literal('allow') }),
    mapDecision: overrides.mapDecision ?? (() => ({ effect: 'allow' })),
  })
}
