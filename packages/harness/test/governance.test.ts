import { z } from 'zod'
import { describe, expect, it } from 'vitest'

import { defineHarness, inMemorySandbox, PolicyDeniedError } from '../src/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import type { ObjectRequest } from '../src/ports/model-provider.js'

const transferInput = z.object({
  from: z.string(),
  to: z.string(),
  amount: z.number(),
  balance: z.number()
})

function bankTools(onTransfer: () => void = () => {}) {
  return {
    transfer_funds: {
      description: 'Transfer funds between two accounts.',
      input: transferInput,
      output: z.object({ approved: z.boolean(), reference: z.string() }),
      handler: async (_ctx, input) => {
        onTransfer()
        return { approved: true, reference: `${input.from}-${input.to}-${input.amount}` }
      }
    }
  }
}

describe('governance policies', () => {
  it('blocks denied tool calls before the tool handler runs', async () => {
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [{ id: 'call-transfer', name: 'transfer_funds', arguments: { from: 'checking', to: 'brokerage', amount: 120, balance: 80 } }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls'
    })
    model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    let transfers = 0

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(bankTools(() => { transfers += 1 }))
      .agents({
        banker: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          instructions: 'Transfer funds and recover from tool errors.',
          tools: ['transfer_funds'],
          builtinTools: false
        }
      })
      .governance(({ native, rule }) => ({
        defaultEffect: 'allow',
        policies: [
          native({
            id: 'bank-transfer-controls',
            rules: [
              rule({
                id: 'insufficient-funds',
                effect: 'deny',
                tools: ['transfer_funds'],
                when: ({ input }) => input.balance < input.amount,
                message: 'Balance must cover the transfer amount.'
              })
            ]
          })
        ]
      }))
      .build()

    const session = await harness.getSession('policy-deny')
    await expect(session.agents.banker.prompt('transfer')).resolves.toBe('done')
    expect(transfers).toBe(0)

    const secondModelRequest = model.requests[1] as ObjectRequest
    const toolMessage = secondModelRequest.messages.find((message) => message.role === 'tool')
    expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({
      code: 'POLICY_DENIED',
      meta: {
        policy_id: 'bank-transfer-controls',
        rule_id: 'insufficient-funds',
        effect: 'deny'
      }
    })
  })

  it('requires approval for matching tool calls and emits approval events', async () => {
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [{ id: 'call-transfer', name: 'transfer_funds', arguments: { from: 'checking', to: 'brokerage', amount: 1_200, balance: 5_000 } }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls'
    })
    model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    let transfers = 0

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(bankTools(() => { transfers += 1 }))
      .agents({
        banker: {
          model: 'fast',
          input: z.string(),
          output: z.string(),
          instructions: 'Transfer funds.',
          tools: ['transfer_funds'],
          builtinTools: false
        }
      })
      .governance(({ native, rule }) => ({
        defaultEffect: 'allow',
        approval: {
          request: async ({ decisions }) => ({
            decision: 'approved',
            approverId: 'ops-1',
            reason: decisions.map((decision) => decision.ruleId).join(',')
          })
        },
        policies: [
          native({
            id: 'bank-transfer-controls',
            rules: [
              rule({
                id: 'large-transfer-approval',
                effect: 'require_approval',
                tools: ['transfer_funds'],
                when: ({ input }) => input.amount > 1_000
              })
            ]
          })
        ]
      }))
      .build()

    const session = await harness.getSession('policy-approval')
    const events = []
    for await (const event of session.agents.banker.stream('transfer')) {
      events.push(event)
    }

    expect(transfers).toBe(1)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'approval.requested', policyId: 'bank-transfer-controls', ruleId: 'large-transfer-approval', toolId: 'transfer_funds' }),
      expect.objectContaining({ type: 'approval.finished', decision: 'approved', approverId: 'ops-1', toolId: 'transfer_funds' }),
      expect.objectContaining({ type: 'tool.started', toolId: 'transfer_funds' }),
      expect.objectContaining({ type: 'tool.finished', toolId: 'transfer_funds', output: expect.objectContaining({ approved: true }) })
    ]))
  })

  it('denies when approval is rejected', async () => {
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [{ id: 'call-transfer', name: 'transfer_funds', arguments: { from: 'checking', to: 'brokerage', amount: 1_200, balance: 5_000 } }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls'
    })
    model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    let transfers = 0

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(bankTools(() => { transfers += 1 }))
      .agents({ banker: { model: 'fast', input: z.string(), output: z.string(), instructions: 'Transfer funds.', tools: ['transfer_funds'], builtinTools: false } })
      .governance(({ native, rule }) => ({
        defaultEffect: 'allow',
        approval: { request: async () => ({ decision: 'rejected', reason: 'Needs human escalation.' }) },
        policies: [
          native({
            id: 'bank-transfer-controls',
            rules: [
              rule({ id: 'large-transfer-approval', effect: 'require_approval', tools: ['transfer_funds'], when: ({ input }) => input.amount > 1_000 })
            ]
          })
        ]
      }))
      .build()

    const session = await harness.getSession('policy-rejected')
    await expect(session.agents.banker.prompt('transfer')).resolves.toBe('done')
    expect(transfers).toBe(0)

    const secondModelRequest = model.requests[1] as ObjectRequest
    const toolMessage = secondModelRequest.messages.find((message) => message.role === 'tool')
    expect(JSON.parse(toolMessage?.content ?? '{}')).toMatchObject({
      code: 'POLICY_DENIED',
      meta: { reason: 'approval_rejected' }
    })
  })

  it('records shadow decisions without blocking tool execution', async () => {
    const model = new FakeModelProvider()
    model.enqueue({
      object: {},
      toolCalls: [{ id: 'call-transfer', name: 'transfer_funds', arguments: { from: 'checking', to: 'brokerage', amount: 12_000, balance: 20_000 } }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: 'tool_calls'
    })
    model.enqueue({ object: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    let transfers = 0

    const harness = defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object', 'tool_use'] } })
      .tools(bankTools(() => { transfers += 1 }))
      .agents({ banker: { model: 'fast', input: z.string(), output: z.string(), instructions: 'Transfer funds.', tools: ['transfer_funds'], builtinTools: false } })
      .governance(({ native, rule }) => ({
        mode: 'shadow',
        defaultEffect: 'allow',
        policies: [
          native({
            id: 'bank-transfer-controls',
            rules: [
              rule({ id: 'hard-limit', effect: 'deny', tools: ['transfer_funds'], when: ({ input }) => input.amount > 10_000 })
            ]
          })
        ]
      }))
      .build()

    const session = await harness.getSession('policy-shadow')
    const events = []
    for await (const event of session.agents.banker.stream('transfer')) {
      events.push(event)
    }

    expect(transfers).toBe(1)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'policy.evaluated', enforced: false, effect: 'deny', policyId: 'bank-transfer-controls', ruleId: 'hard-limit' })
    ]))
  })

  it('validates policy tool references at build time', () => {
    const model = new FakeModelProvider()

    expect(() => defineHarness()
      .sandbox(inMemorySandbox())
      .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
      .tools(bankTools())
      .agents({ banker: { model: 'fast', input: z.string(), output: z.string(), instructions: 'x', tools: ['transfer_funds'], builtinTools: false } })
      .governance(({ native, rule }) => ({
        policies: [
          native({
            id: 'bad-policy',
            rules: [
              rule({ id: 'missing-tool', effect: 'deny', tools: ['wire_money'], when: () => true })
            ]
          })
        ]
      }))
      .build()).toThrow(/unknown tool/i)
  })

  it('exports policy errors on the public surface', () => {
    expect(new PolicyDeniedError('nope', { tool_name: 'transfer_funds', agent_id: 'banker', policy_id: 'p1', effect: 'deny' }).code).toBe('POLICY_DENIED')
  })
})
