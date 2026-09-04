import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineMcpServer } from '../../definitions/mcp-server.js'
import { OperationCancelledError, OperationTimeoutError } from '../../errors/index.js'
import type { SandboxProcess, SpawnCapableSandboxSession } from '../../sandbox/index.js'
import type { McpRuntimeClient, McpRuntimeDependencies } from './runtime.js'
import { createSandboxProcessTransport, initializeMcpRuntimeBundles } from './runtime.js'

function asyncEmpty(): AsyncIterable<string> { return { async *[Symbol.asyncIterator]() {} } }

function stdioHarness() {
  const calls: string[] = []
  const registrations: unknown[] = []
  const opens: unknown[] = []
  const process: SandboxProcess = { writeStdin: async () => undefined, stdout: asyncEmpty(), stderr: asyncEmpty(), exit: Promise.resolve({ exitCode: 0 }), kill: async () => { calls.push('kill') } }
  const session: SpawnCapableSandboxSession = {
    executor: 'available',
    read: async () => new Uint8Array(), readText: async () => '', write: async () => undefined, remove: async () => undefined,
    list: async () => [], stat: async () => ({ kind: 'file', size: 0, modifiedAt: new Date(0).toISOString() }), exists: async () => false,
    mount: async () => undefined, spawn: async () => { calls.push('spawn'); return process }, close: async () => { calls.push('attachment.close') },
  }
  const sandbox = {
    capabilities: ['sandbox.spawn'] as const,
    administration: { list: async () => ({ items: [] }), purge: async () => ({ state: 'completed' as const, deletedResources: 0, remainingResources: 0 }), sweep: async () => ({ examinedResources: 0, deletedResources: 0, pendingResources: 0 }), deleteSnapshot: async () => undefined },
    registerOwner: async value => { calls.push('registerOwner'); registrations.push(value) },
    open: async value => { calls.push('open'); opens.push(value); return { session, disposition: 'created' as const, liveProcessState: 'not_preserved' as const } },
    terminate: async () => { calls.push('terminate') },
  }
  return { calls, registrations, opens, sandbox }
}

const alpha = defineMcpServer('alpha', { tools: { ping: { remoteName: 'ping', description: 'Ping.', input: z.object({}), output: z.object({ ok: z.boolean() }) } } })
const beta = defineMcpServer('beta', { tools: { pong: { remoteName: 'pong', description: 'Pong.', input: z.object({}), output: z.object({ ok: z.boolean() }) } } })

describe('v4 MCP stdio ownership', () => {
  it('uses synthetic instance ownership and closes protocol, attachment, and scope once without closing the adapter', async () => {
    const { calls, registrations, opens, sandbox } = stdioHarness()
    let ownedTransport: { close(): Promise<void> } | undefined
    const runtimeClient: McpRuntimeClient = {
      connect: async transport => { calls.push('connect'); ownedTransport = transport as { close(): Promise<void> } },
      listTools: async () => [{ name: 'ping', inputSchema: { '$schema': 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} } }],
      callTool: async () => null,
      close: async () => { calls.push('protocol.close'); await ownedTransport?.close() },
    }
    const dependencies: McpRuntimeDependencies = {
      createClient: () => runtimeClient,
      createHttpTransport: () => ({}),
      createStdioTransport: process => {
        let closed = false
        return { async close() { if (closed) return; closed = true; calls.push('transport.close'); await process.kill('SIGTERM') } }
      },
    }
    const bundles = await initializeMcpRuntimeBundles({ harnessName: 'banking', harnessInstanceId: '01J00000000000000000000000', timeoutMs: 10, servers: { alpha }, bindings: { alpha: { transport: 'stdio', command: 'mcp', sandbox } }, dependencies })
    expect(calls.slice(0, 4)).toEqual(['registerOwner', 'open', 'spawn', 'connect'])
    expect(registrations).toEqual([{ owner: { namespace: 'banking.mcp', id: 'alpha', instanceId: '01J00000000000000000000000' }, mode: 'create' }])
    expect(opens).toEqual([{ scope: { owner: { namespace: 'banking.mcp', id: 'alpha', instanceId: '01J00000000000000000000000' }, partition: { kind: 'shared' }, lifetime: 'session' }, mode: 'create' }])
    await bundles[0]!.close(); await bundles[0]!.close()
    expect(calls.slice(-5)).toEqual(['protocol.close', 'transport.close', 'kill', 'attachment.close', 'terminate'])
    expect(calls.filter(call => call === 'kill')).toHaveLength(1)
    expect(calls.filter(call => call === 'transport.close')).toHaveLength(1)
    expect(calls.filter(call => call === 'attachment.close')).toHaveLength(1)
    expect(calls.filter(call => call === 'terminate')).toHaveLength(1)
    expect('close' in sandbox).toBe(false)
  })

  it('rolls back a failed later server in reverse creation order', async () => {
    const closed: string[] = []
    const dependencies: McpRuntimeDependencies = {
      createHttpTransport: () => ({}), createStdioTransport: () => ({}),
      createClient(id) {
        return { connect: async () => undefined, listTools: async () => id === 'alpha' ? [{ name: 'ping', inputSchema: { '$schema': 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} } }] : [], callTool: async () => null, close: vi.fn(async () => { closed.push(id) }) }
      },
    }
    await expect(initializeMcpRuntimeBundles({ harnessName: 'banking', harnessInstanceId: '01J00000000000000000000000', timeoutMs: 10, servers: { beta, alpha }, bindings: { alpha: { transport: 'http', url: 'https://a.test' }, beta: { transport: 'http', url: 'https://b.test' } }, dependencies })).rejects.toBeDefined()
    expect(closed).toEqual(['beta', 'alpha'])
  })

  it('honors initialization cancellation without allocating a transport', async () => {
    const controller = new AbortController(); controller.abort('caller detail')
    const createHttpTransport = vi.fn(() => ({}))
    const runtimeClient: McpRuntimeClient = { connect: async () => undefined, listTools: async () => [], callTool: async () => null, close: async () => undefined }
    await expect(initializeMcpRuntimeBundles({ harnessName: 'banking', harnessInstanceId: '01J00000000000000000000000', timeoutMs: 10, signal: controller.signal, servers: { alpha }, bindings: { alpha: { transport: 'http', url: 'https://a.test' } }, dependencies: { createClient: () => runtimeClient, createHttpTransport, createStdioTransport: () => ({}) } })).rejects.toBeInstanceOf(OperationCancelledError)
    expect(createHttpTransport).not.toHaveBeenCalled()
  })

  it('preserves the canonical initialization timeout error', async () => {
    const runtimeClient: McpRuntimeClient = { connect: async () => new Promise<void>(() => undefined), listTools: async () => [], callTool: async () => null, close: async () => undefined }
    await expect(initializeMcpRuntimeBundles({ harnessName: 'banking', harnessInstanceId: '01J00000000000000000000000', timeoutMs: 1, servers: { alpha }, bindings: { alpha: { transport: 'http', url: 'https://a.test' } }, dependencies: { createClient: () => runtimeClient, createHttpTransport: () => ({}), createStdioTransport: () => ({}) } })).rejects.toBeInstanceOf(OperationTimeoutError)
  })

  it('reports malformed stdout without retaining stdout content in the error or its cause', async () => {
    let finish!: (value: { exitCode: number }) => void
    const process: SandboxProcess = {
      writeStdin: async () => undefined,
      stdout: { async *[Symbol.asyncIterator]() { yield 'SECRET malformed json\n' } },
      stderr: asyncEmpty(),
      exit: new Promise(resolve => { finish = resolve }),
      kill: async () => { finish({ exitCode: 0 }) },
    }
    const transport = createSandboxProcessTransport(process) as {
      onerror?: (error: Error) => void
      onmessage?: (message: unknown) => void
      start(): Promise<void>
      close(): Promise<void>
    }
    const reported = new Promise<Error>(resolve => { transport.onerror = resolve })
    transport.onmessage = () => undefined
    await transport.start()
    const error = await reported
    expect(error.message).toBe('MCP stdio stdout stream failed.')
    expect(String(error)).not.toContain('SECRET')
    expect(error.cause).toBeUndefined()
    await transport.close()
  })
})
