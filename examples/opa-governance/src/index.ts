import {
  defineAgent,
  defineHarness,
  defineTool,
  JsonLogger,
  type JsonValue,
  type ModelProvider,
  type ObjectRequest,
  type ObjectResponse,
  type ObjectStreamChunk,
  type ExecutionEvent,
} from '@purista/harness'
import { createOpaClient, opaPolicy, type OpaClient } from '@purista/harness-policy-opa'
import { z } from 'zod'

const transferInput = z.object({
  amount: z.number().positive(),
  destination: z.string().min(1),
})

const transferOutput = z.object({ accepted: z.boolean() })

const opaTransferDecision = z.object({
  matched: z.boolean(),
  effect: z.enum(['allow', 'deny']),
  ruleId: z.string().optional(),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(),
})

/** Synthetic transfer proposed by the deterministic example model. */
export interface TransferScenario {
  readonly amount: number
  readonly destination: string
}

/** Observable result used by the executable example and its deterministic tests. */
export interface OpaGovernanceExampleResult {
  readonly output: string
  readonly events: readonly ExecutionEvent<string>[]
  readonly handlerCalls: number
}

class ScriptedTransferProvider implements ModelProvider {
  public readonly id = 'scripted-transfer'
  public readonly genAiSystem = 'scripted-transfer'
  private calls = 0

  public constructor(private readonly scenario: TransferScenario) {}

  public async object<T extends JsonValue = JsonValue>(_request: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.calls += 1
    if (this.calls === 1) {
      return {
        object: {} as T,
        toolCalls: [{
          id: 'call-transfer',
          name: 'transferFunds',
          arguments: { ...this.scenario },
        }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'tool_calls',
      }
    }
    return {
      object: 'Transfer policy evaluation finished.' as T,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    }
  }

  public async *objectStream<T extends JsonValue = JsonValue>(request: ObjectRequest<T>): AsyncIterable<ObjectStreamChunk<T>> {
    const response = await this.object(request)
    for (const call of response.toolCalls ?? []) yield { kind: 'tool_call', call }
    yield { kind: 'finish', object: response.object, usage: response.usage, finishReason: response.finishReason }
  }
}

/** Builds the example Harness while allowing tests to inject the strict OPA fake. */
export function createOpaGovernanceHarness(scenario: TransferScenario, client: OpaClient) {
  let handlerCalls = 0
  const provider = new ScriptedTransferProvider(scenario)
  const transferFunds = defineTool('transferFunds', {
        description: 'Execute a synthetic transfer after policy evaluation.',
        input: transferInput,
        output: transferOutput,
        handler: async () => {
          handlerCalls += 1
          return { accepted: true }
        },
      })
  const transferAgent = defineAgent('transferAgent', {
      model: 'transferModel',
      input: z.string(),
      output: z.string(),
      instructions: 'Call transferFunds once with the requested synthetic transfer, then summarize the result.',
      prompt: input => ({ role: 'user', content: input }),
      tools: [transferFunds],
      governance: (helpers) => ({
      mode: 'enforce',
      defaultEffect: 'deny',
      policies: [
        opaPolicy(helpers, {
          id: 'opa-transfer-policy',
          version: '2026-08-30',
          effects: ['allow', 'deny'],
          client,
          decisionPath: ['purista', 'bank', 'transfer', 'decision'],
          mapInput(context) {
            if (context.toolId !== 'transferFunds') return undefined
            return {
              tool: context.toolId,
              amount: context.input.amount,
              destination: context.input.destination,
            }
          },
          resultSchema: opaTransferDecision,
          mapDecision(result) {
            if (!result.matched) return undefined
            return {
              effect: result.effect,
              ...(result.ruleId === undefined ? {} : { ruleId: result.ruleId }),
              ...(result.reasonCode === undefined ? {} : { reasonCode: result.reasonCode }),
            }
          },
        }),
      ],
      }),
    })
  const harness = defineHarness({ name: 'opaGovernanceExample' }).addAgent(transferAgent).getInstance({
    models: { transferModel: { provider, model: 'scripted-transfer' } },
    logger: new JsonLogger({ level: 'error' }),
  })

  return { harness, getHandlerCalls: () => handlerCalls }
}

/** Runs one synthetic transfer and returns policy events plus handler execution count. */
export async function runOpaGovernanceScenario(
  scenario: TransferScenario,
  client: OpaClient,
): Promise<OpaGovernanceExampleResult> {
  const { harness: harnessPromise, getHandlerCalls } = createOpaGovernanceHarness(scenario, client)
  const harness = await harnessPromise
  const events: ExecutionEvent<string>[] = []
  let output = ''
  try {
    const session = await harness.getSession(`opa-transfer-${scenario.amount}-${scenario.destination}`)
    for await (const event of session.agents.transferAgent.stream(
      `Transfer ${scenario.amount} to ${scenario.destination}.`,
    )) {
      events.push(event)
      if (event.type === 'run.finished' && event.outcome.status === 'completed') output = event.outcome.output
    }
    return { output, events, handlerCalls: getHandlerCalls() }
  } finally {
    await harness.close()
  }
}

async function main(): Promise<void> {
  const amount = Number(process.env['TRANSFER_AMOUNT'] ?? '250')
  const destination = process.env['TRANSFER_DESTINATION'] ?? 'acct_savings'
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('TRANSFER_AMOUNT must be a positive number.')
  const token = process.env['OPA_TOKEN']
  const client = createOpaClient({
    baseUrl: process.env['OPA_URL'] ?? 'http://127.0.0.1:8181',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  })
  const result = await runOpaGovernanceScenario({ amount, destination }, client)
  const policyEvents = result.events.filter((event) => event.type === 'policy.evaluated')
  console.log(JSON.stringify({ amount, destination, handlerCalls: result.handlerCalls, output: result.output, policyEvents }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'OPA governance example failed.')
    process.exitCode = 1
  })
}
