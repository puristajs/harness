# Durable human review reference

This executable reference uses Harness external waits to pause a durable workflow;
the application owns every review and payment decision around that primitive.
Harness stores only the safe wait request, terminal signal, run lease, and durable
step checkpoints. It does not know reviewer identities, comments, authorization,
payment policy, action payloads, claims, or receipts.

This is separate from bounded `governance.approval` and content rails. Start
with the [decision table](../../docs/guides/decisions-and-approval.md), use the
[guardrails composition](../guardrails/README.md) for one immediate approval
path, and keep durable review state in this application's claim/receipt store.

`ReviewTaskStore` is an intentionally small, application-owned reference store. It
creates an immutable `PaymentAction` and descriptor once, with a frozen expiry and
bounded opaque business/session/run/wait identities. A reviewer-facing application
authenticates and authorizes a principal before calling `decide(...)`, writes the
decision through its own transactional/outbox boundary, then sends the terminal
`signalWait(...)` event. The workflow never awaits a human callback.

On resume, the workflow binds the invocation action to the immutable task before
entering a replayable step. An approved wait is insufficient to execute: the step
reads or atomically creates one `ExecutionRecord`, runs application authorization
and resource-revision checks only for a new claim, executes with the durable run ID
as its idempotency key, and records one receipt. Existing claims and receipts replay
with the same action and key even if expiry, policy, or revision services later
change or fail. A lost application task fails closed; it is never reconstructed from
the Harness wait record.

The in-memory store and executor are deterministic test references. Replace both
with transactional PURISTA services in production. Keep review task retention,
reviewer authorization, decision audit, notification/outbox delivery, execution
reconciliation, and receipts in those application services. Do not promote this
domain state into Harness.

Run the focused checks from the repository root:

```sh
npm test --workspace @purista/durable-human-review-example
npm run typecheck --workspace @purista/durable-human-review-example
```

For a local restart demo, provide a durable `HarnessStorage` and an application
store that retain their data together. The included contract tests exercise crash
windows after an executor effect, after a receipt write, and after the durable step
checkpoint; all retries retain one execution identity and one logical effect.
