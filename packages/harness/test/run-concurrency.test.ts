import { describe, expect, it, vi } from 'vitest'

import { RunConcurrencyRejectedError, HarnessConfigError, InternalError, OperationCancelledError, OperationTimeoutError } from '../src/errors/index.js'
import { inMemoryRunConcurrency, withRunConcurrency } from '../src/runtime/run-concurrency.js'

const request = (signal = new AbortController().signal) => ({ agentId: 'agent', rootRunId: 'root', depth: 0, signal })

describe('run concurrency', () => {
	it('provides bounded FIFO root-run concurrency with cancellation, reentrancy, and exactly-once release', async () => {
		const concurrency = inMemoryRunConcurrency({ maxConcurrent: 1, maxQueued: 1, retryAfterMs: 25 })
		const first = await concurrency.acquire(request())
		const reentrant = await concurrency.acquire({ ...request(), depth: 1 })
		const controller = new AbortController()
		const queued = concurrency.acquire({ ...request(), rootRunId: 'queued', signal: controller.signal })
		const overflow = await concurrency.acquire({ ...request(), rootRunId: 'overflow' }).catch(error => error)
		expect(overflow).toBeInstanceOf(RunConcurrencyRejectedError)
		expect(overflow).toMatchObject({ retryAfterMs: 25, meta: { retryAfterMs: 25 } })
		controller.abort()
		await expect(queued).rejects.toBeInstanceOf(OperationCancelledError)
		reentrant.release()
		first.release()
		first.release()
		const next = await concurrency.acquire({ ...request(), rootRunId: 'next' })
		next.release()
	})

	it('admits queued roots in FIFO order and removes deadline-expired waiters', async () => {
		vi.useFakeTimers()
		const concurrency = inMemoryRunConcurrency({ maxConcurrent: 1, maxQueued: 3 })
		const first = await concurrency.acquire(request())
		const order: string[] = []
		const second = concurrency.acquire({ ...request(), rootRunId: 'second' }).then(lease => { order.push('second'); return lease })
		const third = concurrency.acquire({ ...request(), rootRunId: 'third' }).then(lease => { order.push('third'); return lease })
		const expired = concurrency.acquire({ ...request(), rootRunId: 'expired', deadline: Date.now() + 5 })
		const expiration = expect(expired).rejects.toBeInstanceOf(OperationTimeoutError)
		await vi.advanceTimersByTimeAsync(6)
		await expiration
		first.release()
		const secondLease = await second
		expect(order).toEqual(['second'])
		secondLease.release()
		const thirdLease = await third
		expect(order).toEqual(['second', 'third'])
		thirdLease.release()
		vi.useRealTimers()
	})

	it('uses a bounded maxConcurrent-times-four queue when maxQueued is omitted', async () => {
		const concurrency = inMemoryRunConcurrency({ maxConcurrent: 1 })
		const first = await concurrency.acquire(request())
		const queued = ['one', 'two', 'three', 'four'].map(rootRunId => concurrency.acquire({ ...request(), rootRunId }))
		const overflow = await concurrency.acquire({ ...request(), rootRunId: 'overflow' }).catch(error => error)
		expect(overflow).toMatchObject({ constructor: RunConcurrencyRejectedError, retryAfterMs: 1_000 })
		first.release()
		for (const pending of queued) (await pending).release()
	})

	it('rejects waiting roots when maxQueued is explicitly zero', async () => {
		const concurrency = inMemoryRunConcurrency({ maxConcurrent: 1, maxQueued: 0 })
		const first = await concurrency.acquire(request())
		await expect(concurrency.acquire({ ...request(), rootRunId: 'waiting' })).rejects.toBeInstanceOf(RunConcurrencyRejectedError)
		first.release()
	})

	it('rejects invalid and overflowed queue configuration deterministically', () => {
		for (const maxQueued of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => inMemoryRunConcurrency({ maxConcurrent: 1, maxQueued })).toThrow(HarnessConfigError)
		}
		expect(() => inMemoryRunConcurrency({ maxConcurrent: Number.MAX_SAFE_INTEGER })).toThrow(HarnessConfigError)
	})
	it('defines the exact retryable capacity error and validates retry hints', () => {
		expect(new RunConcurrencyRejectedError({ retryAfterMs: 100 })).toMatchObject({ code: 'RUN_CONCURRENCY_REJECTED', category: 'concurrency', retriable: true, message: 'Run concurrency capacity is exhausted.', meta: { reason: 'capacity_exhausted', retryAfterMs: 100 } })
		expect(() => new RunConcurrencyRejectedError({ retryAfterMs: 0 })).toThrow(HarnessConfigError)
		expect(() => new RunConcurrencyRejectedError({ extra: true } as never)).toThrow(HarnessConfigError)
	})

	it('releases exactly once after the logical result and preserves operation failure identity', async () => {
		const order: string[] = []
		const release = vi.fn(async () => { order.push('release') })
		const concurrency = { acquire: vi.fn(async () => ({ release })) }
		await expect(withRunConcurrency(concurrency, request(), async () => { order.push('run'); return 42 })).resolves.toBe(42)
		expect(order).toEqual(['run', 'release'])
		expect(release).toHaveBeenCalledTimes(1)
		const cancelled = new OperationCancelledError('cancelled', { scope: 'agent' })
		await expect(withRunConcurrency(concurrency, request(), async () => { throw cancelled })).rejects.toBe(cancelled)
		await expect(withRunConcurrency(concurrency, request(), async () => { throw undefined })).rejects.toBeUndefined()
	})

	it('preserves only canonical lifecycle/capacity failures and sanitizes all other adapter failures', async () => {
		for (const error of [new RunConcurrencyRejectedError(), new OperationCancelledError('cancel', { scope: 'agent' }), new OperationTimeoutError('timeout', { scope: 'run', timeout_ms: 1 })]) {
			await expect(withRunConcurrency({ acquire: async () => { throw error } }, request(), async () => null)).rejects.toBe(error)
		}
		for (const error of [new HarnessConfigError('secret config', { reason: 'bad' }), new InternalError('secret internal'), new Error('secret')]) {
			const failure = await withRunConcurrency({ acquire: async () => { throw error } }, request(), async () => null).catch(value => value)
			expect(failure).toMatchObject({ constructor: InternalError, message: 'Run concurrency failed.', meta: { reason: 'run_concurrency_failed' } })
			expect(failure).not.toBe(error)
			expect(failure.cause).toBeUndefined()
		}
	})

	it('does not invoke the adapter for an already cancelled or expired request', async () => {
		const acquire = vi.fn(async () => ({ release() {} }))
		const controller = new AbortController()
		controller.abort('private reason')
		await expect(withRunConcurrency({ acquire }, request(controller.signal), async () => null)).rejects.toBeInstanceOf(OperationCancelledError)
		await expect(withRunConcurrency({ acquire }, { ...request(), deadline: Date.now() - 1 }, async () => null)).rejects.toBeInstanceOf(OperationTimeoutError)
		expect(acquire).not.toHaveBeenCalled()
	})

	it('distinguishes a runtime-detected invalid lease from sanitized adapter failures', async () => {
		await expect(withRunConcurrency({ acquire: async () => ({}) as never }, request(), async () => null)).rejects.toMatchObject({
			constructor: InternalError, message: 'Run concurrency returned an invalid lease.', meta: { reason: 'invalid_run_concurrency_lease' },
		})
	})

	it('releases a lease that arrives after cancellation and reports cleanup without leaking details', async () => {
		const controller = new AbortController()
		let resolve!: (lease: { release(): Promise<void> }) => void
		const release = vi.fn(async () => {})
		const cleanup = vi.fn()
		const pending = withRunConcurrency({ acquire: () => new Promise(value => { resolve = value }) }, request(controller.signal), async () => null, { logger: { warn: cleanup } })
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
		const pending = withRunConcurrency({ acquire: () => new Promise(value => { resolve = value }) }, request(controller.signal), async () => null, { logger: { warn } }).catch(error => error)
		controller.abort()
		await expect(pending).resolves.toBeInstanceOf(OperationCancelledError)
		resolve({ release() { throw new Error('private cleanup detail') } })
		await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
		expect(warn).toHaveBeenCalledWith('Run concurrency release failed.', { reason: 'run_concurrency_release_failed' })
		expect(JSON.stringify(warn.mock.calls)).not.toContain('private cleanup detail')
	})

	it('makes release failure replace a prepared result with a sanitized internal error', async () => {
		const cleanup = vi.fn()
		await expect(withRunConcurrency({ acquire: async () => ({ release() { throw new Error('secret') } }) }, request(), async () => 'done', { logger: { warn: cleanup } })).rejects.toMatchObject({ constructor: InternalError, message: 'Run concurrency release failed.' })
		expect(cleanup).toHaveBeenCalledWith('Run concurrency release failed.', { reason: 'run_concurrency_release_failed' })
	})

	it('bounds a non-cooperative acquire by the inherited deadline and cleans up a late lease', async () => {
		vi.useFakeTimers()
		let resolve!: (lease: { release(): Promise<void> }) => void
		const release = vi.fn(async () => {})
		const pending = withRunConcurrency({ acquire: () => new Promise(value => { resolve = value }) }, {
			...request(), deadline: Date.now() + 5,
		}, async () => null).catch(error => error)
		await vi.advanceTimersByTimeAsync(6)
		await expect(pending).resolves.toBeInstanceOf(OperationTimeoutError)
		resolve({ release })
		await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
		vi.useRealTimers()
	})
})
