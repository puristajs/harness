# Feedback for TICKET-002 remediation

## Blocking Findings

- REVIEW-002-008: Same-key concurrent purge retries can duplicate a provider deletion side effect.
  - Spec refs: `02-administration.md#offboarding-and-purge`, `04-verification.md#ACC-SOWN-ADMIN`.
  - Location: `packages/harness/src/sandbox/catalog.ts:165-200`.
  - Fix boundary: `catalog.ts` and `catalog.test.ts` only.
  - Required verification: focused catalog tests and the declared Harness unit suite.

- REVIEW-002-009: Four required regression paths still lack deterministic tests.
  - Spec refs: `04-verification.md#ACC-SOWN-ADMIN`, `#ACC-SOWN-BOUNDS`, `#ACC-SOWN-SAFETY`.
  - Location: `catalog.test.ts:94-118`, `local-sandbox-catalog.test.ts:30-42`.
  - Fix boundary: the two scoped test files only.
  - Required verification: focused catalog/local-catalog tests and Harness typecheck.

## Resolved Findings

REVIEW-002-001 through REVIEW-002-007 are resolved in the implementation, including exact optional-tenant selection, barrier-first persistence, owner-reserved capacity arithmetic, a private local file lock, cancellation checks, callback-backed snapshot deletion, and current evidence digest pinning.

## Handoff

Use `spec-ticket-implementation` for the two scoped remediations. Do not expose an in-flight cleanup claim as a public lease, wire a factory, or change the live `Sandbox` port. Return for fresh independent review with the exact race and failure-path evidence.
