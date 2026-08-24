import { randomUUID } from 'node:crypto'
import type { SensitiveDataDetector } from '@purista/harness-guardrails'
import { loadNativePrivacyBinding, NativePrivacyBindingError, type NativePrivacyBinding } from './native-loader.js'

/** Exact entity categories implemented locally in the first native privacy release. */
export const NATIVE_PRIVACY_SUPPORTED_ENTITIES = [
  'EMAIL_ADDRESS',
  'PHONE_NUMBER',
  'CREDIT_CARD',
  'IP_ADDRESS',
  'IBAN_CODE',
  'US_SSN',
  'URL'
] as const

/** Native local detector configuration. */
export interface NativePrivacyDetectorOptions {
  /** Stable content-free identifier used in Guardrails telemetry. */
  readonly id: string
  /** Optional explicit binding injection reserved for deterministic tests. */
  readonly binding?: NativePrivacyBinding
}

/**
 * Creates the local Rust Node-API detector. It has no JavaScript, WASM, model,
 * filesystem, or network fallback when an appropriate prebuilt artifact is not available.
 *
 * @example
 * const detector = createNativePrivacyDetector({ id: 'native-privacy' })
 */
export function createNativePrivacyDetector(options: NativePrivacyDetectorOptions): SensitiveDataDetector {
  const id = requireId(options.id)
  const binding = options.binding ?? loadNativePrivacyBinding()
  return {
    id,
    executionMode: 'local',
    supportedEntities: NATIVE_PRIVACY_SUPPORTED_ENTITIES,
    async inspect(request) {
      if (request.signal.aborted) throw new NativePrivacyBindingError('aborted')
      const requestId = randomUUID()
      const onAbort = () => binding.cancel(requestId)
      request.signal.addEventListener('abort', onAbort, { once: true })
      try {
        return { findings: await binding.inspect(requestId, request.text, request.entities, request.scoreThreshold) }
      } catch {
        throw new NativePrivacyBindingError(request.signal.aborted ? 'aborted' : 'native_failure')
      } finally {
        request.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}

function requireId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new TypeError('Native privacy detector id must be a stable ASCII identifier.')
  return value
}
