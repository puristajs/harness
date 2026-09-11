---
id: TICKET-007
title: Enforced workspace snapshot retention and bounded sweeps
wave: 6
lifecycle: planned
spec_manifest_digest: sha256:d428914333a9eab9a1f84659f3c4724028c5c4ca96c20be3c13c9edc4c4365cc
plan_manifest_digest: sha256:57fa5bbc511a90aa7bcc53096fc56a50e9db8025787adb8cda8175e9a7050039
parallel_group: serial-TICKET-007
depends_on: [TICKET-006]
blocked_by: [TICKET-006]
spec_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-BOUNDS, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DURABLE, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-WORKSPACE, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
write_scope: [ai-harness/packages/harness/src/local/local-workspace.ts, ai-harness/packages/harness/src/local/workspace-retention.ts, ai-harness/packages/harness/src/local/workspace-retention.test.ts, ai-harness/packages/harness/src/ports/workspace.ts, ai-harness/packages/harness/src/testing/sandboxSnapshot.ts, ai-harness/packages/harness/src/testing/fakeSandbox.ts, ai-harness/packages/harness/src/sandbox/catalog.ts, ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/options.ts, ai-harness/packages/harness-sandbox-docker/src/options.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts, ai-harness/packages/harness/src/workspace, ai-harness/packages/harness/src/ports/workspace.test.ts]
read_scope: [ai-harness/specs/36-sandbox-ownership-and-administration, AGENTS.md, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/package.json, ai-harness/packages/harness/src, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker, purista/AGENTS.md, purista/packages/core/src, purista/skills/purista, ai-harness/skills/ai-harness, specs/50-handbook/00-information-architecture.md, plans/handbook-refactor/implementation-plan.md, ai-harness/plans/sandbox-ownership]
contract_readiness:
  status: ready
  required_contracts: [CTR-SOWN-OPTIONS, CTR-SOWN-ADMIN, CTR-SOWN-WORKSPACE, CTR-SOWN-ERRORS]
  missing_contracts: []
traceability:
  requirement_ids: [REQ-SOWN-BOUNDS, REQ-SOWN-ADMIN, REQ-SOWN-DURABLE]
  capability_ids: [CAP-SOWN-BOUNDS, CAP-SOWN-ADMIN, CAP-SOWN-DURABLE]
  path_ids: [PATH-SOWN-BOUNDS, PATH-SOWN-ADMIN, PATH-SOWN-DURABLE]
  acceptance_ids: [ACC-SOWN-BOUNDS, ACC-SOWN-ADMIN, ACC-SOWN-DURABLE]
generated_contracts:
  status: ready
  source_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-WORKSPACE, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS]
  command_refs: []
  drift_command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: vertical_slice
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml
  shape_refs: [sown.options, sown.administration, sown.checkpoint, sown.safe-error]
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
  CMD-HARNESS_TYPES:
    command: npm --prefix ai-harness run typecheck --workspace @purista/harness
    purpose: Compile standalone Harness source
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
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md, ai-harness/specs/36-sandbox-ownership-and-administration/.readiness-report.yaml, ai-harness/package.json]
    command_refs: [CMD-BASELINE, CMD-SPEC, CMD-PLAN]
    acceptance_refs: [AC-TICKET-007-BOUNDS, AC-TICKET-007-ADMIN, AC-TICKET-007-DURABLE]
    expected_proof: Matching approved digests and accepted dependencies; dirty baseline preserved; missing authority or prerequisite blocks work.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md, ai-harness/packages/harness/src/local/local-workspace.ts]
    command_refs: [CMD-SPEC, CMD-HARNESS_TYPES]
    acceptance_refs: [AC-TICKET-007-BOUNDS, AC-TICKET-007-ADMIN, AC-TICKET-007-DURABLE]
    expected_proof: Exact schema and public type mapping identified before runtime changes; no new semantic decision or legacy shape.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
    acceptance_refs: [AC-TICKET-007-BOUNDS, AC-TICKET-007-ADMIN, AC-TICKET-007-DURABLE]
    expected_proof: Named acceptance fixtures fail for the missing behavior before implementation; existing covered behavior recorded separately.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/packages/harness/src/local/local-workspace.ts, ai-harness/packages/harness/src/local/workspace-retention.ts, ai-harness/packages/harness/src/local/workspace-retention.test.ts, ai-harness/packages/harness/src/ports/workspace.ts, ai-harness/packages/harness/src/testing/sandboxSnapshot.ts, ai-harness/packages/harness/src/testing/fakeSandbox.ts, ai-harness/packages/harness/src/sandbox/catalog.ts, ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/options.ts, ai-harness/packages/harness-sandbox-docker/src/options.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts, ai-harness/packages/harness/src/workspace, ai-harness/packages/harness/src/ports/workspace.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
    acceptance_refs: [AC-TICKET-007-BOUNDS, AC-TICKET-007-ADMIN, AC-TICKET-007-DURABLE]
    expected_proof: Only scoped deliverable implemented with approved public shapes and exact failure behavior; no compatibility path.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-SPEC, CMD-PLAN, CMD-HARNESS_TEST, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
    acceptance_refs: [AC-TICKET-007-BOUNDS, AC-TICKET-007-ADMIN, AC-TICKET-007-DURABLE]
    expected_proof: All owned acceptance rows green; no new baseline regression; no weakened tests or thresholds; external gate reported separately.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: [CMD-BASELINE]
    acceptance_refs: [AC-TICKET-007-BOUNDS, AC-TICKET-007-ADMIN, AC-TICKET-007-DURABLE]
    expected_proof: Return changed paths plus red/green command evidence and unresolved blockers; controller records lifecycle; no self acceptance.
acceptance:
  - id: AC-TICKET-007-BOUNDS
    traceability_acceptance_ids: [ACC-SOWN-BOUNDS]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-BOUNDS]
    test_refs: [ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-BOUNDS satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-007-ADMIN
    traceability_acceptance_ids: [ACC-SOWN-ADMIN]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN]
    test_refs: [ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-ADMIN satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-007-DURABLE
    traceability_acceptance_ids: [ACC-SOWN-DURABLE]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DURABLE]
    test_refs: [ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-DURABLE satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
---

# TICKET-007 — Enforced workspace snapshot retention and bounded sweeps

## Goal

Make accepted quota/TTL settings real and keep pinned recovery state safe during bounded garbage collection.

## Context Digest

Scope is the approved spec-36 follow-up, not the historical spec-34 completion. Current source baseline includes preserved uncommitted sandbox and unrelated evaluation/handbook work. Do not start until TICKET-006 are independently accepted and the controller promotes this ticket. Planning approval is not permission to implement during the current conversation.

## Implementation Approach

1. Apply exact factory support matrix/defaults to local and in-memory workspace, snapshot fake and sandbox admin options. Reject ignored/unsupported fields and invalid manual/automatic cleanup policy combinations.

2. Reserve and measure aggregate checkpoint/temp bytes during bounded copy, count failed cleanup against capacity, and use existing path ownership checks with no external symlink traversal.

3. Implement eligibility-only scheduled sweeps, terminal-time TTLs, pin-aware oldest-first collection and explicit snapshot delete conflict. Never infer terminal/orphan state solely from age.

4. Keep finite terminal catalogs and purge reserves; deny new admission instead of deleting barriers. Docker rejects portable live-volume byte limits and retains existing resource security limits.

## Decision Ledger

D2 decisions are frozen by the canonical contracts and DEC-SOWN-BOUNDARY/DELIVERY. D0 mechanical changes and D1 private reversible helpers/test placement are the only local choices. No new dependency, public option, error family, topology flag, or ownership rule may be invented.

## Action Plan

1. Preflight: read only listed source scopes, verify both manifests and accepted prerequisites, and run CMD-BASELINE. Record pre-existing failures before changing source.

2. Contract: trace CTR-SOWN-OPTIONS, CTR-SOWN-ADMIN, CTR-SOWN-WORKSPACE, CTR-SOWN-ERRORS into the first owned source module and existing public exports. Compiler-generated declarations are not handwritten; strict DTO schemas and inferred types are source.

3. Test first: add or reproduce the named tests and the failure cases below before changing behavior. Record expected red tests; a skip is not red evidence.

4. Implement the numbered Implementation Approach only in write_scope. Preserve owner/history/actor separation and the specified error and cancellation behavior.

5. Verify every acceptance row with the recorded CMD identifiers, inspect generated declarations/type tests and changed-file scope, and obtain independent review against ticket plus source specs.

6. Handoff: return proof and blockers; controller updates shared indexes and records evidence. Do not edit another ticket, mark accepted, publish a package, or fabricate external results.

## Requirements Traceability

- REQ-SOWN-BOUNDS -> CAP-SOWN-BOUNDS -> PATH-SOWN-BOUNDS -> ACC-SOWN-BOUNDS; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-ADMIN -> CAP-SOWN-ADMIN -> PATH-SOWN-ADMIN -> ACC-SOWN-ADMIN; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-DURABLE -> CAP-SOWN-DURABLE -> PATH-SOWN-DURABLE -> ACC-SOWN-DURABLE; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.

## Contract Traceability

- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-WORKSPACE
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS

## Spec Drift Controls

Pinned source digest: sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb. Verify plan digest before edits. Forbidden interpretations: automatic empty reset, history sharing through sandbox IDs, owner deletion by borrowers, ignored quotas, expiry of recovery pins/tombstones, public provider refs and legacy overloads. A missing or contradictory requirement blocks this ticket; no silent reinterpretation. Review must compare both ticket and canonical acceptance rows.

## Generator And Type Plan

Generation map: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/generation-map.yaml. No local-port code generator exists, so handwritten generic/function interfaces are the approved boundary exception; DTOs derive from strict source schemas. Existing compiler build produces declarations; type and contract commands check drift. Do not copy types into PURISTA, widen to any, or edit generated declarations. Public TSDoc is added with the owned API, including non-obvious examples.

## Test-First Order

Controlled clock and low quotas prove aggregate bytes, temp-copy failure, pins preventing eviction, unsupported field rejection, bounded cursors, catalog-full offboarding reserve, late stale create denial and no silent loss. Run the listed test files before the behavior change, then after; record exact red and green results. Include cancellation/denial/retry/state-loss assertions and content-free error projection when those paths are in scope.

## Modularity And Reuse Plan

Reuse the modules and public exports in ai-harness/specs/36-sandbox-ownership-and-administration/00-reuse-inventory.yaml and 04-delivery.md. New helper files stay inside the owned domain folders. Extend existing catalog/error/identity/SQLite/engine mechanisms; no public lifecycle database port or generic resource framework. Do not duplicate existing public identity, capability, session or workspace DTOs.

## Representation Reuse Plan

Catalog: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml. Reuse sown.options, sown.administration, sown.checkpoint, sown.safe-error and their cataloged mappings; source-owned identical shapes are not redefined at each layer. No new representation decision is authorized.

## Slice Strategy

Vertical slice from public entrypoint to actual state/effect and failure behavior. Replay-safe standalone ephemeral disposal in wave 7.

## Tasks

1. Apply exact factory support matrix/defaults to local and in-memory workspace, snapshot fake and sandbox admin options. Reject ignored/unsupported fields and invalid manual/automatic cleanup policy combinations.

2. Reserve and measure aggregate checkpoint/temp bytes during bounded copy, count failed cleanup against capacity, and use existing path ownership checks with no external symlink traversal.

3. Implement eligibility-only scheduled sweeps, terminal-time TTLs, pin-aware oldest-first collection and explicit snapshot delete conflict. Never infer terminal/orphan state solely from age.

4. Keep finite terminal catalogs and purge reserves; deny new admission instead of deleting barriers. Docker rejects portable live-volume byte limits and retains existing resource security limits.

## Acceptance

All frontmatter acceptance rows must pass for this ticket's contribution. Shared canonical rows are collectively owned by their listed dependent tickets; this ticket cannot claim downstream behavior is complete. No partial implementation is a releasable spec-36 package.

## Acceptance Test Matrix

| Local acceptance | Canonical proof | Test files |
| --- | --- | --- |
| AC-TICKET-007-BOUNDS | ACC-SOWN-BOUNDS in 04-verification.md | ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts |
| AC-TICKET-007-ADMIN | ACC-SOWN-ADMIN in 04-verification.md | ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts |
| AC-TICKET-007-DURABLE | ACC-SOWN-DURABLE in 04-verification.md | ai-harness/packages/harness/test/sandbox-retention.test.ts, ai-harness/packages/harness/test/local-workspace-retention.test.ts, ai-harness/packages/harness/test/sandbox-snapshot.test.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts |

Exact expected cases: Controlled clock and low quotas prove aggregate bytes, temp-copy failure, pins preventing eviction, unsupported field rejection, bounded cursors, catalog-full offboarding reserve, late stale create denial and no silent loss.

## End-To-End Definition Coverage

CAP-SOWN-BOUNDS / PATH-SOWN-BOUNDS; CAP-SOWN-ADMIN / PATH-SOWN-ADMIN; CAP-SOWN-DURABLE / PATH-SOWN-DURABLE map to ai-harness/specs/36-sandbox-ownership-and-administration/02-capabilities/capability-inventory.md and 03-flows/e2e-coverage.md. Those rows fix actor, reachable entrypoint, data/state, side effects, permissions, errors/recovery, owner/final state and observability. This ticket covers the implementation approach above; no frontend/client screen or new transport is introduced.

## Operational Path Coverage

Include the matching failure/recovery cases in 04-verification.md: Controlled clock and low quotas prove aggregate bytes, temp-copy failure, pins preventing eviction, unsupported field rejection, bounded cursors, catalog-full offboarding reserve, late stale create denial and no silent loss. Operator/provider actions outside default commands stay blocked until separately authorized. Cleanup remains retryable and never reports partial work as completed.

## Review And Verification Plan

An independent reviewer checks source specs, this action plan, exact tests, strict typing/generated declarations, modular placement, reuse, privacy and dirty-worktree scope. Any invented behavior, missing unhappy-path test, duplicate DTO, incompatible consumer or unverifiable claim prevents acceptance. Implementation handoff may say implemented only after all owned local checks pass.

## Verification

- CMD-BASELINE: `git -C ai-harness status --short` — Record preserved source baseline.
- CMD-SPEC: `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` — Verify approved source digest and contract controls.
- CMD-PLAN: `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` — Verify ticket digest and dependency indexes.
- CMD-HARNESS_TEST: `npm --prefix ai-harness run test --workspace @purista/harness` — Run Harness unit integration and failure regressions.
- CMD-HARNESS_TYPES: `npm --prefix ai-harness run typecheck --workspace @purista/harness` — Compile standalone Harness source.
- CMD-DOCKER_TEST: `npm --prefix ai-harness run test --workspace @purista/harness-sandbox-docker` — Run hermetic Docker transport and contract tests only.
- CMD-DOCKER_TYPES: `npm --prefix ai-harness run typecheck --workspace @purista/harness-sandbox-docker` — Compile independent Docker adapter.

## Non-goals

Production E2B/Daytona adapters or bake-off selection; new service/daemon/router; compatibility/migration helpers; destructive user-data migration; topology-dependent business logic; unrelated evaluation or handbook refactoring; publication.

## Handoff

Return changed paths, baseline/red/green commands, test counts, acceptance-row results and explicit blockers. The controller records proof and moves ready/in_progress to implemented, then review_pending; only independent review moves to accepted. Do not edit shared indexes from parallel workers. Next: Replay-safe standalone ephemeral disposal in wave 7.
