# Decision boundaries: breaking changes

The current public contract has one bounded decision lifecycle and separate
owners for content, tool authority, and durable review. There are no legacy
hooks, compatibility aliases, or alternate result readers.

- Builtin permissions use `allow`, `deny`, or `require_approval`. Every
  immediate approval uses `governance.approval.request(request, execution)`.
- Approval requests contain `approvalId`, correlated `subject`, and safe
  `demands`; results contain `decision: 'approved' | 'rejected'` and optional
  `reasonCode`. Policy results contain `effect`, optional `reasonCode`/`ruleId`.
- Rail actions declare their phase. Content blocks and evaluation failures use
  shared `DecisionBlockedError`/`DecisionEvaluationError` evidence. `afterModel`
  only allows or blocks; final content transforms belong in `beforeOutput`.
- Provider adapters use canonical `providerContinuation` slots. Tool-input
  transforms cannot leave stale provider argument copies in the next request.
- `model.completed` is the generative model usage/count event. Presentation
  events no longer double as accounting records.
- Durable external-wait outcomes remain separate from application review
  content and execution claim/receipt state.

See the [current developer journey](../guides/decisions-and-approval.md) and its
tested examples for supported usage.
