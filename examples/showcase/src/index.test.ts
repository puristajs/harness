import { describe, expect, it } from 'vitest'
import { createShowcaseHarness, ScriptedObjectProvider } from './index.js'

describe('showcase harness examples', () => {
  it('runs a typed workflow with a mounted skill', async () => {
    const provider = new ScriptedObjectProvider()
    const { harness: harnessPromise } = createShowcaseHarness(provider)
    const harness = await harnessPromise
    const session = await harness.getSession('showcase-skills')

    const result = await session.workflows.summarizeIncident.run({
      incident: 'Checkout errors increased for EU users after deploy.'
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error('Expected completed incident workflow.')
    expect(result.output.summary).toContain('Impact')
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain('incident-responder')
    await harness.close()
  })

  it('runs an agent with an explicitly allowed TypeScript tool', async () => {
    const provider = new ScriptedObjectProvider()
    const { harness: harnessPromise } = createShowcaseHarness(provider)
    const harness = await harnessPromise
    const session = await harness.getSession('showcase-tools')

    const result = await session.workflows.answerPolicyQuestion.run({
      question: 'What should we do for a customer-impacting security incident?'
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') throw new Error('Expected completed policy workflow.')
    expect(result.output.answer).toContain('Policy for security')
    expect(provider.requests[0]?.tools).toHaveLength(1)
    await harness.close()
  })
})
