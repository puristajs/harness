import type { RunConcurrency, RunConcurrencyLease, RunConcurrencyRequest } from '../ports/run-concurrency.js'
import {
	RunConcurrencyRejectedError,
	HarnessConfigError,
	InternalError,
	OperationCancelledError,
	OperationTimeoutError,
} from '../errors/index.js'
import { abortError, withAbortSignal } from './abort.js'
import type { Logger } from '../logger/index.js'

export interface RunConcurrencyRuntimeOptions {
	readonly logger?: Pick<Logger, 'warn'>
}

/** Configuration for the opt-in, process-local bounded concurrency helper. */
export interface InMemoryRunConcurrencyOptions {
	/** Maximum concurrently admitted root execution trees. */
	readonly maxConcurrent: number
	/** Maximum waiting root execution trees; defaults to four times `maxConcurrent`. */
	readonly maxQueued?: number
	/** Stable retry hint used when the bounded queue is full. */
	readonly retryAfterMs?: number
}

type Waiter = Readonly<{
	request: RunConcurrencyRequest
	resolve: (lease: RunConcurrencyLease) => void
	reject: (reason: unknown) => void
	remove(): void
}>

/**
 * Creates an opt-in FIFO concurrency gate for complete local root execution trees.
 * It is process-local only and deliberately has no distributed queue semantics.
 */
export function inMemoryRunConcurrency(options: InMemoryRunConcurrencyOptions): RunConcurrency {
	if (options === null || typeof options !== 'object' || !Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0
		|| (options.maxQueued !== undefined && (!Number.isSafeInteger(options.maxQueued) || options.maxQueued < 0))
		|| (options.retryAfterMs !== undefined && (!Number.isSafeInteger(options.retryAfterMs) || options.retryAfterMs <= 0))) {
		throw new HarnessConfigError('In-memory run concurrency options are invalid.', {
			reason: 'invalid_run_concurrency_options', path: 'concurrency.runs',
		})
	}
	const maxQueued = options.maxQueued ?? defaultMaxQueued(options.maxConcurrent)
	if (!Number.isSafeInteger(maxQueued)) {
		throw new HarnessConfigError('In-memory run concurrency options are invalid.', {
			reason: 'invalid_run_concurrency_options', path: 'concurrency.runs',
		})
	}
	const retryAfterMs = options.retryAfterMs ?? 1_000
	const roots = new Map<string, number>()
	const waiters: Waiter[] = []
	const leaseFor = (rootRunId: string): RunConcurrencyLease => {
		let released = false
		return Object.freeze({ release() {
			if (released) return
			released = true
			const count = roots.get(rootRunId)
			if (count === undefined) return
			if (count > 1) { roots.set(rootRunId, count - 1); return }
			roots.delete(rootRunId)
			drain()
		} })
	}
	const drain = () => {
		while (roots.size < options.maxConcurrent && waiters.length > 0) {
			const waiter = waiters.shift()!
			waiter.remove()
			if (waiter.request.signal.aborted) continue
			if (waiter.request.deadline !== undefined && waiter.request.deadline <= Date.now()) {
				waiter.reject(new OperationTimeoutError('Run concurrency timed out.', { scope: 'run', timeout_ms: 0 })); continue
			}
			roots.set(waiter.request.rootRunId, 1)
			waiter.resolve(leaseFor(waiter.request.rootRunId))
		}
	}
	return Object.freeze({ async acquire(request: RunConcurrencyRequest): Promise<RunConcurrencyLease> {
		if (request.signal.aborted) throw abortError(request.signal, 'agent', 'Run concurrency was cancelled.')
		if (request.deadline !== undefined && request.deadline <= Date.now()) throw new OperationTimeoutError('Run concurrency timed out.', { scope: 'run', timeout_ms: 0 })
		const existing = roots.get(request.rootRunId)
		if (existing !== undefined) { roots.set(request.rootRunId, existing + 1); return leaseFor(request.rootRunId) }
		if (roots.size < options.maxConcurrent) { roots.set(request.rootRunId, 1); return leaseFor(request.rootRunId) }
		if (waiters.length >= maxQueued) throw new RunConcurrencyRejectedError({ retryAfterMs })
		return new Promise<RunConcurrencyLease>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined
			const abort = () => finish(abortError(request.signal, 'agent', 'Run concurrency was cancelled.'))
			const finish = (error: unknown) => {
				const index = waiters.indexOf(waiter)
				if (index >= 0) waiters.splice(index, 1)
				remove(); reject(error)
			}
			const remove = () => { request.signal.removeEventListener('abort', abort); if (timer !== undefined) clearTimeout(timer) }
			const waiter: Waiter = Object.freeze({ request, resolve, reject, remove })
			request.signal.addEventListener('abort', abort, { once: true })
			if (request.deadline !== undefined) timer = setTimeout(() => finish(new OperationTimeoutError('Run concurrency timed out.', { scope: 'run', timeout_ms: 0 })), Math.max(0, request.deadline - Date.now()))
			waiters.push(waiter)
		})
	} })
}

function defaultMaxQueued(maxConcurrent: number): number {
	return maxConcurrent * 4
}

/** Runs one complete root execution tree inside an optional concurrency lease. */
export async function withRunConcurrency<T>(
	concurrency: RunConcurrency | undefined,
	request: RunConcurrencyRequest,
	operation: () => Promise<T>,
	options: RunConcurrencyRuntimeOptions = {},
): Promise<T> {
	if (concurrency === undefined) return operation()
	assertInitialLifecycle(request)
	const lifecycle = concurrencySignal(request)
	let lease: RunConcurrencyLease
	try {
		lease = await acquire(concurrency, Object.freeze({ ...request, signal: lifecycle.signal }), lifecycle.signal, options)
	} finally {
		lifecycle.dispose()
	}
	let result: T | undefined
	let failure: unknown
	let failed = false
	try {
		result = await operation()
	} catch (error) {
		failed = true
		failure = error
	}
	try {
		await lease.release()
	} catch (error) {
		reportCleanup(options)
		throw new InternalError('Run concurrency release failed.', { reason: 'run_concurrency_release_failed' })
	}
	if (failed) throw failure
	return result as T
}

async function acquire(
	concurrency: RunConcurrency,
	request: RunConcurrencyRequest,
	signal: AbortSignal,
	options: RunConcurrencyRuntimeOptions,
): Promise<RunConcurrencyLease> {
	let accepted = false
	const pending = Promise.resolve().then(() => concurrency.acquire(request))
	let lease: RunConcurrencyLease
	try {
		lease = await withAbortSignal(signal, 'agent', 'Run concurrency was cancelled.', () => pending)
		accepted = true
	} catch (error) {
		if (!accepted) {
			void pending.then(async lateLease => {
				try { await lateLease.release() } catch { reportCleanup(options) }
			}, () => {})
		}
		if (
			error instanceof RunConcurrencyRejectedError
			|| error instanceof OperationCancelledError
			|| error instanceof OperationTimeoutError
		) throw error
		throw new InternalError('Run concurrency failed.', { reason: 'run_concurrency_failed' })
	}
	if (lease === null || typeof lease !== 'object' || typeof lease.release !== 'function') {
		throw new InternalError('Run concurrency returned an invalid lease.', { reason: 'invalid_run_concurrency_lease' })
	}
	return lease
}

function assertInitialLifecycle(request: RunConcurrencyRequest): void {
	if (request.signal.aborted) throw abortError(request.signal, 'agent', 'Run concurrency was cancelled.')
	if (request.deadline !== undefined && request.deadline <= Date.now()) {
		throw new OperationTimeoutError('Run concurrency timed out.', { scope: 'run', timeout_ms: 0 })
	}
}

function concurrencySignal(request: RunConcurrencyRequest): Readonly<{ signal: AbortSignal; dispose(): void }> {
	if (request.deadline === undefined) return Object.freeze({ signal: request.signal, dispose() {} })
	const controller = new AbortController()
	const timeoutMs = Math.max(0, request.deadline - Date.now())
	const timeout = setTimeout(() => controller.abort(new OperationTimeoutError('Run concurrency timed out.', { scope: 'run', timeout_ms: timeoutMs })), timeoutMs)
	const forward = () => controller.abort(abortError(request.signal, 'agent', 'Run concurrency was cancelled.'))
	request.signal.addEventListener('abort', forward, { once: true })
	if (request.signal.aborted) forward()
	return Object.freeze({
		signal: controller.signal,
		dispose() { clearTimeout(timeout); request.signal.removeEventListener('abort', forward) },
	})
}

function reportCleanup(options: RunConcurrencyRuntimeOptions): void {
	try { options.logger?.warn('Run concurrency release failed.', { reason: 'run_concurrency_release_failed' }) } catch { /* diagnostics cannot change cleanup semantics */ }
}
