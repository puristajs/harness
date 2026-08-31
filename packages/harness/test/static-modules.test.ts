import { z } from 'zod'
import { expect, it } from 'vitest'
import {
  HarnessConfigError,
  InMemoryHarnessStorage,
  JsonLogger,
  defineHarness,
  defineHarnessModule,
  inMemoryMemoryEngine,
  inMemorySandbox,
} from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import type { BuilderState, ModelAlias } from '../src/index.js'

const model = new FakeModelProvider()

const modelsModule = defineHarnessModule<{}>()('support.models', {
  version: '1.0.0',
  requires: ['sandbox.fs'],
  register(builder) {
    return builder.models({ support: { provider: model, model: 'support-v1', capabilities: ['object'] } })
  },
})

type SupportModelState = BuilderState & { models: { support: ModelAlias } }
const agentsModule = defineHarnessModule<SupportModelState>()('support.agents', {
  register(builder) {
    return builder.agent('answer', {
      model: 'support',
      input: z.object({ question: z.string() }),
      output: z.object({ answer: z.string() }),
      instructions: 'Answer the support question.',
      builtinTools: false,
      handler: async (ctx) => ({ answer: ctx.input.question }),
    })
  },
})

const directToolsModule = defineHarnessModule<{}>()('support.direct-tools', {
  register(builder) {
    return builder.tools({
      lookup: {
        description: 'Looks up one support record.',
        input: z.object({ id: z.string() }),
        output: z.object({ value: z.string() }),
        handler: async (_ctx, input) => ({ value: input.id }),
      },
    })
  },
})

it('composes local modules and exposes immutable, ordered provenance', async () => {
  const harness = defineHarness().use(modelsModule).use(agentsModule).build()
  const inspection = harness.inspect()
  expect(inspection.modules).toEqual([
    {
      id: 'support.models',
      version: '1.0.0',
      requires: ['sandbox.fs'],
      contributions: [{ kind: 'model', ids: ['support'] }],
    },
    {
      id: 'support.agents',
      requires: [],
      contributions: [{ kind: 'agent', ids: ['answer'] }],
    },
  ])
  expect(Object.isFrozen(inspection.modules)).toBe(true)
  expect(Object.isFrozen(inspection.modules[0]?.contributions)).toBe(true)
  const session = await harness.getSession('static-modules')
  await expect(session.agents.answer.run({ question: 'How are you?' })).resolves.toEqual({ answer: 'How are you?' })
})

it('registers native tools through the static-module builder', () => {
  const harness = defineHarness()
    .models({ support: { provider: model, model: 'support-v1', capabilities: ['object'] } })
    .use(directToolsModule)
    .build()
  expect(harness.inspect().modules).toEqual([
    {
      id: 'support.direct-tools',
      requires: [],
      contributions: [{ kind: 'tool', ids: ['lookup'] }],
    },
  ])
})

it('rejects a malformed static-module native tool', () => {
  const invalidToolsModule = defineHarnessModule<{}>()('support.invalid-tools', {
    register: (builder) =>
      builder.tools({
        lookup: {
          description: 'Raw lookup.',
          input: z.string(),
          output: z.string(),
          handler: 'not-a-function',
        } as never,
      }),
  })

  expect(() => defineHarness().use(invalidToolsModule)).toThrow(
    expect.objectContaining({ meta: { reason: 'invalid_tool', path: 'tools.lookup', id: 'lookup' } }),
  )
})

it('rejects duplicate module ids and definition ids without overwriting earlier state', () => {
  let duplicateModuleError: unknown
  try {
    defineHarness().use(modelsModule).use(modelsModule)
  } catch (error) {
    duplicateModuleError = error
  }
  expect(duplicateModuleError).toBeInstanceOf(HarnessConfigError)
  expect((duplicateModuleError as HarnessConfigError).meta).toMatchObject({
    reason: 'duplicate_module',
    id: 'support.models',
  })

  const collision = defineHarnessModule<SupportModelState>()('support.collision', {
    register(builder) {
      return builder.models({ support: { provider: model, model: 'other', capabilities: ['object'] } })
    },
  })
  const source = defineHarness().use(modelsModule)
  expect(() => source.use(collision)).toThrow(HarnessConfigError)
  expect(
    source
      .use(agentsModule)
      .build()
      .inspect()
      .modules.map((entry) => entry.id),
  ).toEqual(['support.models', 'support.agents'])
})

it('accumulates singular and plural agent and workflow registrations', async () => {
  const harness = defineHarness()
    .models({ support: { provider: model, model: 'support-v1', capabilities: ['object'] } })
    .agent('classify', {
      model: 'support',
      input: z.string(),
      output: z.string(),
      instructions: 'Classify the request.',
      handler: async ({ input }) => input,
    })
    .agents({
      summarize: {
        model: 'support',
        input: z.string(),
        output: z.string(),
        instructions: 'Summarize the request.',
        handler: async ({ input }: { input: string }) => input,
      },
    })
    .workflow('triage', {
      input: z.string(),
      output: z.string(),
      handler: async ({ input }) => input,
    })
    .workflows({
      resolve: {
        input: z.string(),
        output: z.string(),
        handler: async ({ input }: { input: string }) => input,
      },
    })
    .build()

  const session = await harness.getSession('mixed-registration')
  await expect(session.agents.classify.run('urgent')).resolves.toBe('urgent')
  await expect(session.agents.summarize.run('short')).resolves.toBe('short')
  await expect(session.workflows.triage.run('new')).resolves.toBe('new')
  await expect(session.workflows.resolve.run('fixed')).resolves.toBe('fixed')
})

it('rejects duplicate ids across singular and plural registrations', () => {
  const agents = defineHarness()
    .models({ support: { provider: model, model: 'support-v1', capabilities: ['object'] } })
    .agent('answer', { model: 'support', instructions: 'Answer.' })

  expect(() => agents.agents({ answer: { model: 'support', instructions: 'Answer again.' } })).toThrow(
    expect.objectContaining({ meta: { reason: 'duplicate_definition', path: 'agents.answer', id: 'answer' } }),
  )

  const workflows = agents.workflow('respond', { handler: async ({ input }) => input })
  expect(() => workflows.workflows({ respond: { handler: async ({ input }: { input: string }) => input } })).toThrow(
    expect.objectContaining({ meta: { reason: 'duplicate_definition', path: 'workflows.respond', id: 'respond' } }),
  )
})

it('accumulates singular and plural definitions contributed by one module', () => {
  const mixedModule = defineHarnessModule<SupportModelState>()('support.mixed', {
    register(builder) {
      return builder
        .agent('answer', { model: 'support', instructions: 'Answer.' })
        .agents({ summarize: { model: 'support', instructions: 'Summarize.' } })
        .workflow('answer_flow', { handler: async ({ input }) => input })
        .workflows({ summarize_flow: { handler: async ({ input }: { input: string }) => input } })
    },
  })

  expect(defineHarness().use(modelsModule).use(mixedModule).build().inspect().modules.at(-1)?.contributions).toEqual([
    { kind: 'agent', ids: ['answer', 'summarize'] },
    { kind: 'workflow', ids: ['answer_flow', 'summarize_flow'] },
  ])
})

it('rejects a builder facade captured by a different module invocation', () => {
  let captured: ReturnType<typeof defineHarnessModule<{}>> extends never ? never : unknown
  const first = defineHarnessModule<{}>()('capture.first', {
    register(builder) {
      captured = builder
      return builder.models({ support: { provider: model, model: 'support-v1', capabilities: ['object'] } })
    },
  })
  const stale = defineHarnessModule<{}>()('capture.stale', {
    register() {
      return (captured as { tools: (tools: Record<string, unknown>) => unknown }).tools({}) as never
    },
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
    },
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
    },
  })
  const source = defineHarness().use(modelsModule)
  expect(() => source.use(throwing)).toThrow('deliberate')
  expect(
    source
      .use(agentsModule)
      .build()
      .inspect()
      .modules.map((entry) => entry.id),
  ).toEqual(['support.models', 'support.agents'])
})

it('closes each configured closable resource once, continues after failure, and coalesces shutdown', async () => {
  const calls: string[] = []
  const sharedProvider = new FakeModelProvider() as FakeModelProvider & { close: () => Promise<void> }
  sharedProvider.close = async () => {
    calls.push('provider')
    throw new Error('provider close failed')
  }
  const state = new InMemoryHarnessStorage() as InMemoryHarnessStorage & { close: () => Promise<void> }
  state.close = async () => {
    calls.push('state')
  }
  const memory = inMemoryMemoryEngine() as ReturnType<typeof inMemoryMemoryEngine> & { close: () => Promise<void> }
  memory.close = async () => {
    calls.push('memory')
  }
  const sandbox = inMemorySandbox() as ReturnType<typeof inMemorySandbox> & { close: () => Promise<void> }
  sandbox.close = async () => {
    calls.push('sandbox')
  }
  const logger = new JsonLogger() as JsonLogger & { close: () => Promise<void> }
  logger.close = async () => {
    calls.push('logger')
  }

  const harness = defineHarness()
    .logger(logger)
    .storage(state)
    .sandbox(sandbox)
    .memory(memory)
    .models({
      first: { provider: sharedProvider, model: 'one', capabilities: ['object'] },
      second: { provider: sharedProvider, model: 'two', capabilities: ['object'] },
    })
    .agent('answer', {
      model: 'first',
      input: z.string(),
      output: z.string(),
      instructions: 'x',
      builtinTools: false,
      handler: async (input) => input.input,
    })
    .build()

  const [first, second] = await Promise.all([harness.shutdown(), harness.shutdown()])
  expect(calls).toEqual(['provider', 'memory', 'sandbox', 'state', 'logger'])
  expect(first.errors).toHaveLength(1)
  expect(second.errors).toHaveLength(1)
  await harness.shutdown()
  expect(calls).toEqual(['provider', 'memory', 'sandbox', 'state', 'logger'])
})
