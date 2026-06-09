import { createRequire } from 'node:module'
import path from 'node:path'
import { OperationCancelledError, OperationTimeoutError, HarnessConfigError, SandboxError, SandboxNoExecutorError } from '../errors/index.js'
import type { DirEntry, ExecOptions, ExecResult, FileStat } from '../harness/types.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { AdapterCapabilities, AdapterCapability } from '../ports/capabilities.js'

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
  close(): Promise<void>
}

export interface ExecCapableSandboxSession extends SandboxSessionBase {
  readonly executor: 'available'
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
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
  return typeof (session as Partial<SpawnCapableSandboxSession>).spawn === 'function'
}

export type SandboxSession = SandboxSessionBase & {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
}

type HasSandboxCapability<C extends readonly AdapterCapability[], K extends AdapterCapability> = K extends C[number] ? true : false

export type SandboxSessionFor<C extends readonly AdapterCapability[]> =
  HasSandboxCapability<C, 'sandbox.exec'> extends true
    ? ExecCapableSandboxSession
    : SandboxSessionBase & { readonly executor: 'unavailable' }

export interface Sandbox<C extends readonly AdapterCapability[] = readonly AdapterCapability[]> extends Partial<AdapterCapabilities> {
  readonly capabilities?: C
  configureHarnessContext?(context: HarnessAdapterContext): void
  open(opts: { sessionId: string; runId: string; signal?: AbortSignal }): Promise<SandboxSessionFor<C>>
}

/** Result produced when a sandbox adapter records a restorable checkpoint. */
export interface SnapshotResult {
  /** Adapter-owned id used to resume the checkpoint later. */
  readonly snapshotId: string
  /** Optional adapter metadata for observability or persistence records. */
  readonly metadata?: Record<string, unknown>
}

/** Options used to open a sandbox session from a prior snapshot. */
export interface SandboxResumeOptions {
  /** Snapshot id previously returned by `snapshot(...)` or `hibernate(...)`. */
  readonly snapshotId: string
  /** Logical harness session id for the resumed sandbox session. */
  readonly sessionId: string
  /** Harness run id requesting the resumed sandbox session. */
  readonly runId: string
  /** Optional cancellation signal for adapters that support abortable resume. */
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
  snapshot(session: SandboxSession): Promise<SnapshotResult>
}

/**
 * Optional sandbox capability for opening sessions from durable snapshots.
 *
 * @example
 * ```ts
 * if ('resume' in sandbox) {
 *   const session = await sandbox.resume({ snapshotId, sessionId, runId })
 * }
 * ```
 */
export interface ResumeCapableSandbox {
  resume(opts: SandboxResumeOptions): Promise<SandboxSession>
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
  hibernate(session: SandboxSession): Promise<SnapshotResult>
}

type Node = { kind: 'file'; data: Uint8Array; modifiedAt: string } | { kind: 'directory'; modifiedAt: string }

function now(): string { return new Date().toISOString() }

function normalizePath(input: string): string {
  if (!input.startsWith('/')) throw new SandboxError('Invalid path', { reason: 'invalid_path' })
  const normalized = path.posix.normalize(input)
  if (!normalized.startsWith('/')) throw new SandboxError('Invalid path', { reason: 'invalid_path' })
  return normalized
}

class MemorySandboxSession implements SandboxSession {
  private fs = new Map<string, Node>()
  readonly executor: 'available' | 'unavailable'
  private bashExec: ((command: string, opts?: ExecOptions) => Promise<ExecResult>) | undefined

  constructor(executor: 'available' | 'unavailable', bashExec?: (command: string, opts?: ExecOptions) => Promise<ExecResult>) {
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
    const node = this.fs.get(normalizePath(filePath))
    if (!node || node.kind !== 'file') throw new SandboxError('File not found', { reason: 'fs_failed' })
    return node.data
  }

  async readText(filePath: string): Promise<string> { return new TextDecoder().decode(await this.read(filePath)) }

  async write(filePath: string, data: Uint8Array | string): Promise<void> {
    const p = normalizePath(filePath)
    this.ensureParent(p)
    this.fs.set(p, { kind: 'file', data: typeof data === 'string' ? new TextEncoder().encode(data) : data, modifiedAt: now() })
  }

  async remove(filePath: string, opts?: { recursive?: boolean }): Promise<void> {
    const p = normalizePath(filePath)
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
    const node = this.fs.get(normalizePath(filePath))
    if (!node) throw new SandboxError('Path not found', { reason: 'fs_failed' })
    return { kind: node.kind, size: node.kind === 'file' ? node.data.byteLength : 0, modifiedAt: node.modifiedAt }
  }

  async exists(filePath: string): Promise<boolean> { return this.fs.has(normalizePath(filePath)) }

  async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> {
    const base = normalizePath(atPath)
    for (const [rel, data] of files.entries()) {
      const relNorm = rel.startsWith('/') ? rel.slice(1) : rel
      await this.write(`${base}/${relNorm}`, data)
    }
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    if (this.executor === 'unavailable' || !this.bashExec) throw new SandboxNoExecutorError('Sandbox executor unavailable.', { session_id: 'unknown' })
    return this.bashExec(command, opts)
  }

  async close(): Promise<void> {}
}

export function inMemorySandbox(): Sandbox<readonly ['sandbox.fs']> {
  return {
    capabilities: ['sandbox.fs'],
    async open() {
      return new MemorySandboxSession('unavailable') as SandboxSessionFor<readonly ['sandbox.fs']>
    }
  }
}

export function bashSandbox(opts?: { network?: { allow?: string[]; deny?: string[] }; executionLimits?: { wallClockMs?: number; memoryMb?: number }; python?: boolean }): Sandbox<readonly ['sandbox.fs', 'sandbox.exec']> {
  let justBash: any
  try {
    justBash = require('just-bash')
  } catch {
    throw new HarnessConfigError('just-bash is not installed', { reason: 'just_bash_not_installed' })
  }

  return {
    capabilities: ['sandbox.fs', 'sandbox.exec'],
    async open() {
      const engine = justBash.createSandbox ? await justBash.createSandbox(opts) : new justBash.Bash({ ...opts, cwd: '/workspace' })
      const exec = async (command: string, execOpts?: ExecOptions): Promise<ExecResult> => {
        const started = Date.now()
        if (execOpts?.signal?.aborted) throw new OperationCancelledError('Sandbox run was cancelled.', { scope: 'sandbox' })
        if (!engine.exec) throw new HarnessConfigError('just-bash exec is unavailable', { reason: 'just_bash_exec_unavailable' })

        const timeoutMs = execOpts?.timeoutMs
        const controller = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined
        const signal = controller?.signal ?? execOpts?.signal
        const sourceSignal = execOpts?.signal as (AbortSignal & {
          addEventListener?: (type: 'abort', listener: () => void, options?: { once?: boolean }) => void
          removeEventListener?: (type: 'abort', listener: () => void) => void
        }) | undefined
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        let abortListener: (() => void) | undefined

        const abortPromise = sourceSignal?.addEventListener
          ? new Promise<never>((_, reject) => {
            abortListener = () => {
              controller?.abort()
              reject(new OperationCancelledError('Sandbox run was cancelled.', { scope: 'sandbox' }))
            }
            sourceSignal.addEventListener!('abort', abortListener, { once: true })
          })
          : undefined
        const timeoutPromise = timeoutMs && timeoutMs > 0
          ? new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              controller?.abort()
              reject(new OperationTimeoutError('Sandbox run timed out.', { scope: 'sandbox_run', timeout_ms: timeoutMs }))
            }, timeoutMs)
          })
          : undefined

        try {
          const runner = engine.exec(command, { cwd: execOpts?.cwd, env: execOpts?.env, stdin: execOpts?.stdin, signal })
          const result = await Promise.race([runner, abortPromise, timeoutPromise].filter(Boolean))
          return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0, durationSeconds: (Date.now() - started) / 1000 }
        } finally {
          if (timeoutId) clearTimeout(timeoutId)
          if (abortListener) sourceSignal?.removeEventListener?.('abort', abortListener)
        }
      }
      return new MemorySandboxSession('available', exec) as SandboxSessionFor<readonly ['sandbox.fs', 'sandbox.exec']>
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

export function autoDetectSandbox(): Sandbox<any> {
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
