# Distributed Production Reference Stack

Status: owner-approved clean implementation specification.

Date: 2026-08-30

Decision authority: repository owner approval in the 2026-08-30 Harness
production-stack implementation request. This specification supersedes only
the production-provider selection block in spec 34. The topology-transparent
Sandbox contract, adapter-private coordination, recovery, privacy, and
conformance requirements from specs 21, 32, 34, and 36 remain normative.

## 1. Outcome

PURISTA publishes and verifies a complete self-hosted distributed reference
stack without coupling standalone Harness packages to PURISTA Core:

1. `@purista/harness-storage-postgres` implements the complete
   `HarnessStorage` contract for replicated applications.
2. `@purista/harness-sandbox-kubernetes` implements the existing `Sandbox`
   contract and returns a coordinated `DurableWorkspace` when durable files
   are enabled.
3. One PURISTA service instance constructs one shared Harness runtime for all
   attached agents and workflows, then shuts it down exactly once.
4. One runnable PURISTA example proves Docker Compose development and
   Kubernetes production deployment from the same application composition.

Harness core gains no database, Kubernetes, PURISTA, object-storage, scheduler,
or hosted-review dependency.

## 2. Public composition

The production composition is explicit and has no environment-driven fallback:

```ts
const storage = postgresHarnessStorage({
  connectionString: process.env.DATABASE_URL!,
})

const execution = kubernetesSandboxRuntime({
  namespace: process.env.PURISTA_SANDBOX_NAMESPACE!,
  image: process.env.PURISTA_SANDBOX_IMAGE!,
  runtimeId: 'payments-v1',
  workspace: true,
})

const service = await serviceBuilder.getInstance(eventBridge, {
  ai: {
    models,
    storage,
    sandbox: execution.sandbox,
    workspace: execution.workspace,
  },
})
```

For local development the application may compose the existing in-memory,
SQLite, local-directory, or Docker adapters instead. Agent and workflow
definitions do not branch on deployment topology.

## 3. Adapter-author surface

`@purista/harness/adapter` is the supported narrow entry point for first-party
and third-party adapter implementations. It exposes canonical validation and
identity helpers that adapters must share with core. It does not expose runtime
registries, storage internals, provider references, leases, Kubernetes types,
or PURISTA types. Application users continue importing public ports and errors
from `@purista/harness`.

## 4. PostgreSQL storage contract

`postgresHarnessStorage(options)` accepts exactly one caller-owned `pg.Pool` or
a connection string. An injected pool is never closed by the adapter; a pool
created by the adapter is closed idempotently.

The adapter:

- advertises `storage.persistent` and `storage.multi_instance` in addition to
  all required Harness storage capabilities;
- uses one versioned, idempotent package migration under a database advisory
  lock and fails closed on incompatible schema state;
- preserves exact session incarnation, identity, sandbox-binding, run,
  checkpoint, wait, message, and event semantics from spec 32;
- uses PostgreSQL transactions and row/advisory locks for concurrent creation,
  session serialization, lease acquisition/takeover, checkpoint fencing, wait
  registration, and terminal signalling;
- keeps timestamps as canonical ISO strings at the public boundary and JSON
  values in JSONB without exposing database-native values;
- emits only the existing content-free `harness.storage.*` telemetry;
- passes `harnessStorageContract` and live two-pool contention/restart tests.

Lazy initialization is permitted for low-effort composition, but every first
operation observes the same initialization promise and no operation runs
before migration succeeds.

## 5. Kubernetes execution contract

`kubernetesSandboxRuntime(options)` returns exactly:

```ts
{
  sandbox: Sandbox,
  workspace?: DurableWorkspace,
  close(): Promise<void>
}
```

The package uses the official Kubernetes client and Kubernetes API resources.
It owns logical-scope hashing, provider resource names, resource-version CAS,
generation records, attachment leases/fences, pod/PVC lifecycle, cleanup, and
optional VolumeSnapshot coordination behind the existing public ports.

Required behavior:

- `create` atomically establishes one logical generation; `attach` never
  creates; `restore` requires the workspace adapter to have resumed a committed
  checkpoint for the exact run scope;
- stale attachments cannot mutate files, execute, spawn, snapshot, or
  terminate after authority changes;
- provider absence and provider outage remain distinct; known missing state is
  `SandboxStateLostError`, never an empty workspace;
- commands execute without host-shell interpolation and honor cancellation,
  wall-clock, output, CPU, memory, PID, and storage limits;
- filesystem and bounded text search execute where the data lives;
- pods run as non-root with read-only root filesystems, no privilege
  escalation, dropped capabilities, seccomp, bounded service-account access,
  and documented default-deny egress integration;
- cleanup is idempotent and terminal business outcomes never change because
  cleanup must be retried;
- the adapter passes `sandboxContract`, `sandboxTextSearchContract`, and
  `sandboxMultiClientContract`; kind-backed live tests verify Kubernetes API,
  pod, PVC, handoff, restore, and termination behavior.

Durable file recovery uses Kubernetes persistent volumes and VolumeSnapshot
when configured. S3 or another object store is not required and is not hidden
inside this package. A future object-storage workspace remains a separate
optional adapter.

## 6. PURISTA lifecycle and application boundary

The existing `AgentQueueBuilder` integration is the only Framework bridge:

- one service-local runtime registry collects all attached agents, workflows,
  workflow-local agents, models, tools, skills, governance, and telemetry;
- application code supplies adapter instances once through
  `service.getInstance(..., { ai })`; it does not construct the Harness itself;
- model aliases remain definition-local while private registry ids prevent
  collisions inside the shared Harness;
- validated PURISTA tenant/principal and trace context project into each
  Harness invocation;
- durable run ids remain stable, payload-derived application identifiers;
- approval/review identity, authorization, durable review records, action
  digests, execution claims, receipts, and resume commands remain
  application-owned PURISTA capabilities;
- the service starts one Harness and closes the Harness and owned adapters once.

The reference application must not construct a Harness per queue delivery,
command, agent, or workflow.

## 7. Reference deployment and evidence

The reference application includes:

- at least two attached agents and one recoverable workflow;
- a typed application-owned review command and result/receipt record;
- PostgreSQL, two PURISTA worker replicas, and optional local sandbox execution
  in Docker Compose;
- Kubernetes manifests or Helm values for the same application, PostgreSQL
  connectivity, RBAC, sandbox namespace, pod security, PVC/snapshot classes,
  quotas, network policy, probes, graceful shutdown, and cleanup ownership;
- no embedded production credentials or cluster-wide default permissions.

Automated evidence must prove:

1. two application replicas share sessions and run state;
2. concurrent first acquisition has one winner;
3. pod/process termination resumes from the last committed step;
4. lease expiry permits fenced takeover and rejects the stale worker;
5. duplicate queue delivery, checkpoint commit, and review signal are safe;
6. approval wait, application-owned decision, signal, and resume complete once;
7. tenant/session/workspace scopes are isolated;
8. sandbox cleanup and service/Harness shutdown are each idempotent;
9. local composition can omit Kubernetes without changing definitions;
10. packages, docs, website, API reference, examples, and canonical skills use
    the same names and capability claims.

## 8. Release and verification

This is an unreleased clean addition. No compatibility alias or generic
production meta-adapter is added. Completion requires package typechecks,
contract/unit/live-gated tests, consumer-pack installation tests, PURISTA core
tests, the reference application build/tests, website build/link validation,
and PURISTA skill/knowledge audits.
