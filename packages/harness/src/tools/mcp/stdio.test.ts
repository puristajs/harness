import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineMcpServer } from '../../definitions/mcp-server.js'
import { OperationCancelledError, OperationTimeoutError } from '../../errors/index.js'
import type { McpRuntimeClient, McpRuntimeDependencies } from './runtime.js'
import { initializeMcpRuntimeBundles } from './runtime.js'

function client(tools: readonly { name: string; inputSchema?: unknown }[]): McpRuntimeClient & { callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return {
    connect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async (name: string, input: unknown) => ({ name, input })),
    close: vi.fn(async () => undefined),
  }
}

const server = defineMcpServer('knowledge', {
  tools: {
    searchKnowledge: {
      remoteName: 'search_knowledge', description: 'Search knowledge.',
      input: z.object({ query: z.string(), limit: z.number().optional() }),
      output: z.object({ result: z.string() }),
    },
  },
})

function dependencies(runtimeClient: McpRuntimeClient): McpRuntimeDependencies {
  return { createClient: () => runtimeClient, createHttpTransport: () => Object.freeze({}), createStdioTransport: () => Object.freeze({}) }
}

describe('v4 MCP HTTP bundle', () => {
  it('discovers every declared remote exactly once, ignores undeclared tools, and routes by hidden owner bundle', async () => {
    const runtimeClient = client([
      { name: 'unrelated', inputSchema: { type: 'object' } },
      { name: 'search_knowledge', inputSchema: { '$schema': 'https://json-schema.org/draft/2020-12/schema', description: 'ignored', required: ['query'], type: 'object', properties: { limit: { type: 'number' }, query: { type: 'string' } } } },
    ])
    const bundles = await initializeMcpRuntimeBundles({
      harnessName: 'banking', harnessInstanceId: '01J00000000000000000000000', timeoutMs: 100,
      servers: { knowledge: server }, bindings: { knowledge: { transport: 'http', url: 'https://example.test/mcp' } },
      dependencies: dependencies(runtimeClient),
    })
    expect(bundles).toHaveLength(1)
    expect(Object.keys(bundles[0]!.tools)).toEqual(['searchKnowledge'])
    await expect(bundles[0]!.tools.searchKnowledge!.invokeValidated({}, { query: 'x' })).resolves.toEqual({ name: 'search_knowledge', input: { query: 'x' } })
    expect(runtimeClient.callTool).toHaveBeenCalledOnce()
    await bundles[0]!.close(); await bundles[0]!.close()
    expect(runtimeClient.close).toHaveBeenCalledOnce()
  })

  it('fails closed for missing, duplicate, unequal, and unsupported selected schemas', async () => {
    const base = { harnessName: 'banking', harnessInstanceId: '01J00000000000000000000000', timeoutMs: 100, servers: { knowledge: server }, bindings: { knowledge: { transport: 'http' as const, url: 'https://example.test/mcp' } } }
    for (const tools of [
      [],
      [{ name: 'search_knowledge', inputSchema: { type: 'object' } }, { name: 'search_knowledge', inputSchema: { type: 'object' } }],
      [{ name: 'search_knowledge', inputSchema: { type: 'object', properties: { other: { type: 'string' } } } }],
      [{ name: 'search_knowledge', inputSchema: { type: 'object', unevaluatedProperties: false } }],
    ]) {
      const runtimeClient = client(tools)
      await expect(initializeMcpRuntimeBundles({ ...base, dependencies: dependencies(runtimeClient) })).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR', meta: { phase: 'list' } })
      expect(runtimeClient.close).toHaveBeenCalledOnce()
    }
  })

  it('normalizes string cancellation reasons and preserves canonical MCP call timeouts', async () => {
    const runtimeClient = client([
      { name: 'search_knowledge', inputSchema: { '$schema': 'https://json-schema.org/draft/2020-12/schema', required: ['query'], type: 'object', properties: { limit: { type: 'number' }, query: { type: 'string' } } } },
    ])
    const bundles = await initializeMcpRuntimeBundles({
      harnessName: 'banking', harnessInstanceId: '01J00000000000000000000000', timeoutMs: 100,
      servers: { knowledge: server }, bindings: { knowledge: { transport: 'http', url: 'https://example.test/mcp' } },
      dependencies: dependencies(runtimeClient),
    })
    const controller = new AbortController()
    controller.abort('caller detail')
    runtimeClient.callTool.mockRejectedValueOnce('caller detail')
    await expect(bundles[0]!.tools.searchKnowledge!.invokeValidated({ signal: controller.signal }, { query: 'x' })).rejects.toBeInstanceOf(OperationCancelledError)

    const timeout = new OperationTimeoutError('MCP tool operation timed out.', { scope: 'tool', timeout_ms: 100 })
    runtimeClient.callTool.mockRejectedValueOnce(timeout)
    await expect(bundles[0]!.tools.searchKnowledge!.invokeValidated({}, { query: 'x' })).rejects.toBe(timeout)
    await bundles[0]!.close()
  })
})
