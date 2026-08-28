import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { BaseModelProvider, defineHarness, inMemorySandbox, InMemoryHarnessStorage, ModelError } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/index.js'
import type { JsonValue, ObjectRequest, ObjectStreamChunk, TextRequest, TextStreamChunk } from '../src/index.js'

describe('run event persistence privacy', () => {
  it('redacts output content by default and keeps envelope fields outside payload', async () => {
    const state = new InMemoryHarnessStorage()
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .storage(state)
      .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({ wf: { input: z.string(), output: z.string(), handler: async (ctx) => `secret:${ctx.input}` } })
      .build()

    const session = await harness.getSession('s1')
    await session.workflows.wf.prompt('payload')
    const run = (await state.listRuns('s1'))[0]!
    const events = await state.listEvents(run.id)

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.finished', payload: { output: '[redacted]' } })
    ]))
    expect(JSON.stringify(events)).not.toContain('secret:payload')
    expect(events.some((event) => Object.prototype.hasOwnProperty.call(event.payload as object, 'runId'))).toBe(false)
    expect(events.some((event) => Object.prototype.hasOwnProperty.call(event.payload as object, 'at'))).toBe(false)
  })

  it('keeps persisted event content redacted even when a non-default telemetry content policy is configured', async () => {
    const state = new InMemoryHarnessStorage()
    const harness = defineHarness()
      .telemetry({ contentCaptureMode: 'SPAN_AND_EVENT' })
      .sandbox(inMemorySandbox())
      .storage(state)
      .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({ wf: { input: z.string(), output: z.string(), handler: async (ctx) => `secret:${ctx.input}` } })
      .build()

    const session = await harness.getSession('s1')
    await session.workflows.wf.prompt('payload')
    const run = (await state.listRuns('s1'))[0]!
    const events = await state.listEvents(run.id)

    expect(JSON.stringify(events)).not.toContain('secret:payload')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.finished', payload: { output: '[redacted]' } })
    ]))
  })
})

describe('stream completion accounting', () => {
  for (const operation of ['textStream', 'objectStream'] as const) {
    it.each(['success', 'duplicate', 'late', 'throw', 'partial', 'cancel', 'early_return'] as const)(`${operation}: %s`, async (ending) => {
      const controller = new AbortController()
      const failure = new Error('Synthetic provider failure')
      const afterStream = () => {
        if (ending === 'throw') throw failure
        if (ending === 'cancel') controller.abort()
      }
      class Provider extends FakeModelProvider {
        override async *textStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
          yield* super.textStream(req)
          afterStream()
        }
        override async *objectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
          yield* super.objectStream(req)
          afterStream()
        }
      }
      const provider = new Provider()
      const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
      const textFinish: TextStreamChunk = { kind: 'finish', usage, finishReason: 'stop' }
      const objectFinish: ObjectStreamChunk = { kind: 'finish', object: { ok: true }, usage, finishReason: 'stop' }
      provider.enqueueTextStream([
        { kind: 'delta', text: 'synthetic content' },
        ...(ending === 'partial' ? [] : [textFinish]),
        ...(ending === 'duplicate' ? [textFinish] : []),
        ...(ending === 'late' ? [{ kind: 'delta' as const, text: 'late' }] : [])
      ])
      provider.enqueueObjectStream([
        { kind: 'partial', partial: { ok: false } },
        ...(ending === 'partial' ? [] : [objectFinish]),
        ...(ending === 'duplicate' ? [objectFinish] : []),
        ...(ending === 'late' ? [{ kind: 'partial' as const, partial: { late: true } }] : [])
      ])
      const storage = new InMemoryHarnessStorage()
      const harness = defineHarness()
        .sandbox(inMemorySandbox())
        .storage(storage)
        .models({ fake: { provider, model: 'fake', capabilities: ['text_stream', 'object_stream'] } })
        .workflows({
          wf: {
            input: z.string(), output: z.string(),
            handler: async (ctx) => {
              const request = { messages: [{ role: 'user' as const, content: ctx.input }] }
              const stream = operation === 'textStream'
                ? ctx.models.fake.textStream(request, ctx.signal)
                : ctx.models.fake.objectStream({ ...request, schema: { type: 'object' } }, ctx.signal)
              for await (const _chunk of stream) {
                if (ending === 'early_return') break
              }
              return 'done'
            }
          }
        }).build()
      const session = await harness.getSession('stream-accounting')
      try {
        const result = session.workflows.wf.prompt('test', { signal: controller.signal })
        if (ending === 'throw') await expect(result).rejects.toThrow(failure.message)
        else if (ending === 'cancel') await expect(result).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
        else if (ending === 'duplicate' || ending === 'late') await expect(result).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
        else await expect(result).resolves.toBe('done')
        const run = (await storage.listRuns('stream-accounting'))[0]!
        const events = await storage.listEvents(run.id)
        const completed = events.filter((event) => event.type === 'model.completed')
        expect(completed).toHaveLength(ending === 'success' ? 1 : 0)
        expect(events.some((event) => ['model.delta', 'model.object.partial', 'model.object'].includes(event.type))).toBe(false)
        const summary = await session.getRunSummary(run.id)
        expect(summary.modelCalls).toBe(ending === 'success' ? 1 : 0)
        if (ending === 'success') expect(summary.tokenTotals).toEqual(usage)
      } finally {
        await harness.shutdown()
      }
    })

    it(`${operation}: counts only the successful retry before the first chunk`, async () => {
      const fake = new FakeModelProvider()
      class RetryingProvider extends BaseModelProvider {
        attempts = 0
        constructor() { super({ id: 'retry', genAiSystem: 'test' }) }
        private attempt(): void {
          if (++this.attempts === 1) throw new ModelError('Temporary failure.', {
            provider: this.id, model: 'fake', method: operation, reason: 'network'
          })
        }
        protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
          this.attempt()
          yield* fake.textStream(req)
        }
        protected override async *doObjectStream<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
          this.attempt()
          yield* fake.objectStream(req)
        }
      }
      const provider = new RetryingProvider()
      const storage = new InMemoryHarnessStorage()
      const harness = defineHarness().storage(storage)
        .models({ fake: { provider, model: 'fake', capabilities: ['text_stream', 'object_stream'], retry: { minDelayMs: 0, maxDelayMs: 0 } } })
        .workflows({ wf: {
          input: z.string(), output: z.string(),
          handler: async (ctx) => {
            const request = { messages: [{ role: 'user' as const, content: ctx.input }] }
            const stream = operation === 'textStream'
              ? ctx.models.fake.textStream(request, ctx.signal)
              : ctx.models.fake.objectStream({ ...request, schema: { type: 'object' } }, ctx.signal)
            for await (const _chunk of stream) { /* exhaust successful retry */ }
            return 'done'
          }
        } }).build()
      try {
        const session = await harness.getSession('stream-retry')
        await expect(session.workflows.wf.prompt('test')).resolves.toBe('done')
        expect(provider.attempts).toBe(2)
        const run = (await storage.listRuns('stream-retry'))[0]!
        expect((await storage.listEvents(run.id)).filter((event) => event.type === 'model.completed')).toHaveLength(1)
        expect((await session.getRunSummary(run.id)).modelCalls).toBe(1)
      } finally { await harness.shutdown() }
    })
  }
})

describe('model completion metadata validation', () => {
  const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3, cachedInputTokens: 1, cacheCreationInputTokens: 0, reasoningTokens: 1 }
  const privateContent = 'PRIVATE_PROVIDER_CONTENT'
  const cases: { name: string; metadata: unknown; valid?: boolean; reported?: boolean }[] = [
    { name: 'projects reported metadata', metadata: { usage: { ...usage, prompt: privateContent }, finishReason: 'stop', raw: privateContent }, valid: true, reported: true },
    { name: 'ignores undeclared usage accessors', metadata: { usage: Object.defineProperty({ ...usage }, 'prompt', { enumerable: true, get: () => { throw new Error(privateContent) } }), finishReason: 'stop' }, valid: true, reported: true },
    { name: 'accepts absent metadata', metadata: {}, valid: true },
    { name: 'rejects null usage', metadata: { usage: null } },
    { name: 'rejects incomplete usage', metadata: { usage: { inputTokens: 1, outputTokens: 2 } } },
    ...Object.keys(usage).map((field) => ({ name: `rejects nonfinite ${field}`, metadata: { usage: { ...usage, [field]: Infinity } } })),
    { name: 'rejects NaN usage', metadata: { usage: { ...usage, inputTokens: NaN } } },
    { name: 'rejects string usage', metadata: { usage: { ...usage, totalTokens: privateContent } } },
    { name: 'rejects unnormalized finish reason', metadata: { finishReason: privateContent } },
    { name: 'rejects null finish reason', metadata: { finishReason: null } }
  ]
  for (const operation of ['text', 'object', 'textStream', 'objectStream'] as const) {
    it.each(cases)(`${operation}: $name`, async ({ metadata, valid, reported }) => {
      const provider = new FakeModelProvider()
      // Deliberately bypass the port types to simulate an untrusted custom adapter.
      const response = Object.assign({ content: 'done', object: { ok: true }, kind: 'finish' }, metadata)
      if (operation === 'text') provider.enqueueText(response as never)
      else if (operation === 'object') provider.enqueueObject(response as never)
      else if (operation === 'textStream') provider.enqueueTextStream([response as never])
      else provider.enqueueObjectStream([response as never])
      const storage = new InMemoryHarnessStorage()
      const harness = defineHarness().storage(storage)
        .models({ fake: { provider, model: 'fake', capabilities: ['text', 'object', 'text_stream', 'object_stream'] } })
        .workflows({ wf: {
          input: z.string(), output: z.string(),
          handler: async (ctx) => {
            const request = { messages: [{ role: 'user' as const, content: ctx.input }] }
            const objectRequest = { ...request, schema: { type: 'object' } }
            if (operation === 'text') await ctx.models.fake.text(request, ctx.signal)
            else if (operation === 'object') await ctx.models.fake.object(objectRequest, ctx.signal)
            else {
              const stream = operation === 'textStream'
                ? ctx.models.fake.textStream(request, ctx.signal)
                : ctx.models.fake.objectStream(objectRequest, ctx.signal)
              for await (const _chunk of stream) { /* exhaust without content events */ }
            }
            return 'done'
          }
        } }).build()
      try {
        const session = await harness.getSession('metadata')
        const result = session.workflows.wf.prompt('test')
        if (valid) await expect(result).resolves.toBe('done')
        else await expect(result).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'model_response' } })
        const run = (await storage.listRuns('metadata'))[0]!
        const events = await storage.listEvents(run.id)
        const completed = events.filter((event) => event.type === 'model.completed')
        expect(completed).toHaveLength(valid ? 1 : 0)
        expect(JSON.stringify({ events, error: run.error })).not.toContain(privateContent)
        if (valid) {
          expect(completed[0]!.payload).toEqual({ modelAlias: 'fake', workflowId: 'wf', operation,
            ...(operation.endsWith('Stream') ? { streamId: expect.any(String) } : {}),
            ...(reported ? { usage, finishReason: 'stop' } : {})
          })
        }
      } finally { await harness.shutdown() }
    })
  }

  it.each(['undefined', 'function', 'nonfinite', 'accessor'] as const)('rejects a non-JSON object finish: %s', async (invalid) => {
    const provider = new FakeModelProvider()
    const object = invalid === 'function' ? { invalid: () => privateContent } : invalid === 'nonfinite' ? { invalid: Infinity } : undefined
    let reads = 0
    const finish = { kind: 'finish', object, usage, finishReason: 'stop' }
    if (invalid === 'accessor') Object.defineProperty(finish, 'object', {
      enumerable: true, get: () => { reads += 1; throw new Error(privateContent) }
    })
    provider.enqueueObjectStream([finish as never])
    const storage = new InMemoryHarnessStorage()
    const harness = defineHarness().storage(storage)
      .models({ fake: { provider, model: 'fake', capabilities: ['object_stream'] } })
      .workflows({ wf: {
        input: z.string(), output: z.string(), handler: async (ctx) => {
          for await (const _chunk of ctx.models.fake.objectStream({ messages: [], schema: {} }, ctx.signal)) { /* exhaust */ }
          return 'done'
        }
      } }).build()
    try {
      const session = await harness.getSession('invalid-object')
      await expect(session.workflows.wf.prompt('test')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'model_response' } })
      expect(reads).toBe(0)
      const run = (await storage.listRuns('invalid-object'))[0]!
      const events = await storage.listEvents(run.id)
      expect(events.filter((event) => event.type === 'model.completed')).toHaveLength(0)
      expect(JSON.stringify({ events, error: run.error })).not.toContain(privateContent)
    } finally { await harness.shutdown() }
  })
})

describe('model stream run events', () => {
  it('does not emit text deltas for the default final-object agent path', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObject({
      object: { answer: 'done' },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: 'stop'
    })
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider, model: 'fake', capabilities: ['object', 'text_stream'] } })
      .tools({})
      .skills({})
      .agents({
        answerer: {
          model: 'fake',
          input: z.string(),
          output: z.object({ answer: z.string() }),
          builtinTools: false,
          instructions: 'Return a final object.'
        }
      })
      .build()

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.agents.answerer.stream('hello')) events.push(event)

    expect(events.some((event) => event.type === 'model.delta')).toBe(false)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.completed', modelAlias: 'fake', operation: 'object', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' }),
      expect.objectContaining({ type: 'model.object', object: { answer: 'done' } }),
      expect.objectContaining({ type: 'run.finished', output: { answer: 'done' } })
    ]))
    expect(events.filter((event) => event.type === 'model.completed')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'model.object')).toHaveLength(1)
  })

  it('does not emit stream chunks when a workflow consumes textStream internally', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueTextStream([
      { kind: 'delta', text: 'hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'finish', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' }
    ])
    const state = new InMemoryHarnessStorage()
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .storage(state)
      .models({ fake: { provider, model: 'fake', capabilities: ['text_stream'] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({
        wf: {
          input: z.string(),
          output: z.string(),
          handler: async (ctx) => {
            let text = ''
            for await (const chunk of ctx.models.fake.textStream({ messages: [{ role: 'user', content: ctx.input }] }, ctx.signal)) {
              if (chunk.kind === 'delta') text += chunk.text
            }
            return text
          }
        }
      })
      .build()

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.workflows.wf.stream('hello')) events.push(event)
    const run = (await state.listRuns('s1'))[0]!
    const persisted = await state.listEvents(run.id)

    expect(events.some((event) => event.type === 'model.delta')).toBe(false)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.completed', workflowId: 'wf', modelAlias: 'fake', operation: 'textStream', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' }),
      expect.objectContaining({ type: 'run.finished', output: 'hello' })
    ]))
    expect(JSON.stringify(persisted)).not.toContain('hello')
    expect(persisted.some((event) => event.type === 'model.delta')).toBe(false)
  })

  it('emits text stream deltas when a workflow opts in for a public textStream call', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueTextStream([
      { kind: 'delta', text: 'hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'finish', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' }
    ])
    const state = new InMemoryHarnessStorage()
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .storage(state)
      .models({ fake: { provider, model: 'fake', capabilities: ['text_stream'] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({
        wf: {
          input: z.string(),
          output: z.string(),
          handler: async (ctx) => {
            let text = ''
            for await (const chunk of ctx.models.fake.textStream(
              { messages: [{ role: 'user', content: ctx.input }] },
              ctx.signal,
              { emitRunEvents: true }
            )) {
              if (chunk.kind === 'delta') text += chunk.text
            }
            return text
          }
        }
      })
      .build()

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.workflows.wf.stream('hello')) events.push(event)
    const run = (await state.listRuns('s1'))[0]!
    const persisted = await state.listEvents(run.id)

    const deltas = events.filter((event) => event.type === 'model.delta')
    const streamId = deltas[0]?.streamId
    expect(typeof streamId).toBe('string')
    expect(deltas).toEqual([
      expect.objectContaining({ type: 'model.delta', workflowId: 'wf', modelAlias: 'fake', streamId, delta: 'hel' }),
      expect.objectContaining({ type: 'model.delta', workflowId: 'wf', modelAlias: 'fake', streamId, delta: 'lo' })
    ])
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.finished', output: 'hello' })
    ]))
    expect(JSON.stringify(persisted)).not.toContain('hello')
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.delta', payload: { workflowId: 'wf', modelAlias: 'fake', streamId, delta: '[redacted]' } })
    ]))
  })

  it('emits text stream deltas when a custom handler agent explicitly opts in', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueTextStream([
      { kind: 'delta', text: 'cu' },
      { kind: 'delta', text: 'stom' },
      { kind: 'finish', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' }
    ])
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider, model: 'fake', capabilities: ['text_stream'] } })
      .tools({})
      .skills({})
      .agents(({ agent }) => ({
        streamed: agent({
          model: 'fake',
          input: z.string(),
          output: z.string(),
          handler: async (ctx) => {
            let text = ''
            for await (const chunk of ctx.models.fake.textStream(
              { messages: [{ role: 'user', content: ctx.input }] },
              ctx.signal,
              { emitRunEvents: true }
            )) {
              if (chunk.kind === 'delta') text += chunk.text
            }
            return text
          }
        })
      }))
      .build()

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.agents.streamed.stream('hello')) events.push(event)

    const deltas = events.filter((event) => event.type === 'model.delta')
    const streamId = deltas[0]?.streamId
    expect(typeof streamId).toBe('string')
    expect(deltas).toEqual([
      expect.objectContaining({ type: 'model.delta', agentId: 'streamed', modelAlias: 'fake', streamId, delta: 'cu' }),
      expect.objectContaining({ type: 'model.delta', agentId: 'streamed', modelAlias: 'fake', streamId, delta: 'stom' })
    ])
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run.finished', output: 'custom' })
    ]))
  })

  it('keeps custom handler object calls and lifecycle events on the native run pipeline', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObject({
      object: { answer: 'native' },
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      finishReason: 'stop'
    })
    const state = new InMemoryHarnessStorage()
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .storage(state)
      .models({ fake: { provider, model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents(({ agent }) => ({
        custom: agent({
          model: 'fake',
          input: z.string(),
          output: z.object({ answer: z.string() }),
          handler: async (ctx) => {
            const response = await ctx.models.fake.object(
              {
                messages: [{ role: 'user', content: ctx.input }],
                schema: { type: 'object' }
              },
              ctx.signal,
              // The enclosing session owns run identity even when a handler
              // supplies an invocation context of its own.
              { emitRunEvents: true, runId: 'forged-run-id' }
            )
            return response.object as { answer: string }
          }
        })
      }))
      .build()

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.agents.custom.stream('hello')) events.push(event)
    const run = (await state.listRuns('s1'))[0]!
    const persisted = await state.listEvents(run.id)
    const summary = await session.getRunSummary(run.id)

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'agent.started',
      'model.completed',
      'agent.finished',
      'run.finished'
    ])
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.completed', runId: run.id, agentId: 'custom', modelAlias: 'fake', operation: 'object', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, finishReason: 'stop' }),
      expect.objectContaining({ type: 'agent.finished', runId: run.id, agentId: 'custom', output: { answer: 'native' } })
    ]))
    expect(events.some((event) => event.runId === 'forged-run-id')).toBe(false)
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.completed', payload: { agentId: 'custom', modelAlias: 'fake', operation: 'object', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, finishReason: 'stop' } })
    ]))
    expect(summary).toMatchObject({ agentCalls: 1, modelCalls: 1, tokenTotals: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } })
  })

  it('assigns separate stream ids for parallel opted-in workflow model streams', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueTextStream([
      { kind: 'delta', text: 'a' },
      { kind: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
    ])
    provider.enqueueTextStream([
      { kind: 'delta', text: 'b' },
      { kind: 'finish', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' }
    ])
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider, model: 'fake', capabilities: ['text_stream'] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({
        wf: {
          input: z.string(),
          output: z.string(),
          handler: async (ctx) => {
            const consume = async (label: string): Promise<string> => {
              let text = ''
              for await (const chunk of ctx.models.fake.textStream(
                { messages: [{ role: 'user', content: label }] },
                ctx.signal,
                { emitRunEvents: true }
              )) {
                if (chunk.kind === 'delta') text += chunk.text
              }
              return text
            }
            const [left, right] = await Promise.all([consume('left'), consume('right')])
            return `${left}${right}`
          }
        }
      })
      .build()

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.workflows.wf.stream('hello')) events.push(event)

    const deltas = events.filter((event) => event.type === 'model.delta')
    expect(deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.delta', workflowId: 'wf', modelAlias: 'fake', delta: 'a' }),
      expect.objectContaining({ type: 'model.delta', workflowId: 'wf', modelAlias: 'fake', delta: 'b' })
    ]))
    expect(new Set(deltas.map((event) => event.streamId)).size).toBe(2)
  })

  it('emits structured stream partials and the final object when a workflow opts in for objectStream events', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObjectStream([
      { kind: 'partial', partial: { ok: false } },
      { kind: 'partial', partial: { ok: true } },
      { kind: 'finish', object: { ok: true }, usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, finishReason: 'stop' }
    ])
    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fake: { provider, model: 'fake', capabilities: ['object_stream'] } })
      .tools({})
      .skills({})
      .agents({})
      .workflows({
        wf: {
          input: z.string(),
          output: z.object({ ok: z.boolean() }),
          handler: async (ctx) => {
            let output = { ok: false }
            for await (const chunk of ctx.models.fake.objectStream(
              {
                messages: [{ role: 'user', content: ctx.input }],
                schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
              },
              ctx.signal,
              { emitRunEvents: true }
            )) {
              if (chunk.kind === 'finish') output = chunk.object as { ok: boolean }
            }
            return output
          }
        }
      })
      .build()

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.workflows.wf.stream('check')) events.push(event)

    expect(events.filter((event) => event.type === 'model.object.partial')).toEqual([
      expect.objectContaining({ type: 'model.object.partial', workflowId: 'wf', modelAlias: 'fake', partial: { ok: false } }),
      expect.objectContaining({ type: 'model.object.partial', workflowId: 'wf', modelAlias: 'fake', partial: { ok: true } })
    ])
    const streamId = (events.find((event) => event.type === 'model.object.partial') as { streamId?: string } | undefined)?.streamId
    expect(typeof streamId).toBe('string')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'model.object',
        workflowId: 'wf',
        modelAlias: 'fake',
        streamId,
        object: { ok: true }
      }),
      expect.objectContaining({ type: 'model.completed', workflowId: 'wf', modelAlias: 'fake', streamId, operation: 'objectStream', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, finishReason: 'stop' }),
      expect.objectContaining({ type: 'run.finished', output: { ok: true } })
    ]))
  })
})
