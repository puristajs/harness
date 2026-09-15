---
id: TICKET-003
title: Build-time model projection cache and memory schema fix
wave: 3
lifecycle: skipped
spec_manifest_digest: sha256:d675819593a8c7712cf7f4ccb6f4a78db08f2cefa325c36ec527e80a166d6498
plan_manifest_digest: sha256:497ac211ca9d25b29bf200d9de6512a73e5e8b190c065ce8a7f73140e78cb1e6
parallel_group: standard-schema-sequential-3
depends_on: [TICKET-002]
blocked_by: []
spec_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/model-projection.md#CTR-SS-PROJECTION, ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-ERRORS, ai-harness/specs/39-standard-schema-boundaries/03-flows/e2e-coverage.md#Boundary matrix]
traceability:
  requirement_ids: []
  capability_ids: []
  path_ids: []
  acceptance_ids: [AC-SS-PROJECTION-SUCCESS, AC-SS-PROJECTION-FAILURE, AC-SS-PROJECTION-RECOVERY]
write_scope: [ai-harness/packages/harness/src/schema/json-schema.ts, ai-harness/packages/harness/src/schema/json-schema.test.ts, ai-harness/packages/harness/src/harness/defineHarness.ts, ai-harness/packages/harness/src/agents/index.ts, ai-harness/packages/harness/src/sessions/index.ts, ai-harness/packages/harness/test/build-validation.test.ts, ai-harness/packages/harness/test/harness.test.ts]
read_scope: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/packages/harness/src/ports/model-provider.ts, ai-harness/packages/harness/src/schema/validation.ts]
contract_readiness:
  status: ready
  required_contracts: [CTR-SS-PROJECTION, CTR-SS-ERRORS]
  missing_contracts: []
generated_contracts:
  status: source_derived_ready
  source_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/generation-map.yaml]
  command_refs: [CMD-BUILD, CMD-CORE]
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
  shape_refs: [schema.user, model.json-schema, schema.error-meta, runtime.serialized-error]
  mapping_refs: [MAP-SS-PROJECT, MAP-SS-ERROR]
  new_shape_decision: Private compiled definitions reuse registered schemas and projected JsonValue; no public runtime shape is introduced.
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
    purpose: compile build-time definitions
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-CORE:
    command: npm --prefix ai-harness test --workspace @purista/harness
    purpose: verify projection, build and runtime regressions
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-TYPES:
    command: npm --prefix ai-harness run test:types --workspace @purista/harness
    purpose: preserve ModelSchema correlation
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md]
    command_refs: [CMD-SPECS, CMD-PLAN, CMD-STATUS]
    acceptance_refs: [ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: TICKET-002 is accepted and model port remains plain JsonValue.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/packages/harness/src/schema/json-schema.ts, ai-harness/packages/harness/src/harness/defineHarness.ts]
    command_refs: [CMD-BUILD]
    acceptance_refs: [ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: Input projection, JSON assertion, recursive freeze and private cache compile with closed build errors.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness/src/schema/json-schema.test.ts, ai-harness/packages/harness/test/build-validation.test.ts, ai-harness/packages/harness/test/harness.test.ts]
    command_refs: [CMD-CORE, CMD-TYPES]
    acceptance_refs: [ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: Converter spies, three failure cases, atomic rebuild and memory-summary regression are failing tests before implementation.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/packages/harness/src/schema/json-schema.ts, ai-harness/packages/harness/src/harness/defineHarness.ts, ai-harness/packages/harness/src/agents/index.ts, ai-harness/packages/harness/src/sessions/index.ts]
    command_refs: []
    acceptance_refs: [ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: Build owns conversion/cache, runtime consumes cache, and the Zod-to-JsonValue memory cast is deleted.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness/src/schema/json-schema.test.ts, ai-harness/packages/harness/test/build-validation.test.ts, ai-harness/packages/harness/test/harness.test.ts]
    command_refs: [CMD-BUILD, CMD-CORE, CMD-TYPES]
    acceptance_refs: [ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: One converter call per boundary, frozen reuse, exact metadata and real memory JSON Schema are proven.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: []
    acceptance_refs: [ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: Evidence includes converter counts, schema snapshots, error privacy and cast-removal scan.
acceptance:
  - id: ACC-PROJECTION-SUCCESS
    traceability_acceptance_ids: [AC-SS-PROJECTION-SUCCESS]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/model-projection.md#CTR-SS-PROJECTION]
    test_refs: [ai-harness/packages/harness/src/schema/json-schema.test.ts, ai-harness/packages/harness/test/harness.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: Each model boundary projects input Draft 2020-12 once at build and reuses frozen JSON.
    lifecycle: planned
  - id: ACC-PROJECTION-FAILURE
    traceability_acceptance_ids: [AC-SS-PROJECTION-FAILURE]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-ERRORS]
    test_refs: [ai-harness/packages/harness/test/build-validation.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: Missing, throwing and invalid converters fail atomically with exact redacted metadata.
    lifecycle: planned
  - id: ACC-PROJECTION-RECOVERY
    traceability_acceptance_ids: [AC-SS-PROJECTION-RECOVERY]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-flows/e2e-coverage.md#PATH-SS-PROJECTION-RECOVERY]
    test_refs: [ai-harness/packages/harness/test/build-validation.test.ts, ai-harness/packages/harness/test/harness.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: Corrected rebuild succeeds and memory summarization submits actual JSON Schema.
    lifecycle: planned
---

## Goal
Superseded before implementation: type replacement and build-time projection are one buildable core boundary and are owned by TICKET-001.
## Context Digest
Validation is stable after TICKET-002; provider ports already accept JsonValue.
## Implementation Approach
Test converter semantics, implement one projection helper, compile definitions atomically, switch consumers to cache and fix memory summary.
## Decision Ledger
DEC-SS-MODEL, DEC-SS-PROJECTION, DEC-SS-PROVIDERS and DEC-SS-CLEAN are fixed.
## Action Plan
Follow ordered steps; do not convert at runtime or mutate provider keywords.
## Requirements Traceability
Traceability moved to TICKET-001; this retained ticket is skipped as an execution-history record.
## Contract Traceability
Implements CTR-SS-PROJECTION and its build-error portion of CTR-SS-ERRORS.
## Spec Drift Controls
Recheck manifests before and after; scoped specs are immutable.
## Generator And Type Plan
Projection is an in-memory build output, not a committed artifact; declaration correlation remains from TICKET-001.
## Test-First Order
Converter count/failure/freeze/memory tests precede implementation.
## Modularity And Reuse Plan
Reuse JsonValue, isJsonValue, HarnessConfigError and private compiled definitions.
## Representation Reuse Plan
Map schema.user to model.json-schema exactly as catalogued.
## Slice Strategy
Complete tool and default-loop output projection together to avoid mixed runtime conversion.
## Tasks
Implement helper/cache/errors, agent/tool schema consumption and memory regression fix.
## Acceptance
All three acceptance rows pass without converter calls after build.
## Acceptance Test Matrix
Cover Zod, ArkType, Valibot wrapper, distinctive nesting, retries, multiple runs, missing/throw/invalid and rebuild.
## End-To-End Definition Coverage
Schema registration through build projection, provider request input and local validation is covered.
## Operational Path Coverage
Atomic failure, bounded compilation, immutable cache and recovery are asserted.
## Review And Verification Plan
Inspect runtime for conversion calls/casts and run all commands.
## Verification
Record converter counters, deep-freeze checks and memory request capture.
## Non-goals
No provider adapter edits, keyword normalization, docs or migration.
## Handoff
Do not execute or promote this ticket; continue with TICKET-004 after TICKET-001 is reviewed.
