import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { defineHarness, inMemorySandbox } from '../src/index.js'
import { OperationCancelledError, OperationTimeoutError, SessionBusyError } from '../src/errors/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

/**
 * Sentinel for "the prompt must settle well before this". Generous (2 s vs the
 * 5 ms run timeout under test) so a loaded CI machine cannot win the race.
 */
const SENTINEL_TIMEOUT_MS = 2_000

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
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), SENTINEL_TIMEOUT_MS))
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
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), SENTINEL_TIMEOUT_MS))
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
      .tools(({ tool }) => ({
        hang: tool({
          kind: 'ts',
          description: 'Never resolves unless the harness cancellation wrapper wins.',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          handler: async () => {
            markToolStarted()
            return new Promise<never>(() => undefined)
          }
        })
      }))
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
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), SENTINEL_TIMEOUT_MS))
    ])
    expect(result).toBeInstanceOf(OperationCancelledError)
    expect(result).toMatchObject({ meta: { scope: 'run' } })
  })

  it('keeps the run alive when a consumer abandons the event stream until the caller aborts it', async () => {
    const controller = new AbortController()
    let modelAborted = false
    let markModelStarted!: () => void
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve
    })
    let markModelAborted!: () => void
    const modelAbortSeen = new Promise<void>((resolve) => {
      markModelAborted = resolve
    })
    const model = {
      id: 'hanging',
      genAiSystem: 'hanging',
      async object(req: { signal: AbortSignal }) {
        markModelStarted()
        return new Promise((_resolve, reject) => {
          const onAbort = () => {
            modelAborted = true
            markModelAborted()
            reject(req.signal.reason)
          }
          if (req.signal.aborted) return onAbort()
          req.signal.addEventListener('abort', onAbort, { once: true })
        })
      }
    }
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false } })
      .workflows({})
      .build()

    const session = await harness.getSession('s-abandoned-stream')
    for await (const event of session.agents.a1.stream('x', { signal: controller.signal })) {
      if (event.type === 'run.started') {
        await modelStarted
        break
      }
    }

    // Breaking out of the stream only detaches this consumer; explicit caller
    // cancellation is required to stop the underlying run.
    expect(modelAborted).toBe(false)
    await expect(session.clearHistory()).rejects.toBeInstanceOf(SessionBusyError)

    controller.abort()
    await modelAbortSeen
    for (let i = 0; i < 20; i += 1) {
      try {
        await session.clearHistory()
        return
      } catch (error) {
        if (!(error instanceof SessionBusyError)) throw error
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
    await session.clearHistory()
  })

  it('emits a paired tool.finished when a tool call is cancelled', async () => {
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
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(({ tool }) => ({
        hang: tool({
          kind: 'ts',
          description: 'Never resolves; cancelled through the run signal.',
          input: z.object({}),
          output: z.object({ ok: z.boolean() }),
          handler: async () => {
            markToolStarted()
            return new Promise<never>(() => undefined)
          }
        })
      }))
      .skills({})
      .agents({ a1: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', tools: ['hang'], builtinTools: false } })
      .workflows({})
      .build()

    const session = await harness.getSession('s-tool-finished-pairing')
    void toolStarted.then(() => controller.abort(new Error('stop')))

    const events: Array<{ type: string; toolId?: string; callId?: string; error?: { code?: string } }> = []
    let failure: unknown
    try {
      for await (const event of session.agents.a1.stream('x', { signal: controller.signal })) {
        events.push(event as (typeof events)[number])
      }
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(OperationCancelledError)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.started', toolId: 'hang', callId: 'call_hang' }),
      expect.objectContaining({
        type: 'tool.finished',
        toolId: 'hang',
        callId: 'call_hang',
        error: expect.objectContaining({ code: 'OPERATION_CANCELLED' })
      })
    ]))
  })
})
