import { afterEach, describe, expect, it } from 'vitest'
import { McpAuthError, OperationTimeoutError, ValidationError } from '../../errors/index.js'
import { startFakeHttpMcpServer, type FakeHttpMcpServer } from '../../testing/fixtures/mcp/fake-http-server.js'
import { createHttpMcpTransportRunner, statusFromError } from './http.js'
import { invokeMcpTool } from './runner.js'

const servers: FakeHttpMcpServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

function config(url: string, timeoutMs = 1_000) {
  return {
    localToolId: 'echoHttp',
    kind: 'mcp_http' as const,
    description: 'Echo through HTTP',
    upstreamToolName: 'echo',
    timeoutMs,
    serverKey: `echoHttp-${Math.random()}`,
    url
  }
}

describe('HTTP MCP runner', () => {
  it('discovers tools and invokes a fake streamable HTTP MCP server', async () => {
    const server = await startFakeHttpMcpServer()
    servers.push(server)
    const localConfig = config(server.url)
    const runner = createHttpMcpTransportRunner(localConfig)
    try {
      await expect(invokeMcpTool(localConfig, runner, { message: 'hello' }, new AbortController().signal)).resolves.toEqual({ echo: 'hello' })
    } finally {
      await runner.close()
    }
  })

  it('supports bearer, oauth2, API key, and basic auth headers with auth precedence', async () => {
    const server = await startFakeHttpMcpServer({ requiredHeaders: { authorization: 'Bearer secret' } })
    servers.push(server)

    await expect(invokeMcpTool({
      ...config(server.url),
      headers: { authorization: 'Bearer wrong' },
      auth: { kind: 'bearer' as const, token: 'secret' }
    }, createHttpMcpTransportRunner({ ...config(server.url), headers: { authorization: 'Bearer wrong' }, auth: { kind: 'bearer' as const, token: 'secret' } }), { message: 'bearer' }, new AbortController().signal)).resolves.toEqual({ echo: 'bearer' })

    const oauthServer = await startFakeHttpMcpServer({ requiredHeaders: { authorization: 'Bearer oauth-secret' } })
    servers.push(oauthServer)
    const oauthConfig = { ...config(oauthServer.url), auth: { kind: 'oauth2' as const, accessToken: 'oauth-secret' } }
    await expect(invokeMcpTool(oauthConfig, createHttpMcpTransportRunner(oauthConfig), { message: 'oauth' }, new AbortController().signal)).resolves.toEqual({ echo: 'oauth' })

    const apiServer = await startFakeHttpMcpServer({ requiredHeaders: { 'x-api-key': 'secret-key' } })
    servers.push(apiServer)
    const apiConfig = { ...config(apiServer.url), auth: { kind: 'api_key' as const, header: 'x-api-key', value: 'secret-key' } }
    await expect(invokeMcpTool(apiConfig, createHttpMcpTransportRunner(apiConfig), { message: 'api' }, new AbortController().signal)).resolves.toEqual({ echo: 'api' })

    const basicServer = await startFakeHttpMcpServer({ requiredHeaders: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` } })
    servers.push(basicServer)
    const basicConfig = { ...config(basicServer.url), auth: { kind: 'basic' as const, username: 'u', password: 'p' } }
    await expect(invokeMcpTool(basicConfig, createHttpMcpTransportRunner(basicConfig), { message: 'basic' }, new AbortController().signal)).resolves.toEqual({ echo: 'basic' })
  })

  it('maps HTTP auth failures and validates input', async () => {
    const server = await startFakeHttpMcpServer({ requiredHeaders: { authorization: 'Bearer secret' } })
    servers.push(server)
    const localConfig = config(server.url)
    const runner = createHttpMcpTransportRunner(localConfig)
    try {
      await expect(invokeMcpTool(localConfig, runner, { message: 'hello' }, new AbortController().signal)).rejects.toBeInstanceOf(McpAuthError)
    } finally {
      await runner.close()
    }

    const openServer = await startFakeHttpMcpServer()
    servers.push(openServer)
    const openConfig = config(openServer.url)
    const openRunner = createHttpMcpTransportRunner(openConfig)
    try {
      await expect(invokeMcpTool(openConfig, openRunner, { message: 123 }, new AbortController().signal)).rejects.toBeInstanceOf(ValidationError)
    } finally {
      await openRunner.close()
    }
  })

  it('only trusts structured fields or explicit status phrasing when sniffing HTTP statuses', () => {
    expect(statusFromError({ status: 403 })).toBe(403)
    expect(statusFromError(new Error('HTTP 503 from upstream'))).toBe(503)
    expect(statusFromError(new Error('upstream status: 429'))).toBe(429)
    expect(statusFromError(new Error('Unauthorized'))).toBe(401)
    // Incidental numbers in messages must not classify as HTTP statuses.
    expect(statusFromError(new Error('request took 401ms'))).toBeUndefined()
    expect(statusFromError(new Error('retried 500 times'))).toBeUndefined()
  })

  it('enforces HTTP call timeouts', async () => {
    const server = await startFakeHttpMcpServer()
    servers.push(server)
    const localConfig = config(server.url, 1_000)
    const runner = createHttpMcpTransportRunner(localConfig)
    try {
      await runner.listTools({ timeoutMs: 1_000 })
      localConfig.timeoutMs = 20
      await expect(invokeMcpTool(localConfig, runner, { message: 'slow', delayMs: 250 }, new AbortController().signal)).rejects.toBeInstanceOf(OperationTimeoutError)
    } finally {
      await runner.close()
    }
  })
})
