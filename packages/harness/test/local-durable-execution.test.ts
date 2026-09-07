import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import {
  DurableRunLeaseError,
  DurableTerminalRunError,
  isReadOnlyMountCapableSession,
  localDirectorySandbox,
  localDirectoryWorkspace,
  localDurableExecution,
  SandboxStateLostError,
  SqliteHarnessStorage,
  sqliteHarnessStorage,
} from '../src/index.js'
import type { AdapterCapability, HarnessStorage, JsonValue, Sandbox, SandboxSessionFor } from '../src/index.js'
import { canonicalJson } from '../src/runtime/canonical-json.js'
import { createLocalWorkspaceCoordinator } from '../src/local/local-workspace.js'
import type { HarnessAdapterContext } from '../src/ports/harness-context.js'
import { harnessStorageContract } from '../src/testing/harnessStorageContract.js'
import { sandboxTextSearchContract } from '../src/testing/sandboxContract.js'
import { RecordingLogger, RecordingTelemetry } from './telemetryFlowHarness.js'
import { defineHarness as defineV4Harness } from '../src/definitions/harness.js'
import { defineAgent } from '../src/definitions/agent.js'
import { defineTool } from '../src/definitions/tool.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { OperationCancelledError } from '../src/errors/index.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'purista-harness-'))
}

async function acquireRun(storage: HarnessStorage, runId: string, sessionId: string, workerId: string, stepId: string) {
  const run = await storage.getRun(runId)
  if (!run) throw new Error('test run is missing')
  const checkpoint = await storage.loadCheckpoint(runId)
  const mode = run.revision === 1 && checkpoint === undefined ? 'initial' as const : 'resume' as const
  const selectedStep = checkpoint?.stepId ?? stepId
  const expectedStatus = ['running', 'waiting', 'interrupted'].includes(run.status) ? run.status as 'running' | 'waiting' | 'interrupted' : 'interrupted'
  const request = { mode, runId, sessionId, workerId,
    expected: { revision: run.revision, status: expectedStatus, checkpoint: { stepId: selectedStep, sequence: checkpoint?.sequence ?? null } } } as const
  const acquisitionId = `acq_${createHash('sha256').update(canonicalJson(['harness-run-acquisition-v1', mode, runId,
    sessionId, workerId, run.revision, expectedStatus, selectedStep, checkpoint?.sequence ?? null, null])).digest('hex')}`
  return storage.acquireRun({ ...request, acquisitionId })
}

async function finalizeStoredRun(
  storage: HarnessStorage,
  lease: Awaited<ReturnType<typeof acquireRun>>,
  patch: { status: 'succeeded'; output: JsonValue } | { status: 'cancelled' | 'failed'; error: { code: string; message: string } },
): Promise<void> {
  const at = new Date().toISOString()
  const sequence = (await storage.listEvents(lease.runId)).length + 1
  const type = 'run.finished' as const
  const id = `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', lease.runId, sequence, type])).digest('hex')}`
  const outcome = patch.status === 'succeeded'
    ? { status: 'completed' as const }
    : { status: patch.status, error: patch.error }
  await storage.finalizeRun({
    runId: lease.runId,
    sessionId: lease.sessionId,
    leaseId: lease.leaseId,
    workerId: lease.workerId,
    patch: { ...patch, finishedAt: at },
    terminalEvent: { id, sequence, runId: lease.runId, at, type, payload: { outcome } },
    checkpointDisposition: 'delete-all',
  })
}

function durableOwner(sessionId: string) {
  return { namespace: 'local-durable-test', id: sessionId, instanceId: '01J00000000000000000000000' } as const
}

const durablePolicyDigest = 'a'.repeat(64)
const sharedPartition = [{ kind: 'shared' as const }] as const

async function localSandboxFiles(root: string): Promise<string> {
  const directories = await readdir(join(root, 'sandboxes'))
  expect(directories).toHaveLength(1)
  return join(root, 'sandboxes', directories[0]!, 'files')
}

async function openLocalSandbox<C extends readonly AdapterCapability[]>(
  sandbox: Sandbox<C>,
  sessionId: string,
  runId: string,
  mode: 'create' | 'attach' | 'restore' = 'create',
): Promise<SandboxSessionFor<C>> {
  const scope = {
    owner: { namespace: 'local-durable-test', id: sessionId, instanceId: '01J00000000000000000000000' },
    partition: { kind: 'shared' as const },
    lifetime: 'run' as const,
    runId,
  }
  await sandbox.registerOwner({ owner: scope.owner, mode: mode === 'create' ? 'create' : 'attach' })
  return (
    await sandbox.open({
      scope,
      mode,
    })
  ).session
}

harnessStorageContract(() => sqliteHarnessStorage({ file: ':memory:' }))
sandboxTextSearchContract(async () => localDirectorySandbox({ root: await tempRoot() }))

function configureForTelemetry(
  adapter: unknown,
  telemetry: RecordingTelemetry,
  overrides: { toolTimeoutMs?: number } = {},
): void {
  const configurable = adapter as { configureHarnessContext?: (context: HarnessAdapterContext) => void }
  configurable.configureHarnessContext?.({
    harnessName: 'local-durable-test',
    logger: new RecordingLogger(),
    telemetry,
    metrics: {
      counter: (name, value = 1, attrs) => telemetry.recordCounter(name, value, attrs ?? {}),
      histogram: (name, value, attrs) => telemetry.recordHistogram(name, value, attrs ?? {}),
      duration: async (_name, _attrs, fn) => fn(),
    },
    contentCaptureMode: 'NO_CONTENT',
    defaults: {
      agentMaxIterations: 4,
      runTimeoutMs: 60_000,
      toolTimeoutMs: overrides.toolTimeoutMs ?? 10_000,
      skillTimeoutMs: 10_000,
      modelTimeoutMs: 60_000,
      maxParallelToolCalls: 8,
    },
  })
}

describe('local durable execution', () => {
  it('attaches across independent local adapters and never recreates terminated state', async () => {
    const root = await tempRoot()
    try {
      const firstAdapter = localDirectorySandbox({ root })
      const secondAdapter = localDirectorySandbox({ root })
      const scope = {
        owner: { namespace: 'local-multi-client', id: 'shared', instanceId: '01J00000000000000000000000' },
        partition: { kind: 'shared' as const },
        lifetime: 'run' as const,
        runId: 'shared-run',
      }
      await firstAdapter.registerOwner({ owner: scope.owner, mode: 'create' })
      await secondAdapter.registerOwner({ owner: scope.owner, mode: 'attach' })
      const first = (await firstAdapter.open({ scope, mode: 'create' })).session
      await first.write('/workspace/retained.txt', 'retained')
      const second = (await secondAdapter.open({ scope, mode: 'attach' })).session
      await expect(second.readText('/workspace/retained.txt')).resolves.toBe('retained')
      await first.close()
      await expect(first.readText('/workspace/retained.txt')).rejects.toMatchObject({
        meta: { reason: 'session_closed' },
      })
      await expect(second.readText('/workspace/retained.txt')).resolves.toBe('retained')
      await secondAdapter.terminate({ scope, reason: 'run_disposed' })
      await expect(second.readText('/workspace/retained.txt')).rejects.toBeInstanceOf(SandboxStateLostError)
      await expect(secondAdapter.open({ scope, mode: 'attach' })).rejects.toBeInstanceOf(SandboxStateLostError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates only the unified storage schema', async () => {
    const root = await tempRoot()
    const file = join(root, 'schema.sqlite')
    const storage = sqliteHarnessStorage({ file })
    await storage.close()
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (
        file: string,
      ) => { prepare(sql: string): { all(): Array<Record<string, unknown>> }; close(): void }
    }
    const db = new DatabaseSync(file)
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => row['name'])
    const sessionColumns = db
      .prepare('pragma table_info(harness_sessions)')
      .all()
      .map((row) => row['name'])
    db.close()
    expect(tables).toEqual(
      expect.arrayContaining([
        'harness_sessions',
        'harness_messages',
        'harness_runs',
        'harness_run_events',
        'harness_run_checkpoints',
        'harness_run_leases',
        'harness_external_waits',
        'harness_external_wait_signals',
      ]),
    )
    expect(tables).not.toContain('harness_durable_runs')
    expect(tables).not.toContain('harness_context_checkpoints')
    expect(sessionColumns).toContain('sandbox_binding_json')
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
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'sqlite_schema_incompatible' }) }),
    )
  })

  it('rejects a session layout without the immutable sandbox binding before writing', async () => {
    const root = await tempRoot()
    const file = join(root, 'legacy-session.sqlite')
    const require = createRequire(import.meta.url)
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void }
    }
    const db = new DatabaseSync(file)
    db.exec(
      'create table harness_sessions(id text primary key, instance_id text not null, created_at text not null, updated_at text not null, run_count integer not null, identity_json text, metadata_json text)',
    )
    db.close()

    expect(() => sqliteHarnessStorage({ file })).toThrowError(
      expect.objectContaining({ meta: expect.objectContaining({ reason: 'sqlite_schema_incompatible' }) }),
    )
  })

  it('persists external waits and deterministic signal delivery across adapter rebuilds', async () => {
    const root = await tempRoot()
    const file = join(root, 'runtime.sqlite')
    const first = new SqliteHarnessStorage({ file })
    await first.createRun({
      id: 'run-a',
      sessionId: 'session-a',
      kind: 'workflow',
      target: 'review',
      startedAt: new Date().toISOString(),
      input: null,
    })
    await acquireRun(first, 'run-a', 'session-a', 'worker-a', 'review')
    await first.registerWait({
      runId: 'run-a',
      sessionId: 'session-a',
      waitId: 'review-a',
      kind: 'human_review',
      schemaVersion: 'v1',
      definitionVersion: 'v1',
      deadline: '2030-01-01T00:00:00.000Z',
    })
    await first.close()

    const reopened = new SqliteHarnessStorage({ file })
    expect((await reopened.getWait('review-a'))?.status).toBe('waiting')
    expect((await reopened.signalWait({ waitId: 'review-a', eventId: 'event-a', outcome: 'approved' })).kind).toBe(
      'applied',
    )
    expect((await reopened.signalWait({ waitId: 'review-a', eventId: 'event-a', outcome: 'approved' })).kind).toBe(
      'duplicate',
    )
    await reopened.close()
  })

  it('persists durable storage checkpoints across adapter rebuilds', async () => {
    const root = await tempRoot()
    const file = join(root, 'runtime.sqlite')
    const storage = sqliteHarnessStorage({ file })
    await storage.createRun({
      id: 'run-1',
      sessionId: 'session-1',
      kind: 'workflow',
      target: 'step-a',
      startedAt: new Date().toISOString(),
      input: { ok: true },
    })
    const lease = await acquireRun(storage, 'run-1', 'session-1', 'worker-1', 'step-a')
    await storage.commitCheckpoint({
      runId: lease.runId,
      sessionId: lease.sessionId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      stepId: 'step-a',
      input: lease.run.input,
      attempt: lease.attempt,
      sequence: 1,
      output: { value: 1 },
    })
    await lease.release()
    await storage.close()

    const reopened = sqliteHarnessStorage({ file })
    const resumed = await acquireRun(reopened, 'run-1', 'session-1', 'worker-1', 'step-a')
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
      sandboxOwner: durableOwner('session-files'),
      sandboxPolicyDigest: durablePolicyDigest,
      attempt: 1,
      idempotencyKey: 'start',
    })
    const session = await openLocalSandbox(sandbox, 'session-files', 'run-files')
    await session.write('/workspace/note.txt', 'first')
    const checkpoint = await workspace.pauseWorkspace({
      handle,
      sandboxPartitions: sharedPartition,
      stepId: 'write-note',
      sequence: 1,
      attempt: 1,
      reason: 'step_completed',
      idempotencyKey: 'pause',
    })
    await session.write('/workspace/note.txt', 'mutated')

    await workspace.resumeWorkspace({
      workspaceRef: handle.workspaceRef,
      checkpointRef: checkpoint.checkpointRef,
      runId: 'run-files',
      sessionId: 'session-files',
      attempt: 2,
      idempotencyKey: 'resume',
    })
    const resumed = await openLocalSandbox(sandbox, 'session-files', 'run-files', 'restore')
    await expect(resumed.readText('/workspace/note.txt')).resolves.toBe('first')
  })

  it('rejects a missing committed sandbox partition before replacing the active workspace', async () => {
    const root = await tempRoot()
    const coordinator = createLocalWorkspaceCoordinator()
    const workspace = localDirectoryWorkspace({ root, coordinator })
    const sandbox = localDirectorySandbox({ root, coordinator, exec: false })
    const handle = await workspace.startWorkspace({
      runId: 'run-missing-member',
      sessionId: 'session-missing-member',
      sandboxOwner: durableOwner('session-missing-member'),
      sandboxPolicyDigest: durablePolicyDigest,
      attempt: 1,
      idempotencyKey: 'start',
    })
    const session = await openLocalSandbox(sandbox, 'session-missing-member', 'run-missing-member')
    await session.write('/workspace/note.txt', 'committed')
    const checkpoint = await workspace.pauseWorkspace({
      handle,
      sandboxPartitions: sharedPartition,
      stepId: 'write-note',
      sequence: 1,
      attempt: 1,
      reason: 'step_completed',
      idempotencyKey: 'pause',
    })
    await session.write('/workspace/note.txt', 'active-before-failed-restore')
    const checkpointPartitions = join(
      root,
      'workspaces',
      handle.workspaceRef,
      'checkpoints',
      checkpoint.checkpointRef,
      'partitions',
    )
    const [partition] = await readdir(checkpointPartitions)
    await rm(join(checkpointPartitions, partition!), { recursive: true, force: true })

    await expect(
      workspace.resumeWorkspace({
        workspaceRef: handle.workspaceRef,
        checkpointRef: checkpoint.checkpointRef,
        runId: 'run-missing-member',
        sessionId: 'session-missing-member',
        attempt: 2,
        idempotencyKey: 'resume',
      }),
    ).rejects.toBeInstanceOf(SandboxStateLostError)
    await expect(session.readText('/workspace/note.txt')).resolves.toBe('active-before-failed-restore')
  })

  it('replays a terminal durable workflow across v4 Harness rebuilds with the local storage bundle', async () => {
    const root = await tempRoot()
    let effects = 0
    const workflow = defineWorkflow('recover', {
      input: z.string(), output: z.string(), durable: true,
      async handler({ input }) { effects += 1; return input },
    })
    async function build() {
      const local = localDurableExecution({ root })
      return {
        local,
        harness: await defineV4Harness({ name: 'localReplay', revision: 'release-1' }).addWorkflow(workflow)
          .getInstance({ storage: local.storage }),
      }
    }

    const first = await build()
    const firstSession = await first.harness.getSession('session-retry')
    await expect(firstSession.workflows.recover.run('go', { durable: { runId: 'run-retry' } })).resolves.toMatchObject({ status: 'completed', output: 'go' })
    await first.harness.close()
    await first.local.close()

    const second = await build()
    const secondSession = await second.harness.getSession('session-retry')
    await expect(secondSession.workflows.recover.run('go', { durable: { runId: 'run-retry' } })).resolves.toMatchObject({ status: 'completed', output: 'go' })
    expect(effects).toBe(1)
    await second.harness.close()
    await second.local.close()
  })

  it('enforces the workspace checkpoint payload quota through the v4 standalone runtime', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root, policy: { quota: { maxCheckpointPayloadBytes: 8 } } })
    const workflow = defineWorkflow('oversizedCheckpoint', {
      input: z.string(), output: z.string(), durable: true, workspace: true,
      handler: async ({ step }) => await step('oversized', async () => '1234567'),
    })
    const harness = await defineV4Harness({ name: 'checkpointQuota', revision: 'v1' }).addWorkflow(workflow)
      .getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace })

    try {
      const session = await harness.getSession('payload-limit-session')
      await expect(session.workflows.oversizedCheckpoint.run('go', {
        durable: { runId: 'payload-limit-run' },
      })).rejects.toMatchObject({
        code: 'WORKSPACE_QUOTA_EXCEEDED',
        meta: { quota: 'maxCheckpointPayloadBytes', limit: 8, actual: 9 },
      })
    } finally {
      await harness.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed per-run workspace policy before opening a workspace', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root })
    const startWorkspace = vi.spyOn(local.workspace, 'startWorkspace')
    const workflow = defineWorkflow('workspacePolicy', {
      input: z.string(), output: z.string(), durable: true, workspace: true,
      async handler({ input }) { return input },
    })
    const harness = await defineV4Harness({ name: 'workspacePolicyHarness', revision: 'v1' }).addWorkflow(workflow)
      .getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace })
    try {
      const session = await harness.getSession('workspace-policy-session')
      await expect(session.workflows.workspacePolicy.run('go', {
        durable: { runId: 'workspace-policy-run', workspacePolicy: { quota: { maxWorkspaceBytes: 0 } } },
      } as never)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', meta: { where: 'invoke_options' } })
      expect(startWorkspace).not.toHaveBeenCalled()
      await expect(local.storage.getRun('workspace-policy-run')).resolves.toBeUndefined()
    } finally {
      await harness.close()
      await local.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('starts, checkpoints, and finishes a successful v4 durable workspace in order', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root })
    const calls: string[] = []
    for (const method of ['startWorkspace', 'pauseWorkspace', 'pinCheckpoint', 'finish', 'releaseCheckpoint'] as const) {
      const original = local.workspace[method].bind(local.workspace) as (...args: never[]) => Promise<unknown>
      vi.spyOn(local.workspace, method).mockImplementation(async (...args: never[]) => {
        calls.push(method)
        return original(...args)
      })
    }
    const workflow = defineWorkflow('workspaceSuccess', {
      input: z.string(), output: z.string(), durable: true, workspace: true,
      handler: async ({ step }) => await step('prepare', async () => 'ready'),
    })
    const harness = await defineV4Harness({ name: 'workspaceSuccessHarness', revision: 'v1' }).addWorkflow(workflow)
      .getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace })
    try {
      const session = await harness.getSession('workspace-success-session')
      await expect(session.workflows.workspaceSuccess.run('go', { durable: { runId: 'workspace-success-run' } }))
        .resolves.toMatchObject({ status: 'completed', output: 'ready' })
      expect(calls).toEqual(['startWorkspace', 'pauseWorkspace', 'pinCheckpoint', 'finish', 'releaseCheckpoint'])
    } finally {
      await harness.close()
      await local.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
		['private', 'private', { kind: 'workflow', harnessName: 'workspaceDefaultPrivate', id: 'workspacePartition' }],
		['group', { group: 'reviewers' }, { kind: 'group', id: 'reviewers' }],
	] as const)('uses the runtime %s default policy for a durable workspace partition', async (_case, defaultPolicy, expectedPartition) => {
		const root = await tempRoot()
		const local = localDurableExecution({ root })
		const opened = vi.spyOn(local.sandbox, 'open')
		const workflow = defineWorkflow('workspacePartition', { input: z.string(), output: z.string(), durable: true, workspace: true,
			async handler({ input }) { return input } })
		const instance = await defineV4Harness({ name: defaultPolicy === 'private' ? 'workspaceDefaultPrivate' : 'workspaceDefaultGroup', revision: 'v1' })
			.addWorkflow(workflow).getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace,
				sandboxBinding: defaultPolicy === 'private'
					? { defaultPolicy }
					: { groups: ['reviewers'] as const, defaultPolicy } } as never)
		try {
			const session = await instance.getSession(`workspace-${_case}`)
			await session.workflows.workspacePartition.run('go', { durable: { runId: `workspace-${_case}-run` } })
			expect(opened.mock.calls.some(([request]) => request.scope.lifetime === 'run'
				&& JSON.stringify(request.scope.partition) === JSON.stringify(expectedPartition))).toBe(true)
		} finally {
			await instance.close()
			await local.close()
			await rm(root, { recursive: true, force: true })
		}
  })

  it('resumes a checkpointed v4 agent workspace before an approved effect', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root })
    const resumeWorkspace = vi.spyOn(local.workspace, 'resumeWorkspace')
    const provider = new FakeModelProvider({ strict: true })
    provider.enqueueObject({ object: '', toolCalls: [{ id: 'call-1', name: 'effect', arguments: 'approved' }],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'tool_calls' })
    provider.enqueueObject({ object: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    let effects = 0
    const effect = defineTool('effect', { description: 'Apply one approved effect.', input: z.string(), output: z.string(),
      async handler(_context, value) { effects += 1; return value } })
    const agent = defineAgent('workspaceApproval', { input: z.string(), output: z.string(), instructions: 'Use the effect.',
      prompt: value => ({ role: 'user', content: value }), tools: [effect], permissions: { bash: 'allow', write: 'allow', edit: 'allow' },
      governance: { policies: [{ kind: 'native', id: 'approvalPolicy', rules: [{ id: 'approveEffect', tools: ['effect'], effect: 'require_approval' }] }] },
      durable: true, workspace: true })
    const definition = defineV4Harness({ name: 'workspaceApprovalHarness', revision: 'v1' }).addAgent(agent)
    const first = await definition.getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace,
      model: { provider, model: 'fake' } })
    const firstSession = await first.getSession('workspace-approval-session')
    const interrupted = await firstSession.agents.workspaceApproval.run('start', { durable: { runId: 'workspace-approval-run' } })
    if (interrupted.status !== 'interrupted' || interrupted.interrupt.type !== 'tool-approval') throw new Error('Expected approval interruption.')
    expect(effects).toBe(0)
    await first.close()

    const second = await definition.getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace,
      model: { provider, model: 'fake' } })
    try {
      const session = await second.getSession('workspace-approval-session')
      const request = interrupted.interrupt.requests[0]!
      await expect(session.agents.workspaceApproval.run('start', { resume: { type: 'tool-approval', runId: interrupted.runId,
        interruptId: interrupted.interrupt.id, revision: interrupted.interrupt.revision, eventId: 'workspace-resume-event',
        decisions: [{ approvalId: request.approvalId, approved: true }] } })).resolves.toMatchObject({ status: 'completed', output: 'done' })
      expect(resumeWorkspace).toHaveBeenCalledTimes(1)
      expect(effects).toBe(1)
    } finally {
      await second.close()
      await local.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finishes and aborts a cancelled v4 durable workspace after the run terminal is committed', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root })
    const finish = vi.spyOn(local.workspace, 'finish')
    const abort = vi.spyOn(local.workspace, 'abortWorkspace')
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const workflow = defineWorkflow('workspaceCancelled', {
      input: z.string(), output: z.string(), durable: true, workspace: true,
      async handler({ signal }) {
        entered()
        return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
    })
    const harness = await defineV4Harness({ name: 'workspaceCancelledHarness', revision: 'v1' }).addWorkflow(workflow)
      .getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace })
    try {
      const session = await harness.getSession('workspace-cancel-session')
      const controller = new AbortController()
      const running = session.workflows.workspaceCancelled.run('go', { signal: controller.signal,
        durable: { runId: 'workspace-cancel-run' } })
      await started
      controller.abort()
      await expect(running).rejects.toBeInstanceOf(OperationCancelledError)
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ runId: 'workspace-cancel-run', status: 'cancelled' }))
      expect(abort).toHaveBeenCalledWith(expect.objectContaining({ runId: 'workspace-cancel-run', reason: 'cancelled' }))
      await expect(local.storage.getRun('workspace-cancel-run')).resolves.toMatchObject({ status: 'cancelled' })
    } finally {
      await harness.close()
      await local.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finishes a failed v4 durable workspace only after the failed run is committed', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root })
    const calls: string[] = []
    let workspaceRef: string | undefined
    const finalizeRun = local.storage.finalizeRun.bind(local.storage)
    vi.spyOn(local.storage, 'finalizeRun').mockImplementation(async request => {
      calls.push('finalizeRun')
      return finalizeRun(request)
    })
    const finish = local.workspace.finish.bind(local.workspace)
    vi.spyOn(local.workspace, 'finish').mockImplementation(async request => {
      calls.push(`finish:${request.status}`)
      workspaceRef = request.workspaceRef
      return finish(request)
    })
    const workflow = defineWorkflow('workspaceFailed', {
      input: z.string(), output: z.string(), durable: true, workspace: true,
      async handler() { throw new Error('workflow failed') },
    })
    const harness = await defineV4Harness({ name: 'workspaceFailedHarness', revision: 'v1' }).addWorkflow(workflow)
      .getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace })
    try {
      const session = await harness.getSession('workspace-failed-session')
      await expect(session.workflows.workspaceFailed.run('go', { durable: { runId: 'workspace-failed-run' } }))
        .rejects.toThrow('workflow failed')
      expect(calls).toEqual(['finalizeRun', 'finish:failed'])
      await expect(local.storage.getRun('workspace-failed-run')).resolves.toMatchObject({ status: 'failed' })
      await expect(local.workspace.inspectWorkspace?.({ workspaceRef }))
        .resolves.toMatchObject({ state: 'terminal', terminal: { status: 'failed' } })
    } finally {
      await harness.close()
      await local.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('aborts a started workspace when the run sandbox binding cannot open', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root })
    const abort = vi.spyOn(local.workspace, 'abortWorkspace')
    vi.spyOn(local.sandbox, 'open').mockRejectedValueOnce(new Error('sandbox binding failed'))
    let effects = 0
    const workflow = defineWorkflow('workspaceBindingFailure', {
      input: z.string(), output: z.string(), durable: true, workspace: true,
      async handler({ input }) { effects += 1; return input },
    })
    const harness = await defineV4Harness({ name: 'workspaceBindingFailureHarness', revision: 'v1' }).addWorkflow(workflow)
      .getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace })
    try {
      const session = await harness.getSession('workspace-binding-failure-session')
      await expect(session.workflows.workspaceBindingFailure.run('go', { durable: { runId: 'workspace-binding-failure-run' } }))
        .rejects.toThrow('sandbox binding failed')
      expect(abort).toHaveBeenCalledWith(expect.objectContaining({ runId: 'workspace-binding-failure-run', reason: 'failed' }))
      expect(effects).toBe(0)
      await expect(local.storage.listEvents('workspace-binding-failure-run')).resolves.toEqual([])
    } finally {
      await harness.close()
      await local.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('continues cancellation abort when terminal workspace finish cleanup fails', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root })
    const logger = new RecordingLogger()
    vi.spyOn(local.workspace, 'finish').mockRejectedValueOnce(new Error('finish failed'))
    const abort = vi.spyOn(local.workspace, 'abortWorkspace')
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const workflow = defineWorkflow('workspaceCleanupFailure', {
      input: z.string(), output: z.string(), durable: true, workspace: true,
      async handler({ signal }) {
        entered()
        return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
    })
    const harness = await defineV4Harness({ name: 'workspaceCleanupFailureHarness', revision: 'v1' }).addWorkflow(workflow)
      .getInstance({ storage: local.storage, sandbox: local.sandbox, workspace: local.workspace, logger })
    try {
      const session = await harness.getSession('workspace-cleanup-failure-session')
      const controller = new AbortController()
      const running = session.workflows.workspaceCleanupFailure.run('go', { signal: controller.signal,
        durable: { runId: 'workspace-cleanup-failure-run' } })
      await started
      controller.abort()
      await expect(running).rejects.toBeInstanceOf(OperationCancelledError)
      expect(abort).toHaveBeenCalledWith(expect.objectContaining({ runId: 'workspace-cleanup-failure-run', reason: 'cancelled' }))
      expect(logger.entries).toContainEqual(expect.objectContaining({ level: 'warn', msg: 'Terminal workspace cleanup failed.',
        fields: expect.objectContaining({ failure_count: 1 }) }))
    } finally {
      await harness.close()
      await local.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('emits privacy-safe telemetry for local runtime, workspace, sandbox, and context checkpoints', async () => {
    const root = await tempRoot()
    const telemetry = new RecordingTelemetry()
    const local = localDurableExecution({ root })
    configureForTelemetry(local.storage, telemetry)
    configureForTelemetry(local.workspace, telemetry)
    configureForTelemetry(local.sandbox, telemetry)

    await local.storage.createRun({
      id: 'run-otel',
      sessionId: 'session-otel',
      kind: 'workflow',
      target: 'collect',
      startedAt: new Date().toISOString(),
      input: { prompt: 'private prompt text' },
    })
    const lease = await acquireRun(local.storage, 'run-otel', 'session-otel', 'worker-otel', 'collect')
    await local.storage.loadCheckpoint('run-otel')

    const handle = await local.workspace.startWorkspace({
      runId: 'run-otel',
      sessionId: 'session-otel',
      sandboxOwner: durableOwner('session-otel'),
      sandboxPolicyDigest: durablePolicyDigest,
      attempt: lease.attempt,
      idempotencyKey: 'start-otel',
    })
    const sandboxSession = await openLocalSandbox(local.sandbox, 'session-otel', 'run-otel')
    await sandboxSession.write('/workspace/private.txt', 'payload content that must not leak')
    await expect(sandboxSession.readText('/workspace/private.txt')).resolves.toBe('payload content that must not leak')

    const workspaceCheckpoint = await local.workspace.pauseWorkspace({
      handle,
      sandboxPartitions: sharedPartition,
      stepId: 'collect',
      sequence: 1,
      attempt: lease.attempt,
      reason: 'step_completed',
      idempotencyKey: 'pause-otel',
    })
    await local.storage.commitCheckpoint({
      runId: lease.runId,
      sessionId: lease.sessionId,
      workerId: lease.workerId,
      leaseId: lease.leaseId,
      stepId: 'collect',
      input: lease.run.input,
      attempt: lease.attempt,
      sequence: 1,
      output: { ok: true },
      replay: workspaceCheckpoint,
    })

    await finalizeStoredRun(local.storage, lease, { status: 'succeeded', output: { ok: true } })
    await local.workspace.inspectWorkspace?.({ workspaceRef: handle.workspaceRef })
    await local.workspace.cleanupWorkspace({
      workspaceRef: handle.workspaceRef,
      reason: 'manual',
      idempotencyKey: 'cleanup-otel',
    })
    await local.close()

    const spanNames = telemetry.spans.map((span) => span.name)
    expect(spanNames).toEqual(
      expect.arrayContaining([
        'harness.storage.acquire_run',
        'harness.storage.load_checkpoint',
        'harness.storage.commit_checkpoint',
        'harness.workspace.start',
        'harness.workspace.pause',
        'harness.workspace.inspect',
        'harness.workspace.cleanup',
        'harness.local_sandbox.open',
        'harness.local_sandbox.write',
        'harness.local_sandbox.read_text',
      ]),
    )
    expect(telemetry.metrics.map((metric) => metric.name)).toEqual(
      expect.arrayContaining([
        'harness.storage.operations',
        'harness.workspace.operations',
        'harness.workspace.bytes',
        'harness.local_sandbox.operations',
      ]),
    )

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
    expect(sandboxOpen?.attrs).not.toHaveProperty('harness.workspace.ref_hash')
    const sandboxMetrics = telemetry.metrics.filter((metric) => metric.name.startsWith('harness.local_sandbox.'))
    expect(sandboxMetrics.length).toBeGreaterThan(0)
    for (const metric of sandboxMetrics) {
      expect(Object.keys(metric.attrs ?? {})).not.toEqual(expect.arrayContaining(['harness.workspace.ref_hash']))
      expect(JSON.stringify(metric.attrs)).not.toMatch(/[0-9a-f]{64}/)
    }
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
    const session = await openLocalSandbox(sandbox, 'session-symlink', 'run-symlink')
    await symlink(outsideFile, join(await localSandboxFiles(root), 'workspace', 'escape.txt'))

    await expect(session.readText('/workspace/escape.txt')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'invalid_path' },
    })
    await expect(session.write('/workspace/escape.txt', 'mutated')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'invalid_path' },
    })
  })

  it('keeps host command execution disabled by default and enforces allow-lists when enabled', async () => {
    const root = await tempRoot()
    const disabled = await openLocalSandbox(
      localDirectorySandbox({ root, exec: false }),
      'session-exec-disabled',
      'run-exec-disabled',
    )
    await expect(disabled.exec?.('node -e "process.stdout.write(1)"')).rejects.toMatchObject({
      code: 'SANDBOX_NO_EXECUTOR',
    })

    const enabled = await openLocalSandbox(
      localDirectorySandbox({
        root,
        exec: { allowCommands: ['node'], timeoutMs: 5_000 },
      }),
      'session-exec-enabled',
      'run-exec-enabled',
    )
    await expect(enabled.exec?.('echo nope')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'exec_failed' },
    })
    await expect(enabled.exec?.('node -e "process.stdout.write(process.cwd())"')).resolves.toMatchObject({
      exitCode: 0,
    })
  })
})

describe('SQLite Harness storage durability', () => {
  async function tempFile(): Promise<string> {
    return join(await tempRoot(), 'runtime.sqlite')
  }

  const start = async (
    storage: ReturnType<typeof sqliteHarnessStorage>,
    workerId: string,
    runId = 'run-1',
    sessionId = 'session-1',
  ) => {
    if (!(await storage.getRun(runId))) {
      await storage.createRun({
        id: runId,
        sessionId,
        kind: 'workflow',
        target: 'step-a',
        startedAt: new Date().toISOString(),
        input: { ok: true },
      })
    }
    return acquireRun(storage, runId, sessionId, workerId, 'step-a')
  }

  it('renews the lease for a same-worker retry within the TTL', async () => {
    const runtime = sqliteHarnessStorage({ file: await tempFile() })
    const first = await start(runtime, 'worker-1')
    const retry = await runtime.acquireRun({ mode: 'initial', runId: first.runId, sessionId: first.sessionId,
      workerId: first.workerId, acquisitionId: first.acquisitionId, expected: first.acquiredFrom })
    expect(retry.attempt).toBe(first.attempt)
    expect(retry.leaseId).toBe(first.leaseId)
    await runtime.close()
  })

  it('rejects another worker while the lease is active and allows takeover after expiry', async () => {
    let nowMs = 1_700_000_000_000
    const runtime = sqliteHarnessStorage({ file: await tempFile(), leaseTtlMs: 1_000, now: () => nowMs })
    await start(runtime, 'worker-1')
    await expect(start(runtime, 'worker-2')).rejects.toMatchObject({
      code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'lease_conflict' },
    })
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
      input: lease.run.input,
      attempt: lease.attempt,
      sequence: 1,
      output: { value: 1 },
    })
    // Past the original expiry but inside the renewed window: still owned.
    nowMs += 400
    await expect(start(runtime, 'worker-2')).rejects.toMatchObject({
      code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'lease_conflict' },
    })
    // Past the renewed expiry: takeover succeeds and the stale lease loses write access.
    nowMs += 1_000
    await start(runtime, 'worker-2')
    await expect(
      runtime.commitCheckpoint({
        runId: lease.runId,
        sessionId: lease.sessionId,
        workerId: lease.workerId,
        leaseId: lease.leaseId,
        stepId: 'step-b',
        input: lease.run.input,
        attempt: lease.attempt,
        sequence: 2,
        output: { value: 2 },
      }),
    ).rejects.toBeInstanceOf(DurableRunLeaseError)
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
      input: lease.run.input,
      attempt: lease.attempt,
      sequence: 1,
      output: { value: 1 },
    }
    await runtime.commitCheckpoint(checkpoint)
    await expect(runtime.commitCheckpoint(checkpoint)).resolves.toBeUndefined()
    await expect(runtime.commitCheckpoint({ ...checkpoint, output: { value: 2 } })).rejects.toMatchObject({
      code: 'STATE_ERROR',
      meta: { reason: 'checkpoint_conflict' },
    })
    await runtime.close()
  })

  it('rejects terminal runs and resumes only interrupted runs', async () => {
    const runtime = sqliteHarnessStorage({ file: await tempFile() })

    const succeeded = await start(runtime, 'worker-1', 'run-success', 'session-success')
    await finalizeStoredRun(runtime, succeeded, { status: 'succeeded', output: { ok: true } })
    await expect(start(runtime, 'worker-1', 'run-success', 'session-success')).rejects.toBeInstanceOf(
      DurableTerminalRunError,
    )

    const cancelled = await start(runtime, 'worker-1', 'run-cancelled', 'session-cancelled')
    await finalizeStoredRun(runtime, cancelled, {
      status: 'cancelled',
      error: { code: 'OPERATION_CANCELLED', message: 'stop' },
    })
    await expect(start(runtime, 'worker-1', 'run-cancelled', 'session-cancelled')).rejects.toBeInstanceOf(
      DurableTerminalRunError,
    )

    const failed = await start(runtime, 'worker-1', 'run-interrupted', 'session-interrupted')
    await runtime.commitCheckpoint({
      runId: failed.runId,
      sessionId: failed.sessionId,
      workerId: failed.workerId,
      leaseId: failed.leaseId,
      stepId: 'step-a',
      input: failed.run.input,
      attempt: failed.attempt,
      sequence: 1,
      output: { value: 1 },
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
    await expect(
      runtime.commitCheckpoint({
        runId: lease.runId,
        sessionId: lease.sessionId,
        workerId: lease.workerId,
        leaseId: lease.leaseId,
        stepId: 'step-a',
        input: lease.run.input,
        attempt: lease.attempt,
        sequence: 1,
        output: cyclic as unknown as JsonValue,
      }),
    ).rejects.toMatchObject({ code: 'STATE_ERROR', meta: { op: 'commitCheckpoint', reason: 'checkpoint_conflict' } })
    await expect(runtime.loadCheckpoint(lease.runId)).resolves.toBeUndefined()
    await runtime.close()
  })

  it('serializes concurrent transactions across two sessions on one connection', async () => {
    const root = await tempRoot()
    const local = localDurableExecution({ root })
    const runFor = async (index: number): Promise<void> => {
      const sessionId = `session-${index}`
      const runId = `run-${index}`
      await local.storage.createRun({
        id: runId,
        sessionId,
        kind: 'workflow',
        target: 'step-a',
        startedAt: new Date().toISOString(),
        input: { index },
      })
      const lease = await acquireRun(local.storage, runId, sessionId, 'worker-1', 'step-a')
      for (let sequence = 1; sequence <= 5; sequence += 1) {
        await local.storage.commitCheckpoint({
          runId,
          sessionId,
          workerId: lease.workerId,
          leaseId: lease.leaseId,
          stepId: `step-${sequence}`,
          input: lease.run.input,
          attempt: lease.attempt,
          sequence,
          output: { sequence },
        })
        await local.storage.appendMessages(sessionId, [
          {
            id: `${runId}-msg-${sequence}`,
            sessionId,
            role: 'assistant',
            content: `step ${sequence}`,
            timestamp: new Date().toISOString(),
          },
        ])
      }
      await finalizeStoredRun(local.storage, lease, { status: 'succeeded', output: { done: true } })
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
    await expect(
      store.resumeWorkspace({
        workspaceRef: traversal,
        runId: 'r',
        sessionId: 's',
        attempt: 1,
        idempotencyKey: 'resume',
        signal,
      }),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'invalid_reference' },
    })
    await expect(
      store.abortWorkspace({
        workspaceRef: traversal,
        runId: 'r',
        sessionId: 's',
        reason: 'cancelled',
        idempotencyKey: 'abort',
        signal,
      }),
    ).rejects.toMatchObject({
      meta: { reason: 'invalid_reference' },
    })
    await expect(
      store.cleanupWorkspace({ workspaceRef: traversal, reason: 'manual', idempotencyKey: 'cleanup', signal }),
    ).rejects.toMatchObject({
      meta: { reason: 'invalid_reference' },
    })
    await expect(store.inspectWorkspace?.({ workspaceRef: traversal, signal })).rejects.toMatchObject({
      meta: { reason: 'invalid_reference' },
    })
  })

  it('cleanup refuses to follow a workspace symlink outside the store root', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    const store = localDirectoryWorkspace({ root })
    // Materialize the store root, then plant a symlink that "looks like" a ref.
    await store.startWorkspace({
      runId: 'r',
      sessionId: 's',
      sandboxOwner: durableOwner('s'),
      sandboxPolicyDigest: durablePolicyDigest,
      attempt: 1,
      idempotencyKey: 'start',
      signal,
    })
    await symlink(outside, join(root, 'workspaces', 'workspace_FAKE'))
    await expect(
      store.cleanupWorkspace({ workspaceRef: 'workspace_FAKE', reason: 'manual', idempotencyKey: 'cleanup', signal }),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'invalid_reference' },
    })
    await expect(stat(outside)).resolves.toBeDefined()
  })

  it('persists idempotency replay and conflicts across store rebuilds', async () => {
    const root = await tempRoot()
    const first = localDirectoryWorkspace({ root })
    const handle = await first.startWorkspace({
      runId: 'r',
      sessionId: 's',
      sandboxOwner: durableOwner('s'),
      sandboxPolicyDigest: durablePolicyDigest,
      attempt: 1,
      idempotencyKey: 'start-key',
      signal,
    })

    const second = localDirectoryWorkspace({ root })
    const replayed = await second.startWorkspace({
      runId: 'r',
      sessionId: 's',
      sandboxOwner: durableOwner('s'),
      sandboxPolicyDigest: durablePolicyDigest,
      attempt: 1,
      idempotencyKey: 'start-key',
      signal,
    })
    expect(replayed.workspaceRef).toBe(handle.workspaceRef)
    await expect(
      second.startWorkspace({
        runId: 'other-run',
        sessionId: 'other-session',
        sandboxOwner: durableOwner('other-session'),
        sandboxPolicyDigest: durablePolicyDigest,
        attempt: 1,
        idempotencyKey: 'start-key',
        signal,
      }),
    ).rejects.toMatchObject({
      code: 'WORKSPACE_ERROR',
      meta: { reason: 'idempotency_conflict' },
    })
  })

  it('rejects unenforceable live-filesystem byte quotas at construction', async () => {
    const root = await tempRoot()
    try {
      localDirectoryWorkspace({ root, policy: { quota: { maxWorkspaceBytes: 8 } } })
      throw new Error('Expected unsupported policy rejection.')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'HARNESS_CONFIG_ERROR',
        meta: { reason: 'unsupported_workspace_policy', path: 'quota' },
      })
    }
  })

  it('rejects orphan TTLs because a local workspace cannot confirm an orphan safely', async () => {
    const root = await tempRoot()
    try {
      expect(() =>
        localDirectoryWorkspace({
          root,
          policy: { retention: { cleanupMode: 'application_scheduled', orphanTtlMs: 1 } },
        }),
      ).toThrowError(
        expect.objectContaining({
          code: 'HARNESS_CONFIG_ERROR',
          meta: { reason: 'unsupported_workspace_policy', path: 'retention.orphanTtlMs' },
        }),
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an oversized checkpoint payload before publishing a local checkpoint', async () => {
    const root = await tempRoot()
    try {
      const store = localDirectoryWorkspace({ root, policy: { quota: { maxCheckpointPayloadBytes: 8 } } })
      const handle = await store.startWorkspace({
        runId: 'payload-run',
        sessionId: 'payload-session',
        sandboxOwner: durableOwner('payload'),
        sandboxPolicyDigest: durablePolicyDigest,
        attempt: 1,
        idempotencyKey: 'payload-start',
        signal,
      })

      await expect(
        store.pauseWorkspace({
          handle,
          sandboxPartitions: sharedPartition,
          stepId: 'payload-step',
          sequence: 1,
          attempt: 1,
          checkpointPayload: '1234567',
          reason: 'step_completed',
          idempotencyKey: 'payload-pause',
          signal,
        }),
      ).rejects.toMatchObject({
        code: 'WORKSPACE_QUOTA_EXCEEDED',
        meta: { quota: 'maxCheckpointPayloadBytes', limit: 8, actual: 9 },
      })
      await expect(store.inspectWorkspace?.({ workspaceRef: handle.workspaceRef, signal })).resolves.toMatchObject({
        checkpoints: [],
      })
      await expect(
        store.administration.list({
          selector: { kind: 'owner', owner: durableOwner('payload') },
          kind: 'snapshot',
          signal,
        }),
      ).resolves.toMatchObject({ items: [] })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps recovery-pinned checkpoints through an expired scheduled sweep', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:00:00.000Z'))
    const root = await tempRoot()
    try {
      const store = localDirectoryWorkspace({
        root,
        policy: { retention: { cleanupMode: 'application_scheduled', terminalSuccessTtlMs: 1 } },
      })
      const owner = durableOwner('retention')
      const handle = await store.startWorkspace({
        runId: 'retention-run',
        sessionId: 'retention-session',
        sandboxOwner: owner,
        sandboxPolicyDigest: durablePolicyDigest,
        attempt: 1,
        idempotencyKey: 'retention-start',
        signal,
      })
      const checkpoint = await store.pauseWorkspace({
        handle,
        sandboxPartitions: sharedPartition,
        stepId: 'retention-step',
        sequence: 1,
        attempt: 1,
        reason: 'step_completed',
        idempotencyKey: 'retention-pause',
        signal,
      })
      await store.pinCheckpoint({
        workspaceRef: handle.workspaceRef,
        checkpointRef: checkpoint.checkpointRef,
        runId: handle.runId,
        idempotencyKey: 'retention-pin',
        signal,
      })
      await store.finish({
        workspaceRef: handle.workspaceRef,
        runId: handle.runId,
        status: 'succeeded',
        idempotencyKey: 'retention-finish',
        signal,
      })

      vi.advanceTimersByTime(2)
      await expect(store.administration.sweep({ limit: 10, signal })).resolves.toMatchObject({
        examinedResources: 0,
        deletedResources: 0,
        pendingResources: 0,
      })
      await expect(store.inspectWorkspace?.({ workspaceRef: handle.workspaceRef, signal })).resolves.toMatchObject({
        state: 'terminal',
        checkpoints: [expect.objectContaining({ checkpointRef: checkpoint.checkpointRef })],
      })

      await store.releaseCheckpoint({
        workspaceRef: handle.workspaceRef,
        checkpointRef: checkpoint.checkpointRef,
        runId: handle.runId,
        idempotencyKey: 'retention-release',
        signal,
      })
      await expect(store.administration.sweep({ limit: 10, signal })).resolves.toMatchObject({
        deletedResources: 2,
        pendingResources: 0,
      })
      await expect(store.inspectWorkspace?.({ workspaceRef: handle.workspaceRef, signal })).rejects.toMatchObject({
        meta: { reason: 'not_found' },
      })
    } finally {
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a durable, content-free checkpoint inventory for operators', async () => {
    const root = await tempRoot()
    const store = localDirectoryWorkspace({ root })
    const owner = durableOwner('operator')
    const handle = await store.startWorkspace({
      runId: 'r',
      sessionId: 's',
      sandboxOwner: owner,
      sandboxPolicyDigest: durablePolicyDigest,
      attempt: 1,
      idempotencyKey: 'start',
      signal,
    })
    const checkpoint = await store.pauseWorkspace({
      handle,
      sandboxPartitions: sharedPartition,
      stepId: 'step-1',
      sequence: 1,
      attempt: 1,
      reason: 'step_completed',
      idempotencyKey: 'pause',
      signal,
    })
    const listed = await store.administration.list({ selector: { kind: 'owner', owner }, kind: 'snapshot' })
    expect(listed.items).toEqual([
      expect.objectContaining({ resourceId: checkpoint.checkpointRef, kind: 'snapshot', pinned: false }),
    ])
    await store.administration.deleteSnapshot({ owner, snapshotId: checkpoint.checkpointRef, signal })
    await expect(store.inspectWorkspace!({ workspaceRef: handle.workspaceRef, signal })).resolves.toMatchObject({
      checkpoints: [],
    })
  })
})

describe('local sandbox hardening (spec 22 §5/§8)', () => {
  it('blocks shell-metacharacter bypasses of the exec allow-list', async () => {
    const root = await tempRoot()
    const session = await openLocalSandbox(
      localDirectorySandbox({ root, exec: { allowCommands: ['node'], timeoutMs: 5_000 } }),
      'session-bypass',
      'run-bypass',
    )
    const probe = join(root, 'bypass-proof.txt')
    for (const command of [
      `node -v; touch ${probe}`,
      `node -v | touch ${probe}`,
      `node -v && touch ${probe}`,
      `node -v $(touch ${probe})`,
      'node -v `touch /tmp/x`',
      `node -v > ${probe}`,
    ]) {
      await expect(session.exec(command)).rejects.toMatchObject({
        code: 'SANDBOX_ERROR',
        meta: { reason: 'exec_failed' },
      })
    }
    await expect(stat(probe)).rejects.toThrow()
  })

  it('runs commands without a shell so expansions and substitutions stay literal', async () => {
    const root = await tempRoot()
    const session = await openLocalSandbox(
      localDirectorySandbox({ root, exec: { timeoutMs: 5_000 } }),
      'session-argv',
      'run-argv',
    )
    const result = await session.exec('node -e "process.stdout.write(process.argv[1])" literal-$HOME')
    expect(result.stdout).toBe('literal-$HOME')
  })

  it('blocks dangling-symlink write escapes', async () => {
    const root = await tempRoot()
    const outsideRoot = await tempRoot()
    const danglingTarget = join(outsideRoot, 'does-not-exist-yet.txt')

    const sandbox = localDirectorySandbox({ root, exec: false })
    const session = await openLocalSandbox(sandbox, 'session-dangling', 'run-dangling')
    await symlink(danglingTarget, join(await localSandboxFiles(root), 'workspace', 'dangling.txt'))

    await expect(session.write('/workspace/dangling.txt', 'escape')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'invalid_path' },
    })
    await expect(stat(danglingTarget)).rejects.toThrow()
  })

  it('rejects aborted exec with OperationCancelledError and signal-killed exec as failure', async () => {
    const root = await tempRoot()
    const session = await openLocalSandbox(localDirectorySandbox({ root, exec: {} }), 'session-abort', 'run-abort')

    const controller = new AbortController()
    const pending = session.exec('node -e "setTimeout(() => {}, 30000)"', { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
      meta: { scope: 'sandbox' },
    })

    await expect(session.exec('node -e "process.kill(process.pid, \'SIGKILL\')"')).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'exec_failed' },
    })
  })

  it('hashes logical owner and run identifiers instead of using them as host paths', async () => {
    const root = await tempRoot()
    const sandbox = localDirectorySandbox({ root, exec: false })
    const first = await openLocalSandbox(sandbox, '../escape', 'run-ok')
    const second = await openLocalSandbox(sandbox, 'session-ok', '..')
    await first.write('/workspace/first', 'first')
    await expect(second.exists('/workspace/first')).resolves.toBe(false)
    expect((await readdir(join(root, 'sandboxes'))).every((entry) => /^[a-f0-9]{64}$/.test(entry))).toBe(true)
  })

  it('falls back to the configured harness toolTimeoutMs for exec', async () => {
    const root = await tempRoot()
    const sandbox = localDirectorySandbox({ root, exec: {} })
    configureForTelemetry(sandbox, new RecordingTelemetry(), { toolTimeoutMs: 200 })
    const session = await openLocalSandbox(sandbox, 'session-timeout', 'run-timeout')
    await expect(session.exec('node -e "setTimeout(() => {}, 30000)"')).rejects.toMatchObject({
      code: 'OPERATION_TIMEOUT',
      meta: { scope: 'sandbox_run', timeout_ms: 200 },
    })
  })

  it('caps captured exec output and appends a truncation marker', async () => {
    const root = await tempRoot()
    const session = await openLocalSandbox(
      localDirectorySandbox({ root, exec: { timeoutMs: 30_000 } }),
      'session-cap',
      'run-cap',
    )
    const result = await session.exec('node -e "process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 97))"')
    expect(result.exitCode).toBe(0)
    expect(result.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024 + 100)
    expect(result.stdout.endsWith('[truncated: local sandbox capture limit reached]')).toBe(true)
  })

  it('supports mount, glob list, stat, and remove inside the jail', async () => {
    const root = await tempRoot()
    const session = await openLocalSandbox(localDirectorySandbox({ root, exec: false }), 'session-fs', 'run-fs')
    await session.mount(
      new Map<string, string>([
        ['a.txt', 'alpha'],
        ['b.log', 'beta'],
      ]),
      '/workspace/mounted',
    )
    const txtEntries = await session.list('/workspace/mounted', { glob: '*.txt' })
    expect(txtEntries.map((entry) => entry.name)).toEqual(['a.txt'])
    await expect(session.stat('/workspace/mounted/a.txt')).resolves.toMatchObject({ kind: 'file', size: 5 })
    await session.remove('/workspace/mounted', { recursive: true })
    await expect(session.exists('/workspace/mounted')).resolves.toBe(false)
  })

  it('provides a spawn-capable local process boundary without claiming immutable package mounts', async () => {
    const root = await tempRoot()
    const session = await openLocalSandbox(
      localDirectorySandbox({ root, exec: { allowCommands: ['node'], timeoutMs: 5_000 } }),
      'session-plugin',
      'run-plugin',
    )
    expect(isReadOnlyMountCapableSession(session)).toBe(false)
    if (!('spawn' in session) || typeof session.spawn !== 'function')
      throw new Error('Expected local spawn capability.')
    const process = await session.spawn('node', { args: ['-e', 'process.stdout.write("ready")'] })
    let output = ''
    for await (const chunk of process.stdout) output += chunk
    await process.exit
    expect(output).toBe('ready')
  })

  it('jails exec cwd to the sandbox root', async () => {
    const root = await tempRoot()
    const session = await openLocalSandbox(
      localDirectorySandbox({ root, exec: { timeoutMs: 5_000 } }),
      'session-cwd',
      'run-cwd',
    )
    const result = await session.exec('node -e "process.stdout.write(process.cwd())"', {
      cwd: '/workspace/../workspace',
    })
    expect(result.stdout.endsWith('/workspace')).toBe(true)
    await expect(session.exec('node -v', { cwd: '/missing' })).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'fs_failed' },
    })
  })
})
