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

  it('rejects a durable definition without caller-owned durable invocation options before registration', async () => {
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
    const wait = defineWorkflow('missingDurableInvocation', {
      input: z.string(), output: z.string(), durable: true,
      async handler(context) {
        await context.externalWait.wait(request)
        return context.input
      },
    })
    const instance = await defineHarness({ name: 'missingDurableInvocationHarness', revision: 'release-1' })
      .addWorkflow(wait).getInstance({ storage })
    const session = await instance.getSession('missing-durable-session')

    await expect(session.workflows.missingDurableInvocation.run('input')).rejects.toMatchObject({
      code: 'EXTERNAL_WAIT_ERROR', reason: 'durable_required',
    })
    expect(storage.registrations).toBe(0)
    await expect(storage.getWait(request.waitId)).resolves.toBeUndefined()
    await session.destroy()
    await instance.close()
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
