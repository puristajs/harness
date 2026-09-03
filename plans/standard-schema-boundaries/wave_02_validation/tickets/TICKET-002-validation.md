---
id: TICKET-002
title: Shared async runtime validation across public boundaries
wave: 2
lifecycle: skipped
spec_manifest_digest: sha256:d675819593a8c7712cf7f4ccb6f4a78db08f2cefa325c36ec527e80a166d6498
plan_manifest_digest: sha256:497ac211ca9d25b29bf200d9de6512a73e5e8b190c065ce8a7f73140e78cb1e6
parallel_group: standard-schema-sequential-2
depends_on: [TICKET-001]
blocked_by: []
spec_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-VALIDATION, ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-ERRORS, ai-harness/specs/39-standard-schema-boundaries/03-flows/e2e-coverage.md#Boundary matrix]
traceability:
  requirement_ids: []
  capability_ids: []
  path_ids: []
  acceptance_ids: [AC-SS-VALIDATION-SUCCESS, AC-SS-VALIDATION-FAILURE, AC-SS-VALIDATION-RECOVERY]
write_scope: [ai-harness/packages/harness/src/schema/validation.ts, ai-harness/packages/harness/src/schema/validation.test.ts, ai-harness/packages/harness/src/errors, ai-harness/packages/harness/src/agents/index.ts, ai-harness/packages/harness/src/agents/tool-execution.ts, ai-harness/packages/harness/src/workflows/index.ts, ai-harness/packages/harness/src/sessions/index.ts, ai-harness/packages/harness/test, ai-harness/packages/harness-guardrails/src, ai-harness/packages/harness-guardrails/test, ai-harness/packages/harness-guardrails/type-tests]
read_scope: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/packages/harness/src/models/json.ts, ai-harness/packages/harness/src/harness/defineHarness.ts]
contract_readiness:
  status: ready
  required_contracts: [CTR-SS-VALIDATION, CTR-SS-ERRORS]
  missing_contracts: []
generated_contracts:
  status: source_derived_ready
  source_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/generation-map.yaml]
  command_refs: [CMD-BUILD]
  drift_command_refs: [CMD-SPECS, CMD-PLAN]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: vertical_slice
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/39-standard-schema-boundaries/03-contracts/representation-catalog.yaml
  shape_refs: [schema.user, value.validated-json, schema.error-meta, runtime.serialized-error]
  mapping_refs: [MAP-SS-VALIDATE, MAP-SS-ERROR]
  new_shape_decision: Existing JsonValue and serialized error remain canonical; only closed metadata reasons are added.
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
    purpose: preserve dirty baseline
    expected: record_only
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-BUILD:
    command: npm --prefix ai-harness run build --workspace @purista/harness
    purpose: compile runtime changes
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-CORE:
    command: npm --prefix ai-harness test --workspace @purista/harness
    purpose: validate all core boundary behavior
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-GUARD:
    command: npm --prefix ai-harness test --workspace @purista/harness-guardrails
    purpose: validate guardrail schema behavior
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-TYPES:
    command: npm --prefix ai-harness run test:types
    purpose: preserve callback type directions
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md]
    command_refs: [CMD-SPECS, CMD-PLAN, CMD-STATUS]
    acceptance_refs: [ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY]
    expected_proof: TICKET-001 is accepted and bound inputs are unchanged.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/packages/harness/src/schema/validation.ts, ai-harness/packages/harness/src/errors]
    command_refs: [CMD-BUILD]
    acceptance_refs: [ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY]
    expected_proof: One awaited validator and closed privacy-safe error mapping compile.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness/src/schema/validation.test.ts, ai-harness/packages/harness/test, ai-harness/packages/harness-guardrails/test, ai-harness/packages/harness-guardrails/type-tests]
    command_refs: [CMD-CORE, CMD-GUARD, CMD-TYPES]
    acceptance_refs: [ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY]
    expected_proof: Table-driven boundary tests prove sync, async, transform, failures and recovery before implementation completion.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/packages/harness/src/schema/validation.ts, ai-harness/packages/harness/src/errors, ai-harness/packages/harness/src/agents/index.ts, ai-harness/packages/harness/src/agents/tool-execution.ts, ai-harness/packages/harness/src/workflows/index.ts, ai-harness/packages/harness/src/sessions/index.ts, ai-harness/packages/harness-guardrails/src]
    command_refs: []
    acceptance_refs: [ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY]
    expected_proof: Direct user-schema parses are deleted and every owned runtime boundary uses validated JSON output exactly once.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness/src/schema/validation.ts, ai-harness/packages/harness/src/schema/validation.test.ts, ai-harness/packages/harness/test, ai-harness/packages/harness-guardrails/test]
    command_refs: [CMD-BUILD, CMD-CORE, CMD-GUARD, CMD-TYPES]
    acceptance_refs: [ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY]
    expected_proof: All effects stop after failure, serialized errors redact content and later valid calls succeed.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: []
    acceptance_refs: [ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY]
    expected_proof: Evidence includes call counters, error snapshots, cancellation checks and scoped diff.
acceptance:
  - id: ACC-VALIDATION-SUCCESS
    traceability_acceptance_ids: [AC-SS-VALIDATION-SUCCESS]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-VALIDATION]
    test_refs: [ai-harness/packages/harness/src/schema/validation.test.ts, ai-harness/packages/harness/test/harness.test.ts, ai-harness/packages/harness-guardrails/test/guardrails.test.ts]
    command_refs: [CMD-CORE, CMD-GUARD]
    expected_outcome: Sync and async transforms yield one validated JSON value at every boundary.
    lifecycle: planned
  - id: ACC-VALIDATION-FAILURE
    traceability_acceptance_ids: [AC-SS-VALIDATION-FAILURE]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-ERRORS]
    test_refs: [ai-harness/packages/harness/src/schema/validation.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: Issues, throws, rejects and non-JSON output fail with fixed redacted errors before effects.
    lifecycle: planned
  - id: ACC-VALIDATION-RECOVERY
    traceability_acceptance_ids: [AC-SS-VALIDATION-RECOVERY]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-flows/e2e-coverage.md#PATH-SS-VALIDATION-RECOVERY]
    test_refs: [ai-harness/packages/harness/test/harness.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: A valid call after failure succeeds without leaked state.
    lifecycle: planned
---

## Goal
Superseded before implementation: type replacement and runtime validation are one buildable core boundary and are owned by TICKET-001.
## Context Digest
TICKET-001 declarations are prerequisite; reuse existing JsonValue, errors, cancellation and runtime order.
## Implementation Approach
Test the helper first, extend closed error metadata, replace each direct public-schema parse, then delete duplicate branches.
## Decision Ledger
DEC-SS-VALIDATION, DEC-SS-JSON and DEC-SS-CLEAN are fixed.
## Action Plan
Execute ordered steps and stop if TICKET-001 is not accepted.
## Requirements Traceability
Traceability moved to TICKET-001; this retained ticket is skipped as an execution-history record.
## Contract Traceability
Implements CTR-SS-VALIDATION and CTR-SS-ERRORS.
## Spec Drift Controls
Approved specs remain immutable; preflight and handoff recheck digests.
## Generator And Type Plan
No new generator; emitted callback types from TICKET-001 must remain exact.
## Test-First Order
Add helper and boundary failure tests before runtime replacement.
## Modularity And Reuse Plan
One helper owns validation/JSON assertion; existing errors and signal lifecycle remain owners.
## Representation Reuse Plan
Map schema.user to value.validated-json and allowlisted error metadata to existing serialization.
## Slice Strategy
Complete all public validation sites in one sequential slice so no dual runtime remains.
## Tasks
Implement helper, errors, all boundary calls, guardrails, cancellation checks and tests.
## Acceptance
All three rows pass with no content leakage or duplicate validation.
## Acceptance Test Matrix
Cover each boundary with sync/async success, issues, rejection, throw, transform, non-JSON and later recovery.
## End-To-End Definition Coverage
Invocation candidate through callback/effect, validation, persistence/result and error serialization is covered.
## Operational Path Coverage
Cancellation, failure isolation, bounded issue handling and secret-free telemetry/logging are asserted.
## Review And Verification Plan
Review every removed parse call, helper callers, snapshots and call counters; run all commands.
## Verification
Record command outputs and forbidden direct public-schema parsing scan.
## Non-goals
No model projection, adapter changes, docs, migration or internal Zod purge.
## Handoff
Do not execute or promote this ticket; continue with TICKET-004 after TICKET-001 is reviewed.
