import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import process from 'node:process'
import { mkdir, readFile, writeFile, rm, readdir, stat, lstat, realpath } from 'node:fs/promises'
import { resolve, dirname, posix, join, basename } from 'node:path'
import { HarnessError, SandboxError, SandboxNoExecutorError, SandboxStateLostError, OperationTimeoutError } from '../errors/index.js'
import type { DirEntry, ExecOptions, ExecResult, FileStat } from '../harness/types.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import { abortError } from '../runtime/abort.js'
import { SandboxAdapterCatalog } from '../sandbox/adapter-catalog.js'
import type { SandboxAdministration, SandboxAdministrationOptions, SandboxResourceSummary } from '../sandbox/administration.js'
import { LocalSandboxCatalog } from './local-sandbox-catalog.js'
import type { ExecCapableSandboxSession, Sandbox, SandboxOpenOptions, SandboxOpenResult, SandboxProcess, SandboxScope, SandboxSessionBase, SandboxTerminateOptions, SpawnCapableSandboxSession, SpawnOptions } from '../sandbox/index.js'
import type { SandboxOwnerRegistrationOptions } from '../sandbox/ownership.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'
import type { LocalWorkspaceCoordinator } from './local-workspace.js'
import { LocalSandboxState, type LocalSandboxAttachment } from './local-sandbox-state.js'
import { sha256Hex } from './ref-hash.js'
import { sandboxScopeKey } from '../sandbox/lifecycle.js'

export interface LocalHostExecPolicy {
  env?: Record<string, string>
  allowCommands?: readonly string[]
  timeoutMs?: number
}

export interface LocalDirectorySandboxOptions {
  root: string
  exec?: false | LocalHostExecPolicy
  coordinator?: LocalWorkspaceCoordinator
  /** Bounded private inventory and cleanup limits for this adapter. */
  administration?: SandboxAdministrationOptions
}

/** Capability tuple advertised by the files-only local sandbox (spec 22 §2). */
export type LocalFilesOnlySandboxCapabilities = readonly ['sandbox.fs', 'sandbox.persistent_fs'] | readonly ['sandbox.fs', 'sandbox.persistent_fs', 'sandbox.workspace_binding']

/** Capability tuple advertised by the exec-enabled local sandbox (spec 22 §2). */
export type LocalExecSandboxCapabilities = readonly ['sandbox.fs', 'sandbox.exec', 'sandbox.spawn', 'sandbox.persistent_fs'] | readonly ['sandbox.fs', 'sandbox.exec', 'sandbox.spawn', 'sandbox.persistent_fs', 'sandbox.workspace_binding']

/** Sandbox shape returned by `localDirectorySandbox(...)` (spec 22 §2). */
export type LocalDurableSandbox = Sandbox<LocalFilesOnlySandboxCapabilities> | Sandbox<LocalExecSandboxCapabilities>

const DEFAULT_EXEC_TIMEOUT_MS = 120_000
/** Maximum captured stdout/stderr bytes per exec call (spec 22 §5). */
const MAX_EXEC_CAPTURE_BYTES = 10 * 1024 * 1024
const EXEC_OUTPUT_TRUNCATION_MARKER = '\n[truncated: local sandbox capture limit reached]'
/** Shell metacharacters rejected outside quotes when an allow-list is active (spec 22 §5). */
const SHELL_METACHARACTERS = new Set([';', '|', '&', '<', '>', '`', '$', '(', ')', '\n', '\r'])
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
  target.text += Buffer.from(chunk).subarray(0, Math.max(0, remaining)).toString('utf8') + EXEC_OUTPUT_TRUNCATION_MARKER
  target.bytes = MAX_EXEC_CAPTURE_BYTES
  target.truncated = true
}

class LocalDirectorySandboxSession implements SandboxSessionBase {
  public readonly executor: 'available' | 'unavailable'
  private readonly root: string
  private readonly execPolicy: false | LocalHostExecPolicy
  private readonly telemetry: TelemetryShim | undefined
  private readonly fallbackExecTimeoutMs: number
  private closed = false
  private cleanupComplete = false
  private closePromise: Promise<void> | undefined
  private terminated = false
  private readonly processStops = new Set<(signal?: 'SIGTERM' | 'SIGKILL') => Promise<void>>()
  private readonly unregister: () => void

  public constructor(
    private readonly state: LocalSandboxState,
    private readonly attachment: LocalSandboxAttachment,
    execPolicy: false | LocalHostExecPolicy,
    telemetry: TelemetryShim | undefined,
    fallbackExecTimeoutMs: number | undefined,
    private readonly assertActive: () => void | Promise<void> = () => undefined
  ) {
    this.root = resolve(attachment.root)
    this.execPolicy = execPolicy
    this.telemetry = telemetry
    this.fallbackExecTimeoutMs = fallbackExecTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
    this.executor = execPolicy === false ? 'unavailable' : 'available'
    this.unregister = state.register(attachment, async () => {
      this.terminated = true
      await this.stopProcesses()
      this.unregister()
    })
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
      const physical = await this.toPhysical(path, { forWrite: true })
      try {
        await stat(physical)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    })
  }

  public async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> {
    return this.sandboxSpan('mount', {
      'harness.sandbox.file_count': files.size
    }, async () => {
      for (const [name, data] of files) {
        const target = posix.join(atPath, name)
        const physical = await this.toPhysical(target, { forWrite: true })
        await mkdir(dirname(physical), { recursive: true })
        await writeFile(physical, data)
      }
    })
  }

  /** Starts a long-lived process using the same allowlist and environment policy as exec(). */
  public async spawn(command: string, opts: SpawnOptions = {}): Promise<SandboxProcess> {
    const releaseProcess = await this.attachment.writerFence?.trackProcess()
    try {
      const processHandle = await this.sandboxSpan('spawn', { 'harness.sandbox.has_cwd': Boolean(opts.cwd) }, async () => {
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
      this.requireUsable()
      if (opts.signal?.aborted) throw abortError(opts.signal, 'sandbox', 'Sandbox run was cancelled.')
      const child = spawn(commandName, args, {
        cwd,
        env: { PATH: process.env['PATH'] ?? '', HOME: this.root, ...policy.env, ...Object.fromEntries(envEntries) },
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const exit = new Promise<{ exitCode: number; signal?: string }>((resolveExit) => {
        child.once('close', (exitCode, signal) => resolveExit({ exitCode: exitCode ?? 1, ...(signal ? { signal } : {}) }))
      })
      const stop = this.trackProcess(child, exit)
      child.stdin.on('error', () => undefined)
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once('spawn', resolveSpawn)
        child.once('error', () => rejectSpawn(new SandboxError('Local sandbox process could not be started.', { reason: 'exec_failed' })))
      })
      const onAbort = () => { void stop().catch(() => undefined) }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (opts.signal?.aborted) {
        await stop()
        throw abortError(opts.signal, 'sandbox', 'Sandbox process was cancelled.')
      }
      void exit.finally(() => opts.signal?.removeEventListener('abort', onAbort))
      const sandboxProcess: SandboxProcess = {
        writeStdin: async (chunk) => await new Promise<void>((resolveWrite, rejectWrite) => {
          child.stdin.write(chunk, (error) => error ? rejectWrite(new SandboxError('Local sandbox stdin is unavailable.', { reason: 'exec_failed' })) : resolveWrite())
        }),
        stdout: (async function * () { for await (const chunk of child.stdout) yield String(chunk) })(),
        stderr: (async function * () { for await (const chunk of child.stderr) yield String(chunk) })(),
        exit,
        kill: stop
      }
        return sandboxProcess
      })
      void processHandle.exit.finally(() => releaseProcess?.())
      return processHandle
    } catch (error) {
      releaseProcess?.()
      throw error
    }
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
        this.requireUsable()
        const child = spawn(commandName, argv.slice(1), {
          cwd,
          env: { PATH: process.env['PATH'] ?? '', HOME: this.root, ...policy.env, ...opts.env },
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe']
        })
        const exit = new Promise<void>(resolveExit => child.once('close', () => resolveExit()))
        const stop = this.trackProcess(child, exit)
        child.stdin.on('error', () => undefined)
        const stdout: CapturedOutput = { text: '', bytes: 0, truncated: false }
        const stderr: CapturedOutput = { text: '', bytes: 0, truncated: false }
        let settled = false
        let interrupted: 'cancelled' | 'timeout' | undefined
        const onAbort = (): void => {
          interrupted = 'cancelled'
          void stop().catch(() => finish(() => rejectExec(new SandboxError('Local sandbox process cleanup failed.', { reason: 'cleanup_failed' }))))
        }
        const timer = setTimeout(() => {
          interrupted = 'timeout'
          void stop('SIGKILL').catch(() => finish(() => rejectExec(new SandboxError('Local sandbox process cleanup failed.', { reason: 'cleanup_failed' }))))
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
        child.on('error', () => {
          finish(() => rejectExec(new SandboxError('Local sandbox exec failed.', { reason: 'exec_failed' })))
        })
        child.on('close', (exitCode, exitSignal) => {
          finish(() => {
            if (interrupted === 'cancelled') { rejectExec(abortError(signal as AbortSignal, 'sandbox', 'Sandbox exec was cancelled.')); return }
            if (interrupted === 'timeout') { rejectExec(new OperationTimeoutError('Sandbox exec timed out.', { scope: 'sandbox_run', timeout_ms: timeoutMs })); return }
            if (exitCode === null) {
              rejectExec(new SandboxError('Local sandbox exec was terminated.', { reason: 'exec_failed' }))
              return
            }
            resolveExec({ stdout: stdout.text, stderr: stderr.text, exitCode, durationSeconds: (Date.now() - started) / 1000 })
          })
        })
        if (opts.stdin) child.stdin.end(opts.stdin)
        else child.stdin.end()
        if (signal?.aborted) onAbort()
      })
    })
  }

  public async close(): Promise<void> {
    if (this.cleanupComplete) return
    this.closed = true
    this.closePromise ??= this.stopProcesses().then(() => {
      this.cleanupComplete = true
      this.unregister()
    }).finally(() => { this.closePromise = undefined })
    await this.closePromise
  }

  private async stopProcesses(): Promise<void> {
    const results = await Promise.allSettled([...this.processStops].map(stop => stop()))
    if (results.some(result => result.status === 'rejected')) throw new SandboxError('Local sandbox process cleanup failed.', { reason: 'cleanup_failed' })
  }

  private trackProcess(child: ChildProcessWithoutNullStreams, exit: Promise<unknown>): (signal?: 'SIGTERM' | 'SIGKILL') => Promise<void> {
    let exited = false
    let stopping: Promise<void> | undefined
    const wait = async (milliseconds: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([exit.then(() => true), new Promise<boolean>(resolveWait => { timer = setTimeout(() => resolveWait(false), milliseconds) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
    const send = (signal: 'SIGTERM' | 'SIGKILL'): void => {
      if (exited || !child.pid) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new SandboxError('Local sandbox process cleanup failed.', { reason: 'cleanup_failed' })
      }
    }
    const stop = (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> => {
      if (stopping) return stopping
      stopping = (async () => {
        send(signal)
        if (await wait(signal === 'SIGKILL' ? 1000 : 100)) return
        send('SIGKILL')
        if (!await wait(1000)) throw new SandboxError('Local sandbox process did not stop.', { reason: 'cleanup_failed' })
      })().catch(error => { stopping = undefined; throw error })
      return stopping
    }
    this.processStops.add(stop)
    void exit.then(() => { exited = true; this.processStops.delete(stop) })
    return stop
  }

  private async collect(root: string, virtualRoot: string, recursive: boolean, out: DirEntry[]): Promise<void> {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const physical = join(root, entry.name)
      const virtual = posix.join(virtualRoot, entry.name)
      const info = await lstat(physical)
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
        await this.assertActive()
        this.requireUsable()
        const result = await this.state.use(this.attachment, async () => {
          await this.assertActive()
          this.requireUsable()
          return await fn()
        }, operation !== 'exec' && operation !== 'spawn')
        await this.assertActive()
        this.telemetry?.recordCounter('harness.local_sandbox.operations', 1, spanAttrs)
        return result
      } catch (error) {
        if (error instanceof HarnessError) throw error
        throw new SandboxError('Local sandbox operation failed.', { reason: 'fs_failed' })
      } finally {
        this.telemetry?.recordHistogram('harness.local_sandbox.operation.duration', (Date.now() - started) / 1000, spanAttrs)
      }
    }
    return this.telemetry ? this.telemetry.span(`harness.local_sandbox.${operation}`, spanAttrs, run) : run()
  }

  private requireUsable(): void {
    if (this.terminated) {
      throw new SandboxStateLostError('Local sandbox lifecycle state is missing.', {
        reason: 'lifecycle_state_missing', lifetime: this.attachment.scope.lifetime, adapter_id: 'local_directory'
      })
    }
    if (this.closed) throw new SandboxError('Local sandbox attachment is closed.', { reason: 'session_closed' })
  }
}

class FilesOnlyLocalSandboxSession extends LocalDirectorySandboxSession {
  declare public readonly executor: 'unavailable'

  public constructor(state: LocalSandboxState, attachment: LocalSandboxAttachment, telemetry: TelemetryShim | undefined, assertActive?: () => void | Promise<void>) {
    super(state, attachment, false, telemetry, undefined, assertActive)
  }
}

class ExecLocalSandboxSession extends LocalDirectorySandboxSession implements ExecCapableSandboxSession, SpawnCapableSandboxSession {
  declare public readonly executor: 'available'

  public constructor(state: LocalSandboxState, attachment: LocalSandboxAttachment, execPolicy: LocalHostExecPolicy, telemetry: TelemetryShim | undefined, fallbackExecTimeoutMs: number | undefined, assertActive?: () => void | Promise<void>) {
    super(state, attachment, execPolicy, telemetry, fallbackExecTimeoutMs, assertActive)
  }
}

abstract class BaseLocalDirectorySandbox {
  public readonly telemetryAdapterId = 'local_directory_sandbox'
  protected telemetry: TelemetryShim | undefined
  protected toolTimeoutMs: number | undefined
  protected readonly state: LocalSandboxState
  private readonly catalog: SandboxAdapterCatalog

  protected constructor(protected readonly options: LocalDirectorySandboxOptions, private readonly execEnabled: boolean) {
    this.state = new LocalSandboxState(options.root)
    this.catalog = new SandboxAdapterCatalog(new LocalSandboxCatalog({
      root: options.root,
      ...(options.administration ? { administration: options.administration } : {}),
      callbacks: {
        deleteResource: async (resource: SandboxResourceSummary, signal?: AbortSignal) => {
          if (resource.kind === 'sandbox' && resource.scope) {
            await this.state.terminate({ scope: resource.scope, reason: 'manual', ...(signal ? { signal } : {}) })
          }
        }
      }
    }))
  }

  public get administration(): SandboxAdministration { return this.catalog.administration }

  public async registerOwner(options: SandboxOwnerRegistrationOptions): Promise<void> {
    await this.catalog.registerOwner(options)
  }

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.telemetry = context.telemetry
    this.catalog.configureHarnessContext(context, 'local_directory_sandbox')
    // Spec 22 §2: exec timeout falls back to the configured harness toolTimeoutMs.
    this.toolTimeoutMs = context.defaults.toolTimeoutMs
  }

  protected async openRoot<T extends SandboxSessionBase>(options: SandboxOpenOptions, make: (attachment: LocalSandboxAttachment, assertActive: () => void | Promise<void>) => T): Promise<{ session: T; disposition: 'created' | 'attached' | 'restored' | 'resumed'; liveProcessState: 'not_preserved' }> {
    const { scope } = options
    const aggregate = this.options.coordinator?.get(scope)
    if (scope.lifetime === 'run' && this.options.coordinator && !aggregate) {
      throw new SandboxStateLostError('Local sandbox has no compatible active workspace binding.', {
        reason: 'durable_workspace_recovery_unavailable', lifetime: 'run', adapter_id: 'local_directory'
      })
    }
    if (aggregate) {
      try {
        const activePath = await stat(aggregate.activePath)
        if (!activePath.isDirectory()) throw new Error('Invalid workspace directory')
      } catch {
        throw new SandboxStateLostError('Local sandbox has no compatible active workspace binding.', {
          reason: 'durable_workspace_recovery_unavailable', lifetime: 'run', adapter_id: 'local_directory'
        })
      }
    }
    const active = aggregate
      ? {
          ...aggregate,
          activePath: join(aggregate.activePath, 'partitions', sha256Hex(sandboxScopeKey(scope))),
          ownerPath: join(dirname(aggregate.activePath), 'sandbox-owner')
        }
      : undefined
    const spanAttrs: SpanAttrs = {
      'harness.sandbox.adapter': 'local_directory_sandbox',
      'harness.sandbox.operation': 'open',
      'harness.sandbox.exec_enabled': this.execEnabled,
      'harness.sandbox.lifetime': scope.lifetime
    }
    const started = Date.now()
    const run = async () => {
      let attachmentAssertActive: () => void | Promise<void> = () => undefined
      const opened = await this.catalog.open(options, async () => {
        const state = await this.state.open(options, active)
        return { session: make(state.attachment, () => attachmentAssertActive()), disposition: state.disposition, assertActive: () => undefined }
      })
      attachmentAssertActive = opened.assertActive
      this.telemetry?.recordCounter('harness.local_sandbox.operations', 1, spanAttrs)
      this.telemetry?.recordHistogram('harness.local_sandbox.operation.duration', (Date.now() - started) / 1000, spanAttrs)
      return {
        session: opened.session,
        disposition: opened.disposition,
        liveProcessState: 'not_preserved' as const
      }
    }
    return this.telemetry ? this.telemetry.span('harness.local_sandbox.open', spanAttrs, async () => run()) : run()
  }

  protected async terminateScope(options: SandboxTerminateOptions): Promise<void> {
    await this.catalog.terminate(options, async () => await this.state.terminate(options))
  }
}

class FilesOnlyLocalDirectorySandbox extends BaseLocalDirectorySandbox implements Sandbox<LocalFilesOnlySandboxCapabilities> {
  public readonly capabilities: LocalFilesOnlySandboxCapabilities

  public constructor(options: LocalDirectorySandboxOptions) {
    super(options, false)
    this.capabilities = options.coordinator ? ['sandbox.fs', 'sandbox.persistent_fs', 'sandbox.workspace_binding'] : ['sandbox.fs', 'sandbox.persistent_fs']
  }

  public async open(options: SandboxOpenOptions): Promise<SandboxOpenResult<LocalFilesOnlySandboxCapabilities>> {
    return await this.openRoot(options, (attachment, assertActive) => new FilesOnlyLocalSandboxSession(this.state, attachment, this.telemetry, assertActive))
  }

  public async terminate(options: SandboxTerminateOptions): Promise<void> {
    await this.terminateScope(options)
  }
}

class ExecLocalDirectorySandbox extends BaseLocalDirectorySandbox implements Sandbox<LocalExecSandboxCapabilities> {
  public readonly capabilities: LocalExecSandboxCapabilities

  public constructor(options: LocalDirectorySandboxOptions, private readonly execPolicy: LocalHostExecPolicy) {
    super(options, true)
    this.capabilities = options.coordinator ? ['sandbox.fs', 'sandbox.exec', 'sandbox.spawn', 'sandbox.persistent_fs', 'sandbox.workspace_binding'] : ['sandbox.fs', 'sandbox.exec', 'sandbox.spawn', 'sandbox.persistent_fs']
  }

  public async open(options: SandboxOpenOptions): Promise<SandboxOpenResult<LocalExecSandboxCapabilities>> {
    return await this.openRoot(options, (attachment, assertActive) => new ExecLocalSandboxSession(this.state, attachment, this.execPolicy, this.telemetry, this.toolTimeoutMs, assertActive))
  }

  public async terminate(options: SandboxTerminateOptions): Promise<void> {
    await this.terminateScope(options)
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

export function localDirectorySandbox(options: LocalDirectorySandboxOptions & { exec: LocalHostExecPolicy }): Sandbox<LocalExecSandboxCapabilities>
export function localDirectorySandbox(options: LocalDirectorySandboxOptions & { exec?: false }): Sandbox<LocalFilesOnlySandboxCapabilities>
export function localDirectorySandbox(options: LocalDirectorySandboxOptions): LocalDurableSandbox
export function localDirectorySandbox(options: LocalDirectorySandboxOptions): LocalDurableSandbox {
  const exec = options.exec ?? false
  return exec === false ? new FilesOnlyLocalDirectorySandbox(options) : new ExecLocalDirectorySandbox(options, exec)
}
