import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineMcpServer } from '../../src/definitions/mcp-server.js'
import { projectModelSchema } from '../../src/schema/json-schema.js'
import { initializeMcpRuntimeBundles } from '../../src/tools/mcp/runtime.js'

describe('fake MCP fixtures', () => {
  it('ships a deterministic fake stdio server path', () => {
    const path = fileURLToPath(new URL('../../src/testing/fixtures/mcp/fake-stdio-server.mjs', import.meta.url))
    expect(path.endsWith('/packages/harness/src/testing/fixtures/mcp/fake-stdio-server.mjs')).toBe(true)
  })

  it('initializes and closes an HTTP MCP bundle through the injected protocol seam', async () => {
    const input = z.object({ query: z.string() })
    const server = defineMcpServer('knowledge', { tools: {
      lookup: { remoteName: 'remoteLookup', description: 'Lookup.', input, output: z.object({ result: z.string() }) },
    } })
    const calls: string[] = []
    const bundles = await initializeMcpRuntimeBundles({
      harnessName: 'testHarness', harnessInstanceId: 'instance1', servers: { knowledge: server },
      bindings: { knowledge: { transport: 'http', url: 'https://invalid.test/mcp' } }, timeoutMs: 1_000,
      dependencies: {
        createHttpTransport: async () => ({}), createStdioTransport: () => ({}),
        createClient: async () => ({
          connect: async () => { calls.push('connect') },
          listTools: async () => [{ name: 'remoteLookup', inputSchema: projectModelSchema(input, 'tool_input', 'lookup') }],
          callTool: async () => ({ content: [] }),
          close: async () => { calls.push('close') },
        }),
      },
    })
    expect(Object.keys(bundles[0]!.tools)).toEqual(['lookup'])
    await bundles[0]!.close()
    expect(calls).toEqual(['connect', 'close'])
  })
})
