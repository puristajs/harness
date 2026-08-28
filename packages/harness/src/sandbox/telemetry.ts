import {
  OperationCancelledError,
  SandboxConflictError,
  SandboxError,
  SandboxPermissionDeniedError,
  SandboxQuotaExceededError,
  SandboxStateLostError
} from '../errors/index.js'
import { telemetryErrorType, type SpanAttrs, type TelemetryShim } from '../telemetry/index.js'

/** Content-free public sandbox operations used by lifecycle and administration telemetry. */
export type SandboxTelemetryOperation =
  | 'register_owner'
  | 'open'
  | 'detach'
  | 'terminate'
  | 'list'
  | 'purge'
  | 'sweep'
  | 'delete_snapshot'

/**
 * Records one public sandbox operation without exposing scopes, owners, paths, or provider references.
 *
 * Adapter packages may use this helper with the telemetry inherited through
 * {@link HarnessAdapterContext}; `adapterId` is normalized to a bounded
 * low-cardinality value before it becomes a span or metric attribute.
 */
export async function withSandboxTelemetry<T>(
  telemetry: TelemetryShim | undefined,
  adapterId: string,
  operation: SandboxTelemetryOperation,
  action: () => Promise<T>,
  successAttributes?: (result: T) => SpanAttrs
): Promise<T> {
  if (!telemetry) return await action()
  const attrs: SpanAttrs = {
    'harness.sandbox.adapter': normalizeAdapterId(adapterId),
    'harness.sandbox.operation': operation
  }
  const started = Date.now()
  return await telemetry.span(`harness.sandbox.${operation}`, attrs, async (span) => {
    try {
      const result = await action()
      attrs['harness.sandbox.outcome'] = 'success'
      Object.assign(attrs, successAttributes?.(result))
      return result
    } catch (error) {
      attrs['harness.sandbox.outcome'] = sandboxOutcome(error)
      attrs['error.type'] = telemetryErrorType(error)
      throw error
    } finally {
      span.setAttributes(attrs)
      telemetry.recordCounter('harness.sandbox.operations', 1, attrs)
      telemetry.recordHistogram('harness.sandbox.operation.duration', (Date.now() - started) / 1000, attrs)
    }
  })
}

function normalizeAdapterId(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : 'custom_sandbox'
}

function sandboxOutcome(error: unknown): 'denied' | 'conflict' | 'state_lost' | 'quota' | 'cleanup_pending' | 'cancelled' | 'error' {
  if (error instanceof SandboxPermissionDeniedError) return 'denied'
  if (error instanceof SandboxConflictError) return 'conflict'
  if (error instanceof SandboxStateLostError) return 'state_lost'
  if (error instanceof SandboxQuotaExceededError) return 'quota'
  if (error instanceof OperationCancelledError) return 'cancelled'
  if (error instanceof SandboxError && error.meta?.['reason'] === 'cleanup_pending') return 'cleanup_pending'
  return 'error'
}
