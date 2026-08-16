import { McpProtocolError, OperationTimeoutError, SandboxNoExecutorError } from '../../errors/index.js'
import { isSpawnCapableSession, type SandboxProcess, type SpawnCapableSandboxSession } from '../../sandbox/index.js'
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
  let connected: Promise<{ client: SdkClient; transport: SandboxStdioTransport; cleanup?: () => Promise<void> }> | undefined

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

  async function connect(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ client: SdkClient; transport: SandboxStdioTransport; cleanup?: () => Promise<void> }> {
    if (connected) {
      const current = await connected.catch(() => undefined)
      if (current && !current.transport.isClosed) return current
      connected = undefined
    }
    if (!connected) {
      const promise = (async () => {
        await ensureInstalled(options?.signal)
        const prepared = await config.prepareLaunch?.({ sandbox: session, ...(options?.signal ? { signal: options.signal } : {}) })
        const launch = prepared ? { ...config, ...prepared, env: { ...(config.env ?? {}), ...(prepared.env ?? {}) } } : config
        const transport = new SandboxStdioTransport(launch, session, hooks)
        try {
          const { Client } = await import('@modelcontextprotocol/client')
          const client = new Client(
            { name: `purista-harness-${config.localToolId}`, version: '0.0.0' },
            { versionNegotiation: { mode: { pin: '2026-07-28' } } }
          ) as SdkClient
          await client.connect(transport as never, toSdkOptions(options))
          return { client, transport, ...(prepared?.cleanup ? { cleanup: prepared.cleanup } : {}) }
        } catch (error) {
          await transport.close().catch(() => undefined)
          await prepared?.cleanup?.().catch(() => undefined)
          throw mapStdioError(config, 'connect', error)
        }
      })()
      void promise.catch(() => {
        if (connected === promise) connected = undefined
      })
      connected = promise
    }
    return connected
  }

  return {
    async listTools(options) {
      try {
        const active = await connect(options)
        return (await Promise.race([active.client.listTools(undefined, toSdkOptions(options)), active.transport.waitForClose()])).tools
      } catch (error) {
        if (error instanceof McpProtocolError || error instanceof SandboxNoExecutorError) throw error
        throw mapStdioError(config, 'list', error)
      }
    },
    async callTool(name, input, options) {
      try {
        const active = await connect(options)
        return await withMcpTimeout(
          { ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: options?.timeoutMs ?? config.timeoutMs, scope: 'tool' },
          (signal) => Promise.race([active.client.callTool({ name, arguments: input }, toSdkOptions({ ...(signal ? { signal } : {}) })), active.transport.waitForClose()])
        )
      } catch (error) {
        if (error instanceof McpProtocolError || error instanceof SandboxNoExecutorError || error instanceof OperationTimeoutError) throw error
        throw mapStdioError(config, 'call', error)
      }
    },
    async close() {
      const current = await connected?.catch(() => undefined)
      connected = undefined
      installPromise = undefined
      if (!current) return
      await Promise.allSettled([current.client.close(), current.transport.close(), ...(current.cleanup ? [current.cleanup()] : [])])
    }
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

  waitForClose(): Promise<never> {
    return new Promise((_, reject: (error: Error) => void) => this.closeWaiters.add(reject))
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
  if (config.sandbox.executor !== 'available') {
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

function toSdkOptions(options?: { signal?: AbortSignal }): { signal?: AbortSignal } | undefined {
  if (!options) return undefined
  return options.signal ? { signal: options.signal } : undefined
}


function mapStdioError(config: ResolvedMcpStdioTool, phase: 'connect' | 'list' | 'call', error: unknown): McpProtocolError {
  return new McpProtocolError('MCP stdio protocol failure.', { tool_id: config.localToolId, transport: 'stdio', phase }, error)
}
