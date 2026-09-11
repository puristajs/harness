# Minimal Harness sandbox image

An Alpine-based, credential-free starting point for the Docker and Kubernetes
sandbox adapters. It contains Node.js 24, `/bin/sh`, GNU coreutils, findutils,
and grep. It deliberately does **not** contain the Harness, model SDKs, Git,
SSH, npm, Yarn, Corepack, an APK client, compilers, or your application.

This is a build recipe shipped in `@purista/harness-sandbox-docker`, not a
published container image or a managed patch service. Building it does not
build any Harness package. The same resulting image can be used by the
Kubernetes adapter without installing the Docker adapter in the worker.

## Build and verify

Install the matching adapter release in your application, then build from the
small packaged context, not from your repository root:

```sh
npm install @purista/harness@^3 @purista/harness-sandbox-docker@^3
docker build --pull -t harness-sandbox:local \
  node_modules/@purista/harness-sandbox-docker/image
export SANDBOX_IMAGE="$(docker image inspect harness-sandbox:local --format '{{.Id}}')"
```

The build needs network access to the pinned official Node image and Alpine
package repositories. The recipe never copies application files; its
`.dockerignore` excludes everything except the recipe. It removes development
tools in an intermediate stage, then copies the prepared root filesystem into
a fresh final stage, so removed content is not retained in lower final layers.

Run a disposable check with no host mounts or network access:

```sh
docker run --rm --pull=never --read-only --network=none \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=64 --memory=256m --cpus=1 --user=1000:1000 \
  --tmpfs /workspace:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700 \
  --tmpfs /skills:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=0700 \
  -i "$SANDBOX_IMAGE" sh -s \
  < node_modules/@purista/harness-sandbox-docker/image/smoke.sh
```

Expect `Sandbox image smoke passed`. The check proves required filesystem,
search, Node ESM and child-process operations; absent development tools;
non-root execution; no effective capabilities; no-new-privileges; read-only
root; and loopback-only network interfaces for **this invocation**. It does not
prove resistance to container escape or cluster isolation.

## Use with the adapters

For Docker, pass `SANDBOX_IMAGE` to `dockerSandbox({ root, image })` as shown in
the [adapter guide](../README.md). Its default `1000:1000` user matches the
image and the prepared `/workspace` and `/skills` ownership. No privileged
startup repair is needed. The adapter accepts the immutable local image ID;
it neither pulls nor builds images. Run its direct file/reattachment example
after the image check to verify volume initialization and lifecycle behavior.

For Kubernetes, build for the cluster node architecture, scan the result, and
publish it to **your** registry. Configure `kubernetesSandboxRuntime({ image,
... })` with the resulting `registry/repository@sha256:...` manifest digest,
not a Docker-local image ID. Registry publication is an explicit operator step.
Use the same recipe in a separate image-build job if the worker application
does not depend on the Docker adapter.

The Kubernetes adapter overrides the image user with UID/GID `65532:65532` and
`fsGroup: 65532`. It mounts writable PVC/emptyDir volumes at `/workspace`,
`/skills`, and `/tmp`; the read-only image directories are not its storage.
Verify that your CSI driver honors the required ownership. The image check can
be repeated with `--user=65532:65532` and `uid=65532,gid=65532` on all three
tmpfs mounts. This tests guest compatibility, not PVCs, RBAC, NetworkPolicy,
snapshots, or a live cluster.

## What is hardened—and what is not

| Image provides | Deployment must provide |
| --- | --- |
| Non-root default user; no setuid/setgid file bits | Enforced UID, dropped capabilities, no privilege escalation and seccomp |
| Reduced runtime without package-manager clients or Git credentials | No host paths, Docker socket, secrets, SSH agent or service-account token in the guest |
| Required GNU tools plus Node, with no application install | CPU, memory, PID, storage and output/time limits |
| Compatibility with a read-only root and writable task mounts | Read-only-root policy and correctly owned mounts |
| No baked-in credentials | Network denial/allowlisting and authenticated host-side operations |

**The image does not enforce networking or filesystem isolation.** Node can
open sockets, interpret downloaded code, and launch processes; BusyBox also
contains networking applets. Removing npm or Git reduces convenience and
footprint, not authority. `noexec` mounts do not stop a Node or shell interpreter
from reading a script. Never rely on command removal or prompts as a security
boundary.

The current Docker adapter drops capabilities, sets no-new-privileges, limits
resources and disables networking by default, but does **not** set a read-only
root filesystem. Its non-root user normally cannot modify root-owned runtime
files; `/workspace`, `/skills`, and temporary paths remain writable. The smoke
command above applies a stricter read-only-root check than that adapter.
The Kubernetes adapter sets read-only root and restricted pod controls, while
the operator must install and verify network policy and other cluster controls.
Use a stronger RuntimeClass/isolation boundary for hostile multi-tenant code.

Native TypeScript tool handlers still run in the trusted Harness host process.
Only operations dispatched through the sandbox execute in this image. Keep
model/provider, Git, registry and cloud credentials at that trusted boundary;
do not put them in guest environment variables or task files.

## Extend and maintain

- Copy the recipe into an application-owned image build when additional tools
  are needed. Add only reviewed tools during the build, before final hardening.
  Do not install tools or dependencies at agent runtime with production secrets.
- This is Alpine/musl, not glibc. Native npm modules and arbitrary Linux binaries
  may need a separately reviewed Debian-based image. It is not a ready-made
  coding-agent/dependency-install environment.
- The base image is pinned by multi-platform digest. Alpine package versions
  resolve from the selected distribution repositories at build time: **the
  recipe is not a bit-for-bit reproducible dependency lock**. Promote one scanned
  artifact by final digest. Use snapshot repositories/package locks if your
  reproducibility policy requires them.
- Retain package inventory, SBOM, provenance, notices and scan results with the
  artifact. Removed APK executables may still appear in retained OS package
  metadata; scanners can conservatively report those packages.
- Regularly rebuild with `--pull --no-cache`, review new base digests and package
  fixes, rerun the image checks and live adapter tests, then promote the new
  digest. `--pull` cannot update a pinned base digest. Pinning is not patching.
- Keep the previous artifact for rollback. Docker binds retained scopes to their
  original image/user/resource policy: drain or deliberately terminate old
  scopes before switching, rather than changing their image under attachment.

Primary references: [Node image variants](https://github.com/nodejs/docker-node#image-variants),
[Docker build practices](https://docs.docker.com/build/building/best-practices/),
and [Docker runtime controls](https://docs.docker.com/reference/cli/docker/container/run/).

## Maintainer verification

From the `packages/harness-sandbox-docker` directory, after building the image:

```sh
PURISTA_DOCKER_SANDBOX_IMAGE="$SANDBOX_IMAGE" \
  npm run test:image
PURISTA_DOCKER_SANDBOX_IMAGE="$SANDBOX_IMAGE" \
  npm run test:docker
```

These opt-in checks create only uniquely named disposable resources and clean
up their exact targets. Use an engine you own. Passing image checks for both
UIDs is not a live Kubernetes qualification.

### Verification snapshot: 2026-08-31

On macOS arm64 with OrbStack and Docker CLI/Engine 29.4.0, the image builds to
142,303,889 bytes (about 136 MiB uncompressed); Node accounts for most of the
runtime footprint. Final local image ID:
`sha256:29bda5ab8b0b2fb735ae138b7eddddda3686a896f37ac57cbc4534bcfe87a3d2`.
This is recorded evidence, not a registry pull reference or a future build ID.

Both restricted UID checks pass. The broader adapter suite passes 16 of 19
checks; two negative-request tests fail during fixture cleanup and the
streaming-cancellation test fails during close with an ownership-lock conflict.
All three failures also reproduce against the previous Debian fixture image.
They are not Alpine-specific, but the complete live-adapter gate remains red.
Do not treat this image as evidence that those lifecycle issues are resolved.
No live Kubernetes test or vulnerability scan is claimed here.
