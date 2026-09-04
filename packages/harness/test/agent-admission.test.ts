import { describe, expect, it, vi } from 'vitest'

import { AgentAdmissionRejectedError, HarnessConfigError, InternalError, OperationCancelledError, OperationTimeoutError } from '../src/errors/index.js'
import { withAgentAdmission } from '../src/runtime/agent-admission.js'

const request = (signal = new AbortController().signal) => ({ agentId: 'agent', rootRunId: 'root', depth: 0, signal })

describe('agent admission', () => {
	it('defines the exact retryable capacity error and validates retry hints', () => {
		expect(new AgentAdmissionRejectedError({ retryAfterMs: 100 })).toMatchObject({ code: 'AGENT_ADMISSION_REJECTED', category: 'admission', retriable: true, message: 'Agent admission capacity is exhausted.', meta: { reason: 'capacity_exhausted', retryAfterMs: 100 } })
		expect(() => new AgentAdmissionRejectedError({ retryAfterMs: 0 })).toThrow(HarnessConfigError)
		expect(() => new AgentAdmissionRejectedError({ extra: true } as never)).toThrow(HarnessConfigError)
	})

	it('releases exactly once after the logical result and preserves operation failure identity', async () => {
		const order: string[] = []
		const release = vi.fn(async () => { order.push('release') })
		const admission = { acquire: vi.fn(async () => ({ release })) }
		await expect(withAgentAdmission(admission, request(), async () => { order.push('run'); return 42 })).resolves.toBe(42)
		expect(order).toEqual(['run', 'release'])
		expect(release).toHaveBeenCalledTimes(1)
		const cancelled = new OperationCancelledError('cancelled', { scope: 'agent' })
		await expect(withAgentAdmission(admission, request(), async () => { throw cancelled })).rejects.toBe(cancelled)
		await expect(withAgentAdmission(admission, request(), async () => { throw undefined })).rejects.toBeUndefined()
	})

	it('preserves only canonical lifecycle/capacity failures and sanitizes all other adapter failures', async () => {
		for (const error of [new AgentAdmissionRejectedError(), new OperationCancelledError('cancel', { scope: 'agent' }), new OperationTimeoutError('timeout', { scope: 'run', timeout_ms: 1 })]) {
			await expect(withAgentAdmission({ acquire: async () => { throw error } }, request(), async () => null)).rejects.toBe(error)
		}
		for (const error of [new HarnessConfigError('secret config', { reason: 'bad' }), new InternalError('secret internal'), new Error('secret')]) {
			const failure = await withAgentAdmission({ acquire: async () => { throw error } }, request(), async () => null).catch(value => value)
			expect(failure).toMatchObject({ constructor: InternalError, message: 'Agent admission failed.', meta: { reason: 'agent_admission_failed' } })
			expect(failure).not.toBe(error)
			expect(failure.cause).toBeUndefined()
		}
	})

	it('does not invoke the adapter for an already cancelled or expired request', async () => {
		const acquire = vi.fn(async () => ({ release() {} }))
		const controller = new AbortController()
		controller.abort('private reason')
		await expect(withAgentAdmission({ acquire }, request(controller.signal), async () => null)).rejects.toBeInstanceOf(OperationCancelledError)
		await expect(withAgentAdmission({ acquire }, { ...request(), deadline: Date.now() - 1 }, async () => null)).rejects.toBeInstanceOf(OperationTimeoutError)
		expect(acquire).not.toHaveBeenCalled()
	})

	it('distinguishes a runtime-detected invalid lease from sanitized adapter failures', async () => {
		await expect(withAgentAdmission({ acquire: async () => ({}) as never }, request(), async () => null)).rejects.toMatchObject({
			constructor: InternalError, message: 'Agent admission returned an invalid lease.', meta: { reason: 'invalid_agent_admission_lease' },
		})
	})

	it('releases a lease that arrives after cancellation and reports cleanup without leaking details', async () => {
		const controller = new AbortController()
		let resolve!: (lease: { release(): Promise<void> }) => void
		const release = vi.fn(async () => {})
		const cleanup = vi.fn()
		const pending = withAgentAdmission({ acquire: () => new Promise(value => { resolve = value }) }, request(controller.signal), async () => null, { logger: { warn: cleanup } })
		controller.abort('secret')
		await expect(pending).rejects.toBeInstanceOf(OperationCancelledError)
		resolve({ release })
		await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
		expect(cleanup).not.toHaveBeenCalled()
	})

	it('reports a content-free diagnostic when late-acquire cleanup fails', async () => {
		const controller = new AbortController()
		let resolve!: (lease: { release(): void }) => void
		const warn = vi.fn()
		const pending = withAgentAdmission({ acquire: () => new Promise(value => { resolve = value }) }, request(controller.signal), async () => null, { logger: { warn } }).catch(error => error)
		controller.abort()
		await expect(pending).resolves.toBeInstanceOf(OperationCancelledError)
		resolve({ release() { throw new Error('private cleanup detail') } })
		await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
		expect(warn).toHaveBeenCalledWith('Agent admission release failed.', { reason: 'agent_admission_release_failed' })
		expect(JSON.stringify(warn.mock.calls)).not.toContain('private cleanup detail')
	})

	it('makes release failure replace a prepared result with a sanitized internal error', async () => {
		const cleanup = vi.fn()
		await expect(withAgentAdmission({ acquire: async () => ({ release() { throw new Error('secret') } }) }, request(), async () => 'done', { logger: { warn: cleanup } })).rejects.toMatchObject({ constructor: InternalError, message: 'Agent admission release failed.' })
		expect(cleanup).toHaveBeenCalledWith('Agent admission release failed.', { reason: 'agent_admission_release_failed' })
	})

	it('bounds a non-cooperative acquire by the inherited deadline and cleans up a late lease', async () => {
		vi.useFakeTimers()
		let resolve!: (lease: { release(): Promise<void> }) => void
		const release = vi.fn(async () => {})
		const pending = withAgentAdmission({ acquire: () => new Promise(value => { resolve = value }) }, {
			...request(), deadline: Date.now() + 5,
		}, async () => null).catch(error => error)
		await vi.advanceTimersByTimeAsync(6)
		await expect(pending).resolves.toBeInstanceOf(OperationTimeoutError)
		resolve({ release })
		await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
		vi.useRealTimers()
	})
})
