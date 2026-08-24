import { SpanStatusCode } from '@opentelemetry/api'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { defineHarness, inMemorySandbox } from '@purista/harness'
import { FakeLogger, FakeModelProvider, RecordingTelemetry } from '@purista/harness/testing'
import { createModelRegistry } from '../../harness/src/models/registry.js'
import { createSensitiveDataActions, defineGuardrails, GuardrailBlockedError, modelCheckRail, parseGuardrailsConfig, type SensitiveDataDetector } from '../src/index.js'
import { FakeSensitiveDataDetector } from '../src/testing/index.js'

it('scripts deterministic sensitive-data findings, failures, capabilities, and request recording', async () => {
  const detector = new FakeSensitiveDataDetector({ id: 'privacy-test', executionMode: 'cloud', supportedEntities: ['EMAIL_ADDRESS'] })
  const request = { text: 'synthetic@example.test', entities: ['EMAIL_ADDRESS'], scoreThreshold: 0.6, signal: new AbortController().signal }
  detector.enqueue([{ category: 'EMAIL_ADDRESS', start: 0, end: request.text.length, score: 0.99 }])
  detector.enqueueError(new Error('intentional test failure'))

  await expect(detector.inspect(request)).resolves.toEqual({ findings: [{ category: 'EMAIL_ADDRESS', start: 0, end: request.text.length, score: 0.99 }] })
  await expect(detector.inspect(request)).rejects.toThrow('intentional test failure')
  await expect(detector.inspect(request)).resolves.toEqual({ findings: [] })
  expect(detector.executionMode).toBe('cloud')
  expect(detector.supportedEntities).toEqual(['EMAIL_ADDRESS'])
  expect(detector.requests).toHaveLength(3)
  detector.reset()
  expect(detector.requests).toEqual([])
})

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

it('masks an explicitly selected structured tool-input field before the Harness tool executes', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'transfer-1', name: 'transfer', arguments: { amount: 100, memo: 'refund test@example.test' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
  })
  provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const detector: SensitiveDataDetector = {
    id: 'email-detector',
    executionMode: 'local',
    supportedEntities: ['EMAIL_ADDRESS'],
    async inspect({ text }) {
      const start = text.indexOf('test@example.test')
      return { findings: start < 0 ? [] : [{ category: 'EMAIL_ADDRESS', start, end: start + 'test@example.test'.length }] }
    }
  }
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({
      rails: {
        config: { sensitive_data_detection: { input: { entities: ['EMAIL_ADDRESS'], mask_token: '<MASKED>', score_threshold: 0 } } },
        tool_input: { flows: ['mask transfer memo'] }
      }
    }),
    actions: createSensitiveDataActions({
      detector,
      toolInput: {
        policy: 'input',
        codec: {
          id: 'transfer-memo',
          extract: (value) => [{ id: 'memo', text: (value as { memo: string }).memo }],
          replace: (value, replacements) => ({
            ...(value as Record<string, unknown>),
            memo: replacements.reduce((memo, replacement) => memo.slice(0, replacement.start) + replacement.value + memo.slice(replacement.end), (value as { memo: string }).memo)
          })
        },
        maskFlow: 'mask transfer memo'
      }
    })
  })
  let receivedMemo: string | undefined
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ assistant: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      transfer: {
        description: 'Transfer funds.',
        input: z.object({ amount: z.number(), memo: z.string() }),
        output: z.object({ ok: z.boolean() }),
        handler: async (_context, { memo }) => {
          receivedMemo = memo
          return { ok: true }
        }
      }
    })
    .agents({ answer: rails.attach({ model: 'assistant', instructions: 'Answer.', tools: ['transfer'], builtinTools: false }) })
    .build()

  const session = await harness.getSession('guardrails-tool-mask')
  await expect(session.agents.answer.prompt('transfer')).resolves.toBe('done')
  expect(receivedMemo).toBe('refund <MASKED>')
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

it('masks sensitive retrieval chunks with a provider-neutral detector and content-free child telemetry', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  const detector: SensitiveDataDetector = {
    id: 'test-local-detector',
    executionMode: 'local',
    supportedEntities: ['EMAIL_ADDRESS'],
    async inspect({ text }) {
      const at = text.indexOf('@')
      const start = at < 0 ? -1 : text.lastIndexOf(' ', at) + 1
      return start < 0 ? { findings: [] } : { findings: [{ category: 'EMAIL_ADDRESS', start, end: text.length, score: 0.99 }] }
    }
  }
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({
      rails: {
        config: { sensitive_data_detection: { retrieval: { entities: ['EMAIL_ADDRESS'], mask_token: '<MASKED>', score_threshold: 0.6 } } },
        retrieval: { flows: ['mask sensitive data on retrieval'] }
      }
    }),
    actions: createSensitiveDataActions({ detector }),
    observability: { telemetry, logger }
  })

  await expect(rails.filterRetrievedChunks(['public', 'mail test@example.test', 'approved'])).resolves.toEqual(['public', 'mail <MASKED>', 'approved'])
  const inspection = telemetry.spans.find((span) => span.name === 'harness.sensitive_data.inspect' && span.attrs['harness.sensitive_data.outcome'] === 'transform')
  expect(inspection).toMatchObject({
    attrs: expect.objectContaining({
      'openinference.span.kind': 'GUARDRAIL',
      'harness.sensitive_data.detector.id': 'test-local-detector',
      'harness.sensitive_data.execution_mode': 'local',
      'harness.sensitive_data.operation': 'mask',
      'harness.sensitive_data.outcome': 'transform',
      'harness.sensitive_data.finding_count': '1'
    })
  })
  expect(telemetry.metrics).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'harness.sensitive_data.inspections', attrs: expect.objectContaining({ 'harness.sensitive_data.outcome': 'transform' }) }),
    expect.objectContaining({ name: 'harness.sensitive_data.duration', attrs: expect.objectContaining({ 'harness.sensitive_data.outcome': 'transform' }) })
  ]))
  const recorded = JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records })
  expect(recorded).not.toContain('test@example.test')
  expect(recorded).not.toContain('gen_ai.')
  expect(recorded).not.toContain('llm.')
})

it('blocks sensitive data and fails closed when a detector returns invalid coordinates', async () => {
  const detector: SensitiveDataDetector = {
    id: 'test-detector',
    executionMode: 'local',
    async inspect({ text }) {
      if (text === 'invalid') return { findings: [{ category: 'EMAIL_ADDRESS', start: 0, end: 100 }] }
      return { findings: [{ category: 'EMAIL_ADDRESS', start: 0, end: text.length }] }
    }
  }
  const rails = defineGuardrails({
    config: parseGuardrailsConfig({
      rails: {
        config: { sensitive_data_detection: { retrieval: { entities: ['EMAIL_ADDRESS'], mask_token: '<MASKED>', score_threshold: 0 } } },
        retrieval: { flows: ['detect sensitive data on retrieval'] }
      }
    }),
    actions: createSensitiveDataActions({ detector })
  })

  await expect(rails.filterRetrievedChunks(['address@example.test'])).rejects.toMatchObject({ code: 'GUARDRAIL_BLOCKED', meta: { reason_code: 'sensitive_data_detected' } })
  await expect(rails.filterRetrievedChunks(['invalid'])).rejects.toMatchObject({ code: 'GUARDRAIL_EVALUATION_ERROR', meta: { reason: 'sensitive_data_invalid_result' } })
})

it('rejects unimplemented sensitive-data YAML and unsupported detector capabilities at construction', () => {
  expect(() => parseGuardrailsConfig({
    rails: { config: { sensitive_data_detection: { input: { entities: ['EMAIL_ADDRESS'], mask_token: '<MASKED>', score_threshold: 0.5, recognizers: [] } } } }
  })).toThrow(/Unknown guardrails configuration field/)

  const detector: SensitiveDataDetector = {
    id: 'email-only',
    executionMode: 'local',
    supportedEntities: ['EMAIL_ADDRESS'],
    async inspect() { return { findings: [] } }
  }
  expect(() => defineGuardrails({
    config: parseGuardrailsConfig({
      rails: {
        config: { sensitive_data_detection: { input: { entities: ['PHONE_NUMBER'], mask_token: '<MASKED>', score_threshold: 0.5 } } },
        input: { flows: ['detect sensitive data on input'] }
      }
    }),
    actions: createSensitiveDataActions({ detector })
  })).toThrow(/does not support every configured entity/)

  expect(() => defineGuardrails({
    config: parseGuardrailsConfig({
      rails: {
        config: { sensitive_data_detection: { input: { entities: ['EMAIL_ADDRESS'], mask_token: '<MASKED>', score_threshold: 0.5 } } },
        input: { flows: ['detect sensitive data on input'] }
      }
    }),
    actions: { 'detect sensitive data on input': { evaluate: () => ({ decision: 'allow' }) } }
  })).toThrow(/must use createSensitiveDataActions/)
})
