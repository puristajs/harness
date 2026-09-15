import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { DurableStepError, InMemoryHarnessStorage, OperationCancelledError } from '../src/index.js'
import { canonicalJson } from '../src/runtime/canonical-json.js'
import { createDurableWorkflowContext } from '../src/runtime/steps.js'

async function acquire(
  runtime: InMemoryHarnessStorage,
  runId: string,
  sessionId: string,
  workerId: string,
  mode: 'initial' | 'resume',
) {
  const run = await runtime.getRun(runId)
  if (!run || !['running', 'waiting', 'interrupted'].includes(run.status)) throw new Error('expected active durable run')
  const checkpoint = mode === 'resume' ? await runtime.loadCheckpoint(runId) : undefined
  const stepId = checkpoint?.stepId ?? 'initial'
  const sequence = checkpoint?.sequence ?? null
  const expected = { revision: run.revision, status: run.status as 'running' | 'waiting' | 'interrupted', checkpoint: { stepId, sequence } }
  const acquisitionId = `acq_${createHash('sha256').update(canonicalJson([
    'harness-run-acquisition-v1', mode, runId, sessionId, workerId, run.revision, run.status, stepId, sequence, null,
  ])).digest('hex')}`
  return runtime.acquireRun({ mode, runId, sessionId, workerId, acquisitionId, expected })
}

async function createContext(options: Parameters<typeof createDurableWorkflowContext>[2] = {}) {
  const runtime = new InMemoryHarnessStorage()
  await runtime.createRun({
    id: 'run-step',
    sessionId: 'session-step',
    kind: 'workflow',
    target: 'initial',
    startedAt: new Date().toISOString(),
    input: { prompt: 'hello' },
    validatedInput: { prompt: 'hello' },
  })
  const lease = await acquire(runtime, 'run-step', 'session-step', 'worker-step', 'initial')
  return { runtime, lease, ctx: createDurableWorkflowContext(runtime, lease, options) }
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
  const runtime = new InMemoryHarnessStorage()
  const start = {
    runId: 'run-replay',
    sessionId: 'session-replay',
    workerId: 'worker-replay',
    stepId: 'initial',
    input: { n: 1 },
  }
  await runtime.createRun({
    id: start.runId,
    sessionId: start.sessionId,
    kind: 'workflow',
    target: start.stepId,
    startedAt: new Date().toISOString(),
    input: start.input,
    validatedInput: start.input,
  })

  // First attempt: run two steps, then "crash" (release the lease) after committing.
  const lease1 = await acquire(runtime, start.runId, start.sessionId, start.workerId, 'initial')
  const ctx1 = createDurableWorkflowContext(runtime, lease1)
  let sideEffects = 0
  await ctx1.step('a', async () => {
    sideEffects += 1
    return { a: true }
  })
  await ctx1.step('b', async () => {
    sideEffects += 1
    return { b: 2 }
  })
  expect(sideEffects).toBe(2)
  await lease1.release()

  // Resume: a and b must replay from committed output; their fns must NOT run again.
  const lease2 = await acquire(runtime, start.runId, start.sessionId, start.workerId, 'resume')
  expect(lease2.resumed).toBe(true)
  const ctx2 = createDurableWorkflowContext(runtime, lease2)
  const a = await ctx2.step('a', async () => {
    sideEffects += 1
    return { a: false }
  })
  const b = await ctx2.step('b', async () => {
    sideEffects += 1
    return { b: 99 }
  })
  const c = await ctx2.step('c', async () => {
    sideEffects += 1
    return { c: 3 }
  })

  expect(a).toEqual({ a: true }) // replayed original output
  expect(b).toEqual({ b: 2 }) // replayed original output
  expect(c).toEqual({ c: 3 }) // newly executed
  expect(sideEffects).toBe(3) // only step c ran on resume
})

it('retries transient durable step failures before committing a checkpoint', async () => {
  const { runtime, ctx } = await createContext()
  let attempts = 0

  const output = await ctx.step(
    'retryable',
    async () => {
      attempts += 1
      if (attempts < 3) {
        throw new Error('temporary')
      }
      return { ok: true }
    },
    { retry: { maxAttempts: 3, minDelayMs: 0 } },
  )

  const checkpoint = await runtime.loadCheckpoint('run-step')
  expect(output).toEqual({ ok: true })
  expect(attempts).toBe(3)
  expect(checkpoint?.stepId).toBe('retryable')
  expect(checkpoint?.output).toEqual({ ok: true })
})

it('stops a retry backoff when the workflow is cancelled', async () => {
  const controller = new AbortController()
  const { ctx } = await createContext({ signal: controller.signal })
  let attempts = 0

  const result = ctx.step(
    'cancel-retry',
    async () => {
      attempts += 1
      throw new Error('temporary')
    },
    { retry: { maxAttempts: 3, minDelayMs: 10_000 } },
  )

  controller.abort('test cancellation')

  await expect(result).rejects.toBeInstanceOf(OperationCancelledError)
  expect(attempts).toBe(1)
})
