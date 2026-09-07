import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineMcpServer } from '../../definitions/mcp-server.js'
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
})
