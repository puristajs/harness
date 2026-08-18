import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InMemoryStateStore, OperationCancelledError, SessionBusyError, defineHarness, inMemorySandbox, type Sandbox, type SandboxSession } from '../src/index.js'
import { runTelemetryFlowHarness } from './telemetryFlowHarness.js'

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
    .agents({
      echo: {
        model: 'fake',
        input: z.string(),
        output: z.string(),
        handler: async (ctx) => ctx.input
      }
    })
    .workflows({
      hang: {
        input: z.string(),
        output: z.string(),
        handler: async () => {
          markHandlerStarted()
          return new Promise<never>(() => undefined)
        }
      }
    })
    .build()
  return { harness, handlerStarted }
}

class TrackingStateStore extends InMemoryStateStore {
  public closeSessionCalls = 0

  public override async closeSession(id: string): Promise<void> {
    this.closeSessionCalls += 1
    await super.closeSession(id)
  }
}

class TrackingSandbox implements Sandbox {
  public readonly capabilities = ['sandbox.fs', 'sandbox.exec'] as const
  public openCalls = 0
  public closeCalls = 0
  private readonly delegate = inMemorySandbox()

  public async open(opts: { sessionId: string; runId: string; signal?: AbortSignal }): Promise<SandboxSession> {
    this.openCalls += 1
    const session = await this.delegate.open(opts) as SandboxSession
    return new Proxy(session, {
      get: (target, property) => {
        if (property === 'close') {
          return async (): Promise<void> => {
            this.closeCalls += 1
            await target.close()
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
}

function buildReleaseHarness(state = new TrackingStateStore(), sandbox = new TrackingSandbox()) {
  let markChildStarted!: () => void
  const childStarted = new Promise<void>((resolve) => {
    markChildStarted = resolve
  })
  const harness = defineHarness()
    .state(state)
    .sandbox(sandbox)
    .models({ fake: { provider: { id: 'fake', genAiSystem: 'fake' }, model: 'fake', capabilities: [] } })
    .tools({})
    .skills({})
    .agents({
      echo: {
        model: 'fake', input: z.string(), output: z.string(), builtinTools: false,
        handler: async (ctx) => ctx.input
      },
      worker: {
        model: 'fake', input: z.string(), output: z.string(), builtinTools: false,
        handler: async (ctx) => {
          markChildStarted()
          await new Promise<never>((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(new OperationCancelledError('Child task cancelled.', { scope: 'run' })), { once: true })
          })
          return ctx.input
        }
      }
    })
    .workflows({
      start_child: {
        input: z.string(), output: z.string(), delegation: { agents: ['worker'] },
        handler: async (ctx) => (await ctx.childTasks.start('worker', ctx.input)).id
      }
    })
    .build()
  return { harness, state, sandbox, childStarted }
}

describe('session lifecycle guards', () => {
  it('rejects concurrent runs without leaking caller-signal abort listeners', async () => {
    const { harness, handlerStarted } = buildBusyHarness()
    const session = await harness.getSession('s-busy-listeners')
    const firstController = new AbortController()
    const first = session.workflows.hang.prompt('x', { signal: firstController.signal }).catch((error: unknown) => error)
    await handlerStarted

    const secondController = new AbortController()
    await expect(session.workflows.hang.prompt('y', { signal: secondController.signal })).rejects.toBeInstanceOf(SessionBusyError)
    // SessionBusyError is retriable: a rejected attempt must not leave a
    // run-timeout timer or an abort listener behind on the caller's signal.
    expect(getEventListeners(secondController.signal, 'abort')).toHaveLength(0)

    const agentController = new AbortController()
    await expect(session.agents.echo.prompt('y', { signal: agentController.signal })).rejects.toBeInstanceOf(SessionBusyError)
    expect(getEventListeners(agentController.signal, 'abort')).toHaveLength(0)

    firstController.abort()
    await expect(first).resolves.toBeInstanceOf(OperationCancelledError)
  })

  it('refuses to close a busy session', async () => {
    const { harness, handlerStarted } = buildBusyHarness()
    const session = await harness.getSession('s-busy-close')
    const controller = new AbortController()
    const run = session.workflows.hang.prompt('x', { signal: controller.signal }).catch((error: unknown) => error)
    await handlerStarted

    await expect(session.close()).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      meta: expect.objectContaining({ reason: 'concurrent_run' })
    })
    await expect(session.release()).rejects.toMatchObject({
      code: 'SESSION_BUSY',
      meta: expect.objectContaining({ reason: 'concurrent_run' })
    })

    controller.abort()
    await expect(run).resolves.toBeInstanceOf(OperationCancelledError)
    await expect(session.close()).resolves.toBeUndefined()
  })

  it('releases live resources without deleting persisted session, history, or runs', async () => {
    const { harness, state, sandbox } = buildReleaseHarness()
    const session = await harness.getSession('s-release')
    await session.replaceHistory([{ role: 'user', content: 'remember this' }])
    await expect(session.agents.echo.prompt('done')).resolves.toBe('done')

    await Promise.all([session.release(), session.release()])

    expect(sandbox.openCalls).toBe(1)
    expect(sandbox.closeCalls).toBe(1)
    expect(state.closeSessionCalls).toBe(0)
    await expect(state.getSession('s-release')).resolves.toEqual(expect.objectContaining({ id: 's-release', runCount: 1 }))
    await expect(session.history.list()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ content: 'remember this' })]))
    await expect(state.listRuns('s-release')).resolves.toHaveLength(1)

    const reopened = await harness.getSession('s-release')
    expect(sandbox.openCalls).toBe(2)
    await expect(reopened.agents.echo.prompt('again')).resolves.toBe('again')
    await reopened.release()
  })

  it('does not let a stale facade release or close a reopened session generation', async () => {
    const { harness, state, sandbox } = buildReleaseHarness()
    const original = await harness.getSession('s-stale-release')
    await original.release()

    const reopened = await harness.getSession('s-stale-release')
    await expect(reopened.agents.echo.prompt('still active')).resolves.toBe('still active')
    await original.close()

    expect(sandbox.closeCalls).toBe(1)
    await expect(state.getSession('s-stale-release')).resolves.toEqual(expect.objectContaining({ runCount: 1 }))
    await expect(reopened.agents.echo.prompt('still here')).resolves.toBe('still here')
    await reopened.release()
  })

  it('allows a released session generation to be destructively closed before it is reopened', async () => {
    const { harness, state } = buildReleaseHarness()
    const session = await harness.getSession('s-release-then-close')
    await session.agents.echo.prompt('remove after release')

    await session.release()
    await session.close()

    expect(state.closeSessionCalls).toBe(1)
    await expect(state.getSession('s-release-then-close')).resolves.toBeUndefined()
  })

  it('keeps close destructive for the active session generation', async () => {
    const { harness, state, sandbox } = buildReleaseHarness()
    const session = await harness.getSession('s-destructive-close')
    await session.replaceHistory([{ role: 'user', content: 'remove me' }])
    await session.agents.echo.prompt('remove run')

    await session.close()

    expect(sandbox.closeCalls).toBe(1)
    expect(state.closeSessionCalls).toBe(1)
    await expect(state.getSession('s-destructive-close')).resolves.toBeUndefined()
    await expect(state.listMessages('s-destructive-close')).resolves.toEqual([])
    await expect(state.listRuns('s-destructive-close')).resolves.toEqual([])
  })

  it('cancels resident child tasks before releasing their owner session', async () => {
    const { harness, childStarted, sandbox } = buildReleaseHarness()
    const session = await harness.getSession('s-release-child')
    const taskId = await session.workflows.start_child.prompt('work')
    await childStarted

    await session.release()

    await expect(session.childTasks.get(taskId)).resolves.toMatchObject({ id: taskId })
    await expect((await session.childTasks.get(taskId))?.status()).resolves.toMatchObject({ status: 'cancelled' })
    // The owner sandbox and the task's isolated sandbox are both released.
    expect(sandbox.closeCalls).toBe(2)
  })

  it('emits the activated-skill count on agent spans', async () => {
    const { session, telemetry } = await runTelemetryFlowHarness()
    await session.workflows.wf.prompt('policy question')
    const agentSpan = telemetry.spans.find((span) => span.name.startsWith('invoke_agent'))
    expect(agentSpan).toBeDefined()
    // No skill was mounted/read in this flow; the attribute must still exist.
    expect(agentSpan?.attrs['harness.agent.skills_activated']).toBe(0)
  })
})
