---
id: "TICKET-001"
title: "Shared evidence and bounded decisions"
wave: 1
lifecycle: "accepted"
spec_manifest_digest: "sha256:b5323335237da8fac896a1d42efeac1df47f9438f48cebdc8241565ede67724f"
plan_manifest_digest: sha256:a5841b6d4849575fb90a1681653d8c765471386d3acfa5867fd50147d714c009
parallel_group: "decision-sequential-1"
depends_on: []
blocked_by: []
spec_refs:
  - "ai-harness/specs/37-decision-boundaries/03-contracts/decisions.md#CTR-DB-EVIDENCE"
  - "ai-harness/specs/37-decision-boundaries/03-contracts/decisions.md#CTR-DB-LIFECYCLE"
  - "ai-harness/specs/37-decision-boundaries/03-contracts/decisions.md#CTR-DB-IDENTITY"
  - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-FOUNDATION"
  - "ai-harness/specs/37-decision-boundaries/00-conventions.md#CONV-DB-STYLE"
traceability:
  requirement_ids:
    - "REQ-DB-FOUNDATION"
  capability_ids:
    - "CAP-DB-FOUNDATION"
  path_ids:
    - "PATH-DB-FOUNDATION-SUCCESS"
    - "PATH-DB-FOUNDATION-FAILURE"
    - "PATH-DB-FOUNDATION-RECOVERY"
  acceptance_ids:
    - "AC-DB-FOUNDATION-SUCCESS"
    - "AC-DB-FOUNDATION-FAILURE"
    - "AC-DB-FOUNDATION-RECOVERY"
write_scope:
  - "ai-harness/packages/harness/src/decisions"
  - "ai-harness/packages/harness/src/models/json.ts"
  - "ai-harness/packages/harness/src/harness/types.ts"
  - "ai-harness/packages/harness/src/tools/mcp"
  - "ai-harness/packages/harness/src/testing/replay.ts"
  - "ai-harness/packages/harness/test/replay.test.ts"
  - "ai-harness/packages/harness/test/public-api.test.ts"
  - "ai-harness/packages/harness/src/errors/catalog.ts"
  - "ai-harness/packages/harness/src/runtime/abort.ts"
  - "ai-harness/packages/harness/src/index.ts"
  - "ai-harness/packages/harness/type-tests/harness-typing.ts"
  - "ai-harness/packages/harness/vitest.config.ts"
read_scope:
  - "ai-harness/specs/37-decision-boundaries"
  - "ai-harness/AGENTS.md"
  - "ai-harness/.agent/IMPLEMENTATION.md"
  - "ai-harness/specs/02-harness-config.md"
  - "ai-harness/specs/13-public-api.md"
  - "ai-harness/specs/15-error-catalog.md"
  - "ai-harness/specs/16-testing.md"
  - "ai-harness/plans/decision-boundaries"
  - "ai-harness/packages/harness/src/decisions"
  - "ai-harness/packages/harness/src/models/json.ts"
  - "ai-harness/packages/harness/src/harness/types.ts"
  - "ai-harness/packages/harness/src/tools/mcp"
  - "ai-harness/packages/harness/src/testing/replay.ts"
  - "ai-harness/packages/harness/test/replay.test.ts"
  - "ai-harness/packages/harness/test/public-api.test.ts"
  - "ai-harness/packages/harness/src/errors/catalog.ts"
  - "ai-harness/packages/harness/src/runtime/abort.ts"
  - "ai-harness/packages/harness/src/index.ts"
  - "ai-harness/packages/harness/type-tests/harness-typing.ts"
  - "ai-harness/packages/harness/src"
  - "ai-harness/packages/harness/test"
  - "ai-harness/packages/harness/type-tests"
  - "ai-harness/scripts"
  - "ai-harness/package.json"
  - "ai-harness/package-lock.json"
  - "purista/AGENTS.md"
  - "purista/skills/purista/SKILL.md"
contract_readiness:
  status: "ready"
  required_contracts:
    - "CTR-DB-EVIDENCE"
    - "CTR-DB-LIFECYCLE"
    - "CTR-DB-IDENTITY"
  missing_contracts: []
generated_contracts:
  status: "source_derived_ready"
  source_refs:
    - "ai-harness/specs/37-decision-boundaries/03-contracts/generation-map.yaml"
  command_refs:
    - "CMD-FOUNDATION"
    - "CMD-CORE-TYPES"
    - "CMD-TYPE-TESTS"
  drift_command_refs:
    - "CMD-SPECS"
    - "CMD-PLAN"
ticket_readiness:
  status: "implementation_ready"
  open_decisions: []
  ambiguous_phrases: []
slice_type: "foundation_exception"
phase_gate_exception: true
representation_reuse:
  status: "ready"
  catalog_ref: "ai-harness/specs/37-decision-boundaries/03-contracts/representation-catalog.yaml"
  shape_refs:
    - "decision.source"
    - "decision.evidence"
    - "decision.occurrence"
    - "decision.execution-context"
    - "decision.evidence-input"
    - "decision.error"
  mapping_refs:
    - "MAP-DB-EVIDENCE"
    - "MAP-DB-CREATE-EVIDENCE"
    - "MAP-DB-ERROR"
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
  CMD-FOUNDATION:
    command: "npm --prefix ai-harness test --workspace @purista/harness -- src/decisions/decisions.test.ts src/tools/mcp test/mcp test/replay.test.ts"
    purpose: "requirement-scoped verification for FOUNDATION"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-CORE-TYPES:
    command: "npm --prefix ai-harness run typecheck --workspace @purista/harness"
    purpose: "requirement-scoped verification for FOUNDATION"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-TYPE-TESTS:
    command: "npm --prefix ai-harness run test:types --workspace @purista/harness"
    purpose: "requirement-scoped verification for FOUNDATION"
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
      - "ai-harness/packages/harness/src/decisions"
    command_refs:
      - "CMD-FOUNDATION"
    acceptance_refs: []
    expected_proof: "Canonical contracts and approved representation map matched before behavior edits."
  - id: "STEP-TEST"
    kind: "test"
    files:
      - "ai-harness/packages/harness/src/decisions"
    command_refs:
      - "CMD-FOUNDATION"
    acceptance_refs:
      - "ACC-FOUNDATION-SUCCESS"
      - "ACC-FOUNDATION-FAILURE"
      - "ACC-FOUNDATION-RECOVERY"
    expected_proof: "Named new regression assertions fail for their intended reason before implementation, or existing matching proof is recorded."
  - id: "STEP-IMPLEMENT"
    kind: "implement"
    files:
      - "ai-harness/packages/harness/src/decisions"
    command_refs: []
    acceptance_refs:
      - "ACC-FOUNDATION-SUCCESS"
      - "ACC-FOUNDATION-FAILURE"
      - "ACC-FOUNDATION-RECOVERY"
    expected_proof: "Create strict schemas and inferred records, public evidence factory, deterministic identity and one bounded callback executor in decisions/. Extend existing OperationTimeoutError scope, isJsonValue and exports. Replace duplicate MCP/replay JSON validators; harness/types.ts re-exports canonical JsonValue instead of declaring a second union. Leave policy reduction, tool orchestration and application review out of this module."
  - id: "STEP-VERIFY"
    kind: "verify"
    files:
      - "ai-harness/packages/harness/src/decisions"
    command_refs:
      - "CMD-FOUNDATION"
      - "CMD-CORE-TYPES"
      - "CMD-TYPE-TESTS"
    acceptance_refs:
      - "ACC-FOUNDATION-SUCCESS"
      - "ACC-FOUNDATION-FAILURE"
      - "ACC-FOUNDATION-RECOVERY"
    expected_proof: "All ticket commands pass and every acceptance row has exact test evidence."
  - id: "STEP-HANDOFF"
    kind: "handoff"
    files: []
    command_refs: []
    acceptance_refs: []
    expected_proof: "Evidence recorded; lifecycle implemented only; independent review required for accepted."
acceptance:
  - id: "ACC-FOUNDATION-SUCCESS"
    traceability_acceptance_ids:
      - "AC-DB-FOUNDATION-SUCCESS"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-FOUNDATION"
    test_refs:
      - "ai-harness/packages/harness/src/decisions/decisions.test.ts"
    command_refs:
      - "CMD-FOUNDATION"
      - "CMD-CORE-TYPES"
      - "CMD-TYPE-TESTS"
    expected_outcome: "Validated evidence and one bounded callback result"
    lifecycle: "accepted"
  - id: "ACC-FOUNDATION-FAILURE"
    traceability_acceptance_ids:
      - "AC-DB-FOUNDATION-FAILURE"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-FOUNDATION"
    test_refs:
      - "ai-harness/packages/harness/src/decisions/decisions.test.ts"
    command_refs:
      - "CMD-FOUNDATION"
      - "CMD-CORE-TYPES"
      - "CMD-TYPE-TESTS"
    expected_outcome: "Malformed output or expired/pre-aborted callback invokes no protected work"
    lifecycle: "accepted"
  - id: "ACC-FOUNDATION-RECOVERY"
    traceability_acceptance_ids:
      - "AC-DB-FOUNDATION-RECOVERY"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-FOUNDATION"
    test_refs:
      - "ai-harness/packages/harness/src/decisions/decisions.test.ts"
    command_refs:
      - "CMD-FOUNDATION"
      - "CMD-CORE-TYPES"
      - "CMD-TYPE-TESTS"
    expected_outcome: "Late callback resolution is fenced and listeners/timers return to baseline"
    lifecycle: "accepted"
---

# TICKET-001 — Shared evidence and bounded decisions

## Goal

Validated evidence and one bounded callback result. Covers CAP-DB-FOUNDATION and REQ-DB-FOUNDATION.

## Context Digest

Actor: SDK author and addon. Reachable entry: `createDecisionEvidence and runDecisionOperation`. Contracts: CTR-DB-EVIDENCE, CTR-DB-LIFECYCLE, CTR-DB-IDENTITY. Current source is evidence only; approved spec digest is authority. Preserve existing uncommitted work and preceding ticket changes. No runtime work was performed by this plan.

## Implementation Approach

Create strict schemas and inferred records, public evidence factory, deterministic identity and one bounded callback executor in decisions/. Extend existing OperationTimeoutError scope, isJsonValue and exports. Replace duplicate MCP/replay JSON validators; harness/types.ts re-exports canonical JsonValue instead of declaring a second union. Leave policy reduction, tool orchestration and application review out of this module.

## Decision Ledger

DEC-DB-CLEAN authorizes the exact breaking replacement, no compatibility/migration. DEC-DB-OWNERSHIP fixes module boundaries. Execute those decisions mechanically; only D0/D1 choices in CONV-DB-STYLE are permitted. No new public shape, dependency, policy behavior or business state may be invented.

## Action Plan

1. Read only declared read_scope relevant to this ticket. Check readiness/manifest and prerequisite lifecycle with CMD-SPECS/CMD-PLAN; record CMD-STATUS and baseline of existing ticket commands. New command files are tested after their test-first creation, not claimed to exist at baseline. **Phase Gate:** prerequisite approved spec and matching digests must be proven before edits.
2. Match the referenced contracts and representation entries to their source-schema owner. Author/adjust strict schemas and inferred aliases before runtime behavior. Generation source is `03-contracts/generation-map.yaml`; compiler emits declarations only through the existing build. Generic types and reducers are manual because no approved generator emits them. **Phase Gate:** review the source schemas and required negative type assertions against the spec before behavior implementation; complete compiler checks after the same owner ticket updates its call sites. No duplicate interface mirrors or compatibility overloads.
3. Extend the named tests before production behavior. Fixed identity tuples; unicode source IDs; distinct tool/child/retrieval occurrences; exact reason grammar; closed records; cyclic/non-JSON rejection without payload errors; pre-abort, expired deadline, late fulfillment/rejection, nested timeout classification and timer/listener cleanup. Assert public exports and no addon-internal import requirement. Record intended failing assertions or exact already-existing proof for each acceptance row. Fixtures use fake providers/clocks and synthetic data only.
4. Implement in write_scope: Create strict schemas and inferred records, public evidence factory, deterministic identity and one bounded callback executor in decisions/. Extend existing OperationTimeoutError scope, isJsonValue and exports. Replace duplicate MCP/replay JSON validators; harness/types.ts re-exports canonical JsonValue instead of declaring a second union. Leave policy reduction, tool orchestration and application review out of this module. Keep public TSDoc current. **Phase Gate:** affected boundary tests and type checks must pass before dependent runtime/consumer behavior is marked implemented. If an external declaration/config mismatch is encountered, record blocked evidence; do not suppress or install.
5. Run verification commands in their listed order, rerun CMD-SPECS/CMD-PLAN, inspect changed-file scope and duplicate implementations. Record exit codes, relevant test names, privacy/error/cancellation proof and generated-artifact checks. No acceptance based only on a submitted command or mocked substitute.
6. Write evidence under `ai-harness/plans/decision-boundaries/evidence/TICKET-001.md` through the coordinator handoff. Implementation agent reports implemented/partial/blocked; coordinator owns index/lifecycle and manifest updates. Independent review checks specs plus this action plan before accepted. **Phase Gate:** next ticket stays blocked until this ticket is accepted and its dependency/index pointers are reconciled.

## Requirements Traceability

REQ-DB-FOUNDATION; CAP-DB-FOUNDATION. Success/failure/recovery paths and acceptance IDs are exact frontmatter links to 00-traceability.yaml; no deferrals.

## Contract Traceability

ai-harness/specs/37-decision-boundaries/03-contracts/decisions.md#CTR-DB-EVIDENCE, ai-harness/specs/37-decision-boundaries/03-contracts/decisions.md#CTR-DB-LIFECYCLE, ai-harness/specs/37-decision-boundaries/03-contracts/decisions.md#CTR-DB-IDENTITY, ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-FOUNDATION, ai-harness/specs/37-decision-boundaries/00-conventions.md#CONV-DB-STYLE. Approved decisions.md plus its explicitly linked provider-continuation/review-execution documents define values, error semantics and sequences; no local reinterpretation.

## Spec Drift Controls

Reject changed manifest digests, missing prerequisites, unregistered shapes, altered timeout/approval semantics, raw content in evidence or old API fallbacks. Review against the exact REQ-DB-FOUNDATION, CTR-DB-EVIDENCE, CTR-DB-LIFECYCLE, CTR-DB-IDENTITY and frontmatter acceptance rows before acceptance. Missing behavior goes to readiness review as a blocker, never an implementation guess.

## Generator And Type Plan

Use approved generation-map: strict Zod definitions own non-generic runtime/TypeScript shape; infer aliases, compile with existing tsc, reuse existing declaration generation. Generic narrowing and lifecycle implementation are manual because repository generators do not emit them. Do not add YAML codegen. Build/check commands above own generated validation; no handwritten duplicate schemas/interfaces. No new package/version/dependency. Closed boundaries have no any, unchecked cast or open unknown result.

## Test-First Order

Fixed identity tuples; unicode source IDs; distinct tool/child/retrieval occurrences; exact reason grammar; closed records; cyclic/non-JSON rejection without payload errors; pre-abort, expired deadline, late fulfillment/rejection, nested timeout classification and timer/listener cleanup. Assert public exports and no addon-internal import requirement. Tests precede behavior; each success/failure/recovery acceptance row requires its exact assertion and command proof. Existing fixtures are extended; a new file is permitted only for a new module/checker or absent type-test seam. No live provider/credentials.

## Modularity And Reuse Plan

models/json.ts, runtime/abort.ts, errors/catalog.ts, existing ulid and crypto; no second JSON definition or timer class. Placement follows 00-file-structure.md and 00-module-boundaries.yaml. Extract only helpers consumed by the named boundaries, not a new abstraction hierarchy. No unrelated domain logic.

## Representation Reuse Plan

Catalog: `ai-harness/specs/37-decision-boundaries/03-contracts/representation-catalog.yaml`. Shapes: decision.source, decision.evidence, decision.occurrence, decision.execution-context, decision.evidence-input, decision.error. Mappings: MAP-DB-EVIDENCE, MAP-DB-CREATE-EVIDENCE, MAP-DB-ERROR. Extend those owners only; no second envelope or renamed mirror. New-shape decision: none.

## Slice Strategy

Foundation exception supplies shared primitives consumed by governance and addon; it is accepted only with behavioral executor/evidence tests and public type proof. Unblocks TICKET-002. No parallel writes: runtime builders, sessions and exports overlap across sequential tickets. Only read-only sidecar review is safe.

## Tasks

Execute STEP-PREFLIGHT, STEP-CONTRACT, STEP-TEST, STEP-IMPLEMENT, STEP-VERIFY and STEP-HANDOFF in order. Detailed edits and proof are in Action Plan, not discretionary work suggestions.

## Acceptance

Validated evidence and one bounded callback result. Malformed output or expired/pre-aborted callback invokes no protected work. Late callback resolution is fenced and listeners/timers return to baseline. Every structured acceptance row must pass; no silent partial completion.

## Acceptance Test Matrix

| Acceptance | Required assertion | Verification |
| --- | --- | --- |
| ACC-FOUNDATION-SUCCESS | Validated evidence and one bounded callback result | CMD-FOUNDATION, CMD-CORE-TYPES, CMD-TYPE-TESTS |
| ACC-FOUNDATION-FAILURE | Malformed output or expired/pre-aborted callback invokes no protected work | CMD-FOUNDATION, CMD-CORE-TYPES, CMD-TYPE-TESTS |
| ACC-FOUNDATION-RECOVERY | Late callback resolution is fenced and listeners/timers return to baseline | CMD-FOUNDATION, CMD-CORE-TYPES, CMD-TYPE-TESTS |

## End-To-End Definition Coverage

`02-capabilities/capability-inventory.md#CAP-DB-FOUNDATION` and `03-flows/e2e-coverage.md#REQ-DB-FOUNDATION` specify actor, trigger, entrypoint, state, effects, authorization, errors, recovery, observability, owner and terminal outcomes. This ticket proves that chain through `ai-harness/packages/harness/src/decisions/decisions.test.ts` and the matrix above. No additional UI/server surface is introduced.

## Operational Path Coverage

Cover all three PATH-DB-FOUNDATION paths. Safe reason/evidence and existing trace correlation, cancellation and idempotency follow the owning contract; no raw data logs. 04-nfr/requirements.md and 04-operations/runbook.md bind performance, integrity and release limits. External services, UI/a11y changes, dependency upgrades and production deployment are N/A, not simulated successes.

## Review And Verification Plan

Independent review checks spec/ticket/acceptance alignment, generated declarations, strict typing, module ownership, reuse, dead code and scope. Reject invented behavior, skipped failure/recovery coverage, avoidable casts, duplicate mappers/timers, hidden content leakage or old aliases. A required failed command blocks acceptance even if baseline failure is unrelated; record exact blocker and ask the coordinator for bounded remediation scope.

## Verification

Run CMD-SPECS, CMD-PLAN, CMD-STATUS, CMD-FOUNDATION, CMD-CORE-TYPES, CMD-TYPE-TESTS. Commands are from workspace root and use installed tools. Their no-network/no-secrets contract applies to nested scripts. Local workspace artifacts only. Record expected red test proof before behavior, final pass counts, actual resolution paths and any failure. Do not download a tool or modify lockfiles to force a pass.

## Non-goals

No migrations, legacy readers, deprecations, compatibility wrappers, provider SDK upgrade, production payments, deployment, commit/push, destructive data cleanup, new UI, business policy values, or edits outside write_scope.

## Handoff

Return changed files, acceptance/test proof, remaining blockers or none, and lifecycle recommendation. Do not self-accept. Coordinator updates indexes and plan manifest under the frozen spec; content/spec changes require renewed readiness review and regenerated affected tickets. Evidence does not mutate approved contracts.
