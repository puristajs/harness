import { describe, expect, it } from 'vitest'
import { createReviewHarness } from './index.js'

describe('workflow child tasks example', () => {
  it('retrieves a background result and keeps a continuable conversation isolated', async () => {
    const harness = createReviewHarness()
    const session = await harness.getSession('example-test')
    const { taskId } = await session.workflows.start_review.prompt({ documentId: 'DOC-42' })

    await expect((await session.childTasks.get(taskId))?.result()).resolves.toEqual({ documentId: 'DOC-42', verdict: 'approved' })
    await expect(session.workflows.private_follow_up.prompt('first note')).resolves.toBe('2:follow-up')
    await harness.shutdown()
  })
})
