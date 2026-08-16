import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile, rm, readdir, stat, lstat, realpath, chmod } from 'node:fs/promises'
import { resolve, dirname, posix, join, basename } from 'node:path'
import { SandboxError, SandboxNoExecutorError, OperationTimeoutError } from '../errors/index.js'
import type { DirEntry, ExecOptions, ExecResult, FileStat } from '../harness/types.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import { abortError } from '../runtime/abort.js'
import type { ExecCapableSandboxSession, ReadOnlyMountOptions, Sandbox, SandboxProcess, SandboxSessionBase, SpawnCapableSandboxSession, SpawnOptions } from '../sandbox/index.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'
import type { LocalWorkspaceCoordinator } from './local-workspace.js'
import { sha256Hex } from './ref-hash.js'

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

/** Capability tuple advertised by the files-only local sandbox (spec 22 §2). */
export type LocalFilesOnlySandboxCapabilities = readonly ['sandbox.fs', 'sandbox.persistent_fs']

/** Capability tuple advertised by the exec-enabled local sandbox (spec 22 §2). */
export type LocalExecSandboxCapabilities = readonly ['sandbox.fs', 'sandbox.exec', 'sandbox.persistent_fs']

/** Sandbox shape returned by `localDirectorySandbox(...)` (spec 22 §2). */
export type LocalDurableSandbox = Sandbox<LocalFilesOnlySandboxCapabilities> | Sandbox<LocalExecSandboxCapabilities>

/** Files-only session: `exec` is present but always throws `SandboxNoExecutorError`. */
export type LocalFilesOnlySandboxSession = SandboxSessionBase & {
  readonly executor: 'unavailable'
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>
}

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
/** Maximum captured stdout/stderr bytes per exec call (spec 22 §5). */
const MAX_EXEC_CAPTURE_BYTES = 10 * 1024 * 1024
const EXEC_OUTPUT_TRUNCATION_MARKER = '\n[truncated: local sandbox capture limit reached]'
/** Shell metacharacters rejected outside quotes when an allow-list is active (spec 22 §5). */
const SHELL_METACHARACTERS = new Set([';', '|', '&', '<', '>', '`', '$', '(', ')', '\n', '\r'])
/** Path-segment-safe id for sandbox session roots (no separators, no dot segments). */
const SANDBOX_ID_SEGMENT_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/

function assertSafeIdSegment(value: string, field: 'sessionId' | 'runId'): void {
  if (!SANDBOX_ID_SEGMENT_PATTERN.test(value) || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw new SandboxError(`Sandbox ${field} contains unsupported path characters.`, { reason: 'invalid_path' })
  }
}

/**
 * Tokenizes a command line without invoking a shell. Supports single/double
 * quotes for grouping; performs no expansion, substitution, or redirection.
 * When `rejectMetacharacters` is set (active allow-list), unquoted shell
 * metacharacters are rejected so the allow-list cannot be bypassed.
 */
function tokenizeCommand(command: string, opts: { rejectMetacharacters: boolean }): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let hasToken = false
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (opts.rejectMetacharacters && SHELL_METACHARACTERS.has(char)) {
      throw new SandboxError('Command contains shell metacharacters that are not allowed by local sandbox policy.', { reason: 'exec_failed' })
    }
    if (char === ' ' || char === '\t') {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
    hasToken = true
  }
  if (quote) throw new SandboxError('Command has an unterminated quote.', { reason: 'exec_failed' })
  if (hasToken) tokens.push(current)
  return tokens
}

interface CapturedOutput {
  text: string
  bytes: number
  truncated: boolean
}

function appendCapped(target: CapturedOutput, chunk: string): void {
  if (target.truncated) return
  const chunkBytes = Buffer.byteLength(chunk)
  if (target.bytes + chunkBytes <= MAX_EXEC_CAPTURE_BYTES) {
    target.text += chunk
    target.bytes += chunkBytes
    return
  }
  const remaining = MAX_EXEC_CAPTURE_BYTES - target.bytes
  target.text += chunk.slice(0, Math.max(0, remaining)) + EXEC_OUTPUT_TRUNCATION_MARKER
  target.bytes = MAX_EXEC_CAPTURE_BYTES
  target.truncated = true
}

class LocalDirectorySandboxSession implements SandboxSessionBase {
  public readonly executor: 'available' | 'unavailable'
  private readonly root: string
  private readonly execPolicy: false | LocalHostExecPolicy
  private readonly telemetry: TelemetryShim | undefined
  private readonly fallbackExecTimeoutMs: number

  public constructor(root: string, execPolicy: false | LocalHostExecPolicy, telemetry: TelemetryShim | undefined, fallbackExecTimeoutMs: number | undefined) {
    this.root = resolve(root)
    this.execPolicy = execPolicy
    this.telemetry = telemetry
    this.fallbackExecTimeoutMs = fallbackExecTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
    this.executor = execPolicy === false ? 'unavailable' : 'available'
  }

  public async read(path: string): Promise<Uint8Array> {
    return this.sandboxSpan('read', {}, async () => readFile(await this.toPhysical(path)))
  }

  public async readText(path: string): Promise<string> {
    return this.sandboxSpan('read_text', {}, async () => readFile(await this.toPhysical(path), 'utf8'))
  }

  public async write(path: string, data: Uint8Array | string): Promise<void> {
    return this.sandboxSpan('write', {
      'harness.sandbox.write_bytes': typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    }, async () => {
      const physical = await this.toPhysical(path, { forWrite: true })
      await mkdir(dirname(physical), { recursive: true })
      await writeFile(physical, data)
    })
  }

  public async remove(path: string, opts: { recursive?: boolean } = {}): Promise<void> {
    return this.sandboxSpan('remove', {
      'harness.sandbox.recursive': opts.recursive ?? false
    }, async () => { await rm(await this.toPhysical(path), { recursive: opts.recursive ?? false, force: true }) })
  }

  public async list(path: string, opts: { recursive?: boolean; glob?: string } = {}): Promise<DirEntry[]> {
    return this.sandboxSpan('list', {
      'harness.sandbox.recursive': opts.recursive ?? false,
      'harness.sandbox.has_glob': Boolean(opts.glob)
    }, async () => {
      const root = await this.toPhysical(path)
      const entries: DirEntry[] = []
      await this.collect(root, path, opts.recursive ?? false, entries)
      if (!opts.glob) return entries
      const globPattern = globToRegExp(opts.glob)
      return entries.filter((entry) => globPattern.test(entry.path))
    })
  }

  public async stat(path: string): Promise<FileStat> {
    return this.sandboxSpan('stat', {}, async () => {
      const info = await stat(await this.toPhysical(path))
      return { kind: info.isDirectory() ? 'directory' : 'file', size: info.isDirectory() ? 0 : info.size, modifiedAt: info.mtime.toISOString() }
    })
  }

  public async exists(path: string): Promise<boolean> {
    return this.sandboxSpan('exists', {}, async () => {
      try {
        await this.toPhysical(path)
        return true
      } catch {
        return false
      }
    })
  }

  public async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> {
    return this.sandboxSpan('mount', {
      'harness.sandbox.file_count': files.size
    }, async () => {
      for (const [name, data] of files) {
        const target = posix.join(atPath, name)
        await this.write(target, data)
      }
    })
  }

  /** Stages package assets then removes write permission from every asset and directory. */
  public async mountReadOnly(files: ReadonlyMap<string, Uint8Array | string>, atPath: string, options: ReadOnlyMountOptions = {}): Promise<void> {
    return this.sandboxSpan('mount_read_only', { 'harness.sandbox.file_count': files.size }, async () => {
      await this.mount(files, atPath)
      const base = await this.toPhysical(atPath)
      const directories = new Set<string>([base])
      const executable = new Set(options.executablePaths ?? [])
      for (const name of files.keys()) {
        const target = await this.toPhysical(posix.join(atPath, name))
        await chmod(target, executable.has(name) ? 0o555 : 0o444)
        let directory = dirname(target)
        while (directory === base || directory.startsWith(`${base}/`)) {
          directories.add(directory)
          if (directory === base) break
          directory = dirname(directory)
        }
      }
      for (const directory of [...directories].sort((left, right) => right.length - left.length)) await chmod(directory, 0o555)
    })
  }

  /** Starts a long-lived process using the same allowlist and environment policy as exec(). */
  public async spawn(command: string, opts: SpawnOptions = {}): Promise<SandboxProcess> {
    return this.sandboxSpan('spawn', { 'harness.sandbox.has_cwd': Boolean(opts.cwd) }, async () => {
      if (this.execPolicy === false) throw new SandboxNoExecutorError('Sandbox executor unavailable.', { session_id: 'local' })
      if (opts.signal?.aborted) throw abortError(opts.signal, 'sandbox', 'Sandbox run was cancelled.')
      const policy = this.execPolicy
      const commandName = command.startsWith('/') ? await this.toPhysical(command) : command
      if (policy.allowCommands && !policy.allowCommands.includes(command) && !policy.allowCommands.includes(basename(commandName))) {
        throw new SandboxError('Command is not allowed by local sandbox policy.', { reason: 'exec_failed' })
      }
      const cwd = await this.toPhysical(opts.cwd ?? '/workspace')
      const mapSandboxPathValue = async (value: string): Promise<string> => {
        if (value.startsWith('/')) return await this.toPhysical(value)
        const assignment = value.indexOf('=/')
        if (assignment < 0) return value
        return `${value.slice(0, assignment + 1)}${await this.toPhysical(value.slice(assignment + 1))}`
      }
      const args = await Promise.all((opts.args ?? []).map(mapSandboxPathValue))
      const envEntries = await Promise.all(Object.entries(opts.env ?? {}).map(async ([name, value]) => [name, await mapSandboxPathValue(value)] as const))
      const child = spawn(commandName, args, {
        cwd,
        env: { PATH: process.env['PATH'] ?? '', HOME: this.root, ...policy.env, ...Object.fromEntries(envEntries) },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const exit = new Promise<{ exitCode: number; signal?: string }>((resolveExit) => {
        child.once('close', (exitCode, signal) => resolveExit({ exitCode: exitCode ?? 1, ...(signal ? { signal } : {}) }))
      })
      const onAbort = () => { child.kill('SIGTERM') }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      void exit.finally(() => opts.signal?.removeEventListener('abort', onAbort))
      return {
        writeStdin: async (chunk) => await new Promise<void>((resolveWrite, rejectWrite) => {
          child.stdin.write(chunk, (error) => error ? rejectWrite(error) : resolveWrite())
        }),
        stdout: (async function * () { for await (const chunk of child.stdout) yield String(chunk) })(),
        stderr: (async function * () { for await (const chunk of child.stderr) yield String(chunk) })(),
        exit,
        kill: async (signal = 'SIGTERM') => {
          if (!child.killed) child.kill(signal)
          await exit
        }
      }
    })
  }

  public async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.sandboxSpan('exec', {
      'harness.sandbox.has_cwd': Boolean(opts.cwd),
      'harness.sandbox.has_stdin': Boolean(opts.stdin)
    }, async () => {
      if (this.execPolicy === false) {
        throw new SandboxNoExecutorError('Sandbox session has no executor.', { session_id: 'local' })
      }
      const policy = this.execPolicy
      // No shell is involved: the command is tokenized and spawned as argv, so
      // metacharacters carry no semantics. With an allow-list they are rejected
      // outright to keep the policy boundary obvious (spec 22 §5).
      const argv = tokenizeCommand(command, { rejectMetacharacters: policy.allowCommands !== undefined })
      const commandName = argv[0]
      if (!commandName) {
        throw new SandboxError('Sandbox command is empty.', { reason: 'exec_failed' })
      }
      if (policy.allowCommands && !policy.allowCommands.includes(commandName)) {
        throw new SandboxError('Command is not allowed by local sandbox policy.', { reason: 'exec_failed' })
      }
      const cwd = await this.toPhysical(opts.cwd ?? '/workspace')
      const timeoutMs = opts.timeoutMs ?? policy.timeoutMs ?? this.fallbackExecTimeoutMs
      const signal = opts.signal
      if (signal?.aborted) throw abortError(signal, 'sandbox', 'Sandbox exec was cancelled.')
      const started = Date.now()
      return new Promise<ExecResult>((resolveExec, rejectExec) => {
        const child = spawn(commandName, argv.slice(1), {
          cwd,
          env: { PATH: process.env['PATH'] ?? '', HOME: this.root, ...policy.env, ...opts.env },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        const stdout: CapturedOutput = { text: '', bytes: 0, truncated: false }
        const stderr: CapturedOutput = { text: '', bytes: 0, truncated: false }
        let settled = false
        const onAbort = (): void => {
          child.kill('SIGTERM')
          finish(() => rejectExec(abortError(signal as AbortSignal, 'sandbox', 'Sandbox exec was cancelled.')))
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          finish(() => rejectExec(new OperationTimeoutError('Sandbox exec timed out.', { scope: 'sandbox_run', timeout_ms: timeoutMs })))
        }, timeoutMs)
        const finish = (settle: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          settle()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        child.stdout.on('data', (chunk) => { appendCapped(stdout, String(chunk)) })
        child.stderr.on('data', (chunk) => { appendCapped(stderr, String(chunk)) })
        child.on('error', (error) => {
          finish(() => rejectExec(new SandboxError('Local sandbox exec failed.', { reason: 'exec_failed', stdout: stdout.text, stderr: stderr.text }, error)))
        })
        child.on('close', (exitCode, exitSignal) => {
          finish(() => {
            if (exitCode === null) {
              rejectExec(new SandboxError(`Local sandbox exec was terminated by signal ${exitSignal ?? 'unknown'}.`, { reason: 'exec_failed', stdout: stdout.text, stderr: stderr.text }))
              return
            }
            resolveExec({ stdout: stdout.text, stderr: stderr.text, exitCode, durationSeconds: (Date.now() - started) / 1000 })
          })
        })
        if (opts.stdin) child.stdin.end(opts.stdin)
        else child.stdin.end()
      })
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
    if (opts.forWrite) {
      // The final component must not be a symlink (including dangling ones):
      // writing through it would follow the link target outside the jail.
      const targetInfo = await lstat(target).catch(() => undefined)
      if (targetInfo?.isSymbolicLink()) {
        throw new SandboxError('Path escapes local sandbox root.', { reason: 'invalid_path' })
      }
    }
    return target
  }

  private async sandboxSpan<T>(operation: string, attrs: SpanAttrs, fn: () => Promise<T>): Promise<T> {
    const spanAttrs: SpanAttrs = {
      'harness.sandbox.adapter': 'local_directory_sandbox',
      'harness.sandbox.operation': operation,
      'harness.sandbox.exec_enabled': this.execPolicy !== false,
      ...attrs
    }
    const started = Date.now()
    const run = async (): Promise<T> => {
      try {
        const result = await fn()
        this.telemetry?.recordCounter('harness.local_sandbox.operations', 1, spanAttrs)
        return result
      } finally {
        this.telemetry?.recordHistogram('harness.local_sandbox.operation.duration', (Date.now() - started) / 1000, spanAttrs)
      }
    }
    return this.telemetry ? this.telemetry.span(`harness.local_sandbox.${operation}`, spanAttrs, run) : run()
  }
}

class FilesOnlyLocalSandboxSession extends LocalDirectorySandboxSession {
  declare public readonly executor: 'unavailable'

  public constructor(root: string, telemetry: TelemetryShim | undefined) {
    super(root, false, telemetry, undefined)
  }
}

class ExecLocalSandboxSession extends LocalDirectorySandboxSession implements ExecCapableSandboxSession, SpawnCapableSandboxSession {
  declare public readonly executor: 'available'

  public constructor(root: string, execPolicy: LocalHostExecPolicy, telemetry: TelemetryShim | undefined, fallbackExecTimeoutMs: number | undefined) {
    super(root, execPolicy, telemetry, fallbackExecTimeoutMs)
  }
}

abstract class BaseLocalDirectorySandbox {
  protected telemetry: TelemetryShim | undefined
  protected toolTimeoutMs: number | undefined

  protected constructor(protected readonly options: LocalDirectorySandboxOptions, private readonly execEnabled: boolean) {}

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.telemetry = context.telemetry
    // Spec 22 §2: exec timeout falls back to the configured harness toolTimeoutMs.
    this.toolTimeoutMs = context.defaults.toolTimeoutMs
  }

  protected async openRoot<T extends SandboxSessionBase>(opts: { sessionId: string; runId: string; signal?: AbortSignal }, make: (root: string) => T): Promise<T> {
    assertSafeIdSegment(opts.sessionId, 'sessionId')
    assertSafeIdSegment(opts.runId, 'runId')
    const active = this.options.coordinator?.get(opts.runId, opts.sessionId)
    const spanAttrs: SpanAttrs = {
      'harness.sandbox.adapter': 'local_directory_sandbox',
      'harness.sandbox.operation': 'open',
      'harness.sandbox.exec_enabled': this.execEnabled,
      ...(active ? { 'harness.workspace.ref_hash': sha256Hex(active.workspaceRef) } : {}),
      'harness.run.id': opts.runId,
      'harness.session.id': opts.sessionId
    }
    const started = Date.now()
    const run = async (): Promise<T> => {
      const root = active?.activePath ?? resolve(this.options.root, 'sessions', opts.sessionId, opts.runId)
      await mkdir(join(root, 'workspace'), { recursive: true })
      this.telemetry?.recordCounter('harness.local_sandbox.operations', 1, spanAttrs)
      this.telemetry?.recordHistogram('harness.local_sandbox.operation.duration', (Date.now() - started) / 1000, spanAttrs)
      return make(root)
    }
    return this.telemetry ? this.telemetry.span('harness.local_sandbox.open', spanAttrs, async () => run()) : run()
  }
}

class FilesOnlyLocalDirectorySandbox extends BaseLocalDirectorySandbox implements Sandbox<LocalFilesOnlySandboxCapabilities> {
  public readonly capabilities = ['sandbox.fs', 'sandbox.persistent_fs'] as const

  public constructor(options: LocalDirectorySandboxOptions) {
    super(options, false)
  }

  public async open(opts: { sessionId: string; runId: string; signal?: AbortSignal }): Promise<LocalFilesOnlySandboxSession> {
    return this.openRoot(opts, (root) => new FilesOnlyLocalSandboxSession(root, this.telemetry))
  }
}

class ExecLocalDirectorySandbox extends BaseLocalDirectorySandbox implements Sandbox<LocalExecSandboxCapabilities> {
  public readonly capabilities = ['sandbox.fs', 'sandbox.exec', 'sandbox.persistent_fs'] as const

  public constructor(options: LocalDirectorySandboxOptions, private readonly execPolicy: LocalHostExecPolicy) {
    super(options, true)
  }

  public async open(opts: { sessionId: string; runId: string; signal?: AbortSignal }): Promise<ExecCapableSandboxSession> {
    return this.openRoot(opts, (root) => new ExecLocalSandboxSession(root, this.execPolicy, this.telemetry, this.toolTimeoutMs))
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

export function localDirectorySandbox(options: LocalDirectorySandboxOptions): LocalDurableSandbox {
  const exec = options.exec ?? false
  return exec === false ? new FilesOnlyLocalDirectorySandbox(options) : new ExecLocalDirectorySandbox(options, exec)
}
