import { describe, expect, it } from 'vitest'
import { FakeModelProvider } from '@purista/harness/testing'
import { createQuickstartHarness } from './index.js'

describe('quickstart', () => {
  it('runs the typed quickstart workflow with an injected provider', async () => {
    const provider = new FakeModelProvider({ strict: true })
    provider.enqueueObject({
      object: { answer: 'A harness wires providers, agents, workflows, and sessions behind typed boundaries.' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    const harness = createQuickstartHarness(provider)

    try {
      const session = await harness.getSession('quickstart-test')
      const output = await session.workflows.explain_quickstart.run({ topic: 'harnesses' })

      expect(output.answer).toContain('typed boundaries')
      await expect(session.memory.read<{ topic: string }>('last_topic')).resolves.toEqual({ topic: 'harnesses' })
      expect(provider.requests).toHaveLength(1)
      provider.assertExhausted()
    } finally {
      await harness.shutdown()
    }
  })
})
