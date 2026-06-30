import { z } from 'zod'
import { defineHarness } from '../src/harness/defineHarness.js'
import { createModelRegistry } from '../src/models/registry.js'
import { inMemorySandbox, sandboxMemory } from '../src/index.js'
import type { BuilderState, Harness, HarnessBuilder, ModelsConfig } from '../src/harness/defineHarness.js'
import type { AdapterCapability, HarnessInspection } from '../src/ports/capabilities.js'
import type { JsonValue, ModelProvider, ObjectRequest, ObjectResponse } from '../src/index.js'
import type { Logger } from '../src/logger/index.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false

const provider: ModelProvider = {
  id: 'type-test-provider',
  genAiSystem: 'type-test',
  async object<T extends JsonValue = JsonValue>(_req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    return {
      object: 'ok' as unknown as T,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: 'stop'
    }
  }
}

const harness = defineHarness()
  .memory(sandboxMemory())
  .models({
    assistant: { provider, model: 'type-test-model', capabilities: ['object'] },
    reviewer: { provider, model: 'type-test-reviewer-model', capabilities: ['object'] }
  })
  .tools({
    transfer_funds: {
      description: 'Transfer funds between accounts.',
      input: z.object({ amount: z.number(), balance: z.number() }),
      output: z.object({ approved: z.boolean() }),
      handler: async () => ({ approved: true })
    }
  })
  .agents(({ agent }) => ({
    planner: agent({
      model: 'assistant',
      input: z.object({ task: z.string(), priority: z.number() }),
      output: z.object({ plan: z.string(), accepted: z.boolean() }),
      instructions: (ctx) => {
        type Input = typeof ctx.input
        const _inputIsNotAny: IsAny<Input> extends true ? 'any' : 'ok' = 'ok'
        const _inputExact: Expect<Equal<Input, { task: string; priority: number }>> = true
        const _memoryRead = ctx.memory.session.read<{ value: string }>('topic')
        void _memoryRead
        return `Plan ${ctx.input.task} at priority ${ctx.input.priority}.`
      },
      handler: async (ctx) => {
        type Input = typeof ctx.input
        const _inputIsNotAny: IsAny<Input> extends true ? 'any' : 'ok' = 'ok'
        const _inputExact: Expect<Equal<Input, { task: string; priority: number }>> = true
        await ctx.memory.run.write('plan_input', { task: ctx.input.task })
        await ctx.memory.agent?.write('last_priority', ctx.input.priority)
        return { plan: ctx.input.task, accepted: ctx.input.priority > 0 }
      }
    })
  }))
  .workflows(({ workflow }) => ({
    prepare: workflow({
      input: z.object({ task: z.string() }),
      output: z.object({ plan: z.string(), accepted: z.boolean() }),
      delegation: {
        agents: ['planner'],
        agentModelAliases: { planner: ['assistant', 'reviewer'] },
        maxChildAgentCalls: 2,
        maxParallelChildAgentCalls: 1
      },
      handler: async (ctx) => {
        type Input = typeof ctx.input
        const _inputIsNotAny: IsAny<Input> extends true ? 'any' : 'ok' = 'ok'
        const _inputExact: Expect<Equal<Input, { task: string }>> = true
        // Spec 10 `WorkflowContext`: handlers receive the harness logger.
        const _logIsLogger: Expect<Equal<typeof ctx.log, Logger>> = true
        ctx.log.debug('workflow handler logging is typed')
        await ctx.memory.session.write('workflow_task', { task: ctx.input.task })
        await ctx.memory.run.write('workflow_seen', true)
        await ctx.memory.user('u1').write('workflow_user', 'ok')

        const plan = await ctx.agents.planner({ task: ctx.input.task, priority: 1 })
        type PlanOutput = typeof plan
        const _agentOutputExact: Expect<Equal<PlanOutput, { plan: string; accepted: boolean }>> = true
        const reviewedPlan = await ctx.agents.planner({ task: ctx.input.task, priority: 1 }, { model: 'reviewer' })
        const _reviewedAgentOutputExact: Expect<Equal<typeof reviewedPlan, { plan: string; accepted: boolean }>> = true
        // @ts-expect-error workflow-local agent model overrides must use configured model aliases
        await ctx.agents.planner({ task: ctx.input.task, priority: 1 }, { model: 'missing' })

        return plan
      }
    }),
    invalid_output: workflow({
      input: z.object({ task: z.string() }),
      output: z.object({ plan: z.string(), accepted: z.boolean() }),
      // @ts-expect-error workflow handlers must return the sibling output schema type
      handler: async (ctx) => ctx.input.task
    })
  }))
  .governance(({ native, rule }) => ({
    defaultEffect: 'allow',
    policies: [
      native({
        id: 'typed-bank-policy',
        rules: [
          rule({
            id: 'insufficient-funds',
            effect: 'deny',
            tools: ['transfer_funds'],
            when: (ctx) => {
              type Input = typeof ctx.input
              const _inputIsNotAny: IsAny<Input> extends true ? 'any' : 'ok' = 'ok'
              const _inputExact: Expect<Equal<Input, { amount: number; balance: number }>> = true
              return ctx.input.balance < ctx.input.amount
            }
          }),
          rule({
            id: 'bad-field',
            effect: 'deny',
            tools: ['transfer_funds'],
            // @ts-expect-error governance predicates use the selected tool input schema
            when: (ctx) => ctx.input.currency === 'EUR'
          })
        ]
      })
    ]
  }))
  .build()

defineHarness()
  .models({
    assistant: { provider, model: 'type-test-model', capabilities: ['object', 'tool_use'] }
  })
  .tools({
    transfer_funds: {
      description: 'Transfer funds.',
      input: z.object({ amount: z.number(), balance: z.number() }),
      output: z.object({ ok: z.boolean() }),
      handler: async () => ({ ok: true })
    }
  })
  .agents(({ agent }) => ({
    banker: agent({
      model: 'assistant',
      input: z.string(),
      output: z.string(),
      tools: ['transfer_funds'],
      builtinTools: false,
      instructions: 'Transfer funds.'
    })
  }))
  .governance(({ exposureRule }) => ({
    exposure: {
      rules: [
        exposureRule({
          id: 'hide-transfers',
          effect: 'hide',
          tools: ['transfer_funds'],
          when: (ctx) => {
            type ToolId = typeof ctx.toolId
            const _toolIdExact: Expect<Equal<ToolId, 'transfer_funds'>> = true
            return ctx.step >= 0
          }
        }),
        exposureRule({
          id: 'bad-exposure-tool',
          effect: 'hide',
          // @ts-expect-error governance exposure rules must reference known tools
          tools: ['missing_tool']
        })
      ]
    }
  }))
  .build()

type PrepareInput = typeof harness.$infer.workflows.prepare.input
type PrepareOutput = typeof harness.$infer.workflows.prepare.output
type PlannerInput = typeof harness.$infer.agents.planner.input
type PlannerOutput = typeof harness.$infer.agents.planner.output

const _workflowInputExact: Expect<Equal<PrepareInput, { task: string }>> = true
const _workflowOutputExact: Expect<Equal<PrepareOutput, { plan: string; accepted: boolean }>> = true
const _agentInputExact: Expect<Equal<PlannerInput, { task: string; priority: number }>> = true
const _agentOutputExact: Expect<Equal<PlannerOutput, { plan: string; accepted: boolean }>> = true

async function invokeWorkflow() {
  const session = await harness.getSession('type-test')
  const agentOutput = await session.agents.planner.prompt({ task: 'ship typing', priority: 1 })
  const _agentInvokeOutputExact: Expect<Equal<typeof agentOutput, { plan: string; accepted: boolean }>> = true

  // @ts-expect-error agent prompt input must match the sibling input schema
  await session.agents.planner.prompt({ task: 'missing priority' })

  const output = await session.workflows.prepare.prompt({ task: 'ship typing' })
  const _outputExact: Expect<Equal<typeof output, { plan: string; accepted: boolean }>> = true

  // @ts-expect-error workflow prompt input must match the sibling input schema
  await session.workflows.prepare.prompt({ topic: 'wrong key' })
}

type CapabilityAwareBuilder<S extends BuilderState> = Omit<HarnessBuilder<S>, 'build' | 'models'> & {
  requires(required: readonly AdapterCapability[]): CapabilityAwareBuilder<S>
  models<const M extends ModelsConfig>(models: M): CapabilityAwareBuilder<S & { models: M }>
  build(): Harness<S> & { inspect(): HarnessInspection }
}

const futureCapabilityHarness = (defineHarness() as CapabilityAwareBuilder<{}>)
  .requires(['sandbox.snapshot', 'sandbox.resume', 'runtime.checkpoint'])
  .models({
    assistant: { provider, model: 'type-test-model', capabilities: ['object'] }
  })
  .build()

const futureCapabilities = futureCapabilityHarness.inspect().capabilities
type AdapterCapabilityList = readonly AdapterCapability[]
const _futureCapabilitiesExact: Expect<Equal<typeof futureCapabilities, AdapterCapabilityList>> = true

// @ts-expect-error requires only accepts stable AdapterCapability values
const _invalidFutureRequirement: AdapterCapability = 'sandbox.teleport'
const _validMemoryRequirement: AdapterCapability = 'memory.persistent'

const capabilityRegistry = createModelRegistry({
  textOnly: { provider, model: 'type-test-model', capabilities: ['text'] },
  streamReady: { provider, model: 'type-test-model', capabilities: ['text_stream'] },
  embeddingReady: { provider, model: 'type-test-model', capabilities: ['text', 'embeddings'] }
})

capabilityRegistry['textOnly']!.text({ messages: [] }, new AbortController().signal)
// @ts-expect-error tools require the tool_use marker capability
capabilityRegistry['textOnly']!.text({ messages: [], tools: [] }, new AbortController().signal)
// @ts-expect-error image parts require the vision_input marker capability
capabilityRegistry['textOnly']!.text({ messages: [{ role: 'user', content: [{ kind: 'image_url', url: 'https://example.com/image.png' }] }] }, new AbortController().signal)
// @ts-expect-error embeddings are not exposed unless the alias declares the embeddings capability
capabilityRegistry['textOnly']!.embed({ input: 'hello' }, new AbortController().signal)
capabilityRegistry['embeddingReady']!.embed({ input: 'hello' }, new AbortController().signal)
// @ts-expect-error rerank is not exposed unless the alias declares the rerank capability
capabilityRegistry['embeddingReady']!.rerank({ query: 'hello', documents: [] }, new AbortController().signal)
capabilityRegistry['streamReady']!.textStream({ messages: [] }, new AbortController().signal, { emitRunEvents: true })
// @ts-expect-error streamId is harness-generated and not caller-provided
capabilityRegistry['streamReady']!.textStream({ messages: [] }, new AbortController().signal, { emitRunEvents: true, streamId: 'public-answer' })
// @ts-expect-error app-specific stream names belong in the integration layer
capabilityRegistry['streamReady']!.textStream({ messages: [] }, new AbortController().signal, { emitRunEvents: true, streamKey: 'public-answer' })

const richCapabilityRegistry = createModelRegistry({
  visionToolModel: { provider, model: 'type-test-model', capabilities: ['text', 'tool_use', 'vision_input'] }
})

richCapabilityRegistry['visionToolModel']!.text({
  messages: [{ role: 'user', content: [{ kind: 'image_url', url: 'https://example.com/image.png' }] }],
  tools: []
}, new AbortController().signal)
// @ts-expect-error audio parts require the audio_input marker capability
richCapabilityRegistry['visionToolModel']!.text({ messages: [{ role: 'user', content: [{ kind: 'audio', mimeType: 'audio/wav', dataBase64: 'abc' }] }] }, new AbortController().signal)

async function sandboxCapabilityTypes() {
  const session = await inMemorySandbox().open({ sessionId: 'type-session', runId: 'type-run' })
  await session.readText('/workspace/file.txt')
  // @ts-expect-error files-only sandbox sessions do not expose exec
  await session.exec('echo hi')
}

defineHarness()
  .models({
    textOnly: { provider, model: 'type-test-model', capabilities: ['text'] },
    embeddingReady: { provider, model: 'type-test-model', capabilities: ['text', 'embeddings'] }
  })
  .agents(({ agent }) => ({
    typed_models: agent({
      model: 'textOnly',
      input: z.string(),
      output: z.string(),
      instructions: 'Use typed models.',
      handler: async (ctx) => {
        await ctx.models.textOnly.text({ messages: [] }, ctx.signal)
        // @ts-expect-error handler model handles only expose declared capabilities
        await ctx.models.textOnly.embed({ input: 'hello' }, ctx.signal)
        await ctx.models.embeddingReady.embed({ input: 'hello' }, ctx.signal)
        return ctx.input
      }
    })
  }))
  .workflows(({ workflow }) => ({
    typed_workflow_models: workflow({
      input: z.string(),
      output: z.string(),
      handler: async (ctx) => {
        await ctx.models.textOnly.text({ messages: [] }, ctx.signal)
        // @ts-expect-error workflow model handles only expose declared capabilities
        await ctx.models.textOnly.embed({ input: 'hello' }, ctx.signal)
        await ctx.models.embeddingReady.embed({ input: 'hello' }, ctx.signal)
        return ctx.input
      }
    })
  }))
