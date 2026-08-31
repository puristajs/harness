import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  defineHarness,
  defineHarnessModule,
  JsonLogger,
  type BuilderState,
  type ModelAlias,
  type ModelProvider,
} from '@purista/harness'
import { openai } from '@purista/harness-openai'
import { z } from 'zod'

export const supportTicketInput = z.object({
  customer: z.string(),
  question: z.string(),
})

export const supportTicketOutput = z.object({
  answer: z.string(),
  priority: z.enum(['low', 'normal', 'high']),
})

function loadRootEnv(): void {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const raw = trimmed.slice(eq + 1).trim()
    process.env[key] ??= raw.replace(/^['"]|['"]$/g, '')
  }
}

function requireOpenAiKey(): string {
  loadRootEnv()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) throw new Error('OPENAI_API_KEY is required. Create .env from .env.example in the repository root.')
  return apiKey
}

/** Reusable infrastructure module: the support model alias, not an application workflow. */
export function supportModels(provider: ModelProvider, model: string) {
  return defineHarnessModule<{}>()('support.models', {
    version: '1.0.0',
    register(builder) {
      return builder.models({
        support: { provider, model, capabilities: ['object'], retry: true },
      })
    },
  })
}

type SupportModelState = BuilderState & { models: { support: ModelAlias } }

/** Reusable domain module that depends on the support model alias. */
export const supportAgents = defineHarnessModule<SupportModelState>()('support.agents', {
  version: '1.0.0',
  register(builder) {
    return builder.agent('answer_ticket', {
      model: 'support',
      input: supportTicketInput,
      output: supportTicketOutput,
      instructions: [
        'You are a concise customer-support specialist.',
        'Return JSON with a practical answer and priority low, normal, or high.',
        'Use high only for account access, data loss, or service outage.',
      ].join(' '),
    })
  },
})

/**
 * Application composition: reusable modules supply capabilities; this app owns
 * the customer-facing workflow and its durable conversation history.
 */
export function createModularSupportHarness(provider?: ModelProvider) {
  const model = process.env['OPENAI_MODEL'] ?? 'gpt-5-mini'
  const modelProvider = provider ?? openai({ apiKey: requireOpenAiKey() })

  return defineHarness()
    .logger(new JsonLogger({ level: 'info' }))
    .defaults({
      // Projection is retry-only: durable history remains complete for audit and replay.
      contextProjection: {
        toolResultPruner: { maxBytes: 8_192, headBytes: 3_000, tailBytes: 3_000 },
      },
    })
    .use(supportModels(modelProvider, model))
    .use(supportAgents)
    .workflow('answer_support_ticket', {
      input: supportTicketInput,
      output: supportTicketOutput,
      delegation: { agents: ['answer_ticket'] },
      handler: async (ctx) => {
        await ctx.memory.session.write('last_ticket', { customer: ctx.input.customer })
        return ctx.agents.answer_ticket(ctx.input)
      },
    })
    .build()
}

export async function runModularSupportHarness(): Promise<void> {
  const harness = createModularSupportHarness()
  const session = await harness.getSession('modular-support-demo')
  const response = await session.workflows.answer_support_ticket.run({
    customer: 'Acme Corp',
    question: 'I cannot sign in after resetting my password.',
  })
  console.log(`${response.priority}: ${response.answer}`)
  await harness.shutdown()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runModularSupportHarness().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
