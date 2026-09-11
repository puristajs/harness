import { createHash } from 'node:crypto'

/**
 * SHA-256 hex digest used for privacy-safe telemetry reference attributes
 * (`harness.workspace.ref_hash`, `harness.workspace.checkpoint_ref_hash`, ...).
 * Raw refs stay in return values and persisted records only (spec 14, 21 §15).
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
