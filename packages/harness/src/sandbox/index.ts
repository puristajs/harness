import { createRequire } from 'node:module'
import path from 'node:path'
import type { IFileSystem } from 'just-bash'
import { z } from 'zod'
import { OperationCancelledError, OperationTimeoutError, HarnessConfigError, SandboxError, SandboxNoExecutorError } from '../errors/index.js'
import type { DirEntry, ExecOptions, ExecResult, FileStat } from '../harness/types.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { AdapterCapabilities, AdapterCapability } from '../ports/capabilities.js'
import type { HarnessIdentity } from '../identity/index.js'
import type { JsonValue } from '../models/json.js'
import type { SandboxAdministration } from './administration.js'
import type { SandboxOwnerRegistrationOptions, SandboxScope } from './ownership.js'
import { SandboxAdapterCatalog } from './adapter-catalog.js'
import { ProcessLocalSandboxLifecycle } from './lifecycle.js'
import { searchSandboxTextLocally, type SandboxTextSearchRequest, type SandboxTextSearchResult } from './text-search.js'

export type { SandboxScope } from './ownership.js'
export {
  SANDBOX_TEXT_SEARCH_LIMITS,
  compileSafeRegex,
  validateSandboxTextSearchRequest,
} from './text-search.js'
export type {
  SandboxTextSearchLimitReason,
  SandboxTextSearchMatch,
  SandboxTextSearchRequest,
  SandboxTextSearchResult,
  SandboxTextSearchSyntax,
} from './text-search.js'

const require = createRequire(import.meta.url)

export interface SandboxSessionBase {
  read(path: string): Promise<Uint8Array>
  readText(path: string, encoding?: 'utf-8'): Promise<string>
  write(path: string, data: Uint8Array | string): Promise<void>
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>
  list(path: string, opts?: { recursive?: boolean; glob?: string }): Promise<DirEntry[]>
  stat(path: string): Promise<FileStat>
  exists(path: string): Promise<boolean>
  mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void>
  readonly executor: 'available' | 'unavailable'
  /** Detaches this client from logical sandbox compute without terminating it. */
  close(): Promise<void>
}

/** Options for staging immutable executable package assets. */
export interface ReadOnlyMountOptions {
  /** Relative files that retain executable mode; all other files are read-only. */
  executablePaths?: readonly string[]
}

/** A sandbox session that can enforce immutable staged package assets. */
export interface ReadOnlyMountCapableSandboxSession extends SandboxSessionBase {
  mountReadOnly(files: ReadonlyMap<string, Uint8Array | string>, atPath: string, options?: ReadOnlyMountOptions): Promise<void>
}

/** Returns true only when a sandbox can enforce an immutable package mount. */
export function isReadOnlyMountCapableSession(session: SandboxSessionBase): session is ReadOnlyMountCapableSandboxSession {
  return typeof (session as Partial<ReadOnlyMountCapableSandboxSession>).mountReadOnly === 'function'
}

export interface ExecCapableSandboxSession extends SandboxSessionBase {
  readonly executor: 'available'
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
}

/** Sandbox session that can perform bounded data-local text search. */
export interface TextSearchCapableSandboxSession extends SandboxSessionBase {
  searchText(request: SandboxTextSearchRequest): Promise<SandboxTextSearchResult>
}

/** Narrows a dynamically configured session to bounded text search. */
export function isTextSearchCapableSession(session: SandboxSessionBase): session is TextSearchCapableSandboxSession {
  return typeof (session as Partial<TextSearchCapableSandboxSession>).searchText === 'function'
}

/** Narrows a dynamically configured session to its available command executor. */
export function isExecCapableSession(session: SandboxSessionBase): session is ExecCapableSandboxSession {
  return session.executor === 'available' && typeof (session as Partial<ExecCapableSandboxSession>).exec === 'function'
}

/** Options for spawning a long-lived process inside the sandbox. */
export interface SpawnOptions {
  /** Command arguments. */
  args?: readonly string[]
  /** Working directory inside the sandbox. */
  cwd?: string
  /** Extra environment variables. */
  env?: Record<string, string>
  /** Cancellation signal; aborting terminates the process. */
  signal?: AbortSignal
}

/** A long-lived process owned by a sandbox session with streaming stdio. */
export interface SandboxProcess {
  /** Writes a chunk to the process stdin. */
  writeStdin(chunk: string): Promise<void>
  /** Decoded stdout chunks. Completes when the process exits. */
  readonly stdout: AsyncIterable<string>
  /** Decoded stderr chunks. Completes when the process exits. */
  readonly stderr: AsyncIterable<string>
  /** Resolves with the exit code when the process terminates. Never rejects. */
  readonly exit: Promise<{ exitCode: number; signal?: string }>
  /** Terminates the process. Idempotent. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>
}

/** Sandbox session that can host long-lived processes (`sandbox.spawn`). */
export interface SpawnCapableSandboxSession extends SandboxSessionBase {
  readonly executor: 'available'
  spawn(command: string, opts?: SpawnOptions): Promise<SandboxProcess>
}

/** Returns true when a sandbox session can spawn long-lived processes. */
export function isSpawnCapableSession(session: SandboxSessionBase): session is SpawnCapableSandboxSession {
  return session.executor === 'available' && typeof (session as Partial<SpawnCapableSandboxSession>).spawn === 'function'
}

export type SandboxSession = SandboxSessionBase & {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
}

/** @inline */
type DeclaresSandboxCapability<C extends readonly AdapterCapability[], K extends AdapterCapability> =
  C extends readonly [infer Head, ...infer Tail extends readonly AdapterCapability[]]
    ? [Head] extends [K] ? true : DeclaresSandboxCapability<Tail, K>
    : false

/**
 * Session operations inferred from an adapter's capability tuple.
 *
 * Every session exposes {@link SandboxSessionBase} file and attachment operations.
 * A definite `sandbox.text_search` entry adds {@link TextSearchCapableSandboxSession.searchText};
 * a definite `sandbox.exec` entry adds {@link ExecCapableSandboxSession.exec}; a
 * definite `sandbox.spawn` entry adds {@link SpawnCapableSandboxSession.spawn}.
 * Widened capability arrays require {@link isExecCapableSession} or
 * {@link isSpawnCapableSession} before using those optional operations.
 *
 * @typeParam C - The adapter's readonly capability tuple.
 * @example
 * ```ts
 * type Files = SandboxSessionFor<readonly ['sandbox.fs']>
 * type Shell = SandboxSessionFor<readonly ['sandbox.fs', 'sandbox.exec']>
 * ```
 */
export type SandboxSessionFor<C extends readonly AdapterCapability[]> =
  number extends C['length']
    ? SandboxSessionBase
    : SandboxSessionBase
      & (DeclaresSandboxCapability<C, 'sandbox.text_search'> extends true ? TextSearchCapableSandboxSession : unknown)
      & (DeclaresSandboxCapability<C, 'sandbox.exec'> extends true ? ExecCapableSandboxSession : unknown)
      & (DeclaresSandboxCapability<C, 'sandbox.spawn'> extends true ? SpawnCapableSandboxSession : unknown)
      & (Extract<C[number], 'sandbox.exec' | 'sandbox.spawn'> extends never ? { readonly executor: 'unavailable' } : unknown)

/** Controls whether the adapter may allocate, only attach, or restore a scope. */
export type SandboxOpenMode = 'create' | 'attach' | 'restore'

/** Lifecycle-aware request to open a sandbox attachment. */
export interface SandboxOpenOptions {
  readonly scope: SandboxScope
  readonly mode: SandboxOpenMode
  /** Trusted acting identity, authorized against the immutable owner. */
  readonly identity?: HarnessIdentity
  readonly signal?: AbortSignal
}

/** @inline */
type SandboxOpenResultBase = {
  /** Attachment owned by the caller; closing it does not terminate the logical sandbox. */
  readonly session: SandboxSessionBase
  /** What the adapter actually did to make this attachment available. */
  readonly disposition: 'created' | 'attached' | 'resumed' | 'restored'
  /** Whether previously running processes survived; independent of durable workspace recovery. */
  readonly liveProcessState: 'preserved' | 'restarted' | 'not_preserved' | 'unknown'
}

/**
 * A sandbox attachment and truthful preservation outcome.
 *
 * `session` carries operations inferred by {@link SandboxSessionFor}.
 * `disposition` reports creation, attachment, resume, or restore; `liveProcessState`
 * reports process survival separately from durable workspace recovery.
 *
 * @typeParam C - The adapter's readonly capability tuple.
 */
export type SandboxOpenResult<C extends readonly AdapterCapability[]> =
  number extends C['length'] ? SandboxOpenResultBase : SandboxOpenResultBase & { readonly session: SandboxSessionFor<C> }

/** Idempotent logical sandbox termination request. */
export interface SandboxTerminateOptions {
  readonly scope: SandboxScope
  readonly reason: 'session_closed' | 'run_disposed' | 'manual'
  readonly signal?: AbortSignal
}

/** @inline */
type SandboxBase = Partial<AdapterCapabilities> & {
  /** Operations and recovery guarantees this adapter actually implements. */
  readonly capabilities?: readonly AdapterCapability[]
  /** Stable low-cardinality adapter label used only in standard lifecycle telemetry. */
  readonly telemetryAdapterId?: string
  /** Receives Harness logging, telemetry, and defaults when composed into a Harness. */
  configureHarnessContext?(context: HarnessAdapterContext): void
  /** Registers immutable owner metadata before any partition allocation. */
  registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void>
  /** Trusted bounded inventory and cleanup surface owned by this adapter. */
  readonly administration: SandboxAdministration
  /** Opens the requested logical scope without silently replacing missing state. */
  open(options: SandboxOpenOptions): Promise<SandboxOpenResultBase>
  /** Idempotently terminates the scope and invalidates all its attachments. */
  terminate(options: SandboxTerminateOptions): Promise<void>
}

/**
 * One logical lifecycle for every sandbox adapter, with capability-inferred attachments.
 *
 * Use `open` to create, attach, or restore a logical {@link SandboxScope} and
 * `terminate` to end that scope. Closing an attachment only releases that caller's
 * handle. Provider placement, coordination, and fencing stay inside the adapter.
 *
 * @typeParam C - The adapter's readonly capability tuple; omit when accepting any adapter.
 * @example
 * ```ts
 * const opened = await sandbox.open({ scope, mode: 'attach' })
 * try {
 *   const content = await opened.session.readText('/workspace/result.txt')
 * } finally {
 *   await opened.session.close()
 * }
 * ```
 */
export type Sandbox<C extends readonly AdapterCapability[] = readonly AdapterCapability[]> =
  number extends C['length'] ? SandboxBase : Omit<SandboxBase, 'capabilities' | 'open'> & {
    readonly capabilities?: C
    open(options: SandboxOpenOptions): Promise<SandboxOpenResult<C>>
  }

/** Result produced when a sandbox adapter records a restorable checkpoint. */
export interface SnapshotResult {
  /** Adapter-owned id used to resume the checkpoint later. */
  readonly snapshotId: string
  /** Optional adapter metadata for observability or persistence records. */
  readonly metadata?: Record<string, JsonValue>
}

/** Options used to open a sandbox session from a prior snapshot. */
export interface SandboxResumeOptions {
  /** Snapshot id previously returned by `snapshot(...)` or `hibernate(...)`. */
  readonly snapshotId: string
  /** Full target identity; retries retain this scope rather than allocating another sandbox. */
  readonly scope: SandboxScope
  /** Trusted acting identity, authorized against the immutable snapshot owner. */
  readonly identity?: HarnessIdentity
  /** Cancels resume without authorizing replacement state. */
  readonly signal?: AbortSignal
}

/**
 * Optional sandbox capability for creating durable session snapshots.
 *
 * @example
 * ```ts
 * if ('snapshot' in sandbox) {
 *   const result = await sandbox.snapshot(session)
 * }
 * ```
 */
export interface SnapshotCapableSandbox {
  snapshot(session: SandboxSessionBase): Promise<SnapshotResult>
}

/**
 * Optional sandbox capability for opening sessions from durable snapshots.
 * Resuming the same snapshot into the same target scope is idempotent. A target
 * already created independently or resumed from another snapshot is a conflict.
 * This operation does not authorize lifecycle `restore` from a durable workspace.
 *
 * @example
 * ```ts
 * if ('resume' in sandbox) {
 *   const session = await sandbox.resume({ snapshotId, scope })
 * }
 * ```
 */
export interface ResumeCapableSandbox {
  resume(opts: SandboxResumeOptions): Promise<SandboxSessionBase>
}

/**
 * Optional sandbox capability for snapshotting and releasing active compute.
 *
 * @example
 * ```ts
 * if ('hibernate' in sandbox) {
 *   const result = await sandbox.hibernate(session)
 * }
 * ```
 */
export interface HibernateCapableSandbox {
  hibernate(session: SandboxSessionBase): Promise<SnapshotResult>
}

type Node = { kind: 'file'; data: Uint8Array; modifiedAt: string } | { kind: 'directory'; modifiedAt: string }

function now(): string { return new Date().toISOString() }

function normalizePath(input: string): string {
  if (!input.startsWith('/')) throw new SandboxError('Invalid path', { reason: 'invalid_path' })
  const normalized = path.posix.normalize(input)
  if (!normalized.startsWith('/')) throw new SandboxError('Invalid path', { reason: 'invalid_path' })
  return normalized
}

class MemorySandboxSession<E extends SandboxSessionBase['executor']> implements SandboxSession {
  private readonly controller = new AbortController()
  private fs = new Map<string, Node>()
  readonly executor: E
  private bashExec: ((command: string, opts?: ExecOptions) => Promise<ExecResult>) | undefined

  constructor(executor: E, bashExec?: (command: string, opts?: ExecOptions) => Promise<ExecResult>, private readonly engineFs?: IFileSystem) {
    this.executor = executor
    this.bashExec = bashExec
    this.fs.set('/', { kind: 'directory', modifiedAt: now() })
  }

  private ensureParent(filePath: string): void {
    const parts = normalizePath(filePath).split('/').filter(Boolean)
    let current = '/'
    for (let i = 0; i < parts.length - 1; i += 1) {
      current = current === '/' ? `/${parts[i]}` : `${current}/${parts[i]}`
      if (!this.fs.has(current)) this.fs.set(current, { kind: 'directory', modifiedAt: now() })
    }
  }

  async read(filePath: string): Promise<Uint8Array> {
    const target = normalizePath(filePath)
    if (this.engineFs) return this.filesystemOperation(async () => new Uint8Array(await this.engineFs!.readFileBuffer(target)))
    const node = this.fs.get(target)
    if (!node || node.kind !== 'file') throw new SandboxError('File not found', { reason: 'fs_failed' })
    return new Uint8Array(node.data)
  }

  async readText(filePath: string): Promise<string> { return new TextDecoder().decode(await this.read(filePath)) }

  async write(filePath: string, data: Uint8Array | string): Promise<void> {
    const p = normalizePath(filePath)
    if (this.engineFs) {
      return this.filesystemOperation(async () => {
        await this.engineFs!.mkdir(path.posix.dirname(p), { recursive: true })
        await this.engineFs!.writeFile(p, typeof data === 'string' ? data : new Uint8Array(data))
      })
    }
    this.ensureParent(p)
    this.fs.set(p, { kind: 'file', data: typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data), modifiedAt: now() })
  }

  async remove(filePath: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = normalizePath(filePath)
    if (this.engineFs) return this.filesystemOperation(() => this.engineFs!.rm(p, { ...opts, force: true }))
    if (opts?.recursive) {
      for (const key of [...this.fs.keys()]) {
        if (key === p || key.startsWith(`${p}/`)) this.fs.delete(key)
      }
      return
    }
    this.fs.delete(p)
  }

  async list(rootPath: string, opts?: { recursive?: boolean; glob?: string }): Promise<DirEntry[]> {
    const root = normalizePath(rootPath)
    if (this.engineFs) {
      return this.filesystemOperation(async () => {
        const entries: DirEntry[] = []
        for (const entryPath of this.engineFs!.getAllPaths()) {
          if (entryPath === root || !entryPath.startsWith(root === '/' ? '/' : `${root}/`)) continue
          const relative = root === '/' ? entryPath.slice(1) : entryPath.slice(root.length + 1)
          if (!opts?.recursive && relative.includes('/')) continue
          if (opts?.glob && !globToRegExp(opts.glob).test(entryPath)) continue
          const stat = await this.engineFs!.stat(entryPath)
          entries.push({ name: path.posix.basename(entryPath), path: entryPath, kind: stat.isDirectory ? 'directory' : 'file', ...(stat.isFile ? { size: stat.size } : {}) })
        }
        return entries.sort((a, b) => a.path.localeCompare(b.path))
      })
    }
    const out: DirEntry[] = []
    for (const [k, v] of this.fs.entries()) {
      if (k === root) continue
      if (!k.startsWith(root === '/' ? '/' : `${root}/`)) continue
      const relative = root === '/' ? k.slice(1) : k.slice(root.length + 1)
      if (!opts?.recursive && relative.includes('/')) continue
      if (opts?.glob && !globToRegExp(opts.glob).test(k)) continue
      out.push({ name: k.split('/').at(-1) ?? '', path: k, kind: v.kind, ...(v.kind === 'file' ? { size: v.data.byteLength } : {}) })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  async stat(filePath: string): Promise<FileStat> {
    const target = normalizePath(filePath)
    if (this.engineFs) {
      return this.filesystemOperation(async () => {
        const stat = await this.engineFs!.stat(target)
        return { kind: stat.isDirectory ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtime.toISOString() }
      })
    }
    const node = this.fs.get(target)
    if (!node) throw new SandboxError('Path not found', { reason: 'fs_failed' })
    return { kind: node.kind, size: node.kind === 'file' ? node.data.byteLength : 0, modifiedAt: node.modifiedAt }
  }

  async exists(filePath: string): Promise<boolean> {
    const target = normalizePath(filePath)
    return this.engineFs ? this.filesystemOperation(() => this.engineFs!.exists(target)) : this.fs.has(target)
  }

  async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> {
    const base = normalizePath(atPath)
    for (const [rel, data] of files.entries()) {
      const relNorm = rel.startsWith('/') ? rel.slice(1) : rel
      await this.write(`${base}/${relNorm}`, data)
    }
  }

  async searchText(request: SandboxTextSearchRequest): Promise<SandboxTextSearchResult> {
    return searchSandboxTextLocally(request, this)
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (this.executor === 'unavailable' || !this.bashExec) throw new SandboxNoExecutorError('Sandbox executor unavailable.', { session_id: 'unknown' })
    return this.bashExec(command, { ...opts, signal: opts?.signal ? AbortSignal.any([opts.signal, this.controller.signal]) : this.controller.signal })
  }

  async close(): Promise<void> { this.controller.abort(); this.fs.clear() }

  private async filesystemOperation<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() } catch { throw new SandboxError('Sandbox filesystem operation failed.', { reason: 'fs_failed' }) }
  }
}

/** Per-client attachment over shared in-memory logical sandbox state. */
class AttachedMemorySandboxSession<E extends SandboxSessionBase['executor']> implements SandboxSession {
  public readonly executor: E
  private closed = false
  private readonly controller = new AbortController()

  public constructor(private readonly backing: MemorySandboxSession<E>, private readonly assertActive: () => void | Promise<void>) {
    this.executor = backing.executor
  }

  public async read(path: string): Promise<Uint8Array> { return this.use(() => this.backing.read(path)) }
  public async readText(path: string, _encoding?: 'utf-8'): Promise<string> { return this.use(() => this.backing.readText(path)) }
  public async write(path: string, data: Uint8Array | string): Promise<void> { return this.use(() => this.backing.write(path, data)) }
  public async remove(path: string, opts?: { recursive?: boolean }): Promise<void> { return this.use(() => this.backing.remove(path, opts)) }
  public async list(path: string, opts?: { recursive?: boolean; glob?: string }): Promise<DirEntry[]> { return this.use(() => this.backing.list(path, opts)) }
  public async stat(path: string): Promise<FileStat> { return this.use(() => this.backing.stat(path)) }
  public async exists(path: string): Promise<boolean> { return this.use(() => this.backing.exists(path)) }
  public async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> {
    await this.assertOpen()
    const base = normalizePath(atPath)
    for (const [relative, data] of files) await this.write(`${base}/${relative.startsWith('/') ? relative.slice(1) : relative}`, data)
  }
  public async searchText(request: SandboxTextSearchRequest): Promise<SandboxTextSearchResult> {
    return this.use(() => this.backing.searchText({
      ...request,
      signal: request.signal ? AbortSignal.any([request.signal, this.controller.signal]) : this.controller.signal,
    }))
  }
  public async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    await this.assertExecOpen(this.closed)
    const result = await this.backing.exec(command, { ...opts, signal: opts?.signal ? AbortSignal.any([opts.signal, this.controller.signal]) : this.controller.signal })
    await this.assertOpen()
    return result
  }
  public async close(): Promise<void> { this.closed = true; this.controller.abort() }

  private async use<T>(operation: () => Promise<T>): Promise<T> {
    await this.assertOpen()
    const result = await operation()
    await this.assertOpen()
    return result
  }

  private async assertOpen(): Promise<void> {
    await this.assertActive()
    if (this.closed) throw new SandboxError('Sandbox attachment is closed.', { reason: 'session_closed' })
  }

  private async assertExecOpen(wasClosed: boolean): Promise<void> {
    try {
      await this.assertOpen()
    } catch (error) {
      if (!wasClosed && this.controller.signal.aborted) {
        throw new OperationCancelledError('Sandbox execution was cancelled.', { scope: 'sandbox' })
      }
      throw error
    }
  }
}

export function inMemorySandbox(): Sandbox<readonly ['sandbox.fs', 'sandbox.text_search']> {
  const lifecycle = new ProcessLocalSandboxLifecycle<MemorySandboxSession<'unavailable'>>()
  const catalog = SandboxAdapterCatalog.inMemory(async (resource) => {
    if (resource.kind === 'sandbox' && resource.scope) await lifecycle.terminate({ scope: resource.scope, reason: 'manual' })
  })
  return {
    capabilities: ['sandbox.fs', 'sandbox.text_search'],
    telemetryAdapterId: 'in_memory_sandbox',
    administration: catalog.administration,
    registerOwner: async (options) => await catalog.registerOwner(options),
    configureHarnessContext(context) {
      catalog.configureHarnessContext(context, 'in_memory_sandbox')
    },
    async open(options) {
      const { session, disposition, assertActive } = await catalog.open(options, async () => await lifecycle.open(options, () => new MemorySandboxSession('unavailable')))
      return { session: new AttachedMemorySandboxSession(session, assertActive), disposition, liveProcessState: 'not_preserved' }
    },
    async terminate(options) {
      await catalog.terminate(options, async () => await lifecycle.terminate(options))
    }
  }
}

/** Optional limits for the process-local Bash emulator. Network and Python are disabled by default. */
export interface BashSandboxOptions {
  /** URL prefixes permitted for emulated network commands. Omit to deny network access. */
  readonly network?: { readonly allow?: readonly string[] }
  readonly executionLimits?: {
    /** Maximum execution duration in milliseconds. */
    readonly wallClockMs?: number
    /** Maximum bytes retained by the in-memory filesystem; this is not a host-memory limit. */
    readonly maxFileSystemBytes?: number
  }
  /** Enables the optional emulated Python builtin. Default: false. */
  readonly python?: boolean
}

const bashSandboxOptionsSchema = z.object({
  network: z.object({ allow: z.array(z.url()).optional() }).strict().optional(),
  executionLimits: z.object({
    wallClockMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    maxFileSystemBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  }).strict().optional(),
  python: z.boolean().optional()
}).strict()

/** Creates a process-local Bash emulator whose file and command APIs share one filesystem. */
export function bashSandbox(opts?: BashSandboxOptions): Sandbox<readonly ['sandbox.fs', 'sandbox.text_search', 'sandbox.exec']> {
  const parsed = bashSandboxOptionsSchema.safeParse(opts ?? {})
  if (!parsed.success) throw new HarnessConfigError('Bash sandbox configuration is invalid.', { reason: 'invalid_bash_sandbox_options', path: 'sandbox' })
  const configuration = parsed.data
  let modulePath: string
  try {
    modulePath = require.resolve('just-bash')
  } catch {
    throw new HarnessConfigError('just-bash is not installed', { reason: 'just_bash_not_installed' })
  }
  const justBash = require(modulePath) as typeof import('just-bash')

  const lifecycle = new ProcessLocalSandboxLifecycle<MemorySandboxSession<'available'>>()
  const catalog = SandboxAdapterCatalog.inMemory(async (resource) => {
    if (resource.kind === 'sandbox' && resource.scope) await lifecycle.terminate({ scope: resource.scope, reason: 'manual' })
  })
  let defaultTimeoutMs = 120_000
  return {
    capabilities: ['sandbox.fs', 'sandbox.text_search', 'sandbox.exec'],
    telemetryAdapterId: 'bash_sandbox',
    administration: catalog.administration,
    registerOwner: async (options) => await catalog.registerOwner(options),
    configureHarnessContext(context) {
      defaultTimeoutMs = context.defaults.toolTimeoutMs
      catalog.configureHarnessContext(context, 'bash_sandbox')
    },
    async open(options) {
      const { session, disposition, assertActive } = await catalog.open(options, async () => await lifecycle.open(options, async () => {
        const engine = new justBash.Bash({
          cwd: '/workspace',
          ...(configuration.network?.allow ? { network: { allowedUrlPrefixes: configuration.network.allow } } : {}),
          ...(configuration.python !== undefined ? { python: configuration.python } : {}),
          executionLimits: {
            ...(configuration.executionLimits?.wallClockMs !== undefined ? { maxExecutionTimeMs: configuration.executionLimits.wallClockMs } : {}),
            ...(configuration.executionLimits?.maxFileSystemBytes !== undefined ? { maxFileSystemBytes: configuration.executionLimits.maxFileSystemBytes } : {})
          }
        })
        await engine.fs.mkdir('/workspace', { recursive: true })
        const exec = async (command: string, execOpts?: ExecOptions): Promise<ExecResult> => {
          const started = Date.now()
          if (execOpts?.signal?.aborted) throw new OperationCancelledError('Sandbox run was cancelled.', { scope: 'sandbox' })
          const timeoutMs = Math.min(execOpts?.timeoutMs ?? defaultTimeoutMs, configuration.executionLimits?.wallClockMs ?? Number.POSITIVE_INFINITY)
          if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new SandboxError('Sandbox execution timeout is invalid.', { reason: 'invalid_exec_options' })
          const controller = new AbortController()
          const sourceSignal = execOpts?.signal
          let timeoutId: ReturnType<typeof setTimeout> | undefined
          let abortListener: (() => void) | undefined
          const abortPromise = sourceSignal
            ? new Promise<never>((_, reject) => {
              abortListener = () => {
                controller.abort()
                reject(new OperationCancelledError('Sandbox run was cancelled.', { scope: 'sandbox' }))
              }
              sourceSignal.addEventListener('abort', abortListener, { once: true })
            })
            : undefined
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort()
              reject(new OperationTimeoutError('Sandbox run timed out.', { scope: 'sandbox_run', timeout_ms: timeoutMs }))
            }, timeoutMs)
          })
          try {
            const runner = engine.exec(command, {
              ...(execOpts?.cwd !== undefined ? { cwd: normalizePath(execOpts.cwd) } : {}),
              ...(execOpts?.env ? { env: execOpts.env } : {}),
              ...(execOpts?.stdin !== undefined ? { stdin: execOpts.stdin } : {}),
              signal: controller.signal
            })
            const result = await Promise.race([runner, ...(abortPromise ? [abortPromise] : []), timeoutPromise])
            const durationMs = Date.now() - started
            // The emulator may enforce its own deadline before the host timer runs.
            if (durationMs >= timeoutMs) throw new OperationTimeoutError('Sandbox run timed out.', { scope: 'sandbox_run', timeout_ms: timeoutMs })
            return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, durationSeconds: durationMs / 1000 }
          } finally {
            if (timeoutId) clearTimeout(timeoutId)
            if (abortListener) sourceSignal?.removeEventListener('abort', abortListener)
          }
        }
        return new MemorySandboxSession('available', exec, engine.fs)
      }))
      return { session: new AttachedMemorySandboxSession(session, assertActive), disposition, liveProcessState: 'not_preserved' }
    },
    async terminate(options) {
      await catalog.terminate(options, async () => await lifecycle.terminate(options))
    }
  }
}

/**
 * Translate a glob to a fully-anchored RegExp matched against the absolute
 * path. `*`/`**` match any characters and `?` matches a single character; all
 * other regex metacharacters are escaped to literals so a pattern can never
 * throw a `SyntaxError` or trigger catastrophic backtracking. Anchoring both
 * ends fixes the previous over-match (e.g. `*.ts` no longer matches `a.tsx`).
 */
function globToRegExp(glob: string): RegExp {
  let out = '^'
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string
    if (char === '*') {
      out += '.*'
      if (glob[i + 1] === '*') i += 1
    } else if (char === '?') {
      out += '.'
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`${out}$`)
}

export function autoDetectSandbox(): Sandbox {
  try {
    return bashSandbox()
  } catch (error) {
    // Only fall back to the no-executor sandbox when just-bash is absent.
    // A real configuration/init error must surface, not silently downgrade.
    if (error instanceof HarnessConfigError && (error.meta as { reason?: string } | undefined)?.reason === 'just_bash_not_installed') {
      return inMemorySandbox()
    }
    throw error
  }
}
