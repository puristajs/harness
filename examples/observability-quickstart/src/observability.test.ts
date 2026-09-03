import { AggregationTemporality, InMemoryMetricExporter } from '@opentelemetry/sdk-metrics'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { FakeModelProvider } from '@purista/harness/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createObservedHarness } from './harness.js'
import { startOpenTelemetry } from './telemetry.js'

const spanExporter = new InMemorySpanExporter()
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
const telemetry = startOpenTelemetry({
  traceExporter: spanExporter,
  metricExporter,
  metricExportIntervalMs: 60_000,
})

beforeAll(() => undefined)
afterAll(async () => telemetry.shutdown())

describe('observability quickstart', () => {
  it('exports Harness spans, application metrics, and correlated safe logs', async () => {
    const provider = new FakeModelProvider({ strict: true })
    provider.enqueueObject({
      object: { answer: 'Open Billing and choose Edit address.' },
      usage: { inputTokens: 8, outputTokens: 7, totalTokens: 15 },
      finishReason: 'stop',
    })
    const logLines: string[] = []
    const harness = createObservedHarness({
      provider,
      logger: new (await import('@purista/harness')).JsonLogger({
        out: { write: chunk => logLines.push(chunk) },
        bindings: { service: 'support-agent' },
      }),
    })

    try {
      const session = await harness.getSession('observability-test')
      await expect(session.workflows.handle_ticket.run({
        ticketId: 'SUP-42',
        question: 'How can I update my billing address?',
      })).resolves.toMatchObject({ status: 'completed', output: { answer: 'Open Billing and choose Edit address.' } })
      await telemetry.forceFlush()

      const spanNames = spanExporter.getFinishedSpans().map(span => span.name)
      expect(spanNames).toContain('harness.workflow.run')
      expect(spanNames).toContain('invoke_agent answer_ticket')

      const metricNames = metricExporter.getMetrics().flatMap(resource =>
        resource.scopeMetrics.flatMap(scope => scope.metrics.map(metric => metric.descriptor.name)),
      )
      expect(metricNames).toContain('support.tickets.started')
      expect(metricNames).toContain('support.ticket.duration')

      const log = JSON.parse(logLines.find(line => line.includes('Handling support ticket.')) ?? '{}')
      expect(log.ticket_id).toBe('SUP-42')
      expect(log.trace_id).toMatch(/^[0-9a-f]{32}$/)
      expect(log.span_id).toMatch(/^[0-9a-f]{16}$/)
      const capturedTelemetry = spanExporter.getFinishedSpans().map(span => ({
        attributes: span.attributes,
        events: span.events.map(event => ({ name: event.name, attributes: event.attributes })),
      }))
      expect(JSON.stringify(capturedTelemetry)).not.toContain('billing address')
    } finally {
      await harness.shutdown()
    }
  })
})
