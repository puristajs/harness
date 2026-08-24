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
