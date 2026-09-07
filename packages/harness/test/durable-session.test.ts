import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { z } from 'zod'

import { defineAgent } from '../src/definitions/agent.js'
import { defineHarness } from '../src/definitions/harness.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { InMemoryHarnessStorage } from '../src/storage/in-memory.js'
import { FakeModelProvider } from '../src/testing/fakeModelProvider.js'
import type { AcquireRunRequest } from '../src/storage/types.js'
import type { DurableRunLease } from '../src/storage/execution.js'
import { canonicalJson } from '../src/runtime/canonical-json.js'

function persistentStorage(): InMemoryHarnessStorage {
  const storage = new InMemoryHarnessStorage()
  const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
  Object.defineProperties(storage, {
    capabilities: { value: capabilities },
    info: { value: Object.freeze({ ...storage.info, capabilities }) },
  })
  return storage
}

function acquisitionId(request: Omit<AcquireRunRequest, 'acquisitionId'>): string {
	return `acq_${createHash('sha256').update(canonicalJson(['harness-run-acquisition-v1', request.mode, request.runId,
		request.sessionId, request.workerId, request.expected.revision, request.expected.status,
		request.expected.checkpoint.stepId, request.expected.checkpoint.sequence, request.requestedAttempt ?? null])).digest('hex')}`
}

describe('v4 durable session execution', () => {
  it('acquires before the workflow effect and finalizes output and terminal event atomically', async () => {
    const storage = persistentStorage()
    let observedStatus: string | undefined
    const workflow = defineWorkflow('transfer', {
      input: z.string(), output: z.string(), durable: true,
      async handler({ input }) {
        observedStatus = (await storage.getRun('transfer-run'))?.status
        return input
      },
    })
    const instance = await defineHarness({ name: 'durableSession', revision: 'release-1' }).addWorkflow(workflow).getInstance({ storage })
    const session = await instance.getSession('session-1')

    await expect(session.workflows.transfer.run('€10', { durable: { runId: 'transfer-run' } })).resolves.toEqual({
      status: 'completed', runId: 'transfer-run', output: '€10',
    })
    expect(observedStatus).toBe('running')
    expect(await storage.getRun('transfer-run')).toMatchObject({ status: 'succeeded', input: '€10', output: '€10', revision: 3 })
    expect((await storage.listEvents('transfer-run')).map(event => [event.sequence, event.type])).toEqual([[1, 'run.started'], [2, 'run.finished']])
    expect(await storage.loadCheckpoint('transfer-run')).toBeUndefined()

    await session.destroy()
    await instance.close()
  })

  it('returns the stored terminal outcome without rerunning a durable workflow', async () => {
    const storage = persistentStorage()
    let effects = 0
    const workflow = defineWorkflow('once', {
      input: z.string(), output: z.number(), durable: true,
      async handler() { effects += 1; return effects },
    })
    const instance = await defineHarness({ name: 'durableReplay', revision: 'release-1' }).addWorkflow(workflow).getInstance({ storage })
    const session = await instance.getSession('session-2')
    const invoke = { durable: { runId: 'once-run' } } as const

    await expect(session.workflows.once.run('same', invoke)).resolves.toMatchObject({ status: 'completed', output: 1 })
    await expect(session.workflows.once.run('same', invoke)).resolves.toMatchObject({ status: 'completed', output: 1 })
    expect(effects).toBe(1)

    await session.destroy()
    await instance.close()
  })

	it('reacquires an interrupted ordinary durable run with its stable caller run id', async () => {
		const storage = persistentStorage()
		const created = await storage.createRun({ id: 'recover-run', sessionId: 'recover-session', kind: 'workflow', target: 'recover',
			startedAt: '2026-09-05T00:00:00.000Z', input: 'same' })
		const request = { mode: 'initial' as const, runId: created.id, sessionId: created.sessionId, workerId: 'crashed-worker',
			expected: { revision: created.revision, status: 'running' as const, checkpoint: { stepId: 'harness:root:v1', sequence: null } } }
		const crashed = await storage.acquireRun({ ...request, acquisitionId: acquisitionId(request) })
		await crashed.release()
		await expect(storage.getRun(created.id)).resolves.toMatchObject({ status: 'interrupted', attempt: 1 })

		let effects = 0
		const workflow = defineWorkflow('recover', { input: z.string(), output: z.string(), durable: true,
			async handler({ input }) { effects += 1; return input } })
		const instance = await defineHarness({ name: 'ordinaryDurableRecovery', revision: 'v1' }).addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession(created.sessionId)
		await expect(session.workflows.recover.run('same', { durable: { runId: created.id } })).resolves.toEqual({
			status: 'completed', runId: created.id, output: 'same',
		})
		expect(effects).toBe(1)
		await expect(storage.getRun(created.id)).resolves.toMatchObject({ status: 'succeeded', attempt: 2, output: 'same' })
		await session.destroy()
		await instance.close()
	})

	it('releases a forged atomic acquisition snapshot before any workflow effect', async () => {
		class ForgedLeaseStorage extends InMemoryHarnessStorage {
			public releases = 0
			public override async acquireRun(request: AcquireRunRequest): Promise<DurableRunLease> {
				const lease = await super.acquireRun(request)
				return Object.freeze({ ...lease, acquisitionId: `acq_${'0'.repeat(64)}`, release: async () => {
					this.releases += 1
					await lease.release()
				} })
			}
		}
		const storage = new ForgedLeaseStorage()
		const capabilities = Object.freeze([...storage.capabilities, 'storage.persistent'] as const)
		Object.defineProperties(storage, { capabilities: { value: capabilities }, info: { value: Object.freeze({ ...storage.info, capabilities }) } })
		let effects = 0
		const workflow = defineWorkflow('snapshotFence', { input: z.string(), output: z.string(), durable: true,
			async handler({ input }) { effects += 1; return input } })
		const instance = await defineHarness({ name: 'snapshotFenceHarness', revision: 'v1' }).addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('snapshot-session')
		await expect(session.workflows.snapshotFence.run('value', { durable: { runId: 'snapshot-run' } })).rejects.toMatchObject({
			code: 'STATE_ERROR', meta: { op: 'acquireRun', reason: 'acquisition_conflict' },
		})
		expect(storage.releases).toBe(1)
		expect(effects).toBe(0)
		await expect(storage.getRun('snapshot-run')).resolves.toMatchObject({ status: 'interrupted' })
		await session.destroy()
		await instance.close()
	})

  it('rejects a changed canonical root input before another acquisition or effect', async () => {
    const storage = persistentStorage()
    let effects = 0
    const workflow = defineWorkflow('identity', {
      input: z.object({ value: z.string() }), output: z.string(), durable: true,
      async handler({ input }) { effects += 1; return input.value },
    })
    const instance = await defineHarness({ name: 'durableIdentity', revision: 'release-1' }).addWorkflow(workflow).getInstance({ storage })
    const session = await instance.getSession('session-3')
    const durable = { durable: { runId: 'identity-run' } } as const

    await session.workflows.identity.run({ value: 'first' }, durable)
    await expect(session.workflows.identity.run({ value: 'changed' }, durable)).rejects.toMatchObject({
      code: 'STATE_ERROR', meta: { op: 'createRun', reason: 'run_conflict' },
    })
    expect(effects).toBe(1)

    await session.destroy()
    await instance.close()
  })

  it('applies durable execution to agents with the same storage lifecycle', async () => {
    const storage = persistentStorage()
    const provider = new FakeModelProvider({ strict: true })
    provider.enqueueText({ content: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
    const agent = defineAgent('durableAgent', {
      input: z.string(), output: z.string(), durable: true, instructions: 'Answer.',
      prompt: input => ({ role: 'user', content: input }),
    })
    const instance = await defineHarness({ name: 'durableAgentHarness', revision: 'release-1' }).addAgent(agent)
      .getInstance({ model: { provider, model: 'fake' }, storage })
    const session = await instance.getSession('session-4')

    await expect(session.agents.durableAgent.run('hello', { durable: { runId: 'agent-run' } })).resolves.toEqual({
      status: 'completed', runId: 'agent-run', output: 'ok',
    })
    expect(await storage.getRun('agent-run')).toMatchObject({ kind: 'agent', status: 'succeeded', input: 'hello' })

    await session.destroy()
    await instance.close()
  })

  it('uses Harness-owned local resources for an ephemeral workflow', async () => {
    const workflow = defineWorkflow('defaultStorage', {
      input: z.string(), output: z.string(),
      async handler({ input }) { return input },
    })
    const instance = await defineHarness({ name: 'defaultStorageHarness' }).addWorkflow(workflow).getInstance({})
    const session = await instance.getSession('session-5')
    await expect(session.workflows.defaultStorage.run('ok')).resolves.toMatchObject({ status: 'completed', output: 'ok' })
    await session.destroy()
    await instance.close()
  })

  it('rejects durability when the target did not declare it', async () => {
    const workflow = defineWorkflow('ephemeral', {
      input: z.string(), output: z.string(), async handler({ input }) { return input },
    })
    const instance = await defineHarness({ name: 'ephemeral' }).addWorkflow(workflow).getInstance({})
    const session = await instance.getSession('session-6')
    await expect(session.workflows.ephemeral.run('no', { durable: { runId: 'invalid-run' } })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR', meta: { where: 'invoke_options', issues: { reason: 'target_not_durable' } },
    })
    await session.destroy()
    await instance.close()
  })
})
