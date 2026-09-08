import { createHash } from 'node:crypto'

import type { AnyAgentDefinition, AnyToolDefinition, AnyWorkflowDefinition, ChildTaskDescriptor, ChildTaskHandle, ChildTaskStatus, ContinuableChildTaskHandle, WorkflowAgentMap, WorkflowContext, WorkflowModelMap, WorkflowModelCallOptions, WorkflowToolDefinitions } from '../definitions/types.js'
import type { ExecutionEvent } from '../definitions/execution-events.js'
import { AgentLoopBudgetError, AgentNotFoundError, ChildTaskConflictError, ChildTaskStateError, HarnessError, InternalError, OperationCancelledError, OperationTimeoutError, ValidationError, WorkflowAgentCallBudgetError, WorkflowCallReplayConflictError, WorkflowManagedCallError } from '../errors/index.js'
import type { HarnessIdentity } from '../identity/index.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type { ChildTaskRecordMetadataV1, RunRecord, SerializedError } from '../models/state.js'
import type { ModelHandle, ModelInvokeContext } from '../models/registry.js'
import type { EmbeddingRequest, EmbeddingResponse, ImageRequest, ImageResponse, ObjectRequest, ObjectResponse, ObjectStreamChunk, RerankRequest, RerankResponse, SpeechRequest, SpeechResponse, TextRequest, TextResponse, TextStreamChunk, VideoRequest, VideoResponse, VideoStreamChunk } from '../ports/model-provider.js'
import type { HarnessTargetDispatcher } from '../ports/target-dispatcher.js'
import type { HarnessTraceContext } from '../telemetry/trace-context.js'
import { abortError, withAbortSignal } from '../runtime/abort.js'
import { canonicalJson } from '../runtime/canonical-json.js'
import { projectHarnessExecutionCaller } from '../runtime/execution-caller.js'
import type { ResolvedHarnessExecutionDefaults } from '../runtime/execution-defaults.js'
import type { CompiledApprovalInventory } from '../runtime/compiled-graph.js'
import { consumeHarnessTargetStream } from '../runtime/subagent-execution.js'
import { createHarnessChildTargetInterruption, isHarnessChildTargetInterruption, type WorkflowAgentCallBudgetStateV1, type WorkflowChildCheckpointAccess } from '../runtime/steps.js'
import type { HarnessStorage } from '../storage/types.js'
import type { SandboxPolicy } from '../sandbox/ownership.js'
import type { WorkflowCallCheckpointV1, WorkflowCallPublicationCheckpointV1, WorkflowCallStoredOutcomeV1, WorkflowManagedCallOperation } from '../storage/execution.js'
import type { ModelSchema } from '../schema/index.js'
import { validateSchema } from '../schema/validation.js'
import { getDefinitionIdentity } from '../definitions/identity.js'
import type { AgentExecutableBinding, WorkflowToolInvocationContext } from '../tools/bindings.js'

type CallOperation = WorkflowManagedCallOperation | 'child_task_start'
type ManagedTargetKind = 'agent' | 'tool' | 'model'
type CallTuple = Readonly<{ operation: CallOperation; targetKind: ManagedTargetKind; targetId: string; input: JsonValue; inputCanonical: string; idempotencyKey: string | null; optionsCanonical: string }>
type CallEntry = Readonly<{ tuple: CallTuple; promise: Promise<unknown> }>
type ChildLaunchRequest = Readonly<{ kind: 'inline' | 'background'; agent: AnyAgentDefinition;
	childInvocationId: string; childSessionId: string; taskRunId: string; policy?: SandboxPolicy<string> }>

export interface WorkflowRuntimeOptions<Agents extends WorkflowAgentMap | undefined, Tools extends WorkflowToolDefinitions | undefined, Models extends WorkflowModelMap | undefined> {
	readonly workflow: AnyWorkflowDefinition & Readonly<{ agents?: Agents; tools?: Tools; models?: Models }>
	readonly models: Models extends WorkflowModelMap ? { readonly [K in keyof Models]: ModelHandle<Models[K]> } : Record<never, never>
	readonly toolBindings?: Readonly<Record<string, AgentExecutableBinding>>
	readonly toolContext?: Omit<WorkflowToolInvocationContext, 'step' | 'toolId' | 'callId' | 'idempotencyKey' | 'signal'>
	readonly targetDispatcher: HarnessTargetDispatcher
	readonly signal: AbortSignal
	readonly lifecycleSignal?: AbortSignal
	readonly sessionId: string
	readonly runId: string
	readonly rootRunId: string
	readonly invocationId: string
	readonly depth: number
	readonly remainingDepth: number
	readonly defaults: Pick<ResolvedHarnessExecutionDefaults, 'maxWorkflowAgentCalls' | 'maxParallelWorkflowAgentCalls'>
		& Partial<Pick<ResolvedHarnessExecutionDefaults, 'toolTimeoutMs' | 'modelTimeoutMs'>>
	readonly identity?: HarnessIdentity
	readonly trace?: HarnessTraceContext
	readonly deadline?: number
	readonly checkpoint?: WorkflowChildCheckpointAccess
	readonly storage?: HarnessStorage
	readonly durable?: boolean
	readonly emit?: (event: UncorrelatedExecutionEvent) => Promise<void>
	readonly relayChildEvent?: (event: ExecutionEvent) => Promise<void>
	/** @internal Authorization fence and sandbox handoff installed before any child effect. */
	readonly prepareChildLaunch?: (request: ChildLaunchRequest) => Promise<void>
	/** @internal Authorization-only acceptance fence used before reserving a continuable turn. */
	readonly authorizeChildLaunch?: (request: ChildLaunchRequest) => Promise<void>
	/** @internal Removes a handoff that was not consumed by the dispatcher. */
	readonly finishChildLaunch?: (childInvocationId: string) => void
	/** @internal Runs background child cleanup only after its terminal record/event commit. */
	readonly onChildTaskTerminal?: (childSessionId: string) => Promise<void>
	readonly now?: () => Date
	readonly taskRegistry?: Map<string, ChildTaskHandle<JsonValue>>
	readonly restoredAgentCallBudget?: WorkflowAgentCallBudgetStateV1
	/** @internal Direct workflow host-tool calls whose input/start lifecycle was persisted before interruption. */
	readonly restoredToolCallIds?: readonly string[]
	readonly approval: CompiledApprovalInventory['agents']
}

type UncorrelatedExecutionEvent = ExecutionEvent extends infer Event
	? Event extends ExecutionEvent ? Omit<Event, 'eventId' | 'sequence'> : never
	: never

type AgentInvokers<Agents extends WorkflowAgentMap | undefined> = WorkflowContext<ModelSchema, ModelSchema, Agents, undefined, undefined, readonly [], undefined>['agents']
type ToolInvokers<Tools extends WorkflowToolDefinitions | undefined> = WorkflowContext<ModelSchema, ModelSchema, undefined, Tools, undefined, readonly [], undefined>['tools']
type RuntimeChildTasks<Agents extends WorkflowAgentMap | undefined> = WorkflowContext<ModelSchema, ModelSchema, Agents, undefined, undefined, readonly string[], undefined>['childTasks']

/** Package-private workflow execution surface assembled into the public handler context by H4-008. */
export interface WorkflowExecutionRuntime<Agents extends WorkflowAgentMap | undefined, Tools extends WorkflowToolDefinitions | undefined, Models extends WorkflowModelMap | undefined> {
	readonly agents: AgentInvokers<Agents>
	readonly tools: ToolInvokers<Tools>
	readonly models: WorkflowContext<ModelSchema, ModelSchema, undefined, undefined, Models, readonly [], undefined>['models']
	readonly childTasks: RuntimeChildTasks<Agents>
	readonly fanOut: WorkflowContext<ModelSchema, ModelSchema, Agents, undefined, undefined, readonly [], undefined>['fanOut']
	/** Package-private state persisted by the H4-008 continuation owner. */
	agentCallBudgetState(): WorkflowAgentCallBudgetStateV1
	/** Package-private ordered logical calls still suspended below this workflow frame. */
	activeCallIds(): readonly string[]
}

/** @internal Reconstructs the owner-only session view of one persisted child task. */
export function restoreSessionChildTaskHandle(record: RunRecord, expectedSessionId: string): ChildTaskHandle<JsonValue> | undefined {
	if (record.kind !== 'child_task' || record.sessionId !== expectedSessionId) return undefined
	const metadata = record.metadata
	try {
		if (!isPlainRecord(metadata) || !exactKeys(metadata, ['schemaVersion', 'kind', 'parentRunId', 'workflowId', 'workflowInvocationId', 'callId',
			'agentId', 'modelAlias', 'mode', 'context', 'timeoutMs', 'idempotencyKey', 'createdAt'])
			|| metadata['schemaVersion'] !== 1 || metadata['kind'] !== 'workflow_child_task'
			|| !nonempty(metadata['parentRunId']) || !nonempty(metadata['workflowId']) || !nonempty(metadata['workflowInvocationId'])
			|| !nonempty(metadata['agentId']) || !nonempty(metadata['modelAlias']) || metadata['agentId'] !== record.target
			|| typeof metadata['callId'] !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(metadata['callId'])
			|| metadata['mode'] !== 'one_shot' && metadata['mode'] !== 'continuable' || metadata['context'] !== 'isolated'
			|| metadata['timeoutMs'] !== null && (!Number.isSafeInteger(metadata['timeoutMs']) || (metadata['timeoutMs'] as number) <= 0)
			|| metadata['idempotencyKey'] !== null && (typeof metadata['idempotencyKey'] !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(metadata['idempotencyKey']))
			|| record.startedAt !== metadata['createdAt'] || !validTimestamp(metadata['createdAt']) || !isJsonValue(record.input)
			|| !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error()
		const base = ['id', 'sessionId', 'kind', 'target', 'startedAt', 'status', 'revision', 'input', 'metadata']
		if (record.status === 'running') { if (!exactKeys(record, base)) throw new Error() }
		else if (record.status === 'succeeded') { if (!exactKeys(record, [...base, 'finishedAt', 'output']) || !validTimestamp(record.finishedAt) || !isJsonValue(record.output)) throw new Error() }
		else if (record.status === 'failed' || record.status === 'cancelled') {
			if (!exactKeys(record, [...base, 'finishedAt', 'error']) || !validTimestamp(record.finishedAt)
				|| !validChildStoredError(record.error, record.status, metadata['workflowId'] as string, metadata['callId'],
					metadata['agentId'] as string, metadata['timeoutMs'] as number | null)) throw new Error()
		} else throw new Error()
		const descriptor = Object.freeze<ChildTaskDescriptor>({ id: record.id, parentRunId: metadata['parentRunId'] as string,
			sessionId: expectedSessionId, workflowId: metadata['workflowId'] as string, workflowInvocationId: metadata['workflowInvocationId'] as string,
			callId: metadata['callId'], agentId: metadata['agentId'] as string, modelAlias: metadata['modelAlias'] as string,
			contextPolicy: 'isolated', mode: metadata['mode'], createdAt: metadata['createdAt'] as string })
		if (record.status !== 'running') return terminalTaskHandle(descriptor, record)
		const status = Object.freeze<ChildTaskStatus>({ descriptor, status: 'running' })
		const unavailable = () => Promise.reject(new ChildTaskStateError({ reason: 'recovery_required', task_id: record.id,
			workflow_id: descriptor.workflowId, agent_id: descriptor.agentId }))
		return Object.freeze({ id: record.id, status: async () => status, result: unavailable, cancel: unavailable })
	} catch (error) {
		if (error instanceof ChildTaskStateError) throw error
		throw new ChildTaskStateError({ reason: 'invalid_record', task_id: record.id })
	}
}

/** Creates one isolated, replay-aware orchestration state for one logical workflow invocation. */
export function createWorkflowExecutionRuntime<Agents extends WorkflowAgentMap | undefined, Tools extends WorkflowToolDefinitions | undefined, Models extends WorkflowModelMap | undefined>(
	options: WorkflowRuntimeOptions<Agents, Tools, Models>,
): WorkflowExecutionRuntime<Agents, Tools, Models> {
	const workflow = options.workflow
	const maxCalls = workflow.agentCalls?.maxCalls ?? options.defaults.maxWorkflowAgentCalls ?? 32
	const maxParallel = workflow.agentCalls?.maxParallel ?? options.defaults.maxParallelWorkflowAgentCalls ?? 8
	const restoredUsedCalls = validateRestoredBudget(options.restoredAgentCallBudget, maxCalls)
	const budget = new WorkflowCallAdmission(workflow.id, maxCalls, maxParallel, restoredUsedCalls)
	const calls = new Map<string, CallEntry>()
	const activeCalls = new Set<string>()
	const restoredToolCalls = new Set(options.restoredToolCallIds ?? [])
	const liveTasks = options.taskRegistry ?? new Map<string, ChildTaskHandle<JsonValue>>()
	let sequence = 0

	const agents: Record<string, { run(input: JsonValue, callOptions: WorkflowModelCallOptions): Promise<JsonValue> }> = {}
	for (const agent of workflow.agents ?? []) {
		agents[agent.id] = Object.freeze({ run: (input, callOptions) => directAgentRun(agent, input, callOptions) })
	}
	const tools: Record<string, { run(input: JsonValue, callOptions: WorkflowModelCallOptions): Promise<JsonValue> }> = {}
	for (const tool of workflow.tools ?? []) {
		const binding = options.toolBindings?.[tool.id]
		const identity = getDefinitionIdentity(tool)
		if (identity === undefined || binding === undefined || binding.definitionIdentity.token !== identity.token || binding.invokeWorkflowValidated === undefined) {
			throw new InternalError('Compiled workflow tool binding is unavailable.')
		}
		tools[tool.id] = Object.freeze({ run: (input, callOptions) => directToolRun(tool, binding, input, callOptions) })
	}

	async function directToolRun(tool: AnyToolDefinition, binding: AgentExecutableBinding, wireInput: JsonValue, callOptions: WorkflowModelCallOptions): Promise<JsonValue> {
		assertDirectOptions(callOptions)
		assertWireInput(wireInput)
		const input = await validateSchema(binding.input, wireInput, { where: 'tool_input', message: 'Tool input validation failed.' })
		if (!isJsonValue(input)) throw new ValidationError('Tool input validation failed.', { where: 'tool_input', issues: { reason: 'non_json_tool_input' } })
		const tuple = makeTuple('tool_run', 'tool', tool.id, wireInput, callOptions.idempotencyKey ?? null, normalizeDirectIdentity(callOptions))
		const existing = calls.get(callOptions.callId)
		if (existing !== undefined) {
			assertSameCall(workflow.id, callOptions.callId, existing.tuple, tuple)
			return existing.promise as Promise<JsonValue>
		}
		let admitted = false; let checkpointed = false
		activeCalls.add(callOptions.callId)
		const promise = executeTool(binding, input, wireInput, callOptions, () => { admitted = true }, () => { checkpointed = true }).then(value => {
			activeCalls.delete(callOptions.callId); return value
		}, error => { if (!isHarnessChildTargetInterruption(error)) activeCalls.delete(callOptions.callId); throw error })
		const entry = Object.freeze({ tuple, promise })
		calls.set(callOptions.callId, entry)
		void promise.catch(error => { if ((!admitted || checkpointed) && !isHarnessChildTargetInterruption(error) && calls.get(callOptions.callId) === entry) calls.delete(callOptions.callId) })
		return promise
	}

	async function executeTool(binding: AgentExecutableBinding, input: JsonValue, wireInput: JsonValue, callOptions: WorkflowModelCallOptions, admitted: () => void, checkpointed: () => void): Promise<JsonValue> {
		const toolContext = options.toolContext
		if (toolContext === undefined) throw new InternalError('Workflow tool execution context is unavailable.')
		const caller = projectHarnessExecutionCaller(toolContext.caller)
		if (caller.kind !== 'workflow') throw new ValidationError('Workflow tool caller projection is invalid.', { where: 'invoke_options', issues: { reason: 'invalid_execution_caller' } })
		const replay = await loadDirectCheckpoint(callOptions.callId, 'tool_run', 'tool', binding.id, wireInput, callOptions)
		if (replay !== undefined) { checkpointed(); await publishManagedEvents(replay); return replayDirectOutcome(replay.outcome) }
		const signal = managedSignal(options.signal, callOptions.timeoutMs ?? options.defaults.toolTimeoutMs)
		if (signal.aborted) throw abortError(signal, 'tool', 'Workflow managed call was cancelled.')
		admitted()
		const context: WorkflowToolInvocationContext = Object.freeze({ ...toolContext, caller, workflowId: workflow.id,
			step: 0, toolId: binding.id, callId: callOptions.callId, ...(callOptions.idempotencyKey === undefined ? {} : { idempotencyKey: callOptions.idempotencyKey }), signal })
		if (!restoredToolCalls.has(callOptions.callId)) {
			await options.emit?.({ type: 'tool.input.available', runId: options.runId, caller, toolId: binding.id, callId: callOptions.callId, input: wireInput })
			await options.emit?.({ type: 'tool.started', runId: options.runId, caller, toolId: binding.id, callId: callOptions.callId, input: wireInput })
		}
		let output: JsonValue
		try {
			const raw = await toolContext.telemetry.span('harness.tool.execute', {
				'harness.name': toolContext.harnessName, 'harness.session.id': options.sessionId, 'harness.run.id': options.runId,
				'harness.workflow.id': workflow.id, 'harness.tool.id': binding.id, 'harness.call.id': callOptions.callId,
			}, () => withAbortSignal(signal, 'tool', 'Workflow managed call was cancelled.', () => binding.invokeWorkflowValidated!(context, input, wireInput)))
			output = await validateSchema(binding.output, raw, { where: 'tool_output', message: 'Tool output validation failed.' })
			if (!isJsonValue(output)) throw new ValidationError('Tool output validation failed.', { where: 'tool_output', issues: { reason: 'non_json_tool_output' } })
		} catch (error) {
			if (isHarnessChildTargetInterruption(error)) throw error
			const cancelled = signal.aborted || error instanceof OperationCancelledError || error instanceof OperationTimeoutError
			const stored = cancelled ? storedManagedCancelled('tool') : storedManagedFailure(workflow.id, callOptions.callId, 'tool_run', 'tool', binding.id)
			const record = await commitManagedCheckpoint(callOptions.callId, 'tool_run', 'tool', binding.id, wireInput, stored,
				[{ type: 'tool.finished', runId: options.runId, caller, toolId: binding.id, callId: callOptions.callId, error: stored.error }])
			checkpointed(); await publishManagedEvents(record)
			throw replayDirectOutcomeError(stored)
		}
		const stored = Object.freeze({ status: 'completed' as const, output })
		const record = await commitManagedCheckpoint(callOptions.callId, 'tool_run', 'tool', binding.id, wireInput, stored,
			[{ type: 'tool.finished', runId: options.runId, caller, toolId: binding.id, callId: callOptions.callId, output }])
		checkpointed(); await publishManagedEvents(record); restoredToolCalls.delete(callOptions.callId)
		return output
	}

	type TextInput = Omit<TextRequest, 'model' | 'signal' | 'defaults'>
	type ObjectInput = Omit<ObjectRequest<JsonValue>, 'model' | 'signal' | 'defaults'>
	type EmbeddingInput = Omit<EmbeddingRequest, 'model' | 'signal'>
	type RerankInput = Omit<RerankRequest, 'model' | 'signal'>
	type ImageInput = Omit<ImageRequest, 'model' | 'signal'>
	type SpeechInput = Omit<SpeechRequest, 'model' | 'signal'>
	type VideoInput = Omit<VideoRequest, 'model' | 'signal'>
	type RuntimeModel = Readonly<{
		text(request: TextInput, signal: AbortSignal, context?: ModelInvokeContext): Promise<TextResponse>
		textStream(request: TextInput, signal: AbortSignal, context?: ModelInvokeContext): AsyncIterable<TextStreamChunk>
		object(request: ObjectInput, signal: AbortSignal, context?: ModelInvokeContext): Promise<ObjectResponse<JsonValue>>
		objectStream(request: ObjectInput, signal: AbortSignal, context?: ModelInvokeContext): AsyncIterable<ObjectStreamChunk<JsonValue>>
		embed(request: EmbeddingInput, signal: AbortSignal, context?: ModelInvokeContext): Promise<EmbeddingResponse>
		rerank(request: RerankInput, signal: AbortSignal, context?: ModelInvokeContext): Promise<RerankResponse>
		image(request: ImageInput, signal: AbortSignal, context?: ModelInvokeContext): Promise<ImageResponse>
		speech(request: SpeechInput, signal: AbortSignal, context?: ModelInvokeContext): Promise<SpeechResponse>
		video(request: VideoInput, signal: AbortSignal, context?: ModelInvokeContext): Promise<VideoResponse>
		videoStream(request: VideoInput, signal: AbortSignal, context?: ModelInvokeContext): AsyncIterable<VideoStreamChunk>
	}>
	type WorkflowRuntimeModel = Readonly<{
		text(request: TextInput, options: WorkflowModelCallOptions): Promise<TextResponse>
		textStream(request: TextInput, options: WorkflowModelCallOptions): AsyncIterable<TextStreamChunk>
		object(request: ObjectInput, options: WorkflowModelCallOptions): Promise<ObjectResponse<JsonValue>>
		objectStream(request: ObjectInput, options: WorkflowModelCallOptions): AsyncIterable<ObjectStreamChunk<JsonValue>>
		embed(request: EmbeddingInput, options: WorkflowModelCallOptions): Promise<EmbeddingResponse>
		rerank(request: RerankInput, options: WorkflowModelCallOptions): Promise<RerankResponse>
		image(request: ImageInput, options: WorkflowModelCallOptions): Promise<ImageResponse>
		speech(request: SpeechInput, options: WorkflowModelCallOptions): Promise<SpeechResponse>
		video(request: VideoInput, options: WorkflowModelCallOptions): Promise<VideoResponse>
		videoStream(request: VideoInput, options: WorkflowModelCallOptions): AsyncIterable<VideoStreamChunk>
	}>
	const models: Record<string, WorkflowRuntimeModel> = {}
	for (const [name, requirement] of Object.entries(workflow.models ?? {})) {
		const handle = (options.models as Readonly<Record<string, unknown>>)[name] as RuntimeModel | undefined
		if (handle === undefined) throw new InternalError('Compiled workflow model binding is unavailable.')
		const modelAlias = requirement.alias ?? name
		models[name] = Object.freeze({
			text: (request, callOptions) => managedModelValue('model_text', modelAlias, request, callOptions, (signal, context) => handle.text(request, signal, context)),
			textStream: (request, callOptions) => managedModelStream<TextStreamChunk>('model_text_stream', modelAlias, request, callOptions,
				(signal, context) => handle.textStream(request, signal, context), chunk => chunk.kind === 'delta'
					? { type: 'model.output.text.delta', runId: options.runId, caller: workflowCaller(), callId: callOptions.callId,
						id: modelStreamId(callOptions.callId), modelAlias, delta: chunk.text } : undefined),
			object: (request, callOptions) => managedModelValue('model_object', modelAlias, request, callOptions, (signal, context) => handle.object(request, signal, context)),
			objectStream: (request, callOptions) => managedObjectStream(modelAlias, request, callOptions,
				(signal, context) => handle.objectStream(request, signal, context)),
			embed: (request, callOptions) => managedModelValue('model_embed', modelAlias, request, callOptions, (signal, context) => handle.embed(request, signal, context)),
			rerank: (request, callOptions) => managedModelValue('model_rerank', modelAlias, request, callOptions, (signal, context) => handle.rerank(request, signal, context)),
			image: (request, callOptions) => managedModelValue('model_image', modelAlias, request, callOptions, (signal, context) => handle.image(request, signal, context)),
			speech: (request, callOptions) => managedModelValue('model_speech', modelAlias, request, callOptions, (signal, context) => handle.speech(request, signal, context)),
			video: (request, callOptions) => managedModelValue('model_video', modelAlias, request, callOptions, (signal, context) => handle.video(request, signal, context)),
			videoStream: (request, callOptions) => managedModelStream<VideoStreamChunk>('model_video_stream', modelAlias, request, callOptions,
				(signal, context) => handle.videoStream(request, signal, context), chunk => chunk.kind === 'queued'
					? { type: 'output.progress', runId: options.runId, caller: workflowCaller(), callId: callOptions.callId, id: modelStreamId(callOptions.callId), modelAlias, operation: 'video', state: 'queued' }
					: chunk.kind === 'progress'
						? { type: 'output.progress', runId: options.runId, caller: workflowCaller(), callId: callOptions.callId, id: modelStreamId(callOptions.callId), modelAlias, operation: 'video', state: 'running', progress: chunk.progress }
						: { type: 'output.file', runId: options.runId, caller: workflowCaller(), callId: callOptions.callId, id: chunk.artifact.id, modelAlias, operation: 'video', artifact: chunk.artifact }),
		})
	}

	function workflowCaller(): Extract<ReturnType<typeof projectHarnessExecutionCaller>, { kind: 'workflow' }> {
		if (options.toolContext === undefined) throw new InternalError('Workflow model execution context is unavailable.')
		const caller = projectHarnessExecutionCaller(options.toolContext.caller)
		if (caller.kind !== 'workflow') throw new InternalError('Workflow caller projection is invalid.')
		return caller
	}
	function modelStreamId(callId: string): string { return `model_${digest([options.runId, workflow.id, callId])}` }
	async function managedModelValue<Result>(
		operation: WorkflowManagedCallOperation, modelAlias: string, request: unknown, callOptions: WorkflowModelCallOptions,
		effect: (signal: AbortSignal, context: ModelInvokeContext) => Promise<Result>,
	): Promise<Result> {
		const output = await managedModel(operation, modelAlias, request, callOptions, async (signal, context) => ({ output: managedModelJson(await effect(signal, context), operation), events: [] }))
		return output as unknown as Result
	}
	function managedModelStream<Chunk>(
		operation: WorkflowManagedCallOperation, modelAlias: string, request: unknown, callOptions: WorkflowModelCallOptions,
		effect: (signal: AbortSignal, context: ModelInvokeContext) => AsyncIterable<Chunk>,
		activity: (chunk: Chunk) => UncorrelatedExecutionEvent | undefined,
	): AsyncIterable<Chunk> {
		return (async function* () {
			const output = await managedModel(operation, modelAlias, request, callOptions, async (signal, context) => {
				const chunks: JsonValue[] = []; const events: UncorrelatedExecutionEvent[] = []
				let sawFinish = false; let videoState: 'start' | 'queued' | 'progress' = 'start'
				for await (const chunk of effect(signal, context)) {
					let value: JsonValue
					try { value = managedModelJson(chunk, operation) }
					catch (error) {
						if (operation === 'model_text_stream' || operation === 'model_object_stream' || operation === 'model_video_stream') throw modelResponseError('malformed_chunk')
						throw error
					}
					if (operation === 'model_text_stream') validateFiniteStreamChunk(value, 'text', sawFinish)
					if (operation === 'model_video_stream') videoState = validateVideoStreamChunk(value, videoState)
					if (sawFinish) throw modelResponseError('chunk_after_finish')
					if (isPlainRecord(value) && value['kind'] === 'finish') sawFinish = true
					chunks.push(value); const event = activity(value as Chunk); if (event !== undefined) events.push(event)
				}
				if (!sawFinish) throw modelResponseError(chunks.length === 0 ? 'empty_stream' : 'missing_finish')
				return { output: chunks, events }
			})
			if (!Array.isArray(output)) throw new InternalError('Stored workflow model stream is invalid.')
			for (const chunk of output) yield chunk as unknown as Chunk
		})()
	}
	function managedObjectStream(
		modelAlias: string, request: ObjectInput, callOptions: WorkflowModelCallOptions,
		effect: (signal: AbortSignal, context: ModelInvokeContext) => AsyncIterable<ObjectStreamChunk<JsonValue>>,
	): AsyncIterable<ObjectStreamChunk<JsonValue>> {
		let snapshot: JsonValue | undefined
		return managedModelStream('model_object_stream', modelAlias, request, callOptions, effect, chunk => {
			validateFiniteStreamChunk(chunk as unknown as JsonValue, 'object', false)
			if (chunk.kind === 'partial') snapshot = snapshotJson(chunk.partial)
			else if (chunk.kind === 'delta') snapshot = applyObjectDelta(snapshot, chunk.path, chunk.value)
			else return undefined
			return { type: 'model.output.object.snapshot', runId: options.runId, caller: workflowCaller(), callId: callOptions.callId,
				id: modelStreamId(callOptions.callId), modelAlias, value: snapshot }
		})
	}
	async function managedModel(
		operation: WorkflowManagedCallOperation, modelAlias: string, rawRequest: unknown, callOptions: WorkflowModelCallOptions,
		effect: (signal: AbortSignal, context: ModelInvokeContext) => Promise<Readonly<{ output: JsonValue; events: readonly UncorrelatedExecutionEvent[] }>>,
	): Promise<JsonValue> {
		assertDirectOptions(callOptions)
		if (!isJsonValue(rawRequest)) throw new ValidationError('Workflow model request must be JSON.', { where: 'workflow_input', issues: { reason: 'invalid_json' } })
		const request = rawRequest
		const caller = workflowCaller()
		const tuple = makeTuple(operation, 'model', modelAlias, request, callOptions.idempotencyKey ?? null, normalizeDirectIdentity(callOptions))
		const existing = calls.get(callOptions.callId)
		if (existing !== undefined) { assertSameCall(workflow.id, callOptions.callId, existing.tuple, tuple); return existing.promise as Promise<JsonValue> }
			let admitted = false; let checkpointed = false
		activeCalls.add(callOptions.callId)
		const promise = (async () => {
			const replay = await loadDirectCheckpoint(callOptions.callId, operation, 'model', modelAlias, request, callOptions)
				if (replay !== undefined) { checkpointed = true; await publishManagedEvents(replay); return replayDirectOutcome(replay.outcome) }
			const signal = managedSignal(options.signal, callOptions.timeoutMs ?? options.defaults.modelTimeoutMs)
			if (signal.aborted) throw abortError(signal, 'model', 'Workflow managed call was cancelled.')
			admitted = true
			const context: ModelInvokeContext = Object.freeze({ caller, callId: callOptions.callId,
				harnessName: options.toolContext!.harnessName, sessionId: options.sessionId, runId: options.runId,
				...(options.identity === undefined ? {} : { identity: options.identity }), ...(options.trace === undefined ? {} : { trace: options.trace }),
				artifactIdempotencyKey: `${options.runId}:${callOptions.callId}` })
			let result: Readonly<{ output: JsonValue; events: readonly UncorrelatedExecutionEvent[] }>
			try {
				result = await effect(signal, context)
			} catch (error) {
				if (error instanceof ValidationError && error.meta?.['where'] === 'model_response') throw error
				const cancelled = signal.aborted || error instanceof OperationCancelledError || error instanceof OperationTimeoutError
				const stored = cancelled ? storedManagedCancelled('model') : storedManagedFailure(workflow.id, callOptions.callId, operation, 'model', modelAlias)
					await commitManagedCheckpoint(callOptions.callId, operation, 'model', modelAlias, request, stored, [])
					checkpointed = true
				throw replayDirectOutcomeError(stored)
			}
			const stored = Object.freeze({ status: 'completed' as const, output: result.output })
				const events = [...result.events, ...modelTerminalEvents(operation, modelAlias, callOptions.callId, caller, result.output)]
				const record = await commitManagedCheckpoint(callOptions.callId, operation, 'model', modelAlias, request, stored, events)
				checkpointed = true; await publishManagedEvents(record)
			return result.output
		})().finally(() => activeCalls.delete(callOptions.callId))
		const entry = Object.freeze({ tuple, promise })
		calls.set(callOptions.callId, entry)
			void promise.catch(() => { if ((!admitted || checkpointed) && calls.get(callOptions.callId) === entry) calls.delete(callOptions.callId) })
		return promise
	}
	function modelTerminalEvents(operation: WorkflowManagedCallOperation, modelAlias: string, callId: string, caller: Extract<ReturnType<typeof projectHarnessExecutionCaller>, { kind: 'workflow' }>, output: JsonValue): readonly UncorrelatedExecutionEvent[] {
		if (operation === 'model_text_stream' || operation === 'model_object_stream') {
			const finish = Array.isArray(output) ? output.at(-1) : undefined
			if (!isPlainRecord(finish) || finish['kind'] !== 'finish') throw new InternalError('Stored workflow model stream is invalid.')
			return [{ type: 'model.completed', runId: options.runId, caller, callId, modelAlias, streamId: modelStreamId(callId),
				operation: operation === 'model_text_stream' ? 'textStream' : 'objectStream', ...modelCompletion(finish) }]
		}
		if (!isPlainRecord(output)) return []
		if (operation === 'model_text' || operation === 'model_object') return [{ type: 'model.completed', runId: options.runId, caller, callId, modelAlias,
			operation: operation === 'model_text' ? 'text' : 'object', ...modelCompletion(output) }]
		if (operation === 'model_embed') return [{ type: 'model.embedding.completed', runId: options.runId, caller, callId, modelAlias,
			count: Array.isArray(output['embeddings']) ? output['embeddings'].length : 0, ...(typeof output['dimensions'] === 'number' ? { dimensions: output['dimensions'] } : {}), ...(isPlainRecord(output['usage']) ? { usage: output['usage'] as never } : {}) }]
		if (operation === 'model_rerank') return [{ type: 'model.rerank.completed', runId: options.runId, caller, callId, modelAlias,
			count: Array.isArray(output['results']) ? output['results'].length : 0, ...(isPlainRecord(output['usage']) ? { usage: output['usage'] as never } : {}) }]
		else if (operation === 'model_image') {
			return Array.isArray(output['artifacts']) ? output['artifacts'].flatMap(artifact => isPlainRecord(artifact) && typeof artifact['id'] === 'string'
				? [{ type: 'output.file' as const, runId: options.runId, caller, callId, id: artifact['id'], modelAlias, operation: 'image' as const, artifact: artifact as never }] : []) : []
		}
		if ((operation === 'model_speech' || operation === 'model_video') && isPlainRecord(output['artifact']) && typeof output['artifact']['id'] === 'string') return [{ type: 'output.file', runId: options.runId, caller, callId, id: output['artifact']['id'], modelAlias, operation: operation === 'model_speech' ? 'speech' : 'video', artifact: output['artifact'] as never }]
		return []
	}

	async function directAgentRun(agent: AnyAgentDefinition, input: JsonValue, callOptions: WorkflowModelCallOptions): Promise<JsonValue> {
		assertDirectOptions(callOptions)
		assertWireInput(input)
		const tuple = makeTuple('agent_run', 'agent', agent.id, input, callOptions.idempotencyKey ?? null, normalizeDirectIdentity(callOptions))
		const existing = calls.get(callOptions.callId)
		if (existing !== undefined) {
			assertSameCall(workflow.id, callOptions.callId, existing.tuple, tuple)
			return existing.promise as Promise<JsonValue>
		}
		let admitted = false
		activeCalls.add(callOptions.callId)
		const promise = executeDirect(agent, input, callOptions, () => { admitted = true })
			.then(value => { activeCalls.delete(callOptions.callId); return value }, error => {
				if (!isHarnessChildTargetInterruption(error)) activeCalls.delete(callOptions.callId)
				throw error
			})
		const entry = Object.freeze({ tuple, promise })
		calls.set(callOptions.callId, entry)
		void promise.catch(() => { if (!admitted && calls.get(callOptions.callId) === entry) calls.delete(callOptions.callId) })
		return promise
	}

	async function executeDirect(agent: AnyAgentDefinition, input: JsonValue, callOptions: WorkflowModelCallOptions, markAdmitted: () => void): Promise<JsonValue> {
		const { callId, idempotencyKey } = callOptions
		const signal = managedSignal(options.signal, callOptions.timeoutMs)
		const replay = await loadDirectCheckpoint(callId, 'agent_run', 'agent', agent.id, input, callOptions)
		if (replay !== undefined) return replayDirectOutcome(replay.outcome)
		if (signal.aborted) throw abortError(signal, 'agent', 'Workflow managed call was cancelled.')
		assertNestedDepth(agent.id, options.depth, options.remainingDepth)
		const childInvocationId = opaqueId('invocation', [options.runId, workflow.id, callId, agent.id])
		const childSessionId = opaqueId('session', [options.sessionId, childInvocationId])
		let release: (() => void) | undefined
		let terminalCommitted = false
		let executionAdmitted = false
		try {
			await options.prepareChildLaunch?.(Object.freeze({ kind: 'inline', agent, childInvocationId, childSessionId,
				taskRunId: childInvocationId }))
			release = budget.acquireDirect(agent.id)
			executionAdmitted = true
			markAdmitted()
			const stream = await withAbortSignal(signal, 'agent', 'Workflow managed call was cancelled.', () => options.targetDispatcher.open({
				target: agent.contract, input,
				invocation: Object.freeze({ sessionId: childSessionId, invocationId: childInvocationId,
					rootRunId: options.rootRunId, parentRunId: options.runId, parentWorkflowId: workflow.id,
					depth: options.depth + 1, remainingDepth: Math.max(0, options.remainingDepth - 1),
					...(options.identity === undefined ? {} : { identity: options.identity }), ...(options.trace === undefined ? {} : { trace: options.trace }),
					...(options.deadline === undefined ? {} : { deadline: options.deadline }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }), signal }),
			}))
			const consumed = await consumeHarnessTargetStream({ stream, signal, parentRunId: options.runId, childInvocationId, relay: relayEvent })
			if (consumed.outcome.status === 'interrupted') throw createHarnessChildTargetInterruption(childInvocationId, consumed.outcome)
			let stored: WorkflowCallStoredOutcomeV1
			if (consumed.outcome.status === 'completed') stored = Object.freeze({ status: 'completed', output: consumed.outcome.output })
			else if (consumed.outcome.status === 'cancelled') stored = storedManagedCancelled('agent')
			else stored = storedManagedFailure(workflow.id, callId, 'agent_run', 'agent', agent.id)
			await commitManagedCheckpoint(callId, 'agent_run', 'agent', agent.id, input, stored, [], Object.freeze({ childRunId: consumed.lineage.childRunId, childInvocationId }))
			terminalCommitted = true
			if (stored.status === 'failed') throw new WorkflowManagedCallError(stored.error.meta, consumed.outcome.status === 'failed' ? consumed.outcome.error : undefined)
			return replayDirectOutcome(stored)
		} catch (error) {
			if (isHarnessChildTargetInterruption(error)) throw error
			if (!terminalCommitted && (error instanceof OperationCancelledError || error instanceof OperationTimeoutError)) {
				const stored = storedManagedCancelled('agent')
				await commitManagedCheckpoint(callId, 'agent_run', 'agent', agent.id, input, stored, [], Object.freeze({ childRunId: childInvocationId, childInvocationId }))
				throw replayDirectOutcomeError(stored)
			}
			if (!terminalCommitted && executionAdmitted) {
				const stored = storedManagedFailure(workflow.id, callId, 'agent_run', 'agent', agent.id)
				await commitManagedCheckpoint(callId, 'agent_run', 'agent', agent.id, input, stored, [],
					Object.freeze({ childRunId: childInvocationId, childInvocationId }))
				throw new WorkflowManagedCallError(stored.error.meta, error)
			}
			throw error
		} finally { release?.(); options.finishChildLaunch?.(childInvocationId) }
	}

	async function loadDirectCheckpoint(callId: string, operation: WorkflowManagedCallOperation, targetKind: ManagedTargetKind, targetId: string, input: JsonValue, callOptions: WorkflowModelCallOptions): Promise<WorkflowCallCheckpointV1 | undefined> {
		if (options.checkpoint === undefined) return undefined
		const checkpoint = await options.checkpoint.load(`workflow:call:${callId}`)
		if (checkpoint === undefined) return undefined
		const value = parseWorkflowCallCheckpoint(checkpoint.output)
		if (checkpoint.stepId !== `workflow:call:${callId}` || canonicalJson(checkpoint.input) !== canonicalJson(options.checkpoint.rootInput)
			|| !isPlainRecord(checkpoint.metadata) || !exactKeys(checkpoint.metadata, ['checkpointKind', 'schemaVersion'])
			|| checkpoint.metadata['checkpointKind'] !== 'workflow_call' || checkpoint.metadata['schemaVersion'] !== 1
			|| value.callId !== callId || value.operation !== operation
			|| value.lineage !== undefined && (value.lineage.rootRunId !== options.rootRunId || value.lineage.workflowRunId !== options.runId
			|| value.lineage.workflowInvocationId !== options.invocationId)
			|| value.outcome.status === 'failed' && value.outcome.error.meta.workflow_id !== workflow.id) {
			throw new ValidationError('Stored workflow managed call is invalid.', { where: 'workflow_output', issues: { reason: 'invalid_checkpoint' } })
		}
		assertSameCall(workflow.id, callId,
			makeTuple(value.operation, value.target.kind, value.target.id, value.input, callOptions.idempotencyKey ?? null, normalizeDirectIdentity(callOptions)),
			makeTuple(operation, targetKind, targetId, input, callOptions.idempotencyKey ?? null, normalizeDirectIdentity(callOptions)))
		return value
	}

	async function commitManagedCheckpoint(callId: string, operation: WorkflowManagedCallOperation, targetKind: ManagedTargetKind, targetId: string, input: JsonValue, outcome: WorkflowCallStoredOutcomeV1, events: readonly UncorrelatedExecutionEvent[], child?: Readonly<{ childRunId: string; childInvocationId: string }>): Promise<WorkflowCallCheckpointV1> {
		const record: WorkflowCallCheckpointV1 = Object.freeze({ schemaVersion: 1, kind: 'workflow_call', callId, operation,
			target: Object.freeze({ kind: targetKind, id: targetId }), input, outcome,
			publication: Object.freeze({ events: Object.freeze(events.map(event => snapshotJson(event as unknown as JsonValue))) }),
			...(child === undefined ? {} : { lineage: Object.freeze({ rootRunId: options.rootRunId, workflowRunId: options.runId, workflowInvocationId: options.invocationId, ...child }) }) })
		if (options.checkpoint !== undefined) await options.checkpoint.commit(`workflow:call:${callId}`, record as unknown as JsonValue,
			Object.freeze({ checkpointKind: 'workflow_call', schemaVersion: 1 }))
		return record
	}

	async function publishManagedEvents(record: WorkflowCallCheckpointV1): Promise<void> {
		for (let eventIndex = 0; eventIndex < record.publication.events.length; eventIndex += 1) {
			const event = record.publication.events[eventIndex]!
			const stepId = `workflow:publication:${digest(['harness.workflow-call-publication.v1', record.callId, eventIndex])}`
			const eventDigest = `sha256:${digest(event)}`
			if (options.checkpoint !== undefined) {
				const persisted = await options.checkpoint.load(stepId)
				if (persisted !== undefined) {
					const marker = parseWorkflowPublicationCheckpoint(persisted.output)
					if (persisted.stepId !== stepId || canonicalJson(persisted.input) !== canonicalJson(options.checkpoint.rootInput)
						|| !isPlainRecord(persisted.metadata) || !exactKeys(persisted.metadata, ['checkpointKind', 'schemaVersion'])
						|| persisted.metadata['checkpointKind'] !== 'workflow_call_publication' || persisted.metadata['schemaVersion'] !== 1
						|| marker.callId !== record.callId || marker.eventIndex !== eventIndex || marker.eventDigest !== eventDigest) {
						throw new ValidationError('Stored workflow managed call publication is invalid.', { where: 'workflow_output', issues: { reason: 'invalid_checkpoint' } })
					}
					continue
				}
			}
			await options.emit?.(event as unknown as UncorrelatedExecutionEvent)
			if (options.checkpoint !== undefined && options.emit !== undefined) {
				const marker: WorkflowCallPublicationCheckpointV1 = Object.freeze({ schemaVersion: 1, kind: 'workflow_call_publication', callId: record.callId, eventIndex, eventDigest })
				await options.checkpoint.commit(stepId, marker as unknown as JsonValue,
					Object.freeze({ checkpointKind: 'workflow_call_publication', schemaVersion: 1 }))
			}
		}
	}

	async function startTask(agentName: string, input: JsonValue, rawOptions: Record<string, unknown>): Promise<ChildTaskHandle<JsonValue>> {
		const agent = workflow.agents?.find(value => value.id === agentName)
		if (agent === undefined) throw new AgentNotFoundError('Workflow agent was not found.', { agent_id: agentName })
		assertWireInput(input)
		const taskOptions = normalizeTaskOptions(rawOptions, workflow.childTaskSandboxGroups ?? [])
		if (options.durable && taskOptions.mode === 'continuable') throw invokeOptionsError('durable_continuable_child_task_unsupported')
		if (options.durable && taskOptions.idempotencyKey === null) throw invokeOptionsError('child_task_idempotency_key_required')
		const identityOptions: JsonValue = { mode: taskOptions.mode, idempotencyKey: taskOptions.idempotencyKey,
			timeoutMs: taskOptions.timeoutMs, context: taskOptions.context, sandbox: sandboxPolicyJson(taskOptions.sandbox) }
		const tuple = makeTuple('child_task_start', 'agent', agent.id, input, taskOptions.idempotencyKey, identityOptions)
		const existingCall = calls.get(taskOptions.callId)
		if (existingCall !== undefined) {
			assertSameCall(workflow.id, taskOptions.callId, existingCall.tuple, tuple)
			return existingCall.promise as Promise<ChildTaskHandle<JsonValue>>
		}
		const promise = createOrReplayTask(agent, input, taskOptions)
		const entry = Object.freeze({ tuple, promise })
		calls.set(taskOptions.callId, entry)
		void promise.catch(() => { if (calls.get(taskOptions.callId) === entry) calls.delete(taskOptions.callId) })
		return promise
	}

	async function createOrReplayTask(agent: AnyAgentDefinition, input: JsonValue, taskOptions: NormalizedTaskOptions): Promise<ChildTaskHandle<JsonValue>> {
		const taskId = options.durable
			? `task_${digest(['harness.child-task-id.v1', options.runId, taskOptions.idempotencyKey])}`
			: `task_${digest(['harness.child-task-id.v1', options.runId, options.invocationId, taskOptions.callId, ++sequence])}`
		const resident = liveTasks.get(taskId)
		if (options.storage !== undefined) {
			const stored = await options.storage.getRun(taskId)
			if (stored !== undefined) return reconstructTask(stored, agent, input, taskOptions, taskId, resident)
		}
		if (resident !== undefined) return resident
		if (options.signal.aborted) throw abortError(options.signal, 'workflow', 'Child task was cancelled.')
		const approval = options.approval[agent.id]
		if (approval === undefined) throw new InternalError('Compiled approval inventory is invalid.')
		if (approval.reachable) throw invokeOptionsError('approval_capable_child_task_unsupported')
		assertNestedDepth(agent.id, options.depth, options.remainingDepth)
		const createdAt = now().toISOString()
		const descriptor = Object.freeze<ChildTaskDescriptor>({ id: taskId, parentRunId: options.runId, sessionId: options.sessionId,
			workflowId: workflow.id, workflowInvocationId: options.invocationId, callId: taskOptions.callId, agentId: agent.id,
			modelAlias: agent.model, contextPolicy: 'isolated', mode: taskOptions.mode, createdAt })
		const childSessionId = opaqueId('session', [options.sessionId, taskId])
		const initialChildInvocationId = opaqueId('invocation', [taskId, taskOptions.callId, 1, agent.id])
		await options.prepareChildLaunch?.(Object.freeze({ kind: 'background', agent, childInvocationId: initialChildInvocationId,
			childSessionId, taskRunId: taskId, ...(taskOptions.sandbox === undefined ? {} : { policy: taskOptions.sandbox }) }))
		let rollbackReservation: () => void
		try { rollbackReservation = budget.reserveTask(agent.id) }
		catch (error) { options.finishChildLaunch?.(initialChildInvocationId); throw error }
		const live = new LiveWorkflowChildTask({ descriptor, childSessionId, agent, initialInput: input, taskOptions, workflowId: workflow.id,
			...(options.storage === undefined ? {} : { storage: options.storage }), dispatcher: options.targetDispatcher, budget, controller: new AbortController(), parentSignal: options.signal,
			rootRunId: options.rootRunId, depth: options.depth, remainingDepth: options.remainingDepth,
			...(options.identity === undefined ? {} : { identity: options.identity }), ...(options.trace === undefined ? {} : { trace: options.trace }),
			...(options.deadline === undefined ? {} : { deadline: options.deadline }), relay: relayEvent,
			initialChildInvocationId,
			...(options.prepareChildLaunch === undefined ? {} : { prepareChildLaunch: options.prepareChildLaunch }),
			...(options.authorizeChildLaunch === undefined ? {} : { authorizeChildLaunch: options.authorizeChildLaunch }),
			...(options.finishChildLaunch === undefined ? {} : { finishChildLaunch: options.finishChildLaunch }),
			...(options.onChildTaskTerminal === undefined ? {} : { onTerminal: options.onChildTaskTerminal }),
			...(options.emit === undefined ? {} : { emit: options.emit }), now })
		const handle = live.handle()
		liveTasks.set(taskId, handle)
		try {
			await live.persistStart()
			if (await live.activateLifecycle()) live.start()
			else options.finishChildLaunch?.(initialChildInvocationId)
			return handle
		} catch (error) {
			options.finishChildLaunch?.(initialChildInvocationId)
			if (liveTasks.get(taskId) === handle) liveTasks.delete(taskId)
			rollbackReservation()
			await live.rollbackStart()
			throw error
		}
	}

	async function reconstructTask(record: RunRecord, agent: AnyAgentDefinition, input: JsonValue, taskOptions: NormalizedTaskOptions, expectedTaskId: string, resident?: ChildTaskHandle<JsonValue>): Promise<ChildTaskHandle<JsonValue>> {
		const parsed = parseChildTaskRecord(record, agent, workflow.id, options.runId, options.sessionId, options.invocationId, expectedTaskId)
		const differs = parsed.metadata.callId !== taskOptions.callId || parsed.metadata.agentId !== agent.id
			|| canonicalJson(parsed.input) !== canonicalJson(input) || parsed.metadata.mode !== taskOptions.mode
			|| parsed.metadata.timeoutMs !== taskOptions.timeoutMs || parsed.metadata.context !== taskOptions.context
			|| parsed.metadata.idempotencyKey !== taskOptions.idempotencyKey || record.id !== expectedTaskId
		if (differs) throw new ChildTaskConflictError({ reason: 'idempotency_key_reused', workflow_id: workflow.id, parent_run_id: options.runId,
			task_id: record.id, agent_id: agent.id, call_id: taskOptions.callId })
		if (record.status === 'running') {
			if (resident !== undefined) return resident
			throw new ChildTaskStateError({ reason: 'recovery_required', task_id: record.id, workflow_id: workflow.id, agent_id: agent.id })
		}
		return terminalTaskHandle(parsed.descriptor, record)
	}

	async function relayEvent(event: ExecutionEvent): Promise<void> {
		if (options.relayChildEvent !== undefined) await options.relayChildEvent(event)
	}
	function now(): Date { return options.now?.() ?? new Date() }

	const childTasks = Object.freeze({ start: (agent: string, input: JsonValue, taskOptions: Record<string, unknown>) => startTask(agent, input, taskOptions) })
	const fanOut = async <T, R>(items: readonly T[], worker: (item: T, index: number) => Promise<R>, fanOptions?: Readonly<{ concurrency?: number }>): Promise<R[]> => {
		const requested = fanOptions?.concurrency ?? maxParallel
		if (!Number.isSafeInteger(requested) || requested <= 0) throw invokeOptionsError('invalid_fanout_concurrency')
		const concurrency = Math.min(requested, maxParallel)
		const batchId = `fanout_${digest([options.runId, workflow.id, ++sequence])}`
		await options.emit?.({ type: 'fanout.started', runId: options.runId, batchId, at: now().toISOString(), count: items.length, concurrency })
		const output = new Array<R>(items.length)
		let cursor = 0
		try {
			await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
				while (cursor < items.length) {
					if (options.signal.aborted) throw abortError(options.signal, 'workflow', 'Workflow fan-out was cancelled.')
					const index = cursor++
					output[index] = await worker(items[index]!, index)
				}
			}))
			await options.emit?.({ type: 'fanout.finished', runId: options.runId, batchId, at: now().toISOString(), count: items.length, status: 'succeeded' })
			return output
		} catch (error) {
			await options.emit?.({ type: 'fanout.finished', runId: options.runId, batchId, at: now().toISOString(), count: items.length,
				status: error instanceof OperationCancelledError ? 'cancelled' : 'failed' })
			throw error
		}
	}

	return Object.freeze({ agents: Object.freeze(agents) as AgentInvokers<Agents>, tools: Object.freeze(tools) as ToolInvokers<Tools>,
		models: Object.freeze(models) as WorkflowExecutionRuntime<Agents, Tools, Models>['models'],
		childTasks: childTasks as unknown as RuntimeChildTasks<Agents>, fanOut, agentCallBudgetState: () => budget.state(),
		activeCallIds: () => Object.freeze([...activeCalls]) })
}

class WorkflowCallAdmission {
	private used = 0
	private active = 0
	private readonly waiters: Array<{ agentId: string; signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void }> = []
	public constructor(private readonly workflowId: string, private readonly maxCalls: number, private readonly maxParallel: number, initialUsed: number) { this.used = initialUsed }
	public acquireDirect(agentId: string): () => void {
		this.reserve(agentId)
		if (this.active >= this.maxParallel || this.waiters.length > 0) { this.used -= 1; throw this.failure(agentId, 'max_parallel', this.maxParallel) }
		this.active += 1
		return this.release()
	}
	public reserveTask(agentId: string): () => void { this.reserve(agentId); let retained = true; return () => { if (!retained) return; retained = false; this.used -= 1 } }
	public state(): WorkflowAgentCallBudgetStateV1 { return Object.freeze({ schemaVersion: 1, usedCalls: this.used }) }
	public async acquireTaskTurn(agentId: string, signal: AbortSignal, reserve = false): Promise<() => void> {
		if (reserve) this.reserve(agentId)
		if (this.active < this.maxParallel && this.waiters.length === 0) { this.active += 1; return this.release() }
		return new Promise((resolve, reject) => {
			const waiter = { agentId, signal, resolve, reject }
			const cancelled = () => { const index = this.waiters.findIndex(candidate => candidate.signal === signal && candidate.agentId === agentId); if (index >= 0) this.waiters.splice(index, 1); reject(abortError(signal, 'agent', 'Child task was cancelled.')) }
			signal.addEventListener('abort', cancelled, { once: true })
			this.waiters.push({ ...waiter, resolve: release => { signal.removeEventListener('abort', cancelled); resolve(release) } })
			if (signal.aborted) cancelled()
		})
	}
	private reserve(agentId: string): void { if (this.used >= this.maxCalls) throw this.failure(agentId, 'max_calls', this.maxCalls); this.used += 1 }
	private release(): () => void { let done = false; return () => { if (done) return; done = true; this.active -= 1; this.drain() } }
	private drain() { while (this.active < this.maxParallel && this.waiters.length > 0) { const waiter = this.waiters.shift()!; if (waiter.signal.aborted) continue; this.active += 1; waiter.resolve(this.release()) } }
	private failure(agentId: string, reason: 'max_calls' | 'max_parallel', limit: number) { return new WorkflowAgentCallBudgetError({ workflow_id: this.workflowId, agent_id: agentId, reason, limit }) }
}

class LiveWorkflowChildTask {
	private statusValue: ChildTaskStatus
	private readonly resultPromise: Promise<JsonValue>
	private resolveResult!: (value: JsonValue) => void
	private rejectResult!: (error: unknown) => void
	private lastOutput: JsonValue | undefined
	private closing = false
	private lifecycle: 'open' | 'committing' | 'committed' | 'commit_failed' = 'open'
	private terminalCommit?: Promise<void>
	private terminalRejection: unknown
	private queue = Promise.resolve()
	private acceptanceQueue = Promise.resolve()
	private closePromise?: Promise<JsonValue | undefined>
	private timeout?: ReturnType<typeof setTimeout>
	private pendingTurns = 0
	private turnSequence = 0
	private readonly settledPromise: Promise<void>
	private resolveSettled!: () => void
	private parentAbort?: () => void
	private startRecordPersisted = false
	public constructor(private readonly values: {
		descriptor: ChildTaskDescriptor; childSessionId: string; agent: AnyAgentDefinition; initialInput: JsonValue; taskOptions: NormalizedTaskOptions; workflowId: string
		storage?: HarnessStorage; dispatcher: HarnessTargetDispatcher; budget: WorkflowCallAdmission; controller: AbortController; parentSignal: AbortSignal
		rootRunId: string; depth: number; remainingDepth: number; identity?: HarnessIdentity; trace?: HarnessTraceContext; deadline?: number
		initialChildInvocationId: string
		prepareChildLaunch?: WorkflowRuntimeOptions<WorkflowAgentMap, WorkflowToolDefinitions, WorkflowModelMap>['prepareChildLaunch']
		authorizeChildLaunch?: WorkflowRuntimeOptions<WorkflowAgentMap, WorkflowToolDefinitions, WorkflowModelMap>['authorizeChildLaunch']
		finishChildLaunch?: (childInvocationId: string) => void
		onTerminal?: (childSessionId: string) => Promise<void>
		relay(event: ExecutionEvent): Promise<void>; emit?: (event: UncorrelatedExecutionEvent) => Promise<void>; now(): Date
	}) {
		this.statusValue = Object.freeze({ descriptor: values.descriptor, status: 'running' })
		this.resultPromise = new Promise((resolve, reject) => { this.resolveResult = resolve; this.rejectResult = reject })
		this.settledPromise = new Promise(resolve => { this.resolveSettled = resolve })
	}
	public handle(): ChildTaskHandle<JsonValue> | ContinuableChildTaskHandle<JsonValue, JsonValue> {
		const base = { id: this.values.descriptor.id, result: () => this.resultPromise, status: async () => this.statusValue, cancel: () => this.cancel() }
		return this.values.taskOptions.mode === 'continuable'
			? Object.freeze({ ...base, send: (input: JsonValue) => this.send(input), close: () => this.close() })
			: Object.freeze(base)
	}
	public async persistStart() {
		const metadata = Object.freeze({ schemaVersion: 1 as const, kind: 'workflow_child_task' as const, parentRunId: this.values.descriptor.parentRunId,
			workflowId: this.values.workflowId, workflowInvocationId: this.values.descriptor.workflowInvocationId, callId: this.values.descriptor.callId,
			agentId: this.values.agent.id, modelAlias: this.values.agent.model, mode: this.values.taskOptions.mode, context: 'isolated',
			timeoutMs: this.values.taskOptions.timeoutMs, idempotencyKey: this.values.taskOptions.idempotencyKey, createdAt: this.values.descriptor.createdAt }) satisfies ChildTaskRecordMetadataV1 & Record<string, JsonValue>
		if (this.values.storage !== undefined) {
			await this.values.storage.createRun({ id: this.values.descriptor.id, sessionId: this.values.descriptor.sessionId, kind: 'child_task', target: this.values.agent.id,
				startedAt: this.values.descriptor.createdAt, input: this.values.initialInput, metadata })
			this.startRecordPersisted = true
		}
		try {
			await this.values.emit?.({ type: 'child_task.started', runId: this.values.descriptor.id, taskId: this.values.descriptor.id, at: this.values.descriptor.createdAt,
				parentRunId: this.values.descriptor.parentRunId, workflowId: this.values.workflowId, agentId: this.values.agent.id, modelAlias: this.values.agent.model,
				contextPolicy: 'isolated', mode: this.values.taskOptions.mode })
		} catch (error) { throw lifecycleFailure(error) }
	}
	public async activateLifecycle(): Promise<boolean> {
		this.parentAbort = () => { void this.cancel() }
		this.values.parentSignal.addEventListener('abort', this.parentAbort, { once: true })
		if (this.values.parentSignal.aborted) { await this.cancel(); return false }
		if (this.values.taskOptions.timeoutMs !== null) {
			const remaining = new Date(this.values.descriptor.createdAt).getTime() + this.values.taskOptions.timeoutMs - this.values.now().getTime()
			if (remaining <= 0) { await this.triggerTimeout(); return false }
			this.timeout = setTimeout(() => { void this.triggerTimeout() }, remaining)
		}
		return true
	}
	public async rollbackStart(): Promise<void> {
		if (this.timeout) clearTimeout(this.timeout)
		if (this.parentAbort !== undefined) this.values.parentSignal.removeEventListener('abort', this.parentAbort)
		this.values.controller.abort(new OperationCancelledError('Child task was cancelled.', { scope: 'child_task' }))
		if (this.values.storage === undefined || !this.startRecordPersisted) return
		await this.values.storage.finishRun(this.values.descriptor.id, { status: 'cancelled', finishedAt: this.values.now().toISOString(), error: childCancelled() }).catch(() => undefined)
	}
	public start() {
		this.turnSequence = 1
		this.queue = this.turn(this.values.initialInput, this.values.initialChildInvocationId, true)
			.then(async output => { this.lastOutput = output; if (this.values.taskOptions.mode === 'one_shot') await this.succeed(output) })
			.catch(async error => { if (this.terminalCommit !== undefined) { await this.terminalCommit.catch(() => undefined); return } await this.fail(error) })
	}
	private async turn(input: JsonValue, childInvocationId: string, handoffPrepared: boolean, onLaunch?: () => void): Promise<JsonValue> {
		this.pendingTurns += 1
		let release: (() => void) | undefined
		try {
			assertNestedDepth(this.values.agent.id, this.values.depth, this.values.remainingDepth)
			const request = Object.freeze({ kind: 'background' as const, agent: this.values.agent,
				childInvocationId, childSessionId: this.values.childSessionId, taskRunId: this.values.descriptor.id,
				...(this.values.taskOptions.sandbox === undefined ? {} : { policy: this.values.taskOptions.sandbox }) })
			await this.values.authorizeChildLaunch?.(request)
			release = await this.values.budget.acquireTaskTurn(this.values.agent.id, this.values.controller.signal, false)
			if (handoffPrepared) await this.values.authorizeChildLaunch?.(request)
			else {
				await this.values.prepareChildLaunch?.(Object.freeze({ kind: 'background', agent: this.values.agent,
					childInvocationId, childSessionId: this.values.childSessionId, taskRunId: this.values.descriptor.id,
					...(this.values.taskOptions.sandbox === undefined ? {} : { policy: this.values.taskOptions.sandbox }) }))
			}
			onLaunch?.()
			const stream = await withAbortSignal(this.values.controller.signal, 'agent', 'Child task was cancelled.', () => this.values.dispatcher.open({ target: this.values.agent.contract, input,
				invocation: Object.freeze({ sessionId: this.values.childSessionId, invocationId: childInvocationId, rootRunId: this.values.rootRunId,
					parentRunId: this.values.descriptor.id, parentWorkflowId: this.values.workflowId, depth: this.values.depth + 1,
					remainingDepth: Math.max(0, this.values.remainingDepth - 1), ...(this.values.identity === undefined ? {} : { identity: this.values.identity }),
					...(this.values.trace === undefined ? {} : { trace: this.values.trace }), ...(this.values.deadline === undefined ? {} : { deadline: this.values.deadline }), signal: this.values.controller.signal }) }))
			const consumed = await consumeHarnessTargetStream({ stream, signal: this.values.controller.signal, parentRunId: this.values.descriptor.id, childInvocationId, relay: this.values.relay })
			if (consumed.outcome.status === 'completed') return consumed.outcome.output
			if (consumed.outcome.status === 'cancelled') throw new OperationCancelledError('Child task was cancelled.', { scope: 'child_task' })
			throw new WorkflowManagedCallError({ reason: 'operation_failed', workflow_id: this.values.workflowId, call_id: this.values.descriptor.callId,
				operation: 'agent_run', target_kind: 'agent', target_id: this.values.agent.id }, 'error' in consumed.outcome ? consumed.outcome.error : undefined)
		} finally { release?.(); this.values.finishChildLaunch?.(childInvocationId); this.pendingTurns -= 1 }
	}
	private send(input: JsonValue): Promise<JsonValue> {
		assertWireInput(input)
		if (this.lifecycle !== 'open') return Promise.reject(new ChildTaskStateError({ reason: 'terminal', task_id: this.values.descriptor.id, workflow_id: this.values.workflowId, agent_id: this.values.agent.id }))
		if (this.closing) return Promise.reject(new ChildTaskStateError({ reason: 'closing', task_id: this.values.descriptor.id, workflow_id: this.values.workflowId, agent_id: this.values.agent.id }))
		const childInvocationId = opaqueId('invocation', [this.values.descriptor.id, this.values.descriptor.callId, ++this.turnSequence, this.values.agent.id])
		const request = Object.freeze({ kind: 'background' as const, agent: this.values.agent,
			childInvocationId, childSessionId: this.values.childSessionId, taskRunId: this.values.descriptor.id,
			...(this.values.taskOptions.sandbox === undefined ? {} : { policy: this.values.taskOptions.sandbox }) })
		const accepted = this.acceptanceQueue.then(async () => {
			await this.values.authorizeChildLaunch?.(request)
			return this.values.budget.reserveTask(this.values.agent.id)
		})
		this.acceptanceQueue = accepted.then(() => undefined, () => undefined)
		let resolve!: (value: JsonValue) => void; let reject!: (error: unknown) => void
		const result = new Promise<JsonValue>((ok, fail) => { resolve = ok; reject = fail })
		this.queue = this.queue.then(async () => {
			const rollbackReservation = await accepted
			let launched = false
			try {
				if (this.lifecycle !== 'open') throw this.terminalError()
				const output = await this.turn(input, childInvocationId, false, () => { launched = true })
				this.lastOutput = output
				resolve(output)
			} catch (error) {
				if (!launched) rollbackReservation()
				throw error
			}
		}).catch(async error => { reject(error); if (this.terminalCommit === undefined) await this.fail(error) })
		return result
	}
	private close(): Promise<JsonValue | undefined> {
		if (this.closePromise !== undefined) return this.closePromise
		if (this.lifecycle !== 'open') return Promise.reject(new ChildTaskStateError({ reason: 'terminal', task_id: this.values.descriptor.id, workflow_id: this.values.workflowId, agent_id: this.values.agent.id }))
		this.closing = true
		this.closePromise = this.queue.then(async () => { if (this.lifecycle !== 'open') throw this.terminalError(); await this.succeed(this.lastOutput); return this.lastOutput })
		return this.closePromise
	}
	private async cancel(): Promise<void> {
		if (this.terminalCommit !== undefined) { await this.terminalCommit; return }
		this.values.controller.abort(new OperationCancelledError('Child task was cancelled.', { scope: 'child_task' }))
		if (this.pendingTurns === 0) await this.settle('cancelled', undefined, childCancelled())
		else await this.settledPromise
	}
	private async triggerTimeout() {
		if (this.terminalCommit !== undefined) { await this.terminalCommit; return }
		const error = new OperationTimeoutError('Child task timed out.', { scope: 'child_task', timeout_ms: this.values.taskOptions.timeoutMs! })
		this.values.controller.abort(error)
		if (this.pendingTurns === 0) await this.settle('failed', undefined, serializeHarnessError(error), error)
	}
	private async failTimeout() { if (this.terminalCommit !== undefined) { await this.terminalCommit; return }; const error = new OperationTimeoutError('Child task timed out.', { scope: 'child_task', timeout_ms: this.values.taskOptions.timeoutMs! }); await this.settle('failed', undefined, serializeHarnessError(error), error); }
	private async succeed(output: JsonValue | undefined) { await this.settle('succeeded', output) }
	private async fail(error: unknown) { if (this.terminalCommit !== undefined) { await this.terminalCommit; return }; if (error instanceof OperationTimeoutError) return this.failTimeout(); if (error instanceof OperationCancelledError) return this.cancel(); const wrapped = error instanceof WorkflowManagedCallError ? error : new WorkflowManagedCallError({ reason: 'operation_failed', workflow_id: this.values.workflowId, call_id: this.values.descriptor.callId, operation: 'agent_run', target_kind: 'agent', target_id: this.values.agent.id }, error); await this.settle('failed', undefined, serializeHarnessError(wrapped), wrapped) }
	private async settle(status: 'succeeded' | 'failed' | 'cancelled', output?: JsonValue, error?: SerializedError, rejection?: unknown) {
		if (this.terminalCommit !== undefined) return this.terminalCommit
		this.lifecycle = 'committing'
		const finishedAt = this.values.now().toISOString()
		const terminalRejection = status === 'succeeded' ? undefined : rejection ?? (error?.code === 'OPERATION_TIMEOUT'
			? new OperationTimeoutError('Child task timed out.', { scope: 'child_task', timeout_ms: this.values.taskOptions.timeoutMs! })
			: error?.code === 'OPERATION_CANCELLED'
				? new OperationCancelledError('Child task was cancelled.', { scope: 'child_task' })
				: new WorkflowManagedCallError({ reason: 'operation_failed', workflow_id: this.values.workflowId, call_id: this.values.descriptor.callId,
					operation: 'agent_run', target_kind: 'agent', target_id: this.values.agent.id }))
		this.terminalCommit = this.commitTerminal(status, finishedAt, output, error, terminalRejection)
		return this.terminalCommit
	}
	private async commitTerminal(status: 'succeeded' | 'failed' | 'cancelled', finishedAt: string, output: JsonValue | undefined, error: SerializedError | undefined, terminalRejection: unknown): Promise<void> {
		try {
			await this.values.storage?.finishRun(this.values.descriptor.id, { status, finishedAt, ...(output === undefined ? {} : { output }), ...(error === undefined ? {} : { error }) })
			try {
				await this.values.emit?.({ type: 'child_task.settled', runId: this.values.descriptor.id, taskId: this.values.descriptor.id, at: finishedAt,
					parentRunId: this.values.descriptor.parentRunId, workflowId: this.values.workflowId, agentId: this.values.agent.id, status, ...(error === undefined ? {} : { error }) })
			} catch (emitError) {
				if (this.values.storage === undefined) throw emitError
			}
			await this.values.onTerminal?.(this.values.childSessionId)
			this.lifecycle = 'committed'
			this.terminalRejection = terminalRejection
			this.statusValue = Object.freeze({ descriptor: this.values.descriptor, status, finishedAt, ...(error === undefined ? {} : { error }) })
			if (status === 'succeeded') this.resolveResult(output as JsonValue)
			else this.rejectResult(terminalRejection)
		} catch (commitError) {
			const normalized = lifecycleFailure(commitError)
			this.lifecycle = 'commit_failed'
			this.terminalRejection = normalized
			this.statusValue = Object.freeze({ descriptor: this.values.descriptor, status: 'failed', finishedAt, error: serializeHarnessError(normalized) })
			this.rejectResult(normalized)
			throw normalized
		} finally {
			if (this.timeout) clearTimeout(this.timeout)
			if (this.parentAbort !== undefined) this.values.parentSignal.removeEventListener('abort', this.parentAbort)
			this.resolveSettled()
		}
	}
	private terminalError(): unknown { return this.terminalRejection ?? new ChildTaskStateError({ reason: 'terminal', task_id: this.values.descriptor.id, workflow_id: this.values.workflowId, agent_id: this.values.agent.id }) }
}

interface NormalizedTaskOptions { callId: string; mode: 'one_shot' | 'continuable'; idempotencyKey: string | null; timeoutMs: number | null; context: 'isolated'; sandbox?: SandboxPolicy<string> }
function normalizeTaskOptions(value: Record<string, unknown>, allowedGroups: readonly string[]): NormalizedTaskOptions {
	if (!isPlainRecord(value)) throw invokeOptionsError('invalid_child_task_context')
	const keys = Reflect.ownKeys(value)
	if (keys.some(key => typeof key !== 'string' || !['callId', 'idempotencyKey', 'timeoutMs', 'context', 'mode', 'sandbox'].includes(key))) throw invokeOptionsError('invalid_child_task_context')
	assertCallId(value['callId'], 'invalid_workflow_call_id')
	if (value['idempotencyKey'] !== undefined) assertCallId(value['idempotencyKey'], 'invalid_child_task_idempotency_key')
	if (value['timeoutMs'] !== undefined && (!Number.isSafeInteger(value['timeoutMs']) || (value['timeoutMs'] as number) <= 0)) throw invokeOptionsError('invalid_child_task_timeout')
	if (value['context'] !== undefined && value['context'] !== 'isolated') throw invokeOptionsError('invalid_child_task_context')
	if (value['mode'] !== undefined && value['mode'] !== 'one_shot' && value['mode'] !== 'continuable') throw invokeOptionsError('invalid_child_task_context')
	if (value['mode'] === 'continuable' && value['idempotencyKey'] !== undefined) throw invokeOptionsError('invalid_child_task_context')
	const sandbox = normalizeChildSandboxPolicy(value['sandbox'], allowedGroups)
	return Object.freeze({ callId: value['callId'] as string, mode: (value['mode'] ?? 'one_shot') as 'one_shot' | 'continuable',
		idempotencyKey: value['idempotencyKey'] as string | undefined ?? null, timeoutMs: value['timeoutMs'] as number | undefined ?? null, context: 'isolated',
		...(sandbox === undefined ? {} : { sandbox }) })
}
function normalizeChildSandboxPolicy(value: unknown, allowedGroups: readonly string[]): SandboxPolicy<string> | undefined {
	if (value === undefined) return undefined
	if (value === 'inherit') return 'inherit'
	if (value === 'private') return 'private'
	if (!isPlainRecord(value) || !exactKeys(value, ['group']) || typeof value['group'] !== 'string' || !allowedGroups.includes(value['group'])) {
		throw invokeOptionsError('invalid_child_task_context')
	}
	return Object.freeze({ group: value['group'] })
}
function sandboxPolicyJson(value: SandboxPolicy<string> | undefined): JsonValue { return value === undefined ? null : typeof value === 'string' ? value : { group: value.group } }

function assertDirectOptions(value: unknown): asserts value is WorkflowModelCallOptions {
	if (!isPlainRecord(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['callId', 'idempotencyKey', 'timeoutMs'].includes(key))) throw invokeOptionsError('invalid_workflow_call_id')
	assertCallId(value['callId'], 'invalid_workflow_call_id')
	if (value['idempotencyKey'] !== undefined) assertCallId(value['idempotencyKey'], 'invalid_child_task_idempotency_key')
	if (value['timeoutMs'] !== undefined && (!Number.isSafeInteger(value['timeoutMs']) || (value['timeoutMs'] as number) <= 0)) throw invokeOptionsError('invalid_workflow_call_timeout')
}
function assertCallId(value: unknown, reason: string): asserts value is string { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw invokeOptionsError(reason) }
function assertWireInput(value: unknown): asserts value is JsonValue { if (!isJsonValue(value)) throw new ValidationError('Workflow child input must be JSON.', { where: 'workflow_input', issues: { reason: 'invalid_json' } }) }
function invokeOptionsError(reason: string) { return new ValidationError('Workflow invocation options are invalid.', { where: 'invoke_options', issues: { reason } }) }
function assertNestedDepth(agentId: string, depth: number, remainingDepth: number): void {
	if (remainingDepth > 0) return
	throw new AgentLoopBudgetError('Agent delegation depth budget exceeded.', { agent_id: agentId, reason: 'max_depth', limit: depth + remainingDepth })
}
function validateRestoredBudget(value: WorkflowAgentCallBudgetStateV1 | undefined, maxCalls: number): number {
	if (value === undefined) return 0
	if (!isPlainRecord(value) || !exactKeys(value, ['schemaVersion', 'usedCalls']) || value['schemaVersion'] !== 1
		|| !Number.isSafeInteger(value['usedCalls']) || (value['usedCalls'] as number) < 0 || (value['usedCalls'] as number) > maxCalls) {
		throw new ValidationError('Stored workflow agent-call budget is invalid.', { where: 'workflow_output', issues: { reason: 'invalid_checkpoint' } })
	}
	return value['usedCalls'] as number
}
function normalizeDirectIdentity(options: WorkflowModelCallOptions): JsonValue { return Object.freeze({ idempotencyKey: options.idempotencyKey ?? null, timeoutMs: options.timeoutMs ?? null }) }
function makeTuple(operation: CallOperation, targetKind: ManagedTargetKind, targetId: string, input: JsonValue, idempotencyKey: string | null, options: JsonValue): CallTuple { return Object.freeze({ operation, targetKind, targetId, input, inputCanonical: canonicalJson(input), idempotencyKey, optionsCanonical: canonicalJson(options) }) }
function assertSameCall(workflowId: string, callId: string, expected: CallTuple, received: CallTuple) {
	let reason: 'operation_mismatch' | 'target_mismatch' | 'input_mismatch' | 'idempotency_key_mismatch' | 'options_mismatch' | undefined
	if (expected.operation !== received.operation) reason = 'operation_mismatch'; else if (expected.targetKind !== received.targetKind || expected.targetId !== received.targetId) reason = 'target_mismatch'; else if (expected.inputCanonical !== received.inputCanonical) reason = 'input_mismatch'; else if (expected.idempotencyKey !== received.idempotencyKey) reason = 'idempotency_key_mismatch'; else if (expected.optionsCanonical !== received.optionsCanonical) reason = 'options_mismatch'
	if (reason !== undefined) throw new WorkflowCallReplayConflictError({ reason, workflow_id: workflowId, call_id: callId,
		expected_operation: expected.operation, received_operation: received.operation, expected_target_kind: expected.targetKind, expected_target_id: expected.targetId,
		received_target_kind: received.targetKind, received_target_id: received.targetId })
}
function storedManagedFailure(workflowId: string, callId: string, operation: WorkflowManagedCallOperation, targetKind: ManagedTargetKind, targetId: string): Extract<WorkflowCallStoredOutcomeV1, { status: 'failed' }> { return Object.freeze({ status: 'failed', error: Object.freeze({ code: 'WORKFLOW_MANAGED_CALL_FAILED', message: 'Workflow managed call failed.', category: 'internal', retriable: false, meta: Object.freeze({ reason: 'operation_failed', workflow_id: workflowId, call_id: callId, operation, target_kind: targetKind, target_id: targetId }) }) }) }
function storedManagedCancelled(scope: ManagedTargetKind): Extract<WorkflowCallStoredOutcomeV1, { status: 'cancelled' }> { return Object.freeze({ status: 'cancelled', error: Object.freeze({ code: 'OPERATION_CANCELLED', message: 'Workflow managed call was cancelled.', category: 'cancelled', retriable: false, meta: Object.freeze({ scope }) }) }) }
function replayDirectOutcome(outcome: WorkflowCallStoredOutcomeV1): JsonValue { if (outcome.status === 'completed') return outcome.output; throw replayDirectOutcomeError(outcome) }
function replayDirectOutcomeError(outcome: Exclude<WorkflowCallStoredOutcomeV1, { status: 'completed' }>): Error { return outcome.status === 'cancelled' ? new OperationCancelledError('Workflow managed call was cancelled.', outcome.error.meta, outcome.error) : new WorkflowManagedCallError(outcome.error.meta, outcome.error) }
function managedSignal(parent: AbortSignal, timeoutMs: number | undefined): AbortSignal {
	if (timeoutMs === undefined) return parent
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new OperationTimeoutError('Workflow managed call timed out.', { scope: 'run', timeout_ms: timeoutMs })), timeoutMs)
	timer.unref?.()
	parent.addEventListener('abort', () => { clearTimeout(timer); controller.abort(parent.reason) }, { once: true })
	return controller.signal
}
function childCancelled(): SerializedError { return Object.freeze({ code: 'OPERATION_CANCELLED', message: 'Child task was cancelled.', category: 'cancelled', retriable: false, meta: Object.freeze({ scope: 'child_task' }) }) }
function serializeHarnessError(error: { code: string; message: string; category: string; retriable: boolean; meta: Readonly<Record<string, unknown>> | undefined }): SerializedError { return Object.freeze({ code: error.code, message: error.message, category: error.category, retriable: error.retriable, ...(error.meta === undefined ? {} : { meta: Object.freeze({ ...error.meta }) }) }) }
function lifecycleFailure(error: unknown): HarnessError { return error instanceof HarnessError ? error : new InternalError('Child task lifecycle persistence failed.', undefined, error) }
function terminalTaskHandle(descriptor: ChildTaskDescriptor, record: RunRecord): ChildTaskHandle<JsonValue> { const storedError = record.error === undefined ? undefined : Object.freeze({ ...record.error, ...(record.error.meta === undefined ? {} : { meta: Object.freeze({ ...record.error.meta }) }) }); const status = Object.freeze({ descriptor, status: record.status as ChildTaskStatus['status'], ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }), ...(storedError === undefined ? {} : { error: storedError }) }); return Object.freeze({ id: record.id, result: async () => { if (record.status === 'succeeded') return record.output!; if (storedError?.code === 'OPERATION_TIMEOUT') throw new OperationTimeoutError('Child task timed out.', { scope: 'child_task', timeout_ms: Number(storedError.meta?.['timeout_ms']) }, storedError); if (record.status === 'cancelled') throw new OperationCancelledError('Child task was cancelled.', { scope: 'child_task' }, storedError); throw new WorkflowManagedCallError({ reason: 'operation_failed', workflow_id: descriptor.workflowId, call_id: descriptor.callId, operation: 'agent_run', target_kind: 'agent', target_id: descriptor.agentId }, storedError) }, status: async () => status, cancel: async () => {} }) }
function parseChildTaskRecord(record: RunRecord, agent: AnyAgentDefinition, workflowId: string, parentRunId: string, sessionId: string, workflowInvocationId: string, expectedTaskId: string): { descriptor: ChildTaskDescriptor; metadata: ChildTaskRecordMetadataV1; input: JsonValue } {
	try {
		const metadata = record.metadata
		if (!isPlainRecord(metadata) || !exactKeys(metadata, ['schemaVersion', 'kind', 'parentRunId', 'workflowId', 'workflowInvocationId', 'callId', 'agentId', 'modelAlias', 'mode', 'context', 'timeoutMs', 'idempotencyKey', 'createdAt'])) throw new Error()
		if (metadata['schemaVersion'] !== 1 || metadata['kind'] !== 'workflow_child_task' || !nonempty(metadata['workflowInvocationId'])
			|| typeof metadata['callId'] !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(metadata['callId'])
			|| metadata['mode'] !== 'one_shot' && metadata['mode'] !== 'continuable' || metadata['context'] !== 'isolated'
			|| metadata['timeoutMs'] !== null && (!Number.isSafeInteger(metadata['timeoutMs']) || (metadata['timeoutMs'] as number) <= 0)
			|| metadata['idempotencyKey'] !== null && (typeof metadata['idempotencyKey'] !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(metadata['idempotencyKey']))) throw new Error()
		if (record.id !== expectedTaskId || record.kind !== 'child_task' || record.sessionId !== sessionId || record.target !== agent.id || record.startedAt !== metadata['createdAt']
			|| metadata['parentRunId'] !== parentRunId || metadata['workflowId'] !== workflowId || metadata['agentId'] !== agent.id
			|| metadata['workflowInvocationId'] !== workflowInvocationId
			|| metadata['modelAlias'] !== agent.model || !validTimestamp(metadata['createdAt']) || !isJsonValue(record.input)) throw new Error()
		if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error()
		const base = ['id', 'sessionId', 'kind', 'target', 'startedAt', 'status', 'revision', 'input', 'metadata']
		if (record.status === 'running') { if (!exactKeys(record, base)) throw new Error() }
		else if (record.status === 'succeeded') { if (!exactKeys(record, [...base, 'finishedAt', 'output']) || !validTimestamp(record.finishedAt) || !isJsonValue(record.output)) throw new Error() }
		else if (record.status === 'failed' || record.status === 'cancelled') { if (!exactKeys(record, [...base, 'finishedAt', 'error']) || !validTimestamp(record.finishedAt) || !validChildStoredError(record.error, record.status, workflowId, metadata['callId'], agent.id, metadata['timeoutMs'])) throw new Error() }
		else throw new Error()
		const typedMetadata = metadata as unknown as ChildTaskRecordMetadataV1
		const descriptor = Object.freeze({ id: record.id, parentRunId, sessionId, workflowId, workflowInvocationId: typedMetadata.workflowInvocationId,
			callId: typedMetadata.callId, agentId: agent.id, modelAlias: agent.model, contextPolicy: 'isolated' as const, mode: typedMetadata.mode, createdAt: typedMetadata.createdAt })
		return { descriptor, metadata: typedMetadata, input: record.input }
	} catch { throw new ChildTaskStateError({ reason: 'invalid_record', task_id: record.id }) }
}
function parseWorkflowCallCheckpoint(value: unknown): WorkflowCallCheckpointV1 {
	if (!isPlainRecord(value) || !exactKeys(value, value['lineage'] === undefined ? ['schemaVersion', 'kind', 'callId', 'operation', 'target', 'input', 'outcome', 'publication'] : ['schemaVersion', 'kind', 'callId', 'operation', 'target', 'input', 'outcome', 'publication', 'lineage'])
		|| value['schemaVersion'] !== 1 || value['kind'] !== 'workflow_call' || typeof value['callId'] !== 'string' || !isManagedOperation(value['operation'])
		|| !isPlainRecord(value['target']) || !exactKeys(value['target'], ['kind', 'id']) || !isManagedTargetKind(value['target']['kind']) || typeof value['target']['id'] !== 'string'
		|| !isJsonValue(value['input']) || !isPlainRecord(value['outcome']) || !validDirectStoredOutcome(value['outcome'], value['callId'], value['operation'], value['target']['kind'], value['target']['id'])
		|| !isPlainRecord(value['publication']) || !exactKeys(value['publication'], ['events']) || !Array.isArray(value['publication']['events'])
		|| !(value['publication']['events'] as unknown[]).every(isJsonValue)
		|| value['lineage'] !== undefined && (!isPlainRecord(value['lineage']) || !exactKeys(value['lineage'], ['rootRunId', 'workflowRunId', 'workflowInvocationId', 'childRunId', 'childInvocationId'])
		|| !Object.values(value['lineage']).every(item => typeof item === 'string'))) {
		throw new ValidationError('Stored workflow managed call is invalid.', { where: 'workflow_output', issues: { reason: 'invalid_checkpoint' } })
	}
	return value as unknown as WorkflowCallCheckpointV1
}
function parseWorkflowPublicationCheckpoint(value: unknown): WorkflowCallPublicationCheckpointV1 {
	if (!isPlainRecord(value) || !exactKeys(value, ['schemaVersion', 'kind', 'callId', 'eventIndex', 'eventDigest'])
		|| value['schemaVersion'] !== 1 || value['kind'] !== 'workflow_call_publication' || !nonempty(value['callId'])
		|| !Number.isSafeInteger(value['eventIndex']) || (value['eventIndex'] as number) < 0
		|| typeof value['eventDigest'] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value['eventDigest'])) {
		throw new ValidationError('Stored workflow managed call publication is invalid.', { where: 'workflow_output', issues: { reason: 'invalid_checkpoint' } })
	}
	return value as unknown as WorkflowCallPublicationCheckpointV1
}
function validDirectStoredOutcome(value: Record<string, unknown>, callId: string, operation: WorkflowManagedCallOperation, targetKind: ManagedTargetKind, targetId: string): boolean {
	if (value['status'] === 'completed') return exactKeys(value, ['status', 'output']) && isJsonValue(value['output'])
	if (value['status'] !== 'failed' && value['status'] !== 'cancelled' || !exactKeys(value, ['status', 'error']) || !isPlainRecord(value['error'])) return false
	const error = value['error']
	if (value['status'] === 'cancelled') return exactSerialized(error, 'OPERATION_CANCELLED', 'Workflow managed call was cancelled.', 'cancelled', false)
		&& isPlainRecord(error['meta']) && error['meta']['scope'] === targetKind
	return exactSerialized(error, 'WORKFLOW_MANAGED_CALL_FAILED', 'Workflow managed call failed.', 'internal', false) && isPlainRecord(error['meta'])
		&& exactKeys(error['meta'], ['reason', 'workflow_id', 'call_id', 'operation', 'target_kind', 'target_id']) && error['meta']['reason'] === 'operation_failed'
		&& error['meta']['call_id'] === callId && error['meta']['operation'] === operation && error['meta']['target_kind'] === targetKind && error['meta']['target_id'] === targetId
}
function isManagedTargetKind(value: unknown): value is ManagedTargetKind { return value === 'agent' || value === 'tool' || value === 'model' }
function isManagedOperation(value: unknown): value is WorkflowManagedCallOperation { return typeof value === 'string' && ['agent_run', 'tool_run', 'model_text', 'model_text_stream', 'model_object', 'model_object_stream', 'model_embed', 'model_rerank', 'model_image', 'model_speech', 'model_video', 'model_video_stream'].includes(value) }
function validChildStoredError(value: unknown, status: 'failed' | 'cancelled', workflowId: string, callId: string, agentId: string, timeoutMs: unknown): boolean {
	if (!isPlainRecord(value)) return false
	const meta = value['meta']
	if (status === 'cancelled') return exactSerialized(value, 'OPERATION_CANCELLED', 'Child task was cancelled.', 'cancelled', false) && isPlainRecord(meta) && meta['scope'] === 'child_task'
	if (value['code'] === 'OPERATION_TIMEOUT') return timeoutMs !== null && exactSerialized(value, 'OPERATION_TIMEOUT', 'Child task timed out.', 'timeout', true)
		&& isPlainRecord(meta) && meta['scope'] === 'child_task' && meta['timeout_ms'] === timeoutMs
	if (!exactSerialized(value, 'WORKFLOW_MANAGED_CALL_FAILED', 'Workflow managed call failed.', 'internal', false) || !isPlainRecord(value['meta'])) return false
	return exactKeys(value['meta'], ['reason', 'workflow_id', 'call_id', 'operation', 'target_kind', 'target_id'])
		&& value['meta']['reason'] === 'operation_failed' && value['meta']['workflow_id'] === workflowId && value['meta']['call_id'] === callId
		&& value['meta']['operation'] === 'agent_run' && value['meta']['target_kind'] === 'agent' && value['meta']['target_id'] === agentId
}
function exactSerialized(value: Record<string, unknown>, code: string, message: string, category: string, retriable: boolean): boolean {
	return exactKeys(value, ['code', 'message', 'category', 'retriable', 'meta']) && value['code'] === code && value['message'] === message
		&& value['category'] === category && value['retriable'] === retriable && isPlainRecord(value['meta'])
		&& (code === 'OPERATION_CANCELLED' ? exactKeys(value['meta'], ['scope']) : code === 'OPERATION_TIMEOUT' ? exactKeys(value['meta'], ['scope', 'timeout_ms']) : true)
}
function exactKeys(value: object, keys: readonly string[]): boolean {
	const allowed = new Set(keys)
	return keys.every(key => Object.prototype.hasOwnProperty.call(value, key)) && Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key))
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function managedJson(value: unknown): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (Array.isArray(value)) return value.map(managedJson)
	if (isPlainRecord(value)) return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, managedJson(child)]))
	throw new ValidationError('Workflow model output must be JSON.', { where: 'workflow_output', issues: { reason: 'invalid_json' } })
}
function managedModelJson(value: unknown, operation: WorkflowManagedCallOperation): JsonValue {
	const projected = managedJson(value)
	const providerNativeRaw = operation === 'model_text' || operation === 'model_object' || operation === 'model_embed' || operation === 'model_rerank'
	if (!providerNativeRaw || !isPlainRecord(projected) || !Object.prototype.hasOwnProperty.call(projected, 'raw')) return projected
	const { raw: _providerNativeRaw, ...portable } = projected
	return portable
}
function modelResponseError(reason: string): ValidationError {
	return new ValidationError('Workflow model stream response is invalid.', { where: 'model_response', issues: { reason } })
}
function validateFiniteStreamChunk(value: JsonValue, kind: 'text' | 'object', _alreadyFinished: boolean): void {
	if (!isPlainRecord(value) || typeof value['kind'] !== 'string') throw modelResponseError('malformed_chunk')
	const chunkKind = value['kind']
	if (kind === 'text') {
		if (chunkKind === 'delta' && exactKeys(value, ['kind', 'text']) && typeof value['text'] === 'string') return
		if (chunkKind === 'tool_call' && exactKeys(value, ['kind', 'call']) && validToolCall(value['call'])) return
		if (chunkKind === 'finish' && validModelFinish(value, false)) return
	} else {
		if (chunkKind === 'partial' && exactKeys(value, ['kind', 'partial']) && isJsonValue(value['partial'])) return
		if (chunkKind === 'delta' && exactKeys(value, ['kind', 'path', 'value']) && Array.isArray(value['path']) && value['path'].every(part => typeof part === 'string' || Number.isSafeInteger(part)) && isJsonValue(value['value'])) return
		if (chunkKind === 'tool_call' && exactKeys(value, ['kind', 'call']) && validToolCall(value['call'])) return
		if (chunkKind === 'finish' && isJsonValue(value['object']) && validModelFinish(value, true)) return
	}
	throw modelResponseError('malformed_chunk')
}
function validateVideoStreamChunk(value: JsonValue, state: 'start' | 'queued' | 'progress'): 'queued' | 'progress' {
	if (!isPlainRecord(value) || typeof value['kind'] !== 'string') throw modelResponseError('malformed_chunk')
	if (value['kind'] === 'queued' && state === 'start' && exactKeys(value, ['kind'])) return 'queued'
	if (value['kind'] === 'progress' && exactKeys(value, ['kind', 'progress']) && typeof value['progress'] === 'number'
		&& state !== 'start' && Number.isFinite(value['progress']) && value['progress'] >= 0 && value['progress'] <= 1) return 'progress'
	if (value['kind'] === 'finish' && state !== 'start' && exactKeys(value, ['kind', 'artifact']) && validArtifact(value['artifact'])) return state
	throw modelResponseError('malformed_chunk')
}
function validArtifact(value: unknown): boolean {
	if (!isPlainRecord(value)) return false
	const allowed = ['id', 'url', 'mediaType', 'filename', 'size', 'expiresAt', 'metadata']
	return exactKeysSubset(value, allowed) && nonempty(value['id']) && nonempty(value['url']) && nonempty(value['mediaType'])
		&& (value['filename'] === undefined || nonempty(value['filename']))
		&& (value['size'] === undefined || Number.isSafeInteger(value['size']) && (value['size'] as number) >= 0)
		&& (value['expiresAt'] === undefined || typeof value['expiresAt'] === 'string')
		&& (value['metadata'] === undefined || isPlainRecord(value['metadata']) && Object.values(value['metadata']).every(isJsonValue))
}
function validToolCall(value: unknown): boolean {
	return isPlainRecord(value) && exactKeys(value, ['id', 'name', 'arguments'])
		&& nonempty(value['id']) && nonempty(value['name']) && isJsonValue(value['arguments'])
}
function validModelFinish(value: Record<string, unknown>, object: boolean): boolean {
	const allowed = new Set(['kind', ...(object ? ['object'] : []), 'usage', 'finishReason', 'outcome', 'providerContinuation'])
	if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) return false
	const usage = value['usage']
	const usageKeys = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'reasoningTokens']
	if (!isPlainRecord(usage) || !exactKeysSubset(usage, usageKeys)
		|| !['inputTokens', 'outputTokens', 'totalTokens'].every(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && usage[key] >= 0)
		|| usageKeys.slice(3).some(key => usage[key] !== undefined && (typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || usage[key] < 0))) return false
	if (value['outcome'] !== undefined && !isJsonValue(value['outcome']) || value['providerContinuation'] !== undefined && !isJsonValue(value['providerContinuation'])) return false
	return typeof value['finishReason'] === 'string' && ['stop', 'length', 'context_limit', 'tool_calls', 'content_filter', 'refusal', 'pause', 'malformed', 'cancelled', 'error'].includes(value['finishReason'])
}
function exactKeysSubset(value: object, allowed: readonly string[]): boolean {
	return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key))
}
function applyObjectDelta(current: JsonValue | undefined, path: readonly (string | number)[], value: JsonValue): JsonValue {
	assertSafeDeltaPath(path)
	if (path.length === 0) return snapshotJson(value)
	const root = current === undefined ? (typeof path[0] === 'number' ? [] : Object.create(null) as Record<string, JsonValue>) : snapshotJson(current)
	if (root === null || typeof root !== 'object') throw modelResponseError('invalid_object_delta')
	let cursor: JsonValue = root
	for (let index = 0; index < path.length - 1; index += 1) {
		const key = path[index]!
		const nextKey = path[index + 1]!
		if (Array.isArray(cursor)) {
			if (typeof key !== 'number' || key < 0 || key > cursor.length) throw modelResponseError('invalid_object_delta')
			const existing = Object.prototype.hasOwnProperty.call(cursor, key) ? cursor[key] : undefined
			if (existing === undefined) cursor[key] = typeof nextKey === 'number' ? [] : Object.create(null) as Record<string, JsonValue>
			cursor = cursor[key]!
		} else if (isPlainRecord(cursor)) {
			if (typeof key !== 'string') throw modelResponseError('invalid_object_delta')
			const existing = Object.prototype.hasOwnProperty.call(cursor, key) ? cursor[key] : undefined
			if (existing === undefined) cursor[key] = typeof nextKey === 'number' ? [] : Object.create(null) as Record<string, JsonValue>
			cursor = cursor[key] as JsonValue
		} else throw modelResponseError('invalid_object_delta')
		if (cursor === null || typeof cursor !== 'object') throw modelResponseError('invalid_object_delta')
	}
	const leaf = path.at(-1)!
	if (Array.isArray(cursor)) {
		if (typeof leaf !== 'number' || leaf < 0 || leaf > cursor.length) throw modelResponseError('invalid_object_delta')
		cursor[leaf] = snapshotJson(value)
	} else if (isPlainRecord(cursor)) {
		if (typeof leaf !== 'string') throw modelResponseError('invalid_object_delta')
		cursor[leaf] = snapshotJson(value)
	} else throw modelResponseError('invalid_object_delta')
	return root
}
function assertSafeDeltaPath(path: readonly (string | number)[]): void {
	for (const segment of path) {
		if (typeof segment === 'string') {
			if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') throw modelResponseError('invalid_object_delta')
		} else if (!Number.isSafeInteger(segment) || segment < 0) throw modelResponseError('invalid_object_delta')
	}
}
function snapshotJson(value: JsonValue): JsonValue {
	if (value === null || typeof value !== 'object') return value
	if (Array.isArray(value)) return value.map(snapshotJson)
	if (!isPlainRecord(value)) throw modelResponseError('invalid_object_delta')
	const result = Object.create(null) as Record<string, JsonValue>
	for (const [key, child] of Object.entries(value)) {
		result[key] = snapshotJson(child as JsonValue)
	}
	return result
}
function modelCompletion(value: Record<string, unknown>): Readonly<{ usage?: never; finishReason?: never }> {
	return Object.freeze({ ...(isPlainRecord(value['usage']) ? { usage: value['usage'] as never } : {}), ...(typeof value['finishReason'] === 'string' ? { finishReason: value['finishReason'] as never } : {}) })
}
function validTimestamp(value: unknown): value is string {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
	const parsed = new Date(value)
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}
function opaqueId(kind: string, values: readonly JsonValue[]): string { return `${kind}_${digest([`harness.child-${kind}.v1`, ...values])}` }
function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex') }
function isPlainRecord(value: unknown): value is Record<string, unknown> { if (value === null || typeof value !== 'object' || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null }
