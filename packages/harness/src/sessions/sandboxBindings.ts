import { createHash } from 'node:crypto'

import { StateError } from '../errors/index.js'
import type { SessionRecord } from '../models/state.js'
import {
  sandboxOwnerSchema,
  sandboxPartitionSchema,
  sandboxScopeSchema,
  sessionSandboxBindingSchema,
  type SandboxOwner,
  type SandboxPolicy,
  type SandboxPartition,
  type SandboxScope,
  type SessionSandboxBinding
} from '../sandbox/ownership.js'

const SESSION_SANDBOX_BINDING_LAYOUT = 'purista.harness.session-sandbox-binding/v1'

/** Inputs required to derive a session's immutable sandbox-owner binding. */
export interface CreateSessionSandboxBindingOptions {
  readonly harnessName: string
  readonly record: Pick<SessionRecord, 'id' | 'instanceId' | 'identity'>
  /** A composition-owned, pre-registered owner shared by authorized sessions. */
  readonly sandboxOwner?: SandboxOwner
}

/**
 * Derives the immutable owner binding for one persisted session incarnation.
 *
 * An omitted owner is private to the Harness session. An explicit owner is a
 * borrowed, already registered composition resource; this helper does not
 * allocate files, compute, or an adapter catalog entry.
 */
export function createSessionSandboxBinding(options: CreateSessionSandboxBindingOptions): SessionSandboxBinding {
  const owner = options.sandboxOwner ?? sandboxOwnerSchema.parse({
    namespace: options.harnessName,
    id: options.record.id,
    instanceId: options.record.instanceId,
    ...(options.record.identity ? { identity: options.record.identity } : {})
  })
  const relation = options.sandboxOwner === undefined ? 'owned' : 'borrowed'
  return sessionSandboxBindingSchema.parse({
    owner,
    relation,
    registration: relation === 'owned' ? 'pending' : 'registered',
    policyDigest: sessionSandboxBindingDigest(owner, relation),
    disposed: false
  })
}

/** Returns a binding after an owned adapter registration has been durably acknowledged. */
export function acknowledgeSandboxOwnerRegistration(binding: SessionSandboxBinding): SessionSandboxBinding {
  const parsed = sessionSandboxBindingSchema.parse(binding)
  if (parsed.registration === 'registered') return parsed
  return sessionSandboxBindingSchema.parse({ ...parsed, registration: 'registered' })
}

/** Returns whether two bindings retain the same immutable owner and layout tuple. */
export function sameSessionSandboxBindingIdentity(left: SessionSandboxBinding, right: SessionSandboxBinding): boolean {
  const first = sessionSandboxBindingSchema.parse(left)
  const second = sessionSandboxBindingSchema.parse(right)
  return first.owner.namespace === second.owner.namespace
    && first.owner.id === second.owner.id
    && first.owner.instanceId === second.owner.instanceId
    && first.owner.identity?.tenantId === second.owner.identity?.tenantId
    && first.owner.identity?.principalId === second.owner.identity?.principalId
    && (first.owner.identity === undefined) === (second.owner.identity === undefined)
    && first.relation === second.relation
    && first.policyDigest === second.policyDigest
}

/**
 * Builds a topology-transparent scope for an already registered owner binding.
 *
 * A pending owner has no authority to allocate a partition; callers must first
 * persist the registration acknowledgement through Harness storage.
 */
export function sandboxScopeForBinding(
  binding: SessionSandboxBinding,
  partition: SandboxPartition,
  lifetime: 'session' | 'run',
  runId?: string
): SandboxScope {
  const parsed = sessionSandboxBindingSchema.parse(binding)
  if (parsed.registration !== 'registered') {
    throw new StateError('Sandbox owner registration has not been acknowledged.', {
      op: 'upsertSession', reason: 'owner_registration_pending'
    })
  }
  const resolvedPartition = sandboxPartitionSchema.parse(partition)
  if (lifetime === 'session') return sandboxScopeSchema.parse({ owner: parsed.owner, partition: resolvedPartition, lifetime })
  return sandboxScopeSchema.parse({ owner: parsed.owner, partition: resolvedPartition, lifetime, runId })
}

/** Registered definition identity used to resolve a private sandbox partition. */
export interface SandboxPartitionTarget {
  readonly kind: 'agent' | 'workflow'
  readonly harnessName: string
  readonly id: string
}

/**
 * Resolves one already-selected sharing policy without reading session state.
 *
 * Callers decide precedence; this function only converts the closed policy
 * vocabulary to the canonical sandbox partition shape.
 */
export function resolveSandboxPartition(
  policy: SandboxPolicy | undefined,
  target: SandboxPartitionTarget,
  inherited?: SandboxPartition
): SandboxPartition {
  if (policy === undefined || policy === 'inherit') {
    return inherited ?? { kind: 'shared' }
  }
  if (policy === 'private') {
    return target.kind === 'agent'
      ? { kind: 'agent', harnessName: target.harnessName, id: target.id }
      : { kind: 'workflow', harnessName: target.harnessName, id: target.id }
  }
  return { kind: 'group', id: policy.group }
}

function sessionSandboxBindingDigest(owner: SandboxOwner, relation: SessionSandboxBinding['relation']): string {
  return createHash('sha256').update(JSON.stringify([
    SESSION_SANDBOX_BINDING_LAYOUT,
    owner.namespace,
    owner.id,
    owner.instanceId,
    owner.identity !== undefined,
    owner.identity?.tenantId !== undefined,
    owner.identity?.tenantId ?? null,
    owner.identity?.principalId !== undefined,
    owner.identity?.principalId ?? null,
    relation
  ])).digest('hex')
}
