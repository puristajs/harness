import path from 'node:path'

import {
  OperationCancelledError,
  OperationTimeoutError,
  SANDBOX_TEXT_SEARCH_LIMITS,
  compileSafeRegex,
  type DirEntry,
  type ExecResult,
  type FileStat,
  type SandboxTextSearchLimitReason,
  type SandboxTextSearchMatch,
  type SandboxTextSearchRequest,
  type SandboxTextSearchResult,
} from '@purista/harness'
import type {
  KubernetesCommandOptions,
  KubernetesPodOptions,
  KubernetesSandboxDriver,
  KubernetesVolumeOptions,
  VersionedKubernetesRecord,
} from './driver.js'

interface MemoryPod {
  readonly volumeName: string
  readonly skills: Map<string, Uint8Array>
}

/** Deterministic shared backend used only by this package's contract tests. */
export class InMemoryKubernetesSandboxDriver implements KubernetesSandboxDriver {
  private readonly records = new Map<string, VersionedKubernetesRecord>()
  private readonly volumes = new Map<string, Map<string, Uint8Array>>()
  private readonly pods = new Map<string, MemoryPod>()
  private readonly snapshots = new Map<string, Map<string, Uint8Array>>()
  private version = 1
  public closeCalls = 0

  public async readRecord<T>(name: string): Promise<VersionedKubernetesRecord<T> | undefined> {
    const record = this.records.get(name)
    return record ? clone(record) as VersionedKubernetesRecord<T> : undefined
  }

  public async createRecord(name: string, kind: string, value: unknown): Promise<boolean> {
    if (this.records.has(name)) return false
    this.records.set(name, { name, kind, version: String(this.version++), value: clone(value) })
    return true
  }

  public async replaceRecord(name: string, expectedVersion: string, kind: string, value: unknown): Promise<boolean> {
    const current = this.records.get(name)
    if (!current || current.version !== expectedVersion) return false
    this.records.set(name, { name, kind, version: String(this.version++), value: clone(value) })
    return true
  }

  public async deleteRecord(name: string): Promise<void> { this.records.delete(name) }
  public async listRecords(): Promise<readonly VersionedKubernetesRecord[]> {
    return [...this.records.values()].map((record) => clone(record))
  }

  public async ensureVolume(options: KubernetesVolumeOptions): Promise<void> {
    if (this.volumes.has(options.name)) return
    const source = options.snapshotName ? this.snapshots.get(options.snapshotName) : undefined
    this.volumes.set(options.name, source ? cloneFiles(source) : new Map())
  }
  public async volumeExists(name: string): Promise<boolean> { return this.volumes.has(name) }
  public async deleteVolume(name: string): Promise<void> { this.volumes.delete(name) }

  public async ensurePod(options: KubernetesPodOptions): Promise<void> {
    if (!this.volumes.has(options.volumeName)) throw new Error('missing volume')
    if (!this.pods.has(options.name)) this.pods.set(options.name, { volumeName: options.volumeName, skills: new Map() })
  }
  public async podExists(name: string): Promise<boolean> { return this.pods.has(name) }
  public async waitForPodReady(name: string, _timeoutMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (!this.pods.has(name)) throw new Error('missing pod')
  }
  public async deletePod(name: string): Promise<void> { this.pods.delete(name) }

  public async readFile(podName: string, filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    throwIfAborted(signal)
    const value = this.files(podName, filePath).get(filePath)
    if (!value) throw new Error('ENOENT')
    return value.slice()
  }
  public async writeFile(podName: string, filePath: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    this.files(podName, filePath).set(filePath, data.slice())
  }
  public async removeFile(podName: string, filePath: string, recursive: boolean, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const files = this.files(podName, filePath)
    for (const key of [...files.keys()]) {
      if (key === filePath || (recursive && key.startsWith(`${filePath}/`))) files.delete(key)
    }
  }
  public async listFiles(podName: string, root: string, recursive: boolean, glob?: string, signal?: AbortSignal): Promise<DirEntry[]> {
    throwIfAborted(signal)
    const files = this.files(podName, root)
    const entries = new Map<string, DirEntry>()
    for (const [filePath, bytes] of files) {
      if (!filePath.startsWith(`${root}/`)) continue
      const relative = filePath.slice(root.length + 1)
      if (!recursive && relative.includes('/')) {
        const directory = relative.split('/')[0]!
        entries.set(`${root}/${directory}`, { name: directory, path: `${root}/${directory}`, kind: 'directory' })
        continue
      }
      if (glob && !globMatch(relative, glob)) continue
      entries.set(filePath, { name: path.posix.basename(filePath), path: filePath, kind: 'file', size: bytes.byteLength })
    }
    return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))
  }
  public async statFile(podName: string, filePath: string, signal?: AbortSignal): Promise<FileStat> {
    throwIfAborted(signal)
    const files = this.files(podName, filePath)
    const value = files.get(filePath)
    const modifiedAt = new Date(0).toISOString()
    if (value) return { kind: 'file', size: value.byteLength, modifiedAt }
    if ([...files].some(([key]) => key.startsWith(`${filePath}/`))) return { kind: 'directory', size: 0, modifiedAt }
    throw new Error('ENOENT')
  }
  public async fileExists(podName: string, filePath: string, signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal)
    const files = this.files(podName, filePath)
    return files.has(filePath) || [...files.keys()].some((key) => key.startsWith(`${filePath}/`))
  }

  public async searchText(podName: string, request: SandboxTextSearchRequest): Promise<SandboxTextSearchResult> {
    throwIfAborted(request.signal)
    const entries = await this.listFiles(podName, request.path, true, undefined, request.signal)
    const matches: SandboxTextSearchMatch[] = []
    const reasons = new Set<SandboxTextSearchLimitReason>()
    let scannedBytes = 0
    let scannedFiles = 0
    const regex = request.syntax === 'safe_regex_v1' ? compileSafeRegex(request.pattern) : undefined
    const literal = request.caseSensitive ? request.pattern : request.pattern.toLowerCase()
    for (const entry of entries.slice(0, SANDBOX_TEXT_SEARCH_LIMITS.maxFiles)) {
      const bytes = await this.readFile(podName, entry.path, request.signal)
      if (bytes.byteLength > SANDBOX_TEXT_SEARCH_LIMITS.maxFileBytes) { reasons.add('file_byte_limit'); continue }
      if (scannedBytes + bytes.byteLength > SANDBOX_TEXT_SEARCH_LIMITS.maxScannedBytes) { reasons.add('scan_byte_limit'); break }
      scannedBytes += bytes.byteLength
      scannedFiles += 1
      const lines = new TextDecoder().decode(bytes).split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        const found = regex?.test(line) ?? (request.caseSensitive ? line : line.toLowerCase()).includes(literal)
        if (!found) continue
        matches.push({ path: entry.path, line: index + 1, text: line, textTruncated: false })
        if (matches.length >= request.maxResults) {
          reasons.add('result_limit')
          return searchResult(matches, reasons, scannedFiles, scannedBytes)
        }
      }
    }
    if (entries.length > SANDBOX_TEXT_SEARCH_LIMITS.maxFiles) reasons.add('file_count_limit')
    return searchResult(matches, reasons, scannedFiles, scannedBytes)
  }

  public async runCommand(options: KubernetesCommandOptions): Promise<ExecResult> {
    throwIfAborted(options.signal)
    if (options.command[0] === 'sleep') {
      const requestedMs = Number(options.command[1] ?? 0) * 1_000
      if (requestedMs > options.timeoutMs) {
        throw new OperationTimeoutError('In-memory Kubernetes command timed out.', {
          scope: 'sandbox_run', timeout_ms: options.timeoutMs,
        })
      }
    }
    if (options.command[0] === 'echo') {
      return { stdout: `${options.command.slice(1).join(' ')}\n`, stderr: '', exitCode: 0, durationSeconds: 0 }
    }
    return { stdout: '', stderr: '', exitCode: 0, durationSeconds: 0 }
  }

  public async createVolumeSnapshot(name: string, volumeName: string): Promise<void> {
    const volume = this.volumes.get(volumeName)
    if (!volume) throw new Error('missing volume')
    if (!this.snapshots.has(name)) this.snapshots.set(name, cloneFiles(volume))
  }
  public async snapshotExists(name: string): Promise<boolean> { return this.snapshots.has(name) }
  public async waitForVolumeSnapshotReady(name: string, _timeoutMs: number, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (!this.snapshots.has(name)) throw new Error('missing snapshot')
  }
  public async deleteVolumeSnapshot(name: string): Promise<void> { this.snapshots.delete(name) }
  public async close(): Promise<void> { this.closeCalls += 1 }

  public losePod(name: string): void { this.pods.delete(name) }

  private files(podName: string, filePath: string): Map<string, Uint8Array> {
    const pod = this.pods.get(podName)
    if (!pod) throw new Error('missing pod')
    if (filePath.startsWith('/skills')) return pod.skills
    const volume = this.volumes.get(pod.volumeName)
    if (!volume) throw new Error('missing volume')
    return volume
  }
}

function searchResult(
  matches: readonly SandboxTextSearchMatch[],
  reasons: ReadonlySet<SandboxTextSearchLimitReason>,
  scannedFiles: number,
  scannedBytes: number,
): SandboxTextSearchResult {
  const limitReasons = [...reasons].sort()
  return { matches, complete: limitReasons.length === 0, limitReasons, scannedFiles, scannedBytes }
}

function globMatch(value: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')
  return new RegExp(`^${escaped}$`).test(value)
}

function clone<T>(value: T): T { return structuredClone(value) }
function cloneFiles(files: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].map(([key, value]) => [key, value.slice()]))
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationCancelledError('In-memory Kubernetes operation was cancelled.', { scope: 'sandbox' })
}
