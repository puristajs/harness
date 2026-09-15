# Wave 4 — Typed sharing policies for agents workflows and child tasks

## End-to-End Outcome

Let applications configure inherited private or named-group files without changing history or adapter topology.

## Implementation Order

TICKET-005 after TICKET-004: Typed sharing policies for agents workflows and child tasks.

## Slice Strategy

Deliver the named complete entrypoint/state/failure slice and its contract tests; no unrelated refactor.

## Isolation

Serial wave; preserve all unrelated dirty worktree content. Controller alone updates plan indexes.

## Status

Planned; promote only after prerequisite tickets are independently accepted. No runtime implementation is claimed.

## Operational Path Coverage

PATH-SOWN-POLICY, PATH-SOWN-OWNER. See canonical failure/recovery and operator proof in 04-verification.md.
