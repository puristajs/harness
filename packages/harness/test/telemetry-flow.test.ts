import { SpanStatusCode } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineHarness, defineWorkflow } from '../src/index.js'
import { RecordingTelemetry } from '../src/testing/index.js'
import { telemetryErrorType } from '../src/telemetry/shim.js'

describe('v4 telemetry entrypoints', () => {
  it('executes workflow telemetry and metric helpers through a bound Harness instance', async () => {
    const workflow = defineWorkflow('observed', {
      input: z.string(), output: z.string(),
      async handler(context) {
        context.metrics.counter('app.workflow.calls')
        return context.telemetry.span('app.workflow', { 'app.workflow.id': 'observed' }, async () =>
          context.metrics.duration('app.workflow.duration', undefined, async () => context.input))
      },
    })
    const instance = await defineHarness({ name: 'telemetryHarness' }).addWorkflow(workflow)
      .getInstance({ telemetry: { flavor: 'dual', contentCaptureMode: 'NO_CONTENT' } })
    const session = await instance.getSession('telemetry-session')

    await expect(session.workflows.observed.run('ok')).resolves.toMatchObject({ status: 'completed', output: 'ok' })
    await session.destroy()
    await instance.close()
  })

  it('records deterministic span failure classification without private error messages', async () => {
    const telemetry = new RecordingTelemetry()
    const failure = new Error('private customer content')
    await expect(telemetry.span('test.operation', {}, async () => { throw failure })).rejects.toBe(failure)

    expect(telemetryErrorType(failure)).toBe('Error')
    expect(telemetry.spans[0]).toMatchObject({
      name: 'test.operation', status: { code: SpanStatusCode.ERROR, message: 'Error' },
      attrs: { 'error.type': 'Error' },
    })
    expect(JSON.stringify(telemetry.spans[0])).not.toContain('private customer content')
  })
})
