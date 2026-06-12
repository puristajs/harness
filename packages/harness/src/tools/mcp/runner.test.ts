import { describe, expect, it, vi } from 'vitest'
import { ToolError, ToolNotFoundError, ValidationError } from '../../errors/index.js'
import type { McpTransportRunner, ResolvedMcpStdioTool } from './runner.js'
import { createMcpRunnerRegistry, getModelToolSpec, invokeMcpTool, normalizeMcpOutput } from './runner.js'

function fakeRunner(result: unknown): McpTransportRunner {
  return {
    async listTools() {
      return [{
        name: 'upstream.draw',
        description: 'Upstream summary',
        inputSchema: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: { title: { type: 'string' } }
        },
        outputSchema: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { type: 'boolean' } }
        }
      }]
    },
    callTool: vi.fn(async () => result),
    close: vi.fn(async () => undefined)
  }
}

const config = {
  localToolId: 'drawDiagram',
  kind: 'mcp_http' as const,
  description: 'Create diagram',
  upstreamToolName: 'upstream.draw',
  timeoutMs: 250,
  serverKey: 'drawDiagram',
  url: 'https://mcp.example.test/mcp'
}

describe('MCP runner facade', () => {
  it('builds model tool specs from discovered MCP input schemas', async () => {
    await expect(getModelToolSpec(config, fakeRunner({ structuredContent: { ok: true } }))).resolves.toEqual({
      name: 'drawDiagram',
      description: 'Create diagram\n\nUpstream summary',
      parameters: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: { title: { type: 'string' } }
      }
    })
  })

  it('retries MCP discovery after transient list failures', async () => {
    const discovered = [{
      name: 'upstream.draw',
      description: 'Upstream summary',
      inputSchema: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: { title: { type: 'string' } }
      }
    }]
    const runner: McpTransportRunner = {
      listTools: vi.fn()
        .mockRejectedValueOnce(new Error('temporary discovery failure'))
        .mockResolvedValueOnce(discovered),
      callTool: vi.fn(async () => ({ structuredContent: { ok: true } })),
      close: vi.fn(async () => undefined)
    }

    await expect(getModelToolSpec(config, runner)).rejects.toThrow('temporary discovery failure')
    await expect(getModelToolSpec(config, runner)).resolves.toEqual({
      name: 'drawDiagram',
      description: 'Create diagram\n\nUpstream summary',
      parameters: discovered[0]?.inputSchema
    })
    expect(runner.listTools).toHaveBeenCalledTimes(2)
  })

  it('normalizes structured, text, image, and resource MCP envelopes', () => {
    expect(normalizeMcpOutput({ structuredContent: { ok: true }, content: [{ type: 'text', text: 'ignored' }] })).toEqual({ ok: true })
    expect(normalizeMcpOutput({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(normalizeMcpOutput({ content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }] })).toEqual({ contentType: 'image/png', data: 'abc' })
    expect(normalizeMcpOutput({ content: [{ type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'abc' } }] })).toEqual({ contentType: 'text/plain', uri: 'file:///a.txt', data: 'abc' })
  })

  it('applies input adapter before validation and output adapter after output validation', async () => {
    const runner = fakeRunner({ structuredContent: { ok: true } })
    const output = await invokeMcpTool({
      ...config,
      inputAdapter: (input: unknown) => ({ title: (input as { name: string }).name }),
      outputAdapter: (value: unknown) => ({ wrapped: value })
    }, runner, { name: 'Wiki' }, new AbortController().signal)

    expect(output).toEqual({ wrapped: { ok: true } })
    expect(runner.callTool).toHaveBeenCalledWith('upstream.draw', { title: 'Wiki' }, expect.objectContaining({ timeoutMs: 250 }))
  })

  it('maps unknown upstream tools and error results to harness errors', async () => {
    await expect(getModelToolSpec({ ...config, upstreamToolName: 'missing' }, fakeRunner({}))).rejects.toBeInstanceOf(ToolNotFoundError)
    await expect(invokeMcpTool(config, fakeRunner({ isError: true, content: [{ type: 'text', text: 'bad upstream' }] }), { title: 'Wiki' }, new AbortController().signal)).rejects.toBeInstanceOf(ToolError)
  })

  it('includes the truncated server error content in MCP error results', async () => {
    await expect(invokeMcpTool(config, fakeRunner({ isError: true, content: [{ type: 'text', text: 'bad upstream detail' }] }), { title: 'Wiki' }, new AbortController().signal))
      .rejects.toThrow('bad upstream detail')
  })

  it('validates normalized output before output adapters run', async () => {
    const adapter = vi.fn((value) => value)
    await expect(invokeMcpTool({ ...config, outputAdapter: adapter }, fakeRunner({ structuredContent: { ok: 'yes' } }), { title: 'Wiki' }, new AbortController().signal)).rejects.toBeInstanceOf(ValidationError)
    expect(adapter).not.toHaveBeenCalled()
  })
})

describe('MCP runner registry', () => {
  function stdioConfig(sandboxKey: string): ResolvedMcpStdioTool {
    return {
      localToolId: 'sharedTool',
      kind: 'mcp_stdio',
      description: 'shared stdio tool',
      upstreamToolName: 'shared',
      timeoutMs: 250,
      serverKey: `sharedTool:${sandboxKey}`,
      sandboxKey,
      command: '/usr/bin/env',
      sandbox: {} as never
    }
  }

  it('keys runners by server key so sessions never share a sandbox-bound runner', async () => {
    const registry = createMcpRunnerRegistry()
    const sessionOne = stdioConfig('session-1')
    const sessionTwo = stdioConfig('session-2')

    expect(registry.getRunner(sessionOne)).toBe(registry.getRunner(sessionOne))
    expect(registry.getRunner(sessionOne)).not.toBe(registry.getRunner(sessionTwo))
    await registry.close()
  })

  it('evicts only the runners bound to the closed sandbox key', async () => {
    const registry = createMcpRunnerRegistry()
    const sessionOne = stdioConfig('session-1')
    const sessionTwo = stdioConfig('session-2')
    const before = registry.getRunner(sessionOne)
    const survivor = registry.getRunner(sessionTwo)

    await registry.closeForSandboxKey('session-1')

    expect(registry.getRunner(sessionOne)).not.toBe(before)
    expect(registry.getRunner(sessionTwo)).toBe(survivor)
    await registry.close()
  })

  it('closes without loading transports and swallows load failures during close', async () => {
    const registry = createMcpRunnerRegistry()
    // Invalid sandbox: loading the stdio transport for this config throws.
    const runner = registry.getRunner({ ...stdioConfig('session-1'), sandbox: undefined as never })
    // close() before any call must not trigger the (failing) transport load.
    await expect(registry.close()).resolves.toBeUndefined()

    const failing = createMcpRunnerRegistry()
    const loaded = failing.getRunner({ ...stdioConfig('session-2'), sandbox: undefined as never })
    await expect(loaded.callTool('shared', {}, {})).rejects.toThrow()
    // The cached load failure must not escape from registry shutdown.
    await expect(failing.close()).resolves.toBeUndefined()
    void runner
  })
})
