import type { ExecutionEvent } from '../definitions/execution-events.js'
import type { JsonValue } from '../models/json.js'

/** Collects every event from a v4 execution stream into an array. */
export async function recordEvents(iter: AsyncIterable<ExecutionEvent>): Promise<ExecutionEvent<JsonValue>[]> {
  const events: ExecutionEvent<JsonValue>[] = []
  for await (const event of iter) {
    events.push(event)
  }
  return events
}
