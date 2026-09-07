import { describe, expect, it } from 'vitest'

import { enforceToolGovernance } from '../src/governance/index.js'
import type { GovernanceContext } from '../src/governance/types.js'
import { RecordingTelemetry } from '../src/testing/recordingTelemetry.js'

describe('governance evaluation context', () => {
	it('projects the active policy span traceparent into each evaluation', async () => {
		const telemetry = new RecordingTelemetry()
		let received: GovernanceContext | undefined
		await enforceToolGovernance({
			agentId: 'agent', runId: 'run', sessionId: 'session', invocationId: 'invocation', step: 1,
			signal: new AbortController().signal, decisionTimeoutMs: 1_000, metadata: Object.freeze({}),
			telemetry, eventSink: { emit: async () => undefined }, toolId: 'lookup', callId: 'call', input: 'input',
			governance: { policies: [{ id: 'external', effects: ['allow'], evaluate(context) {
				received = context
				return { effect: 'allow' }
			} }] },
		})

		expect(received).toMatchObject({
			traceparent: '00-00000000000000000000000000000001-0000000000000001-01',
		})
		expect(Object.isFrozen(received)).toBe(true)
	})

	it('omits traceparent when no active telemetry context exists', async () => {
		let received: GovernanceContext | undefined
		await enforceToolGovernance({
			agentId: 'agent', runId: 'run', sessionId: 'session', invocationId: 'invocation', step: 1,
			signal: new AbortController().signal, decisionTimeoutMs: 1_000, metadata: Object.freeze({}),
			eventSink: { emit: async () => undefined }, toolId: 'lookup', callId: 'call', input: 'input',
			governance: { policies: [{ id: 'external', effects: ['allow'], evaluate(context) {
				received = context
				return { effect: 'allow' }
			} }] },
		})

		expect(received).not.toHaveProperty('traceparent')
	})

	it('omits an invalid active telemetry traceparent', async () => {
		const telemetry = new class extends RecordingTelemetry {
			public override currentTraceparent(): string { return 'invalid-and-sensitive' }
		}()
		let received: GovernanceContext | undefined
		await enforceToolGovernance({
			agentId: 'agent', runId: 'run', sessionId: 'session', invocationId: 'invocation', step: 1,
			signal: new AbortController().signal, decisionTimeoutMs: 1_000, metadata: Object.freeze({}),
			telemetry, eventSink: { emit: async () => undefined }, toolId: 'lookup', callId: 'call', input: 'input',
			governance: { policies: [{ id: 'external', effects: ['allow'], evaluate(context) {
				received = context
				return { effect: 'allow' }
			} }] },
		})

		expect(received).not.toHaveProperty('traceparent')
	})
})
