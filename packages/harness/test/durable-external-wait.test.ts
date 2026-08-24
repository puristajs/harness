import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  defineHarness,
  ExternalWaitPendingError,
  inMemoryHarnessStorage,
  inMemorySandbox
} from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

describe('durable external waits', () => {
  it('persists a wait, releases the run, and resumes without replaying completed side effects', async () => {
    const storage = inMemoryHarnessStorage()
    const effects = { prepared: 0, executed: 0 }
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .storage(storage)
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents({ noop: { model: 'fake', instructions: 'noop', builtinTools: false } })
      .workflows({
        transfer: {
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
              deadline: '2030-01-01T00:00:00.000Z'
            })
            if (decision.status !== 'approved') return decision.status
            await ctx.step('execute', async () => {
              effects.executed += 1
              return { executed: true }
            })
            return 'executed'
          }
        }
      })
      .build()
    const session = await harness.getSession('review-session')

    await expect(session.workflows.transfer.prompt({ id: 'a' }, { durable: { runId: 'review-run' } }))
      .rejects.toBeInstanceOf(ExternalWaitPendingError)
    expect(effects).toEqual({ prepared: 1, executed: 0 })
    expect((await session.getRunSummary('review-run'))?.status).toBe('waiting')
    expect((await storage.getWait('review-a'))?.status).toBe('waiting')

    expect((await storage.signalWait({ waitId: 'review-a', eventId: 'delivery-1', outcome: 'approved' })).kind).toBe('applied')
    expect((await storage.signalWait({ waitId: 'review-a', eventId: 'delivery-1', outcome: 'approved' })).kind).toBe('duplicate')

    await expect(session.workflows.transfer.prompt({ id: 'a' }, { durable: { runId: 'review-run' } })).resolves.toBe('executed')
    expect(effects).toEqual({ prepared: 1, executed: 1 })
    expect((await session.getRunSummary('review-run'))?.status).toBe('succeeded')
  })

  it('rejects durable waits outside a durable workflow invocation', async () => {
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents({ noop: { model: 'fake', instructions: 'noop', builtinTools: false } })
      .workflows({
        wait: {
          input: z.string(), output: z.string(),
          handler: (ctx) => ctx.externalWait.wait({ waitId: 'x', kind: 'human_review', schemaVersion: 'v1', definitionVersion: 'v1', deadline: '2030-01-01T00:00:00.000Z' }).then(() => 'done')
        }
      })
      .build()
    const session = await harness.getSession('non-durable')
    await expect(session.workflows.wait.prompt('x')).rejects.toMatchObject({ name: 'ExternalWaitError', reason: 'durable_required' })
  })
})
