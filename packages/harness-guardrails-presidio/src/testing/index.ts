/** A test-only copy of one outbound Presidio Analyzer request. */
export interface FakePresidioSidecarRequest {
  /** Fully resolved request URL. */
  readonly url: string
  /** Request options supplied by the Presidio adapter. */
  readonly init: RequestInit
}

/** Options for one scripted Presidio Analyzer HTTP response. */
export interface FakePresidioSidecarResponseOptions {
  /** HTTP status returned to the adapter. Defaults to `200`. */
  readonly status?: number
  /** Optional response headers. JSON content type is supplied by default. */
  readonly headers?: Readonly<Record<string, string>>
}

type ScriptedResponse =
  | { readonly kind: 'response'; readonly body: unknown; readonly options: FakePresidioSidecarResponseOptions }
  | { readonly kind: 'error'; readonly error: Error }

/**
 * Deterministic test-only `fetch` implementation for Presidio Analyzer's
 * supported `POST /analyze` protocol. It does not implement recognizers or
 * NLP; enqueue exact HTTP outcomes instead.
 *
 * @example
 * const sidecar = new FakePresidioSidecar()
 * sidecar.enqueueAnalyzeResponse([])
 * const detector = createPresidioDetector({ id: 'test', endpoint: 'https://presidio.test/', fetch: sidecar.fetch })
 */
export class FakePresidioSidecar {
  /** Test-only outbound request recorder. Do not attach its values to telemetry or logs. */
  public readonly requests: FakePresidioSidecarRequest[] = []
  private readonly responses: ScriptedResponse[] = []

  /**
   * The injected `fetch` function passed to `createPresidioDetector`.
   * An empty queue returns a successful empty Analyzer result.
   */
  public readonly fetch: typeof globalThis.fetch = async (input, init) => {
    this.requests.push({ url: requestUrl(input), init: cloneRequestInit(init) })
    const next = this.responses.shift()
    if (next?.kind === 'error') throw next.error
    const response = next ?? { kind: 'response' as const, body: [], options: {} }
    const headers = new Headers(response.options.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(response.body), { status: response.options.status ?? 200, headers })
  }

  /** Queues one JSON response in Presidio Analyzer's wire shape. */
  public enqueueAnalyzeResponse(body: unknown, options: FakePresidioSidecarResponseOptions = {}): void {
    this.responses.push({ kind: 'response', body, options })
  }

  /** Queues an intentional transport failure for the next adapter request. */
  public enqueueTransportError(error: Error = new TypeError('Fake Presidio sidecar transport failure.')): void {
    this.responses.push({ kind: 'error', error })
  }

  /** Clears recorded requests and scripted outcomes between test cases. */
  public reset(): void {
    this.requests.length = 0
    this.responses.length = 0
  }
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  return input instanceof Request ? input.url : String(input)
}

function cloneRequestInit(init: RequestInit | undefined): RequestInit {
  if (!init) return {}
  return {
    ...init,
    ...(init.headers ? { headers: Object.fromEntries(new Headers(init.headers)) } : {})
  }
}
