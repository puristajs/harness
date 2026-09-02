import { expect, it } from 'vitest'
import { createGuardrailsExample, preflightGuardrailsExample, runGuardrailsExample, runSupportRequest } from './index.js'
import type { SensitiveDataDetector } from '@purista/harness-guardrails'

it('builds and shuts down the complete composition without protected effects', async () => {
  const example = createGuardrailsExample()
  try {
    expect(example.provider.requests).toEqual([])
    expect(example.detectorInspections).toBe(0)
    expect(example.handledNotes).toEqual([])
    expect(example.approvalRequests).toEqual([])
  } finally {
    await example.harness.shutdown()
  }
  let injectedDetectorInspections = 0
  const detector: SensitiveDataDetector = {
    id: 'preflight-observer', executionMode: 'local', supportedEntities: ['EMAIL_ADDRESS'],
    async inspect() {
      injectedDetectorInspections += 1
      return { findings: [] }
    }
  }
  await expect(preflightGuardrailsExample({ detector })).resolves.toEqual({
    modelRequests: 0, detectorInspections: 0, toolInvocations: 0, approvalRequests: 0
  })
  expect(injectedDetectorInspections).toBe(0)
})

it('runs with the Harness test adapter and no network dependency', async () => {
  await expect(runGuardrailsExample()).resolves.toBe('The [redacted] answer.')
})

it('shares one approval provider across parsed tool and permission demands', async () => {
  const example = createGuardrailsExample()
  try {
    await expect(runSupportRequest(example, 'composed-success', 'Where is [secret] [email]?')).resolves.toMatchObject({ status: 'completed', output: 'The [redacted] answer.' })
    expect(example.approvalRequests.map((request) => request.toolId).sort()).toEqual(['publish_note', 'write'])
    expect(example.approvalRequests.find((request) => request.toolId === 'publish_note')?.input).toEqual({ message: '[redacted]', visibility: 'internal' })
    expect(example.approvalRequests.find((request) => request.toolId === 'write')?.demands.map((demand) => demand.source.kind)).toEqual(['permission', 'policy'])
    expect(example.handledNotes).toEqual(['[redacted]'])
    expect(example.lifecycle).toContain('preflight:publish_note')
    expect(example.lifecycle).not.toContain('preflight:lookup_status')
    expect(example.lifecycle).not.toContain('preflight:write')
    expect(example.lifecycle.indexOf('handler:publish_note')).toBeGreaterThan(example.lifecycle.indexOf('approval:publish_note'))
    expect(JSON.stringify(example.provider.requests[0])).not.toContain('[secret]')
    expect(JSON.stringify(example.provider.requests[0])).toContain('<MASKED>')
    expect(JSON.stringify(example.provider.requests[1])).toContain('public status')
    expect(JSON.stringify(example.provider.requests[1])).not.toContain('private status')
  } finally {
    await example.harness.shutdown()
  }
})

it('does not publish when approval is rejected', async () => {
  const example = createGuardrailsExample()
  try {
    const outcome = await runSupportRequest(example, 'composed-rejected', 'Review the note.', request => ({
      approvalId: request.approvalId,
      approved: false,
      reason: 'Rejected by reviewer.',
    }))
    expect(outcome).toMatchObject({ status: 'completed', output: 'The [redacted] answer.' })
    expect(JSON.stringify(example.provider.requests[1])).toContain('Rejected by reviewer.')
    expect(example.handledNotes).toEqual([])
    expect(example.lifecycle).not.toContain('handler:publish_note')
  } finally {
    await example.harness.shutdown()
  }
})

it('cancels an outstanding approval without publishing the note', async () => {
  const controller = new AbortController()
  const example = createGuardrailsExample()
  try {
    await expect(runSupportRequest(example, 'composed-cancel', 'Review the note.', request => {
      controller.abort()
      return { approvalId: request.approvalId, approved: true }
    }, controller.signal)).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(example.handledNotes).toEqual([])
    expect(example.lifecycle).not.toContain('handler:publish_note')
  } finally {
    await example.harness.shutdown()
  }
})

it('blocks content without requesting approval or calling the provider', async () => {
  const example = createGuardrailsExample()
  const session = await example.harness.getSession('composed-content-block')
  try {
    await expect(session.agents.support.run('[blocked]')).rejects.toMatchObject({
      code: 'DECISION_BLOCKED', meta: { evidence: { source: { kind: 'guardrail' }, reasonCode: 'unsafe_content' } }
    })
    expect(example.provider.requests).toEqual([])
    expect(example.approvalRequests).toEqual([])
    expect(example.handledNotes).toEqual([])
  } finally {
    await session.release()
    await example.harness.shutdown()
  }
})
