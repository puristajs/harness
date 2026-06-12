import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { OperationCancelledError, SessionBusyError, defineHarness, inMemorySandbox } from '../src/index.js'
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

    controller.abort()
    await expect(run).resolves.toBeInstanceOf(OperationCancelledError)
    await expect(session.close()).resolves.toBeUndefined()
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
