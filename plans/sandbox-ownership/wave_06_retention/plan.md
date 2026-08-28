# Wave 6 — Enforced workspace snapshot retention and bounded sweeps

## End-to-End Outcome

Make accepted quota/TTL settings real and keep pinned recovery state safe during bounded garbage collection.

## Implementation Order

TICKET-007 after TICKET-006: Enforced workspace snapshot retention and bounded sweeps.

## Slice Strategy

Deliver the named complete entrypoint/state/failure slice and its contract tests; no unrelated refactor.

## Isolation

Serial wave; preserve all unrelated dirty worktree content. Controller alone updates plan indexes.

## Status

Planned; promote only after prerequisite tickets are independently accepted. No runtime implementation is claimed.

## Operational Path Coverage

PATH-SOWN-BOUNDS, PATH-SOWN-ADMIN, PATH-SOWN-DURABLE. See canonical failure/recovery and operator proof in 04-verification.md.
