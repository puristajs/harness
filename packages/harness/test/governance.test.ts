import { describe, expect, it } from 'vitest'

import { applyToolExposure, enforceToolGovernance } from '../src/governance/index.js'
import { DecisionEvaluationError, PermissionDeniedError, PolicyDeniedError } from '../src/errors/index.js'

const invocation = (overrides: Record<string, unknown> = {}) => ({
	agentId: 'agent', runId: 'run', sessionId: 'session', invocationId: 'invocation', step: 1,
	signal: new AbortController().signal, decisionTimeoutMs: 1_000, metadata: Object.freeze({}),
	eventSink: { emit: async () => undefined }, toolId: 'write', callId: 'call', input: { path: 'src/file.ts' }, ...overrides,
})

describe('governance public behavior', () => {
	it('applies exposure rules by precedence, defaults, and shadow mode', async () => {
		const events: unknown[] = []
		const tools = [{ name: 'hidden' }, { name: 'exposed' }, { name: 'unmatched' }]
		const governance = {
			exposure: {
				id: 'exposure', version: '1', defaultEffect: 'hide' as const,
				rules: [
					{ id: 'hide-hidden', effect: 'hide' as const, tools: ['hidden'], when: () => true },
					{ id: 'expose-hidden', effect: 'expose' as const, tools: ['hidden'], when: () => true },
					{ id: 'expose-visible', effect: 'expose' as const, tools: ['exposed'], when: () => true },
					{ id: 'ignored', effect: 'expose' as const, tools: ['unmatched'], when: () => false },
				],
			},
		}

		await expect(applyToolExposure(invocation({ governance, tools, eventSink: { emit: async (event: unknown) => events.push(event) } }))).resolves.toEqual(['exposed'])
		expect(events).toHaveLength(3)
		expect(events.every(event => (event as { type: string }).type === 'policy.exposure')).toBe(true)
		await expect(applyToolExposure(invocation({ governance: { ...governance, mode: 'shadow' }, tools }))).resolves.toEqual([
			'hidden', 'exposed', 'unmatched',
		])
		await expect(applyToolExposure(invocation({ governance: { enabled: false }, tools }))).resolves.toEqual([
			'hidden', 'exposed', 'unmatched',
		])
	})

	it('handles optional approvals and fails closed for policy and audit errors', async () => {
		const emitted: unknown[] = []
		const eventSink = { emit: async (event: unknown) => emitted.push(event) }
		const approvalInvocation = invocation({ eventSink, permissions: { write: 'require_approval' }, governance: undefined })
		const requested = await enforceToolGovernance(approvalInvocation)
		expect(requested).toMatchObject({ decision: 'approval_required' })
		if (!requested || requested.decision !== 'approval_required') throw new Error('approval was not requested')
		await expect(enforceToolGovernance(approvalInvocation, [{ approvalId: requested.request.approvalId, approved: true }])).resolves.toBeUndefined()
		await expect(enforceToolGovernance(approvalInvocation, [{ approvalId: requested.request.approvalId, approved: false }])).resolves.toMatchObject({ decision: 'rejected', approvalId: requested.request.approvalId })
		expect(emitted.filter(event => (event as { type: string }).type === 'approval.responded')).toHaveLength(2)

		await expect(enforceToolGovernance(invocation({ permissions: { write: { mode: 'invalid' } } }))).rejects.toThrow()
		await expect(enforceToolGovernance(invocation({ permissions: { write: 'deny' } }))).rejects.toBeInstanceOf(PermissionDeniedError)
		await expect(enforceToolGovernance(invocation({ governance: { policies: [{ id: 'bad', effects: ['allow'], evaluate: () => ({ effect: 'invalid' }) }] } }))).rejects.toBeInstanceOf(DecisionEvaluationError)
		await expect(enforceToolGovernance(invocation({ governance: { policies: [{ id: 'throws', effects: ['allow'], evaluate: () => { throw new Error('boom') } }] } }))).rejects.toBeInstanceOf(DecisionEvaluationError)
		await expect(enforceToolGovernance(invocation({ governance: { policies: [{ id: 'empty', effects: ['allow'], evaluate: () => undefined }] } }))).rejects.toBeInstanceOf(PolicyDeniedError)
		await expect(enforceToolGovernance(invocation({ governance: {
			policies: [{ kind: 'native', id: 'native', effects: ['audit'], rules: [{ id: 'audit', effect: 'audit', when: () => true }] }],
			audit: { record: async () => { throw new Error('audit failed') } },
		} }))).rejects.toBeInstanceOf(DecisionEvaluationError)
	})
})
