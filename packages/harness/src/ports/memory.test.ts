import { expect, it } from 'vitest'
import type { Span } from '@opentelemetry/api'
import { ModelCapabilityError, ValidationError } from '../errors/index.js'
import { sandboxMemory } from '../memory/sandbox/index.js'
import { inMemorySandbox } from '../sandbox/index.js'
import { FakeMemoryAdapter } from '../testing/fakeMemoryAdapter.js'
import { createMemoryFacade, type MemoryAdapter } from './memory.js'
import type { Logger } from '../logger/index.js'
import type { SpanAttrs, TelemetryShim } from '../telemetry/index.js'

class RecordingMemoryTelemetry implements TelemetryShim {
  public readonly spans: Array<{ name: string; attrs: Record<string, unknown> }> = []
  public readonly metrics: Array<{ name: string; value: number; attrs: Record<string, unknown> }> = []

  public async span<T>(name: string, attrs: SpanAttrs, fn: (span: Span) => Promise<T>): Promise<T> {
    const record = { name, attrs: { ...attrs } }
    this.spans.push(record)
    const span = {
      setAttribute: (key: string, value: unknown) => { record.attrs[key] = value; return span },
      setAttributes: (attrs: Record<string, unknown>) => { Object.assign(record.attrs, attrs); return span },
      addEvent: (_name: string, attrs?: Record<string, unknown>) => { Object.assign(record.attrs, attrs); return span },
      recordException: () => undefined,
      setStatus: () => undefined,
      end: () => undefined
    } as unknown as Span
    return fn(span)
  }

  public recordHistogram(name: string, value: number, attrs: SpanAttrs): void {
    this.metrics.push({ name, value, attrs: { ...attrs } })
  }

  public recordCounter(name: string, value: number, attrs: SpanAttrs): void {
    this.metrics.push({ name, value, attrs: { ...attrs } })
  }

  public currentTraceparent(): string | undefined {
    return undefined
  }
}

const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => logger
}

function memory(adapter: MemoryAdapter, telemetry = new RecordingMemoryTelemetry(), contentCaptureMode = 'NO_CONTENT' as const) {
  return {
    telemetry,
    facade: createMemoryFacade({
      adapter,
      logger,
      telemetry,
      contentCaptureMode,
      signal: new AbortController().signal,
      harnessName: 'memory-test',
      sessionId: 's1',
      runId: 'r1',
      agentId: 'a1',
      metadata: { userId: 'u1', tenantId: 't1' }
    })
  }
}

it('round-trips scoped memory and propagates types through read<T>()', async () => {
  const { facade } = memory(new FakeMemoryAdapter())

  await facade.session.write('topic', { value: 'pricing' })
  const topic = await facade.session.read<{ value: string }>('topic')
  await facade.run.write('step', 'started')
  await facade.agent?.write('preference', { tone: 'short' })
  await facade.user().write('locale', 'de-DE')
  await facade.tenant().write('policy', 'approved')

  expect(topic?.value).toBe('pricing')
  expect(await facade.session.list()).toEqual(['topic'])
  expect(await facade.session.search?.({ text: 'pricing' })).toEqual([{ key: 'topic', value: { value: 'pricing' }, score: 1 }])
})

it('fails before adapter IO when scope identifiers or capabilities are missing', async () => {
  const adapter = new FakeMemoryAdapter()
  const telemetry = new RecordingMemoryTelemetry()
  const facade = createMemoryFacade({
    adapter,
    logger,
    telemetry,
    contentCaptureMode: 'NO_CONTENT',
    signal: new AbortController().signal,
    harnessName: 'memory-test',
    sessionId: 's1',
    runId: 'r1',
    metadata: {}
  })

  await expect(facade.user().read('x')).rejects.toBeInstanceOf(ValidationError)

  const unsupported = memory(sandboxMemory()).facade
  await expect(unsupported.session.search?.({ text: 'x' })).rejects.toBeInstanceOf(ModelCapabilityError)
})

it('omits raw memory content by default and captures bounded content only when enabled', async () => {
  const noContentTelemetry = new RecordingMemoryTelemetry()
  const noContent = memory(new FakeMemoryAdapter(), noContentTelemetry, 'NO_CONTENT').facade
  await noContent.session.write('secret_key', { secret: 'value' })
  expect(noContentTelemetry.spans.at(0)?.attrs['harness.memory.key']).toBeUndefined()
  expect(noContentTelemetry.spans.at(0)?.attrs['harness.memory.value']).toBeUndefined()

  const captureTelemetry = new RecordingMemoryTelemetry()
  const capture = memory(new FakeMemoryAdapter(), captureTelemetry, 'SPAN_ONLY').facade
  await capture.session.write('visible_key', { value: 'ok' })
  expect(captureTelemetry.spans.at(0)?.attrs).toMatchObject({
    'harness.memory.key': 'visible_key',
    'harness.memory.value': '{"value":"ok"}'
  })
})

it('stores sandbox memory values and metadata under the documented paths', async () => {
  const telemetry = new RecordingMemoryTelemetry()
  const sandbox = await inMemorySandbox().open({
    sessionId: 's1',
    runId: 'r1',
    signal: new AbortController().signal
  })
  const facade = createMemoryFacade({
    adapter: sandboxMemory(),
    logger,
    telemetry,
    contentCaptureMode: 'NO_CONTENT',
    signal: new AbortController().signal,
    harnessName: 'memory-test',
    sessionId: 's1',
    runId: 'r1',
    sandbox
  })

  await facade.session.write('profile', { locale: 'de-DE' }, { tags: ['user'], metadata: { source: 'test' } })

  expect(JSON.parse(await sandbox.readText('/memory/session/profile.json'))).toEqual({ locale: 'de-DE' })
  expect(JSON.parse(await sandbox.readText('/memory/.meta/session/profile.json'))).toMatchObject({
    tags: ['user'],
    metadata: { source: 'test' }
  })
  expect(await sandbox.exists('/memory/profile.json')).toBe(false)
})
