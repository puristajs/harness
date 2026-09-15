# Implementation Review: sandbox-ownership / TICKET-002 transaction-bound cleanup

Decision: pass
Review ID: 20260827-ticket-002-transaction-review
Scope: Independent follow-up of REVIEW-002-001 through REVIEW-002-011.

## Findings

No open blocking findings. The transaction-bound private cleanup model resolves
the prior permanent-claim and duplicate-side-effect findings without exposing a
public lease, registry, or alternative Sandbox port.

## Prior Finding Disposition

| Finding | Disposition | Evidence |
| --- | --- | --- |
| REVIEW-002-001 | fixed | Exact optional tenant matching remains in `catalog.ts:281`; absent-tenant fixture passes. |
| REVIEW-002-002 | fixed | Purge persists barrier, journal, and cleanup-pending state before the callback at `catalog.ts:165-191`; post-barrier cancellation returns `cleanup_pending`. |
| REVIEW-002-003 | fixed | Active-owner reservation arithmetic and normal-capacity purge fixture pass. |
| REVIEW-002-004 | fixed | The local storage's tokenized `flag: 'wx'` lock serializes separate catalog storage objects at the durable authority; no process-local Map remains. |
| REVIEW-002-005 | fixed | Registration and bounded sweep observe cancellation; the mid-sweep fixture leaves later work pending. |
| REVIEW-002-006 | fixed | Snapshot state is persisted pending before callback, remains pending on failure, and retry is tested. |
| REVIEW-002-007 | fixed | Evidence and current nested plan manifest both pin `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf`. |
| REVIEW-002-008 | fixed | `transaction` holds the adapter-private storage authority across the bounded callback; concurrent same-key purge test records one callback. |
| REVIEW-002-009 | fixed | Normal-capacity purge and mid-sweep cancellation have explicit fixtures; independent LocalSandboxCatalog instances exercise the shared durable lock authority. |
| REVIEW-002-010 | fixed | No durable cleanup claim remains. A crash after the pre-callback persist leaves a normal `cleanup_pending` record, which a later transaction retry selects and reconciles. |
| REVIEW-002-011 | fixed | Purge, deleteSnapshot, and sweep each use `transaction`, so callback execution is mutually exclusive for the adapter-private catalog authority. |

## Path Coverage

| Path | Status | Evidence | Notes |
| --- | --- | --- |
| Exact owner, tenant, principal selection | passed | `catalog.ts:98-115,281-284`; catalog fixtures | Optional tenant has exact absence semantics; no selector wildcard is introduced. |
| Barrier-first purge, partial failure, cancellation, restart retry | passed | `catalog.ts:161-195,244-255`; `catalog.test.ts:66-91` | Pending state is persisted before external cleanup. A restart sees a retryable pending resource; no empty-state fallback or durable claim blocks it. |
| Concurrent cleanup | passed | `catalog.ts:165,201,221,260`; `catalog.test.ts:94-107` | The same adapter-private lock scopes purge, snapshot deletion, and sweep callback paths. No public lease/fence/provider reference is added. |
| Capacity and retained tombstones | passed | `catalog.ts:305-307`; `catalog.test.ts:109-124` | Active-owner cleanup reservations preserve purge capacity at the configured normal limit. |
| Local durable authority / state loss | passed | `local-sandbox-catalog.ts:31-103`; local catalog fixtures | Atomic replacement plus tokenized lock handle concurrent local clients; an initialized missing journal fails state loss rather than reconstructing host paths. |
| Snapshot failure / retry | passed | `catalog.ts:197-215`; `catalog.test.ts:134-151` | Failed deletion leaves cleanup-pending record; successful retry finalizes it. |
| Bounded sweep cancellation | passed | `catalog.ts:217-242`; `catalog.test.ts:153-162` | Callback-triggered abort stops later selection and reports truthful pending work. |
| Public/package boundary | passed | Ticket scope, `04-delivery.md#DEC-SOWN-DELIVERY` | Foundation remains private and unwired; no factory/root entrypoint/PURISTA/live Sandbox cutover was introduced. |

## Digest And Impact Evidence

- Approved spec digest: `sha256:9578b59d21602ef020997d76a876d99df6e98728ea41834c8fd981c0d38e0acb`.
- Reviewed plan digest: `sha256:8670786e09d95437637dbfb7fdb3d45a6d6a4a51e8a088febf45cea32ec703cf`.
- TICKET-002 implementation evidence pins both current digests.
- Reviewed paths are limited to the five TICKET-002 scoped artifacts. TICKET-004 remains the approved sole consumer for atomic live-port integration.

## Verification

| Command | Result | Evidence |
| --- | --- | --- |
| `node /Users/sebastianwessel/.agents/skills/spec-readiness-review/scripts/check_specs.mjs ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `spec check ok` |
| `node /Users/sebastianwessel/.agents/skills/spec-implementation-planner/references/check_plan.mjs . ai-harness/plans/sandbox-ownership ai-harness/specs/36-sandbox-ownership-and-administration` | passed | `plan lint ok` |
| `npm --prefix ai-harness exec --workspace @purista/harness vitest run src/sandbox/catalog.test.ts src/local/local-sandbox-catalog.test.ts` | passed | 2 files, 15 tests |
| `npm --prefix ai-harness run typecheck --workspace @purista/harness` | passed | `tsc -p tsconfig.json --noEmit` exit 0 |
| `npm --prefix ai-harness run test:unit --workspace @purista/harness` | passed with loopback permission | 25 files, 299 tests |
| `git -C ai-harness diff --check` | passed | exit 0 |

## Self-Audit

- Assumptions: `LocalSandboxCatalog` is a same-host local adapter. Its file lock is intentionally not represented as a cross-host distributed coordination service.
- Skipped checks: Provider engines, Docker, PURISTA, packaging, retention, durable workspace, and live-port behavior are assigned to later tickets and were not claimed here.
- Unreviewed paths: Provider-specific idempotent-delete acknowledgment and runtime attachment fencing remain TICKET-004/later adapter integration responsibilities. The private catalog preserves retryable pending state for those adapters.
- Residual risk: A process may crash after a provider has completed deletion but before the post-callback journal persist. The retained cleanup-pending journal deliberately retries that known resource; a concrete adapter must treat provider not-found as a successful deletion as specified in the later integration contract. This is a safe retry posture, not silent recreation or data loss.
