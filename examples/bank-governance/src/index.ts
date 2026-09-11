import {
  defineAgent,
  defineHarness,
  defineTool,
  JsonLogger,
  type ExecutionEvent,
  type JsonValue,
  type ModelProvider,
  type RunOutcome,
  type TextRequest,
  type TextResponse,
  type TextStreamChunk,
  sqliteHarnessStorage,
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
  approval?: { readonly approved: boolean; readonly reason?: string }
}

export interface TransferScenario {
  from: string
  to: string
  amount: number
}

class ScriptedTransferProvider implements ModelProvider {
  public readonly id = 'scripted-bank'
  public readonly genAiSystem = 'scripted-bank'
  public readonly info = {
    providerId: this.id,
    genAiSystem: this.genAiSystem,
    models: {
      'scripted-bank-model': {
        capabilities: ['text', 'text_stream', 'tool_use'] as const,
        supportedInputParts: ['text'] as const,
        supportedOutputModes: ['text'] as const,
      },
    },
  }
  private calls = 0

  public constructor(private readonly scenario: TransferScenario) {}

  public async text(_request: TextRequest): Promise<TextResponse> {
    this.calls += 1
    if (this.calls === 1) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'call_transfer',
            name: 'transferFunds',
            arguments: { ...this.scenario } as unknown as JsonValue,
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: 'tool_calls',
      }
    }
    return {
      content: 'transaction reviewed',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
    }
  }

  public async *textStream(request: TextRequest): AsyncIterable<TextStreamChunk> {
    const response = await this.text(request)
    for (const call of response.toolCalls ?? []) yield { kind: 'tool_call', call }
    if (response.content) yield { kind: 'delta', text: response.content }
    yield { kind: 'finish', usage: response.usage, finishReason: response.finishReason }
  }
}

export function createBankGovernanceHarness(scenario: TransferScenario, opts: BankGovernanceOptions = {}) {
  const balances: AccountBalances = { checking: 5_000, savings: 2_500, brokerage: 0, ...(opts.balances ?? {}) }
  const approvalThreshold = opts.approvalThreshold ?? 1_000
  const hardLimit = opts.hardLimit ?? 10_000
  const provider = new ScriptedTransferProvider(scenario)

  const transferFunds = defineTool('transferFunds', {
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
  const banker = defineAgent('banker', {
      model: 'bankerModel',
      input: z.string(),
      output: z.string(),
      instructions: 'Use transferFunds for the requested bank transaction, then summarize the result.',
      prompt: input => ({ role: 'user', content: input }),
      tools: [transferFunds],
      governance: ({ native, rule }) => ({
      defaultEffect: 'allow',
      policies: [
        native({
          id: 'bankTransferPolicy',
          description: 'Bank transfer controls for balance, approval, and hard limits.',
          rules: [
            rule({
              id: 'insufficientFunds',
              effect: 'deny',
              tools: ['transferFunds'],
              when: ({ input }) => (balances[input.from] ?? 0) < input.amount,
              reasonCode: 'insufficient_funds',
            }),
            rule({
              id: 'hardTransferLimit',
              effect: 'deny',
              tools: ['transferFunds'],
              when: ({ input }) => input.amount > hardLimit,
              reasonCode: 'hard_limit',
            }),
            rule({
              id: 'largeTransferApproval',
              effect: 'require_approval',
              tools: ['transferFunds'],
              when: ({ input }) => input.amount > approvalThreshold,
              reasonCode: 'large_transfer',
            }),
          ],
        }),
      ],
      }),
    })
  const storage = sqliteHarnessStorage({ file: ':memory:' })
  const harness = defineHarness({ name: 'bankGovernanceExample', revision: 'v1' }).addAgent(banker).getInstance({
    models: { bankerModel: { provider, model: 'scripted-bank-model' } },
    storage,
    logger: new JsonLogger({ level: 'error' }),
  })

  return { harness, balances, storage }
}

export async function runTransferScenario(
  scenario: TransferScenario,
  opts?: BankGovernanceOptions,
): Promise<{ output: string; events: ExecutionEvent<JsonValue>[]; balances: AccountBalances }> {
  const { harness: harnessPromise, balances, storage } = createBankGovernanceHarness(scenario, opts)
  const harness = await harnessPromise
  const session = await harness.getSession(`bank-${scenario.from}-${scenario.to}-${scenario.amount}`)
  const events: ExecutionEvent<JsonValue>[] = []
  let output = ''
  let interrupted: Extract<RunOutcome<JsonValue>, { status: 'interrupted' }> | undefined
  const input = `Transfer ${scenario.amount} from ${scenario.from} to ${scenario.to}.`

  try {
    for await (const event of session.agents.banker.stream(input)) {
      events.push(event)
      if (event.type !== 'run.finished') continue
      if (event.outcome.status === 'completed' && typeof event.outcome.output === 'string') output = event.outcome.output
      else if (event.outcome.status === 'interrupted') interrupted = event.outcome
    }
    if (interrupted?.interrupt.type === 'tool-approval') {
      const decision = opts?.approval ?? { approved: true, reason: 'Approved for the example.' }
      for await (const resumed of session.agents.banker.stream(input, {
          resume: {
            type: 'tool-approval',
            runId: interrupted.runId,
            interruptId: interrupted.interrupt.id,
            revision: interrupted.interrupt.revision,
            eventId: `bank-example:${interrupted.interrupt.id}`,
            decisions: interrupted.interrupt.requests.map(request => ({
              approvalId: request.approvalId,
              approved: decision.approved,
              ...(decision.reason ? { reason: decision.reason } : {}),
            })),
          },
      })) {
        events.push(resumed)
        if (resumed.type === 'run.finished' && resumed.outcome.status === 'completed' && typeof resumed.outcome.output === 'string') output = resumed.outcome.output
      }
    }
    return { output, events, balances }
  } finally {
    await harness.close()
    await storage.close()
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
    const decisions = result.events.filter(event => event.type === 'approval.requested' || event.type === 'approval.responded')
    console.log(JSON.stringify({ scenario, output: result.output, balances: result.balances, decisions }, null, 2))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBankGovernanceExample().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
