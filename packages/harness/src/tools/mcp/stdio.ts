import { McpProtocolError, OperationTimeoutError, SandboxNoExecutorError } from '../../errors/index.js'
import { isSpawnCapableSession, type SandboxProcess, type SpawnCapableSandboxSession } from '../../sandbox/index.js'
import { HARNESS_VERSION } from '../../version.js'
import type { McpDiscoveredTool, McpTransportRunner, ResolvedMcpStdioTool } from './runner.js'
import { withMcpTimeout } from './runner.js'

type JsonRpcResponse = {
  id?: string | number | null
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const protocolVersion = '2025-06-18'

/** Maximum number of recent stderr characters retained to enrich failure messages. */
const STDERR_TAIL_LIMIT = 8_192
/** How long `close()` waits for a SIGTERM'd server before escalating to SIGKILL. */
const DEFAULT_CLOSE_GRACE_MS = 2_000

export interface StdioRunnerHooks {
  /** Invoked whenever the persistent server process is discarded (exit, handshake failure, close). */
  onReset?: () => void
  /** Grace period before SIGKILL escalation on close (test override). */
  closeGraceMs?: number
}

export function createStdioMcpTransportRunner(config: ResolvedMcpStdioTool, hooks: StdioRunnerHooks = {}): McpTransportRunner {
  // A spawn-capable sandbox hosts a single long-lived server multiplexed across
  // calls (server-side state is preserved); otherwise each call is a one-shot
  // exec exchange (leak-free but stateless). See spec 07.
  if (isSpawnCapableSession(config.sandbox)) {
    return createPersistentStdioRunner(config, config.sandbox, hooks)
  }
  return createOneShotStdioRunner(config)
}

function createOneShotStdioRunner(config: ResolvedMcpStdioTool): McpTransportRunner {
  let installPromise: Promise<void> | undefined

  async function ensureInstalled(signal?: AbortSignal): Promise<void> {
    if (!config.install) return
    if (!installPromise) {
      const promise = runInstall(config, signal)
      // A transient/aborted install failure must not poison later calls.
      void promise.catch(() => {
        if (installPromise === promise) installPromise = undefined
      })
      installPromise = promise
    }
    return installPromise
  }

  return {
    async listTools(options) {
      return withMcpTimeout({ ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: options?.timeoutMs ?? config.timeoutMs, scope: 'tool' }, async (signal) => {
        await ensureInstalled(signal)
        const result = await exchange(config, [{ id: 1, method: 'tools/list', params: {} }], signal, options?.timeoutMs)
        return readResult<McpDiscoveredTool[]>(result, 1, 'list', (value) => {
          if (!isRecord(value) || !Array.isArray(value['tools'])) return []
          return value['tools'] as McpDiscoveredTool[]
        })
      })
    },
    async callTool(name, input, options) {
      return withMcpTimeout({ ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: options?.timeoutMs ?? config.timeoutMs, scope: 'tool' }, async (signal) => {
        await ensureInstalled(signal)
        const result = await exchange(config, [{ id: 1, method: 'tools/call', params: { name, arguments: input } }], signal, options?.timeoutMs)
        return readResult<unknown>(result, 1, 'call', (value) => value)
      })
    },
    async close() {
      installPromise = undefined
    }
  }
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void
  reject: (error: unknown) => void
}

/**
 * Persistent stdio transport: spawns the server once, performs the MCP
 * `initialize` handshake a single time, and multiplexes every subsequent
 * request over the same pipe correlating responses by JSON-RPC id.
 */
function createPersistentStdioRunner(config: ResolvedMcpStdioTool, session: SpawnCapableSandboxSession, hooks: StdioRunnerHooks = {}): McpTransportRunner {
  let installPromise: Promise<void> | undefined
  let serverProcess: SandboxProcess | undefined
  let readyPromise: Promise<void> | undefined
  let stderrTail = ''
  let nextId = 1
  const pending = new Map<number, PendingRequest>()
  const closeGraceMs = hooks.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS

  async function ensureInstalled(signal?: AbortSignal): Promise<void> {
    if (!config.install) return
    if (!installPromise) {
      const promise = runInstall(config, signal)
      // A transient/aborted install failure must not poison later calls.
      void promise.catch(() => {
        if (installPromise === promise) installPromise = undefined
      })
      installPromise = promise
    }
    return installPromise
  }

  function rejectAllPending(error: unknown): void {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }

  function teardown(): void {
    serverProcess = undefined
    readyPromise = undefined
    hooks.onReset?.()
  }

  function stderrSuffix(): string {
    const tail = stderrTail.trim()
    return tail ? ` stderr: ${tail}` : ''
  }

  async function spawnAndInitialize(signal?: AbortSignal): Promise<void> {
    const proc = await session.spawn(config.command, {
      ...(config.args ? { args: config.args } : {}),
      ...(config.env ? { env: config.env } : {}),
      ...(signal ? { signal } : {})
    })
    serverProcess = proc
    stderrTail = ''

    // Consume stdout line-by-line, dispatching responses to pending requests.
    void (async () => {
      let buffer = ''
      try {
        for await (const chunk of proc.stdout) {
          buffer += chunk
          let newlineIndex = buffer.indexOf('\n')
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim()
            buffer = buffer.slice(newlineIndex + 1)
            if (line.startsWith('{')) dispatchLine(line, pending)
            newlineIndex = buffer.indexOf('\n')
          }
        }
      } catch {
        // stdout ended or aborted; exit handler performs cleanup.
      }
    })()

    // Drain stderr so the child never blocks on a full pipe; keep only a small
    // tail to enrich failure messages.
    void (async () => {
      try {
        for await (const chunk of proc.stderr) {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT)
        }
      } catch {
        // stderr ended or aborted; exit handler performs cleanup.
      }
    })()

    // When the process exits, fail every in-flight request and force a respawn.
    void proc.exit.then((result) => {
      rejectAllPending(mapStdioError(config, 'call', new Error(`MCP server exited with code ${result.exitCode}.${stderrSuffix()}`)))
      if (serverProcess === proc) teardown()
    })

    try {
      const initResponse = await writeMessage(proc, {
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion, capabilities: {}, clientInfo: { name: '@purista/harness', version: HARNESS_VERSION } }
      }, pending, 0, signal)
      if (initResponse.error) {
        throw mapStdioError(config, 'connect', new Error(initResponse.error.message ?? 'MCP initialize failed.'))
      }
      await proc.writeStdin(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
    } catch (error) {
      // Never leave an orphaned server behind a failed handshake.
      pending.delete(0)
      await terminateProcess(proc, closeGraceMs)
      throw error
    }
  }

  async function ensureReady(signal?: AbortSignal): Promise<SandboxProcess> {
    await ensureInstalled(signal)
    if (!readyPromise) {
      readyPromise = spawnAndInitialize(signal).catch((error) => {
        teardown()
        throw error
      })
    }
    await readyPromise
    if (!serverProcess) throw mapStdioError(config, 'connect', new Error('MCP server is not running.'))
    return serverProcess
  }

  async function request<T>(method: string, params: unknown, phase: 'list' | 'call', map: (value: unknown) => T, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
    return withMcpTimeout({ ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: options?.timeoutMs ?? config.timeoutMs, scope: 'tool' }, async (signal) => {
      const proc = await ensureReady(signal)
      const id = ++nextId
      try {
        const response = await writeMessage(proc, { jsonrpc: '2.0', id, method, params }, pending, id, signal)
        if (response.error) throw mapStdioError(config, phase, new Error(response.error.message ?? `MCP ${phase} failed.`))
        return map(response.result)
      } catch (error) {
        pending.delete(id)
        if (error instanceof OperationTimeoutError) throw error
        if (error instanceof McpProtocolError) throw error
        throw mapStdioError(config, phase, error)
      }
    })
  }

  return {
    async listTools(options) {
      return request<McpDiscoveredTool[]>('tools/list', {}, 'list', (value) => {
        if (!isRecord(value) || !Array.isArray(value['tools'])) return []
        return value['tools'] as McpDiscoveredTool[]
      }, options)
    },
    async callTool(name, input, options) {
      return request<unknown>('tools/call', { name, arguments: input }, 'call', (value) => value, options)
    },
    async close() {
      const proc = serverProcess
      teardown()
      installPromise = undefined
      rejectAllPending(mapStdioError(config, 'call', new Error('MCP runner closed.')))
      if (proc) await terminateProcess(proc, closeGraceMs)
    }
  }
}

/** SIGTERMs a server process and escalates to SIGKILL when it ignores the grace window. */
async function terminateProcess(proc: SandboxProcess, graceMs: number): Promise<void> {
  await proc.kill('SIGTERM').catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const exited = await Promise.race([
    proc.exit.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs)
      timer.unref?.()
    })
  ])
  if (timer) clearTimeout(timer)
  if (!exited) {
    await proc.kill('SIGKILL').catch(() => undefined)
    await proc.exit
  }
}

/** Sends one JSON-RPC message and (when `id` is set) awaits the correlated response. */
async function writeMessage(
  proc: SandboxProcess,
  message: { jsonrpc: '2.0'; id?: number; method: string; params: unknown },
  pending: Map<number, PendingRequest>,
  id: number,
  signal?: AbortSignal
): Promise<JsonRpcResponse> {
  const response = new Promise<JsonRpcResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    if (signal) {
      const onAbort = () => {
        pending.delete(id)
        reject(signal.reason ?? new Error('MCP request was aborted.'))
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
  try {
    await proc.writeStdin(`${JSON.stringify(message)}\n`)
  } catch (error) {
    // Drop the orphaned pending entry and mark its promise handled so a later
    // rejectAllPending/abort cannot surface an unhandled rejection.
    pending.delete(id)
    void response.catch(() => undefined)
    throw error
  }
  return response
}

function dispatchLine(line: string, pending: Map<number, PendingRequest>): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (!isRecord(parsed) || !('id' in parsed)) return
  const id = parsed['id']
  if (typeof id !== 'number') return
  const request = pending.get(id)
  if (!request) return
  pending.delete(id)
  request.resolve(parsed as JsonRpcResponse)
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

async function exchange(
  config: ResolvedMcpStdioTool,
  calls: Array<{ id: number; method: string; params: unknown }>,
  signal?: AbortSignal,
  timeoutMs?: number
): Promise<JsonRpcResponse[]> {
  if (config.sandbox.executor !== 'available') {
    throw new SandboxNoExecutorError('MCP stdio requires a sandbox executor.', { session_id: 'unknown' })
  }
  const stdin = [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: '@purista/harness', version: HARNESS_VERSION }
      }
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    ...calls.map((call) => JSON.stringify({ jsonrpc: '2.0', id: call.id, method: call.method, params: call.params }))
  ].join('\n') + '\n'

  try {
    const result = await config.sandbox.exec(commandLine(config.command, config.args), {
      stdin,
      ...(config.env ? { env: config.env } : {}),
      timeoutMs: timeoutMs ?? config.timeoutMs,
      ...(signal ? { signal } : {})
    })
    if (result.exitCode !== 0) {
      throw new Error(`MCP server exited with code ${result.exitCode}: ${result.stderr || result.stdout}`)
    }
    return parseResponses(result.stdout)
  } catch (error) {
    // Timeouts propagate unwrapped — consistent with the persistent runner.
    if (error instanceof OperationTimeoutError) throw error
    throw mapStdioError(config, calls[0]?.method === 'tools/list' ? 'list' : 'call', error)
  }
}

function readResult<T>(responses: JsonRpcResponse[], id: number, phase: 'list' | 'call', map: (value: unknown) => T): T {
  const response = responses.find((candidate) => candidate.id === id)
  if (!response) throw new Error(`MCP ${phase} response missing.`)
  if (response.error) throw new Error(response.error.message ?? `MCP ${phase} failed.`)
  return map(response.result)
}

function parseResponses(stdout: string): JsonRpcResponse[] {
  const responses: JsonRpcResponse[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    const parsed = JSON.parse(trimmed) as unknown
    if (isRecord(parsed) && ('id' in parsed || 'result' in parsed || 'error' in parsed)) responses.push(parsed as JsonRpcResponse)
  }
  return responses
}

function commandLine(command: string, args: readonly string[] | undefined): string {
  return [command, ...(args ?? [])].map(shellQuote).join(' ')
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function mapStdioError(config: ResolvedMcpStdioTool, phase: 'connect' | 'list' | 'call', error: unknown): McpProtocolError {
  return new McpProtocolError('MCP stdio protocol failure.', { tool_id: config.localToolId, transport: 'stdio', phase }, error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
