---
id: TICKET-012
title: Independent clean-release review and local-engine evidence gate
wave: 11
lifecycle: planned
spec_manifest_digest: sha256:d428914333a9eab9a1f84659f3c4724028c5c4ca96c20be3c13c9edc4c4365cc
plan_manifest_digest: sha256:57fa5bbc511a90aa7bcc53096fc56a50e9db8025787adb8cda8175e9a7050039
parallel_group: serial-TICKET-012
depends_on: [TICKET-011]
blocked_by: [TICKET-011]
spec_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DURABLE, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-PURISTA, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-POLICY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-WORKSPACE, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS, ai-harness/specs/36-sandbox-ownership-and-administration/05-purista.md#CTR-SOWN-PURISTA, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
write_scope: [ai-harness/plans/sandbox-ownership/evidence, ai-harness/plans/sandbox-ownership/reviews]
read_scope: [ai-harness/specs/36-sandbox-ownership-and-administration, AGENTS.md, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/package.json, ai-harness/packages/harness/src, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker, purista/AGENTS.md, purista/packages/core/src, purista/skills/purista, ai-harness/skills/ai-harness, specs/50-handbook/00-information-architecture.md, plans/handbook-refactor/implementation-plan.md, ai-harness/plans/sandbox-ownership]
contract_readiness:
  status: ready
  required_contracts: [CTR-SOWN-POLICY, CTR-SOWN-OWNER, CTR-SOWN-OPEN, CTR-SOWN-ADMIN, CTR-SOWN-WORKSPACE, CTR-SOWN-ERRORS, CTR-SOWN-PURISTA]
  missing_contracts: []
traceability:
  requirement_ids: [REQ-SOWN-DELIVERY, REQ-SOWN-SAFETY, REQ-SOWN-ADMIN, REQ-SOWN-DURABLE, REQ-SOWN-PURISTA]
  capability_ids: [CAP-SOWN-DELIVERY, CAP-SOWN-SAFETY, CAP-SOWN-ADMIN, CAP-SOWN-DURABLE, CAP-SOWN-PURISTA]
  path_ids: [PATH-SOWN-DELIVERY, PATH-SOWN-SAFETY, PATH-SOWN-ADMIN, PATH-SOWN-DURABLE, PATH-SOWN-PURISTA]
  acceptance_ids: [ACC-SOWN-DELIVERY, ACC-SOWN-SAFETY, ACC-SOWN-ADMIN, ACC-SOWN-DURABLE, ACC-SOWN-PURISTA]
generated_contracts:
  status: ready
  source_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-POLICY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-WORKSPACE, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS, ai-harness/specs/36-sandbox-ownership-and-administration/05-purista.md#CTR-SOWN-PURISTA]
  command_refs: []
  drift_command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-WORKSPACE_TYPES, CMD-DOCKER_TEST, CMD-PACKAGES, CMD-PURISTA_TEST, CMD-PURISTA_TYPES]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: remediation
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml
  shape_refs: [sown.owner, sown.scope, sown.administration, sown.checkpoint, sown.framework-policy, sown.safe-error]
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
  CMD-HARNESS_PUBLIC_TYPES:
    command: npm --prefix ai-harness run test:types
    purpose: Verify public inference and negative type cases
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
  CMD-WORKSPACE_TYPES:
    command: npm --prefix ai-harness run typecheck
    purpose: Compile all affected Harness workspace consumers
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
  CMD-PURISTA_TEST:
    command: node ai-harness/scripts/check-purista-sandbox.mjs --mode source
    purpose: Compile and test staged Core against actual packed local Harness
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
  CMD-SKILLS:
    command: npm --prefix purista run audit:skills
    purpose: Verify canonical skill consistency
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-KNOWLEDGE:
    command: npm --prefix purista run audit:knowledge
    purpose: Verify canonical public knowledge consistency
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-PURISTA_CONSUMER:
    command: node ai-harness/scripts/check-purista-sandbox.mjs --mode consumer
    purpose: Strict packed Core and Harness public consumer release gate
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md, ai-harness/specs/36-sandbox-ownership-and-administration/.readiness-report.yaml, ai-harness/package.json]
    command_refs: [CMD-BASELINE, CMD-SPEC, CMD-PLAN]
    acceptance_refs: [AC-TICKET-012-DELIVERY, AC-TICKET-012-SAFETY, AC-TICKET-012-ADMIN, AC-TICKET-012-DURABLE, AC-TICKET-012-PURISTA]
    expected_proof: Matching approved digests and accepted dependencies; dirty baseline preserved; missing authority or prerequisite blocks work.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md, ai-harness/plans/sandbox-ownership/evidence]
    command_refs: [CMD-SPEC, CMD-HARNESS_PUBLIC_TYPES]
    acceptance_refs: [AC-TICKET-012-DELIVERY, AC-TICKET-012-SAFETY, AC-TICKET-012-ADMIN, AC-TICKET-012-DURABLE, AC-TICKET-012-PURISTA]
    expected_proof: Exact schema and public type mapping identified before runtime changes; no new semantic decision or legacy shape.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_COVERAGE, CMD-WORKSPACE_TYPES, CMD-DOCKER_TEST, CMD-ARCHITECTURE, CMD-PACKAGES, CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-SKILLS, CMD-KNOWLEDGE]
    acceptance_refs: [AC-TICKET-012-DELIVERY, AC-TICKET-012-SAFETY, AC-TICKET-012-ADMIN, AC-TICKET-012-DURABLE, AC-TICKET-012-PURISTA]
    expected_proof: Existing implementation proof independently reproduced; unavailable evidence remains blocked.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/plans/sandbox-ownership/evidence, ai-harness/plans/sandbox-ownership/reviews]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_COVERAGE, CMD-WORKSPACE_TYPES, CMD-DOCKER_TEST, CMD-ARCHITECTURE, CMD-PACKAGES, CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-SKILLS, CMD-KNOWLEDGE]
    acceptance_refs: [AC-TICKET-012-DELIVERY, AC-TICKET-012-SAFETY, AC-TICKET-012-ADMIN, AC-TICKET-012-DURABLE, AC-TICKET-012-PURISTA]
    expected_proof: Independent findings and real evidence recorded without source edits or invented pass claims.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts]
    command_refs: [CMD-SPEC, CMD-PLAN, CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_COVERAGE, CMD-WORKSPACE_TYPES, CMD-DOCKER_TEST, CMD-ARCHITECTURE, CMD-PACKAGES, CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-SKILLS, CMD-KNOWLEDGE, CMD-PURISTA_CONSUMER]
    acceptance_refs: [AC-TICKET-012-DELIVERY, AC-TICKET-012-SAFETY, AC-TICKET-012-ADMIN, AC-TICKET-012-DURABLE, AC-TICKET-012-PURISTA]
    expected_proof: All owned acceptance rows green; no new baseline regression; no weakened tests or thresholds; external gate reported separately.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: [CMD-BASELINE]
    acceptance_refs: [AC-TICKET-012-DELIVERY, AC-TICKET-012-SAFETY, AC-TICKET-012-ADMIN, AC-TICKET-012-DURABLE, AC-TICKET-012-PURISTA]
    expected_proof: Return changed paths plus red/green command evidence and unresolved blockers; controller records lifecycle; no self acceptance.
acceptance:
  - id: AC-TICKET-012-DELIVERY
    traceability_acceptance_ids: [ACC-SOWN-DELIVERY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY]
    test_refs: [ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_COVERAGE, CMD-WORKSPACE_TYPES, CMD-DOCKER_TEST, CMD-ARCHITECTURE, CMD-PACKAGES, CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-SKILLS, CMD-KNOWLEDGE, CMD-PURISTA_CONSUMER]
    expected_outcome: This ticket contribution to ACC-SOWN-DELIVERY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-012-SAFETY
    traceability_acceptance_ids: [ACC-SOWN-SAFETY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY]
    test_refs: [ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_COVERAGE, CMD-WORKSPACE_TYPES, CMD-DOCKER_TEST, CMD-ARCHITECTURE, CMD-PACKAGES, CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-SKILLS, CMD-KNOWLEDGE, CMD-PURISTA_CONSUMER]
    expected_outcome: This ticket contribution to ACC-SOWN-SAFETY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-012-ADMIN
    traceability_acceptance_ids: [ACC-SOWN-ADMIN]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-ADMIN]
    test_refs: [ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_COVERAGE, CMD-WORKSPACE_TYPES, CMD-DOCKER_TEST, CMD-ARCHITECTURE, CMD-PACKAGES, CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-SKILLS, CMD-KNOWLEDGE, CMD-PURISTA_CONSUMER]
    expected_outcome: This ticket contribution to ACC-SOWN-ADMIN satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-012-DURABLE
    traceability_acceptance_ids: [ACC-SOWN-DURABLE]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DURABLE]
    test_refs: [ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_COVERAGE, CMD-WORKSPACE_TYPES, CMD-DOCKER_TEST, CMD-ARCHITECTURE, CMD-PACKAGES, CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-SKILLS, CMD-KNOWLEDGE, CMD-PURISTA_CONSUMER]
    expected_outcome: This ticket contribution to ACC-SOWN-DURABLE satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-012-PURISTA
    traceability_acceptance_ids: [ACC-SOWN-PURISTA]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-PURISTA]
    test_refs: [ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts]
    command_refs: [CMD-HARNESS_TEST, CMD-HARNESS_PUBLIC_TYPES, CMD-HARNESS_COVERAGE, CMD-WORKSPACE_TYPES, CMD-DOCKER_TEST, CMD-ARCHITECTURE, CMD-PACKAGES, CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-SKILLS, CMD-KNOWLEDGE, CMD-PURISTA_CONSUMER]
    expected_outcome: This ticket contribution to ACC-SOWN-PURISTA satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
---

# TICKET-012 — Independent clean-release review and local-engine evidence gate

## Goal

Independently verify the integrated clean break and record release limits without implementing new behavior.

## Context Digest

Scope is the approved spec-36 follow-up, not the historical spec-34 completion. Current source baseline includes preserved uncommitted sandbox and unrelated evaluation/handbook work. Do not start until TICKET-011 are independently accepted and the controller promotes this ticket. Planning approval is not permission to implement during the current conversation.

## Implementation Approach

1. Review actual changed files against every canonical acceptance row and public contract; compare dirty-worktree baseline so unrelated evaluation/handbook work is not credited or overwritten.

2. Rerun full offline tests/types/coverage, architecture, packed Harness/Docker consumers and PURISTA checks. Record commands, versions, counts and exact failures; do not waive old declaration failures as feature acceptance.

3. Require fresh opt-in real local Docker evidence for changed lifecycle behavior; the owner/operator explicitly authorizes engine/image use separately. Default commands below do not grant engine mutation or image acquisition.

4. Inspect recorded live engine/OS/image digest, all non-skipped tests, exact owned cleanup, and supported-platform claims. Prior spec-34 live results do not prove new ownership behavior.

5. Record accepted only when independent evidence covers all rows and external gate is satisfied. Missing live infrastructure is a release blocker, not a reason to fabricate proof or choose another provider.

## Decision Ledger

D2 decisions are frozen by the canonical contracts and DEC-SOWN-BOUNDARY/DELIVERY. D0 mechanical changes and D1 private reversible helpers/test placement are the only local choices. Real-engine execution and publication require separate caller authority.

## Action Plan

1. Preflight: read only listed source scopes, verify both manifests and accepted prerequisites, and run CMD-BASELINE. Record pre-existing failures before changing source.

2. Contract: trace CTR-SOWN-POLICY, CTR-SOWN-OWNER, CTR-SOWN-OPEN, CTR-SOWN-ADMIN, CTR-SOWN-WORKSPACE, CTR-SOWN-ERRORS, CTR-SOWN-PURISTA into the first owned source module and existing public exports. Compiler-generated declarations are not handwritten; strict DTO schemas and inferred types are source.

3. Test first: add or reproduce the named tests and the failure cases below before changing behavior. This review ticket reproduces evidence rather than creating a failing runtime test.

4. Implement the numbered Implementation Approach only in write_scope. Preserve owner/history/actor separation and the specified error and cancellation behavior.

5. Verify every acceptance row with the recorded CMD identifiers, inspect generated declarations/type tests and changed-file scope, and obtain independent review against ticket plus source specs.

6. Handoff: return proof and blockers; controller updates shared indexes and records evidence. Do not edit another ticket, mark accepted, publish a package, or fabricate external results.

## Requirements Traceability

- REQ-SOWN-DELIVERY -> CAP-SOWN-DELIVERY -> PATH-SOWN-DELIVERY -> ACC-SOWN-DELIVERY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-SAFETY -> CAP-SOWN-SAFETY -> PATH-SOWN-SAFETY -> ACC-SOWN-SAFETY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-ADMIN -> CAP-SOWN-ADMIN -> PATH-SOWN-ADMIN -> ACC-SOWN-ADMIN; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-DURABLE -> CAP-SOWN-DURABLE -> PATH-SOWN-DURABLE -> ACC-SOWN-DURABLE; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-PURISTA -> CAP-SOWN-PURISTA -> PATH-SOWN-PURISTA -> ACC-SOWN-PURISTA; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.

## Contract Traceability

- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-POLICY
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OPEN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ADMIN
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-WORKSPACE
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS
- ai-harness/specs/36-sandbox-ownership-and-administration/05-purista.md#CTR-SOWN-PURISTA

## Spec Drift Controls

Pinned source digest: sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb. Verify plan digest before edits. Forbidden interpretations: automatic empty reset, history sharing through sandbox IDs, owner deletion by borrowers, ignored quotas, expiry of recovery pins/tombstones, public provider refs and legacy overloads. A missing or contradictory requirement blocks this ticket; no silent reinterpretation. Review must compare both ticket and canonical acceptance rows.

## Generator And Type Plan

Generation map: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/generation-map.yaml. No local-port code generator exists, so handwritten generic/function interfaces are the approved boundary exception; DTOs derive from strict source schemas. Existing compiler build produces declarations; type and contract commands check drift. Do not copy types into PURISTA, widen to any, or edit generated declarations. Public TSDoc is added with the owned API, including non-obvious examples.

## Test-First Order

All new acceptance rows proven with no compatibility API; unchanged thresholds; packed standalone isolation; actual post-change live owner/purge tests and zero leftover test resources; missing evidence blocks acceptance. Run the listed test files before the behavior change, then after; record exact red and green results. Include cancellation/denial/retry/state-loss assertions and content-free error projection when those paths are in scope.

## Modularity And Reuse Plan

Reuse the modules and public exports in ai-harness/specs/36-sandbox-ownership-and-administration/00-reuse-inventory.yaml and 04-delivery.md. New helper files stay inside the owned domain folders. Extend existing catalog/error/identity/SQLite/engine mechanisms; no public lifecycle database port or generic resource framework. Do not duplicate existing public identity, capability, session or workspace DTOs.

## Representation Reuse Plan

Catalog: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml. Reuse sown.owner, sown.scope, sown.administration, sown.checkpoint, sown.framework-policy, sown.safe-error and their cataloged mappings; source-owned identical shapes are not redefined at each layer. No new representation decision is authorized.

## Slice Strategy

Independent review/remediation evidence slice; source changes belong to scoped remediation tickets, not this reviewer. No provider implementation or publication; release authorization remains separate.

## Tasks

1. Review actual changed files against every canonical acceptance row and public contract; compare dirty-worktree baseline so unrelated evaluation/handbook work is not credited or overwritten.

2. Rerun full offline tests/types/coverage, architecture, packed Harness/Docker consumers and PURISTA checks. Record commands, versions, counts and exact failures; do not waive old declaration failures as feature acceptance.

3. Require fresh opt-in real local Docker evidence for changed lifecycle behavior; the owner/operator explicitly authorizes engine/image use separately. Default commands below do not grant engine mutation or image acquisition.

4. Inspect recorded live engine/OS/image digest, all non-skipped tests, exact owned cleanup, and supported-platform claims. Prior spec-34 live results do not prove new ownership behavior.

5. Record accepted only when independent evidence covers all rows and external gate is satisfied. Missing live infrastructure is a release blocker, not a reason to fabricate proof or choose another provider.

## Acceptance

All frontmatter acceptance rows must pass for this ticket's contribution. Shared canonical rows are collectively owned by their listed dependent tickets; this ticket cannot claim downstream behavior is complete. The full row is accepted only here after integrated proof, including the fresh external local-engine gate.

## Acceptance Test Matrix

| Local acceptance | Canonical proof | Test files |
| --- | --- | --- |
| AC-TICKET-012-DELIVERY | ACC-SOWN-DELIVERY in 04-verification.md | ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts |
| AC-TICKET-012-SAFETY | ACC-SOWN-SAFETY in 04-verification.md | ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts |
| AC-TICKET-012-ADMIN | ACC-SOWN-ADMIN in 04-verification.md | ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts |
| AC-TICKET-012-DURABLE | ACC-SOWN-DURABLE in 04-verification.md | ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts |
| AC-TICKET-012-PURISTA | ACC-SOWN-PURISTA in 04-verification.md | ai-harness/packages/harness/test/sandbox-sharing.test.ts, ai-harness/packages/harness/test/sandbox-durable-partitions.test.ts, ai-harness/packages/harness-sandbox-docker/src/docker.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts |

Exact expected cases: All new acceptance rows proven with no compatibility API; unchanged thresholds; packed standalone isolation; actual post-change live owner/purge tests and zero leftover test resources; missing evidence blocks acceptance.

## End-To-End Definition Coverage

CAP-SOWN-DELIVERY / PATH-SOWN-DELIVERY; CAP-SOWN-SAFETY / PATH-SOWN-SAFETY; CAP-SOWN-ADMIN / PATH-SOWN-ADMIN; CAP-SOWN-DURABLE / PATH-SOWN-DURABLE; CAP-SOWN-PURISTA / PATH-SOWN-PURISTA map to ai-harness/specs/36-sandbox-ownership-and-administration/02-capabilities/capability-inventory.md and 03-flows/e2e-coverage.md. Those rows fix actor, reachable entrypoint, data/state, side effects, permissions, errors/recovery, owner/final state and observability. This ticket covers the implementation approach above; no frontend/client screen or new transport is introduced.

## Operational Path Coverage

Include the matching failure/recovery cases in 04-verification.md: All new acceptance rows proven with no compatibility API; unchanged thresholds; packed standalone isolation; actual post-change live owner/purge tests and zero leftover test resources; missing evidence blocks acceptance. Operator/provider actions outside default commands stay blocked until separately authorized. Cleanup remains retryable and never reports partial work as completed.

## Review And Verification Plan

An independent reviewer checks source specs, this action plan, exact tests, strict typing/generated declarations, modular placement, reuse, privacy and dirty-worktree scope. Any invented behavior, missing unhappy-path test, duplicate DTO, incompatible consumer or unverifiable claim prevents acceptance. Record real-engine evidence or block release; historical engine runs do not count.

## Verification

- CMD-BASELINE: `git -C ai-harness status --short` — Record preserved source baseline.
- CMD-SPEC: `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` — Verify approved source digest and contract controls.
- CMD-PLAN: `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` — Verify ticket digest and dependency indexes.
- CMD-HARNESS_TEST: `npm --prefix ai-harness run test --workspace @purista/harness` — Run Harness unit integration and failure regressions.
- CMD-HARNESS_PUBLIC_TYPES: `npm --prefix ai-harness run test:types` — Verify public inference and negative type cases.
- CMD-HARNESS_COVERAGE: `npm --prefix ai-harness run test:coverage --workspace @purista/harness` — Verify unchanged coverage gates.
- CMD-WORKSPACE_TYPES: `npm --prefix ai-harness run typecheck` — Compile all affected Harness workspace consumers.
- CMD-DOCKER_TEST: `npm --prefix ai-harness run test --workspace @purista/harness-sandbox-docker` — Run hermetic Docker transport and contract tests only.
- CMD-ARCHITECTURE: `npm --prefix ai-harness run verify:architecture` — Verify package direction and unchanged capability families.
- CMD-PACKAGES: `npm --prefix ai-harness run verify:sandbox-packages` — Verify offline packed standalone Harness and Docker consumers.
- CMD-PURISTA_TEST: `node ai-harness/scripts/check-purista-sandbox.mjs --mode source` — Verify scoped framework runtime and builder behavior.
- CMD-PURISTA_TYPES: `node ai-harness/scripts/check-purista-sandbox.mjs --mode source` — Compile framework unit consumers against public Harness.
- CMD-SKILLS: `npm --prefix purista run audit:skills` — Verify canonical skill consistency.
- CMD-KNOWLEDGE: `npm --prefix purista run audit:knowledge` — Verify canonical public knowledge consistency.

Separate operator gate (not a default autonomous command): after explicit local-engine authorization and an already-present digest-pinned image, the caller runs the existing `test:docker` package script with PURISTA_DOCKER_SANDBOX_IMAGE and optional CONTEXT configured. Record the exact command/environment keys without credentials, engine/CLI/OS/OrbStack versions, image digest, test counts and cleanup proof in ai-harness/plans/sandbox-ownership/evidence/local-docker-live.md. Missing/skipped tests block release. No pull, provider provisioning or broad Docker prune is authorized.

## Non-goals

Production E2B/Daytona adapters or bake-off selection; new service/daemon/router; compatibility/migration helpers; destructive user-data migration; topology-dependent business logic; unrelated evaluation or handbook refactoring; publication.

## Handoff

Return changed paths, baseline/red/green commands, test counts, acceptance-row results and explicit blockers. The controller records proof and moves ready/in_progress to implemented, then review_pending; only independent review moves to accepted. Do not edit shared indexes from parallel workers. Next: No provider implementation or publication; release authorization remains separate.


CMD-PURISTA_CONSUMER: `node ai-harness/scripts/check-purista-sandbox.mjs --mode consumer` — Strict packed Core and Harness public consumer release gate.


Known external-declaration prerequisite: consumer mode currently encounters the Core dev-only sinon declaration and thread-stream/Node-26 type issues recorded in VERIFY-SOWN-PACKAGED-PURISTA. Keep final release blocked until separately approved dependency/package remediation makes the strict command pass. Source-mode success is not a waiver; no ambient shim, third-party patch or weaker consumer compiler option is authorized here.
