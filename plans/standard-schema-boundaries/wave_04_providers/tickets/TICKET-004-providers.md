---
id: TICKET-004
title: First-party provider exact JSON Schema pass-through
wave: 4
lifecycle: accepted
spec_manifest_digest: sha256:d675819593a8c7712cf7f4ccb6f4a78db08f2cefa325c36ec527e80a166d6498
plan_manifest_digest: sha256:497ac211ca9d25b29bf200d9de6512a73e5e8b190c065ce8a7f73140e78cb1e6
parallel_group: standard-schema-sequential-4
depends_on: [TICKET-001]
blocked_by: []
spec_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/model-projection.md#CTR-SS-PROVIDERS, ai-harness/specs/39-standard-schema-boundaries/03-contracts/model-projection.md#CTR-SS-PROJECTION]
traceability:
  requirement_ids: [REQ-SS-PROVIDERS]
  capability_ids: [CAP-SS-PROVIDERS]
  path_ids: [PATH-SS-PROVIDERS-SUCCESS, PATH-SS-PROVIDERS-FAILURE, PATH-SS-PROVIDERS-RECOVERY]
  acceptance_ids: [AC-SS-PROVIDERS-SUCCESS, AC-SS-PROVIDERS-FAILURE, AC-SS-PROVIDERS-RECOVERY]
write_scope: [ai-harness/packages/harness-openai, ai-harness/packages/harness-anthropic, ai-harness/packages/harness-bedrock, ai-harness/packages/harness-azure-foundry]
read_scope: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, ai-harness/packages/harness/src/ports/model-provider.ts, ai-harness/packages/harness/src/schema/json-schema.ts]
contract_readiness:
  status: ready
  required_contracts: [CTR-SS-PROVIDERS, CTR-SS-PROJECTION]
  missing_contracts: []
generated_contracts:
  status: source_derived_ready
  source_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/generation-map.yaml]
  command_refs: [CMD-BUILD, CMD-PROVIDERS]
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
  shape_refs: [model.json-schema, provider.sdk-request-schema]
  mapping_refs: [MAP-SS-PROVIDER]
  new_shape_decision: Existing provider request shapes remain canonical; tests capture their schema field without a new adapter abstraction.
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
    command: npm --prefix ai-harness run build
    purpose: compile all provider packages
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-PROVIDERS:
    command: npm --prefix ai-harness test --workspaces --if-present
    purpose: run provider contract tests with fake SDK seams
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-ARCH:
    command: npm --prefix ai-harness run verify:architecture
    purpose: prove dependency boundaries
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md]
    command_refs: [CMD-SPECS, CMD-PLAN, CMD-STATUS]
    acceptance_refs: [ACC-PROVIDERS-SUCCESS, ACC-PROVIDERS-FAILURE, ACC-PROVIDERS-RECOVERY]
    expected_proof: TICKET-003 is accepted and provider ports remain JsonValue-only.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/packages/harness-openai, ai-harness/packages/harness-anthropic, ai-harness/packages/harness-bedrock, ai-harness/packages/harness-azure-foundry]
    command_refs: [CMD-BUILD, CMD-ARCH]
    acceptance_refs: [ACC-PROVIDERS-SUCCESS, ACC-PROVIDERS-FAILURE, ACC-PROVIDERS-RECOVERY]
    expected_proof: Adapters compile without schema-library dependencies or conversion helpers.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/packages/harness-openai/test, ai-harness/packages/harness-anthropic/test, ai-harness/packages/harness-bedrock/test, ai-harness/packages/harness-azure-foundry/test]
    command_refs: [CMD-PROVIDERS]
    acceptance_refs: [ACC-PROVIDERS-SUCCESS, ACC-PROVIDERS-FAILURE, ACC-PROVIDERS-RECOVERY]
    expected_proof: Distinctive schema pass-through, provider rejection and compatible recovery tests exist at every SDK seam.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/packages/harness-openai, ai-harness/packages/harness-anthropic, ai-harness/packages/harness-bedrock, ai-harness/packages/harness-azure-foundry]
    command_refs: []
    acceptance_refs: [ACC-PROVIDERS-SUCCESS, ACC-PROVIDERS-FAILURE, ACC-PROVIDERS-RECOVERY]
    expected_proof: Only required request translation/test changes are made; no keyword rewrite or weakened retry is introduced.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/packages/harness-openai, ai-harness/packages/harness-anthropic, ai-harness/packages/harness-bedrock, ai-harness/packages/harness-azure-foundry]
    command_refs: [CMD-BUILD, CMD-PROVIDERS, CMD-ARCH]
    acceptance_refs: [ACC-PROVIDERS-SUCCESS, ACC-PROVIDERS-FAILURE, ACC-PROVIDERS-RECOVERY]
    expected_proof: All four packages deep-equal schemas and use existing model-error mapping with no network.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: []
    acceptance_refs: [ACC-PROVIDERS-SUCCESS, ACC-PROVIDERS-FAILURE, ACC-PROVIDERS-RECOVERY]
    expected_proof: Evidence records captured requests, dependency scans and provider-specific rejection behavior.
acceptance:
  - id: ACC-PROVIDERS-SUCCESS
    traceability_acceptance_ids: [AC-SS-PROVIDERS-SUCCESS]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/model-projection.md#CTR-SS-PROVIDERS]
    test_refs: [ai-harness/packages/harness-openai/test/provider-contract.test.ts, ai-harness/packages/harness-anthropic/test/provider-contract.test.ts, ai-harness/packages/harness-bedrock/test/provider-contract.test.ts, ai-harness/packages/harness-azure-foundry/test/provider-contract.test.ts]
    command_refs: [CMD-PROVIDERS]
    expected_outcome: Every SDK request receives deeply equal nested JSON Schema.
    lifecycle: planned
  - id: ACC-PROVIDERS-FAILURE
    traceability_acceptance_ids: [AC-SS-PROVIDERS-FAILURE]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/model-projection.md#CTR-SS-PROVIDERS]
    test_refs: [ai-harness/packages/harness-openai/test/provider-contract.test.ts, ai-harness/packages/harness-anthropic/test/provider-contract.test.ts]
    command_refs: [CMD-PROVIDERS]
    expected_outcome: Provider rejection maps through existing errors and never retries with weakened schema.
    lifecycle: planned
  - id: ACC-PROVIDERS-RECOVERY
    traceability_acceptance_ids: [AC-SS-PROVIDERS-RECOVERY]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-flows/e2e-coverage.md#PATH-SS-PROVIDERS-RECOVERY]
    test_refs: [ai-harness/packages/harness-bedrock/test/provider-contract.test.ts, ai-harness/packages/harness-azure-foundry/test/provider-contract.test.ts]
    command_refs: [CMD-PROVIDERS]
    expected_outcome: An explicitly compatible schema succeeds through the unchanged port and local validation remains authoritative.
    lifecycle: planned
---

## Goal
Prove and preserve provider-neutral exact JSON Schema pass-through.
## Context Digest
Core projection is accepted; provider ports use JsonValue and SDK seams already have fakes.
## Implementation Approach
Add deep-equality contract cases first, then make only necessary pass-through corrections.
## Decision Ledger
DEC-SS-PROVIDERS and DEC-SS-PROJECTION forbid validator imports and keyword rewriting.
## Action Plan
Run all four adapters together and stop on any live-call or secret requirement.
## Requirements Traceability
Owns REQ-SS-PROVIDERS and three paths.
## Contract Traceability
Implements CTR-SS-PROVIDERS without changing CTR-SS-PROJECTION.
## Spec Drift Controls
Spec and plan checks precede adapter edits and handoff.
## Generator And Type Plan
No generator or public type changes; SDK request types are existing boundaries.
## Test-First Order
Distinctive nested schema and rejection captures precede corrections.
## Modularity And Reuse Plan
Reuse provider port, existing adapters, fakes and error mappers.
## Representation Reuse Plan
MAP-SS-PROVIDER permits container placement only; schema content is exact.
## Slice Strategy
One cross-adapter conformance slice prevents inconsistent provider claims.
## Tasks
Test object/tool schema fields, rejection sequence, dependency boundaries and compatible recovery.
## Acceptance
All three rows pass across all four first-party providers.
## Acceptance Test Matrix
Cover object and tool requests, nested refs/unions/additionalProperties, SDK rejection and second compatible request.
## End-To-End Definition Coverage
Core JsonValue through adapter mapping to captured SDK request and mapped response/error is covered.
## Operational Path Coverage
No network/secrets, no weakened retry and existing cancellation/error behavior are retained.
## Review And Verification Plan
Inspect package manifests/imports/request captures and run all commands.
## Verification
Record deep-equality fixtures and zero validator-dependency scan.
## Non-goals
No provider schema subset normalizer, live test, core edit, docs or migration.
## Handoff
Accept reviewed conformance before promoting TICKET-005.
