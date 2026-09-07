import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { defineMcpServer } from '../../definitions/mcp-server.js'
import { initializeMcpRuntimeBundles } from './runtime.js'

afterEach(() => vi.unstubAllGlobals())

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
