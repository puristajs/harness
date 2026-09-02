import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  HarnessConfigError,
  InMemoryHarnessStorage,
  SkillManifestError,
  defineHarness,
  defineHarnessModule,
  inMemoryMemoryEngine,
  inMemorySandbox,
  type TsToolDefinition,
} from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

function builderWith(agent: Record<string, unknown>) {
  return defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
    .tools({
      echo: {
        kind: 'ts',
        description: 'Echoes the query.',
        input: z.object({ query: z.string() }),
        output: z.object({ query: z.string() }),
        handler: async (_ctx, input) => input,
      },
    })
    .skills({})
    .agent('a1', agent as never)
}

describe('build-time agent reference validation', () => {
  it('requires sandbox text search when an agent enables built-in grep', () => {
    const provider = new FakeModelProvider()
    const defaultHarness = defineHarness()
      .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
      .agent('answer', { model: 'fast', instructions: 'x', builtinTools: ['grep'] })
      .build()

    expect(defaultHarness.inspect().requiredCapabilities).toContain('sandbox.text_search')
    expect(defaultHarness.inspect().capabilities).toContain('sandbox.text_search')

    const fsOnly = { ...inMemorySandbox(), capabilities: ['sandbox.fs'] as const }
    expect(() =>
      defineHarness()
        .sandbox(fsOnly as never)
        .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
        .agent('answer', { model: 'fast', instructions: 'x', builtinTools: ['grep'] })
        .build(),
    ).toThrow(expect.objectContaining({
      meta: expect.objectContaining({
        reason: 'missing_required_capability',
        id: 'sandbox.text_search',
      }),
    }))
  })

  it('rejects invalid composition values before model-schema projection', () => {
    const provider = new FakeModelProvider()
    const model = { fast: { provider, model: 'fake', capabilities: ['object'] as const } }

		expect(defineHarness().build().inspect().adapters).toEqual(expect.not.arrayContaining([
			expect.objectContaining({ kind: 'model' }),
		]))
    expect(() => defineHarness().models({})).toThrow(
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'missing_models' }) }),
    )
    expect(() => defineHarness().sandbox(undefined, { groups: [1] } as never)).toThrow(
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'invalid_adapter', path: 'sandbox' }) }),
    )
    expect(() => defineHarness().memory(null as never)).toThrow(
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'invalid_adapter', path: 'memory' }) }),
    )
    expect(() => defineHarness().memory({ engine: {} } as never)).toThrow(
      expect.objectContaining({
        meta: expect.objectContaining({ reason: 'invalid_memory_engine', path: 'memory.engine' }),
      }),
    )

    expect(() => defineHarness().defaults({ decisionTimeoutMs: 0 })).toThrow(
      expect.objectContaining({ meta: expect.objectContaining({ path: 'defaults.decisionTimeoutMs' }) }),
    )
    expect(() => defineHarness().defaults({ historyWindow: -1 })).toThrow(
      expect.objectContaining({ meta: expect.objectContaining({ path: 'defaults.historyWindow' }) }),
    )

    expect(() => defineHarness().storage(new InMemoryHarnessStorage()).storage(new InMemoryHarnessStorage())).toThrow(
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'duplicate_adapter', path: 'storage' }) }),
    )
    expect(() => defineHarness().sandbox(inMemorySandbox()).sandbox(inMemorySandbox())).toThrow(
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'duplicate_adapter', path: 'sandbox' }) }),
    )
    expect(() => defineHarness().memory(inMemoryMemoryEngine()).memory(inMemoryMemoryEngine())).toThrow(
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'duplicate_adapter', path: 'memory' }) }),
    )
    expect(() =>
      defineHarness()
        .governance(({ native, rule }) => ({
          policies: [native({ id: 'allow', rules: [rule({ id: 'allow-all', effect: 'allow' })] })],
        }))
        .governance(({ native, rule }) => ({
          policies: [native({ id: 'again', rules: [rule({ id: 'allow-all', effect: 'allow' })] })],
        })),
    ).toThrow(
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'duplicate_adapter', path: 'governance' }) }),
    )
  })

  it('keeps skill and delegation references closed before model-schema projection', () => {
    const provider = new FakeModelProvider()
    expect(() =>
      defineHarness()
        .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
        .agent('answer', { model: 'fast', instructions: 'x', builtinTools: false, skills: ['unknown'] } as never)
        .build(),
    ).toThrow(
      expect.objectContaining({
        meta: expect.objectContaining({ reason: 'invalid_agent', path: 'agents.answer.skills' }),
      }),
    )

    expect(() =>
      defineHarness()
        .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
        .skills({ known: { directory: '/does/not/matter' } })
        .agent('answer', { model: 'fast', instructions: 'x', builtinTools: false, skills: ['known'] } as never)
        .build(),
    ).toThrow(SkillManifestError)

    expect(() =>
      defineHarness()
        .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
        .agent('answer', { model: 'fast', instructions: 'x', builtinTools: false })
        .workflow('dispatch', { delegation: { agents: ['unknown'] }, handler: async () => null } as never)
        .build(),
    ).toThrow(
      expect.objectContaining({
        meta: expect.objectContaining({ reason: 'invalid_workflow', path: 'workflows.dispatch.delegation.agents' }),
      }),
    )
  })

  it('accepts ordinary native definitions across spreads and captured-map reuse', () => {
    const authored: TsToolDefinition<z.ZodString, z.ZodString> = {
      description: 'Echoes.',
      input: z.string(),
      output: z.string(),
      handler: async (_ctx: unknown, input: string) => input,
    }
    const models = { fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] as const } }

    expect(() => defineHarness().models(models).tools({ echo: { ...authored } }).build()).not.toThrow()
    expect(Object.getOwnPropertySymbols(authored)).toEqual([])
    expect(() => defineHarness().models(models).tools({ echo: authored }).build()).not.toThrow()
  })

  it('treats an omitted kind as native and rejects malformed native definitions', () => {
    const native = {
      description: 'Echoes.',
      input: z.string(),
      output: z.string(),
      handler: async (_ctx: unknown, input: string) => input,
    } as never

    expect(() =>
      defineHarness()
        .sandbox(inMemorySandbox())
        .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
        .tools({ echo: native }),
    ).not.toThrow()

    expect(() =>
      defineHarness()
        .sandbox(inMemorySandbox())
        .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
        .tools({ echo: { ...native, handler: 'not-a-function' } as never }),
    ).toThrow(expect.objectContaining({ meta: { reason: 'invalid_tool', path: 'tools.echo', id: 'echo' } }))
  })

  it('rejects agents referencing an unknown model alias', () => {
    const builder = builderWith({
      model: 'ghost_alias',
      input: z.string(),
      output: z.string(),
      builtinTools: false,
      instructions: 'x',
    })
    let thrown: unknown
    try {
      builder.build()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HarnessConfigError)
    expect(thrown).toMatchObject({
      meta: expect.objectContaining({ reason: 'invalid_agent', path: 'agents.a1.model', id: 'ghost_alias' }),
    })
  })

  it('rejects agents referencing an unknown tool id', () => {
    const builder = builderWith({
      model: 'fast',
      input: z.string(),
      output: z.string(),
      builtinTools: false,
      tools: ['ghost_tool'],
      instructions: 'x',
    })
    let thrown: unknown
    try {
      builder.build()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HarnessConfigError)
    expect(thrown).toMatchObject({
      meta: expect.objectContaining({ reason: 'invalid_agent', path: 'agents.a1.tools', id: 'ghost_tool' }),
    })
  })

  it('accepts agents with valid model and tool references', () => {
    const builder = builderWith({
      model: 'fast',
      input: z.string(),
      output: z.string(),
      builtinTools: false,
      tools: ['echo'],
      instructions: 'x',
    })
    expect(() => builder.build()).not.toThrow()
  })

  it('validates interceptor requirements across direct, helper, and static-module tool registrations without effects', () => {
    const provider = new FakeModelProvider()
    const staticTools = defineHarnessModule<{}>()('requirements.static-tools', {
      register(builder) {
        return builder.tools({
          static_lookup: {
            description: 'Reads a static module record.',
            input: z.object({ id: z.string() }),
            output: z.object({ value: z.string() }),
            handler: async (_ctx, input) => ({ value: input.id }),
          },
        })
      },
    })

    expect(() =>
      defineHarness()
        .use(staticTools)
        .tools({
          helper_lookup: {
            description: 'Reads a helper record.',
            input: z.object({ id: z.string() }),
            output: z.object({ value: z.string() }),
            handler: async (_ctx, input) => ({ value: input.id }),
          },
          remote_lookup: {
            kind: 'mcp_http',
            description: 'Reads a remote record.',
            url: 'https://example.invalid/mcp',
            tool: 'lookup',
          },
        })
        .agent('guarded', {
          model: 'late',
          instructions: 'Use the available tools.',
          tools: ['helper_lookup', 'static_lookup', 'remote_lookup'],
          builtinTools: ['read'],
          interceptors: [
            {
              id: 'requirements',
              requirements: {
                tools: ['helper_lookup', 'static_lookup', 'remote_lookup', 'read'],
                models: [{ alias: 'late', capabilities: ['object'] }],
              },
            },
          ],
        } as never)
        .models({ late: { provider, model: 'late-model', capabilities: ['object'] } })
        .build(),
    ).not.toThrow()
    expect(provider.requests).toEqual([])
  })

  it.each([
    {
      name: 'malformed requirements',
      agent: {
        model: 'fast',
        instructions: 'x',
        builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { tools: [] } }],
      },
    },
    {
      name: 'duplicate required ids',
      agent: {
        model: 'fast',
        instructions: 'x',
        builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { tools: ['echo', 'echo'] } }],
      },
    },
    {
      name: 'duplicate model capabilities',
      agent: {
        model: 'fast',
        instructions: 'x',
        builtinTools: false,
        interceptors: [
          { id: 'requirements', requirements: { models: [{ alias: 'fast', capabilities: ['object', 'object'] }] } },
        ],
      },
    },
    {
      name: 'duplicate model aliases',
      agent: {
        model: 'fast',
        instructions: 'x',
        builtinTools: false,
        interceptors: [
          {
            id: 'requirements',
            requirements: {
              models: [
                { alias: 'fast', capabilities: ['object'] },
                { alias: 'fast', capabilities: ['object'] },
              ],
            },
          },
        ],
      },
    },
    {
      name: 'an unknown required tool',
      agent: {
        model: 'fast',
        instructions: 'x',
        builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { tools: ['missing'] } }],
      },
    },
    {
      name: 'a disabled built-in tool',
      agent: {
        model: 'fast',
        instructions: 'x',
        builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { tools: ['read'] } }],
      },
    },
    {
      name: 'an unknown model alias',
      agent: {
        model: 'fast',
        instructions: 'x',
        builtinTools: false,
        interceptors: [
          { id: 'requirements', requirements: { models: [{ alias: 'missing', capabilities: ['object'] }] } },
        ],
      },
    },
    {
      name: 'an unavailable model capability',
      agent: {
        model: 'fast',
        instructions: 'x',
        builtinTools: false,
        interceptors: [
          { id: 'requirements', requirements: { models: [{ alias: 'fast', capabilities: ['tool_use'] }] } },
        ],
      },
    },
  ])('rejects $name before provider, sandbox, or MCP work', ({ agent }) => {
    const provider = new FakeModelProvider()
    const builder = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
      .agent('guarded', agent as never)

    expect(() => builder.build()).toThrow(
      expect.objectContaining({
        meta: expect.objectContaining({ reason: 'invalid_agent' }),
      }),
    )
    expect(provider.requests).toEqual([])
  })

  it.each([
    { name: 'unknown tool', requirements: { tools: ['missing'] }, id: 'missing' },
    { name: 'disabled built-in', requirements: { tools: ['read'] }, id: 'read' },
    {
      name: 'missing model alias',
      requirements: { models: [{ alias: 'missing', capabilities: ['object'] }] },
      id: 'missing',
    },
    {
      name: 'missing model capability',
      requirements: { models: [{ alias: 'fast', capabilities: ['tool_use'] }] },
      id: 'fast',
    },
  ])('keeps the exact interceptor declaration path for $name', ({ requirements, id }) => {
    const provider = new FakeModelProvider()
    const builder = defineHarness()
      .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
      .agent('guarded', {
        model: 'fast',
        instructions: 'x',
        builtinTools: false,
        interceptors: [{ id: 'first' }, { id: 'requirements', requirements }],
      } as never)

    expect(() => builder.build()).toThrow(
      expect.objectContaining({
        meta: {
          reason: 'invalid_agent',
          path: 'agents.guarded.interceptors.1.requirements',
          id,
        },
      }),
    )
    expect(provider.requests).toEqual([])
  })
})
