import { mkdtemp, stat, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import {
  defineHarness,
  DurableRunLeaseError,
  DurableStepError,
  DurableTerminalRunError,
  isReadOnlyMountCapableSession,
  localDirectorySandbox,
  localDirectoryWorkspace,
  localDurableExecution,
  SqliteHarnessStorage,
  sqliteHarnessStorage
} from '../src/index.js'
import type { JsonValue } from '../src/index.js'
import { createLocalWorkspaceCoordinator } from '../src/local/local-workspace.js'
import type { HarnessAdapterContext } from '../src/ports/harness-context.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { harnessStorageContract } from '../src/testing/harnessStorageContract.js'
import { RecordingLogger, RecordingTelemetry } from './telemetryFlowHarness.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'purista-harness-'))
}

harnessStorageContract(() => sqliteHarnessStorage({ file: ':memory:' }))

function configureForTelemetry(adapter: unknown, telemetry: RecordingTelemetry, overrides: { toolTimeoutMs?: number } = {}): void {
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
      toolTimeoutMs: overrides.toolTimeoutMs ?? 10_000,
      skillTimeoutMs: 10_000,
      modelTimeoutMs: 60_000,
      maxParallelToolCalls: 8
    }
  })
}

describe('local durable execution', () => {
  it('creates only the unified storage schema', async () => {
    const root = await tempRoot()
    const file = join(root, 'schema.sqlite')
    const storage = sqliteHarnessStorage({ file })
    await storage.close()
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (file: string) => { prepare(sql: string): { all(): Array<{ name: string }> }; close(): void } }
    const db = new DatabaseSync(file)
    const tables = db.prepare("select name from sqlite_master where type = 'table' order by name").all().map((row) => row.name)
    db.close()
    expect(tables).toEqual(expect.arrayContaining([
      'harness_sessions', 'harness_messages', 'harness_runs', 'harness_run_events',
      'harness_run_checkpoints', 'harness_run_leases', 'harness_external_waits', 'harness_external_wait_signals'
    ]))
    expect(tables).not.toContain('harness_durable_runs')
    expect(tables).not.toContain('harness_context_checkpoints')
  })

  it('rejects a Harness 2 SQLite schema instead of silently retaining legacy tables', async () => {
    const root = await tempRoot()
    const file = join(root, 'legacy.sqlite')
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void }
    }
    const db = new DatabaseSync(file)
    db.exec('create table harness_durable_runs (run_id text primary key)')
    db.close()

    expect(() => sqliteHarnessStorage({ file })).toThrowError(
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'sqlite_schema_incompatible' }) })
    )
  })

  it('persists external waits and deterministic signal delivery across adapter rebuilds', async () => {
    const root = await tempRoot()
    const file = join(root, 'runtime.sqlite')
    const first = new SqliteHarnessStorage({ file })
    await first.createRun({ id: 'run-a', sessionId: 'session-a', kind: 'workflow', target: 'review', startedAt: new Date().toISOString(), status: 'running' })
    await first.acquireRun({ runId: 'run-a', sessionId: 'session-a', workerId: 'worker-a', stepId: 'review', input: null })
    await first.registerWait({ runId: 'run-a', sessionId: 'session-a', waitId: 'review-a', kind: 'human_review', schemaVersion: 'v1', definitionVersion: 'v1', deadline: '2030-01-01T00:00:00.000Z' })
    await first.close()

    const reopened = new SqliteHarnessStorage({ file })
    expect((await reopened.getWait('review-a'))?.status).toBe('waiting')
    expect((await reopened.signalWait({ waitId: 'review-a', eventId: 'event-a', outcome: 'approved' })).kind).toBe('applied')
    expect((await reopened.signalWait({ waitId: 'review-a', eventId: 'event-a', outcome: 'approved' })).kind).toBe('duplicate')
    await reopened.close()
  })

  it('persists durable storage checkpoints across adapter rebuilds', async () => {
    const root = await tempRoot()
    const file = join(root, 'runtime.sqlite')
    const storage = sqliteHarnessStorage({ file })
    await storage.createRun({ id: 'run-1', sessionId: 'session-1', kind: 'workflow', target: 'step-a', startedAt: new Date().toISOString(), status: 'running', input: { ok: true } })
    const lease = await storage.acquireRun({
      runId: 'run-1',
      sessionId: 'session-1',
      workerId: 'worker-1',
      stepId: 'step-a',
      input: { ok: true }
    })
    await storage.commitCheckpoint({
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
    await storage.close()

    const reopened = sqliteHarnessStorage({ file })
    const resumed = await reopened.acquireRun({
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
    const workspace = localDirectoryWorkspace({ root, coordinator })
    const sandbox = localDirectorySandbox({ root, coordinator, exec: false })

    const handle = await workspace.startWorkspace({
      runId: 'run-files',
      sessionId: 'session-files',
      attempt: 1,
      idempotencyKey: 'start'
    })
    const session = await sandbox.open({ runId: 'run-files', sessionId: 'session-files' })
    await session.write('/workspace/note.txt', 'first')
    const checkpoint = await workspace.pauseWorkspace({
      handle,
      stepId: 'write-note',
      sequence: 1,
      attempt: 1,
      reason: 'step_completed',
      idempotencyKey: 'pause'
    })
    await session.write('/workspace/note.txt', 'mutated')

    await workspace.resumeWorkspace({
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
          .storage(local.storage)
          .sandbox(local.sandbox)
          .workspace(local.workspace)
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
    await expect(second.local.storage.loadCheckpoint('run-retry')).resolves.toMatchObject({ stepId: 'b' })
    await second.harness.shutdown()
  })

  it('emits privacy-safe telemetry for local runtime, workspace, sandbox, and context checkpoints', async () => {
    const root = await tempRoot()
    const telemetry = new RecordingTelemetry()
    const local = localDurableExecution({ root })
    configureForTelemetry(local.storage, telemetry)
    configureForTelemetry(local.workspace, telemetry)
    configureForTelemetry(local.sandbox, telemetry)

    await local.storage.createRun({ id: 'run-otel', sessionId: 'session-otel', kind: 'workflow', target: 'collect', startedAt: new Date().toISOString(), status: 'running', input: { prompt: 'private prompt text' } })
    const lease = await local.storage.acquireRun({
      runId: 'run-otel',
      sessionId: 'session-otel',
      workerId: 'worker-otel',
      stepId: 'collect',
      input: { prompt: 'private prompt text' }
    })
    await local.storage.loadCheckpoint('run-otel')

    const handle = await local.workspace.startWorkspace({
      runId: 'run-otel',
      sessionId: 'session-otel',
      attempt: lease.attempt,
      idempotencyKey: 'start-otel'
    })
    const sandboxSession = await local.sandbox.open({ runId: 'run-otel', sessionId: 'session-otel' })
    await sandboxSession.write('/workspace/private.txt', 'payload content that must not leak')
    await expect(sandboxSession.readText('/workspace/private.txt')).resolves.toBe('payload content that must not leak')

    const workspaceCheckpoint = await local.workspace.pauseWorkspace({
      handle,
      stepId: 'collect',
      sequence: 1,
      attempt: lease.attempt,
      reason: 'step_completed',
      idempotencyKey: 'pause-otel'
    })
    await local.storage.commitCheckpoint({
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

    await local.storage.finishRun('run-otel', { status: 'succeeded', output: { ok: true } })
    await local.workspace.inspectWorkspace?.({ workspaceRef: handle.workspaceRef })
    await local.workspace.cleanupWorkspace({ workspaceRef: handle.workspaceRef, reason: 'manual', idempotencyKey: 'cleanup-otel' })
    await local.close()

    const spanNames = telemetry.spans.map((span) => span.name)
    expect(spanNames).toEqual(expect.arrayContaining([
      'harness.storage.acquire_run',
      'harness.storage.load_checkpoint',
      'harness.storage.commit_checkpoint',
      'harness.storage.finish_run',
      'harness.workspace.start',
      'harness.workspace.pause',
      'harness.workspace.inspect',
      'harness.workspace.cleanup',
      'harness.local_sandbox.open',
      'harness.local_sandbox.write',
      'harness.local_sandbox.read_text'
    ]))
    expect(telemetry.metrics.map((metric) => metric.name)).toEqual(expect.arrayContaining([
      'harness.storage.operations',
      'harness.workspace.operations',
      'harness.workspace.bytes',
      'harness.local_sandbox.operations'
    ]))

    const sha256Pattern = /^[0-9a-f]{64}$/
    const storageStart = telemetry.spans.find((span) => span.name === 'harness.storage.acquire_run')
    expect(storageStart?.attrs['harness.storage.resumed']).toBe(false)
    expect(storageStart?.attrs['harness.storage.attempt']).toBe(1)
    const workspaceStart = telemetry.spans.find((span) => span.name === 'harness.workspace.start')
    expect(workspaceStart?.attrs['harness.workspace.state']).toBe('active')
    expect(workspaceStart?.attrs['harness.workspace.ref_hash']).toMatch(sha256Pattern)
    const workspacePause = telemetry.spans.find((span) => span.name === 'harness.workspace.pause')
    expect(workspacePause?.attrs['harness.workspace.checkpoint_ref_hash']).toMatch(sha256Pattern)
    const workspaceCleanup = telemetry.spans.find((span) => span.name === 'harness.workspace.cleanup')
    expect(workspaceCleanup?.attrs['harness.workspace.cleanup.reason']).toBe('manual')
    const sandboxOpen = telemetry.spans.find((span) => span.name === 'harness.local_sandbox.open')
    expect(sandboxOpen?.attrs['harness.sandbox.adapter']).toBe('local_directory_sandbox')
    expect(sandboxOpen?.attrs['harness.sandbox.exec_enabled']).toBe(false)
    expect(sandboxOpen?.attrs['harness.workspace.ref_hash']).toMatch(sha256Pattern)
    const telemetryJson = JSON.stringify({ spans: telemetry.spans, metrics: telemetry.metrics })
    expect(telemetryJson).not.toContain(root)
    expect(telemetryJson).not.toContain(handle.workspaceRef)
    expect(telemetryJson).not.toContain(workspaceCheckpoint.checkpointRef)
    expect(telemetryJson).not.toContain('payload content that must not leak')
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

describe('SQLite Harness storage durability', () => {
  async function tempFile(): Promise<string> {
    return join(await tempRoot(), 'runtime.sqlite')
  }

  const start = async (storage: ReturnType<typeof sqliteHarnessStorage>, workerId: string, runId = 'run-1', sessionId = 'session-1') => {
    if (!await storage.getRun(runId)) {
      await storage.createRun({ id: runId, sessionId, kind: 'workflow', target: 'step-a', startedAt: new Date().toISOString(), status: 'running', input: { ok: true } })
    }
    return storage.acquireRun({ runId, sessionId, workerId, stepId: 'step-a', input: { ok: true } })
  }

  it('renews the lease for a same-worker retry within the TTL', async () => {
    const runtime = sqliteHarnessStorage({ file: await tempFile() })
    const first = await start(runtime, 'worker-1')
    const retry = await start(runtime, 'worker-1')
    expect(retry.attempt).toBe(first.attempt + 1)
    expect(retry.leaseId).not.toBe(first.leaseId)
    await runtime.close()
  })

  it('rejects another worker while the lease is active and allows takeover after expiry', async () => {
    let nowMs = 1_700_000_000_000
    const runtime = sqliteHarnessStorage({ file: await tempFile(), leaseTtlMs: 1_000, now: () => nowMs })
    await start(runtime, 'worker-1')
    await expect(start(runtime, 'worker-2')).rejects.toBeInstanceOf(DurableRunLeaseError)
    nowMs += 1_500
    const takeover = await start(runtime, 'worker-2')
    expect(takeover.workerId).toBe('worker-2')
    await runtime.close()
  })

  it('renews the lease on every owner checkpoint so long runs are not taken over', async () => {
    let nowMs = 1_700_000_000_000
    const runtime = sqliteHarnessStorage({ file: await tempFile(), leaseTtlMs: 1_000, now: () => nowMs })
    const lease = await start(runtime, 'worker-1')
    nowMs += 800
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
    // Past the original expiry but inside the renewed window: still owned.
    nowMs += 400
    await expect(start(runtime, 'worker-2')).rejects.toBeInstanceOf(DurableRunLeaseError)
    // Past the renewed expiry: takeover succeeds and the stale lease loses write access.
    nowMs += 1_000
    await start(runtime, 'worker-2')
    await expect(runtime.commitCheckpoint({
      runId: lease.runId,
      sessionId: lease.sessionId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      stepId: 'step-b',
      input: lease.start.input,
      attempt: lease.attempt,
      sequence: 2,
      output: { value: 2 }
    })).rejects.toBeInstanceOf(DurableRunLeaseError)
    await runtime.close()
  })

  it('replays idempotent checkpoints and rejects conflicting payloads', async () => {
    const runtime = sqliteHarnessStorage({ file: await tempFile() })
    const lease = await start(runtime, 'worker-1')
    const checkpoint = {
      runId: lease.runId,
      sessionId: lease.sessionId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      stepId: 'step-a',
      input: lease.start.input,
      attempt: lease.attempt,
      sequence: 1,
      output: { value: 1 }
    }
    await runtime.commitCheckpoint(checkpoint)
    await expect(runtime.commitCheckpoint(checkpoint)).resolves.toBeUndefined()
    await expect(runtime.commitCheckpoint({ ...checkpoint, output: { value: 2 } })).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'checkpoint_conflict' }
    })
    await runtime.close()
  })

  it('rejects terminal runs and resumes only interrupted runs', async () => {
    const runtime = sqliteHarnessStorage({ file: await tempFile() })

    const succeeded = await start(runtime, 'worker-1', 'run-success', 'session-success')
    await runtime.finishRun(succeeded.runId, { status: 'succeeded', output: { ok: true } })
    await expect(start(runtime, 'worker-1', 'run-success', 'session-success')).rejects.toBeInstanceOf(DurableTerminalRunError)

    const cancelled = await start(runtime, 'worker-1', 'run-cancelled', 'session-cancelled')
    await runtime.finishRun(cancelled.runId, { status: 'cancelled', error: { code: 'OPERATION_CANCELLED', message: 'stop' } })
    await expect(start(runtime, 'worker-1', 'run-cancelled', 'session-cancelled')).rejects.toBeInstanceOf(DurableTerminalRunError)

    const failed = await start(runtime, 'worker-1', 'run-interrupted', 'session-interrupted')
    await runtime.commitCheckpoint({
      runId: failed.runId,
      sessionId: failed.sessionId,
      workerId: failed.workerId,
      leaseId: failed.leaseId,
      stepId: 'step-a',
      input: failed.start.input,
      attempt: failed.attempt,
      sequence: 1,
      output: { value: 1 }
    })
    await failed.release()
    const resumed = await start(runtime, 'worker-2', 'run-interrupted', 'session-interrupted')
    expect(resumed.resumed).toBe(true)
    expect(resumed.attempt).toBe(failed.attempt + 1)
    expect(resumed.checkpoint?.output).toEqual({ value: 1 })
    await runtime.close()
  })

  it('rejects non-serializable checkpoints before any SQLite write', async () => {
    const runtime = sqliteHarnessStorage({ file: await tempFile() })
    const lease = await start(runtime, 'worker-1')
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    await expect(runtime.commitCheckpoint({
      runId: lease.runId,
      sessionId: lease.sessionId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      stepId: 'step-a',
      input: lease.start.input,
      attempt: lease.attempt,
      sequence: 1,
      output: cyclic as unknown as JsonValue
    })).rejects.toBeInstanceOf(DurableStepError)
    await expect(runtime.loadCheckpoint(lease.runId)).resolves.toBeUndefined()
    await runtime.close()
  })

  it('serializes concurrent transactions across two sessions on one connection', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root })
    const runFor = async (index: number): Promise<void> => {
      const sessionId = `session-${index}`
      const runId = `run-${index}`
      await local.storage.createRun({ id: runId, sessionId, kind: 'workflow', target: 'step-a', startedAt: new Date().toISOString(), status: 'running', input: { index } })
      const lease = await local.storage.acquireRun({ runId, sessionId, workerId: 'worker-1', stepId: 'step-a', input: { index } })
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        await local.storage.commitCheckpoint({
          runId,
          sessionId,
          workerId: lease.workerId,
          leaseId: lease.leaseId,
          stepId: `step-${sequence}`,
          input: lease.start.input,
          attempt: lease.attempt,
          sequence,
          output: { sequence }
        })
        await local.storage.appendMessages(sessionId, [{
          id: `${runId}-msg-${sequence}`,
          sessionId,
          role: 'assistant',
          content: `step ${sequence}`,
          timestamp: new Date().toISOString()
        }])
      }
      await local.storage.finishRun(runId, { status: 'succeeded', output: { done: true } })
    }
    await Promise.all([runFor(1), runFor(2), runFor(3)])
    await expect(local.storage.listMessages('session-1')).resolves.toHaveLength(5)
    await expect(local.storage.listMessages('session-3')).resolves.toHaveLength(5)
    await local.close()
  })

  it('close is idempotent', async () => {
    const runtime = sqliteHarnessStorage({ file: await tempFile() })
    await runtime.close()
    await expect(runtime.close()).resolves.toBeUndefined()
  })

})

describe('local durable workspace hardening (spec 22 §4/§8)', () => {
  const signal = new AbortController().signal

  it('rejects traversal-shaped workspace refs on every operation', async () => {
    const root = await tempRoot()
    const store = localDirectoryWorkspace({ root })
    const traversal = '../../tmp/victim'
    await expect(store.resumeWorkspace({ workspaceRef: traversal, runId: 'r', sessionId: 's', attempt: 1, idempotencyKey: 'resume', signal })).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'invalid_reference' }
    })
    await expect(store.abortWorkspace({ workspaceRef: traversal, runId: 'r', sessionId: 's', reason: 'cancelled', idempotencyKey: 'abort', signal })).rejects.toMatchObject({
      meta: { reason: 'invalid_reference' }
    })
    await expect(store.cleanupWorkspace({ workspaceRef: traversal, reason: 'manual', idempotencyKey: 'cleanup', signal })).rejects.toMatchObject({
      meta: { reason: 'invalid_reference' }
    })
    await expect(store.inspectWorkspace?.({ workspaceRef: traversal, signal })).rejects.toMatchObject({
      meta: { reason: 'invalid_reference' }
    })
  })

  it('cleanup refuses to follow a workspace symlink outside the store root', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    const store = localDirectoryWorkspace({ root })
    // Materialize the store root, then plant a symlink that "looks like" a ref.
    await store.startWorkspace({ runId: 'r', sessionId: 's', attempt: 1, idempotencyKey: 'start', signal })
    await symlink(outside, join(root, 'workspaces', 'workspace_FAKE'))
    await expect(store.cleanupWorkspace({ workspaceRef: 'workspace_FAKE', reason: 'manual', idempotencyKey: 'cleanup', signal })).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'invalid_reference' }
    })
    await expect(stat(outside)).resolves.toBeDefined()
  })

  it('persists idempotency replay and conflicts across store rebuilds', async () => {
    const root = await tempRoot()
    const first = localDirectoryWorkspace({ root })
    const handle = await first.startWorkspace({ runId: 'r', sessionId: 's', attempt: 1, idempotencyKey: 'start-key', signal })

    const second = localDirectoryWorkspace({ root })
    const replayed = await second.startWorkspace({ runId: 'r', sessionId: 's', attempt: 1, idempotencyKey: 'start-key', signal })
    expect(replayed.workspaceRef).toBe(handle.workspaceRef)
    await expect(second.startWorkspace({ runId: 'other-run', sessionId: 'other-session', attempt: 1, idempotencyKey: 'start-key', signal })).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'idempotency_conflict' }
    })
  })

  it('enforces a configured maxWorkspaceBytes quota on pause', async () => {
    const root = await tempRoot()
    const store = localDirectoryWorkspace({ root, policy: { quota: { maxWorkspaceBytes: 8 } } })
    const handle = await store.startWorkspace({ runId: 'r', sessionId: 's', attempt: 1, idempotencyKey: 'start', signal })
    await writeFile(join(root, 'workspaces', handle.workspaceRef, 'active', 'workspace', 'big.txt'), 'way more than eight bytes')
    await expect(store.pauseWorkspace({ handle, stepId: 'step-1', sequence: 1, attempt: 1, reason: 'step_completed', idempotencyKey: 'pause', signal })).rejects.toMatchObject({
      code: 'WORKSPACE_QUOTA_EXCEEDED',
      meta: { quota: 'maxWorkspaceBytes' }
    })
  })
})

describe('local sandbox hardening (spec 22 §5/§8)', () => {
  it('blocks shell-metacharacter bypasses of the exec allow-list', async () => {
    const root = await tempRoot()
    const session = await localDirectorySandbox({ root, exec: { allowCommands: ['node'], timeoutMs: 5_000 } }).open({
      runId: 'run-bypass',
      sessionId: 'session-bypass'
    })
    const probe = join(root, 'bypass-proof.txt')
    for (const command of [
      `node -v; touch ${probe}`,
      `node -v | touch ${probe}`,
      `node -v && touch ${probe}`,
      `node -v $(touch ${probe})`,
      'node -v `touch /tmp/x`',
      `node -v > ${probe}`
    ]) {
      await expect(session.exec(command)).rejects.toMatchObject({
        code: 'SANDBOX_ERROR',
        meta: { reason: 'exec_failed' }
      })
    }
    await expect(stat(probe)).rejects.toThrow()
  })

  it('runs commands without a shell so expansions and substitutions stay literal', async () => {
    const root = await tempRoot()
    const session = await localDirectorySandbox({ root, exec: { timeoutMs: 5_000 } }).open({
      runId: 'run-argv',
      sessionId: 'session-argv'
    })
    const result = await session.exec('node -e "process.stdout.write(process.argv[1])" literal-$HOME')
    expect(result.stdout).toBe('literal-$HOME')
  })

  it('blocks dangling-symlink write escapes', async () => {
    const root = await tempRoot()
    const outsideRoot = await tempRoot()
    const danglingTarget = join(outsideRoot, 'does-not-exist-yet.txt')

    const sandbox = localDirectorySandbox({ root, exec: false })
    const session = await sandbox.open({ runId: 'run-dangling', sessionId: 'session-dangling' })
    await symlink(danglingTarget, join(root, 'sessions', 'session-dangling', 'run-dangling', 'workspace', 'dangling.txt'))

    await expect(session.write('/workspace/dangling.txt', 'escape')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'invalid_path' }
    })
    await expect(stat(danglingTarget)).rejects.toThrow()
  })

  it('rejects aborted exec with OperationCancelledError and signal-killed exec as failure', async () => {
    const root = await tempRoot()
    const session = await localDirectorySandbox({ root, exec: {} }).open({
      runId: 'run-abort',
      sessionId: 'session-abort'
    })

    const controller = new AbortController()
    const pending = session.exec('node -e "setTimeout(() => {}, 30000)"', { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
      meta: { scope: 'sandbox' }
    })

    await expect(session.exec('node -e "process.kill(process.pid, \'SIGKILL\')"')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'exec_failed' }
    })
  })

  it('rejects session and run ids containing path segments', async () => {
    const root = await tempRoot()
    const sandbox = localDirectorySandbox({ root, exec: false })
    await expect(sandbox.open({ runId: 'run-ok', sessionId: '../escape' })).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'invalid_path' }
    })
    await expect(sandbox.open({ runId: '..', sessionId: 'session-ok' })).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'invalid_path' }
    })
  })

  it('falls back to the configured harness toolTimeoutMs for exec', async () => {
    const root = await tempRoot()
    const sandbox = localDirectorySandbox({ root, exec: {} })
    configureForTelemetry(sandbox, new RecordingTelemetry(), { toolTimeoutMs: 200 })
    const session = await sandbox.open({ runId: 'run-timeout', sessionId: 'session-timeout' })
    await expect(session.exec('node -e "setTimeout(() => {}, 30000)"')).rejects.toMatchObject({
      code: 'OPERATION_TIMEOUT',
      meta: { scope: 'sandbox_run', timeout_ms: 200 }
    })
  })

  it('caps captured exec output and appends a truncation marker', async () => {
    const root = await tempRoot()
    const session = await localDirectorySandbox({ root, exec: { timeoutMs: 30_000 } }).open({
      runId: 'run-cap',
      sessionId: 'session-cap'
    })
    const result = await session.exec('node -e "process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 97))"')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024 + 100)
    expect(result.stdout.endsWith('[truncated: local sandbox capture limit reached]')).toBe(true)
  })

  it('supports mount, glob list, stat, and remove inside the jail', async () => {
    const root = await tempRoot()
    const session = await localDirectorySandbox({ root, exec: false }).open({
      runId: 'run-fs',
      sessionId: 'session-fs'
    })
    await session.mount(new Map<string, string>([
      ['a.txt', 'alpha'],
      ['b.log', 'beta']
    ]), '/workspace/mounted')
    const txtEntries = await session.list('/workspace/mounted', { glob: '*.txt' })
    expect(txtEntries.map((entry) => entry.name)).toEqual(['a.txt'])
    await expect(session.stat('/workspace/mounted/a.txt')).resolves.toMatchObject({ kind: 'file', size: 5 })
    await session.remove('/workspace/mounted', { recursive: true })
    await expect(session.exists('/workspace/mounted')).resolves.toBe(false)
  })

  it('provides a spawn-capable local process boundary without claiming immutable package mounts', async () => {
    const root = await tempRoot()
    const session = await localDirectorySandbox({ root, exec: { allowCommands: ['node'], timeoutMs: 5_000 } }).open({
      runId: 'run-plugin', sessionId: 'session-plugin'
    })
    expect(isReadOnlyMountCapableSession(session)).toBe(false)
    if (!('spawn' in session) || typeof session.spawn !== 'function') throw new Error('Expected local spawn capability.')
    const process = await session.spawn('node', { args: ['-e', 'process.stdout.write("ready")'] })
    let output = ''
    for await (const chunk of process.stdout) output += chunk
    await process.exit
    expect(output).toBe('ready')
  })

  it('jails exec cwd to the sandbox root', async () => {
    const root = await tempRoot()
    const session = await localDirectorySandbox({ root, exec: { timeoutMs: 5_000 } }).open({
      runId: 'run-cwd',
      sessionId: 'session-cwd'
    })
    const result = await session.exec('node -e "process.stdout.write(process.cwd())"', { cwd: '/workspace/../workspace' })
    expect(result.stdout.endsWith('/workspace')).toBe(true)
    await expect(session.exec('node -v', { cwd: '/missing' })).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'fs_failed' }
    })
  })
})
