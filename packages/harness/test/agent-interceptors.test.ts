import { expect, it } from 'vitest'
import { z } from 'zod'
import { AgentInterceptorError, defineHarness, inMemorySandbox } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { runTelemetryFlowHarness } from './telemetryFlowHarness.js'

it('transforms parsed input before the default loop builds the model request', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({ object: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agents({
      answer: {
        model: 'fake',
        instructions: ({ input }) => `Answer the normalized input: ${input}`,
        builtinTools: false,
        interceptors: [{
          id: 'normalize',
          beforeInput: () => ({ decision: 'transform', value: 'safe input' })
        }]
      }
    })
    .build()

  const session = await harness.getSession('interceptor-transform')
  await expect(session.agents.answer.prompt('unsafe input')).resolves.toBe('ok')
  expect(provider.requests[0]?.messages).toEqual([
    { role: 'system', content: 'Answer the normalized input: safe input' },
    { role: 'user', content: 'safe input', toolCalls: undefined }
  ])
})

it('blocks a model response before it can be emitted or persisted', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({ object: 'unsafe output', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agents({
      answer: {
        model: 'fake',
        instructions: 'Answer.',
        builtinTools: false,
        interceptors: [{ id: 'output', afterModel: () => ({ decision: 'block', reason: 'unsafe_output' }) }]
      }
    })
    .build()

  const session = await harness.getSession('interceptor-block')
  await expect(session.agents.answer.prompt('question')).rejects.toMatchObject({
    code: 'AGENT_INTERCEPTOR_ERROR',
    category: 'interceptor',
    meta: { interceptor_id: 'output', phase: 'after_model', reason: 'blocked' }
  } satisfies Partial<AgentInterceptorError>)
  expect(provider.requests).toHaveLength(1)
  expect(await session.history.list()).toEqual([])
})

it('blocks a tool before its side effect', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'call-1', name: 'transfer', arguments: { amount: 10 } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
  })
  let calls = 0
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
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
    .agents({
      answer: {
        model: 'fake',
        instructions: 'Answer.',
        tools: ['transfer'],
        builtinTools: false,
        interceptors: [{ id: 'tool-input', beforeTool: () => ({ decision: 'block', reason: 'not_approved' }) }]
      }
    })
    .build()

  const session = await harness.getSession('interceptor-tool-block')
  await expect(session.agents.answer.prompt('transfer')).rejects.toBeInstanceOf(AgentInterceptorError)
  expect(calls).toBe(0)
})

it('attributes a blocked interceptor on the failed parent agent span without recording input content', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness({
    interceptors: [{ id: 'compliance_gate', beforeInput: () => ({ decision: 'block' }) }]
  })

  await expect(session.agents.responder.prompt('customer-secret@example.test')).rejects.toBeInstanceOf(AgentInterceptorError)
  const agentSpan = telemetry.spans.find((span) => span.name === 'invoke_agent responder')
  expect(agentSpan).toMatchObject({
    attrs: expect.objectContaining({
      'error.type': 'AGENT_INTERCEPTOR_ERROR',
      'harness.interceptor.id': 'compliance_gate',
      'harness.interceptor.phase': 'before_input'
    })
  })
  expect(JSON.stringify(agentSpan)).not.toContain('customer-secret@example.test')
})
