import { describe, expect, it } from 'vitest'
import type { Message } from '../models/state.js'
import { InMemoryHarnessStorage } from './in-memory.js'
import { JsonLogger } from '../logger/index.js'
import { createMetrics } from '../telemetry/index.js'
import { RecordingTelemetry } from '../testing/recordingTelemetry.js'

function message(id: string): Message {
  return { id, sessionId: 's1', role: 'user', content: 'hello', timestamp: new Date().toISOString() }
}

describe('InMemoryHarnessStorage message operations', () => {
  it('reports the actual operation for duplicate ids in replaceMessages', async () => {
    const store = new InMemoryHarnessStorage()

    await expect(store.replaceMessages('s1', [message('m1'), message('m1')])).rejects.toMatchObject({
      code: 'STATE_ERROR',
      meta: { op: 'replaceMessages', reason: 'duplicate_message_id' }
    })
  })

  it('keeps reporting appendMessages for duplicate ids in appendMessages', async () => {
    const store = new InMemoryHarnessStorage()
    await store.appendMessages('s1', [message('m1')])

    await expect(store.appendMessages('s1', [message('m1')])).rejects.toMatchObject({
      code: 'STATE_ERROR',
      meta: { op: 'appendMessages', reason: 'duplicate_message_id' }
    })
  })

  it('emits content-free storage spans and metrics for recoverable execution', async () => {
    const telemetry = new RecordingTelemetry()
    const store = new InMemoryHarnessStorage()
    store.configureHarnessContext({
      harnessName: 'storage-test',
      logger: new JsonLogger({ level: 'fatal', out: { write: () => undefined } }),
      telemetry,
      metrics: createMetrics(telemetry),
      contentCaptureMode: 'NO_CONTENT',
      defaults: {
        agentMaxIterations: 1,
        runTimeoutMs: 1,
        toolTimeoutMs: 1,
        skillTimeoutMs: 1,
        modelTimeoutMs: 1,
        maxParallelToolCalls: 1
      }
    })
    await store.createRun({ id: 'run-otel', sessionId: 'session-otel', kind: 'workflow', target: 'test', startedAt: new Date().toISOString(), status: 'running' })
    const lease = await store.acquireRun({ runId: 'run-otel', sessionId: 'session-otel', workerId: 'worker', stepId: 'start', input: { private: 'must-not-leak' } })
    await store.commitCheckpoint({ runId: lease.runId, sessionId: lease.sessionId, workerId: lease.workerId, leaseId: lease.leaseId, stepId: 'step', input: lease.start.input, output: { private: 'must-not-leak' }, attempt: lease.attempt, sequence: 1 })
    await store.registerWait({ runId: lease.runId, sessionId: lease.sessionId, waitId: 'wait-otel', kind: 'approval', schemaVersion: 'v1', definitionVersion: 'v1', deadline: '2030-01-01T00:00:00.000Z' })
    await store.signalWait({ waitId: 'wait-otel', eventId: 'event-otel', outcome: 'approved' })

    expect(telemetry.spans.map((span) => span.name)).toEqual([
      'harness.storage.acquire_run',
      'harness.storage.commit_checkpoint',
      'harness.storage.register_wait',
      'harness.storage.signal_wait'
    ])
    expect(telemetry.metrics.filter((metric) => metric.name === 'harness.storage.operations')).toHaveLength(4)
    expect(JSON.stringify(telemetry.spans)).not.toContain('must-not-leak')
    expect(JSON.stringify(telemetry.spans)).not.toContain('wait-otel')
    expect(JSON.stringify(telemetry.spans)).not.toContain('event-otel')
  })
})
