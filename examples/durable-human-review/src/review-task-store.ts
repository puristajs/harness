import { createHash } from 'node:crypto'
import { HarnessError } from '@purista/harness'

export type ReviewOutcome = 'approved' | 'rejected' | 'expired' | 'cancelled'
export type ReviewTaskStatus = 'pending' | ReviewOutcome | 'consumed'

/** Immutable, versioned evidence for exactly one business action. */
export interface ActionDescriptor {
  readonly businessKey: string
  readonly actionSchema: string
  readonly definitionVersion: string
  readonly targetRevision: string
  readonly executionDigest: string
  readonly expiresAt: string
}

export interface ReviewTask {
  readonly businessKey: string
  readonly waitId: string
  readonly revision: number
  readonly descriptor: ActionDescriptor
  readonly status: ReviewTaskStatus
  readonly decisionEventId?: string
  readonly decidedBy?: string
}

export type DecideResult =
  | { readonly kind: 'applied'; readonly task: ReviewTask }
  | { readonly kind: 'duplicate'; readonly task: ReviewTask }
  | { readonly kind: 'stale' | 'already_decided' | 'expired' | 'not_found' }

/** Stable, content-safe failure used when an approval no longer binds the action. */
export class ReviewBindingError extends HarnessError {
  public constructor(reason: 'not_approved' | 'descriptor_mismatch') {
    super({
      code: 'REVIEW_BINDING_ERROR',
      category: 'state',
      retriable: false,
      message: reason === 'not_approved' ? 'Review was not approved.' : 'Approved review is stale or no longer binds the requested action.',
      meta: { reason }
    })
  }
}

/** Application-owned, deterministic reference store. Replace with transactional persistence in production. */
export class ReviewTaskStore {
  private readonly tasks = new Map<string, ReviewTask>()

  public create(descriptor: ActionDescriptor): ReviewTask {
    const existing = this.expire(this.tasks.get(descriptor.businessKey))
    if (existing) {
      if (existing.descriptor.executionDigest !== descriptor.executionDigest || existing.descriptor.targetRevision !== descriptor.targetRevision || existing.descriptor.definitionVersion !== descriptor.definitionVersion) {
        throw new Error('Review business key is already bound to a different action descriptor.')
      }
      return existing
    }
    const task: ReviewTask = {
      businessKey: descriptor.businessKey,
      waitId: `review:${sha256(descriptor.businessKey).slice(0, 24)}`,
      revision: 1,
      descriptor,
      status: 'pending'
    }
    this.tasks.set(task.businessKey, task)
    return task
  }

  /** Caller must authenticate/authorize `principalId` before this command. */
  public decide(input: { businessKey: string; expectedRevision: number; outcome: Exclude<ReviewOutcome, 'expired'>; eventId: string; principalId: string }): DecideResult {
    const task = this.expire(this.tasks.get(input.businessKey))
    if (!task) return { kind: 'not_found' }
    if (task.status !== 'pending') {
      return task.decisionEventId === input.eventId ? { kind: 'duplicate', task } : { kind: task.status === 'expired' ? 'expired' : 'already_decided' }
    }
    if (task.revision !== input.expectedRevision) return { kind: 'stale' }
    const decided: ReviewTask = { ...task, status: input.outcome, decisionEventId: input.eventId, decidedBy: input.principalId }
    this.tasks.set(task.businessKey, decided)
    return { kind: 'applied', task: decided }
  }

  public read(businessKey: string): ReviewTask | undefined {
    return this.expire(this.tasks.get(businessKey))
  }

  /** Recheck the immutable evidence before the final side effect. */
  public consumeApproved(businessKey: string, current: Omit<ActionDescriptor, 'businessKey'>): ReviewTask {
    const task = this.expire(this.tasks.get(businessKey))
    if (!task || task.status !== 'approved') throw new ReviewBindingError('not_approved')
    const descriptor = task.descriptor
    if (descriptor.executionDigest !== current.executionDigest || descriptor.targetRevision !== current.targetRevision || descriptor.definitionVersion !== current.definitionVersion || descriptor.actionSchema !== current.actionSchema || Date.parse(descriptor.expiresAt) <= Date.now()) {
      throw new ReviewBindingError('descriptor_mismatch')
    }
    const consumed: ReviewTask = { ...task, status: 'consumed' }
    this.tasks.set(businessKey, consumed)
    return consumed
  }

  private expire(task: ReviewTask | undefined): ReviewTask | undefined {
    if (!task || task.status !== 'pending' || Date.parse(task.descriptor.expiresAt) > Date.now()) return task
    const expired: ReviewTask = { ...task, status: 'expired' }
    this.tasks.set(task.businessKey, expired)
    return expired
  }
}

export function actionDigest(value: unknown): string {
  return sha256(JSON.stringify(value))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
