import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { HarnessConfigError, defineHarness, inMemorySandbox } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

const echoTool = {
  kind: 'ts' as const,
  description: 'Echoes the query.',
  input: z.object({ query: z.string() }),
  output: z.object({ query: z.string() }),
  handler: async (ctx: { input: { query: string } }) => ctx.input
}

function builderWith(agent: Record<string, unknown>) {
  return defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
    .tools({ echo: echoTool as never })
    .skills({})
    .agents({ a1: agent as never })
    .workflows({})
}

describe('build-time agent reference validation', () => {
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
})
