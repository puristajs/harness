import { describe, expect, it } from 'vitest'
import { createShowcaseHarness, ScriptedObjectProvider } from './index.js'

describe('showcase harness examples', () => {
  it('runs a typed workflow with a mounted skill', async () => {
    const provider = new ScriptedObjectProvider()
    const { harness } = createShowcaseHarness(provider)
    const session = await harness.getSession('showcase-skills')

    const result = await session.workflows.summarize_incident.run({
      incident: 'Checkout errors increased for EU users after deploy.'
    })

    expect(result.summary).toContain('Impact')
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain('incident-responder')
    await harness.shutdown()
  })

  it('runs an agent with an explicitly allowed TypeScript tool', async () => {
    const provider = new ScriptedObjectProvider()
    const { harness } = createShowcaseHarness(provider)
    const session = await harness.getSession('showcase-tools')

    const result = await session.workflows.answer_policy_question.run({
      question: 'What should we do for a customer-impacting security incident?'
    })

    expect(result.answer).toContain('Policy for security')
    expect(provider.requests[0]?.tools).toHaveLength(1)
    await harness.shutdown()
  })
})
