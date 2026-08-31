# Guardrails and one approval path

This local example composes content rails and governance on one default-loop
agent. It uses `FakeModelProvider`, an in-memory sandbox, and synthetic data;
no credentials or network access are required.

From the repository root:

```sh title="Verify and run the composition"
npm test --workspace @purista/guardrails-example
npm run typecheck --workspace @purista/guardrails-example
npm run build --workspace @purista/guardrails-example
npm start --workspace @purista/guardrails-example
```

Expected output: `The [redacted] answer.`

## Follow the source

[`createGuardrailsExample`](src/index.ts) owns the composition. Its first fake
model turn requests `lookup_status`, `publish_note`, and builtin `write`; its
second returns the final answer. The registered `assistant` alias resolves to
that fake provider, and rail flow names resolve to the declared action map.

- Input rails replace `[secret]` and mask the synthetic `[email]` marker before
  instructions or provider input are built; `[blocked]` stops the run before a
  model or approval call. These markers and the detector are example fixtures,
  not a production email detector.
- Tool-input rails redact a note's wire arguments. The tool schema then adds
  `visibility: 'internal'`; policy, approval, and handler share this parsed input.
- A native multi-tool rule narrows `ctx.input` through `ctx.toolId` without
  casts or duplicate schemas.
- `publish_note` needs policy approval. Builtin `write` needs both static
  permission and policy approval, collected into one request for that call.
  Both use the single `governance.approval` provider.
- Tool-output rails replace the validated private status with a public
  presentation. Final-output rails redact only the final candidate.

Change the existing `actions`, tool schemas/handlers, and native rules to fit
your application. Replace the example's automatically approving provider with
your reviewer adapter; forward the supplied `execution.signal` and
`execution.deadline`. The factory's optional `approval` lets tests inject
rejection, callback failure, timeout, or cancellation without a second harness.
The recorded requests/lifecycle are synthetic test observations, not a model
for production logging. Never log an approval subject's input.

## Failure and recovery boundaries

The [tests](src/index.test.ts) verify all preflight hooks run before dispatch,
one request per approval occurrence, parsed defaults, safe callback errors,
content blocking, rejection, timeout, and cancellation. Rejection becomes a recoverable tool
denial and the fake model still answers; it does not prove that the requested
effect happened. Callback failure/timeout fails the run closed.

Other admitted tools can already be executing when a sibling is rejected or
cancelled. Neither a tool-output rail nor a later decision rolls back effects.
The synthetic publication list and sandbox file are not durable business state.

Use the [bank example](../bank-governance/README.md) for focused immediate
approval, and the [durable review example](../durable-human-review/README.md)
for application-owned wait/claim/receipt recovery. A rail block is neither an
approval request nor durable suspension. The complete
[decision guide](../../docs/guides/decisions-and-approval.md) covers safe evidence,
direct-call and opaque-reasoning limits, and deadlines.
