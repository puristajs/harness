import { z } from 'zod'
import { expect, it } from 'vitest'
import { defineHarness, inMemorySandbox, InMemoryHarnessStorage, JsonLogger, StateError, type FinishRunPatch, type PersistedRunEvent, type SessionRecord } from '../../src/index.js'
import type { RunRecord } from '../../src/models/state.js'

class CreateRunFailingHarnessStorage extends InMemoryHarnessStorage {
  public readonly appendedEvents: PersistedRunEvent[] = []
  public readonly finishRunCalls: Array<{ runId: string; patch: FinishRunPatch }> = []

  public override async createRun(_record: RunRecord): Promise<void> {
    throw new StateError('createRun failed', { op: 'createRun', reason: 'injected_failure' })
  }

  public override async appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    this.appendedEvents.push(...events.map((event) => ({ ...event, runId })))
  }

  public override async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    this.finishRunCalls.push({ runId, patch })
  }
}

class FailureTerminalizationHarnessStorage extends InMemoryHarnessStorage {
  public constructor(private readonly failingOperation: 'finishRun' | 'upsertSession') {
    super()
  }

  public override async finishRun(runId: string, patch: FinishRunPatch): Promise<void> {
    if (this.failingOperation === 'finishRun') {
      throw new StateError('finishRun failed', { op: 'finishRun', reason: 'injected_failure' })
    }
    await super.finishRun(runId, patch)
  }

  public override async upsertSession(record: SessionRecord): Promise<void> {
    if (this.failingOperation === 'upsertSession' && record.runCount > 0) {
      throw new StateError('upsertSession failed', { op: 'upsertSession', reason: 'injected_failure' })
    }
    await super.upsertSession(record)
  }
}

it('does not emit or finish a run when createRun fails', async () => {
  const storage = new CreateRunFailingHarnessStorage()
  const harness = defineHarness()
    .storage(storage)
    .sandbox(inMemorySandbox())
    .models({
      fake: {
        provider: {
          id: 'fake',
          genAiSystem: 'fake',
          async object() {
            return { object: 'should not run', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop' }
          }
        },
        model: 'fake',
        capabilities: ['object']
      }
    })
    .agents({ assistant: { model: 'fake', instructions: 'Return text.', builtinTools: false } })
    .workflows({
      wf: {
        input: z.string(),
        output: z.string(),
        delegation: {},
        handler: async (ctx) => ctx.agents.assistant(ctx.input)
      }
    })
    .build()

  const session = await harness.getSession('s1')
  await expect(session.workflows.wf.prompt('hello')).rejects.toBeInstanceOf(StateError)
  expect(storage.appendedEvents).toEqual([])
  expect(storage.finishRunCalls).toEqual([])
})

it.each(['finishRun', 'upsertSession'] as const)(
  'preserves the original workflow/model failure when %s fails during failure terminalization',
  async (failingOperation) => {
    const storage = new FailureTerminalizationHarnessStorage(failingOperation)
    const primaryError = new Error('model failed first')
    const logs: string[] = []
    const harness = defineHarness()
      .logger(new JsonLogger({ level: 'error', out: { write: (chunk) => logs.push(chunk) } }))
      .storage(storage)
      .sandbox(inMemorySandbox())
      .models({
        fake: {
          provider: {
            id: 'fake',
            genAiSystem: 'fake',
            async object() {
              throw primaryError
            }
          },
          model: 'fake',
          capabilities: ['object']
        }
      })
      .agents({ assistant: { model: 'fake', instructions: 'Return text.', builtinTools: false } })
      .workflows({
        wf: {
          input: z.string(),
          output: z.string(),
          delegation: {},
          handler: async (ctx) => ctx.agents.assistant(ctx.input)
        }
      })
      .build()

    const session = await harness.getSession('s1')
    await expect(session.workflows.wf.prompt('hello')).rejects.toBe(primaryError)
    expect(logs.join('')).toContain('Failed to terminalize failed run; preserving primary run error.')
    expect(logs.join('')).toContain(failingOperation === 'finishRun' ? 'finish_run' : 'upsert_session')
  }
)
