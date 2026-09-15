---
id: TICKET-001
title: Core Standard Schema boundary: types, validation, and projection
wave: 1
lifecycle: accepted
spec_manifest_digest: sha256:d675819593a8c7712cf7f4ccb6f4a78db08f2cefa325c36ec527e80a166d6498
plan_manifest_digest: sha256:497ac211ca9d25b29bf200d9de6512a73e5e8b190c065ce8a7f73140e78cb1e6
parallel_group: standard-schema-sequential-1
depends_on: []
blocked_by: []
spec_refs:
  - ai-harness/specs/39-standard-schema-boundaries/03-contracts/schema-types.md#CTR-SS-SCHEMA
  - ai-harness/specs/39-standard-schema-boundaries/03-contracts/schema-types.md#CTR-SS-BUILDERS
  - ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-VALIDATION
  - ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-ERRORS
  - ai-harness/specs/39-standard-schema-boundaries/03-contracts/model-projection.md#CTR-SS-PROJECTION
  - ai-harness/specs/39-standard-schema-boundaries/00-conventions.md#CONV-SS-PURISTA
traceability:
  requirement_ids: [REQ-SS-TYPES, REQ-SS-VALIDATION, REQ-SS-PROJECTION]
  capability_ids: [CAP-SS-TYPES, CAP-SS-VALIDATION, CAP-SS-PROJECTION]
  path_ids: [PATH-SS-TYPES-SUCCESS, PATH-SS-TYPES-FAILURE, PATH-SS-TYPES-RECOVERY, PATH-SS-VALIDATION-SUCCESS, PATH-SS-VALIDATION-FAILURE, PATH-SS-VALIDATION-RECOVERY, PATH-SS-PROJECTION-SUCCESS, PATH-SS-PROJECTION-FAILURE, PATH-SS-PROJECTION-RECOVERY]
  acceptance_ids: [AC-SS-TYPES-SUCCESS, AC-SS-TYPES-FAILURE, AC-SS-TYPES-RECOVERY, AC-SS-VALIDATION-SUCCESS, AC-SS-VALIDATION-FAILURE, AC-SS-VALIDATION-RECOVERY, AC-SS-PROJECTION-SUCCESS, AC-SS-PROJECTION-FAILURE, AC-SS-PROJECTION-RECOVERY]
write_scope: [ai-harness/package.json, ai-harness/package-lock.json, ai-harness/packages/harness/package.json, ai-harness/packages/harness/src/schema, ai-harness/packages/harness/src/errors, ai-harness/packages/harness/src/harness/defineHarness.ts, ai-harness/packages/harness/src/agents/index.ts, ai-harness/packages/harness/src/agents/tool-execution.ts, ai-harness/packages/harness/src/workflows/index.ts, ai-harness/packages/harness/src/sessions/index.ts, ai-harness/packages/harness/src/index.ts, ai-harness/packages/harness/type-tests, ai-harness/packages/harness/test, ai-harness/packages/harness-guardrails/src, ai-harness/packages/harness-guardrails/test, ai-harness/packages/harness-guardrails/type-tests]
read_scope: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, purista/packages/core/src/schema/standardSchema.ts, ai-harness/packages/harness/src/models/json.ts, ai-harness/packages/harness/src/ports/model-provider.ts]
contract_readiness:
  status: ready
  required_contracts: [CTR-SS-SCHEMA, CTR-SS-BUILDERS, CTR-SS-VALIDATION, CTR-SS-ERRORS, CTR-SS-PROJECTION]
  missing_contracts: []
generated_contracts:
  status: source_derived_ready
  source_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/generation-map.yaml]
  command_refs: [CMD-BUILD, CMD-TYPES]
  drift_command_refs: [CMD-SPECS, CMD-PLAN]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: refactor_exception
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/39-standard-schema-boundaries/03-contracts/representation-catalog.yaml
  shape_refs: [schema.user, value.validated-json, model.json-schema, schema.error-meta, runtime.serialized-error]
  mapping_refs: [MAP-SS-VALIDATE, MAP-SS-PROJECT, MAP-SS-ERROR]
  new_shape_decision: Approved schema associations are source-derived; no handwritten value interface is allowed.
autonomy:
  allowed_classes: [D0, D1]
  convention_refs: [ai-harness/specs/39-standard-schema-boundaries/00-conventions.md#CONV-SS-PURISTA]
  approved_decision_refs: [ai-harness/specs/39-standard-schema-boundaries/00-vision.md#Decisions]
  escalation: blocker
verification_commands:
  CMD-SPECS:
    command: node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/39-standard-schema-boundaries
    purpose: verify approved contract digest and gates
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-PLAN:
    command: node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/standard-schema-boundaries ai-harness/specs/39-standard-schema-boundaries
    purpose: verify ticket binding and scopes
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-STATUS:
    command: git -C ai-harness status --short
    purpose: record and preserve dirty baseline
    expected: record_only
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-BUILD:
    command: npm --prefix ai-harness run build --workspace @purista/harness
    purpose: emit and verify public declarations
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-TYPES:
    command: npm --prefix ai-harness run test:types --workspace @purista/harness
    purpose: verify exact cross-vendor inference
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-PUBLIC:
    command: npm --prefix ai-harness test --workspace @purista/harness -- public-api.test.ts
    purpose: verify package exports
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-CORE:
    command: npm --prefix ai-harness test --workspace @purista/harness
    purpose: verify runtime validation and build-time projection
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md]
    command_refs: [CMD-SPECS, CMD-PLAN, CMD-STATUS]
    acceptance_refs: [ACC-TYPES-SUCCESS, ACC-TYPES-FAILURE, ACC-TYPES-RECOVERY, ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY, ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: Digests match, execution owns the indivisible core boundary, and unrelated changes are recorded.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/packages/harness/package.json, ai-harness/packages/harness/src/schema, ai-harness/packages/harness/src/harness/defineHarness.ts, ai-harness/packages/harness/src/agents/index.ts, ai-harness/packages/harness/src/sessions/index.ts, ai-harness/packages/harness/src/index.ts]
    command_refs: [CMD-BUILD]
    acceptance_refs: [ACC-TYPES-SUCCESS, ACC-TYPES-FAILURE, ACC-TYPES-RECOVERY, ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY, ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: PURISTA-named schema types, one async validation boundary, and the private build cache emit without public Zod or erased generics.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness/type-tests, ai-harness/packages/harness/test, ai-harness/packages/harness-guardrails/test]
    command_refs: [CMD-TYPES, CMD-PUBLIC, CMD-CORE]
    acceptance_refs: [ACC-TYPES-SUCCESS, ACC-TYPES-FAILURE, ACC-TYPES-RECOVERY, ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY, ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: Positive equality, negative compiler, async validation, error privacy, projection count/failure/freeze, and recovery fixtures fail before and pass after implementation.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/package.json, ai-harness/package-lock.json, ai-harness/packages/harness/package.json, ai-harness/packages/harness/src/schema, ai-harness/packages/harness/src/errors, ai-harness/packages/harness/src/harness/defineHarness.ts, ai-harness/packages/harness/src/agents/index.ts, ai-harness/packages/harness/src/agents/tool-execution.ts, ai-harness/packages/harness/src/workflows/index.ts, ai-harness/packages/harness/src/sessions/index.ts, ai-harness/packages/harness/src/index.ts, ai-harness/packages/harness-guardrails/src]
    command_refs: []
    acceptance_refs: [ACC-TYPES-SUCCESS, ACC-TYPES-FAILURE, ACC-TYPES-RECOVERY, ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY, ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: Exact dependencies, exports, correlated definitions, validation helper, and build cache replace the public Zod path with no compatibility aliases.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness/src/schema, ai-harness/packages/harness/src/harness/defineHarness.ts, ai-harness/packages/harness/src/agents/index.ts, ai-harness/packages/harness/src/agents/tool-execution.ts, ai-harness/packages/harness/src/workflows/index.ts, ai-harness/packages/harness/src/sessions/index.ts, ai-harness/packages/harness/type-tests, ai-harness/packages/harness/test]
    command_refs: [CMD-BUILD, CMD-TYPES, CMD-PUBLIC, CMD-CORE]
    acceptance_refs: [ACC-TYPES-SUCCESS, ACC-TYPES-FAILURE, ACC-TYPES-RECOVERY, ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY, ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: Declarations and tests prove exact schemas, async transforms, nested aliases, error privacy, one-time frozen projection and rejection cases.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: []
    acceptance_refs: [ACC-TYPES-SUCCESS, ACC-TYPES-FAILURE, ACC-TYPES-RECOVERY, ACC-VALIDATION-SUCCESS, ACC-VALIDATION-FAILURE, ACC-VALIDATION-RECOVERY, ACC-PROJECTION-SUCCESS, ACC-PROJECTION-FAILURE, ACC-PROJECTION-RECOVERY]
    expected_proof: Evidence records dependency provenance, commands, scoped diff, source scans and reviewer-ready findings.
acceptance:
  - id: ACC-TYPES-SUCCESS
    traceability_acceptance_ids: [AC-SS-TYPES-SUCCESS]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/schema-types.md#CTR-SS-BUILDERS]
    test_refs: [ai-harness/packages/harness/type-tests/harness-typing.ts]
    command_refs: [CMD-TYPES]
    expected_outcome: Zod, ArkType and Valibot preserve exact nested input/output and registry inference.
    lifecycle: ready
  - id: ACC-TYPES-FAILURE
    traceability_acceptance_ids: [AC-SS-TYPES-FAILURE]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/schema-types.md#CTR-SS-SCHEMA]
    test_refs: [ai-harness/packages/harness/type-tests/harness-typing.ts]
    command_refs: [CMD-TYPES]
    expected_outcome: Invalid schemas, model-incomplete schemas, non-JSON transforms and cross-alias values fail typechecking.
    lifecycle: ready
  - id: ACC-TYPES-RECOVERY
    traceability_acceptance_ids: [AC-SS-TYPES-RECOVERY]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/schema-types.md#CTR-SS-BUILDERS]
    test_refs: [ai-harness/packages/harness/type-tests/harness-typing.ts]
    command_refs: [CMD-BUILD, CMD-TYPES]
    expected_outcome: Correct schemas compile through builder, contexts, sessions and $infer without casts or annotations.
    lifecycle: ready
  - id: ACC-VALIDATION-SUCCESS
    traceability_acceptance_ids: [AC-SS-VALIDATION-SUCCESS]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-VALIDATION]
    test_refs: [ai-harness/packages/harness/src/schema/schema.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: Every public boundary awaits one Standard Schema validation and uses the JSON transformed output.
    lifecycle: ready
  - id: ACC-VALIDATION-FAILURE
    traceability_acceptance_ids: [AC-SS-VALIDATION-FAILURE]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-ERRORS]
    test_refs: [ai-harness/packages/harness/src/schema/schema.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: Issues, throws and non-JSON successes become closed redacted errors with no callback or persistence side effect.
    lifecycle: ready
  - id: ACC-VALIDATION-RECOVERY
    traceability_acceptance_ids: [AC-SS-VALIDATION-RECOVERY]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-flows/e2e-coverage.md#PATH-SS-VALIDATION-RECOVERY]
    test_refs: [ai-harness/packages/harness/src/schema/schema.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: A later conforming call succeeds without caching a failed validation result.
    lifecycle: ready
  - id: ACC-PROJECTION-SUCCESS
    traceability_acceptance_ids: [AC-SS-PROJECTION-SUCCESS]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/model-projection.md#CTR-SS-PROJECTION]
    test_refs: [ai-harness/packages/harness/src/schema/schema.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: Each model boundary projects input Draft 2020-12 once at build and reuses frozen JSON.
    lifecycle: ready
  - id: ACC-PROJECTION-FAILURE
    traceability_acceptance_ids: [AC-SS-PROJECTION-FAILURE]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/runtime-validation.md#CTR-SS-ERRORS]
    test_refs: [ai-harness/packages/harness/src/schema/schema.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: Missing, throwing and invalid converters fail atomically with exact redacted metadata.
    lifecycle: ready
  - id: ACC-PROJECTION-RECOVERY
    traceability_acceptance_ids: [AC-SS-PROJECTION-RECOVERY]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-flows/e2e-coverage.md#PATH-SS-PROJECTION-RECOVERY]
    test_refs: [ai-harness/packages/harness/src/schema/schema.test.ts]
    command_refs: [CMD-CORE]
    expected_outcome: Corrected rebuild succeeds and memory summarization submits actual JSON Schema.
    lifecycle: ready
---

## Goal
Deliver the indivisible Standard Schema core: types, all runtime validation boundaries, and build-time model projection.
## Context Digest
Read the bound specs, analysis, dirty baseline and PURISTA core naming pattern before edits.
## Implementation Approach
Add the direct standard-spec dependency and exact dev fixture versions; rebuild schema-first generics; then install shared validation and projection helpers in the same change. Type replacement cannot build without these consumers moving at once.
## Decision Ledger
DEC-SS-PUBLIC, DEC-SS-JSON, DEC-SS-MODEL, DEC-SS-VALIDATION, DEC-SS-PROJECTION and DEC-SS-CLEAN are fixed; no alias, fallback or alternative generic design is permitted.
## Action Plan
Execute frontmatter steps in order. Stop on digest, dependency or scope mismatch.
## Requirements Traceability
Owns REQ-SS-TYPES, REQ-SS-VALIDATION and REQ-SS-PROJECTION and their nine paths exclusively.
## Contract Traceability
Implements CTR-SS-SCHEMA, CTR-SS-BUILDERS, CTR-SS-VALIDATION, CTR-SS-ERRORS and CTR-SS-PROJECTION exactly.
## Spec Drift Controls
Rerun CMD-SPECS and CMD-PLAN before handoff; never edit approved scoped specs.
## Generator And Type Plan
TypeScript declaration emit is authoritative. Inspect emitted declarations for Zod leakage and widening.
## Test-First Order
Write positive equality/negative compiler fixtures and validation/projection conformance tests before replacing the old path; prove the intended pre-change failures.
## Modularity And Reuse Plan
Reuse `JsonValue`, PURISTA names, existing error types and the builder graph; create the schema module as the sole validation/projection owner.
## Representation Reuse Plan
Schema-associated types derive from `schema.user`; no duplicate request/result interfaces.
## Slice Strategy
This refactor exception must end buildable: changing definitions without moving validation and projection consumers is forbidden.
## Tasks
Update metadata, exports, definitions, mapped inference, validators, lifecycle consumers, compiled model schemas and fixtures; remove public Zod type imports and all direct public-boundary parsing/conversion in owned files.
## Acceptance
All nine local acceptance rows pass and no unrelated file changes are introduced.
## Acceptance Test Matrix
Cover three vendors, nested objects/arrays, defaults/optionals, transforms, aliases, contexts, session methods, wrong-value negatives, async errors, cancellation, projection failure/recovery and cache reuse.
## End-To-End Definition Coverage
Registration through builder declaration emission, runtime boundary validation, build projection, cached provider request construction and caller autocomplete/type rejection is covered.
## Operational Path Coverage
Dependency provenance, clean declaration build, private compiled cache and local runtime boundaries are covered; provider adapters remain later work.
## Review And Verification Plan
Review emitted declarations, schema ownership and source diff, then run every declared command.
## Verification
Record exact command outputs, scoped diff, converter counts and source scan; provider failures do not waive this ticket.
## Non-goals
No provider adapter, documentation, migration or provider behavior changes.
## Handoff
Mark implemented only with evidence, then route to independent review before accepting and promoting TICKET-004.
