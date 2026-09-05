import { OperationCancelledError, OperationTimeoutError } from '../../errors/index.js'
import { abortError } from '../../runtime/abort.js'

/** Runs one MCP operation with inherited cancellation and an optional timeout. */
export async function withMcpTimeout<T>(
  options: Readonly<{ signal?: AbortSignal; timeoutMs?: number; scope: 'tool' }>,
  operation: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  if (options.signal?.aborted) throw abortError(options.signal, 'tool', 'MCP tool operation was cancelled.')
  if (!options.timeoutMs || options.timeoutMs <= 0) {
    try { return await operation(options.signal) }
    catch (error) {
      if (error instanceof OperationCancelledError || error instanceof OperationTimeoutError) throw error
      if (options.signal?.aborted) throw abortError(options.signal, 'tool', 'MCP tool operation was cancelled.')
      throw error
    }
  }
  const controller = new AbortController()
  const relay = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', relay, { once: true })
  if (options.signal?.aborted) relay()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new OperationTimeoutError('MCP tool operation timed out.', { scope: options.scope, timeout_ms: options.timeoutMs! })
      controller.abort(error)
      reject(error)
    }, options.timeoutMs)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } catch (error) {
    if (controller.signal.reason instanceof OperationTimeoutError) throw controller.signal.reason
    if (controller.signal.aborted) throw abortError(controller.signal, 'tool', 'MCP tool operation was cancelled.')
    throw error
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    options.signal?.removeEventListener('abort', relay)
  }
}
