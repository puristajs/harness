import { McpAuthError, McpProtocolError, OperationTimeoutError } from '../../errors/index.js'
import type { McpAuth } from '../../harness/defineHarness.js'
import type { ResolvedMcpHttpTool, McpDiscoveredTool, McpTransportRunner } from './runner.js'
import { withMcpTimeout } from './runner.js'

type SdkClient = {
  connect(transport: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<void>
  listTools(params?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ tools: McpDiscoveredTool[] }>
  callTool(params: { name: string; arguments?: unknown }, resultSchema?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>
  close(): Promise<void>
}

type SdkTransport = { close(): Promise<void> }

export function createHttpMcpTransportRunner(config: ResolvedMcpHttpTool): McpTransportRunner {
  let connected: Promise<{ client: SdkClient; transport: SdkTransport }> | undefined

  async function connect(options?: { signal?: AbortSignal; timeoutMs?: number }) {
    if (!connected) {
      const promise = (async () => {
        const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
          import('@modelcontextprotocol/sdk/client/index.js'),
          import('@modelcontextprotocol/sdk/client/streamableHttp.js')
        ])
        const transport = new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: buildHeaders(config.headers, config.auth) }
        })
        const client = new Client({ name: `purista-harness-${config.localToolId}`, version: '0.0.0' }) as SdkClient
        try {
          await client.connect(transport, toSdkOptions(options))
        } catch (error) {
          throw mapHttpError(config, 'connect', error)
        }
        return { client, transport }
      })()
      // Never cache a rejected connection (import or connect failure); the
      // next call must retry from scratch.
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
        const { client } = await connect(options)
        return (await client.listTools(undefined, toSdkOptions(options))).tools
      } catch (error) {
        if (error instanceof McpAuthError || error instanceof McpProtocolError) throw error
        throw mapHttpError(config, 'list', error)
      }
    },
    async callTool(name, input, options) {
      try {
        const { client } = await connect(options)
        return await withMcpTimeout({ ...(options?.signal ? { signal: options.signal } : {}), timeoutMs: options?.timeoutMs ?? config.timeoutMs, scope: 'tool' }, (signal) =>
          client.callTool({ name, arguments: input }, undefined, toSdkOptions({ ...(signal ? { signal } : {}), timeoutMs: options?.timeoutMs ?? config.timeoutMs }))
        )
      } catch (error) {
        if (error instanceof McpAuthError || error instanceof McpProtocolError) throw error
        if (error instanceof OperationTimeoutError) throw error
        throw mapHttpError(config, 'call', error)
      }
    },
    async close() {
      if (!connected) return
      const current = await connected.catch(() => undefined)
      connected = undefined
      if (!current) return
      // Client first per SDK guidance; close both even when one throws.
      await Promise.allSettled([current.client.close(), current.transport.close()])
    }
  }
}

function buildHeaders(headers: Record<string, string> | undefined, auth: McpAuth | undefined): Record<string, string> {
  const next = { ...(headers ?? {}) }
  if (!auth || auth.kind === 'none') return next
  if (auth.kind === 'bearer') next['authorization'] = `Bearer ${auth.token}`
  if (auth.kind === 'oauth2') next['authorization'] = `Bearer ${auth.accessToken}`
  if (auth.kind === 'api_key') next[auth.header] = auth.value
  if (auth.kind === 'basic') next['authorization'] = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`
  return next
}

function toSdkOptions(options?: { signal?: AbortSignal; timeoutMs?: number }): { signal?: AbortSignal; timeout?: number } | undefined {
  if (!options) return undefined
  return {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {})
  }
}

function mapHttpError(config: ResolvedMcpHttpTool, phase: 'connect' | 'list' | 'call', error: unknown): McpAuthError | McpProtocolError {
  const status = statusFromError(error)
  if (status === 401 || status === 403) {
    return new McpAuthError('MCP HTTP authentication failed.', { tool_id: config.localToolId, auth_kind: config.auth?.kind ?? 'none', status }, error)
  }
  return new McpProtocolError('MCP HTTP transport failed.', { tool_id: config.localToolId, transport: 'http', phase }, error)
}

/** Exported for tests. Extracts an HTTP status from structured fields or explicit status phrasing only. */
export function statusFromError(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { status?: unknown; code?: unknown; cause?: unknown }
    if (typeof maybe.status === 'number') return maybe.status
    if (typeof maybe.code === 'number') return maybe.code
    const causeStatus = statusFromError(maybe.cause)
    if (causeStatus !== undefined) return causeStatus
  }
  if (error instanceof Error) {
    if (/unauthorized/i.test(error.message)) return 401
    // Only trust explicit "HTTP 503" / "status: 503" phrasing — a bare number
    // in a message (e.g. "took 401ms") must not classify as an HTTP status.
    const match = /HTTP (\d{3})/.exec(error.message) ?? /status[: ] ?(\d{3})/i.exec(error.message)
    if (match?.[1]) return Number(match[1])
  }
  return undefined
}
