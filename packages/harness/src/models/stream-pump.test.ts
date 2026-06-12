import { describe, expect, it } from 'vitest'

import { pumpStreamThroughSpan } from './stream-pump.js'
import type { TelemetryShim } from '../telemetry/index.js'

function telemetryShim(spanNames: string[] = []): TelemetryShim {
  return {
    span: async (name, _attrs, fn) => {
      spanNames.push(name)
      return fn({ setStatus: () => undefined, recordException: () => undefined, end: () => undefined } as never)
    },
    recordHistogram: () => undefined,
    recordCounter: () => undefined,
    currentTraceparent: () => undefined
  }
}

describe('pumpStreamThroughSpan', () => {
  it('delivers all chunks in order and keeps the span open for the stream lifetime', async () => {
    const spanNames: string[] = []
    const stream = pumpStreamThroughSpan(telemetryShim(spanNames), 'test.span', {}, async function* () {
      yield 1
      yield 2
      yield 3
    })

    const received: number[] = []
    for await (const chunk of stream) received.push(chunk)

    expect(received).toEqual([1, 2, 3])
    expect(spanNames).toEqual(['test.span'])
  })

  it('applies backpressure so the producer never runs ahead of the consumer', async () => {
    let produced = 0
    const stream = pumpStreamThroughSpan(telemetryShim(), 'test.span', {}, async function* () {
      for (let index = 0; index < 10; index += 1) {
        produced += 1
        yield index
      }
    })

    const iterator = stream[Symbol.asyncIterator]()
    await iterator.next()
    // Give the producer plenty of chances to run ahead if unbounded.
    await new Promise((resolve) => setTimeout(resolve, 20))
    // One delivered chunk plus at most one buffered chunk awaiting demand.
    expect(produced).toBeLessThanOrEqual(2)

    const rest: number[] = []
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      rest.push(next.value)
    }
    expect(produced).toBe(10)
    expect(rest).toHaveLength(9)
  })

  it('stops the producer and closes the source when the consumer breaks early', async () => {
    let produced = 0
    let closed = false
    const stream = pumpStreamThroughSpan(telemetryShim(), 'test.span', {}, async function* () {
      try {
        for (let index = 0; index < 100; index += 1) {
          produced += 1
          yield index
        }
      } finally {
        closed = true
      }
    })

    for await (const chunk of stream) {
      if (chunk >= 1) break
    }
    // The generator's finally must have run by the time iteration returns.
    expect(closed).toBe(true)
    expect(produced).toBeLessThanOrEqual(3)
  })

  it('propagates producer failures to the consumer', async () => {
    const stream = pumpStreamThroughSpan(telemetryShim(), 'test.span', {}, async function* () {
      yield 1
      throw new Error('producer failed')
    })

    const received: number[] = []
    await expect((async () => {
      for await (const chunk of stream) received.push(chunk)
    })()).rejects.toThrow('producer failed')
    expect(received).toEqual([1])
  })

  it('propagates failures thrown before the first chunk', async () => {
    const failBeforeFirstChunk = true
    const stream = pumpStreamThroughSpan(telemetryShim(), 'test.span', {}, async function* () {
      if (failBeforeFirstChunk) throw new Error('immediate failure')
      yield 1
    })

    await expect((async () => {
      for await (const _chunk of stream) {
        // never reached
      }
    })()).rejects.toThrow('immediate failure')
  })
})
