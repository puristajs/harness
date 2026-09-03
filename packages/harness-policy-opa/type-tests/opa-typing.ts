import { defineHarness } from '@purista/harness'
import { z } from 'zod'
import { createOpaClient, opaPolicy } from '../src/index.js'

const client = createOpaClient({ baseUrl: 'https://opa.example.test/' })

defineHarness()
  .tools({
    transfer_funds: {
      description: 'Transfer synthetic funds.',
      input: z.object({ amount: z.number(), destination: z.string() }),
      output: z.object({ accepted: z.boolean() }),
      handler: async () => ({ accepted: true }),
    },
    read_balance: {
      description: 'Read a synthetic balance.',
      input: z.object({ accountId: z.string() }),
      output: z.object({ balance: z.number() }),
      handler: async () => ({ balance: 100 }),
    },
  })
  .governance((helpers) => ({
    policies: [
      opaPolicy(helpers, {
        id: 'typed-opa-policy',
        client,
        decisionPath: ['bank', 'tool'],
        mapInput(context) {
          if (context.toolId === 'transfer_funds') {
            const amount: number = context.input.amount
            // @ts-expect-error transfer input has no accountId
            context.input.accountId
            return { tool: context.toolId, amount }
          }
          if (context.toolId === 'read_balance') {
            const accountId: string = context.input.accountId
            // @ts-expect-error balance input has no amount
            context.input.amount
            return { tool: context.toolId, accountId }
          }
          return undefined
        },
        resultSchema: z.object({ matched: z.boolean(), effect: z.enum(['allow', 'deny']) }),
        mapDecision(result, context) {
          const matched: boolean = result.matched
          const toolId: 'transfer_funds' | 'read_balance' | string = context.toolId
          void matched
          void toolId
          // @ts-expect-error validated result has no prose field
          result.prose
          return result.matched ? { effect: result.effect, ruleId: 'opa-result' } : undefined
        },
      }),
    ],
  }))

const nonJsonSchema = z.custom<Date>()

defineHarness().governance((helpers) => ({
  policies: [
    opaPolicy(helpers, {
      id: 'reject-non-json-result',
      client,
      decisionPath: ['test'],
      mapInput: () => ({}),
      // @ts-expect-error policy result schemas must produce JSON-compatible values
      resultSchema: nonJsonSchema,
      mapDecision: () => undefined,
    }),
  ],
}))
