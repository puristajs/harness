import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineHarness, defineWorkflow, localDurableExecution } from '@purista/harness'

const planInput = z.object({ topic: z.string() }).strict()
const planOutput = z.object({ done: z.boolean(), topic: z.string() })
const reviewWait = {
  waitId: 'plan-review',
  kind: 'human_review',
  schemaVersion: 'plan-review-v1',
  definitionVersion: 'v1',
  deadline: '2099-01-01T00:00:00.000Z',
} as const

export async function createLocalDurableHarness(root?: string) {
  const local = localDurableExecution({
    root: root ?? (await mkdtemp(join(tmpdir(), 'purista-local-durable-'))),
    exec: false,
  })
  const plan = defineWorkflow('plan', {
    input: planInput,
    output: planOutput,
    durable: true,
    workspace: true,
    async handler(context) {
      await context.step('outline', async () => ({ topic: context.input.topic, next: 'review' }))
      const decision = await context.externalWait.wait(reviewWait)
      if (decision.status !== 'approved') return { done: false, topic: context.input.topic }
      await context.step('draft', async () => ({ draft: true }))
      return { done: true, topic: context.input.topic }
    },
  })
  const harness = await defineHarness({ name: 'localDurableExample', revision: 'v1' }).addWorkflow(plan)
    .getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace })
  return { local, harness }
}

export async function runLocalDurableExample(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'purista-local-durable-'))
  const first = await createLocalDurableHarness(root)
  const firstSession = await first.harness.getSession('demo')
  await firstSession.workflows.plan.run({ topic: 'durable local work' }, { durable: { runId: 'demo-run' } })
  await first.harness.close()

  const second = await createLocalDurableHarness(root)
  await second.local.storage.signalWait({ waitId: reviewWait.waitId, eventId: 'review-approved', outcome: 'approved' })
  const secondSession = await second.harness.getSession('demo')
  console.log(await secondSession.workflows.plan.run(
    { topic: 'durable local work' },
    { durable: { runId: 'demo-run' } },
  ))
  await second.harness.close()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLocalDurableExample().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
