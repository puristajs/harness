import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  HarnessConfigError,
  defineHarness,
  inMemorySandbox,
} from '../src/index.js'
import { FakeLogger } from '../src/testing/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

function modelAlias(provider = new FakeModelProvider()) {
  return { provider, model: 'fake', capabilities: ['object'] as const }
}

function nativeTool() {
  return {
    description: 'Echoes one value.',
    input: z.object({ value: z.string() }),
    output: z.object({ value: z.string() }),
    handler: async (_ctx: unknown, input: { value: string }) => input,
  }
}

describe('clean builder and runtime API contract', () => {
  it('appends singular and plural definitions, executes direct native tools, and exposes only run/stream session facades', async () => {
    const provider = new FakeModelProvider({ strict: true })
    provider.enqueue({
      object: {},
      toolCalls: [{ id: 'call-echo', name: 'echo', arguments: { value: 'hello' } }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls',
    })
    provider.enqueue({
      object: 'done',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    })
    const logger = new FakeLogger()
    const seenTelemetry: unknown[] = []

    const harness = defineHarness()
      .logger(logger)
      .sandbox(inMemorySandbox())
      .model('primary', { provider, model: 'fake', capabilities: ['object', 'tool_use'] })
      .models({ secondary: modelAlias() })
      .model('tertiary', modelAlias())
      .tool('echo', {
        description: 'Echoes one value.',
        input: z.object({ value: z.string() }),
        output: z.object({ value: z.string() }),
        handler: async (ctx, input) => {
          ctx.logger.info('direct-tool-context')
          ctx.telemetry.recordCounter('app.direct_tool.calls', 1, {})
          seenTelemetry.push(ctx.telemetry)
          return input
        },
      })
      .tools({ uppercase: nativeTool() })
      .tool('lowercase', nativeTool())
      .agent('tool_agent', {
        model: 'primary',
        input: z.string(),
        output: z.string(),
        instructions: 'Use the echo tool, then answer.',
        tools: ['echo'],
        builtinTools: false,
      })
      .agents({
        custom_agent: {
          model: 'primary',
          input: z.string(),
          output: z.string(),
          instructions: 'Return the input.',
          builtinTools: false,
          handler: async (ctx) => {
            ctx.logger.info('agent-context')
            ctx.telemetry.recordCounter('app.agent.calls', 1, {})
            seenTelemetry.push(ctx.telemetry)
            return ctx.input
          },
        },
      })
      .agent('second_agent', { model: 'primary', instructions: 'Return the input.', handler: async (ctx) => ctx.input })
      .workflow('first_workflow', {
        input: z.string(),
        output: z.string(),
        handler: async (ctx) => {
          ctx.logger.info('workflow-context')
          ctx.telemetry.recordCounter('app.workflow.calls', 1, {})
          seenTelemetry.push(ctx.telemetry)
          return ctx.input
        },
      })
      .workflows({
        second_workflow: { input: z.string(), output: z.string(), handler: async (ctx) => ctx.input },
      })
      .workflow('third_workflow', { input: z.string(), output: z.string(), handler: async (ctx) => ctx.input })
      .build()

    const session = await harness.getSession('clean-api-contract')
    await expect(session.agents.tool_agent.run('hello')).resolves.toMatchObject({ status: 'completed', output: 'done' })
    await expect(session.agents.custom_agent.run('custom')).resolves.toMatchObject({ status: 'completed', output: 'custom' })
    await expect(session.workflows.first_workflow.run('workflow')).resolves.toMatchObject({ status: 'completed', output: 'workflow' })
    await expect(session.workflows.second_workflow.run('plural')).resolves.toMatchObject({ status: 'completed', output: 'plural' })
    await expect(session.workflows.third_workflow.run('repeated')).resolves.toMatchObject({ status: 'completed', output: 'repeated' })
    provider.assertExhausted()

    expect(logger.records.map(record => record.msg)).toEqual(
      expect.arrayContaining(['direct-tool-context', 'agent-context', 'workflow-context']),
    )
    expect(seenTelemetry).toHaveLength(3)
    expect(seenTelemetry.every(telemetry => telemetry && typeof (telemetry as { recordCounter?: unknown }).recordCounter === 'function')).toBe(true)
    expect('prompt' in session.agents.tool_agent).toBe(false)
    expect('prompt' in session.workflows.first_workflow).toBe(false)
    expect('close' in session).toBe(false)

    await session.destroy()
    await expect(session.destroy()).resolves.toBeUndefined()
  })

  it('rejects malformed direct native definitions before a harness can build', () => {
    expect(() =>
      defineHarness().tool('malformed', {
        description: 'Malformed.',
        input: z.string(),
        output: z.string(),
        handler: 'not-a-function',
      } as never),
    ).toThrow(expect.objectContaining({ meta: { reason: 'invalid_tool', path: 'tools.malformed', id: 'malformed' } }))
  })

  it.each([
    ['model', (id: string) => defineHarness().model(id, modelAlias()), 'invalid_model_id'],
    ['tool', (id: string) => defineHarness().tool(id, nativeTool()), 'invalid_tool_id'],
    ['agent', (id: string) => defineHarness().models({ primary: modelAlias() }).agent(id, { model: 'primary', instructions: 'x' }), 'invalid_agent_id'],
    ['workflow', (id: string) => defineHarness().workflow(id, { handler: async ({ input }) => input }), 'invalid_workflow_id'],
  ] as const)('rejects invalid and reserved %s ids', (_family, register, reason) => {
    for (const id of ['invalid-id', 'harness_reserved', 'system_reserved']) {
      expect(register.bind(undefined, id)).toThrow(
        expect.objectContaining({ meta: expect.objectContaining({ reason, id }) }),
      )
    }
  })

  it('rejects invalid skill ids and duplicate singular/plural definitions in every registry', () => {
    expect(() => defineHarness().skill('Invalid_Skill', { directory: '/does/not/matter' })).toThrow(
      expect.objectContaining({ meta: { reason: 'invalid_name', skill_id: 'Invalid_Skill' } }),
    )

    expect(() => defineHarness().model('primary', modelAlias()).models({ primary: modelAlias() })).toThrow(
      expect.objectContaining({ meta: { reason: 'duplicate_definition', path: 'models.primary', id: 'primary' } }),
    )
    expect(() => defineHarness().tool('echo', nativeTool()).tools({ echo: nativeTool() })).toThrow(
      expect.objectContaining({ meta: { reason: 'duplicate_definition', path: 'tools.echo', id: 'echo' } }),
    )
    expect(() => defineHarness().skill('writer', { directory: '/does/not/matter' }).skills({ writer: { directory: '/does/not/matter' } })).toThrow(
      expect.objectContaining({ meta: { reason: 'duplicate_definition', path: 'skills.writer', id: 'writer' } }),
    )
    expect(() =>
      defineHarness()
        .models({ primary: modelAlias() })
        .agent('answer', { model: 'primary', instructions: 'x' })
        .agents({ answer: { model: 'primary', instructions: 'x' } }),
    ).toThrow(expect.objectContaining({ meta: { reason: 'duplicate_definition', path: 'agents.answer', id: 'answer' } }))
    expect(() =>
      defineHarness()
        .workflow('answer', { handler: async ({ input }) => input })
        .workflows({ answer: { handler: async ({ input }) => input } }),
    ).toThrow(expect.objectContaining({ meta: { reason: 'duplicate_definition', path: 'workflows.answer', id: 'answer' } }))
  })
})
