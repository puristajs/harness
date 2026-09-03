# Implementation Review: sandbox-ownership / TICKET-002

Decision: needs_fixes
Review ID: 20260826-ticket-002-independent-review
Scope: TICKET-002 — Private local owner catalog and administration primitives

## Findings

- REVIEW-002-001 (blocking): A principal selector without `tenantId` matches every tenant instead of only an absent tenant.
- REVIEW-002-002 (blocking): Purge performs provider side effects before persisting revocation/progress, and cancellation rolls the barrier back instead of returning durable `cleanup_pending` progress.
- REVIEW-002-003 (blocking): Catalog capacity does not reserve every admitted owner's future barrier/progress records, so normal capacity can make its own required purge impossible.
- REVIEW-002-004 (blocking): `LocalSandboxCatalog` serializes only within one JavaScript process; concurrent catalog processes can lose a read-modify-write update.
- REVIEW-002-005 (blocking): Registration and sweep do not honour an already-aborted or newly-aborted signal throughout their mutations.
- REVIEW-002-006 (blocking): `deleteSnapshot` declares a snapshot deleted without invoking the adapter-private deletion callback, so it can claim cleanup while backing data remains.
- REVIEW-002-007 (blocking): The implementation evidence pins a plan digest that is not the current approved plan manifest digest.

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Exact owner registration / unknown ownership | partial | `src/sandbox/catalog.ts:97-113`, `catalog.test.ts:24-29` | Missing attach state loss and exact owner handling are covered; cancellation is not checked and is ignored by the implementation. |
| Principal offboarding and tenant isolation | failed | `src/sandbox/catalog.ts:256`, `catalog.test.ts:31-43` | The covered case provides a tenant. The omitted-tenant selector is a wildcard in the implementation, contrary to the contract. |
| Purge barrier, retry, and cancellation | failed | `src/sandbox/catalog.ts:159-201`, `catalog.test.ts:56-72` | Partial-delete retry is covered, but provider deletion occurs before the journal write and post-barrier cancellation aborts the whole transaction. |
| Capacity and tombstone protection | failed | `src/sandbox/catalog.ts:108,129,167,260-261`, `catalog.test.ts:74-81` | The test leaves spare slots; it does not prove a normal-capacity owner can still reserve its barrier and durable purge job. |
| Local restart and concurrent authority | failed | `src/local/local-sandbox-catalog.ts:8,39-66`, `local-sandbox-catalog.test.ts:13-28` | Missing-journal state loss is covered. The module-global queue is not inter-process mutual exclusion. |
| Snapshot deletion | failed | `src/sandbox/catalog.ts:204-215` | The only concrete deletion path omits `callbacks.deleteResource`; no backing-cleanup or failure-path test exists. |
| Cursor / bounded list | reviewed | `src/sandbox/catalog.ts:142-156,264-266`, `catalog.test.ts:45-54` | The direct selector/kind mismatch is rejected. Deletion-stability and maximum emitted-cursor tests remain absent; this does not change the blocking decision above. |
| Public/package boundary | reviewed | Ticket write scope, `04-delivery.md#DEC-SOWN-DELIVERY` | No factory, root entrypoint, or live port was wired early. The new catalog remains a private foundation. |
| Telemetry / live provider operation | deferred | Ticket non-goal and private-foundation stage | No provider adapter or runtime telemetry behavior is claimed by this ticket. |

## Digest And Impact Evidence

- Spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`.
- Current plan digest: `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf` from `plans/sandbox-ownership/plan-manifest.yaml`.
- Evidence digest: `sha256:525d3ec4a0a8f88ca85d5c3a041ab01bd3d7d9f1bd4e31ab6ede08e5ab022e98` in `plans/implementation-evidence/TICKET-002.json`; it does not pin the current plan.
- Changed artifacts reviewed: `packages/harness/src/sandbox/{catalog,catalog.test}.ts`, `packages/harness/src/local/{local-sandbox-catalog,local-sandbox-catalog.test}.ts`, and the scoped Vitest discovery change.
- The only declared future consumer is `wave_03_port_cutover/TICKET-004`; no early consumer wiring was found.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `spec check ok` |
| `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `plan lint ok` |
| `npm --prefix ai-harness exec --workspace @purista/harness vitest run src/sandbox/catalog.test.ts src/local/local-sandbox-catalog.test.ts` | passed | 2 files, 7 tests |
| `npm --prefix ai-harness run typecheck --workspace @purista/harness` | passed | `tsc -p tsconfig.json --noEmit` exit 0 |
| `npm --prefix ai-harness run test:unit --workspace @purista/harness` | passed with loopback permission | 25 files, 291 tests; the restricted sandbox blocks the HTTP-MCP fixture's `127.0.0.1` listener, while the allowed loopback run passes |
| `git -C ai-harness diff --check` | passed | exit 0 |
| `node /Users/sebastianwessel/.agents/skills/spec-implementation-review/scripts/check_implementation_evidence.mjs ai-harness` | tooling limitation / failed | The generic checker assumes root manifests, rejects accepted TICKET-001 evidence, and reports unrelated TICKET-013 evidence. The scoped TICKET-002 evidence was manually checked and has the stale plan digest recorded above. |

## Self-Audit

- Assumptions: The private/unwired catalog stage is intentional, so this review does not require the later public `Sandbox` port, factory, PURISTA mapping, or provider engine behavior.
- Skipped checks: No live Docker, cloud-provider, PURISTA, or packaged-consumer command was run; each belongs to a later ticket and is outside this ticket's write scope.
- Unreviewed paths: Later runtime attachment fencing, durable workspace coordination, full retention policy, and application authorization remain owned by later tickets.
- Residual risk: The listed defects affect the private foundation directly. In particular, the selector wildcard, non-durable barrier ordering, and inter-process lost-update path must be corrected before the catalog can safely become TICKET-004's backing authority.
