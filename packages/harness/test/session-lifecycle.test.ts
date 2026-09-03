import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  InMemoryDurableWorkspace,
  InMemoryHarnessStorage,
  OperationCancelledError,
  SessionBusyError,
  defineHarness,
  inMemorySandbox,
  type DurableWorkspace,
  type Sandbox,
  type SandboxBindingOptions,
  type SandboxOpenOptions,
  type SandboxOpenResult,
  type SandboxPolicy,
  type SandboxScope,
  type SandboxSession,
  type SandboxTerminateOptions,
  type RunOutcome,
} from '../src/index.js'
import { runTelemetryFlowHarness } from './telemetryFlowHarness.js'

function completedOutput<T>(outcome: RunOutcome<T>): T {
  if (outcome.status !== 'completed') throw new Error('Expected the test run to complete.')
  return outcome.output
}

function buildBusyHarness() {
  let markHandlerStarted!: () => void
  const handlerStarted = new Promise<void>((resolve) => {
    markHandlerStarted = resolve
  })
  const harness = defineHarness()
    .sandbox(inMemorySandbox())
    .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
    .tools({})
    .skills({})
    .agent('echo', {
      model: 'fake',
      input: z.string(),
      output: z.string(),
      handler: async (ctx) => ctx.input,
    })
    .workflow('hang', {
      input: z.string(),
      output: z.string(),
      handler: async () => {
        markHandlerStarted()
        return new Promise<never>(() => undefined)
      },
    })
    .build()
  return { harness, handlerStarted }
}

class TrackingHarnessStorage extends InMemoryHarnessStorage {
  public closeSessionCalls = 0

  public override async closeSession(id: string, expectedInstanceId: string): Promise<void> {
    this.closeSessionCalls += 1
    await super.closeSession(id, expectedInstanceId)
  }
}

class RestartableTrackingHarnessStorage extends TrackingHarnessStorage {
  // A real durable store keeps session records when an adapter handle closes.
	public override async close(): Promise<void> {}
}

class TrackingSandbox implements Sandbox {
  public readonly capabilities = ['sandbox.fs', 'sandbox.exec'] as const
  public openCalls = 0
  public closeCalls = 0
  public readonly ownerRegistrations: Parameters<Sandbox['registerOwner']>[0][] = []
  public failNextOwnerRegistration: Error | undefined
  public readonly openedScopes: SandboxScope[] = []
  public readonly terminatedScopes: SandboxScope[] = []
  private readonly delegate = inMemorySandbox()

  public get administration() {
    return this.delegate.administration
  }

  public async registerOwner(options: Parameters<Sandbox['registerOwner']>[0]): Promise<void> {
    this.ownerRegistrations.push(options)
    const failure = this.failNextOwnerRegistration
    this.failNextOwnerRegistration = undefined
    if (failure) throw failure
    await this.delegate.registerOwner(options)
  }

  public async open(opts: SandboxOpenOptions): Promise<SandboxOpenResult<readonly ['sandbox.fs', 'sandbox.exec']>> {
    this.openCalls += 1
    this.openedScopes.push(opts.scope)
    const opened = await this.delegate.open(opts)
    const session = opened.session as SandboxSession
    return {
      ...opened,
      session: new Proxy(session, {
        get: (target, property) => {
			if (property === 'close') {
            return async (): Promise<void> => {
              this.closeCalls += 1
					await target.close()
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as SandboxOpenResult<readonly ['sandbox.fs', 'sandbox.exec']>['session'],
    }
  }

  public async terminate(opts: SandboxTerminateOptions): Promise<void> {
    this.terminatedScopes.push(opts.scope)
    await this.delegate.terminate(opts)
  }
}

function trackAdministrationPurge(
  adapter: { readonly administration: Sandbox['administration'] },
  events: string[],
  label: string,
  nextResult?: () => Awaited<ReturnType<Sandbox['administration']['purge']>> | undefined,
): void {
  const administration = adapter.administration
  const purge = administration.purge.bind(administration)
  const tracked = new Proxy(administration, {
    get: (target, property, receiver) => {
      if (property === 'purge') {
        return async (...args: Parameters<Sandbox['administration']['purge']>) => {
          events.push(label)
          return nextResult?.() ?? purge(...args)
        }
      }
      const value = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  Object.defineProperty(adapter, 'administration', { configurable: true, value: tracked })
}

function buildReleaseHarness(
  storage = new TrackingHarnessStorage(),
  sandbox = new TrackingSandbox(),
  workerSandbox?: SandboxPolicy,
  workspace?: DurableWorkspace,
  sandboxBinding?: SandboxBindingOptions<string>,
) {
  let markChildStarted!: () => void
  const childStarted = new Promise<void>((resolve) => {
    markChildStarted = resolve
  })
  const builder = defineHarness().storage(storage).sandbox(sandbox, sandboxBinding)
  const configured = workspace ? builder.workspace(workspace) : builder
  const harness = configured
    .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
    .tools({})
    .skills({})
    .agent('echo', {
      model: 'fake',
      input: z.string(),
      output: z.string(),
      builtinTools: false,
      handler: async (ctx) => ctx.input,
    })
    .agent('worker', {
      model: 'fake',
      input: z.string(),
      output: z.string(),
      builtinTools: false,
      ...(workerSandbox === undefined ? {} : { sandbox: workerSandbox }),
      handler: async (ctx) => {
        markChildStarted()
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => reject(new OperationCancelledError('Child task cancelled.', { scope: 'run' })),
            { once: true },
          )
        })
        return ctx.input
      },
    })
    .workflow('echo_workflow', {
      input: z.string(),
      output: z.string(),
      handler: async (ctx) => ctx.input,
    })
    .workflow('start_child', {
      input: z.string(),
      output: z.string(),
      delegation: { agents: ['worker'] },
      handler: async (ctx) => (await ctx.childTasks.start('worker', ctx.input)).id,
    })
    .build()
  return { harness, storage, sandbox, childStarted }
}

describe('session lifecycle guards', () => {
  it('registers and acknowledges an implicit owner before any compute allocation', async () => {
    const { harness, storage, sandbox } = buildReleaseHarness()

    const session = await harness.getSession('s-no-live-owner')

    expect(sandbox.ownerRegistrations).toEqual([
      expect.objectContaining({ mode: 'create', owner: expect.objectContaining({ id: 's-no-live-owner' }) }),
    ])
    expect(sandbox.openCalls).toBe(0)
    await expect(storage.getSession('s-no-live-owner')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ relation: 'owned', registration: 'registered' }),
      }),
    )

    await session.release()
    await session.destroy()

    expect(sandbox.openCalls).toBe(0)
    expect(storage.closeSessionCalls).toBe(1)
  })

  it('retries a pending implicit-owner registration without allocating compute', async () => {
    const sandbox = new TrackingSandbox()
    sandbox.failNextOwnerRegistration = new Error('owner journal temporarily unavailable')
    const { harness, storage } = buildReleaseHarness(undefined, sandbox)

    await expect(harness.getSession('s-owner-registration-retry')).rejects.toThrow(
      'owner journal temporarily unavailable',
    )
    await expect(storage.getSession('s-owner-registration-retry')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ registration: 'pending' }),
      }),
    )
    expect(sandbox.openCalls).toBe(0)

    const session = await harness.getSession('s-owner-registration-retry')

    expect(sandbox.ownerRegistrations).toHaveLength(2)
    expect(sandbox.ownerRegistrations).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'create' })]))
    expect(sandbox.openCalls).toBe(0)
    await expect(storage.getSession('s-owner-registration-retry')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ registration: 'registered' }),
      }),
    )
    await session.destroy()
  })

  it('keeps a registered no-live owner usable after a harness restart', async () => {
    const storage = new RestartableTrackingHarnessStorage()
    const sandbox = new TrackingSandbox()
    const first = buildReleaseHarness(storage, sandbox).harness
    const session = await first.getSession('s-no-live-restart')
    await session.release()
    await first.shutdown()

    const restarted = buildReleaseHarness(storage, sandbox).harness
    const recovered = await restarted.getSession('s-no-live-restart')

    // An acknowledged owner is attached only when live compute is opened.
    expect(sandbox.ownerRegistrations).toEqual([expect.objectContaining({ mode: 'create' })])
    expect(sandbox.openCalls).toBe(0)
    await recovered.release()
    await recovered.destroy()
    expect(sandbox.openCalls).toBe(0)
    expect(storage.closeSessionCalls).toBe(1)
  })

  it('rejects concurrent runs without leaking caller-signal abort listeners', async () => {
    const { harness, handlerStarted } = buildBusyHarness()
    const session = await harness.getSession('s-busy-listeners')
    const firstController = new AbortController()
    const first = session.workflows.hang
      .run('x', { signal: firstController.signal })
      .catch((error: unknown) => error)
    await handlerStarted

    const secondController = new AbortController()
    await expect(session.workflows.hang.run('y', { signal: secondController.signal })).rejects.toBeInstanceOf(
      SessionBusyError,
    )
    // SessionBusyError is retriable: a rejected attempt must not leave a
    // run-timeout timer or an abort listener behind on the caller's signal.
    expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(0)

    const agentController = new AbortController()
    await expect(session.agents.echo.run('y', { signal: agentController.signal })).rejects.toBeInstanceOf(
      SessionBusyError,
    )
    expect(getEventListeners(agentController.signal, 'abort')).toHaveLength(0)

    firstController.abort()
    await expect(first).resolves.toBeInstanceOf(OperationCancelledError)
  })

  it('refuses to destroy a busy session', async () => {
    const { harness, handlerStarted } = buildBusyHarness()
    const session = await harness.getSession('s-busy-destroy')
    const controller = new AbortController()
    const run = session.workflows.hang.run('x', { signal: controller.signal }).catch((error: unknown) => error)
    await handlerStarted

    await expect(session.destroy()).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      meta: expect.objectContaining({ reason: 'concurrent_run' }),
    })
    await expect(session.release()).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      meta: expect.objectContaining({ reason: 'concurrent_run' }),
    })

    controller.abort()
    await expect(run).resolves.toBeInstanceOf(OperationCancelledError)
    await expect(session.destroy()).resolves.toBeUndefined()
  })

  it('releases live resources without deleting persisted session, history, or runs', async () => {
    const { harness, storage, sandbox } = buildReleaseHarness()
    const session = await harness.getSession('s-release')
    await session.replaceHistory([{ role: 'user', content: 'remember this' }])
    await expect(session.agents.echo.run('done')).resolves.toMatchObject({ status: 'completed', output: 'done' })

    await Promise.all([session.release(), session.release()])

    expect(sandbox.openCalls).toBe(1)
    expect(sandbox.closeCalls).toBe(1)
    expect(storage.closeSessionCalls).toBe(0)
    await expect(storage.getSession('s-release')).resolves.toEqual(
      expect.objectContaining({ id: 's-release', runCount: 1 }),
    )
    await expect(session.history.list()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'remember this' })]),
    )
    await expect(storage.listRuns('s-release')).resolves.toHaveLength(1)

    const reopened = await harness.getSession('s-release')
    await expect(reopened.agents.echo.run('again')).resolves.toMatchObject({ status: 'completed', output: 'again' })
    expect(sandbox.openCalls).toBe(2)
    await reopened.release()
  })

  it('does not let a stale facade release or destroy a reopened session generation', async () => {
    const { harness, storage, sandbox } = buildReleaseHarness()
    const original = await harness.getSession('s-stale-release')
    await original.release()

    const reopened = await harness.getSession('s-stale-release')
    await expect(reopened.agents.echo.run('still active')).resolves.toMatchObject({ status: 'completed', output: 'still active' })
    await expect(original.agents.echo.run('stale invocation')).rejects.toMatchObject({
      code: 'STATE_ERROR',
      meta: { reason: 'session_attachment_closed' },
    })
    await expect(original.clearHistory()).rejects.toMatchObject({
      code: 'STATE_ERROR',
      meta: { reason: 'session_attachment_closed' },
    })
    await original.destroy()

    expect(sandbox.closeCalls).toBe(0)
    await expect(storage.getSession('s-stale-release')).resolves.toEqual(expect.objectContaining({ runCount: 1 }))
    await expect(reopened.agents.echo.run('still here')).resolves.toMatchObject({ status: 'completed', output: 'still here' })
    await reopened.release()
  })

  it('allows a released session generation to be destructively destroyed before it is reopened', async () => {
    const { harness, storage } = buildReleaseHarness()
    const session = await harness.getSession('s-release-then-destroy')
    await session.agents.echo.run('remove after release')

    await session.release()
    await session.destroy()

    expect(storage.closeSessionCalls).toBe(1)
    await expect(storage.getSession('s-release-then-destroy')).resolves.toBeUndefined()
  })

  it('disposes owned compute without deleting history, while allowing terminal idempotent replay only', async () => {
    const { harness, storage } = buildReleaseHarness()
    const session = await harness.getSession('s-dispose-sandbox')
    await session.replaceHistory([{ role: 'user', content: 'retain this receipt context' }])
    await expect(session.agents.echo.run('complete', { idempotencyKey: 'delivery-1' })).resolves.toMatchObject({ status: 'completed', output: 'complete' })

    await session.disposeSandbox()

    await expect(storage.getSession('s-dispose-sandbox')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ disposed: true }),
      }),
    )
    const reopened = await harness.getSession('s-dispose-sandbox')
    await expect(reopened.history.list()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ content: 'retain this receipt context' })]),
    )
    await expect(reopened.agents.echo.run('complete', { idempotencyKey: 'delivery-1' })).resolves.toMatchObject({ status: 'completed', output: 'complete' })
    const replayedEvents = []
    for await (const event of reopened.agents.echo.observe('complete', { idempotencyKey: 'delivery-1' })) {
      replayedEvents.push(event)
    }
    expect(replayedEvents).toMatchObject([{ type: 'run.started' }, { type: 'run.finished', output: 'complete' }])
    await expect(reopened.agents.echo.run('must not recreate')).rejects.toMatchObject({
      code: 'SANDBOX_STATE_LOST',
      meta: { reason: 'scope_terminated' },
    })
  })

  it('purges an owned sandbox before its associated workspace and marks disposal only after both complete', async () => {
    const events: string[] = []
    const sandbox = new TrackingSandbox()
    const workspace = new InMemoryDurableWorkspace()
    trackAdministrationPurge(sandbox, events, 'sandbox')
    trackAdministrationPurge(workspace, events, 'workspace')
    const { harness, storage } = buildReleaseHarness(undefined, sandbox, undefined, workspace)
    const session = await harness.getSession('s-dispose-workspace')
    await session.agents.echo.run('allocate')
    const owner = (await storage.getSession('s-dispose-workspace'))!.sandboxBinding.owner
    await workspace.startWorkspace({
      sessionId: 's-dispose-workspace',
      runId: 'workspace-run',
      sandboxOwner: owner,
      sandboxPolicyDigest: 'a'.repeat(64),
      attempt: 1,
      idempotencyKey: 'workspace-start',
    })

    await session.disposeSandbox()

    expect(events).toEqual(['sandbox', 'workspace'])
    await expect(storage.getSession('s-dispose-workspace')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ disposed: true }),
      }),
    )
  })

  it('keeps an owned session retryable when workspace cleanup remains pending', async () => {
    const events: string[] = []
    const sandbox = new TrackingSandbox()
    const workspace = new InMemoryDurableWorkspace()
    let workspacePending = true
    trackAdministrationPurge(sandbox, events, 'sandbox')
    trackAdministrationPurge(workspace, events, 'workspace', () => {
      if (!workspacePending) return undefined
      workspacePending = false
      return { state: 'cleanup_pending', deletedResources: 0, remainingResources: 1, retryAfterMs: 1 }
    })
    const { harness, storage } = buildReleaseHarness(undefined, sandbox, undefined, workspace)
    const session = await harness.getSession('s-dispose-workspace-retry')
    await session.agents.echo.run('allocate')
    const owner = (await storage.getSession('s-dispose-workspace-retry'))!.sandboxBinding.owner
    await workspace.startWorkspace({
      sessionId: 's-dispose-workspace-retry',
      runId: 'workspace-run',
      sandboxOwner: owner,
      sandboxPolicyDigest: 'a'.repeat(64),
      attempt: 1,
      idempotencyKey: 'workspace-start',
    })

    await expect(session.disposeSandbox()).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'cleanup_pending' },
    })
    await expect(storage.getSession('s-dispose-workspace-retry')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ disposed: false }),
      }),
    )

    await expect(session.disposeSandbox()).resolves.toBeUndefined()
    expect(events).toEqual(['sandbox', 'workspace', 'sandbox', 'workspace'])
    await expect(storage.getSession('s-dispose-workspace-retry')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ disposed: true }),
      }),
    )
  })

  it('does not begin workspace cleanup until owned sandbox cleanup completes', async () => {
    const events: string[] = []
    const sandbox = new TrackingSandbox()
    const workspace = new InMemoryDurableWorkspace()
    trackAdministrationPurge(sandbox, events, 'sandbox', () => ({
      state: 'cleanup_pending',
      deletedResources: 0,
      remainingResources: 1,
      retryAfterMs: 1,
    }))
    trackAdministrationPurge(workspace, events, 'workspace')
    const { harness, storage } = buildReleaseHarness(undefined, sandbox, undefined, workspace)
    const session = await harness.getSession('s-dispose-sandbox-pending')
    await session.agents.echo.run('allocate')

    await expect(session.disposeSandbox()).rejects.toMatchObject({
      code: 'SANDBOX_ERROR',
      meta: { reason: 'cleanup_pending' },
    })

    expect(events).toEqual(['sandbox'])
    await expect(storage.getSession('s-dispose-sandbox-pending')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ disposed: false }),
      }),
    )
  })

  it('does not purge borrowed sandbox or workspace owners', async () => {
    const events: string[] = []
    const sandbox = new TrackingSandbox()
    const workspace = new InMemoryDurableWorkspace()
    trackAdministrationPurge(sandbox, events, 'sandbox')
    trackAdministrationPurge(workspace, events, 'workspace')
    const owner = { namespace: 'external', id: 'borrowed-owner', instanceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }
    await sandbox.registerOwner({ owner, mode: 'create' })
    const { harness, storage } = buildReleaseHarness(undefined, sandbox, undefined, workspace, {
      authorizeOwner: () => true,
    })
    const session = await harness.getSession('s-dispose-borrowed', { sandboxOwner: owner })
    await session.agents.echo.run('attach')
    await workspace.startWorkspace({
      sessionId: 's-dispose-borrowed',
      runId: 'workspace-run',
      sandboxOwner: owner,
      sandboxPolicyDigest: 'a'.repeat(64),
      attempt: 1,
      idempotencyKey: 'workspace-start',
    })

    await session.disposeSandbox()

    expect(events).toEqual([])
    await expect(storage.getSession('s-dispose-borrowed')).resolves.toEqual(
      expect.objectContaining({
        sandboxBinding: expect.objectContaining({ relation: 'borrowed', disposed: false }),
      }),
    )
  })

  it('replays a terminal workflow receipt after ephemeral compute is disposed', async () => {
    const { harness, sandbox } = buildReleaseHarness()
    const session = await harness.getSession('s-workflow-dispose-replay')
    await expect(
      session.workflows.echo_workflow.run('complete', { idempotencyKey: 'workflow-delivery-1' }),
    ).resolves.toMatchObject({ status: 'completed', output: 'complete' })
    const opensBeforeDispose = sandbox.openCalls

    await session.disposeSandbox()

    const reopened = await harness.getSession('s-workflow-dispose-replay')
    await expect(
      reopened.workflows.echo_workflow.run('complete', { idempotencyKey: 'workflow-delivery-1' }),
    ).resolves.toMatchObject({ status: 'completed', output: 'complete' })
    expect(sandbox.openCalls).toBe(opensBeforeDispose)
    await expect(
      reopened.workflows.echo_workflow.run('different', { idempotencyKey: 'workflow-delivery-1' }),
    ).rejects.toMatchObject({
      code: 'SANDBOX_STATE_LOST',
      meta: { reason: 'scope_terminated' },
    })
  })

  it('keeps destroy destructive for the active session generation', async () => {
    const { harness, storage, sandbox } = buildReleaseHarness()
    const session = await harness.getSession('s-destructive-destroy')
    await session.replaceHistory([{ role: 'user', content: 'remove me' }])
    await session.agents.echo.run('remove run')

    await session.destroy()

    expect(sandbox.closeCalls).toBe(1)
    expect(storage.closeSessionCalls).toBe(1)
    await expect(storage.getSession('s-destructive-destroy')).resolves.toBeUndefined()
    await expect(storage.listMessages('s-destructive-destroy')).resolves.toEqual([])
    await expect(storage.listRuns('s-destructive-destroy')).resolves.toEqual([])
  })

  it('cancels resident child tasks before releasing their owner session', async () => {
    const { harness, childStarted, sandbox } = buildReleaseHarness()
    const session = await harness.getSession('s-release-child')
    const taskId = completedOutput(await session.workflows.start_child.run('work'))
    await childStarted

    await session.release()

    await expect(session.childTasks.get(taskId)).resolves.toMatchObject({ id: taskId })
    await expect((await session.childTasks.get(taskId))?.status()).resolves.toMatchObject({ status: 'cancelled' })
    // The owner sandbox and the task's isolated sandbox are both released.
    expect(sandbox.closeCalls).toBe(2)
    expect(sandbox.terminatedScopes).toEqual([
      expect.objectContaining({ lifetime: 'run', runId: taskId, partition: { kind: 'shared' } }),
    ])
  })

  it('releases an explicitly inherited child attachment without terminating its parent partition', async () => {
    const { harness, childStarted, sandbox } = buildReleaseHarness(undefined, undefined, 'inherit')
    const session = await harness.getSession('s-release-child-inherit')
    const taskId = completedOutput(await session.workflows.start_child.run('work'))
    await childStarted

    await session.release()

    expect(sandbox.openedScopes).toEqual([
      expect.objectContaining({ lifetime: 'session', partition: { kind: 'shared' } }),
      expect.objectContaining({ lifetime: 'session', partition: { kind: 'shared' } }),
    ])
    expect(sandbox.terminatedScopes).toEqual([])
    await expect((await session.childTasks.get(taskId))?.status()).resolves.toMatchObject({ status: 'cancelled' })
  })

  it('emits the activated-skill count on agent spans', async () => {
    const { session, telemetry } = await runTelemetryFlowHarness()
    await session.workflows.wf.run('policy question')
    const agentSpan = telemetry.spans.find((span) => span.name.startsWith('invoke_agent'))
    expect(agentSpan).toBeDefined()
    // No skill was mounted/read in this flow; the attribute must still exist.
    expect(agentSpan?.attrs['harness.agent.skills_activated']).toBe(0)
  })
})
