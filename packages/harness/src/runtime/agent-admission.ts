import type { AgentAdmission, AgentAdmissionLease, AgentAdmissionRequest } from '../ports/agent-admission.js'
import {
	AgentAdmissionRejectedError,
	HarnessConfigError,
	InternalError,
	OperationCancelledError,
	OperationTimeoutError,
} from '../errors/index.js'
import { abortError, withAbortSignal } from './abort.js'
import type { Logger } from '../logger/index.js'

export interface AgentAdmissionRuntimeOptions {
	readonly logger?: Pick<Logger, 'warn'>
}

/** Configuration for the opt-in, process-local bounded admission helper. */
export interface InMemoryAgentAdmissionOptions {
	/** Maximum concurrently admitted root execution trees. */
	readonly maxConcurrent: number
	/** Maximum waiting root execution trees; defaults to zero for immediate rejection. */
	readonly maxQueue?: number
	/** Stable retry hint used when the bounded queue is full. */
	readonly retryAfterMs?: number
}

type Waiter = Readonly<{
	request: AgentAdmissionRequest
	resolve: (lease: AgentAdmissionLease) => void
	reject: (reason: unknown) => void
	remove(): void
}>

/**
 * Creates an opt-in FIFO admission gate for complete local agent execution trees.
 * It is process-local only and deliberately has no distributed queue semantics.
 */
export function inMemoryAgentAdmission(options: InMemoryAgentAdmissionOptions): AgentAdmission {
	if (options === null || typeof options !== 'object' || !Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0
		|| (options.maxQueue !== undefined && (!Number.isSafeInteger(options.maxQueue) || options.maxQueue < 0))
		|| (options.retryAfterMs !== undefined && (!Number.isSafeInteger(options.retryAfterMs) || options.retryAfterMs <= 0))) {
		throw new HarnessConfigError('In-memory agent admission options are invalid.', {
			reason: 'invalid_agent_admission_options', path: 'agentAdmission',
		})
	}
	const maxQueue = options.maxQueue ?? 0
	const retryAfterMs = options.retryAfterMs ?? 1_000
	const roots = new Map<string, number>()
	const waiters: Waiter[] = []
	const leaseFor = (rootRunId: string): AgentAdmissionLease => {
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
				waiter.reject(new OperationTimeoutError('Agent admission timed out.', { scope: 'run', timeout_ms: 0 })); continue
			}
			roots.set(waiter.request.rootRunId, 1)
			waiter.resolve(leaseFor(waiter.request.rootRunId))
		}
	}
	return Object.freeze({ async acquire(request: AgentAdmissionRequest): Promise<AgentAdmissionLease> {
		if (request.signal.aborted) throw abortError(request.signal, 'agent', 'Agent admission was cancelled.')
		if (request.deadline !== undefined && request.deadline <= Date.now()) throw new OperationTimeoutError('Agent admission timed out.', { scope: 'run', timeout_ms: 0 })
		const existing = roots.get(request.rootRunId)
		if (existing !== undefined) { roots.set(request.rootRunId, existing + 1); return leaseFor(request.rootRunId) }
		if (roots.size < options.maxConcurrent) { roots.set(request.rootRunId, 1); return leaseFor(request.rootRunId) }
		if (waiters.length >= maxQueue) throw new AgentAdmissionRejectedError({ retryAfterMs })
		return new Promise<AgentAdmissionLease>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined
			const abort = () => finish(abortError(request.signal, 'agent', 'Agent admission was cancelled.'))
			const finish = (error: unknown) => {
				const index = waiters.indexOf(waiter)
				if (index >= 0) waiters.splice(index, 1)
				remove(); reject(error)
			}
			const remove = () => { request.signal.removeEventListener('abort', abort); if (timer !== undefined) clearTimeout(timer) }
			const waiter: Waiter = Object.freeze({ request, resolve, reject, remove })
			request.signal.addEventListener('abort', abort, { once: true })
			if (request.deadline !== undefined) timer = setTimeout(() => finish(new OperationTimeoutError('Agent admission timed out.', { scope: 'run', timeout_ms: 0 })), Math.max(0, request.deadline - Date.now()))
			waiters.push(waiter)
		})
	} })
}

/** Runs one complete agent loop inside an optional root-tree admission lease. */
export async function withAgentAdmission<T>(
	admission: AgentAdmission | undefined,
	request: AgentAdmissionRequest,
	operation: () => Promise<T>,
	options: AgentAdmissionRuntimeOptions = {},
): Promise<T> {
	if (admission === undefined) return operation()
	assertInitialLifecycle(request)
	const lifecycle = admissionSignal(request)
	let lease: AgentAdmissionLease
	try {
		lease = await acquire(admission, Object.freeze({ ...request, signal: lifecycle.signal }), lifecycle.signal, options)
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
		throw new InternalError('Agent admission release failed.', { reason: 'agent_admission_release_failed' })
	}
	if (failed) throw failure
	return result as T
}

async function acquire(
	admission: AgentAdmission,
	request: AgentAdmissionRequest,
	signal: AbortSignal,
	options: AgentAdmissionRuntimeOptions,
): Promise<AgentAdmissionLease> {
	let accepted = false
	const pending = Promise.resolve().then(() => admission.acquire(request))
	let lease: AgentAdmissionLease
	try {
		lease = await withAbortSignal(signal, 'agent', 'Agent admission was cancelled.', () => pending)
		accepted = true
	} catch (error) {
		if (!accepted) {
			void pending.then(async lateLease => {
				try { await lateLease.release() } catch { reportCleanup(options) }
			}, () => {})
		}
		if (
			error instanceof AgentAdmissionRejectedError
			|| error instanceof OperationCancelledError
			|| error instanceof OperationTimeoutError
		) throw error
		throw new InternalError('Agent admission failed.', { reason: 'agent_admission_failed' })
	}
	if (lease === null || typeof lease !== 'object' || typeof lease.release !== 'function') {
		throw new InternalError('Agent admission returned an invalid lease.', { reason: 'invalid_agent_admission_lease' })
	}
	return lease
}

function assertInitialLifecycle(request: AgentAdmissionRequest): void {
	if (request.signal.aborted) throw abortError(request.signal, 'agent', 'Agent admission was cancelled.')
	if (request.deadline !== undefined && request.deadline <= Date.now()) {
		throw new OperationTimeoutError('Agent admission timed out.', { scope: 'run', timeout_ms: 0 })
	}
}

function admissionSignal(request: AgentAdmissionRequest): Readonly<{ signal: AbortSignal; dispose(): void }> {
	if (request.deadline === undefined) return Object.freeze({ signal: request.signal, dispose() {} })
	const controller = new AbortController()
	const timeoutMs = Math.max(0, request.deadline - Date.now())
	const timeout = setTimeout(() => controller.abort(new OperationTimeoutError('Agent admission timed out.', { scope: 'run', timeout_ms: timeoutMs })), timeoutMs)
	const forward = () => controller.abort(abortError(request.signal, 'agent', 'Agent admission was cancelled.'))
	request.signal.addEventListener('abort', forward, { once: true })
	if (request.signal.aborted) forward()
	return Object.freeze({
		signal: controller.signal,
		dispose() { clearTimeout(timeout); request.signal.removeEventListener('abort', forward) },
	})
}

function reportCleanup(options: AgentAdmissionRuntimeOptions): void {
	try { options.logger?.warn('Agent admission release failed.', { reason: 'agent_admission_release_failed' }) } catch { /* diagnostics cannot change cleanup semantics */ }
}
