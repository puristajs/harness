import { createHash } from 'node:crypto'

import { ToolApprovalPendingError, type ToolApprovalInterrupt, type ToolApprovalResume } from '../approvals/index.js'
import { freezeAcceptedModelTurnCursor, freezeSuspendedAgentTurnState } from '../approvals/prepared-tool-checkpoint.js'
import type { AgentContinuationStateV1, PreparedToolCheckpointEntryV1, SuspendedAgentTurnStateV1 } from '../approvals/prepared-tool-checkpoint.js'
import { executeStandardAgent } from '../agents/standard-loop.js'
import type { AgentEventSink, AgentPipelineEvent, ExecutionEvent } from '../definitions/execution-events.js'
import { getDefinitionIdentity } from '../definitions/identity.js'
import type { AnyAgentDefinition, AnyWorkflowDefinition, BuiltInToolDefinition, ToolDefinition } from '../definitions/types.js'
import { ApprovalResumeError, HarnessConfigError, InternalError, OperationCancelledError, OperationTimeoutError, SandboxPermissionDeniedError, SandboxStateLostError, SessionBusyError, StateError, ValidationError, serializeError } from '../errors/index.js'
import { agentGuardrailsBinding, type ContentCaptureMode, type ConversationHistory, type HarnessInterrupt, type RunOutcome, type RunSummary, type SessionChildTasks, type TelemetryOptions } from '../harness/defineHarness.js'
import { normalizeHarnessIdentity } from '../identity/index.js'
import { JsonLogger, type Logger } from '../logger/index.js'
import { inMemoryMemoryEngine } from '../memory/in-memory.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import { createModelRegistry, type ModelHandle } from '../models/registry.js'
import type { Message, PersistedFinalRunEvent, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import { createMemoryFacade, createSessionMemory, type MemoryEngine, type SessionMemory } from '../ports/memory.js'
import type { ModelMessage } from '../ports/model-provider.js'
import type { HarnessTargetDispatchStream } from '../ports/target-dispatcher.js'
import { inMemorySandbox, type Sandbox, type SandboxScope, type SandboxSessionBase } from '../sandbox/index.js'
import { sessionOptionsSchema, type SessionOptions } from '../sandbox/ownership.js'
import { retainCompleteTurns } from '../sessions/history-retention.js'
import { validateSchema } from '../schema/validation.js'
import { loadSkillSnapshots, createReadSkillBinding, type LoadedSkillSnapshot } from '../skills/index.js'
import { InMemoryHarnessStorage } from '../storage/in-memory.js'
import type { DurableRunLease, RunCheckpoint, WorkflowChildCallCheckpointV1 } from '../storage/execution.js'
import type { AcquireRunRequest, AppliedApprovalDecisionV1, ApprovalResumeReceiptV1, HarnessStorage } from '../storage/types.js'
import { createMetrics, createTelemetryShim, type SpanAttrs, type TelemetryShim } from '../telemetry/index.js'
import { normalizeHarnessTraceContext, type HarnessTraceContext } from '../telemetry/trace-context.js'
import { ulid } from '../ulid/index.js'
import { bindBuiltInTool, bindPortableTool, type AgentExecutableBinding } from '../tools/bindings.js'
import { invokePreparedBuiltinTool, prepareBuiltinTool } from '../tools/index.js'
import { initializeMcpRuntimeBundles, type McpRuntimeBundle } from '../tools/mcp/runtime.js'
import { createWorkflowExecutionRuntime, restoreSessionChildTaskHandle, type WorkflowExecutionRuntime } from '../workflows/index.js'
import type { HarnessContracts } from '../definitions/catalog.js'
import { validateContextProjection, type ContextProjectionPolicy } from '../context-projection.js'
import type { DurableReplayCheckpoint, DurableWorkspacePolicy, WorkspaceHandle } from '../ports/workspace.js'
import type { CompiledDefinitionGraph } from './compiled-graph.js'
import type { ResolvedHarnessExecutionDefaults } from './execution-defaults.js'
import type { ValidatedHarnessInstanceBindings } from './instance-config.js'
import type { RuntimeRequirements } from './runtime-requirements.js'
import { createLocalTargetDispatcher, type LocalTargetBinding, type LocalTargetExecutionRequest } from './local-target-dispatcher.js'
import { canonicalJson } from './canonical-json.js'
import { createSubagentBinding, consumeHarnessTargetStream } from './subagent-execution.js'
import { createDurableWorkflowContext, createHarnessChildTargetInterruption, isHarnessChildTargetInterruption, type WorkflowAgentCallBudgetStateV1, type WorkflowChildCheckpointAccess } from './steps.js'
import { withAgentAdmission } from './agent-admission.js'
import { abortError } from './abort.js'

type AnyTargetContract = import('../ports/target-dispatcher.js').AnyHarnessTargetContract
type TargetInput<T extends AnyTargetContract> = import('../ports/target-dispatcher.js').HarnessTargetInput<T>
type TargetOutput<T extends AnyTargetContract> = import('../ports/target-dispatcher.js').HarnessTargetOutput<T>
type UncorrelatedExecutionEvent<Output extends JsonValue = JsonValue> = ExecutionEvent<Output> extends infer Event
	? Event extends ExecutionEvent<Output> ? Omit<Event, 'eventId' | 'sequence' | 'runId' | 'parentRunId' | 'parentInvocationId'> : never
	: never
type RootEventBody<Output extends JsonValue = JsonValue> =
	| Readonly<{ type: 'run.started'; at: string }>
	| Readonly<{ type: 'run.finished'; at: string; outcome: RunOutcome<Output> | Readonly<{ status: 'failed' | 'cancelled'; runId: string; error: ReturnType<typeof serializeError> }> }>
	| Readonly<{ type: 'model.completed'; agentId?: string; workflowId?: string; modelAlias: string; streamId?: string; operation: 'text' | 'object' | 'textStream' | 'objectStream'; usage?: import('../ports/model-provider.js').TokenUsage; finishReason?: import('../ports/model-provider.js').FinishReason }>

interface PendingInterruptionValue {
	readonly schemaVersion: 1
	readonly rootRunId: string
	readonly sessionId: string
	readonly rootTarget: Readonly<{ kind: 'agent' | 'workflow'; id: string }>
	readonly deploymentRevision: string
	readonly compiledGraphDigest: string
	readonly sessionIdentityDigest: string
	readonly interrupt: ToolApprovalInterrupt
	readonly continuation: SuspensionNodeValue
	readonly priorResumeReceipt?: ApprovalResumeReceiptV1
	readonly nextEventSequence: number
	readonly startedAgentRunIds: readonly string[]
}

type SuspensionFrameValue =
	| Readonly<{ kind: 'agent'; runId: string; invocationId: string; state: AgentContinuationStateV1 }>
	| Readonly<{ kind: 'workflow'; runId: string; workflowId: string; invocationId: string; input: JsonValue;
		activeCallIds: readonly string[]; agentCallBudget: WorkflowAgentCallBudgetStateV1 }>
	| Readonly<{ kind: 'host-tool'; runId: string; agentId: string; invocationId: string; toolId: string; callId: string;
		input: JsonValue; bindingId: string; bindingContractDigest: string; toolStarted: true; activeNestedCallIds: readonly string[] }>

interface SuspensionNodeValue {
	readonly frame: SuspensionFrameValue
	readonly children: readonly SuspensionNodeValue[]
}

interface ParsedPendingCheckpoint {
	readonly checkpoint: RunCheckpoint
	readonly value: ApprovalCheckpointValue
	readonly replayCurrentInterruption?: true
}

interface ActiveApprovalCheckpointValue {
	readonly schemaVersion: 1
	readonly kind: 'harness_interruption_resuming' | 'harness_post_approval'
	readonly rootRunId: string
	readonly sessionId: string
	readonly interruptId: string
	readonly resumeEventId: string
	readonly decisions: readonly AppliedApprovalDecisionV1[]
	readonly deploymentRevision: string
	readonly compiledGraphDigest: string
	readonly sessionIdentityDigest: string
	readonly continuation: SuspensionNodeValue
	readonly nextEventSequence: number
	readonly startedAgentRunIds: readonly string[]
}

type ApprovalCheckpointValue = PendingInterruptionValue | ActiveApprovalCheckpointValue

/** Stable durable invocation identity and optional recovery settings. */
export interface DurableInvokeOptions {
	readonly runId: string
	readonly workerId?: string
	readonly stepId?: string
	readonly attempt?: number
	readonly workspacePolicy?: Partial<DurableWorkspacePolicy>
}

/** Exact standalone invocation options. Host-only context is intentionally absent. */
export interface InvokeOptions {
	readonly signal?: AbortSignal
	readonly timeoutMs?: number
	readonly historyWindow?: number
	readonly idempotencyKey?: string
	readonly contextProjection?: ContextProjectionPolicy
	readonly traceparent?: string
	readonly tracestate?: string
	readonly metadata?: Readonly<Record<string, JsonValue>>
	readonly resume?: ToolApprovalResume
	readonly durable?: DurableInvokeOptions
}

export interface HarnessTargetInvoker<Target extends AnyTargetContract> {
	run(input: TargetInput<Target>, options?: InvokeOptions): Promise<RunOutcome<TargetOutput<Target>>>
	stream(input: TargetInput<Target>, options?: InvokeOptions): AsyncIterable<ExecutionEvent<TargetOutput<Target>>>
}

export interface HarnessSession<Contracts extends HarnessContracts> {
	readonly id: string
	readonly agents: Readonly<{ [Id in keyof Contracts['agents']]: HarnessTargetInvoker<Contracts['agents'][Id]> }>
	readonly workflows: Readonly<{ [Id in keyof Contracts['workflows']]: HarnessTargetInvoker<Contracts['workflows'][Id]> }>
	readonly childTasks: SessionChildTasks
	readonly memory: SessionMemory
	readonly history: ConversationHistory
	getRunSummary(runId: string): Promise<RunSummary | undefined>
	clearHistory(): Promise<void>
	replaceHistory(messages: readonly Omit<Message, 'id' | 'timestamp'>[]): Promise<void>
	release(): Promise<void>
	destroy(): Promise<void>
}

export type HarnessSessionOptions<Requirements extends RuntimeRequirements> = Requirements['sandbox']['required'] extends true
	? SessionOptions
	: Readonly<Omit<SessionOptions, 'sandboxOwner'> & { sandboxOwner?: never }>

export interface HarnessInstance<Contracts extends HarnessContracts, Requirements extends RuntimeRequirements = RuntimeRequirements> {
	getSession(id: string, options?: HarnessSessionOptions<Requirements>): Promise<HarnessSession<Contracts>>
	close(): Promise<void>
}

export interface InstantiateStandaloneHarnessOptions {
	readonly name: string
	readonly revision?: string
	readonly defaults: Readonly<ResolvedHarnessExecutionDefaults>
	readonly graph: CompiledDefinitionGraph
	readonly bindings: ValidatedHarnessInstanceBindings
}

interface SessionRuntime {
	record: SessionRecord
	readonly sandboxes: Map<string, SandboxSessionBase>
	readonly sandboxOpenings: Map<string, Promise<SandboxSessionBase>>
	ownerRegistration?: Promise<void>
	readonly controller: AbortController
	readonly taskRegistry: Map<string, import('../definitions/types.js').ChildTaskHandle<JsonValue>>
	readonly activeRoots: Map<string, Readonly<{ controller: ReturnType<typeof linkedController>; settled: Promise<void> }>>
	busy: boolean
	releasing: boolean
	released: boolean
	releasePromise?: Promise<void>
	sandboxTerminated?: boolean
	storageClosed?: boolean
	childSandboxCleanup?: Readonly<{ scope: SandboxScope; terminated: boolean }>
}

interface ActiveWorkspaceAttempt {
	readonly handle: WorkspaceHandle
	readonly sandboxSession: SandboxSessionBase
	pause(stepId: string, sequence: number, output: JsonValue, reason?: 'step_completed' | 'manual_pause'): Promise<DurableReplayCheckpoint>
	committed(replay: DurableReplayCheckpoint): Promise<void>
	suspend(): Promise<void>
	settle(status: 'succeeded' | 'failed' | 'cancelled'): Promise<void>
}

interface ChildSandboxHandoff {
	readonly taskRunId: string
	readonly policy?: import('../sandbox/ownership.js').SandboxPolicy<string>
	readonly defaultBehavior: 'inherit' | 'isolated-task'
	readonly source: EffectiveSandboxLaunchSource
}

interface ResolvedChildSandboxHandoff {
	readonly scope: SandboxScope
	readonly mode: 'create' | 'attach'
	readonly terminateOnRelease: boolean
	readonly source: EffectiveSandboxLaunchSource
}

interface EffectiveSandboxLaunchSource {
	readonly scope: SandboxScope
	readonly relation: 'owned' | 'borrowed'
	readonly authorizationRecord: SessionRecord
}

const unavailableSandboxOperation = async (): Promise<never> => {
	throw new InternalError('Sandbox access was not declared for this target.')
}
const UNAVAILABLE_SANDBOX_SESSION: SandboxSessionBase = Object.freeze({
	read: unavailableSandboxOperation,
	readText: unavailableSandboxOperation,
	write: unavailableSandboxOperation,
	remove: unavailableSandboxOperation,
	list: unavailableSandboxOperation,
	stat: unavailableSandboxOperation,
	exists: unavailableSandboxOperation,
	mount: unavailableSandboxOperation,
	executor: 'unavailable' as const,
	async close() {},
})

/** @internal Assembles one definition graph once into a private standalone runtime. */
export async function instantiateStandaloneHarness<Contracts extends HarnessContracts, Requirements extends RuntimeRequirements = RuntimeRequirements>(
	options: InstantiateStandaloneHarnessOptions,
): Promise<HarnessInstance<Contracts, Requirements>> {
	const instanceId = ulid()
	const logger = options.bindings.logger ?? new JsonLogger()
	const telemetry = withStandaloneTelemetryFlavor(createTelemetryShim(), options.bindings.telemetry)
	const contentCaptureMode = resolveContentCaptureMode(options.bindings.telemetry)
	const metrics = createMetrics(telemetry, { 'harness.name': options.name })
	const storage = options.bindings.storage ?? new InMemoryHarnessStorage()
	const memory = options.bindings.memory ?? inMemoryMemoryEngine()
	const sandbox = options.bindings.sandbox ?? inMemorySandbox()
	const requiresSandbox = options.graph.requirements.sandbox.required
	const requiresTargetSandbox = (definition: AnyAgentDefinition | AnyWorkflowDefinition): boolean => {
		if (definition.workspace === true) return true
		if (definition.kind !== 'agent') return false
		const interceptor = definition.guardrails?.[agentGuardrailsBinding]
		if ((definition.skills?.length ?? 0) > 0 || (interceptor?.requirements?.sandbox?.length ?? 0) > 0
			|| (interceptor?.requirements?.skillRuntimes?.length ?? 0) > 0) return true
		return (definition.tools ?? []).some(tool => {
			const identity = getDefinitionIdentity(tool)
			return identity?.kind === 'built-in-tool' || (identity?.kind === 'tool' && 'requires' in tool && (tool.requires?.sandbox?.length ?? 0) > 0)
		})
	}
	const owned = new Set<object>()
	if (options.bindings.storage === undefined) owned.add(storage)
	if (options.bindings.memory === undefined) owned.add(memory)
	if (options.bindings.sandbox === undefined) owned.add(sandbox)
	const closeStack: Array<() => Promise<void>> = []
	const sessions = new Map<string, SessionRuntime>()
	const sessionInitializers = new Map<string, Promise<SessionRuntime>>()
	const rootInputs = new Map<string, JsonValue>()
	const rootOptions = new Map<string, InvokeOptions>()
	const rootModes = new Map<string, 'run' | 'stream'>()
	const rootSettled = new Map<string, () => void>()
	const rootFailures = new Map<string, unknown>()
	const rootChildEventRelays = new Map<string, (event: ExecutionEvent<JsonValue>) => Promise<void>>()
	const childSandboxPolicies = new Map<string, ChildSandboxHandoff>()
	const effectiveSandboxScopes = new Map<string, EffectiveSandboxLaunchSource>()
	const directAgentRuns = new Map<string, Readonly<{ input: string; promise: Promise<RunOutcome<JsonValue>> }>>()
	const directStreamSettlers = new Map<string, Readonly<{
		resolve: (outcome: RunOutcome<JsonValue>) => void
		reject: (error: unknown) => void
	}>>()
	const instanceWorkerId = `worker_${ulid()}`
	let closed = false
	let closePromise: Promise<void> | undefined
	const instanceController = new AbortController()
	let modelRegistry!: Readonly<Record<string, ModelHandle>>

	const adapterContext = {
		harnessName: options.name, logger, telemetry, metrics, contentCaptureMode,
		defaults: {
			agentMaxIterations: options.defaults.maxSteps, runTimeoutMs: options.defaults.runTimeoutMs,
			toolTimeoutMs: options.defaults.toolTimeoutMs, decisionTimeoutMs: options.defaults.decisionTimeoutMs,
			skillTimeoutMs: options.defaults.skillTimeoutMs, modelTimeoutMs: options.defaults.modelTimeoutMs,
			maxParallelToolCalls: options.defaults.maxParallelToolCalls,
			...(options.defaults.historyWindow === undefined ? {} : { historyWindow: options.defaults.historyWindow }),
		},
	}
	let skills!: Readonly<Record<string, LoadedSkillSnapshot>>
	let mcpBundles: readonly McpRuntimeBundle[] = []
	let agentBindings!: readonly (readonly [object, Readonly<Record<string, AgentExecutableBinding>>])[]
	let graphDigest!: string
	let dispatcher!: ReturnType<typeof createLocalTargetDispatcher>
	try {
		modelRegistry = createModelRegistry(options.bindings.models, {
			telemetry, harnessName: options.name,
			...(options.bindings.admission === undefined ? {} : { admission: options.bindings.admission }),
			...(options.bindings.artifacts === undefined ? {} : { artifacts: options.bindings.artifacts }),
		}) as Readonly<Record<string, ModelHandle>>
		for (const value of [storage, memory, sandbox, options.bindings.workspace, options.bindings.artifacts]) {
			if (value && typeof value === 'object' && 'configureHarnessContext' in value && typeof value.configureHarnessContext === 'function') {
				value.configureHarnessContext(adapterContext)
			}
		}
		skills = await loadSkillSnapshots(Object.values(options.graph.skills))
		if (Object.keys(options.graph.mcpServers).length > 0) {
			mcpBundles = await initializeMcpRuntimeBundles({
				harnessName: options.name, harnessInstanceId: instanceId, servers: options.graph.mcpServers,
				bindings: options.bindings.mcp ?? {}, timeoutMs: options.defaults.toolTimeoutMs,
			})
			for (const bundle of mcpBundles) closeStack.push(() => bundle.close())
		}

		const mcpToolRows: Array<readonly [object, AgentExecutableBinding]> = []
		for (const bundle of mcpBundles) {
			const server = options.graph.mcpServers[bundle.serverId]!
			for (const [id, binding] of Object.entries(bundle.tools)) {
				const identity = getDefinitionIdentity(server.tools[id])
				if (identity) mcpToolRows.push(Object.freeze([identity.token, binding]))
			}
		}
		const mcpTools = Object.freeze(mcpToolRows)

		const agentBindingRows: Array<readonly [object, Readonly<Record<string, AgentExecutableBinding>>]> = []
		for (const agent of Object.values(options.graph.agents)) {
			const result: Record<string, AgentExecutableBinding> = {}
			for (const tool of agent.tools ?? []) {
				const identity = getDefinitionIdentity(tool)
				if (!identity) throw new InternalError('Compiled tool identity is unavailable.')
				if (identity.kind === 'tool') result[tool.id] = bindPortableTool(tool as ToolDefinition)
				else if (identity.kind === 'built-in-tool') result[tool.id] = bindBuiltInTool(tool as BuiltInToolDefinition, async (context, input) => invokePreparedBuiltinTool(prepareBuiltinTool(tool.id, input), context.sandbox, context.signal))
				else if (identity.kind === 'mcp-tool') {
					const binding = mcpTools.find(([token]) => token === identity.token)?.[1]
					if (!binding) throw new InternalError('Compiled MCP tool binding is unavailable.')
					result[tool.id] = binding
				} else throw new InternalError('Standalone Harness cannot bind a host tool.')
			}
			for (const [name, reference] of Object.entries(agent.subagents ?? {})) result[name] = createSubagentBinding(name, reference, {
				prepare: (context, child, childInvocationId, childSessionId) => prepareChildSandboxLaunch(agent,
					context.sessionId, context.runId, { kind: 'subagent', agent: child, childInvocationId, childSessionId,
						taskRunId: childInvocationId }),
				finish: childInvocationId => childSandboxPolicies.delete(childInvocationId),
			})
			const selectedSkills = Object.fromEntries((agent.skills ?? []).map(skill => [skill.id, skills[skill.id]!]))
			const reader = createReadSkillBinding(agent, selectedSkills)
			if (reader) result[reader.id] = reader
			const identity = getDefinitionIdentity(agent)!
			agentBindingRows.push(Object.freeze([identity.token, Object.freeze(result)]))
		}
		agentBindings = Object.freeze(agentBindingRows)
		graphDigest = compiledGraphDigest(options, agentBindings)

		const localAgentBindings = Object.freeze(Object.values(options.graph.agents).map((agent): LocalTargetBinding => Object.freeze({
			definition: agent,
			execute: (request: LocalTargetExecutionRequest<AnyAgentDefinition>) => openTarget(agent, request.input, request.invocation),
		})))
		const localWorkflowBindings = Object.freeze(Object.values(options.graph.workflows).map((workflow): LocalTargetBinding => Object.freeze({
			definition: workflow,
			execute: (request: LocalTargetExecutionRequest<AnyWorkflowDefinition>) => openTarget(workflow, request.input, request.invocation),
		})))
		dispatcher = createLocalTargetDispatcher({ defaultMaxDepth: options.defaults.maxDepth,
			bindings: Object.freeze([...localAgentBindings, ...localWorkflowBindings]) })
	} catch (error) {
		const failures = [normalizeInternal(error)]
		for (const close of [...closeStack].reverse()) try { await close() } catch (cleanup) { failures.push(normalizeInternal(cleanup)) }
		for (const resource of [...owned].reverse()) if ('close' in resource && typeof resource.close === 'function') {
			try { await resource.close() } catch (cleanup) { failures.push(normalizeInternal(cleanup)) }
		}
		if (failures.length > 1) throw new AggregateError(failures, 'Harness initialization failed and rollback cleanup failed.', { cause: failures[0] })
		throw failures[0]
	}

	function openTarget(
		definition: AnyAgentDefinition | AnyWorkflowDefinition,
		input: JsonValue,
		invocation: import('../ports/target-dispatcher.js').HarnessTargetDispatchRequest<AnyTargetContract>['invocation'],
	): Promise<HarnessTargetDispatchStream<JsonValue>> {
		const runId = invocation.invocationId
		if (!rootModes.has(runId)) rootModes.set(runId, 'run')
		const controller = linkedController(invocation.signal, invocation.deadline)
		const queue = new EventQueue<JsonValue>(() => controller.abort(new OperationCancelledError('Run was cancelled.', { scope: definition.kind })))
		const execute = () => executeTarget(definition, input, invocation, runId, controller.signal, queue)
		void (invocation.trace !== undefined && telemetry.withTraceContext !== undefined
			? telemetry.withTraceContext(invocation.trace, execute)
			: execute())
			.then(() => {
				const settler = directStreamSettlers.get(runId)
				if (settler === undefined) return
				const terminal = queue.terminalEvent
				if (terminal === undefined) settler.reject(new InternalError('Harness target execution ended without a terminal event.'))
				else {
					try { settler.resolve(terminalOutcome(terminal, definition)) }
					catch (error) { settler.reject(error) }
				}
			})
			.catch(error => {
				directStreamSettlers.get(runId)?.reject(error)
				rootFailures.set(runId, error)
				queue.fail(error)
				rootInputs.delete(runId)
				rootOptions.delete(runId)
				rootModes.delete(runId)
				childSandboxPolicies.delete(invocation.invocationId)
				rootSettled.get(runId)?.()
				rootSettled.delete(runId)
			})
			.finally(() => controller.dispose())
		return Promise.resolve(queue)
	}

	async function executeTarget(
		definition: AnyAgentDefinition | AnyWorkflowDefinition,
		input: JsonValue,
		invocation: import('../ports/target-dispatcher.js').HarnessTargetDispatchRequest<AnyTargetContract>['invocation'],
		runId: string,
		signal: AbortSignal,
		queue: EventQueue<JsonValue>,
	): Promise<void> {
		const childSandboxHandoff = childSandboxPolicies.get(invocation.invocationId)
		if (childSandboxHandoff !== undefined) childSandboxPolicies.delete(invocation.invocationId)
		if (childSandboxHandoff !== undefined) await authorizeSessionOwner(childSandboxHandoff.source.authorizationRecord)
		if (invocation.parentRunId !== undefined) {
			const root = await storage.getRun(invocation.rootRunId)
			const parentSession = root === undefined ? undefined : sessions.get(root.sessionId)
			if (parentSession !== undefined) await authorizeSessionOwner(parentSession.record)
		}
		const session = await ensureSession(invocation.sessionId, invocation.identity === undefined ? {} : { identity: invocation.identity }, childSandboxHandoff !== undefined)
		const persistedInput = rootInputs.get(runId) ?? input
		const invokeOptions = rootOptions.get(runId) ?? {}
		const existing = await storage.getRun(runId)
		const resume = invokeOptions.resume
		const run = resume === undefined
			? await storage.createRun({ id: runId, sessionId: invocation.sessionId, kind: definition.kind, target: definition.id,
				startedAt: existing?.startedAt ?? new Date().toISOString(), input: persistedInput,
				...(invokeOptions.metadata === undefined ? {} : { metadata: invokeOptions.metadata }) })
			: requireResumeRun(existing, resume, invocation.sessionId, definition, persistedInput)
		if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
			if (resume !== undefined) validateTerminalResume(run, resume, options, graphDigest, session.record, definition)
			const storedEvents = await storage.listEvents(runId)
			const boundaries = requirePersistedBoundaries(storedEvents, run)
			queue.push(restoreStartedEvent(boundaries.started))
			queue.push(restoreTerminalEvent(boundaries.terminal, run))
			queue.end()
			rootInputs.delete(runId)
			rootOptions.delete(runId)
			rootModes.delete(runId)
			rootSettled.get(runId)?.()
			rootSettled.delete(runId)
			return
		}
		let pendingCheckpoint: ParsedPendingCheckpoint | undefined
		if (resume !== undefined) {
			const checkpoint = await storage.loadCheckpoint(runId, 'harness:interrupt:v1')
			pendingCheckpoint = validateApprovalResume(checkpoint, resume, run, persistedInput, options, graphDigest, session.record, definition)
			if (pendingCheckpoint.replayCurrentInterruption === true) {
				if (!isPendingInterruptionValue(pendingCheckpoint.value)) throw new ApprovalResumeError('invalid_checkpoint')
				const storedEvents = await storage.listEvents(runId)
				const boundaries = requirePersistedBoundaries(storedEvents, run)
				queue.push(restoreStartedEvent(boundaries.started))
				queue.push(restoreTerminalEvent(boundaries.terminal, run, pendingCheckpoint.value.interrupt))
				queue.end()
				rootInputs.delete(runId)
				rootOptions.delete(runId)
				rootModes.delete(runId)
				childSandboxPolicies.delete(invocation.invocationId)
				rootSettled.get(runId)?.()
				rootSettled.delete(runId)
				return
			}
		}
		const approvalReachable = definition.kind === 'agent'
			? options.graph.approval.agents[definition.id]?.reachable === true
			: options.graph.approval.workflows[definition.id]?.reachable === true
			const leaseBacked = definition.durable === true || definition.workspace === true || approvalReachable
			if (definition.durable === true && session.record.sandboxBinding.relation === 'borrowed') {
				throw new HarnessConfigError('Durable invocations cannot use a borrowed sandbox owner.', {
					reason: 'invalid_runtime_binding', path: 'session.sandboxOwner', id: definition.id,
				})
			}
			const childSandboxScope = childSandboxHandoff === undefined ? undefined
				: resolveChildSandboxScope(options.name, definition, childSandboxHandoff)
			const targetNeedsSandbox = requiresTargetSandbox(definition)
				|| childSandboxHandoff?.policy !== undefined || definition.sandbox !== undefined
			if (targetNeedsSandbox && childSandboxScope === undefined) await ensureSandboxOwnerRegistered(session)
			const effectiveSandboxSource = childSandboxScope?.source ?? Object.freeze({
				scope: rootSandboxScope(options.name, definition, session.record.sandboxBinding.owner, runId,
					options.bindings.sandboxBinding?.defaultPolicy),
				relation: session.record.sandboxBinding.relation,
				authorizationRecord: session.record,
			})
		let lease: DurableRunLease | undefined
		if (leaseBacked) {
				const workerId = invokeOptions.durable?.workerId ?? instanceWorkerId
				const stepId = invokeOptions.durable?.stepId ?? 'harness:root:v1'
				const acquisitionStepId = resume === undefined ? stepId : 'harness:interrupt:v1'
				const optimisticCheckpoint = pendingCheckpoint?.checkpoint ?? await storage.loadCheckpoint(runId, acquisitionStepId)
				const expectedSequence = optimisticCheckpoint?.sequence ?? null
				const mode = resume !== undefined || run.revision > 1 || run.status !== 'running' || run.attempt !== undefined
					? 'resume' as const : 'initial' as const
			const expected = Object.freeze({ revision: run.revision, status: run.status as 'running' | 'waiting' | 'interrupted',
				checkpoint: Object.freeze({ stepId: acquisitionStepId, sequence: expectedSequence }) })
			const acquisitionId = `acq_${digest(['harness-run-acquisition-v1', mode, runId, invocation.sessionId, workerId,
				expected.revision, expected.status, acquisitionStepId, expectedSequence, invokeOptions.durable?.attempt ?? null])}`
			const acquisitionRequest: AcquireRunRequest = Object.freeze({ mode, runId, sessionId: invocation.sessionId, workerId, acquisitionId, expected,
				...(invokeOptions.durable?.attempt === undefined ? {} : { requestedAttempt: invokeOptions.durable.attempt }) })
				lease = await storage.acquireRun(acquisitionRequest)
				try { assertAcquiredLeaseSnapshot(lease, acquisitionRequest, run, optimisticCheckpoint) } catch (error) {
					try { await lease.release() } catch (releaseError) {
						throw new AggregateError([error, normalizeInternal(releaseError)], 'Harness lease validation failed and lease release failed.', { cause: error })
					}
					throw error
				}
			if (resume !== undefined && pendingCheckpoint !== undefined) {
				try {
					pendingCheckpoint = validateApprovalResume(lease.checkpoint, resume, lease.run, persistedInput, options, graphDigest, session.record, definition)
				} catch (error) {
					try { await lease.release() } catch (releaseError) {
						throw new AggregateError([error, normalizeInternal(releaseError)], 'Harness approval resume validation failed and lease release failed.', { cause: error })
					}
					throw error
				}
			}
		}
		let sequence = pendingCheckpoint === undefined ? 0 : pendingCheckpoint.value.nextEventSequence - 1
		const parentEventRunId = invocation.depth === 0 ? undefined : invocation.parentRunId
		const parentInvocationId = invocation.depth === 0 ? undefined : invocation.invocationId
		const persistAndQueue = async (body: AgentPipelineEvent | UncorrelatedExecutionEvent | RootEventBody) => {
			sequence += 1
			const event = correlatedEvent(runId, sequence, body, parentEventRunId, parentInvocationId)
			const existing = event.type === 'model.completed'
				? (await storage.listEvents(runId)).find(candidate => candidate.id === event.eventId)
				: undefined
			const persisted: PersistedRunEvent = Object.freeze({ id: event.eventId, sequence: event.sequence, runId,
				at: existing?.at ?? ('at' in event && typeof event.at === 'string' ? event.at : new Date().toISOString()), type: event.type,
				payload: privacySafeEventPayload(event) })
			try { await storage.appendEvents(runId, [persisted]) } catch (error) {
				metrics.counter('harness.events.persist_errors', 1, { harness: options.name })
				logger.error('Failed to persist run events.', { harness: options.name, run_id: runId, error: serializeError(error) })
			}
			queue.push(event)
		}
		const emit = async (body: AgentPipelineEvent | UncorrelatedExecutionEvent | RootEventBody) => {
			if (queue.wouldOverflow(1)) {
				const dropped = queue.reserve(2)
				await persistAndQueue({ type: 'stream.overflow', at: new Date().toISOString(), dropped })
			}
			await persistAndQueue(body)
		}
		const relayChildEvent = async (event: ExecutionEvent<JsonValue>) => {
			const rootRelay = invocation.depth === 0 ? undefined : rootChildEventRelays.get(invocation.rootRunId)
			if (rootRelay !== undefined) {
				await rootRelay(event)
				return
			}
			if (queue.wouldOverflow(1)) {
				const dropped = queue.reserve(2)
				await persistAndQueue({ type: 'stream.overflow', at: new Date().toISOString(), dropped })
			}
			queue.push(event)
		}
		const resumeAgentNode = async (node: SuspensionNodeValue, expectedRunId: string): Promise<JsonValue> => {
			if (node.frame.kind !== 'agent' || node.frame.runId !== expectedRunId) throw new ApprovalResumeError('invalid_checkpoint')
			const child = options.graph.agents[node.frame.state.agentId]
			const childRun = await storage.getRun(expectedRunId)
			if (!child || !childRun) throw new ApprovalResumeError('invalid_checkpoint')
			const childResume = Object.freeze({ type: 'tool-approval' as const, runId: expectedRunId,
				interruptId: resume!.interruptId, revision: resume!.revision, eventId: resume!.eventId,
				decisions: resume!.decisions })
			rootInputs.set(expectedRunId, childRun.input)
			rootOptions.set(expectedRunId, Object.freeze({ resume: childResume }))
			rootModes.set(expectedRunId, 'run')
			const parentNode = findSuspensionParent(resumedContinuation, node.frame.invocationId)
			if (parentNode === undefined || parentNode.frame.kind === 'host-tool') throw new ApprovalResumeError('invalid_checkpoint')
			const parentDefinition = parentNode.frame.kind === 'agent'
				? options.graph.agents[parentNode.frame.state.agentId]
				: options.graph.workflows[parentNode.frame.workflowId]
			if (parentDefinition === undefined) throw new ApprovalResumeError('invalid_checkpoint')
			if (resumedContinuation === undefined) throw new ApprovalResumeError('invalid_checkpoint')
			const resumeParentSandboxSource = resolveResumeSandboxSource(resumedContinuation, parentNode.frame.invocationId,
				effectiveSandboxScopes.get(invocation.invocationId))
			const childController = linkedController(signal, invocation.deadline)
			const childInvocation = Object.freeze({ sessionId: node.frame.state.sessionId,
				invocationId: node.frame.invocationId, rootRunId: node.frame.state.rootRunId, parentRunId: parentNode.frame.runId,
				...(parentNode.frame.kind === 'agent' ? { parentAgentId: parentNode.frame.state.agentId } : { parentWorkflowId: parentNode.frame.workflowId }),
				depth: (invocation.depth ?? 0) + 1,
				remainingDepth: Math.max(0, (invocation.remainingDepth ?? options.defaults.maxDepth) - 1),
				...(invocation.identity === undefined ? {} : { identity: invocation.identity }),
				...(invocation.deadline === undefined ? {} : { deadline: invocation.deadline }), signal: childController.signal })
			await prepareChildSandboxLaunch(parentDefinition, invocation.sessionId, parentNode.frame.runId, {
				kind: parentNode.frame.kind === 'workflow' ? 'inline' : 'subagent', agent: child, childInvocationId: node.frame.invocationId,
				childSessionId: node.frame.state.sessionId, taskRunId: expectedRunId,
			}, resumeParentSandboxSource)
			try {
				const stream = await openTarget(child, childRun.input, childInvocation)
				const consumed = await consumeHarnessTargetStream({ stream, signal, parentRunId: parentNode.frame.runId,
					childInvocationId: node.frame.invocationId, relay: relayChildEvent })
				if (consumed.outcome.status === 'completed') return consumed.outcome.output
				if (consumed.outcome.status === 'interrupted') throw createHarnessChildTargetInterruption(node.frame.invocationId, consumed.outcome)
				if (consumed.outcome.status === 'cancelled') throw new OperationCancelledError('Subagent execution was cancelled.', { scope: 'agent' }, consumed.outcome.error)
				throw new InternalError('Subagent execution failed.', undefined, consumed.outcome.error)
			} finally { childSandboxPolicies.delete(node.frame.invocationId); childController.dispose() }
		}
		const resumeSuspendedChild = async (entry: Extract<PreparedToolCheckpointEntryV1, { state: 'suspended-child' }>): Promise<JsonValue> => {
			const node = findSuspensionNode(resumedContinuation, entry.childInvocationId)
			if (node === undefined) throw new ApprovalResumeError('invalid_checkpoint')
			return resumeAgentNode(node, entry.childRunId)
		}
		let approvalReceipt: ApprovalResumeReceiptV1 | undefined
		let resumedAgentState: AgentContinuationStateV1 | undefined
		let resumedWorkflowFrame: Extract<SuspensionFrameValue, { kind: 'workflow' }> | undefined
		let resumedContinuation: SuspensionNodeValue | undefined
		let resumeCheckpointSequence = pendingCheckpoint?.checkpoint.sequence
		let resumeReplacement = Promise.resolve()
		let workspaceAttempt: ActiveWorkspaceAttempt | undefined
		if (pendingCheckpoint !== undefined && resume !== undefined && lease !== undefined) {
			approvalReceipt = approvalReceiptFor(resume, pendingCheckpoint.value, options, session.record, definition)
			if (definition.kind === 'agent') resumedAgentState = requireRootAgentFrame(pendingCheckpoint.value, definition)
			else resumedWorkflowFrame = requireRootWorkflowFrame(pendingCheckpoint.value, definition)
			resumedContinuation = pendingCheckpoint.value.continuation
			if (isPendingInterruptionValue(pendingCheckpoint.value)) {
				const replacement = resumingCheckpoint(pendingCheckpoint.value, approvalReceipt)
				await storage.replaceCheckpoint({ runId, sessionId: invocation.sessionId, stepId: 'harness:interrupt:v1',
					expectedSequence: pendingCheckpoint.checkpoint.sequence, leaseId: lease.leaseId, workerId: lease.workerId,
					replacement: checkpointReplacement(pendingCheckpoint.checkpoint, pendingCheckpoint.checkpoint.sequence + 1, replacement, lease) })
				resumeCheckpointSequence = pendingCheckpoint.checkpoint.sequence + 1
			}
		}
		try {
			workspaceAttempt = await openWorkspaceAttempt(definition, session, runId, lease, invokeOptions, signal)
		} catch (error) {
			if (lease !== undefined) {
				try { await lease.release() } catch (releaseError) {
					throw new AggregateError([error, normalizeInternal(releaseError)], 'Workspace initialization failed and lease release failed.', { cause: error })
				}
			}
			throw error
		}
		if (invocation.depth === 0) rootChildEventRelays.set(runId, relayChildEvent)
		effectiveSandboxScopes.set(invocation.invocationId, effectiveSandboxSource)
		try {
			await telemetry.span('harness.session.run', {
			'harness.name': options.name, 'harness.session.id': invocation.sessionId, 'harness.run.id': runId,
			...(definition.kind === 'workflow' ? { 'harness.workflow.id': definition.id } : {}),
			'harness.telemetry.content_capture_mode': contentCaptureMode,
		}, async sessionSpan => {
		const installInterruptionCheckpoint = async (value: JsonValue) => {
			if (lease === undefined) return
			const nextSequence = (resumeCheckpointSequence ?? 0) + 1
			const replay = await workspaceAttempt?.pause('harness:interrupt:v1', nextSequence, value, 'manual_pause')
			if (resumeCheckpointSequence === undefined) {
				await storage.commitCheckpoint({ runId, sessionId: invocation.sessionId, leaseId: lease.leaseId,
					workerId: lease.workerId, stepId: 'harness:interrupt:v1', input: persistedInput,
					attempt: lease.attempt, sequence: nextSequence, output: value,
					...(replay === undefined ? {} : { replay }), metadata: { checkpointKind: 'harness_interruption', schemaVersion: 1 } })
			} else {
				await storage.replaceCheckpoint({ runId, sessionId: invocation.sessionId, stepId: 'harness:interrupt:v1',
					expectedSequence: resumeCheckpointSequence, leaseId: lease.leaseId, workerId: lease.workerId,
					replacement: checkpointReplacement(pendingCheckpoint!.checkpoint, nextSequence, value, lease, replay) })
			}
			if (replay !== undefined) await workspaceAttempt!.committed(replay)
			resumeCheckpointSequence = nextSequence
		}
		if (pendingCheckpoint === undefined) await emit({ type: 'run.started', at: new Date().toISOString() })
		else {
			const started = (await storage.listEvents(runId)).find(event => event.sequence === 1)
			if (!started) throw new ApprovalResumeError('invalid_checkpoint')
			queue.push(restoreStartedEvent(started))
		}
		await telemetry.span(definition.kind === 'agent' ? `invoke_agent ${definition.id}` : 'harness.workflow.run', {
			'harness.name': options.name, 'harness.session.id': invocation.sessionId, 'harness.run.id': runId,
			...(definition.kind === 'agent'
				? { 'harness.agent.id': definition.id, 'gen_ai.operation.name': 'invoke_agent' }
				: { 'harness.workflow.id': definition.id, 'gen_ai.operation.name': 'invoke_workflow' }),
		}, async targetSpan => {
		let activeWorkflowRuntime: Pick<WorkflowExecutionRuntime<undefined, undefined>, 'agentCallBudgetState' | 'activeCallIds'> | undefined
		let activeWorkflowInput: JsonValue = input
		let conversationTurn: readonly Message[] = Object.freeze([])
		try {
			const memoryFacade = createMemoryFacade({ engine: memory, harnessName: options.name, sessionId: invocation.sessionId,
				...(invocation.identity === undefined ? {} : { identity: invocation.identity }), runId,
				...(definition.kind === 'agent' ? { agentId: definition.id } : {}),
				signal, logger, telemetry, metrics, contentCaptureMode })
			let output: JsonValue
			if (definition.kind === 'agent') {
				const sessionSandbox = workspaceAttempt?.sandboxSession
						?? (targetNeedsSandbox ? await ensureSessionSandbox(session, definition, childSandboxScope) : UNAVAILABLE_SANDBOX_SESSION)
				const identity = getDefinitionIdentity(definition)!
				const selectedSkills = Object.freeze(Object.fromEntries((definition.skills ?? []).map(skill => [skill.id, skills[skill.id]!])) as Record<string, LoadedSkillSnapshot>)
				const historyWindow = invokeOptions.historyWindow ?? options.defaults.historyWindow
				const history = await storage.listMessages(invocation.sessionId, historyWindow === undefined ? {} : { limit: historyWindow })
				const sink: AgentEventSink = Object.freeze({ emit })
				const contextProjection = invokeOptions.contextProjection
					?? options.bindings.models[definition.model]?.contextProjection
					?? options.defaults.contextProjection
				const execute = () => executeStandardAgent({
					agent: definition, mode: rootModes.get(runId) ?? 'stream', input, inputValidation: 'already-validated-target', history: history.map(toModelMessage),
					model: requireModel(definition.model), modelAlias: definition.model,
					bindings: agentBindings.find(([token]) => token === identity.token)?.[1] ?? {}, skills: selectedSkills, defaults: options.defaults,
					...(contextProjection === undefined ? {} : { contextProjection }),
					invocation: Object.freeze({ harnessName: options.name, sessionId: invocation.sessionId, runId,
						rootRunId: invocation.rootRunId, ...(parentEventRunId === undefined ? {} : { parentRunId: parentEventRunId }),
						...(parentInvocationId === undefined ? {} : { parentInvocationId }),
						invocationId: invocation.invocationId, agentId: definition.id, signal,
						metadata: invokeOptions.metadata ?? Object.freeze({}), depth: invocation.depth, remainingDepth: invocation.remainingDepth }),
					interceptorRuntime: Object.freeze({ history: Object.freeze({ list: (listOptions?: { limit?: number; before?: string }) => storage.listMessages(invocation.sessionId, listOptions) }),
						models: modelRegistry, memory: memoryFacade, metrics, logger, telemetry }),
					onModelCompleted: event => emit(Object.freeze({ type: 'model.completed' as const, ...event })),
					toolContext: Object.freeze({ harnessName: options.name, sessionId: invocation.sessionId, runId,
						rootRunId: invocation.rootRunId, ...(parentEventRunId === undefined ? {} : { parentRunId: parentEventRunId }),
						...(parentInvocationId === undefined ? {} : { parentInvocationId }),
						invocationId: invocation.invocationId, agentId: definition.id, depth: invocation.depth,
						remainingDepth: invocation.remainingDepth, ...(invocation.trace === undefined ? {} : { trace: invocation.trace }),
						...(invocation.identity === undefined ? {} : { identity: invocation.identity }),
							...(invocation.deadline === undefined ? {} : { deadline: invocation.deadline }),
							...(invokeOptions.idempotencyKey === undefined ? {} : { idempotencyKey: invokeOptions.idempotencyKey }), signal,
						metadata: invokeOptions.metadata ?? Object.freeze({}), logger, metrics, telemetry, memory: memoryFacade, sandbox: sessionSandbox,
						targetDispatcher: dispatcher, relayChildEvent, checkpointStep: async (_id, handler) => handler() }),
					sink,
					...(resumedAgentState === undefined || approvalReceipt === undefined || lease === undefined ? {} : {
						resume: Object.freeze({ state: resumedAgentState, decisions: approvalReceipt.decisions,
							onEntry: (entry: PreparedToolCheckpointEntryV1) => {
								resumeReplacement = resumeReplacement.then(async () => {
									const state = resumedAgentState
									if (state === undefined || 'kind' in state) throw new ApprovalResumeError('invalid_checkpoint')
									const entries = state.entries.map(current => current.call.id === entry.call.id ? entry : current)
									resumedAgentState = Object.freeze({ ...state, entries: Object.freeze(entries) })
									resumedContinuation = replaceAgentNodeState(resumedContinuation!, state.invocationId, resumedAgentState)
									const expectedSequence = resumeCheckpointSequence!
									const value = resumingCheckpoint(pendingCheckpoint!.value, approvalReceipt!, resumedContinuation!)
									await storage.replaceCheckpoint({ runId, sessionId: invocation.sessionId, stepId: 'harness:interrupt:v1',
										expectedSequence, leaseId: lease!.leaseId, workerId: lease!.workerId,
										replacement: checkpointReplacement(pendingCheckpoint!.checkpoint, expectedSequence + 1, value, lease!) })
									resumeCheckpointSequence = expectedSequence + 1
								})
								return resumeReplacement
							},
							onAcceptedModelTurn: cursor => {
								resumeReplacement = resumeReplacement.then(async () => {
									resumedAgentState = cursor
									resumedContinuation = replaceAgentNodeState(resumedContinuation!, cursor.invocationId, cursor)
									const expectedSequence = resumeCheckpointSequence!
									const value = postApprovalCheckpoint(pendingCheckpoint!.value, approvalReceipt!, resumedContinuation!, sequence + 1)
									await storage.replaceCheckpoint({ runId, sessionId: invocation.sessionId, stepId: 'harness:interrupt:v1',
										expectedSequence, leaseId: lease!.leaseId, workerId: lease!.workerId,
										replacement: checkpointReplacement(pendingCheckpoint!.checkpoint, expectedSequence + 1, value, lease!) })
									resumeCheckpointSequence = expectedSequence + 1
								})
								return resumeReplacement
							},
							onContinuationState: state => {
								resumeReplacement = resumeReplacement.then(async () => {
									resumedAgentState = state
									resumedContinuation = replaceAgentNodeState(resumedContinuation!, state.invocationId, state)
									const expectedSequence = resumeCheckpointSequence!
									const value = postApprovalCheckpoint(pendingCheckpoint!.value, approvalReceipt!, resumedContinuation!, sequence + 1)
									await storage.replaceCheckpoint({ runId, sessionId: invocation.sessionId, stepId: 'harness:interrupt:v1',
										expectedSequence, leaseId: lease!.leaseId, workerId: lease!.workerId,
										replacement: checkpointReplacement(pendingCheckpoint!.checkpoint, expectedSequence + 1, value, lease!) })
									resumeCheckpointSequence = expectedSequence + 1
								})
								return resumeReplacement
							},
							resumeSuspendedChild,
						}),
					}),
				})
				const result = await withAgentAdmission(options.bindings.agentAdmission, {
					agentId: definition.id, rootRunId: invocation.rootRunId, parentRunId: invocation.parentRunId,
					depth: invocation.depth, ...(invocation.deadline === undefined ? {} : { deadline: invocation.deadline }), signal,
				}, execute, { logger })
				await resumeReplacement
				output = result.output
					conversationTurn = Object.freeze(result.conversationMessages.map((message, index) =>
						toPersistedMessage(message, invocation.sessionId, runId, index, run.startedAt)))
			} else {
				if (lease === undefined && (definition.durable === true || approvalReachable)) throw new InternalError('Workflow recovery lease is unavailable.')
				let childCheckpointSequence = Math.max(0, ...(lease?.checkpoints.map(checkpoint => checkpoint.sequence) ?? []))
				const workflowCheckpoint: WorkflowChildCheckpointAccess | undefined = lease === undefined ? undefined : Object.freeze({
					rootInput: persistedInput,
					load: (stepId: string) => storage.loadCheckpoint(runId, stepId),
					commit: async (stepId: string, checkpointOutput: JsonValue, metadata: Readonly<{ checkpointKind: 'workflow_child_call'; schemaVersion: 1 }>) => {
						childCheckpointSequence += 1
						await storage.commitCheckpoint({ runId, sessionId: invocation.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
							stepId, input: persistedInput, attempt: lease.attempt, sequence: childCheckpointSequence, output: checkpointOutput, metadata })
					},
				})
				if (resumedWorkflowFrame !== undefined) {
					if (resumedContinuation === undefined || approvalReceipt === undefined || pendingCheckpoint === undefined || lease === undefined
						|| resumedContinuation.children.length !== resumedWorkflowFrame.activeCallIds.length || workflowCheckpoint === undefined) {
						throw new ApprovalResumeError('invalid_checkpoint')
					}
					for (let index = 0; index < resumedContinuation.children.length; index += 1) {
						const childNode = resumedContinuation.children[index]!
						if (childNode.frame.kind !== 'agent') throw new ApprovalResumeError('invalid_checkpoint')
						const childRun = await storage.getRun(childNode.frame.runId)
						if (childRun === undefined) throw new ApprovalResumeError('invalid_checkpoint')
						const childOutput = await resumeAgentNode(childNode, childNode.frame.runId)
						const callId = resumedWorkflowFrame.activeCallIds[index]!
						const stored: WorkflowChildCallCheckpointV1 = Object.freeze({ schemaVersion: 1, kind: 'workflow_child_call', callId,
							target: Object.freeze({ kind: 'agent', id: childNode.frame.state.agentId }), input: childRun.input,
							outcome: Object.freeze({ status: 'completed', output: childOutput }), lineage: Object.freeze({ rootRunId: runId,
								workflowRunId: runId, workflowInvocationId: resumedWorkflowFrame.invocationId, childRunId: childNode.frame.runId,
								childInvocationId: childNode.frame.invocationId }) })
						await workflowCheckpoint.commit(`workflow:call:${callId}`, stored as unknown as JsonValue,
							Object.freeze({ checkpointKind: 'workflow_child_call', schemaVersion: 1 }))
					}
					resumedContinuation = Object.freeze({ frame: resumedWorkflowFrame, children: Object.freeze([]) })
					const expectedSequence = resumeCheckpointSequence!
					const value = resumingCheckpoint(pendingCheckpoint.value, approvalReceipt, resumedContinuation)
					await storage.replaceCheckpoint({ runId, sessionId: invocation.sessionId, stepId: 'harness:interrupt:v1', expectedSequence,
						leaseId: lease.leaseId, workerId: lease.workerId,
						replacement: checkpointReplacement(pendingCheckpoint.checkpoint, expectedSequence + 1, value, lease) })
					resumeCheckpointSequence = expectedSequence + 1
				}
				const runtime = createWorkflowExecutionRuntime({ workflow: definition, models: workflowModels(definition), targetDispatcher: dispatcher,
					signal, lifecycleSignal: instanceController.signal, sessionId: invocation.sessionId, runId, rootRunId: invocation.rootRunId,
					invocationId: invocation.invocationId, depth: invocation.depth, remainingDepth: invocation.remainingDepth,
					defaults: options.defaults,
					...(invocation.identity === undefined ? {} : { identity: invocation.identity }),
					...(invocation.trace === undefined ? {} : { trace: invocation.trace }),
					...(invocation.deadline === undefined ? {} : { deadline: invocation.deadline }),
					storage, durable: definition.durable === true, emit, relayChildEvent,
					approval: options.graph.approval.agents, taskRegistry: session.taskRegistry,
					prepareChildLaunch: request => prepareChildSandboxLaunch(definition, invocation.sessionId, runId, request),
					authorizeChildLaunch: async () => { await authorizeChildSandboxLaunch(definition, invocation.sessionId, runId) },
					finishChildLaunch: childInvocationId => childSandboxPolicies.delete(childInvocationId),
					onChildTaskTerminal: cleanupBackgroundChildSession,
					...(workflowCheckpoint === undefined ? {} : { checkpoint: workflowCheckpoint }),
					...(resumedWorkflowFrame === undefined ? {} : { restoredAgentCallBudget: resumedWorkflowFrame.agentCallBudget }) })
				activeWorkflowRuntime = runtime
				const workflowInput = resumedWorkflowFrame?.input ?? input
				activeWorkflowInput = workflowInput
				const checkpointStep = definition.durable === true && lease !== undefined
					? createDurableWorkflowContext(storage, lease, { signal,
						...(workspaceAttempt === undefined ? {} : {
							onStepCommit: (commit) => workspaceAttempt!.pause(commit.stepId, commit.sequence, commit.output),
							onStepCommitted: (checkpoint) => checkpoint.replay === undefined
								? Promise.resolve() : workspaceAttempt!.committed(checkpoint.replay),
						}),
					}).step
					: async (_id: string, handler: () => Promise<JsonValue>) => handler()
				const context = Object.freeze({ input: workflowInput, agents: runtime.agents, models: runtime.models, childTasks: runtime.childTasks,
					fanOut: runtime.fanOut, signal, runId, sessionId: invocation.sessionId, metadata: invokeOptions.metadata ?? Object.freeze({}),
					logger, telemetry, metrics, memory: memoryFacade, step: checkpointStep })
				const raw = await definition.handler(context)
				const validated = await validateSchema(definition.output, raw, { where: 'workflow_output', message: 'Workflow output validation failed.' })
				if (!isJsonValue(validated)) throw new ValidationError('Workflow output validation failed.', { where: 'workflow_output', issues: { reason: 'non_json_workflow_output' } })
				output = validated
			}
			if (conversationTurn.length > 0) await commitConversationTurn(storage, invocation.sessionId, conversationTurn, options.defaults.historyRetention)
			const outcome = Object.freeze({ status: 'completed' as const, runId, output })
			const at = new Date().toISOString()
			if (lease) {
				const terminal = correlatedEvent(runId, sequence + 1, { type: 'run.finished', at, outcome }, parentEventRunId, parentInvocationId)
				await storage.finalizeRun({ runId, sessionId: invocation.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
						patch: { status: 'succeeded', finishedAt: at, output, ...(approvalReceipt === undefined ? {} : { approvalReceipt }) }, terminalEvent: persistedFinalEvent(terminal), checkpointDisposition: 'delete-all' })
				const authoritative = await requireAuthoritativeTerminalRun(storage, runId, 'succeeded')
				sequence += 1
				queue.push(restoreTerminalEvent(persistedFinalEvent(terminal), authoritative))
			} else {
				await storage.finishRun(runId, { status: 'succeeded', finishedAt: at, output })
				const authoritative = await requireAuthoritativeTerminalRun(storage, runId, 'succeeded')
				await emit({ type: 'run.finished', at, outcome: Object.freeze({ status: 'completed' as const, runId, output: authoritative.output! }) })
			}
			await workspaceAttempt?.settle('succeeded')
			await updateSessionRunCount(session)
		} catch (error) {
			if (error instanceof ToolApprovalPendingError) {
				if (lease && error.preparedState) {
					const pendingValue = JSON.parse(canonicalJson(Object.freeze({ schemaVersion: 1, rootRunId: runId, sessionId: invocation.sessionId,
						rootTarget: Object.freeze({ kind: definition.kind, id: definition.id }), deploymentRevision: options.revision!,
						compiledGraphDigest: graphDigest, sessionIdentityDigest: identityDigest(session.record.identity),
						interrupt: error.interrupt, continuation: Object.freeze({ frame: Object.freeze({ kind: 'agent', runId,
							invocationId: invocation.invocationId, state: error.preparedState }), children: Object.freeze([]) }),
						...(approvalReceipt === undefined ? {} : { priorResumeReceipt: approvalReceipt }),
						nextEventSequence: sequence + 2, startedAgentRunIds: Object.freeze([runId]) }))) as JsonValue
					await installInterruptionCheckpoint(pendingValue)
				}
				if (lease) await lease.release()
				else await storage.finishRun(runId, { status: 'interrupted' })
				await workspaceAttempt?.suspend()
				await emit({ type: 'run.finished', at: new Date().toISOString(), outcome: Object.freeze({ status: 'interrupted' as const, runId, interrupt: error.interrupt }) })
			} else if (isHarnessChildTargetInterruption(error)) {
				if (lease && (error.preparedState || activeWorkflowRuntime)) {
					const childCheckpoint = await storage.loadCheckpoint(error.outcome.runId, 'harness:interrupt:v1')
					if (!childCheckpoint || !isPendingInterruptionValue(childCheckpoint.output)) throw new ApprovalResumeError('invalid_checkpoint')
					const parentFrame: SuspensionFrameValue = error.preparedState
						? Object.freeze({ kind: 'agent', runId, invocationId: invocation.invocationId, state: error.preparedState })
						: Object.freeze({ kind: 'workflow', runId, workflowId: definition.id, invocationId: invocation.invocationId, input: activeWorkflowInput,
							activeCallIds: activeWorkflowRuntime!.activeCallIds(), agentCallBudget: activeWorkflowRuntime!.agentCallBudgetState() })
					const pendingValue = JSON.parse(canonicalJson(Object.freeze({ schemaVersion: 1, rootRunId: runId, sessionId: invocation.sessionId,
						rootTarget: Object.freeze({ kind: definition.kind, id: definition.id }), deploymentRevision: options.revision!,
						compiledGraphDigest: graphDigest, sessionIdentityDigest: identityDigest(session.record.identity),
						interrupt: childCheckpoint.output.interrupt,
						continuation: Object.freeze({ frame: parentFrame, children: Object.freeze([childCheckpoint.output.continuation]) }),
						...(approvalReceipt === undefined ? {} : { priorResumeReceipt: approvalReceipt }),
						nextEventSequence: sequence + 2, startedAgentRunIds: Object.freeze([runId, ...childCheckpoint.output.startedAgentRunIds]) }))) as JsonValue
					await installInterruptionCheckpoint(pendingValue)
				}
				if (lease) await lease.release()
				else await storage.finishRun(runId, { status: 'interrupted' })
				await workspaceAttempt?.suspend()
				await emit({ type: 'run.finished', at: new Date().toISOString(), outcome: Object.freeze({ status: 'interrupted' as const, runId, interrupt: error.outcome.interrupt }) })
			} else {
				const terminalError = signal.aborted && !(error instanceof OperationCancelledError) && !(error instanceof OperationTimeoutError)
					? abortError(signal, definition.kind, 'Harness target execution was cancelled.')
					: error
				recordStandaloneSpanFailure(targetSpan, terminalError)
				recordStandaloneSpanFailure(sessionSpan, terminalError)
				const serialized = serializeError(terminalError)
				const status = terminalError instanceof OperationCancelledError ? 'cancelled' as const : 'failed' as const
				const at = new Date().toISOString()
				const outcome = Object.freeze({ status, runId, error: serialized })
				if (lease) {
					const terminal = correlatedEvent(runId, sequence + 1, { type: 'run.finished', at, outcome }, parentEventRunId, parentInvocationId)
					await storage.finalizeRun({ runId, sessionId: invocation.sessionId, leaseId: lease.leaseId, workerId: lease.workerId,
						patch: { status, finishedAt: at, error: serialized, ...(approvalReceipt === undefined ? {} : { approvalReceipt }) }, terminalEvent: persistedFinalEvent(terminal), checkpointDisposition: 'delete-all' })
					const authoritative = await requireAuthoritativeTerminalRun(storage, runId, status)
					sequence += 1
					queue.push(restoreTerminalEvent(persistedFinalEvent(terminal), authoritative))
				} else {
					await storage.finishRun(runId, { status, finishedAt: at, error: serialized })
					const authoritative = await requireAuthoritativeTerminalRun(storage, runId, status)
					await emit({ type: 'run.finished', at, outcome: Object.freeze({ status, runId, error: authoritative.error! }) })
				}
				await workspaceAttempt?.settle(status === 'cancelled' ? 'cancelled' : 'failed')
				await updateSessionRunCount(session)
				queue.setFailure(terminalError)
				rootFailures.set(runId, terminalError)
			}
		}
		})
		})
		} finally {
			queue.end()
			if (invocation.depth === 0) rootChildEventRelays.delete(runId)
			effectiveSandboxScopes.delete(invocation.invocationId)
			rootInputs.delete(runId)
			rootOptions.delete(runId)
			rootModes.delete(runId)
			childSandboxPolicies.delete(invocation.invocationId)
			rootSettled.get(runId)?.()
			rootSettled.delete(runId)
		}
	}

	async function ensureSession(id: string, rawOptions: SessionOptions, deferOwnerRegistration = false): Promise<SessionRuntime> {
		if (closed) throw new StateError('Harness instance is closed.', { op: 'getSession', reason: 'instance_closed' })
		const parsed = sessionOptionsSchema.parse(rawOptions)
		const normalizedIdentity = normalizeHarnessIdentity(parsed.identity)
		const known = sessions.get(id)
		if (known && !known.released) {
			assertSessionRequestMatches(known.record, normalizedIdentity, parsed.sandboxOwner)
			await authorizeSessionOwner(known.record)
			if (!deferOwnerRegistration && requiresSandbox && known.record.sandboxBinding.registration === 'pending') await ensureSandboxOwnerRegistered(known)
			return known
		}
		const pending = sessionInitializers.get(id)
		if (pending !== undefined) {
			const state = await pending
			assertSessionRequestMatches(state.record, normalizedIdentity, parsed.sandboxOwner)
			await authorizeSessionOwner(state.record)
			if (!deferOwnerRegistration && requiresSandbox && state.record.sandboxBinding.registration === 'pending') await ensureSandboxOwnerRegistered(state)
			return state
		}
		const initialize = (async (): Promise<SessionRuntime> => {
			let record = await storage.getSession(id)
			let inserted = false
			if (record === undefined) {
				const recordId = ulid()
				const owner = parsed.sandboxOwner ?? Object.freeze({ namespace: options.name, id, instanceId: recordId,
					...(normalizedIdentity === undefined ? {} : { identity: normalizedIdentity }) })
				const relation = parsed.sandboxOwner === undefined ? 'owned' as const : 'borrowed' as const
				const at = new Date().toISOString()
				const candidate: SessionRecord = Object.freeze({ id, instanceId: recordId, createdAt: at, updatedAt: at, runCount: 0,
					...(normalizedIdentity === undefined ? {} : { identity: normalizedIdentity }),
					sandboxBinding: Object.freeze({ owner, relation,
						registration: relation === 'owned' && requiresSandbox ? 'pending' as const : 'registered' as const,
						policyDigest: digest(['harness.session-sandbox.v1', options.name, id]), disposed: false }) })
				inserted = await storage.upsertSession(candidate, 'create')
				record = await storage.getSession(id)
				if (record === undefined) throw new StateError('Stored session winner is unavailable.', { op: 'getSession', reason: 'session_instance_mismatch' })
				}
				try {
				assertSessionRequestMatches(record, normalizedIdentity, parsed.sandboxOwner)
				await authorizeSessionOwner(record)
				let ownerRegistration: Promise<void> | undefined
				if (!deferOwnerRegistration && requiresSandbox && record.sandboxBinding.relation === 'owned' && record.sandboxBinding.registration === 'pending') {
						await sandbox.registerOwner({ owner: record.sandboxBinding.owner, mode: 'create' })
						const updated = Object.freeze({ ...record, updatedAt: new Date().toISOString(),
							sandboxBinding: Object.freeze({ ...record.sandboxBinding, registration: 'registered' as const }) })
						await storage.upsertSession(updated, 'update')
						const authoritative = await storage.getSession(updated.id)
						if (authoritative === undefined) throw new StateError('Registered session record is unavailable.', {
							op: 'getSession', reason: 'session_instance_mismatch',
						})
						record = authoritative
						ownerRegistration = Promise.resolve()
				}
				const value: SessionRuntime = { record, sandboxes: new Map(), sandboxOpenings: new Map(), controller: new AbortController(), taskRegistry: new Map(), activeRoots: new Map(), busy: false, releasing: false, released: false }
				if (ownerRegistration !== undefined) value.ownerRegistration = ownerRegistration
				sessions.set(id, value)
				return value
			} catch (error) {
				if (inserted) {
					try { await storage.closeSession(record.id, record.instanceId) } catch (cleanup) {
						throw new AggregateError([error, normalizeInternal(cleanup)], 'Session initialization failed and rollback cleanup failed.', { cause: error })
					}
				}
				throw error
			}
		})()
		sessionInitializers.set(id, initialize)
		try { return await initialize } finally { if (sessionInitializers.get(id) === initialize) sessionInitializers.delete(id) }
	}

	async function updateSessionRunCount(state: SessionRuntime): Promise<void> {
		const updated = Object.freeze({ ...state.record, updatedAt: new Date().toISOString(), runCount: state.record.runCount + 1 })
		try {
			await storage.upsertSession(updated, 'update')
			const authoritative = await storage.getSession(updated.id)
			if (authoritative === undefined) throw new StateError('Updated session record is unavailable.', {
				op: 'getSession', reason: 'session_instance_mismatch',
			})
			state.record = authoritative
		} catch (error) {
			logger.error('Failed to update the terminal session summary.', { harness: options.name,
				session_id: state.record.id, error: serializeError(error) })
		}
	}

	async function ensureSessionSandbox(state: SessionRuntime, definition?: AnyAgentDefinition | AnyWorkflowDefinition,
		scopeOverride?: ResolvedChildSandboxHandoff): Promise<SandboxSessionBase> {
		if (scopeOverride === undefined) await ensureSandboxOwnerRegistered(state)
		const partition = definition === undefined
			? Object.freeze({ kind: 'shared' as const })
			: targetSandboxPartition(options.name, definition, options.bindings.sandboxBinding?.defaultPolicy)
		const scope = scopeOverride?.scope ?? Object.freeze({ owner: state.record.sandboxBinding.owner, partition, lifetime: 'session' as const })
		const key = canonicalJson(scope as unknown as JsonValue)
		const known = state.sandboxes.get(key)
		if (known !== undefined) return known
		const opening = state.sandboxOpenings.get(key)
		if (opening !== undefined) return opening
		const pending = (async () => {
			const opened = await sandbox.open({ scope, mode: scopeOverride?.mode ?? (state.record.sandboxBinding.relation === 'borrowed' ? 'attach' : 'create'),
				...(state.record.identity === undefined ? {} : { identity: state.record.identity }), signal: state.controller.signal })
			try {
				for (const skill of Object.values(skills)) await skill.mountReadOnly(opened.session)
				state.sandboxes.set(key, opened.session)
				if (scopeOverride?.terminateOnRelease === true) {
					state.childSandboxCleanup = Object.freeze({ scope, terminated: false })
				}
				return opened.session
			} catch (error) {
				try { await opened.session.close() } catch (cleanup) {
					throw new AggregateError([error, normalizeInternal(cleanup)], 'Session sandbox initialization failed and rollback cleanup failed.', { cause: error })
				}
				throw error
			}
		})()
		state.sandboxOpenings.set(key, pending)
		try { return await pending } finally { if (state.sandboxOpenings.get(key) === pending) state.sandboxOpenings.delete(key) }
	}

	async function prepareChildSandboxLaunch(
		parent: AnyAgentDefinition | AnyWorkflowDefinition,
		parentSessionId: string,
		parentRunId: string,
		request: Readonly<{ kind: 'inline' | 'background' | 'subagent'; agent: AnyAgentDefinition; childInvocationId: string;
			childSessionId: string; taskRunId: string; policy?: import('../sandbox/ownership.js').SandboxPolicy<string> }>,
		trustedSource?: EffectiveSandboxLaunchSource,
	): Promise<void> {
		const source = trustedSource ?? await authorizeChildSandboxLaunch(parent, parentSessionId, parentRunId)
		if (trustedSource !== undefined) await authorizeSessionOwner(trustedSource.authorizationRecord)
		if (childSandboxPolicies.has(request.childInvocationId)) throw new InternalError('Child launch sandbox handoff already exists.')
		childSandboxPolicies.set(request.childInvocationId, Object.freeze({ taskRunId: request.taskRunId,
			...(request.policy === undefined ? {} : { policy: request.policy }),
			defaultBehavior: request.kind === 'background' ? 'isolated-task' : 'inherit',
			source,
		}))
	}

	async function authorizeChildSandboxLaunch(
		parent: AnyAgentDefinition | AnyWorkflowDefinition,
		parentSessionId: string,
		parentRunId: string,
	): Promise<EffectiveSandboxLaunchSource> {
		const parentSession = sessions.get(parentSessionId)
		if (parentSession === undefined || parentSession.released) throw new InternalError('Child launch parent session is unavailable.')
		const source = effectiveSandboxScopes.get(parentRunId) ?? Object.freeze({
			scope: rootSandboxScope(options.name, parent, parentSession.record.sandboxBinding.owner, parentRunId,
				options.bindings.sandboxBinding?.defaultPolicy),
			relation: parentSession.record.sandboxBinding.relation,
			authorizationRecord: parentSession.record,
		})
		await authorizeSessionOwner(source.authorizationRecord)
		return source
	}

	function resolveResumeSandboxSource(
		root: SuspensionNodeValue,
		parentInvocationId: string,
		rootSource: EffectiveSandboxLaunchSource | undefined,
	): EffectiveSandboxLaunchSource | undefined {
		if (rootSource === undefined) return undefined
		const path = findSuspensionPath(root, parentInvocationId)
		if (path === undefined) throw new ApprovalResumeError('invalid_checkpoint')
		let source = rootSource
		for (const node of path.slice(1)) {
			if (node.frame.kind !== 'agent') throw new ApprovalResumeError('invalid_checkpoint')
			const definition = options.graph.agents[node.frame.state.agentId]
			if (definition === undefined) throw new ApprovalResumeError('invalid_checkpoint')
			source = resolveChildSandboxScope(options.name, definition, Object.freeze({ taskRunId: node.frame.runId,
				defaultBehavior: 'inherit', source })).source
		}
		return source
	}

	async function cleanupBackgroundChildSession(childSessionId: string): Promise<void> {
		const child = sessions.get(childSessionId)
		if (child === undefined || child.released) return
		try { await releaseSession(child, false) }
		catch (error) {
			logger.warn('Background child sandbox cleanup will be retried during Harness close.', {
				harness: options.name, session_id: childSessionId, error: serializeError(error),
			})
		}
	}

	async function authorizeSessionOwner(record: SessionRecord): Promise<void> {
		if (record.sandboxBinding.relation !== 'borrowed') return
		const ownerIdentity = record.sandboxBinding.owner.identity
		const actorIdentity = record.identity
		if (ownerIdentity?.tenantId !== actorIdentity?.tenantId
			|| (ownerIdentity?.principalId !== undefined && ownerIdentity.principalId !== actorIdentity?.principalId)
			|| (ownerIdentity?.tenantId === undefined && ownerIdentity?.principalId === undefined && actorIdentity?.principalId !== undefined)) {
			throw new SandboxPermissionDeniedError('scope_mismatch')
		}
		const authorize = options.bindings.sandboxBinding?.authorizeOwner
		if (authorize === undefined) throw new HarnessConfigError('A borrowed sandbox owner requires authorizeOwner.', {
			reason: 'invalid_runtime_binding', path: 'sandboxBinding.authorizeOwner',
		})
		let allowed: boolean
		try {
			allowed = await authorize(Object.freeze({ owner: record.sandboxBinding.owner,
				...(record.identity === undefined ? {} : { identity: record.identity }), harnessName: options.name, sessionId: record.id }))
		} catch (error) {
			throw new SandboxPermissionDeniedError('owner_not_authorized', normalizeInternal(error))
		}
		if (allowed !== true) throw new SandboxPermissionDeniedError('owner_not_authorized')
	}

	async function ensureSandboxOwnerRegistered(state: SessionRuntime): Promise<void> {
		if (!requiresSandbox) return
		if (state.ownerRegistration !== undefined) return state.ownerRegistration
		const pending = (async () => {
			await authorizeSessionOwner(state.record)
			const registration = state.record.sandboxBinding.registration
			await sandbox.registerOwner({ owner: state.record.sandboxBinding.owner,
				mode: state.record.sandboxBinding.relation === 'owned' && registration === 'pending' ? 'create' : 'attach' })
			if (registration === 'pending') {
				const updated = Object.freeze({ ...state.record, updatedAt: new Date().toISOString(),
					sandboxBinding: Object.freeze({ ...state.record.sandboxBinding, registration: 'registered' as const }) })
				await storage.upsertSession(updated, 'update')
				const authoritative = await storage.getSession(updated.id)
				if (authoritative === undefined) throw new StateError('Registered session record is unavailable.', {
					op: 'getSession', reason: 'session_instance_mismatch',
				})
				state.record = authoritative
			}
		})()
		state.ownerRegistration = pending
		try { await pending } catch (error) { if (state.ownerRegistration === pending) delete state.ownerRegistration; throw error }
	}

	async function openWorkspaceAttempt(
		definition: AnyAgentDefinition | AnyWorkflowDefinition,
		state: SessionRuntime,
		runId: string,
		lease: DurableRunLease | undefined,
		invokeOptions: InvokeOptions,
		signal: AbortSignal,
	): Promise<ActiveWorkspaceAttempt | undefined> {
		if (definition.workspace !== true) return undefined
		const workspace = options.bindings.workspace
		if (workspace === undefined) throw new InternalError('Compiled workspace binding is unavailable.')
		const attempt = lease?.attempt ?? 1
		const replay = lease?.checkpoints.filter(checkpoint => checkpoint.replay !== undefined)
			.sort((left, right) => right.sequence - left.sequence)[0]?.replay
		let handle: WorkspaceHandle
		if (lease?.resumed === true) {
			if (replay?.workspaceRef === undefined || replay.checkpointRef.length === 0) {
				throw new SandboxStateLostError('A committed workspace checkpoint is required to recover this run.', {
					reason: 'durable_workspace_recovery_unavailable', lifetime: 'run',
				})
			}
			handle = await workspace.resumeWorkspace({ workspaceRef: replay.workspaceRef, checkpointRef: replay.checkpointRef,
				runId, sessionId: state.record.id, attempt, idempotencyKey: `${runId}:${attempt}:resume`, signal })
		} else {
			handle = await workspace.startWorkspace({ runId, sessionId: state.record.id,
				...(definition.kind === 'agent' ? { agentId: definition.id } : { workflowId: definition.id }),
				sandboxOwner: state.record.sandboxBinding.owner, sandboxPolicyDigest: sandboxLayoutDigest(options),
				workerId: lease?.workerId ?? instanceWorkerId, attempt, idempotencyKey: `${runId}:start`,
				...(invokeOptions.durable?.workspacePolicy === undefined ? {} : { policy: invokeOptions.durable.workspacePolicy }), signal })
		}
		const partition = targetSandboxPartition(options.name, definition, options.bindings.sandboxBinding?.defaultPolicy)
		let runSandbox: SandboxSessionBase
		try {
			runSandbox = (await sandbox.open({ scope: Object.freeze({ owner: state.record.sandboxBinding.owner, partition,
				lifetime: 'run' as const, runId }), mode: lease?.resumed === true ? 'restore' : 'create',
				...(state.record.identity === undefined ? {} : { identity: state.record.identity }), signal })).session
		} catch (error) {
			const rollbackFailures: unknown[] = []
			try { releaseWorkspaceRunBinding(workspace, runId, state.record.sandboxBinding.owner) } catch (rollbackError) {
				rollbackFailures.push(normalizeInternal(rollbackError))
			}
			try {
				await workspace.abortWorkspace({ workspaceRef: handle.workspaceRef, runId, sessionId: state.record.id,
					reason: 'failed', idempotencyKey: `${runId}:abort:setup` })
			} catch (rollbackError) { rollbackFailures.push(normalizeInternal(rollbackError)) }
			if (workspace.info.policy.retention?.cleanupMode === 'adapter_automatic') {
				try { await workspace.cleanupWorkspace({ workspaceRef: handle.workspaceRef, reason: 'aborted', idempotencyKey: `${runId}:cleanup:setup` }) }
				catch (rollbackError) { rollbackFailures.push(normalizeInternal(rollbackError)) }
			}
			if (rollbackFailures.length > 0) throw new AggregateError([error, ...rollbackFailures],
				'Workspace initialization failed and rollback cleanup failed.', { cause: error })
			throw error
		}
		let pinnedCheckpointRef = replay?.checkpointRef
		let closed = false
		const closeBinding = async () => {
			if (closed) return
			closed = true
			try { await runSandbox.close() } finally {
				releaseWorkspaceRunBinding(workspace, runId, state.record.sandboxBinding.owner)
			}
		}
		return Object.freeze({
			handle, sandboxSession: runSandbox,
			async pause(stepId: string, sequence: number, output: JsonValue, reason: 'step_completed' | 'manual_pause' = 'step_completed') {
				const checkpoint = await workspace.pauseWorkspace({ handle, sandboxPartitions: Object.freeze([partition]),
					stepId, sequence, attempt, checkpointPayload: output, reason,
					idempotencyKey: `${runId}:${attempt}:pause:${stepId}:${sequence}`, signal })
				await workspace.pinCheckpoint({ workspaceRef: checkpoint.workspaceRef, checkpointRef: checkpoint.checkpointRef,
					runId, idempotencyKey: `${runId}:${attempt}:pin:${checkpoint.checkpointRef}`, signal })
				return Object.freeze({ runId, sessionId: state.record.id, sandboxPolicyDigest: checkpoint.sandboxPolicyDigest,
					sandboxPartitions: checkpoint.sandboxPartitions, workerId: lease?.workerId ?? instanceWorkerId,
					...(lease === undefined ? {} : { leaseId: lease.leaseId }), stepId, sequence, attempt,
					checkpointRef: checkpoint.checkpointRef, workspaceRef: checkpoint.workspaceRef,
					...(checkpoint.snapshotRef === undefined ? {} : { snapshotRef: checkpoint.snapshotRef }),
					schemaVersion: 1 as const, committedAt: checkpoint.committedAt,
					...(checkpoint.expiresAt === undefined ? {} : { expiresAt: checkpoint.expiresAt }) })
			},
			async committed(current: DurableReplayCheckpoint) {
				if (pinnedCheckpointRef !== undefined && pinnedCheckpointRef !== current.checkpointRef) {
					await workspace.releaseCheckpoint({ workspaceRef: handle.workspaceRef, checkpointRef: pinnedCheckpointRef,
						runId, idempotencyKey: `${runId}:${attempt}:release:${pinnedCheckpointRef}`, signal })
				}
				pinnedCheckpointRef = current.checkpointRef
			},
			async suspend() { await closeBinding() },
			async settle(status: 'succeeded' | 'failed' | 'cancelled') {
				const failures: unknown[] = []
				try { await closeBinding() } catch (error) { failures.push(error) }
				try { await workspace.finish({ workspaceRef: handle.workspaceRef, runId, status,
					idempotencyKey: `${runId}:finish:${status}` }) } catch (error) { failures.push(error) }
				if (pinnedCheckpointRef !== undefined) {
					try { await workspace.releaseCheckpoint({ workspaceRef: handle.workspaceRef, checkpointRef: pinnedCheckpointRef,
						runId, idempotencyKey: `${runId}:release:terminal` }) } catch (error) { failures.push(error) }
				}
				if (status === 'cancelled') {
					try { await workspace.abortWorkspace({ workspaceRef: handle.workspaceRef, runId, sessionId: state.record.id,
						reason: 'cancelled', idempotencyKey: `${runId}:abort` }) } catch (error) { failures.push(error) }
				}
				if (workspace.info.policy.retention?.cleanupMode === 'adapter_automatic') {
					try { await workspace.cleanupWorkspace({ workspaceRef: handle.workspaceRef,
						reason: status === 'succeeded' ? 'terminal_success' : status === 'failed' ? 'terminal_failure' : 'aborted',
						idempotencyKey: `${runId}:cleanup` }) } catch (error) { failures.push(error) }
				}
				if (failures.length > 0) logger.warn('Terminal workspace cleanup failed.', { harness: options.name, run_id: runId,
					workspace_id: workspace.info.id, failure_count: failures.length })
			},
		})
	}

	async function getSession(id: string, sessionOptions: SessionOptions = {}): Promise<HarnessSession<Contracts>> {
		if (typeof id !== 'string' || id.length === 0) throw new ValidationError('Session id is invalid.', { where: 'invoke_options', issues: { reason: 'invalid_session_id' } })
		if (!requiresSandbox && sessionOptions.sandboxOwner !== undefined) throw new HarnessConfigError('A sandbox owner cannot be supplied when the graph does not require sandboxing.', {
			reason: 'invalid_runtime_binding', path: 'session.sandboxOwner',
		})
		const state = await ensureSession(id, sessionOptions)
		const invokers = (definitions: Readonly<Record<string, AnyAgentDefinition | AnyWorkflowDefinition>>) => Object.freeze(Object.fromEntries(
			Object.entries(definitions).map(([targetId, definition]) => [targetId, createInvoker(state, definition)]),
		))
		const publicSession = {
			id,
			agents: invokers(options.graph.agents), workflows: invokers(options.graph.workflows),
				childTasks: Object.freeze({
					async get(taskId: string) {
						const resident = state.taskRegistry.get(taskId)
						if (resident !== undefined) return resident
						const record = await storage.getRun(taskId)
						return record === undefined ? undefined : restoreSessionChildTaskHandle(record, id)
					},
					async list(listOptions?: { limit?: number; before?: string }) {
						const allRecords = await storage.listRuns(id)
						let records = allRecords.filter(record => record.kind === 'child_task')
						if (listOptions?.before !== undefined) {
							const before = records.findIndex(record => record.id === listOptions.before)
							if (before >= 0) records = records.slice(before + 1)
						}
						if (listOptions?.limit !== undefined) records = records.slice(0, listOptions.limit)
						const rows = await Promise.all(records.flatMap(record => {
							const handle = state.taskRegistry.get(record.id) ?? restoreSessionChildTaskHandle(record, id)
							return handle === undefined ? [] : [handle.status()]
						}))
						return Object.freeze(rows)
					},
				}) as SessionChildTasks,
			memory: createSessionMemory({ engine: memory, harnessName: options.name, sessionId: id,
				...(state.record.identity === undefined ? {} : { identity: state.record.identity }), signal: state.controller.signal,
				logger, telemetry, metrics, contentCaptureMode }, { kind: 'session', scopeKey: `${options.name}:session:${id}` }),
			history: Object.freeze({ list: (listOptions?: { limit?: number; before?: string }) => storage.listMessages(id, listOptions) }),
			async getRunSummary(runId: string) {
				const run = await storage.getRun(runId)
				return run === undefined ? undefined : summarize(run, await storage.listEvents(runId))
			},
			clearHistory: () => {
				if (state.busy) throw new SessionBusyError('Session history cannot change during a run.', { session_id: id, reason: 'history_clear_during_run' })
				return storage.clearMessages(id)
			},
			async replaceHistory(rows: readonly Omit<Message, 'id' | 'timestamp'>[]) {
				if (state.busy) throw new SessionBusyError('Session history cannot change during a run.', { session_id: id, reason: 'history_replace_during_run' })
				if (!storage.replaceMessages) throw new StateError('Storage cannot replace session history.', { op: 'replaceMessages', reason: 'unsupported' })
				await storage.replaceMessages(id, rows.map(row => ({ ...row, id: ulid(), timestamp: new Date().toISOString() })))
			},
			async release() { await releaseSession(state, false) },
			async destroy() { await releaseSession(state, true) },
		}
		return Object.freeze(publicSession) as HarnessSession<Contracts>
	}

	function createInvoker(state: SessionRuntime, definition: AnyAgentDefinition | AnyWorkflowDefinition): HarnessTargetInvoker<AnyTargetContract> {
		const start = (mode: 'run' | 'stream', input: JsonValue, invokeOptions: InvokeOptions = {}) => {
			if (closed || state.released || state.releasing) throw new StateError('Harness invocation is unavailable.', { op: 'getRun', reason: closed ? 'instance_closed' : 'session_released' })
			const normalizedInvokeOptions = normalizeInvokeOptions(invokeOptions)
			if (normalizedInvokeOptions.signal?.aborted) throw abortError(normalizedInvokeOptions.signal, 'run', 'Run was cancelled.')
			if (!isJsonValue(input)) throw new ValidationError('Harness target input must be JSON.', {
				where: definition.kind === 'agent' ? 'agent_input' : 'workflow_input', issues: { reason: 'non_json_input' },
			})
			if (normalizedInvokeOptions.durable !== undefined && definition.durable !== true) {
				throw new ValidationError('Invocation durability is not declared by the target.', { where: 'invoke_options', issues: { reason: 'target_not_durable' } })
			}
			if (definition.durable === true && state.record.sandboxBinding.relation === 'borrowed') {
				throw new HarnessConfigError('Durable invocations cannot use a borrowed sandbox owner.', {
					reason: 'invalid_runtime_binding', path: 'session.sandboxOwner', id: definition.id,
				})
			}
			if (state.busy) throw new SessionBusyError('Session already has an active run.', { session_id: state.record.id, reason: 'concurrent_run' })
			state.busy = true
			const runId = normalizedInvokeOptions.resume?.runId ?? normalizedInvokeOptions.durable?.runId
				?? (definition.kind === 'agent' && normalizedInvokeOptions.idempotencyKey !== undefined
					? directAgentDeliveryId(state.record.id, definition.id, normalizedInvokeOptions.idempotencyKey)
					: `run_${ulid()}`)
			rootInputs.set(runId, JSON.parse(canonicalJson(input)) as JsonValue)
			rootOptions.set(runId, normalizedInvokeOptions)
			rootModes.set(runId, mode)
			const controller = linkedController([
				...(normalizedInvokeOptions.signal === undefined ? [] : [normalizedInvokeOptions.signal]),
				state.controller.signal, instanceController.signal,
			],
				normalizedInvokeOptions.timeoutMs === 0 ? undefined : Date.now() + (normalizedInvokeOptions.timeoutMs ?? options.defaults.runTimeoutMs))
			const trace = invocationTrace(normalizedInvokeOptions, logger)
			let settleRoot!: () => void
			const settled = new Promise<void>(resolve => { settleRoot = resolve })
			rootSettled.set(runId, () => {
				state.busy = false
				state.activeRoots.delete(runId)
				controller.dispose()
				settleRoot()
			})
			state.activeRoots.set(runId, Object.freeze({ controller, settled }))
			const invocation = Object.freeze({ sessionId: state.record.id, invocationId: runId, rootRunId: runId, parentRunId: runId,
					depth: 0, remainingDepth: options.defaults.maxDepth,
					...(state.record.identity === undefined ? {} : { identity: state.record.identity }),
					...(trace === undefined ? {} : { trace }),
					...(controller.deadline === undefined ? {} : { deadline: controller.deadline }),
					...(normalizedInvokeOptions.idempotencyKey === undefined ? {} : { idempotencyKey: normalizedInvokeOptions.idempotencyKey }), signal: controller.signal })
			const opened = normalizedInvokeOptions.resume === undefined
				? dispatcher.open({ target: definition.contract, input, invocation })
				: openTarget(definition, input, invocation)
			return lazyDispatchStream(opened.catch(error => {
				rootInputs.delete(runId)
				rootOptions.delete(runId)
				rootModes.delete(runId)
				rootSettled.get(runId)?.()
				rootSettled.delete(runId)
				throw error
			}), controller)
		}
		const stream = (input: JsonValue, invokeOptions: InvokeOptions = {}) => {
			try {
				const normalized = normalizeInvokeOptions(invokeOptions)
				if (definition.kind === 'agent' && normalized.idempotencyKey !== undefined) {
					if (!isJsonValue(input)) throw new ValidationError('Harness target input must be JSON.', {
						where: 'agent_input', issues: { reason: 'non_json_input' },
					})
					const deliveryId = directAgentDeliveryId(state.record.id, definition.id, normalized.idempotencyKey)
					const inputCanonical = canonicalJson(input)
					const active = directAgentRuns.get(deliveryId)
					if (active !== undefined) {
						if (active.input !== inputCanonical) throw directAgentIdempotencyConflict()
						return replayRunAfter(active.promise, deliveryId)
					}
					let resolve!: (outcome: RunOutcome<JsonValue>) => void
					let reject!: (error: unknown) => void
					const promise = new Promise<RunOutcome<JsonValue>>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
					directStreamSettlers.set(deliveryId, Object.freeze({ resolve, reject }))
					directAgentRuns.set(deliveryId, Object.freeze({ input: inputCanonical, promise }))
					let opened: HarnessTargetDispatchStream<JsonValue>
					try { opened = start('stream', input, normalized) } catch (error) {
						directStreamSettlers.delete(deliveryId)
						directAgentRuns.delete(deliveryId)
						throw error
					}
					void promise.finally(() => {
						if (directAgentRuns.get(deliveryId)?.promise === promise) directAgentRuns.delete(deliveryId)
						directStreamSettlers.delete(deliveryId)
					}).catch(() => {})
					return opened
				}
				return start('stream', input, normalized)
			}
			catch (error) {
				if (error instanceof OperationCancelledError) return rejectedDispatchStream<JsonValue>(error)
				throw error
			}
		}
		return Object.freeze({
			stream,
			async run(input: JsonValue, invokeOptions?: InvokeOptions) {
				const normalized = normalizeInvokeOptions(invokeOptions ?? {})
				if (!isJsonValue(input)) throw new ValidationError('Harness target input must be JSON.', {
					where: definition.kind === 'agent' ? 'agent_input' : 'workflow_input', issues: { reason: 'non_json_input' },
				})
				if (definition.kind === 'agent' && normalized.idempotencyKey !== undefined) {
					const deliveryId = directAgentDeliveryId(state.record.id, definition.id, normalized.idempotencyKey)
					const inputCanonical = canonicalJson(input)
					const active = directAgentRuns.get(deliveryId)
					if (active !== undefined) {
						if (active.input !== inputCanonical) throw directAgentIdempotencyConflict()
						return active.promise
					}
					const promise = consumeRun(start('run', input, normalized), definition)
					directAgentRuns.set(deliveryId, Object.freeze({ input: inputCanonical, promise }))
					try { return await promise } finally {
						if (directAgentRuns.get(deliveryId)?.promise === promise) directAgentRuns.delete(deliveryId)
					}
				}
				return consumeRun(start('run', input, normalized), definition)
			}
		})

		function replayRunAfter(
			settled: Promise<RunOutcome<JsonValue>>,
			runId: string,
		): HarnessTargetDispatchStream<JsonValue> {
			return Object.freeze({
				async cancel() {},
				async *[Symbol.asyncIterator]() {
					await settled
					const stored = await storage.getRun(runId)
					if (stored === undefined) throw new StateError('Idempotent run replay is unavailable.', { op: 'getRun', reason: 'run_not_found' })
					const boundaries = requirePersistedBoundaries(await storage.listEvents(runId), stored)
					yield restoreStartedEvent(boundaries.started)
					yield restoreTerminalEvent(boundaries.terminal, stored)
				},
			})
		}
	}

	async function consumeRun(
		opened: HarnessTargetDispatchStream<JsonValue>,
		definition: AnyAgentDefinition | AnyWorkflowDefinition,
	): Promise<RunOutcome<JsonValue>> {
				let terminal: Extract<ExecutionEvent<JsonValue>, { type: 'run.finished' }> | undefined
				for await (const event of opened) if (event.type === 'run.finished') terminal = event
				if (!terminal) throw new InternalError('Harness target execution ended without a terminal event.')
				return terminalOutcome(terminal, definition)
	}

	function terminalOutcome(
		terminal: Extract<ExecutionEvent<JsonValue>, { type: 'run.finished' }>,
		definition: AnyAgentDefinition | AnyWorkflowDefinition,
	): RunOutcome<JsonValue> {
		if (terminal.outcome.status === 'completed' || terminal.outcome.status === 'interrupted') return terminal.outcome
		const failure = rootFailures.get(terminal.runId)
		rootFailures.delete(terminal.runId)
		if (failure !== undefined) throw failure
		if (terminal.outcome.status === 'cancelled') throw new OperationCancelledError('Harness target execution was cancelled.', { scope: definition.kind })
		throw new InternalError('Harness target execution failed.', undefined, terminal.outcome.error)
	}

	async function releaseSession(state: SessionRuntime, destroy: boolean) {
		if (state.released) return
		if (state.releasePromise !== undefined) return state.releasePromise
		if (state.busy) throw new SessionBusyError('Session cannot be released during a run.', { session_id: state.record.id, reason: 'session_release_in_progress' })
		state.releasing = true
		const pending = (async () => {
			state.controller.abort(new OperationCancelledError('Session was released.', { scope: 'run' }))
			const failures: unknown[] = []
			const taskRows = [...state.taskRegistry.entries()]
			const taskSettled = await Promise.allSettled(taskRows.map(([, task]) => task.cancel('Session was released.')))
			for (let index = 0; index < taskSettled.length; index += 1) {
				const result = taskSettled[index]!
				if (result.status === 'fulfilled') state.taskRegistry.delete(taskRows[index]![0])
				else failures.push(normalizeInternal(result.reason))
			}
			const sandboxRows = [...state.sandboxes.entries()]
			const sandboxSettled = await Promise.allSettled(sandboxRows.map(([, value]) => value.close()))
			for (let index = 0; index < sandboxSettled.length; index += 1) {
				const result = sandboxSettled[index]!
				if (result.status === 'fulfilled') state.sandboxes.delete(sandboxRows[index]![0])
				else failures.push(normalizeInternal(result.reason))
			}
			if (state.childSandboxCleanup !== undefined && !state.childSandboxCleanup.terminated && state.sandboxes.size === 0) {
				try {
					await sandbox.terminate({ scope: state.childSandboxCleanup.scope, reason: 'run_disposed' })
					state.childSandboxCleanup = Object.freeze({ ...state.childSandboxCleanup, terminated: true })
				} catch (error) { failures.push(normalizeInternal(error)) }
			}
			if (destroy && requiresSandbox && state.record.sandboxBinding.relation === 'owned' && state.sandboxTerminated !== true) {
				try {
					await sandbox.terminate({ scope: { owner: state.record.sandboxBinding.owner, partition: { kind: 'shared' }, lifetime: 'session' }, reason: 'session_closed' })
					state.sandboxTerminated = true
				} catch (error) { failures.push(normalizeInternal(error)) }
			}
			if (destroy && state.storageClosed !== true) {
				try { await storage.closeSession(state.record.id, state.record.instanceId); state.storageClosed = true }
				catch (error) { failures.push(normalizeInternal(error)) }
			}
			if (failures.length === 1) throw failures[0]
			if (failures.length > 1) throw new AggregateError(failures, 'Failed to release Harness session resources.')
			state.released = true
			sessions.delete(state.record.id)
		})()
		state.releasePromise = pending
		try { return await pending } finally {
			if (!state.released && state.releasePromise === pending) {
				delete state.releasePromise
				state.releasing = false
			}
		}
	}

	async function close() {
		if (closePromise) return closePromise
		closed = true
		const pending = (async () => {
			instanceController.abort(new OperationCancelledError('Harness instance was closed.', { scope: 'run' }))
			const failures: unknown[] = []
			for (const state of sessions.values()) {
				state.controller.abort(new OperationCancelledError('Harness instance was closed.', { scope: 'run' }))
			}
			await Promise.allSettled([...sessions.values()].flatMap(state => [...state.activeRoots.values()].map(root => root.settled)))
			for (const state of [...sessions.values()].reverse()) try { await releaseSession(state, false) } catch (error) { failures.push(normalizeInternal(error)) }
			for (let index = closeStack.length - 1; index >= 0; index -= 1) {
				try { await closeStack[index]!(); closeStack.splice(index, 1) }
				catch (error) { failures.push(normalizeInternal(error)) }
			}
			for (const resource of [...owned].reverse()) if ('close' in resource && typeof resource.close === 'function') {
				try { await resource.close(); owned.delete(resource) } catch (error) { failures.push(normalizeInternal(error)) }
			}
			if (failures.length > 0) throw new AggregateError(failures, 'Harness close failed.')
		})()
		closePromise = pending
		try { await pending } catch (error) {
			if (closePromise === pending) closePromise = undefined
			throw error
		}
	}

	return Object.freeze({ getSession, close }) as HarnessInstance<Contracts, Requirements>

	function requireModel(alias: string): ModelHandle {
		const model = modelRegistry[alias]
		if (!model) throw new InternalError('Compiled model alias is unavailable.')
		return model
	}
	function workflowModels(workflow: AnyWorkflowDefinition): Record<string, ModelHandle> {
		return Object.fromEntries(Object.entries(workflow.models ?? {}).map(([name, requirement]) => [name, requireModel(requirement.alias)]))
	}
}

class EventQueue<Output extends JsonValue> implements HarnessTargetDispatchStream<Output> {
	private static readonly MAX_BUFFERED_EVENTS = 256
	private readonly values: ExecutionEvent<Output>[] = []
	private readonly waiters: Array<() => void> = []
	private done = false
	private rejectIterator = false
	private terminal?: Extract<ExecutionEvent<Output>, { type: 'run.finished' }>
	public failure: unknown
	public constructor(private readonly cancelRun: () => void) {}
	public push(value: ExecutionEvent<Output>) { if (!this.done) { if (value.type === 'run.finished') this.terminal = value; this.values.push(value); this.wake() } }
	public get terminalEvent(): Extract<ExecutionEvent<Output>, { type: 'run.finished' }> | undefined {
		return this.terminal
	}
	public wouldOverflow(additional: number): boolean { return this.values.length + additional > EventQueue.MAX_BUFFERED_EVENTS }
	public reserve(slots: number): number {
		let dropped = 0
		while (this.values.length + slots > EventQueue.MAX_BUFFERED_EVENTS) {
			const index = this.values.findIndex(event => event.type !== 'run.finished')
			if (index < 0) break
			this.values.splice(index, 1)
			dropped += 1
		}
		return dropped
	}
	public end() { this.done = true; this.wake() }
	public setFailure(error: unknown) { this.failure = error }
	public fail(error: unknown) { this.failure = error; this.rejectIterator = true; this.done = true; this.wake() }
	public async cancel(): Promise<void> { this.cancelRun() }
	public async *[Symbol.asyncIterator](): AsyncIterator<ExecutionEvent<Output>> {
		while (!this.done || this.values.length > 0) {
			if (this.values.length === 0) await new Promise<void>(resolve => this.waiters.push(resolve))
			while (this.values.length > 0) yield this.values.shift()!
		}
		if (this.rejectIterator) throw this.failure
	}
	private wake() { for (const waiter of this.waiters.splice(0)) waiter() }
}

function lazyDispatchStream<Output extends JsonValue>(
	pending: Promise<HarnessTargetDispatchStream<Output>>,
	controller: ReturnType<typeof linkedController>,
): HarnessTargetDispatchStream<Output> {
	return Object.freeze({
		async cancel(reason?: string) { const stream = await pending; await stream.cancel(reason); controller.dispose() },
		async *[Symbol.asyncIterator]() { const stream = await pending; try { yield* stream } finally { controller.dispose() } },
	})
}

function correlatedEvent<Output extends JsonValue>(runId: string, sequence: number, body: object, parentRunId?: string, parentInvocationId?: string): ExecutionEvent<Output> {
	const type = (body as { type: ExecutionEvent['type'] }).type
	const eventId = `event_${createHash('sha256').update(canonicalJson(['harness.event.v1', runId, sequence, type])).digest('hex')}`
	return Object.freeze({ ...body, eventId, sequence, runId,
		...(parentRunId === undefined ? {} : { parentRunId }),
		...(parentInvocationId === undefined ? {} : { parentInvocationId }) }) as ExecutionEvent<Output>
}

function persistedEvent(event: ExecutionEvent<JsonValue>): PersistedRunEvent {
	return Object.freeze({
		id: event.eventId,
		sequence: event.sequence,
		runId: event.runId,
		at: 'at' in event && typeof event.at === 'string' ? event.at : new Date().toISOString(),
		type: event.type,
		payload: privacySafeEventPayload(event),
	})
}

function persistedFinalEvent(
	event: ExecutionEvent<JsonValue>,
): PersistedFinalRunEvent {
	if (event.type !== 'run.finished') throw new InternalError('Terminal event projection requires run.finished.')
	return Object.freeze({
		id: event.eventId,
		sequence: event.sequence,
		runId: event.runId,
		at: event.at,
		type: 'run.finished',
		payload: privacySafeEventPayload(event) as PersistedFinalRunEvent['payload'],
	})
}

function rejectedDispatchStream<Output extends JsonValue>(error: unknown): HarnessTargetDispatchStream<Output> {
	return Object.freeze({
		async cancel() {},
		async *[Symbol.asyncIterator](): AsyncIterator<ExecutionEvent<Output>> { throw error },
	})
}

function directAgentDeliveryId(sessionId: string, agentId: string, idempotencyKey: string): string {
	return `run_${digest(['harness.direct-agent-delivery.v1', sessionId, agentId, idempotencyKey])}`
}

function directAgentIdempotencyConflict(): StateError {
	return new StateError('Direct-agent idempotency key conflicts with an earlier invocation.', {
		op: 'createRun', reason: 'run_conflict',
	})
}

async function requireAuthoritativeTerminalRun(
	storage: HarnessStorage,
	runId: string,
	status: 'succeeded' | 'failed' | 'cancelled',
): Promise<RunRecord> {
	const run = await storage.getRun(runId)
	if (run === undefined || run.status !== status
		|| (status === 'succeeded' ? !isJsonValue(run.output) : run.error === undefined)) {
		throw new StateError('Authoritative terminal run record is unavailable.', { op: 'getRun', reason: 'run_not_found' })
	}
	return run
}

function assertAcquiredLeaseSnapshot(
	lease: DurableRunLease,
	request: AcquireRunRequest,
	optimisticRun: RunRecord,
	optimisticCheckpoint: RunCheckpoint | undefined,
): void {
	const fail = () => { throw new StateError('Acquired run snapshot conflicts with the optimistic read.', {
		op: 'acquireRun', reason: 'acquisition_conflict',
	}) }
	if (!Object.isFrozen(lease) || !Object.isFrozen(lease.acquiredFrom) || !Object.isFrozen(lease.run)
		|| !Object.isFrozen(lease.checkpoints) || lease.checkpoints.some(checkpoint => !Object.isFrozen(checkpoint))) fail()
	if (lease.runId !== request.runId || lease.sessionId !== request.sessionId || lease.workerId !== request.workerId
		|| lease.acquisitionId !== request.acquisitionId || lease.resumed !== (request.mode === 'resume')) fail()
	if (canonicalJson(lease.acquiredFrom as unknown as JsonValue) !== canonicalJson(request.expected as unknown as JsonValue)) fail()
	const run = lease.run
	const expectedAttempt = Math.max((optimisticRun.attempt ?? 0) + 1, request.requestedAttempt ?? 1)
	const expectedRun = Object.freeze({ ...optimisticRun, status: 'running' as const,
		revision: optimisticRun.revision + 1, workerId: request.workerId, attempt: expectedAttempt,
		...(optimisticRun.initialStepId === undefined && request.mode === 'initial'
			? { initialStepId: request.expected.checkpoint.stepId } : {}) })
	if (lease.attempt !== expectedAttempt || canonicalJson(run as unknown as JsonValue) !== canonicalJson(expectedRun as unknown as JsonValue)) fail()
	const selected = lease.checkpoint
	if (canonicalJson((selected ?? null) as unknown as JsonValue) !== canonicalJson((optimisticCheckpoint ?? null) as unknown as JsonValue)) fail()
	if ((selected === undefined) !== (request.expected.checkpoint.sequence === null)) fail()
	if (selected !== undefined && (selected.stepId !== request.expected.checkpoint.stepId || selected.sequence !== request.expected.checkpoint.sequence)) fail()
	let priorSequence = -1
	let selectedMatches = selected === undefined
	const stepIds = new Set<string>()
	for (const checkpoint of lease.checkpoints) {
		if (checkpoint.runId !== run.id || checkpoint.sessionId !== run.sessionId || checkpoint.sequence <= priorSequence
			|| stepIds.has(checkpoint.stepId)) fail()
		stepIds.add(checkpoint.stepId)
		if (checkpoint === selected || canonicalJson(checkpoint as unknown as JsonValue) === canonicalJson((selected ?? null) as unknown as JsonValue)) selectedMatches = true
		priorSequence = checkpoint.sequence
	}
	if (!selectedMatches) fail()
}

function requirePersistedBoundaries(
	events: readonly PersistedRunEvent[],
	run: RunRecord,
): Readonly<{ started: PersistedRunEvent; terminal: PersistedRunEvent }> {
	const starts = events.filter(event => event.type === 'run.started')
	const terminals = events.filter(event => event.type === 'run.finished')
	const started = starts[0]
	const terminal = terminals.at(-1)
	if (starts.length !== 1 || started === undefined || started.sequence !== 1 || terminal === undefined
		|| terminal.sequence !== events.at(-1)?.sequence || started.runId !== run.id || terminal.runId !== run.id) {
		throw new StateError('Persisted run boundary events are invalid.', { op: 'listEvents', reason: 'event_sequence_conflict' })
	}
	return Object.freeze({ started, terminal })
}

function restoreStartedEvent(stored: PersistedRunEvent): ExecutionEvent<JsonValue> {
	if (stored.type !== 'run.started' || stored.sequence !== 1 || !validTimestamp(stored.at)
		|| !isStrictPersistedPayload(stored.payload, [])) {
		throw new StateError('Persisted run start event is invalid.', { op: 'listEvents', reason: 'event_sequence_conflict' })
	}
	return Object.freeze({ type: 'run.started', eventId: stored.id, sequence: stored.sequence, runId: stored.runId, at: stored.at,
		...persistedParent(stored.payload as Record<string, unknown>) })
}

function restoreTerminalEvent(
	stored: PersistedRunEvent,
	run: RunRecord,
	interrupt?: ToolApprovalInterrupt,
): ExecutionEvent<JsonValue> {
	if (stored.type !== 'run.finished' || !validTimestamp(stored.at) || !isPlainRecord(stored.payload)
		|| !hasOnlyStringKeys(stored.payload, ['parentRunId', 'parentInvocationId', 'outcome']) || !isPlainRecord(stored.payload['outcome'])) {
		throw new StateError('Persisted terminal event is invalid.', { op: 'listEvents', reason: 'event_sequence_conflict' })
	}
	const parent = persistedParent(stored.payload)
	const storedOutcome = stored.payload['outcome']
	let outcome: Extract<ExecutionEvent<JsonValue>, { type: 'run.finished' }>['outcome']
	if (run.status === 'succeeded') {
		if (!hasOnlyStringKeys(storedOutcome, ['status']) || storedOutcome['status'] !== 'completed' || !isJsonValue(run.output)) throw invalidPersistedTerminal()
		outcome = Object.freeze({ status: 'completed', runId: run.id, output: run.output })
	} else if (run.status === 'interrupted' || run.status === 'running' || run.status === 'waiting') {
		if (!hasOnlyStringKeys(storedOutcome, ['status']) || storedOutcome['status'] !== 'interrupted' || interrupt === undefined) throw invalidPersistedTerminal()
		outcome = Object.freeze({ status: 'interrupted', runId: run.id, interrupt })
	} else {
		if (!hasOnlyStringKeys(storedOutcome, ['status', 'error']) || storedOutcome['status'] !== run.status || run.error === undefined
			|| canonicalJson(storedOutcome['error'] as JsonValue) !== canonicalJson(run.error as unknown as JsonValue)) throw invalidPersistedTerminal()
		outcome = Object.freeze({ status: run.status, runId: run.id, error: run.error })
	}
	return Object.freeze({ type: 'run.finished', eventId: stored.id, sequence: stored.sequence, runId: stored.runId, at: stored.at,
		...parent, outcome })
}

function persistedParent(payload: Record<string, unknown>): Readonly<{ parentRunId?: string; parentInvocationId?: string }> {
	const parentRunId = payload['parentRunId']
	const parentInvocationId = payload['parentInvocationId']
	if ((parentRunId === undefined) !== (parentInvocationId === undefined)
		|| (parentRunId !== undefined && (!validIdentifier(parentRunId) || !validIdentifier(parentInvocationId)))) throw invalidPersistedTerminal()
	return parentRunId === undefined ? Object.freeze({}) : Object.freeze({ parentRunId, parentInvocationId: parentInvocationId as string })
}

function isStrictPersistedPayload(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return isPlainRecord(value) && hasOnlyStringKeys(value, ['parentRunId', 'parentInvocationId', ...keys])
		&& ((value['parentRunId'] === undefined && value['parentInvocationId'] === undefined)
			|| (validIdentifier(value['parentRunId']) && validIdentifier(value['parentInvocationId'])))
}

function invalidPersistedTerminal(): StateError {
	return new StateError('Persisted terminal event is invalid.', { op: 'listEvents', reason: 'event_sequence_conflict' })
}

function validTimestamp(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value
}

function privacySafeEventPayload(event: ExecutionEvent<JsonValue>): JsonValue {
	switch (event.type) {
		case 'run.started': return compactOperational(event, [])
		case 'run.finished': return JSON.parse(canonicalJson({
			...(event.parentRunId === undefined ? {} : { parentRunId: event.parentRunId, parentInvocationId: event.parentInvocationId }),
			outcome: event.outcome.status === 'failed' || event.outcome.status === 'cancelled'
			? { status: event.outcome.status, error: event.outcome.error }
			: { status: event.outcome.status } } as unknown as JsonValue)) as JsonValue
		case 'agent.started': return compactOperational(event, ['agentId', 'workflowId', 'parentAgentId', 'delegationCallId', 'delegationDepth', 'modelAlias'])
		case 'agent.finished': return compactOperational(event, ['agentId', 'workflowId', 'parentAgentId', 'delegationCallId', 'delegationDepth', 'modelAlias', 'error'])
		case 'model.message': return compactOperational({ ...event, messageId: event.message.id, role: event.message.role }, ['agentId', 'messageId', 'role'])
		case 'model.completed': return compactOperational(event, ['agentId', 'workflowId', 'modelAlias', 'streamId', 'operation', 'usage', 'finishReason'])
		case 'model.embedding.completed': return compactOperational(event, ['agentId', 'count', 'dimensions', 'usage'])
		case 'model.rerank.completed': return compactOperational(event, ['agentId', 'count', 'topN', 'usage'])
		case 'output.text.delta':
		case 'output.object.snapshot': return compactOperational(event, ['id', 'agentId', 'workflowId', 'modelAlias'])
		case 'output.file': return compactOperational(event, ['id', 'agentId', 'workflowId', 'modelAlias', 'operation'])
		case 'output.progress': return compactOperational(event, ['id', 'agentId', 'workflowId', 'modelAlias', 'operation', 'state', 'progress'])
		case 'tool.input.available':
		case 'tool.started': return compactOperational(event, ['agentId', 'toolId', 'callId'])
		case 'tool.finished': return compactOperational(event, ['agentId', 'toolId', 'callId', 'error'])
		case 'policy.exposure': return compactOperational(event, ['agentId', 'invocationId', 'toolId', 'step', 'evidence', 'effect', 'enforced'])
		case 'policy.evaluated': return compactOperational(event, ['agentId', 'invocationId', 'toolId', 'callId', 'step', 'evidence', 'effect', 'enforced'])
		case 'approval.requested': return compactOperational(event, ['agentId', 'invocationId', 'toolId', 'callId', 'step', 'approvalId', 'demands'])
		case 'approval.responded': return compactOperational(event, ['agentId', 'invocationId', 'toolId', 'callId', 'step', 'approvalId', 'approved'])
		case 'external_wait.requested': return compactOperational(event, ['waitId', 'kind', 'schemaVersion', 'definitionVersion', 'deadline'])
		case 'external_wait.waiting': return compactOperational(event, ['waitId', 'kind', 'deadline'])
		case 'external_wait.resolved': return compactOperational(event, ['waitId', 'kind', 'deadline'])
		case 'fanout.started': return compactOperational(event, ['batchId', 'count', 'concurrency'])
		case 'fanout.finished': return compactOperational(event, ['batchId', 'count', 'status'])
		case 'child_task.started': return compactOperational(event, ['taskId', 'parentRunId', 'workflowId', 'agentId', 'modelAlias', 'contextPolicy', 'mode'])
		case 'child_task.settled': return compactOperational(event, ['taskId', 'parentRunId', 'workflowId', 'agentId', 'status', 'error'])
		case 'stream.overflow': return compactOperational(event, ['dropped'])
	}
}

function compactOperational(value: object, keys: readonly string[]): JsonValue {
	const source = value as Readonly<Record<string, unknown>>
	const result: Record<string, JsonValue> = {}
	for (const key of ['parentRunId', 'parentInvocationId', ...keys]) if (source[key] !== undefined && isJsonValue(source[key])) result[key] = source[key]
	return JSON.parse(canonicalJson(result)) as JsonValue
}

function identityDigest(identity: SessionRecord['identity']): string {
	return `sha256:${digest(['harness.session-identity.v1', identity?.tenantId ?? null, identity?.principalId ?? null])}`
}

function assertSessionRequestMatches(
	record: SessionRecord,
	identity: SessionRecord['identity'],
	sandboxOwner: SessionOptions['sandboxOwner'],
): void {
	if (canonicalJson((record.identity ?? null) as JsonValue) !== canonicalJson((identity ?? null) as JsonValue)) {
		throw new StateError('Session identity does not match the stored session.', { op: 'getSession', reason: 'session_identity_mismatch' })
	}
	if (sandboxOwner !== undefined && canonicalJson(record.sandboxBinding.owner as unknown as JsonValue) !== canonicalJson(sandboxOwner as unknown as JsonValue)) {
		throw new StateError('Session sandbox owner does not match the stored session.', { op: 'getSession', reason: 'session_identity_mismatch' })
	}
}

function invocationTrace(options: InvokeOptions, logger: Logger): HarnessTraceContext | undefined {
	if (options.traceparent === undefined) {
		if (options.tracestate !== undefined) logger.warn('Ignoring invalid trace context.', { 'harness.warning.code': 'INVALID_TRACE_CONTEXT' })
		return undefined
	}
	try {
		return normalizeHarnessTraceContext({ traceparent: options.traceparent,
			...(options.tracestate === undefined ? {} : { tracestate: options.tracestate }) })
	} catch {
		logger.warn('Ignoring invalid trace context.', { 'harness.warning.code': 'INVALID_TRACE_CONTEXT' })
		return undefined
	}
}

function compiledGraphDigest(
	options: InstantiateStandaloneHarnessOptions,
	agentBindings: readonly (readonly [object, Readonly<Record<string, AgentExecutableBinding>>])[],
): string {
	const definitions: JsonValue[] = [
		...Object.values(options.graph.tools).map(value => {
			const identity = getDefinitionIdentity(value)
			if (identity === undefined) throw new InternalError('Compiled tool identity is unavailable.')
			return [identity.kind, value.id] as JsonValue
		}),
		...Object.values(options.graph.skills).map(value => ['skill', value.id] as JsonValue),
		...Object.values(options.graph.mcpServers).flatMap(server => [
			['mcp-server', server.id] as JsonValue,
			...Object.keys(server.tools).map(id => ['mcp-tool', server.id, id] as JsonValue),
		]),
		...Object.values(options.graph.agents).map(value => ['agent', value.id] as JsonValue),
		...Object.values(options.graph.workflows).map(value => ['workflow', value.id] as JsonValue),
		...Object.keys(options.graph.requirements.models).map(id => ['model-alias', id] as JsonValue),
	].sort(compareCanonical)
	const edges: JsonValue[] = []
	for (const server of Object.values(options.graph.mcpServers)) for (const localId of Object.keys(server.tools)) {
		edges.push(['mcp-tool-owner', server.id, localId])
	}
	for (const agent of Object.values(options.graph.agents)) {
		edges.push(['agent-model', agent.id, agent.model])
		for (const tool of agent.tools ?? []) edges.push(['agent-tool', agent.id, tool.id, graphToolReference(tool)])
		for (const skill of agent.skills ?? []) edges.push(['agent-skill', agent.id, skill.id])
		for (const [name, reference] of Object.entries(agent.subagents ?? {})) {
			const child = 'agent' in reference ? reference.agent : reference
			edges.push(['agent-subagent', agent.id, name, child.id])
		}
		if (agent.memory?.embedding !== undefined) edges.push(['agent-memory-embedding-model', agent.id, agent.memory.embedding.model])
		if (agent.memory?.summary !== undefined) edges.push(['agent-memory-summary-model', agent.id, agent.memory.summary.model])
	}
	for (const workflow of Object.values(options.graph.workflows)) {
		for (const [key, agent] of Object.entries(workflow.agents ?? {})) edges.push(['workflow-agent', workflow.id, key, agent.id])
		for (const [key, model] of Object.entries(workflow.models ?? {})) edges.push(['workflow-model', workflow.id, key, model.alias])
	}
	edges.sort(compareCanonical)
	const targetPolicies = compiledGraphTargetPolicyPreimage(options.graph)
	const bindings: Array<[string, string, string]> = []
	for (const agent of Object.values(options.graph.agents)) {
		const identity = getDefinitionIdentity(agent)
		if (identity === undefined) throw new InternalError('Compiled agent identity is unavailable.')
		for (const [modelFacingId, binding] of Object.entries(agentBindings.find(([token]) => token === identity.token)?.[1] ?? {})) {
			bindings.push([agent.id, modelFacingId, binding.contractDigest])
		}
	}
	bindings.sort((left, right) => codePointCompare(String(left[0]), String(right[0])) || codePointCompare(String(left[1]), String(right[1])))
	const defaults = options.defaults
	const requirements = options.graph.requirements
	const contextProjection = defaults.contextProjection?.toolResultPruner
	const historyRetention = defaults.historyRetention
	return `sha256:${digest(['harness.graph.v1', options.name,
		[defaults.maxSteps, defaults.maxToolCalls, defaults.maxSubagentCalls, defaults.maxParallelSubagents,
			defaults.maxWorkflowAgentCalls, defaults.maxParallelWorkflowAgentCalls, defaults.maxDepth,
			defaults.runTimeoutMs, defaults.modelTimeoutMs, defaults.toolTimeoutMs, defaults.skillTimeoutMs,
			defaults.decisionTimeoutMs, defaults.maxParallelToolCalls, defaults.historyWindow ?? null,
			contextProjection === undefined ? null : ['tool-result-pruner', contextProjection.maxBytes, contextProjection.headBytes,
				contextProjection.tailBytes, contextProjection.marker ?? '...[tool result pruned]...'],
			historyRetention === undefined ? null : [historyRetention.maxTurns ?? null, historyRetention.maxBytes ?? null]],
		[Object.entries(requirements.models).sort(([left], [right]) => codePointCompare(left, right)).map(([alias, row]) => [alias, sortedSet(row.capabilities)]),
			sortedSet(requirements.mcpServers), sortedSet(requirements.skillRuntimes), requirements.storage.durable,
			sortedSet(requirements.memory.capabilities), sortedSet(requirements.memory.modelAliases), sortedSet(requirements.sandbox.capabilities),
			sortedSet(requirements.sandbox.requiredGroups), requirements.sandbox.required,
			requirements.workspace, requirements.artifacts, sortedSet(requirements.hostTools)], definitions, edges, [...targetPolicies], bindings])}`
}

/** @internal Exact target-policy component of GraphDigestPreimageV1. */
export function compiledGraphTargetPolicyPreimage(graph: CompiledDefinitionGraph): readonly JsonValue[] {
	return Object.freeze([
		...Object.values(graph.agents).map(agent => agentPolicyDigest(agent)),
		...Object.values(graph.workflows).map(workflow => ['workflow', workflow.id,
			[workflow.agentCalls?.maxCalls ?? null, workflow.agentCalls?.maxParallel ?? null], workflow.maxDepth ?? null,
			sandboxPolicyDigest(workflow.sandbox), workflow.workspace === true, workflow.durable === true] as JsonValue),
	].sort(compareCanonical))
}

function graphToolReference(tool: ToolDefinition | BuiltInToolDefinition | import('../definitions/types.js').HostToolDefinition | import('../definitions/types.js').McpToolDefinition): JsonValue {
	const identity = getDefinitionIdentity(tool)
	if (identity === undefined) throw new InternalError('Compiled tool identity is unavailable.')
	if (identity.kind === 'mcp-tool') {
		const owner = getDefinitionIdentity(identity.owner)
		if (owner?.kind !== 'mcp-server') throw new InternalError('Compiled MCP owner identity is unavailable.')
		return ['mcp-tool', owner.id, tool.id]
	}
	return [identity.kind, tool.id]
}

function sandboxPolicyDigest(policy: AnyAgentDefinition['sandbox'] | AnyWorkflowDefinition['sandbox']): JsonValue {
	if (policy === undefined) return null
	if (typeof policy === 'string') return [policy]
	return ['group', policy.group]
}

function permissionDigest(value: unknown): JsonValue {
	if (value === undefined) return null
	if (typeof value === 'string') return [value, null, null]
	const policy = value as Readonly<{ mode: string; allow?: readonly string[]; deny?: readonly string[] }>
	return [policy.mode, policy.allow === undefined ? null : [...policy.allow], policy.deny === undefined ? null : [...policy.deny]]
}

function agentPolicyDigest(agent: AnyAgentDefinition): JsonValue {
	const memory = agent.memory
	const governance = agent.governance
	const guardrail = agent.guardrails?.[agentGuardrailsBinding]
	return ['agent', agent.id, agent.model,
		[agent.loop?.maxSteps ?? null, agent.loop?.maxToolCalls ?? null, agent.loop?.maxSubagentCalls ?? null,
			agent.loop?.maxParallelSubagents ?? null, agent.loop?.maxDepth ?? null],
		memory === undefined ? null : [sortedSet(memory.capabilities), memory.embedding?.model ?? null,
			memory.summary === undefined ? null : [memory.summary.model, memory.summary.everyTurns ?? null, memory.summary.sourceTurns ?? null]],
		sandboxPolicyDigest(agent.sandbox), agent.workspace === true, agent.durable === true,
		agent.permissions === undefined ? null : [permissionDigest(agent.permissions.bash), permissionDigest(agent.permissions.write), permissionDigest(agent.permissions.edit)],
		governance === undefined ? null : governanceDigest(governance),
		guardrail === undefined ? null : guardrailDigest(guardrail)]
}

function governanceDigest(governance: NonNullable<AnyAgentDefinition['governance']>): JsonValue {
	const policies = (governance.policies ?? []).map(policy => {
		if ('kind' in policy) return ['native', policy.id, policy.version ?? null,
			policy.rules.map(rule => [rule.id, rule.tools === undefined ? null : sortedSet(rule.tools), rule.effect,
				rule.reasonCode ?? null, typeof rule.when === 'function'])] as JsonValue
		return ['external', policy.id, policy.version ?? null, policy.engine ?? null, sortedSet(policy.effects)] as JsonValue
	})
	const exposure = governance.exposure
	return [governance.enabled ?? true, governance.mode ?? 'enforce', governance.defaultEffect ?? 'allow', policies,
		exposure === undefined ? null : [exposure.id ?? null, exposure.version ?? null, exposure.defaultEffect ?? 'expose',
			(exposure.rules ?? []).map(rule => [rule.id, rule.tools === undefined ? null : sortedSet(rule.tools), rule.effect, typeof rule.when === 'function'])],
		governance.audit !== undefined]
}

function guardrailDigest(interceptor: NonNullable<AnyAgentDefinition['guardrails']>[typeof agentGuardrailsBinding]): JsonValue {
	const requirements = interceptor.requirements
	const phases = ([['beforeInput', 'input'], ['beforeModel', 'before_model'], ['afterModel', 'after_model'],
		['beforeTool', 'tool_input'], ['afterTool', 'tool_output'], ['beforeOutput', 'output']] as const)
		.flatMap(([hook, phase]) => typeof interceptor[hook] === 'function' ? [phase] : [])
	return [sortedSet(phases), sortedSet(requirements?.tools ?? []),
		[...(requirements?.models ?? [])].sort((left, right) => codePointCompare(left.alias, right.alias)).map(row => [row.alias, sortedSet(row.capabilities)]),
		sortedSet(requirements?.memory ?? []), sortedSet(requirements?.sandbox ?? []), sortedSet(requirements?.skillRuntimes ?? []),
		requirements?.durable === true, requirements?.workspace === true, requirements?.artifacts === true]
}

function compareCanonical(left: JsonValue, right: JsonValue): number { return codePointCompare(canonicalJson(left), canonicalJson(right)) }
function sortedSet(values: readonly string[]): string[] { return [...new Set(values)].sort(codePointCompare) }

function linkedController(parent: AbortSignal | readonly AbortSignal[], deadline?: number) {
	const controller = new AbortController()
	const parents = Array.isArray(parent) ? parent : [parent]
	const listeners = parents.map(signal => {
		const forward = () => controller.abort(signal.reason)
		signal.addEventListener('abort', forward, { once: true })
		if (signal.aborted) forward()
		return [signal, forward] as const
	})
	let timer: ReturnType<typeof setTimeout> | undefined
	if (deadline !== undefined) {
		const timeoutMs = Math.max(0, deadline - Date.now())
		timer = setTimeout(() => controller.abort(new OperationTimeoutError('Run timed out.', { scope: 'run', timeout_ms: timeoutMs })), timeoutMs)
	}
	return Object.freeze({ signal: controller.signal, deadline, abort: (reason?: unknown) => controller.abort(reason),
		dispose() { for (const [signal, forward] of listeners) signal.removeEventListener('abort', forward); if (timer) clearTimeout(timer) } })
}

function resolveContentCaptureMode(options: Readonly<TelemetryOptions> | undefined): ContentCaptureMode {
	if (options?.contentCaptureMode !== undefined) return options.contentCaptureMode
	const configured = process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']
	if (configured === 'true') return 'SPAN_AND_EVENT'
	if (configured === 'false') return 'NO_CONTENT'
	if (configured === 'NO_CONTENT' || configured === 'SPAN_ONLY' || configured === 'EVENT_ONLY' || configured === 'SPAN_AND_EVENT') return configured
	return 'NO_CONTENT'
}

function withStandaloneTelemetryFlavor(telemetry: TelemetryShim, options: Readonly<TelemetryOptions> | undefined): TelemetryShim {
	const flavor = options?.flavor ?? process.env['PURISTA_TELEMETRY_FLAVOR'] ?? 'dual'
	if (flavor === 'dual') return telemetry
	const filtered: TelemetryShim = {
		span: (name, attrs, fn) => telemetry.span(name, filterStandaloneTelemetryAttrs(attrs, flavor), span => fn(filterStandaloneSpan(span, flavor))),
		recordHistogram: (name, value, attrs) => telemetry.recordHistogram(name, value, filterStandaloneTelemetryAttrs(attrs, flavor)),
		recordCounter: (name, value, attrs) => telemetry.recordCounter(name, value, filterStandaloneTelemetryAttrs(attrs, flavor)),
		currentTraceparent: () => telemetry.currentTraceparent(),
	}
	if (telemetry.withTraceContext) filtered.withTraceContext = (carrier, fn) => telemetry.withTraceContext?.(carrier, fn) ?? fn()
	return Object.freeze(filtered)
}

function recordStandaloneSpanFailure(
	span: Parameters<TelemetryShim['span']>[2] extends (span: infer Span) => Promise<unknown> ? Span : never,
	error: unknown,
): void {
	const serialized = serializeError(error)
	const scope = typeof serialized.meta?.['scope'] === 'string' ? serialized.meta['scope'] : undefined
	const timeoutMs = typeof serialized.meta?.['timeout_ms'] === 'number' && Number.isFinite(serialized.meta['timeout_ms'])
		? serialized.meta['timeout_ms'] : undefined
	span.setAttributes({
		'harness.error.code': serialized.code,
		'harness.error.category': serialized.category,
		'harness.error.retriable': serialized.retriable,
		...(scope === undefined ? {} : { 'harness.error.scope': scope }),
		...(timeoutMs === undefined ? {} : { 'harness.error.timeout_ms': timeoutMs }),
	})
	span.recordException(new Error(serialized.code))
	span.setStatus({ code: 2, message: serialized.code })
}

function filterStandaloneSpan(span: Parameters<TelemetryShim['span']>[2] extends (span: infer S) => Promise<unknown> ? S : never, flavor: string): typeof span {
	const target = span as { setAttribute?: (key: string, value: unknown) => unknown; setAttributes?: (attrs: Record<string, unknown>) => unknown }
	return new Proxy(span as object, { get(value, property, receiver) {
		if (property === 'setAttribute' && target.setAttribute) return (key: string, attrValue: unknown) => {
			if (Object.keys(filterStandaloneTelemetryAttrs({ [key]: attrValue } as SpanAttrs, flavor)).length > 0) target.setAttribute?.(key, attrValue)
			return span
		}
		if (property === 'setAttributes' && target.setAttributes) return (attrs: SpanAttrs) => {
			target.setAttributes?.(filterStandaloneTelemetryAttrs(attrs, flavor)); return span
		}
		return Reflect.get(value, property, receiver)
	} }) as typeof span
}

function filterStandaloneTelemetryAttrs<T extends Record<string, unknown>>(attrs: T, flavor: string): T {
	const filtered: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined) continue
		if (flavor === 'gen_ai_only' && isOpenInferenceAttribute(key)) continue
		if (flavor === 'openinference_only' && key.startsWith('gen_ai.')) continue
		filtered[key] = value
	}
	return filtered as T
}

function isOpenInferenceAttribute(key: string): boolean {
	return key === 'openinference.span.kind' || key.startsWith('llm.') || key.startsWith('tool.')
		|| key.startsWith('retrieval.') || key.startsWith('embedding.') || key.startsWith('reranker.')
		|| key.startsWith('guardrail.') || key.startsWith('evaluator.') || key === 'input.value' || key === 'output.value'
}

function toModelMessage(message: Message): ModelMessage {
	if (message.role === 'tool') return { role: 'tool', toolCallId: message.toolResults?.[0]?.toolCallId ?? message.id, content: message.content }
	return { role: message.role, content: message.content, ...(message.role === 'assistant' && message.toolCalls ? { toolCalls: message.toolCalls } : {}) }
}

function toPersistedMessage(message: ModelMessage, sessionId: string, runId: string, index: number, timestamp: string): Message {
	const content = typeof message.content === 'string' ? message.content : canonicalJson(message.content as unknown as JsonValue)
	const base = { id: `msg_${digest(['harness.message.v1', runId, index, message.role])}`, sessionId, runId,
		role: message.role, content, timestamp }
	if (message.role === 'assistant' && message.toolCalls !== undefined) {
		return Object.freeze({ ...base, toolCalls: message.toolCalls.map(call => ({
			id: call.id, name: call.name, arguments: JSON.parse(canonicalJson(call.arguments)) as JsonValue,
		})) })
	}
	if (message.role === 'tool') {
		return Object.freeze({ ...base, toolResults: [{ toolCallId: message.toolCallId,
			output: parseToolMessageOutput(message.content) }] })
	}
	return Object.freeze(base)
}

function parseToolMessageOutput(content: string): JsonValue {
	try {
		const parsed: unknown = JSON.parse(content)
		return isJsonValue(parsed) ? parsed : content
	} catch { return content }
}

async function commitConversationTurn(
	storage: HarnessStorage,
	sessionId: string,
	turn: readonly Message[],
	retention: ResolvedHarnessExecutionDefaults['historyRetention'],
): Promise<void> {
	if (retention === undefined) {
		await storage.appendMessages(sessionId, [...turn])
		return
	}
	if (storage.replaceMessages === undefined) throw new StateError('Storage cannot apply session history retention.', { op: 'replaceMessages', reason: 'unsupported' })
	const prior = await storage.listMessages(sessionId)
	await storage.replaceMessages(sessionId, retainCompleteTurns([...prior, ...turn], retention))
}

function summarize(run: RunRecord, events: readonly PersistedRunEvent[]): RunSummary {
	const tokenTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
	let modelCalls = 0
	let toolCalls = 0
	let agentCalls = 0
	for (const event of events) {
		if (event.type === 'agent.started') agentCalls += 1
		if (event.type === 'tool.started') toolCalls += 1
		if (event.type !== 'model.completed') continue
		modelCalls += 1
		if (!isPlainRecord(event.payload) || !isTokenUsage(event.payload['usage'])) continue
		tokenTotals.inputTokens += event.payload['usage'].inputTokens
		tokenTotals.outputTokens += event.payload['usage'].outputTokens
		tokenTotals.totalTokens += event.payload['usage'].totalTokens
	}
	const value: RunSummary = { runId: run.id, sessionId: run.sessionId, status: run.status, startedAt: run.startedAt,
		...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }), tokenTotals,
		modelCalls, toolCalls, agentCalls }
	if (run.error !== undefined) return { ...value, error: run.error as Exclude<RunSummary['error'], undefined> }
	return value
}

function isTokenUsage(value: unknown): value is import('../ports/model-provider.js').TokenUsage {
	return isPlainRecord(value)
		&& Number.isFinite(value['inputTokens']) && Number.isFinite(value['outputTokens']) && Number.isFinite(value['totalTokens'])
}

function requireResumeRun(
	run: RunRecord | undefined,
	resume: ToolApprovalResume,
	sessionId: string,
	target: AnyAgentDefinition | AnyWorkflowDefinition,
	input: JsonValue,
): RunRecord {
	if (resume.runId !== run?.id) throw new ApprovalResumeError('run_mismatch')
	if (run.sessionId !== sessionId || run.kind !== target.kind || run.target !== target.id) throw new ApprovalResumeError('run_mismatch')
	if (canonicalJson(run.input) !== canonicalJson(input)) throw new ApprovalResumeError('input_mismatch')
	return run
}

function validateTerminalResume(
	run: RunRecord,
	resume: ToolApprovalResume,
	options: InstantiateStandaloneHarnessOptions,
	graphDigest: string,
	session: SessionRecord,
	target: AnyAgentDefinition | AnyWorkflowDefinition,
): void {
	const receipt = run.approvalReceipt
	if (!receipt || receipt.interruptId !== resume.interruptId) throw new ApprovalResumeError('stale_continuation')
	if (receipt.deploymentRevision !== options.revision) throw new ApprovalResumeError('revision_mismatch')
	if (receipt.compiledGraphDigest !== graphDigest) throw new ApprovalResumeError('graph_mismatch')
	if (receipt.sessionIdentityDigest !== identityDigest(session.identity)) throw new ApprovalResumeError('session_identity_mismatch')
	if (receipt.rootTarget.kind !== target.kind || receipt.rootTarget.id !== target.id) throw new ApprovalResumeError('run_mismatch')
	const decisions = normalizeResumeDecisions(resume)
	if (receipt.resumeEventId !== resume.eventId) throw new ApprovalResumeError('stale_continuation')
	if (canonicalJson(receipt.decisions as unknown as JsonValue) !== canonicalJson(decisions as unknown as JsonValue)) throw new ApprovalResumeError('event_conflict')
}

function validateApprovalResume(
	checkpoint: RunCheckpoint | undefined,
	resume: ToolApprovalResume,
	run: RunRecord,
	input: JsonValue,
	options: InstantiateStandaloneHarnessOptions,
	graphDigest: string,
	session: SessionRecord,
	target: AnyAgentDefinition | AnyWorkflowDefinition,
): ParsedPendingCheckpoint {
	if (run.status !== 'interrupted' && run.status !== 'running') throw new ApprovalResumeError('invalid_checkpoint')
	if (!checkpoint || checkpoint.stepId !== 'harness:interrupt:v1' || checkpoint.runId !== run.id || checkpoint.sessionId !== session.id
		|| canonicalJson(checkpoint.input) !== canonicalJson(input) || !isApprovalCheckpointValue(checkpoint.output)) {
		throw new ApprovalResumeError('invalid_checkpoint')
	}
	const value = checkpoint.output
	if (value.rootRunId !== run.id || value.sessionId !== session.id) {
		throw new ApprovalResumeError('run_mismatch')
	}
	if (!isPendingInterruptionValue(value)) {
		if (value.interruptId !== resume.interruptId || value.resumeEventId !== resume.eventId) throw new ApprovalResumeError('stale_continuation')
		if (value.deploymentRevision !== options.revision) throw new ApprovalResumeError('revision_mismatch')
		if (value.compiledGraphDigest !== graphDigest) throw new ApprovalResumeError('graph_mismatch')
		if (value.sessionIdentityDigest !== identityDigest(session.identity)) throw new ApprovalResumeError('session_identity_mismatch')
		const decisions = normalizeResumeDecisions(resume)
		if (canonicalJson(value.decisions as unknown as JsonValue) !== canonicalJson(decisions as unknown as JsonValue)) throw new ApprovalResumeError('event_conflict')
		const rootFrame = value.continuation.frame
		if (rootFrame.runId !== run.id || (target.kind === 'agent'
			? rootFrame.kind !== 'agent' || rootFrame.state.agentId !== target.id
			: rootFrame.kind !== 'workflow' || rootFrame.workflowId !== target.id)) throw new ApprovalResumeError('run_mismatch')
		return Object.freeze({ checkpoint, value })
	}
	if (value.rootTarget.kind !== target.kind || value.rootTarget.id !== target.id) throw new ApprovalResumeError('run_mismatch')
	if (value.interrupt.id !== resume.interruptId) {
		const prior = value.priorResumeReceipt
		if (!prior || prior.interruptId !== resume.interruptId) throw new ApprovalResumeError('stale_continuation')
		if (prior.resumeEventId !== resume.eventId) throw new ApprovalResumeError('stale_continuation')
		if (canonicalJson(prior.decisions as unknown as JsonValue) !== canonicalJson(normalizeResumeDecisions(resume) as unknown as JsonValue)) {
			throw new ApprovalResumeError('event_conflict')
		}
		return Object.freeze({ checkpoint, value, replayCurrentInterruption: true })
	}
	if (value.interrupt.revision !== resume.revision) throw new ApprovalResumeError('interrupt_mismatch')
	if (value.deploymentRevision !== options.revision) throw new ApprovalResumeError('revision_mismatch')
	if (value.compiledGraphDigest !== graphDigest) throw new ApprovalResumeError('graph_mismatch')
	if (value.sessionIdentityDigest !== identityDigest(session.identity)) throw new ApprovalResumeError('session_identity_mismatch')
	const decisions = normalizeResumeDecisions(resume)
	const requested = [...value.interrupt.requests].map(request => request.approvalId).sort(codePointCompare)
	if (decisions.length !== requested.length || decisions.some((decision, index) => decision.approvalId !== requested[index])) {
		throw new ApprovalResumeError('decision_set_mismatch')
	}
	return Object.freeze({ checkpoint, value })
}

function normalizeResumeDecisions(resume: ToolApprovalResume): readonly AppliedApprovalDecisionV1[] {
	const seen = new Set<string>()
	const decisions: AppliedApprovalDecisionV1[] = []
	for (const decision of resume.decisions) {
		if (!validIdentifier(decision.approvalId) || typeof decision.approved !== 'boolean' || seen.has(decision.approvalId)) {
			throw new ApprovalResumeError('decision_set_mismatch')
		}
		seen.add(decision.approvalId)
		decisions.push(Object.freeze({ approvalId: decision.approvalId, approved: decision.approved }))
	}
	return Object.freeze(decisions.sort((left, right) => codePointCompare(left.approvalId, right.approvalId)))
}

function approvalReceiptFor(
	resume: ToolApprovalResume,
	checkpoint: ApprovalCheckpointValue,
	options: InstantiateStandaloneHarnessOptions,
	session: SessionRecord,
	target: AnyAgentDefinition | AnyWorkflowDefinition,
): ApprovalResumeReceiptV1 {
	if (!isPendingInterruptionValue(checkpoint)) return Object.freeze({ schemaVersion: 1,
		interruptId: checkpoint.interruptId, resumeEventId: checkpoint.resumeEventId, decisions: checkpoint.decisions,
		deploymentRevision: checkpoint.deploymentRevision, compiledGraphDigest: checkpoint.compiledGraphDigest,
		sessionIdentityDigest: checkpoint.sessionIdentityDigest, rootTarget: Object.freeze({ kind: target.kind, id: target.id }) })
	return Object.freeze({ schemaVersion: 1, interruptId: resume.interruptId, resumeEventId: resume.eventId,
		decisions: normalizeResumeDecisions(resume), deploymentRevision: options.revision!,
		compiledGraphDigest: checkpoint.compiledGraphDigest, sessionIdentityDigest: identityDigest(session.identity),
		rootTarget: checkpoint.rootTarget })
}

function requireRootAgentFrame(value: ApprovalCheckpointValue, target: AnyAgentDefinition | AnyWorkflowDefinition): AgentContinuationStateV1 {
	if (target.kind !== 'agent' || value.continuation.frame.kind !== 'agent'
		|| value.continuation.frame.runId !== value.rootRunId) throw new ApprovalResumeError('invalid_checkpoint')
	return value.continuation.frame.state
}

function requireRootWorkflowFrame(
	value: ApprovalCheckpointValue,
	target: AnyAgentDefinition | AnyWorkflowDefinition,
): Extract<SuspensionFrameValue, { kind: 'workflow' }> {
	const frame = value.continuation.frame
	if (target.kind !== 'workflow' || frame.kind !== 'workflow' || frame.runId !== value.rootRunId
		|| frame.workflowId !== target.id) throw new ApprovalResumeError('invalid_checkpoint')
	return frame
}

function resumingCheckpoint(
	pending: ApprovalCheckpointValue,
	receipt: ApprovalResumeReceiptV1,
	continuation: SuspensionNodeValue = pending.continuation,
): JsonValue {
	return JSON.parse(canonicalJson(Object.freeze({ schemaVersion: 1, kind: 'harness_interruption_resuming',
		rootRunId: pending.rootRunId, sessionId: pending.sessionId, interruptId: receipt.interruptId,
		resumeEventId: receipt.resumeEventId, decisions: receipt.decisions, deploymentRevision: receipt.deploymentRevision,
		compiledGraphDigest: receipt.compiledGraphDigest, sessionIdentityDigest: receipt.sessionIdentityDigest,
		continuation,
		nextEventSequence: pending.nextEventSequence, startedAgentRunIds: pending.startedAgentRunIds }))) as JsonValue
}

function postApprovalCheckpoint(
	pending: ApprovalCheckpointValue,
	receipt: ApprovalResumeReceiptV1,
	continuation: SuspensionNodeValue,
	nextEventSequence: number,
): JsonValue {
	return JSON.parse(canonicalJson(Object.freeze({ schemaVersion: 1, kind: 'harness_post_approval',
		rootRunId: pending.rootRunId, sessionId: pending.sessionId, interruptId: receipt.interruptId,
		resumeEventId: receipt.resumeEventId, decisions: receipt.decisions, deploymentRevision: receipt.deploymentRevision,
		compiledGraphDigest: receipt.compiledGraphDigest, sessionIdentityDigest: receipt.sessionIdentityDigest,
		continuation, nextEventSequence, startedAgentRunIds: pending.startedAgentRunIds }))) as JsonValue
}

function replaceAgentNodeState(node: SuspensionNodeValue, invocationId: string, state: AgentContinuationStateV1): SuspensionNodeValue {
	if (node.frame.invocationId === invocationId) {
		if (node.frame.kind !== 'agent') throw new ApprovalResumeError('invalid_checkpoint')
		return Object.freeze({ frame: Object.freeze({ ...node.frame, state }), children: node.children })
	}
	let changed = false
	const children = node.children.map(child => {
		const next = replaceAgentNodeState(child, invocationId, state)
		if (next !== child) changed = true
		return next
	})
	return changed ? Object.freeze({ frame: node.frame, children: Object.freeze(children) }) : node
}

function findSuspensionNode(node: SuspensionNodeValue | undefined, invocationId: string): SuspensionNodeValue | undefined {
	if (node?.frame.invocationId === invocationId) return node
	for (const child of node?.children ?? []) {
		const found = findSuspensionNode(child, invocationId)
		if (found) return found
	}
	return undefined
}

function findSuspensionParent(node: SuspensionNodeValue | undefined, invocationId: string): SuspensionNodeValue | undefined {
	if (node === undefined) return undefined
	if (node.children.some(child => child.frame.invocationId === invocationId)) return node
	for (const child of node.children) {
		const found = findSuspensionParent(child, invocationId)
		if (found !== undefined) return found
	}
	return undefined
}

function findSuspensionPath(node: SuspensionNodeValue, invocationId: string): readonly SuspensionNodeValue[] | undefined {
	if (node.frame.invocationId === invocationId) return Object.freeze([node])
	for (const child of node.children) {
		const childPath = findSuspensionPath(child, invocationId)
		if (childPath !== undefined) return Object.freeze([node, ...childPath])
	}
	return undefined
}

function uncorrelatedEvent<Output extends JsonValue>(event: ExecutionEvent<Output>): UncorrelatedExecutionEvent<Output> {
	const { eventId: _eventId, sequence: _sequence, runId: _runId, parentRunId: _parentRunId,
		parentInvocationId: _parentInvocationId, ...body } = event
	return body as UncorrelatedExecutionEvent<Output>
}

function checkpointReplacement(
	base: RunCheckpoint,
	sequence: number,
	output: JsonValue,
	lease?: DurableRunLease,
	replay: DurableReplayCheckpoint | undefined = base.replay,
): RunCheckpoint {
	return Object.freeze({ runId: base.runId, sessionId: base.sessionId, leaseId: lease?.leaseId ?? base.leaseId, workerId: lease?.workerId ?? base.workerId,
		stepId: base.stepId, input: base.input, attempt: lease?.attempt ?? base.attempt, sequence, output,
		...(replay === undefined ? {} : { replay }),
		metadata: { checkpointKind: 'harness_interruption', schemaVersion: 1 } })
}

function targetSandboxPartition(
	harnessName: string,
	definition: AnyAgentDefinition | AnyWorkflowDefinition,
	defaultPolicy: import('../sandbox/ownership.js').SandboxPolicy<string> = 'inherit',
	childPolicy?: import('../sandbox/ownership.js').SandboxPolicy<string>,
): import('../sandbox/ownership.js').SandboxPartition {
	const policy = childPolicy === undefined
		? definition.sandbox ?? defaultPolicy
		: childPolicy === 'inherit' ? definition.sandbox ?? 'inherit' : childPolicy
	if (policy === 'inherit') return Object.freeze({ kind: 'shared' })
	if (policy === 'private') return Object.freeze({ kind: definition.kind, harnessName, id: definition.id })
	return Object.freeze({ kind: 'group', id: policy.group })
}

function rootSandboxScope(
	harnessName: string,
	definition: AnyAgentDefinition | AnyWorkflowDefinition,
	owner: import('../sandbox/ownership.js').SandboxOwner,
	runId: string,
	defaultPolicy: import('../sandbox/ownership.js').SandboxPolicy<string> = 'inherit',
	): SandboxScope {
	const partition = targetSandboxPartition(harnessName, definition, defaultPolicy)
	return definition.durable === true || definition.workspace === true
		? Object.freeze({ owner, partition, lifetime: 'run', runId })
		: Object.freeze({ owner, partition, lifetime: 'session' })
}

function resolveChildSandboxScope(
	harnessName: string,
	definition: AnyAgentDefinition | AnyWorkflowDefinition,
	handoff: ChildSandboxHandoff,
	): ResolvedChildSandboxHandoff {
	if (definition.kind !== 'agent') throw new InternalError('A child sandbox handoff must target an agent.')
	const selected = handoff.policy ?? definition.sandbox
	if (selected === undefined) {
		if (handoff.defaultBehavior === 'inherit') return Object.freeze({
			mode: handoff.source.relation === 'borrowed' ? 'attach' : 'create', scope: handoff.source.scope,
			terminateOnRelease: false, source: handoff.source,
		})
		const scope = Object.freeze({ owner: handoff.source.scope.owner, partition: Object.freeze({ kind: 'shared' as const }),
			lifetime: 'run' as const, runId: handoff.taskRunId })
		return Object.freeze({ mode: handoff.source.relation === 'borrowed' ? 'attach' : 'create', terminateOnRelease: true, scope,
			source: Object.freeze({ ...handoff.source, scope }) })
	}
	if (selected === 'inherit') return Object.freeze({
		mode: handoff.source.relation === 'borrowed' ? 'attach' : 'create', scope: handoff.source.scope,
		terminateOnRelease: false, source: handoff.source,
	})
	const partition = selected === 'private'
		? Object.freeze({ kind: 'agent' as const, harnessName, id: definition.id })
		: Object.freeze({ kind: 'group' as const, id: selected.group })
	const scope = handoff.source.scope.lifetime === 'run'
		? Object.freeze({ owner: handoff.source.scope.owner, partition, lifetime: 'run' as const, runId: handoff.source.scope.runId })
		: Object.freeze({ owner: handoff.source.scope.owner, partition, lifetime: 'session' as const })
	return Object.freeze({ scope, mode: handoff.source.relation === 'borrowed' ? 'attach' : 'create', terminateOnRelease: false,
		source: Object.freeze({ ...handoff.source, scope }) })
}

function sandboxLayoutPreimage(options: InstantiateStandaloneHarnessOptions): JsonValue {
	return ['harness.sandbox-layout.v1', options.name,
		sandboxPolicyDigest(options.bindings.sandboxBinding?.defaultPolicy),
		sortedSet(options.bindings.sandboxBinding?.groups ?? []),
		Object.values(options.graph.agents).map(value => ['agent', value.id, sandboxPolicyDigest(value.sandbox)] as JsonValue).sort(compareCanonical),
		Object.values(options.graph.workflows).map(value => ['workflow', value.id, sandboxPolicyDigest(value.sandbox),
			sortedSet(value.childTaskSandboxGroups ?? [])] as JsonValue).sort(compareCanonical)]
}

function sandboxLayoutDigest(options: InstantiateStandaloneHarnessOptions): string {
	return `sha256:${digest(sandboxLayoutPreimage(options))}`
}

function releaseWorkspaceRunBinding(
	workspace: import('../ports/workspace.js').DurableWorkspace,
	runId: string,
	owner: import('../sandbox/ownership.js').SandboxOwner,
): void {
	const candidate = workspace as { releaseRunBinding?: (selectedRunId: string, selectedOwner: import('../sandbox/ownership.js').SandboxOwner) => void }
	candidate.releaseRunBinding?.(runId, owner)
}

function isPendingInterruptionValue(value: unknown): value is PendingInterruptionValue {
	if (!isPlainRecord(value) || !hasOnlyStringKeys(value, ['schemaVersion', 'rootRunId', 'sessionId', 'rootTarget', 'deploymentRevision',
		'compiledGraphDigest', 'sessionIdentityDigest', 'interrupt', 'continuation', 'priorResumeReceipt', 'nextEventSequence', 'startedAgentRunIds'])) return false
	if (value['schemaVersion'] !== 1 || !validIdentifier(value['rootRunId']) || !validIdentifier(value['sessionId'])
		|| typeof value['deploymentRevision'] !== 'string' || typeof value['compiledGraphDigest'] !== 'string'
		|| typeof value['sessionIdentityDigest'] !== 'string' || !Number.isSafeInteger(value['nextEventSequence'])
		|| (value['nextEventSequence'] as number) < 2 || !Array.isArray(value['startedAgentRunIds'])
		|| !(value['startedAgentRunIds'] as unknown[]).every(validIdentifier)) return false
	const root = value['rootTarget']
	const interrupt = value['interrupt']
	const continuation = value['continuation']
	if (!isPlainRecord(root) || !hasOnlyStringKeys(root, ['kind', 'id']) || !['agent', 'workflow'].includes(String(root['kind'])) || !validIdentifier(root['id'])) return false
	if (!isPlainRecord(interrupt) || !hasOnlyStringKeys(interrupt, ['type', 'id', 'revision', 'requests']) || interrupt['type'] !== 'tool-approval'
		|| !validIdentifier(interrupt['id']) || typeof interrupt['revision'] !== 'string' || !Array.isArray(interrupt['requests'])
		|| !(interrupt['requests'] as unknown[]).every(isApprovalRequest)) return false
	return isSuspensionNode(continuation)
}

function isApprovalCheckpointValue(value: unknown): value is ApprovalCheckpointValue {
	return isPendingInterruptionValue(value) || isActiveApprovalCheckpointValue(value)
}

function isActiveApprovalCheckpointValue(value: unknown): value is ActiveApprovalCheckpointValue {
	if (!isPlainRecord(value) || !hasOnlyStringKeys(value, ['schemaVersion', 'kind', 'rootRunId', 'sessionId', 'interruptId',
		'resumeEventId', 'decisions', 'deploymentRevision', 'compiledGraphDigest', 'sessionIdentityDigest', 'continuation',
		'nextEventSequence', 'startedAgentRunIds'])) return false
	if (value['schemaVersion'] !== 1 || !['harness_interruption_resuming', 'harness_post_approval'].includes(String(value['kind']))
		|| !validIdentifier(value['rootRunId']) || !validIdentifier(value['sessionId']) || !validIdentifier(value['interruptId'])
		|| !validIdentifier(value['resumeEventId']) || typeof value['deploymentRevision'] !== 'string'
		|| typeof value['compiledGraphDigest'] !== 'string' || typeof value['sessionIdentityDigest'] !== 'string'
		|| !Number.isSafeInteger(value['nextEventSequence']) || (value['nextEventSequence'] as number) < 2
		|| !Array.isArray(value['startedAgentRunIds']) || !(value['startedAgentRunIds'] as unknown[]).every(validIdentifier)
		|| !Array.isArray(value['decisions']) || !(value['decisions'] as unknown[]).every(isAppliedApprovalDecision)) return false
	return isSuspensionNode(value['continuation'])
}

function isSuspensionNode(value: unknown): value is SuspensionNodeValue {
	if (!isPlainRecord(value) || !hasOnlyStringKeys(value, ['frame', 'children']) || !Array.isArray(value['children'])
		|| !isPlainRecord(value['frame'])) return false
	const frame = value['frame']
	if (!validSuspensionFrame(frame)) return false
	return value['children'].every(isSuspensionNode)
}

function validSuspensionFrame(frame: Record<string, unknown>): frame is SuspensionFrameValue {
	if (!validIdentifier(frame['runId']) || !validIdentifier(frame['invocationId'])) return false
	if (frame['kind'] === 'agent') {
		if (!hasOnlyStringKeys(frame, ['kind', 'runId', 'invocationId', 'state']) || !isJsonValue(frame['state'])) return false
		try {
			const state = frame['state'] as unknown as AgentContinuationStateV1
			if ('kind' in state) freezeAcceptedModelTurnCursor(state)
			else freezeSuspendedAgentTurnState(state)
			return true
		} catch { return false }
	}
	if (frame['kind'] === 'workflow') {
		return hasOnlyStringKeys(frame, ['kind', 'runId', 'workflowId', 'invocationId', 'input', 'activeCallIds', 'agentCallBudget'])
			&& validIdentifier(frame['workflowId']) && isJsonValue(frame['input']) && validIdentifierList(frame['activeCallIds'])
			&& validWorkflowAgentCallBudget(frame['agentCallBudget'])
	}
	if (frame['kind'] === 'host-tool') {
		return hasOnlyStringKeys(frame, ['kind', 'runId', 'agentId', 'invocationId', 'toolId', 'callId', 'input', 'bindingId',
			'bindingContractDigest', 'toolStarted', 'activeNestedCallIds'])
			&& validIdentifier(frame['agentId']) && validIdentifier(frame['toolId']) && validIdentifier(frame['callId'])
			&& isJsonValue(frame['input']) && validIdentifier(frame['bindingId']) && typeof frame['bindingContractDigest'] === 'string'
			&& frame['bindingContractDigest'].length > 0 && frame['toolStarted'] === true && validIdentifierList(frame['activeNestedCallIds'])
	}
	return false
}

function validIdentifierList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every(validIdentifier) && new Set(value).size === value.length
}

function validWorkflowAgentCallBudget(value: unknown): value is WorkflowAgentCallBudgetStateV1 {
	return isPlainRecord(value) && hasOnlyStringKeys(value, ['schemaVersion', 'usedCalls']) && value['schemaVersion'] === 1
		&& Number.isSafeInteger(value['usedCalls']) && (value['usedCalls'] as number) >= 0
}

function isAppliedApprovalDecision(value: unknown): boolean {
	return isPlainRecord(value) && hasOnlyStringKeys(value, ['approvalId', 'approved'])
		&& validIdentifier(value['approvalId']) && typeof value['approved'] === 'boolean'
}

function isApprovalRequest(value: unknown): boolean {
	return isPlainRecord(value) && hasOnlyStringKeys(value, ['approvalId', 'runId', 'agentRunId', 'parentRunId', 'parentInvocationId',
		'agentId', 'workflowId', 'invocationId', 'step', 'toolId', 'callId', 'input', 'demands'])
		&& ['approvalId', 'runId', 'agentRunId', 'agentId', 'invocationId', 'toolId', 'callId'].every(key => validIdentifier(value[key]))
		&& Number.isSafeInteger(value['step']) && isJsonValue(value['input']) && Array.isArray(value['demands'])
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function hasOnlyStringKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key))
}

function validIdentifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) }
function validInvocationIdempotencyKey(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value)
}
function codePointCompare(left: string, right: string): number {
	const a = Array.from(left, char => char.codePointAt(0)!)
	const b = Array.from(right, char => char.codePointAt(0)!)
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index]! - b[index]!
	return a.length - b.length
}

function normalizeInvokeOptions(value: InvokeOptions): InvokeOptions {
	if (!hasPlainPrototype(value)) throw invalidInvokeOptions()
	const allowed = ['signal', 'timeoutMs', 'historyWindow', 'idempotencyKey', 'contextProjection', 'traceparent', 'tracestate', 'metadata', 'resume', 'durable'] as const
	if (!Reflect.ownKeys(value).every(key => typeof key === 'string' && (allowed as readonly string[]).includes(key))) throw invalidInvokeOptions()
	if (value.signal !== undefined && (typeof value.signal !== 'object' || value.signal === null || typeof value.signal.aborted !== 'boolean'
		|| typeof value.signal.addEventListener !== 'function' || typeof value.signal.removeEventListener !== 'function')) throw invalidInvokeOptions()
	if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 0)) throw invalidInvokeOptions()
	if (value.historyWindow !== undefined && (!Number.isSafeInteger(value.historyWindow) || value.historyWindow < 0)) throw invalidInvokeOptions()
	if (value.idempotencyKey !== undefined && !validInvocationIdempotencyKey(value.idempotencyKey)) throw invalidInvokeOptions()
	if (value.traceparent !== undefined && typeof value.traceparent !== 'string') throw invalidInvokeOptions()
	if (value.tracestate !== undefined && typeof value.tracestate !== 'string') throw invalidInvokeOptions()
	const contextProjection = value.contextProjection === undefined ? undefined : snapshotContextProjection(value.contextProjection)
	const metadata = value.metadata === undefined ? undefined : snapshotJsonRecord(value.metadata)
	const resume = value.resume === undefined ? undefined : snapshotApprovalResume(value.resume)
	const durable = value.durable === undefined ? undefined : snapshotDurableInvokeOptions(value.durable)
	return Object.freeze({
		...(value.signal === undefined ? {} : { signal: value.signal }),
		...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
		...(value.historyWindow === undefined ? {} : { historyWindow: value.historyWindow }),
		...(value.idempotencyKey === undefined ? {} : { idempotencyKey: value.idempotencyKey }),
		...(contextProjection === undefined ? {} : { contextProjection }),
		...(value.traceparent === undefined ? {} : { traceparent: value.traceparent }),
		...(value.tracestate === undefined ? {} : { tracestate: value.tracestate }),
		...(metadata === undefined ? {} : { metadata }),
		...(resume === undefined ? {} : { resume }),
		...(durable === undefined ? {} : { durable }),
	})
}

function snapshotContextProjection(value: ContextProjectionPolicy): ContextProjectionPolicy {
	if (!hasPlainPrototype(value) || !Reflect.ownKeys(value).every(key => key === 'toolResultPruner')) throw invalidInvokeOptions()
	const pruner = value.toolResultPruner
	if (pruner === undefined) return Object.freeze({})
	if (!hasPlainPrototype(pruner)
		|| !Reflect.ownKeys(pruner).every(key => typeof key === 'string' && ['maxBytes', 'headBytes', 'tailBytes', 'marker'].includes(key))
		|| !validateContextProjection(value)) throw invalidInvokeOptions()
	return Object.freeze({ toolResultPruner: Object.freeze({ maxBytes: pruner.maxBytes, headBytes: pruner.headBytes,
		tailBytes: pruner.tailBytes, ...(pruner.marker === undefined ? {} : { marker: pruner.marker }) }) })
}

function snapshotDurableInvokeOptions(value: DurableInvokeOptions): DurableInvokeOptions {
	if (!hasPlainPrototype(value) || !Reflect.ownKeys(value).every(key => typeof key === 'string' && ['runId', 'workerId', 'stepId', 'attempt', 'workspacePolicy'].includes(key))
		|| !validIdentifier(value.runId) || (value.workerId !== undefined && !validIdentifier(value.workerId))
		|| (value.stepId !== undefined && !validIdentifier(value.stepId))
		|| (value.attempt !== undefined && (!Number.isSafeInteger(value.attempt) || value.attempt <= 0))) throw invalidInvokeOptions()
	const workspacePolicy = value.workspacePolicy === undefined ? undefined : snapshotWorkspacePolicy(value.workspacePolicy)
	return Object.freeze({ runId: value.runId, ...(value.workerId === undefined ? {} : { workerId: value.workerId }),
		...(value.stepId === undefined ? {} : { stepId: value.stepId }), ...(value.attempt === undefined ? {} : { attempt: value.attempt }),
		...(workspacePolicy === undefined ? {} : { workspacePolicy }) })
}

function snapshotWorkspacePolicy(value: Partial<DurableWorkspacePolicy>): Partial<DurableWorkspacePolicy> {
	if (!hasPlainPrototype(value) || !Reflect.ownKeys(value).every(key => typeof key === 'string'
		&& ['retention', 'encryption', 'quota'].includes(key))) throw invalidInvokeOptions()
	const retention = value.retention
	if (retention !== undefined) {
		const numeric = ['activeTtlMs', 'pausedTtlMs', 'terminalSuccessTtlMs', 'terminalFailureTtlMs', 'abortedTtlMs',
			'orphanTtlMs', 'maxTtlMs'] as const
		if (!hasPlainPrototype(retention) || !Reflect.ownKeys(retention).every(key => typeof key === 'string'
			&& [...numeric, 'cleanupMode'].includes(key as (typeof numeric)[number] | 'cleanupMode'))
			|| !['adapter_automatic', 'application_scheduled', 'manual_only'].includes(retention.cleanupMode)
			|| numeric.some(key => retention[key] !== undefined && (!Number.isSafeInteger(retention[key]) || retention[key]! <= 0))) {
			throw invalidInvokeOptions()
		}
	}
	const encryption = value.encryption
	if (encryption !== undefined && (!hasPlainPrototype(encryption)
		|| !Reflect.ownKeys(encryption).every(key => typeof key === 'string'
			&& ['encryptedAtRest', 'keyScope', 'rotationSupported', 'metadataEncrypted'].includes(key))
		|| typeof encryption.encryptedAtRest !== 'boolean' || typeof encryption.rotationSupported !== 'boolean'
		|| typeof encryption.metadataEncrypted !== 'boolean'
		|| !['adapter', 'tenant', 'project', 'application'].includes(encryption.keyScope))) throw invalidInvokeOptions()
	const quota = value.quota
	if (quota !== undefined) {
		const keys = ['maxWorkspaceBytes', 'maxWorkspaceFiles', 'maxSingleFileBytes', 'maxCheckpointPayloadBytes', 'maxSnapshotBytes',
			'maxActiveWorkspaces', 'maxPausedWorkspaces', 'maxConcurrentResumes', 'maxWorkspaceAgeMs', 'maxSnapshotsPerWorkspace',
			'maxRetainedSnapshotBytes'] as const
		if (!hasPlainPrototype(quota) || !Reflect.ownKeys(quota).every(key => typeof key === 'string' && keys.includes(key as (typeof keys)[number]))
			|| keys.some(key => quota[key] !== undefined && (!Number.isSafeInteger(quota[key]) || quota[key]! <= 0))) throw invalidInvokeOptions()
	}
	return Object.freeze({
		...(retention === undefined ? {} : { retention: Object.freeze({ ...retention }) }),
		...(encryption === undefined ? {} : { encryption: Object.freeze({ ...encryption }) }),
		...(quota === undefined ? {} : { quota: Object.freeze({ ...quota }) }),
	})
}

function snapshotJsonRecord(value: Readonly<Record<string, unknown>>): Readonly<Record<string, JsonValue>> {
	if (!hasPlainPrototype(value) || !isJsonValue(value)) throw invalidInvokeOptions()
	const copy: Record<string, JsonValue> = {}
	for (const [key, child] of Object.entries(value)) copy[key] = freezeJsonValue(child)
	return Object.freeze(copy)
}

function snapshotApprovalResume(value: ToolApprovalResume): ToolApprovalResume {
	assertApprovalResume(value)
	return Object.freeze({ type: 'tool-approval', runId: value.runId, interruptId: value.interruptId, revision: value.revision,
		eventId: value.eventId, decisions: Object.freeze(value.decisions.map(decision => Object.freeze({ approvalId: decision.approvalId,
			approved: decision.approved, ...(decision.reason === undefined ? {} : { reason: decision.reason }) }))) })
}

function freezeJsonValue(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return Object.freeze(value.map(item => freezeJsonValue(item))) as unknown as JsonValue
	if (value !== null && typeof value === 'object') {
		const copy: Record<string, JsonValue> = {}
		for (const [key, child] of Object.entries(value)) copy[key] = freezeJsonValue(child)
		return Object.freeze(copy)
	}
	return value
}

function invalidInvokeOptions(): ValidationError {
	return new ValidationError('Invocation options are invalid.', { where: 'invoke_options', issues: { reason: 'invalid_invoke_options' } })
}

function hasPlainPrototype(value: unknown): boolean {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function assertApprovalResume(value: unknown): asserts value is ToolApprovalResume {
	if (!isPlainRecord(value) || !hasOnlyStringKeys(value, ['type', 'runId', 'interruptId', 'revision', 'eventId', 'decisions'])
		|| value['type'] !== 'tool-approval' || !validIdentifier(value['runId']) || !validIdentifier(value['interruptId'])
		|| typeof value['revision'] !== 'string' || !validIdentifier(value['eventId']) || !Array.isArray(value['decisions'])) {
		throw new ApprovalResumeError('invalid_resume')
	}
	for (const decision of value['decisions']) {
		if (!isPlainRecord(decision) || !hasOnlyStringKeys(decision, ['approvalId', 'approved', 'reason'])
			|| !validIdentifier(decision['approvalId']) || typeof decision['approved'] !== 'boolean'
			|| (decision['reason'] !== undefined && typeof decision['reason'] !== 'string')) throw new ApprovalResumeError('invalid_resume')
	}
}

function digest(value: JsonValue): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }
function normalizeInternal(error: unknown): unknown { return error instanceof Error ? error : new InternalError('Harness operation failed.') }
