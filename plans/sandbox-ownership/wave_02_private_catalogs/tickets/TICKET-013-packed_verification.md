---
id: TICKET-013
title: Offline packed Harness and PURISTA verification prerequisite
wave: 2
lifecycle: accepted
spec_manifest_digest: sha256:d428914333a9eab9a1f84659f3c4724028c5c4ca96c20be3c13c9edc4c4365cc
plan_manifest_digest: sha256:57fa5bbc511a90aa7bcc53096fc56a50e9db8025787adb8cda8175e9a7050039
parallel_group: wave-02-private-catalogs
depends_on: [TICKET-001]
blocked_by: []
spec_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY, ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY, ai-harness/specs/36-sandbox-ownership-and-administration/04-verification.md#VERIFY-SOWN-PACKAGED-PURISTA, ai-harness/specs/36-sandbox-ownership-and-administration/05-purista.md#CTR-SOWN-PURISTA]
write_scope: [ai-harness/scripts/check-purista-sandbox.mjs, ai-harness/scripts/check-purista-sandbox.test.mjs, ai-harness/scripts/check-sandbox-packages.mjs, ai-harness/scripts/fixtures/purista-sandbox-consumer.ts, ai-harness/scripts/fixtures/purista-sandbox-source.ts, ai-harness/.gitignore]
read_scope: [ai-harness/specs/36-sandbox-ownership-and-administration, AGENTS.md, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/package.json, ai-harness/packages/harness/src, ai-harness/packages/harness/test, ai-harness/packages/harness/type-tests, ai-harness/packages/harness-sandbox-docker, purista/AGENTS.md, purista/packages/core/src, purista/skills/purista, ai-harness/skills/ai-harness, specs/50-handbook/00-information-architecture.md, plans/handbook-refactor/implementation-plan.md, ai-harness/plans/sandbox-ownership, purista/package.json, purista/package-lock.json, purista/tsconfig.json, purista/tsconfig.unit.json, purista/vitest.config.unit.ts, purista/vitest.workspaceAliases.ts, purista/typedoc.json, purista/scripts, purista/web, purista/packages/core/package.json, purista/packages/core/tsconfig.json, purista/packages/core/tsconfig.build.json, ai-harness/packages/harness/package.json, ai-harness/packages/harness/tsconfig.json, ai-harness/tsconfig.base.json, ai-harness/scripts, ai-harness/package-lock.json, purista/packages, purista/tsconfig.typedoc.json, purista/vitest.config.ts]
contract_readiness:
  status: ready
  required_contracts: [CTR-SOWN-OWNER, CTR-SOWN-PURISTA]
  missing_contracts: []
traceability:
  requirement_ids: [REQ-SOWN-DELIVERY, REQ-SOWN-SAFETY]
  capability_ids: [CAP-SOWN-DELIVERY, CAP-SOWN-SAFETY]
  path_ids: [PATH-SOWN-DELIVERY, PATH-SOWN-SAFETY]
  acceptance_ids: [ACC-SOWN-DELIVERY, ACC-SOWN-SAFETY]
generated_contracts:
  status: ready
  source_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/04-verification.md#VERIFY-SOWN-PACKAGED-PURISTA]
  command_refs: [CMD-SOURCE]
  drift_command_refs: [CMD-RUNNER_TEST, CMD-SOURCE]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: foundation_exception
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml
  shape_refs: [sown.owner, sown.framework-policy, sown.framework-manifest]
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
  CMD-RUNNER_TEST:
    command: node --test ai-harness/scripts/check-purista-sandbox.test.mjs
    purpose: Verify isolated offline runner package binding and failure guards
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-SOURCE:
    command: node ai-harness/scripts/check-purista-sandbox.mjs --mode source
    purpose: Compile and test staged Core against the local packed Harness public API
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/36-sandbox-ownership-and-administration/04-verification.md]
    command_refs: [CMD-BASELINE, CMD-SPEC, CMD-PLAN]
    acceptance_refs: [AC-TICKET-013-DELIVERY, AC-TICKET-013-SAFETY]
    expected_proof: Offline scratch-only verification uses the built local public package; stale installed Harness and missing cached inputs cannot pass silently.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/scripts/check-purista-sandbox.test.mjs]
    command_refs: [CMD-RUNNER_TEST, CMD-SOURCE]
    acceptance_refs: [AC-TICKET-013-DELIVERY, AC-TICKET-013-SAFETY]
    expected_proof: Offline scratch-only verification uses the built local public package; stale installed Harness and missing cached inputs cannot pass silently.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/scripts/check-purista-sandbox.test.mjs]
    command_refs: [CMD-RUNNER_TEST, CMD-SOURCE]
    acceptance_refs: [AC-TICKET-013-DELIVERY, AC-TICKET-013-SAFETY]
    expected_proof: Offline scratch-only verification uses the built local public package; stale installed Harness and missing cached inputs cannot pass silently.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/scripts/check-purista-sandbox.mjs, ai-harness/scripts/check-purista-sandbox.test.mjs, ai-harness/scripts/check-sandbox-packages.mjs, ai-harness/scripts/fixtures/purista-sandbox-consumer.ts, ai-harness/scripts/fixtures/purista-sandbox-source.ts, ai-harness/.gitignore]
    command_refs: [CMD-RUNNER_TEST, CMD-SOURCE]
    acceptance_refs: [AC-TICKET-013-DELIVERY, AC-TICKET-013-SAFETY]
    expected_proof: Offline scratch-only verification uses the built local public package; stale installed Harness and missing cached inputs cannot pass silently.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/scripts/check-purista-sandbox.test.mjs]
    command_refs: [CMD-RUNNER_TEST, CMD-SOURCE]
    acceptance_refs: [AC-TICKET-013-DELIVERY, AC-TICKET-013-SAFETY]
    expected_proof: Offline scratch-only verification uses the built local public package; stale installed Harness and missing cached inputs cannot pass silently.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: [CMD-RUNNER_TEST, CMD-SOURCE]
    acceptance_refs: [AC-TICKET-013-DELIVERY, AC-TICKET-013-SAFETY]
    expected_proof: Offline scratch-only verification uses the built local public package; stale installed Harness and missing cached inputs cannot pass silently.
acceptance:
  - id: AC-TICKET-013-DELIVERY
    traceability_acceptance_ids: [ACC-SOWN-DELIVERY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-DELIVERY]
    test_refs: [ai-harness/scripts/check-purista-sandbox.test.mjs, ai-harness/scripts/fixtures/purista-sandbox-consumer.ts]
    command_refs: [CMD-RUNNER_TEST, CMD-SOURCE]
    expected_outcome: Actual packed local Harness resolves in staged Core; isolated cache and safe cleanup; no network or source aliases.
    lifecycle: planned
  - id: AC-TICKET-013-SAFETY
    traceability_acceptance_ids: [ACC-SOWN-SAFETY]
    requirement_refs: [ai-harness/specs/36-sandbox-ownership-and-administration/00-vision.md#REQ-SOWN-SAFETY]
    test_refs: [ai-harness/scripts/check-purista-sandbox.test.mjs, ai-harness/scripts/fixtures/purista-sandbox-consumer.ts]
    command_refs: [CMD-RUNNER_TEST, CMD-SOURCE]
    expected_outcome: Actual packed local Harness resolves in staged Core; isolated cache and safe cleanup; no network or source aliases.
    lifecycle: planned
---

# TICKET-013 — Offline packed Harness and PURISTA verification prerequisite

## Goal

Make later Framework checks prove the new local Harness contract through actual packages, without modifying the developer's installed dependencies.

## Context Digest

PURISTA currently resolves installed Harness 1.7.3 despite declaring ^3.0.0. The existing Harness/Docker package check also uses OS temporary directories and an uncontrolled npm cache. This approved test-only foundation fixes verification, not runtime dependencies. Depends on accepted TICKET-001.

## Implementation Approach

1. Implement check-purista-sandbox.mjs with exact source/consumer/docs modes from VERIFY-SOWN-PACKAGED-PURISTA.

2. Build/pack local Harness, copy Core sources and required configs, and bind its normal public package in a unique workspace-local scratch tree. Use an explicit prepopulated offline cache and guarded test installs; do not alter repository node_modules or locks.

3. Source mode runs scoped Core compilation/tests; consumer mode builds/packs actual Core and runs strict public-package type/runtime fixtures; docs mode builds API/website and audits internal links under the same package binding.

4. Refactor the existing Harness/Docker package checker to the same workspace scratch/cache rules; never broaden its package boundary. Add hermetic runner tests before orchestration code.

## Decision Ledger

D2 verification authority and strict external consumer semantics are fixed by VERIFY-SOWN-PACKAGED-PURISTA. D1 private helper placement only. Missing cache is a preflight blocker, not authorization for network/install into the user's project.

## Action Plan

1. Verify source/plan digests, accepted TICKET-001 and dirty baseline.

2. Trace current public package manifests, compiler settings and the exact prerequisite contract; fixture imports use public exports only.

3. Test missing cache, wrong installed Harness, source alias, scratch escape, cleanup failure, failed typecheck and skipped proof before implementing the runner.

4. Implement only the scoped scripts/fixtures/gitignore. Child installs are offline, ignore package scripts, and use explicit workspace-local cache/output paths; invoke known build commands separately.

5. Run CMD-RUNNER_TEST and CMD-SOURCE. Strict consumer mode is deliberately a final release gate: existing external declaration failures must be recorded, not patched or hidden.

6. Return evidence and blockers. Controller promotes to implemented/review_pending; independent review accepts.

## Requirements Traceability

REQ-SOWN-DELIVERY and REQ-SOWN-SAFETY -> matching CAP/PATH/ACC-SOWN IDs in the feature traceability graph.

## Contract Traceability

ai-harness/specs/36-sandbox-ownership-and-administration/04-verification.md#VERIFY-SOWN-PACKAGED-PURISTA and ai-harness/specs/36-sandbox-ownership-and-administration/05-purista.md#CTR-SOWN-PURISTA.

## Spec Drift Controls

No source alias/shim for Harness, no fake registry resolution or integrity, no lowering compiler settings, no default network, no broad temp cleanup and no unrelated dependency remediation. New public semantics return to spec review.

## Generator And Type Plan

Use existing compiler/declaration and TypeDoc commands in staged source. Packed consumer uses skipLibCheck false; source compilation preserves the existing Core setting. Tests distinguish the two and cannot mislabel source-mode success as strict-consumer success.

## Test-First Order

Hermetic runner tests first, including wrong dependency/version, missing offline input, path escape, child failure, cancellation and exact scratch cleanup. Then source-mode fixture compiles against the local tarball and runs scoped AgentQueueBuilder tests.

## Modularity And Reuse Plan

Reuse existing check-sandbox-packages.mjs packing/fixture conventions and repository compiler/configs. This is one test runner plus fixtures, not a runtime package, package manager or new build framework.

## Representation Reuse Plan

ai-harness/specs/36-sandbox-ownership-and-administration/03-contracts/representation-catalog.yaml; reuse sown.owner, sown.framework-policy and sown.framework-manifest. No copied runtime DTOs in fixtures.

## Slice Strategy

Approved horizontal verification foundation. It unblocks TICKET-004 and later Framework/docs/release proof without mutating runtime contracts. Disjoint from local/Docker catalog workers.

## Tasks

Implement the four ordered Implementation Approach tasks and the guarded offline failure tests; do not repair the unrelated strict external declaration prerequisites.

## Acceptance

Both structured acceptance rows must pass: correct packed public binding and safe offline scratch/cache authority. Full strict consumer acceptance remains TICKET-012's gate.

## Acceptance Test Matrix

| Acceptance | Test | Expected |
| --- | --- | --- |
| AC-TICKET-013-DELIVERY | Runner tests and public consumer/source fixtures | Actual local Harness package, no stale-install success |
| AC-TICKET-013-SAFETY | Runner failure/path/cache tests | Offline only, exact scratch cleanup, no project dependency writes |

## End-To-End Definition Coverage

CAP/PATH-SOWN-DELIVERY and SAFETY: developer invokes the runner; local source/packed package inputs yield compiled public consumers and safe evidence or a blocking failure. No hosted service, credentials, frontend changes or provider operations.

## Operational Path Coverage

Missing cache/engine is not auto-provisioned. A failed build/typecheck cannot become a pass record. Scratch cleanup targets only the invocation-created child; preserve failure evidence and report incomplete cleanup.

## Review And Verification Plan

Independent review checks source contract, generated declarations, test/runtime provenance, child process arguments, actual resolved Harness version, no source aliases, scratch/cache containment and preserved dirty worktree.

## Verification

CMD-RUNNER_TEST: `node --test ai-harness/scripts/check-purista-sandbox.test.mjs`.

CMD-SOURCE: `node ai-harness/scripts/check-purista-sandbox.mjs --mode source`.

Spec/plan checks are the exact commands in frontmatter. Consumer-mode failures are final-release prerequisites, not foundation runtime defects.

## Non-goals

Third-party dependency changes, registry publication/download, project dependency reinstall, public API redesign, production provider work or engine provisioning.

## Handoff

Return exact package versions/tarball provenance, commands, scoped test counts and known strict consumer blockers. Controller owns shared indexes; do not self-accept. Unblocks TICKET-004.

Command-generated outputs are limited to uniquely created ai-harness/.sandbox-verification children, normal in-repository build outputs, and ai-harness/plans/sandbox-ownership/evidence. They are verification outputs, not permission to edit additional source. Stage only the declared package/config/script/doc-source/asset inputs; never copy .env, .git, private sandbox journals, user workspaces or credentials into fixtures.
