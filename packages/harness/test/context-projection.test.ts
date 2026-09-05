import { expect, it } from 'vitest'
import {
  projectToolResults,
  validateContextProjection,
} from '../src/index.js'
import type { ModelMessage } from '../src/index.js'

it('prunes oversized UTF-8 tool results deterministically without breaking the tool-call id', () => {
  const messages: ModelMessage[] = [{ role: 'tool', toolCallId: 'call-1', content: 'é'.repeat(80) }]
  const policy = { toolResultPruner: { maxBytes: 96, headBytes: 12, tailBytes: 12 } }
  const projected = projectToolResults(messages, policy)
  expect(projected[0]?.toolCallId).toBe('call-1')
  expect(projected[0]?.content).toContain('UTF-8 bytes omitted')
  expect(projected).toEqual(projectToolResults(projected, policy))
})

it('accounts for the exact custom marker and omission annotation bytes', () => {
  const marker = 'x'.repeat(80)
  const policy = { toolResultPruner: { maxBytes: 128, headBytes: 12, tailBytes: 12, marker } }
  // The old fixed 64-byte allowance accepted this policy even though rendering
  // its custom marker could exceed the configured cap.
  expect(validateContextProjection(policy)).toBe(false)

  const validPolicy = { toolResultPruner: { maxBytes: 128, headBytes: 12, tailBytes: 12, marker: 'x'.repeat(48) } }
  expect(validateContextProjection(validPolicy)).toBe(true)
  const projected = projectToolResults([{ role: 'tool', toolCallId: 'call-1', content: 'é'.repeat(200) }], validPolicy)
  expect(Buffer.byteLength(projected[0]?.content ?? '', 'utf8')).toBeLessThanOrEqual(
    validPolicy.toolResultPruner.maxBytes,
  )
})

it('does not treat tool-controlled marker text as an existing projection', () => {
  const marker = '[projection]'
  const policy = { toolResultPruner: { maxBytes: 96, headBytes: 12, tailBytes: 12, marker } }
  const original = {
    role: 'tool' as const,
    toolCallId: 'call-1',
    content: `${marker} (not a harness projection) ${'x'.repeat(200)}`,
  }
  const [projected] = projectToolResults([original], policy)
  expect(projected).not.toBe(original)
  expect(Buffer.byteLength(projected?.content ?? '', 'utf8')).toBeLessThanOrEqual(policy.toolResultPruner.maxBytes)
})
