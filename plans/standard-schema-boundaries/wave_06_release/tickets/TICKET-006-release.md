---
id: TICKET-006
title: Clean-cut drift gates full CI and breaking release evidence
wave: 6
lifecycle: accepted
spec_manifest_digest: sha256:d675819593a8c7712cf7f4ccb6f4a78db08f2cefa325c36ec527e80a166d6498
plan_manifest_digest: sha256:497ac211ca9d25b29bf200d9de6512a73e5e8b190c065ce8a7f73140e78cb1e6
parallel_group: standard-schema-sequential-6
depends_on: [TICKET-005]
blocked_by: []
spec_refs: [ai-harness/specs/39-standard-schema-boundaries/04-delivery/consumers.md#CTR-SS-CLEANUP, ai-harness/specs/39-standard-schema-boundaries/04-operations/runbook.md#Release, ai-harness/specs/39-standard-schema-boundaries/04-nfr/requirements.md#Supply chain]
traceability:
  requirement_ids: [REQ-SS-CLEANUP]
  capability_ids: [CAP-SS-CLEANUP]
  path_ids: [PATH-SS-CLEANUP-SUCCESS, PATH-SS-CLEANUP-FAILURE, PATH-SS-CLEANUP-RECOVERY]
  acceptance_ids: [AC-SS-CLEANUP-SUCCESS, AC-SS-CLEANUP-FAILURE, AC-SS-CLEANUP-RECOVERY]
write_scope: [ai-harness/.github/workflows/ci.yml, ai-harness/package.json, ai-harness/scripts/check-standard-schema-boundaries.mjs, ai-harness/scripts/check-standard-schema-boundaries.test.mjs, ai-harness/docs/releases/standard-schema-boundaries.md, purista/scripts, purista/package.json]
read_scope: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/packages, ai-harness/examples, ai-harness/docs, ai-harness/skills, purista/AGENTS.md, purista/web, purista/skills, starter, create-purista]
contract_readiness:
  status: ready
  required_contracts: [CTR-SS-CLEANUP]
  missing_contracts: []
generated_contracts:
  status: source_derived_ready
  source_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/generation-map.yaml]
  command_refs: [CMD-HARNESS-CI, CMD-PACK]
  drift_command_refs: [CMD-SPECS, CMD-PLAN, CMD-CLEAN]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: vertical_slice
phase_gate_exception: false
representation_reuse:
  status: not_applicable
  rationale: Final integration adds only scripts CI wiring and release evidence; no runtime or boundary representation is introduced.
  scope_refs: [ai-harness/specs/39-standard-schema-boundaries/04-delivery/consumers.md#CTR-SS-CLEANUP]
autonomy:
  allowed_classes: [D0, D1]
  convention_refs: [ai-harness/specs/39-standard-schema-boundaries/00-conventions.md#CONV-SS-PURISTA]
  approved_decision_refs: [ai-harness/specs/39-standard-schema-boundaries/00-vision.md#Decisions]
  escalation: blocker
verification_commands:
  CMD-SPECS:
    command: node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/39-standard-schema-boundaries
    purpose: approved preflight
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-PLAN:
    command: node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/standard-schema-boundaries ai-harness/specs/39-standard-schema-boundaries
    purpose: plan preflight
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-STATUS:
    command: git -C ai-harness status --short
    purpose: preserve and audit dirty baseline
    expected: record_only
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-CLEAN:
    command: node ai-harness/scripts/check-standard-schema-boundaries.mjs
    purpose: enforce permanent legacy and fake-implementation bans
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-CLEAN-TEST:
    command: node --test ai-harness/scripts/check-standard-schema-boundaries.test.mjs
    purpose: prove the gate fails on each forbidden fixture and recovers
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-HARNESS-CI:
    command: npm --prefix ai-harness run ci
    purpose: full Harness release acceptance
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-SKILLS:
    command: npm --prefix purista run audit:skills
    purpose: final canonical skill audit
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-KNOWLEDGE:
    command: npm --prefix purista run audit:knowledge
    purpose: final website knowledge audit
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-HANDBOOK:
    command: npm --prefix purista run audit:handbook
    purpose: final handbook structure audit
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-PACK:
    command: npm --prefix ai-harness pack --workspace @purista/harness --dry-run
    purpose: inspect publish artifact without publishing
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, purista/AGENTS.md]
    command_refs: [CMD-SPECS, CMD-PLAN, CMD-STATUS]
    acceptance_refs: [ACC-CLEANUP-SUCCESS, ACC-CLEANUP-FAILURE, ACC-CLEANUP-RECOVERY]
    expected_proof: All five dependencies are accepted and the complete dirty baseline is attributable.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/scripts/check-standard-schema-boundaries.mjs, ai-harness/.github/workflows/ci.yml, ai-harness/package.json, purista/package.json]
    command_refs: [CMD-CLEAN]
    acceptance_refs: [ACC-CLEANUP-SUCCESS, ACC-CLEANUP-FAILURE, ACC-CLEANUP-RECOVERY]
    expected_proof: Permanent scripts and CI invoke exact forbidden scans and consumer audits.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/scripts/check-standard-schema-boundaries.test.mjs]
    command_refs: [CMD-CLEAN-TEST]
    acceptance_refs: [ACC-CLEANUP-SUCCESS, ACC-CLEANUP-FAILURE, ACC-CLEANUP-RECOVERY]
    expected_proof: Isolated fixtures prove every ban fails and clean recovery passes before CI wiring is accepted.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/.github/workflows/ci.yml, ai-harness/package.json, ai-harness/scripts/check-standard-schema-boundaries.mjs, ai-harness/scripts/check-standard-schema-boundaries.test.mjs, ai-harness/docs/releases/standard-schema-boundaries.md, purista/scripts, purista/package.json]
    command_refs: []
    acceptance_refs: [ACC-CLEANUP-SUCCESS, ACC-CLEANUP-FAILURE, ACC-CLEANUP-RECOVERY]
    expected_proof: Drift gates, release note and final audits are installed without publish, migration or compatibility behavior.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages, ai-harness/examples, ai-harness/docs, ai-harness/skills, purista/web, purista/skills, starter, create-purista]
    command_refs: [CMD-CLEAN, CMD-CLEAN-TEST, CMD-HARNESS-CI, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK, CMD-PACK]
    acceptance_refs: [ACC-CLEANUP-SUCCESS, ACC-CLEANUP-FAILURE, ACC-CLEANUP-RECOVERY]
    expected_proof: Full acceptance passes, publish artifact is correct and no uninventoried consumer or forbidden legacy path remains.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: []
    acceptance_refs: [ACC-CLEANUP-SUCCESS, ACC-CLEANUP-FAILURE, ACC-CLEANUP-RECOVERY]
    expected_proof: Final evidence records all commands, scoped diff, package contents, rollback note and independent review status.
acceptance:
  - id: ACC-CLEANUP-SUCCESS
    traceability_acceptance_ids: [AC-SS-CLEANUP-SUCCESS]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/04-delivery/consumers.md#CTR-SS-CLEANUP]
    test_refs: [ai-harness/scripts/check-standard-schema-boundaries.test.mjs, ai-harness/package.json]
    command_refs: [CMD-CLEAN, CMD-HARNESS-CI, CMD-PACK]
    expected_outcome: Full CI and audits prove one clean public path and correct publish declarations.
    lifecycle: planned
  - id: ACC-CLEANUP-FAILURE
    traceability_acceptance_ids: [AC-SS-CLEANUP-FAILURE]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/04-delivery/consumers.md#CTR-SS-CLEANUP]
    test_refs: [ai-harness/scripts/check-standard-schema-boundaries.test.mjs]
    command_refs: [CMD-CLEAN-TEST]
    expected_outcome: Legacy types/parsers/casts, compatibility, skipped/fake tests, widening and placeholders fail the permanent gate.
    lifecycle: planned
  - id: ACC-CLEANUP-RECOVERY
    traceability_acceptance_ids: [AC-SS-CLEANUP-RECOVERY]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-flows/e2e-coverage.md#PATH-SS-CLEANUP-RECOVERY]
    test_refs: [ai-harness/scripts/check-standard-schema-boundaries.test.mjs, ai-harness/docs/releases/standard-schema-boundaries.md]
    command_refs: [CMD-CLEAN-TEST, CMD-HARNESS-CI, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK]
    expected_outcome: Removing the violation and rerunning every gate restores acceptance; waiver or deprecation is rejected.
    lifecycle: planned
---

## Goal
Make the clean break permanent and record complete local release evidence.
## Context Digest
All implementation/consumer tickets are accepted; this ticket owns only gates, audits and release evidence.
## Implementation Approach
Test a focused forbidden-pattern checker, wire it into CI, run all existing gates and document the breaking current contract.
## Decision Ledger
DEC-SS-CLEAN and DEC-SS-CONSUMERS forbid compatibility, migration and fake completion.
## Action Plan
Run preflight, implement/test gates, execute full matrix and route any product defect back to its owner.
## Requirements Traceability
Owns REQ-SS-CLEANUP and all three final paths.
## Contract Traceability
Implements CTR-SS-CLEANUP and validates every prior contract transitively.
## Spec Drift Controls
Spec/plan digests, permanent source scan and canonical audits are release gates.
## Generator And Type Plan
Rebuild declarations and inspect dry-run package contents; generated skill/site artifacts must be clean.
## Test-First Order
Failure fixtures for every forbidden class precede checker/CI acceptance.
## Modularity And Reuse Plan
Extend existing CI/audit scripts; one focused checker owns schema-boundary bans.
## Representation Reuse Plan
No new representation; release evidence references approved artifacts and command results.
## Slice Strategy
Final integration slice only; implementation fixes return to the originating ticket.
## Tasks
Add checker/tests/scripts/CI/release note, run full Harness and PURISTA gates, inspect consumers and package.
## Acceptance
All three rows and independent review pass without publishing.
## Acceptance Test Matrix
Cover each forbidden token/path, clean fixture recovery, full CI, skills/knowledge/handbook and pack dry run.
## End-To-End Definition Coverage
Source through declaration/package, examples/docs/skills/site, CI and rollback documentation is covered.
## Operational Path Coverage
Supply chain, secret-free testing, rollback, full failure diagnostics and no-data migration are recorded.
## Review And Verification Plan
Independent review checks commands, source scan precision, package contents, consumer inventory and unrelated diff.
## Verification
Persist exact outputs and final hashes; do not claim live provider or publish success.
## Non-goals
No feature implementation, provider call, publish, migration code, compatibility switch, Voyage or unrelated cleanup.
## Handoff
Accept only after final reviewer approval; the repository owner controls release/publish separately.
