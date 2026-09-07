import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { BaseModelProvider, InMemoryHarnessStorage, ModelError } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/index.js'
import type { JsonValue, ObjectRequest, ObjectStreamChunk, TextRequest, TextStreamChunk } from '../src/index.js'
import { defineAgent } from '../src/definitions/agent.js'
import { defineHarness as defineHarnessV4 } from '../src/definitions/harness.js'
import { defineWorkflow } from '../src/definitions/workflow.js'

function persistentStorage(): InMemoryHarnessStorage {
  const storage = new InMemoryHarnessStorage()
  const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
  Object.defineProperty(storage, 'capabilities', { value: capabilities })
  Object.defineProperty(storage, 'info', { value: Object.freeze({ ...storage.info, capabilities }) })
  return storage
}

async function waitForTerminalRun(storage: InMemoryHarnessStorage, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = (await storage.listRuns(sessionId))[0]
    if (run !== undefined && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for the test run to settle.')
}

describe('run event persistence privacy', () => {
  it('redacts output content by default and keeps envelope fields outside payload', async () => {
    const state = persistentStorage()
    const workflow = defineWorkflow('wf', { input: z.string(), output: z.string(), durable: true,
      async handler({ input }) { return `secret:${input}` },
    })
    const harness = await defineHarnessV4({ name: 'eventPrivacy', revision: 'v1' }).addWorkflow(workflow).getInstance({ storage: state })

    const session = await harness.getSession('s1')
    await session.workflows.wf.run('payload')
    const run = (await state.listRuns('s1'))[0]!
    const events = await state.listEvents(run.id)

    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'run.finished', payload: { outcome: { status: 'completed' } } })]),
    )
    expect(JSON.stringify(events)).not.toContain('secret:payload')
    expect(events.some((event) => Object.prototype.hasOwnProperty.call(event.payload as object, 'runId'))).toBe(false)
    expect(events.some((event) => Object.prototype.hasOwnProperty.call(event.payload as object, 'at'))).toBe(false)
  })

  it('keeps persisted event content redacted even when a non-default telemetry content policy is configured', async () => {
    const state = persistentStorage()
    const workflow = defineWorkflow('wf', { input: z.string(), output: z.string(), durable: true,
      async handler({ input }) { return `secret:${input}` },
    })
    const harness = await defineHarnessV4({ name: 'eventPrivacyCapture', revision: 'v1' }).addWorkflow(workflow)
      .getInstance({ storage: state, telemetry: { contentCaptureMode: 'SPAN_AND_EVENT' } })

    const session = await harness.getSession('s1')
    await session.workflows.wf.run('payload')
    const run = (await state.listRuns('s1'))[0]!
    const events = await state.listEvents(run.id)

    expect(JSON.stringify(events)).not.toContain('secret:payload')
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'run.finished', payload: { outcome: { status: 'completed' } } })]),
    )
  })
})

describe('stream completion accounting', () => {
  for (const operation of ['textStream', 'objectStream'] as const) {
    it.each(['success', 'duplicate', 'late', 'throw', 'partial', 'cancel', 'early_return'] as const)(
      `${operation}: %s`,
      async (ending) => {
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
          override async *objectStream<T extends JsonValue = JsonValue>(
            req: ObjectRequest<T>,
          ): AsyncIterable<ObjectStreamChunk<T>> {
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
          ...(ending === 'late' ? [{ kind: 'delta' as const, text: 'late' }] : []),
        ])
        provider.enqueueObjectStream([
          { kind: 'partial', partial: { ok: false } },
          ...(ending === 'partial' ? [] : [objectFinish]),
          ...(ending === 'duplicate' ? [objectFinish] : []),
          ...(ending === 'late' ? [{ kind: 'partial' as const, partial: { late: true } }] : []),
        ])
        const storage = persistentStorage()
        const agent = operation === 'textStream'
          ? defineAgent('streamAccounting', { input: z.string(), instructions: 'Respond.', durable: true,
            prompt: value => ({ role: 'user', content: value }),
          })
          : defineAgent('streamAccounting', { input: z.string(), output: z.object({ ok: z.boolean() }), instructions: 'Respond.', durable: true,
            prompt: value => ({ role: 'user', content: value }),
          })
        const harness = await defineHarnessV4({ name: `streamAccounting${operation}`, revision: 'v1' }).addAgent(agent)
          .getInstance({ storage, model: { provider, model: 'fake' } })
        const session = await harness.getSession('stream-accounting')
        try {
          const live = []
          const consume = async () => {
            for await (const event of session.agents.streamAccounting.stream('test', { signal: controller.signal })) {
              live.push(event)
              if (ending === 'early_return' && event.type === 'agent.started') return
            }
          }
          await expect(consume()).resolves.toBeUndefined()
          if (ending === 'early_return') await waitForTerminalRun(storage, 'stream-accounting')
          const run = (await storage.listRuns('stream-accounting'))[0]!
          if (ending !== 'early_return') {
            expect(live.at(-1)).toMatchObject({
              type: 'run.finished',
              outcome: { status: ending === 'success' ? 'completed' : ending === 'cancel' ? 'cancelled' : 'failed' },
            })
          }
          const events = await storage.listEvents(run.id)
          const completed = events.filter((event) => event.type === 'model.completed')
          expect(completed).toHaveLength(ending === 'success' || ending === 'early_return' ? 1 : 0)
          expect(
            events.some((event) => ['model.delta', 'model.object.partial', 'model.object'].includes(event.type)),
          ).toBe(false)
          const summary = await session.getRunSummary(run.id)
          expect(summary.modelCalls).toBe(ending === 'success' || ending === 'early_return' ? 1 : 0)
          if (ending === 'success' || ending === 'early_return') expect(summary.tokenTotals).toEqual(usage)
        } finally {
          await harness.close()
        }
      },
    )

    it(`${operation}: counts only the successful retry before the first chunk`, async () => {
      const fake = new FakeModelProvider()
      class RetryingProvider extends BaseModelProvider {
        attempts = 0
        constructor() {
          super({ id: 'retry', genAiSystem: 'test' })
        }
        private attempt(): void {
          if (++this.attempts === 1)
            throw new ModelError('Temporary failure.', {
              provider: this.id,
              model: 'fake',
              method: operation,
              reason: 'network',
            })
        }
        protected override async *doTextStream(req: TextRequest): AsyncIterable<TextStreamChunk> {
          this.attempt()
          yield* fake.textStream(req)
        }
        protected override async *doObjectStream<T extends JsonValue = JsonValue>(
          req: ObjectRequest<T>,
        ): AsyncIterable<ObjectStreamChunk<T>> {
          this.attempt()
          yield* fake.objectStream(req)
        }
      }
      const provider = new RetryingProvider()
      const usage = { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
      fake.enqueueTextStream([
        { kind: 'delta', text: 'done' },
        { kind: 'finish', usage, finishReason: 'stop' },
      ])
      fake.enqueueObjectStream([
        { kind: 'partial', partial: { ok: false } },
        { kind: 'finish', object: { ok: true }, usage, finishReason: 'stop' },
      ])
      const storage = persistentStorage()
      const agent = operation === 'textStream'
        ? defineAgent('streamRetry', { input: z.string(), instructions: 'Respond.', durable: true,
          prompt: value => ({ role: 'user', content: value }),
        })
        : defineAgent('streamRetry', { input: z.string(), output: z.object({ ok: z.boolean() }), instructions: 'Respond.', durable: true,
          prompt: value => ({ role: 'user', content: value }),
        })
      const harness = await defineHarnessV4({ name: `streamRetry${operation}`, revision: 'v1' }).addAgent(agent)
        .getInstance({ storage, model: { provider, model: 'fake', retry: { minDelayMs: 0, maxDelayMs: 0 } } })
      try {
        const session = await harness.getSession('stream-retry')
        const events = []
        for await (const event of session.agents.streamRetry.stream('test')) events.push(event)
        expect(events.at(-1)).toMatchObject({ type: 'run.finished', outcome: { status: 'completed' } })
        expect(provider.attempts).toBe(2)
        const run = (await storage.listRuns('stream-retry'))[0]!
        expect((await storage.listEvents(run.id)).filter((event) => event.type === 'model.completed')).toHaveLength(1)
        expect((await session.getRunSummary(run.id)).modelCalls).toBe(1)
      } finally {
        await harness.close()
      }
    })
  }
})

describe('model completion metadata validation', () => {
  const usage = {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
    cachedInputTokens: 1,
    cacheCreationInputTokens: 0,
    reasoningTokens: 1,
  }
  const privateContent = 'PRIVATE_PROVIDER_CONTENT'
  const cases: { name: string; metadata: unknown; valid?: boolean; reported?: boolean }[] = [
    {
      name: 'projects reported metadata',
      metadata: { usage, finishReason: 'stop' },
      valid: true,
      reported: true,
    },
    {
      name: 'rejects undeclared usage accessors without reading them',
      metadata: {
        usage: Object.defineProperty({ ...usage }, 'prompt', {
          enumerable: true,
          get: () => {
            throw new Error(privateContent)
          },
        }),
        finishReason: 'stop',
      },
    },
    { name: 'uses the required terminal metadata defaults', metadata: {}, valid: true, reported: true },
    { name: 'rejects null usage', metadata: { usage: null } },
    { name: 'rejects incomplete usage', metadata: { usage: { inputTokens: 1, outputTokens: 2 } } },
    ...Object.keys(usage).map((field) => ({
      name: `rejects nonfinite ${field}`,
      metadata: { usage: { ...usage, [field]: Infinity } },
    })),
    { name: 'rejects NaN usage', metadata: { usage: { ...usage, inputTokens: NaN } } },
    { name: 'rejects string usage', metadata: { usage: { ...usage, totalTokens: privateContent } } },
    { name: 'rejects unnormalized finish reason', metadata: { finishReason: privateContent } },
    { name: 'rejects null finish reason', metadata: { finishReason: null } },
  ]
  for (const operation of ['text', 'object', 'textStream', 'objectStream'] as const) {
    it.each(cases)(`${operation}: $name`, async ({ metadata, valid, reported }) => {
      const provider = new FakeModelProvider()
      // Deliberately bypass the port types to simulate an untrusted custom adapter.
      const response = Object.assign(operation === 'text'
        ? { content: 'done', usage, finishReason: 'stop' }
        : operation === 'object'
          ? { object: { ok: true }, usage, finishReason: 'stop' }
          : operation === 'textStream'
            ? { kind: 'finish', usage, finishReason: 'stop' }
            : { kind: 'finish', object: { ok: true }, usage, finishReason: 'stop' }, metadata)
      if (operation === 'text') provider.enqueueText(response as never)
      else if (operation === 'object') provider.enqueueObject(response as never)
      else if (operation === 'textStream') provider.enqueueTextStream([response as never])
      else provider.enqueueObjectStream([response as never])
      const storage = persistentStorage()
      const agent = operation === 'text' || operation === 'textStream'
        ? defineAgent('metadataAgent', { input: z.string(), instructions: 'Respond.', durable: true,
          prompt: value => ({ role: 'user', content: value }),
        })
        : defineAgent('metadataAgent', { input: z.string(), output: z.object({ ok: z.boolean() }), instructions: 'Respond.', durable: true,
          prompt: value => ({ role: 'user', content: value }),
        })
      const harness = await defineHarnessV4({ name: `metadata${operation}`, revision: 'v1' }).addAgent(agent)
        .getInstance({ storage, model: { provider, model: 'fake' } })
      try {
        const session = await harness.getSession('metadata')
        let terminal
        if (operation === 'text' || operation === 'object') {
          try {
            terminal = await session.agents.metadataAgent.run('test')
          } catch (error) {
            if (valid) throw error
            expect(error).toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'model_response' } })
          }
        } else {
          for await (const event of session.agents.metadataAgent.stream('test')) {
            if (event.type === 'run.finished') terminal = event.outcome
          }
        }
        expect(terminal?.status).toBe(valid ? 'completed' : operation.endsWith('Stream') ? 'failed' : undefined)
        const run = (await storage.listRuns('metadata'))[0]!
        const events = await storage.listEvents(run.id)
        const completed = events.filter((event) => event.type === 'model.completed')
        expect(completed).toHaveLength(valid ? 1 : 0)
        expect(JSON.stringify({ events, error: run.error })).not.toContain(privateContent)
        if (valid) {
          expect(completed[0]!.payload).toEqual({
            caller: { kind: 'agent', agentId: 'metadataAgent' },
            modelAlias: 'primary',
            operation,
            ...(operation.endsWith('Stream') ? { streamId: expect.any(String) } : {}),
            ...(reported ? { usage, finishReason: 'stop' } : {}),
          })
        }
      } finally {
        await harness.close()
      }
    })
  }

  it.each(['undefined', 'function', 'nonfinite', 'accessor'] as const)(
    'rejects a non-JSON object finish: %s',
    async (invalid) => {
      const provider = new FakeModelProvider()
      const object =
        invalid === 'function'
          ? { invalid: () => privateContent }
          : invalid === 'nonfinite'
            ? { invalid: Infinity }
            : undefined
      let reads = 0
      const finish = { kind: 'finish', object, usage, finishReason: 'stop' }
      if (invalid === 'accessor')
        Object.defineProperty(finish, 'object', {
          enumerable: true,
          get: () => {
            reads += 1
            throw new Error(privateContent)
          },
        })
      provider.enqueueObjectStream([finish as never])
      const storage = persistentStorage()
      const agent = defineAgent('invalidObjectAgent', { input: z.string(), output: z.object({ ok: z.boolean() }),
        durable: true, instructions: 'Respond.', prompt: value => ({ role: 'user', content: value }),
      })
      const harness = await defineHarnessV4({ name: 'invalidObject', revision: 'v1' }).addAgent(agent)
        .getInstance({ storage, model: { provider, model: 'fake' } })
      try {
        const session = await harness.getSession('invalid-object')
        const events = []
        for await (const event of session.agents.invalidObjectAgent.stream('test')) events.push(event)
        expect(events.at(-1)).toMatchObject({ type: 'run.finished', outcome: { status: 'failed', error: {
          code: 'VALIDATION_ERROR', meta: { where: 'model_response' },
        } } })
        expect(reads).toBe(0)
        const run = (await storage.listRuns('invalid-object'))[0]!
        const persisted = await storage.listEvents(run.id)
        expect(persisted.filter((event) => event.type === 'model.completed')).toHaveLength(0)
        expect(JSON.stringify({ events: persisted, error: run.error })).not.toContain(privateContent)
      } finally {
        await harness.close()
      }
    },
  )
})

describe('model stream run events', () => {
  it('emits only structured snapshots for a structured v4 agent', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObjectStream([{
      kind: 'finish', object: { answer: 'done' },
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: 'stop',
    }])
    const agent = defineAgent('answerer', { input: z.string(), output: z.object({ answer: z.string() }),
      instructions: 'Return a final object.', prompt: value => ({ role: 'user', content: value }),
    })
    const harness = await defineHarnessV4({ name: 'structuredOnly' }).addAgent(agent)
      .getInstance({ model: { provider, model: 'fake' } })

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.agents.answerer.stream('hello')) events.push(event)

    expect(events.some((event) => event.type === 'output.text.delta')).toBe(false)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model.completed',
          modelAlias: 'primary',
          operation: 'objectStream',
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          finishReason: 'stop',
        }),
        expect.objectContaining({ type: 'run.finished', outcome: expect.objectContaining({ status: 'completed', output: { answer: 'done' } }) }),
      ]),
    )
    expect(events.filter((event) => event.type === 'model.completed')).toHaveLength(1)
    await harness.close()
  })

  it('emits workflow-scoped model output while keeping root output private until completion', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueTextStream([
      { kind: 'delta', text: 'hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'finish', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' },
    ])
    const workflow = defineWorkflow('wf', {
        input: z.string(), output: z.string(),
        models: { fake: { alias: 'primary', capabilities: ['text_stream'] } },
        handler: async (ctx) => {
          let text = ''
          for await (const chunk of ctx.models.fake.textStream(
            { messages: [{ role: 'user', content: ctx.input }] },
            { callId: 'private-stream' },
          )) {
            if (chunk.kind === 'delta') text += chunk.text
          }
          return text
        },
      })
    const harness = await defineHarnessV4({ name: 'workflowPrivateStream' }).addWorkflow(workflow)
      .getInstance({ model: { provider, model: 'fake' } })

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.workflows.wf.stream('hello')) events.push(event)
    expect(events.some((event) => event.type === 'output.text.delta')).toBe(false)
    expect(events).toEqual(
      expect.arrayContaining([
		expect.objectContaining({ type: 'model.output.text.delta', caller: { kind: 'workflow', workflowId: 'wf' }, modelAlias: 'primary', callId: 'private-stream', delta: 'hel' }),
		expect.objectContaining({ type: 'model.output.text.delta', caller: { kind: 'workflow', workflowId: 'wf' }, modelAlias: 'primary', callId: 'private-stream', delta: 'lo' }),
        expect.objectContaining({ type: 'run.finished', outcome: expect.objectContaining({ status: 'completed', output: 'hello' }) }),
      ]),
    )
    await harness.close()
  })

  it('emits text stream deltas for a v4 streaming agent while persisted content stays private', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueTextStream([
      { kind: 'delta', text: 'hel' },
      { kind: 'delta', text: 'lo' },
      { kind: 'finish', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, finishReason: 'stop' },
    ])
    const state = persistentStorage()
    const agent = defineAgent('streamed', { input: z.string(), durable: true, instructions: 'Respond.',
      prompt: value => ({ role: 'user', content: value }),
    })
    const harness = await defineHarnessV4({ name: 'publicTextStream', revision: 'v1' }).addAgent(agent)
      .getInstance({ storage: state, model: { provider, model: 'fake' } })

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.agents.streamed.stream('hello')) events.push(event)
    const run = (await state.listRuns('s1'))[0]!
    const persisted = await state.listEvents(run.id)

    const deltas = events.filter((event) => event.type === 'output.text.delta')
    const streamId = deltas[0]?.id
    expect(typeof streamId).toBe('string')
    expect(deltas).toEqual([
      expect.objectContaining({ type: 'output.text.delta', caller: { kind: 'agent', agentId: 'streamed' }, modelAlias: 'primary', id: streamId, delta: 'hel' }),
      expect.objectContaining({ type: 'output.text.delta', caller: { kind: 'agent', agentId: 'streamed' }, modelAlias: 'primary', id: streamId, delta: 'lo' }),
    ])
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.finished', outcome: expect.objectContaining({ status: 'completed', output: 'hello' }) })]))
    expect(JSON.stringify(persisted)).not.toContain('hello')
    expect(JSON.stringify(persisted)).not.toContain('hel')
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.completed', payload: expect.objectContaining({ streamId, caller: { kind: 'agent', agentId: 'streamed' } }) }),
    ]))
    await harness.close()
  })

  it('keeps structured v4 agent calls and lifecycle events on the native run pipeline', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObjectStream([{
      kind: 'finish', object: { answer: 'native' },
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      finishReason: 'stop',
    }])
    const state = persistentStorage()
    const agent = defineAgent('custom', { input: z.string(), output: z.object({ answer: z.string() }), durable: true,
      instructions: 'Respond.', prompt: value => ({ role: 'user', content: value }),
    })
    const harness = await defineHarnessV4({ name: 'structuredLifecycle', revision: 'v1' }).addAgent(agent)
      .getInstance({ storage: state, model: { provider, model: 'fake' } })

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
      'model.message',
      'agent.finished',
      'run.finished',
    ])
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model.completed',
          runId: run.id,
          caller: { kind: 'agent', agentId: 'custom' },
          modelAlias: 'primary',
          operation: 'objectStream',
          streamId: expect.any(String),
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          finishReason: 'stop',
        }),
        expect.objectContaining({
          type: 'agent.finished',
          runId: run.id,
          agentId: 'custom',
        }),
      ]),
    )
    expect(events.some((event) => event.runId === 'forged-run-id')).toBe(false)
    expect(persisted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model.completed',
          payload: {
            caller: { kind: 'agent', agentId: 'custom' },
            modelAlias: 'primary',
            operation: 'objectStream',
            streamId: expect.any(String),
            usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
            finishReason: 'stop',
          },
        }),
      ]),
    )
    expect(summary).toMatchObject({
      agentCalls: 1,
      modelCalls: 1,
      tokenTotals: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    })
    await harness.close()
  })

  it('emits structured stream snapshots and the final v4 agent outcome', async () => {
    const provider = new FakeModelProvider()
    provider.enqueueObjectStream([
      { kind: 'partial', partial: { ok: false } },
      { kind: 'partial', partial: { ok: true } },
      {
        kind: 'finish',
        object: { ok: true },
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        finishReason: 'stop',
      },
    ])
    const agent = defineAgent('structuredSnapshots', { input: z.string(), output: z.object({ ok: z.boolean() }),
      instructions: 'Respond.', prompt: value => ({ role: 'user', content: value }),
    })
    const harness = await defineHarnessV4({ name: 'structuredSnapshots' }).addAgent(agent)
      .getInstance({ model: { provider, model: 'fake' } })

    const session = await harness.getSession('s1')
    const events = []
    for await (const event of session.agents.structuredSnapshots.stream('check')) events.push(event)

    expect(events.filter((event) => event.type === 'output.object.snapshot')).toEqual([
      expect.objectContaining({
        type: 'output.object.snapshot',
        caller: { kind: 'agent', agentId: 'structuredSnapshots' },
        modelAlias: 'primary',
        value: { ok: false },
      }),
      expect.objectContaining({
        type: 'output.object.snapshot',
        caller: { kind: 'agent', agentId: 'structuredSnapshots' },
        modelAlias: 'primary',
        value: { ok: true },
      }),
    ])
    const streamId = (
      events.find((event) => event.type === 'output.object.snapshot') as { id?: string } | undefined
    )?.id
    expect(typeof streamId).toBe('string')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'model.completed',
		  caller: { kind: 'agent', agentId: 'structuredSnapshots' },
          modelAlias: 'primary',
          streamId,
          operation: 'objectStream',
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          finishReason: 'stop',
        }),
        expect.objectContaining({ type: 'run.finished', outcome: expect.objectContaining({ status: 'completed', output: { ok: true } }) }),
      ]),
    )
    await harness.close()
  })
})
