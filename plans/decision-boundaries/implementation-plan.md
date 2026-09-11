# Approved decision-boundary implementation plan

## Start here

This plan implements the [approved specs](../../specs/37-decision-boundaries/00-vision.md). The owner approved clean breaking changes, no legacy/backward compatibility/migrations, and explicitly excluded Voyage. Remaining verification covers only the defined Harness, Core, starter/create-purista, handbook and skill scope. See [final evidence](evidence/TICKET-010.md) and read [_status.yaml](_status.yaml) for current evidence and resume points rather than restarting accepted tickets. Only the coordinator promotes dependencies after independent acceptance.

## Outcome and architecture

One core evidence/schema/identity/callback facility supports distinct guardrail, permission, policy and immediate approval semantics. Prepared tools make transformed arguments authoritative for history/replay and parsed inputs authoritative for permission/policy/approval/handler. Durable review uses existing waits/checkpoints and application-owned immutable claims/receipts. No new policy framework or Core dependency in Harness.

## Ordered waves

| Wave | Ticket | Deliverable | Current state |
| --- | --- | --- | --- |
| 1 | [TICKET-001](wave_01_foundation/tickets/TICKET-001-foundation.md) | Shared evidence and bounded decisions | accepted |
| 2 | [TICKET-002](wave_02_governance/tickets/TICKET-002-governance.md) | Single immediate approval and typed policy | accepted |
| 3 | [TICKET-003](wave_03_providers/tickets/TICKET-003-providers.md) | Canonical provider continuation | accepted |
| 4 | [TICKET-004](wave_04_tools/tickets/TICKET-004-tools.md) | Prepared tool batch and content lifecycle | accepted |
| 5 | [TICKET-005](wave_05_rails/tickets/TICKET-005-rails.md) | Typed rails and final-only output | accepted |
| 6 | [TICKET-006](wave_06_waits/tickets/TICKET-006-waits.md) | Strict wait schemas and terminal return | accepted |
| 7 | [TICKET-007](wave_07_review/tickets/TICKET-007-review.md) | Retry-safe application approval claim | accepted |
| 8 | [TICKET-008](wave_08_consumers/tickets/TICKET-008-consumers.md) | PURISTA and workspace integration | accepted |
| 9 | [TICKET-009](wave_09_docs/tickets/TICKET-009-docs.md) | One current usage journey | accepted |
| 10 | [TICKET-010](wave_10_cleanup/tickets/TICKET-010-cleanup.md) | Clean cut and complete verification | accepted |

## Clean boundary strategy

Coordinator scope update, 2026-08-26: Voyage is excluded from implementation, documentation, static scans and all acceptance gates. TICKET-008 verifies Core and starter/create-purista only. TICKET-010 scanner implementation may follow TICKET-007 independently of remaining consumer/docs gates; final in-scope consumer verification remains mandatory. No in-scope public contract or acceptance criterion is waived.

The source-contract/generation map is approved before implementation. Foundation schemas and inferred types precede runtime code; provider continuation, tool lifecycle and final-output changes precede consumers. Existing builds emit declarations; no runtime code generator is invented. Shared builder/session/export files require sequential ownership. No long-lived compatibility path is allowed; owner tickets remove their old API and affected in-scope references. Documentation and final cleanup complete the same delivery, not a follow-on roadmap.

The plan includes Harness, provider adapters, guardrails, storage, both approval examples, PURISTA Core integration, verified starter/create-purista non-impact, handbook and skills. Registry publication/version bumps are explicitly outside this task; local source/dist checks must prove the changed code is used.

## Coordinator protocol

Run spec and plan checkers from workspace root using the exact commands in tickets. Preserve baseline uncommitted source and unrelated workstreams. Before activating a ticket, require all dependencies accepted; synchronize lifecycle, blocked_by and indexes. Evidence/reviews live in their excluded plan directories. Lifecycle-only index/ticket changes require `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/generate_plan_manifest.mjs . ai-harness/plans/decision-boundaries ai-harness/specs/37-decision-boundaries`, then the ticket CMD-PLAN checker; do not edit the frozen spec digest. Any semantic spec change returns to readiness review, obtains fresh digest-bound approval under the owner's scope, and regenerates affected tickets before execution. No worker silently repairs missing requirements or widens write_scope.

Implementation agents may report implemented only after local proof. Independent review moves review_pending to accepted. A required red gate, missing local dependency or unsupported source shape is blocked with exact evidence. No skipLibCheck/cast/test skipping, dependency install, illustrative substitute or unrelated rewrite is an acceptance shortcut. Status indexes—not prose checkmarks—own lifecycle.

## Verification and completion

Every ticket contains exact commands, test-first regression cases and three structured acceptance rows. Final ticket runs full Harness lint/build/unit/provider/addon/examples/coverage/types/storage/integration/failure gates, local source/dist consumer tests, removal checks and PURISTA audits. Complete only when all ten tickets are accepted, all thirty acceptance paths have evidence, removed surfaces are absent and no required gate is unresolved. A successful spec/plan checker is definition verification, not runtime implementation proof.

## Self-Audit

Assumptions: installed lockfile dependencies and local toolchain remain available; no network or publication. Evidence: current source audit, focused baseline tests recorded in the historical audit, independent contract readiness reviews and scoped manifest. Coverage: ten capabilities, thirty success/failure/recovery paths, public types, async lifecycle, privacy, durable integrity, consumer reachability, docs, operations and cleanup. NFR/ops/supply-chain ownership is fixed in specs; new infrastructure/UI/release execution are explicitly excluded. Fake work is allowed only for test fixtures and the existing application reference; real runtime changes must be exercised. Parallel risk is controlled through sequential ticket dependencies. No open semantic decision remains; implementation/runtime prerequisites are checked per ticket and are not falsely pre-certified.
