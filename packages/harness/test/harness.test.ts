import { exec, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { env as processEnv } from 'node:process'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { expect, it } from 'vitest'
import { BaseModelProvider, InMemoryStateStore, defineHarness, inMemorySandbox, JsonLogger, OperationTimeoutError, sandboxMemory, type MemoryAdapter, type SandboxProcess, type SandboxSession, type SpawnCapableSandboxSession } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { inMemoryDurableWorkspaceStore } from '../src/index.js'
import { AgentLoopBudgetError, HarnessConfigError, ModelCapabilityError, SessionBusyError, SkillManifestError } from '../src/errors/index.js'
import type { ObjectRequest } from '../src/ports/model-provider.js'
import type { ObjectResponse } from '../src/ports/model-provider.js'
import type { HarnessAdapterContext } from '../src/ports/harness-context.js'

const fakeMcpServerPath = fileURLToPath(new URL('../src/testing/fixtures/mcp/fake-stdio-server.mjs', import.meta.url))

class SlowBaseProvider extends BaseModelProvider {
  public constructor() {
    super({ id: 'slow', genAiSystem: 'test' })
  }

  protected override async doObject<T extends import('../src/index.js').JsonValue = import('../src/index.js').JsonValue>(): Promise<ObjectResponse<T>> {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return {
      object: 'late' as T,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop'
    }
  }
}

class ContextAwareStateStore extends InMemoryStateStore {
  public configured = false

  public configureHarnessContext(context: HarnessAdapterContext): void {
    this.configured = context.harnessName === 'ctx-test'
  }
}

it('enforces maxSteps in default agent loop', async () => {
  const model = new FakeModelProvider()
  model.enqueue({ object: {}, toolCalls: [{ id: 'c1', name: 'read', arguments: { path: '/workspace/a.txt' } }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
  model.enqueue({ object: {}, toolCalls: [{ id: 'c2', name: 'read', arguments: { path: '/workspace/a.txt' } }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })

  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({})
    .skills({})
    .agents({ a1: { model: 'fast', instructions: 'x', maxSteps: 1 } })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string> } })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.prompt('hello')).rejects.toBeInstanceOf(AgentLoopBudgetError)
})

it('lets prepareStep switch model aliases and restrict active tools', async () => {
  const primary = new FakeModelProvider()
  const fallback = new FakeModelProvider()
  fallback.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({
      primary: { provider: primary, model: 'primary-model', capabilities: ['object', 'tool_use'] },
      fallback: { provider: fallback, model: 'fallback-model', capabilities: ['object'] }
    })
    .tools({
      lookup: {
        description: 'Lookup a value.',
        input: z.object({ id: z.string() }),
        output: z.object({ value: z.string() }),
        handler: async (_ctx, input) => ({ value: input.id })
      }
    })
    .skills({})
    .agents({
      a1: {
        model: 'primary',
        instructions: 'x',
        tools: ['lookup'],
        builtinTools: false,
        prepareStep: ({ step }) => step === 0 ? { model: 'fallback', activeTools: [] } : {}
      }
    })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string> } })
    .build()

  const s = await harness.getSession('s-prepare-step')
  await expect(s.workflows.wf.prompt('hello')).resolves.toBe('done')

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
    finishReason: 'tool_calls'
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
        }
      }
    })
    .skills({})
    .agents({
      a1: {
        model: 'fast',
        instructions: 'x',
        tools: ['lookup'],
        builtinTools: false,
        stopWhen: ({ step, toolCalls }) => step === 0 && toolCalls.length > 0
      }
    })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string> } })
    .build()

  const s = await harness.getSession('s-stop-when')
  await expect(s.workflows.wf.prompt('hello')).resolves.toBe('done')
  expect(toolCalls).toBe(0)
})

it('replays model providerItems on the next agent loop round without persisting them', async () => {
  const model = new FakeModelProvider()
  const providerItems = {
    providerId: 'fake',
    items: [{ type: 'reasoning', id: 'rs_1' }, { type: 'function_call', id: 'fc_1', call_id: 'c1' }]
  }
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'c1', name: 'read', arguments: { path: '/workspace/a.txt' } }],
    providerItems,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = await defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({})
    .skills({})
    .agents({ a1: { model: 'fast', instructions: 'x' } })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string> } })
    .build()

  const s = await harness.getSession('s1')
  await s.workflows.wf.prompt('hello')

  const secondRound = model.requests[1] as ObjectRequest
  const assistantTurn = secondRound.messages.find((m) => m.role === 'assistant')
  expect(assistantTurn).toMatchObject({ role: 'assistant', providerItems })
  const persisted = await s.history.list()
  for (const message of persisted) {
    expect('providerItems' in message).toBe(false)
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
    .agents({ a1: { model: 'fast', instructions: 'x', builtinTools: false } })
    .workflows({
      wf: {
        input: z.string(),
        output: z.string(),
        delegation: {},
        handler: async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return ctx.agents.a1(ctx.input) as Promise<string>
        }
      }
    })
    .build()

  const s = await harness.getSession('s1')
  await s.memory.write('foo', { a: 1 })
  expect(await s.memory.read('foo')).toEqual({ a: 1 })
  const p1 = s.workflows.wf.prompt('x')
  await expect(s.workflows.wf.prompt('y')).rejects.toBeInstanceOf(SessionBusyError)
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
    .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x' } })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.prompt('hello')).rejects.toBeInstanceOf(ModelCapabilityError)
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
    .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false } })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.prompt('hello')).rejects.toBeInstanceOf(OperationTimeoutError)
  expect(logs.join('')).toContain('Model provider call failed.')
})

it('passes harness context into state, sandbox, and tool adapters', async () => {
  const model = new FakeModelProvider()
  model.enqueue({ object: {}, toolCalls: [{ id: 'call-1', name: 'ctx_tool', arguments: { value: 'x' } }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  const state = new ContextAwareStateStore()
  let sandboxConfigured = false
  let memoryConfigured = false
  let toolConfigured = false
  let toolSawContext = false
  const baseMemory = sandboxMemory()
  const memory = {
    info: baseMemory.info,
    capabilities: baseMemory.capabilities,
    open: baseMemory.open.bind(baseMemory),
    ...(baseMemory.close ? { close: baseMemory.close.bind(baseMemory) } : {}),
    configureHarnessContext(context: HarnessAdapterContext) {
      memoryConfigured = context.harnessName === 'ctx-test' && Boolean(context.metrics) && context.contentCaptureMode === 'NO_CONTENT'
    }
  } satisfies MemoryAdapter
  const sandbox = {
    ...inMemorySandbox(),
    configureHarnessContext(context: HarnessAdapterContext) {
      sandboxConfigured = context.harnessName === 'ctx-test'
    }
  }

  const harness = defineHarness({ name: 'ctx-test' })
    .logger(new JsonLogger({ level: 'fatal', out: { write: () => undefined } }))
    .state(state)
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
        }
      }
    })
    .skills({})
    .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', tools: ['ctx_tool'], builtinTools: false } })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.prompt('hello')).resolves.toBe('done')
  expect(state.configured).toBe(true)
  expect(sandboxConfigured).toBe(true)
  expect(memoryConfigured).toBe(true)
  expect(toolConfigured).toBe(true)
  expect(toolSawContext).toBe(true)
})

it('executes tool calls from the same model response concurrently and preserves model result order', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [
      { id: 'call-slow', name: 'timed_tool', arguments: { id: 'slow', delayMs: 70 } },
      { id: 'call-fast', name: 'timed_tool', arguments: { id: 'fast', delayMs: 10 } }
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
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
        }
      }
    })
    .skills({})
    .agents({
      a1: {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Use both tool calls, then return done.',
        tools: ['timed_tool'],
        builtinTools: false
      }
    })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  const s = await harness.getSession('parallel-tools')
  await expect(s.workflows.wf.prompt('hello')).resolves.toBe('done')

  expect(maxActiveTools).toBe(2)
  expect(completionOrder).toEqual(['fast', 'slow'])

  const secondModelRequest = model.requests[1] as ObjectRequest
  const toolMessages = secondModelRequest.messages.filter((message) => message.role === 'tool')
  expect(toolMessages.map((message) => message.toolCallId)).toEqual(['call-slow', 'call-fast'])
  expect(toolMessages.map((message) => JSON.parse(message.content) as unknown)).toEqual([{ id: 'slow' }, { id: 'fast' }])
})

it('limits parallel tool execution with maxParallelToolCalls', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [
      { id: 'call-1', name: 'timed_tool', arguments: { id: 'one', delayMs: 30 } },
      { id: 'call-2', name: 'timed_tool', arguments: { id: 'two', delayMs: 30 } },
      { id: 'call-3', name: 'timed_tool', arguments: { id: 'three', delayMs: 5 } }
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
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
        }
      }
    })
    .skills({})
    .agents({
      a1: {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Use all tool calls, then return done.',
        tools: ['timed_tool'],
        builtinTools: false
      }
    })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  const s = await harness.getSession('limited-parallel-tools')
  await expect(s.workflows.wf.prompt('hello')).resolves.toBe('done')

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
      { id: 'call-2', name: 'counter_tool', arguments: {} }
    ],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const sandbox = hostSpawnExecSandbox()
  const harness = defineHarness()
    .defaults({ maxParallelToolCalls: 1 })
    .sandbox({
      ...sandbox,
      open: async () => sandbox
    })
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      counter_tool: {
        kind: 'mcp_stdio',
        description: 'Stateful counter over stdio MCP.',
        command: '/usr/bin/env',
        args: ['node', fakeMcpServerPath],
        tool: 'counter'
      }
    })
    .skills({})
    .agents({
      a1: {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Call counter twice, then return done.',
        tools: ['counter_tool'],
        builtinTools: false
      }
    })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  try {
    const session = await harness.getSession('agent-persistent-mcp')
    await expect(session.workflows.wf.prompt('hello')).resolves.toBe('done')

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
    finishReason: 'tool_calls'
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const sandbox = hostSpawnExecSandbox()
  const harness = defineHarness()
    .sandbox({
      ...sandbox,
      open: async () => sandbox
    })
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .tools({
      spawn_probe: {
        kind: 'ts',
        description: 'Reports whether the sandbox still exposes spawn.',
        input: z.object({}),
        output: z.object({ hasSpawn: z.boolean() }),
        handler: async (ctx) => ({
          hasSpawn: typeof (ctx.sandbox as Partial<SpawnCapableSandboxSession>).spawn === 'function'
        })
      }
    })
    .skills({})
    .agents({
      a1: {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Call spawn_probe, then return done.',
        tools: ['spawn_probe'],
        builtinTools: false
      }
    })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  try {
    const session = await harness.getSession('spawn-wrapper')
    await expect(session.workflows.wf.prompt('hello')).resolves.toBe('done')

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

it('reports static permission denials with mode_deny instead of hook_deny', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'call-write', name: 'write', arguments: { path: '/workspace/blocked.txt', content: 'blocked' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .agents({
      a1: {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Try the write tool, then recover.',
        builtinTools: ['write'],
        permissions: { write: 'deny' }
      }
    })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  const s = await harness.getSession('permission-denied')
  await expect(s.workflows.wf.prompt('hello')).resolves.toBe('done')

  const secondModelRequest = model.requests[1] as ObjectRequest
  const toolMessage = secondModelRequest.messages.find((message) => message.role === 'tool')
  expect(toolMessage?.toolCallId).toBe('call-write')
  expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({
    code: 'PERMISSION_DENIED',
    meta: { reason: 'mode_deny' }
  })
})

it('enforces permission deny patterns before mutating built-in tools run', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'call-write', name: 'write', arguments: { path: '/workspace/blocked.txt', content: 'blocked' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .agents({
      a1: {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Try the write tool, then recover.',
        builtinTools: ['write'],
        permissions: { write: { mode: 'allow', deny: ['/workspace/blocked*'] } }
      }
    })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  const s = await harness.getSession('permission-deny-pattern')
  await expect(s.workflows.wf.prompt('hello')).resolves.toBe('done')

  const secondModelRequest = model.requests[1] as ObjectRequest
  const toolMessage = secondModelRequest.messages.find((message) => message.role === 'tool')
  expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({
    code: 'PERMISSION_DENIED',
    meta: { reason: 'mode_deny' }
  })
})

it('bounds permission hooks with the tool timeout and lets the model recover', async () => {
  const model = new FakeModelProvider()
  model.enqueue({
    object: {},
    toolCalls: [{ id: 'call-write', name: 'write', arguments: { path: '/workspace/slow.txt', content: 'slow' } }],
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: 'tool_calls'
  })
  model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = defineHarness()
    .defaults({ toolTimeoutMs: 5 })
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
    .agents({
      a1: {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        instructions: 'Try the write tool, then recover.',
        builtinTools: ['write'],
        permissions: { write: 'ask' },
        onPermission: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return 'allow'
        }
      }
    })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  const s = await harness.getSession('permission-timeout')
  await expect(s.workflows.wf.prompt('hello')).resolves.toBe('done')

  const secondModelRequest = model.requests[1] as ObjectRequest
  const toolMessage = secondModelRequest.messages.find((message) => message.role === 'tool')
  expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({
    code: 'OPERATION_TIMEOUT',
    meta: { scope: 'tool', timeout_ms: 5 }
  })
})

it('inspects effective adapter capabilities and validates requirements at build time', () => {
  const model = new FakeModelProvider()
  const workspace = inMemoryDurableWorkspaceStore()
  const harness = defineHarness({ name: 'capability-test' })
    .sandbox(inMemorySandbox())
    .runtime({ id: 'fake-runtime', capabilities: ['runtime.checkpoint'] })
    .workspaceStore(workspace)
    .requires(['sandbox.fs', 'runtime.checkpoint', 'workspace_store.durable', 'workspace_store.resume'])
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false } })
    .build()

  const inspection = harness.inspect()
  expect(inspection.name).toBe('capability-test')
  expect(inspection.capabilities).toEqual([
    'sandbox.fs',
    'memory.kv',
    'memory.list',
    'memory.delete',
    'memory.run',
    'memory.session',
    'runtime.checkpoint',
    'workspace_store.durable',
    'workspace_store.checkpoint',
    'workspace_store.resume',
    'workspace_store.abort',
    'workspace_store.cleanup',
    'workspace_store.inspect',
    'workspace_store.retention',
    'workspace_store.quota'
  ])
  expect(inspection.requiredCapabilities).toEqual(['sandbox.fs', 'runtime.checkpoint', 'workspace_store.durable', 'workspace_store.resume'])
  expect(inspection.adapters.some((adapter) => adapter.kind === 'memory' && adapter.id === 'sandbox_memory')).toBe(true)
  expect(inspection.adapters.some((adapter) => adapter.kind === 'runtime' && adapter.id === 'fake-runtime')).toBe(true)
  expect(inspection.adapters.some((adapter) => adapter.kind === 'workspace_store' && adapter.id === 'in_memory_workspace_store')).toBe(true)
  expect(inspection.adapters.some((adapter) => adapter.kind === 'model' && adapter.id === 'fast')).toBe(true)

  expect(() => defineHarness()
    .sandbox(inMemorySandbox())
    .requires(['sandbox.resume'])
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false } })
    .build()).toThrow(HarnessConfigError)

  expect(() => defineHarness()
    .sandbox(inMemorySandbox())
    .requires(['memory.persistent'])
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false } })
    .build()).toThrow(HarnessConfigError)

  expect(() => defineHarness()
    .memory(sandboxMemory())
    .memory(sandboxMemory())).toThrow(HarnessConfigError)

  expect(() => defineHarness()
    .workspaceStore(inMemoryDurableWorkspaceStore())
    .workspaceStore(inMemoryDurableWorkspaceStore())).toThrow(HarnessConfigError)
})

it('rejects malformed custom tool ids at the .tools() call', () => {
  const model = new FakeModelProvider()
  const base = () => defineHarness().models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
  expect(() => base().tools({ 'Bad-Id': { description: 'x', input: z.object({}), output: z.object({}), handler: async () => ({}) } as any })).toThrow(HarnessConfigError)
  expect(() => base().tools({ '1leading': { description: 'x', input: z.object({}), output: z.object({}), handler: async () => ({}) } as any })).toThrow(HarnessConfigError)
})

it('rejects a custom tool id that collides with a built-in tool name', () => {
  const model = new FakeModelProvider()
  expect(() => defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .tools({ read: { description: 'x', input: z.object({}), output: z.object({}), handler: async () => ({}) } as any })
    .build()).toThrow(SkillManifestError)
})

it('serializes two same-tick prompts on a fresh session (concurrency race)', async () => {
  const model = new FakeModelProvider()
  model.enqueue({ object: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
  model.enqueue({ object: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })

  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false } })
    .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  // Fire both before any await resolves: the first must win, the second must be rejected.
  const session = await harness.getSession('race')
  const results = await Promise.allSettled([session.workflows.wf.prompt('a'), session.workflows.wf.prompt('b')])
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
    .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false } })
    .build()

  const session = await harness.getSession('hist')
  await session.replaceHistory([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }])
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
    async read() { throw new Error('not implemented') },
    async readText() { throw new Error('not implemented') },
    async write() {},
    async remove() {},
    async list() { return [] },
    async stat() { throw new Error('not implemented') },
    async exists() { return false },
    async mount() {},
    async exec(command, opts) {
      return new Promise((resolve, reject) => {
        const started = Date.now()
        const child = exec(command, {
          cwd: opts?.cwd,
          env: { ...processEnv, ...(opts?.env ?? {}) },
          timeout: opts?.timeoutMs
        }, (error, stdout, stderr) => {
          if (error && !('code' in error)) {
            reject(error)
            return
          }
          resolve({
            stdout,
            stderr,
            exitCode: typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : 0,
            durationSeconds: (Date.now() - started) / 1000
          })
        })
        if (opts?.stdin) child.stdin?.end(opts.stdin)
        else child.stdin?.end()
        opts?.signal?.addEventListener('abort', () => {
          child.kill()
          reject(opts.signal?.reason ?? new Error('aborted'))
        }, { once: true })
      })
    },
    async close() {
      for (const child of children) child.kill('SIGKILL')
      children.clear()
    }
  } as Omit<HostSpawnExecSandbox, 'spawn'>

  Object.defineProperty(sandbox, 'spawn', {
    enumerable: false,
    value: async (command: string, opts?: Parameters<SpawnCapableSandboxSession['spawn']>[1]): Promise<SandboxProcess> => {
      sandbox.spawnCalls += 1
      const child = spawn(command, [...(opts?.args ?? [])], {
        cwd: opts?.cwd,
        env: { ...processEnv, ...(opts?.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      children.add(child)
      const exit = new Promise<{ exitCode: number; signal?: string }>((resolve) => {
        child.on('exit', (code, signal) => resolve({ exitCode: code ?? 0, ...(signal ? { signal } : {}) }))
      })
      opts?.signal?.addEventListener('abort', () => child.kill(), { once: true })
      return {
        async writeStdin(chunk) { child.stdin.write(chunk) },
        stdout: decodeStream(child.stdout),
        stderr: decodeStream(child.stderr),
        exit,
        async kill(signal) { child.kill(signal ?? 'SIGTERM') }
      }
    }
  })

  return sandbox as HostSpawnExecSandbox
}

async function* decodeStream(stream: Readable): AsyncIterable<string> {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    yield decoder.decode(chunk as Buffer, { stream: true })
  }
}
