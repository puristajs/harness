---
id: "TICKET-006"
title: "Strict wait schemas and terminal return"
wave: 6
lifecycle: "accepted"
spec_manifest_digest: "sha256:b5323335237da8fac896a1d42efeac1df47f9438f48cebdc8241565ede67724f"
plan_manifest_digest: sha256:a5841b6d4849575fb90a1681653d8c765471386d3acfa5867fd50147d714c009
parallel_group: "decision-sequential-6"
depends_on:
  - "TICKET-005"
blocked_by: []
spec_refs:
  - "ai-harness/specs/37-decision-boundaries/03-contracts/decisions.md#CTR-DB-WAITS"
  - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-WAITS"
  - "ai-harness/specs/37-decision-boundaries/00-conventions.md#CONV-DB-STYLE"
traceability:
  requirement_ids:
    - "REQ-DB-WAITS"
  capability_ids:
    - "CAP-DB-WAITS"
  path_ids:
    - "PATH-DB-WAITS-SUCCESS"
    - "PATH-DB-WAITS-FAILURE"
    - "PATH-DB-WAITS-RECOVERY"
  acceptance_ids:
    - "AC-DB-WAITS-SUCCESS"
    - "AC-DB-WAITS-FAILURE"
    - "AC-DB-WAITS-RECOVERY"
write_scope:
  - "ai-harness/packages/harness/src/storage"
  - "ai-harness/packages/harness/src/sessions/index.ts"
  - "ai-harness/packages/harness/src/harness/defineHarness.ts"
  - "ai-harness/packages/harness/src/errors/catalog.ts"
  - "ai-harness/packages/harness/src/testing"
  - "ai-harness/packages/harness/src/index.ts"
  - "ai-harness/packages/harness/test/durable-external-wait.test.ts"
  - "ai-harness/packages/harness/test/local-durable-execution.test.ts"
  - "ai-harness/packages/harness/type-tests/harness-typing.ts"
read_scope:
  - "ai-harness/specs/37-decision-boundaries"
  - "ai-harness/AGENTS.md"
  - "ai-harness/.agent/IMPLEMENTATION.md"
  - "ai-harness/specs/02-harness-config.md"
  - "ai-harness/specs/13-public-api.md"
  - "ai-harness/specs/15-error-catalog.md"
  - "ai-harness/specs/16-testing.md"
  - "ai-harness/plans/decision-boundaries"
  - "ai-harness/packages/harness/src/storage"
  - "ai-harness/packages/harness/src/sessions/index.ts"
  - "ai-harness/packages/harness/src/harness/defineHarness.ts"
  - "ai-harness/packages/harness/src/errors/catalog.ts"
  - "ai-harness/packages/harness/src/testing"
  - "ai-harness/packages/harness/src/index.ts"
  - "ai-harness/packages/harness/test/durable-external-wait.test.ts"
  - "ai-harness/packages/harness/test/local-durable-execution.test.ts"
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
    - "CTR-DB-WAITS"
  missing_contracts: []
generated_contracts:
  status: "source_derived_ready"
  source_refs:
    - "ai-harness/specs/37-decision-boundaries/03-contracts/generation-map.yaml"
  command_refs:
    - "CMD-WAITS"
    - "CMD-CONTRACTS"
    - "CMD-CORE-TYPES"
    - "CMD-TYPE-TESTS"
  drift_command_refs:
    - "CMD-SPECS"
    - "CMD-PLAN"
ticket_readiness:
  status: "implementation_ready"
  open_decisions: []
  ambiguous_phrases: []
slice_type: "vertical_slice"
phase_gate_exception: true
representation_reuse:
  status: "ready"
  catalog_ref: "ai-harness/specs/37-decision-boundaries/03-contracts/representation-catalog.yaml"
  shape_refs:
    - "wait.request"
    - "wait.snapshot"
    - "wait.resolved"
    - "wait.signal"
  mapping_refs:
    - "MAP-DB-WAIT"
    - "MAP-DB-RESOLVED"
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
  CMD-WAITS:
    command: "npm --prefix ai-harness test --workspace @purista/harness -- test/durable-external-wait.test.ts src/storage/storage-contract.test.ts src/storage/in-memory.test.ts test/local-durable-execution.test.ts"
    purpose: "requirement-scoped verification for WAITS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-CONTRACTS:
    command: "npm --prefix ai-harness run test:contracts"
    purpose: "requirement-scoped verification for WAITS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-CORE-TYPES:
    command: "npm --prefix ai-harness run typecheck --workspace @purista/harness"
    purpose: "requirement-scoped verification for WAITS"
    expected: "pass"
    network: "forbidden"
    writes: "workspace_only"
    secrets: "forbidden"
  CMD-TYPE-TESTS:
    command: "npm --prefix ai-harness run test:types --workspace @purista/harness"
    purpose: "requirement-scoped verification for WAITS"
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
      - "ai-harness/packages/harness/src/storage"
    command_refs:
      - "CMD-WAITS"
    acceptance_refs: []
    expected_proof: "Canonical contracts and approved representation map matched before behavior edits."
  - id: "STEP-TEST"
    kind: "test"
    files:
      - "ai-harness/packages/harness/src/storage"
    command_refs:
      - "CMD-WAITS"
    acceptance_refs:
      - "ACC-WAITS-SUCCESS"
      - "ACC-WAITS-FAILURE"
      - "ACC-WAITS-RECOVERY"
    expected_proof: "Named new regression assertions fail for their intended reason before implementation, or existing matching proof is recorded."
  - id: "STEP-IMPLEMENT"
    kind: "implement"
    files:
      - "ai-harness/packages/harness/src/storage"
    command_refs: []
    acceptance_refs:
      - "ACC-WAITS-SUCCESS"
      - "ACC-WAITS-FAILURE"
      - "ACC-WAITS-RECOVERY"
    expected_proof: "Make external-wait.ts own strict request/signal/snapshot/registration schemas and inferred terminal subset. Validate before telemetry/storage and validate adapter snapshots before events. Change workflow wait return type to ExternalWaitResolved; retain pending exception and full storage union. In-memory and SQLite use explicit identical projections and shared validation, including get/cancel IDs and clock/observedAt rules; preserve storage tables and transactions."
  - id: "STEP-VERIFY"
    kind: "verify"
    files:
      - "ai-harness/packages/harness/src/storage"
    command_refs:
      - "CMD-WAITS"
      - "CMD-CONTRACTS"
      - "CMD-CORE-TYPES"
      - "CMD-TYPE-TESTS"
    acceptance_refs:
      - "ACC-WAITS-SUCCESS"
      - "ACC-WAITS-FAILURE"
      - "ACC-WAITS-RECOVERY"
    expected_proof: "All ticket commands pass and every acceptance row has exact test evidence."
  - id: "STEP-HANDOFF"
    kind: "handoff"
    files: []
    command_refs: []
    acceptance_refs: []
    expected_proof: "Evidence recorded; lifecycle implemented only; independent review required for accepted."
acceptance:
  - id: "ACC-WAITS-SUCCESS"
    traceability_acceptance_ids:
      - "AC-DB-WAITS-SUCCESS"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-WAITS"
    test_refs:
      - "ai-harness/packages/harness/test/durable-external-wait.test.ts"
    command_refs:
      - "CMD-WAITS"
      - "CMD-CONTRACTS"
      - "CMD-CORE-TYPES"
      - "CMD-TYPE-TESTS"
    expected_outcome: "Registration readback and terminal results use exact canonical shape"
    lifecycle: "accepted"
  - id: "ACC-WAITS-FAILURE"
    traceability_acceptance_ids:
      - "AC-DB-WAITS-FAILURE"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-WAITS"
    test_refs:
      - "ai-harness/packages/harness/test/durable-external-wait.test.ts"
    command_refs:
      - "CMD-WAITS"
      - "CMD-CONTRACTS"
      - "CMD-CORE-TYPES"
      - "CMD-TYPE-TESTS"
    expected_outcome: "Missing extra invalid fields rejected before telemetry or persistence"
    lifecycle: "accepted"
  - id: "ACC-WAITS-RECOVERY"
    traceability_acceptance_ids:
      - "AC-DB-WAITS-RECOVERY"
    requirement_refs:
      - "ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-WAITS"
    test_refs:
      - "ai-harness/packages/harness/test/durable-external-wait.test.ts"
    command_refs:
      - "CMD-WAITS"
      - "CMD-CONTRACTS"
      - "CMD-CORE-TYPES"
      - "CMD-TYPE-TESTS"
    expected_outcome: "Duplicate and late signals retain current terminal state and replay semantics"
    lifecycle: "accepted"
---

# TICKET-006 — Strict wait schemas and terminal return

## Goal

Registration readback and terminal results use exact canonical shape. Covers CAP-DB-WAITS and REQ-DB-WAITS.

## Context Digest

Actor: durable workflow and storage adapter. Reachable entry: `externalWait.wait registerWait signalWait`. Contracts: CTR-DB-WAITS. Current source is evidence only; approved spec digest is authority. Preserve existing uncommitted work and preceding ticket changes. No runtime work was performed by this plan.

## Implementation Approach

Make external-wait.ts own strict request/signal/snapshot/registration schemas and inferred terminal subset. Validate before telemetry/storage and validate adapter snapshots before events. Change workflow wait return type to ExternalWaitResolved; retain pending exception and full storage union. In-memory and SQLite use explicit identical projections and shared validation, including get/cancel IDs and clock/observedAt rules; preserve storage tables and transactions.

## Decision Ledger

DEC-DB-CLEAN authorizes the exact breaking replacement, no compatibility/migration. DEC-DB-OWNERSHIP fixes module boundaries. Execute those decisions mechanically; only D0/D1 choices in CONV-DB-STYLE are permitted. No new public shape, dependency, policy behavior or business state may be invented.

## Action Plan

1. Read only declared read_scope relevant to this ticket. Check readiness/manifest and prerequisite lifecycle with CMD-SPECS/CMD-PLAN; record CMD-STATUS and baseline of existing ticket commands. New command files are tested after their test-first creation, not claimed to exist at baseline. **Phase Gate:** prerequisite TICKET-005 and matching digests must be proven before edits.
2. Match the referenced contracts and representation entries to their source-schema owner. Author/adjust strict schemas and inferred aliases before runtime behavior. Generation source is `03-contracts/generation-map.yaml`; compiler emits declarations only through the existing build. Generic types and reducers are manual because no approved generator emits them. **Phase Gate:** review the source schemas and required negative type assertions against the spec before behavior implementation; complete compiler checks after the same owner ticket updates its call sites. No duplicate interface mirrors or compatibility overloads.
3. Extend the named tests before production behavior. Missing/extra/malformed IDs/timestamps/outcomes; invalid get/cancel args; missing terminal eventId except autoexpiry; invalid adapter snapshot before event; exact initial/readback parity excluding binding IDs; now==deadline; observedAt cannot revive; duplicate/late signals unchanged; terminal type narrowing; lease release/replay and existing storage contract suite. Record intended failing assertions or exact already-existing proof for each acceptance row. Fixtures use fake providers/clocks and synthetic data only.
4. Implement in write_scope: Make external-wait.ts own strict request/signal/snapshot/registration schemas and inferred terminal subset. Validate before telemetry/storage and validate adapter snapshots before events. Change workflow wait return type to ExternalWaitResolved; retain pending exception and full storage union. In-memory and SQLite use explicit identical projections and shared validation, including get/cancel IDs and clock/observedAt rules; preserve storage tables and transactions. Keep public TSDoc current. **Phase Gate:** affected boundary tests and type checks must pass before dependent runtime/consumer behavior is marked implemented. If an external declaration/config mismatch is encountered, record blocked evidence; do not suppress or install.
5. Run verification commands in their listed order, rerun CMD-SPECS/CMD-PLAN, inspect changed-file scope and duplicate implementations. Record exit codes, relevant test names, privacy/error/cancellation proof and generated-artifact checks. No acceptance based only on a submitted command or mocked substitute.
6. Write evidence under `ai-harness/plans/decision-boundaries/evidence/TICKET-006.md` through the coordinator handoff. Implementation agent reports implemented/partial/blocked; coordinator owns index/lifecycle and manifest updates. Independent review checks specs plus this action plan before accepted. **Phase Gate:** next ticket stays blocked until this ticket is accepted and its dependency/index pointers are reconciled.

## Requirements Traceability

REQ-DB-WAITS; CAP-DB-WAITS. Success/failure/recovery paths and acceptance IDs are exact frontmatter links to 00-traceability.yaml; no deferrals.

## Contract Traceability

ai-harness/specs/37-decision-boundaries/03-contracts/decisions.md#CTR-DB-WAITS, ai-harness/specs/37-decision-boundaries/03-flows/e2e-coverage.md#REQ-DB-WAITS, ai-harness/specs/37-decision-boundaries/00-conventions.md#CONV-DB-STYLE. Approved decisions.md plus its explicitly linked provider-continuation/review-execution documents define values, error semantics and sequences; no local reinterpretation.

## Spec Drift Controls

Reject changed manifest digests, missing prerequisites, unregistered shapes, altered timeout/approval semantics, raw content in evidence or old API fallbacks. Review against the exact REQ-DB-WAITS, CTR-DB-WAITS and frontmatter acceptance rows before acceptance. Missing behavior goes to readiness review as a blocker, never an implementation guess.

## Generator And Type Plan

Use approved generation-map: strict Zod definitions own non-generic runtime/TypeScript shape; infer aliases, compile with existing tsc, reuse existing declaration generation. Generic narrowing and lifecycle implementation are manual because repository generators do not emit them. Do not add YAML codegen. Build/check commands above own generated validation; no handwritten duplicate schemas/interfaces. No new package/version/dependency. Closed boundaries have no any, unchecked cast or open unknown result.

## Test-First Order

Missing/extra/malformed IDs/timestamps/outcomes; invalid get/cancel args; missing terminal eventId except autoexpiry; invalid adapter snapshot before event; exact initial/readback parity excluding binding IDs; now==deadline; observedAt cannot revive; duplicate/late signals unchanged; terminal type narrowing; lease release/replay and existing storage contract suite. Tests precede behavior; each success/failure/recovery acceptance row requires its exact assertion and command proof. Existing fixtures are extended; a new file is permitted only for a new module/checker or absent type-test seam. No live provider/credentials.

## Modularity And Reuse Plan

Existing ExternalWaitOutcome, storage transactions, ExternalWaitError and HarnessStorage contract suite; no second wait facade or table. Placement follows 00-file-structure.md and 00-module-boundaries.yaml. Extract only helpers consumed by the named boundaries, not a new abstraction hierarchy. No unrelated domain logic.

## Representation Reuse Plan

Catalog: `ai-harness/specs/37-decision-boundaries/03-contracts/representation-catalog.yaml`. Shapes: wait.request, wait.snapshot, wait.resolved, wait.signal. Mappings: MAP-DB-WAIT, MAP-DB-RESOLVED. Extend those owners only; no second envelope or renamed mirror. New-shape decision: none.

## Slice Strategy

Vertical slice runs from the named public/application entrypoint to its required effect, safe rejection and recovery outcome. Unblocks TICKET-007. No parallel writes: runtime builders, sessions and exports overlap across sequential tickets. Only read-only sidecar review is safe.

## Tasks

Execute STEP-PREFLIGHT, STEP-CONTRACT, STEP-TEST, STEP-IMPLEMENT, STEP-VERIFY and STEP-HANDOFF in order. Detailed edits and proof are in Action Plan, not discretionary work suggestions.

## Acceptance

Registration readback and terminal results use exact canonical shape. Missing extra invalid fields rejected before telemetry or persistence. Duplicate and late signals retain current terminal state and replay semantics. Every structured acceptance row must pass; no silent partial completion.

## Acceptance Test Matrix

| Acceptance | Required assertion | Verification |
| --- | --- | --- |
| ACC-WAITS-SUCCESS | Registration readback and terminal results use exact canonical shape | CMD-WAITS, CMD-CONTRACTS, CMD-CORE-TYPES, CMD-TYPE-TESTS |
| ACC-WAITS-FAILURE | Missing extra invalid fields rejected before telemetry or persistence | CMD-WAITS, CMD-CONTRACTS, CMD-CORE-TYPES, CMD-TYPE-TESTS |
| ACC-WAITS-RECOVERY | Duplicate and late signals retain current terminal state and replay semantics | CMD-WAITS, CMD-CONTRACTS, CMD-CORE-TYPES, CMD-TYPE-TESTS |

## End-To-End Definition Coverage

`02-capabilities/capability-inventory.md#CAP-DB-WAITS` and `03-flows/e2e-coverage.md#REQ-DB-WAITS` specify actor, trigger, entrypoint, state, effects, authorization, errors, recovery, observability, owner and terminal outcomes. This ticket proves that chain through `ai-harness/packages/harness/test/durable-external-wait.test.ts` and the matrix above. No additional UI/server surface is introduced.

## Operational Path Coverage

Cover all three PATH-DB-WAITS paths. Safe reason/evidence and existing trace correlation, cancellation and idempotency follow the owning contract; no raw data logs. 04-nfr/requirements.md and 04-operations/runbook.md bind performance, integrity and release limits. External services, UI/a11y changes, dependency upgrades and production deployment are N/A, not simulated successes.

## Review And Verification Plan

Independent review checks spec/ticket/acceptance alignment, generated declarations, strict typing, module ownership, reuse, dead code and scope. Reject invented behavior, skipped failure/recovery coverage, avoidable casts, duplicate mappers/timers, hidden content leakage or old aliases. A required failed command blocks acceptance even if baseline failure is unrelated; record exact blocker and ask the coordinator for bounded remediation scope.

## Verification

Run CMD-SPECS, CMD-PLAN, CMD-STATUS, CMD-WAITS, CMD-CONTRACTS, CMD-CORE-TYPES, CMD-TYPE-TESTS. Commands are from workspace root and use installed tools. Their no-network/no-secrets contract applies to nested scripts. Local workspace artifacts only. Record expected red test proof before behavior, final pass counts, actual resolution paths and any failure. Do not download a tool or modify lockfiles to force a pass.

## Non-goals

No migrations, legacy readers, deprecations, compatibility wrappers, provider SDK upgrade, production payments, deployment, commit/push, destructive data cleanup, new UI, business policy values, or edits outside write_scope.

## Handoff

Return changed files, acceptance/test proof, remaining blockers or none, and lifecycle recommendation. Do not self-accept. Coordinator updates indexes and plan manifest under the frozen spec; content/spec changes require renewed readiness review and regenerated affected tickets. Evidence does not mutate approved contracts.
