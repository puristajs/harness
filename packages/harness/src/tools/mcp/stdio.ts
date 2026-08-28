import { McpProtocolError, OperationTimeoutError, SandboxNoExecutorError } from '../../errors/index.js'
import { isExecCapableSession, isSpawnCapableSession, type SandboxProcess, type SpawnCapableSandboxSession } from '../../sandbox/index.js'
import type { McpDiscoveredTool, McpTransportRunner, ResolvedMcpStdioTool } from './runner.js'
import { withMcpTimeout } from './runner.js'

const STDERR_TAIL_LIMIT = 8_192
const DEFAULT_CLOSE_GRACE_MS = 2_000

export interface StdioRunnerHooks {
  onReset?: () => void
  closeGraceMs?: number
}

type SdkClient = {
  connect(transport: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<void>
  listTools(params?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ tools: McpDiscoveredTool[] }>
  callTool(params: { name: string; arguments?: unknown }, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>
  close(): Promise<void>
}

/**
 * Creates a current-MCP stdio runner.
 *
 * Stdio requires a spawn-capable sandbox. The old one-shot JSON-RPC exchange
 * was intentionally removed: it cannot model a modern MCP lifecycle or server
 * state correctly.
 */
export function createStdioMcpTransportRunner(config: ResolvedMcpStdioTool, hooks: StdioRunnerHooks = {}): McpTransportRunner {
  if (!isSpawnCapableSession(config.sandbox)) return unavailableRunner()
  return createPersistentStdioRunner(config, config.sandbox, hooks)
}

function unavailableRunner(): McpTransportRunner {
  const fail = () => Promise.reject(new SandboxNoExecutorError('MCP stdio requires a spawn-capable sandbox executor.', { session_id: 'unknown' }))
  return { listTools: fail, callTool: fail, close: async () => undefined }
}

function createPersistentStdioRunner(config: ResolvedMcpStdioTool, session: SpawnCapableSandboxSession, hooks: StdioRunnerHooks): McpTransportRunner {
  let installPromise: Promise<void> | undefined
  let connected: Promise<StdioConnection> | undefined

  async function ensureInstalled(signal?: AbortSignal): Promise<void> {
    if (!config.install) return
    if (!installPromise) {
      const promise = runInstall(config, signal)
      void promise.catch(() => {
        if (installPromise === promise) installPromise = undefined
      })
      installPromise = promise
    }
    await installPromise
  }

  async function connect(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<StdioConnection> {
    if (connected) {
      const current = await connected.catch(() => undefined)
      if (current && !current.transport.isClosed) return current
      if (current) await finalizeConnection(current)
      connected = undefined
    }
    if (!connected) {
      const promise = openConnection(options)
      void promise.catch(() => {
        if (connected === promise) connected = undefined
      })
      connected = promise
    }
    return connected
  }

  async function openConnection(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<StdioConnection> {
    let client: SdkClient | undefined
    let transport: SandboxStdioTransport | undefined
    let cleanup: (() => Promise<void>) | undefined
    try {
      return await withMcpTimeout(
        { ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: options?.timeoutMs ?? config.timeoutMs, scope: 'tool' },
        async (signal) => {
          await ensureInstalled(signal)
          const prepared = await config.prepareLaunch?.({ sandbox: session, ...(signal ? { signal } : {}) })
          cleanup = prepared?.cleanup
          const launch = prepared ? { ...config, ...prepared, env: { ...(config.env ?? {}), ...(prepared.env ?? {}) } } : config
          transport = new SandboxStdioTransport(launch, session, hooks)
          const { Client } = await import('@modelcontextprotocol/client')
          client = new Client(
            { name: `purista-harness-${config.localToolId}`, version: '0.0.0' },
            { versionNegotiation: { mode: { pin: '2026-07-28' } } }
          ) as SdkClient
          await client.connect(transport as never, toSdkOptions(signal ? { signal } : undefined))
          return { client, transport, ...(cleanup ? { cleanup } : {}) }
        }
      )
    } catch (error) {
      const finalization = await closeConnectionParts(client, transport, cleanup)
      const primary = error instanceof OperationTimeoutError ? error : mapStdioError(config, 'connect', error)
      if (finalization.cleanupFailure !== undefined) {
        throw new AggregateError([primary, ...finalization.failures], 'MCP stdio connection failed and its staged resources could not be finalized.')
      }
      throw primary
    }
  }

  async function resetConnection(current: StdioConnection, error: unknown): Promise<never> {
    if (connected) {
      const active = await connected.catch(() => undefined)
      if (active === current) connected = undefined
    }
    try {
      await finalizeConnection(current)
    } catch (finalizeError) {
      if (current.cleanupFailure === undefined) throw error
      throw new AggregateError([error, finalizeError], 'MCP stdio operation failed and its staged resources could not be finalized.')
    }
    throw error
  }

  return {
    async listTools(options) {
      try {
        const active = await connect(options)
        return (await withMcpTimeout(
          { ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: options?.timeoutMs ?? config.timeoutMs, scope: 'tool' },
          (signal) => raceTransportClose(active.transport, () => active.client.listTools(undefined, toSdkOptions(signal ? { signal } : undefined)))
        )).tools
      } catch (error) {
        if (error instanceof OperationTimeoutError) {
          const current = await connected?.catch(() => undefined)
          if (current) return resetConnection(current, error)
          throw error
        }
        if (error instanceof McpProtocolError || error instanceof SandboxNoExecutorError) throw error
        throw mapStdioError(config, 'list', error)
      }
    },
    async callTool(name, input, options) {
      try {
        const active = await connect(options)
        return await withMcpTimeout(
          { ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: options?.timeoutMs ?? config.timeoutMs, scope: 'tool' },
          (signal) => raceTransportClose(active.transport, () => active.client.callTool({ name, arguments: input }, toSdkOptions(signal ? { signal } : undefined)))
        )
      } catch (error) {
        if (error instanceof OperationTimeoutError) {
          const current = await connected?.catch(() => undefined)
          if (current) return resetConnection(current, error)
          throw error
        }
        if (error instanceof McpProtocolError || error instanceof SandboxNoExecutorError) throw error
        throw mapStdioError(config, 'call', error)
      }
    },
    async close() {
      const current = await connected?.catch(() => undefined)
      connected = undefined
      installPromise = undefined
      if (!current) return
      await finalizeConnection(current)
    }
  }
}

interface StdioConnection {
  client: SdkClient
  transport: SandboxStdioTransport
  cleanup?: () => Promise<void>
  finalization?: Promise<void>
  cleanupFailure?: unknown
}

async function finalizeConnection(connection: StdioConnection): Promise<void> {
  connection.finalization ??= (async () => {
    const finalization = await closeConnectionParts(connection.client, connection.transport, connection.cleanup)
    connection.cleanupFailure = finalization.cleanupFailure
    if (finalization.failures.length > 0) throw new AggregateError(finalization.failures, 'MCP stdio resources could not be finalized.')
  })()
  return connection.finalization
}

async function closeConnectionParts(
  client: SdkClient | undefined,
  transport: SandboxStdioTransport | undefined,
  cleanup: (() => Promise<void>) | undefined
): Promise<{ failures: unknown[]; cleanupFailure?: unknown }> {
  const failures: unknown[] = []
  if (client) {
    try { await client.close() } catch (error) { failures.push(error) }
  }
  if (transport) {
    try { await transport.close() } catch (error) { failures.push(error) }
  }
  let cleanupFailure: unknown
  if (cleanup) {
    try { await cleanup() } catch (error) { cleanupFailure = error; failures.push(error) }
  }
  return { failures, ...(cleanupFailure !== undefined ? { cleanupFailure } : {}) }
}

async function raceTransportClose<T>(transport: SandboxStdioTransport, operation: () => Promise<T>): Promise<T> {
  const closed = transport.waitForClose()
  try {
    return await Promise.race([operation(), closed.promise])
  } finally {
    closed.dispose()
  }
}

/** Minimal MCP SDK transport implemented on a sandbox-owned process. */
class SandboxStdioTransport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: unknown) => void
  private process: SandboxProcess | undefined
  private stderrTail = ''
  private closed = false
  private readonly closeWaiters = new Set<(error: Error) => void>()

  get isClosed(): boolean {
    return this.closed || !this.process
  }

  constructor(
    private readonly config: ResolvedMcpStdioTool,
    private readonly session: SpawnCapableSandboxSession,
    private readonly hooks: StdioRunnerHooks
  ) {}

  async start(): Promise<void> {
    if (this.closed) throw new Error('MCP stdio transport is closed.')
    this.process = await this.session.spawn(this.config.command, {
      ...(this.config.args ? { args: this.config.args } : {}),
      ...(this.config.cwd ? { cwd: this.config.cwd } : {}),
      ...(this.config.env ? { env: this.config.env } : {})
    })
    this.consume(this.process)
  }

  async send(message: unknown): Promise<void> {
    if (!this.process) throw new Error('MCP stdio transport has not started.')
    await this.process.writeStdin(`${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const process = this.process
    this.process = undefined
    if (process) await terminateProcess(process, this.hooks.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS)
    this.notifyClosed(new Error('MCP stdio transport closed.'))
    this.hooks.onReset?.()
    this.onclose?.()
  }

  private consume(process: SandboxProcess): void {
    void (async () => {
      let buffer = ''
      try {
        for await (const chunk of process.stdout) {
          buffer += chunk
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (line) this.dispatch(line)
            newline = buffer.indexOf('\n')
          }
        }
      } catch (error) {
        this.report(error)
      }
      if (this.process === process && !this.closed) {
        this.handleUnexpectedClose(new Error('MCP server closed its stdout stream.'))
      }
    })()
    void (async () => {
      try {
        for await (const chunk of process.stderr) this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT)
      } catch (error) {
        this.report(error)
      }
    })()
    void process.exit.then((result) => {
      if (this.process !== process) return
      const suffix = this.stderrTail.trim() ? ` stderr: ${this.stderrTail.trim()}` : ''
      this.handleUnexpectedClose(new Error(`MCP server exited with code ${result.exitCode}.${suffix}`))
    })
  }

  private dispatch(line: string): void {
    try {
      const message: unknown = JSON.parse(line)
      if (typeof message === 'object' && message !== null) this.onmessage?.(message)
    } catch (error) {
      this.report(error)
    }
  }

  private report(error: unknown): void {
    this.onerror?.(error instanceof Error ? error : new Error(String(error)))
  }

  waitForClose(): { promise: Promise<never>; dispose: () => void } {
    let rejectClose!: (error: Error) => void
    const promise = new Promise<never>((_, reject: (error: Error) => void) => {
      rejectClose = reject
      this.closeWaiters.add(reject)
    })
    return {
      promise,
      dispose: () => this.closeWaiters.delete(rejectClose)
    }
  }

  private notifyClosed(error: Error): void {
    for (const reject of this.closeWaiters) reject(error)
    this.closeWaiters.clear()
  }

  private handleUnexpectedClose(error: Error): void {
    if (this.closed) return
    this.process = undefined
    this.closed = true
    this.hooks.onReset?.()
    this.notifyClosed(error)
    this.report(error)
    this.onclose?.()
  }
}

async function runInstall(config: ResolvedMcpStdioTool, signal?: AbortSignal): Promise<void> {
  if (!isExecCapableSession(config.sandbox)) {
    throw new SandboxNoExecutorError('MCP stdio install requires a sandbox executor.', { session_id: 'unknown' })
  }
  const install = config.install
  if (!install) return
  const result = await config.sandbox.exec(install.command, {
    ...(install.cwd ? { cwd: install.cwd } : {}),
    ...(install.env ? { env: install.env } : {}),
    timeoutMs: install.timeoutMs ?? config.timeoutMs,
    ...(signal ? { signal } : {})
  })
  if (result.exitCode !== 0) {
    throw mapStdioError(config, 'connect', new Error(`MCP install failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`))
  }
}

async function terminateProcess(process: SandboxProcess, graceMs: number): Promise<void> {
  await process.kill('SIGTERM').catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const exited = await Promise.race([
    process.exit.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs)
      timer.unref?.()
    })
  ])
  if (timer) clearTimeout(timer)
  if (!exited) {
    await process.kill('SIGKILL').catch(() => undefined)
    await process.exit
  }
}

function toSdkOptions(options?: { signal?: AbortSignal; timeoutMs?: number }): { signal?: AbortSignal; timeout?: number } | undefined {
  if (!options) return undefined
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs && options.timeoutMs > 0 ? { timeout: options.timeoutMs } : {})
  }
}


function mapStdioError(config: ResolvedMcpStdioTool, phase: 'connect' | 'list' | 'call', error: unknown): McpProtocolError {
  return new McpProtocolError('MCP stdio protocol failure.', { tool_id: config.localToolId, transport: 'stdio', phase }, error)
}
