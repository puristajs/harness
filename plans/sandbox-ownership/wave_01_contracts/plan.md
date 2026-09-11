# Wave 1 — Closed ownership and administration contract foundation

## End-to-End Outcome

Create strict source-derived DTO schemas and error classes that compile without replacing the live port yet.

## Implementation Order

TICKET-001 after spec/plan gate: Closed ownership and administration contract foundation.

## Slice Strategy

Approved foundation exception; direct schema/catalog tests give a working isolated increment, not a release. Next vertical integration is the atomic base-port cutover.

## Isolation

Serial wave; preserve all unrelated dirty worktree content. Controller alone updates plan indexes.

## Status

TICKET-001 remediations are implemented and awaiting follow-up independent review.

## Operational Path Coverage

PATH-SOWN-OWNER, PATH-SOWN-SAFETY, PATH-SOWN-DELIVERY. See canonical failure/recovery and operator proof in 04-verification.md.
