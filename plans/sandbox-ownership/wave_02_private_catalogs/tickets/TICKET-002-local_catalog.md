---
id: TICKET-002
title: Private local owner catalog and administration primitives
wave: 2
lifecycle: accepted
spec_manifest_digest: sha256:d428914333a9eab9a1f84659f3c4724028c5c4ca96c20be3c13c9edc4c4365cc
plan_manifest_digest: sha256:57fa5bbc511a90aa7bcc53096fc56a50e9db8025787adb8cda8175e9a7050039
parallel_group: wave-02-private-catalogs
depends_on: [TICKET-001]
blocked_by: []
spec_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-BOUNDS, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
write_scope: [ai-harness/packages/harness/src/sandbox/catalog.ts, ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts, ai-harness/packages/harness/vitest.config.ts]
read_scope: [ai-harness/specs/36-sandbox-ownership-and-administration, AGENTS.md, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/package.json, ai-harness/packages/harness/src, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker, purista/AGENTS.md, purista/packages/core/src, purista/skills/purista, ai-harness/skills/ai-harness, specs/50-handbook/00-information-architecture.md, plans/handbook-refactor/implementation-plan.md, ai-harness/plans/sandbox-ownership]
contract_readiness:
  status: ready
  required_contracts: [CTR-SOWN-OWNER, CTR-SOWN-ADMIN, CTR-SOWN-OPTIONS, CTR-SOWN-ERRORS]
  missing_contracts: []
traceability:
  requirement_ids: [REQ-SOWN-OWNER, REQ-SOWN-ADMIN, REQ-SOWN-BOUNDS, REQ-SOWN-SAFETY]
  capability_ids: [CAP-SOWN-OWNER, CAP-SOWN-ADMIN, CAP-SOWN-BOUNDS, CAP-SOWN-SAFETY]
  path_ids: [PATH-SOWN-OWNER, PATH-SOWN-ADMIN, PATH-SOWN-BOUNDS, PATH-SOWN-SAFETY]
  acceptance_ids: [ACC-SOWN-OWNER, ACC-SOWN-ADMIN, ACC-SOWN-BOUNDS, ACC-SOWN-SAFETY]
generated_contracts:
  status: ready
  source_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS]
  command_refs: []
  drift_command_refs: [CMD-HARNESS_UNIT, CMD-HARNESS_TYPES]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: foundation_exception
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml
  shape_refs: [sown.owner, sown.administration, sown.options, sown.safe-error]
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
  CMD-HARNESS_UNIT:
    command: npm --prefix ai-harness run test:unit --workspace @purista/harness
    purpose: Run source unit and schema fixtures
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-HARNESS_TYPES:
    command: npm --prefix ai-harness run typecheck --workspace @purista/harness
    purpose: Compile standalone Harness source
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md, ai-harness/specs/36-sandbox-ownership-and-administration/.readiness-report.yaml, ai-harness/package.json]
    command_refs: [CMD-BASELINE, CMD-SPEC, CMD-PLAN]
    acceptance_refs: [AC-TICKET-002-OWNER, AC-TICKET-002-ADMIN, AC-TICKET-002-BOUNDS, AC-TICKET-002-SAFETY]
    expected_proof: Matching approved digests and accepted dependencies; dirty baseline preserved; missing authority or prerequisite blocks work.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md, ai-harness/packages/harness/src/sandbox/catalog.ts]
    command_refs: [CMD-SPEC, CMD-HARNESS_TYPES]
    acceptance_refs: [AC-TICKET-002-OWNER, AC-TICKET-002-ADMIN, AC-TICKET-002-BOUNDS, AC-TICKET-002-SAFETY]
    expected_proof: Exact schema and public type mapping identified before runtime changes; no new semantic decision or legacy shape.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts]
    command_refs: [CMD-HARNESS_UNIT, CMD-HARNESS_TYPES]
    acceptance_refs: [AC-TICKET-002-OWNER, AC-TICKET-002-ADMIN, AC-TICKET-002-BOUNDS, AC-TICKET-002-SAFETY]
    expected_proof: Named acceptance fixtures fail for the missing behavior before implementation; existing covered behavior recorded separately.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/packages/harness/src/sandbox/catalog.ts, ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts]
    command_refs: [CMD-HARNESS_UNIT, CMD-HARNESS_TYPES]
    acceptance_refs: [AC-TICKET-002-OWNER, AC-TICKET-002-ADMIN, AC-TICKET-002-BOUNDS, AC-TICKET-002-SAFETY]
    expected_proof: Only scoped deliverable implemented with approved public shapes and exact failure behavior; no compatibility path.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts]
    command_refs: [CMD-SPEC, CMD-PLAN, CMD-HARNESS_UNIT, CMD-HARNESS_TYPES]
    acceptance_refs: [AC-TICKET-002-OWNER, AC-TICKET-002-ADMIN, AC-TICKET-002-BOUNDS, AC-TICKET-002-SAFETY]
    expected_proof: All owned acceptance rows green; no new baseline regression; no weakened tests or thresholds; external gate reported separately.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: [CMD-BASELINE]
    acceptance_refs: [AC-TICKET-002-OWNER, AC-TICKET-002-ADMIN, AC-TICKET-002-BOUNDS, AC-TICKET-002-SAFETY]
    expected_proof: Return changed paths plus red/green command evidence and unresolved blockers; controller records lifecycle; no self acceptance.
acceptance:
  - id: AC-TICKET-002-OWNER
    traceability_acceptance_ids: [ACC-SOWN-OWNER]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-OWNER]
    test_refs: [ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts]
    command_refs: [CMD-HARNESS_UNIT, CMD-HARNESS_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-OWNER satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-002-ADMIN
    traceability_acceptance_ids: [ACC-SOWN-ADMIN]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN]
    test_refs: [ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts]
    command_refs: [CMD-HARNESS_UNIT, CMD-HARNESS_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-ADMIN satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-002-BOUNDS
    traceability_acceptance_ids: [ACC-SOWN-BOUNDS]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-BOUNDS]
    test_refs: [ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts]
    command_refs: [CMD-HARNESS_UNIT, CMD-HARNESS_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-BOUNDS satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-002-SAFETY
    traceability_acceptance_ids: [ACC-SOWN-SAFETY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY]
    test_refs: [ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts]
    command_refs: [CMD-HARNESS_UNIT, CMD-HARNESS_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-SAFETY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
---

# TICKET-002 — Private local owner catalog and administration primitives

## Goal

Provide tested private catalog primitives for existing in-memory and single-host adapters without changing their public port yet.

## Context Digest

Scope is the approved spec-36 follow-up, not the historical spec-34 completion. Current source baseline includes preserved uncommitted sandbox and unrelated evaluation/handbook work. Do not start until TICKET-001 are independently accepted and the controller promotes this ticket. Planning approval is not permission to implement during the current conversation.

## Implementation Approach

1. Implement exact owner/subject indexes, versioned private records, provisioning intent, revocation barriers, durable purge progress and resource/pin reservations in focused sandbox-domain modules.

2. Reuse existing filesystem ownership/atomic-write discipline; local catalog restart must recover records or fail state loss, never enumerate arbitrary paths as authority.

3. Implement stable bounded inventory cursors, exact selectors, idempotency conflict detection and finite catalog/active-resource admission; reserve purge and selector capacity before allocation.

4. Use typed internal resource deletion/stop callbacks to exercise retries and cancellation, not a public registry port or generalized resource framework. Keep existing factories unwired until TICKET-004.

## Decision Ledger

D2 decisions are frozen by the canonical contracts and DEC-SOWN-BOUNDARY/DELIVERY. D0 mechanical changes and D1 private reversible helpers/test placement are the only local choices. No new dependency, public option, error family, topology flag, or ownership rule may be invented.

## Action Plan

1. Preflight: read only listed source scopes, verify both manifests and accepted prerequisites, and run CMD-BASELINE. Record pre-existing failures before changing source.

2. Contract: trace CTR-SOWN-OWNER, CTR-SOWN-ADMIN, CTR-SOWN-OPTIONS, CTR-SOWN-ERRORS into the first owned source module and existing public exports. Compiler-generated declarations are not handwritten; strict DTO schemas and inferred types are source.

3. Test first: add or reproduce the named tests and the failure cases below before changing behavior. Record expected red tests; a skip is not red evidence.

4. Implement the numbered Implementation Approach only in write_scope. Keep the foundation private/unwired until the named cutover; it must compile and pass its direct tests.

5. Verify every acceptance row with the recorded CMD identifiers, inspect generated declarations/type tests and changed-file scope, and obtain independent review against ticket plus source specs.

6. Handoff: return proof and blockers; controller updates shared indexes and records evidence. Do not edit another ticket, mark accepted, publish a package, or fabricate external results.

## Requirements Traceability

- REQ-SOWN-OWNER -> CAP-SOWN-OWNER -> PATH-SOWN-OWNER -> ACC-SOWN-OWNER; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-ADMIN -> CAP-SOWN-ADMIN -> PATH-SOWN-ADMIN -> ACC-SOWN-ADMIN; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-BOUNDS -> CAP-SOWN-BOUNDS -> PATH-SOWN-BOUNDS -> ACC-SOWN-BOUNDS; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-SAFETY -> CAP-SOWN-SAFETY -> PATH-SOWN-SAFETY -> ACC-SOWN-SAFETY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.

## Contract Traceability

- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS

## Spec Drift Controls

Pinned source digest: sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb. Verify plan digest before edits. Forbidden interpretations: automatic empty reset, history sharing through sandbox IDs, owner deletion by borrowers, ignored quotas, expiry of recovery pins/tombstones, public provider refs and legacy overloads. A missing or contradictory requirement blocks this ticket; no silent reinterpretation. Review must compare both ticket and canonical acceptance rows.

## Generator And Type Plan

Generation map: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/generation-map.yaml. No local-port code generator exists, so handwritten generic/function interfaces are the approved boundary exception; DTOs derive from strict source schemas. Existing compiler build produces declarations; type and contract commands check drift. Do not copy types into PURISTA, widen to any, or edit generated declarations. Public TSDoc is added with the owned API, including non-obvious examples.

## Test-First Order

Two clients race registration/purge, absent owner purge races creation, principal barrier spares other actors, partial delete survives restart, wrong cursor/key denied, capacity reserves and tombstones prevent resurrection. Run the listed test files before the behavior change, then after; record exact red and green results. Include cancellation/denial/retry/state-loss assertions and content-free error projection when those paths are in scope.

## Modularity And Reuse Plan

Reuse the modules and public exports in ai-harness/specs/36-sandbox-ownership-and-administration/00-reuse-inventory.yaml and 04-delivery.md. New helper files stay inside the owned domain folders. Extend existing catalog/error/identity/SQLite/engine mechanisms; no public lifecycle database port or generic resource framework. Do not duplicate existing public identity, capability, session or workspace DTOs.

## Representation Reuse Plan

Catalog: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml. Reuse sown.owner, sown.administration, sown.options, sown.safe-error and their cataloged mappings; source-owned identical shapes are not redefined at each layer. No new representation decision is authorized.

## Slice Strategy

Approved horizontal foundation exception: only contract/private primitives, with direct tests and no parallel runtime contract. Atomic integration into every existing base adapter in wave 3.

## Tasks

1. Implement exact owner/subject indexes, versioned private records, provisioning intent, revocation barriers, durable purge progress and resource/pin reservations in focused sandbox-domain modules.

2. Reuse existing filesystem ownership/atomic-write discipline; local catalog restart must recover records or fail state loss, never enumerate arbitrary paths as authority.

3. Implement stable bounded inventory cursors, exact selectors, idempotency conflict detection and finite catalog/active-resource admission; reserve purge and selector capacity before allocation.

4. Use typed internal resource deletion/stop callbacks to exercise retries and cancellation, not a public registry port or generalized resource framework. Keep existing factories unwired until TICKET-004.

## Acceptance

All frontmatter acceptance rows must pass for this ticket's contribution. Shared canonical rows are collectively owned by their listed dependent tickets; this ticket cannot claim downstream behavior is complete. No partial implementation is a releasable spec-36 package.

## Acceptance Test Matrix

| Local acceptance | Canonical proof | Test files |
| --- | --- | --- |
| AC-TICKET-002-OWNER | ACC-SOWN-OWNER in 04-verification.md | ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts |
| AC-TICKET-002-ADMIN | ACC-SOWN-ADMIN in 04-verification.md | ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts |
| AC-TICKET-002-BOUNDS | ACC-SOWN-BOUNDS in 04-verification.md | ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts |
| AC-TICKET-002-SAFETY | ACC-SOWN-SAFETY in 04-verification.md | ai-harness/packages/harness/src/sandbox/catalog.test.ts, ai-harness/packages/harness/src/local/local-sandbox-catalog.test.ts |

Exact expected cases: Two clients race registration/purge, absent owner purge races creation, principal barrier spares other actors, partial delete survives restart, wrong cursor/key denied, capacity reserves and tombstones prevent resurrection.

## End-To-End Definition Coverage

CAP-SOWN-OWNER / PATH-SOWN-OWNER; CAP-SOWN-ADMIN / PATH-SOWN-ADMIN; CAP-SOWN-BOUNDS / PATH-SOWN-BOUNDS; CAP-SOWN-SAFETY / PATH-SOWN-SAFETY map to ai-harness/specs/36-sandbox-ownership-and-administration/02-capabilities/capability-inventory.md and 03-flows/e2e-coverage.md. Those rows fix actor, reachable entrypoint, data/state, side effects, permissions, errors/recovery, owner/final state and observability. This ticket covers the implementation approach above; no frontend/client screen or new transport is introduced.

## Operational Path Coverage

Include the matching failure/recovery cases in 04-verification.md: Two clients race registration/purge, absent owner purge races creation, principal barrier spares other actors, partial delete survives restart, wrong cursor/key denied, capacity reserves and tombstones prevent resurrection. Operator/provider actions outside default commands stay blocked until separately authorized. Cleanup remains retryable and never reports partial work as completed.

## Review And Verification Plan

An independent reviewer checks source specs, this action plan, exact tests, strict typing/generated declarations, modular placement, reuse, privacy and dirty-worktree scope. Any invented behavior, missing unhappy-path test, duplicate DTO, incompatible consumer or unverifiable claim prevents acceptance. Implementation handoff may say implemented only after all owned local checks pass.

## Verification

- CMD-BASELINE: `git -C ai-harness status --short` — Record preserved source baseline.
- CMD-SPEC: `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` — Verify approved source digest and contract controls.
- CMD-PLAN: `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` — Verify ticket digest and dependency indexes.
- CMD-HARNESS_UNIT: `npm --prefix ai-harness run test:unit --workspace @purista/harness` — Run source unit and schema fixtures.
- CMD-HARNESS_TYPES: `npm --prefix ai-harness run typecheck --workspace @purista/harness` — Compile standalone Harness source.

## Non-goals

Production E2B/Daytona adapters or bake-off selection; new service/daemon/router; compatibility/migration helpers; destructive user-data migration; topology-dependent business logic; unrelated evaluation or handbook refactoring; publication.

## Handoff

Return changed paths, baseline/red/green commands, test counts, acceptance-row results and explicit blockers. The controller records proof and moves ready/in_progress to implemented, then review_pending; only independent review moves to accepted. Do not edit shared indexes from parallel workers. Next: Atomic integration into every existing base adapter in wave 3.
