import { expect, it } from 'vitest'
import { createDurableWorkflowContext, DurableStepError, inMemoryDurableRuntime } from '../src/index.js'

async function createContext() {
  const runtime = inMemoryDurableRuntime()
  const lease = await runtime.startRun({
    runId: 'run-step',
    sessionId: 'session-step',
    workerId: 'worker-step',
    stepId: 'initial',
    input: { prompt: 'hello' }
  })
  return { runtime, lease, ctx: createDurableWorkflowContext(runtime, lease) }
}

it('checkpoints explicit durable steps', async () => {
  const { runtime, ctx } = await createContext()

  const output = await ctx.step('prepare-inputs', async () => ({ ok: true }))
  const checkpoint = await runtime.loadCheckpoint('run-step')

  expect(output).toEqual({ ok: true })
  expect(checkpoint?.stepId).toBe('prepare-inputs')
  expect(checkpoint?.output).toEqual({ ok: true })
})

it('rejects duplicate and invalid durable step ids', async () => {
  const { ctx } = await createContext()

  await ctx.step('once', async () => 'ok')
  await expect(ctx.step('once', async () => 'again')).rejects.toBeInstanceOf(DurableStepError)
  await expect(ctx.step('bad step id', async () => 'bad')).rejects.toBeInstanceOf(DurableStepError)
})

it('rejects non-serializable durable step output deterministically', async () => {
  const { ctx } = await createContext()
  const circular: Record<string, unknown> = {}
  circular.self = circular

  await expect(ctx.step('circular', async () => circular as never)).rejects.toBeInstanceOf(DurableStepError)
})

it('replays committed steps on resume without re-running side effects', async () => {
  const runtime = inMemoryDurableRuntime()
  const start = { runId: 'run-replay', sessionId: 'session-replay', workerId: 'worker-replay', stepId: 'initial', input: { n: 1 } }

  // First attempt: run two steps, then "crash" (release the lease) after committing.
  const lease1 = await runtime.startRun(start)
  const ctx1 = createDurableWorkflowContext(runtime, lease1)
  let sideEffects = 0
  await ctx1.step('a', async () => { sideEffects += 1; return { a: true } })
  await ctx1.step('b', async () => { sideEffects += 1; return { b: 2 } })
  expect(sideEffects).toBe(2)
  await lease1.release()

  // Resume: a and b must replay from committed output; their fns must NOT run again.
  const lease2 = await runtime.startRun(start)
  expect(lease2.resumed).toBe(true)
  const ctx2 = createDurableWorkflowContext(runtime, lease2)
  const a = await ctx2.step('a', async () => { sideEffects += 1; return { a: false } })
  const b = await ctx2.step('b', async () => { sideEffects += 1; return { b: 99 } })
  const c = await ctx2.step('c', async () => { sideEffects += 1; return { c: 3 } })

  expect(a).toEqual({ a: true })   // replayed original output
  expect(b).toEqual({ b: 2 })      // replayed original output
  expect(c).toEqual({ c: 3 })      // newly executed
  expect(sideEffects).toBe(3)      // only step c ran on resume
})

it('retries transient durable step failures before committing a checkpoint', async () => {
  const { runtime, ctx } = await createContext()
  let attempts = 0

  const output = await ctx.step('retryable', async () => {
    attempts += 1
    if (attempts < 3) {
      throw new Error('temporary')
    }
    return { ok: true }
  }, { retry: { maxAttempts: 3, minDelayMs: 0 } })

  const checkpoint = await runtime.loadCheckpoint('run-step')
  expect(output).toEqual({ ok: true })
  expect(attempts).toBe(3)
  expect(checkpoint?.stepId).toBe('retryable')
  expect(checkpoint?.output).toEqual({ ok: true })
})
