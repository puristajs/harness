import type { KubeConfig } from '@kubernetes/client-node'
import { HarnessConfigError, type DurableWorkspace, type Sandbox } from '@purista/harness'
import { createOfficialKubernetesSandboxDriver, type KubernetesSandboxDriver } from './driver.js'
import { KubernetesSandboxAdapter } from './sandbox.js'
import { KubernetesDurableWorkspace } from './workspace.js'

/** VolumeSnapshot behavior enabled for a Kubernetes-backed durable workspace. */
export interface KubernetesWorkspaceRuntimeOptions {
  /** Kubernetes VolumeSnapshotClass. Omit to use the cluster default. */
  readonly snapshotClassName?: string
  /** Maximum wait for a snapshot to become replayable. @defaultValue 120000 */
  readonly snapshotReadyTimeoutMs?: number
}

/** Composition options for the first-party Kubernetes sandbox/workspace bundle. */
export interface KubernetesSandboxRuntimeOptions {
  /** Namespace in which sandbox Pods, PVCs, snapshots, and control records live. */
  readonly namespace: string
  /** Non-root image containing Node.js and grep. */
  readonly image: string
  /** Stable label used to isolate multiple Harness runtimes in one namespace. @defaultValue purista-harness */
  readonly runtimeId?: string
  /** Container name used by Kubernetes exec. @defaultValue workspace */
  readonly containerName?: string
  /** Service account assigned to generated sandbox Pods. It should have no Kubernetes API authority. */
  readonly serviceAccountName?: string
  /** Optional RuntimeClass used for stronger node-level isolation such as gVisor or Kata. */
  readonly runtimeClassName?: string
  /** Pull policy applied to generated sandbox Pods. @defaultValue IfNotPresent */
  readonly imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never'
  /** Requested size for generated workspace PVCs. @defaultValue 1Gi */
  readonly volumeSize?: string
  /** StorageClass used for generated workspace PVCs. Omit to use the cluster default. */
  readonly storageClassName?: string
  /** Maximum wait for a generated Pod to become ready. @defaultValue 120000 */
  readonly podReadyTimeoutMs?: number
  /** Default wall-clock limit for one sandbox command. @defaultValue 30000 */
  readonly defaultCommandTimeoutMs?: number
  /** CPU limit applied to generated sandbox containers. @defaultValue 1 */
  readonly cpuLimit?: string
  /** Memory limit applied to generated sandbox containers. @defaultValue 1Gi */
  readonly memoryLimit?: string
  /** Ephemeral-storage limit applied to generated sandbox containers. @defaultValue 1Gi */
  readonly ephemeralStorageLimit?: string
  /** Maximum bytes returned by one filesystem read. */
  readonly maxFileBytes?: number
  /** Maximum combined bytes retained from one command execution. */
  readonly maxOutputBytes?: number
  /** Enable durable PVC generations and VolumeSnapshot checkpoints. @defaultValue false */
  readonly workspace?: false | true | KubernetesWorkspaceRuntimeOptions
  /** Uses the default kubeconfig loading chain when omitted. */
  readonly kubeConfig?: KubeConfig
  /** Injectable infrastructure boundary for tests and platform wrappers. */
  readonly driver?: KubernetesSandboxDriver
}

/** Resources returned by `kubernetesSandboxRuntime()` when workspaces are optional or disabled. */
export interface KubernetesSandboxRuntime {
  /** Sandbox adapter registered with `defineHarness().sandbox(...)`. */
  readonly sandbox: Sandbox
  /** Durable workspace when `workspace` was enabled. */
  readonly workspace?: DurableWorkspace
  /** Closes client-owned runtime resources without deleting logical sandbox state. */
  close(): Promise<void>
}

/** Runtime result whose durable workspace is known to exist at compile time. */
export interface KubernetesSandboxRuntimeWithWorkspace extends KubernetesSandboxRuntime {
  /** PVC/VolumeSnapshot durable workspace paired with the sandbox adapter. */
  readonly workspace: DurableWorkspace
}

/**
 * Creates a coordinated Kubernetes sandbox and optional durable workspace.
 * Application code normally calls this once at its composition root and
 * registers the returned adapters with one shared Harness runtime.
 *
 * @example
 * ```ts
 * const execution = kubernetesSandboxRuntime({
 *   namespace: 'purista-sandboxes',
 *   image: 'registry.example/sandbox@sha256:...',
 *   runtimeId: 'support-v1',
 *   workspace: true,
 * })
 * ```
 */
export function kubernetesSandboxRuntime(
  options: KubernetesSandboxRuntimeOptions & { readonly workspace: true | KubernetesWorkspaceRuntimeOptions },
): KubernetesSandboxRuntimeWithWorkspace
export function kubernetesSandboxRuntime(options: KubernetesSandboxRuntimeOptions): KubernetesSandboxRuntime
export function kubernetesSandboxRuntime(options: KubernetesSandboxRuntimeOptions): KubernetesSandboxRuntime {
  const resolved = validateOptions(options)
  const driver = options.driver ?? createOfficialKubernetesSandboxDriver({
    namespace: resolved.namespace,
    runtimeId: resolved.runtimeId,
    containerName: resolved.containerName,
    ...(options.kubeConfig ? { kubeConfig: options.kubeConfig } : {}),
    maxFileBytes: resolved.maxFileBytes,
    maxOutputBytes: resolved.maxOutputBytes,
    defaultCommandTimeoutMs: resolved.defaultCommandTimeoutMs,
  })
  const workspaceOptions = options.workspace && typeof options.workspace === 'object' ? options.workspace : {}
  const workspace = options.workspace
    ? new KubernetesDurableWorkspace({
        driver,
        runtimeId: resolved.runtimeId,
        volumeSize: resolved.volumeSize,
        ...(resolved.storageClassName ? { storageClassName: resolved.storageClassName } : {}),
        ...(workspaceOptions.snapshotClassName ? { snapshotClassName: workspaceOptions.snapshotClassName } : {}),
        snapshotReadyTimeoutMs: workspaceOptions.snapshotReadyTimeoutMs ?? 120_000,
      })
    : undefined
  const sandbox = new KubernetesSandboxAdapter({
    driver,
    runtimeId: resolved.runtimeId,
    ...(workspace ? { coordinator: workspace } : {}),
    image: resolved.image,
    containerName: resolved.containerName,
    ...(resolved.serviceAccountName ? { serviceAccountName: resolved.serviceAccountName } : {}),
    ...(resolved.runtimeClassName ? { runtimeClassName: resolved.runtimeClassName } : {}),
    imagePullPolicy: resolved.imagePullPolicy,
    volumeSize: resolved.volumeSize,
    ...(resolved.storageClassName ? { storageClassName: resolved.storageClassName } : {}),
    podReadyTimeoutMs: resolved.podReadyTimeoutMs,
    defaultCommandTimeoutMs: resolved.defaultCommandTimeoutMs,
    cpuLimit: resolved.cpuLimit,
    memoryLimit: resolved.memoryLimit,
    ephemeralStorageLimit: resolved.ephemeralStorageLimit,
  })
  let closePromise: Promise<void> | undefined
  return {
    sandbox,
    ...(workspace ? { workspace } : {}),
    close: async () => {
      closePromise ??= driver.close()
      await closePromise
    },
  }
}

const optionKeys = new Set<keyof KubernetesSandboxRuntimeOptions>([
  'namespace', 'image', 'runtimeId', 'containerName', 'serviceAccountName', 'runtimeClassName',
  'imagePullPolicy', 'volumeSize', 'storageClassName', 'podReadyTimeoutMs',
  'defaultCommandTimeoutMs', 'cpuLimit', 'memoryLimit', 'ephemeralStorageLimit',
  'maxFileBytes', 'maxOutputBytes', 'workspace', 'kubeConfig', 'driver',
])

function validateOptions(options: KubernetesSandboxRuntimeOptions) {
  for (const key of Object.keys(options)) {
    if (!optionKeys.has(key as keyof KubernetesSandboxRuntimeOptions)) invalid(`options.${key}`, 'unknown_option')
  }
  const namespace = requiredString(options.namespace, 'options.namespace')
  const image = requiredString(options.image, 'options.image')
  const runtimeId = optionalString(options.runtimeId, 'options.runtimeId') ?? 'purista-harness'
  const containerName = optionalString(options.containerName, 'options.containerName') ?? 'workspace'
  const serviceAccountName = optionalString(options.serviceAccountName, 'options.serviceAccountName')
  const runtimeClassName = optionalString(options.runtimeClassName, 'options.runtimeClassName')
  const storageClassName = optionalString(options.storageClassName, 'options.storageClassName')
  const imagePullPolicy = options.imagePullPolicy ?? 'IfNotPresent'
  if (!['Always', 'IfNotPresent', 'Never'].includes(imagePullPolicy)) invalid('options.imagePullPolicy', 'invalid_option')
  const workspace = options.workspace
  if (workspace !== undefined && workspace !== false && workspace !== true) {
    const keys = Object.keys(workspace)
    if (keys.some((key) => key !== 'snapshotClassName' && key !== 'snapshotReadyTimeoutMs')) {
      invalid(`options.workspace.${keys.find((key) => key !== 'snapshotClassName' && key !== 'snapshotReadyTimeoutMs')}`, 'unknown_option')
    }
    optionalString(workspace.snapshotClassName, 'options.workspace.snapshotClassName')
    if (workspace.snapshotReadyTimeoutMs !== undefined) positiveInteger(workspace.snapshotReadyTimeoutMs, 'options.workspace.snapshotReadyTimeoutMs')
  }
  return {
    namespace,
    image,
    runtimeId,
    containerName,
    serviceAccountName,
    runtimeClassName,
    imagePullPolicy,
    volumeSize: optionalString(options.volumeSize, 'options.volumeSize') ?? '5Gi',
    storageClassName,
    podReadyTimeoutMs: positiveInteger(options.podReadyTimeoutMs ?? 120_000, 'options.podReadyTimeoutMs'),
    defaultCommandTimeoutMs: positiveInteger(options.defaultCommandTimeoutMs ?? 30_000, 'options.defaultCommandTimeoutMs'),
    cpuLimit: optionalString(options.cpuLimit, 'options.cpuLimit') ?? '1000m',
    memoryLimit: optionalString(options.memoryLimit, 'options.memoryLimit') ?? '1Gi',
    ephemeralStorageLimit: optionalString(options.ephemeralStorageLimit, 'options.ephemeralStorageLimit') ?? '1Gi',
    maxFileBytes: positiveInteger(options.maxFileBytes ?? 10 * 1024 * 1024, 'options.maxFileBytes'),
    maxOutputBytes: positiveInteger(options.maxOutputBytes ?? 1024 * 1024, 'options.maxOutputBytes'),
  }
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(path, 'missing_option')
  return value.trim()
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return requiredString(value, path)
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalid(path, 'invalid_option')
  return value
}

function invalid(path: string, reason: string): never {
  throw new HarnessConfigError('Kubernetes sandbox runtime configuration is invalid.', { reason, path })
}
