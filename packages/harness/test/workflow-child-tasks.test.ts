import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineHarness, inMemorySandbox, type ChildTaskHandle, type ContinuableChildTaskHandle } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

describe('workflow child tasks', () => {
  it('starts an isolated, workflow-owned task that can settle after its starter workflow', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObject({
      object: 'done',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    let handle: ChildTaskHandle<string> | undefined
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return done.',
      })
      .workflow('launch', {
        input: z.string(),
        output: z.string(),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => {
          handle = await ctx.childTasks.start('worker', ctx.input)
          return handle.id
        },
      })
      .build()

    const session = await harness.getSession('task-owner')
    await session.replaceHistory([{ role: 'user', content: 'older private parent secret' }])
    const taskId = await session.workflows.launch.run('private parent context')
    expect(handle?.id).toBe(taskId)
    await expect(handle?.result()).resolves.toBe('done')
    await expect(handle?.status()).resolves.toMatchObject({
      status: 'succeeded',
      descriptor: { contextPolicy: 'isolated', parentRunId: expect.any(String) },
    })

    const summary = await session.getRunSummary(taskId)
    expect(summary).toMatchObject({ status: 'succeeded', agentCalls: 1 })
    // The child's request has only its direct input; parent workflow history is not forwarded.
    expect(provider.requests[0]).toMatchObject({
      messages: expect.not.arrayContaining([expect.objectContaining({ content: 'older private parent secret' })]),
    })
    await harness.shutdown()
  })

  it('cancels a live task without cancelling a later workflow invocation', async () => {
    let handle: ChildTaskHandle<string> | undefined
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Wait.',
        handler: async (ctx) =>
          new Promise<string>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true })
          }),
      })
      .workflow('launch', {
        input: z.string(),
        output: z.string(),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => {
          handle = await ctx.childTasks.start('worker', ctx.input)
          return handle.id
        },
      })
      .workflow('healthy', { input: z.string(), output: z.string(), handler: async (ctx) => ctx.input })
      .build()

    const session = await harness.getSession('task-cancel')
    const taskId = await session.workflows.launch.run('work')
    // The task is deliberately independent of its completed starter workflow.
    await expect(session.workflows.healthy.run('next')).resolves.toBe('next')
    expect(taskId).toMatch(/^task_/)
    await handle?.cancel('test shutdown')
    await expect(handle?.status()).resolves.toMatchObject({ status: 'cancelled' })
    await harness.shutdown()
  })

  it('queues background tasks under the delegation ceiling instead of rejecting them', async () => {
    let active = 0
    let peak = 0
    const handles: ChildTaskHandle<string>[] = []
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Wait.',
        handler: async (ctx) => {
          active += 1
          peak = Math.max(peak, active)
          await new Promise((resolve) => setTimeout(resolve, 10))
          active -= 1
          return ctx.input
        },
      })
      .workflow('launch', {
        input: z.array(z.string()),
        output: z.array(z.string()),
        delegation: { agents: ['worker'], maxParallelChildAgentCalls: 1 },
        handler: async (ctx) => {
          handles.push(...(await Promise.all(ctx.input.map((input) => ctx.childTasks.start('worker', input)))))
          return handles.map((handle) => handle.id)
        },
      })
      .build()

    const session = await harness.getSession('task-queue')
    await session.workflows.launch.run(['one', 'two'])
    await expect(Promise.all(handles.map((handle) => handle.result()))).resolves.toEqual(['one', 'two'])
    expect(peak).toBe(1)
    await harness.shutdown()
  })

  it('atomically coalesces concurrent starts with the same idempotency key', async () => {
    let executions = 0
    const handles: ChildTaskHandle<string>[] = []
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Return.',
        handler: async (ctx) => {
          executions += 1
          await new Promise((resolve) => setTimeout(resolve, 10))
          return ctx.input
        },
      })
      .workflow('launch', {
        input: z.string(),
        output: z.array(z.string()),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => {
          handles.push(
            ...(await Promise.all([
              ctx.childTasks.start('worker', ctx.input, { idempotencyKey: 'same-key' }),
              ctx.childTasks.start('worker', ctx.input, { idempotencyKey: 'same-key' }),
            ])),
          )
          return handles.map((handle) => handle.id)
        },
      })
      .build()
    const session = await harness.getSession('task-idempotency')
    const ids = await session.workflows.launch.run('one')
    expect(new Set(ids).size).toBe(1)
    await expect(Promise.all(handles.map((handle) => handle.result()))).resolves.toEqual(['one', 'one'])
    expect(executions).toBe(1)
    await harness.shutdown()
  })

  it('keeps a continuable task-owned history and exposes it through the session owner', async () => {
    let task: ContinuableChildTaskHandle<string, string> | undefined
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .agent('worker', {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        builtinTools: false,
        instructions: 'Echo.',
        handler: async (ctx) => `${(await ctx.history.list()).length}:${ctx.input}`,
      })
      .workflow('launch', {
        input: z.string(),
        output: z.string(),
        delegation: { agents: ['worker'] },
        handler: async (ctx) => {
          task = await ctx.childTasks.start('worker', ctx.input, { mode: 'continuable' })
          return task.id
        },
      })
      .build()

    const session = await harness.getSession('task-continuable')
    const taskId = await session.workflows.launch.run('first')
    await expect(task?.send('second')).resolves.toBe('2:second')
    await expect(task?.close()).resolves.toBe('2:second')
    await expect(task?.result()).resolves.toBe('2:second')
    await expect(session.childTasks.get(taskId)).resolves.toBeDefined()
    await expect((await session.childTasks.get(taskId))?.result()).resolves.toBe('2:second')
    await expect(session.childTasks.list()).resolves.toContainEqual(
      expect.objectContaining({ status: 'succeeded', descriptor: expect.objectContaining({ mode: 'continuable' }) }),
    )
    await harness.shutdown()
  })
})
