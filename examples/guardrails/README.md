# Guardrails and tool approval

This local example composes content rails and governance on one default-loop
agent. It uses `FakeModelProvider`, an in-memory sandbox, and synthetic data;
no credentials or network access are required.

From this example directory:

```sh title="Verify and run the composition"
npm install
npm test
npm run typecheck
npm run build
npm start
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
  `visibility: 'internal'`; policy, approval request, and handler share this parsed input.
- A native multi-tool rule narrows `ctx.input` through `ctx.toolId` without
  casts or duplicate schemas.
- `publish_note` needs policy approval. Builtin `write` needs both static
  permission and policy approval. Harness combines the prepared calls in one
  durable `ToolApprovalInterrupt` before either gated handler starts.
- Tool-output rails replace the validated private status with a public
  presentation. Final-output rails redact only the final candidate.

Change the existing `actions`, tool schemas/handlers, and native rules to fit
your application. `runSupportRequest(...)` shows the application boundary: it
receives the interrupted outcome, selects typed decisions, and resumes the same
run. A real application persists the interrupt and authenticates, authorizes,
and records the reviewer before resuming. The recorded requests and lifecycle
are synthetic test observations, not a model for production logging.

## Failure and recovery boundaries

The [tests](src/index.test.ts) verify all preflight hooks run before dispatch,
the stable interrupt contains parsed defaults, content blocking never requests
approval, rejection does not execute the tool, and cancellation stays safe.
Rejection becomes a recoverable tool denial and the fake model can still answer;
it does not prove that the requested effect happened.

Other admitted tools can already be executing when a sibling is rejected or
cancelled. Neither a tool-output rail nor a later decision rolls back effects.
The synthetic publication list and sandbox file are not durable business state.

Use the [bank example](../bank-governance/README.md) for focused tool
approval, and the [durable review example](../durable-human-review/README.md)
for application-owned wait/claim/receipt recovery. A rail block is neither an
approval request nor durable suspension. The complete
[decision guide](../../docs/guides/decisions-and-approval.md) covers safe evidence,
direct-call and opaque-reasoning limits, and deadlines.
