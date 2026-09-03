---
id: "TICKET-010"
title: "Clean cut and complete verification"
wave: 10
lifecycle: "accepted"
spec_manifest_digest: "sha256:b5323335237da8fac896a1d42efeac1df47f9438f48cebdc8241565ede67724f"
plan_manifest_digest: sha256:a5841b6d4849575fb90a1681653d8c765471386d3acfa5867fd50147d714c009
parallel_group: "decision-sequential-10"
depends_on:
  - "TICKET-007"
blocked_by: []
spec_refs:
  - "ai-harness/specs/37-decision-boundaries/04-delivery/clean-cut.md#CTR-DB-CLEANUP"
  - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-CLEANUP"
  - "ai-harness/specs/37-decision-boundaries/00-conventions.md#CONV-DB-STYLE"
traceability:
  requirement_ids:
    - "REQ-DB-CLEANUP"
  capability_ids:
    - "CAP-DB-CLEANUP"
  path_ids:
    - "PATH-DB-CLEANUP-SUCCESS"
    - "PATH-DB-CLEANUP-FAILURE"
    - "PATH-DB-CLEANUP-RECOVERY"
  acceptance_ids:
    - "AC-DB-CLEANUP-SUCCESS"
    - "AC-DB-CLEANUP-FAILURE"
    - "AC-DB-CLEANUP-RECOVERY"
write_scope:
  - "ai-harness/scripts/check-decision-boundaries.mjs"
  - "ai-harness/scripts/check-decision-boundaries.test.mjs"
  - "ai-harness/scripts/verify-decision-consumers.mjs"
  - "ai-harness/scripts/verify-decision-consumers.test.mjs"
  - "ai-harness/scripts/package-boundaries.mjs"
  - "ai-harness/scripts/package-boundaries.test.mjs"
  - "ai-harness/scripts/verify-capability-catalog.mjs"
  - "ai-harness/package.json"
  - "ai-harness/architecture"
  - "ai-harness/docs"
  - "ai-harness/packages"
  - "ai-harness/examples"
  - "ai-harness/skills"
  - "purista/packages/core/src/AgentQueueBuilder"
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
  - "ai-harness/scripts/check-decision-boundaries.mjs"
  - "ai-harness/scripts/check-decision-boundaries.test.mjs"
  - "ai-harness/scripts/verify-decision-consumers.mjs"
  - "ai-harness/scripts/verify-decision-consumers.test.mjs"
  - "ai-harness/scripts/package-boundaries.mjs"
  - "ai-harness/scripts/package-boundaries.test.mjs"
  - "ai-harness/scripts/verify-capability-catalog.mjs"
  - "ai-harness/package.json"
  - "ai-harness/architecture"
  - "ai-harness/docs"
  - "ai-harness/packages"
  - "ai-harness/examples"
  - "ai-harness/skills"
  - "purista/packages/core/src/AgentQueueBuilder"
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
    - "CTR-DB-CLEANUP"
  missing_contracts: []
generated_contracts:
  status: "source_derived_ready"
  source_refs:
    - "ai-harness/specs/37-decision-boundaries/03-contracts/generation-map.yaml"
  command_refs:
    - "CMD-SCAN-TEST"
    - "CMD-SCAN"
    - "CMD-ARCHITECTURE"
    - "CMD-BUILD"
    - "CMD-LINT"
    - "CMD-ALL-TESTS"
    - "CMD-COVERAGE"
    - "CMD-TYPE-TESTS"
    - "CMD-CONTRACTS"
    - "CMD-INTEGRATION"
    - "CMD-FAILURE"
    - "CMD-CONSUMERS"
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
    - "governance.result"
    - "provider.continuation"
    - "rail.outcome"
    - "wait.resolved"
    - "review.execution"
  mapping_refs:
    - "MAP-DB-EVENT"
    - "MAP-DB-HISTORY"
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
  CMD-SCAN-TEST:
    command: "node --test ai-harness/scripts/check-decision-boundaries.test.mjs"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-SCAN:
    command: "node ai-harness/scripts/check-decision-boundaries.mjs"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-ARCHITECTURE:
    command: "npm --prefix ai-harness run verify:architecture"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-BUILD:
    command: "env CARGO_NET_OFFLINE=true npm --prefix ai-harness run build"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-LINT:
    command: "npm --prefix ai-harness run lint"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-ALL-TESTS:
    command: "npm --prefix ai-harness test"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-COVERAGE:
    command: "npm --prefix ai-harness run test:coverage"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-TYPE-TESTS:
    command: "npm --prefix ai-harness run test:types --workspace @purista/harness"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-CONTRACTS:
    command: "npm --prefix ai-harness run test:contracts"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-INTEGRATION:
    command: "npm --prefix ai-harness run test:integration"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-FAILURE:
    command: "npm --prefix ai-harness run test:failure"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-CONSUMERS:
    command: "node ai-harness/scripts/verify-decision-consumers.mjs --check"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-SKILLS:
    command: "npm --prefix purista run audit:skills"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-KNOWLEDGE:
    command: "npm --prefix purista run audit:knowledge"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-HANDBOOK:
    command: "npm --prefix purista run audit:handbook"
    purpose: "requirement-scoped verification for CLEANUP"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-API-DOCS:
    command: "npm --prefix purista run audit:api-docs"
    purpose: "requirement-scoped verification for CLEANUP"
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
      - "ai-harness/scripts/check-decision-boundaries.mjs"
    command_refs:
      - "CMD-SCAN-TEST"
    acceptance_refs: []
    expected_proof: "Canonical contracts and approved representation map matched before behavior edits."
  - id: "STEP-TEST"
    kind: "test"
    files:
      - "ai-harness/scripts/check-decision-boundaries.mjs"
    command_refs:
      - "CMD-SCAN-TEST"
    acceptance_refs:
      - "ACC-CLEANUP-SUCCESS"
      - "ACC-CLEANUP-FAILURE"
      - "ACC-CLEANUP-RECOVERY"
    expected_proof: "Named new regression assertions fail for their intended reason before implementation, or existing matching proof is recorded."
  - id: "STEP-IMPLEMENT"
    kind: "implement"
    files:
      - "ai-harness/scripts/check-decision-boundaries.mjs"
    command_refs: []
    acceptance_refs:
      - "ACC-CLEANUP-SUCCESS"
      - "ACC-CLEANUP-FAILURE"
      - "ACC-CLEANUP-RECOVERY"
    expected_proof: "Add exact scoped removed-symbol/private-import/duplicate-helper checker with tests and wire it into existing architecture gate. Remove remaining dead old surfaces, duplicate reducers/mappers/timers/validators and obsolete tests within the touched decision-boundary modules only. Refresh existing generated artifacts, exports and catalog. Broad package paths are a mechanical removal exception, not permission to alter unrelated sandbox/memory/evaluation work. Add concise breaking-change inventory and full end-to-end proof; zero compatibility paths."
  - id: "STEP-VERIFY"
    kind: "verify"
    files:
      - "ai-harness/scripts/check-decision-boundaries.mjs"
    command_refs:
      - "CMD-SCAN-TEST"
      - "CMD-SCAN"
      - "CMD-ARCHITECTURE"
      - "CMD-BUILD"
      - "CMD-LINT"
      - "CMD-ALL-TESTS"
      - "CMD-COVERAGE"
      - "CMD-TYPE-TESTS"
      - "CMD-CONTRACTS"
      - "CMD-INTEGRATION"
      - "CMD-FAILURE"
      - "CMD-CONSUMERS"
      - "CMD-SKILLS"
      - "CMD-KNOWLEDGE"
      - "CMD-HANDBOOK"
      - "CMD-API-DOCS"
    acceptance_refs:
      - "ACC-CLEANUP-SUCCESS"
      - "ACC-CLEANUP-FAILURE"
      - "ACC-CLEANUP-RECOVERY"
    expected_proof: "All ticket commands pass and every acceptance row has exact test evidence."
  - id: "STEP-HANDOFF"
    kind: "handoff"
    files: []
    command_refs: []
    acceptance_refs: []
    expected_proof: "Evidence recorded; lifecycle implemented only; independent review required for accepted."
acceptance:
  - id: "ACC-CLEANUP-SUCCESS"
    traceability_acceptance_ids:
      - "AC-DB-CLEANUP-SUCCESS"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-CLEANUP"
    test_refs:
      - "ai-harness/scripts/check-decision-boundaries.mjs"
    command_refs:
      - "CMD-SCAN-TEST"
      - "CMD-SCAN"
      - "CMD-ARCHITECTURE"
      - "CMD-BUILD"
      - "CMD-LINT"
      - "CMD-ALL-TESTS"
      - "CMD-COVERAGE"
      - "CMD-TYPE-TESTS"
      - "CMD-CONTRACTS"
      - "CMD-INTEGRATION"
      - "CMD-FAILURE"
      - "CMD-CONSUMERS"
      - "CMD-SKILLS"
      - "CMD-KNOWLEDGE"
      - "CMD-HANDBOOK"
      - "CMD-API-DOCS"
    expected_outcome: "All changed consumers and package exports pass no-drift gates"
    lifecycle: "accepted"
  - id: "ACC-CLEANUP-FAILURE"
    traceability_acceptance_ids:
      - "AC-DB-CLEANUP-FAILURE"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-CLEANUP"
    test_refs:
      - "ai-harness/scripts/check-decision-boundaries.mjs"
    command_refs:
      - "CMD-SCAN-TEST"
      - "CMD-SCAN"
      - "CMD-ARCHITECTURE"
      - "CMD-BUILD"
      - "CMD-LINT"
      - "CMD-ALL-TESTS"
      - "CMD-COVERAGE"
      - "CMD-TYPE-TESTS"
      - "CMD-CONTRACTS"
      - "CMD-INTEGRATION"
      - "CMD-FAILURE"
      - "CMD-CONSUMERS"
      - "CMD-SKILLS"
      - "CMD-KNOWLEDGE"
      - "CMD-HANDBOOK"
      - "CMD-API-DOCS"
    expected_outcome: "Removed names duplicate timers and unsafe projections fail static gate"
    lifecycle: "accepted"
  - id: "ACC-CLEANUP-RECOVERY"
    traceability_acceptance_ids:
      - "AC-DB-CLEANUP-RECOVERY"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-CLEANUP"
    test_refs:
      - "ai-harness/scripts/check-decision-boundaries.mjs"
    command_refs:
      - "CMD-SCAN-TEST"
      - "CMD-SCAN"
      - "CMD-ARCHITECTURE"
      - "CMD-BUILD"
      - "CMD-LINT"
      - "CMD-ALL-TESTS"
      - "CMD-COVERAGE"
      - "CMD-TYPE-TESTS"
      - "CMD-CONTRACTS"
      - "CMD-INTEGRATION"
      - "CMD-FAILURE"
      - "CMD-CONSUMERS"
      - "CMD-SKILLS"
      - "CMD-KNOWLEDGE"
      - "CMD-HANDBOOK"
      - "CMD-API-DOCS"
    expected_outcome: "No destructive reset no old reader no compatibility mode is introduced"
    lifecycle: "accepted"
---

# TICKET-010 — Clean cut and complete verification

## Goal

All changed consumers and package exports pass no-drift gates. Covers CAP-DB-CLEANUP and REQ-DB-CLEANUP.

## Context Digest

Actor: maintainer and independent reviewer. Reachable entry: `workspace verification and removal inventory`. Contracts: CTR-DB-CLEANUP. Current source is evidence only; approved spec digest is authority. Preserve existing uncommitted work and preceding ticket changes. Implementation is underway; current lifecycle and evidence are in the plan indexes.

## Implementation Approach

Add exact scoped removed-symbol/private-import/duplicate-helper checker with tests and wire it into existing architecture gate. Remove remaining dead old surfaces, duplicate reducers/mappers/timers/validators and obsolete tests within the touched decision-boundary modules only. Refresh existing generated artifacts, exports and catalog. Broad package paths are a mechanical removal exception, not permission to alter unrelated sandbox/memory/evaluation work. Add concise breaking-change inventory and full end-to-end proof; zero compatibility paths.

## Decision Ledger

DEC-DB-CLEAN authorizes the exact breaking replacement, no compatibility/migration. DEC-DB-OWNERSHIP fixes module boundaries. Execute those decisions mechanically; only D0/D1 choices in CONV-DB-STYLE are permitted. No new public shape, dependency, policy behavior or business state may be invented.

## Action Plan

1. Read only declared read_scope relevant to this ticket. Check readiness/manifest and prerequisite lifecycle with CMD-SPECS/CMD-PLAN; record CMD-STATUS and baseline of existing ticket commands. New command files are tested after their test-first creation, not claimed to exist at baseline. **Phase Gate:** prerequisite TICKET-007 and matching digests must be proven before edits. The checker may be implemented while independent documentation and consumer work finishes. TICKET-008 and TICKET-009 acceptance remains mandatory before TICKET-010 can be accepted; unrelated consumer compilation failures remain required blockers, not an implied acceptance exception.
2. Match the referenced contracts and representation entries to their source-schema owner. Author/adjust strict schemas and inferred aliases before runtime behavior. Generation source is `03-contracts/generation-map.yaml`; compiler emits declarations only through the existing build. Generic types and reducers are manual because no approved generator emits them. **Phase Gate:** review the source schemas and required negative type assertions against the spec before behavior implementation; complete compiler checks after the same owner ticket updates its call sites. No duplicate interface mirrors or compatibility overloads.
3. Extend the named tests before production behavior. Scanner negative fixtures for each named removed surface; public export/runtime config rejection; full Harness/provider/addon/example regression, type/build/contracts/failure/integration/coverage; consumer checks and PURISTA audits. Verify sentinel privacy, no legacy reader/alias, no duplicate timer/schema/mapper and no untracked generated artifacts. Required red gates remain blockers; no skipping tests or suppressing declaration errors. Record intended failing assertions or exact already-existing proof for each acceptance row. Fixtures use fake providers/clocks and synthetic data only.
4. Implement in write_scope: Add exact scoped removed-symbol/private-import/duplicate-helper checker with tests and wire it into existing architecture gate. Remove remaining dead old surfaces, duplicate reducers/mappers/timers/validators and obsolete tests within the touched decision-boundary modules only. Refresh existing generated artifacts, exports and catalog. Broad package paths are a mechanical removal exception, not permission to alter unrelated sandbox/memory/evaluation work. Add concise breaking-change inventory and full end-to-end proof; zero compatibility paths. Keep public TSDoc current. **Phase Gate:** affected boundary tests and type checks must pass before dependent runtime/consumer behavior is marked implemented. If an external declaration/config mismatch is encountered, record blocked evidence; do not suppress or install.
5. Run verification commands in their listed order, rerun CMD-SPECS/CMD-PLAN, inspect changed-file scope and duplicate implementations. Record exit codes, relevant test names, privacy/error/cancellation proof and generated-artifact checks. No acceptance based only on a submitted command or mocked substitute.
6. Write evidence under `ai-harness/plans/decision-boundaries/evidence/TICKET-010.md` through the coordinator handoff. Implementation agent reports implemented/partial/blocked; coordinator owns index/lifecycle and manifest updates. Independent review checks specs plus this action plan before accepted. **Phase Gate:** next ticket stays blocked until this ticket is accepted and its dependency/index pointers are reconciled.

## Requirements Traceability

REQ-DB-CLEANUP; CAP-DB-CLEANUP. Success/failure/recovery paths and acceptance IDs are exact frontmatter links to 00-traceability.yaml; no deferrals.

## Contract Traceability

ai-harness/specs/37-decision-boundaries/04-delivery/clean-cut.md#CTR-DB-CLEANUP, ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-CLEANUP, ai-harness/specs/37-decision-boundaries/00-conventions.md#CONV-DB-STYLE. Approved decisions.md plus its explicitly linked provider-continuation/review-execution documents define values, error semantics and sequences; no local reinterpretation.

## Spec Drift Controls

Reject changed manifest digests, missing prerequisites, unregistered shapes, altered timeout/approval semantics, raw content in evidence or old API fallbacks. Review against the exact REQ-DB-CLEANUP, CTR-DB-CLEANUP and frontmatter acceptance rows before acceptance. Missing behavior goes to readiness review as a blocker, never an implementation guess.

## Generator And Type Plan

Use approved generation-map: strict Zod definitions own non-generic runtime/TypeScript shape; infer aliases, compile with existing tsc, reuse existing declaration generation. Generic narrowing and lifecycle implementation are manual because repository generators do not emit them. Do not add YAML codegen. Build/check commands above own generated validation; no handwritten duplicate schemas/interfaces. No new package/version/dependency. Closed boundaries have no any, unchecked cast or open unknown result.

## Test-First Order

Scanner negative fixtures for each named removed surface; public export/runtime config rejection; full Harness/provider/addon/example regression, type/build/contracts/failure/integration/coverage; consumer checks and PURISTA audits. Verify sentinel privacy, no legacy reader/alias, no duplicate timer/schema/mapper and no untracked generated artifacts. Required red gates remain blockers; no skipping tests or suppressing declaration errors. Tests precede behavior; each success/failure/recovery acceptance row requires its exact assertion and command proof. Existing fixtures are extended; a new file is permitted only for a new module/checker or absent type-test seam. No live provider/credentials.

## Modularity And Reuse Plan

Existing architecture/package boundary/catalog checks, test fakes and builds; no new runtime module in cleanup. Placement follows 00-file-structure.md and 00-module-boundaries.yaml. Extract only helpers consumed by the named boundaries, not a new abstraction hierarchy. No unrelated domain logic.

## Representation Reuse Plan

Catalog: `ai-harness/specs/37-decision-boundaries/03-contracts/representation-catalog.yaml`. Shapes: decision.evidence, governance.result, provider.continuation, rail.outcome, wait.resolved, review.execution. Mappings: MAP-DB-EVENT, MAP-DB-HISTORY, MAP-DB-CLAIM. Extend those owners only; no second envelope or renamed mirror. New-shape decision: none.

## Slice Strategy

Refactor exception spans one inseparable public boundary and its call sites; phase gates prohibit moving downstream before the changed boundary has proof. Unblocks final completion review. No parallel writes: runtime builders, sessions and exports overlap across sequential tickets. The scanner writer is isolated to scripts/package metadata; owner-ticket runtime repairs and documentation may proceed without overlapping writes. Final acceptance still requires TICKET-008 and TICKET-009.

## Tasks

Execute STEP-PREFLIGHT, STEP-CONTRACT, STEP-TEST, STEP-IMPLEMENT, STEP-VERIFY and STEP-HANDOFF in order. Detailed edits and proof are in Action Plan, not discretionary work suggestions.

## Acceptance

All changed consumers and package exports pass no-drift gates. Removed names duplicate timers and unsafe projections fail static gate. No destructive reset no old reader no compatibility mode is introduced. Every structured acceptance row must pass; no silent partial completion.

## Acceptance Test Matrix

| Acceptance | Required assertion | Verification |
| --- | --- | --- |
| ACC-CLEANUP-SUCCESS | All changed consumers and package exports pass no-drift gates | CMD-SCAN-TEST, CMD-SCAN, CMD-ARCHITECTURE, CMD-BUILD, CMD-LINT, CMD-ALL-TESTS, CMD-COVERAGE, CMD-TYPE-TESTS, CMD-CONTRACTS, CMD-INTEGRATION, CMD-FAILURE, CMD-CONSUMERS, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK, CMD-API-DOCS |
| ACC-CLEANUP-FAILURE | Removed names duplicate timers and unsafe projections fail static gate | CMD-SCAN-TEST, CMD-SCAN, CMD-ARCHITECTURE, CMD-BUILD, CMD-LINT, CMD-ALL-TESTS, CMD-COVERAGE, CMD-TYPE-TESTS, CMD-CONTRACTS, CMD-INTEGRATION, CMD-FAILURE, CMD-CONSUMERS, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK, CMD-API-DOCS |
| ACC-CLEANUP-RECOVERY | No destructive reset no old reader no compatibility mode is introduced | CMD-SCAN-TEST, CMD-SCAN, CMD-ARCHITECTURE, CMD-BUILD, CMD-LINT, CMD-ALL-TESTS, CMD-COVERAGE, CMD-TYPE-TESTS, CMD-CONTRACTS, CMD-INTEGRATION, CMD-FAILURE, CMD-CONSUMERS, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK, CMD-API-DOCS |

## End-To-End Definition Coverage

`02-capabilities/capability-inventory.md#CAP-DB-CLEANUP` and `03-flows/e2e-coverage.md#REQ-DB-CLEANUP` specify actor, trigger, entrypoint, state, effects, authorization, errors, recovery, observability, owner and terminal outcomes. This ticket proves that chain through `ai-harness/scripts/check-decision-boundaries.mjs` and the matrix above. No additional UI/server surface is introduced.

## Operational Path Coverage

Cover all three PATH-DB-CLEANUP paths. Safe reason/evidence and existing trace correlation, cancellation and idempotency follow the owning contract; no raw data logs. 04-nfr/requirements.md and 04-operations/runbook.md bind performance, integrity and release limits. External services, UI/a11y changes, dependency upgrades and production deployment are N/A, not simulated successes.

## Review And Verification Plan

Independent review checks spec/ticket/acceptance alignment, generated declarations, strict typing, module ownership, reuse, dead code and scope. Reject invented behavior, skipped failure/recovery coverage, avoidable casts, duplicate mappers/timers, hidden content leakage or old aliases. A required failed command blocks acceptance even if baseline failure is unrelated; record exact blocker and ask the coordinator for bounded remediation scope.

## Verification

Run CMD-SPECS, CMD-PLAN, CMD-STATUS, CMD-SCAN-TEST, CMD-SCAN, CMD-ARCHITECTURE, CMD-BUILD, CMD-LINT, CMD-ALL-TESTS, CMD-COVERAGE, CMD-TYPE-TESTS, CMD-CONTRACTS, CMD-INTEGRATION, CMD-FAILURE, CMD-CONSUMERS, CMD-SKILLS, CMD-KNOWLEDGE, CMD-HANDBOOK, CMD-API-DOCS. Commands are from workspace root and use installed tools. Their no-network/no-secrets contract applies to nested scripts. Local workspace artifacts only. Record expected red test proof before behavior, final pass counts, actual resolution paths and any failure. Do not download a tool or modify lockfiles to force a pass.

## Non-goals

No migrations, legacy readers, deprecations, compatibility wrappers, provider SDK upgrade, production payments, deployment, commit/push, destructive data cleanup, new UI, business policy values, or edits outside write_scope.

## Handoff

Return changed files, acceptance/test proof, remaining blockers or none, and lifecycle recommendation. Do not self-accept. Coordinator updates indexes and plan manifest under the frozen spec; content/spec changes require renewed readiness review and regenerated affected tickets. Evidence does not mutate approved contracts.
