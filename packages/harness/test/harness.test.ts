import { z } from 'zod'
import { expect, it } from 'vitest'
import { BaseModelProvider, InMemoryStateStore, defineHarness, inMemorySandbox, JsonLogger, OperationTimeoutError, sandboxMemory, type MemoryAdapter } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { inMemoryDurableWorkspaceStore } from '../src/index.js'
import { AgentLoopBudgetError, HarnessConfigError, ModelCapabilityError, SessionBusyError } from '../src/errors/index.js'
import type { ObjectResponse } from '../src/ports/model-provider.js'
import type { HarnessAdapterContext } from '../src/ports/harness-context.js'

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
    .workflows({ wf: { input: z.string(), output: z.string(), handler: async (ctx) => ctx.agents.a1(ctx.input) as Promise<string> } })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.prompt('hello')).rejects.toBeInstanceOf(AgentLoopBudgetError)
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
    .workflows({ wf: { input: z.string(), output: z.string(), handler: async (ctx) => ctx.agents.a1(ctx.input) } })
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
    .workflows({ wf: { input: z.string(), output: z.string(), handler: async (ctx) => ctx.agents.a1(ctx.input) } })
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
    .workflows({ wf: { input: z.string(), output: z.string(), handler: async (ctx) => ctx.agents.a1(ctx.input) } })
    .build()

  const s = await harness.getSession('s1')
  await expect(s.workflows.wf.prompt('hello')).resolves.toBe('done')
  expect(state.configured).toBe(true)
  expect(sandboxConfigured).toBe(true)
  expect(memoryConfigured).toBe(true)
  expect(toolConfigured).toBe(true)
  expect(toolSawContext).toBe(true)
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
