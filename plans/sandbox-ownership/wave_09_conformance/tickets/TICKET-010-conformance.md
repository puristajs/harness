---
id: TICKET-010
title: Cross-adapter administration privacy and package conformance
wave: 9
lifecycle: planned
spec_manifest_digest: sha256:d428914333a9eab9a1f84659f3c4724028c5c4ca96c20be3c13c9edc4c4365cc
plan_manifest_digest: sha256:57fa5bbc511a90aa7bcc53096fc56a50e9db8025787adb8cda8175e9a7050039
parallel_group: serial-TICKET-010
depends_on: [TICKET-009]
blocked_by: [TICKET-009]
spec_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
write_scope: [ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/src/testing/sandboxSnapshot.ts, ai-harness/packages/harness/src/testing/index.ts, ai-harness/packages/harness/src/sandbox/telemetry.ts, ai-harness/packages/harness/src/sessions/sandboxTelemetry.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness/test/telemetry-flow.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts, ai-harness/scripts/check-sandbox-packages.mjs, ai-harness/scripts/fixtures, ai-harness/packages/harness-sandbox-docker/src/index.test.ts, ai-harness/packages/harness/src/sessions/index.ts]
read_scope: [ai-harness/specs/36-sandbox-ownership-and-administration, AGENTS.md, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/package.json, ai-harness/packages/harness/src, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker, purista/AGENTS.md, purista/packages/core/src, purista/skills/purista, ai-harness/skills/ai-harness, specs/50-handbook/00-information-architecture.md, plans/handbook-refactor/implementation-plan.md, ai-harness/plans/sandbox-ownership]
contract_readiness:
  status: ready
  required_contracts: [CTR-SOWN-ADMIN, CTR-SOWN-ERRORS, CTR-SOWN-OPEN, CTR-SOWN-OWNER]
  missing_contracts: []
traceability:
  requirement_ids: [REQ-SOWN-ADMIN, REQ-SOWN-SAFETY, REQ-SOWN-DELIVERY]
  capability_ids: [CAP-SOWN-ADMIN, CAP-SOWN-SAFETY, CAP-SOWN-DELIVERY]
  path_ids: [PATH-SOWN-ADMIN, PATH-SOWN-SAFETY, PATH-SOWN-DELIVERY]
  acceptance_ids: [ACC-SOWN-ADMIN, ACC-SOWN-SAFETY, ACC-SOWN-DELIVERY]
generated_contracts:
  status: ready
  source_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER]
  command_refs: []
  drift_command_refs: [CMD-HARNESS_TEST, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-PACKAGES]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: vertical_slice
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml
  shape_refs: [sown.administration, sown.safe-error, sown.owner, sown.scope]
  mapping_refs: []
  new_shape_decision: none
autonomy:
  allowed_classes: [D0, D1]
  convention_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-conventions.md#CONV-SOWN-PURISTA, ai-harness/specs/36-sandbox-ownership-and-administration/00-conventions.md#CONV-SOWN-TYPES, ai-harness/specs/36-sandbox-ownership-and-administration/00-conventions.md#CONV-SOWN-AUTONOMY]
  approved_decision_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#DEC-SOWN-BOUNDARY, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
  escalation: blocker
verification_commands:
  CMD-BASELINE:
    command: git -C ai-harness status --short
    purpose: Record preserved source baseline
    expected: record_only
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-SPEC:
    command: node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration
    purpose: Verify approved source digest and contract controls
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-PLAN:
    command: node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration
    purpose: Verify ticket digest and dependency indexes
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-HARNESS_TEST:
    command: npm --prefix ai-harness run test --workspace @purista/harness
    purpose: Run Harness unit integration and failure regressions
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-HARNESS_COVERAGE:
    command: npm --prefix ai-harness run test:coverage --workspace @purista/harness
    purpose: Verify unchanged coverage gates
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-DOCKER_TEST:
    command: npm --prefix ai-harness run test --workspace @purista/harness-sandbox-docker
    purpose: Run hermetic Docker transport and contract tests only
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-DOCKER_TYPES:
    command: npm --prefix ai-harness run typecheck --workspace @purista/harness-sandbox-docker
    purpose: Compile independent Docker adapter
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-ARCHITECTURE:
    command: npm --prefix ai-harness run verify:architecture
    purpose: Verify package direction and unchanged capability families
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-PACKAGES:
    command: npm --prefix ai-harness run verify:sandbox-packages
    purpose: Verify offline packed standalone Harness and Docker consumers
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md, ai-harness/specs/36-sandbox-ownership-and-administration/.readiness-report.yaml, ai-harness/package.json]
    command_refs: [CMD-BASELINE, CMD-SPEC, CMD-PLAN]
    acceptance_refs: [AC-TICKET-010-ADMIN, AC-TICKET-010-SAFETY, AC-TICKET-010-DELIVERY]
    expected_proof: Matching approved digests and accepted dependencies; dirty baseline preserved; missing authority or prerequisite blocks work.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md, ai-harness/packages/harness/src/testing/sandboxContract.ts]
    command_refs: [CMD-SPEC, CMD-DOCKER_TYPES]
    acceptance_refs: [AC-TICKET-010-ADMIN, AC-TICKET-010-SAFETY, AC-TICKET-010-DELIVERY]
    expected_proof: Exact schema and public type mapping identified before runtime changes; no new semantic decision or legacy shape.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_COVERAGE, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-ARCHITECTURE, CMD-PACKAGES]
    acceptance_refs: [AC-TICKET-010-ADMIN, AC-TICKET-010-SAFETY, AC-TICKET-010-DELIVERY]
    expected_proof: Named acceptance fixtures fail for the missing behavior before implementation; existing covered behavior recorded separately.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/src/testing/sandboxSnapshot.ts, ai-harness/packages/harness/src/testing/index.ts, ai-harness/packages/harness/src/sandbox/telemetry.ts, ai-harness/packages/harness/src/sessions/sandboxTelemetry.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness/test/telemetry-flow.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts, ai-harness/scripts/check-sandbox-packages.mjs, ai-harness/scripts/fixtures, ai-harness/packages/harness-sandbox-docker/src/index.test.ts, ai-harness/packages/harness/src/sessions/index.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_COVERAGE, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-ARCHITECTURE, CMD-PACKAGES]
    acceptance_refs: [AC-TICKET-010-ADMIN, AC-TICKET-010-SAFETY, AC-TICKET-010-DELIVERY]
    expected_proof: Only scoped deliverable implemented with approved public shapes and exact failure behavior; no compatibility path.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts]
    command_refs: [CMD-SPEC, CMD-PLAN, CMD-HARNESS_TEST, CMD-HARNESS_COVERAGE, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-ARCHITECTURE, CMD-PACKAGES]
    acceptance_refs: [AC-TICKET-010-ADMIN, AC-TICKET-010-SAFETY, AC-TICKET-010-DELIVERY]
    expected_proof: All owned acceptance rows green; no new baseline regression; no weakened tests or thresholds; external gate reported separately.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: [CMD-BASELINE]
    acceptance_refs: [AC-TICKET-010-ADMIN, AC-TICKET-010-SAFETY, AC-TICKET-010-DELIVERY]
    expected_proof: Return changed paths plus red/green command evidence and unresolved blockers; controller records lifecycle; no self acceptance.
acceptance:
  - id: AC-TICKET-010-ADMIN
    traceability_acceptance_ids: [ACC-SOWN-ADMIN]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN]
    test_refs: [ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_COVERAGE, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-ARCHITECTURE, CMD-PACKAGES]
    expected_outcome: This ticket contribution to ACC-SOWN-ADMIN satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-010-SAFETY
    traceability_acceptance_ids: [ACC-SOWN-SAFETY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY]
    test_refs: [ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_COVERAGE, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-ARCHITECTURE, CMD-PACKAGES]
    expected_outcome: This ticket contribution to ACC-SOWN-SAFETY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-010-DELIVERY
    traceability_acceptance_ids: [ACC-SOWN-DELIVERY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY]
    test_refs: [ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_COVERAGE, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-ARCHITECTURE, CMD-PACKAGES]
    expected_outcome: This ticket contribution to ACC-SOWN-DELIVERY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
---

# TICKET-010 — Cross-adapter administration privacy and package conformance

## Goal

Prove one public contract across built-ins and Docker with no privacy or standalone-package regression.

## Context Digest

Scope is the approved spec-36 follow-up, not the historical spec-34 completion. Current source baseline includes preserved uncommitted sandbox and unrelated evaluation/handbook work. Do not start until TICKET-009 are independently accepted and the controller promotes this ticket. Planning approval is not permission to implement during the current conversation.

## Implementation Approach

1. Publish a reusable sandboxAdministrationContract from the existing testing entrypoint and run it for every built-in/fake/Docker scripted transport, including two-client races.

2. Instrument existing sandbox/workspace telemetry helpers using only approved operation/outcome/count fields and existing NO_CONTENT plumbing; do not create a metrics subsystem.

3. Extend real-engine test cases for actor revocation, retained volume deletion, stale attachments and partial cleanup, but do not run them without the separate caller-controlled engine gate.

4. Extend existing packed-package fixture checks for public-only Harness/Docker imports and new DTO/type inference; preserve strict declarations and no Framework dependency. Verify the existing capability catalog; these ownership tracking IDs do not create runtime capabilities or a new family.

## Decision Ledger

D2 decisions are frozen by the canonical contracts and DEC-SOWN-BOUNDARY/DELIVERY. D0 mechanical changes and D1 private reversible helpers/test placement are the only local choices. No new dependency, public option, error family, topology flag, or ownership rule may be invented.

## Action Plan

1. Preflight: read only listed source scopes, verify both manifests and accepted prerequisites, and run CMD-BASELINE. Record pre-existing failures before changing source.

2. Contract: trace CTR-SOWN-ADMIN, CTR-SOWN-ERRORS, CTR-SOWN-OPEN, CTR-SOWN-OWNER into the first owned source module and existing public exports. Compiler-generated declarations are not handwritten; strict DTO schemas and inferred types are source.

3. Test first: add or reproduce the named tests and the failure cases below before changing behavior. Record expected red tests; a skip is not red evidence.

4. Implement the numbered Implementation Approach only in write_scope. Preserve owner/history/actor separation and the specified error and cancellation behavior.

5. Verify every acceptance row with the recorded CMD identifiers, inspect generated declarations/type tests and changed-file scope, and obtain independent review against ticket plus source specs.

6. Handoff: return proof and blockers; controller updates shared indexes and records evidence. Do not edit another ticket, mark accepted, publish a package, or fabricate external results.

## Requirements Traceability

- REQ-SOWN-ADMIN -> CAP-SOWN-ADMIN -> PATH-SOWN-ADMIN -> ACC-SOWN-ADMIN; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-SAFETY -> CAP-SOWN-SAFETY -> PATH-SOWN-SAFETY -> ACC-SOWN-SAFETY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-DELIVERY -> CAP-SOWN-DELIVERY -> PATH-SOWN-DELIVERY -> ACC-SOWN-DELIVERY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.

## Contract Traceability

- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER

## Spec Drift Controls

Pinned source digest: sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb. Verify plan digest before edits. Forbidden interpretations: automatic empty reset, history sharing through sandbox IDs, owner deletion by borrowers, ignored quotas, expiry of recovery pins/tombstones, public provider refs and legacy overloads. A missing or contradictory requirement blocks this ticket; no silent reinterpretation. Review must compare both ticket and canonical acceptance rows.

## Generator And Type Plan

Generation map: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/generation-map.yaml. No local-port code generator exists, so handwritten generic/function interfaces are the approved boundary exception; DTOs derive from strict source schemas. Existing compiler build produces declarations; type and contract commands check drift. Do not copy types into PURISTA, widen to any, or edit generated declarations. Existing package-boundary/catalog verification remains a gate; no new runtime capability is added.

## Test-First Order

Offboard principal while another uses tenant-owned files; snapshot resume cannot bypass actor denial; secret sentinel absent from logs/nested errors/metrics; base and admin contracts all factories; packed runtime and declarations independent of Core. Run the listed test files before the behavior change, then after; record exact red and green results. Include cancellation/denial/retry/state-loss assertions and content-free error projection when those paths are in scope.

## Modularity And Reuse Plan

Reuse the modules and public exports in ai-harness/specs/36-sandbox-ownership-and-administration/00-reuse-inventory.yaml and 04-delivery.md. New helper files stay inside the owned domain folders. Extend existing catalog/error/identity/SQLite/engine mechanisms; no public lifecycle database port or generic resource framework. Do not duplicate existing public identity, capability, session or workspace DTOs.

## Representation Reuse Plan

Catalog: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml. Reuse sown.administration, sown.safe-error, sown.owner, sown.scope and their cataloged mappings; source-owned identical shapes are not redefined at each layer. No new representation decision is authorized.

## Slice Strategy

Vertical slice from public entrypoint to actual state/effect and failure behavior. Examples and operations guidance in wave 10, then independent release review.

## Tasks

1. Publish a reusable sandboxAdministrationContract from the existing testing entrypoint and run it for every built-in/fake/Docker scripted transport, including two-client races.

2. Instrument existing sandbox/workspace telemetry helpers using only approved operation/outcome/count fields and existing NO_CONTENT plumbing; do not create a metrics subsystem.

3. Extend real-engine test cases for actor revocation, retained volume deletion, stale attachments and partial cleanup, but do not run them without the separate caller-controlled engine gate.

4. Extend existing packed-package fixture checks for public-only Harness/Docker imports and new DTO/type inference; preserve strict declarations and no Framework dependency. Verify the existing capability catalog; these ownership tracking IDs do not create runtime capabilities or a new family.

## Acceptance

All frontmatter acceptance rows must pass for this ticket's contribution. Shared canonical rows are collectively owned by their listed dependent tickets; this ticket cannot claim downstream behavior is complete. No partial implementation is a releasable spec-36 package.

## Acceptance Test Matrix

| Local acceptance | Canonical proof | Test files |
| --- | --- | --- |
| AC-TICKET-010-ADMIN | ACC-SOWN-ADMIN in 04-verification.md | ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts |
| AC-TICKET-010-SAFETY | ACC-SOWN-SAFETY in 04-verification.md | ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts |
| AC-TICKET-010-DELIVERY | ACC-SOWN-DELIVERY in 04-verification.md | ai-harness/packages/harness/src/testing/sandboxAdministrationContract.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/sandbox-telemetry.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts |

Exact expected cases: Offboard principal while another uses tenant-owned files; snapshot resume cannot bypass actor denial; secret sentinel absent from logs/nested errors/metrics; base and admin contracts all factories; packed runtime and declarations independent of Core.

## End-To-End Definition Coverage

CAP-SOWN-ADMIN / PATH-SOWN-ADMIN; CAP-SOWN-SAFETY / PATH-SOWN-SAFETY; CAP-SOWN-DELIVERY / PATH-SOWN-DELIVERY map to ai-harness/specs/36-sandbox-ownership-and-administration/02-capabilities/capability-inventory.md and 03-flows/e2e-coverage.md. Those rows fix actor, reachable entrypoint, data/state, side effects, permissions, errors/recovery, owner/final state and observability. This ticket covers the implementation approach above; no frontend/client screen or new transport is introduced.

## Operational Path Coverage

Include the matching failure/recovery cases in 04-verification.md: Offboard principal while another uses tenant-owned files; snapshot resume cannot bypass actor denial; secret sentinel absent from logs/nested errors/metrics; base and admin contracts all factories; packed runtime and declarations independent of Core. Operator/provider actions outside default commands stay blocked until separately authorized. Cleanup remains retryable and never reports partial work as completed.

## Review And Verification Plan

An independent reviewer checks source specs, this action plan, exact tests, strict typing/generated declarations, modular placement, reuse, privacy and dirty-worktree scope. Any invented behavior, missing unhappy-path test, duplicate DTO, incompatible consumer or unverifiable claim prevents acceptance. Implementation handoff may say implemented only after all owned local checks pass.

## Verification

- CMD-BASELINE: `git -C ai-harness status --short` — Record preserved source baseline.
- CMD-SPEC: `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` — Verify approved source digest and contract controls.
- CMD-PLAN: `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` — Verify ticket digest and dependency indexes.
- CMD-HARNESS_TEST: `npm --prefix ai-harness run test --workspace @purista/harness` — Run Harness unit integration and failure regressions.
- CMD-HARNESS_COVERAGE: `npm --prefix ai-harness run test:coverage --workspace @purista/harness` — Verify unchanged coverage gates.
- CMD-DOCKER_TEST: `npm --prefix ai-harness run test --workspace @purista/harness-sandbox-docker` — Run hermetic Docker transport and contract tests only.
- CMD-DOCKER_TYPES: `npm --prefix ai-harness run typecheck --workspace @purista/harness-sandbox-docker` — Compile independent Docker adapter.
- CMD-ARCHITECTURE: `npm --prefix ai-harness run verify:architecture` — Verify package direction and unchanged capability families.
- CMD-PACKAGES: `npm --prefix ai-harness run verify:sandbox-packages` — Verify offline packed standalone Harness and Docker consumers.

## Non-goals

Production E2B/Daytona adapters or bake-off selection; new service/daemon/router; compatibility/migration helpers; destructive user-data migration; topology-dependent business logic; unrelated evaluation or handbook refactoring; publication.

## Handoff

Return changed paths, baseline/red/green commands, test counts, acceptance-row results and explicit blockers. The controller records proof and moves ready/in_progress to implemented, then review_pending; only independent review moves to accepted. Do not edit shared indexes from parallel workers. Next: Examples and operations guidance in wave 10, then independent release review.
