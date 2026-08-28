# Bank Governance Example

This example demonstrates the optional harness governance layer with a small bank-transfer flow.

Rules:

- Transfers above `1_000` require approval.
- Transfers above `10_000` are denied.
- Transfers where the source balance is lower than the amount are denied.

The example uses a scripted local model provider, so it does not need provider keys.

```bash
npm run test --workspace @purista/bank-governance-example
npm run typecheck --workspace @purista/bank-governance-example
npm run build --workspace @purista/bank-governance-example
npm run start --workspace @purista/bank-governance-example
```

The key integration point is `.governance(({ native, rule }) => ...)` in `src/index.ts`. The `rule(...)` helper receives the typed `transfer_funds` tool input, so policy predicates can use `input.amount` and `input.balance` without manual casts.

Governance also supports optional `exposureRule(...)` entries for hiding tools before a model step; this example keeps the model-facing tool set stable and demonstrates execution-time deny and approval policies.

The one approval provider receives the frozen parsed tool input inside
`request.subject`, safe demand evidence, and a separate bounded signal/deadline.
It returns approved/rejected with a stable `reasonCode`; rejected approval is a
recoverable tool denial, not a content-rail block. The default auto-approval is
only a local demonstration. These balance mutations are not production payment
transactions or a durable review store.

For input/tool/output rails and static permission approval using that same
provider, run the [guardrails composition](../guardrails/README.md). For review
that outlives a callback, use the [durable review example](../durable-human-review/README.md)
with application-owned action binding, claim, and receipt. Read the
[decision guide](../../docs/guides/decisions-and-approval.md) for cancellation,
safe evidence, and the absence of rollback or post-admission revocation.
