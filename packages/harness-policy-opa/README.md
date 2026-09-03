# `@purista/harness-policy-opa`

Typed, fail-closed Open Policy Agent (OPA) Data API governance for
`@purista/harness`.

Use this package when an agent tool call must be checked by an OPA decision
before its handler starts. It works with the same API whether OPA runs as a
local process, sidecar, Kubernetes service, service-mesh destination, or hosted
internal service. The package does not load Rego or bundles and does not turn
model/tool input into authenticated identity.

## Install

```sh
npm install @purista/harness @purista/harness-policy-opa zod
```

No OPA JavaScript SDK is required. Run and operate OPA separately.

## Minimum typed policy

```ts
import { defineHarness } from '@purista/harness'
import { createOpaClient, opaPolicy } from '@purista/harness-policy-opa'
import { z } from 'zod'

const client = createOpaClient({
  baseUrl: process.env.OPA_URL ?? 'http://127.0.0.1:8181',
})

const opaResult = z.object({
  matched: z.boolean(),
  effect: z.enum(['allow', 'deny', 'audit', 'require_approval']),
  ruleId: z.string().optional(),
  reasonCode: z.string().regex(/^[a-z0-9_.-]{1,128}$/).optional(),
})

const harness = defineHarness()
  .tool('transfer_funds', {
      description: 'Transfer funds.',
      input: z.object({ amount: z.number(), destination: z.string() }),
      output: z.object({ accepted: z.boolean() }),
      handler: async () => ({ accepted: true }),
  })
  .governance((helpers) => ({
    mode: 'enforce',
    defaultEffect: 'deny',
    policies: [
      opaPolicy(helpers, {
        id: 'transfer-policy',
        version: '2026-08-30',
        client,
        decisionPath: ['purista', 'bank', 'transfer', 'decision'],
        mapInput(context) {
          if (context.toolId !== 'transfer_funds') return undefined
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
            ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
          }
        },
      }),
    ],
  }))
  .build()
```

`helpers` is the type-inference anchor. After `toolId` is narrowed,
`context.input` is the exact validated input for that tool. `mapDecision`
receives the validated output of `resultSchema`. Returning `undefined` from
`mapInput` makes no network request. An OPA success response without `result`
also means the evaluator did not match, so `defaultEffect: 'deny'` remains the
safe enforcement default.

## Data API request

The client sends one request and never retries or follows redirects:

```http
POST /v1/data/purista/bank/transfer/decision
Content-Type: application/json

{"input":{"tool":"transfer_funds","amount":250,"destination":"acct_savings"}}
```

OPA returns a defined decision as:

```json
{
  "decision_id": "optional-opa-correlation-id",
  "result": {
    "matched": true,
    "effect": "allow",
    "ruleId": "opa_transfer_allow",
    "reasonCode": "policy_allow"
  }
}
```

The OPA `result` shape is application-owned. Validate it explicitly and map it
to Harness's closed `allow`, `deny`, `audit`, or `require_approval` effects.

When the client is registered through `opaPolicy(...)`, it inherits the active
Harness OpenTelemetry context and forwards only W3C `traceparent` to the fixed
trusted OPA endpoint. It never records policy input, results, URLs, headers,
or credentials in Harness telemetry.

## Client options

| Option | Default | Contract |
| --- | --- | --- |
| `baseUrl` | required | Fixed credential-free absolute HTTP(S) base URL; query and fragment are rejected. |
| `headers` | none | Static authorization/proxy headers. Transport headers and line breaks are rejected. |
| `fetch` | platform `fetch` | Inject only for deterministic tests or an application-owned transport wrapper. |
| `timeoutMs` | `10_000` | Positive safe integer; shortens an inherited Harness decision deadline. |
| `maxResponseBytes` | `262_144` | Positive safe integer, at most 4 MiB; enforced while streaming the body. |

`decisionPath` is a non-empty tuple of path segments. Segments are encoded
individually and cannot contain slashes, backslashes, control characters,
`.`/`..`, or more than 256 characters.

## Failure behavior

`OpaClientError` reports only a safe `kind` and, for non-success HTTP responses,
the numeric `status`. It never includes URL, headers, request input, response
body, schema issues, or the underlying transport message.

Client kinds are `aborted`, `deadline_exceeded`, `transport`, `http`,
`invalid_content_type`, `response_too_large`, and `malformed_response`.
Application mapping failures use `OpaPolicyError` with `input_mapping`,
`non_json_input`, `result_validation`, or `decision_mapping`.

Harness runs the evaluator inside its decision deadline and fails closed. The
adapter makes no retry because a second immediate policy evaluation can observe
a different bundle or data revision. Put availability and rollout controls in
the OPA deployment, and use Harness shadow mode deliberately before enforcing a
new policy.

## Deterministic tests

```ts
import { createOpaClient } from '@purista/harness-policy-opa'
import { FakeOpaDataApi } from '@purista/harness-policy-opa/testing'

const api = new FakeOpaDataApi()
api.enqueueDecision({ matched: true, effect: 'deny' })

const client = createOpaClient({
  baseUrl: 'https://opa.example.test/',
  fetch: api.fetch,
})

// Run the Harness scenario, then prove the exact minimized request.
api.assertExhausted()
```

The fake is strict and does not evaluate Rego. Use it for Harness control-flow,
input-mapping, response-validation, and handler-suppression tests. Separately
run selected policy cases against the real OPA version and bundles you deploy.

## Production ownership

- Keep `baseUrl`, headers, and decision paths in trusted composition-root
  configuration. Never derive them from prompts, tool arguments, tenant input,
  or model output.
- Use TLS/mTLS, workload identity, and egress/network policy appropriate to the
  topology. A service mesh may own credentials without adapter headers.
- Resolve authenticated principal, tenant, action, and resource data before the
  policy mapping. Model or tool input is only a proposal.
- Send the minimum input needed. OPA decision logs can contain input and result;
  configure masking, retention, and access controls in OPA.
- Gate startup/readiness on OPA health and, when used, bundle/plugin readiness.
  Runtime failures still remain fail closed.
- Durable human review and uncertain side effects need an application-owned
  review queue, resume flow, action digest, claim, and receipt. This package is
  an immediate policy evaluator, not a workflow system.

Cedar is intentionally separate. Embedded Cedar and AWS Verified Permissions
have different clients, policy/entity lifecycles, credentials, and operational
topologies; use a focused application-owned `GovernancePolicyEvaluator` until a
specific first-party adapter exists.

See the [maintained OPA governance example](../../examples/opa-governance/README.md),
the [PURISTA Handbook guide](https://purista.dev/handbook/harness/secure-and-govern/governance-policies/connect-external-policy-engine/),
the [OPA REST API](https://www.openpolicyagent.org/docs/rest-api), and
[OPA decision logs](https://www.openpolicyagent.org/docs/management-decision-logs).
