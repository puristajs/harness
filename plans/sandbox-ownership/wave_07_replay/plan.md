# Wave 7 — Replay-safe terminal disposal for agent and workflow invocations

## End-to-End Outcome

Return retained terminal receipts after compute deletion and preserve compute for retryable or suspended work.

## Implementation Order

TICKET-008 after TICKET-007: Replay-safe terminal disposal for agent and workflow invocations.

## Slice Strategy

Deliver the named complete entrypoint/state/failure slice and its contract tests; no unrelated refactor.

## Isolation

Serial wave; preserve all unrelated dirty worktree content. Controller alone updates plan indexes.

## Status

Planned; promote only after prerequisite tickets are independently accepted. No runtime implementation is claimed.

## Operational Path Coverage

PATH-SOWN-OWNER, PATH-SOWN-PURISTA, PATH-SOWN-DURABLE. See canonical failure/recovery and operator proof in 04-verification.md.
