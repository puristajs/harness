import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import {
  defineHarness,
  inMemoryDurableWorkspace,
  inMemoryHarnessStorage,
  inMemorySandbox,
  localDirectoryWorkspace,
  type HarnessStorage,
  type DurableWorkspace
} from '../src/index.js'
import { createLocalWorkspaceCoordinator } from '../src/local/local-workspace.js'
import type { Logger } from '../src/logger/logger.js'
import { beginDurableWorkflow } from '../src/runtime/sessionDurable.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import { ValidationError, WorkspaceError } from '../src/errors/index.js'

function noopLogger(): Logger {
  const logger: Logger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
    child: () => logger
  }
  return logger
}

function durableSandbox(sessionId: string) {
  return {
    owner: { namespace: 'durable-session-test', id: sessionId, instanceId: '01J00000000000000000000000' },
    partition: { kind: 'shared' as const },
    policyDigest: 'a'.repeat(64)
  }
}

function buildHarness(opts: { storage?: HarnessStorage; workspace?: DurableWorkspace; effects: Record<string, number> } ) {
  const model = new FakeModelProvider()
  let builder = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fast: { provider: model, model: 'fake', capabilities: ['object'] } })
    .tools({})
    .skills({})
    .agents({ noop: { model: 'fast', instructions: 'x', builtinTools: false } })
  if (opts.storage) builder = builder.storage(opts.storage)
  if (opts.workspace) builder = builder.workspace(opts.workspace)
  return builder
    .workflows({
      twoStep: {
        input: z.string(),
        output: z.string(),
        handler: async (ctx) => {
          const a = await ctx.step('a', async () => { opts.effects['a'] = (opts.effects['a'] ?? 0) + 1; return { a: 1 } })
          const b = await ctx.step('b', async () => { opts.effects['b'] = (opts.effects['b'] ?? 0) + 1; return { b: 2 } })
          return JSON.stringify({ ...a, ...b })
        }
      }
    })
    .build()
}

describe('durable workflow auto-wiring', () => {
  it.each(['success', 'cancelled'] as const)('preserves terminal %s when workspace cleanup fails', async outcome => {
    const storage = inMemoryHarnessStorage()
    const workspace = inMemoryDurableWorkspace()
    workspace.info.policy = { ...workspace.info.policy, retention: { cleanupMode: 'adapter_automatic' } }
    const marker = 'private-provider-ref-and-host-path'
    vi.spyOn(workspace, 'cleanupWorkspace').mockRejectedValue(new Error(marker))
    vi.spyOn(workspace, 'abortWorkspace').mockRejectedValue(new Error(marker))
    const logger = noopLogger()
    const warnings = vi.spyOn(logger, 'warn')
    await storage.createRun({ id: 'terminal-cleanup', sessionId: 'terminal-session', kind: 'workflow', target: 'workflow', startedAt: new Date().toISOString(), status: 'running', input: 'input' })
    const args = { storage, workspace, durable: { runId: 'terminal-cleanup' }, defaultWorkerId: 'worker', sessionId: 'terminal-session', workflowId: 'workflow', input: 'input', signal: new AbortController().signal, logger, harnessName: 'cleanup', sandbox: durableSandbox('terminal-session') }
    const binding = await beginDurableWorkflow(args)
    if (outcome === 'success') await binding.finishSuccess('done')
    else await binding.finishCancelled(new Error('cancelled'))
    await binding.dispose()
    expect((await storage.getRun('terminal-cleanup'))?.status).toBe(outcome === 'success' ? 'succeeded' : 'cancelled')
    await expect(beginDurableWorkflow(args)).rejects.toMatchObject({ name: 'DurableTerminalRunError' })
    expect(warnings).toHaveBeenCalledOnce()
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(marker)
  })

  it('fails closed before workspace start when a retried run has no committed recovery files', async () => {
    const storage = inMemoryHarnessStorage()
    const workspace = inMemoryDurableWorkspace()
    const start = vi.spyOn(workspace, 'startWorkspace')
    const resume = vi.spyOn(workspace, 'resumeWorkspace')
    await storage.createRun({ id: 'no-checkpoint', sessionId: 'recovery-session', kind: 'workflow', target: 'workflow', startedAt: new Date().toISOString(), status: 'running', input: 'input' })
    const args = {
      storage, workspace, durable: { runId: 'no-checkpoint' }, defaultWorkerId: 'worker',
      sessionId: 'recovery-session', workflowId: 'workflow', input: 'input',
      signal: new AbortController().signal, logger: noopLogger(), harnessName: 'recovery', sandbox: durableSandbox('recovery-session')
    }
    const first = await beginDurableWorkflow(args)
    await first.dispose()
    await expect(beginDurableWorkflow(args)).rejects.toMatchObject({ code: 'SANDBOX_STATE_LOST' })
    expect(start).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
    const lease = await storage.acquireRun({ runId: 'no-checkpoint', sessionId: 'recovery-session', workerId: 'another-worker', stepId: 'workflow', input: 'input' })
    await lease.release()
  })

  it('runs ctx.step as a transparent pass-through without a durable invocation', async () => {
    const effects: Record<string, number> = {}
    const harness = buildHarness({ effects })
    const session = await harness.getSession('ephemeral')

    await expect(session.workflows.twoStep.prompt('go')).resolves.toBe(JSON.stringify({ a: 1, b: 2 }))
    expect(effects).toEqual({ a: 1, b: 1 })
  })

  it('checkpoints steps and finalizes Harness storage on success', async () => {
    const effects: Record<string, number> = {}
    const storage = inMemoryHarnessStorage()
    const harness = buildHarness({ storage, effects })
    const session = await harness.getSession('durable-success')

    const result = await session.workflows.twoStep.prompt('go', { durable: { runId: 'run-success' } })
    expect(result).toBe(JSON.stringify({ a: 1, b: 2 }))

    const checkpoint = await storage.loadCheckpoint('run-success')
    expect(checkpoint?.stepId).toBe('b')
    const summary = await session.getRunSummary('run-success')
    expect(summary?.status).toBe('succeeded')
  })

  it('replays committed steps on resume after a crash without re-running side effects', async () => {
    const effects: Record<string, number> = {}
    const storage = inMemoryHarnessStorage({ failAfterCheckpoint: 1 })
    const harness = buildHarness({ storage, effects })
    const session = await harness.getSession('durable-resume')

    // First attempt crashes after step "a" commits its checkpoint.
    await expect(session.workflows.twoStep.prompt('go', { durable: { runId: 'run-resume' } })).rejects.toThrow()
    expect(effects).toEqual({ a: 1 })

    // Resume with the same run id: "a" replays, only "b" runs.
    const result = await session.workflows.twoStep.prompt('go', { durable: { runId: 'run-resume' } })
    expect(result).toBe(JSON.stringify({ a: 1, b: 2 }))
    expect(effects).toEqual({ a: 1, b: 1 })
  })

  it('does not let a competing durable invocation overwrite or terminalize the lease owner run', async () => {
    const storage = inMemoryHarnessStorage()
    const sandbox = inMemorySandbox()
    let entered: (() => void) | undefined
    const started = new Promise<void>((resolve) => { entered = resolve })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const makeHarness = () => defineHarness()
      .sandbox(sandbox)
      .storage(storage)
      .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents({ noop: { model: 'fast', instructions: 'x', builtinTools: false } })
      .workflows({
        block: {
          input: z.string(),
          output: z.string(),
          handler: async (ctx) => {
            await ctx.step('entered', async () => 'entered')
            entered?.()
            await gate
            return 'done'
          }
        }
      })
      .build()

    const first = await makeHarness().getSession('shared-session')
    const second = await makeHarness().getSession('shared-session')
    const winner = first.workflows.block.prompt('input', { durable: { runId: 'shared-run' } })
    await started
    await expect(second.workflows.block.prompt('input', { durable: { runId: 'shared-run' } })).rejects.toMatchObject({ name: 'DurableRunLeaseError' })
    release?.()
    await expect(winner).resolves.toBe('done')
    expect((await storage.getRun('shared-run'))?.status).toBe('succeeded')
  })

  it('fences simultaneous first durable invocations at atomic run creation', async () => {
    class SynchronizedFirstCreateStorage extends InMemoryHarnessStorage {
      private creates = 0
      private releaseCreates: (() => void) | undefined
      private readonly bothCreating = new Promise<void>((resolve) => { this.releaseCreates = resolve })

      public override async createRun(record: Parameters<HarnessStorage['createRun']>[0]): Promise<void> {
        this.creates += 1
        if (this.creates <= 2) {
          if (this.creates === 2) this.releaseCreates?.()
          await this.bothCreating
        }
        return super.createRun(record)
      }
    }

    const storage = new SynchronizedFirstCreateStorage()
    const sandbox = inMemorySandbox()
    let entered: (() => void) | undefined
    const started = new Promise<void>((resolve) => { entered = resolve })
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const makeHarness = () => defineHarness()
      .sandbox(sandbox)
      .storage(storage)
      .models({ fast: { provider: new FakeModelProvider(), model: 'fake', capabilities: ['object'] } })
      .tools({})
      .skills({})
      .agents({ noop: { model: 'fast', instructions: 'x', builtinTools: false } })
      .workflows({
        echo: {
          input: z.enum(['first', 'second']),
          output: z.enum(['first', 'second']),
          handler: async (ctx) => {
            entered?.()
            await gate
            return ctx.input
          }
        }
      })
      .build()

    const first = await makeHarness().getSession('simultaneous-session')
    const second = await makeHarness().getSession('simultaneous-session')
    const firstAttempt = first.workflows.echo.prompt('first', { durable: { runId: 'simultaneous-run' } })
    const secondAttempt = second.workflows.echo.prompt('second', { durable: { runId: 'simultaneous-run' } })
    await started
    release?.()
    const attempts = await Promise.allSettled([firstAttempt, secondAttempt])

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ name: 'DurableRunLeaseError' }) })
    ])
    const run = await storage.getRun('simultaneous-run')
    expect(run?.status).toBe('succeeded')
    // The only completed handler is the creation winner. This detects a
    // check-then-create overwrite between two initially absent observations.
    expect(run?.input).toBe((attempts.find((attempt) => attempt.status === 'fulfilled') as PromiseFulfilledResult<'first' | 'second'>).value)
  })

  it('drives the durable workspace lifecycle across a crash and resume', async () => {
    const effects: Record<string, number> = {}
    const storage = inMemoryHarnessStorage({ failAfterCheckpoint: 1 })
    const workspace = inMemoryDurableWorkspace()
    const harness = buildHarness({ storage, workspace, effects })
    const session = await harness.getSession('durable-workspace')

    await expect(session.workflows.twoStep.prompt('go', { durable: { runId: 'run-ws' } })).rejects.toThrow()
    await session.workflows.twoStep.prompt('go', { durable: { runId: 'run-ws' } })

    const checkpoint = await storage.loadCheckpoint('run-ws')
    const workspaceRef = checkpoint?.replay?.workspaceRef
    expect(workspaceRef).toBeTypeOf('string')
    const inspection = await workspace.inspectWorkspace?.({ workspaceRef })
    expect(inspection?.checkpoints.length).toBe(2)
    expect(inspection?.state).toBe('terminal')
  })

  it('forwards an invocation workspace policy only when it creates the workspace', async () => {
    const effects: Record<string, number> = {}
    const storage = inMemoryHarnessStorage()
    const workspace = inMemoryDurableWorkspace()
    const startWorkspace = workspace.startWorkspace.bind(workspace)
    let receivedPolicy: unknown
    workspace.startWorkspace = async (options) => {
      receivedPolicy = options.policy
      return startWorkspace(options)
    }
    const harness = buildHarness({ storage, workspace, effects })
    const session = await harness.getSession('durable-workspace-policy')
    const workspacePolicy = {
      retention: { cleanupMode: 'manual_only' as const, pausedTtlMs: 60_000 }
    }

    await session.workflows.twoStep.prompt('go', {
      durable: { runId: 'run-ws-policy', workspacePolicy }
    })

    expect(receivedPolicy).toEqual(workspacePolicy)
  })

  it('supports durable invocation with the default in-memory storage', async () => {
    const effects: Record<string, number> = {}
    const harness = buildHarness({ effects })
    const session = await harness.getSession('no-runtime')

    await expect(session.workflows.twoStep.prompt('go', { durable: { runId: 'run-x' } }))
      .resolves.toBe(JSON.stringify({ a: 1, b: 2 }))
  })

  it('rejects an invalid durable run id', async () => {
    const effects: Record<string, number> = {}
    const harness = buildHarness({ effects })
    const session = await harness.getSession('bad-run-id')

    await expect(session.workflows.twoStep.prompt('go', { durable: { runId: 'bad run id!' } })).rejects.toBeInstanceOf(ValidationError)
  })

  it('releases the lease when the workspace phase fails after startRun', async () => {
    const storage = inMemoryHarnessStorage()
    const failingStore = inMemoryDurableWorkspace()
    failingStore.startWorkspace = async () => {
      throw new WorkspaceError('Workspace backend down.', { reason: 'backend_failure' })
    }
    await storage.createRun({
      id: 'run-lease-leak', sessionId: 'session-lease-leak', kind: 'workflow', target: 'wf',
      startedAt: new Date().toISOString(), status: 'running', input: { ok: true }
    })

    await expect(beginDurableWorkflow({
      storage,
      workspace: failingStore,
      durable: { runId: 'run-lease-leak' },
      defaultWorkerId: 'worker-1',
      sessionId: 'session-lease-leak',
      workflowId: 'wf',
      input: { ok: true },
      signal: new AbortController().signal,
      logger: noopLogger(),
      harnessName: 'test',
      sandbox: durableSandbox('session-lease-leak')
    })).rejects.toMatchObject({ code: 'WORKSPACE_ERROR' })

    // The lease must have been released: another worker can acquire the run
    // immediately instead of waiting for the lease TTL.
    const lease = await storage.acquireRun({
      runId: 'run-lease-leak',
      workerId: 'worker-2',
      sessionId: 'session-lease-leak',
      stepId: 'wf',
      input: { ok: true }
    })
    expect(lease.runId).toBe('run-lease-leak')
    await lease.release()
  })

  it('unbinds the local workspace coordinator when the durable binding is disposed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purista-durable-binding-'))
    const coordinator = createLocalWorkspaceCoordinator()
    const workspace = localDirectoryWorkspace({ root, coordinator })
    const storage = inMemoryHarnessStorage()
    await storage.createRun({
      id: 'run-binding', sessionId: 'session-binding', kind: 'workflow', target: 'wf',
      startedAt: new Date().toISOString(), status: 'running', input: { ok: true }
    })

    const binding = await beginDurableWorkflow({
      storage,
      workspace,
      durable: { runId: 'run-binding' },
      defaultWorkerId: 'worker-1',
      sessionId: 'session-binding',
      workflowId: 'wf',
      input: { ok: true },
      signal: new AbortController().signal,
      logger: noopLogger(),
      harnessName: 'test',
      sandbox: durableSandbox('session-binding')
    })
    const scope = { owner: durableSandbox('session-binding').owner, partition: { kind: 'shared' as const }, lifetime: 'run' as const, runId: 'run-binding' }
    expect(coordinator.get(scope)).toBeDefined()

    await binding.finishSuccess({ done: true })
    await binding.dispose()
    expect(coordinator.get(scope)).toBeUndefined()
  })

  it('rejects durable execution on agent runs', async () => {
    const effects: Record<string, number> = {}
    const harness = buildHarness({ effects })
    const session = await harness.getSession('agent-durable')

    await expect(session.agents.noop.prompt('hi', { durable: { runId: 'run-agent' } })).rejects.toBeInstanceOf(ValidationError)
  })
})
