import { describe, expect, it } from 'vitest'
import type { ExecutionEvent } from '@purista/harness'
import { adaptExecutionEvent } from './streamAdapter.js'

const correlation = { eventId: 'event-1', sequence: 1, runId: 'run-1', at: '2026-01-01T00:00:00.000Z' }

describe('living wiki execution-event adapter', () => {
  it.each([
    [{ status: 'completed', runId: 'run-1', output: { answer: 'ok' } }, 'completed', undefined],
    [{ status: 'interrupted', runId: 'run-1', interrupt: { type: 'external-wait', runId: 'run-1', interruptId: 'wait-1', revision: 'revision-1', eventId: 'event-1', waitId: 'wait-1', kind: 'review', schemaVersion: '1', definitionVersion: '1', deadline: '2026-01-02T00:00:00.000Z' } }, 'interrupted', undefined],
    [{ status: 'failed', runId: 'run-1', error: { name: 'Error', message: 'failed exactly' } }, 'failed', 'failed exactly'],
    [{ status: 'cancelled', runId: 'run-1', error: { name: 'Error', message: 'cancelled exactly' } }, 'cancelled', 'cancelled exactly'],
  ] as const)('maps canonical terminal status %# exactly', (outcome, state, failedMessage) => {
    const event = { ...correlation, type: 'run.finished', outcome } as ExecutionEvent
    expect(adaptExecutionEvent(event)).toContainEqual({
      kind: 'finished',
      state,
      ...(failedMessage ? { failedMessage } : {}),
    })
  })
})
