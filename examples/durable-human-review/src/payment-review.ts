import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  defineHarness,
  ExternalWaitPendingError,
  InMemoryHarnessStorage,
  inMemorySandbox,
  type HarnessStorage,
  type JsonValue,
  type Sandbox,
} from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import {
  actionDigest,
  executionReceiptSchema,
  executionRecordSchema,
  paymentActionSchema,
  reviewIdentity,
  reviewTaskSchema,
  ReviewBindingError,
  type ExecutionReceipt,
  type PaymentAction,
  type ReviewTaskStore,
} from './review-task-store.js'

const paymentInputSchema = paymentActionSchema
const paymentResultSchema = z
  .object({ status: z.enum(['waiting', 'approved', 'rejected', 'expired', 'cancelled']) })
  .strict()
const executionStepOutputSchema = z.object({ receiptId: z.string().min(1).max(200) }).strict()
type PaymentInput = z.output<typeof paymentInputSchema>
type PaymentResult = z.output<typeof paymentResultSchema>

/**
 * Application-owned idempotent side-effect boundary.
 *
 * The executor must return the same receipt for the same key and immutable action.
 */
export interface PaymentExecutor {
  execute(input: { action: Readonly<PaymentAction>; idempotencyKey: string }): Promise<ExecutionReceipt>
}

/** Application callbacks that are intentionally outside Harness governance and approval. */
export interface PaymentReviewAdmission {
  authorizeExecution(action: Readonly<PaymentAction>): Promise<boolean>
  readTargetRevision(paymentId: string): Promise<number>
}

/** Configuration for the application-owned durable-review composition. */
export interface PaymentReviewExampleOptions extends PaymentReviewAdmission {
  readonly tasks: ReviewTaskStore
  readonly payments: PaymentExecutor
  readonly storage?: HarnessStorage
  readonly sandbox?: Sandbox
  /** Application composition clock. Pass the same clock to in-memory storage and task store in tests. */
  readonly now?: () => Date
}

/**
 * Builds the reference workflow around the generic Harness wait primitive.
 *
 * Reviewer tasks, authentication, authorization, execution receipts and retention
 * stay in the application. Harness only persists the safe wait/checkpoint state.
 */
export function createPaymentReviewExample(input: PaymentReviewExampleOptions) {
  const now = input.now ?? (() => new Date())
  const storage = input.storage ?? new InMemoryHarnessStorage({ now })
  const harness = defineHarness({ name: 'durable-payment-review-example' })
    .sandbox(input.sandbox ?? inMemorySandbox())
    .storage(storage)
    .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
    .agent('noop', { model: 'fake', instructions: 'No model call is needed for this reference workflow.' })
    .workflow('review_payment', {
      input: paymentInputSchema,
      output: paymentResultSchema,
      handler: async (ctx): Promise<PaymentResult> => {
        const action = paymentInputSchema.parse(ctx.input)
        const identity = reviewIdentity(action)
        const checkpointTask = reviewTaskSchema.parse(
          await ctx.step('create-review-task-v1', async () => {
            const task = await input.tasks.getOrCreate({ action, waitId: identity.waitId })
            return checkpointTaskJson(task)
          }),
        )

        // This binding runs outside every replay-skipped step. A checkpoint or
        // prior receipt never lets changed invocation input bypass admission.
        const task = await input.tasks.get(identity.businessKey)
        if (!task) throw new ReviewBindingError('missing_task')
        assertBoundTask(task, checkpointTask, action, identity)

        const outcome = await ctx.externalWait.wait({
          waitId: task.waitId,
          kind: 'human_review',
          schemaVersion: 'payment-review-v1',
          definitionVersion: task.descriptor.definitionVersion,
          deadline: task.descriptor.expiresAt,
        })
        if (outcome.status !== 'approved') return { status: outcome.status }

        executionStepOutputSchema.parse(
          await ctx.step('execute-payment-v1', async () => {
            const currentTask = await input.tasks.get(identity.businessKey)
            if (!currentTask) throw new ReviewBindingError('missing_task')
            assertBoundTask(currentTask, checkpointTask, action, identity)
            const existing = await input.tasks.readExecution(ctx.runId)
            const claimed = existing
              ? assertBoundExecution(existing, currentTask, ctx.runId)
              : await claimNewExecution(input, currentTask, ctx.runId)

            if (claimed.status === 'succeeded') {
              if (!claimed.receipt) throw new ReviewBindingError('receipt_conflict')
              return { receiptId: claimed.receipt.receiptId }
            }

            const receipt = parseExecutorReceipt(
              await input.payments.execute({ action: claimed.action, idempotencyKey: claimed.executionId }),
              claimed.executionId,
            )
            const recorded = await input.tasks.recordExecutionReceipt(receipt)
            if (!recorded.receipt) throw new ReviewBindingError('receipt_conflict')
            return { receiptId: recorded.receipt.receiptId }
          }),
        )
        return { status: 'approved' }
      },
    })
    .build()

  return {
    storage,
    /** Starts or resumes the deterministic durable run for one payment action. */
    async run(payment: PaymentInput): Promise<PaymentResult> {
      const action = paymentInputSchema.parse(payment)
      const identity = reviewIdentity(action)
      // A stable durable run id is intentionally bound to its original Harness
      // input. Check the application-owned task binding before entering that
      // boundary so changed payment details fail closed as stale_action rather
      // than as a generic durable-input conflict. The handler repeats the
      // check after checkpoint replay to close the race with task changes.
      const existingTask = await input.tasks.get(identity.businessKey)
      if (existingTask) assertTaskMatchesInvocation(existingTask, action, identity)
      const session = await harness.getSession(identity.sessionId)
      try {
        return paymentResultSchema.parse(
          await session.workflows.review_payment.run(action, { durable: { runId: identity.runId } }),
        )
      } catch (error) {
        if (error instanceof ExternalWaitPendingError) return { status: 'waiting' }
        throw error
      } finally {
        await session.release()
      }
    },
  }
}

/**
 * Deterministic executor used only by this reference and its tests.
 *
 * A real executor reconciles uncertain external outcomes with this same key.
 */
export class InMemoryPaymentExecutor implements PaymentExecutor {
  private readonly receipts = new Map<string, { actionDigest: string; receipt: ExecutionReceipt }>()
  public effects = 0

  public async execute(input: { action: Readonly<PaymentAction>; idempotencyKey: string }): Promise<ExecutionReceipt> {
    const action = paymentActionSchema.parse(input.action)
    const idempotencyKey = z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_.:@/-]+$/)
      .parse(input.idempotencyKey)
    const digest = actionDigest(action)
    const existing = this.receipts.get(idempotencyKey)
    if (existing) {
      if (existing.actionDigest !== digest) throw new ReviewBindingError('execution_conflict')
      return existing.receipt
    }
    const receipt = executionReceiptSchema.parse({
      executionId: idempotencyKey,
      receiptId: `payment-receipt:${sha256(idempotencyKey).slice(0, 48)}`,
    })
    this.receipts.set(idempotencyKey, { actionDigest: digest, receipt })
    this.effects += 1
    return receipt
  }
}

async function claimNewExecution(
  input: PaymentReviewExampleOptions,
  task: z.output<typeof reviewTaskSchema>,
  executionId: string,
) {
  const authorized = await readAuthorized(input, task.action)
  const targetRevision = await readRevision(input, task.action.paymentId)
  return input.tasks.claimApprovedExecution({
    businessKey: task.businessKey,
    executionId,
    executionDigest: task.descriptor.executionDigest,
    authorized,
    targetRevision,
  })
}

async function readAuthorized(input: PaymentReviewAdmission, action: Readonly<PaymentAction>): Promise<boolean> {
  try {
    const value = await input.authorizeExecution(action)
    if (typeof value !== 'boolean') throw new ReviewBindingError('invalid_request')
    return value
  } catch (error) {
    if (error instanceof ReviewBindingError) throw error
    throw new ReviewBindingError('invalid_request')
  }
}

async function readRevision(input: PaymentReviewAdmission, paymentId: string): Promise<number> {
  try {
    const value = await input.readTargetRevision(paymentId)
    if (!Number.isSafeInteger(value) || value < 0) throw new ReviewBindingError('invalid_request')
    return value
  } catch (error) {
    if (error instanceof ReviewBindingError) throw error
    throw new ReviewBindingError('invalid_request')
  }
}

function assertBoundTask(
  task: z.output<typeof reviewTaskSchema>,
  checkpointTask: z.output<typeof reviewTaskSchema>,
  action: PaymentAction,
  identity: ReturnType<typeof reviewIdentity>,
): void {
  assertTaskMatchesInvocation(task, action, identity)
  if (
    checkpointTask.businessKey !== task.businessKey ||
    checkpointTask.waitId !== task.waitId ||
    checkpointTask.descriptor.executionDigest !== task.descriptor.executionDigest ||
    checkpointTask.descriptor.expiresAt !== task.descriptor.expiresAt
  )
    throw new ReviewBindingError('stale_action')
}

/**
 * Binds an invocation candidate to the immutable application task. This is
 * deliberately usable before durable admission and again after replayed
 * checkpoints: Harness owns run-id/input idempotency; the application owns
 * whether a payment action is still the action that was reviewed.
 */
function assertTaskMatchesInvocation(
  task: z.output<typeof reviewTaskSchema>,
  action: PaymentAction,
  identity: ReturnType<typeof reviewIdentity>,
): void {
  if (
    task.businessKey !== identity.businessKey ||
    task.waitId !== identity.waitId ||
    task.descriptor.executionDigest !== actionDigest(action) ||
    task.descriptor.targetRevision !== action.targetRevision ||
    task.descriptor.definitionVersion !== 'payment-v1'
  )
    throw new ReviewBindingError('stale_action')
}

function assertBoundExecution(value: unknown, task: z.output<typeof reviewTaskSchema>, executionId: string) {
  const execution = executionRecordSchema.safeParse(value)
  if (!execution.success) throw new ReviewBindingError('execution_conflict')
  const record = execution.data
  if (
    record.executionId !== executionId ||
    record.businessKey !== task.businessKey ||
    record.approvedRevision !== task.approvedRevision ||
    record.descriptor.executionDigest !== task.descriptor.executionDigest ||
    record.descriptor.expiresAt !== task.descriptor.expiresAt ||
    actionDigest(record.action) !== actionDigest(task.action)
  )
    throw new ReviewBindingError('execution_conflict')
  return record
}

function parseExecutorReceipt(value: unknown, executionId: string): ExecutionReceipt {
  const receipt = executionReceiptSchema.safeParse(value)
  if (!receipt.success || receipt.data.executionId !== executionId) throw new ReviewBindingError('invalid_receipt')
  return receipt.data
}

function checkpointTaskJson(task: z.output<typeof reviewTaskSchema>): JsonValue {
  return {
    businessKey: task.businessKey,
    waitId: task.waitId,
    revision: task.revision,
    action: { ...task.action },
    descriptor: { ...task.descriptor },
    status: task.status,
    ...(task.decisionEventId === undefined ? {} : { decisionEventId: task.decisionEventId }),
    ...(task.decidedBy === undefined ? {} : { decidedBy: task.decidedBy }),
    ...(task.approvedRevision === undefined ? {} : { approvedRevision: task.approvedRevision }),
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
