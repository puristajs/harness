import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
  agentGuardrailsBinding,
  DecisionBlockedError,
  defineHarness,
  inMemorySandbox,
  InMemoryHarnessStorage,
  OperationCancelledError,
  OperationTimeoutError,
  serializeError,
  type ModelSchema,
} from '../src/index.js'
import type { JsonValue } from '../src/models/json.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { FakeLogger, FakeMemoryEngine, RecordingTelemetry } from '../src/testing/index.js'
import { runTelemetryFlowHarness } from './telemetryFlowHarness.js'
import * as mcp from '../src/tools/mcp/runner.js'
import { createMemoryFacade } from '../src/ports/memory.js'
import { createMetrics } from '../src/telemetry/index.js'
import { runPreparedToolBatch } from '../src/agents/tool-execution.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('appends a direct Guardrails binding after explicitly declared interceptors', async () => {
  const provider = new FakeModelProvider({ strict: true })
  provider.enqueueObject({
    object: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })
  const order: string[] = []
  const guardrails = {
    [agentGuardrailsBinding]: {
      id: 'guardrails',
      beforeInput: () => {
        order.push('guardrails')
        return { decision: 'allow' as const }
      },
    },
  }
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      interceptors: [
        {
          id: 'application',
          beforeInput: () => {
            order.push('application')
            return { decision: 'allow' }
          },
        },
      ],
      guardrails,
    })
    .build()

  await expect((await harness.getSession('direct-guardrails-order')).agents.answer.run('question')).resolves.toMatchObject({ status: 'completed', output: 'ok' })
  expect(order).toEqual(['application', 'guardrails'])
  provider.assertExhausted()
})

it('rejects default-loop controls on custom-handler agents during registration', () => {
  expect(() =>
    defineHarness()
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('custom', {
        model: 'fake',
        handler: async ({ input }: { input: string }) => input,
        guardrails: { [agentGuardrailsBinding]: { id: 'guardrails' } },
      } as never),
  ).toThrow(
    expect.objectContaining({
      meta: { reason: 'invalid_agent', path: 'agents.custom', id: 'custom' },
    }),
  )
})

it('transforms parsed input before the default loop builds the model request', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({ object: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      instructions: ({ input }) => `Answer the normalized input: ${input}`,
      builtinTools: false,
      interceptors: [
        {
          id: 'normalize',
          beforeInput: () => ({ decision: 'transform', value: 'safe input' }),
        },
      ],
    })
    .build()

  const session = await harness.getSession('interceptor-transform')
  await expect(session.agents.answer.run('unsafe input')).resolves.toMatchObject({ status: 'completed', output: 'ok' })
  expect(provider.requests[0]?.messages).toEqual([
    { role: 'system', content: 'Answer the normalized input: safe input' },
    { role: 'user', content: 'safe input' },
  ])
})

it('blocks a model response before it can be emitted or persisted', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: 'unsafe output',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      builtinTools: false,
      interceptors: [{ id: 'output', afterModel: () => ({ decision: 'block', reasonCode: 'unsafe_output' }) }],
    })
    .build()

  const session = await harness.getSession('interceptor-block')
  await expect(session.agents.answer.run('question')).rejects.toMatchObject({
    code: 'DECISION_BLOCKED',
    category: 'interceptor',
    meta: {
      evidence: { source: { id: 'output', kind: 'interceptor' }, phase: 'after_model', reasonCode: 'unsafe_output' },
    },
  })
  expect(provider.requests).toHaveLength(1)
  expect(await session.history.list()).toEqual([])
})

it('blocks a tool before its side effect', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'call-1', name: 'transfer', arguments: { amount: 10 } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
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
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      tools: ['transfer'],
      builtinTools: false,
      interceptors: [{ id: 'tool-input', beforeTool: () => ({ decision: 'block', reasonCode: 'not_approved' }) }],
    })
    .build()

  const session = await harness.getSession('interceptor-tool-block')
  await expect(session.agents.answer.run('transfer')).rejects.toBeInstanceOf(DecisionBlockedError)
  expect(calls).toBe(0)
})

it('preflights the complete tool batch before starting an eligible handler', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [
      { id: 'call-allow', name: 'transfer', arguments: { amount: 10 } },
      { id: 'call-block', name: 'transfer', arguments: { amount: 20 } },
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
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
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      tools: ['transfer'],
      builtinTools: false,
      interceptors: [
        {
          id: 'batch-rail',
          beforeTool: ({ callId }) =>
            callId === 'call-block' ? { decision: 'block', reasonCode: 'blocked' } : { decision: 'allow' },
        },
      ],
    })
    .build()

  const session = await harness.getSession('interceptor-batch-preflight')
  await expect(session.agents.answer.run('transfer twice')).rejects.toBeInstanceOf(DecisionBlockedError)
  expect(calls).toBe(0)
})

it('reuses transformed wire arguments while passing the once-parsed input to the handler', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'call-normalize', name: 'transfer', arguments: { amount: '1' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  let received: unknown
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      transfer: {
        description: 'Transfer funds.',
        input: z.object({ amount: z.coerce.number() }),
        output: z.object({ ok: z.boolean() }),
        handler: async (_ctx, input) => {
          received = input
          return { ok: true }
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      tools: ['transfer'],
      builtinTools: false,
      interceptors: [
        {
          id: 'normalize-tool',
          beforeTool: () => ({ decision: 'transform', value: { amount: '25' }, reasonCode: 'normalized' }),
        },
      ],
    })
    .build()

  const session = await harness.getSession('interceptor-transformed-tool')
  await expect(session.agents.answer.run('transfer')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(received).toEqual({ amount: 25 })
  expect(provider.requests[1]?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: [{ id: 'call-normalize', name: 'transfer', arguments: { amount: '25' } }],
      }),
    ]),
  )
})

it('projects native tool input schemas to the model and applies defaulted transforms once', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueObject({
    object: {},
    toolCalls: [{ id: 'call-default', name: 'normalize', arguments: {} }],
    finishReason: 'tool_calls',
  })
  provider.enqueueObject({ object: 'done', finishReason: 'stop' })
  const parseInput = vi.fn((value: string) => Number(value))
  const parseOutput = vi.fn((value: string) => `processed:${value}`)
  let handlerInput: unknown
  const observedOutputs: unknown[] = []
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      normalize: {
        description: 'Normalizes a defaulted amount.',
        input: z.object({ amount: z.string().default('2').transform(parseInput) }),
        output: z.string().transform(parseOutput),
        handler: async (_ctx, input) => {
          handlerInput = input
          return 'raw'
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Normalize.',
      builtinTools: false,
      tools: ['normalize'],
      interceptors: [
        {
          id: 'observe-output',
          afterTool: ({ output }) => {
            observedOutputs.push(output)
            return { decision: 'allow' }
          },
        },
      ],
    })
    .build()

  await expect((await harness.getSession('tool-schema-directions')).agents.answer.run('go')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(provider.requests[0]?.tools).toEqual([
    expect.objectContaining({
      name: 'normalize',
      parameters: expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({ amount: expect.objectContaining({ type: 'string', default: '2' }) }),
      }),
    }),
  ])
  expect(parseInput).toHaveBeenCalledTimes(1)
  expect(parseOutput).toHaveBeenCalledTimes(1)
  expect(handlerInput).toEqual({ amount: 2 })
  expect(observedOutputs).toEqual(['processed:raw'])
})

it('passes transformed defaults to a direct custom agent handler and validates its raw output once', async () => {
  const provider = new FakeModelProvider()
  const parseInput = vi.fn((value: string) => Number(value))
  const parseOutput = vi.fn((value: string) => Number(value))
  const seen: unknown[] = []
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('direct', {
      model: 'fake',
      instructions: '',
      input: z.string().default('3').transform(parseInput),
      output: z.string().transform(parseOutput),
      handler: async (ctx) => {
        seen.push(ctx.input)
        return '5'
      },
    })
    .build()

  await expect((await harness.getSession('direct-transforms')).agents.direct.run(undefined)).resolves.toMatchObject({ status: 'completed', output: 5 })
  expect(seen).toEqual([3])
  expect(parseInput).toHaveBeenCalledTimes(1)
  expect(parseOutput).toHaveBeenCalledTimes(1)
  expect(provider.requests).toEqual([])
})

it('uses the model-facing input schema for transformed agent output candidates', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueObject({ object: '6', finishReason: 'stop' })
  const parseOutput = vi.fn((value: string) => Number(value))
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('modeled', {
      model: 'fake',
      input: z.string(),
      output: z.string().transform(parseOutput),
      builtinTools: false,
      instructions: 'Return a number encoded as a string.',
    })
    .build()

  await expect((await harness.getSession('modeled-output-transform')).agents.modeled.run('go')).resolves.toMatchObject({ status: 'completed', output: 6 })
  expect(parseOutput).toHaveBeenCalledTimes(1)
  expect(provider.requests[0]).toMatchObject({ schema: { type: 'string' } })
})

it('transforms the final candidate before output validation and delivery', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: { answer: 'unsafe' },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  })
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      builtinTools: false,
      output: z.object({ answer: z.string() }),
      interceptors: [
        {
          id: 'final-rail',
          beforeOutput: () => ({ decision: 'transform', value: { answer: 'safe' }, reasonCode: 'redacted' }),
        },
      ],
    })
    .build()

  const session = await harness.getSession('interceptor-final-output')
  await expect(session.agents.answer.run('question')).resolves.toMatchObject({ status: 'completed', output: { answer: 'safe' } })
})

it('reparses every before-input transform and rejects malformed interceptor decisions closed', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({ object: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const seen: unknown[] = []
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      builtinTools: false,
      input: z.object({ count: z.coerce.number() }),
      interceptors: [
        { id: 'coerce', beforeInput: () => ({ decision: 'transform', value: { count: '2' } }) },
        {
          id: 'observe',
          beforeInput: ({ input }) => {
            seen.push(input)
            return { decision: 'allow' }
          },
        },
      ],
    })
    .agent('invalid', {
      model: 'fake',
      instructions: 'Answer.',
      builtinTools: false,
      interceptors: [{ id: 'invalid', beforeInput: () => ({ decision: 'transform', value: undefined }) as never }],
    })
    .build()

  const session = await harness.getSession('interceptor-transform-validation')
  await expect(session.agents.answer.run({ count: 0 })).resolves.toMatchObject({ status: 'completed', output: 'ok' })
  expect(seen).toEqual([{ count: 2 }])
  await expect(session.agents.invalid.run('question')).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'invalid_transform' },
  })
})

it('rejects a malformed before-model transcript before provider I/O', async () => {
  const provider = new FakeModelProvider()
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      builtinTools: false,
      interceptors: [
        {
          id: 'malformed-model-transform',
          beforeModel: () =>
            ({
              decision: 'transform',
              value: { messages: [{ role: 'user', content: 'injected', unsafe: true }] },
            }) as never,
        },
      ],
    })
    .build()

  const session = await harness.getSession('interceptor-model-validation')
  await expect(session.agents.answer.run('question')).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'invalid_transform' },
  })
  expect(provider.requests).toHaveLength(0)
})

it('protects completed tool interaction groups from prepare-step rewrites', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'call-1', name: 'transfer', arguments: { amount: 10 } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
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
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      tools: ['transfer'],
      builtinTools: false,
      prepareStep: ({ step, messages }) =>
        step === 1
          ? {
              messages: messages.map((message) =>
                message.role === 'assistant'
                  ? {
                      ...message,
                      toolCalls: message.toolCalls?.map((call) => ({ ...call, arguments: { amount: 999 } })),
                    }
                  : message,
              ),
            }
          : {},
    })
    .build()

  const session = await harness.getSession('interceptor-protected-transcript')
  await expect(session.agents.answer.run('transfer')).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: {
      failureKind: 'invalid_transform',
      evidence: { phase: 'before_model', source: { kind: 'interceptor', id: 'prepare_step' } },
    },
  })
  expect(calls).toBe(1)
  expect(provider.requests).toHaveLength(1)
})

it('uses the actual loop step for every interceptor invocation', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'call-1', name: 'transfer', arguments: { amount: 10 } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const steps: number[] = []
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      transfer: {
        description: 'Transfer funds.',
        input: z.object({ amount: z.number() }),
        output: z.object({ ok: z.boolean() }),
        handler: async () => ({ ok: true }),
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      tools: ['transfer'],
      builtinTools: false,
      interceptors: [
        {
          id: 'step-observer',
          beforeModel: ({ step }) => {
            steps.push(step)
            return { decision: 'allow' }
          },
        },
      ],
    })
    .build()

  await expect((await harness.getSession('interceptor-step')).agents.answer.run('transfer')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(steps).toEqual([0, 1])
})

it('continues recoverable schema failures with the frozen transformed wire call', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [{ id: 'call-invalid', name: 'transfer', arguments: { amount: 10 } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
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
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      tools: ['transfer'],
      builtinTools: false,
      interceptors: [
        { id: 'break-schema', beforeTool: () => ({ decision: 'transform', value: { amount: 'invalid' } }) },
      ],
    })
    .build()

  await expect(
    (await harness.getSession('interceptor-recoverable-wire')).agents.answer.run('transfer'),
  ).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(calls).toBe(0)
  expect(provider.requests[1]?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: [{ id: 'call-invalid', name: 'transfer', arguments: { amount: 'invalid' } }],
      }),
    ]),
  )
})

it.each([
  { decision: 'allow', reasonCode: 'contains prose' },
  { decision: 'block', reasonCode: 'x'.repeat(65) },
  { decision: 'transform', value: 'safe', reasonCode: 'CAPS' },
  { decision: 'allow', value: 'unexpected' },
  { decision: 'block', reason: 'unexpected prose' },
  { decision: 'transform', value: 'safe', target: 'unexpected' },
  { decision: 'transform' },
  Object.assign(Object.create({ value: 'inherited' }), { decision: 'transform' }),
])('rejects malformed closed interceptor outcomes: %j', async (outcome) => {
  const provider = new FakeModelProvider()
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      builtinTools: false,
      interceptors: [{ id: 'invalid-outcome', beforeInput: () => outcome as never }],
    })
    .build()

  const session = await harness.getSession('interceptor-closed-outcome')
  await expect(session.agents.answer.run('question')).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'invalid_result' },
  })
  expect(provider.requests).toHaveLength(0)
})

it.each(['getter', 'proxy'] as const)(
  'fails closed without exposing a throwing interceptor result %s',
  async (kind) => {
    const secret = 'SYNTHETIC_PRIVATE_INTERCEPTOR_RESULT'
    const fail = () => {
      throw new Error(secret)
    }
    const outcome =
      kind === 'getter'
        ? Object.defineProperty({}, 'decision', { enumerable: true, get: fail })
        : new Proxy(
            {},
            { get: (target, key, receiver) => (key === 'decision' ? fail() : Reflect.get(target, key, receiver)) },
          )
    const provider = new FakeModelProvider()
    const storage = new InMemoryHarnessStorage()
    const logger = new FakeLogger()
    const harness = defineHarness()
      .storage(storage)
      .logger(logger)
      .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
      .agent('answer', {
        model: 'fake',
        instructions: 'Answer.',
        builtinTools: false,
        interceptors: [{ id: 'throwing-outcome', beforeInput: () => outcome as never }],
      })
      .build()

    try {
      const session = await harness.getSession(`throwing-outcome-${kind}`)
      const error = await session.agents.answer.run('question').then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(error).toMatchObject({
        code: 'DECISION_EVALUATION_ERROR',
        message: 'Decision evaluation failed closed.',
        meta: { failureKind: 'invalid_result' },
      })
      expect(provider.requests).toHaveLength(0)
      const runs = await storage.listRuns(session.id)
      const events = await storage.listEvents(runs[0]!.id)
      expect(JSON.stringify({ error: serializeError(error), runs, events, logs: logger.records })).not.toContain(secret)
    } finally {
      await harness.shutdown()
    }
  },
)

it('enforces the parsed interceptor decision without rereading a changing getter', async () => {
  let reads = 0
  const outcome = Object.defineProperty({}, 'decision', {
    enumerable: true,
    get: () => (++reads <= 2 ? 'block' : 'allow'),
  })
  const provider = new FakeModelProvider()
  provider.enqueueObject({ object: 'done', finishReason: 'stop' })
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      builtinTools: false,
      interceptors: [{ id: 'changing-outcome', beforeInput: () => outcome as never }],
    })
    .build()

  try {
    const session = await harness.getSession('changing-outcome')
    await expect(session.agents.answer.run('question')).rejects.toBeInstanceOf(DecisionBlockedError)
    expect(reads).toBe(2)
    expect(provider.requests).toHaveLength(0)
  } finally {
    await harness.shutdown()
  }
})

it('continues every recoverable transformed preflight validation with the frozen wire calls', async () => {
  const provider = new FakeModelProvider()
  provider.enqueue({
    object: {},
    toolCalls: [
      { id: 'call-plain-validation', name: 'plain_validation', arguments: { amount: 1 } },
      { id: 'call-non-json', name: 'non_json', arguments: { amount: 2 } },
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  provider.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  let handlers = 0
  const plainValidationInput: ModelSchema<JsonValue, JsonValue> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => ({ issues: [{ message: 'amount is invalid' }] }),
      jsonSchema: { input: () => ({ type: 'object', properties: { amount: { type: 'number' } } }) },
    },
  }
  const nonJsonInput: ModelSchema<JsonValue, JsonValue> = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: () => ({ issues: [{ message: 'amount is invalid' }] }),
      jsonSchema: { input: () => ({ type: 'object', properties: { amount: { type: 'number' } } }) },
    },
  }
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      plain_validation: {
        description: 'Throws a plain validation error.',
        input: plainValidationInput,
        output: z.object({ ok: z.boolean() }),
        handler: async () => {
          handlers += 1
          return { ok: true }
        },
      },
      non_json: {
        description: 'Parses to a non-JSON value.',
        input: nonJsonInput,
        output: z.object({ ok: z.boolean() }),
        handler: async () => {
          handlers += 1
          return { ok: true }
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Answer.',
      tools: ['plain_validation', 'non_json'],
      builtinTools: false,
      interceptors: [
        {
          id: 'transform-wire',
          beforeTool: ({ callId }) => ({
            decision: 'transform',
            value: { amount: callId === 'call-plain-validation' ? 101 : 202 },
          }),
        },
      ],
    })
    .build()

  await expect(
    (await harness.getSession('interceptor-recoverable-preflight')).agents.answer.run('run tools'),
  ).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(handlers).toBe(0)
  expect(provider.requests[1]?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        toolCalls: [
          { id: 'call-plain-validation', name: 'plain_validation', arguments: { amount: 101 } },
          { id: 'call-non-json', name: 'non_json', arguments: { amount: 202 } },
        ],
      }),
    ]),
  )
})

it('attributes a blocked interceptor on the failed parent agent span without recording input content', async () => {
  const { session, telemetry } = await runTelemetryFlowHarness({
    interceptors: [{ id: 'compliance_gate', beforeInput: () => ({ decision: 'block' }) }],
  })

  await expect(session.agents.responder.run('customer-secret@example.test')).rejects.toBeInstanceOf(
    DecisionBlockedError,
  )
  const agentSpan = telemetry.spans.find((span) => span.name === 'invoke_agent responder')
  expect(agentSpan).toMatchObject({
    attrs: expect.objectContaining({
      'error.type': 'DECISION_BLOCKED',
    }),
  })
  expect(JSON.stringify(agentSpan)).not.toContain('customer-secret@example.test')
})

it('uses one input parse without transforms and reparses only actual replacements', async () => {
  const parses = vi.fn((value: number) => value + 1)
  const provider = new FakeModelProvider()
  provider.enqueueObject({ object: 'done', finishReason: 'stop' })
  const seen: unknown[] = []
  const harness = defineHarness()
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      input: z.number().transform(parses),
      builtinTools: false,
      instructions: 'Answer.',
      interceptors: [
        {
          id: 'observe',
          beforeInput: ({ input, agentInput, model }) => {
            seen.push([input, agentInput, model])
            return { decision: 'allow' }
          },
        },
      ],
    })
    .build()
  await expect((await harness.getSession('input-once')).agents.answer.run(1)).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(parses).toHaveBeenCalledTimes(1)
  expect(seen).toEqual([[2, 2, 'fake']])
  expect(provider.requests[0]?.messages).toContainEqual({ role: 'user', content: '2' })
  await harness.shutdown()
})

it('gives each interceptor callback a fresh deadline', async () => {
  vi.useFakeTimers()
  const provider = new FakeModelProvider()
  provider.enqueueObject({ object: 'done', finishReason: 'stop' })
  const remaining: number[] = []
  const beforeInput = async ({ decision }: { decision: { deadline: number } }) => {
    remaining.push(decision.deadline - Date.now())
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { decision: 'allow' as const }
  }
  const harness = defineHarness()
    .defaults({ decisionTimeoutMs: 30 })
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      builtinTools: false,
      instructions: 'Answer.',
      interceptors: [
        { id: 'one', beforeInput },
        { id: 'two', beforeInput },
      ],
    })
    .build()
  const session = await harness.getSession('interceptor-budgets')
  const result = session.agents.answer.run('question').then(
    (value) => value,
    (error: unknown) => error,
  )
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ status: 'completed', output: 'done' })
  expect(remaining).toEqual([30, 30])
  await harness.shutdown()
})

it('normalizes an interceptor own timeout and ignores its late resolution', async () => {
  vi.useFakeTimers()
  const provider = new FakeModelProvider()
  let finish: ((value: { decision: 'allow' }) => void) | undefined
  let child: AbortSignal | undefined
  const harness = defineHarness()
    .defaults({ decisionTimeoutMs: 10 })
    .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
    .agent('answer', {
      model: 'fake',
      builtinTools: false,
      instructions: 'Answer.',
      interceptors: [
        {
          id: 'slow',
          beforeInput: ({ decision }) => {
            child = decision.signal
            return new Promise((resolve) => {
              finish = resolve
            })
          },
        },
      ],
    })
    .build()
  const session = await harness.getSession('interceptor-own-timeout')
  const result = session.agents.answer.run('question').catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(11)
  expect(await result).toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'callback_timeout', evidence: { source: { id: 'slow' }, phase: 'input' } },
  })
  expect(child?.aborted).toBe(true)
  finish?.({ decision: 'allow' })
  await vi.advanceTimersByTimeAsync(100)
  expect(provider.requests).toHaveLength(0)
  expect(await session.history.list()).toEqual([])
  await harness.shutdown()
})

it.each(['direct', 'workflow', 'one_shot', 'continuable'] as const)(
  'reports the effective run deadline in %s interceptor contexts',
  async (mode) => {
    vi.useFakeTimers()
    const provider = new FakeModelProvider()
    const remaining: number[] = []
    const harness = defineHarness()
      .defaults({ decisionTimeoutMs: 100 })
      .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
      .agent('answer', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Answer.',
        interceptors: [
          {
            id: 'slow',
            beforeInput: ({ decision }) => {
              remaining.push(decision.deadline - Date.now())
              return new Promise(() => {})
            },
          },
        ],
      })
      .workflow('run', {
        input: z.string(),
        output: z.string(),
        delegation: { agents: ['answer'] },
        handler: async (ctx) => {
          if (mode === 'workflow') return ctx.agents.answer(ctx.input, { timeoutMs: 20 })
          if (mode === 'continuable') {
            const task = await ctx.childTasks.start('answer', ctx.input, { mode: 'continuable', timeoutMs: 20 })
            return task.close()
          }
          const task = await ctx.childTasks.start('answer', ctx.input, { timeoutMs: 20 })
          return task.result()
        },
      })
      .build()
    const session = await harness.getSession(`deadline-${mode}`)
    const result = (
      mode === 'direct'
        ? session.agents.answer.run('question', { timeoutMs: 20 })
        : session.workflows.run.run('question')
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(25)
    expect(await result).toMatchObject({ code: 'OPERATION_TIMEOUT', meta: { scope: 'run' } })
    expect(remaining).toEqual([20])
    expect(provider.requests).toHaveLength(0)
    await harness.shutdown()
  },
)

it('includes tool occurrence identity and skips interceptors without the current hook', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueObject({
    object: {},
    toolCalls: [
      { id: 'first', name: 'transfer', arguments: { amount: 1 } },
      { id: 'second', name: 'transfer', arguments: { amount: 2 } },
    ],
    finishReason: 'tool_calls',
  })
  let runId = ''
  let calls = 0
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      transfer: {
        description: 'Transfer.',
        input: z.object({ amount: z.number() }),
        output: z.boolean(),
        handler: async () => {
          calls += 1
          return true
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Transfer.',
      builtinTools: false,
      tools: ['transfer'],
      interceptors: [
        { id: 'model-only', afterModel: () => ({ decision: 'allow' }) },
        { id: 'abstain', beforeTool: () => undefined },
        {
          id: 'gate',
          beforeTool: (ctx) => {
            runId = ctx.runId
            return ctx.callId === 'second' ? { decision: 'block' } : { decision: 'allow' }
          },
        },
      ],
    })
    .build()
  const result = await (await harness.getSession('tool-identity')).agents.answer
    .run('question')
    .catch((error: unknown) => error)
  const id = `decision_${createHash('sha256')
    .update(JSON.stringify([runId, runId, 'tool_input', 0, 'transfer', 'second', 'interceptor', 'gate', null, null, 1]))
    .digest('hex')}`
  expect(result).toMatchObject({ code: 'DECISION_BLOCKED', meta: { evidence: { decisionId: id } } })
  expect(calls).toBe(0)
  await harness.shutdown()
})

it.each([
  ['prepareStep', 'arguments'],
  ['prepareStep', 'messages'],
  ['prepareStep', 'result'],
  ['prepareStep', 'continuation'],
  ['beforeModel', 'arguments'],
  ['beforeModel', 'messages'],
  ['beforeModel', 'result'],
  ['beforeModel', 'continuation'],
  ['beforeModel', 'tools'],
  ['beforeModel', 'schema'],
  ['beforeModel', 'generation'],
  ['afterModel', 'arguments'],
  ['afterModel', 'toolCalls'],
  ['afterModel', 'usage'],
  ['afterModel', 'continuation'],
] as const)('prevents in-place %s mutation of %s', async (phase, target) => {
  const provider = new FakeModelProvider()
  provider.enqueueObject({
    object: {},
    toolCalls: [{ id: 'call-1', name: 'transfer', arguments: { amount: 1 } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    providerContinuation: {
      providerId: 'fake',
      items: [
        { kind: 'opaque', data: { private: 'unchanged' } },
        { kind: 'tool_call', callId: 'call-1' },
      ],
    },
    finishReason: 'tool_calls',
  })
  let calls = 0
  const mutate = (context: any) => {
    if (phase === 'afterModel') {
      if (target === 'arguments') context.response.toolCalls[0].arguments.amount = 99
      if (target === 'toolCalls') context.response.toolCalls.pop()
      if (target === 'usage') context.response.usage.totalTokens = 999
      if (target === 'continuation') context.response.providerContinuation.items[0].data.private = 'changed'
      return
    }
    if (context.step !== 1) return
    const request = context.request ?? context
    if (target === 'arguments')
      request.messages.find((message: any) => message.toolCalls).toolCalls[0].arguments.amount = 99
    if (target === 'messages') request.messages.pop()
    if (target === 'result') request.messages.find((message: any) => message.role === 'tool').content = 'changed'
    if (target === 'continuation')
      request.messages.find((message: any) => message.providerContinuation).providerContinuation.items[0].data.private =
        'changed'
    if (target === 'tools') request.tools[0].name = 'unauthorized'
    if (target === 'schema') request.schema.type = 'number'
    if (target === 'generation') request.call.temperature = 2
  }
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      transfer: {
        description: 'Transfer.',
        input: z.object({ amount: z.number() }),
        output: z.boolean(),
        handler: async () => {
          calls += 1
          return true
        },
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Transfer.',
      builtinTools: false,
      tools: ['transfer'],
      prepareStep: (ctx) => {
        if (phase === 'prepareStep') mutate(ctx)
        return { call: { temperature: 0 } }
      },
      interceptors:
        phase === 'beforeModel'
          ? [
              {
                id: 'mutate',
                beforeModel: (ctx) => {
                  mutate(ctx)
                  return { decision: 'allow' }
                },
              },
            ]
          : phase === 'afterModel'
            ? [
                {
                  id: 'mutate',
                  afterModel: (ctx) => {
                    mutate(ctx)
                    return { decision: 'allow' }
                  },
                },
              ]
            : [],
    })
    .build()
  const session = await harness.getSession(`mutation-${phase}-${target}`)
  await expect(session.agents.answer.run('question')).rejects.toMatchObject({
    code: 'DECISION_EVALUATION_ERROR',
    meta: { failureKind: 'callback_failed' },
  })
  expect(provider.requests).toHaveLength(1)
  expect(calls).toBe(phase === 'afterModel' ? 0 : 1)
  expect(await session.history.list()).toEqual([])
  await harness.shutdown()
})

it('still allows omission of complete older interaction groups while retaining the latest batch', async () => {
  const provider = new FakeModelProvider()
  for (const id of ['older', 'latest'])
    provider.enqueueObject({
      object: {},
      toolCalls: [{ id, name: 'transfer', arguments: { amount: 1 } }],
      finishReason: 'tool_calls',
    })
  provider.enqueueObject({ object: 'done', finishReason: 'stop' })
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      transfer: {
        description: 'Transfer.',
        input: z.object({ amount: z.number() }),
        output: z.boolean(),
        handler: async () => true,
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Transfer.',
      builtinTools: false,
      tools: ['transfer'],
      prepareStep: ({ step, messages }) =>
        step === 2
          ? {
              messages: messages.filter(
                (message) =>
                  !(message.role === 'assistant' && message.toolCalls?.[0]?.id === 'older') &&
                  !(message.role === 'tool' && message.toolCallId === 'older'),
              ),
            }
          : {},
    })
    .build()
  await expect((await harness.getSession('historical-compaction')).agents.answer.run('question')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(provider.requests[2]?.messages).toContainEqual(
    expect.objectContaining({
      role: 'assistant',
      toolCalls: [{ id: 'latest', name: 'transfer', arguments: { amount: 1 } }],
    }),
  )
  expect(JSON.stringify(provider.requests[2]?.messages)).not.toContain('older')
  await harness.shutdown()
})

it.each([
  { tool: 'write', arguments: { path: 17, content: 'text' } },
  { tool: 'grep', arguments: { pattern: '[' } },
] as const)('validates built-in $tool input before policy or approval', async ({ tool, arguments: input }) => {
  const provider = new FakeModelProvider()
  provider.enqueueObject({
    object: {},
    toolCalls: [{ id: 'invalid', name: tool, arguments: input }],
    finishReason: 'tool_calls',
  })
  provider.enqueueObject({ object: 'done', finishReason: 'stop' })
  const policy = vi.fn(() => true)
  const approval = vi.fn(async () => ({ decision: 'approved' as const }))
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .agent('answer', { model: 'fake', instructions: 'Use the tool.', builtinTools: [tool] })
    .governance(({ native, rule }) => ({
      policies: [
        native({
          id: 'review',
          rules: [rule({ id: 'approve', tools: [tool], effect: 'require_approval', when: policy })],
        }),
      ],
      approval: { request: approval },
    }))
    .build()
  await expect((await harness.getSession(`invalid-builtin-${tool}`)).agents.answer.run('go')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(policy).not.toHaveBeenCalled()
  expect(approval).not.toHaveBeenCalled()
  const result = provider.requests[1]?.messages.find((message) => message.role === 'tool')
  expect(JSON.parse(result?.content as string)).toMatchObject({ code: 'VALIDATION_ERROR' })
  await harness.shutdown()
})

it('shares built-in schema defaults with policy and approval before the handler', async () => {
  const provider = new FakeModelProvider()
  provider.enqueueObject({
    object: {},
    toolCalls: [{ id: 'read-once', name: 'read', arguments: { path: '/file' } }],
    finishReason: 'tool_calls',
  })
  provider.enqueueObject({ object: 'done', finishReason: 'stop' })
  const base = inMemorySandbox()
  const readText = vi.fn(async () => 'content')
  const inputs: unknown[] = []
  const harness = defineHarness()
    .sandbox({
      ...base,
      open: async (options) => {
        const opened = await base.open(options)
        vi.spyOn(opened.session, 'readText').mockImplementation(readText)
        return opened
      },
    })
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .agent('answer', { model: 'fake', instructions: 'Read.', builtinTools: ['read'] })
    .governance(({ native, rule }) => ({
      policies: [
        native({
          id: 'review',
          rules: [
            rule({
              id: 'approve',
              tools: ['read'],
              effect: 'require_approval',
              when: ({ input }) => {
                inputs.push(input)
                return true
              },
            }),
          ],
        }),
      ],
      approval: {
        request: async ({ subject }) => {
          inputs.push(subject.input)
          expect(readText).not.toHaveBeenCalled()
          return { decision: 'approved' }
        },
      },
    }))
    .build()
  await expect((await harness.getSession('builtin-defaults')).agents.answer.run('go')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(inputs[0]).toEqual({ path: '/file', encoding: 'utf-8' })
  expect(inputs[1]).toBe(inputs[0])
  expect(Object.isFrozen(inputs[0])).toBe(true)
  expect(readText).toHaveBeenCalledExactlyOnceWith('/file', 'utf-8')
  expect(provider.requests[1]?.messages).toContainEqual(
    expect.objectContaining({
      role: 'assistant',
      toolCalls: [{ id: 'read-once', name: 'read', arguments: { path: '/file' } }],
    }),
  )
  await harness.shutdown()
})

it.each([true, false])('prepares MCP adapter input exactly once before approval (valid=%s)', async (valid) => {
  const provider = new FakeModelProvider()
  provider.enqueueObject({
    object: {},
    toolCalls: [{ id: 'mcp-once', name: 'lookup', arguments: { name: 'original' } }],
    finishReason: 'tool_calls',
  })
  provider.enqueueObject({ object: 'done', finishReason: 'stop' })
  const callTool = vi.fn(async () => ({ structuredContent: { ok: true } }))
  const runner: mcp.McpTransportRunner = {
    listTools: async () => [
      {
        name: 'lookup',
        inputSchema: {
          type: 'object',
          required: ['title'],
          additionalProperties: false,
          properties: { title: { type: 'string' } },
        },
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      },
    ],
    callTool,
    close: async () => {},
  }
  vi.spyOn(mcp, 'createMcpRunnerRegistry').mockReturnValue({
    getRunner: () => runner,
    close: async () => {},
    closeForSandboxKey: async () => {},
  })
  const inputs: unknown[] = []
  const inputAdapter = vi.fn((input: unknown) => ({ title: valid ? (input as { name: string }).name : 17 }))
  const outputAdapter = vi.fn((output: unknown) => ({ wrapped: output }))
  const afterTool = vi.fn(({ output }: { output: unknown }) => {
    expect(output).toEqual({ wrapped: { ok: true } })
    return { decision: 'allow' as const }
  })
  const approval = vi.fn(async ({ subject }: { subject: { input: unknown } }) => {
    inputs.push(subject.input)
    expect(callTool).not.toHaveBeenCalled()
    return { decision: 'approved' as const }
  })
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      lookup: {
        kind: 'mcp_http',
        description: 'Lookup.',
        url: 'https://mcp.example.test',
        tool: 'lookup',
        inputAdapter,
        outputAdapter,
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Lookup.',
      builtinTools: false,
      tools: ['lookup'],
      interceptors: [{ id: 'wire', beforeTool: () => ({ decision: 'transform', value: { name: 'safe' } }), afterTool }],
    })
    .governance(({ native, rule }) => ({
      policies: [
        native({
          id: 'review',
          rules: [
            rule({
              id: 'approve',
              tools: ['lookup'],
              effect: 'require_approval',
              when: ({ input }) => {
                inputs.push(input)
                return true
              },
            }),
          ],
        }),
      ],
      approval: { request: approval },
    }))
    .build()
  await expect((await harness.getSession(`mcp-prepared-${valid}`)).agents.answer.run('go')).resolves.toMatchObject({ status: 'completed', output: 'done' })
  expect(inputAdapter).toHaveBeenCalledExactlyOnceWith({ name: 'safe' })
  expect(approval).toHaveBeenCalledTimes(valid ? 1 : 0)
  expect(callTool).toHaveBeenCalledTimes(valid ? 1 : 0)
  expect(afterTool).toHaveBeenCalledTimes(valid ? 1 : 0)
  expect(outputAdapter).toHaveBeenCalledTimes(valid ? 1 : 0)
  if (valid) {
    expect(inputs[0]).toEqual({ title: 'safe' })
    expect(inputs[1]).toBe(inputs[0])
    expect(callTool.mock.calls[0]?.[1]).toBe(inputs[0])
    expect(Object.isFrozen(inputs[0])).toBe(true)
  }
  expect(provider.requests[1]?.messages).toContainEqual(
    expect.objectContaining({
      role: 'assistant',
      toolCalls: [{ id: 'mcp-once', name: 'lookup', arguments: { name: 'safe' } }],
    }),
  )
  await harness.shutdown()
})

it.each([
  ['prepareStep', 'orphan'],
  ['prepareStep', 'duplicate'],
  ['beforeModel', 'orphan'],
  ['beforeModel', 'duplicate'],
] as const)('rejects %s leaving an %s older tool result before model I/O', async (phase, change) => {
  const provider = new FakeModelProvider()
  for (const id of ['older', 'latest'])
    provider.enqueueObject({
      object: {},
      toolCalls: [{ id, name: 'transfer', arguments: { amount: 1 } }],
      finishReason: 'tool_calls',
    })
  provider.enqueueObject({ object: 'done', finishReason: 'stop' })
  const rewrite = (messages: readonly import('../src/ports/model-provider.js').ModelMessage[]) =>
    change === 'orphan'
      ? messages.filter((message) => !(message.role === 'assistant' && message.toolCalls?.[0]?.id === 'older'))
      : [...messages, messages.find((message) => message.role === 'tool' && message.toolCallId === 'older')!]
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      transfer: {
        description: 'Transfer.',
        input: z.object({ amount: z.number() }),
        output: z.boolean(),
        handler: async () => true,
      },
    })
    .agent('answer', {
      model: 'fake',
      instructions: 'Transfer.',
      builtinTools: false,
      tools: ['transfer'],
      prepareStep: ({ step, messages }) =>
        phase === 'prepareStep' && step === 2 ? { messages: rewrite(messages) } : {},
      interceptors: [
        {
          id: 'transcript',
          beforeModel: ({ step, request }) =>
            phase === 'beforeModel' && step === 2
              ? { decision: 'transform', value: { messages: rewrite(request.messages) } }
              : { decision: 'allow' },
        },
      ],
    })
    .build()
  await expect(
    (await harness.getSession(`${phase}-${change}-result`)).agents.answer.run('go'),
  ).rejects.toMatchObject({ code: 'DECISION_EVALUATION_ERROR', meta: { failureKind: 'invalid_transform' } })
  expect(provider.requests).toHaveLength(2)
  await harness.shutdown()
})

it.each(['cancelled', 'timed_out'] as const)(
  'does not prepare a tool when its parent is already %s',
  async (outcome) => {
    const controller = new AbortController()
    const reason =
      outcome === 'cancelled'
        ? new OperationCancelledError('Run cancelled.', { scope: 'run' })
        : new OperationTimeoutError('Run timed out.', { scope: 'run', timeout_ms: 10 })
    controller.abort(reason)
    const logger = new FakeLogger()
    const telemetry = new RecordingTelemetry()
    const sandbox = inMemorySandbox()
    const scope = {
      owner: { namespace: 'pre-aborted', id: 'session', instanceId: '01J00000000000000000000000' },
      partition: { kind: 'shared' as const },
      lifetime: 'run' as const,
      runId: 'run',
    }
    await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
    const opened = await sandbox.open({ scope, mode: 'create' })
    const memory = createMemoryFacade({
      engine: new FakeMemoryEngine(),
      harnessName: 'pre-aborted',
      sessionId: 'session',
      runId: 'run',
      logger,
      telemetry,
      metrics: createMetrics(telemetry),
      contentCaptureMode: 'NO_CONTENT',
      signal: controller.signal,
    })
    const beforeTool = vi.fn(async (_toolId, _callId, input) => input)
    const afterTool = vi.fn(async (_toolId, _callId, output) => output)
    const approval = vi.fn(async () => ({ decision: 'approved' as const }))
    await expect(
      runPreparedToolBatch(
        {
          harnessName: 'pre-aborted',
          agentId: 'answer',
          runId: 'run',
          sessionId: 'session',
          agent: { permissions: { write: 'require_approval' } },
          customTools: {},
          governance: { approval: { request: approval } },
          session: opened.session,
          memory,
          skills: {},
          activatedSkills: new Set(),
          signal: controller.signal,
          toolTimeoutMs: 10,
          decisionTimeoutMs: 10,
          maxParallelToolCalls: 1,
          logger,
          telemetry,
          step: 0,
          enabledCustomTools: new Set(),
          turnMessageId: (slot) => slot,
          beforeTool,
          afterTool,
        },
        [{ id: 'call', name: 'write', arguments: { path: '/file', content: 'data' } }],
        [{ name: 'write', description: 'Write.', parameters: {} }],
      ),
    ).rejects.toBe(reason)
    expect(beforeTool).not.toHaveBeenCalled()
    expect(approval).not.toHaveBeenCalled()
    expect(afterTool).not.toHaveBeenCalled()
    await opened.session.close()
  },
)

it('keeps Standard Schema tool preflight failures recoverable while rejecting unexposed calls', async () => {
  const logger = new FakeLogger()
  const telemetry = new RecordingTelemetry()
  const sandbox = inMemorySandbox()
  const scope = {
    owner: { namespace: 'standard-tool-boundary', id: 'session', instanceId: '01J00000000000000000000000' },
    partition: { kind: 'shared' as const },
    lifetime: 'run' as const,
    runId: 'run',
  }
  await sandbox.registerOwner({ owner: scope.owner, mode: 'create' })
  const opened = await sandbox.open({ scope, mode: 'create' })
  const controller = new AbortController()
  const memory = createMemoryFacade({
    engine: new FakeMemoryEngine(),
    harnessName: 'standard-tool-boundary',
    sessionId: 'session',
    runId: 'run',
    logger,
    telemetry,
    metrics: createMetrics(telemetry),
    contentCaptureMode: 'NO_CONTENT',
    signal: controller.signal,
  })
  const valid = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) } }
  const invalid = {
    '~standard': { version: 1 as const, vendor: 'test', validate: () => ({ issues: [{ message: 'private' }] }) },
  }
  const args = {
    harnessName: 'standard-tool-boundary',
    agentId: 'answer',
    runId: 'run',
    sessionId: 'session',
    agent: {},
    customTools: {
      lookup: {
        description: 'Looks up a value.',
        input: valid,
        output: valid,
        handler: async (_ctx: unknown, input: unknown) => input,
      },
      rejected: { description: 'Rejects a value.', input: invalid, output: valid, handler: async () => 'unreachable' },
    },
    session: opened.session,
    memory,
    skills: {},
    activatedSkills: new Set<string>(),
    signal: controller.signal,
    toolTimeoutMs: 50,
    decisionTimeoutMs: 50,
    maxParallelToolCalls: 1,
    logger,
    telemetry,
    step: 0,
    enabledCustomTools: new Set(['lookup', 'rejected']),
    turnMessageId: (slot: string) => slot,
    beforeTool: async (_toolId: string, _callId: string, input: JsonValue) => input,
    afterTool: async (_toolId: string, _callId: string, output: JsonValue) => output,
  }

  await expect(
    runPreparedToolBatch(
      args as never,
      [
        { id: 'valid', name: 'lookup', arguments: { id: '1' } },
        { id: 'invalid', name: 'rejected', arguments: { id: '2' } },
      ],
      [
        { name: 'lookup', description: 'Looks up a value.', parameters: {} },
        { name: 'rejected', description: 'Rejects a value.', parameters: {} },
      ],
    ),
  ).resolves.toMatchObject({
    outcomes: [
      { modelMessage: { content: JSON.stringify({ id: '1' }) } },
      { modelMessage: { content: expect.stringContaining('VALIDATION_ERROR') } },
    ],
  })
  await expect(
    runPreparedToolBatch(args as never, [{ id: 'hidden', name: 'hidden', arguments: {} }], []),
  ).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' })
  await expect(
    runPreparedToolBatch(
      args as never,
      [{ id: 'wrong-type', name: 'lookup', arguments: new Date() as never }],
      [{ name: 'lookup', description: 'Looks up a value.', parameters: {} }],
    ),
  ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  await opened.session.close()
})
