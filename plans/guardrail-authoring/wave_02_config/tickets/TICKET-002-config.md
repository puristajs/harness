---
id: TICKET-002
title: Inline configuration clean cut and file-surface removal
wave: 2
lifecycle: accepted
spec_manifest_digest: sha256:40c13572186ebc1f800a3742dab3b514a65bb924887e9c994921f457bd682b3f
plan_manifest_digest: sha256:2a9ef84fc85798d2235d0bb1203403837fa90f56142d9730ab695bf2beb771c9
parallel_group: guardrail-authoring-sequential-2
depends_on:
  - TICKET-001
blocked_by: []
spec_refs:
  - ai-harness/specs/38-guardrail-authoring/03-contracts/configuration.md#CTR-GA-CONFIG
  - ai-harness/specs/38-guardrail-authoring/03-contracts/configuration.md#CTR-GA-GENERATION
  - ai-harness/specs/38-guardrail-authoring/03-contracts/actions-and-binding.md#CTR-GA-ERRORS
  - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CONFIG
  - ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE
write_scope:
  - ai-harness/packages/harness-guardrails
  - ai-harness/examples/guardrails
  - ai-harness/scripts/generate-guardrails-config.mjs
  - ai-harness/docs/reference/guardrails-config.generated.md
  - ai-harness/package-lock.json
read_scope:
  - ai-harness/specs/38-guardrail-authoring
  - ai-harness/plans/guardrail-authoring/analysis.md
  - ai-harness/AGENTS.md
  - ai-harness/.agent/IMPLEMENTATION.md
  - ai-harness/specs/37-decision-boundaries
  - ai-harness/specs/16-testing.md
  - ai-harness/package.json
  - ai-harness/package-lock.json
contract_readiness:
  status: ready
  required_contracts:
    - CTR-GA-CONFIG
    - CTR-GA-GENERATION
    - CTR-GA-ERRORS
  missing_contracts: []
traceability:
  requirement_ids:
    - REQ-GA-CONFIG
  capability_ids:
    - CAP-GA-CONFIG
  path_ids:
    - PATH-GA-CONFIG-SUCCESS
    - PATH-GA-CONFIG-FAILURE
    - PATH-GA-CONFIG-RECOVERY
  acceptance_ids:
    - AC-GA-CONFIG-SUCCESS
    - AC-GA-CONFIG-FAILURE
    - AC-GA-CONFIG-RECOVERY
generated_contracts:
  status: source_derived_ready
  source_refs:
    - ai-harness/specs/38-guardrail-authoring/03-contracts/generation-map.yaml
  command_refs:
    - CMD-BUILD
  drift_command_refs:
    - CMD-SPECS
    - CMD-PLAN
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: refactor_exception
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/38-guardrail-authoring/03-contracts/representation-catalog.yaml
  shape_refs:
    - guardrails.config-input
    - guardrails.config
    - guardrails.config-error-meta
  mapping_refs:
    - MAP-GA-DEFAULTS
    - MAP-GA-ERROR
  new_shape_decision: none; this ticket only removes alternate configuration surfaces
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
  CMD-BUILD:
    command: npm --prefix ai-harness run build
    purpose: required verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-ADDON:
    command: npm --prefix ai-harness test --workspace @purista/harness-guardrails
    purpose: required verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-TYPES:
    command: npm --prefix ai-harness run test:types --workspace @purista/harness-guardrails
    purpose: required verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files:
      - ai-harness/specs/38-guardrail-authoring
    command_refs:
      - CMD-SPECS
      - CMD-PLAN
    acceptance_refs:
      - ACC-CONFIG-SUCCESS
      - ACC-CONFIG-FAILURE
      - ACC-CONFIG-RECOVERY
    expected_proof: contracts and dirty baseline recorded
  - id: STEP-CONTRACT
    kind: contract
    files:
      - ai-harness/packages/harness-guardrails
    command_refs:
      - CMD-BUILD
    acceptance_refs:
      - ACC-CONFIG-SUCCESS
      - ACC-CONFIG-FAILURE
      - ACC-CONFIG-RECOVERY
    expected_proof: one Zod schema owns the inline surface
  - id: STEP-TEST
    kind: test
    files:
      - ai-harness/packages/harness-guardrails
    command_refs:
      - CMD-ADDON
      - CMD-TYPES
    acceptance_refs:
      - ACC-CONFIG-SUCCESS
      - ACC-CONFIG-FAILURE
      - ACC-CONFIG-RECOVERY
    expected_proof: inline behavior and removal regressions are covered
  - id: STEP-IMPLEMENT
    kind: implement
    files:
      - ai-harness/packages/harness-guardrails
      - ai-harness/examples/guardrails
      - ai-harness/scripts/generate-guardrails-config.mjs
      - ai-harness/docs/reference/guardrails-config.generated.md
      - ai-harness/package-lock.json
    command_refs: []
    acceptance_refs:
      - ACC-CONFIG-SUCCESS
      - ACC-CONFIG-FAILURE
      - ACC-CONFIG-RECOVERY
    expected_proof: file configuration code, dependency, artifacts, scripts, example validation and public exports are deleted
  - id: STEP-VERIFY
    kind: verify
    files:
      - ai-harness/packages/harness-guardrails
      - ai-harness/examples/guardrails
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
      - CMD-TYPES
    acceptance_refs:
      - ACC-CONFIG-SUCCESS
      - ACC-CONFIG-FAILURE
      - ACC-CONFIG-RECOVERY
    expected_proof: checks pass without reduced thresholds
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: []
    acceptance_refs:
      - ACC-CONFIG-SUCCESS
      - ACC-CONFIG-FAILURE
      - ACC-CONFIG-RECOVERY
    expected_proof: superseded prior slice is recorded and independent review requested
acceptance:
  - id: ACC-CONFIG-SUCCESS
    traceability_acceptance_ids:
      - AC-GA-CONFIG-SUCCESS
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CONFIG
    test_refs:
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
    expected_outcome: inline configuration is the only runtime and public authoring surface
    lifecycle: accepted
  - id: ACC-CONFIG-FAILURE
    traceability_acceptance_ids:
      - AC-GA-CONFIG-FAILURE
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CONFIG
    test_refs:
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
    command_refs:
      - CMD-ADDON
    expected_outcome: malformed inline data and removed public names fail safely
    lifecycle: accepted
  - id: ACC-CONFIG-RECOVERY
    traceability_acceptance_ids:
      - AC-GA-CONFIG-RECOVERY
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CONFIG
    test_refs:
      - ai-harness/packages/harness-guardrails/test/guardrails.test.ts
    command_refs:
      - CMD-BUILD
      - CMD-ADDON
    expected_outcome: corrected inline declarations rebuild and deleted surfaces remain absent
    lifecycle: accepted
---

## Goal

Supersede the prior accepted configuration slice with the user-approved
inline-only clean break.

## Context Digest

TICKET-001 remains accepted. The prior TICKET-002 implementation and evidence
are superseded because they introduced an alternate configuration surface that is
now prohibited. Preserve unrelated dirty work. Voyage is excluded.

## Implementation Approach

Keep the canonical Zod schema and derived TypeScript types. Remove every
configuration-file loader/parser/export, yaml dependency and lockfile entry,
generated schema/reference artifact, generator/check script, example file and
example validation command. Keep no compatibility wrapper or legacy name.

## Decision Ledger

Execute DEC-GA-CONFIG, DEC-GA-GENERATION and DEC-GA-CLEAN mechanically.

## Action Plan

Record supersession, add removal regressions, delete the alternate surface,
verify the inline path, and request independent review.

## Requirements Traceability

REQ-GA-CONFIG → CAP-GA-CONFIG → all three configuration paths and AC IDs.

## Contract Traceability

CTR-GA-CONFIG, CTR-GA-GENERATION and CTR-GA-ERRORS are the sole authority.

## Spec Drift Controls

Check both manifests before edits and handoff. A changed prerequisite blocks the
ticket; do not substitute another configuration format.

## Generator And Type Plan

Zod derives runtime validation and exported input/output types. Declaration emit
is the only projection. No configuration artifact or generator remains.

## Test-First Order

Add negative import/removal checks and inline validation cases first, then remove
the obsolete files/dependency/scripts, then run the focused suite.

## Modularity And Reuse Plan

Reuse the existing Zod schema, core JSON validator, action compiler and natural
addon tests. Do not add replacement modules.

## Representation Reuse Plan

Existing config input/output and defaults mapping remain canonical. This ticket
adds no shape.

## Slice Strategy

One sequential breaking clean-cut slice. No partial release or compatibility is
allowed.

## Tasks

1. Delete alternate configuration authoring and every export.
2. Remove dependency, lockfile entry, artifacts, scripts and example hooks.
3. Update tests and direct consumers to inline configuration only.
4. Prove no removed name or artifact remains.

## Acceptance

- Inline configuration is the only runtime and public authoring surface.
- Invalid inline values fail with stable, content-free errors.
- Corrected inline declarations rebuild with no stale artifact or legacy path.

## Acceptance Test Matrix

| Path | Required assertion |
| --- | --- |
| success | Inline policy normalizes and compiles. |
| failure | Invalid values and removed public names fail. |
| recovery | Corrected policy rebuilds; removed surfaces stay absent. |

## End-To-End Definition Coverage

The linked requirement fixes actor, entrypoint, data, errors, recovery,
permissions, observability, owner and final state.

## Operational Path Coverage

Build preflight is composition plus build only. It reads no configuration file
and makes no external request.

## Review And Verification Plan

Independent review traces public exports, package contents, scripts, docs
references and the lockfile; green tests alone are insufficient.

## Verification

Run CMD-BUILD, CMD-ADDON and CMD-TYPES after implementation. No install,
network, credentials or publish is authorized.

## Non-goals

Voyage; provider/detector internals; replacement external format; migrations,
compatibility paths, publishing or source reset.

## Handoff

Write evidence/TICKET-002.md explaining that this ticket superseded its prior
accepted implementation, list deleted names/files, record exact checks, mark
implemented and request independent review.
