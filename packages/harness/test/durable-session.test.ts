import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
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
    expect(inspection?.state).toBe('paused')
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
    const originalStart = failingStore.startWorkspace.bind(failingStore)
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
      harnessName: 'test'
    })).rejects.toMatchObject({ code: 'WORKSPACE_ERROR' })

    // The lease must have been released: another worker can acquire the run
    // immediately instead of waiting for the lease TTL.
    failingStore.startWorkspace = originalStart
    const binding = await beginDurableWorkflow({
      storage,
      workspace: failingStore,
      durable: { runId: 'run-lease-leak' },
      defaultWorkerId: 'worker-2',
      sessionId: 'session-lease-leak',
      workflowId: 'wf',
      input: { ok: true },
      signal: new AbortController().signal,
      logger: noopLogger(),
      harnessName: 'test'
    })
    expect(binding.runId).toBe('run-lease-leak')
    await binding.dispose()
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
      harnessName: 'test'
    })
    expect(coordinator.get('run-binding', 'session-binding')).toBeDefined()

    await binding.finishSuccess({ done: true })
    await binding.dispose()
    expect(coordinator.get('run-binding', 'session-binding')).toBeUndefined()
  })

  it('rejects durable execution on agent runs', async () => {
    const effects: Record<string, number> = {}
    const harness = buildHarness({ effects })
    const session = await harness.getSession('agent-durable')

    await expect(session.agents.noop.prompt('hi', { durable: { runId: 'run-agent' } })).rejects.toBeInstanceOf(ValidationError)
  })
})
