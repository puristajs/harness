# Distributed sandbox lifecycle

Status: approved for Harness contract work, the local Docker addon, and provider bake-off. Production
provider implementation remains blocked on the bake-off decision.

Date: 2026-08-25

## Outcome

`@purista/harness` remains a useful standalone package with one lifecycle-aware
`Sandbox` port. Logical scope, open/attach/recovery results, detach, and
termination are normal Sandbox behavior, independent of deployment topology.
A sandbox adapter, or its private control plane, owns any distributed
coordination, generations, leases, fencing, provider references, retention, and
orphan cleanup. `HarnessStorage` remains the persistence port for sessions,
messages, runs, checkpoints, waits,
and events; it does not become a sandbox control-plane database.

The following rule is absolute:

> A known logical sandbox that is missing at the provider is never replaced by
> empty state. Harness either reattaches, authorizes an explicit replacement
> after a committed `DurableWorkspace` checkpoint has been resumed, or throws
> `SandboxStateLostError`.

Durable workspace files are the recovery guarantee. Live-process preservation
is optional and is never required for correctness unless the application
explicitly requires `sandbox.live_process_preservation`.

PURISTA consumes only the public Harness contract. PURISTA maps framework
identity and runtime policy into Harness at its integration boundary; Harness,
its adapters, and its provider addons never import PURISTA Core concepts.

## Scope

In scope:

- stable session- and run-scoped logical sandbox identity;
- exact optional tenant/principal binding for standalone Harness users and a
  stricter PURISTA integration policy where the application requires it;
- adapter-private generations, leases, fencing, provider references, lifecycle
  records, retention, and cleanup;
- create, attach, detach, pause/resume, explicit replacement, termination, and
  state-loss behavior;
- reuse of the existing `DurableWorkspace` recovery and sandbox-binding rules;
- content-free telemetry and a two-client shared adapter contract;
- an optional `@purista/harness-sandbox-docker` local package, also targeting
  OrbStack through Docker, with no production-provider gate dependency;
- an evidence-based E2B/Daytona bake-off before provider selection.

Out of scope:

- a second `MultiInstanceSandbox` interface or managed-open API;
- extending `HarnessStorage` with sandbox lifecycle operations;
- public lease, fencing-token, provider-reference, or cleanup-queue APIs;
- `defaults.sandboxLifecycle`, a Harness maintenance facade, or a core daemon;
- globally serializing model calls, conversation writes, or all session work;
- selecting or implementing a production provider adapter before the bake-off
  decision is approved;
- treating affinity, a shared host filesystem, or a provider name as
  distributed coordination;
- automatic empty reset after state loss;
- guaranteeing that `SandboxProcess` handles or streams survive detach.

## Approved decisions

1. There is one `Sandbox` interface. Lifecycle-aware `open(...)`, session
   detach through `SandboxSession.close()`, and `terminate(...)` are required
   for every adapter. There is no `MultiInstanceSandbox`, `openManaged`, or
   `terminateManaged` surface.
2. Core constructs `SandboxScope` from the Harness name, the exact
   session-bound optional `HarnessIdentity`, session id, persisted session
   opaque `instanceId`, lifetime, optional run id, and role. Session identity mismatch
   fails before sandbox access. Recreating a closed session produces a new
   scope even when the caller intentionally reuses the human-facing session id.
3. Standalone Harness does not invent tenant or principal values and does not
   require them universally. Applications or framework integrations may
   require either field as policy. Omitted and present fields are distinct
   scope inputs.
4. Ordinary sessions use session lifetime. Durable workflows and child tasks
   use run lifetime. Run id is forbidden for session lifetime and required for
   run lifetime.
5. The adapter owns the logical directory and its generation counter.
   Generation starts at `1` and advances only when authorized committed
   workspace recovery replaces the prior generation. Attachment handoff and
   identical restore retries do not advance it. Termination is final for that
   scope; recreating a closed caller-facing session id produces a new scope and
   starts again at generation `1`.
6. `SandboxOpenMode` makes creation authority explicit. Core uses `create` only
   for a newly allocated session/run scope, `attach` for a persisted scope, and
   `restore` only after committed durable-workspace recovery. Attach never
   creates missing state, including after a process-local adapter loses its
   volatile directory.
7. Deployment topology is not part of the Harness or PURISTA business
   contract. There is no runtime multi-instance capability or topology branch.
   A production adapter must coordinate independently constructed clients and
   reject stale mutations internally; local adapters provide the same
   lifecycle within their documented process or host authority.
8. Provider references are opaque, non-secret, adapter-private values. Harness
   core, `HarnessStorage`, PURISTA, application code, and standard telemetry do
   not receive them.
9. A lost run-scoped sandbox may be replaced only after Harness has resumed the
   latest committed durable workspace checkpoint and established the existing
   spec-21 sandbox binding. Otherwise open fails `SandboxStateLostError`.
10. Built-in local adapters implement the same lifecycle contract within a
   process-local or single-host authority. Using them in a replicated
   deployment is a composition error, not a business-logic mode.
11. Adapter constructor/configuration owns provider timeouts, retention,
   hibernation, cleanup retry, and control-plane policy. Harness has no numeric
   lifecycle defaults and no cleanup scheduler.
12. No production provider addon begins until the shared contract is complete
    and the E2B/Daytona bake-off result receives its separate provider decision.
13. Local Docker is a separate optional addon using the same Sandbox contract,
    not a built-in default or a separate OrbStack implementation. Its first
    slice retains files on one engine but does not add a checkpoint system or
    claim compute-loss recovery. See [local Docker](./05-integration/local-docker.md).
14. Existing adapters, test doubles, callers, and active guidance are rewritten
    in place and verified together. No legacy interface, converter,
    compatibility branch, or partial old/new release is permitted. The exact
    inventory and acceptance gate are in
    [clean-break delivery](./04-delivery/migration-requirements.md).

## Public API Inventory

The Sandbox contract uses `SandboxScope`, `SandboxOpenMode`,
`SandboxOpenOptions`, `SandboxOpenResult`, `SandboxTerminateOptions`, and
`SandboxStateLostError`. The testing entrypoint adds
`sandboxMultiClientContract` for distributed adapter release conformance.
It is not used by Harness or PURISTA runtime logic. The only new runtime
capability is `sandbox.live_process_preservation`.

```yaml
execution_semantics:
  create: only a newly allocated scope may create; concurrent calls are idempotent
  attach: persisted scope must reattach or fail state-lost; it never creates
  restore: resume and bind committed workspace before authorizing next generation
  release: detach without termination
  close: accept adapter termination before deleting the session record
  shutdown: detach clients without terminating retained logical sandboxes
```

## Sources

- `plans/2026-08-25-distributed-sandbox-architecture-research.md`
- `plans/2026-08-25-sandbox-and-evaluation-direction.md`
- `specs/05-sandbox.md`
- `specs/21-durable-workspaces.md`
- `specs/32-harness-storage.md`
- implementation revision `c378607de9e7`
