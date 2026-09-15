import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineAgent, defineHarness, type ModelProvider } from '@purista/harness'
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

const assistant = defineAgent('assistant', {
  model: 'chat',
  input: quickstartInput,
  output: quickstartOutput,
  instructions: 'Return a concise answer matching the output schema.',
  prompt: input => ({ role: 'user', content: `Explain ${input.topic}.` }),
})

export function createQuickstartHarness(provider?: ModelProvider) {
  const model = process.env['OPENAI_MODEL'] ?? 'gpt-5-mini'
  const modelProvider = provider ?? openai({ apiKey: requireOpenAiKey() })
  return defineHarness({ name: 'quickstart' }).addAgent(assistant).getInstance({
    models: { chat: { provider: modelProvider, model, retry: true } },
  })
}

export async function runQuickstart(): Promise<void> {
  const harness = await createQuickstartHarness()
  const session = await harness.getSession('quickstart')
  const response = await session.agents.assistant.run({ topic: 'enterprise agent harnesses' })
  if (response.status !== 'completed') throw new Error('Assistant run was interrupted.')
  console.log(response.output.answer)
  await harness.close()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runQuickstart().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
