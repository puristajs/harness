# @purista/harness-sandbox-docker

Local Docker sandbox adapter for `@purista/harness`.

The package implements one `Sandbox` contract and has no dependency on PURISTA.
Docker Desktop, OrbStack, and Linux Docker Engine are compatibility targets;
the verified environment is recorded below. Untested environments are not
advertised as supported solely because they expose Docker-compatible commands.

This package uses a caller-prepared image pinned by digest. It creates only
its own containers, volumes, and private lifecycle files beneath `root`; it
never mounts a host repository, home directory, Docker socket, or credentials.
It is intended for trusted single-host development, not hostile multi-tenant
workloads.

```ts
import { dockerSandbox } from '@purista/harness-sandbox-docker'

const sandbox = dockerSandbox({
  root: '/var/lib/my-app/sandboxes',
  image: 'ghcr.io/example/harness-tools@sha256:<digest>'
})
```

Docker Desktop and OrbStack are selected through the normal Docker context.
The adapter does not pull images. `mode: 'restore'` is intentionally rejected
until a compatible durable-workspace binding is available; retained volumes are
not durable workflow checkpoints.

The adapter uses the standard `Sandbox` interface—there is no separate
single-host or multi-instance API. `create` allocates a private volume and
container, `attach` opens the same logical scope, and `terminate` cleans up the
exact resources recorded in private metadata. A missing lifecycle record or
provider resource yields `SandboxStateLostError`; the adapter never replaces a
missing scope with a blank container.

## Image and engine preparation

Install the Docker CLI and provision a local Linux engine separately. Select its
Unix-socket Docker context, or pass `context` explicitly. The adapter resolves
the context once and pins both its socket endpoint and engine identity. Remote
TCP/SSH engines and Windows containers are rejected. It never pulls or builds
an image or falls back to running a requested command on the host. `image`
accepts `repository@sha256:<digest>` or `sha256:<local-image-id>`; mutable tags
are rejected. The local image ID form supports a privately built test image
without requiring a registry push.

The prepared image must have `/bin/sh`, `sleep`, `base64`, GNU-compatible `find`
and `stat`, `realpath`, `dirname`, `mkdir`, `rm`, `cat`, and `test`. Its
`/workspace` directory must already be writable by the configured UID/GID so
Docker initializes the private named volume with the right ownership. Prepare
other application paths, such as `/skills`, for the same non-root user when
they are needed. Missing utilities or workspace permissions fail preflight;
the adapter does not run a privileged repair command.

Every Sandbox path is an absolute **guest-container** path. The persistent
volume is `/workspace`, also the default execution directory. For example,
`session.write('/workspace/a.txt', 'hello')` and
`session.exec('cat /workspace/a.txt')` address the same file. Files elsewhere
are subject to guest permissions and belong to the container image layer;
they are not durable workspace checkpoints.

## Defaults and customization

Only `root` and the digest-pinned `image` are required. Optional `user` defaults
to `1000:1000`, `network` to `none`, and `resources` to one CPU, 512 MiB memory,
128 processes, and a 64 MiB `/tmp`. Resource fields can be overridden
individually. Networking can be explicitly enabled with `network: 'bridge'`;
this is not a destination allowlist. There is no raw Docker flag or mount
escape hatch. Configuration objects reject unknown fields.

CLI and exec operations use the Harness `toolTimeoutMs` default (120 seconds
when used independently); individual `exec` calls can set `timeoutMs`. stdout
and stderr are each bounded to 10 MiB, including streaming spawn output; an
overflow fails explicitly, without silent truncation. Binary file reads use
base64 transport and therefore share its encoded-output bound. CLI diagnostics
and inspect results never become public error details.

## Release, restart, and cleanup

`SandboxSession.close()` detaches that attachment. Multiple attachments from
one adapter share ownership; closing a file-only attachment leaves other
attachments usable. The final detach stops guest compute, releases ownership,
and retains the private container, volume, and metadata. A later `attach`
restarts the same container. Independent adapter instances using the same root
and engine must wait for the owner to release the scope.

Retained image, user, network, and resource policy must match the new adapter
configuration. A mismatch rejects attachment without changing compute; restore
the original configuration or explicitly terminate the old scope. Every new
host owner confirms guest work is stopped before attaching, even when an
ownership file is absent.

Cancellation, timeout, output overflow, and process cleanup may stop the
exclusively owned container to prove its guest processes have stopped. Other
processes attached to that scope can also stop; release and reattach to use
retained files. The adapter does not advertise live-process preservation.
Cleanup failures remain visible and retain ownership; retry `close()` after
the engine recovers. A confirmed dead host owner is recovered only after guest
work is stopped. Uncertain ownership fails closed instead of taking over.

At the Harness layer, `session.release()` preserves history and sandbox state;
`session.close()` deletes the conversation and explicitly terminates its
sandbox. `sandbox.terminate(...)` first persists terminal intent, then removes
only its labeled container and volume. Failed or interrupted cleanup is
retryable; attachment and recreation remain blocked. Successful termination
retains a private tombstone. A failed creation also retains terminal intent
until explicit termination confirms cleanup. Never delete metadata to repair
an error: missing metadata cannot authorize replacing or deleting retained
provider resources.

There is no automatic idle expiry, global prune, or background cleanup daemon.
Removing this adapter from configuration does not delete data. Monitor host
disk use and explicitly terminate scopes you no longer need; Docker named
volumes do not provide a portable hard disk quota. Retained volumes are not
backups and cannot recover engine/volume loss.

## Application-owned administration

Before direct lifecycle use, register the exact logical owner with
`sandbox.registerOwner(...)`. The host application authorizes that action and
all administration calls; the adapter does not interpret tenant or principal
roles. Use the `SandboxAdministration` surface for bounded `list`, exact
`purge`, and scheduled `sweep` calls. Treat provider references, owner
identities, cursors, snapshot metadata, and error diagnostics as sensitive
operational data: do not write them to application logs or telemetry.

Offboarding a principal fences that principal's attachments immediately. It
does not delete a tenant-owned shared sandbox while another authorized tenant
principal can still use it. Purge is idempotent and may return
`cleanup_pending` with `retryAfterMs` after an engine failure. Retain and retry
the adapter's private metadata; deleting it would turn an auditable cleanup
operation into state loss.

## Verification

`npm test --workspace @purista/harness-sandbox-docker` runs the shared sandbox
contract and private scripted-transport tests without Docker or credentials.
Those tests verify protocol behavior and failure handling, not kernel or
engine isolation. Real-engine tests are opt-in:

```sh
PURISTA_DOCKER_SANDBOX_IMAGE='registry.example/guest@sha256:YOUR_DIGEST' \
  npm run test:docker --workspace @purista/harness-sandbox-docker
```

Set `PURISTA_DOCKER_SANDBOX_CONTEXT` when testing a context other than the active
one. The image must already be present. `test/Dockerfile` shows the required
directory ownership for an operator-supplied digest-pinned Debian base; build
and provision the final image explicitly outside Harness execution. Record the
final image digest, OS, Docker CLI/engine versions, and OrbStack version where
applicable alongside smoke results before claiming support.

The live suite creates only uniquely namespaced disposable resources. It
terminates exactly its tracked scopes after each test and retains private
metadata if cleanup fails, allowing inspection and retry. No engine prune or
host directory mount is used. Do not run this opt-in suite against an engine
you do not own.

### Recorded local-engine evidence

Verified on 2026-08-26:

| Environment | Evidence |
| --- | --- |
| macOS 26.5.2 arm64, OrbStack 2.2.3 (build 2020300), Docker CLI/Engine 29.4.0 | Full live suite: 20 passed, including unsupported restore, guest-start/timeout cleanup and streaming stdin/stdout/stderr cancellation; standalone public-package Harness example passed. |
| Docker Desktop | Not yet verified. |
| Native Linux Docker Engine | Not yet verified. |

The disposable prepared image was
`sha256:41b693b5051e085a60b9a75c51226df6699d84660ae5b2cefef09bf97fc5ab50`,
built from the already-present
`node@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`.
The focused cleanup test confirms the guest wrote its start marker before the
timeout, then proves its delayed write did not survive stop and reattachment.
The streaming test confirms real guest stdin/stdout/stderr before cancellation,
then verifies the guest's delayed write did not survive reattachment.
This is local lifecycle evidence, not a claim of adversarial multi-tenant
isolation or cross-host recovery. The image IDs record the tested artifact;
applications prepare and pin their own images explicitly.

It is deliberately a narrow adapter: it does not mount host paths, Docker
sockets, credentials, or repositories into guests; it does not pull images;
and it only accepts a local Unix-socket Docker context. Use a Docker/OrbStack
engine you control and verify its platform-specific controls before relying on
it for any sensitive workload.
