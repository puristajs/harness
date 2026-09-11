# Implementation Review: sandbox-ownership / TICKET-003

Decision: needs_fixes
Review ID: 20260826-ticket-003-independent-review
Scope: TICKET-003 — Docker-private indexed ownership and purge preparation

## Findings

- REVIEW-003-001 (blocking): Cancellation after a committed selector barrier is surfaced as an exception rather than the required `cleanup_pending` result.
- REVIEW-003-002 (blocking): Catalog accounting does not reserve enough space for an admitted owner's selector barrier and purge progress, so a full normal catalog can block its own cleanup; a denied post-revocation registration can also add an unbounded owner record.
- REVIEW-003-003 (blocking): The private journal accepts illegal lifecycle resurrection, including `deleted -> active`, instead of failing closed.

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Exact owner registration / unknown ownership | partial | `src/ownership.ts:72-103`, `ownership.test.ts` | Unknown ownership is rejected and labels are checked; catalog capacity handling has the blocking defect below. |
| Selector revocation and principal attachment | partial | `src/ownership.ts:122-195`, `ownership.test.ts` | Owner/principal matching is exact for the covered cases; post-barrier cancellation is incorrect. |
| List cursor | reviewed | `src/administration.ts:40-54,129-176`, `administration.test.ts` | Opaque and selector-bound for this private foundation. Persistence/versioning belongs to the later port cutover and is not claimed here. |
| Purge, partial deletion, retry | partial | `src/administration.ts:56-118`, `administration.test.ts` | Stop/remove/volume order and failed-delete retention are correct in the fixture; barrier cancellation and catalog reserve are not. |
| Resource state transitions | failed | `src/ownership.ts:167-174` | Any permitted target state can replace any prior state, including a final deleted record being reactivated. |
| Public/package boundary | reviewed | `src/index.ts`, package exports, `src/ownership.ts`, `src/administration.ts` | The new foundation is not wired through the package entrypoint, factory, or public Harness port. Engine names stay in private records and are not returned by list. |
| Docker engine/network/image behavior | not applicable | Ticket non-goal | No live engine call, image pull, network/mount, exec-fallback, or capability change was added in the four scoped files. |
| Telemetry and durable restart | deferred | `04-delivery.md#DEC-SOWN-DELIVERY` | This unwired foundation does not claim cutover-level telemetry or persisted journal behavior; those are reviewed with the atomic port cutover. |

## Digest And Impact Evidence

- Spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`.
- Plan digest: `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf`.
- Changed artifacts reviewed: `packages/harness-sandbox-docker/src/{ownership,administration}.ts` and their direct tests.
- Affected consumer remains owned by `wave_03_port_cutover/TICKET-004`; no early factory or entrypoint wiring was found.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `spec check ok` |
| `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `plan lint ok` |
| `npm --prefix ai-harness run test --workspace @purista/harness-sandbox-docker` | passed | 49 passed, 20 opt-in skipped |
| `npm --prefix ai-harness run typecheck --workspace @purista/harness-sandbox-docker` | passed | `tsc -p tsconfig.typecheck.json` exit 0 |
| `git -C ai-harness diff --check` | passed | exit 0 |
| `node /Users/sebastianwessel/.agents/skills/spec-implementation-review/scripts/check_implementation_evidence.mjs ai-harness` | tooling limitation / failed | The generic checker assumes root `specs/spec-manifest.yaml` and `plans/plan-manifest.yaml`; this workstream uses nested manifests. It also reports unrelated TICKET-013 evidence and does not support accepted evidence status. It cannot be used to decide this scoped ticket. |

## Self-Audit

- Assumptions: The comments and approved delivery stage make the private, unwired foundation intentional; persisted-journal, cursor-version and telemetry completion are deferred to the atomic cutover rather than treated as acceptance claims for this ticket.
- Skipped checks: No live Docker test was run; the ticket expressly forbids real engine calls/image pulls and marks them opt-in. No full Harness/PURISTA regression was run because this ticket does not wire a consumer.
- Unreviewed paths: Future factory integration, persisted restart reconciliation, and public operator attachment belong to subsequent tickets.
- Residual risk: The three blocking private-foundation defects must be corrected and independently reviewed before TICKET-003 can become accepted.
