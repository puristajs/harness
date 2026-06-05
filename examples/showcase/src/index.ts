import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { defineHarness, inMemorySandbox, type JsonValue, type ModelProvider, type ObjectRequest, type ObjectResponse } from '@purista/harness'
import { openai } from '@purista/harness-openai'

const here = dirname(fileURLToPath(import.meta.url))
const policyLookupInput = z.object({ topic: z.string() })

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
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required. Create .env from .env.example in the repository root.')
  }
  return apiKey
}

class ScriptedObjectProvider implements ModelProvider {
  public readonly id = 'scripted'
  public readonly genAiSystem = 'example'
  public readonly requests: Array<{ messages: unknown[]; tools: unknown[] }> = []

  async object<T extends JsonValue = JsonValue>(req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.requests.push({ messages: req.messages, tools: req.tools ?? [] })

    if ((req.tools ?? []).some((tool) => tool.name === 'policy_lookup') && !req.messages.some((message) => message.role === 'tool')) {
      return {
        object: {} as T,
        toolCalls: [{ id: 'lookup_1', name: 'policy_lookup', arguments: { topic: 'security' } }],
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        finishReason: 'tool_calls'
      }
    }

    const toolResult = req.messages.find((message) => message.role === 'tool')
    if (toolResult) {
      return {
        object: { answer: `Tool-backed answer: ${toolResult.content}` } as unknown as T,
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        finishReason: 'stop'
      }
    }

    return {
      object: { summary: 'Impact is limited; validate logs and assign an owner.' } as unknown as T,
      usage: { inputTokens: 10, outputTokens: 7, totalTokens: 17 },
      finishReason: 'stop'
    }
  }
}

export function createShowcaseHarness(provider?: ModelProvider) {
  const model = process.env['OPENAI_MODEL'] ?? 'gpt-5-mini'
  const modelProvider = provider ?? openai({ apiKey: requireOpenAiKey() })

  return {
    provider: modelProvider,
    harness: defineHarness()
      .sandbox(inMemorySandbox())
      .models({
        structured: {
          provider: modelProvider,
          model,
          capabilities: ['object', 'tool_use']
        },
        toolReady: {
          provider: modelProvider,
          model,
          capabilities: ['object', 'tool_use']
        }
      })
      .tools({
        policy_lookup: {
          description: 'Look up a short internal policy by topic.',
          input: policyLookupInput,
          output: z.object({ text: z.string() }),
          handler: async (_ctx, input) => {
            const parsed = policyLookupInput.parse(input)
            return { text: `Policy for ${parsed.topic}: escalate customer-impacting incidents.` }
          }
        }
      })
      .skills({
        'incident-responder': {
          directory: join(here, 'skills/incident-responder')
        }
      })
      .agents(({ agent }) => ({
        incident_writer: agent({
          model: 'structured',
          input: z.object({ incident: z.string() }),
          output: z.object({ summary: z.string() }),
          builtinTools: ['read'],
          skills: ['incident-responder'],
          instructions: (ctx) => [
            'Use the mounted incident-responder skill guidance.',
            'Return JSON matching { "summary": string }.',
            `Incident: ${ctx.input.incident}`
          ].join('\n')
        }),
        policy_assistant: agent({
          model: 'toolReady',
          input: z.object({ question: z.string() }),
          output: z.object({ answer: z.string() }),
          builtinTools: false,
          tools: ['policy_lookup'],
          instructions: [
            'Use policy_lookup before answering policy questions.',
            'Return JSON matching { "answer": string }.'
          ].join('\n')
        })
      }))
      .workflows(({ workflow }) => ({
        summarize_incident: workflow({
          input: z.object({ incident: z.string() }),
          output: z.object({ summary: z.string() }),
          handler: async (ctx) => ctx.agents.incident_writer({ incident: ctx.input.incident })
        }),
        answer_policy_question: workflow({
          input: z.object({ question: z.string() }),
          output: z.object({ answer: z.string() }),
          handler: async (ctx) => ctx.agents.policy_assistant({ question: ctx.input.question })
        })
      }))
      .build()
  }
}

export { ScriptedObjectProvider }

export async function runShowcase(): Promise<void> {
  const { harness } = createShowcaseHarness()
  const session = await harness.getSession('showcase')

  const incident = await session.workflows.summarize_incident.prompt({
    incident: 'Checkout error rate increased for EU users after the 14:00 deploy.'
  })
  const policy = await session.workflows.answer_policy_question.prompt({
    question: 'What should we do for a customer-impacting security incident?'
  })

  console.log('incident summary:', incident.summary)
  console.log('policy answer:', policy.answer)
  await harness.shutdown()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runShowcase().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
