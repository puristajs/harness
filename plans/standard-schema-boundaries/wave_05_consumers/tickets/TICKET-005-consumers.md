---
id: TICKET-005
title: Harness and PURISTA documentation skill and website alignment
wave: 5
lifecycle: accepted
spec_manifest_digest: sha256:d675819593a8c7712cf7f4ccb6f4a78db08f2cefa325c36ec527e80a166d6498
plan_manifest_digest: sha256:497ac211ca9d25b29bf200d9de6512a73e5e8b190c065ce8a7f73140e78cb1e6
parallel_group: standard-schema-sequential-5
depends_on: [TICKET-004]
blocked_by: []
spec_refs: [ai-harness/specs/39-standard-schema-boundaries/04-delivery/consumers.md#CTR-SS-CONSUMERS, ai-harness/specs/39-standard-schema-boundaries/03-contracts/schema-types.md#CTR-SS-BUILDERS, ai-harness/specs/39-standard-schema-boundaries/03-contracts/model-projection.md#CTR-SS-PROJECTION]
traceability:
  requirement_ids: [REQ-SS-CONSUMERS]
  capability_ids: [CAP-SS-CONSUMERS]
  path_ids: [PATH-SS-CONSUMERS-SUCCESS, PATH-SS-CONSUMERS-FAILURE, PATH-SS-CONSUMERS-RECOVERY]
  acceptance_ids: [AC-SS-CONSUMERS-SUCCESS, AC-SS-CONSUMERS-FAILURE, AC-SS-CONSUMERS-RECOVERY]
write_scope: [ai-harness/README.md, ai-harness/docs, ai-harness/examples, ai-harness/packages/harness/README.md, ai-harness/packages/harness-guardrails/README.md, ai-harness/skills/ai-harness, purista/web, purista/skills]
read_scope: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, purista/AGENTS.md, purista/packages/core/src/schema/standardSchema.ts, specs/50-handbook/00-information-architecture.md, specs/50-handbook/01-framework-task-flow.md, plans/handbook-refactor/storyline-refactor-plan.md, plans/handbook-refactor/harness-storyline-refactor-plan.md]
contract_readiness:
  status: ready
  required_contracts: [CTR-SS-CONSUMERS, CTR-SS-BUILDERS, CTR-SS-PROJECTION]
  missing_contracts: []
generated_contracts:
  status: source_derived_ready
  source_refs: [ai-harness/specs/39-standard-schema-boundaries/03-contracts/generation-map.yaml]
  command_refs: [CMD-HARNESS-BUILD, CMD-SKILL-SYNC, CMD-WEB]
  drift_command_refs: [CMD-SPECS, CMD-PLAN, CMD-SKILLS, CMD-KNOWLEDGE]
ticket_readiness:
  status: implementation_ready
  open_decisions: []
  ambiguous_phrases: []
slice_type: vertical_slice
phase_gate_exception: false
representation_reuse:
  status: ready
  catalog_ref: ai-harness/specs/39-standard-schema-boundaries/03-contracts/representation-catalog.yaml
  shape_refs: [schema.user, model.json-schema]
  mapping_refs: [MAP-SS-PROJECT]
  new_shape_decision: Existing guide routes, examples, Markdown projection and skill trees are reused; no new documentation hierarchy.
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
  CMD-HARNESS-BUILD:
    command: npm --prefix ai-harness run build
    purpose: compile all examples and package docs references
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-SKILL-SYNC:
    command: npm --prefix ai-harness run skills:sync
    purpose: regenerate existing Harness skill mirrors
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-SKILLS:
    command: npm --prefix purista run audit:skills
    purpose: verify canonical PURISTA skills and mirrors
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-KNOWLEDGE:
    command: npm --prefix purista run audit:knowledge
    purpose: verify website knowledge alignment
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
  CMD-WEB:
    command: npm --prefix purista run build --workspace @purista/web
    purpose: build public website and handbook
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-LINKS:
    command: npm --prefix purista run audit:internal-links --workspace @purista/web
    purpose: verify public route links
    expected: pass
    network: forbidden
    writes: read_only
    secrets: forbidden
action_steps:
  - id: STEP-PREFLIGHT
    kind: preflight
    files: [ai-harness/specs/39-standard-schema-boundaries, ai-harness/plans/standard-schema-boundaries, ai-harness/AGENTS.md, ai-harness/.agent/IMPLEMENTATION.md, purista/AGENTS.md, specs/50-handbook/00-information-architecture.md, specs/50-handbook/01-framework-task-flow.md, plans/handbook-refactor/storyline-refactor-plan.md, plans/handbook-refactor/harness-storyline-refactor-plan.md]
    command_refs: [CMD-SPECS, CMD-PLAN, CMD-STATUS]
    acceptance_refs: [ACC-CONSUMERS-SUCCESS, ACC-CONSUMERS-FAILURE, ACC-CONSUMERS-RECOVERY]
    expected_proof: Provider/core tickets are accepted and handbook/skill ownership guidance is loaded.
  - id: STEP-CONTRACT
    kind: contract
    files: [ai-harness/README.md, ai-harness/docs, ai-harness/packages/harness/README.md, ai-harness/packages/harness-guardrails/README.md, ai-harness/skills/ai-harness, purista/web, purista/skills]
    command_refs: [CMD-HARNESS-BUILD]
    acceptance_refs: [ACC-CONSUMERS-SUCCESS, ACC-CONSUMERS-FAILURE, ACC-CONSUMERS-RECOVERY]
    expected_proof: Every canonical surface states the exact boundary matrix and default-vs-compatible distinction.
  - id: STEP-TEST
    kind: test
    files: [ai-harness/examples, ai-harness/skills/ai-harness, purista/web, purista/skills]
    command_refs: [CMD-HARNESS-BUILD, CMD-SKILLS, CMD-KNOWLEDGE, CMD-WEB, CMD-LINKS]
    acceptance_refs: [ACC-CONSUMERS-SUCCESS, ACC-CONSUMERS-FAILURE, ACC-CONSUMERS-RECOVERY]
    expected_proof: Zod, ArkType and Valibot snippets compile; stale terminology/link/mirror checks fail before correction.
  - id: STEP-IMPLEMENT
    kind: implement
    files: [ai-harness/README.md, ai-harness/docs, ai-harness/examples, ai-harness/packages/harness/README.md, ai-harness/packages/harness-guardrails/README.md, ai-harness/skills/ai-harness, purista/web, purista/skills]
    command_refs: []
    acceptance_refs: [ACC-CONSUMERS-SUCCESS, ACC-CONSUMERS-FAILURE, ACC-CONSUMERS-RECOVERY]
    expected_proof: Existing canonical sources and projections are updated without new routes, migration guides or Voyage changes.
  - id: STEP-VERIFY
    kind: verify
    files: [ai-harness/docs, ai-harness/examples, ai-harness/skills/ai-harness, purista/web, purista/skills]
    command_refs: [CMD-HARNESS-BUILD, CMD-SKILL-SYNC, CMD-SKILLS, CMD-KNOWLEDGE, CMD-WEB, CMD-LINKS]
    acceptance_refs: [ACC-CONSUMERS-SUCCESS, ACC-CONSUMERS-FAILURE, ACC-CONSUMERS-RECOVERY]
    expected_proof: Canonical regeneration is clean and every public surface builds/audits with executable snippets.
  - id: STEP-HANDOFF
    kind: handoff
    files: []
    command_refs: []
    acceptance_refs: [ACC-CONSUMERS-SUCCESS, ACC-CONSUMERS-FAILURE, ACC-CONSUMERS-RECOVERY]
    expected_proof: Evidence lists changed routes, snippets, generated mirrors and all audit outputs.
acceptance:
  - id: ACC-CONSUMERS-SUCCESS
    traceability_acceptance_ids: [AC-SS-CONSUMERS-SUCCESS]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/04-delivery/consumers.md#CTR-SS-CONSUMERS]
    test_refs: [ai-harness/examples, ai-harness/skills/ai-harness, purista/web, purista/skills]
    command_refs: [CMD-HARNESS-BUILD, CMD-WEB, CMD-SKILLS]
    expected_outcome: All public surfaces teach and compile the same three-vendor boundary contract.
    lifecycle: planned
  - id: ACC-CONSUMERS-FAILURE
    traceability_acceptance_ids: [AC-SS-CONSUMERS-FAILURE]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/04-delivery/consumers.md#CTR-SS-CONSUMERS]
    test_refs: [ai-harness/skills/ai-harness, purista/scripts/knowledge-audit.mjs]
    command_refs: [CMD-KNOWLEDGE, CMD-LINKS]
    expected_outcome: Stale Zod-only wording, incorrect projection claims, bad snippets, links or mirrors fail gates.
    lifecycle: planned
  - id: ACC-CONSUMERS-RECOVERY
    traceability_acceptance_ids: [AC-SS-CONSUMERS-RECOVERY]
    requirement_refs: [ai-harness/specs/39-standard-schema-boundaries/03-flows/e2e-coverage.md#PATH-SS-CONSUMERS-RECOVERY]
    test_refs: [ai-harness/scripts/sync-ai-harness-skill.mjs, purista/scripts/skills-audit.mjs]
    command_refs: [CMD-SKILL-SYNC, CMD-SKILLS, CMD-KNOWLEDGE]
    expected_outcome: Correcting canonical content then regenerating mirrors restores every audit without mirror-only patches.
    lifecycle: planned
---

## Goal
Align Harness and PURISTA public knowledge with the implemented Standard Schema contract.
## Context Digest
Core/provider behavior is accepted; repository handbook and skill governance is mandatory.
## Implementation Approach
Inventory stale content, update canonical sources/examples, regenerate mirrors, then build/audit every consumer.
## Decision Ledger
DEC-SS-CONSUMERS and DEC-SS-CLEAN fix wording, scope and no-migration policy.
## Action Plan
Read handbook guidance before edits; canonical source changes precede generation.
## Requirements Traceability
Owns REQ-SS-CONSUMERS and three paths.
## Contract Traceability
Implements CTR-SS-CONSUMERS and reflects builder/projection contracts without redefining them.
## Spec Drift Controls
Specs are linked, not copied as a second internal design source; audits detect drift.
## Generator And Type Plan
Compile snippets against package types and run existing skill sync only.
## Test-First Order
Add or identify snippet/audit failures before correcting prose and mirrors.
## Modularity And Reuse Plan
Reuse existing docs routes, handbook hierarchy, examples, skill packages and website components.
## Representation Reuse Plan
Document existing Schema/ModelSchema and JSON projection shapes; invent no UI/data representation.
## Slice Strategy
One consumer slice prevents Harness docs and PURISTA website/skills from diverging.
## Tasks
Update docs/readmes/examples/skills/site, generate mirrors, audit links/knowledge and compile snippets.
## Acceptance
All success/failure/recovery rows pass with no stale public claim.
## Acceptance Test Matrix
Cover default Zod, ArkType direct, Valibot wrapper, validation-only boundaries and provider-subset caveat.
## End-To-End Definition Coverage
Reader entry through copied snippet, TypeScript build, runtime expectation and troubleshooting guidance is covered.
## Operational Path Coverage
Docs/site build, links, skill sync, knowledge audits and secret-free examples are required.
## Review And Verification Plan
Review route/content diff and generated mirrors, then run every command.
## Verification
Record exact pages/files, snippet outputs and clean regeneration diff.
## Non-goals
No new IA, renderer, product UI, Voyage, migration guide or implementation changes.
## Handoff
Accept reviewed consumer alignment before promoting TICKET-006.
