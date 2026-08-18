#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'

function createServer() {
const server = new McpServer({ name: 'purista-fake-stdio-mcp', version: '0.0.0' })

server.registerTool('echo', {
  description: 'Echoes a message as structured content.',
  inputSchema: {
    message: z.string(),
    delayMs: z.number().optional(),
    die: z.boolean().optional()
  },
  outputSchema: {
    echo: z.string()
  }
}, async ({ message, delayMs, die }) => {
  if (die) process.exit(9)
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
  const structuredContent = { echo: message }
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  }
})

let counter = 0

server.registerTool('counter', {
  description: 'Increments and returns a per-process counter (proves persistent server state).',
  inputSchema: {
    by: z.number().optional()
  },
  outputSchema: {
    value: z.number()
  }
}, async ({ by }) => {
  counter += by ?? 1
  const structuredContent = { value: counter }
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent
  }
})

server.registerTool('bad-envelope', {
  description: 'Returns an MCP error envelope.',
  inputSchema: { message: z.string() }
}, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'fake MCP failure' }]
}))

return server
}

serveStdio(createServer, { legacy: 'reject' })
