import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalDurableHarness } from './index.js'

describe('local durable example', () => {
  it('resumes from the first committed step after a rebuild', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purista-local-durable-example-'))
    const first = await createLocalDurableHarness(root, { crashAfterOutline: true })
    const firstSession = await first.harness.getSession('demo')
    await expect(
      firstSession.workflows.plan.run({ topic: 'docs' }, { durable: { runId: 'demo-run' } }),
    ).rejects.toThrow('simulated crash')
    await first.harness.shutdown()

    const second = await createLocalDurableHarness(root)
    const secondSession = await second.harness.getSession('demo')
    await expect(
      secondSession.workflows.plan.run({ topic: 'docs' }, { durable: { runId: 'demo-run' } }),
    ).resolves.toEqual({ done: true, topic: 'docs' })
    await expect(second.local.storage.loadCheckpoint('demo-run')).resolves.toMatchObject({
      stepId: 'draft',
      sequence: 2,
    })
    await second.harness.shutdown()
  })
})
