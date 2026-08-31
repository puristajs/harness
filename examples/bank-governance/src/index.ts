import {
  defineHarness,
  inMemorySandbox,
  JsonLogger,
  type GovernanceApprovalProvider,
  type JsonValue,
  type ModelProvider,
  type ObjectRequest,
  type ObjectResponse,
  type RunEvent,
} from '@purista/harness'
import { z } from 'zod'

const transferInput = z.object({
  from: z.string(),
  to: z.string(),
  amount: z.number().positive(),
})

const transferOutput = z.object({
  ok: z.boolean(),
  fromBalance: z.number(),
  toBalance: z.number(),
})

export type AccountBalances = Record<string, number>

export interface BankGovernanceOptions {
  balances?: AccountBalances
  approvalThreshold?: number
  hardLimit?: number
  approval?: GovernanceApprovalProvider
}

export interface TransferScenario {
  from: string
  to: string
  amount: number
}

class ScriptedTransferProvider implements ModelProvider {
  public readonly id = 'scripted-bank'
  public readonly genAiSystem = 'scripted-bank'
  private calls = 0

  public constructor(private readonly scenario: TransferScenario) {}

  public async object<T extends JsonValue = JsonValue>(_req: ObjectRequest<T>): Promise<ObjectResponse<T>> {
    this.calls += 1
    if (this.calls === 1) {
      return {
        object: {} as T,
        toolCalls: [
          {
            id: 'call_transfer',
            name: 'transfer_funds',
            arguments: { ...this.scenario } as unknown as JsonValue,
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'tool_calls',
      }
    }
    return {
      object: 'transaction reviewed' as T,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    }
  }
}

export function createBankGovernanceHarness(scenario: TransferScenario, opts: BankGovernanceOptions = {}) {
  const balances: AccountBalances = { checking: 5_000, savings: 2_500, brokerage: 0, ...(opts.balances ?? {}) }
  const approvalThreshold = opts.approvalThreshold ?? 1_000
  const hardLimit = opts.hardLimit ?? 10_000
  const provider = new ScriptedTransferProvider(scenario)
  const approval = opts.approval ?? {
    request: async () => ({
      decision: 'approved' as const,
      reasonCode: 'approved_by_policy',
    }),
  }

  const harness = defineHarness()
    .logger(new JsonLogger({ level: 'error' }))
    .sandbox(inMemorySandbox())
    .models({ banker_model: { provider, model: 'scripted-bank-model', capabilities: ['object', 'tool_use'] } })
    .tool('transfer_funds', {
        description: 'Move money between two authorized bank accounts.',
        input: transferInput,
        output: transferOutput,
        handler: async (_ctx, input) => {
          const currentFrom = balances[input.from] ?? 0
          const currentTo = balances[input.to] ?? 0
          if (currentFrom < input.amount) throw new Error('Transfer rejected by the account service.')
          balances[input.from] = currentFrom - input.amount
          balances[input.to] = currentTo + input.amount
          return {
            ok: true,
            fromBalance: balances[input.from] ?? 0,
            toBalance: balances[input.to] ?? 0,
          }
        },
      })
    .agent('banker', {
      model: 'banker_model',
      input: z.string(),
      output: z.string(),
      instructions: 'Use transfer_funds for the requested bank transaction, then summarize the result.',
      tools: ['transfer_funds'],
    })
    .governance(({ native, rule }) => ({
      defaultEffect: 'allow',
      approval,
      policies: [
        native({
          id: 'bank-transfer-policy',
          description: 'Bank transfer controls for balance, approval, and hard limits.',
          rules: [
            rule({
              id: 'insufficient-funds',
              effect: 'deny',
              tools: ['transfer_funds'],
              when: ({ input }) => (balances[input.from] ?? 0) < input.amount,
              reasonCode: 'insufficient_funds',
            }),
            rule({
              id: 'hard-transfer-limit',
              effect: 'deny',
              tools: ['transfer_funds'],
              when: ({ input }) => input.amount > hardLimit,
              reasonCode: 'hard_limit',
            }),
            rule({
              id: 'large-transfer-approval',
              effect: 'require_approval',
              tools: ['transfer_funds'],
              when: ({ input }) => input.amount > approvalThreshold,
              reasonCode: 'large_transfer',
            }),
          ],
        }),
      ],
    }))
    .build()

  return { harness, balances }
}

export async function runTransferScenario(
  scenario: TransferScenario,
  opts?: BankGovernanceOptions,
): Promise<{ output: string; events: RunEvent[]; balances: AccountBalances }> {
  const { harness, balances } = createBankGovernanceHarness(scenario, opts)
  const session = await harness.getSession(`bank-${scenario.from}-${scenario.to}-${scenario.amount}`)
  const events: RunEvent[] = []
  let output = ''

  try {
    for await (const event of session.agents.banker.stream(
      `Transfer ${scenario.amount} from ${scenario.from} to ${scenario.to}.`,
    )) {
      events.push(event)
      if (event.type === 'run.finished' && typeof event.output === 'string') output = event.output
    }
    return { output, events, balances }
  } finally {
    await harness.shutdown()
  }
}

export async function runBankGovernanceExample(): Promise<void> {
  const scenarios: TransferScenario[] = [
    { from: 'checking', to: 'savings', amount: 250 },
    { from: 'checking', to: 'brokerage', amount: 1_500 },
    { from: 'savings', to: 'brokerage', amount: 12_000 },
    { from: 'savings', to: 'brokerage', amount: 3_000 },
  ]

  for (const scenario of scenarios) {
    const result = await runTransferScenario(scenario)
    const decisions = result.events.filter(
      (event) => event.type === 'policy.evaluated' || event.type === 'approval.finished',
    )
    console.log(JSON.stringify({ scenario, output: result.output, balances: result.balances, decisions }, null, 2))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBankGovernanceExample().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
