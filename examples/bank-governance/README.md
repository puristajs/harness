# Bank Governance Example

This example demonstrates the optional harness governance layer with a small bank-transfer flow.

Rules:

- Transfers above `1_000` require approval.
- Transfers above `10_000` are denied.
- Transfers where the source balance is lower than the amount are denied.

The example uses a scripted local model provider, so it does not need provider keys.

```bash
npm run test --workspace @purista/bank-governance-example
npm run start --workspace @purista/bank-governance-example
```

The key integration point is `.governance(({ native, rule }) => ...)` in `src/index.ts`. The `rule(...)` helper receives the typed `transfer_funds` tool input, so policy predicates can use `input.amount` and `input.balance` without manual casts.

Governance also supports optional `exposureRule(...)` entries for hiding tools before a model step; this example keeps the model-facing tool set stable and demonstrates execution-time deny and approval policies.
