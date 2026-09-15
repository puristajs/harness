---
id: TICKET-008
title: Consumer cut, CI drift gates and final acceptance
wave: 8
lifecycle: accepted
spec_manifest_digest: "sha256:40c13572186ebc1f800a3742dab3b514a65bb924887e9c994921f457bd682b3f"
plan_manifest_digest: sha256:2a9ef84fc85798d2235d0bb1203403837fa90f56142d9730ab695bf2beb771c9
parallel_group: guardrail-authoring-sequential-8
depends_on:
  - TICKET-007
blocked_by: []
spec_refs:
  - ai-harness/specs/38-guardrail-authoring/04-delivery/consumers.md#CTR-GA-CLEANUP
  - ai-harness/specs/38-guardrail-authoring/03-contracts/configuration.md#CTR-GA-GENERATION
  - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CLEANUP
  - ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE
write_scope:
  - ai-harness/.github/workflows/ci.yml
  - ai-harness/package.json
  - ai-harness/scripts/check-decision-boundaries.mjs
  - ai-harness/scripts/check-decision-boundaries.test.mjs
  - ai-harness/scripts/verify-decision-consumers.mjs
  - ai-harness/scripts/verify-decision-consumers.test.mjs
  - ai-harness/docs/releases/guardrail-authoring.md
  - purista/packages/core
read_scope:
  - ai-harness/.github/workflows/ci.yml
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
  - ai-harness/scripts/check-decision-boundaries.mjs
  - ai-harness/scripts/check-decision-boundaries.test.mjs
  - ai-harness/scripts/verify-decision-consumers.mjs
  - ai-harness/scripts/verify-decision-consumers.test.mjs
  - ai-harness/docs/releases/guardrail-authoring.md
  - purista/packages/core
  - purista/examples
  - starter
  - create-purista
contract_readiness:
  status: ready
  required_contracts:
    - CTR-GA-CLEANUP
    - CTR-GA-GENERATION
  missing_contracts: []
traceability:
  requirement_ids:
    - REQ-GA-CLEANUP
  capability_ids:
    - CAP-GA-CLEANUP
  path_ids:
    - PATH-GA-CLEANUP-SUCCESS
    - PATH-GA-CLEANUP-FAILURE
    - PATH-GA-CLEANUP-RECOVERY
  acceptance_ids:
    - AC-GA-CLEANUP-SUCCESS
    - AC-GA-CLEANUP-FAILURE
    - AC-GA-CLEANUP-RECOVERY
generated_contracts:
  status: source_derived_ready
  source_refs:
    - ai-harness/specs/38-guardrail-authoring/03-contracts/configuration.md#CTR-GA-GENERATION
  command_refs:
    - CMD-BUILD
  drift_command_refs:
    - CMD-SPECS
    - CMD-PLAN
    - CMD-ARCH
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: vertical_slice
phase_gate_exception: false
representation_reuse:
  status: not_applicable
  scope_refs: [ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CLEANUP]
  rationale: Documentation or integration gate ticket consumes existing approved shapes and introduces no domain or boundary representation.
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
  CMD-CORE-BUILD:
    command: npm --prefix ai-harness run build --workspace @purista/harness
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-CONFIG:
    command: npm --prefix ai-harness test --workspace @purista/harness-guardrails
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-BUILD:
    command: npm --prefix ai-harness run build
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-LINT:
    command: npm --prefix ai-harness run lint
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-ALL-TESTS:
    command: npm --prefix ai-harness test
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-COVERAGE:
    command: "npm --prefix ai-harness run test:coverage"
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-TYPES:
    command: "npm --prefix ai-harness run test:types"
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
  CMD-CONTRACTS:
    command: "npm --prefix ai-harness run test:contracts"
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-FAILURE:
    command: "npm --prefix ai-harness run test:failure"
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-INTEGRATION:
    command: "npm --prefix ai-harness run test:integration"
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-ARCH:
    command: "npm --prefix ai-harness run verify:architecture"
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-CONSUMERS:
    command: node ai-harness/scripts/verify-decision-consumers.mjs
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-SCAN:
    command: rg -n -e defineGuardrails -e parseGuardrailsConfig -e loadGuardrailsConfig -e createSensitiveDataActions -e modelCheckRail -e '\.tools\x28' purista/examples starter create-purista --glob '*.{ts,tsx,md,json}' --glob '!**/node_modules/**' --glob '!**/dist/**'
    purpose: Require no matches and exit 1; exit 0 means new scope gap; exit 2 means scan error.
    expected: record_only
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-PACK:
    command: npm --prefix ai-harness pack --workspace @purista/harness-guardrails --dry-run --ignore-scripts
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-SKILLS:
    command: "npm --prefix purista run audit:skills"
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-KNOWLEDGE:
    command: "npm --prefix purista run audit:knowledge"
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
      - ACC-CLEANUP-SUCCESS
      - ACC-CLEANUP-FAILURE
      - ACC-CLEANUP-RECOVERY
    expected_proof: current digests and dependencies checked; dirty baseline preserved
  - id: STEP-CONTRACT
    kind: contract
    files:
      - ai-harness/package.json
      - ai-harness/scripts/check-decision-boundaries.mjs
      - ai-harness/scripts/check-decision-boundaries.test.mjs
      - ai-harness/scripts/verify-decision-consumers.mjs
      - ai-harness/scripts/verify-decision-consumers.test.mjs
      - ai-harness/docs/releases/guardrail-authoring.md
      - purista/packages/core
    command_refs:
      - CMD-CORE-BUILD
      - CMD-CONFIG
      - CMD-BUILD
      - CMD-LINT
      - CMD-ALL-TESTS
      - CMD-COVERAGE
      - CMD-TYPES
      - CMD-PREFLIGHT
      - CMD-CONTRACTS
      - CMD-FAILURE
      - CMD-INTEGRATION
      - CMD-ARCH
      - CMD-CONSUMERS
      - CMD-SCAN
      - CMD-PACK
      - CMD-SKILLS
      - CMD-KNOWLEDGE
    acceptance_refs:
      - ACC-CLEANUP-SUCCESS
      - ACC-CLEANUP-FAILURE
      - ACC-CLEANUP-RECOVERY
    expected_proof: canonical schema-derived TypeScript aliases are emitted by the normal build; no configuration-specific artifact or separate check is introduced
  - id: STEP-TEST
    kind: test
    files:
      - ai-harness/scripts/check-decision-boundaries.test.mjs
      - ai-harness/scripts/verify-decision-consumers.test.mjs
    command_refs:
      - CMD-CORE-BUILD
      - CMD-CONFIG
      - CMD-BUILD
      - CMD-LINT
      - CMD-ALL-TESTS
      - CMD-COVERAGE
      - CMD-TYPES
      - CMD-PREFLIGHT
      - CMD-CONTRACTS
      - CMD-FAILURE
      - CMD-INTEGRATION
      - CMD-ARCH
      - CMD-CONSUMERS
      - CMD-SCAN
      - CMD-PACK
      - CMD-SKILLS
      - CMD-KNOWLEDGE
    acceptance_refs:
      - ACC-CLEANUP-SUCCESS
      - ACC-CLEANUP-FAILURE
      - ACC-CLEANUP-RECOVERY
    expected_proof: negative/happy cases demonstrate old failure then new acceptance
  - id: STEP-IMPLEMENT
    kind: implement
    files:
      - ai-harness/package.json
      - ai-harness/scripts/check-decision-boundaries.mjs
      - ai-harness/scripts/check-decision-boundaries.test.mjs
      - ai-harness/scripts/verify-decision-consumers.mjs
      - ai-harness/scripts/verify-decision-consumers.test.mjs
      - ai-harness/docs/releases/guardrail-authoring.md
      - purista/packages/core
    command_refs:
      - CMD-CORE-BUILD
      - CMD-CONFIG
      - CMD-BUILD
      - CMD-LINT
      - CMD-ALL-TESTS
      - CMD-COVERAGE
      - CMD-TYPES
      - CMD-PREFLIGHT
      - CMD-CONTRACTS
      - CMD-FAILURE
      - CMD-INTEGRATION
      - CMD-ARCH
      - CMD-CONSUMERS
      - CMD-SCAN
      - CMD-PACK
      - CMD-SKILLS
      - CMD-KNOWLEDGE
    acceptance_refs:
      - ACC-CLEANUP-SUCCESS
      - ACC-CLEANUP-FAILURE
      - ACC-CLEANUP-RECOVERY
    expected_proof: only approved behavior and mechanical consumer cut within scope
  - id: STEP-VERIFY
    kind: verify
    files:
      - ai-harness/package.json
      - ai-harness/scripts/check-decision-boundaries.mjs
      - ai-harness/scripts/check-decision-boundaries.test.mjs
      - ai-harness/scripts/verify-decision-consumers.mjs
      - ai-harness/scripts/verify-decision-consumers.test.mjs
      - ai-harness/docs/releases/guardrail-authoring.md
      - purista/packages/core
    command_refs:
      - CMD-CORE-BUILD
      - CMD-CONFIG
      - CMD-BUILD
      - CMD-LINT
      - CMD-ALL-TESTS
      - CMD-COVERAGE
      - CMD-TYPES
      - CMD-PREFLIGHT
      - CMD-CONTRACTS
      - CMD-FAILURE
      - CMD-INTEGRATION
      - CMD-ARCH
      - CMD-CONSUMERS
      - CMD-SCAN
      - CMD-PACK
      - CMD-SKILLS
      - CMD-KNOWLEDGE
    acceptance_refs:
      - ACC-CLEANUP-SUCCESS
      - ACC-CLEANUP-FAILURE
      - ACC-CLEANUP-RECOVERY
    expected_proof: exact commands pass with no threshold weakening or skipped assertions
  - id: STEP-HANDOFF
    kind: handoff
    files:
      - ai-harness/package.json
      - ai-harness/scripts/check-decision-boundaries.mjs
      - ai-harness/scripts/check-decision-boundaries.test.mjs
      - ai-harness/scripts/verify-decision-consumers.mjs
      - ai-harness/scripts/verify-decision-consumers.test.mjs
      - ai-harness/docs/releases/guardrail-authoring.md
      - purista/packages/core
    command_refs:
      - CMD-CORE-BUILD
      - CMD-CONFIG
      - CMD-BUILD
      - CMD-LINT
      - CMD-ALL-TESTS
      - CMD-COVERAGE
      - CMD-TYPES
      - CMD-PREFLIGHT
      - CMD-CONTRACTS
      - CMD-FAILURE
      - CMD-INTEGRATION
      - CMD-ARCH
      - CMD-CONSUMERS
      - CMD-SCAN
      - CMD-PACK
      - CMD-SKILLS
      - CMD-KNOWLEDGE
    acceptance_refs:
      - ACC-CLEANUP-SUCCESS
      - ACC-CLEANUP-FAILURE
      - ACC-CLEANUP-RECOVERY
    expected_proof: evidence recorded; request independent review, not self-acceptance
acceptance:
  - id: ACC-CLEANUP-SUCCESS
    traceability_acceptance_ids:
      - AC-GA-CLEANUP-SUCCESS
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CLEANUP
    test_refs:
      - ai-harness/scripts/check-decision-boundaries.test.mjs
      - ai-harness/scripts/verify-decision-consumers.test.mjs
    command_refs:
      - CMD-CORE-BUILD
      - CMD-CONFIG
      - CMD-BUILD
      - CMD-LINT
      - CMD-ALL-TESTS
      - CMD-COVERAGE
      - CMD-TYPES
      - CMD-PREFLIGHT
      - CMD-CONTRACTS
      - CMD-FAILURE
      - CMD-INTEGRATION
      - CMD-ARCH
      - CMD-CONSUMERS
      - CMD-SCAN
      - CMD-PACK
      - CMD-SKILLS
      - CMD-KNOWLEDGE
    expected_outcome: Fresh TypeScript declarations, real PURISTA consumers, both type suites and all hermetic regression gates pass without reduced thresholds.
    lifecycle: accepted
  - id: ACC-CLEANUP-FAILURE
    traceability_acceptance_ids:
      - AC-GA-CLEANUP-FAILURE
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CLEANUP
    test_refs:
      - ai-harness/scripts/check-decision-boundaries.test.mjs
      - ai-harness/scripts/verify-decision-consumers.test.mjs
    command_refs:
      - CMD-CORE-BUILD
      - CMD-CONFIG
      - CMD-BUILD
      - CMD-LINT
      - CMD-ALL-TESTS
      - CMD-COVERAGE
      - CMD-TYPES
      - CMD-PREFLIGHT
      - CMD-CONTRACTS
      - CMD-FAILURE
      - CMD-INTEGRATION
      - CMD-ARCH
      - CMD-CONSUMERS
      - CMD-SCAN
      - CMD-PACK
      - CMD-SKILLS
      - CMD-KNOWLEDGE
    expected_outcome: Architecture/CI checks reject removed aliases, raw actions, duplicate shapes, and retired configuration files, dependencies, artifacts, commands, or APIs; they also fail on incomplete consumer alignment.
    lifecycle: accepted
  - id: ACC-CLEANUP-RECOVERY
    traceability_acceptance_ids:
      - AC-GA-CLEANUP-RECOVERY
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CLEANUP
    test_refs:
      - ai-harness/scripts/check-decision-boundaries.test.mjs
      - ai-harness/scripts/verify-decision-consumers.test.mjs
    command_refs:
      - CMD-CORE-BUILD
      - CMD-CONFIG
      - CMD-BUILD
      - CMD-LINT
      - CMD-ALL-TESTS
      - CMD-COVERAGE
      - CMD-TYPES
      - CMD-PREFLIGHT
      - CMD-CONTRACTS
      - CMD-FAILURE
      - CMD-INTEGRATION
      - CMD-ARCH
      - CMD-CONSUMERS
      - CMD-SCAN
      - CMD-PACK
      - CMD-SKILLS
      - CMD-KNOWLEDGE
    expected_outcome: Example/starter/scaffolder zero-match scan is recorded; no Voyage access, migration/compatibility layer, source reset, unapproved install or publish occurs.
    lifecycle: accepted
---

## Goal

Consumer cut, CI drift gates and final acceptance through the existing public entrypoint, including negative and recovery behavior.

## Context Digest

Read the listed contracts and analysis. This ticket owns REQ-GA-CLEANUP; previous tickets are dependencies, not permission to change their contracts. Source baseline is dirty. Voyage is excluded.

## Implementation Approach

- Retain exact Core source-overlay/runtime and strict dist smoke checks; inspect starter/scaffolder for the approved zero-match baseline; a new match blocks for a scoped ticket update.
- Wire both type suites, the inline-only clean-break gate, and application preflight into existing CI; extend existing architecture checks instead of creating a new audit framework.
- Run package dry-run and full hermetic regression matrix; reconcile removed exports/snippets, current package contents, and release note.
- Record exact commands/results and independent final review; do not mark accepted based on only unit/type checks.

## Decision Ledger

Execute the referenced DEC-GA decisions mechanically. D1 is limited to private extraction/naming under CONV-GA-STYLE. No public design, compatibility, dependency, validation-stage or UX choice is delegated.

## Action Plan

1. Preflight: read scoped authority and dependencies; run CMD-SPECS, CMD-PLAN, CMD-STATUS. Record existing dirty files and actual command baseline; never reset.
2. Build fresh TypeScript declarations from the cited canonical schema-derived types before consumers. No handwritten field mirrors or configuration-specific artifacts.
3. Extend the listed natural tests with all three acceptance rows; record expected pre-change failures or baseline evidence.
4. Implement the numbered changes under Implementation Approach in order, including mechanical affected consumers. Do not add temporary compatibility behavior.
5. Run the exact Verification commands in listed order; investigate failures only within scope, otherwise record blocker.
6. Record changed files, test cases, red/green evidence and limitations in the ticket evidence file; move to implemented and request independent review.

## Requirements Traceability

REQ-GA-CLEANUP → CAP-GA-CLEANUP → SUCCESS/FAILURE/RECOVERY paths and AC IDs in frontmatter. No unowned acceptance remains.

## Contract Traceability

- ai-harness/specs/38-guardrail-authoring/04-delivery/consumers.md#CTR-GA-CLEANUP
- ai-harness/specs/38-guardrail-authoring/03-contracts/configuration.md#CTR-GA-GENERATION
- ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-CLEANUP
- ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE

## Spec Drift Controls

Check both manifest digests before edits and handoff. A contract ambiguity or changed prerequisite blocks the ticket; write a finding under plan evidence, do not modify approved semantics. Only controller updates lifecycle/digests after review.

## Generator And Type Plan

Build first, derive TypeScript via Zod/indexed/generic aliases, and use the existing declaration emit. Do not add copied option tables, duplicate validators, or configuration-specific artifacts.

## Test-First Order

Add type-negative/schema-negative cases first, then the success fixture, then recovery/mutation/no-effect assertions. Reuse existing fakes. If a behavior already passes, record that evidence rather than forcing an artificial failure.

## Modularity And Reuse Plan

Use file-structure/module/reuse inventory. One canonical type per meaning, one builtin resolver, one decision executor and one sensitive algorithm. New helpers are limited to approved cohesive modules. Do not reformat or reorganize unrelated files.

## Representation Reuse Plan

All shape and mapping IDs are enumerated in frontmatter; apply only those touched by this ticket. Config defaults, opaque action preparation and native registration marking are the only new mappings; existing spec37 evidence/output shapes are unchanged.

## Slice Strategy

One sequential, publicly testable authoring/preflight/documentation slice. The complete breaking release is held until TICKET-008 accepts all consumers; no partial release or temporary compatibility is allowed. Same-file contracts make parallel writes inappropriate.

## Tasks

1. Retain exact Core source-overlay/runtime and strict dist smoke checks; inspect starter/scaffolder for the approved zero-match baseline; a new match blocks for a scoped ticket update.
2. Wire both type suites, the inline-only clean-break gate, and application preflight into existing CI; extend existing architecture checks instead of creating a new audit framework.
3. Run package dry-run and full hermetic regression matrix; reconcile removed exports/snippets, current package contents, and release note.
4. Record exact commands/results and independent final review; do not mark accepted based on only unit/type checks.

## Acceptance

- Fresh TypeScript declarations, real PURISTA consumers, both type suites and all hermetic regression gates pass without reduced thresholds.
- Architecture/CI checks reject removed aliases, raw actions, duplicate shapes, and retired configuration files, dependencies, artifacts, commands, or APIs; they also fail on incomplete consumer alignment.
- Example/starter/scaffolder zero-match scan is recorded; no Voyage access, migration/compatibility layer, source reset, unapproved install or publish occurs.

## Acceptance Test Matrix

| Path | Required assertion |
| --- | --- |
| success | Fresh TypeScript declarations, real PURISTA consumers, both type suites and all hermetic regression gates pass without reduced thresholds. |
| failure | Architecture/CI checks reject removed aliases, raw actions, duplicate shapes, and retired configuration files, dependencies, artifacts, commands, or APIs; they also fail on incomplete consumer alignment. |
| recovery | Example/starter/scaffolder zero-match scan is recorded; no Voyage access, migration/compatibility layer, source reset, unapproved install or publish occurs. |


## Review And Verification Plan

Independent review must trace the public entrypoint to exact validation/side-effect behavior and inspect failure paths, not only green compile output. Verify normal TypeScript declaration emit, the clean-break rejection of retired configuration artifacts, no raw-content errors, and no duplicated public fields.

## End-To-End Definition Coverage

Actor, entrypoint, data, errors, recovery, permissions, observability, owner and final state are fixed in the linked requirement. Verify actual API use rather than an illustrative replacement. Docs use runnable source and checked projections.

## Operational Path Coverage

Preflight failures must precede requests and protected effects. Runtime deadlines/privacy remain spec37-owned. No new deployment service or persistence. Applicability N/A records cover infrastructure/migrations/Voyage/live systems.

## Verification

Working directory: workspace root /Users/sebastianwessel/projekte/@purista. Run these in order, without shell chaining:

- `CMD-CORE-BUILD`: `npm --prefix ai-harness run build --workspace @purista/harness`
- `CMD-CONFIG`: `npm --prefix ai-harness test --workspace @purista/harness-guardrails`
- `CMD-BUILD`: `npm --prefix ai-harness run build`
- `CMD-LINT`: `npm --prefix ai-harness run lint`
- `CMD-ALL-TESTS`: `npm --prefix ai-harness test`
- `CMD-COVERAGE`: `npm --prefix ai-harness run test:coverage`
- `CMD-TYPES`: `npm --prefix ai-harness run test:types`
- `CMD-PREFLIGHT`: `npm --prefix ai-harness test --workspace @purista/guardrails-example`
- `CMD-CONTRACTS`: `npm --prefix ai-harness run test:contracts`
- `CMD-FAILURE`: `npm --prefix ai-harness run test:failure`
- `CMD-INTEGRATION`: `npm --prefix ai-harness run test:integration`
- `CMD-ARCH`: `npm --prefix ai-harness run verify:architecture`
- `CMD-CONSUMERS`: `node ai-harness/scripts/verify-decision-consumers.mjs`
- `CMD-SCAN`: `rg -n -e defineGuardrails -e parseGuardrailsConfig -e loadGuardrailsConfig -e createSensitiveDataActions -e modelCheckRail -e '\.tools\x28' purista/examples starter create-purista --glob '*.{ts,tsx,md,json}' --glob '!**/node_modules/**' --glob '!**/dist/**'`
- `CMD-PACK`: `npm --prefix ai-harness pack --workspace @purista/harness-guardrails --dry-run --ignore-scripts`
- `CMD-SKILLS`: `npm --prefix purista run audit:skills`
- `CMD-KNOWLEDGE`: `npm --prefix purista run audit:knowledge`

A command introduced by this ticket is run only after its implementation. External systems/secrets are forbidden. If dependency artifacts are absent, stop for the normal installation approval instead of fetching implicitly.

## Non-goals

Voyage; provider/detector internals; unrelated sandbox/storage/evaluation work; broad arrow conversion; migration/compatibility paths; new dependencies; publishing or source reset.

## Handoff

Write ai-harness/plans/guardrail-authoring/evidence/TICKET-008.md with exact results, acceptance-ID mapping and residual blockers. Mark implemented, not accepted. Independent reviewer controls acceptance; controller updates all four indexes and manifests together.
