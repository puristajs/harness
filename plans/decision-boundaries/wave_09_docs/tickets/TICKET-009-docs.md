---
id: "TICKET-009"
title: "One current usage journey"
wave: 9
lifecycle: "accepted"
spec_manifest_digest: "sha256:b5323335237da8fac896a1d42efeac1df47f9438f48cebdc8241565ede67724f"
plan_manifest_digest: sha256:a5841b6d4849575fb90a1681653d8c765471386d3acfa5867fd50147d714c009
parallel_group: "decision-sequential-9"
depends_on:
  - "TICKET-002"
  - "TICKET-004"
  - "TICKET-005"
  - "TICKET-007"
blocked_by: []
spec_refs:
  - "ai-harness/specs/37-decision-boundaries/04-delivery/consumers.md#CTR-DB-DOCS"
  - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-DOCS"
  - "ai-harness/specs/37-decision-boundaries/00-conventions.md#CONV-DB-STYLE"
traceability:
  requirement_ids:
    - "REQ-DB-DOCS"
  capability_ids:
    - "CAP-DB-DOCS"
  path_ids:
    - "PATH-DB-DOCS-SUCCESS"
    - "PATH-DB-DOCS-FAILURE"
    - "PATH-DB-DOCS-RECOVERY"
  acceptance_ids:
    - "AC-DB-DOCS-SUCCESS"
    - "AC-DB-DOCS-FAILURE"
    - "AC-DB-DOCS-RECOVERY"
write_scope:
  - "ai-harness/README.md"
  - "ai-harness/packages/harness/README.md"
  - "ai-harness/packages/harness-guardrails/README.md"
  - "ai-harness/packages/harness-openai/README.md"
  - "ai-harness/examples/bank-governance"
  - "ai-harness/examples/guardrails"
  - "ai-harness/examples/durable-human-review"
  - "ai-harness/skills"
  - "ai-harness/.artifacts/decision-skills"
  - "ai-harness/.gitignore"
  - "ai-harness/docs"
  - "ai-harness/.agent/IMPLEMENTATION.md"
  - "purista/skills/purista"
  - "purista/packages/core/skills"
  - "purista/web/src/data/harness-markdown.ts"
  - "purista/web/src/content/handbook/harness"
  - "purista/web/src/content/handbook-cards/harness"
  - "purista/web/src/content/handbook-cards/blocks/agent-pattern"
  - "purista/web/src/content/handbook-cards/blocks/agent-pattern.mdx"
read_scope:
  - "ai-harness/specs/37-decision-boundaries"
  - "ai-harness/AGENTS.md"
  - "ai-harness/.agent/IMPLEMENTATION.md"
  - "ai-harness/specs/02-harness-config.md"
  - "ai-harness/specs/13-public-api.md"
  - "ai-harness/specs/15-error-catalog.md"
  - "ai-harness/specs/16-testing.md"
  - "ai-harness/plans/decision-boundaries"
  - "ai-harness/README.md"
  - "ai-harness/packages/harness/README.md"
  - "ai-harness/packages/harness-guardrails/README.md"
  - "ai-harness/packages/harness-openai/README.md"
  - "ai-harness/examples/bank-governance"
  - "ai-harness/examples/guardrails"
  - "ai-harness/examples/durable-human-review"
  - "ai-harness/skills"
  - "ai-harness/.artifacts/decision-skills"
  - "ai-harness/.gitignore"
  - "ai-harness/docs"
  - "purista/skills/purista"
  - "purista/packages/core/skills"
  - "purista/web/src/data/harness-markdown.ts"
  - "purista/web/src/content/handbook/harness"
  - "purista/web/src/content/handbook-cards/harness"
  - "purista/web/src/content/handbook-cards/blocks/agent-pattern"
  - "purista/web/src/content/handbook-cards/blocks/agent-pattern.mdx"
  - "ai-harness/packages/harness/src"
  - "ai-harness/packages/harness/test"
  - "ai-harness/packages/harness/type-tests"
  - "ai-harness/scripts"
  - "ai-harness/package.json"
  - "ai-harness/package-lock.json"
  - "purista/AGENTS.md"
  - "purista/skills/purista/SKILL.md"
  - "purista/packages/core"
  - "purista/tsconfig.json"
  - "purista/tsconfig.unit.json"
  - "purista/vitest.config.unit.ts"
  - "purista/vitest.workspaceAliases.ts"
  - "purista/scripts"
  - "purista/web/AGENTS.md"
  - "purista/web/DESIGN.md"
  - "purista/skills/purista-docs-maintainer"
  - "starter"
  - "create-purista"
contract_readiness:
  status: "ready"
  required_contracts:
    - "CTR-DB-DOCS"
  missing_contracts: []
generated_contracts:
  status: "source_derived_ready"
  source_refs:
    - "ai-harness/specs/37-decision-boundaries/03-contracts/generation-map.yaml"
  command_refs:
    - "CMD-CORE-BUILD"
    - "CMD-RAIL-BUILD"
    - "CMD-COMPOSED-TEST"
    - "CMD-COMPOSED-TYPES"
    - "CMD-BANK"
    - "CMD-BANK-TYPES"
    - "CMD-REVIEW"
    - "CMD-REVIEW-TYPES"
    - "CMD-TYPE-TESTS"
    - "CMD-HARNESS-SKILLS"
    - "CMD-HARNESS-SKILLS-CHECK"
    - "CMD-PURISTA-SKILLS"
    - "CMD-SKILLS"
    - "CMD-KNOWLEDGE"
    - "CMD-HANDBOOK"
    - "CMD-API-DOCS"
  drift_command_refs:
    - "CMD-SPECS"
    - "CMD-PLAN"
ticket_readiness:
  status: "implementation_ready"
  open_decisions: []
  ambiguous_phrases: []
slice_type: "refactor_exception"
phase_gate_exception: true
representation_reuse:
  status: "ready"
  catalog_ref: "ai-harness/specs/37-decision-boundaries/03-contracts/representation-catalog.yaml"
  shape_refs:
    - "decision.evidence"
    - "approval.request"
    - "rail.outcome"
    - "review.execution"
  mapping_refs:
    - "MAP-DB-EVIDENCE"
    - "MAP-DB-CLAIM"
  new_shape_decision: "none; approved DEC-DB-CLEAN and DEC-DB-OWNERSHIP"
autonomy:
  allowed_classes:
    - "D0"
    - "D1"
  convention_refs:
    - "ai-harness/specs/37-decision-boundaries/00-conventions.md#CONV-DB-STYLE"
  approved_decision_refs:
    - "ai-harness/specs/37-decision-boundaries/00-vision.md#Authority"
    - "ai-harness/specs/37-decision-boundaries/00-module-boundaries.yaml#modules"
  escalation: "blocker"
verification_commands:
  CMD-SPECS:
    command: "node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/37-decision-boundaries"
    purpose: "spec/plan and working-tree preflight"
    expected: "pass"
    network: "forbidden"
    writes: "read_only"
    secrets: "forbidden"
  CMD-PLAN:
    command: "node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/decision-boundaries ai-harness/specs/37-decision-boundaries"
    purpose: "spec/plan and working-tree preflight"
    expected: "pass"
    network: "forbidden"
    writes: "read_only"
    secrets: "forbidden"
  CMD-STATUS:
    command: "git -C ai-harness status --short"
    purpose: "spec/plan and working-tree preflight"
    expected: "record_only"
    network: "forbidden"
    writes: "read_only"
    secrets: "forbidden"
  CMD-CORE-BUILD:
    command: "npm --prefix ai-harness run build --workspace @purista/harness"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-RAIL-BUILD:
    command: "npm --prefix ai-harness run build --workspace @purista/harness-guardrails"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-COMPOSED-TEST:
    command: "npm --prefix ai-harness test --workspace @purista/guardrails-example"
    purpose: "Verify the composed rail and approval documentation example"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-COMPOSED-TYPES:
    command: "npm --prefix ai-harness run typecheck --workspace @purista/guardrails-example"
    purpose: "Verify the composed rail and approval documentation example"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-BANK:
    command: "npm --prefix ai-harness test --workspace @purista/bank-governance-example"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-BANK-TYPES:
    command: "npm --prefix ai-harness run typecheck --workspace @purista/bank-governance-example"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-REVIEW:
    command: "npm --prefix ai-harness test --workspace @purista/durable-human-review-example"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-REVIEW-TYPES:
    command: "npm --prefix ai-harness run typecheck --workspace @purista/durable-human-review-example"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-TYPE-TESTS:
    command: "npm --prefix ai-harness run test:types --workspace @purista/harness"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-HARNESS-SKILLS:
    command: "node ai-harness/scripts/sync-ai-harness-skill.mjs ai-harness/.artifacts/decision-skills/ai-harness"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-HARNESS-SKILLS-CHECK:
    command: "node ai-harness/scripts/sync-ai-harness-skill.mjs --check ai-harness/.artifacts/decision-skills/ai-harness"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-PURISTA-SKILLS:
    command: "node purista/scripts/syncPackageSkills.mjs purista/packages/core"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-SKILLS:
    command: "npm --prefix purista run audit:skills"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-KNOWLEDGE:
    command: "npm --prefix purista run audit:knowledge"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-HANDBOOK:
    command: "npm --prefix purista run audit:handbook"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-API-DOCS:
    command: "npm --prefix purista run audit:api-docs"
    purpose: "requirement-scoped verification for DOCS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
action_steps:
  - id: "STEP-PREFLIGHT"
    kind: "preflight"
    files:
      - "ai-harness/specs/37-decision-boundaries"
    command_refs:
      - "CMD-SPECS"
      - "CMD-PLAN"
      - "CMD-STATUS"
    acceptance_refs: []
    expected_proof: "Matching digests, prerequisite accepted, preserved baseline and no competing writer."
  - id: "STEP-CONTRACT"
    kind: "contract"
    files:
      - "ai-harness/README.md"
    command_refs:
      - "CMD-CORE-BUILD"
    acceptance_refs: []
    expected_proof: "Canonical contracts and approved representation map matched before behavior edits."
  - id: "STEP-TEST"
    kind: "test"
    files:
      - "ai-harness/README.md"
    command_refs:
      - "CMD-CORE-BUILD"
    acceptance_refs:
      - "ACC-DOCS-SUCCESS"
      - "ACC-DOCS-FAILURE"
      - "ACC-DOCS-RECOVERY"
    expected_proof: "Named new regression assertions fail for their intended reason before implementation, or existing matching proof is recorded."
  - id: "STEP-IMPLEMENT"
    kind: "implement"
    files:
      - "ai-harness/README.md"
    command_refs: []
    acceptance_refs:
      - "ACC-DOCS-SUCCESS"
      - "ACC-DOCS-FAILURE"
      - "ACC-DOCS-RECOVERY"
    expected_proof: "Publish the one current usage journey and decision table from delivery contract. Update existing examples/readmes and docs/reference/public-api.md plus docs/guides/guardrails.md/configuration.md, canonical skill references, handbook prose/cards and generated PURISTA skill mirrors. Harness has no packaged skill mirror: test its existing sync/check against the owned .artifacts/decision-skills/ai-harness directory, never an installed user skill. Ignore only that exact generated artifact subtree in .gitignore. Remove stale compatibility recipes and old hook/result symbols. Explain exact phase/callback/durable boundaries and risks. Correct stale .agent package inventory only for current affected published Harness/addon/provider surfaces. Preserve handbook routes, layout and styles."
  - id: "STEP-VERIFY"
    kind: "verify"
    files:
      - "ai-harness/README.md"
    command_refs:
      - "CMD-CORE-BUILD"
      - "CMD-RAIL-BUILD"
      - "CMD-COMPOSED-TEST"
      - "CMD-COMPOSED-TYPES"
      - "CMD-BANK"
      - "CMD-BANK-TYPES"
      - "CMD-REVIEW"
      - "CMD-REVIEW-TYPES"
      - "CMD-TYPE-TESTS"
      - "CMD-HARNESS-SKILLS"
      - "CMD-HARNESS-SKILLS-CHECK"
      - "CMD-PURISTA-SKILLS"
      - "CMD-SKILLS"
      - "CMD-KNOWLEDGE"
      - "CMD-HANDBOOK"
      - "CMD-API-DOCS"
    acceptance_refs:
      - "ACC-DOCS-SUCCESS"
      - "ACC-DOCS-FAILURE"
      - "ACC-DOCS-RECOVERY"
    expected_proof: "All ticket commands pass and every acceptance row has exact test evidence."
  - id: "STEP-HANDOFF"
    kind: "handoff"
    files: []
    command_refs: []
    acceptance_refs: []
    expected_proof: "Evidence recorded; lifecycle implemented only; independent review required for accepted."
acceptance:
  - id: "ACC-DOCS-SUCCESS"
    traceability_acceptance_ids:
      - "AC-DB-DOCS-SUCCESS"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-DOCS"
    test_refs:
      - "purista/scripts/knowledge-audit.mjs"
    command_refs:
      - "CMD-CORE-BUILD"
      - "CMD-RAIL-BUILD"
      - "CMD-COMPOSED-TEST"
      - "CMD-COMPOSED-TYPES"
      - "CMD-BANK"
      - "CMD-BANK-TYPES"
      - "CMD-REVIEW"
      - "CMD-REVIEW-TYPES"
      - "CMD-TYPE-TESTS"
      - "CMD-HARNESS-SKILLS"
      - "CMD-HARNESS-SKILLS-CHECK"
      - "CMD-PURISTA-SKILLS"
      - "CMD-SKILLS"
      - "CMD-KNOWLEDGE"
      - "CMD-HANDBOOK"
      - "CMD-API-DOCS"
    expected_outcome: "One example composes content rails immediate approval and durable review ownership"
    lifecycle: "accepted"
  - id: "ACC-DOCS-FAILURE"
    traceability_acceptance_ids:
      - "AC-DB-DOCS-FAILURE"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-DOCS"
    test_refs:
      - "purista/scripts/knowledge-audit.mjs"
    command_refs:
      - "CMD-CORE-BUILD"
      - "CMD-RAIL-BUILD"
      - "CMD-COMPOSED-TEST"
      - "CMD-COMPOSED-TYPES"
      - "CMD-BANK"
      - "CMD-BANK-TYPES"
      - "CMD-REVIEW"
      - "CMD-REVIEW-TYPES"
      - "CMD-TYPE-TESTS"
      - "CMD-HARNESS-SKILLS"
      - "CMD-HARNESS-SKILLS-CHECK"
      - "CMD-PURISTA-SKILLS"
      - "CMD-SKILLS"
      - "CMD-KNOWLEDGE"
      - "CMD-HANDBOOK"
      - "CMD-API-DOCS"
    expected_outcome: "No recipe presents guardrail block as approval request or durable suspension"
    lifecycle: "accepted"
  - id: "ACC-DOCS-RECOVERY"
    traceability_acceptance_ids:
      - "AC-DB-DOCS-RECOVERY"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-DOCS"
    test_refs:
      - "purista/scripts/knowledge-audit.mjs"
    command_refs:
      - "CMD-CORE-BUILD"
      - "CMD-RAIL-BUILD"
      - "CMD-COMPOSED-TEST"
      - "CMD-COMPOSED-TYPES"
      - "CMD-BANK"
      - "CMD-BANK-TYPES"
      - "CMD-REVIEW"
      - "CMD-REVIEW-TYPES"
      - "CMD-TYPE-TESTS"
      - "CMD-HARNESS-SKILLS"
      - "CMD-HARNESS-SKILLS-CHECK"
      - "CMD-PURISTA-SKILLS"
      - "CMD-SKILLS"
      - "CMD-KNOWLEDGE"
      - "CMD-HANDBOOK"
      - "CMD-API-DOCS"
    expected_outcome: "Canonical skill mirrors regenerate from source and exact usage examples typecheck"
    lifecycle: "accepted"
---

# TICKET-009 — One current usage journey

## Goal

One example composes content rails immediate approval and durable review ownership. Covers CAP-DB-DOCS and REQ-DB-DOCS.

## Context Digest

Actor: developer and operator. Reachable entry: `handbook package docs canonical skills examples`. Contracts: CTR-DB-DOCS. Current source is evidence only; approved spec digest is authority. Preserve existing uncommitted work and preceding ticket changes. No runtime work was performed by this plan.

## Implementation Approach

Publish the one current usage journey and decision table from delivery contract. Update existing examples/readmes and docs/reference/public-api.md plus docs/guides/guardrails.md/configuration.md, canonical skill references, handbook prose/cards and generated PURISTA skill mirrors. Harness has no packaged skill mirror: test its existing sync/check against the owned .artifacts/decision-skills/ai-harness directory, never an installed user skill. Ignore only that exact generated artifact subtree in .gitignore. Remove stale compatibility recipes and old hook/result symbols. Explain exact phase/callback/durable boundaries and risks. Correct stale .agent package inventory only for current affected published Harness/addon/provider surfaces. Preserve handbook routes, layout and styles.

## Decision Ledger

DEC-DB-CLEAN authorizes the exact breaking replacement, no compatibility/migration. DEC-DB-OWNERSHIP fixes module boundaries. Execute those decisions mechanically; only D0/D1 choices in CONV-DB-STYLE are permitted. No new public shape, dependency, policy behavior or business state may be invented.

## Action Plan

1. Read only declared read_scope relevant to this ticket. Check readiness/manifest and prerequisite lifecycle with CMD-SPECS/CMD-PLAN; record CMD-STATUS and baseline of existing ticket commands. New command files are tested after their test-first creation, not claimed to exist at baseline. **Phase Gate:** prerequisites TICKET-002, TICKET-004, TICKET-005 and TICKET-007 and matching digests must be proven before edits. Voyage is out of scope.
2. Match the referenced contracts and representation entries to their source-schema owner. Author/adjust strict schemas and inferred aliases before runtime behavior. Generation source is `03-contracts/generation-map.yaml`; compiler emits declarations only through the existing build. Generic types and reducers are manual because no approved generator emits them. **Phase Gate:** review the source schemas and required negative type assertions against the spec before behavior implementation; complete compiler checks after the same owner ticket updates its call sites. No duplicate interface mirrors or compatibility overloads.
3. Extend the named tests before production behavior. Extend the existing guardrails example (already depends on Harness, Guardrails and Zod) with the composed input/tool/output rail plus one approval path; retain bank/review as focused examples. No dependency or package-manifest edit is needed. Runnable examples and public type tests cover documented snippets; skill sync deterministic; audits pass; old API scan empty in active docs; docs state direct-call/opaque reasoning/revocation limits; no user-facing dependency on internal specs. Record intended failing assertions or exact already-existing proof for each acceptance row. Fixtures use fake providers/clocks and synthetic data only.
4. Implement in write_scope: Publish the one current usage journey and decision table from delivery contract. Update existing examples/readmes and docs/reference/public-api.md plus docs/guides/guardrails.md/configuration.md, canonical skill references, handbook prose/cards and generated PURISTA skill mirrors. Harness has no packaged skill mirror: test its existing sync/check against the owned .artifacts/decision-skills/ai-harness directory, never an installed user skill. Ignore only that exact generated artifact subtree in .gitignore. Remove stale compatibility recipes and old hook/result symbols. Explain exact phase/callback/durable boundaries and risks. Correct stale .agent package inventory only for current affected published Harness/addon/provider surfaces. Preserve handbook routes, layout and styles. Keep public TSDoc current. **Phase Gate:** affected boundary tests and type checks must pass before dependent runtime/consumer behavior is marked implemented. If an external declaration/config mismatch is encountered, record blocked evidence; do not suppress or install.
5. Run verification commands in their listed order, rerun CMD-SPECS/CMD-PLAN, inspect changed-file scope and duplicate implementations. Record exit codes, relevant test names, privacy/error/cancellation proof and generated-artifact checks. No acceptance based only on a submitted command or mocked substitute.
6. Write evidence under `ai-harness/plans/decision-boundaries/evidence/TICKET-009.md` through the coordinator handoff. Implementation agent reports implemented/partial/blocked; coordinator owns index/lifecycle and manifest updates. Independent review checks specs plus this action plan before accepted. **Phase Gate:** T010 implementation can proceed after accepted T007; final T010 acceptance remains blocked until T008 and T009 are both accepted and indexes are reconciled.

## Requirements Traceability

REQ-DB-DOCS; CAP-DB-DOCS. Success/failure/recovery paths and acceptance IDs are exact frontmatter links to 00-traceability.yaml; no deferrals.

## Contract Traceability

ai-harness/specs/37-decision-boundaries/04-delivery/consumers.md#CTR-DB-DOCS, ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-DOCS, ai-harness/specs/37-decision-boundaries/00-conventions.md#CONV-DB-STYLE. Approved decisions.md plus its explicitly linked provider-continuation/review-execution documents define values, error semantics and sequences; no local reinterpretation.

## Spec Drift Controls

Reject changed manifest digests, missing prerequisites, unregistered shapes, altered timeout/approval semantics, raw content in evidence or old API fallbacks. Review against the exact REQ-DB-DOCS, CTR-DB-DOCS and frontmatter acceptance rows before acceptance. Missing behavior goes to readiness review as a blocker, never an implementation guess.

## Generator And Type Plan

Use approved generation-map: strict Zod definitions own non-generic runtime/TypeScript shape; infer aliases, compile with existing tsc, reuse existing declaration generation. Generic narrowing and lifecycle implementation are manual because repository generators do not emit them. Do not add YAML codegen. Build/check commands above own generated validation; no handwritten duplicate schemas/interfaces. No new package/version/dependency. Closed boundaries have no any, unchecked cast or open unknown result.

## Test-First Order

Extend the existing guardrails example (already depends on Harness, Guardrails and Zod) with the composed input/tool/output rail plus one approval path; retain bank/review as focused examples. No dependency or package-manifest edit is needed. Runnable examples and public type tests cover documented snippets; skill sync deterministic; audits pass; old API scan empty in active docs; docs state direct-call/opaque reasoning/revocation limits; no user-facing dependency on internal specs. Tests precede behavior; each success/failure/recovery acceptance row requires its exact assertion and command proof. Existing fixtures are extended; a new file is permitted only for a new module/checker or absent type-test seam. No live provider/credentials.

## Modularity And Reuse Plan

Existing docs components/routes, canonical skill catalogs and sync scripts; examples supply compilable snippets instead of copied implementations. Placement follows 00-file-structure.md and 00-module-boundaries.yaml. Extract only helpers consumed by the named boundaries, not a new abstraction hierarchy. No unrelated domain logic.

## Representation Reuse Plan

Catalog: `ai-harness/specs/37-decision-boundaries/03-contracts/representation-catalog.yaml`. Shapes: decision.evidence, approval.request, rail.outcome, review.execution. Mappings: MAP-DB-EVIDENCE, MAP-DB-CLAIM. Extend those owners only; no second envelope or renamed mirror. New-shape decision: none.

## Slice Strategy

Refactor exception spans one inseparable public boundary and its call sites; phase gates prohibit moving downstream before the changed boundary has proof. Unblocks TICKET-010. No parallel writes: runtime builders, sessions and exports overlap across sequential tickets. Only read-only sidecar review is safe.

## Tasks

Execute STEP-PREFLIGHT, STEP-CONTRACT, STEP-TEST, STEP-IMPLEMENT, STEP-VERIFY and STEP-HANDOFF in order. Detailed edits and proof are in Action Plan, not discretionary work suggestions.

## Acceptance

One example composes content rails immediate approval and durable review ownership. No recipe presents guardrail block as approval request or durable suspension. Canonical skill mirrors regenerate from source and exact usage examples typecheck. Every structured acceptance row must pass; no silent partial completion.

## Acceptance Test Matrix

| Acceptance | Required assertion | Verification |
| --- | --- | --- |
| ACC-DOCS-SUCCESS | One example composes content rails immediate approval and durable review ownership | CMD-CORE-BUILD, CMD-RAIL-BUILD, CMD-BANK, CMD-BANK-TYPES, CMD-REVIEW, CMD-REVIEW-TYPES, CMD-TYPE-TESTS, CMD-HARNESS-SKILLS, CMD-HARNESS-SKILLS-CHECK, CMD-PURISTA-SKILLS, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK, CMD-API-DOCS |
| ACC-DOCS-FAILURE | No recipe presents guardrail block as approval request or durable suspension | CMD-CORE-BUILD, CMD-RAIL-BUILD, CMD-BANK, CMD-BANK-TYPES, CMD-REVIEW, CMD-REVIEW-TYPES, CMD-TYPE-TESTS, CMD-HARNESS-SKILLS, CMD-HARNESS-SKILLS-CHECK, CMD-PURISTA-SKILLS, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK, CMD-API-DOCS |
| ACC-DOCS-RECOVERY | Canonical skill mirrors regenerate from source and exact usage examples typecheck | CMD-CORE-BUILD, CMD-RAIL-BUILD, CMD-BANK, CMD-BANK-TYPES, CMD-REVIEW, CMD-REVIEW-TYPES, CMD-TYPE-TESTS, CMD-HARNESS-SKILLS, CMD-HARNESS-SKILLS-CHECK, CMD-PURISTA-SKILLS, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK, CMD-API-DOCS |

## End-To-End Definition Coverage

`02-capabilities/capability-inventory.md#CAP-DB-DOCS` and `03-flows/e2e-coverage.md#REQ-DB-DOCS` specify actor, trigger, entrypoint, state, effects, authorization, errors, recovery, observability, owner and terminal outcomes. This ticket proves that chain through `purista/scripts/knowledge-audit.mjs` and the matrix above. No additional UI/server surface is introduced.

## Operational Path Coverage

Cover all three PATH-DB-DOCS paths. Safe reason/evidence and existing trace correlation, cancellation and idempotency follow the owning contract; no raw data logs. 04-nfr/requirements.md and 04-operations/runbook.md bind performance, integrity and release limits. External services, UI/a11y changes, dependency upgrades and production deployment are N/A, not simulated successes.

## Review And Verification Plan

Independent review checks spec/ticket/acceptance alignment, generated declarations, strict typing, module ownership, reuse, dead code and scope. Reject invented behavior, skipped failure/recovery coverage, avoidable casts, duplicate mappers/timers, hidden content leakage or old aliases. A required failed command blocks acceptance even if baseline failure is unrelated; record exact blocker and ask the coordinator for bounded remediation scope.

## Verification

Run CMD-SPECS, CMD-PLAN, CMD-STATUS, CMD-CORE-BUILD, CMD-RAIL-BUILD, CMD-BANK, CMD-BANK-TYPES, CMD-REVIEW, CMD-REVIEW-TYPES, CMD-TYPE-TESTS, CMD-HARNESS-SKILLS, CMD-HARNESS-SKILLS-CHECK, CMD-PURISTA-SKILLS, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK, CMD-API-DOCS. Commands are from workspace root and use installed tools. Their no-network/no-secrets contract applies to nested scripts. Local workspace artifacts only. Record expected red test proof before behavior, final pass counts, actual resolution paths and any failure. Do not download a tool or modify lockfiles to force a pass.

## Non-goals

No migrations, legacy readers, deprecations, compatibility wrappers, provider SDK upgrade, production payments, deployment, commit/push, destructive data cleanup, new UI, business policy values, or edits outside write_scope.

## Handoff

Return changed files, acceptance/test proof, remaining blockers or none, and lifecycle recommendation. Do not self-accept. Coordinator updates indexes and plan manifest under the frozen spec; content/spec changes require renewed readiness review and regenerated affected tickets. Evidence does not mutate approved contracts.
