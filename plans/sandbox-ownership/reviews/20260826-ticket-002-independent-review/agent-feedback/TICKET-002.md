# Feedback for TICKET-002

## Blocking Findings

- REVIEW-002-001: Omitted principal tenant is treated as a wildcard.
  - Spec refs: `02-administration.md#offboarding-and-purge`, `03-contracts/api.md#CTR-SOWN-ADMIN`.
  - Location: `packages/harness/src/sandbox/catalog.ts:256`.
  - Fix boundary: `catalog.ts` and `catalog.test.ts` only.
  - Required verification: focused catalog tests and Harness typecheck.

- REVIEW-002-002: Barrier/progress are not durable before cleanup side effects, and post-barrier cancellation rolls them back.
  - Spec refs: `02-administration.md#offboarding-and-purge`, `03-contracts/api.md#CTR-SOWN-ADMIN`.
  - Location: `packages/harness/src/sandbox/catalog.ts:159-201,239-245`.
  - Fix boundary: `catalog.ts` and `catalog.test.ts` only.
  - Required verification: focused catalog tests and the declared Harness unit suite.

- REVIEW-002-003: Per-owner purge reservations are absent.
  - Spec refs: `02-administration.md#bounds--dec-sown-bounds`, `02-administration.md#offboarding-and-purge`.
  - Location: `packages/harness/src/sandbox/catalog.ts:108,129,167,260-261`.
  - Fix boundary: `catalog.ts` and `catalog.test.ts` only.
  - Required verification: focused catalog tests and Harness typecheck.

- REVIEW-002-004: The local journal lock is not cross-process.
  - Spec refs: `02-administration.md#inventory--dec-sown-admin`, `04-verification.md#ACC-SOWN-ADMIN`.
  - Location: `packages/harness/src/local/local-sandbox-catalog.ts:8,59-66`.
  - Fix boundary: `local-sandbox-catalog.ts` and `local-sandbox-catalog.test.ts` only.
  - Required verification: focused local catalog tests and Harness typecheck.

- REVIEW-002-005: Signal-bearing registration and sweep do not observe cancellation correctly.
  - Spec refs: `03-contracts/api.md#CTR-SOWN-OWNER`, `03-contracts/api.md#CTR-SOWN-ADMIN`.
  - Location: `packages/harness/src/sandbox/catalog.ts:97-113,217-236`.
  - Fix boundary: `catalog.ts` and `catalog.test.ts` only.
  - Required verification: focused catalog tests and Harness typecheck.

- REVIEW-002-006: Snapshot deletion changes the journal without deleting the backing snapshot.
  - Spec refs: `02-administration.md#offboarding-and-purge`, `03-contracts/api.md#CTR-SOWN-ADMIN`.
  - Location: `packages/harness/src/sandbox/catalog.ts:204-215`.
  - Fix boundary: `catalog.ts` and `catalog.test.ts` only.
  - Required verification: focused catalog tests and Harness typecheck.

- REVIEW-002-007: Implementation evidence does not pin the current nested plan manifest.
  - Spec refs: `04-delivery.md#autonomous-execution-constraints`.
  - Location: `plans/implementation-evidence/TICKET-002.json:6`.
  - Fix boundary: `plans/implementation-evidence/TICKET-002.json` only, after controller-approved remediation and plan-manifest regeneration.
  - Required verification: nested plan checker.

## Advisory Findings

None. The cursor implementation's deletion-stability and emitted-size cases should be included when the remediation tests are expanded, but they are not a separate finding because the listed correctness failures already block acceptance.

## Handoff

Use `spec-ticket-implementation` for the scoped implementation fixes. Do not wire this private foundation through a factory, root entrypoint, or the live `Sandbox` port. Return for fresh independent review with red/green evidence for every listed failure path; the controller owns plan status and manifest/evidence lifecycle updates.
