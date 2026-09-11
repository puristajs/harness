---
id: TICKET-007
title: PURISTA handbook, phase projections and skill reuse
wave: 7
lifecycle: accepted
spec_manifest_digest: "sha256:40c13572186ebc1f800a3742dab3b514a65bb924887e9c994921f457bd682b3f"
plan_manifest_digest: sha256:2a9ef84fc85798d2235d0bb1203403837fa90f56142d9730ab695bf2beb771c9
parallel_group: guardrail-authoring-sequential-7
depends_on:
  - TICKET-006
blocked_by: []
spec_refs:
  - ai-harness/specs/38-guardrail-authoring/04-delivery/consumers.md#CTR-GA-DOCS
  - ai-harness/specs/38-guardrail-authoring/04-delivery/consumers.md#CTR-GA-CLEANUP
  - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-WEBSITE
  - ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE
write_scope:
  - purista/web/src/content/handbook/harness
  - purista/web/src/pages/harness/guardrails.astro
  - purista/web/src/components/harness/GuardrailsArchitecture.astro
  - purista/web/src/data/guardrails-content.ts
  - purista/web/src/data/harness-markdown.ts
  - purista/scripts/knowledge-audit.mjs
  - purista/scripts/guardrails-knowledge.test.mjs
  - purista/skills/purista/references/05-ai-harness-runtime.md
  - purista/skills/purista/references/11-evaluation-scenarios.md
  - purista/packages/core/skills
  - purista/web/src/content/handbook-cards/harness/guardrails-governance.mdx
  - purista/web/src/content/handbook-cards/harness/privacy-detectors.mdx
  - purista/web/src/content/handbook-cards/harness/ecosystem-packages.mdx
  - purista/web/src/content/handbook-cards/blocks/agent-pattern/guardrails.mdx
  - purista/web/src/content/handbook-cards/harness/tools-and-skills.mdx
  - purista/web/src/content/handbook-cards/harness/sandboxing-and-mcp.mdx
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
  - purista/web/src/content/handbook/harness
  - purista/web/src/pages/harness/guardrails.astro
  - purista/web/src/components/harness/GuardrailsArchitecture.astro
  - purista/web/src/data/guardrails-content.ts
  - purista/web/src/data/harness-markdown.ts
  - purista/scripts/knowledge-audit.mjs
  - purista/scripts/guardrails-knowledge.test.mjs
  - purista/skills/purista/references/05-ai-harness-runtime.md
  - purista/skills/purista/references/11-evaluation-scenarios.md
  - purista/packages/core/skills
  - purista/web/src/content/handbook-cards/harness/guardrails-governance.mdx
  - purista/web/src/content/handbook-cards/harness/privacy-detectors.mdx
  - purista/web/src/content/handbook-cards/harness/ecosystem-packages.mdx
  - purista/web/src/content/handbook-cards/blocks/agent-pattern/guardrails.mdx
  - purista/web/src/content/handbook-cards/harness/tools-and-skills.mdx
  - purista/web/src/content/handbook-cards/harness/sandboxing-and-mcp.mdx
  - purista/scripts/skills-audit.mjs
  - purista/web/scripts/audit-internal-links.mjs
contract_readiness:
  status: ready
  required_contracts:
    - CTR-GA-DOCS
    - CTR-GA-CLEANUP
  missing_contracts: []
traceability:
  requirement_ids:
    - REQ-GA-WEBSITE
  capability_ids:
    - CAP-GA-WEBSITE
  path_ids:
    - PATH-GA-WEBSITE-SUCCESS
    - PATH-GA-WEBSITE-FAILURE
    - PATH-GA-WEBSITE-RECOVERY
  acceptance_ids:
    - AC-GA-WEBSITE-SUCCESS
    - AC-GA-WEBSITE-FAILURE
    - AC-GA-WEBSITE-RECOVERY
generated_contracts:
  status: source_derived_ready
  source_refs:
    - ai-harness/specs/38-guardrail-authoring/03-contracts/generation-map.yaml
  command_refs:
    - CMD-SYNC
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
  status: not_applicable
  scope_refs: [ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-WEBSITE]
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
  CMD-SYNC:
    command: node purista/scripts/syncPackageSkills.mjs purista/packages/core
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-SITE:
    command: npm --prefix purista run build --workspace @purista/web
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-DOC-TEST:
    command: node --test purista/scripts/guardrails-knowledge.test.mjs
    purpose: requirement-scoped verification
    expected: pass
    network: forbidden
    writes: workspace_only
    secrets: forbidden
  CMD-LINKS:
    command: "npm --prefix purista run audit:internal-links --workspace @purista/web"
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
  CMD-HANDBOOK:
    command: "npm --prefix purista run audit:handbook"
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
      - ACC-WEBSITE-SUCCESS
      - ACC-WEBSITE-FAILURE
      - ACC-WEBSITE-RECOVERY
    expected_proof: current digests and dependencies checked; dirty baseline preserved
  - id: STEP-CONTRACT
    kind: contract
    files:
      - purista/web/src/content/handbook/harness
      - purista/web/src/pages/harness/guardrails.astro
      - purista/web/src/components/harness/GuardrailsArchitecture.astro
      - purista/web/src/data/guardrails-content.ts
      - purista/web/src/data/harness-markdown.ts
      - purista/scripts/knowledge-audit.mjs
      - purista/scripts/guardrails-knowledge.test.mjs
      - purista/skills/purista/references/05-ai-harness-runtime.md
      - purista/skills/purista/references/11-evaluation-scenarios.md
      - purista/packages/core/skills
      - purista/web/src/content/handbook-cards/harness/guardrails-governance.mdx
      - purista/web/src/content/handbook-cards/harness/privacy-detectors.mdx
      - purista/web/src/content/handbook-cards/harness/ecosystem-packages.mdx
      - purista/web/src/content/handbook-cards/blocks/agent-pattern/guardrails.mdx
      - purista/web/src/content/handbook-cards/harness/tools-and-skills.mdx
      - purista/web/src/content/handbook-cards/harness/sandboxing-and-mcp.mdx
    command_refs:
      - CMD-SYNC
      - CMD-SITE
      - CMD-DOC-TEST
      - CMD-LINKS
      - CMD-SKILLS
      - CMD-KNOWLEDGE
      - CMD-HANDBOOK
    acceptance_refs:
      - ACC-WEBSITE-SUCCESS
      - ACC-WEBSITE-FAILURE
      - ACC-WEBSITE-RECOVERY
    expected_proof: approved source-derived shapes and required generated outputs established before behavior edits
  - id: STEP-TEST
    kind: test
    files:
      - purista/scripts/knowledge-audit.mjs
      - purista/scripts/guardrails-knowledge.test.mjs
      - purista/scripts/skills-audit.mjs
      - purista/web/scripts/audit-internal-links.mjs
    command_refs:
      - CMD-SYNC
      - CMD-SITE
      - CMD-DOC-TEST
      - CMD-LINKS
      - CMD-SKILLS
      - CMD-KNOWLEDGE
      - CMD-HANDBOOK
    acceptance_refs:
      - ACC-WEBSITE-SUCCESS
      - ACC-WEBSITE-FAILURE
      - ACC-WEBSITE-RECOVERY
    expected_proof: negative/happy cases demonstrate old failure then new acceptance
  - id: STEP-IMPLEMENT
    kind: implement
    files:
      - purista/web/src/content/handbook/harness
      - purista/web/src/pages/harness/guardrails.astro
      - purista/web/src/components/harness/GuardrailsArchitecture.astro
      - purista/web/src/data/guardrails-content.ts
      - purista/web/src/data/harness-markdown.ts
      - purista/scripts/knowledge-audit.mjs
      - purista/scripts/guardrails-knowledge.test.mjs
      - purista/skills/purista/references/05-ai-harness-runtime.md
      - purista/skills/purista/references/11-evaluation-scenarios.md
      - purista/packages/core/skills
      - purista/web/src/content/handbook-cards/harness/guardrails-governance.mdx
      - purista/web/src/content/handbook-cards/harness/privacy-detectors.mdx
      - purista/web/src/content/handbook-cards/harness/ecosystem-packages.mdx
      - purista/web/src/content/handbook-cards/blocks/agent-pattern/guardrails.mdx
      - purista/web/src/content/handbook-cards/harness/tools-and-skills.mdx
      - purista/web/src/content/handbook-cards/harness/sandboxing-and-mcp.mdx
    command_refs:
      - CMD-SYNC
      - CMD-SITE
      - CMD-DOC-TEST
      - CMD-LINKS
      - CMD-SKILLS
      - CMD-KNOWLEDGE
      - CMD-HANDBOOK
    acceptance_refs:
      - ACC-WEBSITE-SUCCESS
      - ACC-WEBSITE-FAILURE
      - ACC-WEBSITE-RECOVERY
    expected_proof: only approved behavior and mechanical consumer cut within scope
  - id: STEP-VERIFY
    kind: verify
    files:
      - purista/web/src/content/handbook/harness
      - purista/web/src/pages/harness/guardrails.astro
      - purista/web/src/components/harness/GuardrailsArchitecture.astro
      - purista/web/src/data/guardrails-content.ts
      - purista/web/src/data/harness-markdown.ts
      - purista/scripts/knowledge-audit.mjs
      - purista/scripts/guardrails-knowledge.test.mjs
      - purista/skills/purista/references/05-ai-harness-runtime.md
      - purista/skills/purista/references/11-evaluation-scenarios.md
      - purista/packages/core/skills
      - purista/web/src/content/handbook-cards/harness/guardrails-governance.mdx
      - purista/web/src/content/handbook-cards/harness/privacy-detectors.mdx
      - purista/web/src/content/handbook-cards/harness/ecosystem-packages.mdx
      - purista/web/src/content/handbook-cards/blocks/agent-pattern/guardrails.mdx
      - purista/web/src/content/handbook-cards/harness/tools-and-skills.mdx
      - purista/web/src/content/handbook-cards/harness/sandboxing-and-mcp.mdx
    command_refs:
      - CMD-SYNC
      - CMD-SITE
      - CMD-DOC-TEST
      - CMD-LINKS
      - CMD-SKILLS
      - CMD-KNOWLEDGE
      - CMD-HANDBOOK
    acceptance_refs:
      - ACC-WEBSITE-SUCCESS
      - ACC-WEBSITE-FAILURE
      - ACC-WEBSITE-RECOVERY
    expected_proof: exact commands pass with no threshold weakening or skipped assertions
  - id: STEP-HANDOFF
    kind: handoff
    files:
      - purista/web/src/content/handbook/harness
      - purista/web/src/pages/harness/guardrails.astro
      - purista/web/src/components/harness/GuardrailsArchitecture.astro
      - purista/web/src/data/guardrails-content.ts
      - purista/web/src/data/harness-markdown.ts
      - purista/scripts/knowledge-audit.mjs
      - purista/scripts/guardrails-knowledge.test.mjs
      - purista/skills/purista/references/05-ai-harness-runtime.md
      - purista/skills/purista/references/11-evaluation-scenarios.md
      - purista/packages/core/skills
      - purista/web/src/content/handbook-cards/harness/guardrails-governance.mdx
      - purista/web/src/content/handbook-cards/harness/privacy-detectors.mdx
      - purista/web/src/content/handbook-cards/harness/ecosystem-packages.mdx
      - purista/web/src/content/handbook-cards/blocks/agent-pattern/guardrails.mdx
      - purista/web/src/content/handbook-cards/harness/tools-and-skills.mdx
      - purista/web/src/content/handbook-cards/harness/sandboxing-and-mcp.mdx
    command_refs:
      - CMD-SYNC
      - CMD-SITE
      - CMD-DOC-TEST
      - CMD-LINKS
      - CMD-SKILLS
      - CMD-KNOWLEDGE
      - CMD-HANDBOOK
    acceptance_refs:
      - ACC-WEBSITE-SUCCESS
      - ACC-WEBSITE-FAILURE
      - ACC-WEBSITE-RECOVERY
    expected_proof: evidence recorded; request independent review, not self-acceptance
acceptance:
  - id: ACC-WEBSITE-SUCCESS
    traceability_acceptance_ids:
      - AC-GA-WEBSITE-SUCCESS
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-WEBSITE
    test_refs:
      - purista/scripts/knowledge-audit.mjs
      - purista/scripts/guardrails-knowledge.test.mjs
      - purista/scripts/skills-audit.mjs
      - purista/web/scripts/audit-internal-links.mjs
    command_refs:
      - CMD-SYNC
      - CMD-SITE
      - CMD-DOC-TEST
      - CMD-LINKS
      - CMD-SKILLS
      - CMD-KNOWLEDGE
      - CMD-HANDBOOK
    expected_outcome: HTML architecture, diagram, Markdown projection, handbook and canonical PURISTA skills agree on final-only output, new authoring and preflight limits.
    lifecycle: accepted
  - id: ACC-WEBSITE-FAILURE
    traceability_acceptance_ids:
      - AC-GA-WEBSITE-FAILURE
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-WEBSITE
    test_refs:
      - purista/scripts/knowledge-audit.mjs
      - purista/scripts/guardrails-knowledge.test.mjs
      - purista/scripts/skills-audit.mjs
      - purista/web/scripts/audit-internal-links.mjs
    command_refs:
      - CMD-SYNC
      - CMD-SITE
      - CMD-DOC-TEST
      - CMD-LINKS
      - CMD-SKILLS
      - CMD-KNOWLEDGE
      - CMD-HANDBOOK
    expected_outcome: Focused audit detects stale phase/projection or removed API text; no blanket entity decoding or renderer change is introduced for the unreproduced report.
    lifecycle: accepted
  - id: ACC-WEBSITE-RECOVERY
    traceability_acceptance_ids:
      - AC-GA-WEBSITE-RECOVERY
    requirement_refs:
      - ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-WEBSITE
    test_refs:
      - purista/scripts/knowledge-audit.mjs
      - purista/scripts/guardrails-knowledge.test.mjs
      - purista/scripts/skills-audit.mjs
      - purista/web/scripts/audit-internal-links.mjs
    command_refs:
      - CMD-SYNC
      - CMD-SITE
      - CMD-DOC-TEST
      - CMD-LINKS
      - CMD-SKILLS
      - CMD-KNOWLEDGE
      - CMD-HANDBOOK
    expected_outcome: Existing routes/layout/accessibility survive site build and link audit; rendered/copied factory snippet matches source; package skills regenerate through existing sync.
    lifecycle: accepted
---

## Goal

PURISTA handbook, phase projections and skill reuse through the existing public entrypoint, including negative and recovery behavior. Remove all website, handbook, canonical PURISTA skill and synced package-overlay references to file configuration, its dependency, artifacts, generation/check scripts, validation command and exports; teach the inline object only.

## Context Digest

Read the listed contracts and analysis. This ticket owns REQ-GA-WEBSITE; previous tickets are dependencies, not permission to change their contracts. Source baseline is dirty. Voyage is excluded.

## Implementation Approach

- Create the small shared phase/guarantee content source and consume it from existing page/diagram/Markdown projection.
- Update the bounded handbook native tools/guardrails/factory snippets and canonical skill references; preserve inferred factory return type.
- Extend knowledge checks for new shared content and removed patterns; verify reported encoding path without speculative decoder changes.
- Regenerate existing package skill overlays, build website and audit links/knowledge/skills with no route restructuring.

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

REQ-GA-WEBSITE → CAP-GA-WEBSITE → SUCCESS/FAILURE/RECOVERY paths and AC IDs in frontmatter. No unowned acceptance remains.

## Contract Traceability

- ai-harness/specs/38-guardrail-authoring/04-delivery/consumers.md#CTR-GA-DOCS
- ai-harness/specs/38-guardrail-authoring/04-delivery/consumers.md#CTR-GA-CLEANUP
- ai-harness/specs/38-guardrail-authoring/03-flows/e2e-coverage.md#REQ-GA-WEBSITE
- ai-harness/specs/38-guardrail-authoring/00-conventions.md#CONV-GA-STYLE

## Spec Drift Controls

Check both manifest digests before edits and handoff. A contract ambiguity or changed prerequisite blocks the ticket; write a finding under plan evidence, do not modify approved semantics. Only controller updates lifecycle/digests after review.

## Generator And Type Plan

Build first and use existing declaration emit. Do not add copied option tables or duplicate validators.

## Test-First Order

Add type-negative/schema-negative cases first, then the success fixture, then recovery/mutation/no-effect assertions. Reuse existing fakes. If a behavior already passes, record that evidence rather than forcing an artificial failure.

## Modularity And Reuse Plan

Use file-structure/module/reuse inventory. One canonical type per meaning, one builtin resolver, one decision executor and one sensitive algorithm. New helpers are limited to approved cohesive modules. Do not reformat or reorganize unrelated files.

## Representation Reuse Plan

All shape and mapping IDs are enumerated in frontmatter; apply only those touched by this ticket. Config defaults, opaque action preparation and native registration marking are the only new mappings; existing spec37 evidence/output shapes are unchanged.

## Slice Strategy

One sequential, publicly testable authoring/preflight/documentation slice. The complete breaking release is held until TICKET-008 accepts all consumers; no partial release or temporary compatibility is allowed. Same-file contracts make parallel writes inappropriate.

## Tasks

1. Create the small shared phase/guarantee content source and consume it from existing page/diagram/Markdown projection.
2. Update the bounded handbook native tools/guardrails/factory snippets and canonical skill references; preserve inferred factory return type.
3. Extend knowledge checks for new shared content and removed patterns; verify reported encoding path without speculative decoder changes.
4. Regenerate existing package skill overlays, build website and audit links/knowledge/skills with no route restructuring.

## Acceptance

- HTML architecture, diagram, Markdown projection, handbook and canonical PURISTA skills agree on final-only output, new authoring and preflight limits.
- Focused audit detects stale phase/projection or removed API text; no blanket entity decoding or renderer change is introduced for the unreproduced report.
- Existing routes/layout/accessibility survive site build and link audit; rendered/copied factory snippet matches source; package skills regenerate through existing sync.

## Acceptance Test Matrix

| Path | Required assertion |
| --- | --- |
| success | HTML architecture, diagram, Markdown projection, handbook and canonical PURISTA skills agree on final-only output, new authoring and preflight limits. |
| failure | Focused audit detects stale phase/projection or removed API text; no blanket entity decoding or renderer change is introduced for the unreproduced report. |
| recovery | Existing routes/layout/accessibility survive site build and link audit; rendered/copied factory snippet matches source; package skills regenerate through existing sync. |


## Review And Verification Plan

Independent review must trace the public entrypoint to exact validation/side-effect behavior and inspect failure paths, not only green compile output. Verify generated artifact ownership, no raw-content errors and no duplicated public fields.

## End-To-End Definition Coverage

Actor, entrypoint, data, errors, recovery, permissions, observability, owner and final state are fixed in the linked requirement. Verify actual API use rather than an illustrative replacement. Docs use runnable source and checked projections.

## Operational Path Coverage

Preflight failures must precede requests and protected effects. Runtime deadlines/privacy remain spec37-owned. No new deployment service or persistence. Applicability N/A records cover infrastructure/migrations/Voyage/live systems.

## Verification

Working directory: workspace root /Users/sebastianwessel/projekte/@purista. Run these in order, without shell chaining:

- `CMD-SYNC`: `node purista/scripts/syncPackageSkills.mjs purista/packages/core`
- `CMD-SITE`: `npm --prefix purista run build --workspace @purista/web`
- `CMD-DOC-TEST`: `node --test purista/scripts/guardrails-knowledge.test.mjs`
- `CMD-LINKS`: `npm --prefix purista run audit:internal-links --workspace @purista/web`
- `CMD-SKILLS`: `npm --prefix purista run audit:skills`
- `CMD-KNOWLEDGE`: `npm --prefix purista run audit:knowledge`
- `CMD-HANDBOOK`: `npm --prefix purista run audit:handbook`

A command introduced by this ticket is run only after its implementation. External systems/secrets are forbidden. If dependency artifacts are absent, stop for the normal installation approval instead of fetching implicitly.

## Non-goals

Voyage; provider/detector internals; unrelated sandbox/storage/evaluation work; broad arrow conversion; migration/compatibility paths; new dependencies; publishing or source reset.

## Handoff

Write ai-harness/plans/guardrail-authoring/evidence/TICKET-007.md with exact results, acceptance-ID mapping and residual blockers. Mark implemented, not accepted. Independent reviewer controls acceptance; controller updates all four indexes and manifests together.
