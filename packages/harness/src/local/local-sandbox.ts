import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rm, readdir, stat, realpath } from 'node:fs/promises'
import { resolve, dirname, posix, join } from 'node:path'
import { SandboxError, SandboxNoExecutorError, OperationTimeoutError } from '../errors/index.js'
import type { DirEntry, ExecOptions, ExecResult, FileStat } from '../harness/types.js'
import type { AdapterCapability } from '../ports/capabilities.js'
import type { Sandbox, SandboxSessionBase } from '../sandbox/index.js'
import type { LocalWorkspaceCoordinator } from './local-workspace.js'

export interface LocalHostExecPolicy {
  env?: Record<string, string>
  allowCommands?: readonly string[]
  timeoutMs?: number
}

export interface LocalDirectorySandboxOptions {
  root: string
  exec?: false | LocalHostExecPolicy
  coordinator?: LocalWorkspaceCoordinator
}

class LocalDirectorySandboxSession implements SandboxSessionBase {
  public readonly executor: 'available' | 'unavailable'
  private readonly root: string
  private readonly execPolicy: false | LocalHostExecPolicy

  public constructor(root: string, execPolicy: false | LocalHostExecPolicy) {
    this.root = resolve(root)
    this.execPolicy = execPolicy
    this.executor = execPolicy === false ? 'unavailable' : 'available'
  }

  public async read(path: string): Promise<Uint8Array> {
    return readFile(await this.toPhysical(path))
  }

  public async readText(path: string): Promise<string> {
    return readFile(await this.toPhysical(path), 'utf8')
  }

  public async write(path: string, data: Uint8Array | string): Promise<void> {
    const physical = await this.toPhysical(path, { forWrite: true })
    await mkdir(dirname(physical), { recursive: true })
    await writeFile(physical, data)
  }

  public async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    await rm(await this.toPhysical(path), { recursive: opts.recursive ?? false, force: true })
  }

  public async list(path: string, opts: { recursive?: boolean; glob?: string } = {}): Promise<DirEntry[]> {
    const root = await this.toPhysical(path)
    const entries: DirEntry[] = []
    await this.collect(root, path, opts.recursive ?? false, entries)
    return opts.glob ? entries.filter((entry) => globToRegExp(opts.glob ?? '').test(entry.path)) : entries
  }

  public async stat(path: string): Promise<FileStat> {
    const info = await stat(await this.toPhysical(path))
    return { kind: info.isDirectory() ? 'directory' : 'file', size: info.isDirectory() ? 0 : info.size, modifiedAt: info.mtime.toISOString() }
  }

  public async exists(path: string): Promise<boolean> {
    try {
      await this.toPhysical(path)
      return true
    } catch {
      return false
    }
  }

  public async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> {
    for (const [name, data] of files) {
      const target = posix.join(atPath, name)
      await this.write(target, data)
    }
  }

  public async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.execPolicy === false) {
      throw new SandboxNoExecutorError('Sandbox session has no executor.', { session_id: 'local' })
    }
    const policy = this.execPolicy
    const commandName = command.trim().split(/\s+/)[0] ?? ''
    if (policy.allowCommands && !policy.allowCommands.includes(commandName)) {
      throw new SandboxError('Command is not allowed by local sandbox policy.', { reason: 'exec_failed' })
    }
    const cwd = await this.toPhysical(opts.cwd ?? '/workspace')
    const timeoutMs = opts.timeoutMs ?? policy.timeoutMs ?? 120_000
    const started = Date.now()
    return new Promise<ExecResult>((resolveExec, rejectExec) => {
      const child = spawn(command, {
        cwd,
        shell: true,
        env: { PATH: process.env['PATH'] ?? '', HOME: this.root, ...policy.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        rejectExec(new OperationTimeoutError('Sandbox exec timed out.', { scope: 'sandbox_run', timeout_ms: timeoutMs }))
      }, timeoutMs)
      opts.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', (error) => {
        clearTimeout(timer)
        rejectExec(new SandboxError('Local sandbox exec failed.', { reason: 'exec_failed', stdout, stderr }, error))
      })
      child.on('close', (exitCode) => {
        clearTimeout(timer)
        resolveExec({ stdout, stderr, exitCode: exitCode ?? 0, durationSeconds: (Date.now() - started) / 1000 })
      })
      if (opts.stdin) child.stdin.end(opts.stdin)
      else child.stdin.end()
    })
  }

  public async close(): Promise<void> {}

  private async collect(root: string, virtualRoot: string, recursive: boolean, out: DirEntry[]): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const physical = join(root, entry.name)
      const virtual = posix.join(virtualRoot, entry.name)
      const info = await stat(physical)
      out.push({ name: entry.name, path: virtual, kind: entry.isDirectory() ? 'directory' : 'file', ...(entry.isFile() ? { size: info.size } : {}) })
      if (recursive && entry.isDirectory()) await this.collect(physical, virtual, recursive, out)
    }
  }

  private async toPhysical(input: string, opts: { forWrite?: boolean } = {}): Promise<string> {
    if (!input.startsWith('/')) throw new SandboxError('Invalid path.', { reason: 'invalid_path' })
    const normalized = posix.normalize(input)
    if (!normalized.startsWith('/')) throw new SandboxError('Invalid path.', { reason: 'invalid_path' })
    const target = resolve(this.root, `.${normalized}`)
    const guardPath = opts.forWrite ? dirname(target) : target
    const existing = await realpath(guardPath).catch(() => opts.forWrite ? realpathExistingParent(guardPath) : undefined)
    if (!existing) throw new SandboxError('Path not found.', { reason: 'fs_failed' })
    const rootReal = await realpath(this.root)
    if (existing !== rootReal && !existing.startsWith(`${rootReal}/`)) {
      throw new SandboxError('Path escapes local sandbox root.', { reason: 'invalid_path' })
    }
    return target
  }
}

class LocalDirectorySandbox {
  public readonly capabilities: readonly AdapterCapability[]
  public constructor(private readonly options: LocalDirectorySandboxOptions) {
    this.capabilities = options.exec === false || options.exec === undefined
      ? ['sandbox.fs', 'sandbox.persistent_fs']
      : ['sandbox.fs', 'sandbox.exec', 'sandbox.persistent_fs']
  }

  public configureHarnessContext(): void {}

  public async open(opts: { sessionId: string; runId: string; signal?: AbortSignal }): Promise<SandboxSessionBase & { exec?: (command: string, opts?: ExecOptions) => Promise<ExecResult> }> {
    const active = this.options.coordinator?.get(opts.runId, opts.sessionId)
    const root = active?.activePath ?? resolve(this.options.root, 'sessions', opts.sessionId, opts.runId)
    await mkdir(join(root, 'workspace'), { recursive: true })
    return new LocalDirectorySandboxSession(root, this.options.exec ?? false)
  }
}

async function realpathExistingParent(path: string): Promise<string | undefined> {
  let current = path
  while (current !== dirname(current)) {
    try {
      return await realpath(current)
    } catch {
      current = dirname(current)
    }
  }
  return undefined
}

function globToRegExp(glob: string): RegExp {
  const source = glob.split('*').map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')).join('.*')
  return new RegExp(`^${source}$`)
}

export function localDirectorySandbox(options: LocalDirectorySandboxOptions): Sandbox {
  return new LocalDirectorySandbox(options) as Sandbox
}
