import { z } from 'zod'
import { expect, it } from 'vitest'
import { HarnessConfigError, InMemoryStateStore, JsonLogger, defineHarness, defineHarnessModule, inMemorySandbox, sandboxMemory } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import type { BuilderState, ModelAlias } from '../src/index.js'

const model = new FakeModelProvider()

const modelsModule = defineHarnessModule<{}>()('support.models', {
  version: '1.0.0',
  requires: ['sandbox.fs'],
  register(builder) {
    return builder.models({ support: { provider: model, model: 'support-v1', capabilities: ['object'] } })
  }
})

type SupportModelState = BuilderState & { models: { support: ModelAlias } }
const agentsModule = defineHarnessModule<SupportModelState>()('support.agents', {
  register(builder) {
    return builder.agents(({ agent }) => ({
      answer: agent({
        model: 'support',
        input: z.object({ question: z.string() }),
        output: z.object({ answer: z.string() }),
        instructions: 'Answer the support question.',
        builtinTools: false,
        handler: async (ctx) => ({ answer: ctx.input.question })
      })
    }))
  }
})

it('composes local modules and exposes immutable, ordered provenance', async () => {
  const harness = defineHarness().use(modelsModule).use(agentsModule).build()
  const inspection = harness.inspect()
  expect(inspection.modules).toEqual([
    {
      id: 'support.models',
      version: '1.0.0',
      requires: ['sandbox.fs'],
      contributions: [{ kind: 'model', ids: ['support'] }]
    },
    {
      id: 'support.agents',
      requires: [],
      contributions: [{ kind: 'agent', ids: ['answer'] }]
    }
  ])
  expect(Object.isFrozen(inspection.modules)).toBe(true)
  expect(Object.isFrozen(inspection.modules[0]?.contributions)).toBe(true)
  const session = await harness.getSession('static-modules')
  await expect(session.agents.answer.prompt({ question: 'How are you?' })).resolves.toEqual({ answer: 'How are you?' })
})

it('rejects duplicate module ids and definition ids without overwriting earlier state', () => {
  let duplicateModuleError: unknown
  try {
    defineHarness().use(modelsModule).use(modelsModule)
  } catch (error) {
    duplicateModuleError = error
  }
  expect(duplicateModuleError).toBeInstanceOf(HarnessConfigError)
  expect((duplicateModuleError as HarnessConfigError).meta).toMatchObject({ reason: 'duplicate_module', id: 'support.models' })

  const collision = defineHarnessModule<SupportModelState>()('support.collision', {
    register(builder) {
      return builder.models({ support: { provider: model, model: 'other', capabilities: ['object'] } })
    }
  })
  const source = defineHarness().use(modelsModule)
  expect(() => source.use(collision)).toThrow(HarnessConfigError)
  expect(source.use(agentsModule).build().inspect().modules.map((entry) => entry.id)).toEqual(['support.models', 'support.agents'])
})

it('rejects a builder facade captured by a different module invocation', () => {
  let captured: ReturnType<typeof defineHarnessModule<{}>> extends never ? never : unknown
  const first = defineHarnessModule<{}>()('capture.first', {
    register(builder) {
      captured = builder
      return builder.models({ support: { provider: model, model: 'support-v1', capabilities: ['object'] } })
    }
  })
  const stale = defineHarnessModule<{}>()('capture.stale', {
    register() {
      return (captured as { tools: (tools: Record<string, unknown>) => unknown }).tools({}) as never
    }
  })
  try {
    defineHarness().use(first).use(stale)
    throw new Error('Expected stale module facade to be rejected.')
  } catch (error) {
    expect(error).toMatchObject({ meta: { reason: 'invalid_module' } })
  }
})

it('keeps failed module registration atomic and validates module identities', () => {
  const invalid = defineHarnessModule<{}>()('Bad identity', {
    register(builder) {
      return builder.models({ extra: { provider: model, model: 'extra', capabilities: ['object'] } })
    }
  })
  let invalidModuleError: unknown
  try {
    defineHarness().use(invalid)
  } catch (error) {
    invalidModuleError = error
  }
  expect(invalidModuleError).toBeInstanceOf(HarnessConfigError)
  expect((invalidModuleError as HarnessConfigError).meta).toMatchObject({ reason: 'invalid_module' })

  const throwing = defineHarnessModule<SupportModelState>()('support.throwing', {
    register() {
      throw new Error('deliberate')
    }
  })
  const source = defineHarness().use(modelsModule)
  expect(() => source.use(throwing)).toThrow('deliberate')
  expect(source.use(agentsModule).build().inspect().modules.map((entry) => entry.id)).toEqual(['support.models', 'support.agents'])
})

it('closes each configured closable resource once, continues after failure, and coalesces shutdown', async () => {
  const calls: string[] = []
  const sharedProvider = new FakeModelProvider() as FakeModelProvider & { close: () => Promise<void> }
  sharedProvider.close = async () => { calls.push('provider'); throw new Error('provider close failed') }
  const state = new InMemoryStateStore() as InMemoryStateStore & { close: () => Promise<void> }
  state.close = async () => { calls.push('state') }
  const memory = sandboxMemory() as ReturnType<typeof sandboxMemory> & { close: () => Promise<void> }
  memory.close = async () => { calls.push('memory') }
  const sandbox = inMemorySandbox() as ReturnType<typeof inMemorySandbox> & { close: () => Promise<void> }
  sandbox.close = async () => { calls.push('sandbox') }
  const logger = new JsonLogger() as JsonLogger & { close: () => Promise<void> }
  logger.close = async () => { calls.push('logger') }

  const harness = defineHarness()
    .logger(logger)
    .state(state)
    .sandbox(sandbox)
    .memory(memory)
    .models({ first: { provider: sharedProvider, model: 'one', capabilities: ['object'] }, second: { provider: sharedProvider, model: 'two', capabilities: ['object'] } })
    .agents({ answer: { model: 'first', input: z.string(), output: z.string(), instructions: 'x', builtinTools: false, handler: async (input) => input.input } })
    .build()

  const [first, second] = await Promise.all([harness.shutdown(), harness.shutdown()])
  expect(calls).toEqual(['provider', 'memory', 'sandbox', 'state', 'logger'])
  expect(first.errors).toHaveLength(1)
  expect(second.errors).toHaveLength(1)
  await harness.shutdown()
  expect(calls).toEqual(['provider', 'memory', 'sandbox', 'state', 'logger'])
})
