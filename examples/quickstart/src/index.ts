import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineHarness, JsonLogger, type ModelProvider } from '@purista/harness'
import { openai } from '@purista/harness-openai'
import { z } from 'zod'

const quickstartInput = z.object({ topic: z.string() })
const quickstartOutput = z.object({ answer: z.string() })

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
    const value = raw.replace(/^['"]|['"]$/g, '')
    process.env[key] ??= value
  }
}

function requireOpenAiKey(): string {
  loadRootEnv()
  const apiKey = process.env['OPENAI_API_KEY']
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required. Create .env from .env.example in the repository root.')
  }
  return apiKey
}

export function createQuickstartHarness(provider?: ModelProvider) {
  const model = process.env['OPENAI_MODEL'] ?? 'gpt-5-mini'
  const modelProvider = provider ?? openai({ apiKey: requireOpenAiKey() })

  return defineHarness()
    .logger(new JsonLogger({ level: 'info' }))
    .models({
      assistant: {
        provider: modelProvider,
        model,
        capabilities: ['object']
      }
    })
    .agents(({ agent }) => ({
      assistant: agent({
        model: 'assistant',
        input: quickstartInput,
        output: quickstartOutput,
        builtinTools: false,
        instructions: 'Return JSON matching { "answer": string }. Keep the answer concise.'
      })
    }))
    .workflows(({ workflow }) => ({
      explain_quickstart: workflow({
        input: quickstartInput,
        output: quickstartOutput,
        handler: async (ctx) => {
          ctx.metrics.counter('quickstart.workflow.started', 1, { workflow: 'explain_quickstart' })
          return ctx.metrics.duration('quickstart.workflow.duration', { workflow: 'explain_quickstart' }, () => ctx.agents.assistant(ctx.input))
        }
      })
    }))
    .build()
}

export async function runQuickstart(): Promise<void> {
  const harness = createQuickstartHarness()
  const session = await harness.getSession('quickstart')
  const response = await session.workflows.explain_quickstart.prompt({ topic: 'enterprise agent harnesses' })

  console.log(response.answer)
  await harness.shutdown()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runQuickstart().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
