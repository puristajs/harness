import type { Span } from '@opentelemetry/api'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'

/**
 * Bridges a span-scoped producer stream to a plain consumer `AsyncIterable`.
 *
 * The telemetry span must stay open for the full lifetime of the stream, so a
 * producer task pulls chunks inside `telemetry.span(...)` and hands them to the
 * consumer generator. Two guarantees keep this safe for model streams:
 *
 * - Backpressure: after pushing a chunk the producer waits until the consumer
 *   has drained it, so a slow consumer never accumulates an unbounded queue.
 * - Consumer abandonment: when the consumer stops early (break/return/throw),
 *   the producer is woken, stops pulling, and closes the underlying iterator
 *   so the provider stream is released instead of draining to completion.
 */
export function pumpStreamThroughSpan<T>(
  telemetry: TelemetryShim,
  name: string,
  attrs: SpanAttrs,
  iterate: (span: Span) => AsyncIterable<T>
): AsyncIterable<T> {
  return (async function* () {
    const queue: T[] = []
    let producerDone = false
    let producerFailure: unknown
    let consumerAbandoned = false
    let notifyConsumer: (() => void) | undefined
    let notifyProducer: (() => void) | undefined
    const wakeConsumer = () => {
      notifyConsumer?.()
      notifyConsumer = undefined
    }
    const wakeProducer = () => {
      notifyProducer?.()
      notifyProducer = undefined
    }

    const producer = telemetry.span(name, attrs, async (span) => {
      const iterator = iterate(span)[Symbol.asyncIterator]()
      try {
        while (!consumerAbandoned) {
          const next = await iterator.next()
          if (next.done) return
          queue.push(next.value)
          wakeConsumer()
          // Backpressure: wait for consumer demand before pulling the next chunk.
          while (queue.length > 0 && !consumerAbandoned) {
            await new Promise<void>((resolve) => { notifyProducer = resolve })
          }
        }
      } finally {
        await iterator.return?.()
      }
    }).catch((error) => {
      // Failures after consumer abandonment have no consumer left to observe them.
      if (!consumerAbandoned) producerFailure = error
    }).finally(() => {
      producerDone = true
      wakeConsumer()
    })

    try {
      while (true) {
        if (queue.length > 0) {
          const chunk = queue.shift() as T
          wakeProducer()
          yield chunk
          continue
        }
        if (producerDone) break
        await new Promise<void>((resolve) => { notifyConsumer = resolve })
      }
      if (producerFailure) throw producerFailure
    } finally {
      consumerAbandoned = true
      wakeProducer()
      await producer
    }
  })()
}
