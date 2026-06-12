import type { RunEvent } from '../harness/defineHarness.js'

/** Collects every event from a run-event stream into an array. */
export async function recordEvents(iter: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = []
  for await (const event of iter) {
    events.push(event)
  }
  return events
}
