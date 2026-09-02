# Content decisions, tool approval, and workflow review

Use the boundary that owns the decision. Content protection, permission to run
a prepared tool call, and a workflow wait for a business event are separate
concerns.

| Boundary | Result | Owner and effect |
| --- | --- | --- |
| Content rail | `allow`, `block`, or a phase-specific `transform` | Guardrails inspect or replace content; a block stops the protected path. |
| Built-in permission | `allow`, `deny`, `require_approval` | The agent limits `bash`, `write`, and `edit`. |
| Execution policy | `allow`, `deny`, `audit`, `require_approval` | Governance checks a prepared tool occurrence; precedence is deny, approval, audit, allow. |
| Tool approval | `ToolApprovalInterrupt`, then `ToolApprovalResume` | Harness checkpoints the exact prepared batch; the application owns reviewer authentication, authorization, expiry, and review records. |
| Workflow business wait | `ExternalWaitOutcome` plus an application execution claim | Harness checkpoints and signals; the application owns business state, action binding, claims, and receipts. |

Tool exposure is a separate pre-model `expose`/`hide` policy. It narrows the
agent's configured tool set and never grants an additional capability.

## Start with the runnable examples

The credential-free [guardrails example](../../examples/guardrails/README.md)
composes input, tool-input, tool-output, and final-output rails with tool
approval. The [bank example](../../examples/bank-governance/README.md) focuses
on a typed approval rule and hard denial. The
[durable review example](../../examples/durable-human-review/README.md) uses a
workflow external wait, action claim, and receipt. A content block never asks
for approval, and a tool approval interrupt is not a general workflow wait.

## Follow one protected tool batch

1. Harness parses agent input and runs input rails.
2. `prepareStep`, exposure, and `beforeModel` determine the provider request.
3. The provider proposes one or more tool calls.
4. Harness canonicalizes and preflights every call before any handler starts.
   Tool-input rails produce the effective wire arguments, then the binding
   parses them once.
5. Permissions and governance inspect the prepared, typed occurrences. A deny
   becomes a safe tool denial. If any occurrence requires approval, Harness
   checkpoints the whole batch and returns one `ToolApprovalInterrupt` before
   a gated handler runs.
6. The application persists the interrupt, authenticates and authorizes the
   reviewer, and resumes the same run with a `ToolApprovalResume`.
7. Harness validates the run, interrupt id, revision, event id, and exact
   decision set. It continues from the checkpoint without repeating the model
   turn. Approved calls execute; rejected calls become tool results for the
   model.
8. Handler output passes its schema and tool-output rails. Only a final answer
   candidate enters output rails and final output validation.

An admitted sibling tool may already be running when another call is denied.
No later rail or policy can roll back an external effect. Keep handlers
idempotent and authorize business actions from trusted application state.

## Handle and resume a tool approval

Both `run(...)` and `stream(...)` use the same provider-neutral outcome. A
stream delivers it through its terminal `run.finished` event.

```ts
const first = await session.agents.banker.run(input)

if (first.status === 'interrupted' && first.interrupt.type === 'tool-approval') {
  await reviewRepository.create({
    runId: first.runId,
    interruptId: first.interrupt.id,
    revision: first.interrupt.revision,
    requests: first.interrupt.requests,
    tenantId,
    expiresAt,
  })

  const request = first.interrupt.requests[0]
  if (!request) throw new Error('Expected an approval request')

  const outcome = await session.agents.banker.run(input, {
    resume: {
      type: 'tool-approval',
      runId: first.runId,
      interruptId: first.interrupt.id,
      revision: first.interrupt.revision,
      eventId: reviewDecision.id,
      decisions: [{
        approvalId: request.approvalId,
        approved: reviewDecision.approved,
        reason: reviewDecision.reason,
      }],
    },
  })
}
```

Each `ToolApprovalRequest` identifies one tool occurrence and contains its
effective JSON input plus content-free permission and policy evidence. Treat
that input as untrusted proposal data. The application must bind the review to
the authenticated tenant and principal, check the current business resource,
enforce expiry, and store reviewer identity and comments outside Harness.

Use a unique, stable `eventId` for the review decision. Replaying the same
decision is idempotent. A stale revision, changed decision set, or decision for
another run fails closed. `ToolApprovalPendingError` is private runtime control
flow and must not be caught or exposed as an application error.

## Serve standard browser clients

`@purista/harness-ai-sdk-ui/v1` maps `ExecutionEvent` values to AI SDK UI
Message Stream v1, including status, tool calls, approval requests, and final
completion. It also parses approval responses back into a typed
`ToolApprovalResume`. Keep this projection at the HTTP adapter boundary so
agents, workflows, checkpoints, and application review storage do not depend on
one browser protocol version.

AI Elements can render the standard message parts with AI SDK's `useChat`.
Neither Harness nor PURISTA requires a custom browser SDK.

## Keep decision callbacks bounded

`defaults.decisionTimeoutMs` bounds governance evaluators, audit sinks, and
Guardrail actions. Each receives a linked `signal` and absolute `deadline`.
Forward both to remote policy engines or detectors. Tool approval does not hold
an in-process callback open: it returns a durable interruption and releases the
active invocation.

Provider, tool, run, and transport deadlines still apply after resume. Harness
cannot cancel work that an external system already accepted, so use
idempotency, reconciliation, or compensation for side effects.

## Record safe evidence

`DecisionEvidence` contains `decisionId`, `source`, `phase`, and optional
`reasonCode`. Harness derives occurrence identity. Use stable, content-free
reason codes such as `large_transfer`; never place prompts, arguments,
credentials, matched text, reviewer comments, or raw errors in evidence,
events, logs, or metric labels.

Approval requests contain sensitive proposed input because the reviewer needs
to understand the action. Store them only in protected application review
storage with an explicit retention policy. Reviewer identity and the final
authorization record also belong to the application.

## Use workflow waits for broader business review

Use [external waits](./human-review-gates.md) when a workflow waits for a
business event that is not the approval of one prepared model tool batch.
Harness stores the safe wait descriptor and terminal `approved`, `rejected`,
`expired`, or `cancelled` outcome. The application binds the approved action,
atomically claims execution, uses a stable idempotency key, and stores a receipt.

When a decision crosses a queue, webhook, or separately operated review
service, authenticate the transport and use a versioned signed envelope for
stable binding fields. A signature authenticates delivery; it does not replace
reviewer authorization, action binding, compare-and-swap, or execution
idempotency.

## Connect an external policy engine

Harness ships `@purista/harness-policy-opa` for OPA's stable Data API. The
builder's `adapter(...)` helper performs no I/O; `opaPolicy(...)` supplies the
transport and preserves typed mapping.

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
      ? { effect: result.effect, ruleId: result.ruleId, reasonCode: result.reasonCode }
      : undefined,
  })],
}))
```

The package owns fixed-endpoint transport, path encoding, cancellation,
bounded parsing, and Data API envelope handling. The application owns caller
identity, least-data request mapping, result validation, credentials, Rego and
bundles, rollout, availability, and decision-log policy. Cedar, AWS Verified
Permissions, and custom policy services retain focused application-owned
evaluators rather than a generic arbitrary-URL client.

## Know the coverage limits

Attached rails protect default-loop agents. Direct `ctx.models.*` calls and
custom-handler agents are outside automatic rail coverage. Retrieval is
application-owned and needs an explicit `filterRetrievedChunks(...)` call.
Opaque provider reasoning is continuation state, not inspectable text. Keep
application authentication, tenancy, rate limits, and final domain
authorization at their existing boundaries.
