# Implementation Review: sandbox-ownership / TICKET-002 second remediation

Decision: needs_fixes
Review ID: 20260826-ticket-002-second-remediation-review
Scope: Fresh independent review of TICKET-002, including REVIEW-002-001 through REVIEW-002-009

## Findings

- REVIEW-002-010 (blocking): A durable cleanup claim is never recoverable after a process crash, so a resource can remain `cleanup_pending` forever.
- REVIEW-002-011 (blocking): Snapshot deletion and sweep remain unclaimed concurrent cleanup paths and can duplicate the private provider deletion callback.
- REVIEW-002-009 remains partially open: the cross-process lock and mid-sweep cancellation cases still do not have the required deterministic regression tests.

## Prior Finding Disposition

| Finding | Disposition | Evidence |
| --- | --- | --- |
| REVIEW-002-001 | fixed | Exact optional-tenant comparison remains at `catalog.ts:301`; absent-tenant test passes. |
| REVIEW-002-002 | fixed | Barrier, progress and cleanup-pending resource state are durable before callbacks at `catalog.ts:167-187`; post-commit cancellation test passes. |
| REVIEW-002-003 | fixed | `assertNormalCapacity` reserves retained per-owner cleanup records; `catalog.test.ts:118-124` proves normal catalog capacity followed by purge. |
| REVIEW-002-004 | implementation fixed; test still incomplete | `local-sandbox-catalog.ts:63-103` has a file-lock authority, but the regression test still uses two objects in one process. |
| REVIEW-002-005 | implementation fixed; test still incomplete | Registration and sweep source observe cancellation, but no mid-sweep abort fixture exists. |
| REVIEW-002-006 | fixed | Snapshot callback failure persists cleanup-pending state and retry is now covered by `catalog.test.ts:143-151`. |
| REVIEW-002-007 | fixed | TICKET-002 evidence and nested plan manifest both pin `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf`. |
| REVIEW-002-008 | fixed for purge concurrency; recovery defect found | `cleanupClaim` prevents a second purge from claiming the same record, and `catalog.test.ts:94-107` proves it. The claim is not recoverable after a crash. |
| REVIEW-002-009 | partial | Capacity and failed-snapshot fixtures were added. Cross-process lock and mid-sweep cancellation fixtures remain absent. |

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Owner/principal admission and barrier | passed | `catalog.ts:98-115,301-304`; focused tests | Exact matching and revocation deny are covered. |
| Purge commit, retry, and same-key concurrency | partial | `catalog.ts:162-201,276-282`; `catalog.test.ts:66-107` | Duplicate concurrent callback is prevented while live; a crash leaves an unrecoverable durable claim. |
| Capacity/tombstone admission | passed | `catalog.ts:305-307`; `catalog.test.ts:118-124` | Owner cleanup reservation is tested at the normal capacity boundary. |
| Local restart and process-safe authority | partial | `local-sandbox-catalog.ts:31-103`; `local-sandbox-catalog.test.ts:13-42` | Safe state-loss marker and lock implementation exist; missing independent-process regression evidence. |
| Sweep cancellation and cleanup concurrency | failed | `catalog.ts:227-258` | No claim is taken before callback; concurrent sweep calls can duplicate side effects. No abort-during-sweep test exists. |
| Snapshot cleanup concurrency/retry | partial | `catalog.ts:204-225`; `catalog.test.ts:134-151` | Failure/retry is covered, but two callers can both invoke callback while state is cleanup_pending. |
| Public/package boundary | passed | Ticket scope and `04-delivery.md#DEC-SOWN-DELIVERY` | No live-port/factory/public registry integration was introduced. |

## Digest And Impact Evidence

- Spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`.
- Plan digest: `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf`.
- TICKET-002 implementation evidence pins both current digests.
- The review remains bounded to TICKET-002's five scoped files. TICKET-004 remains the sole downstream live-port integration owner.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `spec check ok` |
| `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `plan lint ok` |
| `npm --prefix ai-harness exec --workspace @purista/harness vitest run src/sandbox/catalog.test.ts src/local/local-sandbox-catalog.test.ts` | passed | 2 files, 14 tests |
| `npm --prefix ai-harness run typecheck --workspace @purista/harness` | passed | `tsc -p tsconfig.json --noEmit` exit 0 |
| `npm --prefix ai-harness run test:unit --workspace @purista/harness` | passed with loopback permission | 25 files, 298 tests |
| `git -C ai-harness diff --check` | passed | exit 0 |

## Self-Audit

- Assumptions: The local file lock is a same-host local-adapter authority, not a distributed shared-filesystem coordination primitive.
- Skipped checks: No external provider/Docker/PURISTA/package verification was run because this private foundation remains unwired by design.
- Unreviewed paths: Provider-specific idempotent-not-found behavior, runtime attachments, durable workspace pins, retention, and framework integration remain later-ticket work.
- Residual risk: A crash after a cleanup claim and concurrent snapshot/sweep operations can preserve or duplicate cleanup effects. Both violate the private catalog's required retry/recovery contract and block acceptance.
