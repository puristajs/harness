# Content decisions, approval, and durable review

Use the boundary that owns the decision. Content protection, permission to run
a tool, and a review that survives a process restart are separate concerns.

| Boundary | Result | Owner and effect |
| --- | --- | --- |
| Content rail | `allow`, `block`, or a phase-specific `transform` | Guardrails inspect or replace content; a block stops the protected path. |
| Builtin permission | `allow`, `deny`, `require_approval` | The agent limits `bash`, `write`, and `edit`; an approval demand uses the shared governance provider. |
| Execution policy | `allow`, `deny`, `audit`, `require_approval` | Governance checks a prepared tool occurrence; precedence is deny, approval, audit, allow. |
| Immediate approval | `approved`, `rejected` | One `governance.approval.request` callback decides the exact occurrence within its deadline. |
| Durable review | `ExternalWaitOutcome` plus an application execution claim | Harness checkpoints and signals; the application owns reviewers, authorization, binding, claim, and receipt. |

Tool exposure is a separate pre-model `expose`/`hide` policy. It narrows the
agent's configured tool set, never grants additional capabilities.

## Start with the runnable composition

The credential-free [guardrails example](../../examples/guardrails/README.md)
composes input, tool-input, tool-output, and final-output rails on one agent.
Its two TypeScript tools demonstrate `toolId`-correlated policy input. A
`write: 'require_approval'` permission and a governance rule both use the same
approval provider. The write occurrence carries both demands in one request;
the provider is called once for that occurrence, not once per demand.

Read its [tested source](../../examples/guardrails/src/index.ts) alongside the
[failure and cancellation tests](../../examples/guardrails/src/index.test.ts).
The [bank example](../../examples/bank-governance/README.md) concentrates on
immediate approval and policy denial. The
[durable review example](../../examples/durable-human-review/README.md)
concentrates on wait, claim, and receipt recovery. No rail block requests an
approval or suspends a workflow.

## What happens before an effect

1. The agent parses its input, then runs input rails before instructions or
   model messages are constructed. A transformed input is validated again.
2. `prepareStep`, exposure, and `beforeModel` determine the current request.
   Protected tool-call/result groups and provider continuation cannot be
   modified, duplicated, or left incomplete by transcript replacements.
3. A successful provider invocation emits `model.completed`. `afterModel`
   permits only allow/block; it cannot rewrite a provider response.
4. For a tool turn, every call is canonicalized and preflighted in provider
   order before any approval or handler starts. Tool-input rails replace the
   effective wire arguments. The binding then parses those arguments exactly
   once, including builtin defaults or MCP's input adapter and upstream schema.
5. Each prepared call enters permission and policy checks, then any required
   approval. Approval and handler code receive the same frozen parsed input.
   Only an admitted call starts its handler. Independent calls execute within
   the configured concurrency limit; one sibling may already be running when
   another awaits approval or fails.
6. The handler result passes its output schema before tool-output rails create
   the presentation sent to the model. A presentation transform cannot undo an
   external effect. Tool results retain provider order in the next request.
7. Only a final candidate enters `beforeOutput` and output rails, then final
   output validation and persistence. Intermediate tool-turn objects do not
   run output rails, including when they are `null`.

Effective wire arguments remain in the canonical assistant tool call. Parsed
input can differ because of schema defaults, coercions, or adapters; do not
reparse it in a policy or approval callback. Treat callback values as read-only
and return an explicit phase replacement instead of mutating them in place.

## Approval callback contract

`request(request, execution)` receives `{ approvalId, subject, demands }` and
`{ signal, deadline }`. `subject` identifies one tool occurrence and contains
its parsed `input`; `demands` contains only safe `DecisionEvidence` values.
Keep the correlated subject or policy context together and narrow on `toolId`
before using tool-specific input fields. The example's native multi-tool rule
is checked by TypeScript against both tool schemas.

Return exactly `{ decision: 'approved' | 'rejected', reasonCode? }`. Approval
cannot modify arguments, override a denial, grant another call, or authorize a
later replay. Missing approval configuration denies a required approval.
Permission and policy denials, including rejected approval, are recoverable
tool errors: the model can receive the denial and answer without that effect.
Malformed results, thrown callbacks, invalid transforms, and decision timeouts
fail the protected run closed rather than asking the model to repair them.

## Deadlines and cancellation

`defaults.decisionTimeoutMs` is a positive safe integer, defaulting to 10,000.
Each callback receives a linked `signal` and an absolute epoch-millisecond
`deadline`, bounded by the earliest remaining run/tool budget and its own
decision budget. Forward both to external reviewers or policy clients.
`toolTimeoutMs` covers preflight, waiting for execution, policy, approval,
handler, and output hooks; it is not restarted after approval.

Honor `signal` before effects and during long work. Harness stops waiting for
an uncooperative callback when its budget expires, but cannot kill external
work or roll back an admitted effect. Parent cancellation and timeout remain
`OperationCancelledError` and `OperationTimeoutError`; a decision's own timeout
is `DecisionEvaluationError` with `failureKind: 'callback_timeout'`.
There is no post-admission revocation or transaction guarantee across tools.

## Safe evidence and observability

`DecisionEvidence` has exactly `decisionId`, `source`, `phase`, and optional
`reasonCode`. `source` has `kind`, `id`, and optional `version`/`ruleId`.
Harness derives `decisionId` from invocation, phase, source, and configured
ordinal; applications do not assign it in callback results. IDs must be stable
configuration/correlation identifiers, never prompts or matched text.

Use deployment-defined reason codes matching `^[a-z][a-z0-9_]{0,63}$`, such as
`note_review` or `secret_redacted`. Do not interpolate input, reviewer comments,
names, credentials, or provider errors into codes. Approval subjects are
transient sensitive input; they are not audit records. Persist reviewer
identity and review content only in appropriately protected application
storage. Policy/approval events, audit records, and normalized decision errors
contain safe evidence rather than that subject. Do not add raw callback errors
as public causes or metadata.

Use `DecisionBlockedError` for a content block and `DecisionEvaluationError`
for a failed decision. Rail-owned evidence keeps `source.kind: 'guardrail'`
even through an attached interceptor. An expected block is a successful rail
evaluation span; callback failures/timeouts are errors.

`model.completed` alone supplies generative model-call/token accounting across
text, object, direct, nested, and fully consumed stream calls. A completion
remains counted if a later rail blocks its content. Failed attempts and streams
that fail after a finish chunk are not completed invocations. Content events
(`model.message`, `model.object`, deltas) are presentation, not another billing
or call-count source. Embedding/rerank completion events keep their own counts.

## Durable review and recovery

Use [external waits](./human-review-gates.md) when the decision must outlive
the immediate callback budget. Harness stores only the safe wait descriptor
and terminal `approved`, `rejected`, `expired`, or `cancelled` outcome. It does
not own review-task CRUD or approval content.

The application binds approval to the exact action digest and revision. Before
a **new** execution claim, check authorization, expiry, and current revision,
then atomically claim that binding. An existing claim or completed receipt
resumes the same execution key; do not apply new authorization or expiry checks
that strand recovery after an effect. Invoke the domain command idempotently,
persist its receipt, and return the stored receipt on replay. A signal alone
does not authorize or prove execution.

When a review decision crosses a queue, webhook, or separately operated review
service, authenticate the transport and use a versioned signed envelope for the
stable binding fields: event/wait IDs, outcome, review revision, action digest,
definition version, issuer, audience, issue/expiry time, and key ID. Verify that
envelope before the application's revision compare-and-swap and before
`signalWait(...)`. Keep proposal text, tool arguments, reviewer comments, and
credentials out of it. A signature authenticates delivery; it does not replace
reviewer authorization, action binding, compare-and-swap, or execution
idempotency. An authenticated direct internal call can instead rely on the
platform service identity and durable audit record when the threat model permits.

## External policy engines

Harness ships the optional `@purista/harness-policy-opa` package for OPA's
stable Data API. The governance builder's `adapter(...)` helper by itself still
performs no I/O; `opaPolicy(helpers, ...)` uses it as an inference anchor and
adds the focused transport, validation, and mapping boundary.

```ts
import { createOpaClient, opaPolicy } from '@purista/harness-policy-opa'

const client = createOpaClient({ baseUrl: process.env.OPA_URL! })

.governance((helpers) => ({
  defaultEffect: 'deny',
  policies: [opaPolicy(helpers, {
    id: 'transfer-policy',
    client,
    decisionPath: ['purista', 'bank', 'transfer', 'decision'],
    mapInput: (ctx) => ctx.toolId === 'transfer_funds'
      ? { amount: ctx.input.amount, destination: ctx.input.destination }
      : undefined,
    resultSchema: opaResultSchema,
    mapDecision: (result) => result.matched
      ? {
          effect: result.effect,
          ...(result.ruleId === undefined ? {} : { ruleId: result.ruleId }),
          ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
        }
      : undefined,
  })],
}))
```

The package owns the fixed URL and encoded path, one-attempt request, linked
signal/deadline, streaming byte bound, Data API envelope, undefined-document
semantics, and content-free failures. The application owns authenticated
identity, the least-data input mapping, strict result schema/decision mapping,
credentials, Rego/bundles, rollout, availability, and OPA decision-log policy.
When registered through `opaPolicy(...)`, the client also inherits the active
Harness OpenTelemetry context and forwards only the W3C `traceparent` header to
that fixed trusted OPA endpoint. Policy evaluation emits a content-free
`harness.policy.evaluate` guardrail span plus outcome metrics; it never exports
policy input, result, URL, headers, or credentials. Do not add trace headers
from tool or model input.
Use the [maintained example](../../examples/opa-governance/README.md) for the
complete real-engine and fake-driven paths.

Choose the engine topology before extracting reusable code:

| Policy system | Integration boundary | Good reusable package boundary |
| --- | --- | --- |
| OPA | Named decision through the stable Data API | First-party `@purista/harness-policy-opa`; application-owned identity, input/result mapping, credentials, bundles, and operations |
| Embedded Cedar | One selected in-process Cedar runtime | That runtime's policy/schema loading and authorizer lifecycle |
| AWS Verified Permissions | AWS `IsAuthorized` against a policy store | AWS client invocation and response normalization |
| Custom service | Application-defined local or remote contract | Usually application code; keep its request and result schema explicit |

The application always owns authenticated principal/resource resolution,
minimal request mapping, strict decision mapping, credentials, policy rollout,
and selected-engine integration tests. Cedar is an authorization language and
request model, not one generic network endpoint, so embedded Cedar and AWS
Verified Permissions are separate adapters. Avoid a generic arbitrary-endpoint
policy client: it saves little mapping work while widening credential and SSRF
risk.

## Coverage limits

Attached rails protect default-loop agents. Direct `ctx.models.*` calls and
custom-handler agents are outside automatic rail coverage. Retrieval is
application-owned and needs an explicit `filterRetrievedChunks` call. Opaque
provider reasoning is continuation state, not inspectable text; rails cannot
scan or rewrite it. Provider adapters reconstruct tool-call slots from the
canonical transformed arguments rather than replaying an old argument blob.
Keep application authentication, tenancy, rate limits, and final domain
authorization at their existing boundaries.
