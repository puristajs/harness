import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { defineHarness, inMemorySandbox, InMemoryHarnessStorage } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/index.js'

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
      expect.objectContaining({ type: 'model.object', object: { answer: 'done' } }),
      expect.objectContaining({ type: 'run.finished', output: { answer: 'done' } })
    ]))
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
      'model.object',
      'agent.finished',
      'run.finished'
    ])
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.object', runId: run.id, agentId: 'custom', modelAlias: 'fake', object: { answer: 'native' } }),
      expect.objectContaining({ type: 'agent.finished', runId: run.id, agentId: 'custom', output: { answer: 'native' } })
    ]))
    expect(events.some((event) => event.runId === 'forged-run-id')).toBe(false)
    expect(persisted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.object', payload: { agentId: 'custom', modelAlias: 'fake', object: '[redacted]', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } })
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
        object: { ok: true },
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
      }),
      expect.objectContaining({ type: 'run.finished', output: { ok: true } })
    ]))
  })
})
