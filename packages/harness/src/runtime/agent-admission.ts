import type { AgentAdmission, AgentAdmissionLease, AgentAdmissionRequest } from '../ports/agent-admission.js'
import {
	AgentAdmissionRejectedError,
	InternalError,
	OperationCancelledError,
	OperationTimeoutError,
} from '../errors/index.js'
import { abortError, withAbortSignal } from './abort.js'
import type { Logger } from '../logger/index.js'

export interface AgentAdmissionRuntimeOptions {
	readonly logger?: Pick<Logger, 'warn'>
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
