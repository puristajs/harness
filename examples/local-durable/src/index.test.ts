import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalDurableHarness } from './index.js'

describe('local durable example', () => {
  it('resumes after a persisted external wait and cleans terminal checkpoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purista-local-durable-example-'))
    const first = await createLocalDurableHarness(root)
    const firstSession = await first.harness.getSession('demo')
    await expect(firstSession.workflows.plan.run(
      { topic: 'docs' },
      { durable: { runId: 'demo-run' } },
    )).resolves.toMatchObject({ status: 'interrupted', interrupt: { type: 'external-wait', id: 'plan-review' } })
    await first.harness.close()

    const second = await createLocalDurableHarness(root)
    await second.local.storage.signalWait({ waitId: 'plan-review', eventId: 'review-approved', outcome: 'approved' })
    const secondSession = await second.harness.getSession('demo')
    await expect(secondSession.workflows.plan.run(
      { topic: 'docs' },
      { durable: { runId: 'demo-run' } },
    )).resolves.toMatchObject({ status: 'completed', output: { done: true, topic: 'docs' } })
    await expect(second.local.storage.loadCheckpoint('demo-run')).resolves.toBeUndefined()
    await second.harness.close()
  })
})
