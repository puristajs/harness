import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  DelegationPolicyError,
  HarnessConfigError,
  InMemoryHarnessStorage,
  OperationCancelledError,
  OperationTimeoutError,
  ValidationError,
  defineHarness,
  inMemorySandbox,
} from '../src/index.js'
import type { Logger, RunEvent } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

/** Model provider whose calls hang until the request signal aborts. */
function hangingProvider(onStarted?: () => void) {
  return {
    id: 'hanging',
    genAiSystem: 'hanging',
    async object(req: { signal: AbortSignal }) {
      onStarted?.()
      return new Promise((_resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
        if (req.signal.aborted) reject(req.signal.reason)
      })
    },
  }
}

describe('workflow delegation policy', () => {
  it('passes transformed workflow input through a delegated transformed custom agent', async () => {
    const model = new FakeModelProvider()
    const parseWorkflowInput = vi.fn((value: string) => Number(value))
    const parseAgentInput = vi.fn((value: string) => Number(value))
    const parseAgentOutput = vi.fn((value: string) => Number(value))
    const parseWorkflowOutput = vi.fn((value: string) => Number(value))
    const workflowInputs: unknown[] = []
    const agentInputs: unknown[] = []

    const harness = defineHarness()
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        instructions: '',
        input: z.string().transform(parseAgentInput),
        output: z.string().transform(parseAgentOutput),
        handler: async (ctx) => {
          agentInputs.push(ctx.input)
          return '5'
        },
      })
      .workflow('delegated', {
        input: z.string().default('3').transform(parseWorkflowInput),
        output: z.string().transform(parseWorkflowOutput),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => {
          workflowInputs.push(ctx.input)
          await ctx.agents.worker('5')
          return '6'
        },
      })
      .build()

    await expect(
      (await harness.getSession('delegated-transforms')).workflows.delegated.run(undefined),
    ).resolves.toBe(6)
    expect(workflowInputs).toEqual([3])
    expect(agentInputs).toEqual([5])
    expect(parseWorkflowInput).toHaveBeenCalledTimes(1)
    expect(parseAgentInput).toHaveBeenCalledTimes(1)
    expect(parseAgentOutput).toHaveBeenCalledTimes(1)
    expect(parseWorkflowOutput).toHaveBeenCalledTimes(1)
    expect(model.requests).toEqual([])
  })

  it('denies child-agent calls by default', async () => {
    const model = new FakeModelProvider()

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('guarded', {
        input: z.string(),
        output: z.string(),
        handler: async (ctx) => ctx.agents.worker(ctx.input),
      })
      .build()

    const session = await harness.getSession('s-default-deny')
    await expect(session.workflows.guarded.run('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'delegation_disabled',
        workflow_id: 'guarded',
        agent_id: 'worker',
      }),
    })
    expect(model.requests).toHaveLength(0)
  })

  it('enforces the opt-in total child-agent call budget', async () => {
    const model = new FakeModelProvider()
    for (let index = 0; index < 32; index += 1) {
      model.enqueue({ object: `ok-${index}`, usage, finishReason: 'stop' })
    }

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('fanout', {
        input: z.string(),
        output: z.array(z.string()),
        delegation: {},
        handler: async (ctx) => {
          const out: string[] = []
          for (let index = 0; index < 33; index += 1) {
            out.push(await ctx.agents.worker(`${ctx.input}-${index}`))
          }
          return out
        },
      })
      .build()

    const session = await harness.getSession('s-default-budget')
    await expect(session.workflows.fanout.run('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'max_child_agent_calls_exceeded',
        workflow_id: 'fanout',
        agent_id: 'worker',
        limit: 32,
      }),
    })
    expect(model.requests).toHaveLength(32)
  })

  it('allows workflows to override child-agent call budgets', async () => {
    const model = new FakeModelProvider()
    model.enqueue({ object: 'one', usage, finishReason: 'stop' })
    model.enqueue({ object: 'two', usage, finishReason: 'stop' })

    const harness = defineHarness()
      .defaults({ delegation: { maxChildAgentCalls: 1 } })
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('fanout', {
        input: z.string(),
        output: z.array(z.string()),
        delegation: { maxChildAgentCalls: 2 },
        handler: async (ctx) => [await ctx.agents.worker(`${ctx.input}-1`), await ctx.agents.worker(`${ctx.input}-2`)],
      })
      .build()

    const session = await harness.getSession('s-override-budget')
    await expect(session.workflows.fanout.run('work')).resolves.toEqual(['one', 'two'])
  })

  it('denies child agents outside the workflow allowlist', async () => {
    const model = new FakeModelProvider()

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('allowed', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Allowed.',
      })
      .agent('blocked', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Blocked.',
      })
      .workflow('guarded', {
        input: z.string(),
        output: z.string(),
        delegation: { agents: ['allowed'] },
        handler: async (ctx) => ctx.agents.blocked(ctx.input),
      })
      .build()

    const session = await harness.getSession('s-agent-allowlist')
    await expect(session.workflows.guarded.run('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'agent_not_allowed',
        workflow_id: 'guarded',
        agent_id: 'blocked',
      }),
    })
    expect(model.requests).toHaveLength(0)
  })

  it('enforces max parallel child-agent calls', async () => {
    const model = new FakeModelProvider()
    model.enqueue({ object: 'one', usage, finishReason: 'stop' })

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('guarded', {
        input: z.string(),
        output: z.array(z.string()),
        delegation: { maxParallelChildAgentCalls: 1 },
        handler: async (ctx) => Promise.all([ctx.agents.worker(`${ctx.input}-1`), ctx.agents.worker(`${ctx.input}-2`)]),
      })
      .build()

    const session = await harness.getSession('s-parallel-budget')
    await expect(session.workflows.guarded.run('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'max_parallel_child_agent_calls_exceeded',
        workflow_id: 'guarded',
        agent_id: 'worker',
        limit: 1,
      }),
    })
  })

  it('uses an allowed per-call model alias override for a child agent', async () => {
    const fast = new FakeModelProvider()
    const deep = new FakeModelProvider()
    deep.enqueue({ object: 'deep answer', usage, finishReason: 'stop' })

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({
        fast: { provider: fast, model: 'fake-fast', capabilities: ['object'] },
        deep: { provider: deep, model: 'fake-deep', capabilities: ['object'] },
      })
      .tools({})
      .skills({})
      .agent('writer', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Write.',
      })
      .workflow('reviewed', {
        input: z.string(),
        output: z.string(),
        delegation: {
          agentModelAliases: { writer: ['deep'] },
        },
        handler: async (ctx) => ctx.agents.writer(ctx.input, { model: 'deep' }),
      })
      .build()

    const session = await harness.getSession('s-model-override')
    await expect(session.workflows.reviewed.run('work')).resolves.toBe('deep answer')
    expect(fast.requests).toHaveLength(0)
    expect(deep.requests).toHaveLength(1)
  })

  it('denies model alias overrides outside delegation policy', async () => {
    const fast = new FakeModelProvider()
    const deep = new FakeModelProvider()

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({
        fast: { provider: fast, model: 'fake-fast', capabilities: ['object'] },
        deep: { provider: deep, model: 'fake-deep', capabilities: ['object'] },
      })
      .tools({})
      .skills({})
      .agent('writer', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Write.',
      })
      .workflow('reviewed', {
        input: z.string(),
        output: z.string(),
        delegation: {
          agentModelAliases: { writer: ['deep'] },
        },
        handler: async (ctx) => ctx.agents.writer(ctx.input, { model: 'fast' }),
      })
      .build()

    const session = await harness.getSession('s-model-denied')
    await expect(session.workflows.reviewed.run('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'model_alias_not_allowed',
        workflow_id: 'reviewed',
        agent_id: 'writer',
        model_alias: 'fast',
      }),
    })
    expect(fast.requests).toHaveLength(0)
    expect(deep.requests).toHaveLength(0)
  })

  it('emits and persists child-agent lineage without content payloads', async () => {
    const model = new FakeModelProvider()
    const state = new InMemoryHarnessStorage()
    model.enqueue({ object: 'done', usage, finishReason: 'stop' })

    const harness = defineHarness()
      .storage(state)
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('traced', {
        input: z.string(),
        output: z.string(),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => ctx.agents.worker(ctx.input),
      })
      .build()

    const session = await harness.getSession('s-lineage')
    const events = []
    for await (const event of session.workflows.traced.stream('secret-input')) {
      events.push(event)
    }

    const runId = events.find((event) => event.type === 'run.started')?.runId
    const started = events.find((event) => event.type === 'agent.started')
    const finished = events.find((event) => event.type === 'agent.finished')

    expect(started).toMatchObject({
      type: 'agent.started',
      workflowId: 'traced',
      agentId: 'worker',
      delegationDepth: 1,
      modelAlias: 'fast',
    })
    expect(finished).toMatchObject({
      type: 'agent.finished',
      workflowId: 'traced',
      agentId: 'worker',
      delegationDepth: 1,
      modelAlias: 'fast',
    })
    expect(typeof started?.delegationCallId).toBe('string')
    expect(finished?.delegationCallId).toBe(started?.delegationCallId)

    const persisted = await state.listEvents(runId as string)
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent.started',
          payload: expect.objectContaining({
            workflowId: 'traced',
            agentId: 'worker',
            delegationDepth: 1,
            modelAlias: 'fast',
            delegationCallId: started?.delegationCallId,
          }),
        }),
        expect.objectContaining({
          type: 'agent.finished',
          payload: expect.not.objectContaining({ output: 'done' }),
        }),
      ]),
    )
  })

  it('enables delegation via defaults for workflows without a policy', async () => {
    const model = new FakeModelProvider()
    model.enqueue({ object: 'ok', usage, finishReason: 'stop' })

    const harness = defineHarness()
      .defaults({ delegation: { enabled: true } })
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('open', {
        input: z.string(),
        output: z.string(),
        handler: async (ctx) => ctx.agents.worker(ctx.input),
      })
      .build()

    const session = await harness.getSession('s-defaults-enabled')
    await expect(session.workflows.open.run('work')).resolves.toBe('ok')
    expect(model.requests).toHaveLength(1)
  })

  it('lets a workflow disable delegation despite harness-wide enablement', async () => {
    const model = new FakeModelProvider()

    const harness = defineHarness()
      .defaults({ delegation: { enabled: true } })
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('sealed', {
        input: z.string(),
        output: z.string(),
        delegation: { enabled: false },
        handler: async (ctx) => ctx.agents.worker(ctx.input),
      })
      .build()

    const session = await harness.getSession('s-workflow-disabled')
    await expect(session.workflows.sealed.run('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({ reason: 'delegation_disabled', workflow_id: 'sealed' }),
    })
    expect(model.requests).toHaveLength(0)
  })

  it('denies child-agent calls when maxDepth is 0', async () => {
    const model = new FakeModelProvider()

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('shallow', {
        input: z.string(),
        output: z.string(),
        delegation: { maxDepth: 0 },
        handler: async (ctx) => ctx.agents.worker(ctx.input),
      })
      .build()

    const session = await harness.getSession('s-max-depth-zero')
    await expect(session.workflows.shallow.run('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'max_delegation_depth_exceeded',
        workflow_id: 'shallow',
        agent_id: 'worker',
        limit: 0,
      }),
    })
    expect(model.requests).toHaveLength(0)
  })

  it('applies workflow-wide modelAliases to default-model child-agent calls', async () => {
    const fast = new FakeModelProvider()
    const deep = new FakeModelProvider()

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({
        fast: { provider: fast, model: 'fake-fast', capabilities: ['object'] },
        deep: { provider: deep, model: 'fake-deep', capabilities: ['object'] },
      })
      .tools({})
      .skills({})
      .agent('writer', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Write.',
      })
      .workflow('restricted', {
        input: z.string(),
        output: z.string(),
        delegation: { modelAliases: ['deep'] },
        // No per-call override: the agent's default alias `fast` is selected.
        handler: async (ctx) => ctx.agents.writer(ctx.input),
      })
      .build()

    const session = await harness.getSession('s-default-model-denied')
    await expect(session.workflows.restricted.run('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'model_alias_not_allowed',
        workflow_id: 'restricted',
        agent_id: 'writer',
        model_alias: 'fast',
      }),
    })
    expect(fast.requests).toHaveLength(0)
    expect(deep.requests).toHaveLength(0)
  })

  it('allows default-model child-agent calls when the default alias is listed', async () => {
    const fast = new FakeModelProvider()
    fast.enqueue({ object: 'fast answer', usage, finishReason: 'stop' })

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: fast, model: 'fake-fast', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('writer', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Write.',
      })
      .workflow('permitted', {
        input: z.string(),
        output: z.string(),
        delegation: { modelAliases: ['fast'] },
        handler: async (ctx) => ctx.agents.writer(ctx.input),
      })
      .build()

    const session = await harness.getSession('s-default-model-allowed')
    await expect(session.workflows.permitted.run('work')).resolves.toBe('fast answer')
    expect(fast.requests).toHaveLength(1)
  })

  it('rejects invalid delegation policies and defaults at build time', () => {
    const model = new FakeModelProvider()
    const base = () =>
      defineHarness()
        .sandbox(inMemorySandbox())
        .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
        .tools({})
        .skills({})
        .agent('worker', {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          builtinTools: false,
          instructions: 'Return the input.',
        })
    const workflowWith = (delegation: Record<string, unknown>) => () =>
      base().workflow('wf', {
        input: z.string(),
        output: z.string(),
        delegation: delegation as never,
        handler: async (ctx) => ctx.agents.worker(ctx.input),
      })

    expectConfigError(workflowWith({ agents: ['ghost'] }), {
      reason: 'invalid_workflow',
      path: 'workflows.wf.delegation.agents',
      id: 'ghost',
    })
    expectConfigError(workflowWith({ modelAliases: ['ghost_alias'] }), {
      reason: 'invalid_workflow',
      path: 'workflows.wf.delegation.modelAliases',
      id: 'ghost_alias',
    })
    expectConfigError(workflowWith({ agentModelAliases: { ghost: ['fast'] } }), {
      reason: 'invalid_workflow',
      path: 'workflows.wf.delegation.agentModelAliases.ghost',
      id: 'ghost',
    })
    expectConfigError(workflowWith({ agentModelAliases: { worker: ['ghost_alias'] } }), {
      reason: 'invalid_workflow',
      path: 'workflows.wf.delegation.agentModelAliases.worker',
      id: 'ghost_alias',
    })
    expectConfigError(workflowWith({ maxChildAgentCalls: -1 }), { path: 'workflows.wf.delegation.maxChildAgentCalls' })
    expectConfigError(workflowWith({ maxChildAgentCalls: 1.5 }), { path: 'workflows.wf.delegation.maxChildAgentCalls' })
    expectConfigError(workflowWith({ maxParallelChildAgentCalls: 0 }), {
      path: 'workflows.wf.delegation.maxParallelChildAgentCalls',
    })
    expectConfigError(workflowWith({ maxDepth: -1 }), { path: 'workflows.wf.delegation.maxDepth' })

    expectConfigError(() => defineHarness().defaults({ delegation: { maxParallelChildAgentCalls: 0 } }), {
      path: 'defaults.delegation.maxParallelChildAgentCalls',
    })
    expectConfigError(() => defineHarness().defaults({ delegation: { maxDepth: -1 } }), {
      path: 'defaults.delegation.maxDepth',
    })
    expectConfigError(() => defineHarness().defaults({ delegation: { maxChildAgentCalls: -1 } }), {
      path: 'defaults.delegation.maxChildAgentCalls',
    })
  })

  it('aborts in-flight child agents when the handler rejects mid-parallel', async () => {
    let firstStarted!: () => void
    const firstCallStarted = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    let abortedReason: unknown
    const slow = hangingProvider(() => firstStarted())
    const slowWithCapture = {
      ...slow,
      async object(req: { signal: AbortSignal }) {
        return (slow.object(req) as Promise<unknown>).catch((reason: unknown) => {
          abortedReason = reason
          throw reason
        })
      },
    }

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ slow: { provider: slowWithCapture, model: 'fake-slow', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'slow',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('guarded', {
        input: z.string(),
        output: z.array(z.string()),
        delegation: { maxParallelChildAgentCalls: 1 },
        handler: async (ctx) => {
          const first = ctx.agents.worker(`${ctx.input}-1`)
          await firstCallStarted
          const second = ctx.agents.worker(`${ctx.input}-2`)
          return Promise.all([first, second])
        },
      })
      .workflow('plain', {
        input: z.string(),
        output: z.string(),
        handler: async (ctx) => ctx.input,
      })
      .build()

    const session = await harness.getSession('s-mid-parallel')
    const events: RunEvent[] = []
    let failure: unknown
    try {
      for await (const event of session.workflows.guarded.stream('work')) {
        events.push(event)
      }
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'max_parallel_child_agent_calls_exceeded',
        workflow_id: 'guarded',
        limit: 1,
      }),
    })
    // The orphan-prevention contract: the in-flight sibling is aborted and
    // settled before the run terminalizes, so run.finished is the last event.
    expect(abortedReason).toBeDefined()
    expect(events.at(-1)?.type).toBe('run.finished')
    // The session busy lock was released only after settlement.
    await expect(session.workflows.plain.run('after')).resolves.toBe('after')
  })

  it('frees parallel slots for sequential child-agent calls', async () => {
    const model = new FakeModelProvider()
    model.enqueue({ object: 'one', usage, finishReason: 'stop' })
    model.enqueue({ object: 'two', usage, finishReason: 'stop' })

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('serial', {
        input: z.string(),
        output: z.array(z.string()),
        delegation: { maxParallelChildAgentCalls: 1 },
        handler: async (ctx) => [await ctx.agents.worker(`${ctx.input}-1`), await ctx.agents.worker(`${ctx.input}-2`)],
      })
      .build()

    const session = await harness.getSession('s-slot-reuse')
    await expect(session.workflows.serial.run('work')).resolves.toEqual(['one', 'two'])
  })

  it('rejects unknown per-call model aliases without consuming call budget', async () => {
    const model = new FakeModelProvider()
    model.enqueue({ object: 'ok', usage, finishReason: 'stop' })
    let aliasFailure: unknown

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('budgeted', {
        input: z.string(),
        output: z.string(),
        delegation: { maxChildAgentCalls: 1 },
        handler: async (ctx) => {
          try {
            await ctx.agents.worker(ctx.input, { model: 'ghost_alias' as never })
          } catch (error) {
            aliasFailure = error
          }
          // The failed alias call must not have consumed the single-call budget.
          return ctx.agents.worker(ctx.input)
        },
      })
      .build()

    const session = await harness.getSession('s-unknown-alias')
    await expect(session.workflows.budgeted.run('work')).resolves.toBe('ok')
    expect(aliasFailure).toBeInstanceOf(ValidationError)
    expect(aliasFailure).toMatchObject({
      code: 'VALIDATION_ERROR',
      meta: expect.objectContaining({ where: 'invoke_options', issues: { model: 'ghost_alias' } }),
    })
    expect(model.requests).toHaveLength(1)
  })

  it('rejects durable child-agent invoke options', async () => {
    const model = new FakeModelProvider()
    let durableFailure: unknown

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('wf', {
        input: z.string(),
        output: z.string(),
        delegation: {},
        handler: async (ctx) => {
          try {
            await ctx.agents.worker(ctx.input, { durable: { runId: 'durable_run' } } as never)
          } catch (error) {
            durableFailure = error
          }
          return 'done'
        },
      })
      .build()

    const session = await harness.getSession('s-durable-denied')
    await expect(session.workflows.wf.run('work')).resolves.toBe('done')
    expect(durableFailure).toBeInstanceOf(ValidationError)
    expect(durableFailure).toMatchObject({
      meta: expect.objectContaining({ where: 'invoke_options', issues: { durable: 'agent_run' } }),
    })
    expect(model.requests).toHaveLength(0)
  })

  it('validates child-agent invoke options', async () => {
    const model = new FakeModelProvider()
    let optionFailure: unknown

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('wf', {
        input: z.string(),
        output: z.string(),
        delegation: {},
        handler: async (ctx) => {
          try {
            await ctx.agents.worker(ctx.input, { historyWindow: -1 })
          } catch (error) {
            optionFailure = error
          }
          return 'done'
        },
      })
      .build()

    const session = await harness.getSession('s-invalid-options')
    await expect(session.workflows.wf.run('work')).resolves.toBe('done')
    expect(optionFailure).toBeInstanceOf(ValidationError)
    expect(optionFailure).toMatchObject({
      meta: expect.objectContaining({ where: 'invoke_options', issues: { historyWindow: -1 } }),
    })
    expect(model.requests).toHaveLength(0)
  })

  it('honors per-call timeoutMs for child-agent calls', async () => {
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ slow: { provider: hangingProvider(), model: 'fake-slow', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'slow',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('wf', {
        input: z.string(),
        output: z.string(),
        delegation: {},
        handler: async (ctx) => {
          try {
            await ctx.agents.worker(ctx.input, { timeoutMs: 25 })
            return 'no-timeout'
          } catch (error) {
            return error instanceof OperationTimeoutError
              ? 'timed-out'
              : `unexpected:${String((error as { code?: string }).code)}`
          }
        },
      })
      .build()

    const session = await harness.getSession('s-child-timeout')
    await expect(session.workflows.wf.run('work')).resolves.toBe('timed-out')
  })

  it('throws cancellation before policy checks once the run signal aborts', async () => {
    const model = new FakeModelProvider()
    const controller = new AbortController()
    let handlerEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      handlerEntered = resolve
    })
    let observed: unknown

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('wf', {
        input: z.string(),
        output: z.string(),
        delegation: { maxDepth: 0 },
        handler: async (ctx) => {
          handlerEntered()
          await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }))
          try {
            await ctx.agents.worker(ctx.input)
          } catch (error) {
            observed = error
          }
          throw observed
        },
      })
      .build()

    const session = await harness.getSession('s-post-abort')
    const prompt = session.workflows.wf.run('work', { signal: controller.signal })
    await entered
    controller.abort()
    await expect(prompt).rejects.toBeInstanceOf(OperationCancelledError)
    await vi.waitFor(() => expect(observed).toBeDefined())
    expect(observed).toBeInstanceOf(OperationCancelledError)
    expect(observed).not.toBeInstanceOf(DelegationPolicyError)
    expect(model.requests).toHaveLength(0)
  })

  it('throws cancellation before policy checks for pre-aborted per-call signals', async () => {
    const model = new FakeModelProvider()

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agent('worker', {
        model: 'fast',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return the input.',
      })
      .workflow('wf', {
        input: z.string(),
        output: z.string(),
        delegation: { maxDepth: 0 },
        handler: async (ctx) => {
          const aborted = new AbortController()
          aborted.abort(new Error('stop-child'))
          try {
            await ctx.agents.worker(ctx.input, { signal: aborted.signal })
            return 'no-throw'
          } catch (error) {
            return error instanceof OperationCancelledError && !(error instanceof DelegationPolicyError)
              ? 'cancelled'
              : 'wrong'
          }
        },
      })
      .build()

    const session = await harness.getSession('s-pre-aborted-call')
    await expect(session.workflows.wf.run('work')).resolves.toBe('cancelled')
    expect(model.requests).toHaveLength(0)
  })

  it('wires ctx.loggerger to the harness logger', async () => {
    const lines: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []
    const logger: Logger = {
      trace: (msg, fields) => {
        lines.push({ level: 'trace', msg, ...(fields ? { fields } : {}) })
      },
      debug: (msg, fields) => {
        lines.push({ level: 'debug', msg, ...(fields ? { fields } : {}) })
      },
      info: (msg, fields) => {
        lines.push({ level: 'info', msg, ...(fields ? { fields } : {}) })
      },
      warn: (msg, fields) => {
        lines.push({ level: 'warn', msg, ...(fields ? { fields } : {}) })
      },
      error: (msg, fields) => {
        lines.push({ level: 'error', msg, ...(fields ? { fields } : {}) })
      },
      fatal: (msg, fields) => {
        lines.push({ level: 'fatal', msg, ...(fields ? { fields } : {}) })
      },
      child: () => logger,
    }
    const model = new FakeModelProvider()

    const harness = defineHarness()
      .logger(logger)
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .workflow('wf', {
        input: z.string(),
        output: z.string(),
        handler: async (ctx) => {
          ctx.logger.info('workflow handler log line', { step: 'start' })
          return ctx.input
        },
      })
      .build()

    const session = await harness.getSession('s-ctx-log')
    await expect(session.workflows.wf.run('hello')).resolves.toBe('hello')
    expect(lines).toEqual(
      expect.arrayContaining([{ level: 'info', msg: 'workflow handler log line', fields: { step: 'start' } }]),
    )
  })
})

function expectConfigError(fn: () => unknown, meta: Record<string, unknown>): void {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(HarnessConfigError)
  expect(thrown).toMatchObject({ meta: expect.objectContaining(meta) })
}
