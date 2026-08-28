# Feedback for TICKET-003

## Blocking Findings

- REVIEW-003-001: Post-barrier cancellation throws instead of returning `cleanup_pending`.
  - Spec refs: `02-administration.md#offboarding-and-purge`, `03-contracts/api.md#CTR-SOWN-ADMIN`.
  - Location: `packages/harness-sandbox-docker/src/administration.ts:56-65,113-116`.
  - Fix boundary: `administration.ts` and `administration.test.ts` only.
  - Required verification: Docker package test and typecheck.

- REVIEW-003-002: Catalog reservations cannot guarantee a later owner purge and a revoked unknown owner can consume unbounded catalog entries.
  - Spec refs: `02-administration.md#offboarding-and-purge`, `02-administration.md#bounds--dec-sown-bounds`.
  - Location: `packages/harness-sandbox-docker/src/ownership.ts:75-82,122-144,205-220`.
  - Fix boundary: `ownership.ts` and `ownership.test.ts` only.
  - Required verification: Docker package test and typecheck.

- REVIEW-003-003: The journal permits illegal lifecycle transitions, including resource resurrection after deletion.
  - Spec refs: `02-administration.md#inventory--dec-sown-admin`.
  - Location: `packages/harness-sandbox-docker/src/ownership.ts:110-120,167-174`.
  - Fix boundary: `ownership.ts` and `ownership.test.ts` only.
  - Required verification: Docker package test and typecheck.

## Advisory Findings

None.

## Handoff

Use `spec-ticket-implementation` for the three implementation-only fixes. Do not wire the foundation through the Docker factory, package entrypoint, or public Harness port. Return for a fresh independent review after the exact new failure-path tests and ticket checks pass.
