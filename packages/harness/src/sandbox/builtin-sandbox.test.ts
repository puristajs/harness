import { describe, expect, it } from 'vitest'
import { inMemorySandbox } from './index.js'
import { withSandboxTelemetry } from './telemetry.js'
import { sandboxActorBarrierContract, sandboxTextSearchContract } from '../testing/sandboxContract.js'
import { RecordingLogger, RecordingTelemetry } from '../../test/telemetryFlowHarness.js'
import type { HarnessAdapterContext } from '../ports/harness-context.js'
import { OperationCancelledError, SandboxPermissionDeniedError, SandboxStateLostError } from '../errors/index.js'

sandboxActorBarrierContract(() => inMemorySandbox())
sandboxTextSearchContract(() => inMemorySandbox())

describe('built-in sandbox administration telemetry', () => {
  it('emits redacted standard spans and metrics for owner registration and administration', async () => {
    const sandbox = inMemorySandbox()
    const telemetry = new RecordingTelemetry()
    const context: HarnessAdapterContext = {
      harnessName: 'telemetry-sandbox',
      logger: new RecordingLogger(),
      telemetry,
      metrics: {
        counter: (name, value = 1, attrs) => telemetry.recordCounter(name, value, attrs ?? {}),
        histogram: (name, value, attrs) => telemetry.recordHistogram(name, value, attrs ?? {}),
        duration: async (_name, _attrs, action) => await action()
      },
      contentCaptureMode: 'NO_CONTENT',
      defaults: { agentMaxIterations: 1, runTimeoutMs: 1, toolTimeoutMs: 1, decisionTimeoutMs: 1, skillTimeoutMs: 1, modelTimeoutMs: 1, maxParallelToolCalls: 1 }
    }
    sandbox.configureHarnessContext?.(context)
    const owner = { namespace: 'private-namespace', id: 'private-owner', instanceId: '01J00000000000000000000000' }

    await sandbox.registerOwner({ owner, mode: 'create' })
    await sandbox.administration.list({ selector: { kind: 'owner', owner } })

    expect(telemetry.spans.map(span => span.name)).toEqual(expect.arrayContaining([
      'harness.sandbox.register_owner', 'harness.sandbox.list'
    ]))
    expect(telemetry.metrics.map(metric => metric.name)).toEqual(expect.arrayContaining([
      'harness.sandbox.operations', 'harness.sandbox.operation.duration'
    ]))
    const encoded = JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics })
    expect(encoded).not.toContain('private-namespace')
    expect(encoded).not.toContain('private-owner')
  })

  it.each([
    [new SandboxPermissionDeniedError('scope_mismatch'), 'denied'],
    [new SandboxStateLostError('private lifecycle state', { reason: 'provider_missing', lifetime: 'session', adapter_id: 'private_adapter_sentinel' }), 'state_lost'],
    [new OperationCancelledError('private cancellation', { scope: 'sandbox' }), 'cancelled']
  ] as const)('classifies %s without exposing private error data', async (error, expectedOutcome) => {
    const telemetry = new RecordingTelemetry()

    await expect(withSandboxTelemetry(
      telemetry,
      'private-adapter-sentinel',
      'open',
      async () => { throw error }
    )).rejects.toBe(error)

    const span = telemetry.spans[0]
    expect(span?.attrs).toMatchObject({
      'harness.sandbox.adapter': 'custom_sandbox',
      'harness.sandbox.operation': 'open',
      'harness.sandbox.outcome': expectedOutcome
    })
    const encoded = JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics })
    expect(encoded).not.toContain('private lifecycle state')
    expect(encoded).not.toContain('private_adapter_sentinel')
    expect(encoded).not.toContain('private cancellation')
  })
})
