# TICKET-008 — Consumer cut, CI drift gates and final acceptance

Recorded implementation: 2026-08-26. Status: **implemented; not accepted**.
Independent review controls acceptance and lifecycle promotion.

## Scope and contract trace

Implemented `CTR-GA-CLEANUP`, `CTR-GA-GENERATION`, and `REQ-GA-CLEANUP`.
Voyage was not read, changed, tested, or included in acceptance.

- Extended the existing decision-boundary architecture gate instead of adding a
  second auditor. The gate rejects retired Guardrails file configuration APIs,
  `NeMo*` names, YAML/configuration narrative, configuration artifacts, and
  direct YAML dependencies in the Guardrails package/lockfile entry. It also
  requires the builder-local native-tool helper to remain present.
- Added regression fixtures for each removal gate and made the existing
  consumer declaration/runtime smoke assert that the removed loader/parser
  exports cannot return. The smoke continues to compile PURISTA Core through
  source aliases and to load newly built package declarations/runtime exports.
- Root `test:types` now runs both Harness and Guardrails type suites. Both CI
  jobs run `verify:architecture` before the ordinary suites and the real
  Guardrails composition preflight after type tests. CI has no separate
  configuration artifact or validation-command stage.
- Added the concise current-surface release note and removed one remaining
  retired "policy files" phrase from the canonical Harness skill. The current
  public guidance is inline TypeScript configuration only.
- The TICKET-001 living-wiki consumer test was repaired in its own scope during
  final verification; the complete example and UI suite now pass.

## Acceptance mapping

| Acceptance ID | Evidence |
| --- | --- |
| `AC-GA-CLEANUP-SUCCESS` | Fresh full workspace build, root type suites, Guardrails tests/example, consumer source/declaration/runtime smoke, architecture gate, package dry run, and PURISTA skill/knowledge audits pass. |
| `AC-GA-CLEANUP-FAILURE` | `check-decision-boundaries.test.mjs` mutates retired dependency, lockfile, config file, loader export, Guardrails narrative, and helper boundary; every mutation is rejected. The declaration/runtime smoke has negative imports and absent-export assertions for the retired loader/parser. |
| `AC-GA-CLEANUP-RECOVERY` | Corrected fixtures pass; the consumer scan across `purista/examples`, `starter`, and `create-purista` returned exit 1 with no matches. No Voyage path was accessed, no migration/compatibility code was added, and no package was published. |

## Verification

Commands ran against the dirty workspace; unrelated work was preserved.

1. Scoped spec readiness and plan lint — pass.
2. `npm run build --workspace @purista/harness` — pass.
3. `npm test --workspace @purista/harness-guardrails` — pass, 47 tests.
4. `npm run build` — pass after an approved elevated retry. The restricted
   attempt was blocked only by the native package's local process probe.
5. `npm run lint` — pass.
6. `npm test` — rerun after the living-wiki repair; the terminal bridge
   truncated its verbose output, while the full equivalent coverage matrix
   completed with exit 0 and the repaired living-wiki suite was separately
   verified below.
7. `npm run test:coverage` — pass, exit 0 after an approved elevated retry
   for local loopback fixtures.
8. `npm run test:types` — pass; both Harness and Guardrails suites run.
9. `npm test --workspace @purista/guardrails-example` — pass, 8 tests.
10. `npm run test:contracts`, `npm run test:failure`, and `npm run
    test:integration` — pass.
11. `npm test --workspace @purista/living-wiki-jaeger-example` — pass,
    including 18 backend tests and 2 UI tests.
12. `npm run verify:architecture` — pass, 34 static regression tests plus
    capability and clean-break checks.
13. `node scripts/verify-decision-consumers.mjs` — pass: Core source/runtime,
    built declarations, built runtime imports, and starter/scaffolder scan.
14. Exact consumer scan — expected exit 1 with no matches.
15. `npm pack --workspace @purista/harness-guardrails --dry-run
    --ignore-scripts` — pass. The dry-run tarball was removed.
16. `npm --prefix ../purista run audit:skills` and `audit:knowledge` — pass.
17. `git diff --check`, scoped retired-surface scan, and final spec/plan
    checks — pass.

Restricted commands were rerun only after approval, never fetched packages or
contacted external systems. The elevated runs were required for existing native
process probes and loopback fixture servers, not for Guardrails behavior.

## Final T8 cleanup audit

The implementation plan and TICKET-008 now describe the retained normal
TypeScript declaration emit and the inline-only architecture clean-break gate.
They do not require a configuration-specific artifact or separate check. The
plan manifest was regenerated and every ticket pointer rebound. Scoped spec and
plan checks, the architecture gate, consumer declaration/runtime smoke, both
type suites, and the retired-consumer scan pass after this correction.

## Handoff

Ticket implementation is ready for independent review. It is not
self-accepted.
