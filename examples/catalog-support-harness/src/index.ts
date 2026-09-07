import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  defineAgent,
  defineCatalog,
  defineHarness,
  defineWorkflow,
  JsonLogger,
  type ModelProvider,
} from '@purista/harness'
import { openai } from '@purista/harness-openai'
import { z } from 'zod'

export const supportTicketInput = z.object({ customer: z.string(), question: z.string() })
export const supportTicketOutput = z.object({
  answer: z.string(),
  priority: z.enum(['low', 'normal', 'high']),
})

const answerTicket = defineAgent('answerTicket', {
  model: 'support',
  input: supportTicketInput,
  output: supportTicketOutput,
  instructions: [
    'You are a concise customer-support specialist.',
    'Return a practical answer and priority low, normal, or high.',
    'Use high only for account access, data loss, or service outage.',
  ].join(' '),
  prompt: input => ({ role: 'user', content: `${input.customer}: ${input.question}` }),
})

/** Reusable, immutable support definitions with no runtime provider binding. */
const supportCatalog = defineCatalog('supportCatalog', { agents: [answerTicket] })

const answerSupportTicket = defineWorkflow('answerSupportTicket', {
  input: supportTicketInput,
  output: supportTicketOutput,
  agents: { answerTicket },
  async handler(context) {
    return context.agents.answerTicket.run(context.input, { callId: 'answerTicket' })
  },
})

const supportHarness = defineHarness({
  name: 'catalogSupportExample',
  defaults: { contextProjection: { toolResultPruner: { maxBytes: 8_192, headBytes: 3_000, tailBytes: 3_000 } } },
}).use(supportCatalog).addWorkflow(answerSupportTicket)

function loadRootEnv(): void {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
  }
}

function requireOpenAiKey(): string {
  loadRootEnv()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) throw new Error('OPENAI_API_KEY is required. Create .env from .env.example in the repository root.')
  return apiKey
}

/** Creates the support Harness by binding the reusable catalog to one model runtime. */
export function createCatalogSupportHarness(provider?: ModelProvider) {
  const modelProvider = provider ?? openai({ apiKey: requireOpenAiKey() })
  return supportHarness.getInstance({
    models: { support: { provider: modelProvider, model: process.env['OPENAI_MODEL'] ?? 'gpt-5-mini', retry: true } },
    logger: new JsonLogger({ level: 'info' }),
  })
}

export async function runCatalogSupportHarness(): Promise<void> {
  const harness = await createCatalogSupportHarness()
  const session = await harness.getSession('catalog-support-demo')
  const response = await session.workflows.answerSupportTicket.run({
    customer: 'Acme Corp', question: 'I cannot sign in after resetting my password.',
  })
  if (response.status === 'interrupted') throw new Error(`Support workflow interrupted: ${response.interrupt.type}`)
  console.log(`${response.output.priority}: ${response.output.answer}`)
  await harness.close()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCatalogSupportHarness().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
