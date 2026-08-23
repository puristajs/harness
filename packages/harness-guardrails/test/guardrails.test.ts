import { SpanStatusCode } from '@opentelemetry/api'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { defineHarness, inMemorySandbox } from '@purista/harness'
import { FakeLogger, FakeModelProvider, RecordingTelemetry } from '@purista/harness/testing'
import { createModelRegistry } from '../../harness/src/models/registry.js'
import { defineGuardrails, GuardrailBlockedError, modelCheckRail, parseGuardrailsConfig } from '../src/index.js'

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

it('records content-free trace, metric, and structured-log outcomes for standalone retrieval rails', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { retrieval: { flows: ['redact source'] } } }),
    observability: { telemetry, logger },
    actions: {
      'redact source': {
        evaluate: ({ value }) => ({
          decision: 'transform',
          target: 'relevant_chunks',
          value: (value as string[]).map(() => 'approved source'),
          reasonCode: 'pii_redacted'
        })
      }
    }
  })

  await expect(rails.filterRetrievedChunks(['customer-secret@example.test'])).resolves.toEqual(['approved source'])
  expect(telemetry.spans).toMatchObject([{
    name: 'evaluate_guardrail redact source',
    attrs: {
      'openinference.span.kind': 'GUARDRAIL',
      'harness.guardrail.id': 'redact source',
      'harness.guardrail.phase': 'retrieval',
      'harness.guardrail.outcome': 'transform',
      'harness.guardrail.reason_code': 'pii_redacted'
    }
  }])
  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'counter', name: 'harness.guardrail.evaluations', attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'transform' }) }),
    expect.objectContaining({ kind: 'histogram', name: 'harness.guardrail.duration', attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'transform' }) })
  ]))
  expect(logger.recordsAt('info')).toEqual([expect.objectContaining({
    msg: 'Harness guardrail transformed a value.',
    fields: expect.objectContaining({ guardrail_id: 'redact source', guardrail_phase: 'retrieval', guardrail_outcome: 'transform' })
  })])
  expect(JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records })).not.toContain('customer-secret@example.test')
})

it('makes a block searchable without treating the guardrail evaluation itself as an error', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { retrieval: { flows: ['deny restricted source'] } } }),
    observability: { telemetry, logger },
    actions: { 'deny restricted source': { evaluate: () => ({ decision: 'block', reasonCode: 'classification_denied' }) } }
  })

  await expect(rails.filterRetrievedChunks(['restricted source'])).rejects.toMatchObject({
    code: 'GUARDRAIL_BLOCKED',
    meta: { rail_id: 'deny restricted source', phase: 'retrieval', reason_code: 'classification_denied' }
  } satisfies Partial<GuardrailBlockedError>)
  expect(telemetry.spans[0]).toMatchObject({
    attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'block', 'harness.guardrail.reason_code': 'classification_denied' })
  })
  expect(telemetry.spans[0]?.status).toBeUndefined()
  expect(logger.recordsAt('warn')).toEqual([expect.objectContaining({ msg: 'Harness guardrail blocked execution.' })])
})

it('fails closed with classified, content-free telemetry when an action fails or exceeds its budget', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  let actionSignal: AbortSignal | undefined
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { retrieval: { flows: ['slow safety check'] } } }),
    observability: { telemetry, logger },
    actionTimeoutMs: 10,
    actions: {
      'slow safety check': {
        evaluate: ({ signal }) => {
          actionSignal = signal
          return new Promise<never>(() => undefined)
        }
      }
    }
  })

  await expect(rails.filterRetrievedChunks(['secret source'])).rejects.toMatchObject({
    code: 'GUARDRAIL_EVALUATION_ERROR',
    meta: { rail_id: 'slow safety check', phase: 'retrieval', reason: 'action_timeout' }
  })
  expect(telemetry.spans[0]).toMatchObject({
    attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'error', 'error.type': 'GUARDRAIL_EVALUATION_ERROR' }),
    status: { code: SpanStatusCode.ERROR }
  })
  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'harness.guardrail.evaluations', attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'error' }) })
  ]))
  expect(actionSignal?.aborted).toBe(true)
  expect(JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records })).not.toContain('secret source')
})

it('classifies thrown action failures without leaking the action error content', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { retrieval: { flows: ['external classifier'] } } }),
    observability: { telemetry, logger },
    actions: { 'external classifier': { evaluate: () => { throw new Error('provider rejected customer-secret@example.test') } } }
  })

  await expect(rails.filterRetrievedChunks(['customer-secret@example.test'])).rejects.toMatchObject({
    code: 'GUARDRAIL_EVALUATION_ERROR',
    meta: { rail_id: 'external classifier', phase: 'retrieval', reason: 'action_failed' }
  })
  expect(telemetry.spans[0]).toMatchObject({
    attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'error', 'error.type': 'GUARDRAIL_EVALUATION_ERROR' }),
    status: { code: SpanStatusCode.ERROR }
  })
  expect(JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records })).not.toContain('customer-secret@example.test')
})

it('enforces an action declaration that transforms are not permitted', async () => {
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { retrieval: { flows: ['decision only'] } } }),
    actions: {
      'decision only': {
        mayTransform: false,
        evaluate: () => ({ decision: 'transform', target: 'relevant_chunks', value: [] })
      }
    }
  })

  await expect(rails.filterRetrievedChunks(['source'])).rejects.toMatchObject({
    code: 'GUARDRAIL_EVALUATION_ERROR',
    meta: { reason: 'invalid_outcome' }
  })
})

it('supports model-backed retrieval checks through the typed standalone execution context', async () => {
  let calls = 0
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { retrieval: { flows: ['retrieval self check'] } } }),
    modelAliases: { safety: 'guardrail_model' },
    actions: { 'retrieval self check': modelCheckRail({ model: 'safety', instructions: 'Return the allow decision.' }) }
  })

  await expect(rails.filterRetrievedChunks(['untrusted'], {
    models: {
      guardrail_model: {
        object: async () => {
          calls += 1
          return { object: { allow: false }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
        }
      }
    }
  })).rejects.toBeInstanceOf(GuardrailBlockedError)
  expect(calls).toBe(1)
})

it('parents model-backed rail usage under the GUARDRAIL span with standard model and token attributes', async () => {
  const telemetry = new RecordingTelemetry()
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: { allow: true },
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: 3, reasoningTokens: 2 },
    finishReason: 'stop'
  })
  const models = createModelRegistry({
    safety: { provider, model: 'safety-model', capabilities: ['object'] }
  }, { telemetry, harnessName: 'guardrails-test' })
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({ rails: { retrieval: { flows: ['safety model'] } } }),
    observability: { telemetry },
    modelAliases: { safety: 'safety' },
    actions: { 'safety model': modelCheckRail({ model: 'safety', instructions: 'Return an allow decision.' }) }
  })

  await expect(rails.filterRetrievedChunks(['approved source'], { models })).resolves.toEqual(['approved source'])
  const guardrailSpan = telemetry.spans.find((span) => span.name === 'evaluate_guardrail safety model')
  const modelSpan = telemetry.spans.find((span) => span.name === 'chat safety-model')
  expect(modelSpan).toMatchObject({
    parentId: guardrailSpan?.id,
    attrs: expect.objectContaining({
      'openinference.span.kind': 'LLM',
      'harness.model.alias': 'safety',
      'gen_ai.request.model': 'safety-model',
      'llm.model_name': 'safety-model',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.usage.total_tokens': 18,
      'llm.token_count.total': 18
    })
  })
  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'gen_ai.client.token.usage', value: 11, attrs: expect.objectContaining({ 'harness.model.alias': 'safety' }) }),
    expect.objectContaining({ name: 'gen_ai.client.token.usage', value: 7, attrs: expect.objectContaining({ 'harness.model.alias': 'safety' }) })
  ]))
})
