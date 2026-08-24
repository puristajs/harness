import type { AdapterCapabilities } from './capabilities.js'
import { HarnessError } from '../errors/harness-error.js'

/** Terminal result accepted by a durable external wait. */
export type ExternalWaitOutcome = 'approved' | 'rejected' | 'expired' | 'cancelled'

/** State persisted by an external-wait adapter. */
export type ExternalWaitStatus = 'waiting' | ExternalWaitOutcome

/** Opaque, non-content request stored by an external-wait adapter. */
export interface ExternalWaitRequest {
  /** Application-generated opaque correlation value. It must be stable across retries. */
  readonly waitId: string
  /** Bounded application-owned wait category, for example `human_review`. */
  readonly kind: string
  /** Version of the application decision schema; no decision content is stored here. */
  readonly schemaVersion: string
  /** Version of the workflow/action definition that created this wait. */
  readonly definitionVersion: string
  /** ISO-8601 deadline. An expired pending wait resolves as `expired`. */
  readonly deadline: string
}

/** Safe snapshot returned by a wait adapter. */
export interface ExternalWaitSnapshot extends ExternalWaitRequest {
  readonly status: ExternalWaitStatus
  readonly createdAt: string
  readonly resolvedAt?: string
  /** Opaque, unique terminal delivery identity when resolved by a signal. */
  readonly eventId?: string
}

/** Idempotent terminal delivery from the application-owned review transport. */
export interface ExternalWaitSignal {
  readonly waitId: string
  readonly eventId: string
  readonly outcome: ExternalWaitOutcome
  readonly observedAt?: string
}

/** Result of one idempotent terminal signal attempt. */
export type ExternalWaitSignalResult =
  | { readonly kind: 'applied'; readonly snapshot: ExternalWaitSnapshot }
  | { readonly kind: 'duplicate'; readonly snapshot: ExternalWaitSnapshot }
  | { readonly kind: 'already_terminal'; readonly snapshot: ExternalWaitSnapshot }
  | { readonly kind: 'not_found' }

/** Idempotent registration result. */
export interface ExternalWaitRegistration {
  readonly created: boolean
  readonly snapshot: ExternalWaitSnapshot
}

/**
 * Provider-neutral persistence port for a checkpoint-and-signal wait.
 *
 * Authentication, reviewer authorization, review content, action binding, and
 * notification delivery are deliberately application-owned. The adapter stores
 * only the safe request shape above and deterministic signal identities.
 */
export interface DurableExternalWaitAdapter extends AdapterCapabilities {
  readonly id?: string
  register(request: ExternalWaitRequest): Promise<ExternalWaitRegistration>
  get(waitId: string): Promise<ExternalWaitSnapshot | undefined>
  signal(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult>
  cancel(waitId: string, eventId: string, observedAt?: string): Promise<ExternalWaitSignalResult>
}

/** Thrown to suspend a durable workflow after a wait was persisted. */
export class ExternalWaitPendingError extends HarnessError {
  public readonly snapshot: ExternalWaitSnapshot

  public constructor(snapshot: ExternalWaitSnapshot) {
    super({
      code: 'EXTERNAL_WAIT_PENDING', category: 'state', retriable: true,
      message: 'Workflow is waiting for an external signal.',
      meta: { kind: snapshot.kind, status: snapshot.status }
    })
    this.snapshot = snapshot
  }
}

/** Error raised for an invalid or unavailable generic external-wait operation. */
export class ExternalWaitError extends HarnessError {
  public constructor(
    message: string,
    public readonly reason: 'invalid_request' | 'request_conflict' | 'adapter_unavailable' | 'durable_required'
  ) {
    super({ code: 'EXTERNAL_WAIT_ERROR', category: 'state', retriable: false, message, meta: { reason } })
  }
}

/** Checks the safe, portable request subset before persisting it. */
export function validateExternalWaitRequest(request: ExternalWaitRequest): void {
  for (const [field, value] of Object.entries(request)) {
    if (field === 'deadline') continue
    if (typeof value !== 'string' || value.length < 1 || value.length > 200 || !/^[A-Za-z0-9_.:@/-]+$/.test(value)) {
      throw new ExternalWaitError(`External wait ${field} must be a bounded identifier.`, 'invalid_request')
    }
  }
  if (!Number.isFinite(Date.parse(request.deadline))) {
    throw new ExternalWaitError('External wait deadline must be an ISO-8601 timestamp.', 'invalid_request')
  }
}

/** Deterministic in-memory external-wait adapter for tests and local examples. */
export class InMemoryExternalWaitAdapter implements DurableExternalWaitAdapter {
  public readonly id = 'in_memory_external_wait'
  public readonly capabilities = ['external_wait.durable', 'external_wait.signal'] as const
  private readonly waits = new Map<string, ExternalWaitSnapshot>()
  private readonly eventIds = new Map<string, Set<string>>()

  public constructor(private readonly now: () => Date = () => new Date()) {}

  public async register(request: ExternalWaitRequest): Promise<ExternalWaitRegistration> {
    validateExternalWaitRequest(request)
    const existing = this.expire(this.waits.get(request.waitId))
    if (existing) {
      if (!sameRequest(existing, request)) throw new ExternalWaitError('External wait id is already bound to a different request.', 'request_conflict')
      return { created: false, snapshot: existing }
    }
    const snapshot: ExternalWaitSnapshot = { ...request, status: 'waiting', createdAt: this.now().toISOString() }
    this.waits.set(request.waitId, snapshot)
    this.eventIds.set(request.waitId, new Set())
    return { created: true, snapshot }
  }

  public async get(waitId: string): Promise<ExternalWaitSnapshot | undefined> {
    return this.expire(this.waits.get(waitId))
  }

  public async signal(signal: ExternalWaitSignal): Promise<ExternalWaitSignalResult> {
    return this.resolve(signal.waitId, signal.eventId, signal.outcome, signal.observedAt)
  }

  public async cancel(waitId: string, eventId: string, observedAt?: string): Promise<ExternalWaitSignalResult> {
    return this.resolve(waitId, eventId, 'cancelled', observedAt)
  }

  private resolve(waitId: string, eventId: string, outcome: ExternalWaitOutcome, observedAt?: string): ExternalWaitSignalResult {
    if (!eventId || eventId.length > 200) throw new ExternalWaitError('External wait eventId must be a bounded identifier.', 'invalid_request')
    const snapshot = this.expire(this.waits.get(waitId))
    if (!snapshot) return { kind: 'not_found' }
    const delivered = this.eventIds.get(waitId)!
    if (delivered.has(eventId)) return { kind: 'duplicate', snapshot }
    delivered.add(eventId)
    if (snapshot.status !== 'waiting') return { kind: 'already_terminal', snapshot }
    const resolved: ExternalWaitSnapshot = { ...snapshot, status: outcome, resolvedAt: observedAt ?? this.now().toISOString(), eventId }
    this.waits.set(waitId, resolved)
    return { kind: 'applied', snapshot: resolved }
  }

  private expire(snapshot: ExternalWaitSnapshot | undefined): ExternalWaitSnapshot | undefined {
    if (!snapshot || snapshot.status !== 'waiting' || Date.parse(snapshot.deadline) > this.now().getTime()) return snapshot
    const expired: ExternalWaitSnapshot = { ...snapshot, status: 'expired', resolvedAt: this.now().toISOString() }
    this.waits.set(snapshot.waitId, expired)
    return expired
  }
}

/** Creates the deterministic test/local adapter. */
export function inMemoryExternalWait(options: { now?: () => Date } = {}): InMemoryExternalWaitAdapter {
  return new InMemoryExternalWaitAdapter(options.now)
}

function sameRequest(snapshot: ExternalWaitSnapshot, request: ExternalWaitRequest): boolean {
  return snapshot.kind === request.kind
    && snapshot.schemaVersion === request.schemaVersion
    && snapshot.definitionVersion === request.definitionVersion
    && snapshot.deadline === request.deadline
}
