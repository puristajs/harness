import {
  OperationCancelledError,
  OperationTimeoutError
} from '../errors/index.js'

type AbortScope = 'run' | 'model' | 'tool' | 'workflow' | 'agent' | 'sandbox' | 'memory' | 'workspace'

export function abortError(signal: AbortSignal, scope: AbortScope, message: string): OperationCancelledError | OperationTimeoutError {
  if (signal.reason instanceof OperationTimeoutError) return signal.reason
  if (signal.reason instanceof OperationCancelledError) return signal.reason
  return new OperationCancelledError(message, { scope }, signal.reason)
}

export async function withAbortSignal<T>(
  signal: AbortSignal,
  scope: AbortScope,
  message: string,
  fn: () => Promise<T>
): Promise<T> {
  if (signal.aborted) throw abortError(signal, scope, message)
  let abortListener: (() => void) | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => reject(abortError(signal, scope, message))
    signal.addEventListener('abort', abortListener, { once: true })
    if (signal.aborted) abortListener()
  })
  try {
    return await Promise.race([fn(), abortPromise])
  } catch (error) {
    if (error instanceof OperationCancelledError || error instanceof OperationTimeoutError) throw error
    if (signal.aborted) throw abortError(signal, scope, message)
    throw error
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener)
  }
}
