import { describe, expect, it } from 'vitest'
import { relayRunEvents } from '../src/sessions/index.js'
import type { RunEvent } from '../src/harness/defineHarness.js'

describe('relayRunEvents', () => {
  it('delivers events in order and completes', async () => {
    const out: RunEvent[] = []
    for await (const event of relayRunEvents(async (onEvent) => {
      await onEvent({ type: 'run.started', runId: 'r', at: 'now' })
      await onEvent({ type: 'model.delta', runId: 'r', streamId: 's', agentId: 'a', delta: 'x' })
      await onEvent({ type: 'run.finished', runId: 'r', at: 'now', output: 'done' })
      return 'done'
    })) {
      out.push(event)
    }
    expect(out.map((e) => e.type)).toEqual(['run.started', 'model.delta', 'run.finished'])
  })

  it('drops only oldest non-terminal events on overflow, never loses a delivered event, keeps run.finished', async () => {
    const total = 2000
    const out: RunEvent[] = []
    for await (const event of relayRunEvents((onEvent) => {
      // Push synchronously (no await) so the producer outruns the consumer and overflows.
      for (let i = 0; i < total; i += 1) {
        void onEvent({ type: 'model.delta', runId: 'r', streamId: 's', agentId: 'a', delta: String(i) })
      }
      void onEvent({ type: 'run.finished', runId: 'r', at: 'now', output: 'done' })
      return Promise.resolve('done')
    })) {
      out.push(event)
    }

    const overflow = out.filter((e) => e.type === 'stream.overflow')
    expect(overflow.length).toBeGreaterThan(0)
    const droppedTotal = overflow.reduce((sum, e) => sum + (e as { dropped: number }).dropped, 0)

    const deltas = out.filter((e) => e.type === 'model.delta') as Array<{ delta: string }>
    // The terminal event is never dropped.
    expect(out.at(-1)?.type).toBe('run.finished')
    // Delivered deltas are strictly increasing (no reordering / no skipped-but-uncounted loss).
    const values = deltas.map((d) => Number(d.delta))
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
    // Accounting balances: delivered deltas + dropped == produced deltas.
    expect(deltas.length + droppedTotal).toBe(total)
  })
})
