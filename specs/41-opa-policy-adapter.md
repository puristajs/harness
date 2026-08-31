# Open Policy Agent governance adapter

**Status:** approved by the repository owner, 2026-08-30.

**Purpose.** Define the first-party `@purista/harness-policy-opa` addon for
evaluating Harness governance decisions through Open Policy Agent's stable Data
API. The package must preserve builder-derived tool-input types, remain usable
with sidecar, Kubernetes service, or hosted OPA topologies, and fail closed
without capturing policy input or response content.

## Product boundary

The addon owns only the reusable OPA Data API transport and the typed adapter
from `GovernanceContext<S>` to `GovernancePolicyEvaluator<S>`.

The application or platform continues to own:

- authenticated principal, tenant, resource, and business-authorization data;
- the explicit mapping from Harness context to the least OPA input required;
- Rego packages, bundles, discovery, rollout, and OPA availability;
- credentials, TLS/mTLS, service discovery, egress policy, and endpoint choice;
- the OPA result schema and mapping to the closed Harness governance effects;
- OPA decision-log storage, masking, retention, and vendor correlation; and
- retries, durable review, signed receipts, idempotency, and recovery across
  external side effects.

The package does not implement Cedar, AWS Verified Permissions, arbitrary policy
HTTP endpoints, policy loading, an OPA control plane, a hosted review queue, or
an authorization identity source. Cedar remains an application-owned
`GovernancePolicyEvaluator` because embedded Cedar and AWS Verified Permissions
have different execution and credential models.

## Package and dependency rules

- Package name: `@purista/harness-policy-opa`.
- ESM only, Node `>=24.15.0`, target and compiler rules inherited from the
  repository TypeScript configuration.
- Runtime dependency: public `@purista/harness` only. There is no OPA SDK,
  provider package, framework package, or addon-to-addon dependency.
- The package exports `.` and `./testing`. Testing helpers never appear from the
  main entry point.
- The implementation uses the platform `fetch` API and public Harness decision,
  schema, JSON, cancellation, and timeout contracts.

## Public API

```ts
export const OPA_DATA_API_PREFIX: 'v1/data'
export const OPA_DEFAULT_MAX_RESPONSE_BYTES: 262_144
export const OPA_DEFAULT_TIMEOUT_MS: 10_000

export type OpaDecisionPath = readonly [string, ...string[]]

export interface OpaDecisionExecution {
  readonly signal: AbortSignal
  readonly deadline: number
}

export interface OpaClientOptions {
  readonly baseUrl: URL | string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
  readonly maxResponseBytes?: number
  readonly timeoutMs?: number
}

export type OpaQueryResult =
  | { readonly defined: false; readonly decisionId?: string }
  | { readonly defined: true; readonly result: JsonValue; readonly decisionId?: string }

export interface OpaClient {
  configureHarnessContext(context: HarnessAdapterContext): void
  query(
    path: OpaDecisionPath,
    input: JsonValue,
    execution?: OpaDecisionExecution,
  ): Promise<OpaQueryResult>
}

export type OpaClientErrorKind =
  | 'aborted'
  | 'deadline_exceeded'
  | 'transport'
  | 'http'
  | 'invalid_content_type'
  | 'response_too_large'
  | 'malformed_response'

export class OpaClientError extends Error {
  readonly kind: OpaClientErrorKind
  readonly status?: number
}

export type OpaPolicyErrorKind =
  | 'input_mapping'
  | 'non_json_input'
  | 'result_validation'
  | 'decision_mapping'

export class OpaPolicyError extends Error {
  readonly kind: OpaPolicyErrorKind
}

export interface OpaPolicyRegistrar<S extends BuilderState> {
  adapter<const P extends GovernancePolicyEvaluator<S>>(definition: P): P
}

// Private conditional used by the public options interface. It accepts JSON
// object outputs with absent optional properties, but rejects known Date,
// function, bigint, symbol, and top-level undefined output types.
export type OpaJsonCompatible<T> = /* recursive JSON compatibility predicate */ true | false
export type OpaJsonResultSchema<ResultSchema extends Schema<any, any>> = /* conditional */ ResultSchema | never

export interface OpaPolicyOptions<
  S extends BuilderState,
  ResultSchema extends Schema<any, any>,
> {
  readonly id: string
  readonly version?: string
  readonly client: OpaClient
  readonly decisionPath: OpaDecisionPath
  readonly mapInput: (
    context: GovernanceContext<S>,
  ) => JsonValue | undefined | Promise<JsonValue | undefined>
  readonly resultSchema: OpaJsonResultSchema<ResultSchema>
  readonly mapDecision: (
    result: Infer<ResultSchema>,
    context: GovernanceContext<S>,
  ) =>
    | GovernanceDecision
    | readonly GovernanceDecision[]
    | undefined
    | Promise<GovernanceDecision | readonly GovernanceDecision[] | undefined>
}

export function createOpaClient(options: OpaClientOptions): OpaClient

export function opaPolicy<
  S extends BuilderState,
  const ResultSchema extends Schema<any, any>,
>(
  registrar: OpaPolicyRegistrar<S>,
  options: OpaPolicyOptions<S, ResultSchema>,
): GovernancePolicyEvaluator<S>
```

`opaPolicy(helpers, options)` calls the supplied `helpers.adapter(...)` and
returns its evaluator. Passing the helper object from
`.governance((helpers) => ...)` is the inference anchor: after narrowing
`context.toolId`, both mapping callbacks receive the exact schema-derived input
for that tool. `mapDecision` receives the validated output of `resultSchema`.
No cast or separately annotated `BuilderState` is required in consumer code.

## Data API wire contract

`createOpaClient` sends exactly one request per `query` call:

```http
POST <baseUrl>/v1/data/<encoded path segments>
Content-Type: application/json

{"input": <JSON value>}
```

- `baseUrl` must be an absolute, credential-free HTTP(S) base URL without query
  or fragment. A trailing slash is normalized.
- The decision path is a non-empty tuple. Every segment must be non-empty, no
  longer than 256 characters, free of slash, backslash, control characters,
  `.` and `..`, and is encoded as one URL segment before interpolation.
- Static headers are validated once. They may carry authorization, but cannot
  override `content-type`, `content-length`, `host`, `connection`,
  `transfer-encoding`, `traceparent`, or `tracestate`, and cannot contain line
  breaks.
- When the client is registered through `opaPolicy(...)`, it inherits the
  Harness telemetry context and injects the active W3C `traceparent` into the
  fixed trusted OPA request. Policy input, result, URL, headers, credentials,
  and decision-log content are never telemetry attributes.
- Redirect following is disabled with `redirect: 'error'` so a trusted base URL
  cannot silently redirect credentials or policy input.
- There are no hidden retries. A policy query is an immediate decision and at
  most one network request is made per call.
- `timeoutMs` defaults to `10_000` and must be a positive safe integer. The
  effective deadline is the earlier of this client timeout and a supplied
  Harness decision deadline. A supplied parent signal is preserved. Direct
  client calls without an execution object still receive the client timeout.
- `maxResponseBytes` defaults to `262_144` and must be a positive safe integer
  no greater than `4_194_304`. The limit is enforced while streaming the body;
  `Content-Length` is only an early rejection hint.
- Successful responses must use a JSON media type and decode to an object. An
  optional `decision_id` must be a non-empty string. Unknown top-level fields
  are ignored for forward compatibility.
- An absent `result` property means OPA returned an undefined decision and
  yields `{ defined: false }`. A present `result`, including JSON `null`, must
  be JSON-compatible and yields `{ defined: true, result }`.
- Non-2xx responses, malformed envelopes, invalid media types, transport
  failures, parent cancellation, and deadline expiry throw content-free
  `OpaClientError` values. HTTP status is the only response metadata retained.
  The response body, request URL, headers, input, and result never enter the
  error message or fields.

## Policy mapping and failure semantics

1. `mapInput(context)` runs on the already parsed, correlated governance
   context. Returning `undefined` means that this evaluator does not apply and
   makes no OPA request.
2. A returned value is checked with `isJsonValue` even though the callback is
   statically JSON-typed. Non-JSON values fail with
   `OpaPolicyError('non_json_input')`.
3. The client queries `decisionPath`. An undefined OPA result means this
   evaluator returns `undefined`; the Harness policy reducer and
   `defaultEffect` remain authoritative.
4. A defined result is validated through Standard Schema V1. Validator throws,
   issue arrays, malformed validator outcomes, and non-JSON transformed values
   all fail with the content-free `result_validation` kind.
5. `mapDecision(validated, context)` returns the closed Harness decision,
   decision array, or `undefined`. Core performs the final strict governance
   result validation and effect precedence reduction.

Thrown input/decision mapping errors become content-free `OpaPolicyError`
values. Existing `OpaClientError` and `OpaPolicyError` instances are not wrapped
again. No callback input, OPA input/result, schema issue text, or original error
is retained as a cause, message, metadata field, log, or telemetry attribute.
Harness invokes the evaluator through its existing fail-closed decision
boundary, so a timeout or adapter failure cannot allow the tool call.

## Testing subpath

`@purista/harness-policy-opa/testing` exports:

```ts
export interface FakeOpaDataApiRequest {
  readonly url: string
  readonly init: RequestInit
}

export interface FakeOpaDataApiResponseOptions {
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
}

export interface FakeOpaDataApiDecisionOptions extends FakeOpaDataApiResponseOptions {
  readonly decisionId?: string
}

export class FakeOpaDataApi {
  readonly requests: FakeOpaDataApiRequest[]
  readonly fetch: typeof globalThis.fetch
  enqueueDecision(result: JsonValue, options?: FakeOpaDataApiDecisionOptions): void
  enqueueUndefinedDecision(options?: FakeOpaDataApiDecisionOptions): void
  enqueueResponse(body: unknown, options?: FakeOpaDataApiResponseOptions): void
  enqueueTransportError(error?: Error): void
  assertExhausted(): void
  reset(): void
}
```

The fake is strict: an unqueued request fails. It emulates only the supported
HTTP envelope and does not evaluate Rego. Request recordings are test-only and
must never be attached to application logs or telemetry.

## Required evidence

- Runtime tests cover base URL, path, header, redirect, method/body, JSON media
  type, unknown envelope fields, `decision_id`, absent versus `null` result,
  HTTP/transport errors, parent abort, client/effective deadline, streaming byte
  bounds despite false/missing content length, and content-free errors.
- Policy tests cover no-op input, exact request minimization, synchronous and
  asynchronous Standard Schema validation, transformed result, malformed
  validator output, non-JSON input/output, mapping failures, undefined OPA
  results, and strict final decision behavior through a built Harness.
- Type tests prove builder-cascading tool ids/inputs, schema-derived result
  inference, invalid tool fields, and rejection of known non-JSON result schema
  output.
- The maintained `examples/opa-governance` package runs a real local OPA policy
  without model credentials and uses `FakeOpaDataApi` for deterministic tests.
  It proves allow and deny paths and handler suppression.
- Package README, standalone docs, public Handbook, generated API, package
  availability matrix, operations/security guidance, and canonical skills all
  describe the same contract and distinguish OPA from Cedar.

## Operations and security

- OPA should normally be reached through a fixed internal URL, sidecar, service
  mesh, or application-owned gateway. Do not derive `baseUrl`, headers, or the
  decision path from model output, tool input, tenant data, or untrusted request
  fields.
- Use TLS/mTLS or workload identity appropriate to the topology and restrict
  network policy so the application can reach only the intended policy engine.
- Check OPA readiness with its health API, including bundle/plugin readiness
  where used, before routing protected work. Harness decision failures still
  remain fail closed after startup.
- Minimize OPA input. OPA decision logs can contain input and result, so the OPA
  deployment must mask sensitive fields and apply explicit retention/access
  controls.
- This synchronous adapter is suitable for immediate policy decisions. Durable
  human review and effects with uncertain completion require an
  application-owned queue/resume and claim/receipt design.

## Release gates

The package is releasable only when its main and testing exports match this
specification, package-boundary audits pass, package build/typecheck/tests and
coverage pass, the consumer example passes, generated API pages resolve, the
full Handbook build/link/knowledge/skill audits pass, and the canonical skill
mirrors are synchronized.
