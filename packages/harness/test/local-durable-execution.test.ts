import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  defineHarness,
  localDirectorySandbox,
  localDirectoryWorkspaceStore,
  localDurableExecution,
  sqliteDurableRuntime
} from '../src/index.js'
import { createLocalWorkspaceCoordinator } from '../src/local/local-workspace.js'
import type { HarnessAdapterContext } from '../src/ports/harness-context.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { RecordingLogger, RecordingTelemetry } from './telemetryFlowHarness.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'purista-harness-'))
}

function configureForTelemetry(adapter: unknown, telemetry: RecordingTelemetry): void {
  const configurable = adapter as { configureHarnessContext?: (context: HarnessAdapterContext) => void }
  configurable.configureHarnessContext?.({
    harnessName: 'local-durable-test',
    logger: new RecordingLogger(),
    telemetry,
    metrics: {
      counter: (name, value = 1, attrs) => telemetry.recordCounter(name, value, attrs ?? {}),
      histogram: (name, value, attrs) => telemetry.recordHistogram(name, value, attrs ?? {}),
      duration: async (_name, _attrs, fn) => fn()
    },
    contentCaptureMode: 'NO_CONTENT',
    defaults: {
      agentMaxIterations: 4,
      runTimeoutMs: 60_000,
      toolTimeoutMs: 10_000,
      skillTimeoutMs: 10_000,
      modelTimeoutMs: 60_000,
      maxParallelToolCalls: 8
    }
  })
}

describe('local durable execution', () => {
  it('persists durable runtime checkpoints across adapter rebuilds', async () => {
    const root = await tempRoot()
    const file = join(root, 'runtime.sqlite')
    const runtime = sqliteDurableRuntime({ file })
    const lease = await runtime.startRun({
      runId: 'run-1',
      sessionId: 'session-1',
      workerId: 'worker-1',
      stepId: 'step-a',
      input: { ok: true }
    })
    await runtime.commitCheckpoint({
      runId: lease.runId,
      sessionId: lease.sessionId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      stepId: 'step-a',
      input: lease.start.input,
      attempt: lease.attempt,
      sequence: 1,
      output: { value: 1 }
    })
    await lease.release()
    await runtime.close()

    const reopened = sqliteDurableRuntime({ file })
    const resumed = await reopened.startRun({
      runId: 'run-1',
      sessionId: 'session-1',
      workerId: 'worker-1',
      stepId: 'step-a',
      input: { ok: true }
    })
    expect(resumed.resumed).toBe(true)
    expect(resumed.checkpoint?.output).toEqual({ value: 1 })
    await reopened.close()
  })

  it('restores files written through the local sandbox from a workspace checkpoint', async () => {
    const root = await tempRoot()
    const coordinator = createLocalWorkspaceCoordinator()
    const workspaceStore = localDirectoryWorkspaceStore({ root, coordinator })
    const sandbox = localDirectorySandbox({ root, coordinator, exec: false })

    const handle = await workspaceStore.startWorkspace({
      runId: 'run-files',
      sessionId: 'session-files',
      attempt: 1,
      idempotencyKey: 'start'
    })
    const session = await sandbox.open({ runId: 'run-files', sessionId: 'session-files' })
    await session.write('/workspace/note.txt', 'first')
    const checkpoint = await workspaceStore.pauseWorkspace({
      handle,
      stepId: 'write-note',
      sequence: 1,
      attempt: 1,
      reason: 'step_completed',
      idempotencyKey: 'pause'
    })
    await session.write('/workspace/note.txt', 'mutated')

    await workspaceStore.resumeWorkspace({
      workspaceRef: handle.workspaceRef,
      checkpointRef: checkpoint.checkpointRef,
      runId: 'run-files',
      sessionId: 'session-files',
      attempt: 2,
      idempotencyKey: 'resume'
    })
    const resumed = await sandbox.open({ runId: 'run-files', sessionId: 'session-files' })
    await expect(resumed.readText('/workspace/note.txt')).resolves.toBe('first')
  })

  it('replays durable workflow steps across harness rebuilds with the local bundle', async () => {
    const root = await tempRoot()
    const effects: Record<string, number> = {}

    function build(mode: 'fail' | 'success') {
      const local = localDurableExecution({ root })
      const model = new FakeModelProvider()
      return {
        local,
        harness: defineHarness()
          .state(local.state)
          .runtime(local.runtime)
          .sandbox(local.sandbox)
          .workspaceStore(local.workspaceStore)
          .checkpoints(local.checkpoints)
          .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
          .tools({})
          .skills({})
          .agents({ noop: { model: 'fast', instructions: 'x', builtinTools: false } })
          .workflows({
            recover: {
              input: z.string(),
              output: z.string(),
              handler: async (ctx) => {
                const a = await ctx.step('a', async () => {
                  effects['a'] = (effects['a'] ?? 0) + 1
                  await ctx.checkpoints.write({ sequence: 1, kind: 'summary', payload: { phase: 'a' } })
                  return { a: 1 }
                })
                if (mode === 'fail') throw new Error('boom')
                const b = await ctx.step('b', async () => {
                  effects['b'] = (effects['b'] ?? 0) + 1
                  return { b: 2 }
                })
                return JSON.stringify({ ...a, ...b })
              }
            }
          })
          .build()
      }
    }

    const first = build('fail')
    const firstSession = await first.harness.getSession('session-retry')
    await expect(firstSession.workflows.recover.prompt('go', { durable: { runId: 'run-retry' } })).rejects.toThrow('boom')
    await first.harness.shutdown()

    const second = build('success')
    const secondSession = await second.harness.getSession('session-retry')
    await expect(secondSession.workflows.recover.prompt('go', { durable: { runId: 'run-retry' } })).resolves.toBe(JSON.stringify({ a: 1, b: 2 }))
    expect(effects).toEqual({ a: 1, b: 1 })
    await expect(second.local.checkpoints.list({ runId: 'run-retry', sessionId: 'session-retry' })).resolves.toHaveLength(1)
    await second.harness.shutdown()
  })

  it('emits privacy-safe telemetry for local runtime, workspace, sandbox, and context checkpoints', async () => {
    const root = await tempRoot()
    const telemetry = new RecordingTelemetry()
    const local = localDurableExecution({ root })
    configureForTelemetry(local.state, telemetry)
    configureForTelemetry(local.workspaceStore, telemetry)
    configureForTelemetry(local.sandbox, telemetry)

    const lease = await local.runtime.startRun({
      runId: 'run-otel',
      sessionId: 'session-otel',
      workerId: 'worker-otel',
      stepId: 'collect',
      input: { prompt: 'private prompt text' }
    })
    await local.runtime.loadCheckpoint('run-otel')

    const handle = await local.workspaceStore.startWorkspace({
      runId: 'run-otel',
      sessionId: 'session-otel',
      attempt: lease.attempt,
      idempotencyKey: 'start-otel'
    })
    const sandboxSession = await local.sandbox.open({ runId: 'run-otel', sessionId: 'session-otel' })
    await sandboxSession.write('/workspace/private.txt', 'payload content that must not leak')
    await expect(sandboxSession.readText('/workspace/private.txt')).resolves.toBe('payload content that must not leak')

    const workspaceCheckpoint = await local.workspaceStore.pauseWorkspace({
      handle,
      stepId: 'collect',
      sequence: 1,
      attempt: lease.attempt,
      reason: 'step_completed',
      idempotencyKey: 'pause-otel'
    })
    await local.runtime.commitCheckpoint({
      runId: lease.runId,
      sessionId: lease.sessionId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      stepId: 'collect',
      input: lease.start.input,
      attempt: lease.attempt,
      sequence: 1,
      output: { ok: true },
      replay: workspaceCheckpoint
    })

    await local.checkpoints.write({
      runId: 'run-otel',
      sessionId: 'session-otel',
      workflowId: 'workflow-otel',
      sequence: 1,
      kind: 'summary',
      payload: { secret: 'do-not-leak' },
      payloadSizeBytes: 25,
      createdAt: new Date().toISOString()
    })
    await local.checkpoints.read({ runId: 'run-otel', sessionId: 'session-otel', sequence: 1, kind: 'summary' })
    await local.checkpoints.list({ runId: 'run-otel', sessionId: 'session-otel', kind: 'summary' })
    await local.checkpoints.delete({ runId: 'run-otel', sessionId: 'session-otel', sequence: 1, kind: 'summary' })
    await local.runtime.finishRun('run-otel', { status: 'succeeded', output: { ok: true } })
    await local.workspaceStore.inspectWorkspace({ workspaceRef: handle.workspaceRef })
    await local.workspaceStore.cleanupWorkspace({ workspaceRef: handle.workspaceRef })
    await local.close()

    const spanNames = telemetry.spans.map((span) => span.name)
    expect(spanNames).toEqual(expect.arrayContaining([
      'harness.runtime.start',
      'harness.runtime.load_checkpoint',
      'harness.runtime.checkpoint',
      'harness.runtime.finish',
      'harness.workspace.start',
      'harness.workspace.checkpoint',
      'harness.workspace.inspect',
      'harness.workspace.cleanup',
      'harness.local_sandbox.open',
      'harness.local_sandbox.write',
      'harness.local_sandbox.read_text',
      'harness.context_checkpoint.write',
      'harness.context_checkpoint.read',
      'harness.context_checkpoint.list',
      'harness.context_checkpoint.delete'
    ]))
    expect(telemetry.metrics.map((metric) => metric.name)).toEqual(expect.arrayContaining([
      'harness.runtime.operations',
      'harness.workspace.operations',
      'harness.local_sandbox.operations',
      'harness.context_checkpoint.operations'
    ]))

    const telemetryJson = JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics })
    expect(telemetryJson).not.toContain(root)
    expect(telemetryJson).not.toContain(handle.workspaceRef)
    expect(telemetryJson).not.toContain(workspaceCheckpoint.checkpointRef)
    expect(telemetryJson).not.toContain('payload content that must not leak')
    expect(telemetryJson).not.toContain('do-not-leak')
    expect(telemetryJson).not.toContain('private prompt text')
  })

  it('blocks local sandbox symlink escapes for reads and writes', async () => {
    const root = await tempRoot()
    const outsideRoot = await tempRoot()
    const outsideFile = join(outsideRoot, 'secret.txt')
    await writeFile(outsideFile, 'outside')

    const sandbox = localDirectorySandbox({ root, exec: false })
    const session = await sandbox.open({ runId: 'run-symlink', sessionId: 'session-symlink' })
    await symlink(outsideFile, join(root, 'sessions', 'session-symlink', 'run-symlink', 'workspace', 'escape.txt'))

    await expect(session.readText('/workspace/escape.txt')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'invalid_path' }
    })
    await expect(session.write('/workspace/escape.txt', 'mutated')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'invalid_path' }
    })
  })

  it('keeps host command execution disabled by default and enforces allow-lists when enabled', async () => {
    const root = await tempRoot()
    const disabled = await localDirectorySandbox({ root, exec: false }).open({
      runId: 'run-exec-disabled',
      sessionId: 'session-exec-disabled'
    })
    await expect(disabled.exec?.('node -e "process.stdout.write(1)"')).rejects.toMatchObject({
      code: 'SANDBOX_NO_EXECUTOR'
    })

    const enabled = await localDirectorySandbox({
      root,
      exec: { allowCommands: ['node'], timeoutMs: 5_000 }
    }).open({
      runId: 'run-exec-enabled',
      sessionId: 'session-exec-enabled'
    })
    await expect(enabled.exec?.('echo nope')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'exec_failed' }
    })
    await expect(enabled.exec?.('node -e "process.stdout.write(process.cwd())"')).resolves.toMatchObject({
      exitCode: 0
    })
  })
})
