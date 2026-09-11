# Feedback for TICKET-013

## Blocking Findings

- REVIEW-013-001: Failure handling removes the only scratch evidence and can replace the original child error.
  - Spec refs: `VERIFY-SOWN-PACKAGED-PURISTA`; TICKET-013 operational path coverage.
  - Location: `ai-harness/scripts/check-purista-sandbox.mjs:70-79`.
  - Fix boundary: verifier and its tests only.

- REVIEW-013-002: The top-level AbortSignal is not passed to the actual build, pack, install, compiler, test, or docs children.
  - Spec refs: `VERIFY-SOWN-PACKAGED-PURISTA`; TICKET-013 test-first order.
  - Location: `ai-harness/scripts/check-purista-sandbox.mjs:115-128,187-233,261-271`.
  - Fix boundary: verifier and its tests only.

- REVIEW-013-003: `npm pack` is not explicitly offline or bound to the workspace-local npm cache.
  - Spec refs: `VERIFY-SOWN-PACKAGED-PURISTA`; TICKET-013 spec-drift controls.
  - Location: `ai-harness/scripts/check-purista-sandbox.mjs:115-118,201-203` and `ai-harness/scripts/check-sandbox-packages.mjs:16-19`.
  - Fix boundary: verification scripts and runner tests only.

- REVIEW-013-004: The public-entrypoint validator is dead code in the runner, so fixture staging itself does not enforce the no-alias rule.
  - Spec refs: `VERIFY-SOWN-PACKAGED-PURISTA`; TICKET-013 acceptance.
  - Location: `ai-harness/scripts/check-purista-sandbox.mjs:82-90,151-175,195-233`.
  - Fix boundary: verifier and its tests only.

- REVIEW-013-005: The controller-owned evidence manifest is stale and schema-invalid.
  - Route: planner/controller, not product implementation.
  - Location: `ai-harness/plans/implementation-evidence/TICKET-013.json:6-56`.

## Required Follow-up

Use `spec-ticket-implementation` for the four scoped script/test fixes. Do not
install or fetch dependencies. After the fixes, an explicitly prepopulated
workspace-local cache is required to run the actual source proof; its absence
must continue to fail closed. The controller then corrects evidence and routes
the ticket to another independent review.
