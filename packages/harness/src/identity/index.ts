/**
 * Application identity bound to one Harness session.
 *
 * Both dimensions are deliberately optional: single-user applications do not
 * need synthetic identifiers, while multi-tenant applications can bind either
 * a tenant, a principal, or both.
 */
export interface HarnessIdentity {
  readonly tenantId?: string
  readonly principalId?: string
}

/** Validates and canonicalizes an identity without introducing default ids. */
export function normalizeHarnessIdentity(identity: HarnessIdentity | undefined): HarnessIdentity | undefined {
  if (!identity) return undefined
  const normalized: { tenantId?: string; principalId?: string } = {}
  for (const field of ['tenantId', 'principalId'] as const) {
    const value = identity[field]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
      throw new ValidationError(`Harness identity ${field} must be a non-empty string no longer than 256 characters.`, {
        where: 'memory_scope', issues: { reason: 'invalid_harness_identity', field }
      })
    }
    normalized[field] = value
  }
  return Object.freeze(normalized)
}

/** Compares presence and value; omitted dimensions are meaningful. */
export function sameHarnessIdentity(left: HarnessIdentity | undefined, right: HarnessIdentity | undefined): boolean {
  return left?.tenantId === right?.tenantId && left?.principalId === right?.principalId
}
import { ValidationError } from '../errors/index.js'
