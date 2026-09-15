# Feedback for TICKET-001

## Blocking Findings

- REVIEW-SOWN-001: Canonical ULID validation accepts out-of-range values.
  - Spec refs: `CTR-SOWN-OWNER`, `CONV-SOWN-TYPES`.
  - Location: `packages/harness/src/sandbox/ownership.ts:6`.
  - Fix boundary: ownership schema and its test.
  - Required verification: add an over-range first-character fixture; run Harness typecheck and unit tests.

- REVIEW-SOWN-002: `SessionOptions` is not a strict inferred DTO.
  - Spec refs: `CTR-SOWN-POLICY`, validation and generation rule.
  - Location: `packages/harness/src/sandbox/ownership.ts:116`.
  - Fix boundary: ownership schema, ownership tests, and ownership type test.
  - Required verification: prove unknown fields reject and run type/unit checks.

- REVIEW-SOWN-003: Administrative workspace summaries may carry a sandbox scope.
  - Spec refs: `CTR-SOWN-ADMIN`, `ACC-SOWN-SAFETY`.
  - Location: `packages/harness/src/sandbox/administration.ts:40`.
  - Fix boundary: administration schema and test.
  - Required verification: reject a workspace-with-scope fixture and run unit tests.

- REVIEW-SOWN-004: Quota-error metadata leaks caller-supplied identity data.
  - Spec refs: `CTR-SOWN-ERRORS`, `ACC-SOWN-SAFETY`.
  - Location: `packages/harness/src/errors/catalog.ts:153`.
  - Fix boundary: error catalog and catalog test.
  - Required verification: add a serialized sentinel assertion and run unit tests.

- REVIEW-SOWN-005: Ticket tests are excluded by the current Vitest discovery configuration.
  - Owner: planner before implementation resumes; the required config is outside the current ticket write scope.
  - Required verification: amend write scope, regenerate/check the nested plan, then run `CMD-HARNESS_UNIT`.

## Advisory Findings

None. The next pass should remain limited to the approved contract foundation;
do not wire the live Sandbox port or create runtime compatibility behavior.

## Handoff

Route REVIEW-SOWN-005 to `spec-implementation-planner`. After the scope repair,
use `spec-ticket-implementation` for REVIEW-SOWN-001 through REVIEW-SOWN-004,
then return for a fresh independent review. Do not mark this ticket accepted.
