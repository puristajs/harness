import { defineHarness, inMemorySandbox } from '@purista/harness'
import { z } from 'zod'

/**
 * A real application could replace these deterministic handlers with model-loop
 * agents. Keeping them local makes the example runnable without credentials.
 */
export function createReviewHarness() {
  return defineHarness()
    .sandbox(inMemorySandbox())
    .models({ local: { provider: { id: 'example', genAiSystem: 'example' }, model: 'example', capabilities: ['object'] } })
    .agents(({ agent }) => ({
      reviewer: agent({
        model: 'local', input: z.object({ documentId: z.string() }), output: z.object({ documentId: z.string(), verdict: z.string() }),
        builtinTools: false, instructions: 'Review the document.',
        handler: async ({ input }) => ({ documentId: input.documentId, verdict: 'approved' })
      }),
      clarifier: agent({
        model: 'local', input: z.string(), output: z.string(), builtinTools: false, instructions: 'Keep private notes.',
        handler: async ({ input, history }) => `${(await history.list()).length}:${input}`
      })
    }))
    .workflows(({ workflow }) => ({
      start_review: workflow({
        input: z.object({ documentId: z.string() }), output: z.object({ taskId: z.string() }),
        delegation: { agents: ['reviewer', 'clarifier'], maxParallelChildAgentCalls: 2 },
        handler: async (ctx) => {
          const task = await ctx.childTasks.start('reviewer', { documentId: ctx.input.documentId })
          return { taskId: task.id }
        }
      }),
      private_follow_up: workflow({
        input: z.string(), output: z.string(), delegation: { agents: ['reviewer', 'clarifier'] },
        handler: async (ctx) => {
          const task = await ctx.childTasks.start('clarifier', ctx.input, { mode: 'continuable' })
          await task.send('follow-up')
          return (await task.close()) ?? 'no response'
        }
      })
    }))
    .build()
}

export async function runExample(): Promise<void> {
  const harness = createReviewHarness()
  const session = await harness.getSession('review-demo')
  const { taskId } = await session.workflows.start_review.prompt({ documentId: 'DOC-42' })
  const review = await (await session.childTasks.get(taskId))?.result()
  const followUp = await session.workflows.private_follow_up.prompt('first note')
  console.log({ review, followUp })
  await harness.shutdown()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExample().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
