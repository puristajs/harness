import type { McpBinding } from '@purista/harness'

export type HttpMcpBinding = Extract<McpBinding, { transport: 'http' }>
export type HttpBindingValidationErrorReason = 'invalid_selection' | 'invalid_http_headers'

const MAX_URL_BYTES = 8_192
const MAX_HEADER_COUNT = 64
const MAX_HEADER_NAME_BYTES = 256
const MAX_HEADER_VALUE_BYTES = 8_192
const MAX_HEADER_AGGREGATE_BYTES = 32_768

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const CONTROL_CHARACTER = /\p{Cc}/u

const FORBIDDEN_HEADERS = new Set([
  'accept',
  'connection',
  'content-length',
  'content-type',
  'host',
  'keep-alive',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const PORTABLE_CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
])

/** Package-private, content-free HTTP selection failure mapped by the public entry point. */
export class HttpBindingValidationError extends Error {
  public readonly reason: HttpBindingValidationErrorReason

  public constructor(reason: HttpBindingValidationErrorReason) {
    super('Agent Plugin HTTP binding is invalid.')
    this.name = 'HttpBindingValidationError'
    this.reason = reason
  }
}

/**
 * Validates and snapshots one portable Streamable HTTP binding.
 *
 * This is an addon-private boundary. The public plugin loader maps its stable
 * reason to `AgentPluginLoadError` without retaining input or an underlying cause.
 */
export function createHttpMcpBinding(
  portableUrl: unknown,
  portableHeaders: unknown,
  callerHeaders: unknown,
  resolveHeaders?: unknown,
): HttpMcpBinding {
  const url = validatePortableUrl(portableUrl)
  const portable = snapshotHeaders(portableHeaders, true)
  const caller = snapshotHeaders(callerHeaders, false)
  const headers = mergeHeaders(portable, caller)
  if (resolveHeaders !== undefined && !isHeaderResolver(resolveHeaders)) return invalid('invalid_selection')

  return Object.freeze({
    transport: 'http',
    url,
    ...(headers === undefined ? {} : { headers }),
    ...(resolveHeaders === undefined ? {} : { resolveHeaders }),
  })
}

function isHeaderResolver(value: unknown): value is NonNullable<HttpMcpBinding['resolveHeaders']> {
  return typeof value === 'function'
}

function validatePortableUrl(value: unknown): string {
  if (typeof value !== 'string' || !isWellFormedUtf16(value) || utf8Bytes(value) > MAX_URL_BYTES) {
    return invalid('invalid_selection')
  }
  // WHATWG URL parsing trims controls, treats backslashes as separators for
  // special schemes, hides empty query/fragment delimiters, and canonicalizes
  // alternative IPv4 spellings. Reject those raw forms before parsing.
  if (value.trim() !== value || CONTROL_CHARACTER.test(value) || value.includes('\\') || value.includes('?') || value.includes('#')) {
    return invalid('invalid_selection')
  }
  const authorityMatch = /^(https?):\/\/([^/?#]*)/i.exec(value)
  if (!authorityMatch || authorityMatch[0].length === value.length && authorityMatch[2] === '') {
    return invalid('invalid_selection')
  }
  const rawAuthority = authorityMatch[2]
  if (rawAuthority === undefined || rawAuthority.length === 0 || rawAuthority.includes('@')) {
    return invalid('invalid_selection')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  }
  catch {
    return invalid('invalid_selection')
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    utf8Bytes(parsed.href) > MAX_URL_BYTES
  ) {
    return invalid('invalid_selection')
  }

  const rawHost = rawHostname(rawAuthority)
  if (rawHost === undefined) return invalid('invalid_selection')
  if (parsed.protocol === 'http:') {
    const normalized = rawHost.toLowerCase()
    if (normalized !== 'localhost' && normalized !== '127.0.0.1' && normalized !== '[::1]') {
      return invalid('invalid_selection')
    }
  }
  return value
}

function rawHostname(authority: string): string | undefined {
  if (authority.startsWith('[')) {
    const closing = authority.indexOf(']')
    if (closing < 0) return undefined
    const host = authority.slice(0, closing + 1)
    const suffix = authority.slice(closing + 1)
    if (suffix !== '' && !/^:\d+$/.test(suffix)) return undefined
    return host
  }
  const colon = authority.lastIndexOf(':')
  if (colon < 0) return authority
  const host = authority.slice(0, colon)
  const port = authority.slice(colon + 1)
  if (host.includes(':') || port === '' || !/^\d+$/.test(port)) return undefined
  return host
}

type HeaderEntry = Readonly<{ name: string; value: string }>

function snapshotHeaders(value: unknown, portable: boolean): readonly HeaderEntry[] {
  if (value === undefined) return Object.freeze([])
  if (!isHeaderRecord(value)) return invalid('invalid_http_headers')

  let keys: readonly PropertyKey[]
  const rawEntries: Array<Readonly<{ name: string; value: unknown }>> = []
  try {
    keys = Reflect.ownKeys(value)
    if (keys.length > MAX_HEADER_COUNT) return invalid('invalid_http_headers')
    for (const key of keys) {
      if (typeof key !== 'string') return invalid('invalid_http_headers')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable) return invalid('invalid_http_headers')
      const entryValue = 'value' in descriptor ? descriptor.value : Reflect.get(value, key)
      rawEntries.push(Object.freeze({ name: key, value: entryValue }))
    }
  }
  catch {
    return invalid('invalid_http_headers')
  }

  const seen = new Set<string>()
  const entries: HeaderEntry[] = []
  let aggregateBytes = 0
  for (const entry of rawEntries) {
    const { name, value: entryValue } = entry
    if (
      !isWellFormedUtf16(name) ||
      !HTTP_TOKEN.test(name) ||
      utf8Bytes(name) > MAX_HEADER_NAME_BYTES ||
      typeof entryValue !== 'string' ||
      !isWellFormedUtf16(entryValue) ||
      CONTROL_CHARACTER.test(entryValue) ||
      utf8Bytes(entryValue) > MAX_HEADER_VALUE_BYTES
    ) {
      return invalid('invalid_http_headers')
    }
    const normalizedName = name.toLowerCase()
    if (
      seen.has(normalizedName) ||
      FORBIDDEN_HEADERS.has(normalizedName) ||
      (portable && PORTABLE_CREDENTIAL_HEADERS.has(normalizedName))
    ) {
      return invalid('invalid_http_headers')
    }
    seen.add(normalizedName)
    aggregateBytes += utf8Bytes(normalizedName) + utf8Bytes(entryValue)
    if (aggregateBytes > MAX_HEADER_AGGREGATE_BYTES) return invalid('invalid_http_headers')
    entries.push(Object.freeze({ name: normalizedName, value: entryValue }))
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
  return Object.freeze(entries)
}

function mergeHeaders(portable: readonly HeaderEntry[], caller: readonly HeaderEntry[]): Readonly<Record<string, string>> | undefined {
  if (portable.length === 0 && caller.length === 0) return undefined
  const merged = new Map(portable.map(entry => [entry.name, entry.value]))
  for (const entry of caller) merged.set(entry.name, entry.value)
  const entries = [...merged.entries()].sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
  let aggregateBytes = 0
  for (const [name, value] of entries) {
    aggregateBytes += utf8Bytes(name) + utf8Bytes(value)
    if (aggregateBytes > MAX_HEADER_AGGREGATE_BYTES) return invalid('invalid_http_headers')
  }
  return Object.freeze(Object.fromEntries(entries))
}

function isHeaderRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  let prototype: object | null
  try { prototype = Object.getPrototypeOf(value) }
  catch { return false }
  return prototype === Object.prototype || prototype === null
}

function isWellFormedUtf16(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function invalid(reason: HttpBindingValidationErrorReason): never {
  throw new HttpBindingValidationError(reason)
}
