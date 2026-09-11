# Wave 3 — Atomic Sandbox port and lazy implicit-owner cutover

## End-to-End Outcome

Replace the existing base port and all direct callers together, including lazy
session ownership. Owner disposal and workspace cleanup remain in their
dedicated replay/durable slices; this wave must not duplicate them.

## Implementation Order

TICKET-004 after TICKET-002, TICKET-003, TICKET-013, TICKET-014: Atomic Sandbox
port and lazy implicit-owner cutover.

## Slice Strategy

Approved atomic source/caller cutover with explicit internal phase gates; no half-interface release.

## Isolation

Serial wave; preserve all unrelated dirty worktree content. Controller alone updates plan indexes.

## Status

Planned; promote only after prerequisite tickets are independently accepted. No runtime implementation is claimed.

## Operational Path Coverage

PATH-SOWN-OWNER, PATH-SOWN-ADMIN, PATH-SOWN-DELIVERY. See canonical failure/recovery and operator proof in 04-verification.md.
