import { describe, expect, expectTypeOf, it } from 'vitest'
import type { McpBinding } from '@purista/harness'
import {
  HttpBindingValidationError,
  createHttpMcpBinding,
  type HttpMcpBinding,
} from '../src/http.js'

function capturedFailure(action: () => unknown): HttpBindingValidationError {
  let error: unknown
  try { action() }
  catch (failure) { error = failure }
  expect(error).toBeInstanceOf(HttpBindingValidationError)
  return error as HttpBindingValidationError
}

function expectFailure(
  action: () => unknown,
  reason: 'invalid_selection' | 'invalid_http_headers',
): void {
  const error = capturedFailure(action)
  expect(error).toEqual(expect.objectContaining({
    name: 'HttpBindingValidationError',
    message: 'Agent Plugin HTTP binding is invalid.',
    reason,
  }))
  expect(Object.keys(error).sort()).toEqual(['name', 'reason'])
}

function sizedUrl(bytes: number, character = 'a'): string {
  const prefix = 'https://example.test/'
  const remaining = bytes - Buffer.byteLength(prefix)
  const characterBytes = Buffer.byteLength(character)
  if (remaining < 0 || remaining % characterBytes !== 0) throw new Error('Invalid test URL byte size.')
  return prefix + character.repeat(remaining / characterBytes)
}

function aggregateHeaders(lastValueBytes = 8_190): Record<string, string> {
  return {
    x0: 'a'.repeat(8_190),
    x1: 'b'.repeat(8_190),
    x2: 'c'.repeat(8_190),
    x3: 'd'.repeat(lastValueBytes),
  }
}

describe('createHttpMcpBinding', () => {
  it('returns the exact frozen Core HTTP binding and omits empty headers', () => {
    const binding = createHttpMcpBinding('https://example.test/mcp', undefined, {})

    expect(binding).toEqual({ transport: 'http', url: 'https://example.test/mcp' })
    expect(Object.keys(binding)).toEqual(['transport', 'url'])
    expect(Object.isFrozen(binding)).toBe(true)
    expectTypeOf(binding).toEqualTypeOf<HttpMcpBinding>()
    expectTypeOf(binding).toEqualTypeOf<Extract<McpBinding, { transport: 'http' }>>()
  })

  it.each([
    'https://example.test/mcp',
    'https://example.test:8443/mcp',
    'http://localhost/mcp',
    'http://localhost:3000/mcp',
    'http://127.0.0.1/mcp',
    'http://127.0.0.1:3000/mcp',
    'http://[::1]/mcp',
    'http://[::1]:3000/mcp',
  ])('accepts an allowed absolute URL without canonicalizing %s', (url) => {
    expect(createHttpMcpBinding(url, undefined, undefined).url).toBe(url)
  })

  it.each([
    undefined,
    null,
    1,
    '',
    'example.test/mcp',
    'ftp://example.test/mcp',
    'http://example.test/mcp',
    'http://localhost.example.test/mcp',
    'http://localhost./mcp',
    'http://127.1/mcp',
    'http://2130706433/mcp',
    'http://0177.0.0.1/mcp',
    'http://0x7f000001/mcp',
    'http://[::ffff:127.0.0.1]/mcp',
    'http://[::1%25lo0]/mcp',
    'http://user@localhost/mcp',
    'http://@localhost/mcp',
    'http://localhost:/mcp',
    'https://user:secret@example.test/mcp',
    'https://example.test/mcp?query=value',
    'https://example.test/mcp?',
    'https://example.test/mcp#fragment',
    'https://example.test/mcp#',
    ' https://example.test/mcp',
    'https://example.test/mcp ',
    'https://example.test\\mcp',
    'https:\\example.test\\mcp',
    'https://example.test/\nprivate',
    `https://example.test/\uD800`,
  ])('rejects invalid raw or insecure URL %#', (url) => {
    expectFailure(() => createHttpMcpBinding(url, undefined, undefined), 'invalid_selection')
  })

  it('enforces inclusive URL UTF-8 byte limits, including multibyte paths', () => {
    const exactAscii = sizedUrl(8_192)
    const prefix = 'https://example.test/'
    const encodedRemainder = 8_192 - Buffer.byteLength(prefix)
    const exactMultibyte = `${prefix}${'a'.repeat(encodedRemainder % 6)}${'é'.repeat(Math.floor(encodedRemainder / 6))}`
    expect(Buffer.byteLength(new URL(exactMultibyte).href)).toBe(8_192)

    expect(createHttpMcpBinding(exactAscii, undefined, undefined).url).toBe(exactAscii)
    expect(createHttpMcpBinding(exactMultibyte, undefined, undefined).url).toBe(exactMultibyte)
    expectFailure(() => createHttpMcpBinding(`${exactAscii}a`, undefined, undefined), 'invalid_selection')
    expectFailure(() => createHttpMcpBinding(`${exactMultibyte}é`, undefined, undefined), 'invalid_selection')
  })

  it('normalizes, byte-sorts, freezes, and merges headers with caller override precedence', () => {
    const portable = { Zed: 'last', 'X-Tenant': 'portable', Alpha: 'first' }
    const caller = { Authorization: 'Bearer caller-secret', 'x-tenant': 'caller', Cookie: 'session=caller' }
    const binding = createHttpMcpBinding('https://example.test/mcp', portable, caller)

    expect(binding.headers).toEqual({
      alpha: 'first',
      authorization: 'Bearer caller-secret',
      cookie: 'session=caller',
      'x-tenant': 'caller',
      zed: 'last',
    })
    expect(Object.keys(binding.headers ?? {})).toEqual(['alpha', 'authorization', 'cookie', 'x-tenant', 'zed'])
    expect(Object.isFrozen(binding.headers)).toBe(true)
    expect(Object.isFrozen(binding)).toBe(true)
    portable.Alpha = 'changed'
    caller.Authorization = 'changed'
    expect(binding.headers?.['alpha']).toBe('first')
    expect(binding.headers?.['authorization']).toBe('Bearer caller-secret')
  })

  it('accepts null-prototype records and exactly 64 headers', () => {
    const portable = Object.create(null) as Record<string, string>
    for (let index = 0; index < 64; index += 1) portable[`x-${String(index).padStart(2, '0')}`] = ''

    const binding = createHttpMcpBinding('https://example.test/mcp', portable, Object.create(null))
    expect(Object.keys(binding.headers ?? {})).toHaveLength(64)
  })

  it('enforces inclusive header name, value, and source aggregate byte limits', () => {
    const name256 = 'a'.repeat(256)
    const value8192 = 'a'.repeat(8_192)
    const multibyte8192 = 'é'.repeat(4_096)

    expect(createHttpMcpBinding('https://example.test/mcp', { [name256]: '' }, undefined).headers?.[name256]).toBe('')
    expect(createHttpMcpBinding('https://example.test/mcp', { x: value8192 }, undefined).headers?.['x']).toBe(value8192)
    expect(createHttpMcpBinding('https://example.test/mcp', { x: multibyte8192 }, undefined).headers?.['x']).toBe(multibyte8192)
    expect(Object.keys(createHttpMcpBinding('https://example.test/mcp', aggregateHeaders(), undefined).headers ?? {})).toHaveLength(4)

    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', { [`${name256}a`]: '' }, undefined), 'invalid_http_headers')
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', { x: `${value8192}a` }, undefined), 'invalid_http_headers')
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', { x: `${multibyte8192}a` }, undefined), 'invalid_http_headers')
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', aggregateHeaders(8_191), undefined), 'invalid_http_headers')
  })

  it('enforces the merged aggregate after independently valid sources', () => {
    const portable = { x0: 'a'.repeat(8_190), x1: 'b'.repeat(8_190) }
    const callerExact = { x2: 'c'.repeat(8_190), x3: 'd'.repeat(8_190) }
    const callerTooLarge = { x2: 'c'.repeat(8_190), x3: 'd'.repeat(8_191) }

    expect(Object.keys(createHttpMcpBinding('https://example.test/mcp', portable, callerExact).headers ?? {})).toHaveLength(4)
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', portable, callerTooLarge), 'invalid_http_headers')
  })

  it('rejects more than 64 headers and case-insensitive duplicates within either source', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`x-${index}`, '']))

    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', tooMany, undefined), 'invalid_http_headers')
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', { Flag: 'one', flag: 'two' }, undefined), 'invalid_http_headers')
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', undefined, { Flag: 'one', flag: 'two' }), 'invalid_http_headers')
  })

  it.each([
    'accept',
    'content-type',
    'content-length',
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'set-cookie',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'mcp-protocol-version',
    'mcp-session-id',
    'last-event-id',
  ])('rejects the HTTP-stack-owned header %s from both sources', (name) => {
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', { [name]: 'value' }, undefined), 'invalid_http_headers')
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', undefined, { [name.toUpperCase()]: 'value' }), 'invalid_http_headers')
  })

  it.each(['authorization', 'cookie', 'x-api-key'])('rejects portable credential header %s but accepts it from the caller', (name) => {
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', { [name]: 'private' }, undefined), 'invalid_http_headers')
    expect(createHttpMcpBinding('https://example.test/mcp', undefined, { [name]: 'caller' }).headers?.[name]).toBe('caller')
  })

  it.each([
    ['', 'value'],
    ['bad name', 'value'],
    ['bad:name', 'value'],
    ['x-control', 'line\nvalue'],
    ['x-tab', 'tab\tvalue'],
    ['x-del', `value\u007f`],
    ['x-c1', `value\u0085`],
    ['x-surrogate', `value\uD800`],
  ])('rejects malformed header %s', (name, value) => {
    expectFailure(() => createHttpMcpBinding('https://example.test/mcp', { [name]: value }, undefined), 'invalid_http_headers')
  })

  it('rejects non-string values and non-record, inherited, symbol, or hidden inputs', () => {
    const inherited = Object.create({ 'x-inherited': 'value' }) as Record<string, string>
    const symbolic = { x: 'value', [Symbol('private')]: 'hidden' }
    const hidden = Object.defineProperty({}, 'x-hidden', { enumerable: false, value: 'value' })
    const custom = new (class Headers { public x = 'value' })()

    for (const value of [null, [], 'x', { x: 1 }, inherited, symbolic, hidden, custom]) {
      expectFailure(() => createHttpMcpBinding('https://example.test/mcp', value, undefined), 'invalid_http_headers')
    }
  })

  it('snapshots every header value once and returns the validated snapshot', () => {
    let reads = 0
    const headers = Object.defineProperty({}, 'X-Changing', {
      enumerable: true,
      get() { reads += 1; return reads === 1 ? 'validated' : 'changed' },
    })

    const binding = createHttpMcpBinding('https://example.test/mcp', headers, undefined)
    expect(binding.headers).toEqual({ 'x-changing': 'validated' })
    expect(reads).toBe(1)
  })

  it('normalizes getter and proxy failures without retaining private content', () => {
    const getter = Object.defineProperty({}, 'X-Private', {
      enumerable: true,
      get() { throw new Error('private getter value') },
    })
    const proxy = new Proxy({}, {
      ownKeys() { throw new Error('private proxy value') },
    })

    for (const value of [getter, proxy]) {
      const error = capturedFailure(() => createHttpMcpBinding('https://example.test/mcp', value, undefined))
      expect(error.reason).toBe('invalid_http_headers')
      expect(JSON.stringify(error)).not.toContain('private')
      expect(error.cause).toBeUndefined()
    }
  })

  it('classifies URL failures separately from header failures', () => {
    expect(capturedFailure(() => createHttpMcpBinding('http://example.test', undefined, undefined)).reason).toBe('invalid_selection')
    expect(capturedFailure(() => createHttpMcpBinding('https://example.test', { Accept: 'value' }, undefined)).reason).toBe('invalid_http_headers')
  })
})
