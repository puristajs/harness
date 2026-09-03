import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryHarnessStorage, inMemorySandbox, type RunCheckpoint, type Sandbox } from '@purista/harness'
import { createPaymentReviewExample, InMemoryPaymentExecutor, type PaymentExecutor, type PaymentReviewAdmission } from './payment-review.js'
import {
  actionDigest,
  executionReceiptSchema,
  paymentActionSchema,
  reviewIdentity,
  reviewTaskSchema,
  ReviewTaskStore,
  type ExecutionReceipt,
  type PaymentAction
} from './review-task-store.js'

const payment = { paymentId: 'p-1', amountCents: 12_500, targetRevision: 7 } as const

function fixture(options: Partial<PaymentReviewAdmission> & { now?: () => Date; payments?: PaymentExecutor; storage?: InMemoryHarnessStorage; tasks?: ReviewTaskStore; sandbox?: Sandbox } = {}) {
  const now = options.now ?? (() => new Date('2029-01-01T00:00:00.000Z'))
  const tasks = options.tasks ?? new ReviewTaskStore({ now, reviewTtlMs: 60_000 })
  const storage = options.storage ?? new InMemoryHarnessStorage({ now })
  const sandbox = options.sandbox ?? inMemorySandbox()
  const payments = options.payments ?? new InMemoryPaymentExecutor()
  const admission: PaymentReviewAdmission = {
    authorizeExecution: options.authorizeExecution ?? (async () => true),
    readTargetRevision: options.readTargetRevision ?? (async () => payment.targetRevision)
  }
  return {
    app: createPaymentReviewExample({ tasks, storage, payments, sandbox, now, ...admission }),
    tasks,
    storage,
    payments,
    sandbox
  }
}

async function approve(tasks: ReviewTaskStore, storage: InMemoryHarnessStorage, action: PaymentAction, eventId = 'decision-1') {
  const task = await tasks.get(`payment:${action.paymentId}`)
  if (!task) throw new Error('Expected review task.')
  const decision = await tasks.decide({
    businessKey: task.businessKey,
    expectedRevision: task.revision,
    eventId,
    outcome: 'approved',
    principalId: 'reviewer-a',
    executionDigest: actionDigest(action)
  })
  await storage.signalWait({ waitId: task.waitId, eventId, outcome: 'approved' })
  return decision
}

describe('durable human review reference', () => {
  it('creates before its checkpoint and retains the original task when a retry supplies another wait id', async () => {
    let clockReads = 0
    const taskNow = () => {
      clockReads += 1
      return new Date('2029-01-01T00:00:00.000Z')
    }
    const runtimeNow = () => new Date('2029-01-01T00:00:00.000Z')
    const tasks = new ReviewTaskStore({ now: taskNow, reviewTtlMs: 60_000 })
    const storage = new CrashAfterCreationCheckpointStorage({ now: runtimeNow })
    const app = fixture({ now: runtimeNow, tasks, storage })

    await expect(app.app.run(payment)).rejects.toThrow('creation checkpoint crash')
    const created = (await tasks.get('payment:p-1'))!
    expect(created.status).toBe('pending')
    const retried = await tasks.getOrCreate({ action: payment, waitId: '' })
    expect(retried).toEqual(created)
    expect(retried.waitId).toBe(reviewIdentity(payment).waitId)
    expect(retried.descriptor.expiresAt).toBe(created.descriptor.expiresAt)
    expect(clockReads).toBe(2) // creation plus the explicit read; malformed retry does not consult the clock.

    await expect(app.app.run(payment)).resolves.toEqual({ status: 'waiting' })
    await expect(app.app.run(payment)).resolves.toEqual({ status: 'waiting' })
    const requested = (await storage.listEvents(reviewIdentity(payment).runId)).filter((event) => event.type === 'external_wait.requested')
    expect(requested).toHaveLength(1)
  })

  it('uses strict schemas and returns immutable application snapshots', async () => {
    const tasks = new ReviewTaskStore({ now: () => new Date('2029-01-01T00:00:00.000Z'), reviewTtlMs: 60_000 })
    const task = await tasks.getOrCreate({ action: payment, waitId: reviewIdentity(payment).waitId })
    expect(paymentActionSchema.safeParse({ ...payment, extra: true }).success).toBe(false)
    expect(executionReceiptSchema.safeParse({ executionId: 'run-1', receiptId: 'receipt-1', extra: true }).success).toBe(false)
    expect(reviewTaskSchema.safeParse({ ...task, extra: true }).success).toBe(false)
    expect(Object.isFrozen(task)).toBe(true)
    expect(Object.isFrozen(task.action)).toBe(true)
    expect(Object.isFrozen(task.descriptor)).toBe(true)
    expect(() => { task.action.amountCents = 1 }).toThrow()
    expect((await tasks.get(task.businessKey))?.action.amountCents).toBe(payment.amountCents)
  })

  it('persists a reviewer decision before its independent terminal signal', async () => {
    const { app, tasks, storage, payments } = fixture()
    await app.run(payment)
    const task = (await tasks.get('payment:p-1'))!
    const approved = await tasks.decide({
      businessKey: task.businessKey,
      expectedRevision: task.revision,
      eventId: 'decision-before-signal',
      outcome: 'approved',
      principalId: 'reviewer-a',
      executionDigest: actionDigest(payment)
    })
    expect(approved.status).toBe('approved')
    expect((await storage.getWait(task.waitId))?.status).toBe('waiting')
    expect(effectsOf(payments)).toBe(0)
    await storage.signalWait({ waitId: task.waitId, eventId: 'decision-before-signal', outcome: 'approved' })
    await expect(app.run(payment)).resolves.toEqual({ status: 'approved' })
  })

  it('records one immutable claim and receipt after an application-authorized review', async () => {
    const { app, tasks, storage, payments } = fixture()
    await expect(app.run(payment)).resolves.toEqual({ status: 'waiting' })
    const approved = await approve(tasks, storage, payment)

    await expect(app.run(payment)).resolves.toEqual({ status: 'approved' })
    const execution = await tasks.readExecution(`payment-review:${identityDigest(payment)}`)
    expect(execution).toMatchObject({
      businessKey: 'payment:p-1',
      approvedRevision: approved.approvedRevision,
      action: payment,
      status: 'succeeded'
    })
    expect(execution?.receipt?.executionId).toBe(execution?.executionId)
    expect(effectsOf(payments)).toBe(1)
    await expect(storage.signalWait({ waitId: (await tasks.get('payment:p-1'))!.waitId, eventId: 'decision-1', outcome: 'approved' })).resolves.toMatchObject({ kind: 'duplicate' })
  })

  it('fails closed for stale input, unauthorized admission, expired work, and conflicting decisions', async () => {
    const unauthorized = fixture({ authorizeExecution: async () => false })
    await unauthorized.app.run(payment)
    await approve(unauthorized.tasks, unauthorized.storage, payment)
    await expect(unauthorized.app.run(payment)).rejects.toMatchObject({ code: 'REVIEW_BINDING_ERROR', meta: { reason: 'unauthorized' } })
    expect(effectsOf(unauthorized.payments)).toBe(0)

    const stale = fixture()
    await stale.app.run(payment)
    await approve(stale.tasks, stale.storage, payment)
    await expect(stale.app.run({ ...payment, amountCents: 1 })).rejects.toMatchObject({ code: 'REVIEW_BINDING_ERROR', meta: { reason: 'stale_action' } })
    expect(effectsOf(stale.payments)).toBe(0)

    let time = new Date('2029-01-01T00:00:00.000Z')
    const expired = fixture({ now: () => time })
    await expired.app.run(payment)
    time = new Date('2029-01-01T00:01:00.000Z')
    const task = (await expired.tasks.get('payment:p-1'))!
    await expired.storage.signalWait({ waitId: task.waitId, eventId: 'late', outcome: 'approved' })
    await expect(expired.app.run(payment)).resolves.toEqual({ status: 'expired' })
    expect(effectsOf(expired.payments)).toBe(0)

    let approvedTime = new Date('2029-01-01T00:00:00.000Z')
    const directExpiry = new ReviewTaskStore({ now: () => approvedTime, reviewTtlMs: 60_000 })
    const directTask = await directExpiry.getOrCreate({ action: payment, waitId: reviewIdentity(payment).waitId })
    await directExpiry.decide({
      businessKey: directTask.businessKey,
      expectedRevision: directTask.revision,
      eventId: 'approved-before-expiry',
      outcome: 'approved',
      principalId: 'reviewer-a',
      executionDigest: actionDigest(payment)
    })
    approvedTime = new Date('2029-01-01T00:01:00.000Z')
    await expect(directExpiry.claimApprovedExecution({
      businessKey: directTask.businessKey,
      executionId: reviewIdentity(payment).runId,
      executionDigest: actionDigest(payment),
      authorized: true,
      targetRevision: payment.targetRevision
    })).rejects.toMatchObject({ meta: { reason: 'expired' } })

    const conflict = fixture()
    await conflict.app.run(payment)
    const initial = (await conflict.tasks.get('payment:p-1'))!
    await approve(conflict.tasks, conflict.storage, payment)
    await expect(conflict.tasks.decide({
      businessKey: initial.businessKey,
      expectedRevision: initial.revision,
      eventId: 'different-decision',
      outcome: 'rejected',
      principalId: 'reviewer-a',
      executionDigest: actionDigest(payment)
    })).rejects.toMatchObject({ meta: { reason: 'decision_conflict' } })

    for (const outcome of ['rejected', 'cancelled'] as const) {
      const terminal = fixture()
      await terminal.app.run(payment)
      const pending = (await terminal.tasks.get('payment:p-1'))!
      await terminal.tasks.decide({
        businessKey: pending.businessKey,
        expectedRevision: pending.revision,
        eventId: `${outcome}-decision`,
        outcome,
        principalId: 'reviewer-a',
        executionDigest: actionDigest(payment)
      })
      await terminal.storage.signalWait({ waitId: pending.waitId, eventId: `${outcome}-decision`, outcome })
      await expect(terminal.app.run(payment)).resolves.toEqual({ status: outcome })
      expect(effectsOf(terminal.payments)).toBe(0)
    }
  })

  it('does not re-admit a claimed execution after expiry, revocation, or revision lookup failure', async () => {
    let time = new Date('2029-01-01T00:00:00.000Z')
    let fail = true
    let authorized = true
    let revisionAvailable = true
    const effects = new InMemoryPaymentExecutor()
    const payments: PaymentExecutor = {
      execute: async input => {
        if (fail) {
          fail = false
          throw new Error('transient executor failure')
        }
        return effects.execute(input)
      }
    }
    const app = fixture({
      now: () => time,
      payments,
      authorizeExecution: async () => authorized,
      readTargetRevision: async () => {
        if (!revisionAvailable) throw new Error('revision service unavailable')
        return payment.targetRevision
      }
    })
    await app.app.run(payment)
    await approve(app.tasks, app.storage, payment)
    await expect(app.app.run(payment)).rejects.toThrow('transient executor failure')
    expect((await app.tasks.readExecution(`payment-review:${identityDigest(payment)}`))?.status).toBe('claimed')
    time = new Date('2029-01-01T00:02:00.000Z')
    authorized = false
    revisionAvailable = false
    await expect(app.app.run(payment)).resolves.toEqual({ status: 'approved' })
    expect(effects.effects).toBe(1)
  })

  it('recovers one logical effect across receipt and checkpoint crash windows', async () => {
    const beforeReceipt = new CrashBeforeReceiptStore({ now: () => new Date('2029-01-01T00:00:00.000Z'), reviewTtlMs: 60_000 })
    const beforeReceiptApp = fixture({ tasks: beforeReceipt, now: () => new Date('2029-01-01T00:00:00.000Z') })
    await beforeReceiptApp.app.run(payment)
    await approve(beforeReceiptApp.tasks, beforeReceiptApp.storage, payment)
    await expect(beforeReceiptApp.app.run(payment)).rejects.toThrow('receipt persistence crash')
    expect((await beforeReceiptApp.tasks.readExecution(`payment-review:${identityDigest(payment)}`))?.status).toBe('claimed')
    await expect(beforeReceiptApp.app.run(payment)).resolves.toEqual({ status: 'approved' })
    expect(effectsOf(beforeReceiptApp.payments)).toBe(1)

    const afterReceipt = new CrashAfterReceiptStore({ now: () => new Date('2029-01-01T00:00:00.000Z'), reviewTtlMs: 60_000 })
    const first = fixture({ tasks: afterReceipt, now: () => new Date('2029-01-01T00:00:00.000Z') })
    await first.app.run(payment)
    await approve(first.tasks, first.storage, payment)
    await expect(first.app.run(payment)).rejects.toThrow('receipt write crash')
    await expect(first.app.run(payment)).resolves.toEqual({ status: 'approved' })
    expect(effectsOf(first.payments)).toBe(1)

    const storage = new CrashAfterExecutionCheckpointStorage()
    const second = fixture({ storage })
    await second.app.run(payment)
    await approve(second.tasks, second.storage, payment)
    await expect(second.app.run(payment)).rejects.toThrow('checkpoint crash')
    await expect(second.app.run(payment)).resolves.toEqual({ status: 'approved' })
    expect(effectsOf(second.payments)).toBe(1)
  })

  it('binds changed invocation input before replaying a receipt or committed execution step', async () => {
    const storage = new CrashBeforeSuccessfulFinishStorage()
    const app = fixture({ storage })
    await app.app.run(payment)
    await approve(app.tasks, app.storage, payment)
    await expect(app.app.run(payment)).rejects.toThrow('final run commit crash')
    expect((await app.tasks.readExecution(`payment-review:${identityDigest(payment)}`))?.status).toBe('succeeded')
    await expect(app.app.run({ ...payment, amountCents: 1 })).rejects.toMatchObject({
      code: 'REVIEW_BINDING_ERROR',
      meta: { reason: 'stale_action' }
    })
    expect(effectsOf(app.payments)).toBe(1)
  })

  it('preserves receipt and claim identity under duplicate concurrent claims and rejects malformed receipts', async () => {
    const { app, tasks, storage } = fixture()
    await app.run(payment)
    await approve(tasks, storage, payment)
    const task = (await tasks.get('payment:p-1'))!
    const executionId = `payment-review:${identityDigest(payment)}`
    const [left, right] = await Promise.all([
      tasks.claimApprovedExecution({ businessKey: task.businessKey, executionId, executionDigest: task.descriptor.executionDigest, authorized: true, targetRevision: payment.targetRevision }),
      tasks.claimApprovedExecution({ businessKey: task.businessKey, executionId, executionDigest: task.descriptor.executionDigest, authorized: true, targetRevision: payment.targetRevision })
    ])
    expect(left).toEqual(right)
    await expect(tasks.claimApprovedExecution({
      businessKey: task.businessKey,
      executionId: 'another-execution',
      executionDigest: task.descriptor.executionDigest,
      authorized: true,
      targetRevision: payment.targetRevision
    })).rejects.toMatchObject({ meta: { reason: 'execution_conflict' } })
    const receipt = { executionId, receiptId: 'receipt-1' }
    await expect(tasks.recordExecutionReceipt(receipt)).resolves.toMatchObject({ status: 'succeeded', receipt })
    await expect(tasks.recordExecutionReceipt(receipt)).resolves.toMatchObject({ status: 'succeeded', receipt })
    await expect(tasks.recordExecutionReceipt({ executionId, receiptId: 'receipt-2' })).rejects.toMatchObject({ meta: { reason: 'receipt_conflict' } })
    await expect(tasks.recordExecutionReceipt({ executionId: 'wrong-execution', receiptId: 'receipt-1' })).rejects.toMatchObject({ meta: { reason: 'missing_claim' } })
    await expect(tasks.recordExecutionReceipt({ executionId, receiptId: '' })).rejects.toMatchObject({ meta: { reason: 'invalid_receipt' } })
  })

  it('serializes actual concurrent workflow resumes around one durable claim and effect', async () => {
    const executor = new BlockingExecutor()
    const first = fixture({ payments: executor })
    await first.app.run(payment)
    await approve(first.tasks, first.storage, payment)
    const second = fixture({
      tasks: first.tasks,
      storage: first.storage,
      sandbox: first.sandbox,
      payments: executor
    })
    const winner = first.app.run(payment)
    await executor.started
    const loser = second.app.run(payment)
    await expect(loser).rejects.toMatchObject({ name: 'DurableRunLeaseError' })
    executor.release()
    await expect(winner).resolves.toEqual({ status: 'approved' })
    expect(executor.effects).toBe(1)
    expect((await first.tasks.readExecution(reviewIdentity(payment).runId))?.status).toBe('succeeded')
  })

  it('fails a claimed execution when an executor returns a receipt for another run', async () => {
    const mismatched: PaymentExecutor = {
      execute: async () => ({ executionId: 'other-run', receiptId: 'receipt-1' })
    }
    const app = fixture({ payments: mismatched })
    await app.app.run(payment)
    await approve(app.tasks, app.storage, payment)
    await expect(app.app.run(payment)).rejects.toMatchObject({
      code: 'REVIEW_BINDING_ERROR',
      meta: { reason: 'invalid_receipt' }
    })
    expect((await app.tasks.readExecution(reviewIdentity(payment).runId))?.status).toBe('claimed')
  })

  it('rejects a replay checkpoint when the application review task was lost', async () => {
    const first = fixture()
    await first.app.run(payment)
    const lostTasks = new ReviewTaskStore({ now: () => new Date('2029-01-01T00:00:00.000Z'), reviewTtlMs: 60_000 })
    const resumed = fixture({ tasks: lostTasks, storage: first.storage, payments: first.payments, sandbox: first.sandbox })
    await expect(resumed.app.run(payment)).rejects.toMatchObject({ code: 'REVIEW_BINDING_ERROR', meta: { reason: 'missing_task' } })
  })
})

class CrashAfterReceiptStore extends ReviewTaskStore {
  private crashed = false

  public override async recordExecutionReceipt(receipt: ExecutionReceipt) {
    const result = await super.recordExecutionReceipt(receipt)
    if (!this.crashed) {
      this.crashed = true
      throw new Error('receipt write crash')
    }
    return result
  }
}

class CrashAfterCreationCheckpointStorage extends InMemoryHarnessStorage {
  private crashed = false

  public override async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    await super.commitCheckpoint(checkpoint)
    if (!this.crashed && checkpoint.stepId === 'create-review-task-v1') {
      this.crashed = true
      throw new Error('creation checkpoint crash')
    }
  }
}

class CrashBeforeReceiptStore extends ReviewTaskStore {
  private crashed = false

  public override async recordExecutionReceipt(receipt: ExecutionReceipt) {
    if (!this.crashed) {
      this.crashed = true
      throw new Error('receipt persistence crash')
    }
    return super.recordExecutionReceipt(receipt)
  }
}

class CrashAfterExecutionCheckpointStorage extends InMemoryHarnessStorage {
  private crashed = false

  public override async commitCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    await super.commitCheckpoint(checkpoint)
    if (!this.crashed && checkpoint.stepId === 'execute-payment-v1') {
      this.crashed = true
      throw new Error('checkpoint crash')
    }
  }
}

class CrashBeforeSuccessfulFinishStorage extends InMemoryHarnessStorage {
  private successFailures = 0

  public override async finishRun(runId: string, patch: Parameters<InMemoryHarnessStorage['finishRun']>[1]): Promise<void> {
    if (patch.status === 'succeeded' && this.successFailures < 2) {
      this.successFailures += 1
      throw new Error('final run commit crash')
    }
    return super.finishRun(runId, patch)
  }
}

class BlockingExecutor implements PaymentExecutor {
  private readonly delegate = new InMemoryPaymentExecutor()
  private releaseGate: (() => void) | undefined
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve })
  private resolveStarted: (() => void) | undefined
  public readonly started = new Promise<void>((resolve) => { this.resolveStarted = resolve })

  public get effects(): number {
    return this.delegate.effects
  }

  public async execute(input: { action: Readonly<PaymentAction>; idempotencyKey: string }): Promise<ExecutionReceipt> {
    this.resolveStarted?.()
    await this.gate
    return this.delegate.execute(input)
  }

  public release(): void {
    this.releaseGate?.()
  }
}

function identityDigest(action: PaymentAction): string {
  return createDigest(JSON.stringify([`payment:${action.paymentId}`, 'payment-v1']))
}

function createDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function effectsOf(executor: PaymentExecutor): number {
  if (!(executor instanceof InMemoryPaymentExecutor)) throw new Error('Expected in-memory reference executor.')
  return executor.effects
}
