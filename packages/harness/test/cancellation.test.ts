import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { defineHarness, inMemorySandbox } from '../src/index.js'
import { OperationCancelledError, OperationTimeoutError } from '../src/errors/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

describe('harness cancellation propagation', () => {
  it('propagates invoke aborts into model calls', async () => {
    const controller = new AbortController()
    const model = {
      id: 'fake',
      genAiSystem: 'fake',
      async object(req: { signal: AbortSignal }) {
        return new Promise((_resolve, reject) => {
          req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true })
        })
      }
    }
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false } })
      .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
      .build()

    const session = await harness.getSession('s1')
    const promise = session.workflows.wf.prompt('x', { signal: controller.signal })
    controller.abort()
    await expect(promise).rejects.toBeInstanceOf(OperationCancelledError)
  })

  it('maps pre-aborted invoke signals to OperationCancelledError', async () => {
    const controller = new AbortController()
    controller.abort()
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({ wf: { input: z.string(), output: z.string(), handler: async () => 'never' } })
      .build()

    const session = await harness.getSession('s1')
    await expect(session.workflows.wf.prompt('x', { signal: controller.signal })).rejects.toBeInstanceOf(OperationCancelledError)
  })

  it('enforces run timeout when workflow cooperates with the run signal', async () => {
    const harness = defineHarness()
      .defaults({ runTimeoutMs: 5 })
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({
        wf: {
          input: z.string(),
          output: z.string(),
          handler: async (ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 20))
            ctx.signal.throwIfAborted()
            return 'never'
          }
        }
      })
      .build()

    const session = await harness.getSession('s1')
    await expect(session.workflows.wf.prompt('x')).rejects.toBeInstanceOf(OperationTimeoutError)
  })

  it('enforces run timeout for non-cooperative workflow handlers', async () => {
    const harness = defineHarness()
      .defaults({ runTimeoutMs: 5 })
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({
        wf: {
          input: z.string(),
          output: z.string(),
          handler: async () => new Promise<never>(() => undefined)
        }
      })
      .build()

    const session = await harness.getSession('s1')
    const result = await Promise.race([
      session.workflows.wf.prompt('x').then(() => 'resolved', (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100))
    ])
    expect(result).toBeInstanceOf(OperationTimeoutError)
  })

  it('enforces run timeout for non-cooperative custom agent handlers', async () => {
    const harness = defineHarness()
      .defaults({ runTimeoutMs: 5 })
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({
        a1: {
          model: 'fake',
          input: z.string(),
          output: z.string(),
          handler: async () => new Promise<never>(() => undefined)
        }
      })
      .workflows({})
      .build()

    const session = await harness.getSession('s1')
    const result = await Promise.race([
      session.agents.a1.prompt('x').then(() => 'resolved', (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100))
    ])
    expect(result).toBeInstanceOf(OperationTimeoutError)
  })

  it('honors already-aborted nested agent signals inside workflows', async () => {
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({
        a1: {
          model: 'fake',
          input: z.string(),
          output: z.string(),
          handler: async () => 'ok'
        }
      })
      .workflows({
        wf: {
          input: z.string(),
          output: z.string(),
          delegation: {},
          handler: async (ctx) => {
            const controller = new AbortController()
            controller.abort(new Error('nested stop'))
            return ctx.agents.a1(ctx.input, { signal: controller.signal })
          }
        }
      })
      .build()

    const session = await harness.getSession('s1')
    await expect(session.workflows.wf.prompt('x')).rejects.toBeInstanceOf(OperationCancelledError)
  })

  it('cancels non-cooperative tools even when tool timeout is disabled', async () => {
    const controller = new AbortController()
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [{ id: 'call_hang', name: 'hang', arguments: {} }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls'
    })

    let markToolStarted!: () => void
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve
    })

    const harness = defineHarness()
      .defaults({ toolTimeoutMs: 0 })
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools({
        hang: {
          kind: 'ts',
          description: 'Never resolves unless the harness cancellation wrapper wins.',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          handler: async () => {
            markToolStarted()
            return new Promise<never>(() => undefined)
          }
        }
      })
      .skills({})
      .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', tools: ['hang'], builtinTools: false } })
      .workflows({ wf: { input: z.string(), output: z.string(), delegation: {}, handler: async (ctx) => ctx.agents.a1(ctx.input) } })
      .build()

    const session = await harness.getSession('s1')
    const prompt = session.workflows.wf.prompt('x', { signal: controller.signal })
    await toolStarted
    controller.abort(new Error('stop'))

    const result = await Promise.race([
      prompt.then(() => 'resolved', (error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100))
    ])
    expect(result).toBeInstanceOf(OperationCancelledError)
    expect(result).toMatchObject({ meta: { scope: 'run' } })
  })
})
