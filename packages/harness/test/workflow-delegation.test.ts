import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  DelegationPolicyError,
  InMemoryStateStore,
  defineHarness,
  inMemorySandbox
} from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

describe('workflow delegation policy', () => {
  it('enforces the safe default total child-agent call budget', async () => {
    const model = new FakeModelProvider()
    for (let index = 0; index < 32; index += 1) {
      model.enqueue({ object: `ok-${index}`, usage, finishReason: 'stop' })
    }

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents({
        worker: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          builtinTools: false,
          instructions: 'Return the input.'
        }
      })
      .workflows({
        fanout: {
          input: z.string(),
          output: z.array(z.string()),
          handler: async (ctx) => {
            const out: string[] = []
            for (let index = 0; index < 33; index += 1) {
              out.push(await ctx.agents.worker(`${ctx.input}-${index}`))
            }
            return out
          }
        }
      })
      .build()

    const session = await harness.getSession('s-default-budget')
    await expect(session.workflows.fanout.prompt('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'max_child_agent_calls_exceeded',
        workflow_id: 'fanout',
        agent_id: 'worker',
        limit: 32
      })
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
      .agents({
        worker: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          builtinTools: false,
          instructions: 'Return the input.'
        }
      })
      .workflows({
        fanout: {
          input: z.string(),
          output: z.array(z.string()),
          delegation: { maxChildAgentCalls: 2 },
          handler: async (ctx) => [
            await ctx.agents.worker(`${ctx.input}-1`),
            await ctx.agents.worker(`${ctx.input}-2`)
          ]
        }
      })
      .build()

    const session = await harness.getSession('s-override-budget')
    await expect(session.workflows.fanout.prompt('work')).resolves.toEqual(['one', 'two'])
  })

  it('denies child agents outside the workflow allowlist', async () => {
    const model = new FakeModelProvider()

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents({
        allowed: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          builtinTools: false,
          instructions: 'Allowed.'
        },
        blocked: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          builtinTools: false,
          instructions: 'Blocked.'
        }
      })
      .workflows({
        guarded: {
          input: z.string(),
          output: z.string(),
          delegation: { agents: ['allowed'] },
          handler: async (ctx) => ctx.agents.blocked(ctx.input)
        }
      })
      .build()

    const session = await harness.getSession('s-agent-allowlist')
    await expect(session.workflows.guarded.prompt('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'agent_not_allowed',
        workflow_id: 'guarded',
        agent_id: 'blocked'
      })
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
      .agents({
        worker: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          builtinTools: false,
          instructions: 'Return the input.'
        }
      })
      .workflows({
        guarded: {
          input: z.string(),
          output: z.array(z.string()),
          delegation: { maxParallelChildAgentCalls: 1 },
          handler: async (ctx) => Promise.all([
            ctx.agents.worker(`${ctx.input}-1`),
            ctx.agents.worker(`${ctx.input}-2`)
          ])
        }
      })
      .build()

    const session = await harness.getSession('s-parallel-budget')
    await expect(session.workflows.guarded.prompt('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'max_parallel_child_agent_calls_exceeded',
        workflow_id: 'guarded',
        agent_id: 'worker',
        limit: 1
      })
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
        deep: { provider: deep, model: 'fake-deep', capabilities: ['object'] }
      })
      .tools({})
      .skills({})
      .agents({
        writer: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          builtinTools: false,
          instructions: 'Write.'
        }
      })
      .workflows({
        reviewed: {
          input: z.string(),
          output: z.string(),
          delegation: {
            agentModelAliases: { writer: ['deep'] }
          },
          handler: async (ctx) => ctx.agents.writer(ctx.input, { model: 'deep' })
        }
      })
      .build()

    const session = await harness.getSession('s-model-override')
    await expect(session.workflows.reviewed.prompt('work')).resolves.toBe('deep answer')
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
        deep: { provider: deep, model: 'fake-deep', capabilities: ['object'] }
      })
      .tools({})
      .skills({})
      .agents({
        writer: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          builtinTools: false,
          instructions: 'Write.'
        }
      })
      .workflows({
        reviewed: {
          input: z.string(),
          output: z.string(),
          delegation: {
            agentModelAliases: { writer: ['deep'] }
          },
          handler: async (ctx) => ctx.agents.writer(ctx.input, { model: 'fast' })
        }
      })
      .build()

    const session = await harness.getSession('s-model-denied')
    await expect(session.workflows.reviewed.prompt('work')).rejects.toMatchObject({
      code: 'DELEGATION_POLICY_ERROR',
      meta: expect.objectContaining({
        reason: 'model_alias_not_allowed',
        workflow_id: 'reviewed',
        agent_id: 'writer',
        model_alias: 'fast'
      })
    })
    expect(fast.requests).toHaveLength(0)
    expect(deep.requests).toHaveLength(0)
  })

  it('emits and persists child-agent lineage without content payloads', async () => {
    const model = new FakeModelProvider()
    const state = new InMemoryStateStore()
    model.enqueue({ object: 'done', usage, finishReason: 'stop' })

    const harness = defineHarness()
      .state(state)
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents({
        worker: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          builtinTools: false,
          instructions: 'Return the input.'
        }
      })
      .workflows({
        traced: {
          input: z.string(),
          output: z.string(),
          handler: async (ctx) => ctx.agents.worker(ctx.input)
        }
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
      modelAlias: 'fast'
    })
    expect(finished).toMatchObject({
      type: 'agent.finished',
      workflowId: 'traced',
      agentId: 'worker',
      delegationDepth: 1,
      modelAlias: 'fast'
    })
    expect(typeof started?.delegationCallId).toBe('string')
    expect(finished?.delegationCallId).toBe(started?.delegationCallId)

    const persisted = await state.listEvents(runId as string)
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'agent.started',
        payload: expect.objectContaining({
          workflowId: 'traced',
          agentId: 'worker',
          delegationDepth: 1,
          modelAlias: 'fast',
          delegationCallId: started?.delegationCallId
        })
      }),
      expect.objectContaining({
        type: 'agent.finished',
        payload: expect.not.objectContaining({ output: 'done' })
      })
    ]))
  })
})
