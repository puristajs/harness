import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { HarnessConfigError, defineHarness, type ModelProvider } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

const answerSchema = z.object({ answer: z.string() })

const supportDefinition = defineHarness({ name: 'portable-support' })
  .requireModel('primary', { capabilities: ['object'] as const })
  .agent('answer', {
    model: 'primary',
    input: z.object({ question: z.string() }),
    output: answerSchema,
    instructions: 'Answer the question.',
  })
  .define()

describe('portable Harness definitions', () => {
  it('exposes an immutable provider-free contribution catalog', () => {
    expect(supportDefinition.name).toBe('portable-support')
    expect(supportDefinition.catalog.models.primary).toEqual({ capabilities: ['object'] })
    expect(supportDefinition.catalog.agents.answer.updates).toBe('none')
    expect(Object.isFrozen(supportDefinition)).toBe(true)
    expect(Object.isFrozen(supportDefinition.catalog)).toBe(true)
  })

  it('instantiates the same definition with independent runtime model bindings', async () => {
    const firstProvider = new FakeModelProvider()
    firstProvider.enqueue({
      object: { answer: 'first' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    const secondProvider = new FakeModelProvider()
    secondProvider.enqueue({
      object: { answer: 'second' },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })

    const first = await supportDefinition.getInstance({
      models: { primary: { provider: firstProvider, model: 'model-a' } },
    })
    const second = await supportDefinition.getInstance({
      models: { primary: { provider: secondProvider, model: 'model-b' } },
    })
    const firstSession = await first.getSession('first')
    const secondSession = await second.getSession('second')

    await expect(firstSession.agents.answer.run({ question: 'Which instance?' })).resolves.toMatchObject({ status: 'completed', output: { answer: 'first' } })
    await expect(secondSession.agents.answer.run({ question: 'Which instance?' })).resolves.toMatchObject({ status: 'completed', output: { answer: 'second' } })

    await first.shutdown()
    await second.shutdown()
  })

  it('fails before startup when a binding is missing or lacks a required operation', async () => {
    await expect(
      supportDefinition.getInstance({ models: {} } as unknown as Parameters<typeof supportDefinition.getInstance>[0]),
    ).rejects.toMatchObject({ code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'missing_model_binding' } })

    const incompleteProvider: ModelProvider = { id: 'incomplete', genAiSystem: 'test' }
    await expect(
      supportDefinition.getInstance({
        models: { primary: { provider: incompleteProvider, model: 'missing-object' } },
      }),
    ).rejects.toBeInstanceOf(HarnessConfigError)
  })

  it('binds provider-neutral host tools and keeps host context run-scoped', async () => {
    const provider = new FakeModelProvider()
    provider.enqueue({
      object: {},
      toolCalls: [{ id: 'lookup-1', name: 'lookup_account', arguments: { accountId: 'account-1' } }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
    })
    provider.enqueue({
      object: 'approved',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    const calls: unknown[] = []
    const definition = defineHarness({ name: 'host-tools' })
      .requireModel('primary', { capabilities: ['object', 'tool_use'] as const })
      .hostTool('lookup_account', {
        kind: 'host',
        description: 'Look up an account through the embedding application.',
        input: z.object({ accountId: z.string() }),
        output: z.object({ owner: z.string() }),
      })
      .agent('review', {
        model: 'primary',
        input: z.string(),
        output: z.string(),
        instructions: 'Use the account lookup tool.',
        tools: ['lookup_account'],
      })
      .define()

    expect(definition.catalog.hostTools.lookup_account.description).toContain('embedding application')
    await expect(
      definition.getInstance({
        models: { primary: { provider, model: 'fake' } },
      } as never),
    ).rejects.toMatchObject({ meta: { reason: 'missing_host_tool_binding' } })

    const harness = await definition.getInstance<{ tenantId: string }>({
      models: { primary: { provider, model: 'fake' } },
      hostTools: {
        lookup_account: async (context, input) => {
          calls.push({ host: context.host, input })
          return { owner: 'Ada' }
        },
      },
    })
    const session = await harness.getSession('host-session')
    await expect(
      session.agents.review.run('Review it', { hostContext: { tenantId: 'tenant-a' } }),
    ).resolves.toMatchObject({ status: 'completed', output: 'approved' })
    expect(calls).toEqual([{ host: { tenantId: 'tenant-a' }, input: { accountId: 'account-1' } }])
    await harness.shutdown()
  })
})
