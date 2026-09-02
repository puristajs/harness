import { defineHarness, inMemorySandbox } from '@purista/harness'
import { z } from 'zod'

/**
 * A real application could replace these deterministic handlers with model-loop
 * agents. Keeping them local makes the example runnable without credentials.
 */
export function createReviewHarness() {
  return defineHarness()
    .sandbox(inMemorySandbox())
    .models({
      local: { provider: { id: 'example', genAiSystem: 'example' }, model: 'example', capabilities: ['object'] },
    })
    .agent('reviewer', {
      input: z.object({ documentId: z.string() }),
      output: z.object({ documentId: z.string(), verdict: z.string() }),
      handler: async ({ input }) => ({ documentId: input.documentId, verdict: 'approved' }),
    })
    .agent('clarifier', {
      input: z.string(),
      output: z.string(),
      handler: async ({ input, history }) => `${(await history.list()).length}:${input}`,
    })
    .workflow('start_review', {
      input: z.object({ documentId: z.string() }),
      output: z.object({ taskId: z.string() }),
      delegation: { agents: ['reviewer', 'clarifier'], maxParallelChildAgentCalls: 2 },
      handler: async (ctx) => {
        const task = await ctx.childTasks.start('reviewer', { documentId: ctx.input.documentId })
        return { taskId: task.id }
      },
    })
    .workflow('private_follow_up', {
      input: z.string(),
      output: z.string(),
      delegation: { agents: ['reviewer', 'clarifier'] },
      handler: async (ctx) => {
        const task = await ctx.childTasks.start('clarifier', ctx.input, { mode: 'continuable' })
        await task.send('follow-up')
        return (await task.close()) ?? 'no response'
      },
    })
    .build()
}

export async function runExample(): Promise<void> {
  const harness = createReviewHarness()
  const session = await harness.getSession('review-demo')
  const start = await session.workflows.start_review.run({ documentId: 'DOC-42' })
  if (start.status === 'interrupted') throw new Error(`Review workflow interrupted: ${start.interrupt.type}`)
  const { taskId } = start.output
  const review = await (await session.childTasks.get(taskId))?.result()
  const followUp = await session.workflows.private_follow_up.run('first note')
  if (followUp.status === 'interrupted') throw new Error(`Follow-up workflow interrupted: ${followUp.interrupt.type}`)
  console.log({ review, followUp: followUp.output })
  await harness.shutdown()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExample().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
