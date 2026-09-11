---
id: TICKET-003
title: Provider-neutral interceptor build preflight
wave: 3
lifecycle: accepted
spec_manifest_digest: "sha256:40c13572186ebc1f800a3742dab3b514a65bb924887e9c994921f457bd682b3f"
plan_manifest_digest: sha256:2a9ef84fc85798d2235d0bb1203403837fa90f56142d9730ab695bf2beb771c9
parallel_group: guardrail-authoring-sequential-3
depends_on:
  - TICKET-002
blocked_by: []
spec_refs:
  - ai-harness/specs/38-guardrail-authoring/03-contracts/actions-and-binding.md#CTR-GA-BINDING
  - ai-harness/specs/38-guardrail-authoring/03-contracts/actions-and-binding.md#CTR-GA-ERRORS
  - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-REQUIREMENTS
  - ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE
write_scope:
  - ai-harness/packages/harness/src/harness/agent-requirements.ts
  - ai-harness/packages/harness/src/harness/defineHarness.ts
  - ai-harness/packages/harness/src/agents/index.ts
  - ai-harness/packages/harness/src/tools/index.ts
  - ai-harness/packages/harness/src/models/registry.ts
  - ai-harness/packages/harness/src/index.ts
  - ai-harness/packages/harness/test/build-validation.test.ts
  - ai-harness/packages/harness/test/agent-interceptors.test.ts
  - ai-harness/packages/harness/test/public-api.test.ts
  - ai-harness/packages/harness/type-tests/harness-typing.ts
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
  - ai-harness/packages/harness/src/harness/agent-requirements.ts
  - ai-harness/packages/harness/src/harness/defineHarness.ts
  - ai-harness/packages/harness/src/agents/index.ts
  - ai-harness/packages/harness/src/tools/index.ts
  - ai-harness/packages/harness/src/models/registry.ts
  - ai-harness/packages/harness/src/index.ts
  - ai-harness/packages/harness/test/build-validation.test.ts
  - ai-harness/packages/harness/test/agent-interceptors.test.ts
  - ai-harness/packages/harness/test/public-api.test.ts
  - ai-harness/packages/harness/type-tests/harness-typing.ts
contract_readiness:
  status: ready
  required_contracts:
    - CTR-GA-BINDING
    - CTR-GA-ERRORS
  missing_contracts: []
traceability:
  requirement_ids:
    - REQ-GA-REQUIREMENTS
  capability_ids:
    - CAP-GA-REQUIREMENTS
  path_ids:
    - PATH-GA-REQUIREMENTS-SUCCESS
    - PATH-GA-REQUIREMENTS-FAILURE
    - PATH-GA-REQUIREMENTS-RECOVERY
  acceptance_ids:
    - AC-GA-REQUIREMENTS-SUCCESS
    - AC-GA-REQUIREMENTS-FAILURE
    - AC-GA-REQUIREMENTS-RECOVERY
generated_contracts:
  status: source_derived_ready
  source_refs:
    - ai-harness/specs/38-guardrail-authoring/03-contracts/generation-map.yaml
  command_refs:
    - CMD-BUILD
    - CMD-CORE-TYPES
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
    - agent.requirements
    - guardrails.config-error-meta
    - runtime.serialized-error
  mapping_refs:
    - MAP-GA-ERROR
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
  CMD-CORE:
    command: npm --prefix ai-harness test --workspace @purista/harness
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-CORE-TYPES:
    command: "npm --prefix ai-harness run test:types --workspace @purista/harness"
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
      - ACC-REQUIREMENTS-SUCCESS
      - ACC-REQUIREMENTS-FAILURE
      - ACC-REQUIREMENTS-RECOVERY
    expected_proof: current digests and dependencies checked; dirty baseline preserved
  - id: STEP-CONTRACT
    kind: contract
    files:
      - ai-harness/packages/harness/src/harness/agent-requirements.ts
      - ai-harness/packages/harness/src/harness/defineHarness.ts
      - ai-harness/packages/harness/src/agents/index.ts
      - ai-harness/packages/harness/src/tools/index.ts
      - ai-harness/packages/harness/src/models/registry.ts
      - ai-harness/packages/harness/src/index.ts
      - ai-harness/packages/harness/test/build-validation.test.ts
      - ai-harness/packages/harness/test/agent-interceptors.test.ts
      - ai-harness/packages/harness/test/public-api.test.ts
      - ai-harness/packages/harness/type-tests/harness-typing.ts
    command_refs:
      - CMD-BUILD
      - CMD-CORE
      - CMD-CORE-TYPES
    acceptance_refs:
      - ACC-REQUIREMENTS-SUCCESS
      - ACC-REQUIREMENTS-FAILURE
      - ACC-REQUIREMENTS-RECOVERY
    expected_proof: approved source-derived shapes and required generated outputs established before behavior edits
  - id: STEP-TEST
    kind: test
    files:
      - ai-harness/packages/harness/test/build-validation.test.ts
      - ai-harness/packages/harness/test/agent-interceptors.test.ts
      - ai-harness/packages/harness/type-tests/harness-typing.ts
    command_refs:
      - CMD-BUILD
      - CMD-CORE
      - CMD-CORE-TYPES
    acceptance_refs:
      - ACC-REQUIREMENTS-SUCCESS
      - ACC-REQUIREMENTS-FAILURE
      - ACC-REQUIREMENTS-RECOVERY
    expected_proof: negative/happy cases demonstrate old failure then new acceptance
  - id: STEP-IMPLEMENT
    kind: implement
    files:
      - ai-harness/packages/harness/src/harness/agent-requirements.ts
      - ai-harness/packages/harness/src/harness/defineHarness.ts
      - ai-harness/packages/harness/src/agents/index.ts
      - ai-harness/packages/harness/src/tools/index.ts
      - ai-harness/packages/harness/src/models/registry.ts
      - ai-harness/packages/harness/src/index.ts
      - ai-harness/packages/harness/test/build-validation.test.ts
      - ai-harness/packages/harness/test/agent-interceptors.test.ts
      - ai-harness/packages/harness/test/public-api.test.ts
      - ai-harness/packages/harness/type-tests/harness-typing.ts
    command_refs:
      - CMD-BUILD
      - CMD-CORE
      - CMD-CORE-TYPES
    acceptance_refs:
      - ACC-REQUIREMENTS-SUCCESS
      - ACC-REQUIREMENTS-FAILURE
      - ACC-REQUIREMENTS-RECOVERY
    expected_proof: only approved behavior and mechanical consumer cut within scope
  - id: STEP-VERIFY
    kind: verify
    files:
      - ai-harness/packages/harness/src/harness/agent-requirements.ts
      - ai-harness/packages/harness/src/harness/defineHarness.ts
      - ai-harness/packages/harness/src/agents/index.ts
      - ai-harness/packages/harness/src/tools/index.ts
      - ai-harness/packages/harness/src/models/registry.ts
      - ai-harness/packages/harness/src/index.ts
      - ai-harness/packages/harness/test/build-validation.test.ts
      - ai-harness/packages/harness/test/agent-interceptors.test.ts
      - ai-harness/packages/harness/test/public-api.test.ts
      - ai-harness/packages/harness/type-tests/harness-typing.ts
    command_refs:
      - CMD-BUILD
      - CMD-CORE
      - CMD-CORE-TYPES
    acceptance_refs:
      - ACC-REQUIREMENTS-SUCCESS
      - ACC-REQUIREMENTS-FAILURE
      - ACC-REQUIREMENTS-RECOVERY
    expected_proof: exact commands pass with no threshold weakening or skipped assertions
  - id: STEP-HANDOFF
    kind: handoff
    files:
      - ai-harness/packages/harness/src/harness/agent-requirements.ts
      - ai-harness/packages/harness/src/harness/defineHarness.ts
      - ai-harness/packages/harness/src/agents/index.ts
      - ai-harness/packages/harness/src/tools/index.ts
      - ai-harness/packages/harness/src/models/registry.ts
      - ai-harness/packages/harness/src/index.ts
      - ai-harness/packages/harness/test/build-validation.test.ts
      - ai-harness/packages/harness/test/agent-interceptors.test.ts
      - ai-harness/packages/harness/test/public-api.test.ts
      - ai-harness/packages/harness/type-tests/harness-typing.ts
    command_refs:
      - CMD-BUILD
      - CMD-CORE
      - CMD-CORE-TYPES
    acceptance_refs:
      - ACC-REQUIREMENTS-SUCCESS
      - ACC-REQUIREMENTS-FAILURE
      - ACC-REQUIREMENTS-RECOVERY
    expected_proof: evidence recorded; request independent review, not self-acceptance
acceptance:
  - id: ACC-REQUIREMENTS-SUCCESS
    traceability_acceptance_ids:
      - AC-GA-REQUIREMENTS-SUCCESS
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-REQUIREMENTS
    test_refs:
      - ai-harness/packages/harness/test/build-validation.test.ts
      - ai-harness/packages/harness/test/agent-interceptors.test.ts
      - ai-harness/packages/harness/type-tests/harness-typing.ts
    command_refs:
      - CMD-BUILD
      - CMD-CORE
      - CMD-CORE-TYPES
    expected_outcome: Build validates declared model aliases/capabilities and agent-enabled configured tool IDs across direct, helper and static-module registrations.
    lifecycle: accepted
  - id: ACC-REQUIREMENTS-FAILURE
    traceability_acceptance_ids:
      - AC-GA-REQUIREMENTS-FAILURE
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-REQUIREMENTS
    test_refs:
      - ai-harness/packages/harness/test/build-validation.test.ts
      - ai-harness/packages/harness/test/agent-interceptors.test.ts
      - ai-harness/packages/harness/type-tests/harness-typing.ts
    command_refs:
      - CMD-BUILD
      - CMD-CORE
      - CMD-CORE-TYPES
    expected_outcome: Missing/disabled tool, missing alias, missing capability or malformed requirement fails before any callback/session/provider/MCP/sandbox work.
    lifecycle: accepted
  - id: ACC-REQUIREMENTS-RECOVERY
    traceability_acceptance_ids:
      - AC-GA-REQUIREMENTS-RECOVERY
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-REQUIREMENTS
    test_refs:
      - ai-harness/packages/harness/test/build-validation.test.ts
      - ai-harness/packages/harness/test/agent-interceptors.test.ts
      - ai-harness/packages/harness/type-tests/harness-typing.ts
    command_refs:
      - CMD-BUILD
      - CMD-CORE
      - CMD-CORE-TYPES
    expected_outcome: Models registered after agents succeed; builtin defaults/false use one resolver; dynamic turn narrowing still cannot expand permissions.
    lifecycle: accepted
---

## Goal

Provider-neutral interceptor build preflight through the existing public entrypoint, including negative and recovery behavior.

## Context Digest

Read the listed contracts and analysis. This ticket owns REQ-GA-REQUIREMENTS; previous tickets are dependencies, not permission to change their contracts. Source baseline is dirty. Voyage is excluded.

## Implementation Approach

- Create the strict requirements schema/derived type and optional interceptor field with public exports/TSDoc.
- Extend the existing build reference validator; share capability membership and builtin-name resolution with current runtime owners.
- Keep validation declarative and effect-free; preserve runtime capability enforcement and errors outside this new preflight.
- Add counted no-side-effect tests with existing fakes, default/disabled builtin and configured MCP alias cases.

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

REQ-GA-REQUIREMENTS → CAP-GA-REQUIREMENTS → SUCCESS/FAILURE/RECOVERY paths and AC IDs in frontmatter. No unowned acceptance remains.

## Contract Traceability

- ai-harness/specs/38-guardrail-authoring/03-contracts/actions-and-binding.md#CTR-GA-BINDING
- ai-harness/specs/38-guardrail-authoring/03-contracts/actions-and-binding.md#CTR-GA-ERRORS
- ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-REQUIREMENTS
- ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE

## Spec Drift Controls

Check both manifest digests before edits and handoff. A contract ambiguity or changed prerequisite blocks the ticket; write a finding under plan evidence, do not modify approved semantics. Only controller updates lifecycle/digests after review.

## Generator And Type Plan

Build first, derive TypeScript via Zod/indexed/generic aliases, and use existing declaration emit. Do not add copied option tables or duplicate validators.

## Test-First Order

Add type-negative/schema-negative cases first, then the success fixture, then recovery/mutation/no-effect assertions. Reuse existing fakes. If a behavior already passes, record that evidence rather than forcing an artificial failure.

## Modularity And Reuse Plan

Use file-structure/module/reuse inventory. One canonical type per meaning, one builtin resolver, one decision executor and one sensitive algorithm. New helpers are limited to approved cohesive modules. Do not reformat or reorganize unrelated files.

## Representation Reuse Plan

All shape and mapping IDs are enumerated in frontmatter; apply only those touched by this ticket. Config defaults, opaque action preparation and native registration marking are the only new mappings; existing spec37 evidence/output shapes are unchanged.

## Slice Strategy

One sequential, publicly testable authoring/preflight/documentation slice. The complete breaking release is held until TICKET-008 accepts all consumers; no partial release or temporary compatibility is allowed. Same-file contracts make parallel writes inappropriate.

## Tasks

1. Create the strict requirements schema/derived type and optional interceptor field with public exports/TSDoc.
2. Extend the existing build reference validator; share capability membership and builtin-name resolution with current runtime owners.
3. Keep validation declarative and effect-free; preserve runtime capability enforcement and errors outside this new preflight.
4. Add counted no-side-effect tests with existing fakes, default/disabled builtin and configured MCP alias cases.

## Acceptance

- Build validates declared model aliases/capabilities and agent-enabled configured tool IDs across direct, helper and static-module registrations.
- Missing/disabled tool, missing alias, missing capability or malformed requirement fails before any callback/session/provider/MCP/sandbox work.
- Models registered after agents succeed; builtin defaults/false use one resolver; dynamic turn narrowing still cannot expand permissions.

## Acceptance Test Matrix

| Path | Required assertion |
| --- | --- |
| success | Build validates declared model aliases/capabilities and agent-enabled configured tool IDs across direct, helper and static-module registrations. |
| failure | Missing/disabled tool, missing alias, missing capability or malformed requirement fails before any callback/session/provider/MCP/sandbox work. |
| recovery | Models registered after agents succeed; builtin defaults/false use one resolver; dynamic turn narrowing still cannot expand permissions. |


## Review And Verification Plan

Independent review must trace the public entrypoint to exact validation/side-effect behavior and inspect failure paths, not only green compile output. Verify generated artifact ownership, no raw-content errors and no duplicated public fields.

## End-To-End Definition Coverage

Actor, entrypoint, data, errors, recovery, permissions, observability, owner and final state are fixed in the linked requirement. Verify actual API use rather than an illustrative replacement. Docs use runnable source and checked projections.

## Operational Path Coverage

Preflight failures must precede requests and protected effects. Runtime deadlines/privacy remain spec37-owned. No new deployment service or persistence. Applicability N/A records cover infrastructure/migrations/Voyage/live systems.

## Verification

Working directory: workspace root /Users/sebastianwessel/projekte/@purista. Run these in order, without shell chaining:

- `CMD-BUILD`: `npm --prefix ai-harness run build`
- `CMD-CORE`: `npm --prefix ai-harness test --workspace @purista/harness`
- `CMD-CORE-TYPES`: `npm --prefix ai-harness run test:types --workspace @purista/harness`

A command introduced by this ticket is run only after its implementation. External systems/secrets are forbidden. If dependency artifacts are absent, stop for the normal installation approval instead of fetching implicitly.

## Non-goals

Voyage; provider/detector internals; unrelated sandbox/storage/evaluation work; broad arrow conversion; migration/compatibility paths; new dependencies; publishing or source reset.

## Handoff

Write ai-harness/plans/guardrail-authoring/evidence/TICKET-003.md with exact results, acceptance-ID mapping and residual blockers. Mark implemented, not accepted. Independent reviewer controls acceptance; controller updates all four indexes and manifests together.
