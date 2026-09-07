import { z } from 'zod'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { HarnessConfigError, defineAgent, defineHarness, type ModelProvider } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

const answer = defineAgent('answer', {
  model: 'primary', input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
  instructions: 'Answer the question.', prompt: input => ({ role: 'user', content: input.question }),
})
const supportDefinition = defineHarness({ name: 'portableSupport' }).addAgent(answer)

describe('portable Harness definitions', () => {
  it('exposes immutable root contracts and sanitized inspection without a public catalog', () => {
    expect(supportDefinition.name).toBe('portableSupport')
    expect(supportDefinition.contracts.agents.answer).toMatchObject({
      kind: 'agent', id: 'answer', input: answer.input, output: answer.output, updates: 'object-snapshot',
    })
    expect(supportDefinition.inspect()).toMatchObject({
      roots: { agents: [{ kind: 'agent', id: 'answer', updates: 'object-snapshot' }], workflows: [] },
      dependencies: { agents: [], tools: [], skills: [], mcpServers: [], workflows: [] },
    })
    expect(supportDefinition.requirements.models.primary.capabilities).toContain('object')
    type SupportInfer = typeof supportDefinition.$infer
    expectTypeOf<SupportInfer['agents']['answer']['input']>().toEqualTypeOf<{ question: string }>()
    expectTypeOf<SupportInfer['agents']['answer']['output']>().toEqualTypeOf<{ answer: string }>()
    expect(Object.isFrozen(supportDefinition)).toBe(true)
    expect(Object.isFrozen(supportDefinition.contracts)).toBe(true)
    expect(supportDefinition).not.toHaveProperty('catalog')
  })

  it('instantiates the same definition with independent runtime model bindings', async () => {
    const firstProvider = new FakeModelProvider()
    firstProvider.enqueueObject({ object: { answer: 'first' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const secondProvider = new FakeModelProvider()
    secondProvider.enqueueObject({ object: { answer: 'second' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const first = await supportDefinition.getInstance({ model: { provider: firstProvider, model: 'model-a' } })
    const second = await supportDefinition.getInstance({ model: { provider: secondProvider, model: 'model-b' } })
    const firstSession = await first.getSession('first')
    const secondSession = await second.getSession('second')
    await expect(firstSession.agents.answer.run({ question: 'Which instance?' })).resolves.toMatchObject({ status: 'completed', output: { answer: 'first' } })
    await expect(secondSession.agents.answer.run({ question: 'Which instance?' })).resolves.toMatchObject({ status: 'completed', output: { answer: 'second' } })
    await first.close()
    await second.close()
  })

  it('fails before startup when a binding is missing or lacks the required operation', () => {
    expect(() => supportDefinition.getInstance({} as never)).toThrow(expect.objectContaining({
      code: 'HARNESS_CONFIG_ERROR', meta: { path: 'model', reason: 'missing_runtime_binding' },
    }))
    const incompleteProvider: ModelProvider = { id: 'incomplete', genAiSystem: 'test' }
    expect(() => supportDefinition.getInstance({ model: { provider: incompleteProvider, model: 'missing-object' } }))
      .toThrow(HarnessConfigError)
  })
})
