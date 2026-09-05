# Open Policy Agent governance adapter

**Status:** approved by the repository owner, 2026-08-30.

**Purpose.** Define the first-party `@purista/harness-policy-opa` addon for
evaluating Harness governance decisions through Open Policy Agent's stable Data
API. The package must preserve definition-derived tool-input types, remain usable
with sidecar, Kubernetes service, or hosted OPA topologies, and fail closed
without capturing policy input or response content.

## Product boundary

The addon owns only the reusable OPA Data API transport and the typed adapter
from `GovernanceContext<Tools>` to `GovernancePolicyEvaluator<Tools>`, where
`Tools` is the exact `GovernanceToolMap` compiled for one agent definition.

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
- This addon's implementation ticket changes source, tests, examples, and
  exports while package versions, Harness ranges, and the lockfile remain at
  the aligned 3.0.0 release. Spec 42 H4-016 performs the single atomic 4.0.0
  flip across Core and all first-party addons; this package is not published
  independently before that gate.

## Public API

```ts
export const OPA_DATA_API_PREFIX: 'v1/data'
export const OPA_DEFAULT_MAX_REQUEST_BYTES: 1_048_576
export const OPA_DEFAULT_MAX_RESPONSE_BYTES: 262_144
export const OPA_DEFAULT_TIMEOUT_MS: 10_000
export const OPA_MAX_REQUEST_BYTES: 16_777_216
export const OPA_MAX_RESPONSE_BYTES: 4_194_304

export type OpaDecisionPath = readonly [string, ...string[]]

export interface OpaDecisionExecution {
  readonly signal: AbortSignal
  readonly deadline: number
  readonly traceparent?: string
}

export interface OpaClientOptions {
  readonly baseUrl: URL | string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
  readonly maxRequestBytes?: number
  readonly maxResponseBytes?: number
  readonly timeoutMs?: number
}

export type OpaQueryResult =
  | { readonly defined: false; readonly decisionId?: string }
  | { readonly defined: true; readonly result: JsonValue; readonly decisionId?: string }

export interface OpaClient {
  query(
    path: OpaDecisionPath,
    input: JsonValue,
    execution?: OpaDecisionExecution,
  ): Promise<OpaQueryResult>
}

export type OpaClientErrorKind =
  | 'invalid_configuration'
  | 'invalid_request'
  | 'aborted'
  | 'deadline_exceeded'
  | 'invalid_traceparent'
  | 'transport'
  | 'http'
  | 'invalid_content_type'
  | 'response_too_large'
  | 'malformed_response'

export class OpaClientError extends Error {
  constructor(kind: OpaClientErrorKind, status?: number)
  readonly kind: OpaClientErrorKind
  readonly status?: number
}

export type OpaPolicyErrorKind =
  | 'invalid_configuration'
  | 'input_mapping'
  | 'non_json_input'
  | 'result_validation'
  | 'decision_mapping'

export class OpaPolicyError extends Error {
  constructor(kind: OpaPolicyErrorKind)
  readonly kind: OpaPolicyErrorKind
}

// Package-private conditional used by the public options interface. Schema
// already restricts both sides to JSON-compatible values; this additionally
// rejects a validator whose top-level output may be undefined.
type OpaJsonResultSchema<ResultSchema extends Schema> =
  undefined extends Infer<ResultSchema> ? never : ResultSchema

export type OpaGovernanceDecision<Effect extends GovernanceEffect> = Readonly<
  Omit<GovernanceDecision, 'effect'> & { readonly effect: Effect }
>

export type OpaPolicyDecisionResult<
  Effects extends readonly [GovernanceEffect, ...GovernanceEffect[]],
> =
  | OpaGovernanceDecision<Effects[number]>
  | readonly OpaGovernanceDecision<Effects[number]>[]
  | undefined

export type OpaPolicyEvaluator<
  Tools extends GovernanceToolMap,
  Effects extends readonly [GovernanceEffect, ...GovernanceEffect[]],
> = Readonly<
  Omit<GovernancePolicyEvaluator<Tools>, 'engine' | 'effects' | 'evaluate'> & {
    readonly engine: 'opa'
    readonly effects: Effects
    evaluate(
      context: GovernanceContext<Tools>,
    ): OpaPolicyDecisionResult<Effects> | Promise<OpaPolicyDecisionResult<Effects>>
  }
>

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
  readonly mapInput: (
    context: GovernanceContext<Tools>,
  ) => JsonValue | undefined | Promise<JsonValue | undefined>
  readonly resultSchema: OpaJsonResultSchema<ResultSchema>
  readonly mapDecision: (
    result: Infer<ResultSchema>,
    context: GovernanceContext<Tools>,
  ) => OpaPolicyDecisionResult<Effects> | Promise<OpaPolicyDecisionResult<Effects>>
}

export function createOpaClient(options: OpaClientOptions): OpaClient

export function opaPolicy<
  Tools extends GovernanceToolMap,
  const ResultSchema extends Schema,
  const Effects extends readonly [GovernanceEffect, ...GovernanceEffect[]],
>(
  helpers: Pick<GovernanceDefinitionHelpers<Tools>, 'adapter'>,
  options: OpaPolicyOptions<Tools, ResultSchema, Effects>,
): OpaPolicyEvaluator<Tools, Effects>
```

`opaPolicy(helpers, options)` calls the supplied `helpers.adapter(...)` and
returns its evaluator. Passing the helper object from
`defineAgent(..., { governance: (helpers) => ... })` is the inference anchor:
after narrowing
`context.toolId`, both mapping callbacks receive the exact schema-derived input
for that tool. `mapDecision` receives the validated output of `resultSchema`.
No cast or separately annotated tool-map type is required in consumer code.
The required `effects` tuple is also the compile-time range of
`mapDecision.effect`; it preserves the literal declaration through the returned
evaluator so agent requirement compilation can determine whether durable
approval storage is required. Core still rejects an undeclared runtime effect
from JavaScript, `any`, or a cast as
`DecisionEvaluationError{failureKind:'invalid_result'}`.

## Immutable policy construction

`opaPolicy` is definition-time construction and performs no network I/O. Its
options object is closed: the only accepted own fields are `id`, `version`,
`effects`, `client`, `decisionPath`, `mapInput`, `resultSchema`, and
`mapDecision`. Unknown fields are configuration errors rather than ignored
lifecycle extensions.

- `id` and an optional `version` follow the Core governance configuration-id
  rules. Reserved Core policy ids are rejected.
- `effects` is required, nonempty, duplicate-free, and contains only `allow`,
  `deny`, `require_approval`, or `audit`. The factory copies the tuple and
  freezes the copy. An empty, duplicate, or unknown effect is rejected
  synchronously even when supplied from untyped JavaScript.
- `decisionPath` is validated, copied, and frozen during construction. Later
  mutation of the caller's array cannot change the request path.
- The client, schema, and callback references are captured once. Later mutation
  of the caller's options object cannot replace them.
- The evaluator passed to `helpers.adapter(...)` and returned by `opaPolicy`
  has exactly `id`, optional `version`, `engine: 'opa'`, the frozen `effects`
  tuple, and `evaluate`. The evaluator itself is frozen. It has no adapter
  context hook, provider handle, credential, runtime registry, or mutable
  telemetry slot.

`defineAgent` performs its independent closed-field validation and frozen
snapshot of the evaluator. The compiled agent therefore retains only the
declared evaluator fields and the exact effects declaration. Neither
construction layer silently discards an extra field.

`createOpaClient` likewise rejects unknown own option fields, copies its parsed
base URL and validated static headers, and returns a frozen client containing
only `query`. A query validates its execution object and path for that call; it
does not retain either value after settlement.

Every `opaPolicy` construction failure throws
`OpaPolicyError('invalid_configuration')`, with the fixed message and no other
field or cause. Validation performs no I/O and uses this precedence: helper has
a callable `adapter`; options is a closed object; `id`; optional `version`;
nonempty unique known `effects`; a client object with callable `query`;
`decisionPath`;
callable `mapInput`; valid Standard Schema V1 `resultSchema`; callable
`mapDecision`. The decision path uses the same segment rules as `query` and is
snapshotted only after validation. If the authentic Core helper's
`adapter(...)` rejects the otherwise valid evaluator, its existing content-free
Core `HarnessConfigError` passes through unchanged. No construction failure is
reported as an evaluation-time mapping error.

## v4 authoring example

```ts
import { defineAgent, defineHarness, defineTool } from '@purista/harness'
import { createOpaClient, opaPolicy } from '@purista/harness-policy-opa'
import { z } from 'zod'

const transferFunds = defineTool('transferFunds', {
  description: 'Execute one transfer after policy evaluation.',
  input: z.object({
    amount: z.number().positive(),
    destination: z.string().min(1),
  }),
  output: z.object({ accepted: z.boolean() }),
  handler: async (_context, _input) => ({ accepted: true }),
})

const opaResult = z.object({
  matched: z.boolean(),
  effect: z.enum(['allow', 'deny', 'require_approval']),
  ruleId: z.string().optional(),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
})

const client = createOpaClient({
  baseUrl: 'http://127.0.0.1:8181',
})

const transferAgent = defineAgent('transferAgent', {
  instructions: 'Use transferFunds only for the requested transfer.',
  tools: [transferFunds],
  governance: helpers => ({
    mode: 'enforce',
    defaultEffect: 'deny',
    policies: [
      opaPolicy(helpers, {
        id: 'opaTransferPolicy',
        version: '2026.09.05',
        effects: ['allow', 'deny', 'require_approval'],
        client,
        decisionPath: ['purista', 'bank', 'transfer'],
        mapInput(context) {
          if (context.toolId !== 'transferFunds') return undefined
          return {
            tool: context.toolId,
            amount: context.input.amount,
            destination: context.input.destination,
          }
        },
        resultSchema: opaResult,
        mapDecision(result) {
          if (!result.matched) return undefined
          return {
            effect: result.effect,
            ...(result.ruleId === undefined ? {} : { ruleId: result.ruleId }),
            ...(result.reasonCode === undefined
              ? {}
              : { reasonCode: result.reasonCode }),
          }
        },
      }),
    ],
  }),
})

const definition = defineHarness({ name: 'transferService' })
  .addAgent(transferAgent)

const runtime = await definition.getInstance({
  model: {
    provider,
    model: 'approved-model',
  },
  storage,
})
```

This example intentionally maps only the three fields the OPA policy needs.
Because the declared tuple contains `require_approval`, the Harness definition
requires durable storage before an instance can run. The application owns the
concrete `provider` and `storage` bindings.

## Data API wire contract

`createOpaClient` sends exactly one request per `query` call:

```http
POST <baseUrl>/v1/data/<encoded path segments>
Content-Type: application/json

{"input": <JSON value>}
```

- `baseUrl` must be an absolute, credential-free HTTP(S) base URL without query
  or fragment. A trailing slash is normalized. Its serialized form and each
  completed request URL may contain at most 8,192 UTF-8 bytes. Its existing
  pathname is an optional fixed reverse-proxy prefix: the client normalizes that
  pathname to one trailing slash and resolves
  `v1/data/<encoded path segments>` beneath it.
- The decision path contains 1 to 64 segments. Every segment contains 1 to 256
  UTF-8 bytes, is free of slash, backslash, control characters, `.` and `..`,
  and is encoded as one URL segment before interpolation.
- Static headers are validated once. There may be at most 64. A name contains
  at most 256 UTF-8 bytes and is a valid HTTP token; a value contains at most
  8,192 UTF-8 bytes; their normalized aggregate contains at most 32,768 UTF-8
  bytes. The aggregate is the sum, for every entry, of the UTF-8 byte length of
  its normalized lowercase name plus the UTF-8 byte length of its value;
  separators and object syntax contribute no bytes. Names are lowercased and
  duplicate names after normalization fail.
  They may carry authorization, but cannot
  override `content-type`, `content-length`, `host`, `connection`,
  `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `set-cookie`, `te`,
  `trailer`, `transfer-encoding`, `upgrade`, `traceparent`, or `tracestate`.
  Values must be strings without control characters. The validated record is
  copied, lowercased, bytewise sorted by name, and frozen; later caller mutation
  cannot change a request.
- A supplied execution object is closed and contains exactly `signal`,
  `deadline`, and optional `traceparent`. Unknown fields, a non-`AbortSignal`
  signal, or a non-finite deadline fail before `fetch`.
- `OpaDecisionExecution.traceparent`, when present, is validated by calling the
  public Core `normalizeHarnessTraceContext({ traceparent })`. The addon owns no
  second regular expression or version/flag interpretation. A Core-rejected
  value, including a line break, fails before `fetch` with the content-free
  `OpaClientError('invalid_traceparent')`; the Core error is not retained. An
  absent value emits no `traceparent` header. `tracestate` is not accepted or
  propagated.
- When invoked through `opaPolicy(...)`, the evaluator passes the optional
  `GovernanceContext.traceparent` to `client.query(...)` together with that
  evaluation's signal and deadline. Core creates that value from the active
  `harness.policy.evaluate` span for the current invocation. The client stores
  no Harness telemetry object or trace state. Policy input, result, URL,
  headers, credentials, and decision-log content are never telemetry
  attributes.
- One client or evaluator may be reused by multiple Harness definitions and
  runtime instances concurrently. Every request uses only its own execution
  argument, so a traceparent, signal, or deadline from one query cannot appear
  in another and there is no first-instance telemetry binding.
- Redirect following is disabled with `redirect: 'error'` so a trusted base URL
  cannot silently redirect credentials or policy input.
- There are no hidden retries. A policy query is an immediate decision and at
  most one network request is made per call.
- The exact request object is serialized once as UTF-8 JSON before `fetch`.
  `maxRequestBytes` defaults to `OPA_DEFAULT_MAX_REQUEST_BYTES`, must be a
  positive safe integer no greater than `OPA_MAX_REQUEST_BYTES`, and bounds the
  complete `{"input":...}` body. Serialization failure or an oversized body is
  `invalid_request` and performs no I/O.
- `timeoutMs` defaults to `10_000` and must be a positive safe integer no
  greater than `2_147_483_647`. The
  effective deadline is the earlier of this client timeout and a supplied
  Harness decision deadline. A supplied parent signal is preserved. Direct
  client calls without an execution object still receive the client timeout.
- `maxResponseBytes` defaults to `OPA_DEFAULT_MAX_RESPONSE_BYTES` and must be a
  positive safe integer no greater than `OPA_MAX_RESPONSE_BYTES`. The limit is
  enforced while streaming the body;
  `Content-Length` is only an early rejection hint.
- Successful responses must use `application/json` or a case-insensitive media
  type whose subtype ends in `+json`; parameters are ignored after syntactic
  validation. The body must decode to an object. An
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

Invalid `createOpaClient` options, base URL, headers, or configured bounds fail
synchronously with `OpaClientError('invalid_configuration')`. An invalid query
path, input serialization, request bound, or closed execution shape fails with
`OpaClientError('invalid_request')`, except for the dedicated
`invalid_traceparent` case. Error messages are fixed by `kind`; only `http`
retains a validated integer `status`, and no error retains a cause.
Every `OpaClientError` message is exactly `OPA request failed.` and every
`OpaPolicyError` message is exactly `OPA policy evaluation failed.`; the public
`kind` carries the safe distinction.

Cancellation precedence is deterministic. An already-aborted parent signal
wins before deadline evaluation; otherwise an already-expired effective
deadline is `deadline_exceeded`. After `fetch` begins, the first observed parent
abort or effective-deadline timer wins. Response-body cancellation, reader
release, listener removal, and timer cleanup always run; a cleanup failure never
replaces the primary error or successful result. The optional OPA `decision_id`
is exposed only by direct `OpaClient.query` results. `opaPolicy` does not pass it
to `mapDecision`, retain it, log it, or attach it to telemetry or Harness
decision evidence.

The client failure mapping is exhaustive:

| Condition | `OpaClientError.kind` and retained status |
| --- | --- |
| closed factory shape, base URL, static header, fetch, timeout, or byte-limit configuration is invalid | `invalid_configuration`, no status |
| query path, JSON input serialization, request byte bound, or execution object other than traceparent is invalid | `invalid_request`, no status |
| Core rejects the explicit traceparent | `invalid_traceparent`, no status |
| parent signal wins | `aborted`, no status |
| effective deadline wins | `deadline_exceeded`, no status |
| fetch rejects for another reason or the response stream fails | `transport`, no status |
| response has a non-2xx status | `http`, that integer status only |
| successful response lacks an accepted JSON media type | `invalid_content_type`, no status |
| response exceeds the configured bound | `response_too_large`, no status |
| successful JSON body or Data API envelope violates the specified shape | `malformed_response`, no status |

No other client kind is produced. Policy callback and schema failures use the
separate `OpaPolicyError` mapping below.

## Policy mapping and failure semantics

1. `mapInput(context)` runs on the already parsed, correlated governance
   context. Returning `undefined` means that this evaluator does not apply and
   makes no OPA request.
2. A returned value is checked with `isJsonValue` even though the callback is
   statically JSON-typed. Non-JSON values fail with
   `OpaPolicyError('non_json_input')`.
3. The client queries the snapshotted `decisionPath` with the current
   governance context's `signal`, `deadline`, and optional `traceparent`. An
   undefined OPA result means this evaluator returns `undefined`; the Harness
   policy reducer and `defaultEffect` remain authoritative.
4. A defined result is validated through Standard Schema V1. Validator throws,
   issue arrays, malformed validator outcomes, and non-JSON transformed values
   all fail with the content-free `result_validation` kind.
5. `mapDecision(validated, context)` returns a decision whose effect belongs to
   the declared `effects` tuple, an array of such decisions, or `undefined`.
   Core performs final strict governance result validation, rejects undeclared
   effects at runtime, and applies effect precedence reduction.

Thrown input/decision mapping errors become content-free `OpaPolicyError`
values. Existing `OpaClientError` and `OpaPolicyError` instances are not wrapped
again. A custom `OpaClient` rejection that is not an `OpaClientError` becomes
`OpaClientError('transport')` without retaining the original. No callback input, OPA input/result, schema issue text, or original error
is retained as a cause, message, metadata field, log, or telemetry attribute.
Harness invokes the evaluator through its existing fail-closed decision
boundary, so a timeout or adapter failure cannot allow the tool call.

The policy failure mapping is exhaustive: factory validation is
`invalid_configuration`; a `mapInput` throw is `input_mapping`; a returned
non-JSON value is `non_json_input`; a validator
throw, issues result, malformed Standard Schema result, or transformed non-JSON
value is `result_validation`; and a `mapDecision` throw is `decision_mapping`.
Final decision-shape or undeclared-effect rejection remains Core's existing
`DecisionEvaluationError{failureKind:'invalid_result'}`. Constructors and
wrappers retain no callback error as a cause.

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

## Required tests and acceptance

### Compile-time and definition tests

- Type tests use `defineTool` references and the `defineAgent` governance
  callback. They prove the complete definition-derived tool-id union, correlated
  tool input after `context.toolId` narrowing, schema-derived OPA result, and
  rejection of unknown tool fields and known non-JSON result-schema output.
- A literal nonempty `effects` tuple is preserved by `opaPolicy` and by the
  compiled agent governance snapshot. Type tests reject an empty tuple and a
  `mapDecision` effect outside `Effects[number]`. A tuple containing
  `require_approval` produces `RuntimeRequirements.storage.durable: true`; an
  allow-only tuple does not add that requirement.
- Untyped construction tests reject a missing, empty, duplicate, or unknown
  effects list, invalid ids and versions, invalid paths, non-callable callbacks,
  invalid clients or schemas, and every unknown options field including
  `configureHarnessContext`.
- Construction tests prove that the evaluator and its effects are frozen, its
  own keys are exactly the specified evaluator keys, and mutations of the
  original options, effects array, or decision-path array cannot alter later
  evaluation. Construction calls `helpers.adapter(...)` exactly once and makes
  no OPA request.

### Client and policy runtime tests

- Client tests cover closed options and execution fields, frozen construction,
  base URL, path, static headers, redirect mode, method/body, JSON media type,
  unknown envelope fields, `decision_id`, absent versus `null` result, HTTP and
  transport errors, parent abort, client and effective deadline, streaming byte
  bounds despite false or missing content length, and content-free errors.
  Every query makes at most one `fetch` call and releases its timer, linked abort
  listeners, reader, and response body on success, failure, cancellation, and
  deadline expiry.
- Direct client tests prove that representative values accepted by Core,
  including version-00 values with non-sampling flag bits, are sent exactly
  once; absence omits the header; static trace headers remain forbidden; and
  every representative value rejected by Core fails with
  `invalid_traceparent` before `fetch`. A contract test feeds the same corpus to
  Core and the addon and proves the addon never rejects a value Core accepts.
- Policy tests cover no-op input, exact request minimization, synchronous and
  asynchronous Standard Schema validation, transformed result, malformed
  validator output, non-JSON input/output, mapping failures, undefined OPA
  results, and strict final decision behavior through a v4 Harness instance.
  An undeclared effect forced through JavaScript or a cast is rejected by Core
  before approval or tool execution.
- Harness integration tests prove that the OPA request receives the traceparent
  of the active `harness.policy.evaluate` span and that the evaluator passes its
  exact current signal and deadline to `client.query`. When Core supplies no
  traceparent, no header is emitted. The client and evaluator expose no
  `configureHarnessContext` hook and retain no Harness adapter context.
- A concurrency test shares one client and one evaluator between two Harness
  runtime instances with distinct recording telemetry implementations, runs
  overlapping policy evaluations, and proves each request receives only its own
  invocation's traceparent, signal, and deadline. Completion, failure, or
  cancellation of one request cannot affect the other.
- Span, metric, log, and error assertions prove that policy input, result, OPA
  URL, headers, credentials, traceparent, decision-log content, schema issues,
  and callback errors are not captured. Only the existing content-free Core
  policy telemetry and allowed status metadata remain observable.

### Consumer and documentation evidence

- The maintained `examples/opa-governance` package uses `defineTool`,
  `defineAgent`, `defineHarness`, and `getInstance`, runs a real local OPA policy
  without model credentials, and uses `FakeOpaDataApi` for deterministic tests.
  It proves allow and deny paths, handler suppression, and the durable binding
  required by a declared `require_approval` effect.
- Package README, standalone docs, public Handbook, generated API, package
  availability matrix, operations/security guidance, and canonical skills all
  describe the same v4 contract, contain no builder-level governance or adapter
  context hook, and distinguish OPA from Cedar.

Acceptance requires all of the following:

1. **OPA-AC-01 — exact public surface:** the main and testing exports match the
   declarations in this specification. No `BuilderState`, Harness-builder
   `.governance(...)`, `HarnessAdapterContext`, or `configureHarnessContext`
   surface remains.
2. **OPA-AC-02 — immutable evaluator:** `opaPolicy` validates and snapshots the
   closed options, preserves its exact effects tuple, returns the exact frozen
   evaluator, and performs no construction-time I/O.
3. **OPA-AC-03 — bounded transport:** a query uses the fixed Data API endpoint,
   one attempt, linked cancellation and deadline, bounded streaming parsing,
   disabled redirects, strict JSON envelope validation, and complete resource
   cleanup.
4. **OPA-AC-04 — correlated evaluation:** input and result schemas remain
   correlated to the agent's exact `GovernanceToolMap`; undefined input or OPA
   result remains non-applicable; callback, schema, transport, and undeclared
   effect failures remain content-free and fail closed.
5. **OPA-AC-05 — per-query tracing:** the active Core policy-span traceparent is
   forwarded only through the current query execution argument. Valid direct
   values are supported, invalid values fail before I/O, and concurrent shared
   use cannot bind or leak another Harness instance's telemetry state.
6. **OPA-AC-06 — approval planning:** the exact declared effects participate in
   Core requirement compilation, and `require_approval` always requires durable
   storage before runtime instantiation.
7. **OPA-AC-07 — privacy and scope:** no protected content or transport secrets
   enter errors or observability, no retries or policy registry are invented,
   and all application-owned identity, deployment, Rego, review, and recovery
   responsibilities remain outside the addon.

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

As part of the atomic H4-016 release, the package is releasable only when its main and testing exports match this
specification, package-boundary audits pass, package build/typecheck/tests and
coverage pass, the consumer example passes, generated API pages resolve, the
full Handbook build/link/knowledge/skill audits pass, and the canonical skill
mirrors are synchronized.

## Standards and cross-references

- [OPA REST API: execute a simple query](https://www.openpolicyagent.org/docs/rest-api#execute-a-simple-query)
  defines the `POST /v1/data/{path}` input/result envelope and optional
  `decision_id` used here; reviewed 2026-09-05.
- The hermetic real-OPA example and CI fixture use OPA 1.17.0 from
  `docker.io/openpolicyagent/opa@sha256:3c6e9e4d433b6e94df424c3385134312a95042aa991cdfc8e01944115675fb9d`,
  verify `opa version` before tests, load only the repository policy fixture,
  bind a random loopback host port, wait for the Health API, run allow/deny and
  undefined-decision cases, and always remove the container. Deterministic unit
  tests continue to use `FakeOpaDataApi`; missing Docker skips only the separately
  reported real-OPA conformance job, never the package test gate.
- [W3C Trace Context Level 2](https://www.w3.org/TR/trace-context-2/)
  defines the evolving traceparent carrier; Core remains the one parser so the
  addon does not freeze an outdated flag interpretation.
- [42-composable-definitions-and-catalogs](./42-composable-definitions-and-catalogs.md)
  owns the v4 governance helper, trace normalizer, effects-derived durability,
  immutable graph, and atomic release boundary.
