import { z } from 'zod'
import {
  defineHarness,
  ExternalWaitPendingError,
  inMemorySandbox,
  type HarnessStorage,
  InMemoryHarnessStorage,
  type JsonValue
} from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import { actionDigest, type ReviewTaskStore } from './review-task-store.js'

const paymentInput = z.object({ paymentId: z.string(), amountCents: z.number().int().positive(), targetRevision: z.string() })
type PaymentInput = z.infer<typeof paymentInput>

/** The application side effect must also be idempotent. */
export interface PaymentExecutor {
  execute(input: PaymentInput & { idempotencyKey: string }): Promise<void>
}

export function createPaymentReviewExample(input: { tasks: ReviewTaskStore; storage?: HarnessStorage; payments: PaymentExecutor }) {
  const storage = input.storage ?? new InMemoryHarnessStorage()
  const harness = defineHarness({ name: 'durable-payment-review-example' })
    .sandbox(inMemorySandbox())
    .storage(storage)
    .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
    .tools({})
    .skills({})
    .agents({ noop: { model: 'fake', instructions: 'No model call is needed for this reference workflow.', builtinTools: false } })
    .workflows(({ workflow }) => ({
      reviewPayment: workflow({
        input: paymentInput,
        output: z.object({ status: z.enum(['waiting', 'approved', 'rejected', 'expired', 'cancelled']) }),
        handler: async (ctx): Promise<{ status: 'approved' | 'rejected' | 'expired' | 'cancelled' | 'waiting' }> => {
          const descriptor = {
            businessKey: `payment:${ctx.input.paymentId}:payment-v1`,
            actionSchema: 'payment-action-v1',
            definitionVersion: 'payment-v1',
            targetRevision: ctx.input.targetRevision,
            executionDigest: actionDigest(ctx.input),
            // A real application derives this from policy and schedules an expiry signal.
            expiresAt: '2030-01-01T00:00:00.000Z'
          }
          const task = await ctx.step('create-review-task-v1', async () => JSON.parse(JSON.stringify(input.tasks.create(descriptor))) as JsonValue) as unknown as typeof descriptor & { waitId: string; revision: number }
          const outcome = await ctx.externalWait.wait({
            waitId: task.waitId,
            kind: 'human_review',
            schemaVersion: 'payment-review-v1',
            definitionVersion: descriptor.definitionVersion,
            deadline: descriptor.expiresAt
          })
          if (outcome.status !== 'approved') return { status: outcome.status as 'rejected' | 'expired' | 'cancelled' }
          // Never trust a merely approved wait. Reread the application task and
          // bind it to the current action before the actual side effect.
          input.tasks.consumeApproved(descriptor.businessKey, descriptor)
          await ctx.step('execute-payment-v1', async () => {
            await input.payments.execute({ ...ctx.input, idempotencyKey: ctx.runId })
            return { executed: true }
          })
          return { status: 'approved' }
        }
      })
    }))
    .build()

  return {
    storage,
    async run(payment: PaymentInput): Promise<{ status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'cancelled' }> {
      const session = await harness.getSession(`payment:${payment.paymentId}`)
      try {
        return await session.workflows.reviewPayment.prompt(payment, { durable: { runId: `payment-review:${payment.paymentId}:payment-v1` } }) as { status: 'waiting' | 'approved' | 'rejected' | 'expired' | 'cancelled' }
      } catch (error) {
        if (error instanceof ExternalWaitPendingError) return { status: 'waiting' }
        throw error
      }
    }
  }
}
