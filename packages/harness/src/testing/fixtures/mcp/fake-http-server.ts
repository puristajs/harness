import { createServer, type Server } from 'node:http'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'
import { toNodeHandler } from '@modelcontextprotocol/node'
import * as z from 'zod/v4'

export interface FakeHttpMcpServer {
  url: string
  close(): Promise<void>
}

export interface FakeHttpMcpServerOptions {
  requiredHeaders?: Record<string, string>
}

/** A strict 2026-07-28 MCP test endpoint; it deliberately rejects legacy traffic. */
export async function startFakeHttpMcpServer(options: FakeHttpMcpServerOptions = {}): Promise<FakeHttpMcpServer> {
  const handler = createMcpHandler(() => createFakeMcpServer(), { legacy: 'reject', responseMode: 'json' })
  const nodeHandler = toNodeHandler(handler)
  const server = createServer(async (req, res) => {
    if (!headersMatch(req.headers, options.requiredHeaders ?? {})) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (req.url !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    await nodeHandler(req as Parameters<typeof nodeHandler>[0], res)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake MCP server did not bind to a TCP port.')

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await handler.close()
      await closeServer(server)
    }
  }
}

function createFakeMcpServer(): McpServer {
  const server = new McpServer({ name: 'purista-fake-http-mcp', version: '0.0.0' })
  server.registerTool('echo', {
    description: 'Echoes a message as structured content.',
    inputSchema: { message: z.string(), delayMs: z.number().optional() },
    outputSchema: { echo: z.string() }
  }, async ({ message, delayMs }) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    const structuredContent = { echo: message }
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent }
  })
  return server
}

function headersMatch(headers: Record<string, string | string[] | undefined>, required: Record<string, string>): boolean {
  return Object.entries(required).every(([name, value]) => headers[name.toLowerCase()] === value)
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
