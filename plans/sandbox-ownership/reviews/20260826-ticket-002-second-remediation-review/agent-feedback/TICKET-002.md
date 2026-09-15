# Feedback for TICKET-002 second remediation

## Blocking Findings

- REVIEW-002-010: Durable cleanup claims cannot recover after a crashed claimant.
  - Spec refs: `00-vision.md#REQ-SOWN-SAFETY`, `02-administration.md#offboarding-and-purge`.
  - Location: `packages/harness/src/sandbox/catalog.ts:179-196,276-282`.
  - Fix boundary: `catalog.ts` and `catalog.test.ts` only.
  - Required verification: focused catalog tests and the Harness unit suite.

- REVIEW-002-011: Snapshot delete and sweep can still duplicate a private deletion callback concurrently.
  - Spec refs: `02-administration.md#offboarding-and-purge`, `03-contracts/api.md#CTR-SOWN-ADMIN`.
  - Location: `packages/harness/src/sandbox/catalog.ts:204-258`.
  - Fix boundary: `catalog.ts` and `catalog.test.ts` only.
  - Required verification: focused catalog tests and Harness typecheck.

- REVIEW-002-009: Cross-process lock and mid-sweep cancellation regression tests remain missing.
  - Spec refs: `04-verification.md#ACC-SOWN-ADMIN`, `#ACC-SOWN-SAFETY`.
  - Location: `local-sandbox-catalog.test.ts:30-42`, `catalog.test.ts`.
  - Fix boundary: the two scoped test files only.
  - Required verification: focused catalog/local-catalog tests and Harness typecheck.

## Resolved Findings

REVIEW-002-001 through REVIEW-002-008 are resolved for their original paths. REVIEW-002-009 is partially resolved: capacity and snapshot-failure fixtures are present, while its other two required fixtures remain open.

## Handoff

Use `spec-ticket-implementation` for the scoped fixes. Keep cleanup attempts adapter-private; do not add a public lease, generic registry, factory wiring, or live `Sandbox` port behavior. Return for independent review with exact crash-recovery, concurrent-cleanup, process-lock, and sweep-cancellation evidence.
