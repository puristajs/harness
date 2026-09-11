import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HarnessError, type ExternalWaitOutcome } from '@purista/harness'

const identifierPattern = /^[A-Za-z0-9_.:@/-]+$/
const digestPattern = /^[a-f0-9]{64}$/

/** Bounded opaque identifier shared by review records and Harness external waits. */
export const reviewIdentifierSchema = z.string().min(1).max(200).regex(identifierPattern)

/** UTC timestamp with the exact precision required by Harness external waits. */
export const reviewTimestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
  'Expected a UTC ISO-8601 timestamp with millisecond precision.'
)

/** Immutable domain action that a review task can admit exactly once. */
export const paymentActionSchema = z.object({
  paymentId: reviewIdentifierSchema,
  amountCents: z.number().int().safe().positive(),
  targetRevision: z.number().int().safe().nonnegative()
}).strict()
export type PaymentAction = z.output<typeof paymentActionSchema>

/** Immutable evidence that binds a review task to one payment action. */
export const reviewDescriptorSchema = z.object({
  businessKey: reviewIdentifierSchema,
  actionSchema: z.literal('payment-action-v1'),
  definitionVersion: z.literal('payment-v1'),
  targetRevision: z.number().int().safe().nonnegative(),
  executionDigest: z.string().regex(digestPattern),
  expiresAt: reviewTimestampSchema
}).strict()
export type ReviewDescriptor = z.output<typeof reviewDescriptorSchema>

const reviewTaskStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled'])
const reviewTaskBaseSchema = z.object({
  businessKey: reviewIdentifierSchema,
  waitId: reviewIdentifierSchema,
  revision: z.number().int().safe().positive(),
  action: paymentActionSchema,
  descriptor: reviewDescriptorSchema,
  status: reviewTaskStatusSchema,
  decisionEventId: reviewIdentifierSchema.optional(),
  decidedBy: reviewIdentifierSchema.optional(),
  approvedRevision: z.number().int().safe().positive().optional()
}).strict()

/** Application-owned review state. Terminal states never transition again. */
export const reviewTaskSchema = reviewTaskBaseSchema.superRefine((task, ctx) => {
  const hasDecision = task.decisionEventId !== undefined || task.decidedBy !== undefined
  if ((task.decisionEventId === undefined) !== (task.decidedBy === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Decision fields must be present together.' })
  }
  if (task.status === 'pending' && (hasDecision || task.approvedRevision !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Pending tasks cannot contain terminal decision fields.' })
  }
  if (task.status === 'approved' && (!hasDecision || task.approvedRevision !== task.revision)) {
    ctx.addIssue({ code: 'custom', message: 'Approved tasks require their terminal revision.' })
  }
  if (task.status !== 'approved' && task.approvedRevision !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'Only approved tasks have an approved revision.' })
  }
  if (task.status !== 'pending' && task.status !== 'expired' && !hasDecision) {
    ctx.addIssue({ code: 'custom', message: 'Explicit terminal decisions require reviewer evidence.' })
  }
  if (task.descriptor.businessKey !== task.businessKey || task.descriptor.targetRevision !== task.action.targetRevision || task.descriptor.executionDigest !== actionDigest(task.action)) {
    ctx.addIssue({ code: 'custom', message: 'Task action and descriptor must bind exactly.' })
  }
})
export type ReviewTask = z.output<typeof reviewTaskSchema>

/** Receipt returned by the application-owned idempotent payment boundary. */
export const executionReceiptSchema = z.object({
  executionId: reviewIdentifierSchema,
  receiptId: reviewIdentifierSchema
}).strict()
export type ExecutionReceipt = z.output<typeof executionReceiptSchema>

const executionRecordBaseSchema = z.object({
  executionId: reviewIdentifierSchema,
  businessKey: reviewIdentifierSchema,
  approvedRevision: z.number().int().safe().positive(),
  action: paymentActionSchema,
  descriptor: reviewDescriptorSchema,
  status: z.enum(['claimed', 'succeeded']),
  receipt: executionReceiptSchema.optional()
}).strict()

/** Immutable application execution admission and, eventually, its receipt. */
export const executionRecordSchema = executionRecordBaseSchema.superRefine((record, ctx) => {
  if ((record.status === 'succeeded') !== (record.receipt !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Succeeded executions require exactly one receipt.' })
  }
  if (record.descriptor.businessKey !== record.businessKey || record.descriptor.targetRevision !== record.action.targetRevision || record.descriptor.executionDigest !== actionDigest(record.action)) {
    ctx.addIssue({ code: 'custom', message: 'Execution action and descriptor must bind exactly.' })
  }
  if (record.receipt !== undefined && record.receipt.executionId !== record.executionId) {
    ctx.addIssue({ code: 'custom', message: 'Receipt execution id must match its execution.' })
  }
})
export type ExecutionRecord = z.output<typeof executionRecordSchema>

const decideInputSchema = z.object({
  businessKey: reviewIdentifierSchema,
  expectedRevision: z.number().int().safe().positive(),
  eventId: reviewIdentifierSchema,
  outcome: z.custom<ExternalWaitOutcome>((value): value is ExternalWaitOutcome => value === 'approved' || value === 'rejected' || value === 'expired' || value === 'cancelled'),
  principalId: reviewIdentifierSchema,
  executionDigest: z.string().regex(digestPattern)
}).strict()
const claimInputSchema = z.object({
  businessKey: reviewIdentifierSchema,
  executionId: reviewIdentifierSchema,
  executionDigest: z.string().regex(digestPattern),
  authorized: z.boolean(),
  targetRevision: z.number().int().safe().nonnegative()
}).strict()

export type ReviewBindingReason =
  | 'missing_task'
  | 'unauthorized'
  | 'stale_action'
  | 'execution_conflict'
  | 'missing_claim'
  | 'invalid_receipt'
  | 'receipt_conflict'
  | 'invalid_request'
  | 'not_approved'
  | 'expired'
  | 'decision_conflict'

/** Safe, application-only failure at the review execution boundary. */
export class ReviewBindingError extends HarnessError {
  public constructor(reason: ReviewBindingReason) {
    super({
      code: 'REVIEW_BINDING_ERROR',
      category: 'state',
      retriable: false,
      message: 'Review execution binding failed.',
      meta: { reason }
    })
  }
}

/**
 * Application-owned deterministic store for the reference flow.
 *
 * Production applications replace this with a transactional service/store; Harness
 * owns neither these records nor review authentication and authorization.
 */
export class ReviewTaskStore {
  private readonly tasks = new Map<string, ReviewTask>()
  private readonly executions = new Map<string, ExecutionRecord>()
  private readonly executionByBusinessKey = new Map<string, string>()
  private serial = Promise.resolve()

  public constructor(private readonly options: { now: () => Date; reviewTtlMs: number }) {
    if (!options || typeof options.now !== 'function' || !Number.isSafeInteger(options.reviewTtlMs) || options.reviewTtlMs <= 0) {
      throw new ReviewBindingError('invalid_request')
    }
  }

  /** Creates a frozen task once, preserving its original deadline on retries. */
  public getOrCreate(input: { action: PaymentAction; waitId: string }): Promise<ReviewTask> {
    return this.atomic(() => {
      if (!record(input) || !hasOnlyKeys(input, ['action', 'waitId']) || !('action' in input)) throw new ReviewBindingError('invalid_request')
      const candidate = input
      const action = parse(paymentActionSchema, candidate['action'])
      const businessKey = businessKeyFor(action)
      const expectedWaitId = waitIdFor(businessKey)
      const existing = this.tasks.get(businessKey)
      if (existing) {
        if (!sameAction(existing.action, action)) throw new ReviewBindingError('stale_action')
        return snapshot(existing)
      }
      const waitId = parse(reviewIdentifierSchema, candidate['waitId'])
      if (waitId !== expectedWaitId) throw new ReviewBindingError('invalid_request')
      const now = validNow(this.options.now)
      const expiresAt = expiryAt(now, this.options.reviewTtlMs)
      const descriptor: ReviewDescriptor = {
        businessKey,
        actionSchema: 'payment-action-v1',
        definitionVersion: 'payment-v1',
        targetRevision: action.targetRevision,
        executionDigest: actionDigest(action),
        expiresAt
      }
      const task = reviewTaskSchema.parse({
        businessKey,
        waitId: expectedWaitId,
        revision: 1,
        action,
        descriptor,
        status: 'pending'
      })
      this.tasks.set(businessKey, task)
      return snapshot(task)
    })
  }

  /** Reads a task and atomically applies automatic expiry to pending work. */
  public get(businessKey: string): Promise<ReviewTask | undefined> {
    return this.atomic(() => {
      const parsedKey = parse(reviewIdentifierSchema, businessKey)
      const task = this.expire(this.tasks.get(parsedKey))
      return task ? snapshot(task) : undefined
    })
  }

  /** Applies one authenticated, authorized reviewer decision with CAS semantics. */
  public decide(input: { businessKey: string; expectedRevision: number; eventId: string; outcome: ExternalWaitOutcome; principalId: string; executionDigest: string }): Promise<ReviewTask> {
    return this.atomic<ReviewTask>(() => {
      const parsed = parse(decideInputSchema, input)
      const task = this.tasks.get(parsed.businessKey)
      if (!task) throw new ReviewBindingError('missing_task')
      if (task.descriptor.executionDigest !== parsed.executionDigest) throw new ReviewBindingError('stale_action')
      const current = this.expire(task)
      if (!current) throw new ReviewBindingError('missing_task')
      if (current.status !== 'pending') {
        if (current.decisionEventId === parsed.eventId && current.status === parsed.outcome && current.decidedBy === parsed.principalId) return snapshot(current)
        throw new ReviewBindingError('decision_conflict')
      }
      if (current.revision !== parsed.expectedRevision) throw new ReviewBindingError('decision_conflict')
      const revision = current.revision + 1
      const decided = reviewTaskSchema.parse({
        ...current,
        revision,
        status: parsed.outcome,
        decisionEventId: parsed.eventId,
        decidedBy: parsed.principalId,
        ...(parsed.outcome === 'approved' ? { approvedRevision: revision } : {})
      })
      this.tasks.set(decided.businessKey, decided)
      return snapshot(decided)
    })
  }

  /** Reads an existing immutable claim or receipt without changing review state. */
  public readExecution(executionId: string): Promise<ExecutionRecord | undefined> {
    return this.atomic(() => {
      const parsedId = parse(reviewIdentifierSchema, executionId)
      const record = this.executions.get(parsedId)
      return record ? snapshot(record) : undefined
    })
  }

  /**
   * Atomically admits one approved action. An existing identical claim is
   * returned before authorization/revision checks so retries keep their grant.
   */
  public claimApprovedExecution(input: { businessKey: string; executionId: string; executionDigest: string; authorized: boolean; targetRevision: number }): Promise<ExecutionRecord> {
    return this.atomic(() => {
      const parsed = parse(claimInputSchema, input)
      const existing = this.executions.get(parsed.executionId)
      if (existing) {
        if (existing.businessKey !== parsed.businessKey || existing.descriptor.executionDigest !== parsed.executionDigest || existing.action.targetRevision !== parsed.targetRevision) {
          throw new ReviewBindingError('execution_conflict')
        }
        return snapshot(existing)
      }
      const boundExecution = this.executionByBusinessKey.get(parsed.businessKey)
      if (boundExecution !== undefined) throw new ReviewBindingError('execution_conflict')
      const task = this.expire(this.tasks.get(parsed.businessKey))
      if (!task) throw new ReviewBindingError('missing_task')
      if (!parsed.authorized) throw new ReviewBindingError('unauthorized')
      if (task.status !== 'approved') throw new ReviewBindingError('not_approved')
      if (Date.parse(task.descriptor.expiresAt) <= validNow(this.options.now).getTime()) throw new ReviewBindingError('expired')
      if (task.descriptor.executionDigest !== parsed.executionDigest || task.action.targetRevision !== parsed.targetRevision || task.approvedRevision === undefined) {
        throw new ReviewBindingError('stale_action')
      }
      const record = executionRecordSchema.parse({
        executionId: parsed.executionId,
        businessKey: task.businessKey,
        approvedRevision: task.approvedRevision,
        action: task.action,
        descriptor: task.descriptor,
        status: 'claimed'
      })
      this.executions.set(record.executionId, record)
      this.executionByBusinessKey.set(record.businessKey, record.executionId)
      return snapshot(record)
    })
  }

  /** Records the executor receipt exactly once for a previously admitted claim. */
  public recordExecutionReceipt(receipt: ExecutionReceipt): Promise<ExecutionRecord> {
    return this.atomic(() => {
      const parsed = parseReceipt(receipt)
      const existing = this.executions.get(parsed.executionId)
      if (!existing) throw new ReviewBindingError('missing_claim')
      if (existing.status === 'succeeded') {
        if (existing.receipt?.receiptId === parsed.receiptId) return snapshot(existing)
        throw new ReviewBindingError('receipt_conflict')
      }
      const succeeded = executionRecordSchema.parse({ ...existing, status: 'succeeded', receipt: parsed })
      this.executions.set(succeeded.executionId, succeeded)
      return snapshot(succeeded)
    })
  }

  /** Returns the receipt embedded in an existing execution record. */
  public async readExecutionReceipt(executionId: string): Promise<ExecutionReceipt | undefined> {
    return (await this.readExecution(executionId))?.receipt
  }

  private async atomic<T>(operation: () => T): Promise<T> {
    const prior = this.serial
    let release: (() => void) | undefined
    this.serial = new Promise<void>((resolve) => { release = resolve })
    await prior
    try {
      return operation()
    } finally {
      release?.()
    }
  }

  private expire(task: ReviewTask | undefined): ReviewTask | undefined {
    if (!task || task.status !== 'pending') return task
    if (validNow(this.options.now).getTime() < Date.parse(task.descriptor.expiresAt)) return task
    const expired = reviewTaskSchema.parse({ ...task, revision: task.revision + 1, status: 'expired' })
    this.tasks.set(expired.businessKey, expired)
    return expired
  }
}

/** Computes the exact immutable action digest required by the review contract. */
export function actionDigest(action: PaymentAction): string {
  const parsed = parse(paymentActionSchema, action)
  return sha256(JSON.stringify([parsed.paymentId, parsed.amountCents, parsed.targetRevision, 'payment-action-v1', 'payment-v1']))
}

/** Derives bounded opaque identities without interpolating the raw payment id. */
export function reviewIdentity(action: PaymentAction): { businessKey: string; sessionId: string; runId: string; waitId: string } {
  const parsed = parse(paymentActionSchema, action)
  const businessKey = businessKeyFor(parsed)
  const digest = sha256(JSON.stringify([businessKey, 'payment-v1']))
  return {
    businessKey,
    sessionId: `payment:${digest}`,
    runId: `payment-review:${digest}`,
    waitId: `payment-wait:${digest}`
  }
}

function businessKeyFor(action: PaymentAction): string {
  return parse(reviewIdentifierSchema, `payment:${action.paymentId}`)
}

function waitIdFor(businessKey: string): string {
  return parse(reviewIdentifierSchema, `payment-wait:${sha256(JSON.stringify([businessKey, 'payment-v1']))}`)
}

function validNow(now: () => Date): Date {
  const value = now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ReviewBindingError('invalid_request')
  return value
}

function expiryAt(now: Date, ttlMs: number): string {
  const expiry = new Date(now.getTime() + ttlMs)
  if (!Number.isFinite(expiry.getTime())) throw new ReviewBindingError('invalid_request')
  return expiry.toISOString()
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ReviewBindingError('invalid_request')
  return parsed.data
}

function parseReceipt(value: unknown): ExecutionReceipt {
  const parsed = executionReceiptSchema.safeParse(value)
  if (!parsed.success) throw new ReviewBindingError('invalid_receipt')
  return parsed.data
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

function sameAction(left: PaymentAction, right: PaymentAction): boolean {
  return left.paymentId === right.paymentId && left.amountCents === right.amountCents && left.targetRevision === right.targetRevision
}

function snapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
