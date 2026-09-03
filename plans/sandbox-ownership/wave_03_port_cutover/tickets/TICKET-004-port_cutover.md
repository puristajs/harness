---
id: TICKET-004
title: Atomic Sandbox port and lazy implicit-owner cutover
wave: 3
lifecycle: planned
spec_manifest_digest: sha256:d428914333a9eab9a1f84659f3c4724028c5c4ca96c20be3c13c9edc4c4365cc
plan_manifest_digest: sha256:57fa5bbc511a90aa7bcc53096fc56a50e9db8025787adb8cda8175e9a7050039
parallel_group: serial-TICKET-004
depends_on: [TICKET-002, TICKET-003, TICKET-013, TICKET-014]
blocked_by: [TICKET-014]
spec_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
write_scope: [ai-harness/packages/harness/src/sandbox, ai-harness/packages/harness/src/local, ai-harness/packages/harness/src/models/state.ts, ai-harness/packages/harness/src/storage, ai-harness/packages/harness/src/sessions/sandboxBindings.ts, ai-harness/packages/harness/src/sessions/index.ts, ai-harness/packages/harness/src/harness/defineHarness.ts, ai-harness/packages/harness/src/index.ts, ai-harness/packages/harness/src/testing, ai-harness/packages/harness/src/tools/mcp, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker/src/index.ts, ai-harness/packages/harness-sandbox-docker/src/lifecycle.ts, ai-harness/packages/harness-sandbox-docker/src/records.ts, ai-harness/packages/harness-sandbox-docker/src/options.ts, ai-harness/packages/harness-sandbox-docker/src/session.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, ai-harness/packages/harness-sandbox-docker/src/index.test.ts, ai-harness/scripts/fixtures/sandbox-package-consumer.ts]
read_scope: [ai-harness/specs/36-sandbox-ownership-and-administration, AGENTS.md, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/package.json, ai-harness/packages/harness/src, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker, purista/AGENTS.md, purista/packages/core/src, purista/skills/purista, ai-harness/skills/ai-harness, specs/50-handbook/00-information-architecture.md, plans/handbook-refactor/implementation-plan.md, ai-harness/plans/sandbox-ownership]
contract_readiness:
  status: ready
  required_contracts: [CTR-SOWN-OWNER, CTR-SOWN-OPEN, CTR-SOWN-ADMIN, CTR-SOWN-OPTIONS]
  missing_contracts: []
traceability:
  requirement_ids: [REQ-SOWN-OWNER, REQ-SOWN-ADMIN, REQ-SOWN-DELIVERY]
  capability_ids: [CAP-SOWN-OWNER, CAP-SOWN-ADMIN, CAP-SOWN-DELIVERY]
  path_ids: [PATH-SOWN-OWNER, PATH-SOWN-ADMIN, PATH-SOWN-DELIVERY]
  acceptance_ids: [ACC-SOWN-OWNER, ACC-SOWN-ADMIN, ACC-SOWN-DELIVERY]
generated_contracts:
  status: ready
  source_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS]
  command_refs: []
  drift_command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-WORKSPACE_TYPES, CMD-PURISTA_TYPES]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: refactor_exception
phase_gate_exception: true
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml
  shape_refs: [sown.owner, sown.scope, sown.binding, sown.administration, sown.options]
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
    purpose: Preserve Harness coverage thresholds through the atomic cutover
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-ARCHITECTURE:
    command: npm --prefix ai-harness run verify:architecture
    purpose: Verify package and decision boundaries after public port replacement
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-SANDBOX_PACKAGES:
    command: npm --prefix ai-harness run verify:sandbox-packages
    purpose: Pack Harness and Docker and verify their isolated no-Core public consumer
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-HARNESS_PUBLIC_TYPES:
    command: npm --prefix ai-harness run test:types
    purpose: Verify public inference and negative type cases
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
  CMD-WORKSPACE_TYPES:
    command: npm --prefix ai-harness run typecheck
    purpose: Compile all affected Harness workspace consumers
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-PURISTA_TYPES:
    command: node ai-harness/scripts/check-purista-sandbox.mjs --mode source
    purpose: Compile and test staged Core against actual packed local Harness
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md, ai-harness/specs/36-sandbox-ownership-and-administration/.readiness-report.yaml, ai-harness/package.json]
    command_refs: [CMD-BASELINE, CMD-SPEC, CMD-PLAN]
    acceptance_refs: [AC-TICKET-004-OWNER, AC-TICKET-004-ADMIN, AC-TICKET-004-DELIVERY]
    expected_proof: Matching approved digests and accepted dependencies; dirty baseline preserved; missing authority or prerequisite blocks work.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md, ai-harness/packages/harness/src/sandbox]
    command_refs: [CMD-SPEC, CMD-HARNESS_PUBLIC_TYPES]
    acceptance_refs: [AC-TICKET-004-OWNER, AC-TICKET-004-ADMIN, AC-TICKET-004-DELIVERY]
    expected_proof: Exact schema and public type mapping identified before runtime changes; no new semantic decision or legacy shape.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness/test/sandbox-ownership.test.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/session-lifecycle.test.ts, ai-harness/packages/harness/src/storage/storage-contract.test.ts, ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-WORKSPACE_TYPES, CMD-PURISTA_TYPES]
    acceptance_refs: [AC-TICKET-004-OWNER, AC-TICKET-004-ADMIN, AC-TICKET-004-DELIVERY]
    expected_proof: Named acceptance fixtures fail for the missing behavior before implementation; existing covered behavior recorded separately.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/packages/harness/src/sandbox, ai-harness/packages/harness/src/local, ai-harness/packages/harness/src/models/state.ts, ai-harness/packages/harness/src/storage, ai-harness/packages/harness/src/sessions/sandboxBindings.ts, ai-harness/packages/harness/src/sessions/index.ts, ai-harness/packages/harness/src/harness/defineHarness.ts, ai-harness/packages/harness/src/index.ts, ai-harness/packages/harness/src/testing, ai-harness/packages/harness/src/tools/mcp, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker/src/index.ts, ai-harness/packages/harness-sandbox-docker/src/lifecycle.ts, ai-harness/packages/harness-sandbox-docker/src/records.ts, ai-harness/packages/harness-sandbox-docker/src/options.ts, ai-harness/packages/harness-sandbox-docker/src/session.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, ai-harness/packages/harness-sandbox-docker/src/index.test.ts, ai-harness/scripts/fixtures/sandbox-package-consumer.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-WORKSPACE_TYPES, CMD-PURISTA_TYPES]
    acceptance_refs: [AC-TICKET-004-OWNER, AC-TICKET-004-ADMIN, AC-TICKET-004-DELIVERY]
    expected_proof: Only scoped deliverable implemented with approved public shapes and exact failure behavior; no compatibility path.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness/test/sandbox-ownership.test.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/session-lifecycle.test.ts, ai-harness/packages/harness/src/storage/storage-contract.test.ts, ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-SPEC, CMD-PLAN, CMD-HARNESS_TEST, CMD-HARNESS_COVERAGE, CMD-ARCHITECTURE, CMD-SANDBOX_PACKAGES, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-WORKSPACE_TYPES, CMD-PURISTA_TYPES]
    acceptance_refs: [AC-TICKET-004-OWNER, AC-TICKET-004-ADMIN, AC-TICKET-004-DELIVERY]
    expected_proof: All owned acceptance rows green; no new baseline regression; no weakened tests or thresholds; external gate reported separately.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: [CMD-BASELINE]
    acceptance_refs: [AC-TICKET-004-OWNER, AC-TICKET-004-ADMIN, AC-TICKET-004-DELIVERY]
    expected_proof: Return changed paths plus red/green command evidence and unresolved blockers; controller records lifecycle; no self acceptance.
acceptance:
  - id: AC-TICKET-004-OWNER
    traceability_acceptance_ids: [ACC-SOWN-OWNER]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-OWNER]
    test_refs: [ai-harness/packages/harness/test/sandbox-ownership.test.ts, ai-harness/packages/harness/test/session-lifecycle.test.ts, ai-harness/packages/harness/src/storage/storage-contract.test.ts, ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-WORKSPACE_TYPES, CMD-PURISTA_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-OWNER satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-004-ADMIN
    traceability_acceptance_ids: [ACC-SOWN-ADMIN]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN]
    test_refs: [ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/session-lifecycle.test.ts, ai-harness/packages/harness/src/storage/storage-contract.test.ts, ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-WORKSPACE_TYPES, CMD-PURISTA_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-ADMIN satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-004-DELIVERY
    traceability_acceptance_ids: [ACC-SOWN-DELIVERY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY]
    test_refs: [ai-harness/packages/harness/test/sandbox-ownership.test.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/session-lifecycle.test.ts, ai-harness/packages/harness/src/storage/storage-contract.test.ts, ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_COVERAGE, CMD-ARCHITECTURE, CMD-SANDBOX_PACKAGES, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_TYPES, CMD-DOCKER_TEST, CMD-DOCKER_TYPES, CMD-WORKSPACE_TYPES, CMD-PURISTA_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-DELIVERY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
---

# TICKET-004 — Atomic Sandbox port and lazy implicit-owner cutover

## Goal

Replace the existing base port and all direct callers together, including lazy
session ownership. It does not implement sharing policy resolution, durable
workspace metadata, owner disposal, replay, or PURISTA mapping.

## Context Digest

Scope is the approved spec-36 follow-up, not the historical spec-34 completion. Current source baseline includes preserved uncommitted sandbox and unrelated evaluation/handbook work. TICKET-002, TICKET-003, and TICKET-013 are independently accepted. The controller has promoted this ticket for the approved atomic implementation task.

## Implementation Approach

1. Phase A: replace SandboxScope with owner/partition/lifetime, require registerOwner and administration, add actor identity to open and snapshot resume, and bind all built-in/fake/Docker factories to prepared private catalogs.

2. Phase B: persist immutable SessionSandboxBinding in memory/SQLite/fake storage with conditional acknowledgement and disposed transitions. Change getSession to SessionOptions and defer partition compute until invocation; registration acknowledgement precedes compute.

3. Phase C: mechanically replace every affected Sandbox adapter, fake, Harness caller, public fixture, and standalone package consumer. Old layouts fail before writes; no converter or overloaded compatibility signature.

4. Later tickets own the remaining vertical behavior: TICKET-005 resolves definition sharing, TICKET-006 owns workspace metadata and aggregate recovery, TICKET-008 owns dispose/close ordering and replay, and TICKET-009 maps PURISTA public configuration. This ticket must not pre-implement any of them.

## Decision Ledger

D2 decisions are frozen by the canonical contracts and DEC-SOWN-BOUNDARY/DELIVERY. D0 mechanical changes and D1 private reversible helpers/test placement are the only local choices. No new dependency, public option, error family, topology flag, or ownership rule may be invented.

## Action Plan

1. Preflight: read only listed source scopes, verify both manifests and accepted prerequisites, and run CMD-BASELINE. Record pre-existing failures before changing source.

2. Contract: trace CTR-SOWN-OWNER, CTR-SOWN-OPEN, CTR-SOWN-ADMIN, CTR-SOWN-OPTIONS into the first owned source module and existing public exports. Compiler-generated declarations are not handwritten; strict DTO schemas and inferred types are source.

3. Test first: add or reproduce the named tests and the failure cases below before changing behavior. Record expected red tests; a skip is not red evidence.

4. Implement the numbered Implementation Approach only in write_scope. Phase Gate: after Phase A/B schema/registration tests pass, complete Phase C's full caller cutover; all listed type and regression commands must pass before handoff. This atomic boundary refactor is not independently releasable midway.

5. Verify every acceptance row with the recorded CMD identifiers, inspect generated declarations/type tests and changed-file scope, and obtain independent review against ticket plus source specs.

6. Handoff: return proof and blockers; controller updates shared indexes and records evidence. Do not edit another ticket, mark accepted, publish a package, or fabricate external results.

## Requirements Traceability

- REQ-SOWN-OWNER -> CAP-SOWN-OWNER -> PATH-SOWN-OWNER -> ACC-SOWN-OWNER; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-ADMIN -> CAP-SOWN-ADMIN -> PATH-SOWN-ADMIN -> ACC-SOWN-ADMIN; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-DELIVERY -> CAP-SOWN-DELIVERY -> PATH-SOWN-DELIVERY -> ACC-SOWN-DELIVERY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.

## Contract Traceability

- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS

## Spec Drift Controls

Pinned source digest: sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb. Verify plan digest before edits. Forbidden interpretations: automatic empty reset, history sharing through sandbox IDs, owner deletion by borrowers, ignored quotas, expiry of recovery pins/tombstones, public provider refs and legacy overloads. A missing or contradictory requirement blocks this ticket; no silent reinterpretation. Review must compare both ticket and canonical acceptance rows.

## Generator And Type Plan

Generation map: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/generation-map.yaml. No local-port code generator exists, so handwritten generic/function interfaces are the approved boundary exception; DTOs derive from strict source schemas. Existing compiler build produces declarations; type and contract commands check drift. Do not copy types into PURISTA, widen to any, or edit generated declarations. Public TSDoc is added with the owned API, including non-obvious examples.

## Test-First Order

Never-used session survives get/release/restart then initializes; existing missing owner/provider fails; pending registration crash replay; simultaneous creators use winner; adapter administration works through only the public Sandbox property; old signatures fail type tests. Add the canonical public sandbox-administration integration test before wiring live catalogs. Run the listed test files before the behavior change, then after; record exact red and green results. Include cancellation/denial/retry/state-loss assertions and content-free error projection when those paths are in scope. Close/purge ordering belongs to TICKET-008.

## Modularity And Reuse Plan

Reuse the modules and public exports in ai-harness/specs/36-sandbox-ownership-and-administration/00-reuse-inventory.yaml and 04-delivery.md. New helper files stay inside the owned domain folders. Extend existing catalog/error/identity/SQLite/engine mechanisms; no public lifecycle database port or generic resource framework. Do not duplicate existing public identity, capability, session or workspace DTOs.

## Representation Reuse Plan

Catalog: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml. Reuse sown.owner, sown.scope, sown.binding, sown.administration, sown.options and their cataloged mappings; source-owned identical shapes are not redefined at each layer. No new representation decision is authorized.

## Slice Strategy

Approved atomic refactor exception: splitting the required Sandbox port/callers would create an incompatible half-cutover. Phase gates block completion until the integrated boundary is green. Typed sharing policy becomes the next vertical application slice in wave 4.

## Tasks

1. Phase A: replace SandboxScope with owner/partition/lifetime, require registerOwner and administration, add actor identity to open and snapshot resume, and bind all built-in/fake/Docker factories to prepared private catalogs.

2. Phase B: persist immutable SessionSandboxBinding in memory/SQLite/fake storage with conditional acknowledgement and disposed transitions. Change getSession to SessionOptions and defer partition compute until invocation; registration acknowledgement precedes compute.

3. Phase C: mechanically replace every affected Sandbox adapter, fake, Harness caller, public fixture, and standalone package consumer. Do not alter evaluation behavior or unrelated handbook files. Old layouts fail before writes; no converter or overloaded compatibility signature.

4. Do not add policy resolution, durable metadata, Session.disposeSandbox, replay, or PURISTA changes here; TICKET-005, TICKET-006, TICKET-008, and TICKET-009 own those behaviors.

## Acceptance

All frontmatter acceptance rows must pass for this ticket's contribution. Shared canonical rows are collectively owned by their listed dependent tickets; this ticket cannot claim downstream behavior is complete. No partial implementation is a releasable spec-36 package.

## Acceptance Test Matrix

| Local acceptance | Canonical proof | Test files |
| --- | --- | --- |
| AC-TICKET-004-OWNER | ACC-SOWN-OWNER in 04-verification.md | ai-harness/packages/harness/test/sandbox-ownership.test.ts, ai-harness/packages/harness/test/session-lifecycle.test.ts, ai-harness/packages/harness/src/storage/storage-contract.test.ts, ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts |
| AC-TICKET-004-ADMIN | ACC-SOWN-ADMIN in 04-verification.md | ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/session-lifecycle.test.ts, ai-harness/packages/harness/src/storage/storage-contract.test.ts, ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts |
| AC-TICKET-004-DELIVERY | ACC-SOWN-DELIVERY in 04-verification.md | ai-harness/packages/harness/test/sandbox-ownership.test.ts, ai-harness/packages/harness/test/sandbox-administration.test.ts, ai-harness/packages/harness/test/session-lifecycle.test.ts, ai-harness/packages/harness/src/storage/storage-contract.test.ts, ai-harness/packages/harness/src/testing/sandboxContract.ts, ai-harness/packages/harness-sandbox-docker/src/administration.test.ts; full Harness coverage, architecture, and isolated no-Core package checks |

Exact expected cases: Never-used session survives get/release/restart then initializes; existing missing owner/provider fails; pending registration crash replay; simultaneous creators use winner; public administration is reachable without provider-reference leakage; old signatures fail type tests. Close ordering and borrowed-owner purge semantics are owned by TICKET-008.

## End-To-End Definition Coverage

CAP-SOWN-OWNER / PATH-SOWN-OWNER; CAP-SOWN-ADMIN / PATH-SOWN-ADMIN; CAP-SOWN-DELIVERY / PATH-SOWN-DELIVERY map to ai-harness/specs/36-sandbox-ownership-and-administration/02-capabilities/capability-inventory.md and 03-flows/e2e-coverage.md. Those rows fix actor, reachable entrypoint, data/state, side effects, permissions, errors/recovery, owner/final state and observability. This ticket covers the implementation approach above; no frontend/client screen or new transport is introduced.

## Operational Path Coverage

Include the matching failure/recovery cases in 04-verification.md: Never-used session survives get/release/restart then initializes; existing missing owner/provider fails; pending registration crash replay; simultaneous creators use winner; close waits for sandbox then workspace purge; borrowed close spares owner; old signatures fail type tests. Operator/provider actions outside default commands stay blocked until separately authorized. Cleanup remains retryable and never reports partial work as completed.

## Review And Verification Plan

An independent reviewer checks source specs, this action plan, exact tests, strict typing/generated declarations, modular placement, reuse, privacy and dirty-worktree scope. Any invented behavior, missing unhappy-path test, duplicate DTO, incompatible consumer or unverifiable claim prevents acceptance. Implementation handoff may say implemented only after all owned local checks pass.

## Verification

- CMD-BASELINE: `git -C ai-harness status --short` — Record preserved source baseline.
- CMD-SPEC: `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` — Verify approved source digest and contract controls.
- CMD-PLAN: `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` — Verify ticket digest and dependency indexes.
- CMD-HARNESS_TEST: `npm --prefix ai-harness run test --workspace @purista/harness` — Run Harness unit integration and failure regressions.
- CMD-HARNESS_COVERAGE: `npm --prefix ai-harness run test:coverage --workspace @purista/harness` — Preserve coverage thresholds through the cutover.
- CMD-ARCHITECTURE: `npm --prefix ai-harness run verify:architecture` — Verify package and decision boundaries.
- CMD-SANDBOX_PACKAGES: `npm --prefix ai-harness run verify:sandbox-packages` — Verify packed Harness/Docker against an isolated no-Core consumer.
- CMD-HARNESS_PUBLIC_TYPES: `npm --prefix ai-harness run test:types` — Verify public inference and negative type cases.
- CMD-HARNESS_TYPES: `npm --prefix ai-harness run typecheck --workspace @purista/harness` — Compile standalone Harness source.
- CMD-DOCKER_TEST: `npm --prefix ai-harness run test --workspace @purista/harness-sandbox-docker` — Run hermetic Docker transport and contract tests only.
- CMD-DOCKER_TYPES: `npm --prefix ai-harness run typecheck --workspace @purista/harness-sandbox-docker` — Compile independent Docker adapter.
- CMD-WORKSPACE_TYPES: `npm --prefix ai-harness run typecheck` — Compile all affected Harness workspace consumers.
- CMD-PURISTA_TYPES: `node ai-harness/scripts/check-purista-sandbox.mjs --mode source` — Compile framework unit consumers against public Harness.

## Non-goals

Production E2B/Daytona adapters or bake-off selection; new service/daemon/router; compatibility/migration helpers; destructive user-data migration; topology-dependent business logic; unrelated evaluation or handbook refactoring; publication.

## Handoff

Return changed paths, baseline/red/green commands, test counts, acceptance-row results and explicit blockers. The controller records proof and moves ready/in_progress to implemented, then review_pending; only independent review moves to accepted. Do not edit shared indexes from parallel workers. Next: Typed sharing policy becomes the next vertical application slice in wave 4.


The workspace intermediate boundary follows 04-delivery exactly: real owner/admin only in this cutover; no placeholder pin/release/finish methods. Copied checkpoints stay protected pending publication reconciliation. Unsupported TTL/GC options remain rejected until their owning ticket. The packed-PURISTA runner must exist before any Framework proof is credited.
