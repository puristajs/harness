import { expect, it } from 'vitest'
import { createGuardrailsExample, preflightGuardrailsExample, runGuardrailsExample } from './index.js'
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
  const session = await example.harness.getSession('composed-success')
  try {
    await expect(session.agents.support.prompt('Where is [secret] [email]?')).resolves.toBe('The [redacted] answer.')
    expect(example.approvalRequests.map((request) => request.subject.toolId).sort()).toEqual(['publish_note', 'write'])
    expect(example.approvalRequests.find((request) => request.subject.toolId === 'publish_note')?.subject.input).toEqual({ message: '[redacted]', visibility: 'internal' })
    expect(example.approvalRequests.find((request) => request.subject.toolId === 'write')?.demands.map((demand) => demand.source.kind)).toEqual(['permission', 'policy'])
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
    await session.release()
    await example.harness.shutdown()
  }
})

it.each(['rejected', 'failed', 'timeout'] as const)('does not publish when approval is %s', async (mode) => {
  const example = createGuardrailsExample({
    decisionTimeoutMs: 20,
    approval: {
      async request(_request, execution) {
        expect(execution.signal.aborted).toBe(false)
        expect(execution.deadline).toBeGreaterThan(Date.now())
        if (mode === 'failed') throw new Error('private reviewer message')
        if (mode === 'timeout') return new Promise(() => {})
        return { decision: 'rejected', reasonCode: 'review_rejected' }
      }
    }
  })
  const session = await example.harness.getSession(`composed-${mode}`)
  try {
    const error = await session.agents.support.prompt('Review the note.').catch((value: unknown) => value)
    if (mode === 'rejected') {
      expect(error).toBe('The [redacted] answer.')
      expect(JSON.stringify(example.provider.requests[1])).toContain('POLICY_DENIED')
    } else {
      expect(error).toMatchObject({ code: 'DECISION_EVALUATION_ERROR', meta: { failureKind: mode === 'timeout' ? 'callback_timeout' : 'callback_failed' } })
    }
    expect(JSON.stringify(error)).not.toContain('private reviewer message')
    expect(example.handledNotes).toEqual([])
    expect(example.lifecycle).not.toContain('handler:publish_note')
  } finally {
    await session.release()
    await example.harness.shutdown()
  }
})

it('cancels an outstanding approval without publishing the note', async () => {
  const controller = new AbortController()
  const example = createGuardrailsExample({
    approval: { async request(_request, execution) {
      const cancelled = new Promise<void>((resolve) => execution.signal.addEventListener('abort', () => resolve(), { once: true }))
      controller.abort()
      await cancelled
      return { decision: 'approved' }
    } }
  })
  const session = await example.harness.getSession('composed-cancel')
  try {
    await expect(session.agents.support.prompt('Review the note.', { signal: controller.signal })).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' })
    expect(example.handledNotes).toEqual([])
    expect(example.lifecycle).not.toContain('handler:publish_note')
  } finally {
    await session.release()
    await example.harness.shutdown()
  }
})

it('blocks content without requesting approval or calling the provider', async () => {
  const example = createGuardrailsExample()
  const session = await example.harness.getSession('composed-content-block')
  try {
    await expect(session.agents.support.prompt('[blocked]')).rejects.toMatchObject({
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
