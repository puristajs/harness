import { mkdtemp } from 'node:fs/promises'
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
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'purista-harness-'))
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
})
