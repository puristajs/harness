# Local Docker adapter

Status: implemented and verified on OrbStack under `SBX-013`. Other engines
remain unverified; package publication is outside this local delivery.

## Package and boundary

`@purista/harness-sandbox-docker` is an optional ESM package at
`packages/harness-sandbox-docker`. Its `dockerSandbox(options)` factory returns
the existing `Sandbox` port. It depends only on public Harness exports and
the host Docker CLI; it never imports PURISTA or Harness internals. OrbStack
uses the same adapter through its Docker context, not a second package or API.

The package is for local development and trusted single-host operation against
one Linux-container Docker engine. It does not provision Docker, OrbStack,
E2B, Daytona, a cluster, or a control plane. It is not automatically selected
by `.sandbox()` and does not replace `localDirectorySandbox` or
`localDurableExecution`. Business logic continues to use the ordinary Sandbox
contract. Selecting this adapter is a composition-root decision.

The package is approved separately from production provider selection. Its
implementation waits for `GATE-SBX-CONTRACT`, but not `GATE-SBX-PROVIDER`.
It does not satisfy or bypass the E2B/Daytona production bake-off.

## Configuration and dependencies

`CTR-SBX-DOCKER` in `03-contracts/contracts.yaml` owns the closed configuration
shape and exported factory. Use the existing Harness factory naming, strict
TypeScript, Zod-derived option validation, typed errors, and TSDoc patterns.
There is no generator for this TypeScript adapter surface; the generation map
requires public-export/type tests instead of a new generator.

Use the installed `docker` CLI with argument arrays and no host shell.
Resolve and pin the configured context and engine identity before any resource
mutation; a context switch must not redirect an existing adapter instance.
Only a local Unix-socket endpoint is supported initially. TCP/SSH remote
engines and Windows containers fail configuration validation. Docker Desktop
and OrbStack Linux engines on macOS and Docker Engine on Linux are targets;
each advertised environment must have a recorded passing smoke test.

The caller supplies an already-present image by repository digest or immutable
local `sha256` image ID. The adapter
does not pull, build, update, or install software automatically. An example
may document explicit image preparation outside Harness execution. The image
must supply the shell/process utilities required by the adapter; preflight
checks report a sanitized configuration error instead of host-exec fallback.
No Docker SDK dependency, image registry service, or bundled guest daemon is
introduced in this first slice. Record the actual CLI/engine/OrbStack versions
and image digest in release-test evidence; compatibility claims are bounded
by that evidence, not by the fact that an environment accepts Docker commands.

## Files, lifecycle, and authority

- Each full `SandboxScope` resolves to one adapter-owned container and private
  named workspace volume. Container/volume names and labels use opaque derived
  keys, never raw session, tenant, principal, run, or host-path values.
- Private lifecycle metadata and tombstones live under the caller-owned
  `root`. Never mount this directory, the Docker socket, registry credentials,
  or the developer's home/repository into the container. The adapter owns only
  its recorded resources; it never runs global Docker prune operations.
- Filesystem methods, bounded `searchText`, `exec`, and streaming `spawn` execute inside the
  container. No command runs on the host except the fixed Docker CLI transport.
  Paths are guest-absolute; `/workspace` is the retained volume and default
  command directory. The image prepares any other writable paths (for example
  `/skills`) for the configured UID/GID. No implicit root prefix is applied.
  Timeout, cancellation, output bounds, and process-handle semantics follow
  the existing public sandbox contracts. Killing the host CLI alone is not
  proof that an in-container process stopped; tests must verify guest cleanup.
- Create is idempotent. Attach requires both matching private lifecycle state
  and the retained container/volume; it may restart a stopped existing
  container but never recreate a missing one. Engine unavailability is an
  operational failure, not state loss. Changing engine identity fails closed.
  A private policy hash binds image, user, network, and resource settings;
  incompatible attachment configuration fails, while explicit termination may
  still clean the exact recorded resources.
- Detach invalidates handles, stops attachment-owned processes, and leaves
  container, workspace volume, and lifecycle metadata for reattachment.
  The first slice does not promise live-process preservation.
- Independent clients on the same host using the same `root` and engine must
  not concurrently mutate one scope. Coordination is adapter-private: retain
  exclusive ownership or reject conflicts, with no forced lease takeover while
  old operations can still run. Crash recovery must confirm prior guest work
  is stopped before granting new authority; uncertain ownership fails closed.
  Do not add a distributed database, scheduler, or network service for this.
  A fresh owner stops retained guest work before granting attachment authority,
  even when no previous owner record remains. Same-adapter attachments share
  ownership and reference-count their detach operations.
- Termination records its terminal intent before deletion, stops the
  container, and removes only its owned container and volume. A partial failure
  remains retryable and cannot permit reattachment. Acknowledge only completed
  cleanup in this slice; there is no background cleanup service. Retain a
  tombstone after successful deletion. Explicit retry handles engine outages.

## Recovery scope — no second checkpoint system

A retained volume survives container stop and Harness restart, but is not a
committed `DurableWorkspace` checkpoint or a cross-host backup. The first
Docker slice supplies a Sandbox only, not another workspace/storage adapter.
It advertises `sandbox.fs`, `sandbox.text_search`, `sandbox.exec`, `sandbox.spawn`, and
`sandbox.persistent_fs`; it does not advertise snapshots, hibernation, live
process preservation, or durable-workspace recovery.

Missing lifecycle metadata, container, or volume produces
`SandboxStateLostError` without replacement. Until a compatible public
workspace binding is separately specified and verified, `mode: 'restore'`
fails with reason `durable_workspace_recovery_unavailable` before creating or
changing compute. Do not import the internal local-workspace coordinator,
copy its checkpoint implementation, or assume that pairing any workspace
adapter with Docker establishes a binding. Checkpoint-backed Docker recovery
is an explicit follow-up, not an implicit acceptance claim for this package.

This preserves the common guarantee: recover files only from a committed,
compatible durable workspace or report state loss; never synthesize empty
state. Applications needing compute-loss recovery must select a compatible
sandbox/workspace pair. No topology branch is added to their business logic.

## Security, telemetry, and limits

The prepared image also supplies an ERE-capable `grep`. The adapter validates
`safe_regex_v1` through the public Harness validator, invokes the fixed guest
binary with an argument array, and never interpolates model input into shell
source. It transfers file metadata and bounded match results—not every file's
contents—across the Docker transport. Missing search utilities fail preflight
rather than falling back to host or Harness-process matching.

Run as the configured non-root UID/GID with dropped Linux capabilities,
`no-new-privileges`, bounded temporary storage, and
explicit CPU/memory/PID limits. Network is disabled by default; explicit bridge
network access is a trusted application choice, not a destination allowlist.
No privileged mode, host networking/PID namespace, device passthrough,
arbitrary host mounts, published ports, or raw Docker-option escape hatch.
The guest may write its container filesystem and scoped workspace volume;
only the workspace volume is retained independently of container deletion.
Each stdout/stderr stream is bounded to 10 MiB; overflow is an explicit error,
not truncation. Cancellation, timeout, or process cleanup may stop the whole
exclusively owned container to prove guest termination. Attachments must not
assume unrelated live processes survived; no live-process capability is advertised.
Mounted skill/tool files follow the existing Sandbox path contract. Do not
claim that writable image-layer changes are recoverable workspace files.

Use manual cleanup on explicit termination; no idle TTL or autonomous deletion
default is added. Named-volume disk limits are not portable across supported
engines: document this limitation and host disk monitoring, and do not claim a
hard disk quota. Docker access is trusted host authority; container isolation
is not a claim of hostile multi-tenant or microVM-grade isolation. No immutable
plugin-mount capability is claimed by the first slice.

Reuse standard lifecycle telemetry. Exclude Docker inspect bodies, host paths,
context/socket values, container/volume IDs, labels, commands, output, image
credentials, and identity from logs, errors, traces, and metrics. Explicit exec
results may contain the requested output under the existing contract; telemetry
must not copy it. Host Docker inspection remains privileged operator access.

## Acceptance and local release

`ACC-SBX-DOCKER` covers standalone `.sandbox(dockerSandbox(...))`, filesystem
and exec/spawn behavior, detach/restart/reattach, context pinning, identity
separation, idempotent create/terminate, partial cleanup retry, conflict/stale
handle rejection, cancellation with guest-process cleanup, and zero host-exec
fallback. `ACC-SBX-DOCKER-LOSS` covers missing metadata/container/volume,
unavailable engine, unsupported restore with zero mutation, and privacy.

Run the shared `sandboxContract` plus adapter-specific same-host ownership and
security tests. Do not weaken `sandboxMultiClientContract` or claim its full
distributed guarantee for local Docker. Default tests use a private scripted
Docker transport and require neither a daemon nor credentials. Opt-in live
tests use pre-provisioned disposable resources, clean up only their exact
owned resources, and report untested environments explicitly. Prove a
standalone Harness example before documenting PURISTA composition.

Release docs cover installation, context/image preflight, resource policy,
release versus close, host restart, manual cleanup retry, state loss, disk
growth, and the preservation matrix. Removing the adapter configuration is
the rollback; it must not delete retained data implicitly. Shared package
dependency/license/vulnerability/provenance gates apply before publication.

## Primary evidence

Reviewed 2026-08-26; these establish platform behavior, not tested adapter support:

- [Docker run](https://docs.docker.com/reference/cli/docker/container/run/)
  documents security/resource/network flags and no-pull behavior.
- [Docker exec](https://docs.docker.com/reference/cli/docker/container/exec/)
  documents command execution within a running container.
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/)
  distinguishes volume persistence and explicit backup/restore operations.
- [OrbStack Docker](https://docs.orbstack.dev/docker/)
  documents its engine, contexts, volumes, and Compose compatibility.
