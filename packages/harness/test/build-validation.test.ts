import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HarnessConfigError, defineHarness, defineHarnessModule, inMemorySandbox, type RegisteredTsToolDefinition } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

function builderWith(agent: Record<string, unknown>) {
  return defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
    .tools(({ tool }) => ({
      echo: tool({
        kind: 'ts',
        description: 'Echoes the query.',
        input: z.object({ query: z.string() }),
        output: z.object({ query: z.string() }),
        handler: async (_ctx, input) => input
      })
    }))
    .skills({})
    .agents({ a1: agent as never })
    .workflows({})
}

describe('build-time agent reference validation', () => {
  it('brands a shallow native copy that survives spreads and captured-map reuse', () => {
    const authored = {
      description: 'Echoes.',
      input: z.string(),
      output: z.string(),
      handler: async (_ctx: unknown, input: string) => input
    }
    let registered!: RegisteredTsToolDefinition<typeof authored.input, typeof authored.output>
    const models = { fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] as const } }

    defineHarness()
      .models(models)
      .tools(({ tool }) => {
        registered = tool(authored)
        return { echo: { ...registered } }
      })
      .build()

    expect(registered).not.toBe(authored)
    expect(Object.getOwnPropertySymbols(authored)).toEqual([])
    const [brand] = Object.getOwnPropertySymbols(registered)
    expect(brand).toBeDefined()
    expect(Object.getOwnPropertyDescriptor(registered, brand!)).toMatchObject({ value: true, enumerable: true, writable: false, configurable: false })
    expect(JSON.stringify(registered)).not.toContain('purista.harness.registered-tool-definition')

    expect(() => defineHarness().models(models).tools({ echo: registered }).build()).not.toThrow()
  })

  it('rejects an unregistered native tool with an undefined kind in direct and callback maps', () => {
    const rawNative = {
      kind: undefined,
      description: 'Echoes.',
      input: z.string(),
      output: z.string(),
      handler: async (_ctx: unknown, input: string) => input
    } as never

    expect(() => defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .tools({ echo: rawNative })
    ).toThrow(expect.objectContaining({ meta: { reason: 'invalid_tool', path: 'tools.echo', id: 'echo' } }))

    expect(() => defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .tools(() => ({ echo: rawNative }))
    ).toThrow(expect.objectContaining({ meta: { reason: 'invalid_tool', path: 'tools.echo', id: 'echo' } }))
  })

  it('rejects agents referencing an unknown model alias', () => {
    const builder = builderWith({
      model: 'ghost_alias',
      input: z.string(),
      output: z.string(),
      builtinTools: false,
      instructions: 'x'
    })
    let thrown: unknown
    try {
      builder.build()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HarnessConfigError)
    expect(thrown).toMatchObject({
      meta: expect.objectContaining({ reason: 'invalid_agent', path: 'agents.a1.model', id: 'ghost_alias' })
    })
  })

  it('rejects agents referencing an unknown tool id', () => {
    const builder = builderWith({
      model: 'fast',
      input: z.string(),
      output: z.string(),
      builtinTools: false,
      tools: ['ghost_tool'],
      instructions: 'x'
    })
    let thrown: unknown
    try {
      builder.build()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(HarnessConfigError)
    expect(thrown).toMatchObject({
      meta: expect.objectContaining({ reason: 'invalid_agent', path: 'agents.a1.tools', id: 'ghost_tool' })
    })
  })

  it('accepts agents with valid model and tool references', () => {
    const builder = builderWith({
      model: 'fast',
      input: z.string(),
      output: z.string(),
      builtinTools: false,
      tools: ['echo'],
      instructions: 'x'
    })
    expect(() => builder.build()).not.toThrow()
  })

  it('validates interceptor requirements across direct, helper, and static-module tool registrations without effects', () => {
    const provider = new FakeModelProvider()
    const staticTools = defineHarnessModule<{}>()('requirements.static-tools', {
      register(builder) {
        return builder.tools(({ tool }) => ({
          static_lookup: tool({
            description: 'Reads a static module record.',
            input: z.object({ id: z.string() }),
            output: z.object({ value: z.string() }),
            handler: async (_ctx, input) => ({ value: input.id })
          })
        }))
      }
    })

    expect(() => defineHarness()
      .use(staticTools)
      .tools(({ tool }) => ({
        helper_lookup: tool({
          description: 'Reads a helper record.',
          input: z.object({ id: z.string() }),
          output: z.object({ value: z.string() }),
          handler: async (_ctx, input) => ({ value: input.id })
        }),
        remote_lookup: { kind: 'mcp_http', description: 'Reads a remote record.', url: 'https://example.invalid/mcp', tool: 'lookup' }
      }))
      .agents({
        guarded: {
          model: 'late', instructions: 'Use the available tools.', tools: ['helper_lookup', 'static_lookup', 'remote_lookup'],
          interceptors: [{
            id: 'requirements',
            requirements: {
              tools: ['helper_lookup', 'static_lookup', 'remote_lookup', 'read'],
              models: [{ alias: 'late', capabilities: ['object'] }]
            }
          }]
        } as never
      })
      .models({ late: { provider, model: 'late-model', capabilities: ['object'] } })
      .build()
    ).not.toThrow()
    expect(provider.requests).toEqual([])
  })

  it.each([
    {
      name: 'malformed requirements',
      agent: {
        model: 'fast', instructions: 'x', builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { tools: [] } }]
      }
    },
    {
      name: 'duplicate required ids',
      agent: {
        model: 'fast', instructions: 'x', builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { tools: ['echo', 'echo'] } }]
      }
    },
    {
      name: 'duplicate model capabilities',
      agent: {
        model: 'fast', instructions: 'x', builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { models: [{ alias: 'fast', capabilities: ['object', 'object'] }] } }]
      }
    },
    {
      name: 'duplicate model aliases',
      agent: {
        model: 'fast', instructions: 'x', builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { models: [{ alias: 'fast', capabilities: ['object'] }, { alias: 'fast', capabilities: ['object'] }] } }]
      }
    },
    {
      name: 'an unknown required tool',
      agent: {
        model: 'fast', instructions: 'x', builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { tools: ['missing'] } }]
      }
    },
    {
      name: 'a disabled built-in tool',
      agent: {
        model: 'fast', instructions: 'x', builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { tools: ['read'] } }]
      }
    },
    {
      name: 'an unknown model alias',
      agent: {
        model: 'fast', instructions: 'x', builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { models: [{ alias: 'missing', capabilities: ['object'] }] } }]
      }
    },
    {
      name: 'an unavailable model capability',
      agent: {
        model: 'fast', instructions: 'x', builtinTools: false,
        interceptors: [{ id: 'requirements', requirements: { models: [{ alias: 'fast', capabilities: ['tool_use'] }] } }]
      }
    }
  ])('rejects $name before provider, sandbox, or MCP work', ({ agent }) => {
    const provider = new FakeModelProvider()
    const builder = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
      .agents({ guarded: agent as never })

    expect(() => builder.build()).toThrow(expect.objectContaining({
      meta: expect.objectContaining({ reason: 'invalid_agent' })
    }))
    expect(provider.requests).toEqual([])
  })

  it.each([
    { name: 'unknown tool', requirements: { tools: ['missing'] }, id: 'missing' },
    { name: 'disabled built-in', requirements: { tools: ['read'] }, id: 'read' },
    { name: 'missing model alias', requirements: { models: [{ alias: 'missing', capabilities: ['object'] }] }, id: 'missing' },
    { name: 'missing model capability', requirements: { models: [{ alias: 'fast', capabilities: ['tool_use'] }] }, id: 'fast' }
  ])('keeps the exact interceptor declaration path for $name', ({ requirements, id }) => {
    const provider = new FakeModelProvider()
    const builder = defineHarness()
      .models({ fast: { provider, model: 'fake', capabilities: ['object'] } })
      .agents({
        guarded: {
          model: 'fast', instructions: 'x', builtinTools: false,
          interceptors: [{ id: 'first' }, { id: 'requirements', requirements }]
        } as never
      })

    expect(() => builder.build()).toThrow(expect.objectContaining({
      meta: {
        reason: 'invalid_agent',
        path: 'agents.guarded.interceptors.1.requirements',
        id
      }
    }))
    expect(provider.requests).toEqual([])
  })
})
