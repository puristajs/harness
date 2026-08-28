import path from 'node:path'

import { OperationCancelledError, SandboxError, SandboxNoExecutorError } from '../errors/index.js'
import type { DirEntry, ExecOptions, ExecResult, FileStat } from '../harness/types.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import type { Sandbox, SandboxSession, SandboxOpenOptions, SandboxOpenResult, SandboxTerminateOptions } from '../sandbox/index.js'
import { SandboxAdapterCatalog } from '../sandbox/adapter-catalog.js'
import type { SandboxAdministration } from '../sandbox/administration.js'
import type { SandboxOwnerRegistrationOptions } from '../sandbox/ownership.js'
import { ProcessLocalSandboxLifecycle } from '../sandbox/lifecycle.js'

/** Options for {@link FakeSandbox}. */
export interface FakeSandboxOptions {
  /** Whether sessions report an available command executor. Default: `'available'`. */
  executor?: 'available' | 'unavailable'
  /** Optional scripted exec handler. Defaults to a deterministic `echo`-only executor. */
  exec?: (command: string, opts?: ExecOptions) => ExecResult | Promise<ExecResult>
}

type FakeNode = { kind: 'file'; data: Uint8Array; modifiedAt: string } | { kind: 'directory'; modifiedAt: string }

function now(): string {
  return new Date().toISOString()
}


function normalizePath(input: string): string {
  if (!input.startsWith('/')) throw new SandboxError('Invalid path', { reason: 'invalid_path' })
  const normalized = path.posix.normalize(input)
  if (!normalized.startsWith('/')) throw new SandboxError('Invalid path', { reason: 'invalid_path' })
  return normalized
}

/** Deterministic default executor: supports `echo <text>`; everything else exits 127. */
function defaultExec(command: string): ExecResult {
  const trimmed = command.trim()
  if (trimmed === 'echo' || trimmed.startsWith('echo ')) {
    return { stdout: `${trimmed.slice(4).trim()}\n`, stderr: '', exitCode: 0, durationSeconds: 0 }
  }
  const name = trimmed.split(/\s+/)[0] ?? ''
  return { stdout: '', stderr: `command not found: ${name}\n`, exitCode: 127, durationSeconds: 0 }
}

class FakeSandboxSession implements SandboxSession {
  public readonly executor: 'available' | 'unavailable'
  private closed = false
  private readonly fs = new Map<string, FakeNode>([['/', { kind: 'directory', modifiedAt: now() }]])

  public constructor(
    public readonly sessionId: string,
    private readonly options: FakeSandboxOptions
  ) {
    this.executor = options.executor ?? 'available'
  }

  public async read(filePath: string): Promise<Uint8Array> {
    this.assertOpen()
    const node = this.fs.get(normalizePath(filePath))
    if (!node || node.kind !== 'file') throw new SandboxError('File not found', { reason: 'fs_failed' })
    return new Uint8Array(node.data)
  }

  public async readText(filePath: string): Promise<string> {
    return new TextDecoder().decode(await this.read(filePath))
  }

  public async write(filePath: string, data: Uint8Array | string): Promise<void> {
    this.assertOpen()
    const target = normalizePath(filePath)
    this.ensureParent(target)
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
    this.fs.set(target, { kind: 'file', data: bytes, modifiedAt: now() })
  }

  public async remove(filePath: string, opts?: { recursive?: boolean }): Promise<void> {
    this.assertOpen()
    const target = normalizePath(filePath)
    if (opts?.recursive) {
      for (const key of [...this.fs.keys()]) {
        if (key === target || key.startsWith(`${target}/`)) this.fs.delete(key)
      }
      return
    }
    this.fs.delete(target)
  }

  public async list(rootPath: string, opts?: { recursive?: boolean; glob?: string }): Promise<DirEntry[]> {
    this.assertOpen()
    const root = normalizePath(rootPath)
    const out: DirEntry[] = []
    for (const [entryPath, node] of this.fs.entries()) {
      if (entryPath === root) continue
      if (!entryPath.startsWith(root === '/' ? '/' : `${root}/`)) continue
      const relative = root === '/' ? entryPath.slice(1) : entryPath.slice(root.length + 1)
      if (!opts?.recursive && relative.includes('/')) continue
      if (opts?.glob && !new RegExp(opts.glob.replaceAll('.', '\\.').replaceAll('*', '.*')).test(entryPath)) continue
      out.push({
        name: entryPath.split('/').at(-1) ?? '',
        path: entryPath,
        kind: node.kind,
        ...(node.kind === 'file' ? { size: node.data.byteLength } : {})
      })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  public async stat(filePath: string): Promise<FileStat> {
    this.assertOpen()
    const node = this.fs.get(normalizePath(filePath))
    if (!node) throw new SandboxError('Path not found', { reason: 'fs_failed' })
    return { kind: node.kind, size: node.kind === 'file' ? node.data.byteLength : 0, modifiedAt: node.modifiedAt }
  }

  public async exists(filePath: string): Promise<boolean> {
    this.assertOpen()
    return this.fs.has(normalizePath(filePath))
  }

  public async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> {
    this.assertOpen()
    const base = normalizePath(atPath)
    for (const [rel, data] of files.entries()) {
      const relNorm = rel.startsWith('/') ? rel.slice(1) : rel
      await this.write(`${base}/${relNorm}`, data)
    }
  }

  public async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.assertOpen()
    if (this.executor !== 'available') {
      throw new SandboxNoExecutorError('Sandbox executor unavailable.', { session_id: this.sessionId })
    }
    if (opts?.signal?.aborted) {
      throw new OperationCancelledError('Sandbox exec was cancelled.', { scope: 'sandbox' })
    }
    return (this.options.exec ?? defaultExec)(command, opts)
  }

  public async close(): Promise<void> {
    this.closed = true
  }

  private assertOpen(): void {
    if (this.closed) throw new SandboxError('Sandbox session is closed.', { reason: 'session_closed' })
  }

  private ensureParent(filePath: string): void {
    const parts = normalizePath(filePath).split('/').filter(Boolean)
    let current = '/'
    for (let i = 0; i < parts.length - 1; i += 1) {
      current = current === '/' ? `/${parts[i]}` : `${current}/${parts[i]}`
      if (!this.fs.has(current)) this.fs.set(current, { kind: 'directory', modifiedAt: now() })
    }
  }
}

class FakeSandboxAttachment implements SandboxSession {
  public readonly executor: 'available' | 'unavailable'
  private closed = false
  private readonly controller = new AbortController()

  public constructor(private readonly backing: FakeSandboxSession, private readonly assertActive: () => void | Promise<void>) {
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

/**
 * Deterministic in-memory sandbox fake with a configurable executor flag.
 *
 * Sessions are typed exec-capable; when constructed with
 * `executor: 'unavailable'` dynamically widened `exec(...)` calls throw
 * `SandboxNoExecutorError`, matching the sandbox contract.
 */
export class FakeSandbox implements Sandbox {
  public readonly telemetryAdapterId = 'in_memory_sandbox'
  public readonly capabilities: readonly AdapterCapability[]
  private readonly lifecycle = new ProcessLocalSandboxLifecycle<FakeSandboxSession>()
  private readonly catalog = SandboxAdapterCatalog.inMemory(async (resource) => {
    if (resource.kind === 'sandbox' && resource.scope) await this.lifecycle.terminate({ scope: resource.scope, reason: 'manual' })
  })

  public get administration(): SandboxAdministration { return this.catalog.administration }

  public constructor(private readonly options: FakeSandboxOptions = {}) {
    this.capabilities = (options.executor ?? 'available') === 'available'
      ? ['sandbox.fs', 'sandbox.exec']
      : ['sandbox.fs']
  }

  public async registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void> {
    await this.catalog.registerOwner(options)
  }

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.catalog.configureHarnessContext(context, 'in_memory_sandbox')
  }


  public async open(options: SandboxOpenOptions): Promise<SandboxOpenResult<readonly AdapterCapability[]> & { session: SandboxSession }> {
    const { session, disposition, assertActive } = await this.catalog.open(options, async () => await this.lifecycle.open(options, () => new FakeSandboxSession(options.scope.owner.id, this.options)))
    return { session: new FakeSandboxAttachment(session, assertActive), disposition, liveProcessState: 'not_preserved' }
  }

  public async terminate(options: SandboxTerminateOptions): Promise<void> {
    await this.catalog.terminate(options, async () => await this.lifecycle.terminate(options))
  }
}
