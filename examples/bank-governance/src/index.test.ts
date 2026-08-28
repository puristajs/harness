import { describe, expect, it } from 'vitest'

import { runTransferScenario } from './index.js'

describe('bank governance example', () => {
  it('executes ordinary transfers without approval', async () => {
    const result = await runTransferScenario({ from: 'checking', to: 'savings', amount: 250 })

    expect(result.balances['checking']).toBe(4_750)
    expect(result.balances['savings']).toBe(2_750)
    expect(result.events.some((event) => event.type === 'approval.requested')).toBe(false)
  })

  it('requires approval for large transfers below the hard limit', async () => {
    const result = await runTransferScenario({ from: 'checking', to: 'brokerage', amount: 1_500 })

    expect(result.balances['checking']).toBe(3_500)
    expect(result.balances['brokerage']).toBe(1_500)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'approval.requested', demands: [expect.objectContaining({ source: expect.objectContaining({ ruleId: 'large-transfer-approval' }) })] }),
      expect.objectContaining({ type: 'approval.finished', outcome: 'approved', reasonCode: 'approved_by_policy' })
    ]))
  })

  it('blocks transfers above the hard limit', async () => {
    const result = await runTransferScenario({ from: 'checking', to: 'brokerage', amount: 12_000 })

    expect(result.balances['checking']).toBe(5_000)
    expect(result.balances['brokerage']).toBe(0)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'policy.evaluated', effect: 'deny', evidence: expect.objectContaining({ source: expect.objectContaining({ ruleId: 'hard-transfer-limit' }) }) })
    ]))
  })

  it('blocks transfers when the source balance is too low', async () => {
    const result = await runTransferScenario({ from: 'savings', to: 'brokerage', amount: 3_000 })

    expect(result.balances['savings']).toBe(2_500)
    expect(result.balances['brokerage']).toBe(0)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'policy.evaluated', effect: 'deny', evidence: expect.objectContaining({ source: expect.objectContaining({ ruleId: 'insufficient-funds' }) }) })
    ]))
  })
})
