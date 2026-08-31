import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { defineHarness } from '../index.js'
import { FakeModelProvider } from '../testing/index.js'

describe('Session.getRunSummary', () => {
  it('derives run totals and call counts from persisted state events', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObject({
      object: { label: 'ok' },
      usage: {
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 1,
        reasoningTokens: 3,
      },
      finishReason: 'stop',
    })

    const harness = defineHarness({ name: 'summary-test' })
      .models({
        fake: {
          provider,
          model: 'fake-model',
          capabilities: ['object'],
        },
      })
      .agent('triage', {
        model: 'fake',
        input: z.object({ message: z.string() }),
        output: z.object({ label: z.string() }),
        builtinTools: false,
        instructions: 'Return a label.',
      })
      .build()

    const session = await harness.getSession('user:1')
    const events = []
    for await (const event of session.agents.triage.stream({ message: 'hello' })) {
      events.push(event)
    }
    const runId = events[0]?.runId

    expect(runId).toBeTypeOf('string')
    await expect(session.getRunSummary(runId as string)).resolves.toMatchObject({
      runId,
      sessionId: 'user:1',
      status: 'succeeded',
      tokenTotals: {
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
        cachedInputTokens: 2,
        cacheCreationInputTokens: 1,
        reasoningTokens: 3,
      },
      modelCalls: 1,
      toolCalls: 0,
      agentCalls: 1,
    })

    await harness.shutdown()
  })
})
