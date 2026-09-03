# `@purista/harness-sandbox-kubernetes`

Self-hosted Kubernetes execution for `@purista/harness`. It keeps the public
Harness ports provider-neutral while Pods, PVCs, VolumeSnapshots, distributed
fencing, and cleanup remain private to this adapter.

```ts
import { kubernetesSandboxRuntime } from '@purista/harness-sandbox-kubernetes'

const execution = kubernetesSandboxRuntime({
  namespace: 'purista-sandboxes',
  image: 'ghcr.io/example/purista-harness-sandbox@sha256:replace-me',
  runtimeId: 'support-v1',
})

// execution.sandbox works without the VolumeSnapshot CRDs.
```

Enable durable files explicitly when the cluster has a CSI snapshot driver:

```ts
const execution = kubernetesSandboxRuntime({
  namespace: 'purista-sandboxes',
  image: 'ghcr.io/example/purista-harness-sandbox@sha256:replace-me',
  runtimeId: 'support-v1',
  storageClassName: 'standard-rwo',
  workspace: {
    snapshotClassName: 'standard-snapshots',
  },
})

const harness = defineHarness()
  .storage(storage)
  .sandbox(execution.sandbox)
  .workspace(execution.workspace)
  // definitions ...
  .build()

await harness.shutdown()
await execution.close()
```

The package does not require S3. Durable state stays in Kubernetes persistent
volumes and VolumeSnapshots. `close()` closes client-owned resources but does
not delete logical workspaces; lifecycle and administration calls own deletion.

`runtimeId` salts every owner, sandbox, Pod, PVC, workspace, binding, and
snapshot name. Use the same stable value across replicas of one logical
runtime, and a different value for independently administered runtimes sharing
the namespace.

For an image starting point, use the shared
[minimal Alpine recipe](../harness-sandbox-docker/image/README.md). Build for
your cluster architecture, scan and publish to your own registry, and configure
the resulting repository digest. The Docker adapter package is not required
in the Kubernetes worker; the recipe can be used in a separate image-build job.

The sandbox image must support UID/GID `65532`, contain Node.js and GNU `grep`,
and remain alive under `sleep infinity`. The adapter overrides the image user
and supplies `fsGroup: 65532` for mounted task volumes; verify CSI permissions.
It creates non-root Pods with a
read-only root filesystem, dropped Linux capabilities, RuntimeDefault seccomp,
resource limits, and no mounted service-account token. Apply namespace-level
ResourceQuota, Pod Security admission, and default-deny NetworkPolicy as part
of the deployment.

For deterministic tests or platform wrappers, inject a `KubernetesSandboxDriver`.
Production callers normally rely on the official Kubernetes client and its
standard kubeconfig loading chain.

Run the disposable-cluster integration with:

```sh
PURISTA_KUBERNETES_LIVE=1 \
PURISTA_KUBERNETES_NAMESPACE=purista-sandboxes \
PURISTA_KUBERNETES_SANDBOX_IMAGE=example@sha256:... \
PURISTA_KUBERNETES_SNAPSHOT_CLASS=standard-snapshots \
npm run test:live
```

The live test creates a Pod and PVC, commits and restores a VolumeSnapshot,
rejects the stale attachment, terminates the sandbox, and cleans the workspace.
