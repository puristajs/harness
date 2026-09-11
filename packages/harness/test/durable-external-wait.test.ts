import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineHarness, defineWorkflow, InMemoryHarnessStorage } from '../src/index.js'
import {
  validateExternalWaitRequest,
  validateExternalWaitSignal,
  validateExternalWaitSnapshot,
} from '../src/storage/external-wait.js'

const request = {
  waitId: 'review-1',
  kind: 'human_review',
  schemaVersion: 'v1',
  definitionVersion: 'transfer-v1',
  deadline: '2030-01-01T00:00:00.000Z',
} as const

describe('v4 durable external waits', () => {
	it('restores a persisted poisoned wait request when registration skips its producer', async () => {
		const storage = new InMemoryHarnessStorage()
		const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
		Object.defineProperties(storage, { capabilities: { value: capabilities }, info: { value: Object.freeze({ ...storage.info, capabilities }) } })
		const sentinel = new Error('wait request append result unavailable')
		const readback = new Error('wait request readback unavailable')
		let failAppend = true
		let failReadback = false
		let requestedEventId: string | undefined
		const appendEvents = storage.appendEvents.bind(storage)
		storage.appendEvents = async (runId, events) => {
			const requested = failAppend ? events.find(event => event.type === 'external_wait.requested') : undefined
			await appendEvents(runId, events)
			if (requested !== undefined) {
				failAppend = false
				failReadback = true
				requestedEventId = requested.id
				throw sentinel
			}
		}
		const listEvents = storage.listEvents.bind(storage)
		storage.listEvents = async runId => {
			if (failReadback) {
				failReadback = false
				throw readback
			}
			return listEvents(runId)
		}
		const workflow = defineWorkflow('poisonedWaitRequest', { input: z.string(), output: z.string(), durable: true,
			async handler(context) { await context.externalWait.wait({ ...request, waitId: 'poisoned-request' }); return context.input } })
		const instance = await defineHarness({ name: 'poisonedWaitRequestHarness', revision: 'v1' })
			.addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('poisoned-wait-request-session')
		const invoke = { durable: { runId: 'poisoned-wait-request-run' } } as const

		await expect(session.workflows.poisonedWaitRequest.run('value', invoke)).rejects.toBe(sentinel)
		const beforeRecovery = await listEvents(invoke.durable.runId)
		expect(beforeRecovery.filter(event => event.type === 'external_wait.requested')).toEqual([
			expect.objectContaining({ id: requestedEventId, sequence: 2 }),
		])
		const live: string[] = []
		for await (const event of session.workflows.poisonedWaitRequest.stream('value', invoke)) live.push(event.type)
		expect(live.filter(type => type === 'run.started')).toHaveLength(1)
		expect(live.filter(type => type === 'external_wait.requested')).toHaveLength(1)
		expect(live.filter(type => type === 'external_wait.waiting')).toHaveLength(1)
		expect(live.filter(type => type === 'run.finished')).toHaveLength(1)
		const events = await listEvents(invoke.durable.runId)
		expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
		expect(events.filter(event => event.type === 'external_wait.requested')).toEqual([
			expect.objectContaining({ id: requestedEventId, sequence: 2 }),
		])
		await session.destroy()
		await instance.close()
	})

	it.each([false, true])('reconciles an external-wait event append (persisted=%s)', async persisted => {
		const storage = new InMemoryHarnessStorage()
		const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
		Object.defineProperties(storage, { capabilities: { value: capabilities }, info: { value: Object.freeze({ ...storage.info, capabilities }) } })
		const sentinel = new Error(`wait event ${persisted ? 'persisted' : 'absent'}`)
		let fail = true
		const appendEvents = storage.appendEvents.bind(storage)
		storage.appendEvents = async (runId, events) => {
			const requested = fail && events.some(event => event.type === 'external_wait.requested')
			if (requested && !persisted) { fail = false; throw sentinel }
			await appendEvents(runId, events)
			if (requested) { fail = false; throw sentinel }
		}
		const workflow = defineWorkflow('recoverableWait', { input: z.string(), output: z.string(), durable: true,
			async handler(context) { await context.externalWait.wait(request); return context.input } })
		const instance = await defineHarness({ name: persisted ? 'recoverableWaitAfter' : 'recoverableWaitBefore', revision: 'v1' })
			.addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('recoverable-wait-session')
		const invoke = { durable: { runId: 'recoverable-wait-run' } } as const
		if (!persisted) {
			await expect(session.workflows.recoverableWait.run('value', invoke)).rejects.toBe(sentinel)
			expect((await storage.listEvents(invoke.durable.runId)).map(event => event.type)).toEqual(['run.started'])
		}
		await expect(session.workflows.recoverableWait.run('value', invoke)).resolves.toMatchObject({
			status: 'interrupted', interrupt: { type: 'external-wait', id: request.waitId },
		})
		const events = await storage.listEvents(invoke.durable.runId)
		expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
		expect(events.filter(event => event.type === 'external_wait.requested')).toHaveLength(1)
		expect(events.filter(event => event.type === 'external_wait.waiting')).toHaveLength(1)
		expect(events.filter(event => event.type === 'run.finished')).toHaveLength(1)
		await session.destroy()
		await instance.close()
	})

	it.each([false, true])('reconciles an interrupted terminal append without duplicating wait lifecycle (persisted=%s)', async persisted => {
		const storage = new InMemoryHarnessStorage()
		const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
		Object.defineProperties(storage, { capabilities: { value: capabilities }, info: { value: Object.freeze({ ...storage.info, capabilities }) } })
		const sentinel = new Error(`wait terminal ${persisted ? 'persisted' : 'absent'}`)
		let fail = true
		const appendEvents = storage.appendEvents.bind(storage)
		storage.appendEvents = async (runId, events) => {
			const terminal = fail && events.some(event => event.type === 'run.finished')
			if (terminal && !persisted) { fail = false; throw sentinel }
			await appendEvents(runId, events)
			if (terminal) { fail = false; throw sentinel }
		}
		const workflow = defineWorkflow('recoverableWaitTerminal', { input: z.string(), output: z.string(), durable: true,
			async handler(context) { await context.externalWait.wait({ ...request, waitId: 'terminal-review' }); return context.input } })
		const instance = await defineHarness({ name: persisted ? 'recoverableWaitTerminalAfter' : 'recoverableWaitTerminalBefore', revision: 'v1' })
			.addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('recoverable-wait-terminal-session')
		const invoke = { durable: { runId: 'recoverable-wait-terminal-run' } } as const
		if (!persisted) await expect(session.workflows.recoverableWaitTerminal.run('value', invoke)).rejects.toBe(sentinel)
		await expect(session.workflows.recoverableWaitTerminal.run('value', invoke)).resolves.toMatchObject({
			status: 'interrupted', interrupt: { type: 'external-wait', id: 'terminal-review' },
		})
		const events = await storage.listEvents(invoke.durable.runId)
		expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
		expect(events.filter(event => event.type === 'external_wait.requested')).toHaveLength(1)
		expect(events.filter(event => event.type === 'external_wait.waiting')).toHaveLength(1)
		expect(events.filter(event => event.type === 'run.finished')).toHaveLength(1)
		await session.destroy()
		await instance.close()
	})

  it('omits externalWait from non-durable workflow contexts', async () => {
    let exposed = true
    const ordinary = defineWorkflow('ordinary', {
      input: z.string(), output: z.string(),
      async handler(context) {
        exposed = 'externalWait' in context
        return context.input
      },
    })
    const instance = await defineHarness({ name: 'ordinaryWorkflowHarness' }).addWorkflow(ordinary).getInstance({})
    const session = await instance.getSession('ordinary-session')

    await expect(session.workflows.ordinary.run('ok')).resolves.toMatchObject({ status: 'completed', output: 'ok' })
    expect(exposed).toBe(false)
    await session.destroy()
    await instance.close()
  })

  it.each(['run', 'stream'] as const)('allocates durable identity for an ordinary %s invocation and resumes it after restart', async mode => {
    class RegistrationTrackingStorage extends InMemoryHarnessStorage {
      public registrations = 0
      public override async registerWait(value: Parameters<InMemoryHarnessStorage['registerWait']>[0]) {
        this.registrations += 1
        return super.registerWait(value)
      }
    }
    const storage = new RegistrationTrackingStorage()
    const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
    Object.defineProperties(storage, {
      capabilities: { value: capabilities },
      info: { value: Object.freeze({ ...storage.info, capabilities }) },
    })
    let effects = 0
    const modeRequest = { ...request, waitId: `ordinary-${mode}-wait` }
    const wait = defineWorkflow('defaultDurableInvocation', {
      input: z.string(), output: z.string(), durable: true,
      async handler(context) {
		await context.externalWait.wait(modeRequest)
		effects += 1
        return context.input
      },
    })
    const harness = defineHarness({ name: `defaultDurableInvocationHarness${mode}`, revision: 'release-1' })
      .addWorkflow(wait).getInstance({ storage })
    const instance = await harness
    const sessionId = `default-durable-${mode}-session`
    const session = await instance.getSession(sessionId)
	const interrupted = mode === 'run'
		? await session.workflows.defaultDurableInvocation.run('input')
		: await (async () => {
			const stream = session.workflows.defaultDurableInvocation.stream('input')
			const result = await stream.result
			for await (const _event of stream) { /* drain before restart */ }
			return result
		})()
	expect(interrupted).toMatchObject({ status: 'interrupted', interrupt: { type: 'external-wait', id: modeRequest.waitId } })
	const runId = interrupted.runId
	expect(runId).toMatch(/^run_/)
    expect(storage.registrations).toBe(1)
	await instance.close()
	await expect(storage.signalWait({ waitId: modeRequest.waitId, eventId: `${mode}-delivery`, outcome: 'approved' }))
		.resolves.toMatchObject({ kind: 'applied' })

	const restarted = await defineHarness({ name: `defaultDurableInvocationHarness${mode}`, revision: 'release-1' })
		.addWorkflow(wait).getInstance({ storage })
	const resumedSession = await restarted.getSession(sessionId)
	await expect(resumedSession.workflows.defaultDurableInvocation.run('input', { durable: { runId } }))
		.resolves.toEqual({ status: 'completed', runId, output: 'input' })
	expect(effects).toBe(1)
	await resumedSession.destroy()
	await restarted.close()
  })

  it('rejects malformed or extended requests', () => {
    expect(validateExternalWaitRequest(request)).toEqual(request)
    expect(() => validateExternalWaitRequest({ ...request, extra: true })).toThrowError(
      expect.objectContaining({ reason: 'invalid_request' }),
    )
    expect(() => validateExternalWaitRequest({ ...request, deadline: '2030-01-01T00:00:00Z' })).toThrowError(
      expect.objectContaining({ reason: 'invalid_request' }),
    )
  })

  it('rejects malformed or extended signals', () => {
    expect(() => validateExternalWaitSignal({
      waitId: request.waitId,
      eventId: 'delivery-1',
      outcome: 'approved',
      observedAt: '2030-01-01T00:00:00.000Z',
      extra: true,
    })).toThrowError(expect.objectContaining({ reason: 'invalid_request' }))
    expect(() => validateExternalWaitSignal({ waitId: request.waitId, eventId: '', outcome: 'approved' }))
      .toThrowError(expect.objectContaining({ reason: 'invalid_request' }))
  })

  it('rejects malformed terminal snapshots', () => {
    expect(() => validateExternalWaitSnapshot({
      ...request,
      status: 'approved',
      createdAt: request.deadline,
      resolvedAt: request.deadline,
    })).toThrowError(expect.objectContaining({ reason: 'invalid_snapshot' }))
    expect(() => validateExternalWaitSnapshot({
      ...request,
      status: 'waiting',
      createdAt: request.deadline,
      unexpected: true,
    })).toThrowError(expect.objectContaining({ reason: 'invalid_snapshot' }))
  })

  it('persists, signals, and resumes a durable v4 workflow without replaying committed steps', async () => {
    const storage = new InMemoryHarnessStorage()
    const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
    Object.defineProperties(storage, {
      capabilities: { value: capabilities },
      info: { value: Object.freeze({ ...storage.info, capabilities }) },
    })
    const effects = { prepared: 0, executed: 0 }
    const transfer = defineWorkflow('transfer', {
      input: z.string(), output: z.string(), durable: true,
      async handler(context) {
        await context.step('prepare', async () => { effects.prepared += 1; return { prepared: true } })
        const decision = await context.externalWait.wait(request)
        if (decision.status !== 'approved') return decision.status
        await context.step('execute', async () => { effects.executed += 1; return { executed: true } })
        return 'executed'
      },
    })
    const instance = await defineHarness({ name: 'externalWaitHarness', revision: 'release-1' })
      .addWorkflow(transfer).getInstance({ storage })
    const session = await instance.getSession('review-session')

    await expect(session.workflows.transfer.run('input', { durable: { runId: 'review-run' } })).resolves.toMatchObject({
      status: 'interrupted', runId: 'review-run', interrupt: { type: 'external-wait', id: request.waitId },
    })
    expect(effects).toEqual({ prepared: 1, executed: 0 })
    await expect(storage.getWait(request.waitId)).resolves.toMatchObject({ status: 'waiting' })
    await expect(storage.signalWait({ waitId: request.waitId, eventId: 'delivery-1', outcome: 'approved' }))
      .resolves.toMatchObject({ kind: 'applied' })

    await expect(session.workflows.transfer.run('input', { durable: { runId: 'review-run' } })).resolves.toEqual({
      status: 'completed', runId: 'review-run', output: 'executed',
    })
    expect(effects).toEqual({ prepared: 1, executed: 1 })
    await session.destroy()
    await instance.close()
  })
})
