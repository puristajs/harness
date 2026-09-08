import { describe, expect, it } from 'vitest'
import { HarnessConfigError, InternalError, OperationCancelledError } from '../src/errors/index.js'
import { defineHarness as defineV4Harness } from '../src/definitions/harness.js'
import { defineAgent as defineV4Agent } from '../src/definitions/agent.js'
import { defineWorkflow } from '../src/definitions/workflow.js'
import { defineTool } from '../src/definitions/tool.js'
import type { ExecutionTerminalOutcome } from '../src/definitions/execution-events.js'
import { EventQueue } from '../src/runtime/standalone-instance.js'
import { z } from 'zod'

describe('portable execution contract', () => {
	it.each([
		{ status: 'completed', runId: 'queue-run', output: 'done' },
		{ status: 'interrupted', runId: 'queue-run', interrupt: { type: 'external-wait', runId: 'queue-run', interruptId: 'wait-1', revision: 'revision-1', eventId: 'event-1', id: 'wait-1', kind: 'review', schemaVersion: 'v1', definitionVersion: 'v1', deadline: '2030-01-01T00:00:00.000Z' } },
		{ status: 'failed', runId: 'queue-run', error: { name: 'Error', message: 'failed' } },
		{ status: 'cancelled', runId: 'queue-run', error: { name: 'Error', message: 'cancelled' } },
	] satisfies readonly ExecutionTerminalOutcome<string, { type: 'external-wait'; runId: string; interruptId: string; revision: string; eventId: string; id: string; kind: string; schemaVersion: string; definitionVersion: string; deadline: string }>[])('settles a captured $status terminal only when its producer ends', async outcome => {
		const queue = new EventQueue<string>('queue-run', () => undefined)
		queue.push({ type: 'run.finished', eventId: 'terminal-1', sequence: 1, runId: 'queue-run', at: '2026-01-01T00:00:00.000Z', outcome })
		let settled = false
		void queue.result.finally(() => { settled = true })
		await Promise.resolve()
		expect(settled).toBe(false)

		queue.end()
		await expect(queue.result).resolves.toBe(outcome)
	})

	it('rejects a captured terminal when producer finalization fails afterward', async () => {
		const queue = new EventQueue<string>('queue-run', () => undefined)
		const infrastructureFailure = new Error('terminal acknowledgement failed')
		queue.push({
			type: 'run.finished', eventId: 'terminal-1', sequence: 1, runId: 'queue-run', at: '2026-01-01T00:00:00.000Z',
			outcome: { status: 'completed', runId: 'queue-run', output: 'done' },
		})
		queue.fail(infrastructureFailure)

		await expect(queue.result).rejects.toBe(infrastructureFailure)
		queue.end()
		await expect(queue.result).rejects.toBe(infrastructureFailure)
	})

	it('rejects missing and duplicate terminals through both result and iteration', async () => {
		const missing = new EventQueue<string>('missing-run', () => undefined)
		missing.end()
		await expect(missing.result).rejects.toBeInstanceOf(InternalError)
		await expect((async () => { for await (const _event of missing) { /* no events */ } })())
			.rejects.toBeInstanceOf(InternalError)

		const duplicate = new EventQueue<string>('duplicate-run', () => undefined)
		const terminal = {
			type: 'run.finished' as const, eventId: 'terminal-1', sequence: 1, runId: 'duplicate-run', at: '2026-01-01T00:00:00.000Z',
			outcome: { status: 'completed' as const, runId: 'duplicate-run', output: 'done' },
		}
		duplicate.push(terminal)
		duplicate.push({ ...terminal, eventId: 'terminal-2', sequence: 2 })
		await expect(duplicate.result).rejects.toBeInstanceOf(InternalError)
		await expect((async () => { for await (const _event of duplicate) { /* drain first terminal */ } })())
			.rejects.toBeInstanceOf(InternalError)
	})

	it('keeps metadata-only operational failure and cancellation separate from producer failure', async () => {
		const operational = new EventQueue<string>('operational-run', () => undefined)
		const operationalFailure = new Error('private operational failure')
		operational.setFailure(operationalFailure)
		operational.push({
			type: 'run.finished', eventId: 'terminal-1', sequence: 1, runId: 'operational-run', at: '2026-01-01T00:00:00.000Z',
			outcome: { status: 'failed', runId: 'operational-run', error: { name: 'Error', message: 'failed' } },
		})
		operational.end()
		await expect(operational.result).resolves.toMatchObject({ status: 'failed' })
		expect(operational.failure).toBe(operationalFailure)

		let cancelReason: string | undefined
		const cancelled = new EventQueue<string>('cancel-run', reason => { cancelReason = reason })
		const cancellation = cancelled.cancel('stop')
		let settled = false
		void cancelled.result.finally(() => { settled = true })
		await cancellation
		await Promise.resolve()
		expect(cancelReason).toBe('stop')
		expect(settled).toBe(false)
		cancelled.push({
			type: 'run.finished', eventId: 'terminal-1', sequence: 1, runId: 'cancel-run', at: '2026-01-01T00:00:00.000Z',
			outcome: { status: 'cancelled', runId: 'cancel-run', error: { name: 'Error', message: 'cancelled' } },
		})
		cancelled.end()
		await expect(cancelled.result).resolves.toMatchObject({ status: 'cancelled' })
	})

	it('honors the first producer finalizer', async () => {
		const completed = new EventQueue<string>('first-run', () => undefined)
		completed.push({
			type: 'run.finished', eventId: 'terminal-1', sequence: 1, runId: 'first-run', at: '2026-01-01T00:00:00.000Z',
			outcome: { status: 'completed', runId: 'first-run', output: 'done' },
		})
		completed.end()
		completed.fail(new Error('too late'))
		await expect(completed.result).resolves.toMatchObject({ status: 'completed' })
	})

	it('resolves one frozen v4 defaults snapshot and preserves it through composition', () => {
		const definition = defineV4Harness({ name: 'defaultsHarness', defaults: { maxSteps: 4, historyWindow: 0 } })
		const next = definition.addAgent(defineV4Agent('answerAgent', { instructions: 'Answer.' }))
		expect(definition.defaults).toMatchObject({ maxSteps: 4, historyWindow: 0, maxToolCalls: 32 })
		expect(Object.isFrozen(definition.defaults)).toBe(true)
		expect(next.defaults).toBe(definition.defaults)
		expect(() => defineV4Harness({ name: 'badDefaults', defaults: { maxSteps: 0 } })).toThrow(HarnessConfigError)
	})

	it('rejects symbol and unknown execution-default keys at exact closed paths', () => {
		const hidden = Symbol('hidden')
		for (const [defaults, path] of [
			[{ [hidden]: true }, 'harness.defaults'],
			[{ unexpected: true }, 'harness.defaults.unexpected'],
			[{ contextProjection: { [hidden]: true, toolResultPruner: { maxBytes: 10, headBytes: 4, tailBytes: 4 } } }, 'harness.defaults.contextProjection'],
			[{ contextProjection: { toolResultPruner: { maxBytes: 10, headBytes: 4, tailBytes: 4, unexpected: true } } }, 'harness.defaults.contextProjection.toolResultPruner.unexpected'],
			[{ historyRetention: { maxTurns: 1, [hidden]: true } }, 'harness.defaults.historyRetention'],
		] as const) {
			try {
				defineV4Harness({ name: 'closedDefaults', defaults: defaults as never })
				throw new Error('Expected invalid defaults.')
			} catch (error) {
				expect(error).toBeInstanceOf(HarnessConfigError)
				expect((error as HarnessConfigError).meta).toMatchObject({ reason: 'invalid_execution_defaults', path })
			}
		}
	})

	it('settles one stream result for completed and failed executions independently of iteration', async () => {
		const completed = defineWorkflow('completedOutcome', { async handler({ input }) { return input } })
		const failed = defineWorkflow('failedOutcome', { async handler() { throw new Error('private provider failure') } })
		const instance = await defineV4Harness({ name: 'terminalOutcomeHarness' })
			.addWorkflow(completed).addWorkflow(failed).getInstance({})
		const session = await instance.getSession('terminal-outcome-session')

		const completedStream = session.workflows.completedOutcome.stream('value')
		await expect(completedStream.result).resolves.toMatchObject({ status: 'completed', output: 'value' })
		const completedEvents = []
		for await (const event of completedStream) completedEvents.push(event)
		expect(completedEvents.filter(event => event.type === 'run.finished')).toHaveLength(1)

		const failedStream = session.workflows.failedOutcome.stream('value')
		await expect(failedStream.result).resolves.toMatchObject({
			status: 'failed', error: { code: 'INTERNAL_ERROR' },
		})
		for await (const _event of failedStream) { /* drain producer lifecycle */ }
		const aggregateSession = await instance.getSession('terminal-outcome-aggregate-session')
		await expect(aggregateSession.workflows.failedOutcome.run('value')).rejects.toMatchObject({
			constructor: InternalError, message: 'Harness target execution failed.',
		})
		await aggregateSession.destroy()
		await session.destroy()
		await instance.close()
	})

	it('settles cancellation once and keeps iterator return separate from execution cancellation', async () => {
		let release!: () => void
		const gate = new Promise<void>(resolve => { release = resolve })
		const workflow = defineWorkflow('cancelOutcome', { async handler({ input, signal }) {
			if (input === 'value') await gate
			else await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
			return input
		} })
		const instance = await defineV4Harness({ name: 'cancelOutcomeHarness' }).addWorkflow(workflow).getInstance({})
		const session = await instance.getSession('cancel-outcome-session')
		const observed = session.workflows.cancelOutcome.stream('value')
		const iterator = observed[Symbol.asyncIterator]()
		await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.started' } })
		await iterator.return?.()
		release()
		await expect(observed.result).resolves.toMatchObject({ status: 'completed', output: 'value' })

		const cancellationSession = await instance.getSession('cancel-outcome-cancellation-session')
		const cancelled = cancellationSession.workflows.cancelOutcome.stream('cancel')
		await cancelled.cancel('consumer disconnected')
		await expect(cancelled.result).resolves.toMatchObject({ status: 'cancelled', error: { code: 'OPERATION_CANCELLED' } })
		for await (const _event of cancelled) { /* drain producer lifecycle */ }
		const aggregateSession = await instance.getSession('cancel-outcome-aggregate-session')
		await expect(aggregateSession.workflows.cancelOutcome.run('cancel', { signal: AbortSignal.abort('stop') }))
			.rejects.toBeInstanceOf(OperationCancelledError)
		await aggregateSession.destroy()
		await cancellationSession.destroy()
		await session.destroy()
		await instance.close()
	})

	it('retains the terminal result when bounded delivery overflows', async () => {
		const echo = defineTool('overflowEcho', { description: 'Echo.', input: z.number(), output: z.number(),
			async handler(_context, value) { return value } })
		const workflow = defineWorkflow('overflowOutcome', { tools: [echo], async handler({ input, tools }) {
			for (let index = 0; index < 100; index += 1) await tools.overflowEcho.run(index, { callId: `overflow-${index}` })
			return input
		} })
		const instance = await defineV4Harness({ name: 'overflowOutcomeHarness' }).addWorkflow(workflow).getInstance({})
		const session = await instance.getSession('overflow-outcome-session')
		const stream = session.workflows.overflowOutcome.stream('value')
		await expect(stream.result).resolves.toMatchObject({ status: 'completed', output: 'value' })
		const events = []
		for await (const event of stream) events.push(event)
		expect(events.some(event => event.type === 'stream.overflow')).toBe(true)
		expect(events.at(-1)).toMatchObject({ type: 'run.finished', outcome: { status: 'completed' } })
		await session.destroy()
		await instance.close()
	})
})
