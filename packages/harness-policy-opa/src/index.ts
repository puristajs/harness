import {
  isJsonValue,
  OperationCancelledError,
  OperationTimeoutError,
  runDecisionOperation,
  type BuilderState,
  type GovernanceContext,
  type GovernanceDecision,
  type GovernancePolicyEvaluator,
  type HarnessAdapterContext,
  type Infer,
  type JsonValue,
  type Schema,
} from '@purista/harness'

/** Stable prefix for Open Policy Agent Data API decision queries. */
export const OPA_DATA_API_PREFIX = 'v1/data' as const

/** Default maximum decoded OPA response body size: 256 KiB. */
export const OPA_DEFAULT_MAX_RESPONSE_BYTES = 262_144 as const

/** Default standalone OPA request deadline in milliseconds. */
export const OPA_DEFAULT_TIMEOUT_MS = 10_000 as const

const OPA_MAX_RESPONSE_BYTES = 4_194_304
const OPA_MAX_PATH_SEGMENT_LENGTH = 256
const RESERVED_HEADERS = new Set(['connection', 'content-length', 'content-type', 'host', 'transfer-encoding', 'traceparent', 'tracestate'])

/** A non-empty sequence of OPA Data API document path segments. */
export type OpaDecisionPath = readonly [string, ...string[]]

/** Cancellation and absolute deadline inherited from a Harness decision callback. */
export interface OpaDecisionExecution {
  /** Parent cancellation signal. */
  readonly signal: AbortSignal
  /** Absolute Unix epoch deadline in milliseconds. */
  readonly deadline: number
}

/** Configuration for a reusable OPA Data API client. */
export interface OpaClientOptions {
  /** Fixed credential-free HTTP(S) base URL for the trusted OPA deployment. */
  readonly baseUrl: URL | string
  /** Static application-owned authorization or proxy headers. */
  readonly headers?: Readonly<Record<string, string>>
  /** Injectable transport for deterministic tests. Defaults to platform `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Maximum successful response body size. Defaults to 256 KiB; maximum 4 MiB. */
  readonly maxResponseBytes?: number
  /** Standalone request deadline and upper bound for inherited deadlines. Defaults to 10 seconds. */
  readonly timeoutMs?: number
}

/** Normalized OPA Data API query result, including OPA's undefined-document case. */
export type OpaQueryResult =
  | Readonly<{ defined: false; decisionId?: string }>
  | Readonly<{ defined: true; result: JsonValue; decisionId?: string }>

/** Reusable, topology-neutral OPA Data API client. */
export interface OpaClient {
  /** Receives the Harness telemetry context when this client is used by `opaPolicy`. */
  configureHarnessContext(context: HarnessAdapterContext): void
  /** Queries one OPA data document with a JSON input envelope. */
  query(path: OpaDecisionPath, input: JsonValue, execution?: OpaDecisionExecution): Promise<OpaQueryResult>
}

/** Content-free categories for OPA transport and response failures. */
export type OpaClientErrorKind =
  | 'aborted'
  | 'deadline_exceeded'
  | 'transport'
  | 'http'
  | 'invalid_content_type'
  | 'response_too_large'
  | 'malformed_response'

/** A content-free OPA transport or response failure. */
export class OpaClientError extends Error {
  public readonly kind: OpaClientErrorKind
  /** HTTP status is present only for a non-success response. */
  public readonly status?: number

  public constructor(kind: OpaClientErrorKind, status?: number) {
    super('Open Policy Agent request failed.')
    this.name = 'OpaClientError'
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

/** Content-free categories for application-owned OPA policy mapping failures. */
export type OpaPolicyErrorKind =
  | 'input_mapping'
  | 'non_json_input'
  | 'result_validation'
  | 'decision_mapping'

/** A content-free OPA governance mapping or validation failure. */
export class OpaPolicyError extends Error {
  public readonly kind: OpaPolicyErrorKind

  public constructor(kind: OpaPolicyErrorKind) {
    super('Open Policy Agent policy mapping failed.')
    this.name = 'OpaPolicyError'
    this.kind = kind
  }
}

/** The inference-preserving subset of Harness governance definition helpers. */
export interface OpaPolicyRegistrar<S extends BuilderState> {
  adapter<const P extends GovernancePolicyEvaluator<S>>(definition: P): P
}

/** Compile-time JSON compatibility predicate used by {@link OpaJsonResultSchema}. */
export type OpaJsonCompatible<T> = T extends undefined
  ? false
  : T extends (...args: any[]) => unknown
    ? false
  : T extends JsonValue
    ? true
    : T extends readonly (infer Item)[]
      ? OpaJsonCompatible<Item>
      : T extends object
        ? false extends {
            [Key in keyof T]-?: OpaJsonCompatible<Exclude<T[Key], undefined>>
          }[keyof T]
          ? false
          : true
        : false

/** A Standard Schema whose known validated output is JSON-compatible. */
export type OpaJsonResultSchema<ResultSchema extends Schema<any, any>> = false extends OpaJsonCompatible<Infer<ResultSchema>>
  ? never
  : ResultSchema

/** Options for adapting one OPA decision document into Harness governance. */
export interface OpaPolicyOptions<
  S extends BuilderState,
  ResultSchema extends Schema<any, any>,
> {
  /** Stable Harness policy id. */
  readonly id: string
  /** Optional deployed policy or bundle version recorded in Harness evidence. */
  readonly version?: string
  /** Reusable OPA Data API client. */
  readonly client: OpaClient
  /** OPA data document path below `/v1/data`. */
  readonly decisionPath: OpaDecisionPath
  /** Explicit least-data mapping. Return `undefined` when this policy does not apply. */
  readonly mapInput: (
    context: GovernanceContext<S>,
  ) => JsonValue | undefined | Promise<JsonValue | undefined>
  /** Standard Schema validator for the selected OPA document's `result`. */
  readonly resultSchema: OpaJsonResultSchema<ResultSchema>
  /** Maps validated policy output to the closed Harness governance decision. */
  readonly mapDecision: (
    result: Infer<ResultSchema>,
    context: GovernanceContext<S>,
  ) =>
    | GovernanceDecision
    | readonly GovernanceDecision[]
    | undefined
    | Promise<GovernanceDecision | readonly GovernanceDecision[] | undefined>
}

/**
 * Creates a bounded Open Policy Agent Data API client.
 *
 * The client performs no retries and follows no redirects. Keep `baseUrl`
 * fixed at the application composition root; never derive it from model or
 * tool input.
 *
 * @example
 * ```ts
 * const client = createOpaClient({
 *   baseUrl: 'http://opa.default.svc.cluster.local:8181',
 *   headers: { authorization: `Bearer ${process.env.OPA_TOKEN}` },
 * })
 * ```
 */
export function createOpaClient(options: OpaClientOptions): OpaClient {
  const baseUrl = parseBaseUrl(options.baseUrl)
  const headers = validateHeaders(options.headers)
  const fetchImplementation = options.fetch ?? globalThis.fetch
  if (typeof fetchImplementation !== 'function') {
    throw new TypeError('A fetch implementation is required for the OPA client.')
  }
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? OPA_DEFAULT_MAX_RESPONSE_BYTES,
    'OPA maxResponseBytes',
  )
  if (maxResponseBytes > OPA_MAX_RESPONSE_BYTES) {
    throw new TypeError('OPA maxResponseBytes may not exceed 4 MiB.')
  }
  const timeoutMs = positiveInteger(options.timeoutMs ?? OPA_DEFAULT_TIMEOUT_MS, 'OPA timeoutMs')

  let telemetry: HarnessAdapterContext['telemetry'] | undefined
  return Object.freeze({
    configureHarnessContext(context: HarnessAdapterContext): void {
      telemetry ??= context.telemetry
    },
    async query(
      path: OpaDecisionPath,
      input: JsonValue,
      execution?: OpaDecisionExecution,
    ): Promise<OpaQueryResult> {
      const requestUrl = decisionUrl(baseUrl, path)
      if (!isJsonValue(input)) throw new TypeError('OPA input must be JSON-compatible.')
      const parentSignal = execution?.signal ?? new AbortController().signal
      if (!(parentSignal instanceof AbortSignal)) {
        throw new TypeError('OPA execution signal must be an AbortSignal.')
      }
      const ownDeadline = Date.now() + timeoutMs
      const inheritedDeadline = execution?.deadline ?? ownDeadline
      if (!Number.isFinite(inheritedDeadline)) {
        throw new TypeError('OPA execution deadline must be finite.')
      }
      const deadline = Math.min(ownDeadline, inheritedDeadline)
      const traceparent = telemetry?.currentTraceparent()

      try {
        return await runDecisionOperation({ signal: parentSignal, deadline }, async (signal) => {
          let response: Response
          try {
            response = await fetchImplementation(requestUrl, {
              method: 'POST',
              redirect: 'error',
              signal,
              headers: {
                ...headers,
                'content-type': 'application/json',
                ...(traceparent ? { traceparent } : {}),
              },
              body: JSON.stringify({ input }),
            })
          } catch {
            signal.throwIfAborted()
            throw new OpaClientError('transport')
          }
          if (!response.ok) throw new OpaClientError('http', response.status)
          if (!isJsonMediaType(response.headers.get('content-type'))) {
            throw new OpaClientError('invalid_content_type')
          }
          const payload = await readBoundedJson(response, maxResponseBytes, signal)
          return decodeEnvelope(payload)
        })
      } catch (error) {
        if (error instanceof OpaClientError) throw error
        if (error instanceof OperationCancelledError || parentSignal.aborted) {
          throw new OpaClientError('aborted')
        }
        if (error instanceof OperationTimeoutError) throw new OpaClientError('deadline_exceeded')
        throw new OpaClientError('transport')
      }
    },
  } satisfies OpaClient)
}

/**
 * Creates and registers a typed OPA-backed governance policy.
 *
 * Passing the `helpers` object from `.governance(...)` preserves the complete
 * builder-derived tool-id/input union in both mapping callbacks.
 *
 * @example
 * ```ts
 * .governance((helpers) => ({
 *   defaultEffect: 'deny',
 *   policies: [opaPolicy(helpers, {
 *     id: 'transfer-policy',
 *     client,
 *     decisionPath: ['bank', 'transfer'],
 *     mapInput: (ctx) => ctx.toolId === 'transfer_funds'
 *       ? { amount: ctx.input.amount }
 *       : undefined,
 *     resultSchema: z.object({ effect: z.enum(['allow', 'deny']) }),
 *     mapDecision: (result) => ({ effect: result.effect }),
 *   })],
 * }))
 * ```
 */
export function opaPolicy<
  S extends BuilderState,
  const ResultSchema extends Schema<any, any>,
>(
  registrar: OpaPolicyRegistrar<S>,
  options: OpaPolicyOptions<S, ResultSchema>,
): GovernancePolicyEvaluator<S> {
  const id = stableIdentifier(options.id, 'OPA policy id')
  const version = options.version === undefined
    ? undefined
    : stableIdentifier(options.version, 'OPA policy version')
  validateDecisionPath(options.decisionPath)
  if (!options.client || typeof options.client.query !== 'function') {
    throw new TypeError('OPA policy client must implement query().')
  }
  if (typeof options.mapInput !== 'function' || typeof options.mapDecision !== 'function') {
    throw new TypeError('OPA policy mapping callbacks must be functions.')
  }
  if (!isSchema(options.resultSchema)) {
    throw new TypeError('OPA resultSchema must implement Standard Schema V1.')
  }

  return registrar.adapter({
    id,
    ...(version ? { version } : {}),
    engine: 'opa',
    configureHarnessContext(context) {
      options.client.configureHarnessContext(context)
    },
    async evaluate(context) {
      let input: JsonValue | undefined
      try {
        input = await options.mapInput(context)
      } catch (error) {
        rethrowKnown(error)
        throw new OpaPolicyError('input_mapping')
      }
      if (input === undefined) return undefined
      if (!isJsonValue(input)) throw new OpaPolicyError('non_json_input')

      const response = await options.client.query(options.decisionPath, input, {
        signal: context.signal,
        deadline: context.deadline,
      })
      if (!response.defined) return undefined
      const result = await validateResult(options.resultSchema, response.result)

      try {
        return await options.mapDecision(result, context)
      } catch (error) {
        rethrowKnown(error)
        throw new OpaPolicyError('decision_mapping')
      }
    },
  })
}

function parseBaseUrl(value: URL | string): URL {
  let baseUrl: URL
  try {
    baseUrl = new URL(value)
  } catch {
    throw new TypeError('OPA baseUrl must be an absolute HTTP(S) URL.')
  }
  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:')
    || baseUrl.username
    || baseUrl.password
    || baseUrl.search
    || baseUrl.hash
  ) {
    throw new TypeError('OPA baseUrl must be a credential-free HTTP(S) base URL.')
  }
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname = `${baseUrl.pathname}/`
  return baseUrl
}

function validateHeaders(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
  if (!value) return Object.freeze({})
  const result: Record<string, string> = {}
  for (const [key, headerValue] of Object.entries(value)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)
      || typeof headerValue !== 'string'
      || /[\r\n]/.test(headerValue)
      || RESERVED_HEADERS.has(key.toLowerCase())
    ) {
      throw new TypeError('OPA headers must be static valid headers and may not override transport headers.')
    }
    result[key] = headerValue
  }
  return Object.freeze(result)
}

function decisionUrl(baseUrl: URL, path: OpaDecisionPath): URL {
  validateDecisionPath(path)
  return new URL(`${OPA_DATA_API_PREFIX}/${path.map((segment) => encodeURIComponent(segment)).join('/')}`, baseUrl)
}

function validateDecisionPath(path: OpaDecisionPath): void {
  if (!Array.isArray(path) || path.length === 0) {
    throw new TypeError('OPA decisionPath must contain at least one path segment.')
  }
  for (const segment of path) {
    if (
      typeof segment !== 'string'
      || segment.length === 0
      || segment.length > OPA_MAX_PATH_SEGMENT_LENGTH
      || segment === '.'
      || segment === '..'
      || /[\\/\u0000-\u001F\u007F]/.test(segment)
    ) {
      throw new TypeError('OPA decisionPath contains an invalid path segment.')
    }
  }
}

function isJsonMediaType(value: string | null): boolean {
  if (value === null) return false
  const mediaType = value.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'))
}

async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new OpaClientError('response_too_large')
  }
  if (!response.body) throw new OpaClientError('malformed_response')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new OpaClientError('response_too_large')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } catch (error) {
    if (error instanceof OpaClientError) throw error
    signal.throwIfAborted()
    throw new OpaClientError('transport')
  } finally {
    reader.releaseLock()
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new OpaClientError('malformed_response')
  }
}

function decodeEnvelope(payload: unknown): OpaQueryResult {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new OpaClientError('malformed_response')
  }
  const envelope = payload as Record<string, unknown>
  const decisionId = envelope['decision_id']
  if (decisionId !== undefined && (typeof decisionId !== 'string' || decisionId.length === 0)) {
    throw new OpaClientError('malformed_response')
  }
  const identity = decisionId === undefined ? {} : { decisionId }
  if (!Object.hasOwn(envelope, 'result')) return { defined: false, ...identity }
  const result = envelope['result']
  if (!isJsonValue(result)) throw new OpaClientError('malformed_response')
  return { defined: true, result, ...identity }
}

async function validateResult<ResultSchema extends Schema<any, any>>(
  schema: ResultSchema,
  candidate: JsonValue,
): Promise<Infer<ResultSchema>> {
  let result: unknown
  try {
    result = await schema['~standard'].validate(candidate)
  } catch {
    throw new OpaPolicyError('result_validation')
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new OpaPolicyError('result_validation')
  }
  const validation = result as Record<string, unknown>
  if ('issues' in validation) {
    if (!Array.isArray(validation['issues']) || validation['issues'].length > 0) {
      throw new OpaPolicyError('result_validation')
    }
  }
  if (!Object.hasOwn(validation, 'value') || !isJsonValue(validation['value'])) {
    throw new OpaPolicyError('result_validation')
  }
  return validation['value'] as Infer<ResultSchema>
}

function isSchema(value: unknown): value is Schema<any, any> {
  return value !== null
    && typeof value === 'object'
    && '~standard' in value
    && typeof (value as Schema<any, any>)['~standard']?.validate === 'function'
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer.`)
  return value
}

function stableIdentifier(value: string, name: string): string {
  if (typeof value !== 'string' || Array.from(value).length < 1 || Array.from(value).length > 128 || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty identifier without control characters.`)
  }
  return value
}

function rethrowKnown(error: unknown): void {
  if (error instanceof OpaClientError || error instanceof OpaPolicyError) throw error
}
