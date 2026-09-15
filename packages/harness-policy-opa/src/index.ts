import {
	isJsonValue,
	HarnessConfigError,
	normalizeHarnessTraceContext,
	OperationCancelledError,
	OperationTimeoutError,
	runDecisionOperation,
	type GovernanceContext,
	type GovernanceDecision,
	type GovernanceDefinitionHelpers,
	type GovernanceEffect,
	type GovernancePolicyEvaluator,
	type GovernanceToolMap,
	type Infer,
	type JsonValue,
	type Schema,
} from '@purista/harness'

/** Stable prefix for Open Policy Agent Data API decision queries. */
export const OPA_DATA_API_PREFIX = 'v1/data' as const
/** Default maximum serialized OPA request size: 1 MiB. */
export const OPA_DEFAULT_MAX_REQUEST_BYTES = 1_048_576 as const
/** Default maximum decoded OPA response body size: 256 KiB. */
export const OPA_DEFAULT_MAX_RESPONSE_BYTES = 262_144 as const
/** Default standalone OPA request deadline in milliseconds. */
export const OPA_DEFAULT_TIMEOUT_MS = 10_000 as const
/** Hard maximum serialized OPA request size: 16 MiB. */
export const OPA_MAX_REQUEST_BYTES = 16_777_216 as const
/** Hard maximum decoded OPA response body size: 4 MiB. */
export const OPA_MAX_RESPONSE_BYTES = 4_194_304 as const

const MAX_URL_BYTES = 8_192
const MAX_PATH_SEGMENTS = 64
const MAX_PATH_SEGMENT_BYTES = 256
const MAX_HEADERS = 64
const MAX_HEADER_NAME_BYTES = 256
const MAX_HEADER_VALUE_BYTES = 8_192
const MAX_HEADERS_BYTES = 32_768
const MAX_TIMEOUT_MS = 2_147_483_647
const textEncoder = new TextEncoder()
const RESERVED_HEADERS = new Set([
	'connection', 'content-length', 'content-type', 'host', 'keep-alive', 'proxy-authenticate',
	'proxy-authorization', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade',
	'traceparent', 'tracestate',
])
const CLIENT_OPTION_KEYS = new Set(['baseUrl', 'headers', 'fetch', 'maxRequestBytes', 'maxResponseBytes', 'timeoutMs'])
const EXECUTION_KEYS = new Set(['signal', 'deadline', 'traceparent'])
const POLICY_OPTION_KEYS = new Set(['id', 'version', 'effects', 'client', 'decisionPath', 'mapInput', 'resultSchema', 'mapDecision'])
const GOVERNANCE_EFFECTS = new Set<GovernanceEffect>(['allow', 'deny', 'require_approval', 'audit'])

/** A non-empty sequence of OPA Data API document path segments. */
export type OpaDecisionPath = readonly [string, ...string[]]

/** Cancellation, deadline, and trace context inherited from one decision callback. */
export interface OpaDecisionExecution {
	readonly signal: AbortSignal
	readonly deadline: number
	readonly traceparent?: string
}

/** Configuration for a reusable OPA Data API client. */
export interface OpaClientOptions {
	readonly baseUrl: URL | string
	readonly headers?: Readonly<Record<string, string>>
	readonly fetch?: typeof globalThis.fetch
	readonly maxRequestBytes?: number
	readonly maxResponseBytes?: number
	readonly timeoutMs?: number
}

/** Normalized OPA Data API query result, including OPA's undefined-document case. */
export type OpaQueryResult =
	| Readonly<{ defined: false; decisionId?: string }>
	| Readonly<{ defined: true; result: JsonValue; decisionId?: string }>

/** Reusable, immutable OPA Data API client. */
export interface OpaClient {
	query(path: OpaDecisionPath, input: JsonValue, execution?: OpaDecisionExecution): Promise<OpaQueryResult>
}

/** Content-free categories for OPA transport and response failures. */
export type OpaClientErrorKind =
	| 'invalid_configuration' | 'invalid_request' | 'aborted' | 'deadline_exceeded'
	| 'invalid_traceparent' | 'transport' | 'http' | 'invalid_content_type'
	| 'response_too_large' | 'malformed_response'

/** A content-free OPA transport or response failure. */
export class OpaClientError extends Error {
	public readonly kind: OpaClientErrorKind
	declare public readonly status?: number

	public constructor(kind: OpaClientErrorKind, status?: number) {
		super('OPA request failed.')
		this.name = 'OpaClientError'
		this.kind = kind
		if (kind === 'http' && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) this.status = status
	}
}

/** Content-free categories for OPA policy mapping failures. */
export type OpaPolicyErrorKind =
	| 'invalid_configuration' | 'input_mapping' | 'non_json_input'
	| 'result_validation' | 'decision_mapping'

/** A content-free OPA governance mapping or validation failure. */
export class OpaPolicyError extends Error {
	public readonly kind: OpaPolicyErrorKind
	public constructor(kind: OpaPolicyErrorKind) {
		super('OPA policy evaluation failed.')
		this.name = 'OpaPolicyError'
		this.kind = kind
	}
}

type OpaJsonResultSchema<ResultSchema extends Schema> = undefined extends Infer<ResultSchema> ? never : ResultSchema

/** A governance decision restricted to one declared OPA evaluator effect. */
export type OpaGovernanceDecision<Effect extends GovernanceEffect> = Readonly<
	Omit<GovernanceDecision, 'effect'> & { readonly effect: Effect }
>

/** Result accepted from an OPA policy decision mapper. */
export type OpaPolicyDecisionResult<Effects extends readonly [GovernanceEffect, ...GovernanceEffect[]]> =
	| OpaGovernanceDecision<Effects[number]>
	| readonly OpaGovernanceDecision<Effects[number]>[]
	| undefined

/** OPA evaluator preserving its exact tool map and declared effects. */
export type OpaPolicyEvaluator<
	Tools extends GovernanceToolMap,
	Effects extends readonly [GovernanceEffect, ...GovernanceEffect[]],
> = Readonly<Omit<GovernancePolicyEvaluator<Tools>, 'engine' | 'effects' | 'evaluate'> & {
	readonly engine: 'opa'
	readonly effects: Effects
	evaluate(context: GovernanceContext<Tools>): OpaPolicyDecisionResult<Effects> | Promise<OpaPolicyDecisionResult<Effects>>
}>

/** Options for adapting one OPA decision document into Harness governance. */
export interface OpaPolicyOptions<
	Tools extends GovernanceToolMap,
	ResultSchema extends Schema,
	Effects extends readonly [GovernanceEffect, ...GovernanceEffect[]],
> {
	readonly id: string
	readonly version?: string
	readonly effects: Effects
	readonly client: OpaClient
	readonly decisionPath: OpaDecisionPath
	readonly mapInput: (context: GovernanceContext<Tools>) => JsonValue | undefined | Promise<JsonValue | undefined>
	readonly resultSchema: OpaJsonResultSchema<ResultSchema>
	readonly mapDecision: (
		result: Infer<ResultSchema>, context: GovernanceContext<Tools>,
	) => OpaPolicyDecisionResult<Effects> | Promise<OpaPolicyDecisionResult<Effects>>
}

/** Creates a bounded, single-attempt Open Policy Agent Data API client. */
export function createOpaClient(options: OpaClientOptions): OpaClient {
	let snapshot: Readonly<{
		baseUrl: URL
		headers: Readonly<Record<string, string>>
		fetch: typeof globalThis.fetch
		maxRequestBytes: number
		maxResponseBytes: number
		timeoutMs: number
	}>
	try {
		const source = closedRecord(options, CLIENT_OPTION_KEYS)
		const baseUrlValue = ownField(source, 'baseUrl')
		const headersValue = ownField(source, 'headers')
		const fetchValue = ownField(source, 'fetch')
		const maxRequestValue = ownField(source, 'maxRequestBytes')
		const maxResponseValue = ownField(source, 'maxResponseBytes')
		const timeoutValue = ownField(source, 'timeoutMs')
		const baseUrl = parseBaseUrl(baseUrlValue)
		const headers = snapshotHeaders(headersValue)
		const fetchImplementation: unknown = fetchValue === undefined ? globalThis.fetch : fetchValue
		if (typeof fetchImplementation !== 'function') throw new Error()
		const maxRequestBytes = boundedPositiveInteger(maxRequestValue ?? OPA_DEFAULT_MAX_REQUEST_BYTES, OPA_MAX_REQUEST_BYTES)
		const maxResponseBytes = boundedPositiveInteger(maxResponseValue ?? OPA_DEFAULT_MAX_RESPONSE_BYTES, OPA_MAX_RESPONSE_BYTES)
		const timeoutMs = boundedPositiveInteger(timeoutValue ?? OPA_DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
		snapshot = Object.freeze({ baseUrl, headers, fetch: fetchImplementation as typeof globalThis.fetch, maxRequestBytes, maxResponseBytes, timeoutMs })
	} catch {
		throw new OpaClientError('invalid_configuration')
	}

	return Object.freeze({
		async query(path: OpaDecisionPath, input: JsonValue, execution?: OpaDecisionExecution): Promise<OpaQueryResult> {
			let request: Readonly<{ url: string; body: string; signal: AbortSignal; deadline: number }>
			let explicitTraceparent = false
			let traceparentCandidate: unknown
			try {
				const pathSnapshot = snapshotDecisionPath(path)
				const body = serializeRequest(input, snapshot.maxRequestBytes)
				const url = decisionUrl(snapshot.baseUrl, pathSnapshot)
				const ownDeadline = Date.now() + snapshot.timeoutMs
				if (execution === undefined) {
					request = Object.freeze({ url, body, signal: new AbortController().signal, deadline: ownDeadline })
				} else {
					const source = closedRecord(execution, EXECUTION_KEYS)
					const signal = ownField(source, 'signal')
					const deadlineValue = ownField(source, 'deadline')
					if (!(signal instanceof AbortSignal) || !Number.isFinite(deadlineValue)) throw new Error()
					explicitTraceparent = Object.hasOwn(source, 'traceparent')
					traceparentCandidate = ownField(source, 'traceparent')
					request = Object.freeze({ url, body, signal, deadline: Math.min(ownDeadline, deadlineValue as number) })
				}
			} catch {
				throw new OpaClientError('invalid_request')
			}

			let traceparent: string | undefined
			if (explicitTraceparent) {
				if (typeof traceparentCandidate !== 'string') throw new OpaClientError('invalid_traceparent')
				try { traceparent = normalizeHarnessTraceContext({ traceparent: traceparentCandidate }).traceparent }
				catch { throw new OpaClientError('invalid_traceparent') }
			}
			if (request.signal.aborted) throw new OpaClientError('aborted')
			if (request.deadline <= Date.now()) throw new OpaClientError('deadline_exceeded')

			try {
				return await runDecisionOperation({ signal: request.signal, deadline: request.deadline }, async signal => {
					let response: Response
					try {
						response = await snapshot.fetch(request.url, {
							method: 'POST', redirect: 'error', signal, body: request.body,
							headers: { ...snapshot.headers, 'content-type': 'application/json', ...(traceparent === undefined ? {} : { traceparent }) },
						})
					} catch {
						signal.throwIfAborted()
						throw new OpaClientError('transport')
					}
					if (!response.ok) {
						cancelBody(response)
						throw new OpaClientError('http', response.status)
					}
					if (!isJsonMediaType(response.headers.get('content-type'))) {
						cancelBody(response)
						throw new OpaClientError('invalid_content_type')
					}
					return decodeEnvelope(await readBoundedJson(response, snapshot.maxResponseBytes, signal))
				})
			} catch (error) {
				if (error instanceof OpaClientError) throw error
				if (error instanceof OperationCancelledError) throw new OpaClientError('aborted')
				if (error instanceof OperationTimeoutError) throw new OpaClientError('deadline_exceeded')
				throw new OpaClientError('transport')
			}
		},
	} satisfies OpaClient)
}

/** Creates and registers an immutable typed OPA-backed governance policy. */
export function opaPolicy<
	Tools extends GovernanceToolMap,
	const ResultSchema extends Schema,
	const Effects extends readonly [GovernanceEffect, ...GovernanceEffect[]],
>(
	helpers: Pick<GovernanceDefinitionHelpers<Tools>, 'adapter'>,
	options: OpaPolicyOptions<Tools, ResultSchema, Effects>,
): OpaPolicyEvaluator<Tools, Effects> {
	let adapter: GovernanceDefinitionHelpers<Tools>['adapter']
	let evaluator: OpaPolicyEvaluator<Tools, Effects>
	try {
		if (helpers === null || typeof helpers !== 'object') throw new Error()
		adapter = helpers.adapter
		if (typeof adapter !== 'function') throw new Error()
		const source = closedRecord(options, POLICY_OPTION_KEYS)
		const id = ownField(source, 'id')
		if (!validConfigurationId(id) || ['governance.default', 'governance.exposure'].includes(id)) throw new Error()
		const version = ownField(source, 'version')
		if (version !== undefined && !validConfigurationId(version)) throw new Error()
		const effects = snapshotEffects(ownField(source, 'effects')) as unknown as Effects
		const client = ownField(source, 'client')
		if (client === null || typeof client !== 'object') throw new Error()
		const queryValue = (client as { query?: unknown }).query
		if (typeof queryValue !== 'function') throw new Error()
		const query = queryValue.bind(client) as OpaClient['query']
		const decisionPath = snapshotDecisionPath(ownField(source, 'decisionPath'))
		const mapInput = ownField(source, 'mapInput')
		if (typeof mapInput !== 'function') throw new Error()
		const resultSchema = ownField(source, 'resultSchema')
		const validate = snapshotSchemaValidator(resultSchema)
		const mapDecision = ownField(source, 'mapDecision')
		if (typeof mapDecision !== 'function') throw new Error()

		evaluator = Object.freeze({
			id,
			...(version === undefined ? {} : { version }),
			engine: 'opa' as const,
			effects,
			async evaluate(context: GovernanceContext<Tools>): Promise<OpaPolicyDecisionResult<Effects>> {
				let input: JsonValue | undefined
				try { input = await mapInput(context) }
				catch (error) { rethrowKnown(error); throw new OpaPolicyError('input_mapping') }
				if (input === undefined) return undefined
				if (!safeIsJsonValue(input)) throw new OpaPolicyError('non_json_input')
				let response: OpaQueryResult
				try {
					response = await query(decisionPath, input, {
						signal: context.signal, deadline: context.deadline,
						...(context.traceparent === undefined ? {} : { traceparent: context.traceparent }),
					})
				} catch (error) {
					if (error instanceof OpaClientError || error instanceof OpaPolicyError) throw error
					throw new OpaClientError('transport')
				}
				if (!response.defined) return undefined
				const result = await validateResult(validate, response.result)
				try { return await mapDecision(result as Infer<ResultSchema>, context) }
				catch (error) { rethrowKnown(error); throw new OpaPolicyError('decision_mapping') }
			},
		})
	} catch (error) {
		if (error instanceof OpaPolicyError) throw error
		throw new OpaPolicyError('invalid_configuration')
	}

	// Authentic Core helper failures remain Core-owned and pass through unchanged.
	try { return adapter(evaluator) as OpaPolicyEvaluator<Tools, Effects> }
	catch (error) {
		if (error instanceof HarnessConfigError) throw error
		throw new OpaPolicyError('invalid_configuration')
	}
}

function closedRecord(value: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
	const keys = Reflect.ownKeys(value)
	for (const key of keys) {
		if (typeof key !== 'string' || !allowed.has(key)) throw new Error()
	}
	return value as Record<string, unknown>
}

function ownField(value: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(value, key) ? value[key] : undefined
}

function parseBaseUrl(value: unknown): URL {
	if (!(typeof value === 'string' || value instanceof URL)) throw new Error()
	const url = new URL(value.toString())
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
	if (!url.pathname.endsWith('/')) url.pathname += '/'
	if (utf8Length(url.toString()) > MAX_URL_BYTES) throw new Error()
	return Object.freeze(url)
}

function snapshotHeaders(value: unknown): Readonly<Record<string, string>> {
	if (value === undefined) return Object.freeze({})
	if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error()
	const keys = Reflect.ownKeys(value)
	if (keys.length > MAX_HEADERS) throw new Error()
	const entries: [string, string][] = []
	const names = new Set<string>()
	let aggregate = 0
	for (const key of keys) {
		if (typeof key !== 'string') throw new Error()
		const headerValue = (value as Record<string, unknown>)[key]
		const name = key.toLowerCase()
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || names.has(name) || RESERVED_HEADERS.has(name)
			|| utf8Length(name) > MAX_HEADER_NAME_BYTES || typeof headerValue !== 'string'
			|| /\p{Cc}/u.test(headerValue) || utf8Length(headerValue) > MAX_HEADER_VALUE_BYTES) throw new Error()
		names.add(name)
		aggregate += utf8Length(name) + utf8Length(headerValue)
		entries.push([name, headerValue])
	}
	if (aggregate > MAX_HEADERS_BYTES) throw new Error()
	entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
	return Object.freeze(Object.fromEntries(entries))
}

function snapshotDecisionPath(value: unknown): OpaDecisionPath {
	if (!Array.isArray(value)) throw new Error()
	const segments = [...value]
	if (segments.length < 1 || segments.length > MAX_PATH_SEGMENTS) throw new Error()
	for (const segment of segments) {
		if (typeof segment !== 'string' || utf8Length(segment) < 1 || utf8Length(segment) > MAX_PATH_SEGMENT_BYTES
			|| segment === '.' || segment === '..' || /[\\/]/.test(segment) || /\p{Cc}/u.test(segment)) throw new Error()
	}
	return Object.freeze(segments) as OpaDecisionPath
}

function snapshotEffects(value: unknown): readonly [GovernanceEffect, ...GovernanceEffect[]] {
	if (!Array.isArray(value)) throw new Error()
	const effects = [...value]
	if (effects.length === 0 || effects.some(effect => typeof effect !== 'string' || !GOVERNANCE_EFFECTS.has(effect as GovernanceEffect))
		|| new Set(effects).size !== effects.length) throw new Error()
	return Object.freeze(effects) as readonly [GovernanceEffect, ...GovernanceEffect[]]
}

function serializeRequest(input: unknown, maxBytes: number): string {
	if (!safeIsJsonValue(input)) throw new Error()
	const body = JSON.stringify({ input })
	if (typeof body !== 'string' || utf8Length(body) > maxBytes) throw new Error()
	return body
}

function decisionUrl(baseUrl: URL, path: OpaDecisionPath): string {
	const url = new URL(`${OPA_DATA_API_PREFIX}/${path.map(segment => encodeURIComponent(segment)).join('/')}`, baseUrl).toString()
	if (utf8Length(url) > MAX_URL_BYTES) throw new Error()
	return url
}

function isJsonMediaType(value: string | null): boolean {
	if (value === null) return false
	const separator = value.indexOf(';')
	const mediaType = separator === -1 ? value : value.slice(0, separator)
	if (!mediaType || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(mediaType.trim())) return false
	if (separator !== -1 && !hasValidMediaTypeParameters(value.slice(separator + 1))) return false
	const normalized = mediaType.trim().toLowerCase()
	return normalized === 'application/json' || normalized.split('/')[1]?.endsWith('+json') === true
}

async function readBoundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
	const declared = response.headers.get('content-length')
	if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
		cancelBody(response)
		throw new OpaClientError('response_too_large')
	}
	if (response.body === null) throw new OpaClientError('malformed_response')
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	let primary: unknown
	try {
		while (true) {
			signal.throwIfAborted()
			const part = await readChunk(reader, signal)
			if (part.done) break
			total += part.value.byteLength
			if (total > maxBytes) throw new OpaClientError('response_too_large')
			chunks.push(part.value)
		}
		const bytes = new Uint8Array(total)
		let offset = 0
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
		let text: string
		try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
		catch { throw new OpaClientError('malformed_response') }
		try { return JSON.parse(text) as unknown }
		catch { throw new OpaClientError('malformed_response') }
	} catch (error) {
		primary = error
		if (error instanceof OpaClientError) throw error
		signal.throwIfAborted()
		throw new OpaClientError('transport')
	} finally {
		cleanupReader(reader)
		void primary
	}
}

async function readChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
	signal.throwIfAborted()
	let rejectAbort: ((reason: unknown) => void) | undefined
	const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
	const onAbort = () => rejectAbort?.(signal.reason)
	signal.addEventListener('abort', onAbort, { once: true })
	try { return await Promise.race([reader.read(), aborted]) }
	finally { signal.removeEventListener('abort', onAbort) }
}

function cleanupReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	let cancellation: Promise<void> | undefined
	try { cancellation = reader.cancel() } catch { /* cleanup never replaces the primary result */ }
	const release = () => { try { reader.releaseLock() } catch { /* a pending read releases on its settlement path */ } }
	queueMicrotask(release)
	if (cancellation !== undefined) void cancellation.catch(() => undefined).finally(release)
}

function cancelBody(response: Response): void {
	try {
		const cancellation = response.body?.cancel()
		if (cancellation !== undefined) void cancellation.catch(() => undefined)
	} catch { /* cleanup never replaces the primary result */ }
}

function decodeEnvelope(payload: unknown): OpaQueryResult {
	if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new OpaClientError('malformed_response')
	const envelope = payload as Record<string, unknown>
	const decisionId = envelope['decision_id']
	if (decisionId !== undefined && (typeof decisionId !== 'string' || decisionId.length === 0)) throw new OpaClientError('malformed_response')
	const identity = decisionId === undefined ? {} : { decisionId }
	if (!Object.hasOwn(envelope, 'result')) return Object.freeze({ defined: false, ...identity })
	const result = envelope['result']
	if (!safeIsJsonValue(result)) throw new OpaClientError('malformed_response')
	return Object.freeze({ defined: true, result, ...identity })
}

async function validateResult(
	validate: (value: unknown) => unknown | Promise<unknown>, candidate: JsonValue,
): Promise<JsonValue> {
	let outcome: unknown
	try { outcome = await validate(candidate) }
	catch { throw new OpaPolicyError('result_validation') }
	if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) throw new OpaPolicyError('result_validation')
	try {
		const result = outcome as Record<string, unknown>
		const hasIssues = Object.hasOwn(result, 'issues')
		const issues = hasIssues ? result['issues'] : undefined
		if (hasIssues && (!Array.isArray(issues) || issues.length > 0)) throw new Error()
		if (!Object.hasOwn(result, 'value')) throw new Error()
		const value = result['value']
		if (!safeIsJsonValue(value)) throw new Error()
		return value
	} catch { throw new OpaPolicyError('result_validation') }
}

function snapshotSchemaValidator(value: unknown): (candidate: unknown) => unknown | Promise<unknown> {
	if (value === null || typeof value !== 'object') throw new Error()
	const schema = value as Record<string, unknown>
	// Standard Schema implementations such as Zod expose `~standard` through a
	// prototype accessor. Snapshot that public property once, then require the
	// V1 descriptor itself to contain the contract fields as own properties.
	const standard = schema['~standard']
	if (standard === null || typeof standard !== 'object') throw new Error()
	const descriptor = standard as Record<string, unknown>
	const version = ownField(descriptor, 'version')
	if (version !== 1) throw new Error()
	const vendor = ownField(descriptor, 'vendor')
	if (typeof vendor !== 'string') throw new Error()
	const validate = ownField(descriptor, 'validate')
	if (typeof validate !== 'function') throw new Error()
	return validate.bind(standard) as (candidate: unknown) => unknown | Promise<unknown>
}

function validConfigurationId(value: unknown): value is string {
	return typeof value === 'string' && Array.from(value).length >= 1 && Array.from(value).length <= 128 && !/\p{Cc}/u.test(value)
}

function hasValidMediaTypeParameters(value: string): boolean {
	let index = 0
	while (index < value.length) {
		while (value[index] === ' ' || value[index] === '\t') index += 1
		const nameStart = index
		while (index < value.length && isHttpTokenCharacter(value[index]!)) index += 1
		if (index === nameStart) return false
		while (value[index] === ' ' || value[index] === '\t') index += 1
		if (value[index] !== '=') return false
		index += 1
		while (value[index] === ' ' || value[index] === '\t') index += 1
		if (value[index] === '"') {
			index += 1
			let closed = false
			while (index < value.length) {
				const code = value.charCodeAt(index)
				if (value[index] === '"') { index += 1; closed = true; break }
				if (value[index] === '\\') {
					index += 1
					if (index >= value.length) return false
					const escaped = value.charCodeAt(index)
					if (!isHttpQuotedOctet(escaped)) return false
					index += 1
					continue
				}
				if (!isHttpQuotedOctet(code)) return false
				index += 1
			}
			if (!closed) return false
		} else {
			const valueStart = index
			while (index < value.length && isHttpTokenCharacter(value[index]!)) index += 1
			if (index === valueStart) return false
		}
		while (value[index] === ' ' || value[index] === '\t') index += 1
		if (index === value.length) return true
		if (value[index] !== ';') return false
		index += 1
	}
	return false
}

function isHttpTokenCharacter(value: string): boolean {
	return /^[!#$%&'*+.^_`|~0-9A-Za-z-]$/.test(value)
}

function isHttpQuotedOctet(value: number): boolean {
	return value === 9 || (value >= 32 && value <= 126) || (value >= 128 && value <= 255)
}

function boundedPositiveInteger(value: unknown, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) throw new Error()
	return value as number
}

function utf8Length(value: string): number { return textEncoder.encode(value).byteLength }
function safeIsJsonValue(value: unknown): value is JsonValue {
	try { return isJsonValue(value) } catch { return false }
}
function rethrowKnown(error: unknown): void {
	if (error instanceof OpaClientError || error instanceof OpaPolicyError) throw error
}
