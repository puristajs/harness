import {
  defineHarness,
  inMemorySandbox,
  JsonLogger,
  type JsonValue,
  type ModelProvider,
  type ObjectRequest,
  type ObjectResponse,
  type RunEvent,
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
  effect: z.enum(['allow', 'deny', 'audit', 'require_approval']),
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
  readonly events: readonly RunEvent[]
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
          name: 'transfer_funds',
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
}

/** Builds the example Harness while allowing tests to inject the strict OPA fake. */
export function createOpaGovernanceHarness(scenario: TransferScenario, client: OpaClient) {
  let handlerCalls = 0
  const provider = new ScriptedTransferProvider(scenario)
  const harness = defineHarness()
    .logger(new JsonLogger({ level: 'error' }))
    .sandbox(inMemorySandbox())
    .models({ transfer_model: { provider, model: 'scripted-transfer', capabilities: ['object', 'tool_use'] } })
    .tool('transfer_funds', {
        description: 'Execute a synthetic transfer after policy evaluation.',
        input: transferInput,
        output: transferOutput,
        handler: async () => {
          handlerCalls += 1
          return { accepted: true }
        },
      })
    .agent('transfer_agent', {
      model: 'transfer_model',
      input: z.string(),
      output: z.string(),
      instructions: 'Call transfer_funds once with the requested synthetic transfer, then summarize the result.',
      tools: ['transfer_funds'],
    })
    .governance((helpers) => ({
      mode: 'enforce',
      defaultEffect: 'deny',
      policies: [
        opaPolicy(helpers, {
          id: 'opa-transfer-policy',
          version: '2026-08-30',
          client,
          decisionPath: ['purista', 'bank', 'transfer', 'decision'],
          mapInput(context) {
            if (context.toolId !== 'transfer_funds') return undefined
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
    }))
    .build()

  return { harness, getHandlerCalls: () => handlerCalls }
}

/** Runs one synthetic transfer and returns policy events plus handler execution count. */
export async function runOpaGovernanceScenario(
  scenario: TransferScenario,
  client: OpaClient,
): Promise<OpaGovernanceExampleResult> {
  const { harness, getHandlerCalls } = createOpaGovernanceHarness(scenario, client)
  const events: RunEvent[] = []
  let output = ''
  try {
    const session = await harness.getSession(`opa-transfer-${scenario.amount}-${scenario.destination}`)
    for await (const event of session.agents.transfer_agent.observe(
      `Transfer ${scenario.amount} to ${scenario.destination}.`,
    )) {
      events.push(event)
      if (event.type === 'run.finished' && typeof event.output === 'string') output = event.output
    }
    return { output, events, handlerCalls: getHandlerCalls() }
  } finally {
    await harness.shutdown()
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
