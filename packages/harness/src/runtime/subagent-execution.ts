import { createHash } from 'node:crypto'

import { getDefinitionIdentity } from '../definitions/identity.js'
import { assertDefinitionId, assertNonemptyText } from '../definitions/identity.js'
import type { AgentSubagentReference, AnyAgentDefinition } from '../definitions/types.js'
import { harnessExecutionEventTypesV1, type ExecutionEvent } from '../definitions/execution-events.js'
import { decisionEvidenceSchema } from '../decisions/schemas.js'
import { AgentLoopBudgetError, OperationCancelledError, ToolError, ValidationError } from '../errors/index.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type { Infer, InferIn } from '../schema/index.js'
import type { HarnessTargetDispatchStream } from '../ports/target-dispatcher.js'
import { finishReasonSchema } from '../ports/model-provider.js'
import { withAbortSignal } from './abort.js'
import { canonicalJson } from './canonical-json.js'
import { createHarnessChildTargetInterruption } from './steps.js'
import {
	createAgentExecutableBinding,
	type AgentExecutableBinding,
	type AgentToolInvocationContext,
} from '../tools/bindings.js'

type ReferencedAgent<R extends AgentSubagentReference> = R extends AnyAgentDefinition ? R : R extends { readonly agent: infer A extends AnyAgentDefinition } ? A : never
type SubagentBinding<A extends AnyAgentDefinition> = Omit<AgentExecutableBinding<A['input'], A['output']>, 'invokeValidated'> & Readonly<{
	invokeValidated(context: AgentToolInvocationContext, input: Infer<A['input']> & JsonValue, wireInput: InferIn<A['input']> & JsonValue): Promise<Infer<A['output']> & JsonValue>
}>

/** @internal Runtime-owned authorization and sandbox handoff for one subagent launch. */
export interface SubagentLaunchHooks {
	prepare(context: AgentToolInvocationContext, agent: AnyAgentDefinition, childInvocationId: string, childSessionId: string): Promise<void>
	finish(childInvocationId: string): void
}

/** Creates the sole common-pipeline binding for one model-facing subagent. */
export function createSubagentBinding<
	const Name extends string,
	const Reference extends AgentSubagentReference,
>(name: Name, reference: Reference, hooks?: SubagentLaunchHooks): SubagentBinding<ReferencedAgent<Reference>> {
	assertDefinitionId(name, 'agent.subagents')
	const agent: AnyAgentDefinition = isReferenceWrapper(reference) ? reference.agent : reference as AnyAgentDefinition
	const identity = getDefinitionIdentity(agent)
	if (identity?.kind !== 'agent' || getDefinitionIdentity(agent.contract)?.token !== identity.token) {
		throw new TypeError('Subagent binding requires an exact package-owned agent definition.')
	}
	const override = isReferenceWrapper(reference) ? reference.description : undefined
	if (override !== undefined) assertNonemptyText(override, 'agent.subagents.description', agent.id)
	const description = override ?? agent.description ?? `Delegate to the "${agent.id}" agent.`
	const childIds = (context: AgentToolInvocationContext) => Object.freeze({
		invocationId: deriveOpaqueId('invocation', [context.runId, 'agent', context.agentId, context.callId, agent.id]),
		sessionId: deriveOpaqueId('session', [context.sessionId, context.rootRunId,
			deriveOpaqueId('invocation', [context.runId, 'agent', context.agentId, context.callId, agent.id]), agent.id]),
	})
	const binding = createAgentExecutableBinding({
		id: name,
		description,
		input: agent.input,
		output: agent.output,
		implementationKind: 'subagent',
		definitionIdentity: identity,
		digestDefinition: ['agent', agent.id],
		mcpOwner: null,
		remoteMcpName: null,
		outputValidation: 'already-validated-target',
		...(hooks === undefined ? {} : {
			beforeInvoke: async (context: AgentToolInvocationContext) => {
				const ids = childIds(context)
				await hooks.prepare(context, agent, ids.invocationId, ids.sessionId)
			},
			afterInvoke: (context: AgentToolInvocationContext) => hooks.finish(childIds(context).invocationId),
		}),
		invokeValidated: async (context, _input, wireInput) => executeSubagent(name, agent, context, wireInput),
	})
	return binding as SubagentBinding<ReferencedAgent<Reference>>
}

async function executeSubagent(
	providerName: string,
	agent: AnyAgentDefinition,
	context: AgentToolInvocationContext,
	wireInput: JsonValue,
): Promise<JsonValue> {
	if (context.remainingDepth === 0) throw new AgentLoopBudgetError('Agent delegation depth budget exceeded.', {
		agent_id: context.agentId, reason: 'max_depth', limit: context.depth + context.remainingDepth,
	})
	const childInvocationId = deriveOpaqueId('invocation', [context.runId, 'agent', context.agentId, context.callId, agent.id])
	const childSessionId = deriveOpaqueId('session', [context.sessionId, context.rootRunId, childInvocationId, agent.id])
	const route = context.targetDispatcher.assertTarget(agent.contract)
	const stream = await withAbortSignal(context.signal, 'agent', 'Subagent execution was cancelled.', () => context.targetDispatcher.open({
		target: agent.contract,
		input: wireInput,
		invocation: Object.freeze({
			sessionId: childSessionId,
			invocationId: childInvocationId,
			rootRunId: context.rootRunId,
			parentRunId: context.runId,
			parentAgentId: context.agentId,
			depth: context.depth + 1,
			remainingDepth: context.remainingDepth - 1,
			...(context.identity === undefined ? {} : { identity: context.identity }),
			...(context.trace === undefined ? {} : { trace: context.trace }),
			...(context.deadline === undefined ? {} : { deadline: context.deadline }),
			...(context.idempotencyKey === undefined ? {} : { idempotencyKey: context.idempotencyKey }),
			signal: context.signal,
		}),
	}))
	const consumed = await consumeHarnessTargetStream({
		stream, signal: context.signal, parentRunId: context.runId, childInvocationId,
		relay: event => context.relayChildEvent(event),
	})
	const outcome = consumed.outcome
	if (outcome.status === 'completed') return outcome.output
	if (outcome.status === 'interrupted') throw createHarnessChildTargetInterruption(childInvocationId, outcome, route, wireInput)
	if (outcome.status === 'cancelled') throw new OperationCancelledError('Subagent execution was cancelled.', { scope: 'agent' }, outcome.error)
	throw new ToolError('Subagent execution failed.', { tool_id: providerName, tool_kind: 'subagent' }, outcome.error)
}

export interface ConsumedHarnessTarget<Output, Interrupt> {
	readonly outcome: Extract<ExecutionEvent<Output, Interrupt>, { readonly type: 'run.finished' }>['outcome']
	readonly lineage: Readonly<{ parentRunId: string; childRunId: string; childInvocationId: string }>
}

/** @internal Strict shared target-stream consumer. Caller-specific code maps the terminal. */
export async function consumeHarnessTargetStream<Output extends JsonValue, Interrupt>(options: Readonly<{
	stream: HarnessTargetDispatchStream<Output, Interrupt>
	signal: AbortSignal
	parentRunId: string
	childInvocationId: string
	relay(event: ExecutionEvent<Output, Interrupt>): Promise<void>
}>): Promise<ConsumedHarnessTarget<Output, Interrupt>> {
	const { stream, signal, parentRunId, childInvocationId, relay } = options
	let terminal: Extract<ExecutionEvent<Output, Interrupt>, { readonly type: 'run.finished' }> | undefined
	const childRunId = childInvocationId
	const runs = new Map<string, Readonly<{
		parentRunId: string
		parentInvocationId: string
		terminal: boolean
		lastSequence: number
	}>>()
	let iterator: AsyncIterator<ExecutionEvent<Output, Interrupt>>
	let producerResult: Promise<unknown>
	try {
		iterator = stream[Symbol.asyncIterator]()
		producerResult = Promise.resolve(stream.result)
	} catch (error) {
		await cleanupChildStream(stream)
		throw error
	}
	const producerFailure = producerResult.then(
		() => new Promise<never>(() => {}),
		(error: unknown) => { throw error },
	)
	void producerFailure.catch(() => {})
	try {
		while (true) {
			const next = await Promise.race([
				withAbortSignal(signal, 'agent', 'Subagent execution was cancelled.', () => iterator.next()),
				producerFailure,
			])
			if (next === null || typeof next !== 'object') throw malformedTerminal('invalid_event')
			if (next.done) {
				if (terminal === undefined || [...runs.values()].some(run => !run.terminal)) {
					throw malformedTerminal('missing_terminal')
				}
				break
			}
			if (terminal !== undefined) {
				const reason = isPlainRecord(next.value) && next.value['type'] === 'run.finished' ? 'duplicate_terminal' : 'event_after_terminal'
				throw malformedTerminal(reason)
			}
			const event = validateTargetEvent(next.value) as ExecutionEvent<Output, Interrupt>
			const direct = event.runId === childRunId
			const expectedParentRunId = direct ? parentRunId : event.parentRunId
			const expectedParentInvocationId = direct ? childInvocationId : event.parentInvocationId
			const parent = direct || typeof expectedParentRunId !== 'string' ? undefined : runs.get(expectedParentRunId)
			if (typeof expectedParentRunId !== 'string' || typeof expectedParentInvocationId !== 'string'
				|| (!direct && (parent === undefined || parent.terminal))) throw malformedTerminal('invalid_run_correlation')
			const previous = runs.get(event.runId)
			if (previous !== undefined && (previous.parentRunId !== expectedParentRunId
				|| previous.parentInvocationId !== expectedParentInvocationId
				|| previous.terminal || event.sequence <= previous.lastSequence)) {
				throw malformedTerminal(previous.terminal ? 'event_after_terminal' : 'invalid_run_correlation')
			}
			if (previous === undefined
				&& (event.parentRunId !== expectedParentRunId || event.parentInvocationId !== expectedParentInvocationId
					|| (!direct && (event.type !== 'run.started' || event.sequence !== 1)))) {
				throw malformedTerminal('invalid_run_correlation')
			}
			runs.set(event.runId, Object.freeze({ parentRunId: expectedParentRunId,
				parentInvocationId: expectedParentInvocationId, terminal: event.type === 'run.finished', lastSequence: event.sequence }))
			if (event.type === 'run.finished' && direct) {
				terminal = event
				continue
			}
			await withAbortSignal(signal, 'agent', 'Subagent execution was cancelled.', () => relay(event))
		}
		if (terminal === undefined) throw malformedTerminal('missing_terminal')
		let result: unknown
		try {
			const producerState = await Promise.race([
				producerResult.then(value => Object.freeze({ settled: true as const, value })),
				Promise.resolve().then(() => Object.freeze({ settled: false as const })),
			])
			if (!producerState.settled) throw malformedTerminal('missing_terminal')
			result = producerState.value
		}
		catch (error) { throw error }
		if (!validTerminalOutcome(result, childRunId)
			|| canonicalJson(result) !== canonicalJson(terminal.outcome)) throw malformedTerminal('invalid_terminal')
		await withAbortSignal(signal, 'agent', 'Subagent execution was cancelled.', () => relay(terminal!))
	} catch (error) {
		await cleanupChildStream(stream, iterator)
		throw error
	}
	if (terminal === undefined) throw malformedTerminal('missing_terminal')
	return Object.freeze({ outcome: terminal.outcome, lineage: Object.freeze({ parentRunId, childRunId, childInvocationId }) })
}

function isReferenceWrapper(value: AgentSubagentReference): value is Readonly<{ agent: AnyAgentDefinition; description?: string }> {
	return !('kind' in value)
}

function deriveOpaqueId(kind: 'invocation' | 'session', values: readonly string[]): string {
	const digest = createHash('sha256').update(JSON.stringify([`harness.child-${kind}.v1`, ...values]), 'utf8').digest('hex')
	return `${kind}_${digest}`
}

function validateTargetEvent(value: unknown): ExecutionEvent<JsonValue> {
	if (!isPlainRecord(value) || !isJsonValue(value)) throw malformedTerminal('invalid_event')
	const type = value['type']
	const runId = value['runId']
	if (typeof value['eventId'] !== 'string' || value['eventId'].length === 0
		|| !Number.isSafeInteger(value['sequence']) || (value['sequence'] as number) < 1) throw malformedTerminal('invalid_event')
	if (typeof type !== 'string' || !(harnessExecutionEventTypesV1 as readonly string[]).includes(type)) throw malformedTerminal('invalid_event')
	if (typeof runId !== 'string' || runId.length === 0) throw malformedTerminal('invalid_run_correlation')
	if (!validEventBody(value, type)) throw malformedTerminal(type === 'run.finished' ? 'invalid_terminal' : 'invalid_event')
	return value as unknown as ExecutionEvent<JsonValue>
}

function validEventBody(value: Record<string, unknown>, type: string): boolean {
	const string = (key: string) => typeof value[key] === 'string'
	const optionalString = (key: string) => value[key] === undefined || string(key)
	const finite = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key])
	const integer = (key: string) => finite(key) && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0
	const json = (key: string) => Object.prototype.hasOwnProperty.call(value, key) && isJsonValue(value[key])
	switch (type) {
		case 'run.started': return closed(value, ['at']) && string('at')
		case 'run.finished': return closed(value, ['at', 'outcome']) && string('at') && validTerminalOutcome(value['outcome'], value['runId'] as string)
		case 'agent.started': return closed(value, ['agentId', 'at'], ['workflowId', 'parentAgentId', 'delegationCallId', 'delegationDepth', 'modelAlias'])
			&& string('agentId') && string('at') && optionalString('workflowId') && optionalString('parentAgentId') && optionalString('delegationCallId')
			&& (value['delegationDepth'] === undefined || integer('delegationDepth')) && optionalString('modelAlias')
		case 'agent.finished': return closed(value, ['agentId', 'at'], ['workflowId', 'parentAgentId', 'delegationCallId', 'delegationDepth', 'modelAlias', 'output', 'error'])
			&& string('agentId') && string('at') && optionalString('workflowId') && optionalString('parentAgentId') && optionalString('delegationCallId')
			&& (value['delegationDepth'] === undefined || integer('delegationDepth')) && optionalString('modelAlias')
			&& (value['output'] === undefined || isJsonValue(value['output'])) && (value['error'] === undefined || isSerializedError(value['error']))
		case 'model.message': return closed(value, ['caller', 'message']) && validCaller(value['caller'], 'agent') && isPersistedMessage(value['message'])
		case 'model.completed': return closed(value, ['caller', 'modelAlias', 'operation'], ['callId', 'streamId', 'usage', 'finishReason'])
			&& string('modelAlias') && ['text', 'object', 'textStream', 'objectStream'].includes(value['operation'] as string)
			&& validModelCorrelation(value) && optionalString('streamId')
			&& (value['usage'] === undefined || isTokenUsage(value['usage']))
			&& (value['finishReason'] === undefined || finishReasonSchema.safeParse(value['finishReason']).success)
		case 'model.embedding.completed': return closed(value, ['caller', 'modelAlias', 'count'], ['callId', 'dimensions', 'usage']) && integer('count') && string('modelAlias') && validModelCorrelation(value)
			&& (value['dimensions'] === undefined || integer('dimensions')) && (value['usage'] === undefined || isTokenUsage(value['usage']))
		case 'model.rerank.completed': return closed(value, ['caller', 'modelAlias', 'count'], ['callId', 'topN', 'usage']) && integer('count') && string('modelAlias') && validModelCorrelation(value)
			&& (value['topN'] === undefined || integer('topN')) && (value['usage'] === undefined || isTokenUsage(value['usage']))
		case 'model.output.text.delta': return closed(value, ['caller', 'callId', 'id', 'modelAlias', 'delta']) && validCaller(value['caller'], 'workflow') && string('callId') && string('id') && string('modelAlias') && string('delta')
		case 'model.output.object.snapshot': return closed(value, ['caller', 'callId', 'id', 'modelAlias', 'value']) && validCaller(value['caller'], 'workflow') && string('callId') && string('id') && string('modelAlias') && json('value')
		case 'output.text.delta': return closed(value, ['caller', 'id', 'delta'], ['callId', 'modelAlias']) && validCaller(value['caller'], 'agent') && optionalString('callId') && string('id') && string('delta') && optionalString('modelAlias')
		case 'output.object.snapshot': return closed(value, ['caller', 'id', 'value'], ['callId', 'modelAlias']) && validCaller(value['caller'], 'agent') && optionalString('callId') && string('id') && json('value') && optionalString('modelAlias')
		case 'output.file': return closed(value, ['caller', 'id', 'modelAlias', 'operation', 'artifact'], ['callId']) && string('id') && string('modelAlias')
			&& ['image', 'speech', 'video'].includes(value['operation'] as string) && validModelCorrelation(value) && isArtifactReference(value['artifact'])
		case 'output.progress': return closed(value, ['caller', 'id', 'modelAlias', 'operation', 'state'], ['callId', 'progress']) && string('id') && string('modelAlias')
			&& value['operation'] === 'video' && ['queued', 'running'].includes(value['state'] as string) && validModelCorrelation(value)
			&& (value['progress'] === undefined || finite('progress'))
		case 'tool.input.available':
		case 'tool.started': return closed(value, ['caller', 'toolId', 'callId', 'input']) && validCaller(value['caller']) && string('toolId') && string('callId') && json('input')
		case 'tool.finished': return closed(value, ['caller', 'toolId', 'callId'], ['output', 'error']) && validCaller(value['caller']) && string('toolId') && string('callId')
			&& (value['output'] === undefined || isJsonValue(value['output'])) && (value['error'] === undefined || isSerializedError(value['error']))
		case 'policy.exposure': return closed(value, ['agentId', 'invocationId', 'toolId', 'step', 'evidence', 'effect', 'enforced'])
			&& string('agentId') && string('invocationId') && string('toolId') && integer('step') && decisionEvidenceSchema.safeParse(value['evidence']).success
			&& ['expose', 'hide'].includes(value['effect'] as string) && typeof value['enforced'] === 'boolean'
		case 'policy.evaluated': return closed(value, ['agentId', 'invocationId', 'toolId', 'callId', 'step', 'evidence', 'effect', 'enforced'])
			&& string('agentId') && string('invocationId') && string('toolId') && string('callId') && integer('step') && decisionEvidenceSchema.safeParse(value['evidence']).success
			&& ['allow', 'deny', 'require_approval', 'audit'].includes(value['effect'] as string) && typeof value['enforced'] === 'boolean'
		case 'approval.requested': return closed(value, ['agentId', 'invocationId', 'toolId', 'callId', 'step', 'approvalId', 'demands'])
			&& string('agentId') && string('invocationId') && string('toolId') && string('callId') && integer('step') && string('approvalId')
			&& Array.isArray(value['demands']) && value['demands'].every(demand => decisionEvidenceSchema.safeParse(demand).success)
		case 'approval.responded': return closed(value, ['agentId', 'invocationId', 'toolId', 'callId', 'step', 'approvalId', 'approved'])
			&& string('agentId') && string('invocationId') && string('toolId') && string('callId') && integer('step') && string('approvalId') && typeof value['approved'] === 'boolean'
		case 'external_wait.requested': return closed(value, ['at', 'waitId', 'kind', 'schemaVersion', 'definitionVersion', 'deadline'])
			&& string('at') && string('waitId') && string('kind') && string('schemaVersion') && string('definitionVersion') && string('deadline')
		case 'external_wait.waiting': return closed(value, ['at', 'waitId', 'kind', 'deadline']) && string('at') && string('waitId') && string('kind') && string('deadline')
		case 'external_wait.resolved': return closed(value, ['at', 'waitId', 'kind', 'outcome', 'deadline']) && string('at') && string('waitId') && string('kind')
			&& ['approved', 'rejected', 'expired', 'cancelled'].includes(value['outcome'] as string) && string('deadline')
		case 'fanout.started': return closed(value, ['batchId', 'at', 'count', 'concurrency']) && string('batchId') && string('at') && integer('count') && integer('concurrency')
		case 'fanout.finished': return closed(value, ['batchId', 'at', 'count', 'status']) && string('batchId') && string('at') && integer('count')
			&& ['succeeded', 'failed', 'cancelled'].includes(value['status'] as string)
		case 'child_task.started': return closed(value, ['taskId', 'at', 'parentRunId', 'workflowId', 'agentId', 'contextPolicy', 'mode'], ['modelAlias'])
			&& string('taskId') && string('at') && string('parentRunId') && string('workflowId') && string('agentId') && optionalString('modelAlias')
			&& value['contextPolicy'] === 'isolated' && ['one_shot', 'continuable'].includes(value['mode'] as string)
		case 'child_task.settled': return closed(value, ['taskId', 'at', 'parentRunId', 'workflowId', 'agentId', 'status'], ['error'])
			&& string('taskId') && string('at') && string('parentRunId') && string('workflowId') && string('agentId')
			&& ['succeeded', 'failed', 'cancelled'].includes(value['status'] as string) && (value['error'] === undefined || isSerializedError(value['error']))
		case 'stream.overflow': return closed(value, ['at', 'dropped']) && string('at') && integer('dropped')
		default: return false
	}
}

function validCaller(value: unknown, expected?: 'agent' | 'workflow'): boolean {
	if (!isPlainRecord(value)) return false
	if (value['kind'] === 'agent') return expected !== 'workflow' && exact(value, value['workflowId'] === undefined ? ['kind', 'agentId'] : ['kind', 'agentId', 'workflowId'])
		&& typeof value['agentId'] === 'string' && value['agentId'].length > 0 && (value['workflowId'] === undefined || typeof value['workflowId'] === 'string')
	if (value['kind'] === 'workflow') return expected !== 'agent' && exact(value, ['kind', 'workflowId'])
		&& typeof value['workflowId'] === 'string' && value['workflowId'].length > 0
	return false
}
function validModelCorrelation(value: Record<string, unknown>): boolean {
	return validCaller(value['caller']) && (isPlainRecord(value['caller']) && value['caller']['kind'] === 'workflow'
		? typeof value['callId'] === 'string' && value['callId'].length > 0
		: value['callId'] === undefined || typeof value['callId'] === 'string')
}

function validTerminalOutcome(value: unknown, runId: string): boolean {
	const outcome = value
	if (!isPlainRecord(outcome) || !isJsonValue(outcome) || outcome['runId'] !== runId || typeof outcome['status'] !== 'string') return false
	const status = outcome['status']
	const allowedOutcomeKeys = status === 'completed'
		? ['status', 'runId', 'output']
		: status === 'interrupted'
			? ['status', 'runId', 'interrupt']
			: status === 'cancelled' || status === 'failed'
				? ['status', 'runId', 'error']
				: undefined
	if (allowedOutcomeKeys === undefined || Reflect.ownKeys(outcome).some(key => typeof key !== 'string' || !allowedOutcomeKeys.includes(key))) return false
	if (status === 'completed') return Object.prototype.hasOwnProperty.call(outcome, 'output')
	if (status === 'interrupted') return validHarnessInterrupt(outcome['interrupt'])
	return isSerializedError(outcome['error'])
}

function isSerializedError(value: unknown): boolean {
	if (!isPlainRecord(value) || !isJsonValue(value)) return false
	const allowed = new Set(['code', 'message', 'category', 'retriable', 'meta'])
	if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) return false
	return typeof value['code'] === 'string' && value['code'].length > 0
		&& typeof value['message'] === 'string'
		&& (value['category'] === undefined || typeof value['category'] === 'string')
		&& (value['retriable'] === undefined || typeof value['retriable'] === 'boolean')
		&& (value['meta'] === undefined || isPlainRecord(value['meta']))
}

async function cleanupChildStream(
	stream: { cancel(reason?: string): Promise<void> },
	iterator?: AsyncIterator<unknown>,
): Promise<void> {
	const cleanup: Promise<unknown>[] = []
	try { cleanup.push(Promise.resolve(stream.cancel('target-consumer-stopped'))) } catch { /* preserve the primary failure */ }
	try { if (iterator?.return !== undefined) cleanup.push(Promise.resolve(iterator.return())) } catch { /* preserve the primary failure */ }
	await Promise.allSettled(cleanup)
}

function closed(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set(['type', 'eventId', 'sequence', 'runId', 'parentRunId', 'parentInvocationId', ...required, ...optional])
	return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
		&& Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key))
}

function validHarnessInterrupt(value: unknown): boolean {
	if (!isPlainRecord(value) || !isJsonValue(value)) return false
	if (value['type'] === 'tool-approval') {
		return exact(value, ['type', 'id', 'revision', 'requests']) && typeof value['id'] === 'string' && typeof value['revision'] === 'string'
			&& Array.isArray(value['requests']) && value['requests'].every(isToolApprovalRequest)
	}
	if (value['type'] === 'external-wait') {
		return exact(value, ['type', 'id', 'revision', 'kind', 'schemaVersion', 'definitionVersion', 'deadline'])
			&& ['id', 'revision', 'kind', 'schemaVersion', 'definitionVersion', 'deadline'].every(key => typeof value[key] === 'string')
	}
	return false
}

function isToolApprovalRequest(value: unknown): boolean {
	if (!isPlainRecord(value) || !isJsonValue(value)) return false
	const required = ['approvalId', 'runId', 'agentRunId', 'agentId', 'invocationId', 'step', 'toolId', 'callId', 'input', 'demands']
	const optional = ['parentRunId', 'parentInvocationId', 'workflowId']
	if (!exact(value, required, optional)) return false
	return ['approvalId', 'runId', 'agentRunId', 'agentId', 'invocationId', 'toolId', 'callId'].every(key => typeof value[key] === 'string')
		&& optional.every(key => value[key] === undefined || typeof value[key] === 'string')
		&& Number.isSafeInteger(value['step']) && (value['step'] as number) >= 0 && isJsonValue(value['input'])
		&& Array.isArray(value['demands']) && value['demands'].every(demand => decisionEvidenceSchema.safeParse(demand).success)
}

function isPersistedMessage(value: unknown): boolean {
	if (!isPlainRecord(value) || !isJsonValue(value)) return false
	if (!exact(value, ['id', 'sessionId', 'role', 'content', 'timestamp'], ['runId', 'toolCalls', 'toolResults'])) return false
	if (!['id', 'sessionId', 'content', 'timestamp'].every(key => typeof value[key] === 'string') || !['system', 'user', 'assistant', 'tool'].includes(value['role'] as string)) return false
	if (value['runId'] !== undefined && typeof value['runId'] !== 'string') return false
	if (value['toolCalls'] !== undefined && (!Array.isArray(value['toolCalls']) || !value['toolCalls'].every(call => isPlainRecord(call) && exact(call, ['id', 'name', 'arguments'])
		&& typeof call['id'] === 'string' && typeof call['name'] === 'string' && isJsonValue(call['arguments'])))) return false
	return value['toolResults'] === undefined || (Array.isArray(value['toolResults']) && value['toolResults'].every(result => isPlainRecord(result)
		&& exact(result, ['toolCallId'], ['output', 'error']) && typeof result['toolCallId'] === 'string'
		&& (result['output'] === undefined || isJsonValue(result['output'])) && (result['error'] === undefined || isSerializedError(result['error']))))
}

function isArtifactReference(value: unknown): boolean {
	if (!isPlainRecord(value) || !isJsonValue(value) || !exact(value, ['id', 'url', 'mediaType'], ['filename', 'size', 'expiresAt', 'metadata'])) return false
	return ['id', 'url', 'mediaType'].every(key => typeof value[key] === 'string')
		&& (value['filename'] === undefined || typeof value['filename'] === 'string')
		&& (value['size'] === undefined || typeof value['size'] === 'number' && Number.isFinite(value['size']))
		&& (value['expiresAt'] === undefined || typeof value['expiresAt'] === 'string')
		&& (value['metadata'] === undefined || isPlainRecord(value['metadata']))
}

function isTokenUsage(value: unknown): boolean {
	if (!isPlainRecord(value) || !isJsonValue(value) || !exact(value, ['inputTokens', 'outputTokens', 'totalTokens'], [
		'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens',
	])) return false
	return ['inputTokens', 'outputTokens', 'totalTokens'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]))
		&& ['cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens'].every(key => value[key] === undefined || typeof value[key] === 'number' && Number.isFinite(value[key]))
}

function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional])
	return required.every(key => Object.prototype.hasOwnProperty.call(value, key))
		&& Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function malformedTerminal(reason: 'missing_terminal' | 'duplicate_terminal' | 'event_after_terminal' | 'invalid_event' | 'invalid_run_correlation' | 'invalid_terminal'): ValidationError {
	return new ValidationError('Harness target stream must contain exactly one terminal event.', {
		where: 'model_response', issues: { reason },
	})
}
