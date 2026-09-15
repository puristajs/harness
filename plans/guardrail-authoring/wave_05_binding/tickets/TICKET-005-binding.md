---
id: TICKET-005
title: Attach requirements and end-to-end deployment preflight
wave: 5
lifecycle: accepted
spec_manifest_digest: "sha256:40c13572186ebc1f800a3742dab3b514a65bb924887e9c994921f457bd682b3f"
plan_manifest_digest: sha256:2a9ef84fc85798d2235d0bb1203403837fa90f56142d9730ab695bf2beb771c9
parallel_group: guardrail-authoring-sequential-5
depends_on:
  - TICKET-004
blocked_by: []
spec_refs:
  - ai-harness/specs/38-guardrail-authoring/03-contracts/actions-and-binding.md#CTR-GA-BINDING
  - ai-harness/specs/38-guardrail-authoring/03-contracts/actions-and-binding.md#CTR-GA-ACTIONS
  - ai-harness/specs/38-guardrail-authoring/04-delivery/consumers.md#CTR-GA-DOCS
  - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-BINDING
  - ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE
write_scope:
  - ai-harness/packages/harness-guardrails/src/action.ts
  - ai-harness/packages/harness-guardrails/src/rails.ts
  - ai-harness/packages/harness-guardrails/src/index.ts
  - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
  - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
  - ai-harness/examples/guardrails/src/index.ts
  - ai-harness/examples/guardrails/src/index.test.ts
  - ai-harness/examples/guardrails/package.json
read_scope:
  - ai-harness/specs/38-guardrail-authoring
  - ai-harness/plans/guardrail-authoring/analysis.md
  - ai-harness/AGENTS.md
  - ai-harness/.agent/IMPLEMENTATION.md
  - ai-harness/specs/37-decision-boundaries
  - ai-harness/specs/16-testing.md
  - ai-harness/package.json
  - ai-harness/package-lock.json
  - purista/AGENTS.md
  - purista/skills/purista/SKILL.md
  - ai-harness/packages/harness-guardrails/src/action.ts
  - ai-harness/packages/harness-guardrails/src/rails.ts
  - ai-harness/packages/harness-guardrails/src/index.ts
  - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
  - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
  - ai-harness/examples/guardrails/src/index.ts
  - ai-harness/examples/guardrails/src/index.test.ts
  - ai-harness/examples/guardrails/package.json
contract_readiness:
  status: ready
  required_contracts:
    - CTR-GA-BINDING
    - CTR-GA-ACTIONS
    - CTR-GA-DOCS
  missing_contracts: []
traceability:
  requirement_ids:
    - REQ-GA-BINDING
  capability_ids:
    - CAP-GA-BINDING
  path_ids:
    - PATH-GA-BINDING-SUCCESS
    - PATH-GA-BINDING-FAILURE
    - PATH-GA-BINDING-RECOVERY
  acceptance_ids:
    - AC-GA-BINDING-SUCCESS
    - AC-GA-BINDING-FAILURE
    - AC-GA-BINDING-RECOVERY
generated_contracts:
  status: source_derived_ready
  source_refs:
    - ai-harness/specs/38-guardrail-authoring/03-contracts/generation-map.yaml
  command_refs:
    - CMD-BUILD
    - CMD-ADDON-TYPES
  drift_command_refs:
    - CMD-SPECS
    - CMD-PLAN
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: vertical_slice
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/38-guardrail-authoring/03-contracts/representation-catalog.yaml
  shape_refs:
    - guardrails.action-definition
    - guardrails.action-token
    - agent.requirements
  mapping_refs:
    - MAP-GA-ACTION
  new_shape_decision: none; approved CTR-GA contracts define every introduced shape
autonomy:
  allowed_classes:
    - D0
    - D1
  convention_refs:
    - ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE
  approved_decision_refs:
    - ai-harness/specs/38-guardrail-authoring/00-vision.md#Decisions
  escalation: blocker
verification_commands:
  CMD-SPECS:
    command: node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/38-guardrail-authoring
    purpose: approved preflight
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-PLAN:
    command: node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/guardrail-authoring ai-harness/specs/38-guardrail-authoring
    purpose: approved preflight
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-STATUS:
    command: git -C ai-harness status --short
    purpose: approved preflight
    expected: record_only
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-BUILD:
    command: npm --prefix ai-harness run build
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-ADDON:
    command: npm --prefix ai-harness test --workspace @purista/harness-guardrails
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-ADDON-TYPES:
    command: "npm --prefix ai-harness run test:types --workspace @purista/harness-guardrails"
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-EXAMPLE:
    command: npm --prefix ai-harness test --workspace @purista/guardrails-example
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-PREFLIGHT:
    command: npm --prefix ai-harness test --workspace @purista/guardrails-example
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files:
      - ai-harness/specs/38-guardrail-authoring
      - ai-harness/plans/guardrail-authoring/analysis.md
      - ai-harness/AGENTS.md
      - ai-harness/.agent/IMPLEMENTATION.md
    command_refs:
      - CMD-SPECS
      - CMD-PLAN
      - CMD-STATUS
    acceptance_refs:
      - ACC-BINDING-SUCCESS
      - ACC-BINDING-FAILURE
      - ACC-BINDING-RECOVERY
    expected_proof: current digests and dependencies checked; dirty baseline preserved
  - id: STEP-CONTRACT
    kind: contract
    files:
      - ai-harness/packages/harness-guardrails/src/action.ts
      - ai-harness/packages/harness-guardrails/src/rails.ts
      - ai-harness/packages/harness-guardrails/src/index.ts
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
      - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
      - ai-harness/examples/guardrails/src/index.ts
      - ai-harness/examples/guardrails/src/index.test.ts
      - ai-harness/examples/guardrails/package.json
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
      - CMD-ADDON-TYPES
      - CMD-EXAMPLE
      - CMD-PREFLIGHT
    acceptance_refs:
      - ACC-BINDING-SUCCESS
      - ACC-BINDING-FAILURE
      - ACC-BINDING-RECOVERY
    expected_proof: approved source-derived shapes and required generated outputs established before behavior edits
  - id: STEP-TEST
    kind: test
    files:
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
      - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
      - ai-harness/examples/guardrails/src/index.test.ts
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
      - CMD-ADDON-TYPES
      - CMD-EXAMPLE
      - CMD-PREFLIGHT
    acceptance_refs:
      - ACC-BINDING-SUCCESS
      - ACC-BINDING-FAILURE
      - ACC-BINDING-RECOVERY
    expected_proof: negative/happy cases demonstrate old failure then new acceptance
  - id: STEP-IMPLEMENT
    kind: implement
    files:
      - ai-harness/packages/harness-guardrails/src/action.ts
      - ai-harness/packages/harness-guardrails/src/rails.ts
      - ai-harness/packages/harness-guardrails/src/index.ts
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
      - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
      - ai-harness/examples/guardrails/src/index.ts
      - ai-harness/examples/guardrails/src/index.test.ts
      - ai-harness/examples/guardrails/package.json
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
      - CMD-ADDON-TYPES
      - CMD-EXAMPLE
      - CMD-PREFLIGHT
    acceptance_refs:
      - ACC-BINDING-SUCCESS
      - ACC-BINDING-FAILURE
      - ACC-BINDING-RECOVERY
    expected_proof: only approved behavior and mechanical consumer cut within scope
  - id: STEP-VERIFY
    kind: verify
    files:
      - ai-harness/packages/harness-guardrails/src/action.ts
      - ai-harness/packages/harness-guardrails/src/rails.ts
      - ai-harness/packages/harness-guardrails/src/index.ts
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
      - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
      - ai-harness/examples/guardrails/src/index.ts
      - ai-harness/examples/guardrails/src/index.test.ts
      - ai-harness/examples/guardrails/package.json
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
      - CMD-ADDON-TYPES
      - CMD-EXAMPLE
      - CMD-PREFLIGHT
    acceptance_refs:
      - ACC-BINDING-SUCCESS
      - ACC-BINDING-FAILURE
      - ACC-BINDING-RECOVERY
    expected_proof: exact commands pass with no threshold weakening or skipped assertions
  - id: STEP-HANDOFF
    kind: handoff
    files:
      - ai-harness/packages/harness-guardrails/src/action.ts
      - ai-harness/packages/harness-guardrails/src/rails.ts
      - ai-harness/packages/harness-guardrails/src/index.ts
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
      - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
      - ai-harness/examples/guardrails/src/index.ts
      - ai-harness/examples/guardrails/src/index.test.ts
      - ai-harness/examples/guardrails/package.json
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
      - CMD-ADDON-TYPES
      - CMD-EXAMPLE
      - CMD-PREFLIGHT
    acceptance_refs:
      - ACC-BINDING-SUCCESS
      - ACC-BINDING-FAILURE
      - ACC-BINDING-RECOVERY
    expected_proof: evidence recorded; request independent review, not self-acceptance
acceptance:
  - id: ACC-BINDING-SUCCESS
    traceability_acceptance_ids:
      - AC-GA-BINDING-SUCCESS
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-BINDING
    test_refs:
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
      - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
      - ai-harness/examples/guardrails/src/index.test.ts
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
      - CMD-ADDON-TYPES
      - CMD-EXAMPLE
      - CMD-PREFLIGHT
    expected_outcome: Attached actions emit active-phase requirements; the inline example builds and executes two differently shaped tools with selective protection.
    lifecycle: accepted
  - id: ACC-BINDING-FAILURE
    traceability_acceptance_ids:
      - AC-GA-BINDING-FAILURE
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-BINDING
    test_refs:
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
      - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
      - ai-harness/examples/guardrails/src/index.test.ts
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
      - CMD-ADDON-TYPES
      - CMD-EXAMPLE
      - CMD-PREFLIGHT
    expected_outcome: Missing model/tool/capability fails build before requests; retrieval checks only retrieval dependencies; schema-incompatible selected payload still fails at invocation with zero protected effects.
    lifecycle: accepted
  - id: ACC-BINDING-RECOVERY
    traceability_acceptance_ids:
      - AC-GA-BINDING-RECOVERY
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-BINDING
    test_refs:
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
      - ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts
      - ai-harness/examples/guardrails/src/index.test.ts
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
      - CMD-ADDON-TYPES
      - CMD-EXAMPLE
      - CMD-PREFLIGHT
    expected_outcome: Manual core interceptor declarations retain requirements; preflight script calls the real composition then shutdown with zero model/detector/tool invocations; corrected policy can rebuild.
    lifecycle: accepted
---

## Goal

Attach requirements and end-to-end deployment preflight through the existing public entrypoint, including negative and recovery behavior.

## Context Digest

Read the listed contracts and analysis. This ticket owns REQ-GA-BINDING; previous tickets are dependencies, not permission to change their contracts. Source baseline is dirty. Voyage is excluded.

## Implementation Approach

- Project declared action models into callback handles and emit object requirements from existing token metadata; direct aliases/token construction are prerequisites from TICKET-002/004.
- Aggregate only active attached phases into both attach() and interceptor(); keep retrieval requirements separate and preflight supplied retrieval handles.
- Preserve exact agent schema/context inference, interceptor order and custom-handler rejection.
- Exercise the inline composition using existing fakes for good/bad policy and registry cases without network.

## Decision Ledger

Execute the referenced DEC-GA decisions mechanically. D1 is limited to private extraction/naming under CONV-GA-STYLE. No public design, compatibility, dependency, validation-stage or UX choice is delegated.

## Action Plan

1. Preflight: read scoped authority and dependencies; run CMD-SPECS, CMD-PLAN, CMD-STATUS. Record existing dirty files and actual command baseline; never reset.
2. Establish the cited canonical types/schema/exports first; use generation map. Build fresh declarations before consumers. No handwritten field mirrors.
3. Extend the listed natural tests with all three acceptance rows; record expected pre-change failures or baseline evidence.
4. Implement the numbered changes under Implementation Approach in order, including mechanical affected consumers. Do not add temporary compatibility behavior.
5. Run the exact Verification commands in listed order; investigate failures only within scope, otherwise record blocker.
6. Record changed files, test cases, red/green evidence and limitations in the ticket evidence file; move to implemented and request independent review.

## Requirements Traceability

REQ-GA-BINDING → CAP-GA-BINDING → SUCCESS/FAILURE/RECOVERY paths and AC IDs in frontmatter. No unowned acceptance remains.

## Contract Traceability

- ai-harness/specs/38-guardrail-authoring/03-contracts/actions-and-binding.md#CTR-GA-BINDING
- ai-harness/specs/38-guardrail-authoring/03-contracts/actions-and-binding.md#CTR-GA-ACTIONS
- ai-harness/specs/38-guardrail-authoring/04-delivery/consumers.md#CTR-GA-DOCS
- ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-BINDING
- ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE

## Spec Drift Controls

Check both manifest digests before edits and handoff. A contract ambiguity or changed prerequisite blocks the ticket; write a finding under plan evidence, do not modify approved semantics. Only controller updates lifecycle/digests after review.

## Generator And Type Plan

Build first, derive TypeScript via Zod/indexed/generic aliases. Existing declaration emit is authoritative; no copied option table or duplicate validator is added.

## Test-First Order

Add type-negative/schema-negative cases first, then the success fixture, then recovery/mutation/no-effect assertions. Reuse existing fakes. If a behavior already passes, record that evidence rather than forcing an artificial failure.

## Modularity And Reuse Plan

Use file-structure/module/reuse inventory. One canonical type per meaning, one builtin resolver, one decision executor and one sensitive algorithm. New helpers are limited to approved cohesive modules. Do not reformat or reorganize unrelated files.

## Representation Reuse Plan

All shape and mapping IDs are enumerated in frontmatter; apply only those touched by this ticket. Config defaults, opaque action preparation and native registration marking are the only new mappings; existing spec37 evidence/output shapes are unchanged.

## Slice Strategy

One sequential, publicly testable authoring/preflight/documentation slice. The complete breaking release is held until TICKET-008 accepts all consumers; no partial release or temporary compatibility is allowed. Same-file contracts make parallel writes inappropriate.

## Tasks

1. Project declared action models into callback handles and emit object requirements from existing token metadata; direct aliases/token construction are prerequisites from TICKET-002/004.
2. Aggregate only active attached phases into both attach() and interceptor(); keep retrieval requirements separate and preflight supplied retrieval handles.
3. Preserve exact agent schema/context inference, interceptor order and custom-handler rejection.
4. Exercise the inline composition using existing fakes for good/bad policy and registry cases without network.

## Acceptance

- Attached actions emit active-phase requirements; the inline example builds and executes two differently shaped tools with selective protection.
- Missing model/tool/capability fails build before requests; retrieval checks only retrieval dependencies; schema-incompatible selected payload still fails at invocation with zero protected effects.
- Manual core interceptor declarations retain requirements; preflight script calls the real composition then shutdown with zero model/detector/tool invocations; corrected policy can rebuild.

## Acceptance Test Matrix

| Path | Required assertion |
| --- | --- |
| success | Attached actions emit active-phase requirements; the inline example builds and executes two differently shaped tools with selective protection. |
| failure | Missing model/tool/capability fails build before requests; retrieval checks only retrieval dependencies; schema-incompatible selected payload still fails at invocation with zero protected effects. |
| recovery | Manual core interceptor declarations retain requirements; preflight script calls the real composition then shutdown with zero model/detector/tool invocations; corrected policy can rebuild. |


## Review And Verification Plan

Independent review must trace the public entrypoint to exact validation/side-effect behavior and inspect failure paths, not only green compile output. Verify generated artifact ownership, no raw-content errors and no duplicated public fields.

## End-To-End Definition Coverage

Actor, entrypoint, data, errors, recovery, permissions, observability, owner and final state are fixed in the linked requirement. Verify actual API use rather than an illustrative replacement. Docs use runnable source and checked projections.

## Operational Path Coverage

Preflight failures must precede requests and protected effects. Runtime deadlines/privacy remain spec37-owned. No new deployment service or persistence. Applicability N/A records cover infrastructure/migrations/Voyage/live systems.

## Verification

Working directory: workspace root /Users/sebastianwessel/projekte/@purista. Run these in order, without shell chaining:

- `CMD-BUILD`: `npm --prefix ai-harness run build`
- `CMD-ADDON`: `npm --prefix ai-harness test --workspace @purista/harness-guardrails`
- `CMD-ADDON-TYPES`: `npm --prefix ai-harness run test:types --workspace @purista/harness-guardrails`
- `CMD-EXAMPLE`: `npm --prefix ai-harness test --workspace @purista/guardrails-example`
- `CMD-PREFLIGHT`: `npm --prefix ai-harness test --workspace @purista/guardrails-example`

A command introduced by this ticket is run only after its implementation. External systems/secrets are forbidden. If dependency artifacts are absent, stop for the normal installation approval instead of fetching implicitly.

## Non-goals

Voyage; provider/detector internals; unrelated sandbox/storage/evaluation work; broad arrow conversion; migration/compatibility paths; new dependencies; publishing or source reset.

## Handoff

Write ai-harness/plans/guardrail-authoring/evidence/TICKET-005.md with exact results, acceptance-ID mapping and residual blockers. Mark implemented, not accepted. Independent reviewer controls acceptance; controller updates all four indexes and manifests together.
