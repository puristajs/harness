import { expect, it } from 'vitest'
import { z } from 'zod'
import { defineHarness, inMemorySandbox } from '@purista/harness'
import { FakeModelProvider } from '@purista/harness/testing'
import { defineGuardrails, modelCheckRail, parseGuardrailsConfig } from '../src/index.js'

it('runs NeMo-shaped input and output rails with the Harness test adapter', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({ object: 'unsafe answer', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({
      models: [{ type: 'main', engine: 'harness', model: 'assistant' }],
      rails: {
        input: { flows: ['normalize input'] },
        output: { flows: ['redact output'] }
      }
    }),
    actions: {
      'normalize input': {
        evaluate: () => ({ decision: 'transform', target: 'user_message', value: 'safe question' })
      },
      'redact output': {
        evaluate: () => ({ decision: 'transform', target: 'bot_message', value: 'safe answer' })
      }
    }
  })
  const harness = defineHarness()
    .models({ assistant: { provider, model: 'fake', capabilities: ['object'] } })
    .agents({
      answer: rails.attach({ model: 'assistant', instructions: ({ input }) => `Answer ${input}`, builtinTools: false })
    })
    .build()

  const session = await harness.getSession('guardrails-transform')
  await expect(session.agents.answer.prompt('unsafe question')).resolves.toBe('safe answer')
  expect(provider.requests[0]?.messages).toEqual([
    { role: 'system', content: 'Answer safe question' },
    { role: 'user', content: 'safe question', toolCalls: undefined }
  ])
})

it('blocks a configured tool-input rail before the Harness tool has a side effect', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'transfer-1', name: 'transfer', arguments: { amount: 100 } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
  })
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { tool_input: { flows: ['approve transfer'] } } }),
    actions: { 'approve transfer': { evaluate: () => ({ decision: 'block' }) } }
  })
  let calls = 0
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ assistant: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      transfer: {
        description: 'Transfer funds.',
        input: z.object({ amount: z.number() }),
        output: z.object({ ok: z.boolean() }),
        handler: async () => {
          calls += 1
          return { ok: true }
        }
      }
    })
    .agents({ answer: rails.attach({ model: 'assistant', instructions: 'Answer.', tools: ['transfer'], builtinTools: false }) })
    .build()

  const session = await harness.getSession('guardrails-tool-block')
  await expect(session.agents.answer.prompt('transfer')).rejects.toMatchObject({ code: 'AGENT_INTERCEPTOR_ERROR' })
  expect(calls).toBe(0)
})

it('filters caller-owned retrieval chunks without creating a vector store', async () => {
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { retrieval: { flows: ['filter chunks'] } } }),
    actions: {
      'filter chunks': {
        evaluate: ({ value }) => ({
          decision: 'transform',
          target: 'relevant_chunks',
          value: (value as string[]).filter((chunk) => !chunk.includes('secret'))
        })
      }
    }
  })

  await expect(rails.filterRetrievedChunks(['public', 'secret source', 'approved'])).resolves.toEqual(['public', 'approved'])
})

it('uses an explicitly configured Harness model alias for a model-backed check', async () => {
  const safety = new FakeModelProvider()
  safety.enqueue({ object: { allow: false }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const assistant = new FakeModelProvider()
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { input: { flows: ['self check'] } } }),
    modelAliases: { content_safety: 'safety' },
    actions: { 'self check': modelCheckRail({ model: 'content_safety', instructions: 'Return whether the input is allowed.' }) }
  })
  const harness = defineHarness()
    .models({
      assistant: { provider: assistant, model: 'assistant', capabilities: ['object'] },
      safety: { provider: safety, model: 'safety', capabilities: ['object'] }
    })
    .agents({ answer: rails.attach({ model: 'assistant', instructions: 'Answer.', builtinTools: false }) })
    .build()

  const session = await harness.getSession('guardrails-model-check')
  await expect(session.agents.answer.prompt('unsafe question')).rejects.toMatchObject({ code: 'AGENT_INTERCEPTOR_ERROR' })
  expect(safety.requests).toHaveLength(1)
  expect(assistant.requests).toHaveLength(0)
})

it('rejects unsupported Colang/dialog configuration rather than silently accepting it', () => {
  expect(() => parseGuardrailsConfig({ rails: { dialog: { flows: ['hello'] } } })).toThrow(/not included/)
})
