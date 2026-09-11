# Implementation Review: sandbox-ownership / TICKET-002 remediation

Decision: needs_fixes
Review ID: 20260826-ticket-002-remediation-review
Scope: Fresh independent review of TICKET-002 and REVIEW-002-001 through REVIEW-002-007

## Findings

- REVIEW-002-008 (blocking): Concurrent exact retries of a resource-bearing purge can invoke the provider deletion callback more than once for the same resource.
- REVIEW-002-009 (blocking): The remediation did not add the required deterministic tests for the capacity-at-limit, cross-process lock, mid-sweep cancellation, and failed-snapshot-cleanup paths.

## Prior Finding Disposition

| Finding | Disposition | Evidence |
| --- | --- | --- |
| REVIEW-002-001 | fixed | `catalog.ts:291` now compares `owner.identity?.tenantId === selector.tenantId`; `catalog.test.ts:45-53` proves omitted tenant matches only an absent tenant. |
| REVIEW-002-002 | fixed | `catalog.ts:165-185` persists barrier, purge journal, and `cleanup_pending` state before callbacks; `catalog.test.ts:84-92` proves post-commit cancellation returns durable pending work. |
| REVIEW-002-003 | implementation fixed; test coverage incomplete | `catalog.ts:296-297` reserves two retained records for every active owner before normal admission, but no test fills normal capacity and proves later purge admission. |
| REVIEW-002-004 | implementation fixed; test coverage incomplete | `local-sandbox-catalog.ts:63-103` uses an exclusive lock-file/token protocol, but `local-sandbox-catalog.test.ts:30-42` tests two objects in one process only. |
| REVIEW-002-005 | implementation fixed; test coverage incomplete | `registerOwner` checks cancellation before and inside mutation; sweep checks between resources. There is no abort-during-sweep fixture. |
| REVIEW-002-006 | implementation fixed; test coverage incomplete | `deleteSnapshot` marks durable cleanup-pending state before its callback and only then marks deleted. Tests cover callback success only, not retryable failure. |
| REVIEW-002-007 | fixed | `implementation-evidence/TICKET-002.json:6` matches `plan-manifest.yaml`'s `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf`. |

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Exact owner / absent owner barrier | reviewed | `catalog.ts:97-115`, `catalog.test.ts:24-29,103-109` | Registration is cancellation-aware and unknown owner creation is denied after an absent-owner purge. |
| Principal optional-tenant isolation | passed | `catalog.ts:291`, `catalog.test.ts:45-53` | Omitted tenant is exact absence, not wildcard. |
| Barrier-first purge and retry | partial | `catalog.ts:161-200`, `catalog.test.ts:66-92` | State is now durable before callback. Concurrent retries can still perform duplicate provider deletion. |
| Capacity reservations / tombstones | partial | `catalog.ts:296-297`, `catalog.test.ts:94-101` | Arithmetic is corrected but the test proves active-sandbox quota, not normal-catalog saturation followed by purge. |
| Local restart / concurrent authority | partial | `local-sandbox-catalog.ts:31-103`, `local-sandbox-catalog.test.ts:13-42` | State-loss marker and file lock are present. No independent-process test proves the lock authority. |
| Cancellation during bounded sweep | partial | `catalog.ts:225-256` | The source observes cancellation between resources. No test proves it preserves later resources. |
| Snapshot cleanup | partial | `catalog.ts:202-223`, `catalog.test.ts:111-118` | Callback success is covered. Failure keeps `cleanup_pending` by inspection but lacks failure/retry test evidence. |
| Public/package boundary | reviewed | Ticket scope and `04-delivery.md#DEC-SOWN-DELIVERY` | Remains private and unwired; no premature live-port or factory change found. |

## Digest And Impact Evidence

- Spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`.
- Plan digest: `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf`.
- The implementation evidence now pins that same plan digest.
- Reviewed changed artifacts are the five TICKET-002 scoped files only. The downstream live-port consumer remains TICKET-004.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `spec check ok` |
| `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `plan lint ok` |
| `npm --prefix ai-harness exec --workspace @purista/harness vitest run src/sandbox/catalog.test.ts src/local/local-sandbox-catalog.test.ts` | passed | 2 files, 11 tests |
| `npm --prefix ai-harness run typecheck --workspace @purista/harness` | passed | `tsc -p tsconfig.json --noEmit` exit 0 |
| `npm --prefix ai-harness run test:unit --workspace @purista/harness` | passed with loopback permission | 25 files, 295 tests |
| `git -C ai-harness diff --check` | passed | exit 0 |

## Self-Audit

- Assumptions: The lock-file protocol is an appropriate private local authority for same-host local adapter processes; it does not claim a distributed shared-filesystem lock.
- Skipped checks: No live provider, Docker engine, PURISTA, or packaged-consumer check was run because the private TICKET-002 foundation does not wire those consumers.
- Unreviewed paths: Later attachment fencing, provider idempotency implementations, durable workspace coordination, and retention policy belong to later tickets.
- Residual risk: The remaining findings are bounded to the private catalog and its tests. They must be corrected before the foundation can be accepted and unblocks TICKET-004.
