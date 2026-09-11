import { createHash } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'

import {
  CoreV1Api,
  CustomObjectsApi,
  Exec,
  KubeConfig,
  type V1ConfigMap,
  type V1PersistentVolumeClaim,
  type V1Pod,
  type V1Status,
} from '@kubernetes/client-node'
import {
  OperationCancelledError,
  OperationTimeoutError,
  SANDBOX_TEXT_SEARCH_LIMITS,
  SandboxError,
  type DirEntry,
  type ExecResult,
  type FileStat,
  type SandboxTextSearchRequest,
  type SandboxTextSearchResult,
} from '@purista/harness'

/** Adapter-private control value paired with its Kubernetes resource version. */
export interface VersionedKubernetesRecord<T = unknown> {
  /** Kubernetes object name. */
  readonly name: string
  /** Opaque resource version used for compare-and-swap replacement. */
  readonly version: string
  /** Application-level record discriminator. */
  readonly kind: string
  /** Parsed control value. */
  readonly value: T
}

/** Desired PVC and optional snapshot-restore source. */
export interface KubernetesVolumeOptions {
  /** PVC name. */
  readonly name: string
  /** Requested storage quantity such as `1Gi`. */
  readonly size: string
  /** StorageClass name, or the cluster default when omitted. */
  readonly storageClassName?: string
  /** VolumeSnapshot used as the PVC data source when restoring. */
  readonly snapshotName?: string
}

/** Restricted sandbox Pod inputs accepted by a Kubernetes driver. */
export interface KubernetesPodOptions {
  /** Pod name. */
  readonly name: string
  /** PVC mounted at `/workspace`. */
  readonly volumeName: string
  /** Reviewed sandbox container image. */
  readonly image: string
  /** Container selected by exec operations. */
  readonly containerName: string
  /** Tokenless service account assigned to the Pod. */
  readonly serviceAccountName?: string
  /** Optional stronger-isolation RuntimeClass. */
  readonly runtimeClassName?: string
  /** Container image pull behavior. */
  readonly imagePullPolicy: 'Always' | 'IfNotPresent' | 'Never'
  /** Container CPU limit. */
  readonly cpuLimit: string
  /** Container memory limit. */
  readonly memoryLimit: string
  /** Container ephemeral-storage limit. */
  readonly ephemeralStorageLimit: string
  /** Content-free ownership labels. */
  readonly labels: Readonly<Record<string, string>>
}

/** One argv-based command executed in a sandbox Pod without a host shell. */
export interface KubernetesCommandOptions {
  /** Target Pod. */
  readonly podName: string
  /** Executable and arguments. */
  readonly command: readonly string[]
  /** Optional standard-input payload. */
  readonly stdin?: string | Uint8Array
  /** Optional working directory inside the container. */
  readonly cwd?: string
  /** Explicit environment additions for the command. */
  readonly env?: Readonly<Record<string, string>>
  /** Wall-clock timeout in milliseconds. */
  readonly timeoutMs: number
  /** Optional caller cancellation signal. */
  readonly signal?: AbortSignal
}

/**
 * Injectable Kubernetes boundary. The default implementation uses the
 * official Kubernetes JavaScript client; injection keeps contract tests
 * deterministic and lets platforms wrap cluster access without changing the
 * Harness ports.
 */
export interface KubernetesSandboxDriver {
  /** Reads one versioned control record. */
  readRecord<T = unknown>(name: string): Promise<VersionedKubernetesRecord<T> | undefined>
  /** Creates a control record only when its name is absent. */
  createRecord(name: string, kind: string, value: unknown): Promise<boolean>
  /** Replaces a control record only at the expected resource version. */
  replaceRecord(name: string, expectedVersion: string, kind: string, value: unknown): Promise<boolean>
  /** Deletes one control record idempotently. */
  deleteRecord(name: string): Promise<void>
  /** Lists control records owned by the configured runtime. */
  listRecords(): Promise<readonly VersionedKubernetesRecord[]>

  /** Ensures the requested PVC exists with compatible immutable inputs. */
  ensureVolume(options: KubernetesVolumeOptions): Promise<void>
  /** Reports whether a PVC exists. */
  volumeExists(name: string): Promise<boolean>
  /** Deletes a PVC idempotently. */
  deleteVolume(name: string): Promise<void>
  /** Ensures a restricted sandbox Pod exists. */
  ensurePod(options: KubernetesPodOptions): Promise<void>
  /** Reports whether a Pod exists. */
  podExists(name: string): Promise<boolean>
  /** Waits until the Pod is ready or the deadline/cancellation wins. */
  waitForPodReady(name: string, timeoutMs: number, signal?: AbortSignal): Promise<void>
  /** Deletes a Pod idempotently. */
  deletePod(name: string): Promise<void>

  /** Reads one bounded workspace file. */
  readFile(podName: string, path: string, signal?: AbortSignal): Promise<Uint8Array>
  /** Writes one workspace file. */
  writeFile(podName: string, path: string, data: Uint8Array, signal?: AbortSignal): Promise<void>
  /** Removes a workspace path. */
  removeFile(podName: string, path: string, recursive: boolean, signal?: AbortSignal): Promise<void>
  /** Lists workspace entries under one path. */
  listFiles(podName: string, path: string, recursive: boolean, glob: string | undefined, signal?: AbortSignal): Promise<DirEntry[]>
  /** Reads metadata for one workspace path. */
  statFile(podName: string, path: string, signal?: AbortSignal): Promise<FileStat>
  /** Reports whether one workspace path exists. */
  fileExists(podName: string, path: string, signal?: AbortSignal): Promise<boolean>
  /** Runs bounded literal or safe-regex search where workspace data lives. */
  searchText(podName: string, request: SandboxTextSearchRequest): Promise<SandboxTextSearchResult>
  /** Executes one argv-based command in the target Pod. */
  runCommand(options: KubernetesCommandOptions): Promise<ExecResult>

  /** Creates a VolumeSnapshot from a PVC. */
  createVolumeSnapshot(name: string, volumeName: string, snapshotClassName?: string): Promise<void>
  /** Reports whether a VolumeSnapshot exists. */
  snapshotExists(name: string): Promise<boolean>
  /** Waits until a VolumeSnapshot is ready to use. */
  waitForVolumeSnapshotReady(name: string, timeoutMs: number, signal?: AbortSignal): Promise<void>
  /** Deletes a VolumeSnapshot idempotently. */
  deleteVolumeSnapshot(name: string): Promise<void>
  /** Closes client-owned resources without deleting logical state. */
  close(): Promise<void>
}

/** Official Kubernetes client configuration and operation byte limits. */
export interface OfficialKubernetesSandboxDriverOptions {
  /** Namespace containing generated resources. */
  readonly namespace: string
  /** Stable runtime isolation label. */
  readonly runtimeId: string
  /** Container selected for Kubernetes exec. */
  readonly containerName: string
  /** Preconfigured client; omit to load the standard kubeconfig chain. */
  readonly kubeConfig?: KubeConfig
  /** Maximum bytes returned by one file read. */
  readonly maxFileBytes: number
  /** Maximum bytes retained from one command. */
  readonly maxOutputBytes: number
  /** Default command timeout in milliseconds. */
  readonly defaultCommandTimeoutMs: number
}

/** Creates the driver backed by the official Kubernetes JavaScript client. */
export function createOfficialKubernetesSandboxDriver(
  options: OfficialKubernetesSandboxDriverOptions,
): KubernetesSandboxDriver {
  const kubeConfig = options.kubeConfig ?? new KubeConfig()
  if (!options.kubeConfig) kubeConfig.loadFromDefault()
  return new OfficialKubernetesSandboxDriver(kubeConfig, options)
}

class OfficialKubernetesSandboxDriver implements KubernetesSandboxDriver {
  private readonly core
  private readonly custom
  private readonly exec
  private readonly labelSelector: string

  public constructor(
    kubeConfig: KubeConfig,
    private readonly options: OfficialKubernetesSandboxDriverOptions,
  ) {
    this.core = kubeConfig.makeApiClient(CoreV1Api)
    this.custom = kubeConfig.makeApiClient(CustomObjectsApi)
    this.exec = new Exec(kubeConfig)
    this.labelSelector = `purista.dev/runtime=${options.runtimeId}`
  }

  public async readRecord<T>(name: string): Promise<VersionedKubernetesRecord<T> | undefined> {
    try {
      const value = await this.core.readNamespacedConfigMap({ name, namespace: this.options.namespace })
      return configMapRecord<T>(value)
    } catch (error) {
      if (statusCode(error) === 404) return undefined
      throw providerError('Kubernetes control record read failed.', error)
    }
  }

  public async createRecord(name: string, kind: string, value: unknown): Promise<boolean> {
    try {
      await this.core.createNamespacedConfigMap({
        namespace: this.options.namespace,
        body: {
          metadata: {
            name,
            labels: {
              'app.kubernetes.io/managed-by': 'purista-harness',
              'purista.dev/runtime': this.options.runtimeId,
              'purista.dev/record-kind': labelValue(kind),
            },
          },
          data: { kind, record: JSON.stringify(value) },
        },
        fieldManager: 'purista-harness',
        fieldValidation: 'Strict',
      })
      return true
    } catch (error) {
      if (statusCode(error) === 409) return false
      throw providerError('Kubernetes control record creation failed.', error)
    }
  }

  public async replaceRecord(name: string, expectedVersion: string, kind: string, value: unknown): Promise<boolean> {
    try {
      await this.core.replaceNamespacedConfigMap({
        name,
        namespace: this.options.namespace,
        body: {
          metadata: {
            name,
            resourceVersion: expectedVersion,
            labels: {
              'app.kubernetes.io/managed-by': 'purista-harness',
              'purista.dev/runtime': this.options.runtimeId,
              'purista.dev/record-kind': labelValue(kind),
            },
          },
          data: { kind, record: JSON.stringify(value) },
        },
        fieldManager: 'purista-harness',
        fieldValidation: 'Strict',
      })
      return true
    } catch (error) {
      if (statusCode(error) === 409 || statusCode(error) === 404) return false
      throw providerError('Kubernetes control record replacement failed.', error)
    }
  }

  public async deleteRecord(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedConfigMap({ name, namespace: this.options.namespace })
    } catch (error) {
      if (statusCode(error) !== 404) throw providerError('Kubernetes control record deletion failed.', error)
    }
  }

  public async listRecords(): Promise<readonly VersionedKubernetesRecord[]> {
    try {
      const page = await this.core.listNamespacedConfigMap({
        namespace: this.options.namespace,
        labelSelector: this.labelSelector,
      })
      return (page.items ?? []).map((item) => configMapRecord(item)).filter((item): item is VersionedKubernetesRecord => item !== undefined)
    } catch (error) {
      throw providerError('Kubernetes control record listing failed.', error)
    }
  }

  public async ensureVolume(options: KubernetesVolumeOptions): Promise<void> {
    if (await this.volumeExists(options.name)) return
    const body: V1PersistentVolumeClaim = {
      metadata: {
        name: options.name,
        labels: {
          'app.kubernetes.io/managed-by': 'purista-harness',
          'purista.dev/runtime': this.options.runtimeId,
        },
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: options.size } },
        ...(options.storageClassName ? { storageClassName: options.storageClassName } : {}),
        ...(options.snapshotName ? {
          dataSource: {
            apiGroup: 'snapshot.storage.k8s.io',
            kind: 'VolumeSnapshot',
            name: options.snapshotName,
          },
        } : {}),
      },
    }
    try {
      await this.core.createNamespacedPersistentVolumeClaim({
        namespace: this.options.namespace, body, fieldManager: 'purista-harness', fieldValidation: 'Strict',
      })
    } catch (error) {
      if (statusCode(error) !== 409) throw providerError('Kubernetes workspace volume creation failed.', error)
    }
  }

  public async volumeExists(name: string): Promise<boolean> {
    try {
      await this.core.readNamespacedPersistentVolumeClaim({ name, namespace: this.options.namespace })
      return true
    } catch (error) {
      if (statusCode(error) === 404) return false
      throw providerError('Kubernetes workspace volume lookup failed.', error)
    }
  }

  public async deleteVolume(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedPersistentVolumeClaim({ name, namespace: this.options.namespace })
    } catch (error) {
      if (statusCode(error) !== 404) throw providerError('Kubernetes workspace volume deletion failed.', error)
    }
  }

  public async ensurePod(options: KubernetesPodOptions): Promise<void> {
    if (await this.podExists(options.name)) return
    const body: V1Pod = {
      metadata: {
        name: options.name,
        labels: {
          ...options.labels,
          'app.kubernetes.io/managed-by': 'purista-harness',
          'purista.dev/runtime': this.options.runtimeId,
        },
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: 'Never',
        ...(options.serviceAccountName ? { serviceAccountName: options.serviceAccountName } : {}),
        ...(options.runtimeClassName ? { runtimeClassName: options.runtimeClassName } : {}),
        securityContext: {
          runAsNonRoot: true,
          seccompProfile: { type: 'RuntimeDefault' },
          fsGroup: 65_532,
        },
        containers: [{
          name: options.containerName,
          image: options.image,
          imagePullPolicy: options.imagePullPolicy,
          command: ['sleep', 'infinity'],
          workingDir: '/workspace',
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            runAsNonRoot: true,
            runAsUser: 65_532,
            runAsGroup: 65_532,
            capabilities: { drop: ['ALL'] },
          },
          resources: {
            requests: { cpu: '10m', memory: '32Mi' },
            limits: {
              cpu: options.cpuLimit,
              memory: options.memoryLimit,
              'ephemeral-storage': options.ephemeralStorageLimit,
            },
          },
          volumeMounts: [
            { name: 'workspace', mountPath: '/workspace' },
            { name: 'tmp', mountPath: '/tmp' },
            { name: 'skills', mountPath: '/skills' },
          ],
        }],
        volumes: [
          { name: 'workspace', persistentVolumeClaim: { claimName: options.volumeName } },
          { name: 'tmp', emptyDir: { sizeLimit: options.ephemeralStorageLimit } },
          { name: 'skills', emptyDir: { sizeLimit: options.ephemeralStorageLimit } },
        ],
      },
    }
    try {
      await this.core.createNamespacedPod({
        namespace: this.options.namespace, body, fieldManager: 'purista-harness', fieldValidation: 'Strict',
      })
    } catch (error) {
      if (statusCode(error) !== 409) throw providerError('Kubernetes sandbox pod creation failed.', error)
    }
  }

  public async podExists(name: string): Promise<boolean> {
    try {
      const pod = await this.core.readNamespacedPod({ name, namespace: this.options.namespace })
      return pod.metadata?.deletionTimestamp === undefined
    } catch (error) {
      if (statusCode(error) === 404) return false
      throw providerError('Kubernetes sandbox pod lookup failed.', error)
    }
  }

  public async waitForPodReady(name: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      try {
        const pod = await this.core.readNamespacedPod({ name, namespace: this.options.namespace })
        if (pod.status?.phase === 'Running' && pod.status.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')) return
        if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
          throw new SandboxError('Kubernetes sandbox pod terminated before it became ready.', { reason: 'provider_failed' })
        }
      } catch (error) {
        if (statusCode(error) !== 404) throw error
      }
      await abortableDelay(100, signal)
    }
    throw new OperationTimeoutError('Kubernetes sandbox pod readiness timed out.', { scope: 'sandbox_run', timeout_ms: timeoutMs })
  }

  public async deletePod(name: string): Promise<void> {
    try {
      await this.core.deleteNamespacedPod({
        name, namespace: this.options.namespace, gracePeriodSeconds: 0, propagationPolicy: 'Background',
      })
    } catch (error) {
      if (statusCode(error) !== 404) throw providerError('Kubernetes sandbox pod deletion failed.', error)
    }
  }

  public async readFile(podName: string, path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const result = await this.fileOperation(podName, 'read', { path }, signal)
    return Uint8Array.from(Buffer.from(stringResult(result), 'base64'))
  }

  public async writeFile(podName: string, path: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (data.byteLength > this.options.maxFileBytes) {
      throw new SandboxError('Sandbox file exceeds the configured write limit.', { reason: 'file_too_large' })
    }
    await this.fileOperation(podName, 'write', { path, data: Buffer.from(data).toString('base64') }, signal)
  }

  public async removeFile(podName: string, path: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    await this.fileOperation(podName, 'remove', { path, recursive }, signal)
  }

  public async listFiles(podName: string, path: string, recursive: boolean, glob: string | undefined, signal?: AbortSignal): Promise<DirEntry[]> {
    return jsonResult<DirEntry[]>(await this.fileOperation(podName, 'list', { path, recursive, glob }, signal))
  }

  public async statFile(podName: string, path: string, signal?: AbortSignal): Promise<FileStat> {
    return jsonResult<FileStat>(await this.fileOperation(podName, 'stat', { path }, signal))
  }

  public async fileExists(podName: string, path: string, signal?: AbortSignal): Promise<boolean> {
    return stringResult(await this.fileOperation(podName, 'exists', { path }, signal)) === 'true'
  }

  public async searchText(podName: string, request: SandboxTextSearchRequest): Promise<SandboxTextSearchResult> {
    const result = await this.rawExec({
      podName,
      command: ['node', '--input-type=module', '-e', REMOTE_SEARCH_SCRIPT, JSON.stringify({
        path: request.path,
        pattern: request.pattern,
        syntax: request.syntax,
        caseSensitive: request.caseSensitive,
        maxResults: request.maxResults,
        limits: SANDBOX_TEXT_SEARCH_LIMITS,
      })],
      timeoutMs: this.options.defaultCommandTimeoutMs,
      ...(request.signal ? { signal: request.signal } : {}),
    })
    if (result.exitCode !== 0) throw new SandboxError('Kubernetes sandbox text search failed.', { reason: 'fs_failed' })
    return jsonResult<SandboxTextSearchResult>(result.stdout)
  }

  public async runCommand(options: KubernetesCommandOptions): Promise<ExecResult> {
    return this.rawExec(options)
  }

  public async createVolumeSnapshot(name: string, volumeName: string, snapshotClassName?: string): Promise<void> {
    try {
      await this.custom.createNamespacedCustomObject({
        group: 'snapshot.storage.k8s.io',
        version: 'v1',
        namespace: this.options.namespace,
        plural: 'volumesnapshots',
        body: {
          apiVersion: 'snapshot.storage.k8s.io/v1',
          kind: 'VolumeSnapshot',
          metadata: {
            name,
            labels: {
              'app.kubernetes.io/managed-by': 'purista-harness',
              'purista.dev/runtime': this.options.runtimeId,
            },
          },
          spec: {
            source: { persistentVolumeClaimName: volumeName },
            ...(snapshotClassName ? { volumeSnapshotClassName: snapshotClassName } : {}),
          },
        },
        fieldManager: 'purista-harness',
      })
    } catch (error) {
      if (statusCode(error) !== 409) throw providerError('Kubernetes volume snapshot creation failed.', error)
    }
  }

  public async snapshotExists(name: string): Promise<boolean> {
    try {
      await this.custom.getNamespacedCustomObject({
        group: 'snapshot.storage.k8s.io', version: 'v1', namespace: this.options.namespace,
        plural: 'volumesnapshots', name,
      })
      return true
    } catch (error) {
      if (statusCode(error) === 404) return false
      throw providerError('Kubernetes volume snapshot lookup failed.', error)
    }
  }

  public async waitForVolumeSnapshotReady(name: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      try {
        const snapshot = await this.custom.getNamespacedCustomObject({
          group: 'snapshot.storage.k8s.io', version: 'v1', namespace: this.options.namespace,
          plural: 'volumesnapshots', name,
        }) as { status?: { readyToUse?: boolean; error?: { message?: string } } }
        if (snapshot.status?.readyToUse === true) return
        if (snapshot.status?.error) {
          throw new SandboxError('Kubernetes volume snapshot failed.', { reason: 'provider_failed' })
        }
      } catch (error) {
        if (statusCode(error) !== 404) throw error
      }
      await abortableDelay(100, signal)
    }
    throw new OperationTimeoutError('Kubernetes volume snapshot readiness timed out.', {
      scope: 'sandbox_run', timeout_ms: timeoutMs,
    })
  }

  public async deleteVolumeSnapshot(name: string): Promise<void> {
    try {
      await this.custom.deleteNamespacedCustomObject({
        group: 'snapshot.storage.k8s.io', version: 'v1', namespace: this.options.namespace,
        plural: 'volumesnapshots', name,
      })
    } catch (error) {
      if (statusCode(error) !== 404) throw providerError('Kubernetes volume snapshot deletion failed.', error)
    }
  }

  public async close(): Promise<void> {}

  private async fileOperation(podName: string, operation: string, input: unknown, signal?: AbortSignal): Promise<string> {
    const result = await this.rawExec({
      podName,
      command: ['node', '--input-type=module', '-e', REMOTE_FS_SCRIPT, operation, JSON.stringify(input)],
      timeoutMs: this.options.defaultCommandTimeoutMs,
      ...(signal ? { signal } : {}),
    })
    if (result.exitCode !== 0) throw new SandboxError('Kubernetes sandbox filesystem operation failed.', { reason: 'fs_failed' })
    return result.stdout
  }

  private async rawExec(options: KubernetesCommandOptions): Promise<ExecResult> {
    throwIfAborted(options.signal)
    const started = Date.now()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let outputBytes = 0
    let socket: Awaited<ReturnType<Exec['exec']>> | undefined
    let settled = false

    const append = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      outputBytes += buffer.byteLength
      if (outputBytes > this.options.maxOutputBytes) {
        socket?.close()
        return
      }
      target.push(buffer)
    }
    stdout.on('data', (chunk: Buffer) => append(stdoutChunks, chunk))
    stderr.on('data', (chunk: Buffer) => append(stderrChunks, chunk))

    return await new Promise<ExecResult>((resolve, reject) => {
      const finish = (status: V1Status): void => {
        if (settled) return
        settled = true
        cleanup()
        if (outputBytes > this.options.maxOutputBytes) {
          reject(new SandboxError('Kubernetes sandbox command output exceeded its limit.', { reason: 'output_limit' }))
          return
        }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          exitCode: exitCode(status),
          durationSeconds: (Date.now() - started) / 1000,
        })
      }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const timeout = setTimeout(() => {
        socket?.close()
        fail(new OperationTimeoutError('Kubernetes sandbox command timed out.', {
          scope: 'sandbox_run', timeout_ms: options.timeoutMs,
        }))
      }, options.timeoutMs)
      const onAbort = (): void => {
        socket?.close()
        fail(new OperationCancelledError('Kubernetes sandbox command was cancelled.', { scope: 'sandbox' }))
      }
      const cleanup = (): void => {
        clearTimeout(timeout)
        options.signal?.removeEventListener('abort', onAbort)
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const stdin = options.stdin === undefined
        ? null
        : Readable.from([typeof options.stdin === 'string' ? options.stdin : Buffer.from(options.stdin)])
      const remoteCommand = options.cwd || options.env
        ? ['node', '--input-type=module', '-e', REMOTE_COMMAND_SCRIPT, JSON.stringify({
            command: options.command,
            cwd: options.cwd,
            env: options.env,
          })]
        : [...options.command]
      void this.exec.exec(
        this.options.namespace,
        options.podName,
        this.options.containerName,
        remoteCommand,
        stdout,
        stderr,
        stdin,
        false,
        finish,
      ).then((opened) => { socket = opened }).catch((error) => fail(providerError('Kubernetes pod exec failed.', error)))
    })
  }
}

const REMOTE_FS_SCRIPT = String.raw`
import fs from 'node:fs/promises'; import path from 'node:path';
const [op, raw] = process.argv.slice(1); const input = JSON.parse(raw);
const root = value => { const normalized = path.posix.normalize(value); const contained=normalized==='/workspace'||normalized.startsWith('/workspace/')||normalized==='/skills'||normalized.startsWith('/skills/'); if (!value.startsWith('/') || !contained) throw new Error('invalid path'); return normalized; };
const glob = value => value ? new RegExp('^' + value.replace(/[.+^\${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$') : undefined;
async function walk(base, recursive) { const out=[]; for (const entry of await fs.readdir(base,{withFileTypes:true})) { const target=path.posix.join(base,entry.name); const stat=await fs.stat(target); out.push({name:entry.name,path:target,kind:entry.isDirectory()?'directory':'file',...(entry.isFile()?{size:stat.size}:{})}); if(recursive&&entry.isDirectory()) out.push(...await walk(target,true)); } return out; }
const target = root(input.path);
if (op==='read') process.stdout.write((await fs.readFile(target)).toString('base64'));
else if(op==='write'){ await fs.mkdir(path.posix.dirname(target),{recursive:true}); await fs.writeFile(target,Buffer.from(input.data,'base64')); }
else if(op==='remove') await fs.rm(target,{recursive:Boolean(input.recursive),force:true});
else if(op==='exists'){ try{await fs.access(target);process.stdout.write('true')}catch{process.stdout.write('false')} }
else if(op==='stat'){ const stat=await fs.stat(target); process.stdout.write(JSON.stringify({kind:stat.isDirectory()?'directory':'file',size:stat.size,modifiedAt:stat.mtime.toISOString()})); }
else if(op==='list'){ const matcher=glob(input.glob); const values=(await walk(target,Boolean(input.recursive))).filter(value=>!matcher||matcher.test(value.path.slice(target.length+1))); process.stdout.write(JSON.stringify(values)); }
else throw new Error('unsupported operation');
`

const REMOTE_SEARCH_SCRIPT = String.raw`
import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process';
const input=JSON.parse(process.argv[1]); const reasons=new Set(); const files=[];
const root=path.posix.normalize(input.path); const contained=root==='/workspace'||root.startsWith('/workspace/')||root==='/skills'||root.startsWith('/skills/'); if(!input.path.startsWith('/')||!contained) throw new Error('invalid path');
function walk(base){ for(const item of fs.readdirSync(base,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){ if(files.length>=input.limits.maxFiles){reasons.add('file_count_limit');return} const target=path.posix.join(base,item.name); if(item.isDirectory())walk(target); else if(item.isFile())files.push(target); } }
walk(root); let scannedBytes=0; let scannedFiles=0; const matches=[];
for(const file of files){ const size=fs.statSync(file).size; if(size>input.limits.maxFileBytes){reasons.add('file_byte_limit');continue} if(scannedBytes+size>input.limits.maxScannedBytes){reasons.add('scan_byte_limit');break} scannedBytes+=size;scannedFiles++;
 const args=['-n','-H','-I','--color=never','--max-count',String(input.maxResults-matches.length),input.syntax==='literal'?'-F':'-E']; if(!input.caseSensitive)args.push('-i'); args.push('--',input.pattern,file);
 const result=spawnSync('grep',args,{encoding:'utf8',maxBuffer:Math.min(input.limits.maxScannedBytes,16*1024*1024)}); if(result.error)throw result.error;
 for(const line of result.stdout.split('\n')){if(!line)continue;const first=line.indexOf(':');const second=line.indexOf(':',first+1);if(first<0||second<0)continue;let text=line.slice(second+1);let truncated=false;const bytes=Buffer.byteLength(text);if(bytes>input.limits.maxReturnedLineBytes){text=Buffer.from(text).subarray(0,input.limits.maxReturnedLineBytes).toString('utf8');truncated=true;reasons.add('line_byte_limit')}matches.push({path:line.slice(0,first),line:Number(line.slice(first+1,second)),text,textTruncated:truncated});if(matches.length>=input.maxResults){reasons.add('result_limit');break}}
 if(matches.length>=input.maxResults)break;
}
process.stdout.write(JSON.stringify({matches,complete:reasons.size===0,limitReasons:[...reasons],scannedFiles,scannedBytes}));
`

const REMOTE_COMMAND_SCRIPT = String.raw`
import {spawn} from 'node:child_process';
const input=JSON.parse(process.argv[1]); const [command,...args]=input.command;
const child=spawn(command,args,{cwd:input.cwd,env:{...process.env,...input.env},stdio:'inherit',shell:false});
child.on('error',error=>{process.stderr.write(error.message);process.exit(127)});
child.on('exit',(code,signal)=>process.exit(code??(signal?128:1)));
`

function configMapRecord<T>(configMap: V1ConfigMap): VersionedKubernetesRecord<T> | undefined {
  const name = configMap.metadata?.name
  const version = configMap.metadata?.resourceVersion
  const kind = configMap.data?.['kind']
  const record = configMap.data?.['record']
  if (!name || !version || !kind || !record) return undefined
  return { name, version, kind, value: JSON.parse(record) as T }
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const candidate = error as { code?: unknown; statusCode?: unknown; response?: { statusCode?: unknown }; body?: { code?: unknown } }
  for (const value of [candidate.statusCode, candidate.response?.statusCode, candidate.body?.code, candidate.code]) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function providerError(message: string, cause: unknown): SandboxError {
  return new SandboxError(message, { reason: 'provider_failed' }, cause)
}

function labelValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 63) || 'record'
}

function exitCode(status: V1Status): number {
  if (status.status === 'Success') return 0
  const cause = status.details?.causes?.find((item) => item.reason === 'ExitCode')
  const parsed = Number(cause?.message)
  return Number.isInteger(parsed) ? parsed : 1
}

function jsonResult<T>(value: string): T {
  try { return JSON.parse(value) as T } catch (error) {
    throw new SandboxError('Kubernetes sandbox returned malformed data.', { reason: 'provider_failed' }, error)
  }
}

function stringResult(value: string): string {
  return value.trim()
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationCancelledError('Kubernetes sandbox operation was cancelled.', { scope: 'sandbox' })
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)
    const abort = (): void => {
      clearTimeout(timeout)
      reject(new OperationCancelledError('Kubernetes sandbox operation was cancelled.', { scope: 'sandbox' }))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Stable Kubernetes resource name from an opaque logical key. */
export function kubernetesResourceName(prefix: string, logicalKey: string): string {
  return `${prefix}-${createHash('sha256').update(logicalKey).digest('hex').slice(0, 40)}`
}
