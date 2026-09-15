# Distributed sandbox architecture research

Status: decision proposal, not an approved specification

Date: 2026-08-25

Audience: PURISTA maintainers, platform architects, and handbook authors

## Decision summary

The production default for a horizontally scaled Harness deployment should be a
remote sandbox control plane behind the existing provider-neutral `Sandbox`
port. A shared `HarnessStorage` implementation must own leases and fencing, and
a `DurableWorkspace` or provider snapshot must own replayable files. Application
replicas must persist and exchange only opaque sandbox references; they must not
assume that a process-local handle, host path, or container survives routing to
another replica.

Sticky routing is useful only as a latency optimization. It is not a correctness
or durability mechanism.

Before selecting a reference provider, run the same adapter contract and
failure tests against E2B and Daytona. E2B is the narrower, simple microVM
candidate. Daytona currently appears closest to the full Harness capability set,
especially persistent process sessions and pause/resume. This is an engineering
bake-off recommendation, not a procurement decision.

For customers that cannot use a managed control plane, keep the same port and
support a self-hosted implementation based on Kubernetes plus a sandbox runtime
such as gVisor, Kata Containers, or microVMs. That option has a materially larger
operational and security burden and should not be presented as the beginner
path.

## What exists today

The current design already separates three important responsibilities:

| Responsibility | Current abstraction | Production implication |
| --- | --- | --- |
| Live commands, processes, and filesystem access | [`Sandbox`](../packages/harness/src/sandbox/index.ts) | May be ephemeral and provider-local. |
| Replayable durable files | [`DurableWorkspace`](../specs/21-durable-workspaces.md) | Can restore work after a sandbox or host disappears. |
| Session/run records, ownership, and leases | `HarnessStorage` | Must be shared and multi-instance capable. |

The shipped sandbox implementations are in-memory, local-directory, and local
bash implementations. They are useful for development and tests, but they do
not make a process-local sandbox available to another application replica. The
Docker, E2B, and microVM adapters mentioned in [`05-sandbox.md`](../specs/05-sandbox.md)
are not currently shipped packages.

There are two different execution paths to keep distinct:

- Ordinary session state includes process-local busy/ownership behavior. Two
  replicas can therefore create independent local sandboxes for the same
  logical session unless routing or an external coordinator prevents it.
- Durable runs acquire storage-backed ownership and can start or resume a
  workspace before opening a sandbox. This is the stronger foundation for
  recovery, but it still requires a remote sandbox/workspace implementation and
  fencing-safe adapter semantics.

The current `Sandbox.open({ sessionId, runId, signal })` contract also lacks the
tenant/principal identity and generation or fencing information needed for a
safe multi-tenant, multi-instance implementation.

## The failure we must prevent

Assume request A reaches application replica 1 and creates sandbox `S`. Request
B for the same logical conversation reaches replica 2.

Replica 2 must never silently create a blank sandbox and continue under the same
logical identity. That produces the most dangerous failure mode: the API call
succeeds, but files, installed packages, processes, and tool state have drifted.

The acceptable outcomes are:

1. Replica 2 reattaches to `S` through a remote provider.
2. Replica 2 forwards work to the current fenced owner of `S`.
3. After proven owner loss, replica 2 creates a new sandbox generation and
   restores an explicit workspace/snapshot checkpoint.
4. If none is possible, the request fails with a recoverable state-loss error.

Correctness requires one active writer per logical sandbox generation. A stable
name without a lease or fencing token does not prevent split brain.

## Architecture options

| Option | Correct across replicas? | Preserves live processes? | Recovery | Operations | Recommended use |
| --- | --- | --- | --- | --- | --- |
| Load-balancer sticky sessions | No; routing can change on failure or scale events | Only while the selected replica lives | Poor | Low | Temporary development optimization only. |
| Stateful worker shard plus routing directory | Yes, with leases and fencing | Yes while owner lives | Forward, fail over, then restore | High | Self-hosted interactive workloads needing local runtime control. |
| Queue partitioned by sandbox key | Yes, with a single consumer per partition | Worker-dependent | Reassign and restore | Medium-high | Async or long-running jobs where added latency is acceptable. |
| Stateless worker plus restore on every turn | Yes | No | Strong for checkpointable filesystem work | Medium | Batch/exec workloads that do not require warm processes. |
| Managed remote sandbox control plane | Yes, if the reference and lease are shared | Provider-dependent | Reattach, resume, or snapshot restore | Low-medium | Recommended enterprise default. |
| Self-hosted sandbox control plane | Yes, if implemented correctly | Runtime-dependent | Reattach or restore | Very high | Compliance, sovereignty, or custom-runtime requirements. |

### Why affinity is insufficient

Kubernetes `ClientIP` affinity and proxy stateful-session filters can improve hit
rates, but replica replacement, endpoint changes, retries, NAT, and deployments
still move traffic. Envoy explicitly documents load-imbalance and security
considerations for strong stateful sessions. Affinity may sit in front of the
recommended design, but it cannot replace shared ownership or state.

### Why a remote provider is insufficient by itself

A remote sandbox API solves placement, but PURISTA still needs to define:

- the stable logical key and tenant boundary;
- the current generation, owner lease, and fencing token;
- where the opaque provider reference is persisted;
- idempotent get-or-create and reattach behavior;
- snapshot/checkpoint and restore policy;
- stale-reference and provider-outage behavior;
- cleanup, retention, quotas, network policy, and audit events;
- how a run, trace, sandbox, and workspace correlate without exposing secrets.

## Recommended target design

```text
client
  -> stateless PURISTA/Harness replica
     -> shared HarnessStorage: session/run + lease + generation/fence
     -> Sandbox adapter: idempotent open/reattach by logical key
        -> remote sandbox control plane: live compute and processes
     -> DurableWorkspace/object store: replayable file checkpoint
     -> telemetry: lifecycle events and opaque correlations
```

Use a stable logical key derived from authenticated scope, for example:

```text
tenant / project-or-agent / session / run / sandbox-role / generation
```

Do not use a transport connection, host name, local path, or unauthenticated
caller-supplied session ID as the sole key.

The storage record should contain only provider-neutral lifecycle information:

- logical sandbox key and generation;
- opaque provider reference;
- owning lease and fencing token;
- status such as creating, ready, paused, restoring, terminated, or lost;
- last successful checkpoint reference and timestamp;
- policy/adapter version needed to validate safe reattachment;
- timestamps and cleanup deadline.

Provider credentials, host paths, command output, and secrets must not be stored
in this record.

### Request behavior

1. Authenticate and derive the scoped logical key.
2. Acquire or validate the run/sandbox lease in multi-instance storage.
3. Read the current generation and opaque provider reference.
4. Ask the adapter to reattach or idempotently create under the fencing token.
5. If the provider reports the sandbox missing, transition through an explicit
   restoring state and create a new generation from the latest valid checkpoint.
6. Execute only while the lease remains valid; reject results from stale owners.
7. Checkpoint at declared boundaries and emit lifecycle telemetry.
8. Pause or terminate according to retention and cost policy.

## Provider comparison

This comparison describes publicly documented capabilities as of 2026-08-25.
Security, regions, quotas, support, pricing, and contractual terms require a
separate procurement review.

| Provider | Persistence model | Reconnect/restore model | Deployment control | Harness fit |
| --- | --- | --- | --- | --- |
| Daytona | Files persist across stop/start; documented VM pause/resume can preserve memory; snapshots, forks, volumes, and process sessions | Start/resume an existing sandbox; snapshot/fork when a new generation is needed | Managed, dedicated compute, and BYOC options | Strongest apparent match for `fs`, `exec`, persistent processes, pause/resume, and enterprise deployment choices. |
| E2B | Firecracker microVM sandbox with reconnect-by-ID, pause/resume and snapshot APIs in the current SDK | Connect to an existing sandbox or restore from a filesystem/memory snapshot | Managed plus enterprise deployment options | Strong focused candidate and likely the smallest useful reference adapter. Validate persistent process and hibernation semantics in the spike. |
| Vercel Sandbox | Named sandboxes are documented as persistent by default; supports get-or-create/resume, snapshots, and drives | Resume named state or restore a snapshot | Managed Vercel platform | Attractive TypeScript experience; more platform-specific and currently newer as a persistent offering. |
| Modal | Remote sandbox with filesystem/directory snapshots and alpha memory snapshots | Persist snapshot ID externally and restore a new sandbox | Managed platform | Good FaaS/batch fit; weaker default for indefinitely warm interactive processes. |
| Cloudflare Sandbox SDK | Deterministic ID is coordinated by a Durable Object, but the underlying container can be replaced and lose local files/processes | Restore from backup/mounted storage; do not treat process IDs as durable | Cloudflare Workers platform; 1.0 preview | Useful when already on Workers, but reinforces the need for `DurableWorkspace`. Preview status makes it unsuitable as the sole reference today. |
| AWS Bedrock AgentCore Code Interpreter | Session-scoped microVM; documented session timeout and cleanup; S3/EFS can persist/shared files | Continue within session or use mounted durable storage | AWS-managed with VPC options | Strong AWS-native code-interpreter option, but only a partial match for the general-purpose `Sandbox`/spawn contract. |
| Kubernetes plus hardened runtime | PVC/snapshot policy chosen by operator; StatefulSet can give stable identity | Route to owner or recreate and mount/restore storage | Full self-hosted control | Highest customization and compliance control, with the highest platform and security engineering cost. |

### Recommended provider bake-off

Spike E2B and Daytona against one identical contract. Do not build several
production packages before this evidence exists.

Measure:

- create and warm-reattach latency from two independent adapter instances;
- concurrent `open` of the same logical key;
- preservation of files, environment, and long-lived processes;
- pause/resume and snapshot/restore behavior;
- lost-owner and stale-reference behavior;
- cancellation and command-stream semantics;
- tenant isolation, network restriction, secrets injection, and audit data;
- quota controls and cleanup guarantees;
- telemetry hooks and opaque correlation support;
- region, BYOC/self-hosting, and enterprise support requirements;
- actual cost under expected idle/warm/active distributions.

## Proposed Harness changes

These items require an approved specification before implementation.

### P0: make current boundaries explicit

- Document that local, bash, and directory sandboxes are single-process
  development adapters and are not horizontally scalable production state.
- Document that `storage.multi_instance` is required for durable execution or a
  shared logical sandbox across replicas.
- Define a specific state-loss error; never transparently substitute an empty
  sandbox for a missing generation.

### P1: multi-instance sandbox contract

- Add a `sandbox.multi_instance` capability or an equivalent explicit adapter
  declaration.
- Replace the minimal open options with an explicit scoped contract containing
  tenant/principal identity, logical sandbox key, generation, fencing token,
  workspace/checkpoint reference, and cancellation signal.
- Specify idempotent `open`, reattach, pause, resume, snapshot, and terminate
  semantics without leaking provider handles.
- Require adapter implementations to reject stale fencing tokens.
- Add contract tests using two adapter instances and one shared fake storage.

### P2: reference managed adapter

- Implement the winner of the E2B/Daytona bake-off as an optional package.
- Add an end-to-end sample with two Harness replicas and a shared storage
  adapter.
- Test rolling restart, scale-out, owner death, provider sandbox eviction,
  restore, and cleanup.

### P3: self-hosted reference architecture

- Publish an operator-oriented deployment pattern rather than pretending it is
  a simple adapter install.
- Define required isolation class, single-writer storage, network policy,
  workload identity, image provenance, resource quotas, eviction, snapshots,
  observability, and incident cleanup.

## Handbook plan

Create one concept hub and focused action pages:

1. **Choose a sandbox for development and production** — local versus remote,
   capability matrix, and explicit safety boundary.
2. **Run sandboxes from multiple application replicas** — the state model,
   required shared storage, stable keys, leases, and the recommended managed
   path.
3. **Recover sandbox work safely** — live process state versus durable files,
   checkpoints, generations, and failure behavior.
4. **Configure a remote sandbox provider** — one tested reference adapter with
   credentials, network controls, cleanup, and verification.
5. **Operate self-hosted sandboxes** — an advanced enterprise page covering the
   platform responsibilities and threat model.
6. **Troubleshoot missing or drifted sandbox state** — symptoms, diagnostic
   identifiers, safe recovery, and what never to retry blindly.

Every page should state whether it preserves files, processes, installed
packages, environment variables, and network connections across requests and
failures. Avoid the ambiguous word “persistent” without naming the preserved
state.

## Acceptance criteria for the eventual design

- Two independent app replicas opening the same logical generation cannot create
  two writable sandboxes.
- A stale owner cannot commit output after its lease is fenced.
- A request routed to a new replica can reattach without state drift or can
  restore a new, explicit generation from a known checkpoint.
- Cross-tenant keys and references are rejected.
- Provider loss produces a typed, observable transition rather than silent empty
  state.
- Local adapters remain easy to use while being clearly labeled as
  single-process development choices.
- The reference sample passes during scale-out, rolling restart, and forced
  owner termination.

## Primary sources

- [E2B JavaScript sandbox API: connect to an existing sandbox](https://docs.e2b.dev/sdk-reference/js-sdk/v1.5.2/sandbox)
- [E2B current JavaScript SDK sandbox source](https://github.com/e2b-dev/E2B/blob/main/packages/js-sdk/src/sandbox/index.ts)
- [E2B product and enterprise deployment overview](https://e2b.dev/)
- [Daytona persistence](https://www.daytona.io/docs/en/persistence/)
- [Daytona process and session execution](https://www.daytona.io/docs/en/process-code-execution/)
- [Daytona architecture](https://www.daytona.io/docs/en/architecture/)
- [Daytona scale and dedicated compute](https://www.daytona.io/docs/en/scale/)
- [Modal sandboxes](https://modal.com/docs/guide/sandboxes)
- [Modal sandbox snapshots](https://modal.com/docs/guide/sandbox-snapshots)
- [Vercel Sandbox duration and persistence](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)
- [Vercel Sandbox persistence GA](https://vercel.com/changelog/sandbox-persistence-is-now-ga)
- [Cloudflare Sandbox lifecycle](https://developers.cloudflare.com/sandbox/1-0-preview/lifecycle/)
- [AWS AgentCore code-interpreter session characteristics](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-session-characteristics.html)
- [AWS AgentCore code-interpreter filesystem configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-filesystem-configurations.html)
- [Kubernetes StatefulSet](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- [Kubernetes session affinity](https://kubernetes.io/docs/reference/networking/virtual-ips/#session-affinity)
- [Kubernetes persistent volumes and single-writer access](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Envoy stateful session filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/stateful_session_filter.html)
