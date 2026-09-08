import { createHash } from 'node:crypto'

import type { ToolApprovalResume } from '../approvals/index.js'
import type { HarnessCatalogView, HarnessContracts } from '../definitions/catalog.js'
import { getHarnessRuntimeBlueprint, type HarnessDefinition } from '../definitions/harness.js'
import { getDefinitionIdentity } from '../definitions/identity.js'
import type { HarnessExecutionCaller, HostToolDefinition } from '../definitions/types.js'
import {
	AgentLoopBudgetError, HarnessConfigError, HostNestedTargetError, HostNestedTargetReplayConflictError, InternalError,
	HarnessTargetRouteReceiptMismatchError, OperationCancelledError, ValidationError,
} from '../errors/index.js'
import type { HarnessIdentity } from '../identity/index.js'
import { normalizeHarnessIdentity } from '../identity/index.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type { Logger } from '../logger/index.js'
import type {
	AnyHarnessTargetContract, HarnessNestedTargetDispatchInvocation, HarnessTargetDispatcher, HarnessTargetDispatchStream, HarnessTargetInput,
	HarnessTargetOutput, HarnessTargetRouteReceiptV1, HarnessValidatedTargetInput,
} from '../ports/target-dispatcher.js'
import type { Infer } from '../schema/index.js'
import type { HostNestedTargetCheckpointV1, HostNestedTargetStoredOutcomeV1 } from '../storage/execution.js'
import type { TelemetryShim } from '../telemetry/index.js'
import { normalizeHarnessTraceContext, type HarnessTraceContext } from '../telemetry/trace-context.js'
import { bindHostTool, type AgentExecutableBinding, type ToolInvocationContext } from '../tools/bindings.js'
import { canonicalJson } from '../runtime/canonical-json.js'
import { abortError } from '../runtime/abort.js'
import {
	createHarnessChildTargetInterruption, attachHarnessChildTargetHostFrame,
	type HarnessCheckpointStep,
} from '../runtime/steps.js'
import { consumeHarnessTargetStream } from '../runtime/subagent-execution.js'
import {
	createTrustedHostedInvocationEnvironment, instantiateHarnessRuntime,
	normalizeInvokeOptions, normalizeToolApprovalResume, type InvokeOptions,
} from '../runtime/standalone-instance.js'
import type { RunOutcome } from '../runtime/outcomes.js'
import type { RuntimeRequirements } from '../runtime/runtime-requirements.js'
import type { CompiledDefinitionGraph } from '../runtime/compiled-graph.js'
import {
	validateHostedHarnessInstanceConfig, type HarnessRuntimeBindingFields,
} from '../runtime/instance-config.js'
import { hostToolOwner, isHostOwnerToken, type HostOwnerToken } from './host-tool.js'

/** Address-first invoker exposed only to the current host-tool invocation. */
export interface HarnessNestedTargetInvoker {
	run<Target extends AnyHarnessTargetContract>(
		target: Target,
		input: HarnessTargetInput<Target>,
		options: Readonly<{ callId: string }>,
	): Promise<HarnessTargetOutput<Target>>
}

/** Trusted data supplied to a host context factory for one tool call. */
export type HarnessHostContextRequest<HostInvocation> = Readonly<{
	hostInvocation: HostInvocation
	target: Readonly<{ kind: 'agent' | 'workflow'; id: string }>
	tool: Readonly<{ id: string; callId: string }>
	caller: HarnessExecutionCaller
	sessionId: string
	runId: string
	rootRunId: string
	invocationId: string
	hostToolInvocationId: string
	parentRunId?: string
	depth: number
	remainingDepth: number
	deadline?: number
	signal: AbortSignal
	nestedTargets: HarnessNestedTargetInvoker
	checkpointStep: HarnessCheckpointStep
}>

/** Host-owned projections, dispatch, logging, telemetry, and context construction. */
export interface HarnessHostBindings<HostInvocation, HostContext> {
	readonly hostOwner: HostOwnerToken<HostContext>
	readonly targetDispatcher: HarnessTargetDispatcher
	readonly projectIdentity: (hostInvocation: HostInvocation) => HarnessIdentity | undefined
	readonly projectTraceContext: (hostInvocation: HostInvocation) => HarnessTraceContext | undefined
	readonly createHostContext: (request: HarnessHostContextRequest<HostInvocation>) => HostContext | Promise<HostContext>
	readonly logger: Logger
	readonly telemetry: TelemetryShim
}

type HostedTargetOf<Contracts extends HarnessContracts> = Contracts['agents'][keyof Contracts['agents']] | Contracts['workflows'][keyof Contracts['workflows']]

/** Runtime adapters required by a compiled graph; logger and telemetry remain host owned. */
export type HostedHarnessInstanceConfig<Requirements extends RuntimeRequirements, ConfiguredGroups extends readonly string[] = readonly []> = Readonly<
	HarnessRuntimeBindingFields<Requirements, ConfiguredGroups> & { readonly logger?: never; readonly telemetry?: never }
>

/** Per-call options accepted at a hosted boundary. Trace context is projected by the host. */
export type HostedInvokeOptions = Readonly<Omit<InvokeOptions, 'traceparent' | 'tracestate'> & {
	readonly sessionId: string
	readonly traceparent?: never
	readonly tracestate?: never
}>

/** One already-authenticated and schema-transformed hosted target request. */
export type HostedTargetRequest<Target extends AnyHarnessTargetContract, HostInvocation> = Readonly<{
	target: Target
	input: HarnessValidatedTargetInput<Target>
	invokeOptions: HostedInvokeOptions
	hostInvocation: HostInvocation
}>

/** Runtime-authored nested dispatch identity. Authentication and trace remain host owned. */
type StripHostOwnedInvocation<T> = T extends unknown ? Readonly<Omit<T, 'identity' | 'trace'> & {
		readonly identity?: never
		readonly trace?: never
	}> : never
export type HostedDispatchInvocation = StripHostOwnedInvocation<HarnessNestedTargetDispatchInvocation>

/** Receiving-boundary request for one fresh or persisted dispatcher delivery. */
export type HostedDispatchedTargetRequest<Target extends AnyHarnessTargetContract, HostInvocation> =
	| Readonly<{
		delivery: 'fresh'
		target: Target
		wireInput: HarnessTargetInput<Target>
		input: HarnessValidatedTargetInput<Target>
		invocation: HostedDispatchInvocation
		resume?: never
		hostInvocation: HostInvocation
	}>
	| Readonly<{
		delivery: 'resume'
		target: Target
		wireInput: HarnessTargetInput<Target>
		input?: never
		invocation: HostedDispatchInvocation
		resume: ToolApprovalResume
		hostInvocation: HostInvocation
	}>

/** Hosted execution facade retaining exact graph target types. */
export interface HostedHarnessInstance<Contracts extends HarnessContracts, HostInvocation> {
	runHosted<Target extends HostedTargetOf<Contracts>>(request: HostedTargetRequest<Target, HostInvocation>): Promise<RunOutcome<HarnessTargetOutput<Target>>>
	streamHosted<Target extends HostedTargetOf<Contracts>>(request: HostedTargetRequest<Target, HostInvocation>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
	/** Accepts the receiving side of a trusted target dispatch while preserving its exact child identity. */
	streamDispatched<Target extends HostedTargetOf<Contracts>>(request: HostedDispatchedTargetRequest<Target, HostInvocation>): Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
	close(): Promise<void>
}

/** Creates one hosted Harness runtime using only host-owned projection and dispatch bindings. */
export async function instantiateHostedHarness<
	Catalog extends HarnessCatalogView,
	HostInvocation,
	HostContext,
	const ConfiguredGroups extends readonly string[] = readonly [],
>(
	definition: HarnessDefinition<Catalog>,
	config: HostedHarnessInstanceConfig<Catalog['requirements'], ConfiguredGroups>,
	hostBindings: HarnessHostBindings<HostInvocation, HostContext>,
): Promise<HostedHarnessInstance<Catalog['contracts'], HostInvocation>> {
	const blueprint = getHarnessRuntimeBlueprint(definition)
	if (blueprint === undefined) throw new HarnessConfigError('Hosted Harness definition is invalid.', { reason: 'foreign_definition', path: 'definition' })
	validateHostBindings(hostBindings)
	for (const tool of Object.values(blueprint.graph.tools).sort((a, b) => codePointCompare(a.id, b.id))) {
		if (getDefinitionIdentity(tool)?.kind === 'host-tool' && hostToolOwner(tool) !== hostBindings.hostOwner) {
			throw new HarnessConfigError('Host tool owner does not match the hosted Harness owner.', {
				reason: 'host_owner_mismatch', path: 'hostBindings.hostOwner', id: tool.id,
			})
		}
	}
	const validated = validateHostedHarnessInstanceConfig(blueprint.graph.requirements, config)
	const kernel = await instantiateHarnessRuntime<Catalog['contracts'], Catalog['requirements']>({
		name: blueprint.name, ...(blueprint.revision === undefined ? {} : { revision: blueprint.revision }),
		defaults: blueprint.defaults, graph: blueprint.graph, bindings: validated, hosted: true,
		hostLogger: hostBindings.logger, hostTelemetry: hostBindings.telemetry,
	})
	let closed = false

	const projectEnvironment = async (hostInvocation: HostInvocation) => {
		if (closed) throw new InternalError('Hosted Harness instance is closed.')
		let projectedIdentity: HarnessIdentity | undefined
		try { projectedIdentity = hostBindings.projectIdentity(hostInvocation) }
		catch { throw new InternalError('Hosted identity projection failed.') }
		const identity = normalizeHarnessIdentity(projectedIdentity)
		let traceContext: HarnessTraceContext | undefined
		let projectedTrace: HarnessTraceContext | undefined
		try { projectedTrace = hostBindings.projectTraceContext(hostInvocation) }
		catch { throw new InternalError('Hosted trace-context projection failed.') }
		try {
			traceContext = projectedTrace === undefined ? undefined : normalizeHarnessTraceContext(projectedTrace)
		} catch (error) {
			if (error instanceof HarnessConfigError) throw error
			throw error
		}
		const bindings = createHostBindingOverlay(blueprint.graph, hostBindings, hostInvocation)
		return createTrustedHostedInvocationEnvironment({
			...(identity === undefined ? {} : { identity }), ...(traceContext === undefined ? {} : { traceContext }),
			targetDispatcher: hostBindings.targetDispatcher, hostToolBindings: bindings,
		})
	}
	const prepare = async <Target extends AnyHarnessTargetContract>(request: HostedTargetRequest<Target, HostInvocation>) => {
		if (closed) throw new InternalError('Hosted Harness instance is closed.')
		const invokeOptions = validateHostedRequest(request, blueprint.graph)
		if (invokeOptions.signal?.aborted) throw abortError(invokeOptions.signal, 'run', 'Hosted run was cancelled.')
		return Object.freeze({ environment: await projectEnvironment(request.hostInvocation), invokeOptions })
	}
	return Object.freeze({
		async runHosted<Target extends HostedTargetOf<Catalog['contracts']>>(request: HostedTargetRequest<Target, HostInvocation>) {
			const prepared = await prepare(request)
			return kernel.runTrusted(request.target, request.input, prepared.invokeOptions, prepared.environment) as Promise<RunOutcome<HarnessTargetOutput<Target>>>
		},
		async streamHosted<Target extends HostedTargetOf<Catalog['contracts']>>(request: HostedTargetRequest<Target, HostInvocation>) {
			const prepared = await prepare(request)
			return kernel.streamTrusted(request.target, request.input, prepared.invokeOptions, prepared.environment) as Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
		},
		async streamDispatched<Target extends HostedTargetOf<Catalog['contracts']>>(request: HostedDispatchedTargetRequest<Target, HostInvocation>) {
			if (closed) throw new InternalError('Hosted Harness instance is closed.')
			const validated = validateHostedDispatchedRequest(request, blueprint.graph, blueprint.defaults.maxDepth)
			if (validated.invocation.signal.aborted) throw abortError(validated.invocation.signal, request.target.kind, 'Hosted target dispatch was cancelled.')
			const environment = await projectEnvironment(request.hostInvocation)
			const invocation = Object.freeze({ ...validated.invocation,
				...(environment.identity === undefined ? {} : { identity: environment.identity }),
				...(environment.traceContext === undefined ? {} : { trace: environment.traceContext }),
			})
			const executionInput = validated.delivery === 'fresh' ? validated.input! : validated.wireInput
			return kernel.streamDispatchedTrusted(request.target, executionInput, validated.wireInput,
				invocation, validated.resume, environment) as Promise<HarnessTargetDispatchStream<HarnessTargetOutput<Target>>>
		},
		async close() { closed = true; await kernel.instance.close() },
	})
}

function createHostBindingOverlay<HostInvocation, HostContext>(
	graph: CompiledDefinitionGraph,
	hostBindings: HarnessHostBindings<HostInvocation, HostContext>,
	hostInvocation: HostInvocation,
): ReadonlyMap<object, AgentExecutableBinding> {
	const rows: Array<readonly [object, AgentExecutableBinding]> = []
	for (const tool of Object.values(graph.tools)) {
		const identity = getDefinitionIdentity(tool)
		if (identity?.kind !== 'host-tool') continue
		const definition = tool as HostToolDefinition<string, any, any, HostContext>
		let binding!: AgentExecutableBinding
		binding = bindHostTool(definition, async (context, input, wireInput) => {
			const hostToolInvocationId = opaqueId('invocation', ['harness.host-tool-invocation.v1', context.rootRunId,
				context.runId, context.invocationId, definition.id, context.callId])
				const local = new Map<string, Readonly<{
					target: Readonly<{ kind: 'agent' | 'workflow'; id: string }>
					canonicalInput: string
					pending: Promise<HostNestedTargetCheckpointV1>
				}>>()
			let activeDistinct: string | undefined
			const nestedTargets: HarnessNestedTargetInvoker = Object.freeze({
				async run<Target extends AnyHarnessTargetContract>(target: Target, nestedInput: HarnessTargetInput<Target>, nestedOptions: Readonly<{ callId: string }>): Promise<HarnessTargetOutput<Target>> {
					const route = requireRouteReceipt(hostBindings.targetDispatcher.assertTarget(target), target)
					assertStepId(nestedOptions?.callId)
					if (!isJsonValue(nestedInput)) throw new ValidationError('Harness target input must be JSON.', {
						where: target.kind === 'agent' ? 'agent_input' : 'workflow_input', issues: { reason: 'non_json_input' },
					})
						const key = hostCallKey(hostToolInvocationId, nestedOptions.callId)
						const canonicalInput = canonicalJson(nestedInput)
						const known = local.get(key)
						if (known !== undefined) {
							if (known.target.kind !== target.kind || known.target.id !== target.id) throw new HostNestedTargetReplayConflictError({
								reason: 'target_mismatch', caller: context.caller, caller_run_id: context.runId, tool_id: definition.id,
								tool_call_id: context.callId, call_id: nestedOptions.callId,
								expected_target_kind: known.target.kind, expected_target_id: known.target.id,
								received_target_kind: target.kind, received_target_id: target.id,
							})
							if (known.canonicalInput !== canonicalInput) throw new HostNestedTargetReplayConflictError({
								reason: 'input_mismatch', caller: context.caller, caller_run_id: context.runId, tool_id: definition.id,
								tool_call_id: context.callId, call_id: nestedOptions.callId,
								expected_target_kind: known.target.kind, expected_target_id: known.target.id,
								received_target_kind: target.kind, received_target_id: target.id,
							})
							return replayHostRecord(await known.pending, target, route, canonicalInput, nestedOptions.callId,
								hostToolInvocationId, context, definition) as HarnessTargetOutput<Target>
						}
					if (activeDistinct !== undefined && activeDistinct !== key) throw new ValidationError('Host tool can run only one nested target at a time.', {
						where: 'invoke_options', issues: { reason: 'concurrent_host_nested_target' },
					})
					activeDistinct = key
					const pending = context.checkpointStep(key, async () => executeNestedTarget({ context, definition, binding,
						hostToolInvocationId, target, route, input: nestedInput, hostToolWireInput: wireInput, callId: nestedOptions.callId }) as unknown as JsonValue)
						.then(value => parseHostRecord(value))
						local.set(key, Object.freeze({ target: Object.freeze({ kind: target.kind, id: target.id }), canonicalInput, pending }))
					try { return replayHostRecord(await pending, target, route, canonicalInput, nestedOptions.callId, hostToolInvocationId, context, definition) as HarnessTargetOutput<Target> }
					finally { activeDistinct = undefined }
				},
			})
			const target = Object.freeze(context.caller.kind === 'agent'
				? { kind: 'agent' as const, id: context.caller.agentId }
				: { kind: 'workflow' as const, id: context.caller.workflowId })
			const request = Object.freeze({ hostInvocation, target, tool: Object.freeze({ id: definition.id, callId: context.callId }),
				caller: context.caller,
				sessionId: context.sessionId, runId: context.runId, rootRunId: context.rootRunId, invocationId: context.invocationId,
				hostToolInvocationId, ...(context.parentRunId === undefined ? {} : { parentRunId: context.parentRunId }),
				depth: context.depth, remainingDepth: context.remainingDepth, ...(context.deadline === undefined ? {} : { deadline: context.deadline }),
				signal: context.signal, nestedTargets, checkpointStep: <T extends JsonValue>(stepId: string, handler: () => Promise<T>, stepOptions?: import('../runtime/steps.js').DurableStepOptions) => context.checkpointStep(hostStepKey(hostToolInvocationId, stepId), handler, stepOptions),
			})
			const hostContext = await hostBindings.createHostContext(request)
			return definition.handler(hostContext, input)
		})
		rows.push(Object.freeze([identity.token, binding]))
	}
	return immutableIdentityMap(rows)
}

async function executeNestedTarget(options: Readonly<{
	context: ToolInvocationContext; definition: HostToolDefinition<any, any, any, any>; binding: AgentExecutableBinding; hostToolInvocationId: string
	target: AnyHarnessTargetContract; route: HarnessTargetRouteReceiptV1; input: JsonValue; hostToolWireInput: JsonValue; callId: string
}>): Promise<HostNestedTargetCheckpointV1> {
	const { context, definition, binding, hostToolInvocationId, target, route, input, hostToolWireInput, callId } = options
	if (context.remainingDepth === 0) {
		if (context.caller.kind === 'agent') throw new AgentLoopBudgetError('Agent delegation depth budget exceeded.', {
			agent_id: context.caller.agentId, reason: 'max_depth', limit: context.depth + context.remainingDepth,
		})
		throw new ValidationError('Workflow delegation depth budget exceeded.', { where: 'invoke_options',
			issues: { reason: 'max_depth', limit: context.depth + context.remainingDepth } })
	}
	const childInvocationId = opaqueId('invocation', ['harness.host-child-invocation.v1', hostToolInvocationId, callId, target.kind, target.id])
	const childSessionId = opaqueId('session', ['harness.host-child-session.v1', context.sessionId, context.rootRunId, childInvocationId, target.kind, target.id])
	const stream = await context.targetDispatcher.open({ target, input, invocation: Object.freeze({ sessionId: childSessionId,
		invocationId: childInvocationId, rootRunId: context.rootRunId, parentRunId: context.runId,
		...(context.caller.kind === 'agent' ? { parentAgentId: context.caller.agentId } : { parentWorkflowId: context.caller.workflowId }),
		depth: context.depth + 1, remainingDepth: Math.max(0, context.remainingDepth - 1),
		...(context.identity === undefined ? {} : { identity: context.identity }), ...(context.trace === undefined ? {} : { trace: context.trace }),
		...(context.deadline === undefined ? {} : { deadline: context.deadline }), signal: context.signal }) })
	const consumed = await consumeHarnessTargetStream({ stream, signal: context.signal, parentRunId: context.runId,
		childInvocationId, relay: event => context.relayChildEvent(event) })
	if (consumed.outcome.status === 'interrupted') {
		const interruption = createHarnessChildTargetInterruption(childInvocationId, consumed.outcome)
		throw attachHarnessChildTargetHostFrame(interruption, Object.freeze({ kind: 'host-tool', runId: context.runId,
			caller: context.caller, invocationId: context.invocationId, hostToolInvocationId, toolId: definition.id,
			callId: context.callId, input: hostToolWireInput, bindingId: binding.id, bindingContractDigest: binding.contractDigest,
			toolStarted: true, activeNestedCall: Object.freeze({ callId,
				target: Object.freeze({ kind: target.kind, id: target.id }), route, input,
				childRunId: consumed.outcome.runId, childInvocationId, childSessionId,
				childInterruptId: consumed.outcome.interrupt.id,
				childInterruptRevision: consumed.outcome.interrupt.revision }) }))
	}
	const outcome: HostNestedTargetStoredOutcomeV1 = consumed.outcome.status === 'completed'
		? Object.freeze({ status: 'completed', output: consumed.outcome.output })
		: consumed.outcome.status === 'cancelled'
			? Object.freeze({ status: 'cancelled', error: Object.freeze({ code: 'OPERATION_CANCELLED' as const,
				message: 'Host nested target call was cancelled.' as const, category: 'cancelled' as const, retriable: false as const,
				meta: Object.freeze({ scope: target.kind }) }) })
			: Object.freeze({ status: 'failed', error: hostFailure(context, definition, callId, target) })
	return Object.freeze({ schemaVersion: 1, kind: 'host_nested_target', toolCallId: context.callId, callId,
		target: Object.freeze({ kind: target.kind, id: target.id }), route, input, outcome,
		lineage: Object.freeze({ rootRunId: context.rootRunId, callerRunId: context.runId, hostToolInvocationId,
			childRunId: consumed.lineage.childRunId, childInvocationId }) })
}

function replayHostRecord(record: HostNestedTargetCheckpointV1, target: AnyHarnessTargetContract, route: HarnessTargetRouteReceiptV1, canonicalInput: string,
	callId: string, hostToolInvocationId: string, context: ToolInvocationContext,
	definition: HostToolDefinition<any, any, any, any>): JsonValue {
	const parsed = parseHostRecord(record)
	const expectedChildInvocationId = opaqueId('invocation', ['harness.host-child-invocation.v1', hostToolInvocationId,
		parsed.callId, parsed.target.kind, parsed.target.id])
	if (parsed.toolCallId !== context.callId || parsed.callId !== callId
		|| parsed.lineage.rootRunId !== context.rootRunId || parsed.lineage.callerRunId !== context.runId
		|| parsed.lineage.hostToolInvocationId !== hostToolInvocationId
		|| parsed.lineage.childInvocationId !== expectedChildInvocationId) invalidHostRecord()
	if (parsed.target.kind !== target.kind || parsed.target.id !== target.id) throw new HostNestedTargetReplayConflictError({
		reason: 'target_mismatch', caller: context.caller, caller_run_id: context.runId, tool_id: definition.id, tool_call_id: context.callId, call_id: parsed.callId,
		expected_target_kind: parsed.target.kind, expected_target_id: parsed.target.id,
		received_target_kind: target.kind, received_target_id: target.id,
	})
	if (canonicalJson(parsed.route as unknown as JsonValue) !== canonicalJson(route as unknown as JsonValue)) {
		throw new HarnessTargetRouteReceiptMismatchError({ reason: 'route_receipt_mismatch',
			target_kind: target.kind, target_id: target.id })
	}
	if (canonicalJson(parsed.input) !== canonicalInput) throw new HostNestedTargetReplayConflictError({
		reason: 'input_mismatch', caller: context.caller, caller_run_id: context.runId, tool_id: definition.id, tool_call_id: context.callId, call_id: parsed.callId,
		expected_target_kind: parsed.target.kind, expected_target_id: parsed.target.id,
		received_target_kind: target.kind, received_target_id: target.id,
	})
	if (parsed.outcome.status === 'completed') return parsed.outcome.output
	if (parsed.outcome.status === 'cancelled') {
		if (parsed.outcome.error.meta.scope !== parsed.target.kind) invalidHostRecord()
		throw new OperationCancelledError('Host nested target call was cancelled.', parsed.outcome.error.meta)
	}
	const meta = parsed.outcome.error.meta
	if (canonicalJson(meta.caller as unknown as JsonValue) !== canonicalJson(context.caller as unknown as JsonValue)
		|| meta.caller_run_id !== context.runId || meta.tool_id !== definition.id || meta.tool_call_id !== context.callId
		|| meta.call_id !== parsed.callId || meta.target_kind !== parsed.target.kind || meta.target_id !== parsed.target.id) invalidHostRecord()
	throw new HostNestedTargetError(parsed.outcome.error.meta)
}

function parseHostRecord(value: unknown): HostNestedTargetCheckpointV1 {
	if (!isJsonValue(value) || !plain(value)
		|| !exactKeys(value, ['schemaVersion', 'kind', 'toolCallId', 'callId', 'target', 'route', 'input', 'outcome', 'lineage'])
		|| value['schemaVersion'] !== 1 || value['kind'] !== 'host_nested_target'
		|| !nonempty(value['toolCallId']) || !nonempty(value['callId']) || !isJsonValue(value['input'])) invalidHostRecord()
	const target = value['target']
	if (!plain(target) || !exactKeys(target, ['kind', 'id'])
		|| !['agent', 'workflow'].includes(String(target['kind'])) || !nonempty(target['id'])) invalidHostRecord()
	if (!validRouteReceipt(value['route'], target as { kind: 'agent' | 'workflow'; id: string })) invalidHostRecord()
	const lineage = value['lineage']
	if (!plain(lineage) || !exactKeys(lineage, ['rootRunId', 'callerRunId', 'hostToolInvocationId', 'childRunId', 'childInvocationId'])
		|| !['rootRunId', 'callerRunId', 'hostToolInvocationId', 'childRunId', 'childInvocationId'].every(key => nonempty(lineage[key]))) invalidHostRecord()
	const outcome = value['outcome']
	if (!plain(outcome) || typeof outcome['status'] !== 'string') invalidHostRecord()
	if (outcome['status'] === 'completed') {
		if (!exactKeys(outcome, ['status', 'output']) || !isJsonValue(outcome['output'])) invalidHostRecord()
	} else if (outcome['status'] === 'failed') {
		if (!exactKeys(outcome, ['status', 'error']) || !validStoredHostFailure(outcome['error'])) invalidHostRecord()
	} else if (outcome['status'] === 'cancelled') {
		if (!exactKeys(outcome, ['status', 'error']) || !validStoredHostCancellation(outcome['error'])) invalidHostRecord()
	} else invalidHostRecord()
	return deepFreezeJsonCopy(value) as unknown as HostNestedTargetCheckpointV1
}

function validStoredHostFailure(value: unknown): boolean {
	if (!plain(value) || !exactKeys(value, ['code', 'message', 'category', 'retriable', 'meta'])
		|| value['code'] !== 'HOST_NESTED_TARGET_FAILED' || value['message'] !== 'Host nested target failed.'
		|| value['category'] !== 'internal' || value['retriable'] !== false) return false
	const meta = value['meta']
	return plain(meta) && exactKeys(meta, ['reason', 'caller', 'caller_run_id', 'tool_id', 'tool_call_id', 'call_id', 'target_kind', 'target_id'])
		&& meta['reason'] === 'target_failed' && validCaller(meta['caller']) && nonempty(meta['caller_run_id']) && nonempty(meta['tool_id'])
		&& nonempty(meta['tool_call_id']) && nonempty(meta['call_id'])
		&& ['agent', 'workflow'].includes(String(meta['target_kind'])) && nonempty(meta['target_id'])
}

function validStoredHostCancellation(value: unknown): boolean {
	if (!plain(value) || !exactKeys(value, ['code', 'message', 'category', 'retriable', 'meta'])
		|| value['code'] !== 'OPERATION_CANCELLED' || value['message'] !== 'Host nested target call was cancelled.'
		|| value['category'] !== 'cancelled' || value['retriable'] !== false) return false
	const meta = value['meta']
	return plain(meta) && exactKeys(meta, ['scope']) && ['agent', 'workflow'].includes(String(meta['scope']))
}

function requireRouteReceipt(value: unknown, target: AnyHarnessTargetContract): HarnessTargetRouteReceiptV1 {
	if (!validRouteReceipt(value, target) || !Object.isFrozen(value) || !Object.isFrozen(value.target)) {
		throw new HarnessConfigError('Target dispatcher returned an invalid route receipt.', {
			reason: 'invalid_target_dispatcher', path: 'hostBindings.targetDispatcher',
		})
	}
	return value
}

function validRouteReceipt(value: unknown, target: Readonly<{ kind: 'agent' | 'workflow'; id: string }>): value is HarnessTargetRouteReceiptV1 {
	if (!plain(value) || !exactKeys(value, ['schemaVersion', 'kind', 'target', 'bindingDigest'])
		|| value['schemaVersion'] !== 1 || value['kind'] !== 'harness_target_route'
		|| typeof value['bindingDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value['bindingDigest'])) return false
	const receiptTarget = value['target']
	return plain(receiptTarget) && exactKeys(receiptTarget, ['kind', 'id'])
		&& receiptTarget['kind'] === target.kind && receiptTarget['id'] === target.id
}

function invalidHostRecord(): never { throw new InternalError('Stored host nested target checkpoint is invalid.') }

function validCaller(value: unknown): value is HarnessExecutionCaller {
	if (!plain(value)) return false
	if (value['kind'] === 'workflow') return exactKeys(value, ['kind', 'workflowId']) && nonempty(value['workflowId'])
	return value['kind'] === 'agent' && exactKeys(value, value['workflowId'] === undefined ? ['kind', 'agentId'] : ['kind', 'agentId', 'workflowId'])
		&& nonempty(value['agentId']) && (value['workflowId'] === undefined || nonempty(value['workflowId']))
}

function hostFailure(context: ToolInvocationContext, definition: HostToolDefinition<any, any, any, any>, callId: string, target: AnyHarnessTargetContract) {
	return Object.freeze({ code: 'HOST_NESTED_TARGET_FAILED' as const, message: 'Host nested target failed.' as const,
		category: 'internal' as const, retriable: false as const, meta: Object.freeze({ reason: 'target_failed' as const,
			caller: context.caller, caller_run_id: context.runId, tool_id: definition.id, tool_call_id: context.callId, call_id: callId,
			target_kind: target.kind, target_id: target.id }) })
}

function validateHostedRequest(value: unknown, graph: NonNullable<ReturnType<typeof getHarnessRuntimeBlueprint>>['graph']): HostedInvokeOptions {
	if (!plain(value)) throw new ValidationError('Hosted invocation request is invalid.', { where: 'invoke_options', issues: { reason: 'invalid_hosted_request' } })
	for (const field of ['target', 'input', 'invokeOptions', 'hostInvocation']) if (!Object.prototype.hasOwnProperty.call(value, field)) {
		throw new ValidationError('Hosted invocation request is invalid.', { where: 'invoke_options', issues: { reason: 'invalid_hosted_request', field } })
	}
	const unknown = Reflect.ownKeys(value).filter(key => typeof key !== 'string' || !['target', 'input', 'invokeOptions', 'hostInvocation'].includes(key)).map(String).sort(codePointCompare)[0]
	if (unknown !== undefined) throw new ValidationError('Hosted invocation request is invalid.', { where: 'invoke_options', issues: { reason: 'invalid_hosted_request', field: unknown } })
	const target = value['target'] as AnyHarnessTargetContract
	const identity = getDefinitionIdentity(target)
	const known = identity === undefined ? undefined : [...Object.values(graph.agents), ...Object.values(graph.workflows)]
		.find(candidate => getDefinitionIdentity(candidate)?.token === identity.token && candidate.contract === target)
	if (known === undefined) throw new ValidationError('Hosted target is not part of this Harness graph.', { where: 'invoke_options', issues: { reason: 'unknown_hosted_target' } })
	if (!isJsonValue(value['input'])) throw new ValidationError('Harness target input must be JSON.', { where: target.kind === 'agent' ? 'agent_input' : 'workflow_input', issues: { reason: 'non_json_input' } })
	const invokeOptions = value['invokeOptions']
	if (!plain(invokeOptions)) throw new ValidationError('Hosted invocation request is invalid.', { where: 'invoke_options', issues: { reason: 'invalid_hosted_request' } })
	for (const field of ['traceparent', 'tracestate'] as const) if (Object.prototype.hasOwnProperty.call(invokeOptions, field)) {
		throw new ValidationError('Hosted invocation cannot supply host-owned trace context.', { where: 'invoke_options', issues: { reason: 'host_owned_trace_context', field } })
	}
	const sessionId = invokeOptions['sessionId']
	if (typeof sessionId !== 'string' || sessionId.length === 0) throw new ValidationError('Invocation options are invalid.', {
		where: 'invoke_options', issues: { reason: 'invalid_invoke_options' },
	})
	const { sessionId: _sessionId, ...ordinaryOptions } = invokeOptions
	const normalized = normalizeInvokeOptions(ordinaryOptions as InvokeOptions)
	const { traceparent: _traceparent, tracestate: _tracestate, ...hostedOptions } = normalized
	return Object.freeze({ sessionId, ...hostedOptions })
}

function validateHostedDispatchedRequest(
	value: unknown,
	graph: NonNullable<ReturnType<typeof getHarnessRuntimeBlueprint>>['graph'],
	defaultMaxDepth: number,
): Readonly<{
	delivery: 'fresh' | 'resume'
	input?: JsonValue
	wireInput: JsonValue
	invocation: HostedDispatchInvocation
	resume?: ToolApprovalResume
}> {
	const invalid = (field?: string): never => { throw hostedDispatchValidationError(field) }
	if (!plain(value)) throw hostedDispatchValidationError()
	const request = value
	for (const field of ['delivery', 'target', 'wireInput', 'invocation', 'hostInvocation']) {
		if (!Object.prototype.hasOwnProperty.call(request, field)) invalid(field)
	}
	const requestKeys = ['delivery', 'target', 'wireInput', 'input', 'invocation', 'resume', 'hostInvocation']
	const unknownRequestField = Reflect.ownKeys(request)
		.filter(key => typeof key !== 'string' || !requestKeys.includes(key)).map(String).sort(codePointCompare)[0]
	if (unknownRequestField !== undefined) invalid(unknownRequestField)
	const target = request['target'] as AnyHarnessTargetContract
	const identity = getDefinitionIdentity(target)
	const known = identity === undefined ? undefined : [...Object.values(graph.agents), ...Object.values(graph.workflows)]
		.find(candidate => getDefinitionIdentity(candidate)?.token === identity.token && candidate.contract === target)
	if (known === undefined) throw new ValidationError('Hosted target is not part of this Harness graph.', {
		where: 'invoke_options', issues: { reason: 'unknown_hosted_target' },
	})
	if (!isJsonValue(request['wireInput'])) throw new ValidationError('Harness target input must be JSON.', {
		where: target.kind === 'agent' ? 'agent_input' : 'workflow_input', issues: { reason: 'non_json_input' },
	})
	const deliveryValue = request['delivery']
	if (deliveryValue !== 'fresh' && deliveryValue !== 'resume') throw hostedDispatchValidationError('delivery')
	const delivery: 'fresh' | 'resume' = deliveryValue
	if (delivery === 'fresh') {
		if (!Object.prototype.hasOwnProperty.call(request, 'input') || Object.prototype.hasOwnProperty.call(request, 'resume')) invalid('delivery')
		if (!isJsonValue(request['input'])) throw new ValidationError('Harness target input must be JSON.', {
			where: target.kind === 'agent' ? 'agent_input' : 'workflow_input', issues: { reason: 'non_json_input' },
		})
	} else if (Object.prototype.hasOwnProperty.call(request, 'input') || !Object.prototype.hasOwnProperty.call(request, 'resume')) invalid('delivery')
	const invocationValue = request['invocation']
	if (!plain(invocationValue)) throw hostedDispatchValidationError('invocation')
	const invocation = invocationValue
	const required = ['sessionId', 'invocationId', 'rootRunId', 'parentRunId', 'depth', 'remainingDepth', 'signal']
	for (const field of required) if (!Object.prototype.hasOwnProperty.call(invocation, field)) invalid(`invocation.${field}`)
	const invocationKeys = [...required, 'parentAgentId', 'parentWorkflowId', 'deadline', 'idempotencyKey']
	const unknownInvocationField = Reflect.ownKeys(invocation)
		.filter(key => typeof key !== 'string' || !invocationKeys.includes(key)).map(String).sort(codePointCompare)[0]
	if (unknownInvocationField !== undefined) invalid(`invocation.${unknownInvocationField}`)
	for (const field of ['sessionId', 'invocationId', 'rootRunId', 'parentRunId'] as const) {
		if (!nonempty(invocation[field])) invalid(`invocation.${field}`)
	}
	const parentAgentId = invocation['parentAgentId']
	const parentWorkflowId = invocation['parentWorkflowId']
	if ((parentAgentId === undefined) === (parentWorkflowId === undefined)
		|| (parentAgentId !== undefined && !nonempty(parentAgentId))
		|| (parentWorkflowId !== undefined && !nonempty(parentWorkflowId))) invalid('invocation.parentTarget')
	if (!Number.isSafeInteger(invocation['depth']) || (invocation['depth'] as number) < 1) invalid('invocation.depth')
	if (!Number.isSafeInteger(invocation['remainingDepth']) || (invocation['remainingDepth'] as number) < 0) invalid('invocation.remainingDepth')
	if (invocation['deadline'] !== undefined && (!Number.isSafeInteger(invocation['deadline']) || (invocation['deadline'] as number) <= 0)) invalid('invocation.deadline')
	if (invocation['idempotencyKey'] !== undefined && !nonempty(invocation['idempotencyKey'])) invalid('invocation.idempotencyKey')
	const signal = invocation['signal']
	if (!objectValue(signal) || typeof signal['aborted'] !== 'boolean'
		|| typeof signal['addEventListener'] !== 'function' || typeof signal['removeEventListener'] !== 'function') invalid('invocation.signal')
	let resume: ToolApprovalResume | undefined
	if (delivery === 'resume') {
		resume = normalizeToolApprovalResume(request['resume'])
		if (resume.runId !== invocation['invocationId']) invalid('resume')
	}
	const configuredMaxDepth = known.kind === 'agent' ? known.loop?.maxDepth ?? defaultMaxDepth : known.maxDepth ?? defaultMaxDepth
	const validatedInvocation = Object.freeze({ ...invocation,
		remainingDepth: Math.min(invocation['remainingDepth'] as number, configuredMaxDepth),
	}) as HostedDispatchInvocation
	return Object.freeze({ delivery, wireInput: request['wireInput'],
		...(delivery === 'fresh' ? { input: request['input'] as JsonValue } : {}),
		invocation: validatedInvocation, ...(resume === undefined ? {} : { resume }) })
}

function hostedDispatchValidationError(field?: string): ValidationError {
	return new ValidationError('Hosted dispatch request is invalid.', {
		where: 'invoke_options', issues: Object.freeze({ reason: 'invalid_hosted_dispatch_request', ...(field === undefined ? {} : { field }) }),
	})
}

function validateHostBindings(value: unknown): asserts value is HarnessHostBindings<unknown, unknown> {
	if (!objectValue(value)) throw hostBindingError('invalid_host_binding', 'hostBindings')
	const keys = ['hostOwner', 'targetDispatcher', 'projectIdentity', 'projectTraceContext', 'createHostContext', 'logger', 'telemetry']
	const unknown = Reflect.ownKeys(value).filter(key => typeof key !== 'string' || !keys.includes(key)).map(String).sort(codePointCompare)[0]
	if (unknown !== undefined) throw hostBindingError('unexpected_host_binding', `hostBindings.${unknown}`)
	const requireField = (key: string) => {
		if (!Object.prototype.hasOwnProperty.call(value, key)) throw hostBindingError('missing_host_binding', `hostBindings.${key}`)
	}
	requireField('hostOwner')
	if (!isHostOwnerToken(value['hostOwner'])) throw hostBindingError('invalid_host_binding', 'hostBindings.hostOwner')
	requireField('targetDispatcher')
	if (!objectValue(value['targetDispatcher']) || typeof value['targetDispatcher']['assertTarget'] !== 'function'
		|| typeof value['targetDispatcher']['open'] !== 'function' || typeof value['targetDispatcher']['openPersisted'] !== 'function') {
		throw hostBindingError('invalid_host_binding', 'hostBindings.targetDispatcher')
	}
	for (const key of ['projectIdentity', 'projectTraceContext', 'createHostContext']) {
		requireField(key)
		if (typeof value[key] !== 'function') throw hostBindingError('invalid_host_binding', `hostBindings.${key}`)
	}
	requireField('logger')
	const logger = value['logger']
	if (!objectValue(logger) || ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'child'].some(key => typeof logger[key] !== 'function')) throw hostBindingError('invalid_host_binding', 'hostBindings.logger')
	requireField('telemetry')
	const telemetry = value['telemetry']
	if (!objectValue(telemetry) || ['span', 'recordHistogram', 'recordCounter', 'currentTraceparent'].some(key => typeof telemetry[key] !== 'function')) throw hostBindingError('invalid_host_binding', 'hostBindings.telemetry')
}

function hostBindingError(reason: string, path: string): HarnessConfigError {
	return new HarnessConfigError('Hosted Harness bindings are invalid.', { reason, path })
}
function hostCallKey(invocationId: string, callId: string): string { return `host:call:${hash(['harness.host-call-key.v1', invocationId, callId])}` }
function hostStepKey(invocationId: string, stepId: string): string { assertStepId(stepId); return `host:step:${hash(['harness.host-step-key.v1', invocationId, stepId])}` }
function opaqueId(kind: 'invocation' | 'session', value: JsonValue): string { return `${kind}_${hash(value)}` }
function hash(value: JsonValue): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }
function assertStepId(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new ValidationError('Host nested call id is invalid.', { where: 'invoke_options', issues: { reason: 'invalid_host_call_id' } })
}
function plain(value: unknown): value is Record<string, unknown> { if (typeof value !== 'object' || value === null || Array.isArray(value)) return false; const p = Object.getPrototypeOf(value); return p === Object.prototype || p === null }
function objectValue(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Reflect.ownKeys(value)
	return actual.length === expected.length && actual.every(key => typeof key === 'string' && expected.includes(key))
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function deepFreezeJsonCopy(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeJsonCopy)) as JsonValue
	if (plain(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, deepFreezeJsonCopy(child as JsonValue)])))
	return value
}
function codePointCompare(left: string, right: string): number { const a = Array.from(left, c => c.codePointAt(0)!); const b = Array.from(right, c => c.codePointAt(0)!); for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return a.length - b.length }
function immutableIdentityMap(rows: readonly (readonly [object, AgentExecutableBinding])[]): ReadonlyMap<object, AgentExecutableBinding> {
	const map = new Map(rows)
	let view!: ReadonlyMap<object, AgentExecutableBinding>
	view = Object.freeze({ get: (key: object) => map.get(key), has: (key: object) => map.has(key), get size() { return map.size },
		entries: () => map.entries(), keys: () => map.keys(), values: () => map.values(), [Symbol.iterator]: () => map[Symbol.iterator](),
		forEach: (callback: (value: AgentExecutableBinding, key: object, map: ReadonlyMap<object, AgentExecutableBinding>) => void, thisArg?: unknown) => map.forEach((value, key) => callback.call(thisArg, value, key, view)),
	})
	return view
}
