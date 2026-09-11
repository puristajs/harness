import { StateError } from '../errors/index.js'
import { sessionSandboxBindingSchema, type SessionSandboxBinding } from '../sandbox/ownership.js'

/** Validates the only two mutable fields on a persisted session sandbox binding. */
export function assertSessionSandboxBindingTransition(
  existing: SessionSandboxBinding | undefined,
  next: SessionSandboxBinding | undefined,
  operation: 'getSession' | 'upsertSession'
): void {
  const current = parseBinding(existing, operation)
  const proposed = parseBinding(next, operation)
  if (!sameImmutableBinding(current, proposed)) {
    throw mismatch(operation)
  }
  if (current.registration === 'registered' && proposed.registration !== 'registered') throw mismatch(operation)
  if (current.disposed && !proposed.disposed) throw mismatch(operation)
  if (proposed.relation === 'borrowed' && (proposed.registration !== 'registered' || proposed.disposed)) throw mismatch(operation)
}

function parseBinding(value: SessionSandboxBinding | undefined, operation: 'getSession' | 'upsertSession'): SessionSandboxBinding {
  if (value === undefined) {
    throw new StateError('Session sandbox binding is unavailable.', { op: operation, reason: 'session_sandbox_binding_missing' })
  }
  const parsed = sessionSandboxBindingSchema.safeParse(value)
  if (parsed.success) return parsed.data
  throw new StateError('Session sandbox binding is invalid.', { op: operation, reason: 'session_sandbox_binding_invalid' })
}

function sameImmutableBinding(left: SessionSandboxBinding, right: SessionSandboxBinding): boolean {
  return left.owner.namespace === right.owner.namespace
    && left.owner.id === right.owner.id
    && left.owner.instanceId === right.owner.instanceId
    && left.owner.identity?.tenantId === right.owner.identity?.tenantId
    && left.owner.identity?.principalId === right.owner.identity?.principalId
    && (left.owner.identity === undefined) === (right.owner.identity === undefined)
    && left.relation === right.relation
    && left.policyDigest === right.policyDigest
}

function mismatch(operation: 'getSession' | 'upsertSession'): StateError {
  return new StateError('Session sandbox binding cannot be changed.', { op: operation, reason: 'session_sandbox_binding_mismatch' })
}
