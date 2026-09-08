# Decision boundaries

The current public contract has one bounded decision lifecycle and separate
owners for content, tool authority, and durable review.

- Builtin permissions use `allow`, `deny`, or `require_approval`. Permission and
  policy demands are combined in one durable `ToolApprovalInterrupt`.
- The application persists and authorizes the review, then continues the same
  checkpoint with a `ToolApprovalResume`.
- Guardrail actions declare their exact input, output, tool-input, tool-output,
  or retrieval phase. Content blocks and evaluation failures use shared
  `DecisionBlockedError`/`DecisionEvaluationError` evidence.
- Provider adapters use canonical `providerContinuation` slots. Tool-input
  transforms cannot leave stale provider argument copies in the next request.
- `model.completed` is the generative model usage/count event. Presentation
  events carry updates rather than accounting totals.
- Durable external-wait outcomes remain separate from application review
  content and execution claim/receipt state.

See the [current developer journey](../guides/decisions-and-approval.md) and its
tested examples for supported usage.
