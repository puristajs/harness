---
id: TICKET-009
title: PURISTA public policy mapping identity and ephemeral completion
wave: 8
lifecycle: planned
spec_manifest_digest: sha256:d428914333a9eab9a1f84659f3c4724028c5c4ca96c20be3c13c9edc4c4365cc
plan_manifest_digest: sha256:57fa5bbc511a90aa7bcc53096fc56a50e9db8025787adb8cda8175e9a7050039
parallel_group: serial-TICKET-009
depends_on: [TICKET-008]
blocked_by: [TICKET-008]
spec_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-PURISTA, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-POLICY, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY, ai-harness/specs/36-sandbox-ownership-and-administration/05-purista.md#CTR-SOWN-PURISTA, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-POLICY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS, ai-harness/specs/36-sandbox-ownership-and-administration/04-delivery.md#DEC-SOWN-DELIVERY]
write_scope: [purista/packages/core/src/AgentQueueBuilder, purista/packages/core/src/index.ts, purista/packages/core/src/testing, purista/examples/agent-example]
read_scope: [ai-harness/specs/36-sandbox-ownership-and-administration, AGENTS.md, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/package.json, ai-harness/packages/harness/src, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker, purista/AGENTS.md, purista/packages/core/src, purista/skills/purista, ai-harness/skills/ai-harness, specs/50-handbook/00-information-architecture.md, plans/handbook-refactor/implementation-plan.md, ai-harness/plans/sandbox-ownership]
contract_readiness:
  status: ready
  required_contracts: [CTR-SOWN-PURISTA, CTR-SOWN-POLICY, CTR-SOWN-OWNER, CTR-SOWN-ERRORS]
  missing_contracts: []
traceability:
  requirement_ids: [REQ-SOWN-PURISTA, REQ-SOWN-POLICY, REQ-SOWN-SAFETY, REQ-SOWN-DELIVERY]
  capability_ids: [CAP-SOWN-PURISTA, CAP-SOWN-POLICY, CAP-SOWN-SAFETY, CAP-SOWN-DELIVERY]
  path_ids: [PATH-SOWN-PURISTA, PATH-SOWN-POLICY, PATH-SOWN-SAFETY, PATH-SOWN-DELIVERY]
  acceptance_ids: [ACC-SOWN-PURISTA, ACC-SOWN-POLICY, ACC-SOWN-SAFETY, ACC-SOWN-DELIVERY]
generated_contracts:
  status: ready
  source_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/05-purista.md#CTR-SOWN-PURISTA, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-POLICY, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER, ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS]
  command_refs: []
  drift_command_refs: [CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-HARNESS_PUBLIC_TYPES]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: vertical_slice
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml
  shape_refs: [sown.framework-policy, sown.framework-manifest, sown.policy, sown.owner, sown.safe-error]
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
    acceptance_refs: [AC-TICKET-009-PURISTA, AC-TICKET-009-POLICY, AC-TICKET-009-SAFETY, AC-TICKET-009-DELIVERY]
    expected_proof: Matching approved digests and accepted dependencies; dirty baseline preserved; missing authority or prerequisite blocks work.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md, purista/packages/core/src/AgentQueueBuilder]
    command_refs: [CMD-SPEC, CMD-PURISTA_TYPES]
    acceptance_refs: [AC-TICKET-009-PURISTA, AC-TICKET-009-POLICY, AC-TICKET-009-SAFETY, AC-TICKET-009-DELIVERY]
    expected_proof: Exact schema and public type mapping identified before runtime changes; no new semantic decision or legacy shape.
  - id: STEP-TEST
    kind: test
    files: [purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts]
    command_refs: [CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-HARNESS_PUBLIC_TYPES]
    acceptance_refs: [AC-TICKET-009-PURISTA, AC-TICKET-009-POLICY, AC-TICKET-009-SAFETY, AC-TICKET-009-DELIVERY]
    expected_proof: Named acceptance fixtures fail for the missing behavior before implementation; existing covered behavior recorded separately.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [purista/packages/core/src/AgentQueueBuilder, purista/packages/core/src/index.ts, purista/packages/core/src/testing, purista/examples/agent-example]
    command_refs: [CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-HARNESS_PUBLIC_TYPES]
    acceptance_refs: [AC-TICKET-009-PURISTA, AC-TICKET-009-POLICY, AC-TICKET-009-SAFETY, AC-TICKET-009-DELIVERY]
    expected_proof: Only scoped deliverable implemented with approved public shapes and exact failure behavior; no compatibility path.
  - id: STEP-VERIFY
    kind: verify
    files: [purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts]
    command_refs: [CMD-SPEC, CMD-PLAN, CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-HARNESS_PUBLIC_TYPES]
    acceptance_refs: [AC-TICKET-009-PURISTA, AC-TICKET-009-POLICY, AC-TICKET-009-SAFETY, AC-TICKET-009-DELIVERY]
    expected_proof: All owned acceptance rows green; no new baseline regression; no weakened tests or thresholds; external gate reported separately.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: [CMD-BASELINE]
    acceptance_refs: [AC-TICKET-009-PURISTA, AC-TICKET-009-POLICY, AC-TICKET-009-SAFETY, AC-TICKET-009-DELIVERY]
    expected_proof: Return changed paths plus red/green command evidence and unresolved blockers; controller records lifecycle; no self acceptance.
acceptance:
  - id: AC-TICKET-009-PURISTA
    traceability_acceptance_ids: [ACC-SOWN-PURISTA]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-PURISTA]
    test_refs: [purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts]
    command_refs: [CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-HARNESS_PUBLIC_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-PURISTA satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-009-POLICY
    traceability_acceptance_ids: [ACC-SOWN-POLICY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-POLICY]
    test_refs: [purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts]
    command_refs: [CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-HARNESS_PUBLIC_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-POLICY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-009-SAFETY
    traceability_acceptance_ids: [ACC-SOWN-SAFETY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY]
    test_refs: [purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts]
    command_refs: [CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-HARNESS_PUBLIC_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-SAFETY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
  - id: AC-TICKET-009-DELIVERY
    traceability_acceptance_ids: [ACC-SOWN-DELIVERY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY]
    test_refs: [purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts]
    command_refs: [CMD-PURISTA_TEST, CMD-PURISTA_TYPES, CMD-HARNESS_PUBLIC_TYPES]
    expected_outcome: This ticket contribution to ACC-SOWN-DELIVERY satisfies its exact behavior and failure cases without weakening other tickets.
    lifecycle: planned
---

# TICKET-009 — PURISTA public policy mapping identity and ephemeral completion

## Goal

Expose the same ownership and sharing model through PURISTA without coupling Harness to Framework.

## Context Digest

Scope is the approved spec-36 follow-up, not the historical spec-34 completion. Current source baseline includes preserved uncommitted sandbox and unrelated evaluation/handbook work. Do not start until TICKET-008 are independently accepted and the controller promotes this ticket. Planning approval is not permission to implement during the current conversation.

## Implementation Approach

1. Replace enabled/per-agent adapter policy with the approved sharing/owner shape; keep one service-owned adapter and binding-options object, put executable bindings on AttachedAgentDefinition and emit only AgentSandboxManifest data.

2. Apply service adapter/binding selection, trusted-input owner resolver and Harness authorization; add service ai.sandboxOptions with public imported Harness types. Do not add a runtime topology setting or per-agent adapter override.

3. Derive tenant/principal-aware hashed session/durable IDs and versioned Harness names. Forward message idempotency keys to prompt/stream; keep separate attached-agent histories and canInvokeAgent boundaries.

4. Use dispose only on classified terminal ephemeral Harness outcomes and release on suspension/retry; borrowed owners survive. Custom handlers dispose validated success and release on thrown errors.

5. Add the private errors.ts mapper with exact StatusCode/error metadata rules, preserving retry classification; remove touched sandbox-path any/double casts with public inferred types.

## Decision Ledger

D2 decisions are frozen by the canonical contracts and DEC-SOWN-BOUNDARY/DELIVERY. D0 mechanical changes and D1 private reversible helpers/test placement are the only local choices. No new dependency, public option, error family, topology flag, or ownership rule may be invented.

## Action Plan

1. Preflight: read only listed source scopes, verify both manifests and accepted prerequisites, and run CMD-BASELINE. Record pre-existing failures before changing source.

2. Contract: trace CTR-SOWN-PURISTA, CTR-SOWN-POLICY, CTR-SOWN-OWNER, CTR-SOWN-ERRORS into the first owned source module and existing public exports. Compiler-generated declarations are not handwritten; strict DTO schemas and inferred types are source.

3. Test first: add or reproduce the named tests and the failure cases below before changing behavior. Record expected red tests; a skip is not red evidence.

4. Implement the numbered Implementation Approach only in write_scope. Preserve owner/history/actor separation and the specified error and cancellation behavior.

5. Verify every acceptance row with the recorded CMD identifiers, inspect generated declarations/type tests and changed-file scope, and obtain independent review against ticket plus source specs.

6. Handoff: return proof and blockers; controller updates shared indexes and records evidence. Do not edit another ticket, mark accepted, publish a package, or fabricate external results.

## Requirements Traceability

- REQ-SOWN-PURISTA -> CAP-SOWN-PURISTA -> PATH-SOWN-PURISTA -> ACC-SOWN-PURISTA; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-POLICY -> CAP-SOWN-POLICY -> PATH-SOWN-POLICY -> ACC-SOWN-POLICY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-SAFETY -> CAP-SOWN-SAFETY -> PATH-SOWN-SAFETY -> ACC-SOWN-SAFETY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.
- REQ-SOWN-DELIVERY -> CAP-SOWN-DELIVERY -> PATH-SOWN-DELIVERY -> ACC-SOWN-DELIVERY; canonical details: ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md and 04-verification.md.

## Contract Traceability

- ai-harness/specs/36-sandbox-ownership-and-administration/05-purista.md#CTR-SOWN-PURISTA
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-POLICY
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-OWNER
- ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/api.md#CTR-SOWN-ERRORS

## Spec Drift Controls

Pinned source digest: sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb. Verify plan digest before edits. Forbidden interpretations: automatic empty reset, history sharing through sandbox IDs, owner deletion by borrowers, ignored quotas, expiry of recovery pins/tombstones, public provider refs and legacy overloads. A missing or contradictory requirement blocks this ticket; no silent reinterpretation. Review must compare both ticket and canonical acceptance rows.

## Generator And Type Plan

Generation map: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/generation-map.yaml. No local-port code generator exists, so handwritten generic/function interfaces are the approved boundary exception; DTOs derive from strict source schemas. Existing compiler build produces declarations; type and contract commands check drift. Do not copy types into PURISTA, widen to any, or edit generated declarations. Public TSDoc is added with the owned API, including non-obvious examples.

## Test-First Order

Cross-tenant/principal key separation, cross-agent explicit sharing without history merging, enabled rejection, literal group checks against the service binding, no per-agent adapter override, callback serialization absent, terminal retry/stream replay, custom-handler exception, sanitized framework status mapping. Run the listed test files before the behavior change, then after; record exact red and green results. Include cancellation/denial/retry/state-loss assertions and content-free error projection when those paths are in scope.

## Modularity And Reuse Plan

Reuse the modules and public exports in ai-harness/specs/36-sandbox-ownership-and-administration/00-reuse-inventory.yaml and 04-delivery.md. New helper files stay inside the owned domain folders. Extend existing catalog/error/identity/SQLite/engine mechanisms; no public lifecycle database port or generic resource framework. Do not duplicate existing public identity, capability, session or workspace DTOs.

## Representation Reuse Plan

Catalog: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml. Reuse sown.framework-policy, sown.framework-manifest, sown.policy, sown.owner, sown.safe-error and their cataloged mappings; source-owned identical shapes are not redefined at each layer. No new representation decision is authorized.

## Slice Strategy

Vertical slice from public entrypoint to actual state/effect and failure behavior. Cross-adapter safety and package conformance in wave 9.

## Tasks

1. Replace enabled/per-agent adapter policy with the approved sharing/owner shape; keep one service-owned adapter and binding-options object, put executable bindings on AttachedAgentDefinition and emit only AgentSandboxManifest data.

2. Apply service adapter/binding selection, trusted-input owner resolver and Harness authorization; add service ai.sandboxOptions with public imported Harness types. Do not add a runtime topology setting or per-agent adapter override.

3. Derive tenant/principal-aware hashed session/durable IDs and versioned Harness names. Forward message idempotency keys to prompt/stream; keep separate attached-agent histories and canInvokeAgent boundaries.

4. Use dispose only on classified terminal ephemeral Harness outcomes and release on suspension/retry; borrowed owners survive. Custom handlers dispose validated success and release on thrown errors.

5. Add the private errors.ts mapper with exact StatusCode/error metadata rules, preserving retry classification; remove touched sandbox-path any/double casts with public inferred types.

## Acceptance

All frontmatter acceptance rows must pass for this ticket's contribution. Shared canonical rows are collectively owned by their listed dependent tickets; this ticket cannot claim downstream behavior is complete. No partial implementation is a releasable spec-36 package.

## Acceptance Test Matrix

| Local acceptance | Canonical proof | Test files |
| --- | --- | --- |
| AC-TICKET-009-PURISTA | ACC-SOWN-PURISTA in 04-verification.md | purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts |
| AC-TICKET-009-POLICY | ACC-SOWN-POLICY in 04-verification.md | purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts |
| AC-TICKET-009-SAFETY | ACC-SOWN-SAFETY in 04-verification.md | purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts |
| AC-TICKET-009-DELIVERY | ACC-SOWN-DELIVERY in 04-verification.md | purista/packages/core/src/AgentQueueBuilder/runtime/identity.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/executor.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/errors.test.ts, purista/packages/core/src/AgentQueueBuilder/runtime/scopedRuntime.test.ts, purista/packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts |

Exact expected cases: Cross-tenant/principal key separation, cross-agent explicit sharing without history merging, enabled rejection, literal group checks against the service binding, per-agent adapter override rejection, callback serialization absent, terminal retry/stream replay, custom-handler exception, sanitized framework status mapping.

## End-To-End Definition Coverage

CAP-SOWN-PURISTA / PATH-SOWN-PURISTA; CAP-SOWN-POLICY / PATH-SOWN-POLICY; CAP-SOWN-SAFETY / PATH-SOWN-SAFETY; CAP-SOWN-DELIVERY / PATH-SOWN-DELIVERY map to ai-harness/specs/36-sandbox-ownership-and-administration/02-capabilities/capability-inventory.md and 03-flows/e2e-coverage.md. Those rows fix actor, reachable entrypoint, data/state, side effects, permissions, errors/recovery, owner/final state and observability. This ticket covers the implementation approach above; no frontend/client screen or new transport is introduced.

## Operational Path Coverage

Include the matching failure/recovery cases in 04-verification.md: Cross-tenant/principal key separation, cross-agent explicit sharing without history merging, enabled rejection, literal group checks against the service binding, per-agent adapter override rejection, callback serialization absent, terminal retry/stream replay, custom-handler exception, sanitized framework status mapping. Operator/provider actions outside default commands stay blocked until separately authorized. Cleanup remains retryable and never reports partial work as completed.

## Review And Verification Plan

An independent reviewer checks source specs, this action plan, exact tests, strict typing/generated declarations, modular placement, reuse, privacy and dirty-worktree scope. Any invented behavior, missing unhappy-path test, duplicate DTO, incompatible consumer or unverifiable claim prevents acceptance. Implementation handoff may say implemented only after all owned local checks pass.

## Verification

- CMD-BASELINE: `git -C ai-harness status --short` — Record preserved source baseline.
- CMD-SPEC: `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` — Verify approved source digest and contract controls.
- CMD-PLAN: `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` — Verify ticket digest and dependency indexes.
- CMD-PURISTA_TEST: `node ai-harness/scripts/check-purista-sandbox.mjs --mode source` — Verify scoped framework runtime and builder behavior.
- CMD-PURISTA_TYPES: `node ai-harness/scripts/check-purista-sandbox.mjs --mode source` — Compile framework unit consumers against public Harness.
- CMD-HARNESS_PUBLIC_TYPES: `npm --prefix ai-harness run test:types` — Verify public inference and negative type cases.

## Non-goals

Production E2B/Daytona adapters or bake-off selection; new service/daemon/router; compatibility/migration helpers; destructive user-data migration; topology-dependent business logic; unrelated evaluation or handbook refactoring; publication.

## Handoff

Return changed paths, baseline/red/green commands, test counts, acceptance-row results and explicit blockers. The controller records proof and moves ready/in_progress to implemented, then review_pending; only independent review moves to accepted. Do not edit shared indexes from parallel workers. Next: Cross-adapter safety and package conformance in wave 9.
