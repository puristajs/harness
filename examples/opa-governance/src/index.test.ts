import { FakeOpaDataApi } from '@purista/harness-policy-opa/testing'
import { describe, expect, it } from 'vitest'
import { createOpaClient } from '@purista/harness-policy-opa'
import { runOpaGovernanceScenario } from './index.js'

describe('OPA governance consumer example', () => {
  it('executes the handler after an allow decision and sends only the selected fields', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueDecision({
      matched: true,
      effect: 'allow',
      ruleId: 'opa_transfer_allow',
      reasonCode: 'policy_allow',
    })
    const result = await runOpaGovernanceScenario(
      { amount: 250, destination: 'acct_savings' },
      createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch }),
    )

    expect(result.handlerCalls).toBe(1)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'policy.evaluated',
        effect: 'allow',
        evidence: expect.objectContaining({ source: expect.objectContaining({ ruleId: 'opa_transfer_allow' }) }),
      }),
    ]))
    expect(JSON.parse(String(api.requests[0]?.init.body))).toEqual({
      input: { tool: 'transfer_funds', amount: 250, destination: 'acct_savings' },
    })
    api.assertExhausted()
  })

  it('suppresses the handler after a deny decision', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueDecision({
      matched: true,
      effect: 'deny',
      ruleId: 'opa_transfer_limit',
      reasonCode: 'transfer_limit',
    })
    const result = await runOpaGovernanceScenario(
      { amount: 1_500, destination: 'acct_brokerage' },
      createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch }),
    )

    expect(result.handlerCalls).toBe(0)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'policy.evaluated',
        effect: 'deny',
        evidence: expect.objectContaining({ source: expect.objectContaining({ ruleId: 'opa_transfer_limit' }) }),
      }),
    ]))
    api.assertExhausted()
  })

  it('fails closed when OPA returns an undefined decision', async () => {
    const api = new FakeOpaDataApi()
    api.enqueueUndefinedDecision()
    const result = await runOpaGovernanceScenario(
      { amount: 250, destination: 'acct_savings' },
      createOpaClient({ baseUrl: 'https://opa.example.test/', fetch: api.fetch }),
    )

    expect(result.handlerCalls).toBe(0)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'policy.evaluated', effect: 'deny' }),
    ]))
    api.assertExhausted()
  })
})
