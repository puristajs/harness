import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  defineHarness,
  ExternalWaitError,
  ExternalWaitPendingError,
  InMemoryHarnessStorage,
  inMemoryHarnessStorage,
  inMemorySandbox,
} from '../src/index.js'
import {
  validateExternalWaitRequest,
  validateExternalWaitSignal,
  validateExternalWaitSnapshot,
  type BoundExternalWaitRequest,
  type ExternalWaitRegistration,
  type ExternalWaitSnapshot,
} from '../src/storage/external-wait.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

function harnessWithExternalWait(storage: InMemoryHarnessStorage, waitId: string) {
  return defineHarness()
    .sandbox(inMemorySandbox())
    .storage(storage)
    .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
    .tools({})
    .skills({})
    .agent('noop', { model: 'fake', instructions: 'noop', builtinTools: false })
    .workflow('wait', {
      input: z.string(),
      output: z.string(),
      handler: async (ctx) => {
        await ctx.externalWait.wait({
          waitId,
          kind: 'human_review',
          schemaVersion: 'v1',
          definitionVersion: 'v1',
          deadline: '2030-01-01T00:00:00.000Z',
        })
        return 'unreachable'
      },
    })
    .build()
}

describe('durable external waits', () => {
  it('uses strict request, signal, and discriminated snapshot shapes', () => {
    const request = {
      waitId: 'wait-1',
      kind: 'human_review',
      schemaVersion: 'v1',
      definitionVersion: 'v1',
      deadline: '2030-01-01T00:00:00.000Z',
    }

    expect(validateExternalWaitRequest(request)).toEqual(request)
    expect(() => validateExternalWaitRequest({ ...request, extra: true })).toThrow(
      expect.objectContaining({ reason: 'invalid_request' } satisfies Partial<ExternalWaitError>),
    )
    expect(() => validateExternalWaitRequest({ ...request, deadline: '2030-01-01T00:00:00Z' })).toThrow(
      expect.objectContaining({ reason: 'invalid_request' } satisfies Partial<ExternalWaitError>),
    )
    expect(() =>
      validateExternalWaitSignal({
        waitId: 'wait-1',
        eventId: 'event-1',
        outcome: 'approved',
        observedAt: '2030-01-01T00:00:00.000Z',
        extra: true,
      }),
    ).toThrow(expect.objectContaining({ reason: 'invalid_request' } satisfies Partial<ExternalWaitError>))
    expect(() =>
      validateExternalWaitSnapshot({
        ...request,
        status: 'approved',
        createdAt: request.deadline,
        resolvedAt: request.deadline,
      }),
    ).toThrow(expect.objectContaining({ reason: 'invalid_snapshot' } satisfies Partial<ExternalWaitError>))
    expect(() =>
      validateExternalWaitSnapshot({
        ...request,
        status: 'expired',
        createdAt: request.deadline,
        resolvedAt: request.deadline,
        eventId: undefined,
      }),
    ).toThrow(expect.objectContaining({ reason: 'invalid_snapshot' } satisfies Partial<ExternalWaitError>))
  })

  it('expires against the injected clock before a signal and retains the automatic-expiry shape', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z')
    const storage = inMemoryHarnessStorage({ now: () => now })
    await storage.createRun({
      id: 'run-at-deadline',
      sessionId: 'session-at-deadline',
      kind: 'workflow',
      target: 'wait',
      startedAt: now.toISOString(),
      status: 'running',
    })
    await storage.acquireRun({
      runId: 'run-at-deadline',
      sessionId: 'session-at-deadline',
      workerId: 'worker',
      stepId: 'wait',
      input: null,
    })
    const registration = await storage.registerWait({
      runId: 'run-at-deadline',
      sessionId: 'session-at-deadline',
      waitId: 'wait-at-deadline',
      kind: 'human_review',
      schemaVersion: 'v1',
      definitionVersion: 'v1',
      deadline: now.toISOString(),
    })

    expect(registration.snapshot).toEqual({
      waitId: 'wait-at-deadline',
      kind: 'human_review',
      schemaVersion: 'v1',
      definitionVersion: 'v1',
      deadline: now.toISOString(),
      status: 'waiting',
      createdAt: now.toISOString(),
    })
    const late = await storage.signalWait({
      waitId: 'wait-at-deadline',
      eventId: 'late-delivery',
      outcome: 'approved',
      observedAt: '2029-12-31T23:59:59.000Z',
    })
    expect(late).toEqual({
      kind: 'already_terminal',
      snapshot: {
        waitId: 'wait-at-deadline',
        kind: 'human_review',
        schemaVersion: 'v1',
        definitionVersion: 'v1',
        deadline: now.toISOString(),
        status: 'expired',
        createdAt: now.toISOString(),
        resolvedAt: now.toISOString(),
      },
    })
    await expect(
      storage.signalWait({ waitId: 'wait-at-deadline', eventId: 'late-delivery', outcome: 'approved' }),
    ).resolves.toEqual({ kind: 'duplicate', snapshot: late.snapshot })
    await expect(storage.getWait('')).rejects.toMatchObject({ reason: 'invalid_request' })
    await expect(storage.cancelWait('wait-at-deadline', '', now.toISOString())).rejects.toMatchObject({
      reason: 'invalid_request',
    })
  })

  it('rejects a malformed adapter readback before emitting external-wait events', async () => {
    class MalformedWaitStorage extends InMemoryHarnessStorage {
      public override async registerWait(request: BoundExternalWaitRequest): Promise<ExternalWaitRegistration> {
        const registration = await super.registerWait(request)
        Object.defineProperty(registration.snapshot, 'unexpected', { enumerable: true, value: true })
        return registration
      }
    }
    const storage = new MalformedWaitStorage()
    const harness = harnessWithExternalWait(storage, 'invalid-readback')
    const session = await harness.getSession('invalid-readback-session')

    await expect(
      session.workflows.wait.run('x', { durable: { runId: 'invalid-readback-run' } }),
    ).rejects.toMatchObject({ reason: 'invalid_snapshot' })
    expect(
      (await storage.listEvents('invalid-readback-run')).filter((event) => event.type.startsWith('external_wait.')),
    ).toEqual([])
  })

  it('rejects malformed and foreign getWait readbacks before requested or resolved events', async () => {
    class MalformedReadbackStorage extends InMemoryHarnessStorage {
      public override async getWait(waitId: string): Promise<ExternalWaitSnapshot | undefined> {
        const snapshot = await super.getWait(waitId)
        if (snapshot) Object.defineProperty(snapshot, 'unexpected', { enumerable: true, value: true })
        return snapshot
      }
    }
    class ForeignReadbackStorage extends InMemoryHarnessStorage {
      public override async getWait(waitId: string): Promise<ExternalWaitSnapshot | undefined> {
        const snapshot = await super.getWait(waitId)
        return snapshot ? { ...snapshot, kind: 'foreign_wait_kind' } : undefined
      }
    }

    for (const [storage, waitId, runId, sessionId] of [
      [new MalformedReadbackStorage(), 'malformed-get', 'malformed-get-run', 'malformed-get-session'],
      [new ForeignReadbackStorage(), 'foreign-get', 'foreign-get-run', 'foreign-get-session'],
    ] as const) {
      const harness = harnessWithExternalWait(storage, waitId)
      const session = await harness.getSession(sessionId)
      await expect(session.workflows.wait.run('x', { durable: { runId } })).rejects.toMatchObject({
        reason: 'invalid_snapshot',
      })
      expect((await storage.listEvents(runId)).filter((event) => event.type.startsWith('external_wait.'))).toEqual([])
    }
  })

  it('persists a wait, releases the run, and resumes without replaying completed side effects', async () => {
    const storage = inMemoryHarnessStorage()
    const effects = { prepared: 0, executed: 0 }
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .storage(storage)
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('noop', { model: 'fake', instructions: 'noop', builtinTools: false })
      .workflow('transfer', {
        input: z.object({ id: z.string() }),
        output: z.string(),
        handler: async (ctx) => {
          await ctx.step('prepare', async () => {
            effects.prepared += 1
            return { prepared: true }
          })
          const decision = await ctx.externalWait.wait({
            waitId: `review-${ctx.input.id}`,
            kind: 'human_review',
            schemaVersion: 'v1',
            definitionVersion: 'transfer-v1',
            deadline: '2030-01-01T00:00:00.000Z',
          })
          if (decision.status !== 'approved') return decision.status
          await ctx.step('execute', async () => {
            effects.executed += 1
            return { executed: true }
          })
          return 'executed'
        },
      })
      .build()
    const session = await harness.getSession('review-session')

    await expect(
      session.workflows.transfer.run({ id: 'a' }, { durable: { runId: 'review-run' } }),
    ).rejects.toBeInstanceOf(ExternalWaitPendingError)
    expect(effects).toEqual({ prepared: 1, executed: 0 })
    expect((await session.getRunSummary('review-run'))?.status).toBe('waiting')
    expect((await storage.getWait('review-a'))?.status).toBe('waiting')

    expect((await storage.signalWait({ waitId: 'review-a', eventId: 'delivery-1', outcome: 'approved' })).kind).toBe(
      'applied',
    )
    expect((await storage.signalWait({ waitId: 'review-a', eventId: 'delivery-1', outcome: 'approved' })).kind).toBe(
      'duplicate',
    )

    await expect(session.workflows.transfer.run({ id: 'a' }, { durable: { runId: 'review-run' } })).resolves.toBe(
      'executed',
    )
    expect(effects).toEqual({ prepared: 1, executed: 1 })
    expect((await session.getRunSummary('review-run'))?.status).toBe('succeeded')
  })

  it('rejects durable waits outside a durable workflow invocation', async () => {
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('noop', { model: 'fake', instructions: 'noop', builtinTools: false })
      .workflow('wait', {
        input: z.string(),
        output: z.string(),
        handler: (ctx) =>
          ctx.externalWait
            .wait({
              waitId: 'x',
              kind: 'human_review',
              schemaVersion: 'v1',
              definitionVersion: 'v1',
              deadline: '2030-01-01T00:00:00.000Z',
            })
            .then(() => 'done'),
      })
      .build()
    const session = await harness.getSession('non-durable')
    await expect(session.workflows.wait.run('x')).rejects.toMatchObject({
      name: 'ExternalWaitError',
      reason: 'durable_required',
    })
  })
})
