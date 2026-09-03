---
id: TICKET-001
title: Closed ownership and administration contract foundation
wave: 1
lifecycle: accepted
spec_manifest_digest: sha256:d428914333a9eab9a1f84659f3c4724028c5c4ca96c20be3c13c9edc4c4365cc
plan_manifest_digest: sha256:57fa5bbc511a90aa7bcc53096fc56a50e9db8025787adb8cda8175e9a7050039
parallel_group: serial-TICKET-001
depends_on: []
blocked_by: []
spec_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-POLICY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-WORKSPACE, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
write_scope: [ai-harness/packages/harness/src/sandbox/ownership.ts, ai-harness/packages/harness/src/sandbox/administration.ts, ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/src/index.ts, ai-harness/packages/harness/test/public-api.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts, ai-harness/packages/harness/tsconfig.type-tests.json, ai-harness/packages/harness/vitest.config.ts]
read_scope: [ai-harness/specs/36-sandbox-ownership-and-administration, AGENTS.md, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/package.json, ai-harness/packages/harness/src, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker, purista/AGENTS.md, purista/packages/core/src, purista/skills/purista, ai-harness/skills/ai-harness, specs/50-handbook/00-information-architecture.md, plans/handbook-refactor/implementation-plan.md, ai-harness/plans/sandbox-ownership]
contract_readiness:
  status: ready
  required_contracts: [CTR-SOWN-OWNER, CTR-SOWN-OPEN, CTR-SOWN-ADMIN, CTR-SOWN-OPTIONS, CTR-SOWN-ERRORS, CTR-SOWN-POLICY, CTR-SOWN-WORKSPACE]
  missing_contracts: []
traceability:
  requirement_ids: [REQ-SOWN-OWNER, REQ-SOWN-SAFETY, REQ-SOWN-DELIVERY]
  capability_ids: [CAP-SOWN-OWNER, CAP-SOWN-SAFETY, CAP-SOWN-DELIVERY]
  path_ids: [PATH-SOWN-OWNER, PATH-SOWN-SAFETY, PATH-SOWN-DELIVERY]
  acceptance_ids: [ACC-SOWN-OWNER, ACC-SOWN-SAFETY, ACC-SOWN-DELIVERY]
generated_contracts:
  status: ready
  source_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-POLICY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-WORKSPACE]
  command_refs: [CMD-HARNESS_BUILD]
  drift_command_refs: [CMD-HARNESS_TYPES, CMD-HARNESS_UNIT, CMD-HARNESS_PUBLIC_TYPES]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: foundation_exception
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml
  shape_refs: [sown.owner, sown.scope, sown.policy, sown.administration, sown.options, sown.safe-error]
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
  CMD-HARNESS_TYPES:
    command: npm --prefix ai-harness run typecheck --workspace @purista/harness
    purpose: Compile standalone Harness source
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-HARNESS_UNIT:
    command: npm --prefix ai-harness run test:unit --workspace @purista/harness
    purpose: Run source unit and schema fixtures
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-HARNESS_BUILD:
    command: npm --prefix ai-harness run build --workspace @purista/harness
    purpose: Generate compiler declarations
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
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md, ai-harness/specs/36-sandbox-ownership-and-administration/.readiness-report.yaml, ai-harness/package.json]
    command_refs: [CMD-BASELINE, CMD-SPEC, CMD-PLAN]
    acceptance_refs: [AC-TICKET-001-OWNER, AC-TICKET-001-SAFETY, AC-TICKET-001-DELIVERY]
    expected_proof: Matching approved digests and accepted dependencies; dirty baseline preserved; missing authority or prerequisite blocks work.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md, ai-harness/packages/harness/src/sandbox/ownership.ts]
    command_refs: [CMD-SPEC, CMD-HARNESS_TYPES]
    acceptance_refs: [AC-TICKET-001-OWNER, AC-TICKET-001-SAFETY, AC-TICKET-001-DELIVERY]
    expected_proof: Exact schema and public type mapping identified before runtime changes; no new semantic decision or legacy shape.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts]
    command_refs: [CMD-HARNESS_TYPES, CMD-HARNESS_UNIT, CMD-HARNESS_BUILD, CMD-HARNESS_PUBLIC_TYPES]
    acceptance_refs: [AC-TICKET-001-OWNER, AC-TICKET-001-SAFETY, AC-TICKET-001-DELIVERY]
    expected_proof: Named acceptance fixtures fail for the missing behavior before implementation; existing covered behavior recorded separately.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/packages/harness/src/sandbox/ownership.ts, ai-harness/packages/harness/src/sandbox/administration.ts, ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/src/index.ts, ai-harness/packages/harness/test/public-api.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts, ai-harness/packages/harness/tsconfig.type-tests.json, ai-harness/packages/harness/vitest.config.ts]
    command_refs: [CMD-HARNESS_TYPES, CMD-HARNESS_UNIT, CMD-HARNESS_BUILD, CMD-HARNESS_PUBLIC_TYPES]
    acceptance_refs: [AC-TICKET-001-OWNER, AC-TICKET-001-SAFETY, AC-TICKET-001-DELIVERY]
    expected_proof: Only scoped deliverable implemented with approved public shapes and exact failure behavior; no compatibility path.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts]
    command_refs: [CMD-SPEC, CMD-PLAN, CMD-HARNESS_TYPES, CMD-HARNESS_UNIT, CMD-HARNESS_BUILD, CMD-HARNESS_PUBLIC_TYPES]
    acceptance_refs: [AC-TICKET-001-OWNER, AC-TICKET-001-SAFETY, AC-TICKET-001-DELIVERY]
    expected_proof: All owned acceptance rows green; no new baseline regression; no weakened tests or thresholds; external gate reported separately.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: [CMD-BASELINE]
    acceptance_refs: [AC-TICKET-001-OWNER, AC-TICKET-001-SAFETY, AC-TICKET-001-DELIVERY]
    expected_proof: Return changed paths plus red/green command evidence and unresolved blockers; controller records lifecycle; no self acceptance.
acceptance:
  - id: AC-TICKET-001-OWNER
    traceability_acceptance_ids: [ACC-SOWN-OWNER]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-OWNER]
    test_refs: [ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts]
    command_refs: [CMD-HARNESS_TYPES, CMD-HARNESS_UNIT, CMD-HARNESS_BUILD, CMD-HARNESS_PUBLIC_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-OWNER satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: accepted
  - id: AC-TICKET-001-SAFETY
    traceability_acceptance_ids: [ACC-SOWN-SAFETY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY]
    test_refs: [ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts]
    command_refs: [CMD-HARNESS_TYPES, CMD-HARNESS_UNIT, CMD-HARNESS_BUILD, CMD-HARNESS_PUBLIC_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-SAFETY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: accepted
  - id: AC-TICKET-001-DELIVERY
    traceability_acceptance_ids: [ACC-SOWN-DELIVERY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY]
    test_refs: [ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts]
    command_refs: [CMD-HARNESS_TYPES, CMD-HARNESS_UNIT, CMD-HARNESS_BUILD, CMD-HARNESS_PUBLIC_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-DELIVERY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: accepted
---

# TICKET-001 — Closed ownership and administration contract foundation

## Goal

Create strict source-derived DTO schemas and error classes that compile without replacing the live port yet.

## Context Digest

Scope is the approved spec-36 follow-up, not the historical spec-34 completion. Current source baseline includes preserved uncommitted sandbox and unrelated evaluation/handbook work. This is the only initial ready ticket. Planning approval is not permission to implement during the current conversation.

## Implementation Approach

1. Define the exact owner, partition, binding, policy, selector, page, purge, sweep, factory-option and safe-error schemas from CTR-SOWN contracts; derive DTO types with z.infer and reuse HarnessIdentity.

2. Keep the new scope schema in the ownership module until TICKET-004 replaces the existing root SandboxScope export atomically. Do not add a second runtime port, compatibility alias or fallback adapter.

3. Add closed-schema and error-code fixtures before schema/error changes; negative types cover absent/present identity, lifetime/runId coupling, unknown fields and malformed selectors.

4. Generate declarations with the existing compiler; schema fixtures and negative type tests are the drift gate. Export only non-conflicting new contract symbols before cutover.

## Decision Ledger

D2 decisions are frozen by the canonical contracts and DEC-SOWN-BOUNDARY/DELIVERY. D0 mechanical changes and D1 private reversible helpers/test placement are the only local choices. No new dependency, public option, error family, topology flag, or ownership rule may be invented.

## Action Plan

1. Preflight: read only listed source scopes, verify both manifests and accepted prerequisites, and run CMD-BASELINE. Record pre-existing failures before changing source.

2. Contract: trace CTR-SOWN-OWNER, CTR-SOWN-OPEN, CTR-SOWN-ADMIN, CTR-SOWN-OPTIONS, CTR-SOWN-ERRORS, CTR-SOWN-POLICY, CTR-SOWN-WORKSPACE into the first owned source module and existing public exports. Compiler-generated declarations are not handwritten; strict DTO schemas and inferred types are source.

3. Test first: add or reproduce the named tests and the failure cases below before changing behavior. Record expected red tests; a skip is not red evidence.

4. Implement the numbered Implementation Approach only in write_scope. Keep the foundation private/unwired until the named cutover; it must compile and pass its direct tests.

5. Verify every acceptance row with the recorded CMD identifiers, inspect generated declarations/type tests and changed-file scope, and obtain independent review against ticket plus source specs.

6. Handoff: return proof and blockers; controller updates shared indexes and records evidence. Do not edit another ticket, mark accepted, publish a package, or fabricate external results.

## Requirements Traceability

- REQ-SOWN-OWNER -> CAP-SOWN-OWNER -> PATH-SOWN-OWNER -> ACC-SOWN-OWNER; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-SAFETY -> CAP-SOWN-SAFETY -> PATH-SOWN-SAFETY -> ACC-SOWN-SAFETY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-DELIVERY -> CAP-SOWN-DELIVERY -> PATH-SOWN-DELIVERY -> ACC-SOWN-DELIVERY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.

## Contract Traceability

- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPTIONS
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-POLICY
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-WORKSPACE

## Spec Drift Controls

Pinned source digest: sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb. Verify plan digest before edits. Forbidden interpretations: automatic empty reset, history sharing through sandbox IDs, owner deletion by borrowers, ignored quotas, expiry of recovery pins/tombstones, public provider refs and legacy overloads. A missing or contradictory requirement blocks this ticket; no silent reinterpretation. Review must compare both ticket and canonical acceptance rows.

## Generator And Type Plan

Generation map: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/generation-map.yaml. No local-port code generator exists, so handwritten generic/function interfaces are the approved boundary exception; DTOs derive from strict source schemas. Existing compiler build produces declarations; type and contract commands check drift. Do not copy types into PURISTA, widen to any, or edit generated declarations. Public TSDoc is added with the owned API, including non-obvious examples.

## Test-First Order

Reject malformed/unknown fields, invalid ULIDs, owner/key limits, unknown selector variants, non-integer quotas, invalid reserve/cap ratios and old enabled fields; exact class/code/category/retriable metadata; no identity in errors. Run the listed test files before the behavior change, then after; record exact red and green results. Include cancellation/denial/retry/state-loss assertions and content-free error projection when those paths are in scope.

## Modularity And Reuse Plan

Reuse the modules and public exports in ai-harness/specs/36-sandbox-ownership-and-administration/00-reuse-inventory.yaml and 04-delivery.md. New helper files stay inside the owned domain folders. Extend existing catalog/error/identity/SQLite/engine mechanisms; no public lifecycle database port or generic resource framework. Do not duplicate existing public identity, capability, session or workspace DTOs.

## Representation Reuse Plan

Catalog: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml. Reuse sown.owner, sown.scope, sown.policy, sown.administration, sown.options, sown.safe-error and their cataloged mappings; source-owned identical shapes are not redefined at each layer. No new representation decision is authorized.

## Slice Strategy

Approved horizontal foundation exception: only contract/private primitives, with direct tests and no parallel runtime contract. Private local/Docker catalog foundations in wave 2.

## Tasks

1. Define the exact owner, partition, binding, policy, selector, page, purge, sweep, factory-option and safe-error schemas from CTR-SOWN contracts; derive DTO types with z.infer and reuse HarnessIdentity.

2. Keep the new scope schema in the ownership module until TICKET-004 replaces the existing root SandboxScope export atomically. Do not add a second runtime port, compatibility alias or fallback adapter.

3. Add closed-schema and error-code fixtures before schema/error changes; negative types cover absent/present identity, lifetime/runId coupling, unknown fields and malformed selectors.

4. Generate declarations with the existing compiler; schema fixtures and negative type tests are the drift gate. Export only non-conflicting new contract symbols before cutover.

## Acceptance

All frontmatter acceptance rows must pass for this ticket's contribution. Shared canonical rows are collectively owned by their listed dependent tickets; this ticket cannot claim downstream behavior is complete. No partial implementation is a releasable spec-36 package.

## Acceptance Test Matrix

| Local acceptance | Canonical proof | Test files |
| --- | --- | --- |
| AC-TICKET-001-OWNER | ACC-SOWN-OWNER in 04-verification.md | ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts |
| AC-TICKET-001-SAFETY | ACC-SOWN-SAFETY in 04-verification.md | ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts |
| AC-TICKET-001-DELIVERY | ACC-SOWN-DELIVERY in 04-verification.md | ai-harness/packages/harness/src/sandbox/ownership.test.ts, ai-harness/packages/harness/src/sandbox/administration.test.ts, ai-harness/packages/harness/src/errors/catalog.test.ts, ai-harness/packages/harness/type-tests/sandbox-ownership.ts |

Exact expected cases: Reject malformed/unknown fields, invalid ULIDs, owner/key limits, unknown selector variants, non-integer quotas, invalid reserve/cap ratios and old enabled fields; exact class/code/category/retriable metadata; no identity in errors.

## End-To-End Definition Coverage

CAP-SOWN-OWNER / PATH-SOWN-OWNER; CAP-SOWN-SAFETY / PATH-SOWN-SAFETY; CAP-SOWN-DELIVERY / PATH-SOWN-DELIVERY map to ai-harness/specs/36-sandbox-ownership-and-administration/02-capabilities/capability-inventory.md and 03-flows/e2e-coverage.md. Those rows fix actor, reachable entrypoint, data/state, side effects, permissions, errors/recovery, owner/final state and observability. This ticket covers the implementation approach above; no frontend/client screen or new transport is introduced.

## Operational Path Coverage

Include the matching failure/recovery cases in 04-verification.md: Reject malformed/unknown fields, invalid ULIDs, owner/key limits, unknown selector variants, non-integer quotas, invalid reserve/cap ratios and old enabled fields; exact class/code/category/retriable metadata; no identity in errors. Operator/provider actions outside default commands stay blocked until separately authorized. Cleanup remains retryable and never reports partial work as completed.

## Review And Verification Plan

An independent reviewer checks source specs, this action plan, exact tests, strict typing/generated declarations, modular placement, reuse, privacy and dirty-worktree scope. Any invented behavior, missing unhappy-path test, duplicate DTO, incompatible consumer or unverifiable claim prevents acceptance. Implementation handoff may say implemented only after all owned local checks pass.

## Verification

- CMD-BASELINE: `git -C ai-harness status --short` — Record preserved source baseline.
- CMD-SPEC: `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` — Verify approved source digest and contract controls.
- CMD-PLAN: `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` — Verify ticket digest and dependency indexes.
- CMD-HARNESS_TYPES: `npm --prefix ai-harness run typecheck --workspace @purista/harness` — Compile standalone Harness source.
- CMD-HARNESS_UNIT: `npm --prefix ai-harness run test:unit --workspace @purista/harness` — Run source unit and schema fixtures.
- CMD-HARNESS_BUILD: `npm --prefix ai-harness run build --workspace @purista/harness` — Generate compiler declarations.
- CMD-HARNESS_PUBLIC_TYPES: `npm --prefix ai-harness run test:types` — Verify public inference and negative type cases.

## Non-goals

Production E2B/Daytona adapters or bake-off selection; new service/daemon/router; compatibility/migration helpers; destructive user-data migration; topology-dependent business logic; unrelated evaluation or handbook refactoring; publication.

## Handoff

Return changed paths, baseline/red/green commands, test counts, acceptance-row results and explicit blockers. The controller records proof and moves ready/in_progress to implemented, then review_pending; only independent review moves to accepted. Do not edit shared indexes from parallel workers. Next: Private local/Docker catalog foundations in wave 2.
