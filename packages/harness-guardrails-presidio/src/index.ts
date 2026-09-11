import type { SensitiveDataDetector, SensitiveDataFinding, SensitiveDataInspectionRequest } from '@purista/harness-guardrails'

/** Content-free categories used when the application-owned Presidio sidecar cannot be used safely. */
export type PresidioSidecarErrorKind = 'aborted' | 'transport' | 'http' | 'malformed_response'

/** An intentionally content-free Presidio sidecar failure. */
export class PresidioSidecarError extends Error {
  public readonly kind: PresidioSidecarErrorKind

  public constructor(kind: PresidioSidecarErrorKind) {
    super('Presidio sensitive-data sidecar request failed.')
    this.name = 'PresidioSidecarError'
    this.kind = kind
  }
}

/** Application-owned Presidio Analyzer sidecar configuration. */
export interface PresidioSidecarOptions {
  /** Stable content-free detector id used in Guardrails telemetry. */
  readonly id: string
  /** Base HTTP(S) URL of an authenticated internal Presidio Analyzer gateway. */
  readonly endpoint: URL | string
  /** Presidio ISO language identifier. Defaults to `en`. */
  readonly language?: string
  /** Static gateway or mTLS-proxy headers supplied by the composition root. */
  readonly headers?: Readonly<Record<string, string>>
  /** Injectable transport for tests. Defaults to the platform fetch implementation. */
  readonly fetch?: typeof globalThis.fetch
}

/** The original Presidio Analyzer endpoint used by this adapter. */
export const PRESIDIO_ANALYZE_PATH = 'analyze'

/**
 * Creates a local-mode detector backed by an application-owned original
 * Presidio Analyzer sidecar. It sends no correlation id or decision process.
 *
 * @example
 * const detector = createPresidioDetector({ id: 'presidio-private', endpoint: 'https://presidio.internal/' })
 */
export function createPresidioDetector(options: PresidioSidecarOptions): SensitiveDataDetector {
  const id = requireId(options.id)
  const endpoint = parseEndpoint(options.endpoint)
  const language = options.language ?? 'en'
  if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]+)?$/.test(language)) throw new TypeError('Presidio language must be an ISO language identifier.')
  const headers = validateHeaders(options.headers)
  const fetchImplementation = options.fetch ?? globalThis.fetch
  if (typeof fetchImplementation !== 'function') throw new TypeError('A fetch implementation is required for the Presidio sidecar adapter.')
  const analyzeUrl = new URL(PRESIDIO_ANALYZE_PATH, endpoint)

  return {
    id,
    executionMode: 'local',
    async inspect(request) {
      return inspect(fetchImplementation, analyzeUrl, language, headers, request)
    }
  }
}

async function inspect(fetchImplementation: typeof globalThis.fetch, url: URL, language: string, headers: Readonly<Record<string, string>>, request: SensitiveDataInspectionRequest): Promise<{ findings: readonly SensitiveDataFinding[] }> {
  let response: Response
  try {
    response = await fetchImplementation(url, {
      method: 'POST',
      redirect: 'error',
      signal: request.signal,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        text: request.text,
        language,
        entities: request.entities,
        score_threshold: request.scoreThreshold,
        return_decision_process: false
      })
    })
  } catch (error) {
    throw new PresidioSidecarError(request.signal.aborted ? 'aborted' : 'transport')
  }
  if (!response.ok) throw new PresidioSidecarError('http')
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new PresidioSidecarError('malformed_response')
  }
  if (!Array.isArray(payload)) throw new PresidioSidecarError('malformed_response')
  try {
    return { findings: payload.map((item) => decodeFinding(item, request.text, request.entities)) }
  } catch {
    throw new PresidioSidecarError('malformed_response')
  }
}

function decodeFinding(value: unknown, text: string, requestedEntities: readonly string[]): SensitiveDataFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid finding')
  const item = value as Record<string, unknown>
  const category = item['entity_type']
  const start = item['start']
  const end = item['end']
  const score = item['score']
  if (typeof category !== 'string' || !requestedEntities.includes(category) || typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > codePointLength(text) || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) throw new TypeError('invalid finding')
  return { category, start: codePointToUtf16(text, start), end: codePointToUtf16(text, end), score }
}

function codePointLength(text: string): number {
  return Array.from(text).length
}

function codePointToUtf16(text: string, boundary: number): number {
  let codePoints = 0
  let utf16 = 0
  for (const character of text) {
    if (codePoints === boundary) return utf16
    codePoints += 1
    utf16 += character.length
  }
  if (codePoints === boundary) return utf16
  throw new TypeError('invalid offset')
}

function parseEndpoint(value: URL | string): URL {
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    throw new TypeError('Presidio endpoint must be an absolute HTTP(S) URL.')
  }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new TypeError('Presidio endpoint must be a credential-free HTTP(S) base URL.')
  }
  if (!endpoint.pathname.endsWith('/')) endpoint.pathname = `${endpoint.pathname}/`
  return endpoint
}

function validateHeaders(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (!value) return {}
  for (const [key, headerValue] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof headerValue !== 'string' || key.toLowerCase() === 'content-type') {
      throw new TypeError('Presidio sidecar headers must be static valid headers and may not override content-type.')
    }
  }
  return { ...value }
}

function requireId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new TypeError('Presidio detector id must be a stable ASCII identifier.')
  return value
}
