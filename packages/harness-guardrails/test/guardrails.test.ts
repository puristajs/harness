import { SpanStatusCode } from '@opentelemetry/api'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  agentGuardrailsBinding,
  DecisionBlockedError,
  defineHarness,
  inMemorySandbox,
  serializeError,
  type HarnessAdapterContext,
  type Schema,
} from '@purista/harness'
import { FakeLogger, FakeModelProvider, RecordingTelemetry } from '@purista/harness/testing'
import {
  createSensitiveDataActions,
  defineGuardrailAction,
  defineGuardrails as defineGuardrailsApi,
  GuardrailsConfigError,
  modelCheckRail,
  SensitiveDataDetectorError,
  sensitiveDataToolRail,
  type GuardrailActionContext,
  type SensitiveDataDetector,
} from '../src/index.js'
import { FakeSensitiveDataDetector } from '../src/testing/index.js'

const inlineConfig = <const T>(value: T): T => value

/** Converts historical behavioral fixtures at the test boundary; public calls remain token-only. */
function defineGuardrails(options: {
  readonly config: unknown
  readonly actions: Record<string, unknown>
  readonly observability?: unknown
  readonly actionTimeoutMs?: number
}) {
  const actions = Object.fromEntries(
    Object.entries(options.actions).map(([id, action]) => {
      if (!action || typeof action !== 'object' || !('evaluate' in action)) return [id, action]
      const definition = action as Record<string, unknown>
      const fixtureTool = id.includes('transfer') || id === 'coercing action' ? 'transfer' : 'lookup'
      return [
        id,
        definition['phase'] === 'tool_input' || definition['phase'] === 'tool_output'
          ? defineGuardrailAction({ ...definition, tools: definition['tools'] ?? [fixtureTool] } as never)
          : defineGuardrailAction(definition as never),
      ]
    }),
  )
  return defineGuardrailsApi({ ...options, actions } as never)
}

it('scripts deterministic sensitive-data findings, failures, capabilities, and request recording', async () => {
  const detector = new FakeSensitiveDataDetector({
    id: 'privacy-test',
    executionMode: 'cloud',
    supportedEntities: ['EMAIL_ADDRESS'],
  })
  const request = {
    text: 'synthetic@example.test',
    entities: ['EMAIL_ADDRESS'],
    scoreThreshold: 0.6,
    signal: new AbortController().signal,
  }
  detector.enqueue([{ category: 'EMAIL_ADDRESS', start: 0, end: request.text.length, score: 0.99 }])
  detector.enqueueError(new Error('intentional test failure'))

  await expect(detector.inspect(request)).resolves.toEqual({
    findings: [{ category: 'EMAIL_ADDRESS', start: 0, end: request.text.length, score: 0.99 }],
  })
  await expect(detector.inspect(request)).rejects.toThrow('intentional test failure')
  await expect(detector.inspect(request)).resolves.toEqual({ findings: [] })
  expect(detector.executionMode).toBe('cloud')
  expect(detector.supportedEntities).toEqual(['EMAIL_ADDRESS'])
  expect(detector.requests).toHaveLength(3)
  detector.reset()
  expect(detector.requests).toEqual([])
})

it('accepts only canonical camelCase inline fields and preserves empty masking', () => {
  const unsupported = { unsupported: true } as never
  const legacyModels = { models: [{ type: 'main', endpoint: 'https://example.test' }] } as never
  const extraFlowProperty = { rails: { input: { flows: [], parallel: true } } } as never
  for (const config of [unsupported, legacyModels, extraFlowProperty]) {
    expect(() => defineGuardrails({ config, actions: {} })).toThrow(/Guardrails configuration is invalid/)
  }

  const rails = defineGuardrails({
    config: {
      rails: { input: { flows: [] } },
      sensitiveData: { input: { entities: ['EMAIL_ADDRESS'], maskToken: '', scoreThreshold: 0 } },
    },
    actions: {},
  })
  expect(rails).toBeDefined()
})

it('normalizes hostile inline configuration errors to one fixed serialized form', () => {
  const hostile = new Proxy(
    { rails: {} },
    {
      get(_target, key) {
        if (key === 'rails') throw new Error('private configuration content')
        return undefined
      },
    },
  )
  expect(() => defineGuardrails({ config: hostile as never, actions: {} })).toThrow(
    /Guardrails configuration is invalid/,
  )
  expect(() => defineGuardrails({ config: hostile as never, actions: {} })).not.toThrow(/private configuration content/)
})

it('normalizes invalid JavaScript error metadata without exposing Zod diagnostics', () => {
  const hostileMeta = new Proxy(
    {},
    {
      get() {
        throw new Error('private configuration content')
      },
    },
  )
  const error = new GuardrailsConfigError(hostileMeta as never)
  expect(serializeError(error)).toEqual({
    code: 'GUARDRAILS_CONFIG_ERROR',
    category: 'config',
    retriable: false,
    message: 'Guardrails configuration is invalid.',
    meta: { reason: 'invalid_shape' },
  })
})

it('recovers from an invalid inline declaration and captures the corrected configuration', async () => {
  expect(() => defineGuardrails({ config: { rails: { retrieval: { flows: ['missing'] } } }, actions: {} })).toThrow(
    /Guardrails configuration is invalid/,
  )

  const config = { rails: { retrieval: { flows: ['keep'] } } }
  const rails = defineGuardrails({
    config,
    actions: { keep: { phase: 'retrieval', evaluate: () => ({ decision: 'allow' }) } },
  })
  config.rails.retrieval.flows[0] = 'changed after definition'

  await expect(rails.filterRetrievedChunks(['safe'])).resolves.toEqual(['safe'])
})

it('awaits a non-Zod Standard Schema at each guardrail value boundary', async () => {
  let validations = 0
  const strings: Schema<unknown, string[]> = {
    '~standard': {
      version: 1,
      vendor: 'asynchronous-test-schema',
      async validate(value) {
        validations += 1
        await Promise.resolve()
        return Array.isArray(value) && value.every((item) => typeof item === 'string')
          ? { value: [...value] as string[] }
          : { issues: [{ message: 'Expected strings.' }] }
      },
    },
  }
  const rails = defineGuardrailsApi({
    config: { rails: { retrieval: { flows: ['async schema'] } } },
    actions: {
      'async schema': defineGuardrailAction({
        phase: 'retrieval',
        valueSchema: strings,
        evaluate: ({ value }) => ({
          decision: 'transform',
          target: 'relevant_chunks',
          value: value.map((item) => item.toUpperCase()),
        }),
      }),
    },
  })

  await expect(rails.filterRetrievedChunks(['safe'])).resolves.toEqual(['SAFE'])
  expect(validations).toBe(2)
})

it('rejects raw and forged action objects before evaluation', () => {
  const config = { rails: { input: { flows: ['gate'] } } }
  expect(() =>
    defineGuardrailsApi({
      config,
      actions: { gate: { phase: 'input', evaluate: () => ({ decision: 'allow' }) } } as never,
    }),
  ).toThrow(/Guardrails configuration is invalid/)
  expect(() => defineGuardrailsApi({ config, actions: { gate: { phase: 'input' } } as never })).toThrow(
    /Guardrails configuration is invalid/,
  )
  expect(() =>
    defineGuardrailAction({ phase: 'tool_input', evaluate: () => ({ decision: 'allow' }) } as never),
  ).toThrow(/Invalid guardrail action definition/)
})

it('runs canonical input and output rails with the Harness test adapter', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: 'unsafe answer',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })
  const rails = defineGuardrails({
    config: inlineConfig({
      rails: {
        input: { flows: ['normalize input'] },
        output: { flows: ['redact output'] },
      },
    }),
    actions: {
      'normalize input': {
        phase: 'input',
        evaluate: () => ({ decision: 'transform', target: 'user_message', value: 'safe question' }),
      },
      'redact output': {
        phase: 'output',
        evaluate: () => ({ decision: 'transform', target: 'bot_message', value: 'safe answer' }),
      },
    },
  })
  const harness = defineHarness()
    .models({ assistant: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'assistant',
      instructions: ({ input }) => `Answer ${input}`,
      builtinTools: false,
      guardrails: rails,
    })
    .build()

  const session = await harness.getSession('guardrails-transform')
  await expect(session.agents.answer.run('unsafe question')).resolves.toBe('safe answer')
  expect(provider.requests[0]?.messages).toEqual([
    { role: 'system', content: 'Answer safe question' },
    { role: 'user', content: 'safe question', toolCalls: undefined },
  ])
})

it('blocks a configured tool-input rail before the Harness tool has a side effect', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'transfer-1', name: 'transfer', arguments: { amount: 100 } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { tool_input: { flows: ['approve transfer'] } } }),
    actions: { 'approve transfer': { phase: 'tool_input', evaluate: () => ({ decision: 'block' }) } },
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
        },
      },
    })
    .agent('answer', {
      model: 'assistant',
      instructions: 'Answer.',
      tools: ['transfer'],
      builtinTools: false,
      guardrails: rails,
    })
    .build()

  const session = await harness.getSession('guardrails-tool-block')
  await expect(session.agents.answer.run('transfer')).rejects.toMatchObject({ code: 'DECISION_BLOCKED' })
  expect(calls).toBe(0)
})

it('masks an explicitly selected structured tool-input field before the Harness tool executes', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'transfer-1', name: 'transfer', arguments: { amount: 100, memo: 'refund test@example.test' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const detector: SensitiveDataDetector = {
    id: 'email-detector',
    executionMode: 'local',
    supportedEntities: ['EMAIL_ADDRESS'],
    async inspect({ text }) {
      const start = text.indexOf('test@example.test')
      return {
        findings: start < 0 ? [] : [{ category: 'EMAIL_ADDRESS', start, end: start + 'test@example.test'.length }],
      }
    },
  }
  const rails = defineGuardrails({
    config: inlineConfig({
      rails: { tool_input: { flows: ['mask transfer memo'] } },
      sensitiveData: { input: { entities: ['EMAIL_ADDRESS'], maskToken: '<MASKED>', scoreThreshold: 0 } },
    }),
    actions: {
      'mask transfer memo': sensitiveDataToolRail({
        detector,
        phase: 'tool_input',
        tools: ['transfer'],
        policy: 'input',
        operation: 'mask',
        valueSchema: z.object({ amount: z.number(), memo: z.string() }),
        codec: {
          id: 'transfer-memo',
          extract: (value) => [{ id: 'memo', text: value.memo }],
          replace: (value, replacements) => ({
            ...value,
            memo: replacements.reduce(
              (memo, replacement) => memo.slice(0, replacement.start) + replacement.value + memo.slice(replacement.end),
              value.memo,
            ),
          }),
        },
      }),
    },
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
        },
      },
    })
    .agent('answer', {
      model: 'assistant',
      instructions: 'Answer.',
      tools: ['transfer'],
      builtinTools: false,
      guardrails: rails,
    })
    .build()

  const session = await harness.getSession('guardrails-tool-mask')
  await expect(session.agents.answer.run('transfer')).resolves.toBe('done')
  expect(receivedMemo).toBe('refund <MASKED>')
})

it('filters caller-owned retrieval chunks without creating a vector store', async () => {
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['filter chunks'] } } }),
    actions: {
      'filter chunks': {
        phase: 'retrieval',
        evaluate: ({ value }) => ({
          decision: 'transform',
          target: 'relevant_chunks',
          value: (value as string[]).filter((chunk) => !chunk.includes('secret')),
        }),
      },
    },
  })

  await expect(rails.filterRetrievedChunks(['public', 'secret source', 'approved'])).resolves.toEqual([
    'public',
    'approved',
  ])
})

it('uses a direct Harness model alias for a model-backed check', async () => {
  const safety = new FakeModelProvider()
  safety.enqueue({
    object: { allow: false },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })
  const assistant = new FakeModelProvider()
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { input: { flows: ['self check'] } } }),
    actions: {
      'self check': modelCheckRail({
        phase: 'input',
        model: 'safety',
        instructions: 'Return whether the input is allowed.',
      }),
    },
  })
  const harness = defineHarness()
    .models({
      assistant: { provider: assistant, model: 'assistant', capabilities: ['object'] },
      safety: { provider: safety, model: 'safety', capabilities: ['object'] },
    })
    .agent('answer', { model: 'assistant', instructions: 'Answer.', builtinTools: false, guardrails: rails })
    .build()

  const session = await harness.getSession('guardrails-model-check')
  await expect(session.agents.answer.run('unsafe question')).rejects.toMatchObject({ code: 'DECISION_BLOCKED' })
  expect(safety.requests).toHaveLength(1)
  expect(assistant.requests).toHaveLength(0)
})

it('derives binding requirements from only active non-retrieval actions', () => {
  const rails = defineGuardrailsApi({
    config: {
      rails: {
        input: { flows: ['model check'] },
        tool_input: { flows: ['tool check'] },
        retrieval: { flows: ['retrieval check'] },
      },
    },
    actions: {
      'model check': defineGuardrailAction({
        phase: 'input',
        models: ['safety'],
        evaluate: () => ({ decision: 'allow' }),
      }),
      'tool check': defineGuardrailAction({
        phase: 'tool_input',
        tools: ['publish'],
        evaluate: () => ({ decision: 'allow' }),
      }),
      'retrieval check': defineGuardrailAction({
        phase: 'retrieval',
        models: ['retrieval_model'],
        evaluate: () => ({ decision: 'allow' }),
      }),
    },
  })

  expect(rails[agentGuardrailsBinding]).toMatchObject({
    id: 'purista.guardrails',
    requirements: {
      tools: ['publish'],
      models: [{ alias: 'safety', capabilities: ['object'] }],
    },
  })
})

it('fails attached guardrail preflight before provider work when a declared dependency is unavailable', () => {
  const provider = new FakeModelProvider()
  const rails = defineGuardrailsApi({
    config: { rails: { input: { flows: ['model check'] }, tool_input: { flows: ['tool check'] } } },
    actions: {
      'model check': defineGuardrailAction({
        phase: 'input',
        models: ['missing'],
        evaluate: () => ({ decision: 'allow' }),
      }),
      'tool check': defineGuardrailAction({
        phase: 'tool_input',
        tools: ['publish'],
        evaluate: () => ({ decision: 'allow' }),
      }),
    },
  })

  const error = (() => {
    try {
      defineHarness()
        .models({ assistant: { provider, model: 'assistant', capabilities: ['object'] } })
        .tools({
          publish: {
            description: 'Publish.',
            input: z.object({ message: z.string() }),
            output: z.boolean(),
            handler: async () => true,
          },
        })
        .agent('answer', {
          model: 'assistant',
          instructions: 'Answer.',
          tools: [],
          builtinTools: false,
          guardrails: rails,
        })
        .build()
    } catch (value) {
      return value
    }
    throw new Error('Expected attached requirements to fail build validation.')
  })()
  expect(error).toMatchObject({ code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'invalid_agent', id: 'publish' } })
  expect(provider.requests).toEqual([])
})

it.each([
  { name: 'model alias is missing', model: 'missing', capabilities: ['object'] as const, id: 'missing' },
  { name: 'model object capability is missing', model: 'safety', capabilities: ['text'] as const, id: 'safety' },
])('fails attached preflight before provider work when $name', ({ model, capabilities, id }) => {
  const provider = new FakeModelProvider()
  const rails = defineGuardrailsApi({
    config: { rails: { input: { flows: ['model check'] } } },
    actions: {
      'model check': defineGuardrailAction({
        phase: 'input',
        models: [model],
        evaluate: () => ({ decision: 'allow' }),
      }),
    },
  })
  const models =
    model === 'missing'
      ? { assistant: { provider, model: 'assistant', capabilities: ['object'] as const } }
      : {
          assistant: { provider, model: 'assistant', capabilities: ['object'] as const },
          safety: { provider, model: 'safety', capabilities },
        }

  const error = (() => {
    try {
      defineHarness()
        .models(models)
        .agent('answer', { model: 'assistant', instructions: 'Answer.', builtinTools: false, guardrails: rails })
        .build()
    } catch (value) {
      return value
    }
    throw new Error('Expected attached requirements to fail build validation.')
  })()
  expect(error).toMatchObject({ code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'invalid_agent', id } })
  expect(provider.requests).toEqual([])
})

it('projects only declared attached action models and rejects unavailable requirements before action callbacks', async () => {
  const assistant = new FakeModelProvider()
  assistant.enqueue({
    object: 'safe answer',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })
  const safety = new FakeModelProvider()
  const unrelated = new FakeModelProvider()
  let exposedAliases: string[] = []
  let actionCalls = 0
  const rails = defineGuardrailsApi({
    config: { rails: { input: { flows: ['model check'] } } },
    actions: {
      'model check': defineGuardrailAction({
        phase: 'input',
        models: ['safety'],
        evaluate: ({ models }) => {
          actionCalls += 1
          exposedAliases = Object.keys(models ?? {})
          return { decision: 'allow' }
        },
      }),
    },
  })
  const harness = defineHarness()
    .models({
      assistant: { provider: assistant, model: 'assistant', capabilities: ['object'] },
      safety: { provider: safety, model: 'safety', capabilities: ['object'] },
      unrelated: { provider: unrelated, model: 'unrelated', capabilities: ['object'] },
    })
    .agent('answer', { model: 'assistant', instructions: 'Answer.', builtinTools: false, guardrails: rails })
    .build()
  const session = await harness.getSession('attached-model-projection')
  try {
    await expect(session.agents.answer.run('question')).resolves.toBe('safe answer')
    expect(exposedAliases).toEqual(['safety'])
    expect(actionCalls).toBe(1)
  } finally {
    await session.release()
    await harness.shutdown()
  }

  for (const capabilities of [undefined, ['text'] as const]) {
    let rejectedActionCalls = 0
    const rejectedRails = defineGuardrailsApi({
      config: { rails: { input: { flows: ['model check'] } } },
      actions: {
        'model check': defineGuardrailAction({
          phase: 'input',
          models: ['safety'],
          evaluate: () => {
            rejectedActionCalls += 1
            return { decision: 'allow' }
          },
        }),
      },
    })
    const error = (() => {
      try {
        defineHarness()
          .models({
            assistant: { provider: assistant, model: 'assistant', capabilities: ['object'] },
            ...(capabilities ? { safety: { provider: safety, model: 'safety', capabilities } } : {}),
          })
          .agent('answer', {
            model: 'assistant',
            instructions: 'Answer.',
            builtinTools: false,
            guardrails: rejectedRails,
          })
          .build()
      } catch (value) {
        return value
      }
      throw new Error('Expected attached requirements to fail build validation.')
    })()
    expect(error).toMatchObject({ code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'invalid_agent', id: 'safety' } })
    expect(rejectedActionCalls).toBe(0)
  }
})

it('checks standalone retrieval model dependencies before any action and projects only declared handles', async () => {
  let actionCalls = 0
  let exposedAliases: string[] = []
  const rails = defineGuardrailsApi({
    config: { rails: { retrieval: { flows: ['retrieval check'] } } },
    actions: {
      'retrieval check': defineGuardrailAction({
        phase: 'retrieval',
        models: ['safety'],
        evaluate: ({ models }) => {
          actionCalls += 1
          exposedAliases = Object.keys(models ?? {})
          return { decision: 'allow' }
        },
      }),
    },
  })

  await expect(rails.filterRetrievedChunks(['source'])).rejects.toMatchObject({
    code: 'GUARDRAILS_CONFIG_ERROR',
    meta: { reason: 'model_missing', modelAlias: 'safety' },
  })
  await expect(rails.filterRetrievedChunks(['source'], { models: { safety: {} as never } })).rejects.toMatchObject({
    code: 'GUARDRAILS_CONFIG_ERROR',
    meta: { reason: 'model_capability_missing', modelAlias: 'safety' },
  })
  expect(actionCalls).toBe(0)

  const model = {
    object: async () => ({
      object: {},
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop' as const,
    }),
  }
  await expect(
    rails.filterRetrievedChunks(['source'], { models: { safety: model, unrelated: model } }),
  ).resolves.toEqual(['source'])
  expect(exposedAliases).toEqual(['safety'])
})

it('rejects removed legacy configuration categories', () => {
  expect(() => defineGuardrails({ config: { rails: { dialog: { flows: ['hello'] } } } as never, actions: {} })).toThrow(
    /Guardrails configuration is invalid/,
  )
})

it('records content-free trace, metric, and structured-log outcomes for standalone retrieval rails', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['redact source'] } } }),
    observability: { telemetry, logger },
    actions: {
      'redact source': {
        phase: 'retrieval',
        evaluate: ({ value }) => ({
          decision: 'transform',
          target: 'relevant_chunks',
          value: (value as string[]).map(() => 'approved source'),
          reasonCode: 'pii_redacted',
        }),
      },
    },
  })

  await expect(rails.filterRetrievedChunks(['customer-secret@example.test'])).resolves.toEqual(['approved source'])
  expect(telemetry.spans).toMatchObject([
    {
      name: 'evaluate_guardrail redact source',
      attrs: {
        'openinference.span.kind': 'GUARDRAIL',
        'harness.guardrail.id': 'redact source',
        'harness.guardrail.phase': 'retrieval',
        'harness.guardrail.outcome': 'transform',
        'harness.guardrail.reason_code': 'pii_redacted',
      },
    },
  ])
  expect(telemetry.metrics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'counter',
        name: 'harness.guardrail.evaluations',
        attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'transform' }),
      }),
      expect.objectContaining({
        kind: 'histogram',
        name: 'harness.guardrail.duration',
        attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'transform' }),
      }),
    ]),
  )
  expect(logger.recordsAt('info')).toEqual([
    expect.objectContaining({
      msg: 'Harness guardrail transformed a value.',
      fields: expect.objectContaining({
        guardrail_id: 'redact source',
        guardrail_phase: 'retrieval',
        guardrail_outcome: 'transform',
      }),
    }),
  ])
  expect(JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records })).not.toContain(
    'customer-secret@example.test',
  )
})

it('makes a block searchable without treating the guardrail evaluation itself as an error', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['deny restricted source'] } } }),
    observability: { telemetry, logger },
    actions: {
      'deny restricted source': {
        phase: 'retrieval',
        evaluate: () => ({ decision: 'block', reasonCode: 'classification_denied' }),
      },
    },
  })

  await expect(rails.filterRetrievedChunks(['restricted source'])).rejects.toMatchObject({
    code: 'DECISION_BLOCKED',
    meta: {
      evidence: {
        source: { kind: 'guardrail', id: 'deny restricted source' },
        phase: 'retrieval',
        reasonCode: 'classification_denied',
      },
    },
  } satisfies Partial<DecisionBlockedError>)
  expect(telemetry.spans[0]).toMatchObject({
    attrs: expect.objectContaining({
      'harness.guardrail.outcome': 'block',
      'harness.guardrail.reason_code': 'classification_denied',
    }),
  })
  expect(telemetry.spans[0]?.status).toBeUndefined()
  expect(logger.recordsAt('warn')).toEqual([expect.objectContaining({ msg: 'Harness guardrail blocked execution.' })])
})

it('fails closed with classified, content-free telemetry when an action fails or exceeds its budget', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  let actionSignal: AbortSignal | undefined
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['slow safety check'] } } }),
    observability: { telemetry, logger },
    actionTimeoutMs: 10,
    actions: {
      'slow safety check': {
        phase: 'retrieval',
        evaluate: ({ signal }) => {
          actionSignal = signal
          return new Promise<never>(() => undefined)
        },
      },
    },
  })

  await expect(rails.filterRetrievedChunks(['secret source'])).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'callback_timeout' },
  })
  expect(telemetry.spans[0]).toMatchObject({
    attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'error', 'error.type': 'DECISION_EVALUATION_ERROR' }),
    status: { code: SpanStatusCode.ERROR },
  })
  expect(telemetry.metrics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'harness.guardrail.evaluations',
        attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'error' }),
      }),
    ]),
  )
  expect(actionSignal?.aborted).toBe(true)
  expect(JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records })).not.toContain(
    'secret source',
  )
})

it('classifies thrown action failures without leaking the action error content', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['external classifier'] } } }),
    observability: { telemetry, logger },
    actions: {
      'external classifier': {
        phase: 'retrieval',
        evaluate: () => {
          throw new Error('provider rejected customer-secret@example.test')
        },
      },
    },
  })

  await expect(rails.filterRetrievedChunks(['customer-secret@example.test'])).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'callback_failed' },
  })
  expect(telemetry.spans[0]).toMatchObject({
    attrs: expect.objectContaining({ 'harness.guardrail.outcome': 'error', 'error.type': 'DECISION_EVALUATION_ERROR' }),
    status: { code: SpanStatusCode.ERROR },
  })
  expect(JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records })).not.toContain(
    'customer-secret@example.test',
  )
})

it('enforces an action declaration that transforms are not permitted', async () => {
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['decision only'] } } }),
    actions: {
      'decision only': {
        phase: 'retrieval',
        mayTransform: false,
        evaluate: () => ({ decision: 'transform', target: 'relevant_chunks', value: [] }),
      },
    },
  })

  await expect(rails.filterRetrievedChunks(['source'])).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'invalid_transform' },
  })
})

it('supports model-backed retrieval checks through the typed standalone execution context', async () => {
  let calls = 0
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['retrieval self check'] } } }),
    actions: {
      'retrieval self check': modelCheckRail({
        phase: 'retrieval',
        model: 'guardrail_model',
        instructions: 'Return the allow decision.',
      }),
    },
  })

  await expect(
    rails.filterRetrievedChunks(['untrusted'], {
      models: {
        guardrail_model: {
          object: async () => {
            calls += 1
            return {
              object: { allow: false },
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: 'stop',
            }
          },
        },
      },
    }),
  ).rejects.toBeInstanceOf(DecisionBlockedError)
  expect(calls).toBe(1)
})

it('parents model-backed rail usage under the GUARDRAIL span with standard model and token attributes', async () => {
  const telemetry = new RecordingTelemetry()
  class ObservedProvider extends FakeModelProvider {
    public configureHarnessContext(context: HarnessAdapterContext): void {
      // Observe actual Harness instrumentation through its public adapter context.
      vi.spyOn(context.telemetry, 'span').mockImplementation(telemetry.span.bind(telemetry))
      vi.spyOn(context.telemetry, 'recordCounter').mockImplementation(telemetry.recordCounter.bind(telemetry))
      vi.spyOn(context.telemetry, 'recordHistogram').mockImplementation(telemetry.recordHistogram.bind(telemetry))
    }
  }
  const provider = new ObservedProvider()
  provider.enqueue({
    object: { allow: true },
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18, cachedInputTokens: 3, reasoningTokens: 2 },
    finishReason: 'stop',
  })
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['safety model'] } } }),
    observability: { telemetry },
    actions: {
      'safety model': modelCheckRail({
        phase: 'retrieval',
        model: 'safety',
        instructions: 'Return an allow decision.',
      }),
    },
  })

  const harness = defineHarness({ name: 'guardrails-test' })
    .sandbox(inMemorySandbox())
    .models({ safety: { provider, model: 'safety-model', capabilities: ['object'] } })
    .workflow('review', {
      input: z.string(),
      output: z.number(),
      handler: async (ctx) => {
        const chunks = await rails.filterRetrievedChunks([ctx.input], {
          models: ctx.models,
          signal: ctx.signal,
          logger: ctx.logger,
        })
        return chunks.length
      },
    })
    .build()
  const session = await harness.getSession('model-backed-retrieval')
  try {
    await expect(session.workflows.review.run('approved source')).resolves.toBe(1)
    expect(provider.requests).toHaveLength(1)
  } finally {
    await session.release()
    await harness.shutdown()
    vi.restoreAllMocks()
  }
  const guardrailSpan = telemetry.spans.find((span) => span.name === 'evaluate_guardrail safety model')
  const modelSpan = telemetry.spans.find((span) => span.name === 'chat safety-model')
  expect(guardrailSpan).toMatchObject({ attrs: { 'openinference.span.kind': 'GUARDRAIL' } })
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
      'llm.token_count.total': 18,
    }),
  })
  expect(telemetry.metrics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'gen_ai.client.token.usage',
        value: 11,
        attrs: expect.objectContaining({ 'harness.model.alias': 'safety' }),
      }),
      expect.objectContaining({
        name: 'gen_ai.client.token.usage',
        value: 7,
        attrs: expect.objectContaining({ 'harness.model.alias': 'safety' }),
      }),
    ]),
  )
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
      return start < 0
        ? { findings: [] }
        : { findings: [{ category: 'EMAIL_ADDRESS', start, end: text.length, score: 0.99 }] }
    },
  }
  const rails = defineGuardrails({
    config: inlineConfig({
      rails: { retrieval: { flows: ['mask sensitive data on retrieval'] } },
      sensitiveData: { retrieval: { entities: ['EMAIL_ADDRESS'], maskToken: '<MASKED>', scoreThreshold: 0.6 } },
    }),
    actions: createSensitiveDataActions({ detector }),
    observability: { telemetry, logger },
  })

  await expect(rails.filterRetrievedChunks(['public', 'mail test@example.test', 'approved'])).resolves.toEqual([
    'public',
    'mail <MASKED>',
    'approved',
  ])
  const inspection = telemetry.spans.find(
    (span) =>
      span.name === 'harness.sensitive_data.inspect' && span.attrs['harness.sensitive_data.outcome'] === 'transform',
  )
  expect(inspection).toMatchObject({
    attrs: expect.objectContaining({
      'openinference.span.kind': 'GUARDRAIL',
      'harness.sensitive_data.detector.id': 'test-local-detector',
      'harness.sensitive_data.execution_mode': 'local',
      'harness.sensitive_data.operation': 'mask',
      'harness.sensitive_data.outcome': 'transform',
      'harness.sensitive_data.finding_count': '1',
    }),
  })
  expect(telemetry.metrics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: 'harness.sensitive_data.inspections',
        attrs: expect.objectContaining({ 'harness.sensitive_data.outcome': 'transform' }),
      }),
      expect.objectContaining({
        name: 'harness.sensitive_data.duration',
        attrs: expect.objectContaining({ 'harness.sensitive_data.outcome': 'transform' }),
      }),
    ]),
  )
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
    },
  }
  const rails = defineGuardrails({
    config: inlineConfig({
      rails: { retrieval: { flows: ['detect sensitive data on retrieval'] } },
      sensitiveData: { retrieval: { entities: ['EMAIL_ADDRESS'], maskToken: '<MASKED>', scoreThreshold: 0 } },
    }),
    actions: createSensitiveDataActions({ detector }),
  })

  await expect(rails.filterRetrievedChunks(['address@example.test'])).rejects.toMatchObject({
    code: 'DECISION_BLOCKED',
    meta: { evidence: { reasonCode: 'sensitive_data_detected' } },
  })
  await expect(rails.filterRetrievedChunks(['invalid'])).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'sensitive_data_invalid_result' },
  })
})

it.each(['missing_optional_dependency', 'Unsafe private kind', 'x'.repeat(65)])(
  'records only a stable safe detector failure kind: %s',
  async (kind) => {
    const telemetry = new RecordingTelemetry()
    const logger = new FakeLogger()
    const detector: SensitiveDataDetector = {
      id: 'local-ner',
      executionMode: 'local',
      supportedEntities: ['PERSON'],
      async inspect() {
        throw new SensitiveDataDetectorError(kind, 'Install package for customer@example.test')
      },
    }
    const rails = defineGuardrails({
      config: inlineConfig({
        rails: { retrieval: { flows: ['detect sensitive data on retrieval'] } },
        sensitiveData: { retrieval: { entities: ['PERSON'], maskToken: '<MASKED>', scoreThreshold: 0.5 } },
      }),
      actions: createSensitiveDataActions({ detector }),
      observability: { telemetry, logger },
    })

    await expect(rails.filterRetrievedChunks(['customer@example.test'])).rejects.toMatchObject({
      code: 'DECISION_EVALUATION_ERROR',
      meta: { failureKind: 'sensitive_data_detector_failed' },
    })
    const recorded = JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records })
    expect(recorded).not.toContain('customer@example.test')
    if (kind === 'missing_optional_dependency') {
      expect(recorded).toContain(kind)
      expect(logger.recordsAt('error')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            msg: 'Harness sensitive-data guardrail failed closed.',
            fields: expect.objectContaining({ sensitive_data_failure_kind: kind }),
          }),
        ]),
      )
    } else {
      expect(recorded).not.toContain(kind)
      expect(recorded).not.toContain('sensitive_data_failure_kind')
    }
  },
)

it('rejects invalid inline sensitive-data configuration and unsupported detector capabilities at construction', () => {
  expect(() =>
    defineGuardrails({
      config: {
        sensitiveData: {
          input: { entities: ['EMAIL_ADDRESS'], maskToken: '<MASKED>', scoreThreshold: 0.5, recognizers: [] },
        },
      } as never,
      actions: {},
    }),
  ).toThrow(/Guardrails configuration is invalid/)

  const detector: SensitiveDataDetector = {
    id: 'email-only',
    executionMode: 'local',
    supportedEntities: ['EMAIL_ADDRESS'],
    async inspect() {
      return { findings: [] }
    },
  }
  expect(() =>
    defineGuardrails({
      config: inlineConfig({
        rails: { input: { flows: ['detect sensitive data on input'] } },
        sensitiveData: { input: { entities: ['PHONE_NUMBER'], maskToken: '<MASKED>', scoreThreshold: 0.5 } },
      }),
      actions: createSensitiveDataActions({ detector }),
    }),
  ).toThrow(/Guardrails configuration is invalid/)

  expect(() =>
    defineGuardrails({
      config: inlineConfig({
        rails: { input: { flows: ['detect sensitive data on input'] } },
        sensitiveData: { input: { entities: ['EMAIL_ADDRESS'], maskToken: '<MASKED>', scoreThreshold: 0.5 } },
      }),
      actions: { 'detect sensitive data on input': { phase: 'input', evaluate: () => ({ decision: 'allow' }) } },
    }),
  ).toThrow(/Guardrails configuration is invalid/)
})

it('rejects a phase declaration that does not match its configuration binding', () => {
  expect(() =>
    defineGuardrails({
      config: inlineConfig({ rails: { input: { flows: ['output action'] } } }),
      actions: { 'output action': { phase: 'output', evaluate: () => ({ decision: 'allow' }) } },
    }),
  ).toThrow(/Guardrails configuration is invalid/)
  try {
    defineGuardrails({
      config: inlineConfig({ rails: { input: { flows: ['output action'] } } }),
      actions: { 'output action': { phase: 'output', evaluate: () => ({ decision: 'allow' }) } },
    })
  } catch (error) {
    expect(error).toMatchObject({
      code: 'GUARDRAILS_CONFIG_ERROR',
      meta: { reason: 'invalid_shape', field: 'rails.input.flows', flowId: 'output action' },
    })
  }
})

it('fails closed on extra outcome fields and schema normalization without recording inspected content', async () => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  const invalidResult = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['strict result'] } } }),
    observability: { telemetry, logger },
    actions: {
      'strict result': {
        phase: 'retrieval',
        evaluate: () => ({ decision: 'allow', extra: 'customer-secret@example.test' }),
      },
    },
  })
  await expect(invalidResult.filterRetrievedChunks(['customer-secret@example.test'])).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'invalid_result' },
  })
  expect(JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records })).not.toContain(
    'customer-secret@example.test',
  )

  const coercingValueSchema = defineGuardrails({
    config: inlineConfig({ rails: { tool_input: { flows: ['coercing action'] } } }),
    actions: {
      'coercing action': {
        phase: 'tool_input',
        valueSchema: z.object({ amount: z.coerce.number() }),
        evaluate: () => ({ decision: 'allow' }),
      },
    },
  })
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'transfer-1', name: 'transfer', arguments: { amount: '10' } }],
    finishReason: 'tool_calls',
  })
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ assistant: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      transfer: {
        description: 'Transfer.',
        input: z.object({ amount: z.number() }),
        output: z.object({ ok: z.boolean() }),
        handler: async () => ({ ok: true }),
      },
    })
    .agent('answer', {
      model: 'assistant',
      instructions: 'Answer.',
      tools: ['transfer'],
      builtinTools: false,
      guardrails: coercingValueSchema,
    })
    .build()
  const session = await harness.getSession('coercing-rail')
  await expect(session.agents.answer.run('transfer')).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'invalid_result' },
  })
  await session.release()
  await harness.shutdown()
})

it('blocks final output before model-object delivery or assistant persistence', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({ object: 'restricted final', finishReason: 'stop' })
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { output: { flows: ['final gate'] } } }),
    actions: { 'final gate': { phase: 'output', evaluate: () => ({ decision: 'block', reasonCode: 'restricted' }) } },
  })
  const harness = defineHarness()
    .models({ assistant: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', { model: 'assistant', instructions: 'Answer.', builtinTools: false, guardrails: rails })
    .build()
  const session = await harness.getSession('guardrail-final-block')
  const events = []
  await expect(async () => {
    for await (const event of session.agents.answer.stream('question')) events.push(event)
  }).rejects.toMatchObject({ code: 'DECISION_BLOCKED' })
  expect(events.some((event) => event.type === 'model.object')).toBe(false)
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'run.finished', error: expect.objectContaining({ code: 'DECISION_BLOCKED' }) }),
    ]),
  )
  expect(await session.history.list()).toEqual([])
  await session.release()
  await harness.shutdown()
})

it('applies output rails only to the final candidate, including stopWhen finalization', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: 'intermediate tool text',
    toolCalls: [{ id: 'lookup-1', name: 'lookup', arguments: { id: 'one' } }],
    finishReason: 'tool_calls',
  })
  provider.enqueue({ object: 'restricted final', finishReason: 'stop' })
  let railCalls = 0
  let toolCalls = 0
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { output: { flows: ['final gate'] } } }),
    actions: {
      'final gate': {
        phase: 'output',
        evaluate: () => {
          railCalls += 1
          return { decision: 'block', reasonCode: 'restricted' }
        },
      },
    },
  })
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ assistant: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      lookup: {
        description: 'Lookup.',
        input: z.object({ id: z.string() }),
        output: z.object({ ok: z.boolean() }),
        handler: async () => {
          toolCalls += 1
          return { ok: true }
        },
      },
    })
    .agent('answer', {
      model: 'assistant',
      instructions: 'Answer.',
      tools: ['lookup'],
      builtinTools: false,
      guardrails: rails,
    })
    .build()
  const session = await harness.getSession('guardrail-tool-final')
  await expect(session.agents.answer.run('lookup')).rejects.toMatchObject({ code: 'DECISION_BLOCKED' })
  expect(toolCalls).toBe(1)
  expect(railCalls).toBe(1)
  await session.release()
  await harness.shutdown()

  const stoppedProvider = new FakeModelProvider()
  stoppedProvider.enqueue({
    object: 'restricted stop result',
    toolCalls: [{ id: 'lookup-2', name: 'lookup', arguments: { id: 'two' } }],
    finishReason: 'tool_calls',
  })
  let stoppedToolCalls = 0
  const stoppedHarness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ assistant: { provider: stoppedProvider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      lookup: {
        description: 'Lookup.',
        input: z.object({ id: z.string() }),
        output: z.object({ ok: z.boolean() }),
        handler: async () => {
          stoppedToolCalls += 1
          return { ok: true }
        },
      },
    })
    .agent('answer', {
      model: 'assistant',
      instructions: 'Answer.',
      tools: ['lookup'],
      builtinTools: false,
      stopWhen: ({ toolCalls }) => toolCalls.length > 0,
      guardrails: rails,
    })
    .build()
  const stoppedSession = await stoppedHarness.getSession('guardrail-stop-final')
  await expect(stoppedSession.agents.answer.run('lookup')).rejects.toMatchObject({ code: 'DECISION_BLOCKED' })
  expect(stoppedToolCalls).toBe(0)
  await stoppedSession.release()
  await stoppedHarness.shutdown()
})

it.each([
  {
    name: 'allow reason',
    outcome: { decision: 'allow', reasonCode: 'PRIVATE INSPECTED CONTENT' },
    failureKind: 'invalid_result',
  },
  {
    name: 'block reason',
    outcome: { decision: 'block', reasonCode: 'PRIVATE INSPECTED CONTENT' },
    failureKind: 'invalid_result',
  },
  {
    name: 'transform reason',
    outcome: { decision: 'transform', target: 'relevant_chunks', value: [], reasonCode: 'PRIVATE INSPECTED CONTENT' },
    failureKind: 'invalid_result',
  },
  {
    name: 'transform extra field',
    outcome: { decision: 'transform', target: 'relevant_chunks', value: [], extra: 'PRIVATE INSPECTED CONTENT' },
    failureKind: 'invalid_transform',
  },
])('preserves safe result classification for $name', async ({ outcome, failureKind }) => {
  const telemetry = new RecordingTelemetry()
  const logger = new FakeLogger()
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['strict outcome'] } } }),
    observability: { telemetry, logger },
    // Deliberately malformed adapter output exercises the runtime schema boundary.
    actions: { 'strict outcome': { phase: 'retrieval', evaluate: () => outcome as never } },
  })
  const error = await rails.filterRetrievedChunks(['safe']).catch((failure: unknown) => failure)
  expect(error).toMatchObject({ code: 'DECISION_EVALUATION_ERROR', meta: { failureKind } })
  expect(
    JSON.stringify({ error, spans: telemetry.spans, metrics: telemetry.metrics, logs: logger.records }),
  ).not.toContain('PRIVATE INSPECTED CONTENT')
})

it('keeps ordered transforms and rejects malformed phase outcomes and transform schema changes', async () => {
  const ordered = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['first', 'second'] } } }),
    actions: {
      first: {
        phase: 'retrieval',
        evaluate: () => ({ decision: 'transform', target: 'relevant_chunks', value: ['first'] }),
      },
      second: {
        phase: 'retrieval',
        evaluate: ({ value }) => ({ decision: 'transform', target: 'relevant_chunks', value: [...value, 'second'] }),
      },
    },
  })
  await expect(ordered.filterRetrievedChunks(['initial'])).resolves.toEqual(['first', 'second'])

  for (const action of [
    { phase: 'retrieval', evaluate: () => ({ decision: 'transform', target: 'bot_message', value: [] }) },
    { phase: 'retrieval', evaluate: () => null },
    { phase: 'retrieval', evaluate: () => ({ decision: 'transform', target: 'relevant_chunks', value: Number.NaN }) },
  ]) {
    const rails = defineGuardrails({
      config: inlineConfig({ rails: { retrieval: { flows: ['invalid'] } } }),
      actions: { invalid: action },
    })
    await expect(rails.filterRetrievedChunks(['safe'])).rejects.toMatchObject({ code: 'DECISION_EVALUATION_ERROR' })
  }

  let parseCount = 0
  const mutatingSchema = z
    .custom<readonly string[]>((value) => Array.isArray(value) && value.every((item) => typeof item === 'string'))
    .transform((value) => {
      parseCount += 1
      if (parseCount > 1) (value as string[])[0] = 'rewritten'
      return value
    })
  const mutating = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['mutating'] } } }),
    actions: {
      mutating: {
        phase: 'retrieval',
        valueSchema: mutatingSchema,
        evaluate: () => ({ decision: 'transform', target: 'relevant_chunks', value: ['original'] }),
      },
    },
  })
  await expect(mutating.filterRetrievedChunks(['original'])).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'invalid_transform' },
  })

  const zeroEquivalent = defineGuardrails({
    config: inlineConfig({ rails: { retrieval: { flows: ['zero'] } } }),
    actions: {
      zero: {
        phase: 'retrieval',
        valueSchema: z.array(z.number()).transform((values) => values.map(() => 0)),
        evaluate: () => ({ decision: 'transform', target: 'relevant_chunks', value: [0] }),
      },
    },
  })
  await expect(zeroEquivalent.filterRetrievedChunks([-0])).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'invalid_result' },
  })
})

it('inherits the enclosing tool deadline and fences a late rail continuation', async () => {
  vi.useFakeTimers()
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'lookup-timeout', name: 'lookup', arguments: { id: 'one' } }],
    finishReason: 'tool_calls',
  })
  let actionSignal: AbortSignal | undefined
  let resolveAction: (() => void) | undefined
  let startAction: () => void = () => undefined
  const actionStarted = new Promise<void>((resolve) => {
    startAction = resolve
  })
  let toolCalls = 0
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { tool_input: { flows: ['slow action'] } } }),
    actionTimeoutMs: 1_000,
    actions: {
      'slow action': {
        phase: 'tool_input',
        evaluate: ({ signal }) =>
          new Promise((resolve) => {
            actionSignal = signal
            resolveAction = () => resolve({ decision: 'allow' })
            startAction()
          }),
      },
    },
  })
  const harness = defineHarness()
    .defaults({ toolTimeoutMs: 10 })
    .sandbox(inMemorySandbox())
    .models({ assistant: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      lookup: {
        description: 'Lookup.',
        input: z.object({ id: z.string() }),
        output: z.object({ ok: z.boolean() }),
        handler: async () => {
          toolCalls += 1
          return { ok: true }
        },
      },
    })
    .agent('answer', {
      model: 'assistant',
      instructions: 'Answer.',
      tools: ['lookup'],
      builtinTools: false,
      interceptors: [
        {
          id: 'clock-skew',
          beforeTool: () => {
            // Advance wall time without advancing the already installed tool timer.
            // A nested timer clipped to the reported tool deadline would now win.
            vi.setSystemTime(Date.now() + 5)
            return { decision: 'allow' }
          },
        },
      ],
      guardrails: rails,
    })
    .build()
  try {
    const session = await harness.getSession('guardrail-tool-timeout')
    const result = session.agents.answer.run('lookup').catch((error: unknown) => error)
    await actionStarted
    await vi.advanceTimersByTimeAsync(10)
    expect(await result).toMatchObject({ code: 'OPERATION_TIMEOUT', meta: { scope: 'tool' } })
    expect(actionSignal?.aborted).toBe(true)
    expect(actionSignal?.reason).toMatchObject({ code: 'OPERATION_TIMEOUT', meta: { scope: 'tool' } })
    resolveAction?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(toolCalls).toBe(0)
    await session.release()
  } finally {
    await harness.shutdown()
    vi.useRealTimers()
  }
})

it.each([false, true])(
  'bounds standalone retrieval with fresh action budgets and explicit deadline=%s',
  async (explicitDeadline) => {
    vi.useFakeTimers()
    const deadlines: number[] = []
    const started = Date.now()
    const action = {
      phase: 'retrieval' as const,
      evaluate: (context: GuardrailActionContext<'retrieval'>) =>
        new Promise<{ decision: 'allow' }>((resolve) => {
          deadlines.push(context.deadline)
          setTimeout(() => resolve({ decision: 'allow' }), 8)
        }),
    }
    const rails = defineGuardrails({
      config: inlineConfig({ rails: { retrieval: { flows: ['first', 'second'] } } }),
      actionTimeoutMs: 10,
      actions: { first: action, second: action },
    })
    try {
      const result = rails.filterRetrievedChunks(['safe'], explicitDeadline ? { deadline: started + 5 } : {}).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      await vi.advanceTimersByTimeAsync(20)
      if (explicitDeadline) {
        expect(await result).toMatchObject({
          error: { code: 'DECISION_EVALUATION_ERROR', meta: { failureKind: 'callback_timeout' } },
        })
        expect(deadlines).toEqual([started + 5])
      } else {
        expect(await result).toEqual({ value: ['safe'] })
        expect(deadlines).toEqual([started + 10, started + 18])
      }
    } finally {
      vi.useRealTimers()
    }
  },
)

it.each([
  ['input', 'direct'],
  ['tool_input', 'direct'],
  ['input', 'delegated'],
  ['tool_input', 'delegated'],
] as const)('preserves rail-owned %s evidence and %s invocation identity', async (phase, mode) => {
  const provider = new FakeModelProvider()
  const count = mode === 'delegated' ? 2 : 1
  if (phase === 'tool_input')
    for (let index = 0; index < count; index += 1) {
      provider.enqueueObject({
        object: {},
        toolCalls: [{ id: 'same-call', name: 'lookup', arguments: { id: 'one' } }],
        finishReason: 'tool_calls',
      })
    }
  const contexts: GuardrailActionContext[] = []
  const occurrences: Array<{ invocationId: string; runId: string }> = []
  const failures: DecisionBlockedError[] = []
  const events: import('@purista/harness').RunEvent[] = []
  let handlers = 0
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { [phase]: { flows: ['allow first', 'block second'] } } }),
    actions: {
      'allow first': { phase, evaluate: () => ({ decision: 'allow' }) },
      'block second': {
        phase,
        evaluate: (context) => {
          contexts.push(context)
          return { decision: 'block', reasonCode: 'restricted' }
        },
      },
    },
  })
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      lookup: {
        description: 'Lookup.',
        input: z.object({ id: z.string() }),
        output: z.boolean(),
        handler: async () => {
          handlers += 1
          return true
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      input: z.string(),
      output: z.string(),
      builtinTools: false,
      tools: ['lookup'],
      interceptors: [
        {
          id: 'occurrence',
          beforeInput: ({ invocationId, runId }) => {
            occurrences.push({ invocationId, runId })
            return { decision: 'allow' }
          },
        },
      ],
      guardrails: rails,
    })
    .workflow('review', {
      input: z.string(),
      output: z.string(),
      delegation: { agents: ['answer'] },
      handler: async (ctx) => {
        for (let index = 0; index < count; index += 1) {
          try {
            await ctx.agents.answer(ctx.input)
          } catch (error) {
            if (!(error instanceof DecisionBlockedError)) throw error
            failures.push(error)
          }
        }
        return 'done'
      },
    })
    .build()
  const session = await harness.getSession(`rail-evidence-${phase}-${mode}`)
  if (mode === 'delegated') {
    for await (const event of session.workflows.review.stream('question')) events.push(event)
  } else {
    try {
      for await (const event of session.agents.answer.stream('question')) events.push(event)
    } catch (error) {
      if (!(error instanceof DecisionBlockedError)) throw error
      failures.push(error)
    }
  }
  expect(failures).toHaveLength(count)
  const started = events.filter((event) => event.type === 'agent.started')
  for (const [index, context] of contexts.entries()) {
    const { invocationId, runId } = occurrences[index]!
    expect(context.invocationId).toBe(invocationId)
    if (mode === 'delegated') expect(invocationId).not.toBe(runId)
    else expect(invocationId).toBe(runId)
    if (phase === 'tool_input')
      expect(invocationId).toBe(mode === 'delegated' ? started[index]?.delegationCallId : started[index]?.runId)
    const decisionId = `decision_${createHash('sha256')
      .update(
        JSON.stringify([
          runId,
          invocationId,
          phase,
          0,
          phase === 'tool_input' ? 'lookup' : null,
          phase === 'tool_input' ? 'same-call' : null,
          'guardrail',
          'block second',
          null,
          'block second',
          1,
        ]),
      )
      .digest('hex')}`
    expect(failures[index]?.meta).toEqual({
      evidence: {
        decisionId,
        source: { kind: 'guardrail', id: 'block second', ruleId: 'block second' },
        phase,
        reasonCode: 'restricted',
      },
    })
  }
  if (mode === 'delegated')
    expect(failures[0]?.meta?.evidence.decisionId).not.toBe(failures[1]?.meta?.evidence.decisionId)
  expect(handlers).toBe(0)
  expect(provider.requests).toHaveLength(phase === 'tool_input' ? count : 0)
  await harness.shutdown()
})
