import { SpanStatusCode } from '@opentelemetry/api'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  agentGuardrailsBinding,
  createDecisionEvidence,
  DecisionBlockedError,
  defineAgent,
  defineHarness,
  defineTool,
  defineWorkflow,
  serializeError,
  type ExecutionEvent,
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
  ).toThrow(/Guardrails configuration is invalid/)
})

it('classifies absent and inherited flows as missing while rejecting present forged tokens', () => {
  const config = { rails: { input: { flows: ['gate'] } } } as const
  const expectedMissing = expect.objectContaining({
    code: 'GUARDRAILS_CONFIG_ERROR',
    message: 'Guardrails configuration is invalid.',
    meta: { reason: 'action_missing', field: 'flows.gate', flowId: 'gate' },
  })
  expect(() => defineGuardrailsApi({ config, actions: {} } as never)).toThrow(expectedMissing)

  const inherited = Object.create({
    gate: defineGuardrailAction({ phase: 'input', evaluate: () => ({ decision: 'allow' }) }),
  }) as Record<string, never>
  expect(() => defineGuardrailsApi({ config, actions: inherited } as never)).toThrow(expectedMissing)
  expect(() => defineGuardrailsApi({
    config,
    actions: { gate: { phase: 'input', evaluate: () => ({ decision: 'allow' }) } } as never,
  } as never)).toThrow(expect.objectContaining({
    code: 'GUARDRAILS_CONFIG_ERROR',
    message: 'Guardrails configuration is invalid.',
    meta: { reason: 'invalid_action', field: 'flows.gate', flowId: 'gate' },
  }))
})

it('normalizes invalid and hostile action registries without leaking access failures', () => {
  const config = { rails: { input: { flows: ['gate'] } } } as const
  const token = defineGuardrailAction({ phase: 'input', evaluate: () => ({ decision: 'allow' }) })
  const unreadableOwnProperty = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('private registry descriptor') },
  })
  const unreadableValue = new Proxy({ gate: token }, {
    get(target, property, receiver) {
      if (property === 'gate') throw new Error('private registry value')
      return Reflect.get(target, property, receiver)
    },
  })
  for (const actions of [unreadableOwnProperty, unreadableValue]) {
    expect(() => defineGuardrailsApi({ config, actions } as never)).toThrow(expect.objectContaining({
      code: 'GUARDRAILS_CONFIG_ERROR',
      message: 'Guardrails configuration is invalid.',
      meta: { reason: 'invalid_action', field: 'flows.gate', flowId: 'gate' },
    }))
    expect(() => defineGuardrailsApi({ config, actions } as never)).not.toThrow(/private registry/)
  }
  expect(() => defineGuardrailsApi({ config, actions: null } as never)).toThrow(expect.objectContaining({
    code: 'GUARDRAILS_CONFIG_ERROR',
    message: 'Guardrails configuration is invalid.',
    meta: { reason: 'invalid_shape', field: 'actions' },
  }))
})

it('runs canonical input and output rails with the Harness test adapter', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueText({
    content: 'unsafe answer',
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
  const answer = defineAgent('answer', {
    model: 'assistant',
    output: z.string(),
    instructions: 'Answer the supplied question.',
    guardrails: rails,
  })
  const harness = await defineHarness({ name: 'guardrailsTransform' })
    .addAgent(answer)
    .getInstance({ models: { assistant: { provider, model: 'fake' } } })

  const session = await harness.getSession('guardrails-transform')
  await expect(session.agents.answer.run('unsafe question')).resolves.toMatchObject({ status: 'completed', output: 'safe answer' })
  expect(provider.requests[0]?.messages).toEqual([
    { role: 'system', content: 'Answer the supplied question.' },
    { role: 'user', content: 'safe question', toolCalls: undefined },
  ])
})

it('blocks a configured tool-input rail before the Harness tool has a side effect', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueText({
    content: '',
    toolCalls: [{ id: 'transfer-1', name: 'transfer', arguments: { amount: 100 } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { tool_input: { flows: ['approve transfer'] } } }),
    actions: { 'approve transfer': { phase: 'tool_input', evaluate: () => ({ decision: 'block' }) } },
  })
  let calls = 0
  const transfer = defineTool('transfer', {
    description: 'Transfer funds.',
    input: z.object({ amount: z.number() }),
    output: z.object({ ok: z.boolean() }),
    handler: async () => {
      calls += 1
      return { ok: true }
    },
  })
  const answer = defineAgent('answer', {
    model: 'assistant',
    output: z.string(),
    instructions: 'Answer.',
    tools: [transfer],
    guardrails: rails,
  })
  const harness = await defineHarness({ name: 'guardrailsToolBlock' })
    .addAgent(answer)
    .getInstance({ models: { assistant: { provider, model: 'fake' } } })

  const session = await harness.getSession('guardrails-tool-block')
  await expect(session.agents.answer.run('transfer')).rejects.toMatchObject({ code: 'DECISION_BLOCKED' })
  expect(calls).toBe(0)
})

it('masks an explicitly selected structured tool-input field before the Harness tool executes', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueText({
    content: '',
    toolCalls: [{ id: 'transfer-1', name: 'transfer', arguments: { amount: 100, memo: 'refund test@example.test' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  provider.enqueueText({ content: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
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
  const transfer = defineTool('transfer', {
    description: 'Transfer funds.',
    input: z.object({ amount: z.number(), memo: z.string() }),
    output: z.object({ ok: z.boolean() }),
    handler: async (_context, { memo }) => {
      receivedMemo = memo
      return { ok: true }
    },
  })
  const answer = defineAgent('answer', {
    model: 'assistant',
    output: z.string(),
    instructions: 'Answer.',
    tools: [transfer],
    guardrails: rails,
  })
  const harness = await defineHarness({ name: 'guardrailsToolMask' })
    .addAgent(answer)
    .getInstance({ models: { assistant: { provider, model: 'fake' } } })

  const session = await harness.getSession('guardrails-tool-mask')
  await expect(session.agents.answer.run('transfer')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(receivedMemo).toBe('refund <MASKED>')
})

it('snapshots sensitive-data helper options and codec functions while retaining the live detector', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueText({
    content: '',
    toolCalls: [{ id: 'transfer-1', name: 'transfer', arguments: { memo: 'refund test@example.test' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  provider.enqueueText({ content: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  let detectorCalls = 0
  const detector: SensitiveDataDetector = {
    id: 'mutable-detector',
    executionMode: 'local',
    supportedEntities: ['EMAIL_ADDRESS'],
    async inspect() { return { findings: [] } },
  }
  const tools = ['transfer'] as ['transfer']
  const codec = {
    id: 'transferMemo',
    extract: (value: { memo: string }) => [{ id: 'memo', text: value.memo }],
    replace: (value: { memo: string }, replacements: readonly { start: number; end: number; value: string }[]) => ({
      memo: replacements.reduce(
        (memo, replacement) => memo.slice(0, replacement.start) + replacement.value + memo.slice(replacement.end),
        value.memo,
      ),
    }),
  }
  const options = {
    detector,
    phase: 'tool_input' as const,
    tools,
    policy: 'input' as const,
    operation: 'mask' as const,
    valueSchema: z.object({ memo: z.string() }),
    codec,
  }
  const action = sensitiveDataToolRail(options)
  Reflect.set(tools, 0, 'otherTool')
  Reflect.set(options, 'phase', 'tool_output')
  Reflect.set(options, 'policy', 'output')
  Reflect.set(options, 'operation', 'detect')
  Reflect.set(codec, 'extract', () => [])
  Reflect.set(codec, 'replace', () => ({ memo: 'mutated' }))
  const liveInspect: SensitiveDataDetector['inspect'] = async ({ text }) => {
    detectorCalls += 1
    const start = text.indexOf('test@example.test')
    return { findings: start < 0 ? [] : [{ category: 'EMAIL_ADDRESS', start, end: start + 17 }] }
  }
  Reflect.set(detector, 'inspect', liveInspect)

  const rails = defineGuardrailsApi({
    config: {
      rails: { tool_input: { flows: ['mask memo'] } },
      sensitiveData: { input: { entities: ['EMAIL_ADDRESS'], maskToken: '<MASKED>', scoreThreshold: 0 } },
    },
    actions: { 'mask memo': action },
  })
  expect(rails[agentGuardrailsBinding].requirements).toEqual({ tools: ['transfer'] })
  let receivedMemo: string | undefined
  const transfer = defineTool('transfer', {
    description: 'Transfer funds.',
    input: z.object({ memo: z.string() }),
    output: z.boolean(),
    handler: async (_context, input) => {
      receivedMemo = input.memo
      return true
    },
  })
  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', tools: [transfer], guardrails: rails,
  })
  const harness = await defineHarness({ name: 'immutableSensitiveDataHelper' })
    .addAgent(answer)
    .getInstance({ models: { assistant: { provider, model: 'assistant' } } })
  const session = await harness.getSession('immutable-sensitive-data-helper')

  await expect(session.agents.answer.run('transfer')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(receivedMemo).toBe('refund <MASKED>')
  expect(detectorCalls).toBe(1)
  await harness.close()
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
  safety.enqueueObject({
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
  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', guardrails: rails,
  })
  const harness = await defineHarness({ name: 'guardrailsModelCheck' })
    .addAgent(answer)
    .getInstance({
      models: {
        assistant: { provider: assistant, model: 'assistant' },
        safety: { provider: safety, model: 'safety' },
      },
    })

  const session = await harness.getSession('guardrails-model-check')
  await expect(session.agents.answer.run('unsafe question')).rejects.toMatchObject({ code: 'DECISION_BLOCKED' })
  expect(safety.requests).toHaveLength(1)
  expect(assistant.requests).toHaveLength(0)
})

it('snapshots model-check helper configuration before caller mutation', async () => {
  const safety = new FakeModelProvider()
  safety.enqueueObject({
    object: { allow: true },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })
  const assistant = new FakeModelProvider()
  assistant.enqueueText({ content: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const options = {
    phase: 'input' as const,
    model: 'safety' as const,
    instructions: 'Use the original safety policy.',
  }
  const action = modelCheckRail(options)
  Reflect.set(options, 'model', 'mutatedModel')
  Reflect.set(options, 'instructions', 'Use the mutated policy.')
  const rails = defineGuardrailsApi({
    config: { rails: { input: { flows: ['self check'] } } },
    actions: { 'self check': action },
  })
  expect(rails[agentGuardrailsBinding].requirements).toEqual({
    models: [{ alias: 'safety', capabilities: ['object'] }],
  })
  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', guardrails: rails,
  })
  const harness = await defineHarness({ name: 'immutableModelCheckHelper' })
    .addAgent(answer)
    .getInstance({
      models: {
        assistant: { provider: assistant, model: 'assistant' },
        safety: { provider: safety, model: 'safety' },
      },
    })
  const session = await harness.getSession('immutable-model-check-helper')

  await expect(session.agents.answer.run('question')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(safety.requests[0]?.messages[0]).toEqual({ role: 'system', content: 'Use the original safety policy.' })
  await harness.close()
})

it('derives a frozen, sorted binding requirement snapshot from only selected attached actions', () => {
  const rails = defineGuardrailsApi({
    config: {
      rails: {
        input: { flows: ['model check'] },
        tool_input: { flows: ['tool check'] },
        tool_output: { flows: ['second tool check'] },
        retrieval: { flows: ['retrieval check'] },
      },
    },
    actions: {
      'model check': defineGuardrailAction({
        phase: 'input',
        models: ['zetaModel', 'alphaModel'],
        evaluate: () => ({ decision: 'allow' }),
      }),
      'tool check': defineGuardrailAction({
        phase: 'tool_input',
        tools: ['zetaTool', 'alphaTool'],
        evaluate: () => ({ decision: 'allow' }),
      }),
      'second tool check': defineGuardrailAction({
        phase: 'tool_output',
        tools: ['middleTool', 'alphaTool'],
        models: ['alphaModel'],
        evaluate: () => ({ decision: 'allow' }),
      }),
      'retrieval check': defineGuardrailAction({
        phase: 'retrieval',
        models: ['retrievalModel'],
        evaluate: () => ({ decision: 'allow' }),
      }),
      'unused check': defineGuardrailAction({
        phase: 'input',
        models: ['unusedModel'],
        evaluate: () => ({ decision: 'allow' }),
      }),
    },
  })

  const binding = rails[agentGuardrailsBinding]
  expect(binding).toMatchObject({
    id: 'purista.guardrails',
    requirements: {
      tools: ['alphaTool', 'middleTool', 'zetaTool'],
      models: [
        { alias: 'alphaModel', capabilities: ['object'] },
        { alias: 'zetaModel', capabilities: ['object'] },
      ],
    },
  })
  expect(Object.isFrozen(binding.requirements)).toBe(true)
  expect(Object.isFrozen(binding.requirements?.tools)).toBe(true)
  expect(Object.isFrozen(binding.requirements?.models)).toBe(true)
  expect(Object.isFrozen(binding.requirements?.models?.[0])).toBe(true)
  expect(Object.isFrozen(binding.requirements?.models?.[0]?.capabilities)).toBe(true)

  const tool = <const Id extends string>(id: Id) => defineTool(id, {
    description: `${id} test tool.`, input: z.string(), output: z.string(), handler: async (_context, input) => input,
  })
  const answer = defineAgent('requirementsAgent', {
    model: 'assistant',
    instructions: 'Answer.',
    tools: [tool('zetaTool'), tool('alphaTool'), tool('middleTool')],
    guardrails: rails,
  })
  const definition = defineHarness({ name: 'guardrailRequirements' }).addAgent(answer)
  expect(definition.requirements.models.alphaModel).toEqual({ capabilities: ['object'] })
  expect(definition.requirements.models.zetaModel).toEqual({ capabilities: ['object'] })
  expect(definition.requirements.models).not.toHaveProperty('retrievalModel')
  expect(definition.requirements.models).not.toHaveProperty('unusedModel')
})

it.each(['input', 'output', 'tool_input', 'tool_output'] as const)(
  'derives requirements from the selected %s phase independently',
  (phase) => {
    const action = phase === 'tool_input' || phase === 'tool_output'
      ? defineGuardrailAction({
          phase,
          tools: ['selectedTool'],
          models: ['selectedModel'],
          evaluate: () => ({ decision: 'allow' }),
        })
      : defineGuardrailAction({
          phase,
          models: ['selectedModel'],
          evaluate: () => ({ decision: 'allow' }),
        })
    const rails = defineGuardrailsApi({
      config: { rails: { [phase]: { flows: ['selected'] } } },
      actions: { selected: action },
    } as never)

    expect(rails[agentGuardrailsBinding].requirements).toEqual({
      ...(phase === 'tool_input' || phase === 'tool_output' ? { tools: ['selectedTool'] } : {}),
      models: [{ alias: 'selectedModel', capabilities: ['object'] }],
    })
  },
)

it('omits attached requirements for empty and retrieval-only flow selections', () => {
  const retrieval = defineGuardrailAction({
    phase: 'retrieval',
    models: ['retrievalModel'],
    evaluate: () => ({ decision: 'allow' }),
  })
  expect(defineGuardrailsApi({ config: {}, actions: {} })[agentGuardrailsBinding].requirements).toBeUndefined()
  expect(defineGuardrailsApi({
    config: { rails: { retrieval: { flows: ['retrieval'] } } },
    actions: { retrieval },
  })[agentGuardrailsBinding].requirements).toBeUndefined()
})

it('rejects malformed and duplicate action selectors with content-free configuration errors', () => {
  for (const definition of [
    { phase: 'input', models: [] },
    { phase: 'input', models: ['invalid-alias'] },
    { phase: 'input', models: ['safety', 'safety'] },
    { phase: 'tool_input', tools: ['transfer', 'transfer'] },
    { phase: 'tool_input', tools: ['invalid-tool'] },
    { phase: 'tool_input', tools: [] },
  ]) {
    expect(() =>
      defineGuardrailAction({ ...definition, evaluate: () => ({ decision: 'allow' }) } as never),
    ).toThrow(expect.objectContaining({
      code: 'GUARDRAILS_CONFIG_ERROR',
      message: 'Guardrails configuration is invalid.',
      meta: { reason: 'invalid_shape', field: 'action' },
    }))
  }
})

it('rejects malformed action callbacks and hidden fields with classified content-free errors', () => {
  expect(() => defineGuardrailAction({ phase: 'input' } as never)).toThrow(expect.objectContaining({
    code: 'GUARDRAILS_CONFIG_ERROR',
    message: 'Guardrails configuration is invalid.',
    meta: { reason: 'invalid_action', field: 'action' },
  }))

  const hiddenField = { phase: 'input', evaluate: () => ({ decision: 'allow' }) }
  Object.defineProperty(hiddenField, 'privatePrompt', { value: 'must not cross the error boundary' })
  const symbolField = {
    phase: 'input',
    evaluate: () => ({ decision: 'allow' }),
    [Symbol('private')]: true,
  }
  for (const definition of [hiddenField, symbolField]) {
    expect(() => defineGuardrailAction(definition as never)).toThrow(expect.objectContaining({
      code: 'GUARDRAILS_CONFIG_ERROR',
      message: 'Guardrails configuration is invalid.',
      meta: { reason: 'invalid_shape', field: 'action' },
    }))
  }
})

it('snapshots own action fields once and rejects inherited required fields without leaking getters', () => {
  let evaluateReads = 0
  const changingGetter = { phase: 'input' }
  Object.defineProperty(changingGetter, 'evaluate', {
    enumerable: true,
    get() {
      evaluateReads += 1
      if (evaluateReads > 1) throw new Error('private getter content')
      return () => ({ decision: 'allow' })
    },
  })
  expect(() => defineGuardrailAction(changingGetter as never)).not.toThrow()
  expect(evaluateReads).toBe(1)

  const throwingGetter = { phase: 'input' }
  Object.defineProperty(throwingGetter, 'evaluate', {
    enumerable: true,
    get() { throw new Error('private getter content') },
  })
  expect(() => defineGuardrailAction(throwingGetter as never)).toThrow(expect.objectContaining({
    code: 'GUARDRAILS_CONFIG_ERROR',
    message: 'Guardrails configuration is invalid.',
    meta: { reason: 'invalid_shape', field: 'action' },
  }))
  expect(() => defineGuardrailAction(throwingGetter as never)).not.toThrow(/private getter content/)

  const inheritedBoth = Object.create({
    phase: 'input',
    evaluate: () => ({ decision: 'allow' }),
  })
  expect(() => defineGuardrailAction(inheritedBoth as never)).toThrow(expect.objectContaining({
    meta: { reason: 'invalid_shape', field: 'action' },
  }))
  const inheritedEvaluate = Object.assign(
    Object.create({ evaluate: () => ({ decision: 'allow' }) }),
    { phase: 'input' },
  )
  expect(() => defineGuardrailAction(inheritedEvaluate as never)).toThrow(expect.objectContaining({
    meta: { reason: 'invalid_action', field: 'action' },
  }))

  let toolReads = 0
  const tools = new Array<string>(1)
  Object.defineProperty(tools, 0, {
    enumerable: true,
    get() {
      toolReads += 1
      return toolReads === 1 ? 'safeTool' : 'invalid-tool'
    },
  })
  let modelReads = 0
  const models = new Array<string>(1)
  Object.defineProperty(models, 0, {
    enumerable: true,
    get() {
      modelReads += 1
      return modelReads === 1 ? 'safeModel' : 'invalid-model'
    },
  })
  const snapshottedSelectors = defineGuardrailAction({
    phase: 'tool_input', tools, models, evaluate: () => ({ decision: 'allow' }),
  } as never)
  const rails = defineGuardrailsApi({
    config: { rails: { tool_input: { flows: ['selector snapshot'] } } },
    actions: { 'selector snapshot': snapshottedSelectors },
  } as never)
  expect(rails[agentGuardrailsBinding].requirements).toEqual({
    tools: ['safeTool'],
    models: [{ alias: 'safeModel', capabilities: ['object'] }],
  })
  expect(toolReads).toBe(1)
  expect(modelReads).toBe(1)
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

  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', guardrails: rails,
  })
  const error = (() => {
    try {
      defineHarness({ name: 'missingGuardrailTool' }).addAgent(answer)
    } catch (value) {
      return value
    }
    throw new Error('Expected attached requirements to fail build validation.')
  })()
  expect(error).toMatchObject({ code: 'HARNESS_CONFIG_ERROR', meta: { reason: 'invalid_agent', id: 'publish' } })
  expect(provider.requests).toEqual([])
})

it('requires selected action models as exact runtime bindings before provider work', async () => {
  const provider = new FakeModelProvider()
  const rails = defineGuardrailsApi({
    config: { rails: { input: { flows: ['model check'] } } },
    actions: {
      'model check': defineGuardrailAction({
        phase: 'input',
        models: ['safety'],
        evaluate: () => ({ decision: 'allow' }),
      }),
    },
  })
  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', guardrails: rails,
  })
  const definition = defineHarness({ name: 'missingGuardrailModel' }).addAgent(answer)
  expect(() =>
    definition.getInstance({ models: { assistant: { provider, model: 'assistant' } } } as never),
  ).toThrow(expect.objectContaining({ code: 'HARNESS_CONFIG_ERROR' }))
  expect(provider.requests).toEqual([])
})

it('projects only declared attached action models and rejects unavailable requirements before action callbacks', async () => {
  const assistant = new FakeModelProvider()
  assistant.enqueueText({
    content: 'safe answer',
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
  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', guardrails: rails,
  })
  const unrelatedAgent = defineAgent('unrelatedAgent', {
    model: 'unrelated', output: z.string(), instructions: 'Remain unused.',
  })
  const harness = await defineHarness({ name: 'attachedModelProjection' })
    .addAgent(answer)
    .addAgent(unrelatedAgent)
    .getInstance({
      models: {
        assistant: { provider: assistant, model: 'assistant' },
        safety: { provider: safety, model: 'safety' },
        unrelated: { provider: unrelated, model: 'unrelated' },
      },
    })
  const session = await harness.getSession('attached-model-projection')
  try {
    await expect(session.agents.answer.run('question')).resolves.toMatchObject({ status: 'completed', output: 'safe answer' })
    expect(exposedAliases).toEqual(['safety'])
    expect(actionCalls).toBe(1)
  } finally {
    await session.release()
    await harness.close()
  }

  for (const runtimeSafety of [undefined, { provider: { id: 'no-object', genAiSystem: 'test' }, model: 'safety' }]) {
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
    const rejectedAnswer = defineAgent('rejectedAnswer', {
      model: 'assistant', output: z.string(), instructions: 'Answer.', guardrails: rejectedRails,
    })
    const rejectedDefinition = defineHarness({ name: 'rejectedModelProjection' }).addAgent(rejectedAnswer)
    expect(() =>
      rejectedDefinition.getInstance({
        models: {
          assistant: { provider: assistant, model: 'assistant' },
          ...(runtimeSafety ? { safety: runtimeSafety } : {}),
        },
      } as never),
    ).toThrow(expect.objectContaining({ code: 'HARNESS_CONFIG_ERROR' }))
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
        model: 'guardrailModel',
        instructions: 'Return the allow decision.',
      }),
    },
  })

  await expect(
    rails.filterRetrievedChunks(['untrusted'], {
      models: {
        guardrailModel: {
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

it('adapts a workflow-provided managed model handle inside the guardrail span', async () => {
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
  provider.enqueueObject({
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

  const review = defineWorkflow('review', {
      input: z.string(),
      output: z.number(),
      models: { safety: { capabilities: ['object'] } },
      handler: async (ctx) => {
        const chunks = await rails.filterRetrievedChunks([ctx.input], {
          models: {
            safety: {
              object: (request) => ctx.models.safety.object(JSON.parse(JSON.stringify(request)), { callId: 'guardrailSafety' }),
            },
          },
          signal: ctx.signal,
          logger: ctx.logger,
        })
        return chunks.length
      },
    })
  const harness = await defineHarness({ name: 'guardrailsTest' })
    .addWorkflow(review)
    .getInstance({ models: { safety: { provider, model: 'safety-model' } } })
  const session = await harness.getSession('model-backed-retrieval')
  try {
    await expect(session.workflows.review.run('approved source')).resolves.toMatchObject({ status: 'completed', output: 1 })
    expect(provider.requests).toHaveLength(1)
  } finally {
    await session.release()
    await harness.close()
    vi.restoreAllMocks()
  }
  const guardrailSpan = telemetry.spans.find((span) => span.name === 'evaluate_guardrail safety model')
  expect(guardrailSpan).toMatchObject({ attrs: { 'openinference.span.kind': 'GUARDRAIL' } })
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
  provider.enqueueText({
    content: 'pending',
    toolCalls: [{ id: 'transfer-1', name: 'transfer', arguments: { amount: '10' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  const transfer = defineTool('transfer', {
    description: 'Transfer.',
    input: z.object({ amount: z.number() }),
    output: z.object({ ok: z.boolean() }),
    handler: async () => ({ ok: true }),
  })
  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', tools: [transfer], guardrails: coercingValueSchema,
  })
  const harness = await defineHarness({ name: 'coercingRail' })
    .addAgent(answer)
    .getInstance({ models: { assistant: { provider, model: 'fake' } } })
  const session = await harness.getSession('coercing-rail')
  await expect(session.agents.answer.run('transfer')).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'invalid_result' },
  })
  await session.release()
  await harness.close()
})

it('blocks final output before model-object delivery or assistant persistence', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueText({ content: 'restricted final', finishReason: 'stop' })
  const rails = defineGuardrails({
    config: inlineConfig({ rails: { output: { flows: ['final gate'] } } }),
    actions: { 'final gate': { phase: 'output', evaluate: () => ({ decision: 'block', reasonCode: 'restricted' }) } },
  })
  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', guardrails: rails,
  })
  const harness = await defineHarness({ name: 'guardrailFinalBlock' })
    .addAgent(answer)
    .getInstance({ models: { assistant: { provider, model: 'fake' } } })
  const session = await harness.getSession('guardrail-final-block')
  const events = []
  for await (const event of session.agents.answer.stream('question')) events.push(event)
  expect(events.some((event) => event.type === 'output.object.snapshot')).toBe(false)
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'run.finished',
        outcome: expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'DECISION_BLOCKED' }) }),
      }),
    ]),
  )
  expect(await session.history.list()).toEqual([])
  await session.release()
  await harness.close()
})

it('applies output rails only to the final candidate after tool execution', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueText({
    content: 'intermediate tool text',
    toolCalls: [{ id: 'lookup-1', name: 'lookup', arguments: { id: 'one' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  provider.enqueueText({
    content: 'restricted final',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })
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
  const lookup = defineTool('lookup', {
    description: 'Lookup.',
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    handler: async () => {
      toolCalls += 1
      return { ok: true }
    },
  })
  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', tools: [lookup], guardrails: rails,
  })
  const harness = await defineHarness({ name: 'guardrailToolFinal' })
    .addAgent(answer)
    .getInstance({ models: { assistant: { provider, model: 'fake' } } })
  const session = await harness.getSession('guardrail-tool-final')
  await expect(session.agents.answer.run('lookup')).rejects.toMatchObject({ code: 'DECISION_BLOCKED' })
  expect(toolCalls).toBe(1)
  expect(railCalls).toBe(1)
  await session.release()
  await harness.close()
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
  provider.enqueueText({
    content: 'pending',
    toolCalls: [{ id: 'lookup-timeout', name: 'lookup', arguments: { id: 'one' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
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
  const lookup = defineTool('lookup', {
    description: 'Lookup.',
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    handler: async () => {
      toolCalls += 1
      return { ok: true }
    },
  })
  const answer = defineAgent('answer', {
    model: 'assistant', output: z.string(), instructions: 'Answer.', tools: [lookup], guardrails: rails,
  })
  const harness = await defineHarness({ name: 'guardrailToolTimeout', defaults: { toolTimeoutMs: 10 } })
    .addAgent(answer)
    .getInstance({ models: { assistant: { provider, model: 'fake' } } })
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
    await harness.close()
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
      provider.enqueueText({
        content: 'pending',
        toolCalls: [{ id: 'same-call', name: 'lookup', arguments: { id: 'one' } }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'tool_calls',
      })
    }
  const contexts: GuardrailActionContext[] = []
  const failures: DecisionBlockedError[] = []
  const delegatedFailures: unknown[] = []
  const events: ExecutionEvent[] = []
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
  const lookup = defineTool('lookup', {
    description: 'Lookup.',
    input: z.object({ id: z.string() }),
    output: z.boolean(),
    handler: async () => {
      handlers += 1
      return true
    },
  })
  const answer = defineAgent('answer', {
    model: 'fake',
    instructions: 'Answer.',
    input: z.string(),
    output: z.string(),
    prompt: input => ({ role: 'user', content: input }),
    tools: [lookup],
    guardrails: rails,
  })
  const review = defineWorkflow('review', {
    input: z.string(),
    output: z.string(),
    agents: [answer],
    handler: async (ctx) => {
      for (let index = 0; index < count; index += 1) {
        try {
          await ctx.agents.answer.run(ctx.input, { callId: `answerCall${index}` })
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'WORKFLOW_MANAGED_CALL_FAILED')
            throw error
          delegatedFailures.push(error)
        }
      }
      return 'done'
    },
  })
  const harness = await defineHarness({ name: 'railEvidence' })
    .addAgent(answer)
    .addWorkflow(review)
    .getInstance({ models: { fake: { provider, model: 'fake' } } })
  const session = await harness.getSession(`rail-evidence-${phase}-${mode}`)
  if (mode === 'delegated') {
    for await (const event of session.workflows.review.stream('question')) events.push(event)
  } else {
    try {
      await session.agents.answer.run('question')
    } catch (error) {
      if (!(error instanceof DecisionBlockedError)) throw error
      failures.push(error)
    }
  }
  const blockedFailures = mode === 'delegated'
    ? delegatedFailures
    : failures
  expect(blockedFailures).toHaveLength(count)
  for (const [index, context] of contexts.entries()) {
    const { invocationId, runId } = context
    expect(invocationId).toBe(runId)
    const evidence = createDecisionEvidence({
      occurrence: {
        invocationId,
        step: context.step,
        ...(runId ? { runId } : {}),
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        ...(context.toolId ? { toolId: context.toolId } : {}),
        ...(context.callId ? { callId: context.callId } : {}),
      },
      source: { kind: 'guardrail', id: 'block second', ruleId: 'block second' },
      phase,
      ordinal: 1,
      reasonCode: 'restricted',
    })
    if (mode === 'direct') expect(blockedFailures[index]?.meta).toEqual({ evidence })
    else expect(blockedFailures[index]).toMatchObject({
      code: 'WORKFLOW_MANAGED_CALL_FAILED',
      meta: {
        reason: 'operation_failed',
        workflow_id: 'review',
        call_id: `answerCall${index}`,
        operation: 'agent_run',
        target_kind: 'agent',
        target_id: 'answer',
      },
    })
  }
  if (mode === 'delegated') {
    expect(new Set(contexts.map((context) => context.invocationId)).size).toBe(count)
    const decisionIds = contexts.map(context => createDecisionEvidence({
      occurrence: {
        invocationId: context.invocationId,
        step: context.step,
        ...(context.runId ? { runId: context.runId } : {}),
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        ...(context.toolId ? { toolId: context.toolId } : {}),
        ...(context.callId ? { callId: context.callId } : {}),
      },
      source: { kind: 'guardrail', id: 'block second', ruleId: 'block second' },
      phase,
      ordinal: 1,
      reasonCode: 'restricted',
    }).decisionId)
    expect(decisionIds[0]).not.toBe(decisionIds[1])
  }
  expect(handlers).toBe(0)
  expect(provider.requests).toHaveLength(phase === 'tool_input' ? count : 0)
  await harness.close()
})
