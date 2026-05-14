import { SpanStatusCode, context, metrics, propagation, trace } from '@opentelemetry/api'
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions'
import { HarnessError } from '../errors/index.js'
import { sanitizeForLog } from '../errors/redaction.js'

/** Attributes accepted by telemetry span/metric helpers. */
export type SpanAttrs = Record<string, string | number | boolean | string[] | undefined>

type AttrValue = string | number | boolean | string[]

/** Developer-facing metric helper exposed in handler contexts. */
export interface Metrics {
  /** Adds to a counter instrument. */
  counter(name: string, value?: number, attrs?: SpanAttrs): void
  /** Records a histogram sample. */
  histogram(name: string, value: number, attrs?: SpanAttrs): void
  /** Records the duration of an async operation in seconds. */
  duration<T>(name: string, attrs: SpanAttrs | undefined, fn: () => Promise<T>): Promise<T>
}

/** Minimal telemetry abstraction used by harness internals and integrations. */
export interface TelemetryShim {
  /** Creates a span, executes `fn`, and closes the span with success/error status. */
  span<T>(name: string, attrs: SpanAttrs, fn: (span: import('@opentelemetry/api').Span) => Promise<T>): Promise<T>
  /** Records a histogram value with attributes. */
  recordHistogram(name: string, value: number, attrs: SpanAttrs): void
  /** Records a counter increment/add value with attributes. */
  recordCounter(name: string, value: number, attrs: SpanAttrs): void
  /** Injects the current active trace context into a W3C traceparent carrier. */
  currentTraceparent(): string | undefined
  /** Runs `fn` with the supplied W3C Trace Context as the active parent context. */
  withTraceContext?<T>(carrier: { traceparent: string; tracestate?: string }, fn: () => Promise<T>): Promise<T>
}

function sanitizeAttrs(attrs: SpanAttrs): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      out[key] = [...value]
    } else {
      out[key] = value
    }
  }
  return out
}

function errorAttributes(error: unknown): SpanAttrs {
  if (error instanceof HarnessError) {
    const meta = asRecord(error.meta)
    const providerBody = meta ? jsonAttr(sanitizeForLog(meta['providerBody'])) : undefined
    return {
      [ATTR_ERROR_TYPE]: error.code,
      'harness.error.code': error.code,
      'harness.error.category': error.category,
      'harness.error.retriable': error.retriable,
      'harness.error.provider': stringAttr(meta?.['provider']),
      'harness.error.model': stringAttr(meta?.['model']),
      'harness.error.model_provider_status': numberAttr(meta?.['status']),
      'harness.error.model_provider_code': stringAttr(meta?.['providerCode']),
      'harness.error.model_provider_type': stringAttr(meta?.['providerType']),
      'harness.error.model_provider_param': stringAttr(meta?.['providerParam']),
      'harness.error.model_provider_request_id': stringAttr(meta?.['providerRequestId']),
      'harness.error.model_provider_message': stringAttr(meta?.['providerMessage']),
      'harness.error.model_provider_body': providerBody
    }
  }
  const name = error instanceof Error ? error.name : 'Error'
  return {
    [ATTR_ERROR_TYPE]: name,
    'harness.error.code': name,
    'harness.error.category': 'internal',
    'harness.error.retriable': false
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 4000) : undefined
}

function numberAttr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function jsonAttr(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value).slice(0, 8000)
  } catch {
    return undefined
  }
}

/** OpenTelemetry-backed implementation of {@link TelemetryShim}. */
export class OtelTelemetryShim implements TelemetryShim {
  private readonly tracer = trace.getTracer('@purista/harness')
  private readonly meter = metrics.getMeter('@purista/harness')
  private readonly histograms = new Map<string, import('@opentelemetry/api').Histogram>()
  private readonly counters = new Map<string, import('@opentelemetry/api').Counter>()

  public async span<T>(name: string, attrs: SpanAttrs, fn: (span: import('@opentelemetry/api').Span) => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes: sanitizeAttrs(attrs) }, async (span) => {
      try {
        const result = await fn(span)
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (error) {
        span.setAttributes(sanitizeAttrs(errorAttributes(error)))
        const recordedError = error instanceof HarnessError
          ? new Error(error.message)
          : error instanceof Error
            ? new Error(error.message)
            : new Error(String(error))
        span.recordException(recordedError)
        span.setStatus({ code: SpanStatusCode.ERROR, message: recordedError.message })
        throw error
      } finally {
        span.end()
      }
    })
  }

  public recordHistogram(name: string, value: number, attrs: SpanAttrs): void {
    let histogram = this.histograms.get(name)
    if (!histogram) {
      histogram = this.meter.createHistogram(name)
      this.histograms.set(name, histogram)
    }
    histogram.record(value, sanitizeAttrs(attrs))
  }

  public recordCounter(name: string, value: number, attrs: SpanAttrs): void {
    let counter = this.counters.get(name)
    if (!counter) {
      counter = this.meter.createCounter(name)
      this.counters.set(name, counter)
    }
    counter.add(value, sanitizeAttrs(attrs))
  }

  public currentTraceparent(): string | undefined {
    const carrier: Record<string, string> = {}
    propagation.inject(context.active(), carrier)
    return carrier['traceparent']
  }

  public async withTraceContext<T>(carrier: { traceparent: string; tracestate?: string }, fn: () => Promise<T>): Promise<T> {
    const extracted = propagation.extract(context.active(), {
      traceparent: carrier.traceparent,
      ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {})
    })
    return context.with(extracted, fn)
  }
}

/** Creates the default telemetry shim instance. */
export function createTelemetryShim(): TelemetryShim {
  return new OtelTelemetryShim()
}

/** Creates a scoped metrics helper with default attributes merged into every metric. */
export function createMetrics(telemetry: TelemetryShim, defaultAttrs: SpanAttrs = {}): Metrics {
  const merge = (attrs: SpanAttrs | undefined): SpanAttrs => ({ ...defaultAttrs, ...(attrs ?? {}) })
  return {
    counter(name, value = 1, attrs) {
      telemetry.recordCounter(name, value, merge(attrs))
    },
    histogram(name, value, attrs) {
      telemetry.recordHistogram(name, value, merge(attrs))
    },
    async duration(name, attrs, fn) {
      const started = Date.now()
      try {
        return await fn()
      } finally {
        telemetry.recordHistogram(name, (Date.now() - started) / 1000, merge(attrs))
      }
    }
  }
}
