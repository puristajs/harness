# Wave 5 — Aggregate durable partitions checkpoint pins and terminal lifecycle

## End-to-End Outcome

Recover all private/shared run partitions from one committed workspace without unsafe cross-run rollback.

## Implementation Order

TICKET-006 after TICKET-005: Aggregate durable partitions checkpoint pins and terminal lifecycle.

## Slice Strategy

Deliver the named complete entrypoint/state/failure slice and its contract tests; no unrelated refactor.

## Isolation

Serial wave; preserve all unrelated dirty worktree content. Controller alone updates plan indexes.

## Status

Planned; promote only after prerequisite tickets are independently accepted. No runtime implementation is claimed.

## Operational Path Coverage

PATH-SOWN-DURABLE, PATH-SOWN-OWNER, PATH-SOWN-BOUNDS. See canonical failure/recovery and operator proof in 04-verification.md.
