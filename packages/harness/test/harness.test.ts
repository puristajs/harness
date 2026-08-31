import { exec, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { env as processEnv } from 'node:process'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { expect, it } from 'vitest'
import {
  BaseModelProvider,
  InMemoryHarnessStorage,
  defineHarness,
  inMemoryMemoryEngine,
  inMemorySandbox,
  JsonLogger,
  OperationTimeoutError,
  type MemoryEngine,
  type ModelSchema,
  type SandboxProcess,
  type SandboxSession,
  type SpawnCapableSandboxSession,
} from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { inMemoryDurableWorkspace } from '../src/index.js'
import {
  AgentLoopBudgetError,
  HarnessConfigError,
  ModelCapabilityError,
  ModelError,
  SessionBusyError,
  SkillManifestError,
} from '../src/errors/index.js'
import type { ObjectRequest } from '../src/ports/model-provider.js'
import type { ObjectResponse } from '../src/ports/model-provider.js'
import type { HarnessAdapterContext } from '../src/ports/harness-context.js'

const fakeMcpServerPath = fileURLToPath(new URL('../src/testing/fixtures/mcp/fake-stdio-server.mjs', import.meta.url))

class SlowBaseProvider extends BaseModelProvider {
  public constructor() {
    super({ id: 'slow', genAiSystem: 'test' })
  }

  protected override async doObject<
    T extends import('../src/index.js').JsonValue = import('../src/index.js').JsonValue,
  >(): Promise<ObjectResponse<T>> {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return {
      object: 'late' as T,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    }
  }
}

class ProjectionRetryProvider extends BaseModelProvider {
  public attempts = 0
  public readonly requests: ObjectRequest[] = []

  public constructor() {
    super({ id: 'projection-retry', genAiSystem: 'test' })
  }

  protected override async doObject<
    T extends import('../src/index.js').JsonValue = import('../src/index.js').JsonValue,
  >(request: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.attempts += 1
    this.requests.push(request)
    if (this.attempts === 1) {
      throw new ModelError('Temporary network failure.', {
        provider: this.id,
        model: 'fake',
        method: 'object',
        reason: 'network',
      })
    }
    return { object: 'done' as T, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
  }
}

class ContextAwareHarnessStorage extends InMemoryHarnessStorage {
  public configured = false

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.configured = context.harnessName === 'ctx-test'
  }
}

function enqueueReadToolRounds(model: FakeModelProvider, count: number): void {
  for (let index = 0; index < count; index += 1) {
    model.enqueue({
      object: {},
      toolCalls: [{ id: `c${index + 1}`, name: 'read', arguments: { path: '/workspace/a.txt' } }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
    })
  }
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
}

it('compiles each model-facing schema once at build and reuses it across runs', async () => {
  const model = new ProjectionRetryProvider()
  let outputProjectionCalls = 0
  let toolProjectionCalls = 0
  const output: ModelSchema = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => ({ value: value as string }),
      jsonSchema: {
        input: () => {
          outputProjectionCalls += 1
          return { type: 'string' }
        },
      },
    },
  }
  const input: ModelSchema = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => ({ value: value as { id: string } }),
      jsonSchema: {
        input: () => {
          toolProjectionCalls += 1
          return { type: 'object', properties: { id: { type: 'string' } } }
        },
      },
    },
  }
  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({
      fake: {
        provider: model,
        model: 'fake',
        capabilities: ['object', 'tool_use'],
        retry: { minDelayMs: 0, maxDelayMs: 0 },
      },
    })
    .tools({
      lookup: { description: 'Lookup.', input, output: z.string(), handler: async (_ctx, value) => value.id },
    })
    .skills({})
    .agent('answer', { model: 'fake', instructions: 'Answer.', tools: ['lookup'], output })
    .build()

  expect(outputProjectionCalls).toBe(1)
  expect(toolProjectionCalls).toBe(1)
  await expect((await harness.getSession('projection-first')).agents.answer.run('first')).resolves.toBe('done')
  await expect((await harness.getSession('projection-second')).agents.answer.run('second')).resolves.toBe('done')
  expect(outputProjectionCalls).toBe(1)
  expect(toolProjectionCalls).toBe(1)
  expect(model.attempts).toBe(3)
  expect(model.requests).toHaveLength(3)
  expect(model.requests[0]?.schema).toBe(model.requests[1]?.schema)
  expect(model.requests[1]?.schema).toBe(model.requests[2]?.schema)
  expect(model.requests[0]?.tools?.[0]?.parameters).toBe(model.requests[1]?.tools?.[0]?.parameters)
  expect(model.requests[1]?.tools?.[0]?.parameters).toBe(model.requests[2]?.tools?.[0]?.parameters)
})

it('enforces maxSteps in default agent loop', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'c1', name: 'read', arguments: { path: '/workspace/a.txt' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'c2', name: 'read', arguments: { path: '/workspace/a.txt' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })

  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({})
    .skills({})
    .agent('a1', { model: 'fast', instructions: 'x', builtinTools: ['read'], maxSteps: 1 })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string>,
    })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.run('hello')).rejects.toBeInstanceOf(AgentLoopBudgetError)
})

it('honors an explicit agent maxSteps value above 64', async () => {
  const model = new FakeModelProvider()
  enqueueReadToolRounds(model, 65)

  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({})
    .skills({})
    .agent('a1', { model: 'fast', instructions: 'x', builtinTools: ['read'], maxSteps: 66 })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string>,
    })
    .build()

  const session = await harness.getSession('max-steps-above-64')
  await expect(session.workflows.wf.run('hello')).resolves.toBe('done')
  expect(model.requests).toHaveLength(66)
})

it('honors a harness default agentMaxIterations value above 64', async () => {
  const model = new FakeModelProvider()
  enqueueReadToolRounds(model, 65)

  const harness = await defineHarness()
    .defaults({ agentMaxIterations: 66 })
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({})
    .skills({})
    .agent('a1', { model: 'fast', instructions: 'x', builtinTools: ['read'] })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string>,
    })
    .build()

  const session = await harness.getSession('default-max-steps-above-64')
  await expect(session.workflows.wf.run('hello')).resolves.toBe('done')
  expect(model.requests).toHaveLength(66)
})

it('rejects invalid agent loop budgets at configuration time', () => {
  const model = new FakeModelProvider()
  const agentWith = (maxSteps: number) =>
    defineHarness()
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('a1', { model: 'fast', instructions: 'x', builtinTools: false, maxSteps })

  expect(() => defineHarness().defaults({ agentMaxIterations: 0 })).toThrow(HarnessConfigError)
  expect(() => defineHarness().defaults({ agentMaxIterations: 1.5 })).toThrow(HarnessConfigError)
  expect(() => agentWith(0)).toThrow(HarnessConfigError)
  expect(() => agentWith(1.5)).toThrow(HarnessConfigError)
})

it('lets prepareStep switch model aliases and restrict active tools', async () => {
  const primary = new FakeModelProvider()
  const fallback = new FakeModelProvider()
  fallback.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({
      primary: { provider: primary, model: 'primary-model', capabilities: ['object', 'tool_use'] },
      fallback: { provider: fallback, model: 'fallback-model', capabilities: ['object'] },
    })
    .tools({
      lookup: {
        description: 'Lookup a value.',
        input: z.object({ id: z.string() }),
        output: z.object({ value: z.string() }),
        handler: async (_ctx, input) => ({ value: input.id }),
      },
    })
    .skills({})
    .agent('a1', {
      model: 'primary',
      instructions: 'x',
      tools: ['lookup'],
      builtinTools: false,
      prepareStep: ({ step }) => (step === 0 ? { model: 'fallback', activeTools: [] } : {}),
    })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string>,
    })
    .build()

  const s = await harness.getSession('s-prepare-step')
  await expect(s.workflows.wf.run('hello')).resolves.toBe('done')

  expect(primary.requests).toHaveLength(0)
  expect(fallback.requests).toHaveLength(1)
  expect((fallback.requests[0] as ObjectRequest).model).toBe('fallback-model')
  expect((fallback.requests[0] as ObjectRequest).tools).toEqual([])
})

it('lets stopWhen end the default loop without executing requested tools', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: 'done',
    toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { id: 'ignored' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  let toolCalls = 0

  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      lookup: {
        description: 'Lookup a value.',
        input: z.object({ id: z.string() }),
        output: z.object({ value: z.string() }),
        handler: async (_ctx, input) => {
          toolCalls += 1
          return { value: input.id }
        },
      },
    })
    .skills({})
    .agent('a1', {
      model: 'fast',
      instructions: 'x',
      tools: ['lookup'],
      builtinTools: false,
      stopWhen: ({ step, toolCalls }) => step === 0 && toolCalls.length > 0,
    })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string>,
    })
    .build()

  const s = await harness.getSession('s-stop-when')
  await expect(s.workflows.wf.run('hello')).resolves.toBe('done')
  expect(toolCalls).toBe(0)
})

it('replays model provider continuation on the next agent loop round without persisting it', async () => {
  const model = new FakeModelProvider()
  const providerContinuation = {
    providerId: 'fake',
    items: [
      { kind: 'opaque', data: { type: 'reasoning', id: 'rs_1' } },
      { kind: 'tool_call', callId: 'c1' },
    ],
  }
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'c1', name: 'read', arguments: { path: '/workspace/a.txt' } }],
    providerContinuation,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({})
    .skills({})
    .agent('a1', { model: 'fast', instructions: 'x', builtinTools: ['read'] })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string>,
    })
    .build()

  const s = await harness.getSession('s1')
  await s.workflows.wf.run('hello')

  const secondRound = model.requests[1] as ObjectRequest
  const assistantTurn = secondRound.messages.find((m) => m.role === 'assistant')
  expect(assistantTurn).toMatchObject({ role: 'assistant', providerContinuation })
  const persisted = await s.history.list()
  for (const message of persisted) {
    expect('providerContinuation' in message).toBe(false)
  }
})

it('session busy guard and memory file semantics', async () => {
  const model = new FakeModelProvider()
  model.enqueue({ object: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .tools({})
    .skills({})
    .agent('a1', { model: 'fast', instructions: 'x', builtinTools: false })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return ctx.agents.a1(ctx.input) as Promise<string>
      },
    })
    .build()

  const s = await harness.getSession('s1')
  await s.memory.write('foo', { a: 1 })
  expect(await s.memory.read('foo')).toEqual({ a: 1 })
  const p1 = s.workflows.wf.run('x')
  await expect(s.workflows.wf.run('y')).rejects.toBeInstanceOf(SessionBusyError)
  await p1
})

it('agent loop uses model capability gates', async () => {
  const model = new FakeModelProvider()
  model.enqueue({ object: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['text'] } })
    .tools({})
    .skills({})
    .agent('a1', { model: 'fast', input: z.string(), output: z.string(), instructions: 'x' })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.run('hello')).rejects.toBeInstanceOf(ModelCapabilityError)
})

it('passes harness logger and model timeout defaults into base model providers', async () => {
  const logs: string[] = []
  const harness = defineHarness()
    .logger(new JsonLogger({ level: 'error', out: { write: (chunk) => logs.push(chunk) } }))
    .defaults({ modelTimeoutMs: 5 })
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: new SlowBaseProvider(), model: 'fake', capabilities: ['object'] } })
    .tools({})
    .skills({})
    .agent('a1', { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.run('hello')).rejects.toBeInstanceOf(OperationTimeoutError)
  expect(logs.join('')).toContain('Model provider call failed.')
})

it('validates model retry policies at alias registration time', () => {
  const model = new FakeModelProvider()

  expect(() =>
    defineHarness().models({
      fast: { provider: model, model: 'fake', capabilities: ['object'], retry: { maxAttempts: 0 } },
    }),
  ).toThrow(HarnessConfigError)

  expect(() =>
    defineHarness().models({
      fast: {
        provider: model,
        model: 'fake',
        capabilities: ['object'],
        defaults: { retry: { maxActiveDelayMs: -1 } },
      },
    }),
  ).toThrow(HarnessConfigError)
})

it('passes harness context into storage, sandbox, and tool adapters', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'call-1', name: 'ctx_tool', arguments: { value: 'x' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const state = new ContextAwareHarnessStorage()
  let sandboxConfigured = false
  let memoryConfigured = false
  let toolConfigured = false
  let toolSawContext = false
  const baseMemory = inMemoryMemoryEngine()
  const memory = {
    info: baseMemory.info,
    capabilities: baseMemory.capabilities,
    get: baseMemory.get.bind(baseMemory),
    put: baseMemory.put.bind(baseMemory),
    delete: baseMemory.delete.bind(baseMemory),
    list: baseMemory.list.bind(baseMemory),
    ...(baseMemory.close ? { close: baseMemory.close.bind(baseMemory) } : {}),
    configureHarnessContext(context: HarnessAdapterContext) {
      memoryConfigured =
        context.harnessName === 'ctx-test' && Boolean(context.metrics) && context.contentCaptureMode === 'NO_CONTENT'
    },
  } satisfies MemoryEngine
  const sandbox = {
    ...inMemorySandbox(),
    configureHarnessContext(context: HarnessAdapterContext) {
      sandboxConfigured = context.harnessName === 'ctx-test'
    },
  }

  const harness = defineHarness({ name: 'ctx-test' })
    .logger(new JsonLogger({ level: 'fatal', out: { write: () => undefined } }))
    .storage(state)
    .sandbox(sandbox)
    .memory(memory)
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      ctx_tool: {
        kind: 'ts',
        description: 'Context test tool.',
        input: z.object({ value: z.string() }),
        output: z.object({ ok: z.boolean() }),
        configureHarnessContext(context: HarnessAdapterContext) {
          toolConfigured = context.harnessName === 'ctx-test'
        },
        handler: async (ctx) => {
          toolSawContext = Boolean(ctx.logger && ctx.telemetry && ctx.memory.session && ctx.runId && ctx.sessionId)
          return { ok: true }
        },
      },
    })
    .skills({})
    .agent('a1', {
      model: 'fast',
      input: z.string(),
      output: z.string(),
      instructions: 'x',
      tools: ['ctx_tool'],
      builtinTools: false,
    })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.run('hello')).resolves.toBe('done')
  expect(state.configured).toBe(true)
  expect(sandboxConfigured).toBe(true)
  expect(memoryConfigured).toBe(true)
  expect(toolConfigured).toBe(true)
  expect(toolSawContext).toBe(true)
})

it('rejects malformed Harness storage synchronously', () => {
  expect(() => defineHarness().storage({} as never)).toThrow(HarnessConfigError)

  const missingCapability = new InMemoryHarnessStorage() as InMemoryHarnessStorage & { capabilities: string[] }
  Object.defineProperty(missingCapability, 'capabilities', { value: ['storage.checkpoint'] })
  expect(() => defineHarness().storage(missingCapability as never)).toThrow(HarnessConfigError)
})

it('executes tool calls from the same model response concurrently and preserves model result order', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [
      { id: 'call-slow', name: 'timed_tool', arguments: { id: 'slow', delayMs: 70 } },
      { id: 'call-fast', name: 'timed_tool', arguments: { id: 'fast', delayMs: 10 } },
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  let activeTools = 0
  let maxActiveTools = 0
  const completionOrder: string[] = []

  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      timed_tool: {
        kind: 'ts',
        description: 'Records overlapping tool execution.',
        input: z.object({ id: z.string(), delayMs: z.number().int().nonnegative() }),
        output: z.object({ id: z.string() }),
        handler: async (_ctx, input) => {
          activeTools += 1
          maxActiveTools = Math.max(maxActiveTools, activeTools)
          await new Promise((resolve) => setTimeout(resolve, input.delayMs))
          activeTools -= 1
          completionOrder.push(input.id)
          return { id: input.id }
        },
      },
    })
    .skills({})
    .agent('a1', {
      model: 'fast',
      input: z.string(),
      output: z.string(),
      instructions: 'Use both tool calls, then return done.',
      tools: ['timed_tool'],
      builtinTools: false,
    })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  const s = await harness.getSession('parallel-tools')
  await expect(s.workflows.wf.run('hello')).resolves.toBe('done')

  expect(maxActiveTools).toBe(2)
  expect(completionOrder).toEqual(['fast', 'slow'])

  const secondModelRequest = model.requests[1] as ObjectRequest
  const toolMessages = secondModelRequest.messages.filter((message) => message.role === 'tool')
  expect(toolMessages.map((message) => message.toolCallId)).toEqual(['call-slow', 'call-fast'])
  expect(toolMessages.map((message) => JSON.parse(message.content) as unknown)).toEqual([
    { id: 'slow' },
    { id: 'fast' },
  ])
})

it('limits parallel tool execution with maxParallelToolCalls', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [
      { id: 'call-1', name: 'timed_tool', arguments: { id: 'one', delayMs: 30 } },
      { id: 'call-2', name: 'timed_tool', arguments: { id: 'two', delayMs: 30 } },
      { id: 'call-3', name: 'timed_tool', arguments: { id: 'three', delayMs: 5 } },
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  let activeTools = 0
  let maxActiveTools = 0

  const harness = defineHarness()
    .defaults({ maxParallelToolCalls: 2 })
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      timed_tool: {
        kind: 'ts',
        description: 'Records bounded overlapping tool execution.',
        input: z.object({ id: z.string(), delayMs: z.number().int().nonnegative() }),
        output: z.object({ id: z.string() }),
        handler: async (_ctx, input) => {
          activeTools += 1
          maxActiveTools = Math.max(maxActiveTools, activeTools)
          await new Promise((resolve) => setTimeout(resolve, input.delayMs))
          activeTools -= 1
          return { id: input.id }
        },
      },
    })
    .skills({})
    .agent('a1', {
      model: 'fast',
      input: z.string(),
      output: z.string(),
      instructions: 'Use all tool calls, then return done.',
      tools: ['timed_tool'],
      builtinTools: false,
    })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  const s = await harness.getSession('limited-parallel-tools')
  await expect(s.workflows.wf.run('hello')).resolves.toBe('done')

  expect(maxActiveTools).toBe(2)
  const secondModelRequest = model.requests[1] as ObjectRequest
  const toolMessages = secondModelRequest.messages.filter((message) => message.role === 'tool')
  expect(toolMessages.map((message) => message.toolCallId)).toEqual(['call-1', 'call-2', 'call-3'])
})

it('uses persistent stdio MCP transport through the agent sandbox telemetry wrapper', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [
      { id: 'call-1', name: 'counter_tool', arguments: {} },
      { id: 'call-2', name: 'counter_tool', arguments: {} },
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const sandbox = hostSpawnExecSandbox()
  const sandboxCatalog = inMemorySandbox()
  const harness = defineHarness()
    .defaults({ maxParallelToolCalls: 1 })
    .sandbox({
      ...sandbox,
      administration: sandboxCatalog.administration,
      registerOwner: async (options) => await sandboxCatalog.registerOwner(options),
      open: async () => ({ session: sandbox, disposition: 'created', liveProcessState: 'not_preserved' }),
      terminate: async () => undefined,
    })
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      counter_tool: {
        kind: 'mcp_stdio',
        description: 'Stateful counter over stdio MCP.',
        command: '/usr/bin/env',
        args: ['node', fakeMcpServerPath],
        tool: 'counter',
      },
    })
    .skills({})
    .agent('a1', {
      model: 'fast',
      input: z.string(),
      output: z.string(),
      instructions: 'Call counter twice, then return done.',
      tools: ['counter_tool'],
      builtinTools: false,
    })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  try {
    const session = await harness.getSession('agent-persistent-mcp')
    await expect(session.workflows.wf.run('hello')).resolves.toBe('done')

    const secondModelRequest = model.requests[1] as ObjectRequest
    const toolMessages = secondModelRequest.messages.filter((message) => message.role === 'tool')
    expect(toolMessages.map((message) => JSON.parse(message.content) as unknown)).toEqual([{ value: 1 }, { value: 2 }])
    expect(sandbox.spawnCalls).toBe(1)
  } finally {
    await sandbox.close()
  }
})

it('preserves sandbox spawn capability through the agent sandbox telemetry wrapper', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'call-spawn', name: 'spawn_probe', arguments: {} }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const sandbox = hostSpawnExecSandbox()
  const sandboxCatalog = inMemorySandbox()
  const harness = defineHarness()
    .sandbox({
      ...sandbox,
      administration: sandboxCatalog.administration,
      registerOwner: async (options) => await sandboxCatalog.registerOwner(options),
      open: async () => ({ session: sandbox, disposition: 'created', liveProcessState: 'not_preserved' }),
      terminate: async () => undefined,
    })
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      spawn_probe: {
        kind: 'ts',
        description: 'Reports whether the sandbox still exposes spawn.',
        input: z.object({}),
        output: z.object({ hasSpawn: z.boolean() }),
        handler: async (ctx) => ({
          hasSpawn: typeof (ctx.sandbox as Partial<SpawnCapableSandboxSession>).spawn === 'function',
        }),
      },
    })
    .skills({})
    .agent('a1', {
      model: 'fast',
      input: z.string(),
      output: z.string(),
      instructions: 'Call spawn_probe, then return done.',
      tools: ['spawn_probe'],
      builtinTools: false,
    })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  try {
    const session = await harness.getSession('spawn-wrapper')
    await expect(session.workflows.wf.run('hello')).resolves.toBe('done')

    const secondModelRequest = model.requests[1] as ObjectRequest
    const toolMessage = secondModelRequest.messages.find((message) => message.role === 'tool')
    expect(JSON.parse(toolMessage?.content ?? '{}')).toEqual({ hasSpawn: true })
  } finally {
    await sandbox.close()
  }
})

it('rejects invalid maxParallelToolCalls defaults', () => {
  expect(() => defineHarness().defaults({ maxParallelToolCalls: 0 })).toThrow(HarnessConfigError)
  expect(() => defineHarness().defaults({ maxParallelToolCalls: 1.5 })).toThrow(HarnessConfigError)
})

it('rejects invalid and legacy JavaScript permission configuration at build time', () => {
  const model = new FakeModelProvider()
  const build = (permissions: unknown) =>
    defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .agent('a1', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'x',
        permissions,
      } as never)
      .build()

  expect(() => build({ write: 'ask' })).toThrow(HarnessConfigError)
  expect(() => build({ write: 'unexpected' })).toThrow(HarnessConfigError)
  expect(() => build({ read: 'deny' })).toThrow(HarnessConfigError)
  expect(() => build({ write: { mode: 'allow', legacy: true } })).toThrow(HarnessConfigError)
  expect(() => build({ write: { mode: 'deny', allow: ['ok', 1] } })).toThrow(HarnessConfigError)
})

it('reports static permission denials with safe occurrence evidence', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'call-write', name: 'write', arguments: { path: '/workspace/blocked.txt', content: 'blocked' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .agent('a1', {
      model: 'fast',
      input: z.string(),
      output: z.string(),
      instructions: 'Try the write tool, then recover.',
      builtinTools: ['write'],
      permissions: { write: 'deny' },
    })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  const s = await harness.getSession('permission-denied')
  await expect(s.workflows.wf.run('hello')).resolves.toBe('done')

  const secondModelRequest = model.requests[1] as ObjectRequest
  const toolMessage = secondModelRequest.messages.find((message) => message.role === 'tool')
  expect(toolMessage?.toolCallId).toBe('call-write')
  expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({
    code: 'PERMISSION_DENIED',
    meta: { evidence: { phase: 'permission', source: { kind: 'permission', id: 'write' } } },
  })
})

it('enforces permission deny patterns before mutating built-in tools run', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'call-write', name: 'write', arguments: { path: '/workspace/blocked.txt', content: 'blocked' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls',
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .agent('a1', {
      model: 'fast',
      input: z.string(),
      output: z.string(),
      instructions: 'Try the write tool, then recover.',
      builtinTools: ['write'],
      permissions: { write: { mode: 'allow', deny: ['/workspace/blocked*'] } },
    })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  const s = await harness.getSession('permission-deny-pattern')
  await expect(s.workflows.wf.run('hello')).resolves.toBe('done')

  const secondModelRequest = model.requests[1] as ObjectRequest
  const toolMessage = secondModelRequest.messages.find((message) => message.role === 'tool')
  expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({
    code: 'PERMISSION_DENIED',
    meta: { evidence: { phase: 'permission', source: { kind: 'permission', id: 'write' } } },
  })
})

it('inspects effective adapter capabilities and validates requirements at build time', () => {
  const model = new FakeModelProvider()
  const workspace = inMemoryDurableWorkspace()
  const harness = defineHarness({ name: 'capability-test' })
    .sandbox(inMemorySandbox())
    .workspace(workspace)
    .requires(['sandbox.fs', 'storage.checkpoint', 'workspace.durable', 'workspace.resume'])
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .agent('a1', { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false })
    .build()

  const inspection = harness.inspect()
  expect(inspection.name).toBe('capability-test')
  expect(inspection.capabilities).toEqual([
    'storage.checkpoint',
    'storage.retry',
    'storage.resume',
    'storage.workspace_checkpoint',
    'storage.external_wait',
    'sandbox.fs',
    'sandbox.text_search',
    'memory.kv',
    'memory.list',
    'memory.delete',
    'memory.ttl',
    'workspace.durable',
    'workspace.checkpoint',
    'workspace.resume',
    'workspace.abort',
    'workspace.cleanup',
    'workspace.inspect',
    'workspace.retention',
    'workspace.quota',
  ])
  expect(inspection.requiredCapabilities).toEqual([
    'sandbox.fs',
    'storage.checkpoint',
    'workspace.durable',
    'workspace.resume',
  ])
  expect(inspection.adapters.some((adapter) => adapter.kind === 'memory' && adapter.id === 'in_memory_memory')).toBe(
    true,
  )
  expect(inspection.adapters.some((adapter) => adapter.kind === 'storage' && adapter.id === 'in_memory')).toBe(true)
  expect(
    inspection.adapters.some((adapter) => adapter.kind === 'workspace' && adapter.id === 'in_memory_workspace'),
  ).toBe(true)
  expect(inspection.adapters.some((adapter) => adapter.kind === 'model' && adapter.id === 'fast')).toBe(true)

  expect(() =>
    defineHarness()
      .sandbox(inMemorySandbox())
      .requires(['sandbox.resume'])
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .agent('a1', { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false })
      .build(),
  ).toThrow(HarnessConfigError)

  expect(() =>
    defineHarness()
      .sandbox(inMemorySandbox())
      .requires(['memory.persistent'])
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .agent('a1', { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false })
      .build(),
  ).toThrow(HarnessConfigError)

  expect(() => defineHarness().memory(inMemoryMemoryEngine()).memory(inMemoryMemoryEngine())).toThrow(
    HarnessConfigError,
  )

  expect(() => defineHarness().workspace(inMemoryDurableWorkspace()).workspace(inMemoryDurableWorkspace())).toThrow(
    HarnessConfigError,
  )
})

it('rejects malformed custom tool ids at the .tools() call', () => {
  const model = new FakeModelProvider()
  const base = () => defineHarness().models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
  expect(() =>
    base().tools({
      'Bad-Id': { description: 'x', input: z.object({}), output: z.object({}), handler: async () => ({}) },
    }),
  ).toThrow(HarnessConfigError)
  expect(() =>
    base().tools({
      '1leading': { description: 'x', input: z.object({}), output: z.object({}), handler: async () => ({}) },
    }),
  ).toThrow(HarnessConfigError)
})

it('rejects a custom tool id that collides with a built-in tool name', () => {
  const model = new FakeModelProvider()
  expect(() =>
    defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({
        read: { description: 'x', input: z.object({}), output: z.object({}), handler: async () => ({}) },
      })
      .build(),
  ).toThrow(SkillManifestError)
})

it('serializes two same-tick prompts on a fresh session (concurrency race)', async () => {
  const model = new FakeModelProvider()
  model.enqueue({ object: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  model.enqueue({ object: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .agent('a1', { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false })
    .workflow('wf', {
      input: z.string(),
      output: z.string(),
      delegation: {},
      handler: async (ctx) => ctx.agents.a1(ctx.input),
    })
    .build()

  // Fire both before any await resolves: the first must win, the second must be rejected.
  const session = await harness.getSession('race')
  const results = await Promise.allSettled([session.workflows.wf.run('a'), session.workflows.wf.run('b')])
  const rejected = results.filter((r) => r.status === 'rejected')
  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  expect(fulfilled).toHaveLength(1)
  expect(rejected).toHaveLength(1)
  expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SessionBusyError)
})

it('atomically replaces session history', async () => {
  const model = new FakeModelProvider()
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .agent('a1', { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false })
    .build()

  const session = await harness.getSession('hist')
  await session.replaceHistory([
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
  ])
  const messages = await session.history.list()
  expect(messages.map((m) => m.content)).toEqual(['one', 'two'])

  await session.replaceHistory([{ role: 'user', content: 'fresh' }])
  const replaced = await session.history.list()
  expect(replaced.map((m) => m.content)).toEqual(['fresh'])
})

interface HostSpawnExecSandbox extends SandboxSession, SpawnCapableSandboxSession {
  spawnCalls: number
}

function hostSpawnExecSandbox(): HostSpawnExecSandbox {
  const children = new Set<ChildProcessWithoutNullStreams>()
  const sandbox = {
    executor: 'available',
    spawnCalls: 0,
    async read() {
      throw new Error('not implemented')
    },
    async readText() {
      throw new Error('not implemented')
    },
    async write() {},
    async remove() {},
    async list() {
      return []
    },
    async stat() {
      throw new Error('not implemented')
    },
    async exists() {
      return false
    },
    async mount() {},
    async exec(command, opts) {
      return new Promise((resolve, reject) => {
        const started = Date.now()
        const child = exec(
          command,
          {
            cwd: opts?.cwd,
            env: { ...processEnv, ...(opts?.env ?? {}) },
            timeout: opts?.timeoutMs,
          },
          (error, stdout, stderr) => {
            if (error && !('code' in error)) {
              reject(error)
              return
            }
            resolve({
              stdout,
              stderr,
              exitCode:
                typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : 0,
              durationSeconds: (Date.now() - started) / 1000,
            })
          },
        )
        if (opts?.stdin) child.stdin?.end(opts.stdin)
        else child.stdin?.end()
        opts?.signal?.addEventListener(
          'abort',
          () => {
            child.kill()
            reject(opts.signal?.reason ?? new Error('aborted'))
          },
          { once: true },
        )
      })
    },
    async close() {
      for (const child of children) child.kill('SIGKILL')
      children.clear()
    },
  } as Omit<HostSpawnExecSandbox, 'spawn'>

  Object.defineProperty(sandbox, 'spawn', {
    enumerable: false,
    value: async (
      command: string,
      opts?: Parameters<SpawnCapableSandboxSession['spawn']>[1],
    ): Promise<SandboxProcess> => {
      sandbox.spawnCalls += 1
      const child = spawn(command, [...(opts?.args ?? [])], {
        cwd: opts?.cwd,
        env: { ...processEnv, ...(opts?.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.add(child)
      const exit = new Promise<{ exitCode: number; signal?: string }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ exitCode: code ?? 0, ...(signal ? { signal } : {}) }))
      })
      opts?.signal?.addEventListener('abort', () => child.kill(), { once: true })
      return {
        async writeStdin(chunk) {
          child.stdin.write(chunk)
        },
        stdout: decodeStream(child.stdout),
        stderr: decodeStream(child.stderr),
        exit,
        async kill(signal) {
          child.kill(signal ?? 'SIGTERM')
        },
      }
    },
  })

  return sandbox as HostSpawnExecSandbox
}

async function* decodeStream(stream: Readable): AsyncIterable<string> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    yield decoder.decode(chunk as Buffer, { stream: true })
  }
}
