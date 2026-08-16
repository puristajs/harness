import { expect, it } from 'vitest'
import { DiagnosticInvariantError, assertDiagnosticInvariants } from '../src/testing/index.js'

it('runs explicit diagnostic invariants in registration order without runtime hooks', () => {
  const snapshot = { inspection: { name: 'test', capabilities: [], requiredCapabilities: [], adapters: [], modules: [] } }
  expect(() => assertDiagnosticInvariants(snapshot, [{ id: 'first', check: () => ({ path: 'events.0', message: 'order violation' }) }])).toThrow(DiagnosticInvariantError)
  try {
    assertDiagnosticInvariants(snapshot, [{ id: 'first', check: () => ({ path: 'events.0', message: 'order violation' }) }])
  } catch (error) {
    expect(error).toMatchObject({ meta: { invariantId: 'first', path: 'events.0' } })
  }
})
