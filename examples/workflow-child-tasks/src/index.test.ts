import { describe, expect, it } from 'vitest'
import { createReviewHarness } from './index.js'

describe('workflow child tasks example', () => {
  it('retrieves a background result and keeps a continuable conversation isolated', async () => {
    const harness = createReviewHarness()
    const session = await harness.getSession('example-test')
    const started = await session.workflows.start_review.run({ documentId: 'DOC-42' })
    expect(started.status).toBe('completed')
    if (started.status !== 'completed') throw new Error('Expected completed start_review workflow.')
    const { taskId } = started.output

    await expect((await session.childTasks.get(taskId))?.result()).resolves.toEqual({ documentId: 'DOC-42', verdict: 'approved' })
    await expect(session.workflows.private_follow_up.run('first note')).resolves.toMatchObject({ status: 'completed', output: '2:follow-up' })
    await harness.shutdown()
  })
})
