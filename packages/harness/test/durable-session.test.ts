import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { z } from 'zod'

import { defineAgent } from '../src/definitions/agent.js'
import { defineHarness } from '../src/definitions/harness.js'
import { defineTool } from '../src/definitions/tool.js'
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
	it.each([false, true])('reconciles a failed terminal marker in one handler retry (persisted=%s)', async persisted => {
		const storage = persistentStorage()
		const sentinel = new Error(`marker ${persisted ? 'persisted' : 'absent'}`)
		let fail = true
		let effects = 0
		let caught: unknown
		const originalCommit = storage.commitCheckpoint.bind(storage)
		storage.commitCheckpoint = async checkpoint => {
			const output = checkpoint.output as { eventIndex?: number } | undefined
			const terminalMarker = fail && checkpoint.metadata?.['checkpointKind'] === 'workflow_call_publication' && output?.eventIndex === 2
			if (terminalMarker && !persisted) { fail = false; throw sentinel }
			await originalCommit(checkpoint)
			if (terminalMarker) { fail = false; throw sentinel }
		}
		const tool = defineTool('caughtMarkerTool', { description: 'Complete once.', input: z.string(), output: z.string(),
			async handler(_context, input) { effects += 1; return input } })
		const workflow = defineWorkflow('caughtMarkerWorkflow', { input: z.string(), output: z.string(), durable: true, tools: [tool],
			async handler({ input, tools }) {
				try { await tools.caughtMarkerTool.run(input, { callId: 'caught-call' }) } catch (error) { caught = error }
				return tools.caughtMarkerTool.run(input, { callId: 'caught-call' })
			} })
		const instance = await defineHarness({ name: persisted ? 'caughtMarkerAfter' : 'caughtMarkerBefore', revision: 'v1' })
			.addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('caught-marker-session')
		await expect(session.workflows.caughtMarkerWorkflow.run('value', { durable: { runId: 'caught-marker-run' } }))
			.resolves.toMatchObject({ status: 'completed', output: 'value' })
		expect(caught).toBe(sentinel)
		expect(effects).toBe(1)
		const events = await storage.listEvents('caught-marker-run')
		expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5])
		expect(events.filter(event => event.type === 'tool.finished')).toHaveLength(1)
		await session.destroy()
		await instance.close()
	})

	it.each([false, true])('reconciles uncertain run-start append (persisted=%s)', async persisted => {
		const storage = persistentStorage()
		const sentinel = new Error(`run start ${persisted ? 'persisted' : 'absent'}`)
		let fail = true
		const originalAppend = storage.appendEvents.bind(storage)
		storage.appendEvents = async (runId, events) => {
			const start = fail && events.some(event => event.type === 'run.started')
			if (start && !persisted) { fail = false; throw sentinel }
			await originalAppend(runId, events)
			if (start) { fail = false; throw sentinel }
		}
		let effects = 0
		const workflow = defineWorkflow('uncertainLifecycle', { input: z.string(), output: z.string(), durable: true,
			async handler({ input }) { effects += 1; return input } })
		const instance = await defineHarness({ name: persisted ? 'uncertainLifecycleAfter' : 'uncertainLifecycleBefore', revision: 'v1' })
			.addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('uncertain-lifecycle-session')
		const invoke = { durable: { runId: 'uncertain-lifecycle-run' } } as const
		if (persisted) {
			await expect(session.workflows.uncertainLifecycle.run('value', invoke)).resolves.toMatchObject({ status: 'completed', output: 'value' })
		} else {
			await expect(session.workflows.uncertainLifecycle.run('value', invoke)).rejects.toBe(sentinel)
			await expect(session.workflows.uncertainLifecycle.run('value', invoke)).resolves.toMatchObject({ status: 'completed', output: 'value' })
		}
		expect(effects).toBe(1)
		expect((await storage.listEvents(invoke.durable.runId)).map(event => event.sequence)).toEqual([1, 2])
		await session.destroy()
		await instance.close()
	})

	it.each([false, true])('reconciles a fanout start append without publishing an unmatched terminal (persisted=%s)', async persisted => {
		const storage = persistentStorage()
		const sentinel = new Error(`fanout start ${persisted ? 'persisted' : 'absent'}`)
		let fail = true
		let workers = 0
		const originalAppend = storage.appendEvents.bind(storage)
		storage.appendEvents = async (runId, events) => {
			const start = fail && events.some(event => event.type === 'fanout.started')
			if (start && !persisted) { fail = false; throw sentinel }
			await originalAppend(runId, events)
			if (start) { fail = false; throw sentinel }
		}
		const workflow = defineWorkflow('recoverableFanout', { input: z.string(), output: z.string(), durable: true,
			async handler({ input, fanOut }) {
				const result = await fanOut([input, input], async value => { workers += 1; return value }, { concurrency: 2 })
				return result.join(':')
			} })
		const instance = await defineHarness({ name: persisted ? 'recoverableFanoutAfter' : 'recoverableFanoutBefore', revision: 'v1' })
			.addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('recoverable-fanout-session')
		const invoke = { durable: { runId: 'recoverable-fanout-run' } } as const
		if (!persisted) {
			await expect(session.workflows.recoverableFanout.run('value', invoke)).rejects.toBe(sentinel)
			expect((await storage.listEvents(invoke.durable.runId)).map(event => event.type)).toEqual(['run.started'])
		}
		await expect(session.workflows.recoverableFanout.run('value', invoke)).resolves.toMatchObject({
			status: 'completed', output: 'value:value',
		})
		expect(workers).toBe(2)
		const events = await storage.listEvents(invoke.durable.runId)
		expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4])
		expect(events.filter(event => event.type === 'fanout.started')).toHaveLength(1)
		expect(events.filter(event => event.type === 'fanout.finished')).toHaveLength(1)
		await session.destroy()
		await instance.close()
	})

	it.each([false, true])('reconciles a nested agent run-start append without committing a parent failure (persisted=%s)', async persisted => {
		const storage = persistentStorage()
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: 'child output', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		const sentinel = new Error(`child start ${persisted ? 'persisted' : 'absent'}`)
		const parentRunId = 'recoverable-child-parent-run'
		let fail = true
		const originalAppend = storage.appendEvents.bind(storage)
		storage.appendEvents = async (runId, events) => {
			const childStart = fail && runId !== parentRunId && events.some(event => event.type === 'run.started')
			if (childStart && !persisted) { fail = false; throw sentinel }
			await originalAppend(runId, events)
			if (childStart) { fail = false; throw sentinel }
		}
		const child = defineAgent('recoverableChild', { input: z.string(), output: z.string(), durable: true,
			instructions: 'Return the answer.', prompt: input => ({ role: 'user', content: input }) })
		const workflow = defineWorkflow('recoverableChildParent', { input: z.string(), output: z.string(), durable: true, agents: [child],
			async handler({ input, agents }) { return agents.recoverableChild.run(input, { callId: 'child-call' }) } })
		const instance = await defineHarness({ name: persisted ? 'recoverableChildAfter' : 'recoverableChildBefore', revision: 'v1' })
			.addAgent(child).addWorkflow(workflow).getInstance({ model: { provider, model: 'fake' }, storage })
		const session = await instance.getSession('recoverable-child-session')
		const invoke = { durable: { runId: parentRunId } } as const
		if (!persisted) {
			await expect(session.workflows.recoverableChildParent.run('value', invoke)).rejects.toBe(sentinel)
			await expect(storage.getRun(parentRunId)).resolves.toMatchObject({ status: 'interrupted' })
		}
		await expect(session.workflows.recoverableChildParent.run('value', invoke))
			.resolves.toMatchObject({ status: 'completed', output: 'child output' })
		expect(provider.requests).toHaveLength(1)
		expect((await storage.listEvents(parentRunId)).map(event => event.sequence)).toEqual([1, 2])
		await session.destroy()
		await instance.close()
	})

	it.each([false, true])('reconciles a child-task start append around one effect (persisted=%s)', async persisted => {
			const eventType = 'child_task.started' as const
			const storage = persistentStorage()
			const provider = new FakeModelProvider({ strict: true })
			provider.enqueueText({ content: 'task output', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
			const sentinel = new Error(`${eventType} ${persisted ? 'persisted' : 'absent'}`)
			let fail = true
			const originalAppend = storage.appendEvents.bind(storage)
			storage.appendEvents = async (runId, events) => {
				const target = fail && events.some(event => event.type === eventType)
				if (target && !persisted) { fail = false; throw sentinel }
				await originalAppend(runId, events)
				if (target) { fail = false; throw sentinel }
			}
			const child = defineAgent('recoverableTaskChild', { input: z.string(), output: z.string(), durable: true,
				instructions: 'Return the answer.', prompt: input => ({ role: 'user', content: input }) })
			let caught: unknown
			const workflow = defineWorkflow('recoverableTaskParent', { input: z.string(), output: z.string(), durable: true, agents: [child],
				async handler({ input, childTasks }) {
					let task
					try { task = await childTasks.start('recoverableTaskChild', input, { callId: 'task-call', idempotencyKey: 'task-key' }) }
					catch (error) {
						caught = error
						task = await childTasks.start('recoverableTaskChild', input, { callId: 'task-call', idempotencyKey: 'task-key' })
					}
					return task.result()
				} })
			const instance = await defineHarness({ name: persisted ? 'recoverableTaskStartAfter' : 'recoverableTaskStartBefore', revision: 'v1' })
				.addAgent(child).addWorkflow(workflow).getInstance({ model: { provider, model: 'fake' }, storage })
			const session = await instance.getSession('recoverable-task-session')
			const invoke = { durable: { runId: `recoverable-task-${eventType}-${persisted}` } } as const
			await expect(session.workflows.recoverableTaskParent.run('value', invoke))
				.resolves.toMatchObject({ status: 'completed', output: 'task output' })
			expect(caught).toBe(persisted ? undefined : sentinel)
			expect(provider.requests).toHaveLength(1)
			const events = await storage.listEvents(invoke.durable.runId)
			expect(events.filter(event => event.type === 'child_task.started')).toHaveLength(1)
			expect(events.filter(event => event.type === 'child_task.settled')).toHaveLength(1)
			expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))
			await session.destroy()
			await instance.close()
		})

	it('replays a durable child settlement publication before completing the parent', async () => {
		const storage = persistentStorage()
		const provider = new FakeModelProvider({ strict: true })
		provider.enqueueText({ content: 'settled output', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, finishReason: 'stop' })
		const sentinel = new Error('child settlement publication failed')
		let fail = true
		const originalAppend = storage.appendEvents.bind(storage)
		storage.appendEvents = async (runId, events) => {
			if (fail && events.some(event => event.type === 'child_task.settled')) { fail = false; throw sentinel }
			return originalAppend(runId, events)
		}
		const child = defineAgent('settlementReplayChild', { input: z.string(), output: z.string(), durable: true,
			instructions: 'Return the answer.', prompt: input => ({ role: 'user', content: input }) })
		const workflow = defineWorkflow('settlementReplayParent', { input: z.string(), output: z.string(), durable: true, agents: [child],
			async handler({ input, childTasks }) {
				const task = await childTasks.start('settlementReplayChild', input, { callId: 'settle-call', idempotencyKey: 'settle-key' })
				return task.result()
			} })
		const instance = await defineHarness({ name: 'settlementReplayHarness', revision: 'v1' })
			.addAgent(child).addWorkflow(workflow).getInstance({ model: { provider, model: 'fake' }, storage })
		const session = await instance.getSession('settlement-replay-session')
		const invoke = { durable: { runId: 'settlement-replay-run' } } as const
		await expect(session.workflows.settlementReplayParent.run('value', invoke)).rejects.toBe(sentinel)
		const childRecord = (await storage.listRuns('settlement-replay-session')).find(record => record.kind === 'child_task')
		expect(childRecord).toMatchObject({ status: 'succeeded', output: 'settled output' })
		await expect(storage.getRun(invoke.durable.runId)).resolves.toMatchObject({ status: 'interrupted' })
		expect((await storage.listEvents(invoke.durable.runId)).filter(event => event.type === 'child_task.settled')).toHaveLength(0)
		await expect(session.workflows.settlementReplayParent.run('value', invoke))
			.resolves.toMatchObject({ status: 'completed', output: 'settled output' })
		expect(provider.requests).toHaveLength(1)
		const events = await storage.listEvents(invoke.durable.runId)
		expect(events.filter(event => event.type === 'child_task.started')).toHaveLength(1)
		expect(events.filter(event => event.type === 'child_task.settled')).toHaveLength(1)
		expect(events.filter(event => event.type === 'run.finished')).toHaveLength(1)
		expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))
		await session.destroy()
		await instance.close()
	})

	it.each([false, true])('poisons an inconclusive non-managed append until fresh acquisition (persisted=%s)', async persisted => {
		const storage = persistentStorage()
		const sentinel = new Error(`inconclusive fanout ${persisted ? 'persisted' : 'absent'}`)
		const readback = new Error('fanout reconciliation read failed')
		let failAppend = true
		let failReadback = false
		let allocatedEventId: string | undefined
		let workers = 0
		let firstCaught: unknown
		let fencedCaught: unknown
		const originalAppend = storage.appendEvents.bind(storage)
		const originalList = storage.listEvents.bind(storage)
		storage.appendEvents = async (runId, events) => {
			const target = failAppend ? events.find(event => event.type === 'fanout.started') : undefined
			if (target !== undefined) {
				failAppend = false
				failReadback = true
				allocatedEventId = target.id
				if (persisted) await originalAppend(runId, events)
				throw sentinel
			}
			return originalAppend(runId, events)
		}
		storage.listEvents = async runId => {
			if (failReadback) { failReadback = false; throw readback }
			return originalList(runId)
		}
		const workflow = defineWorkflow('poisonedFanout', { input: z.string(), output: z.string(), durable: true,
			async handler({ input, fanOut }) {
				try { await fanOut([input], async value => { workers += 1; return value }) } catch (error) { firstCaught = error }
				try { await fanOut([input], async value => { workers += 1; return value }) } catch (error) { fencedCaught = error }
				return input
			} })
		const instance = await defineHarness({ name: persisted ? 'poisonedFanoutAfter' : 'poisonedFanoutBefore', revision: 'v1' })
			.addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('poisoned-fanout-session')
		const invoke = { durable: { runId: 'poisoned-fanout-run' } } as const
		await expect(session.workflows.poisonedFanout.run('value', invoke)).rejects.toBe(sentinel)
		expect(firstCaught).toBe(sentinel)
		expect(fencedCaught).toBe(sentinel)
		expect(workers).toBe(0)
		await expect(storage.getRun(invoke.durable.runId)).resolves.toMatchObject({ status: 'interrupted' })
		expect((await originalList(invoke.durable.runId)).some(event => event.type === 'run.finished')).toBe(false)
		firstCaught = undefined
		fencedCaught = undefined
		await expect(session.workflows.poisonedFanout.run('value', invoke)).resolves.toMatchObject({ status: 'completed', output: 'value' })
		expect(workers).toBe(2)
		const events = await originalList(invoke.durable.runId)
		const starts = events.filter(event => event.type === 'fanout.started')
		expect(starts).toHaveLength(2)
		expect(starts[0]?.id).toBe(allocatedEventId)
		expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))
		await session.destroy()
		await instance.close()
	})

	it.each([false, true])('poisons an inconclusive managed marker until fresh acquisition (persisted=%s)', async persisted => {
		const storage = persistentStorage()
		const sentinel = new Error(`inconclusive marker ${persisted ? 'persisted' : 'absent'}`)
		const readback = new Error('marker reconciliation read failed')
		let failMarker = true
		let failReadback = false
		let allocatedEventId: string | undefined
		let effects = 0
		let firstCaught: unknown
		let fencedCaught: unknown
		const originalCommit = storage.commitCheckpoint.bind(storage)
		const originalLoad = storage.loadCheckpoint.bind(storage)
		storage.commitCheckpoint = async checkpoint => {
			if (failMarker && checkpoint.metadata?.['checkpointKind'] === 'workflow_call_publication') {
				failMarker = false
				failReadback = true
				const output = checkpoint.output
				if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
					const allocation = output['allocation']
					if (typeof allocation === 'object' && allocation !== null && !Array.isArray(allocation)) {
						const event = allocation['event']
						if (typeof event === 'object' && event !== null && !Array.isArray(event) && typeof event['eventId'] === 'string') allocatedEventId = event['eventId']
					}
				}
				if (persisted) await originalCommit(checkpoint)
				throw sentinel
			}
			return originalCommit(checkpoint)
		}
		storage.loadCheckpoint = async (runId, stepId) => {
			if (failReadback && stepId.startsWith('workflow:publication:')) { failReadback = false; throw readback }
			return originalLoad(runId, stepId)
		}
		const tool = defineTool('poisonedMarkerTool', { description: 'Complete once.', input: z.string(), output: z.string(),
			async handler(_context, input) { effects += 1; return input } })
		const workflow = defineWorkflow('poisonedMarker', { input: z.string(), output: z.string(), durable: true, tools: [tool],
			async handler({ input, tools, fanOut }) {
				try { return await tools.poisonedMarkerTool.run(input, { callId: 'marker-call' }) }
				catch (error) { firstCaught = error }
				try { await fanOut([input], async value => value) } catch (error) { fencedCaught = error }
				return input
			} })
		const instance = await defineHarness({ name: persisted ? 'poisonedMarkerAfter' : 'poisonedMarkerBefore', revision: 'v1' })
			.addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('poisoned-marker-session')
		const invoke = { durable: { runId: 'poisoned-marker-run' } } as const
		await expect(session.workflows.poisonedMarker.run('value', invoke)).rejects.toBe(sentinel)
		expect(firstCaught).toBe(sentinel)
		expect(fencedCaught).toBe(sentinel)
		expect(effects).toBe(0)
		await expect(storage.getRun(invoke.durable.runId)).resolves.toMatchObject({ status: 'interrupted' })
		expect((await storage.listEvents(invoke.durable.runId)).some(event => event.type === 'run.finished')).toBe(false)
		firstCaught = undefined
		fencedCaught = undefined
		await expect(session.workflows.poisonedMarker.run('value', invoke)).resolves.toMatchObject({ status: 'completed', output: 'value' })
		expect(effects).toBe(1)
		const events = await storage.listEvents(invoke.durable.runId)
		expect(events.find(event => event.sequence === 2)?.id).toBe(allocatedEventId)
		expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))
		await session.destroy()
		await instance.close()
	})

	it.each([
		{ boundary: 'marker' as const, persisted: false }, { boundary: 'marker' as const, persisted: true },
		{ boundary: 'append' as const, persisted: false }, { boundary: 'append' as const, persisted: true },
		{ boundary: 'ack' as const, persisted: false }, { boundary: 'ack' as const, persisted: true },
	])(
		'recovers an instantiated workflow after a $boundary publication failure (persisted=$persisted) without repeating its effect',
		async ({ boundary, persisted }) => {
			const storage = persistentStorage()
			const sentinel = new Error(`${boundary} storage failed${persisted ? ' after persistence' : ''}`)
			let fail = true
			let effects = 0
			let terminalEventId: string | undefined
			let terminalSequence: number | undefined
			const originalCommit = storage.commitCheckpoint.bind(storage)
			storage.commitCheckpoint = async checkpoint => {
				const output = checkpoint.output as { eventIndex?: number; allocation?: { event?: { eventId?: string; sequence?: number } }; eventId?: string } | undefined
				const terminalPublication = output?.eventIndex === 2
				if (terminalPublication && checkpoint.metadata?.['checkpointKind'] === 'workflow_call_publication') {
					terminalEventId = output.allocation?.event?.eventId
					terminalSequence = output.allocation?.event?.sequence
				}
				const failsHere = fail && terminalPublication
					&& checkpoint.metadata?.['checkpointKind'] === `workflow_call_publication${boundary === 'ack' ? '_ack' : ''}`
					&& boundary !== 'append'
				if (failsHere && !persisted) { fail = false; throw sentinel }
				await originalCommit(checkpoint)
				if (failsHere && persisted) {
					fail = false
					throw sentinel
				}
			}
			const originalAppend = storage.appendEvents.bind(storage)
			storage.appendEvents = async (runId, events) => {
				const failsHere = fail && boundary === 'append' && events.some(event => event.type === 'tool.finished')
				if (failsHere && !persisted) { fail = false; throw sentinel }
				await originalAppend(runId, events)
				if (failsHere && persisted) {
					fail = false
					throw sentinel
				}
			}
			const tool = defineTool('recoverableTool', {
				description: 'Complete one recoverable effect.', input: z.string(), output: z.string(),
				async handler(_context, input) { effects += 1; return input },
			})
			const workflow = defineWorkflow('recoverableWorkflow', {
				input: z.string(), output: z.string(), durable: true, tools: [tool],
				async handler({ input, tools }) { return tools.recoverableTool.run(input, { callId: 'stable-call' }) },
			})
			const suffix = `${boundary}-${persisted ? 'after' : 'before'}`
			const harnessName = `recoverable${boundary[0]!.toUpperCase()}${boundary.slice(1)}${persisted ? 'After' : 'Before'}`
			const instance = await defineHarness({ name: harnessName, revision: 'v1' }).addWorkflow(workflow).getInstance({ storage })
			const session = await instance.getSession(`recoverable-${suffix}`)
			const invoke = { durable: { runId: `recoverable-${suffix}-run` } } as const
			const firstLive: string[] = []
			const first = async () => {
				for await (const event of session.workflows.recoverableWorkflow.stream('value', invoke)) firstLive.push(event.type)
			}
			await expect(first()).rejects.toBe(sentinel)
			expect(effects).toBe(1)
			expect(await storage.getRun(invoke.durable.runId)).toMatchObject({ status: 'interrupted' })
			expect(await storage.loadCheckpoint(invoke.durable.runId, 'workflow:call:stable-call')).toMatchObject({
				output: { kind: 'workflow_call', callId: 'stable-call', outcome: { status: 'completed', output: 'value' } },
			})
			expect((await storage.listEvents(invoke.durable.runId)).filter(event => event.type === 'run.finished')).toHaveLength(0)
			expect(firstLive.filter(type => type === 'run.started')).toHaveLength(1)
			expect(firstLive.filter(type => type === 'tool.input.available')).toHaveLength(1)
			expect(firstLive.filter(type => type === 'tool.started')).toHaveLength(1)
			expect(firstLive.filter(type => type === 'tool.finished')).toHaveLength(0)
			expect(terminalEventId).toMatch(/^event_/)
			expect(terminalSequence).toBe(4)

			const recoveredLive: string[] = []
			for await (const event of session.workflows.recoverableWorkflow.stream('value', invoke)) recoveredLive.push(event.type)
			expect(effects).toBe(1)
			for (const type of ['run.started', 'tool.input.available', 'tool.started', 'tool.finished', 'run.finished']) {
				expect(recoveredLive.filter(candidate => candidate === type), type).toHaveLength(1)
			}
			const durableEvents = await storage.listEvents(invoke.durable.runId)
			expect(durableEvents.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5])
			for (const type of ['run.started', 'tool.input.available', 'tool.started', 'tool.finished', 'run.finished']) {
				expect(durableEvents.filter(event => event.type === type), type).toHaveLength(1)
			}
			expect(durableEvents.find(event => event.type === 'tool.finished')).toMatchObject({ id: terminalEventId, sequence: terminalSequence })
			expect(await storage.getRun(invoke.durable.runId)).toMatchObject({ status: 'succeeded', output: 'value' })
			expect(await storage.loadCheckpoint(invoke.durable.runId)).toBeUndefined()
			await session.destroy()
			await instance.close()
		},
	)

	it('reconstructs an acquired running workflow from its durable maximum sequence without a second start', async () => {
		const storage = persistentStorage()
		const runId = 'already-running-run'
		await storage.createRun({ id: runId, sessionId: 'already-running-session', kind: 'workflow', target: 'alreadyRunning',
			startedAt: '2026-09-08T00:00:00.000Z', input: 'value' })
		const startId = `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', runId, 1, 'run.started'])).digest('hex')}`
		await storage.appendEvents(runId, [{ id: startId, sequence: 1, runId,
			at: '2026-09-08T00:00:00.000Z', type: 'run.started', payload: {} }])
		let effects = 0
		const workflow = defineWorkflow('alreadyRunning', { input: z.string(), output: z.string(), durable: true,
			async handler({ input }) { effects += 1; return input } })
		const instance = await defineHarness({ name: 'alreadyRunningHarness', revision: 'v1' }).addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('already-running-session')
		const live: string[] = []
		for await (const event of session.workflows.alreadyRunning.stream('value', { durable: { runId } })) live.push(event.type)
		expect(effects).toBe(1)
		expect(live).toEqual(['run.started', 'run.finished'])
		expect((await storage.listEvents(runId)).map(event => [event.sequence, event.type])).toEqual([
			[1, 'run.started'], [2, 'run.finished'],
		])
		await session.destroy()
		await instance.close()
	})

	it('serializes concurrent managed publications and terminal finalization through one run sequence', async () => {
		const storage = persistentStorage()
		const first = defineTool('firstConcurrentTool', { description: 'First.', input: z.string(), output: z.string(),
			async handler(_context, input) { await Promise.resolve(); return input } })
		const second = defineTool('secondConcurrentTool', { description: 'Second.', input: z.string(), output: z.string(),
			async handler(_context, input) { await Promise.resolve(); return input } })
		const workflow = defineWorkflow('concurrentPublications', {
			input: z.string(), output: z.string(), durable: true, tools: [first, second],
			async handler({ input, tools }) {
				const values = await Promise.all([
					tools.firstConcurrentTool.run(input, { callId: 'first-call' }),
					tools.secondConcurrentTool.run(input, { callId: 'second-call' }),
				])
				return values.join(':')
			},
		})
		const instance = await defineHarness({ name: 'concurrentPublicationHarness', revision: 'v1' }).addWorkflow(workflow).getInstance({ storage })
		const session = await instance.getSession('concurrent-publication-session')
		await expect(session.workflows.concurrentPublications.run('value', { durable: { runId: 'concurrent-publication-run' } }))
			.resolves.toMatchObject({ status: 'completed', output: 'value:value' })
		const events = await storage.listEvents('concurrent-publication-run')
		expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))
		expect(new Set(events.map(event => event.id))).toHaveLength(events.length)
		expect(events.filter(event => event.type === 'tool.input.available')).toHaveLength(2)
		expect(events.filter(event => event.type === 'tool.started')).toHaveLength(2)
		expect(events.filter(event => event.type === 'tool.finished')).toHaveLength(2)
		expect(events.at(-1)?.type).toBe('run.finished')
		await session.destroy()
		await instance.close()
	})

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
