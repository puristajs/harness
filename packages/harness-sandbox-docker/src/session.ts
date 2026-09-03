import { StringDecoder } from 'node:string_decoder'
import { HarnessError, SANDBOX_TEXT_SEARCH_LIMITS, validateSandboxTextSearchRequest, type DirEntry, type ExecOptions, type ExecResult, type FileStat, type HarnessIdentity, type SandboxProcess, type SandboxTextSearchLimitReason, type SandboxTextSearchMatch, type SandboxTextSearchRequest, type SandboxTextSearchResult, type SpawnCapableSandboxSession, type SpawnOptions, type TextSearchCapableSandboxSession } from '@purista/harness'
import type { DockerSandbox } from './lifecycle.js'
import { failure } from './options.js'
import { stateLost, type LifecycleRecord, type Ownership } from './records.js'
import { checkCancelled, collect, OUTPUT_LIMIT_BYTES, type DockerChild, type DockerResult } from './transport.js'

const ROOT = '/workspace'
const CHECK_PATH = 'target=$(realpath -m -- "$1"); shift; '

export class DockerSandboxSession implements SpawnCapableSandboxSession, TextSearchCapableSandboxSession {
  public readonly executor = 'available' as const
  private closing = false
  private closed = false
  private terminated = false
  private cleanupFailure: unknown
  private closePromise: Promise<void> | undefined
  private readonly operations = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private readonly processes = new Set<DockerChild>()
  private stopping: Promise<void> | undefined

  public constructor(
    private readonly adapter: DockerSandbox,
    private readonly record: LifecycleRecord,
    private readonly ownership: Ownership,
    private readonly identity: HarnessIdentity | undefined,
  ) {}

  public async read(path: string): Promise<Uint8Array> {
    const output = await this.fs(path, 'base64 < "$target"')
    return Buffer.from(output.stdout, 'base64')
  }
  public async readText(path: string): Promise<string> { return new TextDecoder().decode(await this.read(path)) }
  public async write(path: string, data: Uint8Array | string): Promise<void> {
    const encoded = Buffer.from(data).toString('base64')
    await this.fs(path, 'mkdir -p -- "$(dirname -- "$target")"; base64 -d > "$target"', { stdin: encoded })
  }
  public async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (guestPath(path) === ROOT || guestPath(path) === '/') throw failure('invalid_path', 'The sandbox filesystem and workspace roots cannot be removed.')
    await this.fs(path, options?.recursive ? 'rm -rf -- "$target"' : 'rm -f -- "$target"')
  }
  public async exists(path: string): Promise<boolean> {
    const result = await this.fs(path, 'if test -e "$target"; then printf present; else printf absent; fi')
    if (result.stdout !== 'present' && result.stdout !== 'absent') throw failure('provider_response_invalid')
    return result.stdout === 'present'
  }
  public async list(path: string, options?: { recursive?: boolean; glob?: string }): Promise<DirEntry[]> {
    const output = await this.fs(path, `find "$target" ${options?.recursive ? '' : '-maxdepth 1'} -mindepth 1 \\( -type f -o -type d \\) -printf '%y\\0%p\\0%s\\0'`)
    const values = output.stdout.split('\0')
    values.pop()
    if (values.length % 3 !== 0) throw failure('provider_response_invalid')
    const entries: DirEntry[] = []
    for (let index = 0; index < values.length; index += 3) {
      const [kind, physical, size] = values.slice(index, index + 3)
      if (!physical?.startsWith('/') || (kind !== 'f' && kind !== 'd') || !Number.isSafeInteger(Number(size))) throw failure('provider_response_invalid')
      const path = physical
      entries.push({ name: path.split('/').at(-1)!, path, kind: kind === 'd' ? 'directory' : 'file', ...(kind === 'f' ? { size: Number(size) } : {}) })
    }
    const pattern = options?.glob ? glob(options.glob) : undefined
    return entries.filter(entry => !pattern || pattern.test(entry.path)).sort((left, right) => left.path.localeCompare(right.path))
  }
  public async stat(path: string): Promise<FileStat> {
    const output = await this.fs(path, 'if test -d "$target"; then printf directory; elif test -f "$target"; then printf file; else exit 1; fi; stat --printf "\\0%s\\0%Y" -- "$target"')
    const [kind, size, modified] = output.stdout.split('\0')
    if ((kind !== 'file' && kind !== 'directory') || !Number.isSafeInteger(Number(size)) || !Number.isFinite(Number(modified))) throw failure('provider_response_invalid')
    const timestamp = new Date(Number(modified) * 1000)
    if (Number.isNaN(timestamp.getTime())) throw failure('provider_response_invalid')
    return { kind, size: Number(size), modifiedAt: timestamp.toISOString() }
  }
  public async mount(files: ReadonlyMap<string, Uint8Array | string>, atPath: string): Promise<void> {
    guestPath(atPath)
    for (const [path, data] of files) {
      if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) throw failure('invalid_path')
      await this.write(`${atPath.replace(/\/$/, '')}/${path}`, data)
    }
  }
  public async searchText(request: SandboxTextSearchRequest): Promise<SandboxTextSearchResult> {
    validateSandboxTextSearchRequest(request)
    checkCancelled(request.signal)
    const entries = (await this.list(request.path, { recursive: true }))
      .filter((entry): entry is DirEntry & { kind: 'file' } => entry.kind === 'file')
      .sort((left, right) => left.path.localeCompare(right.path))
    const matches: SandboxTextSearchMatch[] = []
    const reasons = new Set<SandboxTextSearchLimitReason>()
    let scannedFiles = 0
    let scannedBytes = 0
    if (entries.length > SANDBOX_TEXT_SEARCH_LIMITS.maxFiles) reasons.add('file_count_limit')

    for (const entry of entries.slice(0, SANDBOX_TEXT_SEARCH_LIMITS.maxFiles)) {
      checkCancelled(request.signal)
      if (entry.size === undefined || entry.size > SANDBOX_TEXT_SEARCH_LIMITS.maxFileBytes) {
        reasons.add('file_byte_limit')
        continue
      }
      if (scannedBytes + entry.size > SANDBOX_TEXT_SEARCH_LIMITS.maxScannedBytes) {
        reasons.add('scan_byte_limit')
        break
      }
      scannedFiles += 1
      scannedBytes += entry.size
      const remaining = request.maxResults - matches.length
      const flags = ['-n', '-a', request.syntax === 'literal' ? '-F' : '-E', '-m', String(remaining)]
      if (!request.caseSensitive) flags.push('-i')
      const output = await this.execute(
        ['grep', ...flags, '--', request.pattern, guestPath(entry.path)],
        { ...(request.signal ? { signal: request.signal } : {}), env: { LC_ALL: 'C' } },
      )
      if (output.exitCode !== 0 && output.exitCode !== 1) throw failure('text_search_failed', 'Docker sandbox text search failed.')
      for (const line of output.stdout.split('\n')) {
        if (!line) continue
        const separator = line.indexOf(':')
        if (separator <= 0) throw failure('provider_response_invalid')
        const lineNumber = Number(line.slice(0, separator))
        if (!Number.isSafeInteger(lineNumber) || lineNumber <= 0) throw failure('provider_response_invalid')
        const excerpt = truncateUtf8(line.slice(separator + 1), SANDBOX_TEXT_SEARCH_LIMITS.maxReturnedLineBytes)
        if (excerpt.truncated) reasons.add('line_byte_limit')
        matches.push({ path: entry.path, line: lineNumber, text: excerpt.text, textTruncated: excerpt.truncated })
      }
      if (matches.length >= request.maxResults) {
        reasons.add('result_limit')
        break
      }
    }
    const limitReasons = [...reasons].sort()
    return { matches, complete: limitReasons.length === 0, limitReasons, scannedFiles, scannedBytes }
  }
  public async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    validateCommand(command)
    const started = Date.now()
    const output = await this.execute(['sh', '-c', command], options)
    return { ...output, durationSeconds: (Date.now() - started) / 1000 }
  }
  private async fs(path: string, script: string, options?: ExecOptions): Promise<DockerResult> {
    const result = await this.execute(['sh', '-ceu', CHECK_PATH + script, '--', guestPath(path)], options)
    if (result.exitCode !== 0) throw failure(result.exitCode === 64 ? 'invalid_path' : 'fs_failed', 'Docker sandbox filesystem operation failed.')
    return result
  }
  private async execute(command: readonly string[], options?: ExecOptions): Promise<DockerResult> {
    checkCancelled(options?.signal)
    if (options?.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw failure('invalid_timeout')
    const controller = new AbortController()
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
    this.controllers.add(controller)
    const operation = (async () => {
      await this.requireUsable()
      checkCancelled(signal)
      const child = await this.adapter.startGuest(this.record, guardedCommand(command, options?.cwd), options?.env ? { env: options.env } : {})
      return await collect(child, { signal, stdin: options?.stdin, timeoutMs: options?.timeoutMs ?? this.adapter.timeoutMs, cleanup: async () => await this.stopGuest() })
    })()
    this.operations.add(operation)
    try { return await operation } finally { this.operations.delete(operation); this.controllers.delete(controller) }
  }
  public async spawn(command: string, options?: SpawnOptions): Promise<SandboxProcess> {
    validateCommand(command)
    if (options?.args?.some(argument => typeof argument !== 'string' || argument.includes('\0'))) throw failure('invalid_command')
    checkCancelled(options?.signal)
    const opening = (async () => {
      await this.requireUsable()
      checkCancelled(options?.signal)
      const child = await this.adapter.startGuest(this.record, guardedCommand([command, ...(options?.args ?? [])], options?.cwd), options?.env ? { env: options.env } : {})
      this.processes.add(child)
      const kill = async (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> => {
        if (!this.processes.has(child)) return
        if (signal !== 'SIGTERM' && signal !== 'SIGKILL') throw failure('invalid_signal')
        await this.stopGuest(signal)
        child.kill()
        await child.exit
      }
      const abort = () => { void kill().catch(error => { this.cleanupFailure = error; child.kill() }) }
      options?.signal?.addEventListener('abort', abort, { once: true })
      if (options?.signal?.aborted || this.closing) await kill()
      void child.exit.then(() => { options?.signal?.removeEventListener('abort', abort); this.processes.delete(child) })
      const decode = async function* (stream: AsyncIterable<Uint8Array>): AsyncIterable<string> {
        const decoder = new StringDecoder('utf8')
        let bytes = 0
        try {
          for await (const chunk of stream) {
            bytes += chunk.byteLength
            if (bytes > OUTPUT_LIMIT_BYTES) {
              await kill()
              throw failure('output_limit_exceeded', 'Docker sandbox output exceeded the 10 MiB per-stream limit.')
            }
            const text = decoder.write(Buffer.from(chunk))
            if (text) yield text
          }
          const remaining = decoder.end()
          if (remaining) yield remaining
        } catch (error) {
          await kill()
          throw error instanceof HarnessError ? error : failure('provider_transport_failed')
        }
      }
      return {
        writeStdin: async (chunk: string) => { await this.requireUsable(); if (!this.processes.has(child)) throw failure('process_stdin_closed'); await child.write(chunk) },
        stdout: decode(child.stdout), stderr: decode(child.stderr), exit: child.exit, kill,
      }
    })()
    this.operations.add(opening)
    try { return await opening } finally { this.operations.delete(opening) }
  }
  public async close(): Promise<void> {
    if (this.terminated) return
    if (this.closed) return
    if (this.closePromise) return await this.closePromise
    this.closing = true
    for (const controller of this.controllers) controller.abort()
    this.closePromise = (async () => {
      await Promise.allSettled([...this.operations])
      if (this.processes.size > 0) await this.stopGuest()
      await this.adapter.detached(this.record, this.ownership, this)
      for (const child of this.processes) child.kill()
      this.processes.clear()
      this.closed = true
    })()
    try { await this.closePromise } finally { this.closePromise = undefined }
  }
  private async requireUsable(): Promise<void> {
    if (this.terminated) throw stateLost(this.record.lifetime, 'lifecycle_state_missing')
    if (this.cleanupFailure) throw this.cleanupFailure
    if (this.closing || this.closed) throw failure('session_closed', 'Docker sandbox attachment is closed.')
    await this.adapter.assertActive(this.record, this.ownership, this.identity)
    if (this.terminated) throw stateLost(this.record.lifetime, 'lifecycle_state_missing')
    if (this.closing) throw failure('session_closed')
  }
  public async invalidate(): Promise<void> {
    this.terminated = true
    this.closing = true
    for (const controller of this.controllers) controller.abort()
    await Promise.allSettled([...this.operations])
    for (const child of this.processes) child.kill()
  }
  private async stopGuest(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> {
    this.stopping ??= this.adapter.stopRetained(this.record, signal).finally(() => { this.stopping = undefined })
    await this.stopping
  }
}

function guestPath(input: string): string {
  if (typeof input !== 'string' || !input.startsWith('/') || input.includes('\0') || input.includes('\\') || input.split('/').includes('..')) throw failure('invalid_path', 'Sandbox paths must be absolute guest paths without traversal.')
  return input.replace(/\/+/g, '/')
}
function guardedCommand(command: readonly string[], cwd = '/workspace'): string[] {
  return ['sh', '-ceu', CHECK_PATH + 'cd -- "$target"; exec "$@"', '--', guestPath(cwd), ...command]
}
function validateCommand(command: string): void { if (typeof command !== 'string' || !command.trim() || command.includes('\0')) throw failure('invalid_command') }
function glob(pattern: string): RegExp { return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`) }
function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(value)
  if (encoded.byteLength <= maxBytes) return { text: value, truncated: false }
  let end = maxBytes
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
  return { text: encoded.subarray(0, end).toString('utf8'), truncated: true }
}
