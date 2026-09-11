import type { JsonValue } from '@purista/harness'

/** A test-only copy of one outbound OPA Data API request. */
export interface FakeOpaDataApiRequest {
  /** Fully resolved request URL. */
  readonly url: string
  /** Request options supplied by the OPA client. */
  readonly init: RequestInit
}

/** Options for one scripted OPA Data API HTTP response. */
export interface FakeOpaDataApiResponseOptions {
  /** HTTP status returned to the adapter. Defaults to `200`. */
  readonly status?: number
  /** Optional response headers. JSON content type is supplied by default. */
  readonly headers?: Readonly<Record<string, string>>
}

/** Options for a defined or undefined scripted OPA decision envelope. */
export interface FakeOpaDataApiDecisionOptions extends FakeOpaDataApiResponseOptions {
  /** Optional OPA `decision_id`. */
  readonly decisionId?: string
}

type ScriptedResponse =
  | { readonly kind: 'response'; readonly body: unknown; readonly options: FakeOpaDataApiResponseOptions }
  | { readonly kind: 'error'; readonly error: Error }

/**
 * Strict deterministic fake for the supported OPA Data API envelope.
 *
 * It does not evaluate Rego. Queue every expected response and call
 * `assertExhausted()` after the interaction.
 */
export class FakeOpaDataApi {
  /** Test-only request recorder. Never attach these values to logs or telemetry. */
  public readonly requests: FakeOpaDataApiRequest[] = []
  private readonly responses: ScriptedResponse[] = []

  /** Injected `fetch` implementation passed to `createOpaClient`. */
  public readonly fetch: typeof globalThis.fetch = async (input, init) => {
    this.requests.push({ url: requestUrl(input), init: cloneRequestInit(init) })
    const next = this.responses.shift()
    if (!next) throw new Error('FakeOpaDataApi received an unqueued request.')
    if (next.kind === 'error') throw next.error
    const headers = new Headers(next.options.headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(next.body), {
      status: next.options.status ?? 200,
      headers,
    })
  }

  /** Queues a defined OPA `result`. */
  public enqueueDecision(result: JsonValue, options: FakeOpaDataApiDecisionOptions = {}): void {
    const { decisionId, ...responseOptions } = options
    this.responses.push({
      kind: 'response',
      body: { result, ...(decisionId === undefined ? {} : { decision_id: decisionId }) },
      options: responseOptions,
    })
  }

  /** Queues OPA's successful undefined-document envelope with no `result`. */
  public enqueueUndefinedDecision(options: FakeOpaDataApiDecisionOptions = {}): void {
    const { decisionId, ...responseOptions } = options
    this.responses.push({
      kind: 'response',
      body: decisionId === undefined ? {} : { decision_id: decisionId },
      options: responseOptions,
    })
  }

  /** Queues an exact JSON response for malformed and HTTP-error tests. */
  public enqueueResponse(body: unknown, options: FakeOpaDataApiResponseOptions = {}): void {
    this.responses.push({ kind: 'response', body, options })
  }

  /** Queues one transport failure. */
  public enqueueTransportError(error: Error = new TypeError('Fake OPA transport failure.')): void {
    this.responses.push({ kind: 'error', error })
  }

  /** Fails when a scripted response was not consumed. */
  public assertExhausted(): void {
    if (this.responses.length > 0) {
      throw new Error(`FakeOpaDataApi has ${this.responses.length} unused scripted response(s).`)
    }
  }

  /** Clears request recordings and scripted responses. */
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
    ...(init.headers ? { headers: Object.fromEntries(new Headers(init.headers)) } : {}),
  }
}
