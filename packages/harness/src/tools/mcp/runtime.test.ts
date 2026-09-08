import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineMcpServer } from '../../definitions/mcp-server.js'
import { projectModelSchema } from '../../schema/json-schema.js'
import { initializeMcpRuntimeBundles, normalizeMcpOutput } from './runtime.js'

afterEach(() => vi.unstubAllGlobals())

describe('MCP result normalization', () => {
	it('prefers structured content and normalizes standard content blocks', () => {
		expect(normalizeMcpOutput({ structuredContent: { ok: true }, content: [{ type: 'text', text: 'ignored' }] }, 'lookup', 'http')).toEqual({ ok: true })
		expect(normalizeMcpOutput({ structuredContent: { ok: undefined }, content: [{ type: 'text', text: 'fallback' }] }, 'lookup', 'http')).toBe('fallback')
		expect(normalizeMcpOutput({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 'lookup', 'http')).toBe('a\nb')
		expect(normalizeMcpOutput({ content: [{ type: 'image', mimeType: 'image/png', data: 'abc' }] }, 'lookup', 'stdio')).toEqual({ contentType: 'image/png', data: 'abc' })
		expect(normalizeMcpOutput({ content: [{ type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'abc' } }] }, 'lookup', 'stdio')).toEqual({ contentType: 'text/plain', uri: 'file:///a.txt', data: 'abc' })
		expect(normalizeMcpOutput({ content: [{ type: 'text', text: 'caption' }, { type: 'image', mimeType: 'image/png', data: 'abc' }] }, 'lookup', 'http')).toEqual({
			content: ['caption', { contentType: 'image/png', data: 'abc' }],
		})
	})

	it('maps an MCP error result to a typed tool failure', () => {
		let failure: unknown
		try { normalizeMcpOutput({ isError: true, content: [{ type: 'text', text: 'upstream detail' }] }, 'lookup', 'http') }
		catch (error) { failure = error }
		expect(failure).toMatchObject({ code: 'TOOL_ERROR', meta: { tool_id: 'lookup', tool_kind: 'mcp_http' } })
		expect(`${String(failure)}${JSON.stringify(failure)}`).not.toContain('upstream detail')
	})
})

describe('MCP Streamable HTTP transport', () => {
	it('rejects redirects without contacting the target origin or exposing configured headers', async () => {
		let targetRequests = 0
		let targetAuthorization: string | undefined
		const redirect = 'https://redirect-origin.test/mcp'
		const target = 'https://target-origin.test/mcp'
		const simulatedFetch = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
			const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
			if (url === redirect) {
				if (init?.redirect === 'error') throw new TypeError('Redirects are disabled.')
				return simulatedFetch(target, init)
			}
			if (url === target) {
				targetRequests += 1
				targetAuthorization = new Headers(init?.headers).get('authorization') ?? undefined
				return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
			}
			throw new Error('Unexpected MCP request URL.')
		}
		vi.stubGlobal('fetch', simulatedFetch)
		const secret = 'Bearer must-not-cross-origins'
		const definition = defineMcpServer('redirecting', { tools: {
			lookup: {
				remoteName: 'lookup', description: 'Look up one record.',
				input: z.object({ id: z.string() }), output: z.object({ value: z.string() }),
			},
		} })

		const failure = await initializeMcpRuntimeBundles({
			harnessName: 'redirectHarness', harnessInstanceId: 'instance',
			servers: { redirecting: definition },
			bindings: { redirecting: { transport: 'http', url: redirect, headers: { authorization: secret } } },
			timeoutMs: 1_000,
		}).catch(error => error)

		expect(failure).toMatchObject({ code: 'MCP_PROTOCOL_ERROR' })
		expect(targetRequests).toBe(0)
		expect(targetAuthorization).toBeUndefined()
		expect(`${String(failure)}${JSON.stringify(failure)}`).not.toContain(secret)
	})

	it('uses static headers for discovery and immutable resolved headers for each call on the existing client', async () => {
		const definition = mcpDefinition()
		const staticHeaders = { Authorization: 'Bearer static', 'x-static': 'one' }
		let authorizationReads = 0
		const resolvedTarget = Object.assign(Object.create(null) as Record<string, string>, { 'x-tenant': 'tenant-1' })
		Object.defineProperty(resolvedTarget, 'authorization', {
			enumerable: true,
			get() { authorizationReads += 1; return 'Bearer tenant' },
		})
		const resolvedHeaders = new Proxy(resolvedTarget, {})
		const resolveHeaders = vi.fn(context => {
			expect(Object.isFrozen(context)).toBe(true)
			expect(Object.isFrozen(context.caller)).toBe(true)
			expect(context).toMatchObject({ serverId: 'knowledge', toolId: 'lookup', sessionId: 'session-1', runId: 'run-1',
				caller: { kind: 'workflow', workflowId: 'reviewWorkflow' }, callId: 'call-1', identity: { tenantId: 'tenant-1' } })
			return resolvedHeaders
		})
		const calls: unknown[] = []
		const transports: unknown[] = []
		let clients = 0
		const bundles = await initializeMcpRuntimeBundles({
			harnessName: 'headersHarness', harnessInstanceId: 'instance', servers: { knowledge: definition }, timeoutMs: 1_000,
			bindings: { knowledge: { transport: 'http', url: 'https://knowledge.test/mcp', headers: staticHeaders, resolveHeaders } },
			dependencies: fakeDependencies({ calls, transports, onCreateClient: () => { clients += 1 } }),
		})

		const context = toolContext({ caller: { kind: 'workflow', workflowId: 'reviewWorkflow' }, workflowId: 'reviewWorkflow' })
		await expect(bundles[0]!.tools.lookup!.invokeWorkflowValidated!(context as never, { id: 'record-1' }, { id: 'record-1' }))
			.resolves.toEqual({ value: 'found' })
		expect(clients).toBe(1)
		expect(transports).toEqual([{ transport: 'http', url: 'https://knowledge.test/mcp', headers: {
			Authorization: 'Bearer static', 'x-static': 'one',
		} }])
		expect((transports[0] as Record<string, unknown>)).not.toHaveProperty('resolveHeaders')
		expect(Object.isFrozen(transports[0])).toBe(true)
		expect(calls).toEqual([{ name: 'lookup_remote', input: { id: 'record-1' }, options: {
			signal: context.signal, headers: { authorization: 'Bearer tenant', 'x-static': 'one', 'x-tenant': 'tenant-1' },
		} }])
		expect(Object.isFrozen((calls[0] as { options: { headers: object } }).options.headers)).toBe(true)
		expect(authorizationReads).toBe(1)
		expect(staticHeaders).toEqual({ Authorization: 'Bearer static', 'x-static': 'one' })
	})

	it.each([
		['agent', { kind: 'agent', agentId: 'support' }],
		['workflow', { kind: 'workflow', workflowId: 'reviewWorkflow' }],
	] as const)('projects the exact frozen %s caller into credential resolution', async (_name, caller) => {
		const resolveHeaders = vi.fn(() => ({}))
		const calls: unknown[] = []
		const bundles = await initializeMcpRuntimeBundles({
			harnessName: 'callerHarness', harnessInstanceId: 'instance', servers: { knowledge: mcpDefinition() }, timeoutMs: 1_000,
			bindings: { knowledge: { transport: 'http', url: 'https://knowledge.test/mcp', resolveHeaders } },
			dependencies: fakeDependencies({ calls }),
		})
		await bundles[0]!.tools.lookup!.invokeValidated({ ...toolContext(), caller } as never, { id: 'record-1' }, { id: 'record-1' })
		expect(resolveHeaders).toHaveBeenCalledOnce()
		const projected = (resolveHeaders.mock.calls[0]![0] as { caller: unknown }).caller
		expect(projected).toEqual(caller)
		expect(Object.isFrozen(projected)).toBe(true)
	})

	it.each([
		['neither', {}],
		['both', { kind: 'workflow', workflowId: 'reviewWorkflow', agentId: 'support' }],
	] as const)('rejects an erased %s caller before credential projection or transport effects', async (_name, caller) => {
		const resolveHeaders = vi.fn(() => ({ authorization: 'Bearer secret' }))
		const calls: unknown[] = []
		const bundles = await initializeMcpRuntimeBundles({
			harnessName: 'callerHarness', harnessInstanceId: 'instance', servers: { knowledge: mcpDefinition() }, timeoutMs: 1_000,
			bindings: { knowledge: { transport: 'http', url: 'https://knowledge.test/mcp', resolveHeaders } },
			dependencies: fakeDependencies({ calls }),
		})
		const context = { ...toolContext(), caller }
		await expect(bundles[0]!.tools.lookup!.invokeValidated(context as never, { id: 'record-1' }, { id: 'record-1' }))
			.rejects.toThrow(/caller/i)
		expect(resolveHeaders).not.toHaveBeenCalled()
		expect(calls).toEqual([])
	})

	it('sanitizes credential projection and transport failures without retaining secrets', async () => {
		const secret = 'tenant-secret-that-must-not-leak'
		for (const mode of ['resolver', 'transport'] as const) {
			const calls: unknown[] = []
			const bundles = await initializeMcpRuntimeBundles({
				harnessName: 'secretHarness', harnessInstanceId: 'instance', servers: { knowledge: mcpDefinition() }, timeoutMs: 1_000,
				bindings: { knowledge: { transport: 'http', url: 'https://knowledge.test/mcp', headers: { authorization: secret },
					...(mode === 'resolver' ? { resolveHeaders: () => { throw new Error(secret) } } : {}) } },
				dependencies: fakeDependencies({ calls, ...(mode === 'transport' ? { callError: new Error(secret) } : {}) }),
			})
			const failure = await bundles[0]!.tools.lookup!.invokeValidated(toolContext() as never, { id: 'record-1' }, { id: 'record-1' }).catch(error => error)
			expect(failure).toMatchObject({ code: 'MCP_PROTOCOL_ERROR', meta: { tool_id: 'lookup', transport: 'http', phase: 'call' } })
			expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
			expect(`${String(failure)}${JSON.stringify(failure)}`).not.toContain(secret)
			expect(calls).toEqual(mode === 'resolver' ? [] : [{ name: 'lookup_remote', input: { id: 'record-1' }, options: {
				signal: expect.any(AbortSignal), headers: { authorization: secret },
			} }])
		}
	})

	it('exposes only declared selections and rejects duplicate selected remote names', async () => {
		const calls: unknown[] = []
		const discovered = [
			{ name: 'lookup_remote', inputSchema: projectModelSchema(mcpDefinition().tools.lookup.input, 'tool_input', 'lookup') },
			{ name: 'undeclared_remote', inputSchema: { type: 'object' } },
		]
		const bundles = await initializeMcpRuntimeBundles({
			harnessName: 'selectedHarness', harnessInstanceId: 'instance', servers: { knowledge: mcpDefinition() }, timeoutMs: 1_000,
			bindings: { knowledge: { transport: 'http', url: 'https://knowledge.test/mcp' } },
			dependencies: fakeDependencies({ calls, discovered }),
		})
		expect(Object.keys(bundles[0]!.tools)).toEqual(['lookup'])
		await bundles[0]!.close()

		const close = vi.fn(async () => {})
		await expect(initializeMcpRuntimeBundles({
			harnessName: 'duplicateHarness', harnessInstanceId: 'instance', servers: { knowledge: mcpDefinition() }, timeoutMs: 1_000,
			bindings: { knowledge: { transport: 'http', url: 'https://knowledge.test/mcp' } },
			dependencies: fakeDependencies({ calls: [], discovered: [discovered[0]!, discovered[0]!], close }),
		})).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR', meta: { phase: 'list' } })
		expect(close).toHaveBeenCalledOnce()
	})

	it('times out initialization and rolls partially initialized servers back in reverse order', async () => {
		const timeoutClose = vi.fn(async () => {})
		await expect(initializeMcpRuntimeBundles({
			harnessName: 'timeoutHarness', harnessInstanceId: 'instance', servers: { knowledge: mcpDefinition() },
			bindings: { knowledge: { transport: 'http', url: 'https://knowledge.test/mcp' } }, timeoutMs: 5,
			dependencies: {
				createClient: () => ({ connect: async () => new Promise<void>(() => {}), listTools: async () => [], callTool: async () => null, close: timeoutClose }),
				createHttpTransport: () => ({}), createStdioTransport: () => ({}),
			},
		})).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' })
		expect(timeoutClose).toHaveBeenCalledOnce()

		const closed: string[] = []
		const first = mcpDefinition('alpha')
		const second = mcpDefinition('beta')
		await expect(initializeMcpRuntimeBundles({
			harnessName: 'rollbackHarness', harnessInstanceId: 'instance', servers: { alpha: first, beta: second }, timeoutMs: 1_000,
			bindings: { alpha: { transport: 'http', url: 'https://alpha.test/mcp' }, beta: { transport: 'http', url: 'https://beta.test/mcp' } },
			dependencies: {
				createClient: serverId => ({
					connect: async () => { if (serverId === 'beta') throw new Error('private connect failure') },
					listTools: async () => [{ name: 'lookup_remote', inputSchema: projectModelSchema(first.tools.lookup.input, 'tool_input', 'lookup') }],
					callTool: async () => null, close: async () => { closed.push(serverId) },
				}),
				createHttpTransport: () => ({}), createStdioTransport: () => ({}),
			},
		})).rejects.toMatchObject({ code: 'MCP_PROTOCOL_ERROR', meta: { phase: 'connect' } })
		expect(closed).toEqual(['beta', 'alpha'])
	})
})

function mcpDefinition(id = 'knowledge') {
	return defineMcpServer(id, { tools: { lookup: {
		remoteName: 'lookup_remote', description: 'Look up one record.',
		input: z.object({ id: z.string() }), output: z.object({ value: z.string() }),
	} } })
}

function fakeDependencies(options: { calls: unknown[]; transports?: unknown[]; onCreateClient?: () => void; discovered?: readonly { name: string; inputSchema?: unknown }[]; callError?: Error; close?: () => Promise<void> }) {
	return {
		createClient() {
			options.onCreateClient?.()
			return {
				async connect() {},
				async listTools() { return options.discovered ?? [{ name: 'lookup_remote', inputSchema: projectModelSchema(mcpDefinition().tools.lookup.input, 'tool_input', 'lookup') }] },
				async callTool(name: string, input: unknown, callOptions: unknown) {
					options.calls.push({ name, input, options: callOptions })
					if (options.callError !== undefined) throw options.callError
					return { structuredContent: { value: 'found' } }
				},
				close: options.close ?? (async () => {}),
			}
		},
		createHttpTransport(binding: unknown) { options.transports?.push(binding); return Object.freeze({ transport: 'http' }) },
		createStdioTransport() { return Object.freeze({ transport: 'stdio' }) },
	}
}

function toolContext(overrides: Record<string, unknown> = {}) {
	const signal = new AbortController().signal
	return {
		caller: { kind: 'agent', agentId: 'support' }, harnessName: 'headersHarness', sessionId: 'session-1', runId: 'run-1', rootRunId: 'run-1',
		invocationId: 'invocation-1', agentId: 'support', depth: 0, remainingDepth: 4, step: 1, toolId: 'lookup', callId: 'call-1',
		identity: Object.freeze({ tenantId: 'tenant-1' }), signal, metadata: Object.freeze({}),
		...overrides,
	}
}
