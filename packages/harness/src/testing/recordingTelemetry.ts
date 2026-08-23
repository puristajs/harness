import { SpanStatusCode, type Span } from '@opentelemetry/api'

import type { TelemetryShim } from '../telemetry/index.js'
import { telemetryErrorType } from '../telemetry/index.js'

/** A completed or active span captured by {@link RecordingTelemetry}. */
export interface RecordedTelemetrySpan {
  id: string
  parentId?: string
  name: string
  attrs: Record<string, unknown>
  status?: { code: SpanStatusCode; message?: string }
  exceptions: unknown[]
}

/** A metric measurement captured by {@link RecordingTelemetry}. */
export interface RecordedTelemetryMetric {
  kind: 'counter' | 'histogram'
  name: string
  value: number
  attrs: Record<string, unknown>
}

/**
 * In-memory OpenTelemetry shim for deterministic adapter and addon tests.
 *
 * It preserves parent/child span relationships and captures only attributes
 * explicitly supplied by the subject under test; it never exports telemetry.
 */
export class RecordingTelemetry implements TelemetryShim {
  public readonly spans: RecordedTelemetrySpan[] = []
  public readonly traceContexts: Array<{ traceparent: string; tracestate?: string }> = []
  public readonly metrics: RecordedTelemetryMetric[] = []

  private readonly stack: string[] = []

  public async span<T>(name: string, attrs: Record<string, unknown>, fn: (span: Span) => Promise<T>): Promise<T> {
    const id = `span-${this.spans.length + 1}`
    const parentId = this.stack.at(-1)
    const record: RecordedTelemetrySpan = { id, ...(parentId ? { parentId } : {}), name, attrs: { ...attrs }, exceptions: [] }
    this.spans.push(record)
    const span = {
      setAttribute: (key: string, value: unknown) => { record.attrs[key] = value; return span },
      setAttributes: (next: Record<string, unknown>) => { Object.assign(record.attrs, next); return span },
      recordException: (error: unknown) => { record.exceptions.push(error) },
      setStatus: (status: { code: SpanStatusCode; message?: string }) => { record.status = status },
      end: () => undefined
    } as unknown as Span

    this.stack.push(id)
    try {
      return await fn(span)
    } catch (error) {
      const errorType = telemetryErrorType(error)
      record.exceptions.push(new Error(errorType))
      record.attrs['error.type'] = errorType
      if (error && typeof error === 'object' && 'code' in error) {
        const harnessError = error as { code?: string; category?: string; retriable?: boolean; meta?: Record<string, unknown> }
        record.attrs['harness.error.code'] = harnessError.code
        record.attrs['harness.error.category'] = harnessError.category
        record.attrs['harness.error.retriable'] = harnessError.retriable
        if (typeof harnessError.meta?.['scope'] === 'string') record.attrs['harness.error.scope'] = harnessError.meta['scope']
        if (typeof harnessError.meta?.['timeout_ms'] === 'number') record.attrs['harness.error.timeout_ms'] = harnessError.meta['timeout_ms']
        if (harnessError.code === 'AGENT_INTERCEPTOR_ERROR') {
          if (typeof harnessError.meta?.['interceptor_id'] === 'string') record.attrs['harness.interceptor.id'] = harnessError.meta['interceptor_id']
          if (typeof harnessError.meta?.['phase'] === 'string') record.attrs['harness.interceptor.phase'] = harnessError.meta['phase']
        }
      }
      record.status = { code: SpanStatusCode.ERROR, message: errorType }
      throw error
    } finally {
      this.stack.pop()
    }
  }

  public recordHistogram(name: string, value: number, attrs: Record<string, unknown>): void {
    this.metrics.push({ kind: 'histogram', name, value, attrs: { ...attrs } })
  }

  public recordCounter(name: string, value: number, attrs: Record<string, unknown>): void {
    this.metrics.push({ kind: 'counter', name, value, attrs: { ...attrs } })
  }

  public currentTraceparent(): string | undefined {
    return this.stack.length > 0 ? '00-00000000000000000000000000000001-0000000000000001-01' : undefined
  }

  public async withTraceContext<T>(carrier: { traceparent: string; tracestate?: string }, fn: () => Promise<T>): Promise<T> {
    this.traceContexts.push(carrier)
    return fn()
  }
}
