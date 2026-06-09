import { McpProtocolError, OperationTimeoutError, SandboxNoExecutorError } from '../../errors/index.js'
import { HARNESS_VERSION } from '../../version.js'
import type { McpDiscoveredTool, McpTransportRunner, ResolvedMcpStdioTool } from './runner.js'
import { withMcpTimeout } from './runner.js'

type JsonRpcResponse = {
  id?: string | number | null
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

const protocolVersion = '2025-06-18'

export function createStdioMcpTransportRunner(config: ResolvedMcpStdioTool): McpTransportRunner {
  let installPromise: Promise<void> | undefined

  async function ensureInstalled(signal?: AbortSignal): Promise<void> {
    if (!config.install) return
    installPromise ??= runInstall(config, signal)
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
    if (error instanceof OperationTimeoutError) throw mapStdioError(config, calls[0]?.method === 'tools/list' ? 'list' : 'call', error)
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
