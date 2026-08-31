# Standalone local Docker sandbox

This private example uses `@purista/harness-sandbox-docker` directly. It needs
no PURISTA framework, model provider, API key, agent, or Harness session storage.
The same adapter can be registered with `defineHarness().sandbox(...)` later.

## Prepare your engine and image

Use Node.js 24.15 or newer, the Docker CLI, and a local Linux Docker engine you
control. Docker Desktop, OrbStack, and Linux Docker Engine are compatibility
targets; see the adapter's [verification requirements](../../packages/harness-sandbox-docker/README.md#verification)
before relying on a particular engine for sensitive workloads.

Provision the guest image yourself. It must be present in the selected engine
and referenced as `repository@sha256:<digest>` or `sha256:<local-image-id>`.
Mutable tags are rejected. The example never downloads, pulls, builds, or
installs an image or guest dependency. See the adapter's
[image requirements](../../packages/harness-sandbox-docker/README.md#image-and-engine-preparation)
and [minimal Alpine recipe](../../packages/harness-sandbox-docker/image/README.md).
In particular, `/workspace` must be writable by UID/GID `1000:1000`.

From the repository root, after the workspace dependencies are installed:

```sh
PURISTA_DOCKER_SANDBOX_IMAGE='sha256:YOUR_PREPARED_IMAGE_ID' \
  npm run smoke --workspace @purista/local-docker-sandbox-example
```

Set `PURISTA_DOCKER_SANDBOX_CONTEXT` if you want a specific local Docker context.
Otherwise the adapter resolves and pins the active context. The `smoke` script
compiles the example against its declared public dependencies and then runs it
on the real engine. `npm run typecheck --workspace @purista/local-docker-sandbox-example`
checks it without touching Docker.

## What it demonstrates

`src/index.ts` creates a unique temporary metadata directory and an opaque
logical session instance. It creates one sandbox, writes a file, reads it
through `exec`, and closes the attachment. A separately constructed adapter
then attaches to the same scope and reads the retained file.

The adapter supplies defaults: non-root user, network disabled, bounded CPU,
memory, process count, temporary storage, command duration, and output size.
The temporary host directory is private lifecycle metadata; it is never mounted
inside the container. File operations address absolute guest paths such as
`/workspace/message.txt`.

Expected output:

```text
File/exec roundtrip and independent-client reattachment passed.
Owned sandbox resources and temporary metadata cleaned up.
```

This proves file retention across detach and attach. It does not demonstrate
live-process preservation, engine-loss recovery, or durable workflow restore.
Missing compute or metadata fails explicitly; this example never replaces it
with an empty container.

## Cleanup and failures

The `finally` block closes every acquired attachment and terminates only the
example's exact logical scope, including after failure or SIGINT/SIGTERM.
Successful termination is followed by removal of its unique temporary metadata
directory. No global prune or host-repository cleanup runs.

If termination fails, the example retains metadata and prints only its
application-owned options and scope. Keep that directory. After the engine is
healthy, use those same values to retry:

```ts
await dockerSandbox(options).terminate({ scope, reason: 'manual' })
```

Do not delete retained metadata to force creation, and do not assume that
rerunning the example cleans an earlier failed run. Each run owns a new scope.
