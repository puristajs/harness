import { HarnessConfigError, OperationCancelledError, OperationTimeoutError } from '../errors/index.js'
import { abortError } from '../runtime/abort.js'
import type { DecisionExecutionContext } from './types.js'

/**
 * Executes one decision callback with a single bounded child signal.
 *
 * Parent cancellation keeps its existing normalized reason. Expiration of this
 * callback's own deadline is reported as an `OperationTimeoutError` scoped to
 * `decision`; owners project that timeout into their fail-closed error.
 */
export async function runDecisionOperation<T>(
  context: DecisionExecutionContext,
  operation: (signal: AbortSignal) => Promise<T> | T
): Promise<T> {
  if (!Number.isFinite(context.deadline)) {
    throw new HarnessConfigError('Decision deadline is invalid.', { reason: 'invalid_decision_deadline' })
  }
  if (context.signal.aborted) throw normalizedParentAbort(context.signal)

  const remainingMs = context.deadline - Date.now()
  if (remainingMs <= 0) throw decisionTimeout(0)

  const child = new AbortController()
  let settled = false
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let rejectBoundary: ((error: unknown) => void) | undefined
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject })
  const settle = (error: unknown): void => {
    if (settled) return
    settled = true
    child.abort(error)
    rejectBoundary?.(error)
  }
  const onParentAbort = () => settle(normalizedParentAbort(context.signal))
  context.signal.addEventListener('abort', onParentAbort, { once: true })
  timeoutId = setTimeout(() => {
    if (context.signal.aborted) {
      settle(normalizedParentAbort(context.signal))
      return
    }
    settle(decisionTimeout(Math.max(0, remainingMs)))
  }, remainingMs)

  try {
    if (context.signal.aborted) throw normalizedParentAbort(context.signal)
    const result = Promise.resolve(operation(child.signal))
    return await Promise.race([result, boundary])
  } finally {
    settled = true
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    context.signal.removeEventListener('abort', onParentAbort)
  }
}

function normalizedParentAbort(signal: AbortSignal): OperationCancelledError | OperationTimeoutError {
  return abortError(signal, 'agent', 'Decision operation cancelled.')
}

function decisionTimeout(timeoutMs: number): OperationTimeoutError {
  return new OperationTimeoutError('Decision operation timed out.', { scope: 'decision', timeout_ms: Math.ceil(timeoutMs) })
}
