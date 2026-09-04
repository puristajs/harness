import { HarnessConfigError } from '../errors/index.js'

/** Immutable validated W3C Trace Context carrier. */
export interface HarnessTraceContext { readonly traceparent: string; readonly tracestate?: string }

export function normalizeHarnessTraceContext(value: HarnessTraceContext): HarnessTraceContext {
	const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value.traceparent)
	const valid = match !== null && match[1] !== 'ff' && match[2] !== '00000000000000000000000000000000' && match[3] !== '0000000000000000'
	if (!valid || (value.tracestate !== undefined && (value.tracestate.length > 512 || /[\r\n]/.test(value.tracestate)))) {
		throw new HarnessConfigError('Trace context is invalid.', { reason: 'INVALID_TRACE_CONTEXT', path: 'trace' })
	}
	return Object.freeze({ traceparent: value.traceparent, ...(value.tracestate === undefined ? {} : { tracestate: value.tracestate }) })
}
