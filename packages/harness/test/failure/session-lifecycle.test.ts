import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineHarness, defineWorkflow, InMemoryHarnessStorage, JsonLogger, StateError, type SessionRecord } from '../../src/index.js'
import type { RunRecord } from '../../src/models/state.js'
import type { CreateRunRequest, FinalizeRunRequest } from '../../src/storage/types.js'

const workflow = defineWorkflow('lifecycleFailure', {
  input: z.string(), output: z.string(), durable: true,
  async handler({ input }) { return input },
})

async function instanceWith(storage: InMemoryHarnessStorage) {
  const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
  Object.defineProperties(storage, {
    capabilities: { value: capabilities },
    info: { value: Object.freeze({ ...storage.info, capabilities }) },
  })
  return defineHarness({ name: 'lifecycleFailureHarness', revision: 'release-1' })
    .addWorkflow(workflow).getInstance({ storage,
      logger: new JsonLogger({ level: 'fatal', out: { write: () => undefined } }),
    })
}

describe('v4 storage failure lifecycle', () => {
  it('does not execute the workflow when durable run creation fails', async () => {
    let createCalls = 0
    class CreateFailureStorage extends InMemoryHarnessStorage {
      public override async createRun(_request: CreateRunRequest): Promise<RunRecord> {
        createCalls += 1
        throw new StateError('createRun failed', { op: 'createRun', reason: 'injected_failure' })
      }
    }
    const storage = new CreateFailureStorage()
    const instance = await instanceWith(storage)
    const session = await instance.getSession('create-failure')

    await expect(session.workflows.lifecycleFailure.run('input', { durable: { runId: 'create-failure-run' } }))
      .rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'createRun' } })
    expect(createCalls).toBe(1)
    expect(await storage.listEvents('create-failure-run')).toEqual([])
    await session.destroy()
    await instance.close()
  })

  it('surfaces atomic finalization failure after the workflow handler completes', async () => {
    const finalizationFailure = new StateError('finalizeRun failed', { op: 'finalizeRun', reason: 'injected_failure' })
    class FinalizeFailureStorage extends InMemoryHarnessStorage {
      public finalizeCalls = 0
      public override async finalizeRun(request: FinalizeRunRequest): Promise<void> {
        this.finalizeCalls += 1
        await super.finalizeRun(request)
        if (this.finalizeCalls === 1) throw finalizationFailure
      }
    }
    const storage = new FinalizeFailureStorage()
    const instance = await instanceWith(storage)
    const session = await instance.getSession('finalize-failure')

    const stream = session.workflows.lifecycleFailure.stream('input', { durable: { runId: 'finalize-failure-run' } })
    const liveEvents: unknown[] = []
    const drained = (async () => { for await (const event of stream) liveEvents.push(event) })()

    await expect(stream.result).rejects.toBe(finalizationFailure)
    await expect(drained).rejects.toBe(finalizationFailure)
    expect(storage.finalizeCalls).toBe(1)
    expect(liveEvents).not.toContainEqual(expect.objectContaining({ type: 'run.finished' }))
    await expect(storage.getRun('finalize-failure-run')).resolves.toMatchObject({ status: 'succeeded', output: 'input' })
    await expect(storage.listEvents('finalize-failure-run')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.finished', payload: expect.objectContaining({ outcome: expect.objectContaining({ status: 'completed' }) }) }),
    ]))
    await expect(session.release()).resolves.toBeUndefined()
    await instance.close()
  })

  it('releases a durable run after finalization fails before persistence and retries the effect exactly once', async () => {
    const finalizationFailure = new StateError('finalizeRun failed before persistence', {
      op: 'finalizeRun', reason: 'injected_failure',
    })
    class FinalizeFailureStorage extends InMemoryHarnessStorage {
      public finalizeCalls = 0
      public override async finalizeRun(request: FinalizeRunRequest): Promise<void> {
        this.finalizeCalls += 1
        if (this.finalizeCalls === 1) throw finalizationFailure
        await super.finalizeRun(request)
      }
    }
    let effectCalls = 0
    const retryWorkflow = defineWorkflow('retryFinalizationFailure', {
      input: z.string(), output: z.string(), durable: true,
      async handler({ input, step }) {
        return step('effect', async () => {
          effectCalls += 1
          return input
        })
      },
    })
    const storage = new FinalizeFailureStorage()
    const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
    Object.defineProperties(storage, {
      capabilities: { value: capabilities },
      info: { value: Object.freeze({ ...storage.info, capabilities }) },
    })
    const instance = await defineHarness({ name: 'finalizationRetryHarness', revision: 'release-1' })
      .addWorkflow(retryWorkflow).getInstance({ storage,
        logger: new JsonLogger({ level: 'fatal', out: { write: () => undefined } }),
      })
    const session = await instance.getSession('finalization-retry')
    const durable = { runId: 'finalization-retry-run' } as const

    const first = session.workflows.retryFinalizationFailure.stream('input', { durable })
    const firstEvents: unknown[] = []
    const firstDrain = (async () => { for await (const event of first) firstEvents.push(event) })()

    await expect(first.result).rejects.toBe(finalizationFailure)
    await expect(firstDrain).rejects.toBe(finalizationFailure)
    expect(firstEvents).not.toContainEqual(expect.objectContaining({ type: 'run.finished' }))
    await expect(storage.getRun(durable.runId)).resolves.toMatchObject({ status: 'interrupted' })

    const retry = session.workflows.retryFinalizationFailure.stream('input', { durable })
    const retryEvents: unknown[] = []
    for await (const event of retry) retryEvents.push(event)
    await expect(retry.result).resolves.toEqual({ status: 'completed', runId: durable.runId, output: 'input' })

    expect(effectCalls).toBe(1)
    expect(storage.finalizeCalls).toBe(2)
    expect(retryEvents.filter(event => (event as { type?: string }).type === 'run.finished')).toHaveLength(1)
    await expect(storage.listEvents(durable.runId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.finished', payload: expect.objectContaining({ outcome: expect.objectContaining({ status: 'completed' }) }) }),
    ]))
    expect((await storage.listEvents(durable.runId)).filter(event => event.type === 'run.finished')).toHaveLength(1)
    await expect(session.release()).resolves.toBeUndefined()
    await instance.close()
  })

  it('preserves the completed run when the terminal session summary update fails', async () => {
    class SessionUpdateFailureStorage extends InMemoryHarnessStorage {
      public createCalls = 0
      public override async upsertSession(record: SessionRecord, mode: 'create' | 'update'): Promise<boolean> {
        if (mode === 'update' && record.runCount > 0) {
          throw new StateError('upsertSession failed', { op: 'upsertSession', reason: 'injected_failure' })
        }
        return super.upsertSession(record, mode)
      }
      public override async createRun(request: CreateRunRequest): Promise<RunRecord> {
        this.createCalls += 1
        return super.createRun(request)
      }
    }
    const storage = new SessionUpdateFailureStorage()
    const instance = await instanceWith(storage)
    const session = await instance.getSession('session-update-failure')

    await expect(session.workflows.lifecycleFailure.run('input', { durable: { runId: 'session-update-run' } }))
      .resolves.toEqual({ status: 'completed', runId: 'session-update-run', output: 'input' })
    expect(storage.createCalls).toBe(1)
    await expect(storage.getRun('session-update-run')).resolves.toMatchObject({ status: 'succeeded' })
    await expect(storage.getSession('session-update-failure')).resolves.toMatchObject({ runCount: 0 })
    await session.destroy()
    await instance.close()
  })
})
