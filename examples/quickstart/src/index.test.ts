import { describe, expect, it } from 'vitest'
import { FakeModelProvider } from '@purista/harness/testing'
import { createQuickstartHarness } from './index.js'

describe('quickstart', () => {
  it('runs the typed quickstart agent with an injected provider', async () => {
    const provider = new FakeModelProvider({ strict: true })
    provider.enqueueObject({
      object: { answer: 'A harness wires providers, agents, workflows, and sessions behind typed boundaries.' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    const harness = await createQuickstartHarness(provider)

    try {
      const session = await harness.getSession('quickstart-test')
      const output = await session.agents.assistant.run({ topic: 'harnesses' })
      expect(output.status).toBe('completed')
      if (output.status !== 'completed') throw new Error('Expected the quickstart agent to complete.')
      expect(output.output.answer).toContain('typed boundaries')
      expect(provider.requests).toHaveLength(1)
      provider.assertExhausted()
    } finally {
      await harness.close()
    }
  })
})
