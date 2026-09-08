import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  builtInTools,
  defineAgent,
  defineHarness,
  defineSkill,
  defineTool,
  defineWorkflow,
  inMemorySandbox,
  type JsonValue,
  type ModelProvider,
  type ObjectRequest,
  type ObjectResponse,
  type ObjectStreamChunk,
} from '@purista/harness'
import { openai } from '@purista/harness-openai'

const policyLookupInput = z.object({ topic: z.string() })
const incidentInput = z.object({ incident: z.string() })
const incidentOutput = z.object({ summary: z.string() })
const policyQuestion = z.object({ question: z.string() })
const policyAnswer = z.object({ answer: z.string() })

const policyLookup = defineTool('policyLookup', {
  description: 'Look up a short internal policy by topic.',
  input: policyLookupInput,
  output: z.object({ text: z.string() }),
  async handler(_context, input) {
    return { text: `Policy for ${input.topic}: escalate customer-impacting incidents.` }
  },
})

const incidentResponder = defineSkill('incident-responder', {
  directory: new URL('./skills/incident-responder/', import.meta.url),
})

const incidentWriter = defineAgent('incidentWriter', {
  model: 'structured',
  input: incidentInput,
  output: incidentOutput,
  tools: [builtInTools.read],
  skills: [incidentResponder],
  instructions: 'Use the incident-responder skill guidance and return a concise incident summary.',
  prompt: input => ({ role: 'user', content: input.incident }),
})

const incidentReviewer = defineAgent('incidentReviewer', {
  model: 'structured',
  input: incidentOutput,
  output: z.object({ approved: z.boolean(), note: z.string() }),
  instructions: 'Approve accurate incident summaries before they are sent.',
  prompt: input => ({ role: 'user', content: input.summary }),
})

const policyAssistant = defineAgent('policyAssistant', {
  model: 'toolReady',
  input: policyQuestion,
  output: policyAnswer,
  tools: [policyLookup],
  instructions: 'Use policyLookup before answering policy questions.',
  prompt: input => ({ role: 'user', content: input.question }),
})

const summarizeIncident = defineWorkflow('summarizeIncident', {
  input: incidentInput,
  output: incidentOutput,
  agents: [incidentWriter, incidentReviewer],
  agentCalls: { maxCalls: 2, maxParallel: 1 },
  async handler(context) {
    const draft = await context.agents.incidentWriter.run(context.input, { callId: 'writeIncident' })
    await context.agents.incidentReviewer.run(draft, { callId: 'reviewIncident' })
    return draft
  },
})

const answerPolicyQuestion = defineWorkflow('answerPolicyQuestion', {
  input: policyQuestion,
  output: policyAnswer,
  agents: [policyAssistant],
  async handler(context) {
    return context.agents.policyAssistant.run(context.input, { callId: 'answerPolicy' })
  },
})

const showcaseDefinition = defineHarness({ name: 'showcase' })
  .addWorkflow(summarizeIncident)
  .addWorkflow(answerPolicyQuestion)

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
  if (!apiKey) throw new Error('OPENAI_API_KEY is required. Set it in the environment or repository .env file.')
  return apiKey
}

export class ScriptedObjectProvider implements ModelProvider {
  public readonly id = 'scripted'
  public readonly genAiSystem = 'example'
  public readonly requests: Array<{ messages: unknown[]; tools: unknown[] }> = []

  public async object<T extends JsonValue = JsonValue>(request: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.requests.push({ messages: request.messages, tools: request.tools ?? [] })
    if ((request.tools ?? []).some(tool => tool.name === 'policyLookup') && !request.messages.some(message => message.role === 'tool')) {
      return { object: {} as T, toolCalls: [{ id: 'lookup-1', name: 'policyLookup', arguments: { topic: 'security' } }], usage: usage(12, 4), finishReason: 'tool_calls' }
    }
    const toolResult = request.messages.find(message => message.role === 'tool')
    if (toolResult) return { object: { answer: `Tool-backed answer: ${toolResult.content}` } as unknown as T, usage: usage(20, 8), finishReason: 'stop' }
    if (request.messages.some(message => JSON.stringify(message).includes('Approve accurate'))) {
      return { object: { approved: true, note: 'Summary is ready to send.' } as unknown as T, usage: usage(8, 4), finishReason: 'stop' }
    }
    return { object: { summary: 'Impact is limited; validate logs and assign an owner.' } as unknown as T, usage: usage(10, 7), finishReason: 'stop' }
  }

  public async *objectStream<T extends JsonValue = JsonValue>(request: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    const response = await this.object(request)
    for (const call of response.toolCalls ?? []) yield { kind: 'tool_call', call }
    yield { kind: 'finish', object: response.object, usage: response.usage, finishReason: response.finishReason }
  }
}

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

/** Binds the reusable definitions to provider and sandbox runtime adapters. */
export function createShowcaseHarness(provider?: ModelProvider) {
  const modelProvider = provider ?? openai({ apiKey: requireOpenAiKey() })
  const model = process.env['OPENAI_MODEL'] ?? 'gpt-5-mini'
  return { provider: modelProvider, harness: showcaseDefinition.getInstance({
    models: {
      structured: { provider: modelProvider, model },
      toolReady: { provider: modelProvider, model },
    },
    sandbox: inMemorySandbox(),
  }) }
}

export async function runShowcase(): Promise<void> {
  const { harness: harnessPromise } = createShowcaseHarness()
  const harness = await harnessPromise
  const session = await harness.getSession('showcase')
  const incident = await session.workflows.summarizeIncident.run({ incident: 'Checkout error rate increased for EU users after the 14:00 deploy.' })
  const policy = await session.workflows.answerPolicyQuestion.run({ question: 'What should we do for a customer-impacting security incident?' })
  if (incident.status !== 'completed') throw new Error('Incident workflow interrupted.')
  if (policy.status !== 'completed') throw new Error('Policy workflow interrupted.')
  console.log('incident summary:', incident.output.summary)
  console.log('policy answer:', policy.output.answer)
  await harness.close()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runShowcase().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
