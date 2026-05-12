import { z } from 'zod'
import type { Logger } from '../logger/index.js'
import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import type { JsonValue } from '../models/json.js'
import {
  InternalError,
  OperationCancelledError,
  OperationTimeoutError,
  HarnessError,
  SessionBusyError,
  StateError,
  ValidationError,
  WorkflowNotFoundError,
  serializeError
} from '../errors/index.js'
import { ulid } from '../ulid/index.js'
import { runDefaultAgent } from '../agents/index.js'
import { runWorkflow } from '../workflows/index.js'
import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  BuiltinToolName,
  InvokeOptions,
  ModelsConfig,
  ResolvedSkill,
  RunSummary,
  RunEvent,
  Harness,
  HarnessDefaults,
  Session,
  SessionMemory,
  SkillDefinition,
  ToolsConfig,
  WorkflowDefinition,
  WorkflowInput,
  WorkflowOutput,
  BuilderState,
  TelemetryOptions
} from '../harness/defineHarness.js'
import type { HarnessInspection } from '../ports/capabilities.js'
import type { Sandbox, SandboxSession } from '../sandbox/index.js'
import type { StateStore } from '../ports/state.js'
import type { HarnessAdapterContext, HarnessContextConfigurable } from '../ports/harness-context.js'
import { loadSkillsSync } from '../skills/index.js'
import { createModelRegistry } from '../models/registry.js'
import { createTelemetryShim, type TelemetryShim } from '../telemetry/index.js'
import { createMcpRunnerRegistry } from '../tools/mcp/runner.js'

type HarnessDefinition<S extends BuilderState> = {
  name: string
  logger: Logger
  telemetry?: TelemetryOptions
  telemetryShim?: TelemetryShim
  state: StateStore
  sandbox: Sandbox
  defaults: HarnessDefaults
  models: NonNullable<S['models']>
  tools: NonNullable<S['tools']>
  skills: NonNullable<S['skills']>
  agents: NonNullable<S['agents']>
  workflows: NonNullable<S['workflows']>
  inspection: HarnessInspection
}

type SessionState = {
  busy: boolean
  sandboxSession: SandboxSession
  mountedSkills: Set<string>
}

const MEMORY_KEY_PATTERN = /^[A-Za-z0-9_.\-:]{1,256}$/

function now(): string {
  return new Date().toISOString()
}

function makeMemory(sessionId: string, sandboxSession: SandboxSession): SessionMemory {
  return {
    async read<T = JsonValue>(key: string): Promise<T | undefined> {
      validateMemoryKey(key)
      const path = `/memory/${key}.json`
      if (!(await sandboxSession.exists(path))) {
        return undefined
      }
      return JSON.parse(await sandboxSession.readText(path)) as T
    },
    async write(key: string, value: JsonValue): Promise<void> {
      validateMemoryKey(key)
      let encoded: string
      try {
        encoded = JSON.stringify(value)
      } catch (error) {
        throw new ValidationError('Memory value must be JSON-serializable.', { where: 'memory_value', issues: { key } }, error)
      }
      await sandboxSession.write(`/memory/${key}.json`, encoded)
    },
    async delete(key: string): Promise<void> {
      validateMemoryKey(key)
      await sandboxSession.remove(`/memory/${key}.json`).catch(() => undefined)
    },
    async list(): Promise<string[]> {
      const entries = await sandboxSession.list('/memory').catch(() => [])
      return entries
        .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.json'))
        .map((entry) => entry.name.slice(0, -5))
        .sort()
    }
  }
}

function validateMemoryKey(key: string): void {
  if (!MEMORY_KEY_PATTERN.test(key)) {
    throw new ValidationError('Invalid session memory key.', { where: 'memory_key', issues: { key } })
  }
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
  const telemetry = withTelemetryFlavor(definition.telemetryShim ?? createTelemetryShim(), definition.telemetry)
  const adapterContext: HarnessAdapterContext = {
    harnessName: definition.name,
    logger: definition.logger,
    telemetry,
    defaults: {
      agentMaxIterations: definition.defaults.agentMaxIterations ?? 16,
      runTimeoutMs: definition.defaults.runTimeoutMs ?? 600_000,
      toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
      skillTimeoutMs: definition.defaults.skillTimeoutMs ?? 60_000,
      modelTimeoutMs: definition.defaults.modelTimeoutMs ?? 300_000,
      ...(definition.defaults.historyWindow !== undefined ? { historyWindow: definition.defaults.historyWindow } : {})
    }
  }
  configureHarnessAdapters(adapterContext, definition.models as ModelsConfig, definition.state, definition.sandbox, definition.tools as ToolsConfig)
  const modelRegistry = createModelRegistry(definition.models, { telemetry, harnessName: definition.name })
  const mcpRegistry = createMcpRunnerRegistry()

  async function ensureSessionRecord(sessionId: string): Promise<SessionRecord> {
    const existing = await definition.state.getSession(sessionId)
    if (existing) {
      return existing
    }

    const created: SessionRecord = {
      id: sessionId,
      createdAt: now(),
      updatedAt: now(),
      runCount: 0
    }
    await definition.state.upsertSession(created)
    return created
  }

  async function getSessionState(sessionId: string): Promise<SessionState> {
    const existing = sessionStates.get(sessionId)
    if (existing) {
      return existing
    }

    const sandboxSession = await definition.sandbox.open({ sessionId, runId: `init_${ulid()}` })
    const created: SessionState = { busy: false, sandboxSession, mountedSkills: new Set<string>() }
    sessionStates.set(sessionId, created)
    return created
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
    const tokenTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
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

  return {
    inspect(): HarnessInspection {
      return definition.inspection
    },
    async getSession(sessionId: string): Promise<Session<S>> {
      await ensureSessionRecord(sessionId)
      const state = await getSessionState(sessionId)
      const memory = makeMemory(sessionId, state.sandboxSession)
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
          await definition.state.clearMessages(sessionId)
          if (parsed.length > 0) {
            await definition.state.appendMessages(sessionId, parsed)
          }
        },
        async close(): Promise<void> {
          await definition.state.closeSession(sessionId)
          sessionStates.delete(sessionId)
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
    const buffer: RunEvent[] = []
    const maxBufferedEvents = 1024
    let dropped = 0
    let done = false
    let failure: unknown
    let liveRunId = 'unknown'
    const result = runAgentCall(sessionId, agentId, agent, input, opts, (event) => {
      if ('runId' in event) liveRunId = event.runId
      if (buffer.length >= maxBufferedEvents) {
        const dropIndex = buffer.findIndex((candidate) => candidate.type !== 'run.finished')
        if (dropIndex >= 0) {
          buffer.splice(dropIndex, 1)
          dropped += 1
        }
      }
      buffer.push(event)
      return Promise.resolve()
    }).catch((error) => {
      failure = error
      return undefined
    }).finally(() => {
      done = true
    })

    let cursor = 0
    while (true) {
      if (dropped > 0) {
        yield { type: 'stream.overflow', runId: liveRunId, at: now(), dropped }
        dropped = 0
      }
      while (cursor < buffer.length) {
        yield buffer[cursor] as RunEvent
        cursor += 1
      }
      if (done) {
        await result.catch(() => undefined)
        if (failure) throw failure
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
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
    if (opts?.signal?.aborted) {
      throw new OperationCancelledError('Run was cancelled before start.', { scope: 'run' })
    }

    const runSignal = createRunSignal(opts?.signal, opts?.timeoutMs ?? definition.defaults.runTimeoutMs)
    const state = await getSessionState(sessionId)
    const memory = makeMemory(sessionId, state.sandboxSession)
    if (state.busy) {
      throw new SessionBusyError('Session is busy.', { session_id: sessionId, reason: 'concurrent_run' })
    }
    state.busy = true

    const startedAt = now()
    const runId = ulid()
    const runRecord: RunRecord = {
      id: runId,
      sessionId,
      kind: 'agent',
      target: agentId,
      startedAt,
      status: 'running',
      input: input as JsonValue
    }

    const emit = async (event: RunEvent): Promise<void> => {
      const eventAt = 'at' in event ? event.at : now()
      await onEvent?.(event)
      await appendEvents(runId, [{ id: ulid(), runId, at: eventAt, type: event.type, payload: sanitizeEventForPersistence(event) }])
    }

    try {
      await definition.state.createRun(runRecord)
    } catch (error) {
      state.busy = false
      throw error
    }

    try {
      const result = await withIncomingTraceContext(telemetry, opts, definition.logger, async () => telemetry.span('harness.session.agent_prompt', {
          'harness.name': definition.name,
          'harness.session.id': sessionId,
          'harness.run.id': runId,
          'harness.agent.id': agentId
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
          models: modelRegistry,
          skills: resolvedSkills as Record<string, ResolvedSkill>,
          customTools: definition.tools as ToolsConfig,
          mcpRegistry,
          session: state.sandboxSession,
          memory,
          mountedSkills: state.mountedSkills,
          ...(resolvedHistoryWindow !== undefined ? { historyWindow: resolvedHistoryWindow } : {}),
          maxSteps: definition.defaults.agentMaxIterations ?? 16,
          signal: runSignal.signal,
          toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
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
    const buffer: RunEvent[] = []
    const maxBufferedEvents = 1024
    let dropped = 0
    let done = false
    let failure: unknown
    let liveRunId = 'unknown'
    const result = runWorkflowCall(sessionId, workflowId, workflow, input, opts, (event) => {
      if ('runId' in event) liveRunId = event.runId
      if (buffer.length >= maxBufferedEvents) {
        const dropIndex = buffer.findIndex((candidate) => candidate.type !== 'run.finished')
        if (dropIndex >= 0) {
          buffer.splice(dropIndex, 1)
          dropped += 1
        }
      }
      buffer.push(event)
      return Promise.resolve()
    }).catch((error) => {
      failure = error
      return undefined
    }).finally(() => {
      done = true
    })

    let cursor = 0
    while (true) {
      if (dropped > 0) {
        yield { type: 'stream.overflow', runId: liveRunId, at: now(), dropped }
        dropped = 0
      }
      while (cursor < buffer.length) {
        yield buffer[cursor] as RunEvent
        cursor += 1
      }
      if (done) {
        await result.catch(() => undefined)
        if (failure) throw failure
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
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
    if (opts?.signal?.aborted) {
      throw new OperationCancelledError('Run was cancelled before start.', { scope: 'run' })
    }

    const runSignal = createRunSignal(opts?.signal, opts?.timeoutMs ?? definition.defaults.runTimeoutMs)
    const state = await getSessionState(sessionId)
    const memory = makeMemory(sessionId, state.sandboxSession)
    if (state.busy) {
      throw new SessionBusyError('Session is busy.', { session_id: sessionId, reason: 'concurrent_run' })
    }
    state.busy = true

    const startedAt = now()
    const runId = ulid()
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

    try {
      await definition.state.createRun(runRecord)
    } catch (error) {
      state.busy = false
      throw error
    }

    try {
      const result = await withIncomingTraceContext(telemetry, opts, definition.logger, async () => telemetry.span('harness.session.prompt', {
          'harness.name': definition.name,
          'harness.session.id': sessionId,
          'harness.run.id': runId,
          'harness.workflow.id': workflowId
        }, async () => {
        const runStarted: RunEvent = { type: 'run.started', runId, at: startedAt }
        await emit(runStarted)

        const workflowArgs = {
          workflowId,
          workflow,
          input,
          ctx: {
            signal: runSignal.signal,
            runId,
            sessionId,
            models: modelRegistry,
            metadata: opts?.metadata ?? {},
            agents: Object.fromEntries(
              Object.entries(definition.agents).map(([agentId, agent]) => [
                agentId,
                async (agentInput: unknown, agentOpts?: InvokeOptions) => {
                  const agentSignal = combineSignals(runSignal.signal, agentOpts?.signal)
                  try {
                    const resolvedHistoryWindow = agentOpts?.historyWindow ?? opts?.historyWindow ?? definition.defaults.historyWindow
                    const run = await runDefaultAgent({
                      harnessName: definition.name,
                      agentId,
                      runId,
                      sessionId,
                      workflowId,
                      input: agentInput,
                      history: await definition.state.listMessages(sessionId),
                      agent: agent as AgentDefinition<S>,
                      models: modelRegistry,
                      skills: resolvedSkills as Record<string, ResolvedSkill>,
                      customTools: definition.tools as ToolsConfig,
                      mcpRegistry,
                      session: state.sandboxSession,
                      memory,
                      mountedSkills: state.mountedSkills,
                      ...(resolvedHistoryWindow !== undefined ? { historyWindow: resolvedHistoryWindow } : {}),
                      maxSteps: definition.defaults.agentMaxIterations ?? 16,
                      signal: agentSignal.signal,
                      toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
                      logger: definition.logger,
                      telemetry,
                      emitEvent: emit,
                      metadata: { ...(opts?.metadata ?? {}), ...(agentOpts?.metadata ?? {}) }
                    })
                    if (run.emitted.length > 0) {
                      await definition.state.appendMessages(sessionId, run.emitted)
                    }
                    return run.output
                  } finally {
                    agentSignal.cleanup()
                  }
                }
              ])
            ) as unknown as WorkflowDefinition<S>['handler'] extends (ctx: infer C) => Promise<unknown>
              ? C extends { agents: infer A }
                ? A
                : never
              : never
          }
        } as Parameters<typeof runWorkflow<S>>[0]

        return telemetry.span('harness.workflow.run', {
          'harness.name': definition.name,
          'harness.session.id': sessionId,
          'harness.run.id': runId,
          'harness.workflow.id': workflowId
        }, async () => runWorkflow<S>({
            ...workflowArgs,
            ...(opts ? { opts: { ...opts, signal: runSignal.signal } } : { opts: { signal: runSignal.signal } })
          } as Parameters<typeof runWorkflow<S>>[0]))
      }))

      const finishedAt = now()
      const runFinished: RunEvent = { type: 'run.finished', runId, at: finishedAt, output: result as JsonValue }
      await emit(runFinished)
      await definition.state.finishRun(runId, { status: 'succeeded', finishedAt, output: result as JsonValue })
      const sessionRecord = await ensureSessionRecord(sessionId)
      await definition.state.upsertSession({ ...sessionRecord, updatedAt: finishedAt, runCount: sessionRecord.runCount + 1 })
      return result as WorkflowOutput<S, K>
    } catch (error) {
      const finalError = normalizeRunError(error, runSignal.signal)
      const finishedAt = now()
      const serialized = serializeError(finalError)
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
      runSignal.cleanup()
      state.busy = false
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

function configureHarnessAdapters(
  context: HarnessAdapterContext,
  models: ModelsConfig,
  state: StateStore,
  sandbox: Sandbox,
  tools: ToolsConfig
): void {
  const seen = new Set<unknown>()
  for (const alias of Object.values(models)) {
    configureOne(alias.provider, context, seen)
  }
  configureOne(state, context, seen)
  configureOne(sandbox, context, seen)
  for (const tool of Object.values(tools)) {
    configureOne(tool, context, seen)
  }
}

function configureOne(adapter: unknown, context: HarnessAdapterContext, seen: Set<unknown>): void {
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
      code: 'INVALID_TRACE_CONTEXT',
      traceparent: opts.traceparent,
      tracestate: opts.tracestate
    })
    return fn()
  }
  return telemetry.withTraceContext?.({ traceparent: opts.traceparent, ...(opts.tracestate ? { tracestate: opts.tracestate } : {}) }, fn) ?? fn()
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
      return { agentId: event.agentId }
    case 'agent.finished':
      return {
        agentId: event.agentId,
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
      return { agentId: event.agentId, delta: '[redacted]' }
    case 'model.object.partial':
      return { ...(event.agentId ? { agentId: event.agentId } : {}), partial: '[redacted]' }
    case 'model.object':
      return {
        ...(event.agentId ? { agentId: event.agentId } : {}),
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
  }
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTokenUsage(value: unknown): value is { inputTokens: number; outputTokens: number; totalTokens: number } {
  return isJsonRecord(value)
    && typeof value['inputTokens'] === 'number'
    && typeof value['outputTokens'] === 'number'
    && typeof value['totalTokens'] === 'number'
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

function createRunSignal(parent: AbortSignal | undefined, timeoutMs: number | undefined): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController()
  const relay = () => controller.abort(parent?.reason)
  if (parent) parent.addEventListener('abort', relay, { once: true })
  const timeout = timeoutMs && timeoutMs > 0
    ? setTimeout(() => controller.abort(new OperationTimeoutError('Run timed out.', { scope: 'run', timeout_ms: timeoutMs })), timeoutMs)
    : undefined
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timeout) clearTimeout(timeout)
      if (parent) parent.removeEventListener('abort', relay)
    }
  }
}

function combineSignals(primary: AbortSignal, secondary: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void } {
  if (!secondary) return { signal: primary, cleanup: () => undefined }
  const controller = new AbortController()
  const relayPrimary = () => controller.abort(primary.reason)
  const relaySecondary = () => controller.abort(secondary.reason)
  primary.addEventListener('abort', relayPrimary, { once: true })
  secondary.addEventListener('abort', relaySecondary, { once: true })
  return {
    signal: controller.signal,
    cleanup: () => {
      primary.removeEventListener('abort', relayPrimary)
      secondary.removeEventListener('abort', relaySecondary)
    }
  }
}
