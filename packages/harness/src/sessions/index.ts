import type { Logger } from '../logger/index.js'
import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import type { JsonValue } from '../models/json.js'
import {
  InternalError,
  OperationCancelledError,
  OperationTimeoutError,
  HarnessError,
  SessionBusyError,
  ValidationError,
  DelegationPolicyError,
  serializeError
} from '../errors/index.js'
import { ulid } from '../ulid/index.js'
import { runDefaultAgent } from '../agents/index.js'
import { runWorkflow } from '../workflows/index.js'
import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  InvokeOptions,
  ModelsConfig,
  ResolvedSkill,
  RunSummary,
  RunEvent,
  Harness,
  HarnessDefaults,
  Session,
  SkillDefinition,
  ToolsConfig,
  WorkflowDefinition,
  WorkflowDelegationPolicy,
  WorkflowInput,
  WorkflowOutput,
  BuilderState,
  ContextCheckpoints,
  ContentCaptureMode,
  GovernanceConfig,
  TelemetryOptions
} from '../harness/defineHarness.js'
import type { MemoryAdapter, MemoryFacade } from '../ports/memory.js'
import { createMemoryFacade, createSessionMemory } from '../ports/memory.js'
import type { DurableRuntimeAdapter, HarnessInspection } from '../ports/capabilities.js'
import type { DurableWorkspaceStore } from '../ports/workspace.js'
import type { ContextCheckpoint, ContextCheckpointStore } from '../ports/context-checkpoints.js'
import { beginDurableWorkflow, DURABLE_RUN_ID_PATTERN, isExecutableDurableRuntime, type DurableWorkflowBinding } from '../runtime/sessionDurable.js'
import type { DurableRuntime } from '../runtime/durable.js'
import { runStepWithRetry, type DurableStepOptions } from '../runtime/steps.js'
import { HarnessConfigError } from '../errors/catalog.js'
import type { Sandbox, SandboxSession } from '../sandbox/index.js'
import type { StateStore } from '../ports/state.js'
import type { HarnessAdapterContext, HarnessContextConfigurable } from '../ports/harness-context.js'
import type { TokenUsage } from '../ports/model-provider.js'
import { loadSkillsSync } from '../skills/index.js'
import { createModelRegistry } from '../models/registry.js'
import { createMetrics, createTelemetryShim, type TelemetryShim } from '../telemetry/index.js'
import { metadataSpanAttrs } from '../telemetry/span-attrs.js'
import { abortError } from '../runtime/abort.js'
import { createMcpRunnerRegistry } from '../tools/mcp/runner.js'

type ModelRunContext = {
  harnessName: string
  sessionId: string
  runId: string
  workflowId?: string
  agentId?: string
  emitRunEvents?: boolean
  streamId?: string
  modelAlias?: string
}

type HarnessDefinition<S extends BuilderState> = {
  name: string
  logger: Logger
  telemetry?: TelemetryOptions
  telemetryShim?: TelemetryShim
  state: StateStore
  sandbox: Sandbox
  memory: MemoryAdapter
  runtime?: DurableRuntimeAdapter
  workspaceStore?: DurableWorkspaceStore
  checkpoints?: ContextCheckpointStore
  defaults: HarnessDefaults
  models: NonNullable<S['models']>
  tools: NonNullable<S['tools']>
  skills: NonNullable<S['skills']>
  agents: NonNullable<S['agents']>
  workflows: NonNullable<S['workflows']>
  governance?: GovernanceConfig<S>
  inspection: HarnessInspection
}

type SessionState = {
  busy: boolean
  sandboxSession: SandboxSession
  mountedSkills: Set<string>
}

type EffectiveDelegationPolicy = {
  enabled: boolean
  allowedAgents?: Set<string>
  maxChildAgentCalls: number
  maxParallelChildAgentCalls: number
  maxDepth: number
  modelAliases?: Set<string>
  agentModelAliases: Map<string, Set<string>>
}

type DelegationRunState = {
  totalChildAgentCalls: number
  activeChildAgentCalls: number
  /** In-flight child-agent call promises, settled before the run terminalizes. */
  inFlightChildCalls: Set<Promise<unknown>>
}

const NEVER_ABORT_SIGNAL = new AbortController().signal
const DEFAULT_MAX_CHILD_AGENT_CALLS = 32
const DEFAULT_MAX_PARALLEL_CHILD_AGENT_CALLS = 8
const DEFAULT_MAX_DELEGATION_DEPTH = 1
/**
 * Workflows invoke leaf agents directly, so every child-agent call runs at
 * depth 1 (spec 10 "Delegation policy": `maxDepth` default `1`, `0` disables
 * child-agent delegation).
 */
const CHILD_DELEGATION_DEPTH = 1

function now(): string {
  return new Date().toISOString()
}

const STREAM_MAX_BUFFERED_EVENTS = 1024
/**
 * Event types that must never be dropped from the relay queue.
 *
 * Only `run.finished` qualifies: it occurs at most once per run and is the
 * terminal event consumers key off to know the run is complete. `agent.finished`
 * is emitted once per agent invocation (including every child-agent delegation
 * call), so it can appear many times and must remain droppable to keep the
 * queue bounded when a slow consumer falls behind during a delegation-heavy run.
 */
const STREAM_UNDROPPABLE_EVENT_TYPES = new Set<string>(['run.finished'])

/**
 * Relay run events from an in-process run to a stream consumer.
 *
 * The unread events live in a bounded queue (cap: STREAM_MAX_BUFFERED_EVENTS):
 * consumed events are removed (no growing cursor over a shared array), and on
 * overflow the oldest droppable unread event is dropped and counted, so a slow
 * consumer never silently skips an event without an accompanying
 * `stream.overflow` notice. Only `run.finished` is undroppable; all other
 * event types — including `agent.finished` — may be evicted under pressure.
 * If no droppable event exists when the queue is full, the incoming event is
 * discarded (counted) rather than growing the queue past the cap. Delivery is
 * promise-notified rather than time-polled, so there is no fixed per-event
 * latency or periodic timer.
 *
 * Abandoning the stream (`break` / `iterator.return()`) only detaches that
 * consumer. It does not abort `relaySignal`; callers must pass `opts.signal`
 * when they intend to cancel the underlying run.
 */
export async function* relayRunEvents(
  run: (onEvent: (event: RunEvent) => Promise<void>, relaySignal: AbortSignal) => Promise<unknown>
): AsyncIterable<RunEvent> {
  const queue: RunEvent[] = []
  let dropped = 0
  let liveRunId = 'unknown'
  let done = false
  let failure: unknown
  let wake: (() => void) | undefined
  const relayController = new AbortController()
  let completedNormally = false

  const notify = (): void => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }

  const result = run((event) => {
    if ('runId' in event) liveRunId = event.runId
    if (queue.length >= STREAM_MAX_BUFFERED_EVENTS) {
      const dropIndex = queue.findIndex((candidate) => !STREAM_UNDROPPABLE_EVENT_TYPES.has(candidate.type))
      if (dropIndex >= 0) {
        queue.splice(dropIndex, 1)
        dropped += 1
      } else {
        // Every queued event is undroppable; discard the incoming event to keep
        // the queue bounded rather than growing past the cap.
        dropped += 1
        notify()
        return Promise.resolve()
      }
    }
    queue.push(event)
    notify()
    return Promise.resolve()
  }, relayController.signal)
    .catch((error) => {
      failure = error
      return undefined
    })
    .finally(() => {
      done = true
      notify()
    })

  try {
    while (true) {
      if (dropped > 0) {
        const droppedCount = dropped
        dropped = 0
        yield { type: 'stream.overflow', runId: liveRunId, at: now(), dropped: droppedCount }
      }
      while (queue.length > 0) {
        yield queue.shift() as RunEvent
        // Surface a fresh overflow notice promptly between events.
        if (dropped > 0) break
      }
      if (queue.length === 0 && dropped === 0) {
        if (done) {
          completedNormally = true
          break
        }
        // No await between the empty check and installing `wake`, so a producer
        // push cannot be lost between them.
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    }
  } finally {
    if (completedNormally) {
      await result.catch(() => undefined)
    } else {
      void result.catch(() => undefined)
    }
  }
  if (failure) throw failure
}

function validateInvokeOptions(opts: InvokeOptions | undefined): void {
  if (opts?.historyWindow !== undefined && opts.historyWindow < 0) {
    throw new ValidationError('Invoke options are invalid.', { where: 'invoke_options', issues: { historyWindow: opts.historyWindow } })
  }
  if (opts?.timeoutMs !== undefined && opts.timeoutMs < 0) {
    throw new ValidationError('Invoke options are invalid.', { where: 'invoke_options', issues: { timeoutMs: opts.timeoutMs } })
  }
}

function normalizeMessage(message: Omit<Message, 'id' | 'timestamp'>, sessionId: string): Message {
  return {
    ...message,
    sessionId,
    id: ulid(),
    timestamp: now()
  }
}

export function createSessionHarness<S extends BuilderState>(definition: HarnessDefinition<S>): Harness<S> {
  const resolvedSkills = loadSkillsSync(definition.skills as Record<string, SkillDefinition>) as NonNullable<S['skills']> & Record<string, ResolvedSkill>
  const sessionStates = new Map<string, SessionState>()
  // In-flight session-state creations, memoized so concurrent first-time callers
  // share one sandbox open (no orphaned sessions) and one SessionState object
  // (so the synchronous busy check/set below serializes runs correctly).
  const sessionStateOpenings = new Map<string, Promise<SessionState>>()
  // Stable per-harness-instance worker id used as the default durable lease owner.
  const durableWorkerId = `worker_${ulid()}`
  const contentCaptureMode = resolveContentCaptureMode(definition.telemetry)
  const telemetry = withTelemetryFlavor(definition.telemetryShim ?? createTelemetryShim(), definition.telemetry)
  const adapterMetrics = createMetrics(telemetry, { 'harness.name': definition.name })
  const adapterContext: HarnessAdapterContext = {
    harnessName: definition.name,
    logger: definition.logger,
    telemetry,
    metrics: adapterMetrics,
    contentCaptureMode,
    defaults: {
      agentMaxIterations: definition.defaults.agentMaxIterations ?? 16,
      runTimeoutMs: definition.defaults.runTimeoutMs ?? 600_000,
      toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
      skillTimeoutMs: definition.defaults.skillTimeoutMs ?? 60_000,
      modelTimeoutMs: definition.defaults.modelTimeoutMs ?? 300_000,
      maxParallelToolCalls: definition.defaults.maxParallelToolCalls ?? 8,
      ...(definition.defaults.historyWindow !== undefined ? { historyWindow: definition.defaults.historyWindow } : {})
    }
  }
  configureHarnessAdapters(adapterContext, definition.models as ModelsConfig, definition.state, definition.sandbox, definition.memory, definition.tools as ToolsConfig, definition.runtime, definition.workspaceStore, definition.checkpoints)
  const modelRegistry = createModelRegistry(definition.models, { telemetry, harnessName: definition.name })
  const mcpRegistry = createMcpRunnerRegistry()

  async function ensureSessionRecord(sessionId: string): Promise<SessionRecord> {
    const existing = await definition.state.getSession(sessionId)
    if (existing) {
      return existing
    }

    const createdAt = now()
    const created: SessionRecord = {
      id: sessionId,
      createdAt,
      updatedAt: createdAt,
      runCount: 0
    }
    await definition.state.upsertSession(created)
    return created
  }

  function getSessionState(sessionId: string): Promise<SessionState> {
    const existing = sessionStates.get(sessionId)
    if (existing) {
      return Promise.resolve(existing)
    }
    const pending = sessionStateOpenings.get(sessionId)
    if (pending) {
      return pending
    }

    const opening = (async () => {
      const sandboxSession = await definition.sandbox.open({ sessionId, runId: `init_${ulid()}` })
      const created: SessionState = { busy: false, sandboxSession, mountedSkills: new Set<string>() }
      sessionStates.set(sessionId, created)
      sessionStateOpenings.delete(sessionId)
      return created
    })()
    // Let a failed open be retried instead of caching the rejection forever.
    opening.catch(() => sessionStateOpenings.delete(sessionId))
    sessionStateOpenings.set(sessionId, opening)
    return opening
  }

  async function appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    try {
      await definition.state.appendEvents(runId, events)
    } catch (error) {
      telemetry.recordCounter('harness.events.persist_errors', 1, { harness: definition.name })
      definition.logger.error('Failed to persist run events.', { harness: definition.name, run_id: runId, error: serializeError(error) })
    }
  }

  async function getRunSummary(runId: string): Promise<RunSummary | undefined> {
    const run = await definition.state.getRun(runId)
    if (!run) return undefined
    const events = await definition.state.listEvents(runId)
    const tokenTotals: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let modelCalls = 0
    let toolCalls = 0
    let agentCalls = 0

    for (const event of events) {
      if (event.type === 'agent.started') agentCalls += 1
      if (event.type === 'tool.started') toolCalls += 1
      if (event.type.startsWith('model.') && event.type.endsWith('.completed')) modelCalls += 1
      if (event.type === 'model.object') modelCalls += 1
      const payload = event.payload
      if (isJsonRecord(payload) && isTokenUsage(payload['usage'])) {
        tokenTotals.inputTokens += payload['usage'].inputTokens
        tokenTotals.outputTokens += payload['usage'].outputTokens
        tokenTotals.totalTokens += payload['usage'].totalTokens
        addOptionalTokenCounts(tokenTotals, payload['usage'])
      }
    }

    return {
      runId: run.id,
      sessionId: run.sessionId,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      tokenTotals,
      modelCalls,
      toolCalls,
      agentCalls,
      ...(run.error ? { error: normalizeSerializedRunError(run.error) } : {})
    }
  }

  function memoryOptions(
    sessionId: string,
    sandboxSession: SandboxSession,
    signal: AbortSignal,
    opts: {
      runId?: string
      agentId?: string
      workflowId?: string
      metadata?: Readonly<Record<string, JsonValue>>
    } = {}
  ): Parameters<typeof createSessionMemory>[0] {
    return {
      adapter: definition.memory,
      logger: definition.logger,
      telemetry,
      contentCaptureMode,
      signal,
      sandbox: sandboxSession,
      harnessName: definition.name,
      sessionId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.workflowId ? { workflowId: opts.workflowId } : {}),
      metadata: opts.metadata ?? {}
    }
  }

  function memoryFacade(opts: {
    sessionId: string
    sandboxSession: SandboxSession
    signal: AbortSignal
    runId: string
    agentId?: string
    workflowId?: string
    metadata: Readonly<Record<string, JsonValue>>
  }): MemoryFacade {
    return createMemoryFacade(memoryOptions(opts.sessionId, opts.sandboxSession, opts.signal, opts))
  }

  /**
   * Validates `opts.durable` and returns the executable durable runtime, or
   * `undefined` for an ephemeral run. Throws before any run record is created.
   */
  function resolveDurableRuntime(opts: InvokeOptions | undefined): DurableRuntime | undefined {
    if (!opts?.durable) return undefined
    if (!DURABLE_RUN_ID_PATTERN.test(opts.durable.runId)) {
      throw new ValidationError('Durable run id is invalid.', { where: 'invoke_options', issues: { 'durable.runId': opts.durable.runId } })
    }
    if (!isExecutableDurableRuntime(definition.runtime)) {
      throw new HarnessConfigError('Durable execution requires an executable .runtime(...) adapter.', { reason: 'durable_runtime_required', path: 'runtime' })
    }
    return definition.runtime
  }

  function createContextCheckpoints(args: {
    runId: string
    sessionId: string
    workflowId?: string
    agentId?: string
    signal: AbortSignal
  }): ContextCheckpoints {
    const store = definition.checkpoints
    const requireStore = (): ContextCheckpointStore => {
      if (!store) {
        throw new ValidationError('No context checkpoint store is configured.', {
          where: 'invoke_options',
          issues: { reason: 'context_checkpoint_store_missing' }
        })
      }
      return store
    }
    const baseQuery = {
      runId: args.runId,
      sessionId: args.sessionId,
      ...(args.workflowId ? { workflowId: args.workflowId } : {}),
      ...(args.agentId ? { agentId: args.agentId } : {})
    }
    return {
      async write(input): Promise<void> {
        const json = JSON.stringify(input.payload)
        if (json === undefined) {
          throw new ValidationError('Context checkpoint payload must be JSON-serializable.', {
            where: 'invoke_options',
            issues: { reason: 'non_json_context_checkpoint_payload' }
          })
        }
        const checkpoint: ContextCheckpoint = {
          ...baseQuery,
          sequence: input.sequence,
          kind: input.kind,
          payload: input.payload,
          payloadSizeBytes: Buffer.byteLength(json, 'utf8'),
          createdAt: now(),
          ...(input.metadata ? { metadata: input.metadata } : {})
        }
        await requireStore().write(checkpoint, { signal: args.signal })
      },
      async list(query = {}): Promise<readonly ContextCheckpoint[]> {
        return requireStore().list({ ...baseQuery, ...query, signal: args.signal })
      },
      async read(ref): Promise<ContextCheckpoint | undefined> {
        return requireStore().read({ runId: args.runId, sessionId: args.sessionId, sequence: ref.sequence, kind: ref.kind })
      },
      async delete(ref): Promise<void> {
        await requireStore().delete({ runId: args.runId, sessionId: args.sessionId, sequence: ref.sequence, kind: ref.kind })
      }
    }
  }

  return {
    inspect(): HarnessInspection {
      return definition.inspection
    },
    async getSession(sessionId: string): Promise<Session<S>> {
      await ensureSessionRecord(sessionId)
      const state = await getSessionState(sessionId)
      const memory = createSessionMemory(memoryOptions(sessionId, state.sandboxSession, NEVER_ABORT_SIGNAL), { kind: 'session', sessionId })
      const workflowEntries = Object.entries(definition.workflows).map(([workflowId, workflow]) => {
        const invoker = {
          prompt: (input: WorkflowInput<S, keyof NonNullable<S['workflows']>>, opts?: InvokeOptions) => runWorkflowCall(sessionId, workflowId, workflow as WorkflowDefinition<S>, input, opts) as Promise<WorkflowOutput<S, keyof NonNullable<S['workflows']>>>,
          async *stream(input: WorkflowInput<S, keyof NonNullable<S['workflows']>>, opts?: InvokeOptions): AsyncIterable<RunEvent> {
            for await (const event of streamWorkflowCall(sessionId, workflowId, workflow as WorkflowDefinition<S>, input, opts)) {
              yield event
            }
          }
        }
        return [workflowId, invoker]
      })
      const workflows = Object.fromEntries(workflowEntries) as Session<S>['workflows']
      const agentEntries = Object.entries(definition.agents).map(([agentId, agent]) => {
        const invoker = {
          prompt: (input: AgentInput<S, keyof NonNullable<S['agents']>>, opts?: InvokeOptions) => runAgentCall(sessionId, agentId, agent as AgentDefinition<S>, input, opts) as Promise<AgentOutput<S, keyof NonNullable<S['agents']>>>,
          async *stream(input: AgentInput<S, keyof NonNullable<S['agents']>>, opts?: InvokeOptions): AsyncIterable<RunEvent> {
            for await (const event of streamAgentCall(sessionId, agentId, agent as AgentDefinition<S>, input, opts)) {
              yield event
            }
          }
        }
        return [agentId, invoker]
      })
      const agents = Object.fromEntries(agentEntries) as Session<S>['agents']

      return {
        id: sessionId,
        agents,
        workflows,
        memory,
        history: {
          list: (opts) => definition.state.listMessages(sessionId, opts)
        },
        async getRunSummary(runId: string): Promise<RunSummary | undefined> {
          return getRunSummary(runId)
        },
        async clearHistory(): Promise<void> {
          if (state.busy) {
            throw new SessionBusyError('Session is busy.', { session_id: sessionId, reason: 'history_clear_during_run' })
          }
          await definition.state.clearMessages(sessionId)
        },
        async replaceHistory(messages: ReadonlyArray<Omit<Message, 'id' | 'timestamp'>>): Promise<void> {
          if (state.busy) {
            throw new SessionBusyError('Session is busy.', { session_id: sessionId, reason: 'history_replace_during_run' })
          }
          const parsed = messages.map((message) => {
            try {
              return normalizeMessage(message, sessionId)
            } catch (error) {
              throw new ValidationError('Session history replacement failed validation.', { where: 'session_history', issues: { message } }, error)
            }
          })
          if (definition.state.replaceMessages) {
            await definition.state.replaceMessages(sessionId, parsed)
          } else {
            // Non-atomic fallback for adapters without atomic replace.
            await definition.state.clearMessages(sessionId)
            if (parsed.length > 0) {
              await definition.state.appendMessages(sessionId, parsed)
            }
          }
        },
        async close(): Promise<void> {
          if (state.busy) {
            throw new SessionBusyError('Session is busy.', { session_id: sessionId, reason: 'concurrent_run' })
          }
          await definition.state.closeSession(sessionId)
          sessionStates.delete(sessionId)
          sessionStateOpenings.delete(sessionId)
          await mcpRegistry.closeForSandboxKey(sessionId)
          await state.sandboxSession.close()
        }
      }
    },
    async shutdown(): Promise<{ errors: HarnessError[] }> {
      const errors: HarnessError[] = []
      try {
        await mcpRegistry.close()
      } catch (error) {
        errors.push(error instanceof HarnessError ? error : new InternalError('Failed to close MCP registry.', undefined, error))
      }
      for (const [sessionId, state] of sessionStates) {
        try {
          await state.sandboxSession.close()
        } catch (error) {
          errors.push(error instanceof HarnessError ? error : new InternalError('Failed to close sandbox session.', { session_id: sessionId }, error))
        }
      }
      sessionStates.clear()
      try {
        await definition.state.close?.()
      } catch (error) {
        errors.push(error instanceof HarnessError ? error : new InternalError('Failed to close state store.', undefined, error))
      }
      try {
        await definition.memory.close?.()
      } catch (error) {
        errors.push(error instanceof HarnessError ? error : new InternalError('Failed to close memory adapter.', undefined, error))
      }
      return { errors }
    },
    $infer: {} as Harness<S>['$infer']
  }

  async function* streamAgentCall<K extends keyof NonNullable<S['agents']>>(
    sessionId: string,
    agentId: string,
    agent: AgentDefinition<S>,
    input: AgentInput<S, K>,
    opts?: InvokeOptions
  ): AsyncIterable<RunEvent> {
    yield* relayRunEvents((onEvent, relaySignal) => {
      const combined = combineSignals(relaySignal, opts?.signal)
      return runAgentCall(sessionId, agentId, agent, input, { ...opts, signal: combined.signal }, onEvent)
        .finally(() => combined.cleanup())
    })
  }

  async function runAgentCall<K extends keyof NonNullable<S['agents']>>(
    sessionId: string,
    agentId: string,
    agent: AgentDefinition<S>,
    input: AgentInput<S, K>,
    opts?: InvokeOptions,
    onEvent?: (event: RunEvent) => Promise<void>
  ): Promise<AgentOutput<S, K>> {
    validateInvokeOptions(opts)
    if (opts?.durable) {
      throw new ValidationError('Durable execution is only supported for workflow runs.', { where: 'invoke_options', issues: { durable: 'agent_run' } })
    }
    if (opts?.signal?.aborted) {
      throw new OperationCancelledError('Run was cancelled before start.', { scope: 'run' })
    }

    // Busy check precedes createRunSignal so an early SessionBusyError cannot
    // leak the run-timeout timer or the caller-signal abort listener.
    const state = await getSessionState(sessionId)
    if (state.busy) {
      throw new SessionBusyError('Session is busy.', { session_id: sessionId, reason: 'concurrent_run' })
    }
    state.busy = true
    const runSignal = createRunSignal(opts?.signal, opts?.timeoutMs ?? definition.defaults.runTimeoutMs)

    const startedAt = now()
    const runId = ulid()
    const emit = async (event: RunEvent): Promise<void> => {
      const eventAt = 'at' in event ? event.at : now()
      await onEvent?.(event)
      await appendEvents(runId, [{ id: ulid(), runId, at: eventAt, type: event.type, payload: sanitizeEventForPersistence(event) }])
    }

    let runCreated = false
    try {
      const memory = memoryFacade({
        sessionId,
        runId,
        agentId,
        signal: runSignal.signal,
        sandboxSession: state.sandboxSession,
        metadata: opts?.metadata ?? {}
      })
      const checkpoints = createContextCheckpoints({ sessionId, runId, agentId, signal: runSignal.signal })
      const runRecord: RunRecord = {
        id: runId,
        sessionId,
        kind: 'agent',
        target: agentId,
        startedAt,
        status: 'running',
        input: input as JsonValue
      }
      await definition.state.createRun(runRecord)
      runCreated = true

      const result = await withIncomingTraceContext(telemetry, opts, definition.logger, async () => telemetry.span('harness.session.agent_prompt', {
          'harness.name': definition.name,
          'harness.session.id': sessionId,
          'harness.run.id': runId,
          'harness.agent.id': agentId,
          'harness.telemetry.content_capture_mode': contentCaptureMode,
          ...metadataSpanAttrs(opts?.metadata)
        }, async () => {
        await emit({ type: 'run.started', runId, at: startedAt })
        const resolvedHistoryWindow = opts?.historyWindow ?? definition.defaults.historyWindow
        const run = await runDefaultAgent({
          harnessName: definition.name,
          agentId,
          runId,
          sessionId,
          input,
          history: await definition.state.listMessages(sessionId),
          agent,
          models: withRunEventModelRegistry(modelRegistry, {
            harnessName: definition.name,
            sessionId,
            runId,
            agentId
          }, emit),
          skills: resolvedSkills as Record<string, ResolvedSkill>,
          customTools: definition.tools as ToolsConfig,
          ...(definition.governance ? { governance: definition.governance as GovernanceConfig<any> } : {}),
          mcpRegistry,
          session: state.sandboxSession,
          memory,
          checkpoints,
          mountedSkills: state.mountedSkills,
          ...(resolvedHistoryWindow !== undefined ? { historyWindow: resolvedHistoryWindow } : {}),
          maxSteps: definition.defaults.agentMaxIterations ?? 16,
          signal: runSignal.signal,
          toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
          maxParallelToolCalls: definition.defaults.maxParallelToolCalls ?? 8,
          logger: definition.logger,
          telemetry,
          emitEvent: emit,
          metadata: opts?.metadata ?? {}
        })
        if (run.emitted.length > 0) {
          await definition.state.appendMessages(sessionId, run.emitted)
        }
        return run.output
      }))

      const finishedAt = now()
      await emit({ type: 'run.finished', runId, at: finishedAt, output: result as JsonValue })
      await definition.state.finishRun(runId, { status: 'succeeded', finishedAt, output: result as JsonValue })
      const sessionRecord = await ensureSessionRecord(sessionId)
      await definition.state.upsertSession({ ...sessionRecord, updatedAt: finishedAt, runCount: sessionRecord.runCount + 1 })
      return result as AgentOutput<S, K>
    } catch (error) {
      const finalError = normalizeRunError(error, runSignal.signal)
      if (!runCreated) {
        throw finalError
      }
      const finishedAt = now()
      const serialized = serializeError(finalError)
      const log = finalError instanceof OperationCancelledError ? definition.logger.warn.bind(definition.logger) : definition.logger.error.bind(definition.logger)
      log('Harness agent run failed.', {
        harness: definition.name,
        session_id: sessionId,
        run_id: runId,
        agent_id: agentId,
        error: serialized
      })
      const runFinished: RunEvent = { type: 'run.finished', runId, at: finishedAt, error: serialized }
      await terminalizeFailedRun({
        kind: 'agent',
        targetId: agentId,
        sessionId,
        runId,
        primaryError: serialized,
        emitRunFinished: () => emit(runFinished),
        finishRun: () => definition.state.finishRun(runId, {
          status: finalError instanceof OperationCancelledError ? 'cancelled' : 'failed',
          finishedAt,
          error: serialized
        }),
        upsertSession: async () => {
          const sessionRecord = await ensureSessionRecord(sessionId)
          await definition.state.upsertSession({ ...sessionRecord, updatedAt: finishedAt, runCount: sessionRecord.runCount + 1 })
        }
      })
      throw finalError
    } finally {
      runSignal.cleanup()
      state.busy = false
    }
  }

  async function* streamWorkflowCall<K extends keyof NonNullable<S['workflows']>>(
    sessionId: string,
    workflowId: string,
    workflow: WorkflowDefinition<S>,
    input: WorkflowInput<S, K>,
    opts?: InvokeOptions
  ): AsyncIterable<RunEvent> {
    yield* relayRunEvents((onEvent, relaySignal) => {
      const combined = combineSignals(relaySignal, opts?.signal)
      return runWorkflowCall(sessionId, workflowId, workflow, input, { ...opts, signal: combined.signal }, onEvent)
        .finally(() => combined.cleanup())
    })
  }

  async function runWorkflowCall<K extends keyof NonNullable<S['workflows']>>(
    sessionId: string,
    workflowId: string,
    workflow: WorkflowDefinition<S>,
    input: WorkflowInput<S, K>,
    opts?: InvokeOptions,
    onEvent?: (event: RunEvent) => Promise<void>
  ): Promise<WorkflowOutput<S, K>> {
    validateInvokeOptions(opts)
    const durableRuntime = resolveDurableRuntime(opts)
    if (opts?.signal?.aborted) {
      throw new OperationCancelledError('Run was cancelled before start.', { scope: 'run' })
    }

    // Busy check precedes createRunSignal so an early SessionBusyError cannot
    // leak the run-timeout timer or the caller-signal abort listener.
    const state = await getSessionState(sessionId)
    if (state.busy) {
      throw new SessionBusyError('Session is busy.', { session_id: sessionId, reason: 'concurrent_run' })
    }
    state.busy = true
    const runSignal = createRunSignal(opts?.signal, opts?.timeoutMs ?? definition.defaults.runTimeoutMs)

    const startedAt = now()
    const runId = opts?.durable ? opts.durable.runId : ulid()
    const runRecord: RunRecord = {
      id: runId,
      sessionId,
      kind: 'workflow',
      target: workflowId,
      startedAt,
      status: 'running',
      input: input as JsonValue
    }

    const emit = async (event: RunEvent): Promise<void> => {
      const eventAt = 'at' in event ? event.at : now()
      await onEvent?.(event)
      await appendEvents(runId, [{ id: ulid(), runId, at: eventAt, type: event.type, payload: sanitizeEventForPersistence(event) }])
    }

    let durableBinding: DurableWorkflowBinding | undefined
    let runSandboxSession = state.sandboxSession
    let runMountedSkills = state.mountedSkills
    let closeRunSandbox = false
    let runCreated = false
    const delegationState: DelegationRunState = {
      totalChildAgentCalls: 0,
      activeChildAgentCalls: 0,
      inFlightChildCalls: new Set<Promise<unknown>>()
    }
    try {
      if (durableRuntime && opts?.durable) {
        durableBinding = await beginDurableWorkflow({
          runtime: durableRuntime,
          ...(definition.workspaceStore ? { workspaceStore: definition.workspaceStore } : {}),
          durable: opts.durable,
          defaultWorkerId: durableWorkerId,
          sessionId,
          workflowId,
          input: input as JsonValue,
          signal: runSignal.signal,
          logger: definition.logger,
          harnessName: definition.name
        })
        if (definition.workspaceStore) {
          runSandboxSession = await definition.sandbox.open({ sessionId, runId, signal: runSignal.signal }) as SandboxSession
          runMountedSkills = new Set<string>()
          closeRunSandbox = true
        }
      }
      const memory = memoryFacade({
        sessionId,
        runId,
        workflowId,
        signal: runSignal.signal,
        sandboxSession: runSandboxSession,
        metadata: opts?.metadata ?? {}
      })
      const checkpoints = createContextCheckpoints({ sessionId, runId, workflowId, signal: runSignal.signal })
      await definition.state.createRun(runRecord)
      runCreated = true
      const result = await withIncomingTraceContext(telemetry, opts, definition.logger, async () => telemetry.span('harness.session.prompt', {
          'harness.name': definition.name,
          'harness.session.id': sessionId,
          'harness.run.id': runId,
          'harness.workflow.id': workflowId,
          'harness.telemetry.content_capture_mode': contentCaptureMode,
          ...metadataSpanAttrs(opts?.metadata)
        }, async () => {
        const runStarted: RunEvent = { type: 'run.started', runId, at: startedAt }
        await emit(runStarted)
        const workflowMetrics = createMetrics(telemetry, {
          'harness.name': definition.name,
          'harness.session.id': sessionId,
          'harness.run.id': runId,
          'harness.workflow.id': workflowId
        })
        const delegationPolicy = resolveDelegationPolicy(workflow)

        const workflowArgs = {
          workflowId,
          workflow,
          input,
          ctx: {
            log: definition.logger,
            signal: runSignal.signal,
            runId,
            sessionId,
            models: withRunEventModelRegistry(modelRegistry, {
              harnessName: definition.name,
              sessionId,
              runId,
              workflowId
            }, emit),
            metadata: opts?.metadata ?? {},
            metrics: workflowMetrics,
            memory,
            checkpoints,
            step: durableBinding ? durableBinding.step : passthroughStep,
            agents: Object.fromEntries(
              Object.entries(definition.agents).map(([agentId, agent]) => [
                agentId,
                async (agentInput: unknown, agentOpts?: InvokeOptions & { model?: string }) => {
                  // Spec 10 "Cancellation": starting a child-agent call after
                  // abort throws OperationCancelledError synchronously, before
                  // policy checks run or budgets are consumed.
                  if (runSignal.signal.aborted) {
                    throw abortError(runSignal.signal, 'run', 'Run was cancelled.')
                  }
                  if (agentOpts?.signal?.aborted) {
                    throw new OperationCancelledError('Child-agent call was cancelled before start.', { scope: 'run' }, agentOpts.signal.reason)
                  }
                  validateInvokeOptions(agentOpts)
                  if (agentOpts?.durable) {
                    throw new ValidationError('Durable execution is only supported for workflow runs.', { where: 'invoke_options', issues: { durable: 'agent_run' } })
                  }
                  // An unknown per-call model alias is an invoke-option mistake;
                  // it must not pass the delegation gate or consume call budget.
                  if (agentOpts?.model !== undefined && !(agentOpts.model in (definition.models as ModelsConfig))) {
                    throw new ValidationError('Unknown model alias for child-agent call.', { where: 'invoke_options', issues: { model: agentOpts.model } })
                  }
                  const selectedModelAlias = agentOpts?.model ?? (agent as AgentDefinition<S>).model
                  assertDelegationAllowed({
                    policy: delegationPolicy,
                    state: delegationState,
                    workflowId,
                    agentId,
                    modelAlias: selectedModelAlias
                  })
                  // Compose signals before consuming budget so a composition
                  // failure can never leak an active delegation slot.
                  const combinedSignal = combineSignals(runSignal.signal, agentOpts?.signal)
                  const agentSignal = agentOpts?.timeoutMs !== undefined
                    ? createRunSignal(combinedSignal.signal, agentOpts.timeoutMs)
                    : combinedSignal
                  delegationState.totalChildAgentCalls += 1
                  delegationState.activeChildAgentCalls += 1
                  const delegationCallId = `delegate_${ulid()}`
                  const childCall = (async () => {
                    const resolvedHistoryWindow = agentOpts?.historyWindow ?? opts?.historyWindow ?? definition.defaults.historyWindow
                    const agentMetadata = { ...(opts?.metadata ?? {}), ...(agentOpts?.metadata ?? {}) }
                    const agentMemory = memoryFacade({
                      sessionId,
                      runId,
                      workflowId,
                      agentId,
                      signal: agentSignal.signal,
                      sandboxSession: runSandboxSession,
                      metadata: agentMetadata
                    })
                    const agentCheckpoints = createContextCheckpoints({ sessionId, runId, workflowId, agentId, signal: agentSignal.signal })
                    const run = await runDefaultAgent({
                      harnessName: definition.name,
                      agentId,
                      runId,
                      sessionId,
                      workflowId,
                      delegationCallId,
                      delegationDepth: CHILD_DELEGATION_DEPTH,
                      input: agentInput,
                      history: await definition.state.listMessages(sessionId),
                      agent: agent as AgentDefinition<S>,
                      modelAlias: selectedModelAlias,
                      models: withRunEventModelRegistry(modelRegistry, {
                        harnessName: definition.name,
                        sessionId,
                        runId,
                        workflowId,
                        agentId,
                        modelAlias: selectedModelAlias
                      }, emit),
                      skills: resolvedSkills as Record<string, ResolvedSkill>,
                      customTools: definition.tools as ToolsConfig,
                      ...(definition.governance ? { governance: definition.governance as GovernanceConfig<any> } : {}),
                      mcpRegistry,
                      session: runSandboxSession,
                      memory: agentMemory,
                      checkpoints: agentCheckpoints,
                      mountedSkills: runMountedSkills,
                      ...(resolvedHistoryWindow !== undefined ? { historyWindow: resolvedHistoryWindow } : {}),
                      maxSteps: definition.defaults.agentMaxIterations ?? 16,
                      signal: agentSignal.signal,
                      toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
                      maxParallelToolCalls: definition.defaults.maxParallelToolCalls ?? 8,
                      logger: definition.logger,
                      telemetry,
                      emitEvent: emit,
                      metadata: agentMetadata
                    })
                    if (run.emitted.length > 0) {
                      await definition.state.appendMessages(sessionId, run.emitted)
                    }
                    return run.output
                  })()
                  delegationState.inFlightChildCalls.add(childCall)
                  try {
                    return await childCall
                  } finally {
                    delegationState.inFlightChildCalls.delete(childCall)
                    delegationState.activeChildAgentCalls -= 1
                    agentSignal.cleanup()
                    if (agentSignal !== combinedSignal) combinedSignal.cleanup()
                  }
                }
              ])
            ) as unknown as WorkflowDefinition<S>['handler'] extends (ctx: infer C) => Promise<unknown>
              ? C extends { agents: infer A }
                ? A
                : never
              : never
          }
        } as unknown as Parameters<typeof runWorkflow<S>>[0]

        return telemetry.span('harness.workflow.run', {
          'harness.name': definition.name,
          'harness.session.id': sessionId,
          'harness.run.id': runId,
          'harness.workflow.id': workflowId,
          ...metadataSpanAttrs(opts?.metadata)
        }, async () => runWorkflow<S>({
            ...workflowArgs,
            ...(opts ? { opts: { ...opts, signal: runSignal.signal } } : { opts: { signal: runSignal.signal } })
          } as Parameters<typeof runWorkflow<S>>[0]))
      }))

      // A resolved handler may still have child-agent calls in flight; settle
      // them before terminalizing so no run events trail run.finished.
      if (delegationState.inFlightChildCalls.size > 0) {
        await Promise.allSettled([...delegationState.inFlightChildCalls])
      }
      const finishedAt = now()
      if (durableBinding) {
        await guardDurableStep({ sessionId, runId, workflowId, operation: 'finish_success' }, () => durableBinding!.finishSuccess(result as JsonValue))
      }
      const runFinished: RunEvent = { type: 'run.finished', runId, at: finishedAt, output: result as JsonValue }
      await emit(runFinished)
      await definition.state.finishRun(runId, { status: 'succeeded', finishedAt, output: result as JsonValue })
      const sessionRecord = await ensureSessionRecord(sessionId)
      await definition.state.upsertSession({ ...sessionRecord, updatedAt: finishedAt, runCount: sessionRecord.runCount + 1 })
      return result as WorkflowOutput<S, K>
    } catch (error) {
      const finalError = normalizeRunError(error, runSignal.signal)
      // A handler rejection mid-Promise.all must not orphan in-flight child
      // agents: cancel them through the run signal and await settlement before
      // run.finished is emitted and the session busy lock is released.
      if (delegationState.inFlightChildCalls.size > 0) {
        runSignal.abort(finalError)
        await Promise.allSettled([...delegationState.inFlightChildCalls])
      }
      const finishedAt = now()
      const serialized = serializeError(finalError)
      if (!runCreated) {
        throw finalError
      }
      if (durableBinding && finalError instanceof OperationCancelledError) {
        await guardDurableStep({ sessionId, runId, workflowId, operation: 'finish_cancelled' }, () => durableBinding!.finishCancelled(finalError))
      }
      const log = finalError instanceof OperationCancelledError ? definition.logger.warn.bind(definition.logger) : definition.logger.error.bind(definition.logger)
      log('Harness workflow run failed.', {
        harness: definition.name,
        session_id: sessionId,
        run_id: runId,
        workflow_id: workflowId,
        error: serialized
      })
      const runFinished: RunEvent = { type: 'run.finished', runId, at: finishedAt, error: serialized }
      await terminalizeFailedRun({
        kind: 'workflow',
        targetId: workflowId,
        sessionId,
        runId,
        primaryError: serialized,
        emitRunFinished: () => emit(runFinished),
        finishRun: () => definition.state.finishRun(runId, {
          status: finalError instanceof OperationCancelledError ? 'cancelled' : 'failed',
          finishedAt,
          error: serialized
        }),
        upsertSession: async () => {
          const sessionRecord = await ensureSessionRecord(sessionId)
          await definition.state.upsertSession({ ...sessionRecord, updatedAt: finishedAt, runCount: sessionRecord.runCount + 1 })
        }
      })
      throw finalError
    } finally {
      // Releases the lease for a non-cancel failure so a retry with the same run
      // id can resume; a no-op once the run was settled (success/cancel).
      if (durableBinding) await durableBinding.dispose()
      if (closeRunSandbox) {
        try {
          await runSandboxSession.close()
        } catch (error) {
          definition.logger.warn('Failed to close durable run sandbox.', {
            harness: definition.name,
            session_id: sessionId,
            run_id: runId,
            workflow_id: workflowId,
            error: serializeError(error)
          })
        }
      }
      runSignal.cleanup()
      state.busy = false
    }
  }

  /** Pass-through step used when a workflow runs without durable execution. */
  function passthroughStep<T extends JsonValue>(_stepId: string, fn: () => Promise<T>, options: DurableStepOptions = {}): Promise<T> {
    return runStepWithRetry(fn, options.retry)
  }

  function resolveDelegationPolicy(workflow: WorkflowDefinition<S>): EffectiveDelegationPolicy {
    const configured = workflow.delegation as WorkflowDelegationPolicy<S> | undefined
    const policy = configured ?? {}
    const enabled = configured ? policy.enabled !== false : definition.defaults.delegation?.enabled === true
    return {
      enabled,
      ...(policy.agents ? { allowedAgents: new Set(policy.agents as readonly string[]) } : {}),
      maxChildAgentCalls: policy.maxChildAgentCalls ?? definition.defaults.delegation?.maxChildAgentCalls ?? DEFAULT_MAX_CHILD_AGENT_CALLS,
      maxParallelChildAgentCalls: policy.maxParallelChildAgentCalls ?? definition.defaults.delegation?.maxParallelChildAgentCalls ?? DEFAULT_MAX_PARALLEL_CHILD_AGENT_CALLS,
      maxDepth: policy.maxDepth ?? definition.defaults.delegation?.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH,
      ...(policy.modelAliases ? { modelAliases: new Set(policy.modelAliases as readonly string[]) } : {}),
      agentModelAliases: new Map(
        Object.entries(policy.agentModelAliases ?? {}).map(([agentId, aliases]) => [agentId, new Set(aliases as readonly string[])])
      )
    }
  }

  function assertDelegationAllowed(args: {
    policy: EffectiveDelegationPolicy
    state: DelegationRunState
    workflowId: string
    agentId: string
    modelAlias: string
  }): void {
    const { policy, state, workflowId, agentId, modelAlias } = args
    if (!policy.enabled) {
      throw new DelegationPolicyError('Workflow child-agent delegation is disabled.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'delegation_disabled'
      })
    }
    if (policy.allowedAgents && !policy.allowedAgents.has(agentId)) {
      throw new DelegationPolicyError('Workflow is not allowed to invoke this child agent.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'agent_not_allowed'
      })
    }
    if (CHILD_DELEGATION_DEPTH > policy.maxDepth) {
      throw new DelegationPolicyError('Workflow child-agent delegation depth exceeded.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'max_delegation_depth_exceeded',
        limit: policy.maxDepth
      })
    }
    if (state.totalChildAgentCalls >= policy.maxChildAgentCalls) {
      throw new DelegationPolicyError('Workflow child-agent call budget exceeded.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'max_child_agent_calls_exceeded',
        limit: policy.maxChildAgentCalls
      })
    }
    if (state.activeChildAgentCalls >= policy.maxParallelChildAgentCalls) {
      throw new DelegationPolicyError('Workflow parallel child-agent call budget exceeded.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'max_parallel_child_agent_calls_exceeded',
        limit: policy.maxParallelChildAgentCalls
      })
    }
    const allowedModels = policy.agentModelAliases.get(agentId) ?? policy.modelAliases
    if (allowedModels && !allowedModels.has(modelAlias)) {
      throw new DelegationPolicyError('Workflow is not allowed to invoke this child agent with the selected model alias.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'model_alias_not_allowed',
        model_alias: modelAlias
      })
    }
  }

  /**
   * Runs a durable finalization side effect (runtime finish / workspace lifecycle)
   * without ever masking the primary run outcome (spec 21 §16.1 step 7).
   */
  async function guardDurableStep(
    args: { sessionId: string; runId: string; workflowId: string; operation: string },
    step: () => Promise<void>
  ): Promise<void> {
    try {
      await step()
    } catch (error) {
      telemetry.recordCounter('harness.runs.durable_errors', 1, {
        harness: definition.name,
        'harness.run.durable.operation': args.operation
      })
      definition.logger.error('Durable finalization step failed; preserving run outcome.', {
        harness: definition.name,
        session_id: args.sessionId,
        run_id: args.runId,
        workflow_id: args.workflowId,
        operation: args.operation,
        error: serializeError(error)
      })
    }
  }

  async function terminalizeFailedRun(args: {
    kind: 'agent' | 'workflow'
    targetId: string
    sessionId: string
    runId: string
    primaryError: ReturnType<typeof serializeError>
    emitRunFinished: () => Promise<void>
    finishRun: () => Promise<void>
    upsertSession: () => Promise<void>
  }): Promise<void> {
    await runFailureTerminalizationStep(args, 'emit_run_finished', args.emitRunFinished)
    await runFailureTerminalizationStep(args, 'finish_run', args.finishRun)
    await runFailureTerminalizationStep(args, 'upsert_session', args.upsertSession)
  }

  async function runFailureTerminalizationStep(
    args: {
      kind: 'agent' | 'workflow'
      targetId: string
      sessionId: string
      runId: string
      primaryError: ReturnType<typeof serializeError>
    },
    operation: 'emit_run_finished' | 'finish_run' | 'upsert_session',
    step: () => Promise<void>
  ): Promise<void> {
    try {
      await step()
    } catch (error) {
      telemetry.recordCounter('harness.runs.terminalization_errors', 1, {
        harness: definition.name,
        'harness.run.kind': args.kind,
        'harness.run.terminalization.operation': operation
      })
      definition.logger.error('Failed to terminalize failed run; preserving primary run error.', {
        harness: definition.name,
        session_id: args.sessionId,
        run_id: args.runId,
        [`${args.kind}_id`]: args.targetId,
        operation,
        primary_error: args.primaryError,
        error: serializeError(error)
      })
    }
  }
}

function withRunEventModelRegistry<M extends Record<string, unknown>>(
  models: M,
  context: ModelRunContext,
  emitEvent: (event: RunEvent) => Promise<void>
): M {
  return Object.fromEntries(
    Object.entries(models).map(([alias, handle]) => [alias, withRunEventModelHandle(alias, handle, context, emitEvent)])
  ) as M
}

function withRunEventModelHandle(
  alias: string,
  handle: unknown,
  context: ModelRunContext,
  emitEvent: (event: RunEvent) => Promise<void>
): unknown {
  if (!handle || typeof handle !== 'object') return handle
  const source = handle as Record<string, unknown>
  const wrapped: Record<string, unknown> = { ...source }

  for (const method of ['text', 'object', 'embed', 'rerank'] as const) {
    const fn = source[method]
    if (typeof fn !== 'function') continue
    wrapped[method] = (req: unknown, signal: AbortSignal, ctx?: Partial<ModelRunContext>) =>
      fn.call(source, req, signal, mergeModelRunContext(context, ctx))
  }

  const textStream = source['textStream']
  if (typeof textStream === 'function') {
    wrapped['textStream'] = (req: unknown, signal: AbortSignal, ctx?: Partial<ModelRunContext>) => {
      const streamContext = modelStreamRunContext(context, ctx, alias)
      return emitTextStreamRunEvents(
        textStream.call(source, req, signal, streamContext) as AsyncIterable<unknown>,
        streamContext,
        emitEvent
      )
    }
  }

  const objectStream = source['objectStream']
  if (typeof objectStream === 'function') {
    wrapped['objectStream'] = (req: unknown, signal: AbortSignal, ctx?: Partial<ModelRunContext>) => {
      const streamContext = modelStreamRunContext(context, ctx, alias)
      return emitObjectStreamRunEvents(
        objectStream.call(source, req, signal, streamContext) as AsyncIterable<unknown>,
        streamContext,
        emitEvent
      )
    }
  }

  return wrapped
}

function mergeModelRunContext(context: ModelRunContext, override: Partial<ModelRunContext> | undefined): ModelRunContext {
  return { ...context, ...(override ?? {}) }
}

function modelStreamRunContext(context: ModelRunContext, override: Partial<ModelRunContext> | undefined, alias: string): ModelRunContext {
  const merged = mergeModelRunContext(context, override)
  return {
    ...merged,
    modelAlias: alias,
    ...(merged.emitRunEvents === true ? { streamId: `model_${ulid()}` } : {})
  }
}

async function* emitTextStreamRunEvents(
  stream: AsyncIterable<unknown>,
  context: ModelRunContext,
  emitEvent: (event: RunEvent) => Promise<void>
): AsyncIterable<unknown> {
  for await (const chunk of stream) {
    if (context.emitRunEvents === true && isTextDeltaChunk(chunk)) {
      await emitEvent({
        type: 'model.delta',
        runId: context.runId,
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        ...(context.modelAlias ? { modelAlias: context.modelAlias } : {}),
        streamId: context.streamId!,
        delta: chunk.text
      })
    }
    yield chunk
  }
}

async function* emitObjectStreamRunEvents(
  stream: AsyncIterable<unknown>,
  context: ModelRunContext,
  emitEvent: (event: RunEvent) => Promise<void>
): AsyncIterable<unknown> {
  for await (const chunk of stream) {
    if (context.emitRunEvents === true && isObjectPartialChunk(chunk)) {
      await emitEvent({
        type: 'model.object.partial',
        runId: context.runId,
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        ...(context.modelAlias ? { modelAlias: context.modelAlias } : {}),
        streamId: context.streamId!,
        partial: chunk.partial
      })
    } else if (context.emitRunEvents === true && isObjectFinishChunk(chunk)) {
      await emitEvent({
        type: 'model.object',
        runId: context.runId,
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        ...(context.modelAlias ? { modelAlias: context.modelAlias } : {}),
        ...(context.streamId ? { streamId: context.streamId } : {}),
        object: chunk.object,
        ...(chunk.usage ? { usage: chunk.usage } : {})
      })
    }
    yield chunk
  }
}

function isTextDeltaChunk(chunk: unknown): chunk is { kind: 'delta'; text: string } {
  return Boolean(chunk && typeof chunk === 'object' && (chunk as { kind?: unknown }).kind === 'delta' && typeof (chunk as { text?: unknown }).text === 'string')
}

function isObjectPartialChunk(chunk: unknown): chunk is { kind: 'partial'; partial: JsonValue } {
  return Boolean(chunk && typeof chunk === 'object' && (chunk as { kind?: unknown }).kind === 'partial')
}

function isObjectFinishChunk(chunk: unknown): chunk is { kind: 'finish'; object: JsonValue; usage?: TokenUsage } {
  return Boolean(chunk && typeof chunk === 'object' && (chunk as { kind?: unknown }).kind === 'finish' && Object.prototype.hasOwnProperty.call(chunk, 'object'))
}

function configureHarnessAdapters(
  context: HarnessAdapterContext,
  models: ModelsConfig,
  state: StateStore,
  sandbox: Sandbox,
  memory: MemoryAdapter,
  tools: ToolsConfig,
  runtime: DurableRuntimeAdapter | undefined,
  workspaceStore: DurableWorkspaceStore | undefined,
  checkpoints: ContextCheckpointStore | undefined
): void {
  const seen = new Set<unknown>()
  for (const alias of Object.values(models)) {
    configureOne(alias.provider, context, seen)
  }
  configureOne(state, context, seen)
  configureOne(sandbox, context, seen)
  configureOne(memory, context, seen)
  configureOne(runtime, context, seen)
  configureOne(workspaceStore, context, seen)
  configureOne(checkpoints, context, seen)
  for (const tool of Object.values(tools)) {
    configureOne(tool, context, seen)
  }
}

function configureOne(adapter: unknown, context: HarnessAdapterContext, seen: Set<unknown>): void {
  if (!adapter) return
  const configurable = adapter as Partial<HarnessContextConfigurable>
  if (!configurable.configureHarnessContext || seen.has(adapter)) return
  configurable.configureHarnessContext(context)
  seen.add(adapter)
}

function withTelemetryFlavor(telemetry: TelemetryShim, options: TelemetryOptions | undefined): TelemetryShim {
  const flavor = options?.flavor ?? process.env['PURISTA_TELEMETRY_FLAVOR'] ?? 'dual'
  if (flavor === 'dual') return telemetry
  const filtered: TelemetryShim = {
    span: (name, attrs, fn) => telemetry.span(name, filterTelemetryAttrs(attrs, flavor), (span) => fn(filterSpanAttrs(span, flavor))),
    recordHistogram: (name, value, attrs) => telemetry.recordHistogram(name, value, filterTelemetryAttrs(attrs, flavor)),
    recordCounter: (name, value, attrs) => telemetry.recordCounter(name, value, filterTelemetryAttrs(attrs, flavor)),
    currentTraceparent: () => telemetry.currentTraceparent()
  }
  if (telemetry.withTraceContext) {
    filtered.withTraceContext = (carrier, fn) => telemetry.withTraceContext?.(carrier, fn) ?? fn()
  }
  return filtered
}

async function withIncomingTraceContext<T>(
  telemetry: TelemetryShim,
  opts: InvokeOptions | undefined,
  logger: Logger,
  fn: () => Promise<T>
): Promise<T> {
  if (!opts?.traceparent) return fn()
  if (!isValidTraceparent(opts.traceparent) || (opts.tracestate !== undefined && !isValidTracestate(opts.tracestate))) {
    logger.warn('Invalid Trace Context ignored.', {
      'harness.warning.code': 'INVALID_TRACE_CONTEXT',
      traceparent: opts.traceparent,
      tracestate: opts.tracestate
    })
    return fn()
  }
  return telemetry.withTraceContext?.({ traceparent: opts.traceparent, ...(opts.tracestate ? { tracestate: opts.tracestate } : {}) }, fn) ?? fn()
}

function resolveContentCaptureMode(options: TelemetryOptions | undefined): ContentCaptureMode {
  if (options?.contentCaptureMode !== undefined) return options.contentCaptureMode
  const envValue = process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']
  if (envValue === 'true') return 'SPAN_AND_EVENT'
  if (envValue === 'false') return 'NO_CONTENT'
  if (envValue === 'NO_CONTENT' || envValue === 'SPAN_ONLY' || envValue === 'EVENT_ONLY' || envValue === 'SPAN_AND_EVENT') return envValue
  return 'NO_CONTENT'
}

function isValidTraceparent(traceparent: string): boolean {
  const match = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(traceparent)
  if (!match) return false
  const [, version, traceId, parentId] = match
  return version !== 'ff' && traceId !== '00000000000000000000000000000000' && parentId !== '0000000000000000'
}

function isValidTracestate(tracestate: string): boolean {
  return tracestate.length <= 512 && !/[\r\n]/.test(tracestate)
}

function filterSpanAttrs(span: Parameters<TelemetryShim['span']>[2] extends (span: infer S) => Promise<unknown> ? S : never, flavor: string): typeof span {
  const target = span as {
    setAttribute?: (key: string, value: unknown) => unknown
    setAttributes?: (attrs: Record<string, unknown>) => unknown
  }
  return new Proxy(span as object, {
    get(value, property, receiver) {
      if (property === 'setAttribute' && target.setAttribute) {
        return (key: string, attrValue: unknown) => {
          const filtered = filterTelemetryAttrs({ [key]: attrValue }, flavor)
          if (Object.keys(filtered).length === 0) return span
          target.setAttribute?.(key, attrValue)
          return span
        }
      }
      if (property === 'setAttributes' && target.setAttributes) {
        return (attrs: Record<string, unknown>) => {
          target.setAttributes?.(filterTelemetryAttrs(attrs, flavor))
          return span
        }
      }
      return Reflect.get(value, property, receiver)
    }
  }) as typeof span
}

function filterTelemetryAttrs<T extends Record<string, unknown>>(attrs: T, flavor: string): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue
    if (flavor === 'gen_ai_only' && isOpenInferenceAttr(key)) continue
    if (flavor === 'openinference_only' && key.startsWith('gen_ai.')) continue
    out[key] = value
  }
  return out as T
}

function isOpenInferenceAttr(key: string): boolean {
  return key === 'openinference.span.kind'
    || key.startsWith('llm.')
    || key.startsWith('tool.')
    || key.startsWith('retrieval.')
    || key.startsWith('embedding.')
    || key.startsWith('reranker.')
    || key.startsWith('guardrail.')
    || key.startsWith('evaluator.')
    || key === 'input.value'
    || key === 'output.value'
}

function normalizeRunError(error: unknown, signal: AbortSignal): unknown {
  if (!signal.aborted) return error
  if (signal.reason instanceof OperationTimeoutError) return signal.reason
  if (error instanceof OperationCancelledError || error instanceof OperationTimeoutError) return error
  return new OperationCancelledError('Run was cancelled.', { scope: 'run' }, signal.reason ?? error)
}

function sanitizeEventForPersistence(event: RunEvent): JsonValue {
  switch (event.type) {
    case 'run.started':
      return {}
    case 'run.finished':
      return {
        ...(event.output !== undefined ? { output: '[redacted]' } : {}),
        ...(event.error ? { error: event.error } : {})
      } as unknown as JsonValue
    case 'agent.started':
      return agentRunEventMeta(event)
    case 'agent.finished':
      return {
        ...agentRunEventMeta(event),
        ...(event.output !== undefined ? { output: '[redacted]' } : {}),
        ...(event.error ? { error: event.error } : {})
      } as unknown as JsonValue
    case 'tool.started':
      return { agentId: event.agentId, toolId: event.toolId, callId: event.callId, input: '[redacted]' }
    case 'tool.finished':
      return {
        agentId: event.agentId,
        toolId: event.toolId,
        callId: event.callId,
        ...(event.output !== undefined ? { output: '[redacted]' } : {}),
        ...(event.error ? { error: event.error } : {})
      } as unknown as JsonValue
    case 'model.message':
      return { agentId: event.agentId, message: '[redacted]' }
    case 'model.delta':
      return { ...modelStreamEventMeta(event), delta: '[redacted]' }
    case 'policy.evaluated':
      return {
        agentId: event.agentId,
        toolId: event.toolId,
        callId: event.callId,
        decisionId: event.decisionId,
        policyId: event.policyId,
        ...(event.policyVersion ? { policyVersion: event.policyVersion } : {}),
        ...(event.ruleId ? { ruleId: event.ruleId } : {}),
        effect: event.effect,
        enforced: event.enforced,
        ...(event.message ? { message: event.message } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.riskLevel ? { riskLevel: event.riskLevel } : {}),
        ...(event.tags ? { tags: event.tags } : {})
      } as unknown as JsonValue
    case 'policy.exposure':
      return {
        agentId: event.agentId,
        toolId: event.toolId,
        decisionId: event.decisionId,
        policyId: event.policyId,
        ...(event.policyVersion ? { policyVersion: event.policyVersion } : {}),
        ...(event.ruleId ? { ruleId: event.ruleId } : {}),
        effect: event.effect,
        enforced: event.enforced,
        step: event.step,
        ...(event.message ? { message: event.message } : {}),
        ...(event.reason ? { reason: event.reason } : {}),
        ...(event.riskLevel ? { riskLevel: event.riskLevel } : {}),
        ...(event.tags ? { tags: event.tags } : {})
      } as unknown as JsonValue
    case 'approval.requested':
      return {
        agentId: event.agentId,
        toolId: event.toolId,
        callId: event.callId,
        approvalId: event.approvalId,
        decisionId: event.decisionId,
        policyId: event.policyId,
        ...(event.policyVersion ? { policyVersion: event.policyVersion } : {}),
        ...(event.ruleId ? { ruleId: event.ruleId } : {})
      } as unknown as JsonValue
    case 'approval.finished':
      return {
        agentId: event.agentId,
        toolId: event.toolId,
        callId: event.callId,
        approvalId: event.approvalId,
        decisionId: event.decisionId,
        policyId: event.policyId,
        ...(event.policyVersion ? { policyVersion: event.policyVersion } : {}),
        ...(event.ruleId ? { ruleId: event.ruleId } : {}),
        decision: event.decision,
        ...(event.approverId ? { approverId: event.approverId } : {}),
        ...(event.reason ? { reason: event.reason } : {})
      } as unknown as JsonValue
    case 'model.object.partial':
      return { ...modelStreamEventMeta(event), partial: '[redacted]' }
    case 'model.object':
      return {
        ...modelStreamEventMeta(event),
        object: '[redacted]',
        ...(event.usage ? { usage: event.usage } : {})
      } as unknown as JsonValue
    case 'model.embedding.completed':
      return {
        ...(event.agentId ? { agentId: event.agentId } : {}),
        count: event.count,
        ...(event.dimensions !== undefined ? { dimensions: event.dimensions } : {}),
        ...(event.usage ? { usage: event.usage } : {})
      } as unknown as JsonValue
    case 'model.rerank.completed':
      return {
        ...(event.agentId ? { agentId: event.agentId } : {}),
        count: event.count,
        ...(event.topN !== undefined ? { topN: event.topN } : {}),
        ...(event.usage ? { usage: event.usage } : {})
      } as unknown as JsonValue
    case 'stream.overflow':
      return { dropped: event.dropped }
    default: {
      // Exhaustiveness guard: adding a RunEvent variant without updating this
      // sanitizer becomes a compile error instead of silently persisting undefined.
      event satisfies never
      return {}
    }
  }
}

function modelStreamEventMeta(event: Extract<RunEvent, { type: 'model.delta' | 'model.object.partial' | 'model.object' }>): Record<string, string> {
  return {
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.workflowId ? { workflowId: event.workflowId } : {}),
    ...(event.modelAlias ? { modelAlias: event.modelAlias } : {}),
    ...(event.streamId ? { streamId: event.streamId } : {})
  }
}

function agentRunEventMeta(event: Extract<RunEvent, { type: 'agent.started' | 'agent.finished' }>): Record<string, JsonValue> {
  return {
    agentId: event.agentId,
    ...(event.workflowId ? { workflowId: event.workflowId } : {}),
    ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
    ...(event.delegationCallId ? { delegationCallId: event.delegationCallId } : {}),
    ...(event.delegationDepth !== undefined ? { delegationDepth: event.delegationDepth } : {}),
    ...(event.modelAlias ? { modelAlias: event.modelAlias } : {})
  }
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTokenUsage(value: unknown): value is TokenUsage {
  return isJsonRecord(value)
    && typeof value['inputTokens'] === 'number'
    && typeof value['outputTokens'] === 'number'
    && typeof value['totalTokens'] === 'number'
}

function addOptionalTokenCounts(total: TokenUsage, usage: TokenUsage): void {
  if (typeof usage.cachedInputTokens === 'number' && Number.isFinite(usage.cachedInputTokens)) {
    total.cachedInputTokens = (total.cachedInputTokens ?? 0) + usage.cachedInputTokens
  }
  if (typeof usage.cacheCreationInputTokens === 'number' && Number.isFinite(usage.cacheCreationInputTokens)) {
    total.cacheCreationInputTokens = (total.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens
  }
  if (typeof usage.reasoningTokens === 'number' && Number.isFinite(usage.reasoningTokens)) {
    total.reasoningTokens = (total.reasoningTokens ?? 0) + usage.reasoningTokens
  }
}

function normalizeSerializedRunError(error: RunRecord['error']): NonNullable<RunSummary['error']> {
  return {
    code: error?.code ?? 'UNKNOWN',
    category: error?.category ?? 'internal',
    retriable: error?.retriable ?? false,
    message: error?.message ?? 'Unknown error',
    ...(error?.meta ? { meta: error.meta } : {})
  }
}

function createRunSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; cleanup: () => void; abort: (reason: unknown) => void } {
  const controller = new AbortController()
  const relay = () => controller.abort(runAbortReason(parent?.reason))
  if (parent) parent.addEventListener('abort', relay, { once: true })
  if (parent?.aborted) relay()
  const timeout = timeoutMs && timeoutMs > 0
    ? setTimeout(() => controller.abort(new OperationTimeoutError('Run timed out.', { scope: 'run', timeout_ms: timeoutMs })), timeoutMs)
    : undefined
  return {
    signal: controller.signal,
    /** Harness-initiated abort, e.g. to cancel in-flight child-agent calls. */
    abort: (reason: unknown) => controller.abort(runAbortReason(reason)),
    cleanup: () => {
      if (timeout) clearTimeout(timeout)
      if (parent) parent.removeEventListener('abort', relay)
    }
  }
}

function combineSignals(primary: AbortSignal, secondary: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void } {
  if (!secondary) return { signal: primary, cleanup: () => undefined }
  const controller = new AbortController()
  const relayPrimary = () => controller.abort(runAbortReason(primary.reason))
  const relaySecondary = () => controller.abort(runAbortReason(secondary.reason))
  primary.addEventListener('abort', relayPrimary, { once: true })
  secondary.addEventListener('abort', relaySecondary, { once: true })
  if (primary.aborted) relayPrimary()
  else if (secondary.aborted) relaySecondary()
  return {
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener('abort', relayPrimary)
      secondary.removeEventListener('abort', relaySecondary)
    }
  }
}

function runAbortReason(reason: unknown): unknown {
  if (reason instanceof OperationCancelledError || reason instanceof OperationTimeoutError) return reason
  return new OperationCancelledError('Run was cancelled.', { scope: 'run' }, reason)
}
