import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { defineHarness, localDurableExecution, type JsonValue, type ModelProvider, type ObjectRequest, type ObjectResponse } from '@purista/harness'

class NoopProvider implements ModelProvider {
  readonly id = 'noop'
  readonly genAiSystem = 'example'
  async object<T extends JsonValue = JsonValue>(_req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    return { object: {} as T, finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
  }
}

const planInput = z.object({ topic: z.string(), failAfterFirstStep: z.boolean().default(false) })
const planOutput = z.object({ done: z.boolean(), topic: z.string() })

export async function createLocalDurableHarness(root?: string) {
  const local = localDurableExecution({ root: root ?? await mkdtemp(join(tmpdir(), 'purista-local-durable-')), exec: false })
  const provider = new NoopProvider()
  const harness = defineHarness()
    .state(local.state)
    .runtime(local.runtime)
    .sandbox(local.sandbox)
    .workspaceStore(local.workspaceStore)
    .checkpoints(local.checkpoints)
    .requires(['runtime.persistent', 'workspace_store.persistent', 'context_checkpoint.persistent'])
    .models({ noop: { provider, model: 'noop', capabilities: ['object'] } })
    .tools({})
    .skills({})
    .agents({ noop: { model: 'noop', instructions: 'No model call is needed.', builtinTools: false } })
    .workflows(({ workflow }) => ({
      plan: workflow({
        input: planInput,
        output: planOutput,
        handler: async (ctx) => {
          await ctx.step('outline', async () => {
            await ctx.checkpoints.write({
              sequence: 1,
              kind: 'summary',
              payload: { topic: ctx.input.topic, next: 'draft' }
            })
            return { outline: true }
          })
          if (ctx.input.failAfterFirstStep) throw new Error('simulated crash')
          await ctx.step('draft', async () => ({ draft: true }))
          return { done: true, topic: ctx.input.topic }
        }
      })
    }))
    .build()
  return { local, harness }
}

export async function runLocalDurableExample(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'purista-local-durable-'))
  const first = await createLocalDurableHarness(root)
  const firstSession = await first.harness.getSession('demo')
  await firstSession.workflows.plan.prompt({ topic: 'durable local work', failAfterFirstStep: true }, { durable: { runId: 'demo-run' } }).catch(() => undefined)
  await first.harness.shutdown()

  const second = await createLocalDurableHarness(root)
  const secondSession = await second.harness.getSession('demo')
  const result = await secondSession.workflows.plan.prompt({ topic: 'durable local work', failAfterFirstStep: false }, { durable: { runId: 'demo-run' } })
  console.log(result)
  await second.harness.shutdown()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLocalDurableExample().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
