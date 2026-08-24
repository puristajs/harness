import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteHarnessStorage } from '@purista/harness'
import { createPaymentReviewExample } from './payment-review.js'
import { ReviewTaskStore } from './review-task-store.js'

describe('durable human review reference', () => {
  it('requires a CAS decision, resumes once, and binds approval to the exact payment action', async () => {
    const tasks = new ReviewTaskStore()
    const executed: string[] = []
    const app = createPaymentReviewExample({ tasks, payments: { execute: async input => { executed.push(input.idempotencyKey) } } })
    const payment = { paymentId: 'p-1', amountCents: 12500, targetRevision: 'r1' }

    await expect(app.run(payment)).resolves.toEqual({ status: 'waiting' })
    const task = tasks.read('payment:p-1:payment-v1')!
    expect(tasks.decide({ businessKey: task.businessKey, expectedRevision: 0, outcome: 'approved', eventId: 'decision-0', principalId: 'reviewer-a' })).toEqual({ kind: 'stale' })
    const decision = tasks.decide({ businessKey: task.businessKey, expectedRevision: task.revision, outcome: 'approved', eventId: 'decision-1', principalId: 'reviewer-a' })
    expect(decision.kind).toBe('applied')
    await app.waits.signal({ waitId: task.waitId, eventId: 'decision-1', outcome: 'approved' })

    await expect(app.run(payment)).resolves.toEqual({ status: 'approved' })
    expect((await app.waits.signal({ waitId: task.waitId, eventId: 'decision-1', outcome: 'approved' })).kind).toBe('duplicate')
    expect(executed).toHaveLength(1)
  })

	it('fails closed when the resumed action no longer matches the approved descriptor', async () => {
    const tasks = new ReviewTaskStore()
    const app = createPaymentReviewExample({ tasks, payments: { execute: async () => undefined } })
    await app.run({ paymentId: 'p-2', amountCents: 100, targetRevision: 'r1' })
    const task = tasks.read('payment:p-2:payment-v1')!
    tasks.decide({ businessKey: task.businessKey, expectedRevision: 1, outcome: 'approved', eventId: 'decision-2', principalId: 'reviewer-a' })
    await app.waits.signal({ waitId: task.waitId, eventId: 'decision-2', outcome: 'approved' })
    await expect(app.run({ paymentId: 'p-2', amountCents: 200, targetRevision: 'r1' })).rejects.toThrow('stale or no longer binds')
	})

	it('resumes after rebuilding the Harness and SQLite-backed adapters', async () => {
		const tasks = new ReviewTaskStore()
		const file = join(await mkdtemp(join(tmpdir(), 'purista-review-')), 'runtime.sqlite')
		const firstStorage = new SqliteHarnessStorage({ file })
		const first = createPaymentReviewExample({ tasks, runtime: firstStorage, state: firstStorage, waits: firstStorage, payments: { execute: async () => undefined } })
		await expect(first.run({ paymentId: 'p-3', amountCents: 100, targetRevision: 'r1' })).resolves.toEqual({ status: 'waiting' })
		const task = tasks.read('payment:p-3:payment-v1')!
		tasks.decide({ businessKey: task.businessKey, expectedRevision: 1, outcome: 'approved', eventId: 'decision-3', principalId: 'reviewer-a' })
		await firstStorage.signal({ waitId: task.waitId, eventId: 'decision-3', outcome: 'approved' })
		await firstStorage.close()

		const secondStorage = new SqliteHarnessStorage({ file })
		const second = createPaymentReviewExample({ tasks, runtime: secondStorage, state: secondStorage, waits: secondStorage, payments: { execute: async () => undefined } })
		await expect(second.run({ paymentId: 'p-3', amountCents: 100, targetRevision: 'r1' })).resolves.toEqual({ status: 'approved' })
		await secondStorage.close()
	})
})
