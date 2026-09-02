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

The key integration point is `.governance(({ native, rule }) => ...)` in
`src/index.ts`. The `rule(...)` helper receives the typed `transfer_funds` tool input, so policy
predicates can use `input.from`, `input.to`, and `input.amount` without manual
casts. Account balances remain application-owned state: the policy reads the
balance from the same application-owned record as the handler, and the handler
rechecks it before mutating state. The model never supplies a trusted balance.

Governance also supports optional `exposureRule(...)` entries for hiding tools before a model step; this example keeps the model-facing tool set stable and demonstrates execution-time deny and approval policies.

When the approval rule matches, the first run returns a
`ToolApprovalInterrupt` containing the prepared tool input and safe demand
evidence. `runTransferScenario(...)` demonstrates the application side by
selecting a decision and resuming the same run with `ToolApprovalResume`.
Rejected approval is a recoverable tool denial. The default approval is only a
local demonstration; these balance mutations are not production payment
transactions or an application review store.

For input/tool/output rails and static permission approval in the same
interruption, run the [guardrails composition](../guardrails/README.md). For a
broader workflow business wait, use the [durable review example](../durable-human-review/README.md)
with application-owned action binding, claim, and receipt. Read the
[decision guide](../../docs/guides/decisions-and-approval.md) for cancellation,
safe evidence, and the absence of rollback or post-admission revocation.
