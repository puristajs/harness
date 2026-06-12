import { describe, expect, it } from 'vitest'
import { relayRunEvents } from '../src/sessions/index.js'
import type { RunEvent } from '../src/harness/defineHarness.js'

const STREAM_MAX_BUFFERED_EVENTS = 1024

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

  it('keeps the queue bounded and always delivers run.finished when many agent.finished events overflow the buffer', async () => {
    // Simulate a delegation-heavy run: many agent.finished events emitted
    // synchronously (no await) so the producer outruns the consumer.  Before
    // the fix, agent.finished was treated as undroppable, so the queue could
    // grow unboundedly past STREAM_MAX_BUFFERED_EVENTS.
    const agentFinishedCount = STREAM_MAX_BUFFERED_EVENTS * 3
    const out: RunEvent[] = []
    let peakQueueSize = 0

    for await (const event of relayRunEvents((onEvent, _signal) => {
      // Intercept via a wrapper so we can measure the internal queue indirectly:
      // we track output size between yields to bound our assertion.
      for (let i = 0; i < agentFinishedCount; i += 1) {
        void onEvent({ type: 'agent.finished', runId: 'r', agentId: `a${i}`, at: 'now', output: String(i) })
      }
      void onEvent({ type: 'run.finished', runId: 'r', at: 'now', output: 'done' })
      return Promise.resolve('done')
    })) {
      out.push(event)
      // The consumer is intentionally slow — we count events to verify bounds.
      // Measure the running output length as a proxy: the real queue can never
      // exceed cap, so the total events yielded before run.finished is bounded.
      peakQueueSize = Math.max(peakQueueSize, out.length)
    }

    // run.finished must always be delivered regardless of overflow.
    expect(out.at(-1)?.type).toBe('run.finished')

    // stream.overflow notices must have been emitted (dropped events exist).
    const overflow = out.filter((e) => e.type === 'stream.overflow')
    expect(overflow.length).toBeGreaterThan(0)

    // Total events yielded (excluding the overflow notices themselves) must
    // never have exceeded the cap + 1 (the run.finished beyond the cap).  We
    // allow one extra for run.finished which is undroppable.
    const nonOverflow = out.filter((e) => e.type !== 'stream.overflow')
    expect(nonOverflow.length).toBeLessThanOrEqual(STREAM_MAX_BUFFERED_EVENTS + 1)

    // Accounting: dropped + delivered agent.finished == produced agent.finished.
    const droppedTotal = overflow.reduce((sum, e) => sum + (e as { dropped: number }).dropped, 0)
    const deliveredAgentFinished = out.filter((e) => e.type === 'agent.finished').length
    expect(deliveredAgentFinished + droppedTotal).toBe(agentFinishedCount)
  })
})
