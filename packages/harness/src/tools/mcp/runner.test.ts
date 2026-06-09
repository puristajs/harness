import { describe, expect, it, vi } from 'vitest'
import { ToolError, ToolNotFoundError, ValidationError } from '../../errors/index.js'
import type { McpTransportRunner } from './runner.js'
import { getModelToolSpec, invokeMcpTool, normalizeMcpOutput } from './runner.js'

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

  it('validates normalized output before output adapters run', async () => {
    const adapter = vi.fn((value) => value)
    await expect(invokeMcpTool({ ...config, outputAdapter: adapter }, fakeRunner({ structuredContent: { ok: 'yes' } }), { title: 'Wiki' }, new AbortController().signal)).rejects.toBeInstanceOf(ValidationError)
    expect(adapter).not.toHaveBeenCalled()
  })
})
