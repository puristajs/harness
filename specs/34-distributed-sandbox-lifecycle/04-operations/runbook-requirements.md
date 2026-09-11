# Operations and provider bake-off

## Application operations

Applications configure the selected sandbox adapter or its control plane with
provider credentials, timeouts, retention, hibernation, cleanup retry, orphan
reclamation, quotas, and network/resource policy. Harness adds no lifecycle
policy block, scheduler, or maintenance command.

Runbooks cover stale-attachment rejection, provider outage, authoritative
not-found, state loss, invalid/missing workspace recovery, cleanup backlog,
quota exhaustion, credential rotation, and provider incident containment.
Operator inspection is adapter-specific, content-free, access-controlled, and
must not expose provider references to ordinary Harness or PURISTA callers.
If terminal workspace/sandbox cleanup fails, keep the committed run outcome,
use the content-free cleanup warning for operational triage, and retry the
adapter's idempotent cleanup. Never rerun completed business work to clean files.

## Provider bake-off

E2B and Daytona run against one identical, approved public-contract probe. No
production package begins before the shared contract passes and the resulting
provider decision is approved.

Required evidence:

1. Two independently constructed adapter clients sharing the same backend
   concurrently open one logical scope and create one provider generation.
2. After handoff, the old client cannot write, execute, spawn, snapshot,
   hibernate, resume, or terminate. If the provider API lacks the required
   atomic enforcement, the spike documents the smallest adapter control-plane
   design and its operational burden; a direct-SDK adapter fails this criterion.
3. Attach never triggers first-use creation. Missing lifecycle state and
   provider not-found remain distinct from unavailable, unauthorized, quota,
   cancellation, and timeout.
4. Files, environment, installed packages, and live processes are tested
   separately across detach, hibernate/resume, client loss, and provider
   eviction. Only files restored from `DurableWorkspace` are guaranteed.
5. Recovery uses the same committed durable-workspace fixture and reports
   `preserved`, `restarted`, `not_preserved`, or `unknown` truthfully.
6. Generations, leases, fences, provider refs, and snapshot refs remain private
   to the adapter evidence harness and are absent from public results and
   standard telemetry.
7. Tenant/principal isolation, known-scope attacks, egress policy, secret
   injection, quotas, image provenance, region/BYOC/self-hosting, and secure
   cleanup are documented from current primary provider evidence.
8. Cancellation, streaming, spawned process lifecycle, forced eviction,
   cleanup retry, orphan reclamation, API limits, and SDK retry behavior pass
   the same probe without provider-specific relaxation.
9. p50/p95/p99 latency and estimated cost are measured for create, attach,
   supported hibernate/resume, restore, and terminate under identical resource
   and region settings.
10. The decision report records pass/fail/unknown per criterion, evidence links,
    SDK/API versions, retrieval date, residual risks, required control-plane
    components, and the valid outcome “select none”.

Provider selection is the remaining D3 decision. A winner becomes one optional
`@purista/harness-sandbox-<provider>` package. A tie or failure selects no
provider until a separately approved control-plane approach closes the gaps.
