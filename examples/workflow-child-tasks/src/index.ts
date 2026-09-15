import { defineAgent, defineHarness, defineWorkflow } from '@purista/harness'
import { FakeModelProvider, objectReply, textReply } from '@purista/harness/testing'
import { z } from 'zod'

const reviewInput = z.object({ documentId: z.string() })
const reviewOutput = z.object({ documentId: z.string(), verdict: z.string() })

const reviewer = defineAgent('reviewer', {
  model: 'chat',
  input: reviewInput,
  output: reviewOutput,
  instructions: 'Review the document and return its id and verdict.',
  prompt: input => ({ role: 'user', content: `Review ${input.documentId}.` }),
})

const clarifier = defineAgent('clarifier', {
  model: 'chat',
  input: z.string(),
  output: z.string(),
  instructions: 'Answer each private follow-up concisely.',
  prompt: input => ({ role: 'user', content: input }),
})

const startReview = defineWorkflow('startReview', {
  input: reviewInput,
  output: z.object({ taskId: z.string() }),
  agents: [reviewer, clarifier],
  agentCalls: { maxParallel: 2 },
  async handler(context) {
    const task = await context.childTasks.start('reviewer', { documentId: context.input.documentId }, {
      callId: 'backgroundReview',
    })
    return { taskId: task.id }
  },
})

const privateFollowUp = defineWorkflow('privateFollowUp', {
  input: z.string(),
  output: z.string(),
  agents: [reviewer, clarifier],
  async handler(context) {
    const task = await context.childTasks.start('clarifier', context.input, {
      callId: 'privateClarification',
      mode: 'continuable',
    })
    await task.send('follow-up')
    return (await task.close()) ?? 'no response'
  },
})

const reviewHarness = defineHarness({ name: 'workflowChildTasksExample' })
  .addWorkflow(startReview)
  .addWorkflow(privateFollowUp)

/** Creates the runnable child-task example with deterministic model responses. */
export function createReviewHarness() {
  const provider = new FakeModelProvider({ strict: true })
  provider.enqueueObject(objectReply({ documentId: 'DOC-42', verdict: 'approved' }))
  provider.enqueueText(textReply('first response'))
  provider.enqueueText(textReply('follow-up response'))
  return reviewHarness.getInstance({ models: { chat: { provider, model: 'example' } } })
}

export async function runExample(): Promise<void> {
  const harness = await createReviewHarness()
  const session = await harness.getSession('review-demo')
  const start = await session.workflows.startReview.run({ documentId: 'DOC-42' })
  if (start.status !== 'completed') throw new Error('Review workflow interrupted.')
  const review = await (await session.childTasks.get(start.output.taskId))?.result()
  const followUp = await session.workflows.privateFollowUp.run('first note')
  if (followUp.status !== 'completed') throw new Error('Follow-up workflow interrupted.')
  console.log({ review, followUp: followUp.output })
  await harness.close()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExample().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
