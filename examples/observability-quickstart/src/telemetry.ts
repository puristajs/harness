import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { PeriodicExportingMetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

export interface OpenTelemetryOptions {
  traceExporter?: SpanExporter
  metricExporter?: PushMetricExporter
  metricExportIntervalMs?: number
}

export interface OpenTelemetryRuntime {
  forceFlush(): Promise<void>
  shutdown(): Promise<void>
}

function signalEndpoint(signal: 'traces' | 'metrics'): string {
  const signalName = signal.toUpperCase()
  const explicit = process.env[`OTEL_EXPORTER_OTLP_${signalName}_ENDPOINT`]
  if (explicit) return explicit

  const base = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://localhost:4318'
  return `${base.replace(/\/$/, '')}/v1/${signal}`
}

export function startOpenTelemetry(options: OpenTelemetryOptions = {}): OpenTelemetryRuntime {
  const traceExporter = options.traceExporter ?? new OTLPTraceExporter({
    url: signalEndpoint('traces'),
  })
  const metricExporter = options.metricExporter ?? new OTLPMetricExporter({
    url: signalEndpoint('metrics'),
  })

  const spanProcessor = new BatchSpanProcessor(traceExporter)
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: options.metricExportIntervalMs ?? 10_000,
  })
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'support-agent',
    }),
    spanProcessors: [spanProcessor],
    metricReaders: [metricReader],
  })

  sdk.start()
  return {
    async forceFlush() {
      await Promise.all([spanProcessor.forceFlush(), metricReader.forceFlush()])
    },
    async shutdown() {
      await sdk.shutdown()
    },
  }
}
