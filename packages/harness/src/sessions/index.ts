import { createHash } from 'node:crypto'
import { z } from 'zod'

import type { Logger } from '../logger/index.js'
import type { Message, PersistedRunEvent, RunRecord, SessionRecord } from '../models/state.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import {
  InternalError,
  OperationCancelledError,
  OperationTimeoutError,
  HarnessError,
  SessionBusyError,
  StateError,
  SandboxConflictError,
  SandboxError,
  SandboxPermissionDeniedError,
  SandboxStateLostError,
  ValidationError,
  DelegationPolicyError,
  serializeError,
} from '../errors/index.js'
import { ulid } from '../ulid/index.js'
import { runDefaultAgent } from '../agents/index.js'
import { runWorkflow } from '../workflows/index.js'
import { validateSchema } from '../schema/validation.js'
import type {
  AgentDefinition,
  AgentInput,
  AgentOutput,
  InvokeOptions,
  ModelsConfig,
  ResolvedSkill,
  RunSummary,
  RunEvent,
  ExecutionEvent,
  RunOutcome,
  OutputUpdateMode,
  Harness,
  HarnessDefaults,
  Session,
  SkillDefinition,
  ToolsConfig,
  WorkflowDefinition,
  WorkflowDelegationPolicy,
  WorkflowFanOutOptions,
  WorkflowInput,
  WorkflowOutput,
  BuilderState,
  ChildTaskDescriptor,
  ChildTaskHandle,
  ChildTaskStartOptions,
  ChildTaskStatus,
  ContentCaptureMode,
  GovernanceConfig,
  TelemetryOptions,
} from '../harness/defineHarness.js'
import type { MemoryEngine, MemoryFacade } from '../ports/memory.js'
import { createMemoryFacade, createSessionMemory } from '../ports/memory.js'
import type { HarnessInspection } from '../ports/capabilities.js'
import type { DurableWorkspace } from '../ports/workspace.js'
import {
  ExternalWaitError,
  ExternalWaitPendingError,
  asExternalWaitResolved,
  assertExternalWaitSnapshotRequest,
  validateExternalWaitRegistration,
  validateExternalWaitRequest,
  validateExternalWaitSnapshot,
  type ExternalWaitRequest,
  type ExternalWaitResolved,
} from '../storage/external-wait.js'
import { beginDurableWorkflow, DURABLE_RUN_ID_PATTERN, type DurableWorkflowBinding } from '../runtime/sessionDurable.js'
import { runStepWithRetry, type DurableStepOptions } from '../runtime/steps.js'
import { HarnessConfigError } from '../errors/catalog.js'
import type {
  Sandbox,
  SandboxOpenOptions,
  SandboxOpenResult,
  SandboxScope,
  SandboxSessionBase,
  SandboxTerminateOptions,
} from '../sandbox/index.js'
import { withSandboxTelemetry } from '../sandbox/telemetry.js'
import {
  sessionOptionsSchema,
  type SandboxBindingOptions,
  type SandboxOwner,
  type SandboxPartition,
  type SandboxPolicy,
  type SessionOptions,
} from '../sandbox/ownership.js'

import type { AdapterCapability } from '../ports/capabilities.js'
import type { HarnessStorage } from '../storage/types.js'
import type { HarnessAdapterContext, HarnessContextConfigurable } from '../ports/harness-context.js'
import { finishReasonSchema, tokenUsageSchema, type FinishReason, type TokenUsage } from '../ports/model-provider.js'
import { loadSkillsSync } from '../skills/index.js'
import { createModelRegistry } from '../models/registry.js'
import type { ModelAdmission } from '../ports/model-admission.js'
import { createMetrics, createTelemetryShim, telemetryErrorType, type TelemetryShim } from '../telemetry/index.js'
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_WORKFLOW_NAME,
} from '@opentelemetry/semantic-conventions/incubating'
import { metadataSpanAttrs } from '../telemetry/span-attrs.js'
import { abortError } from '../runtime/abort.js'
import { createMcpRunnerRegistry } from '../tools/mcp/runner.js'
import { validateContextProjection } from '../context-projection.js'
import { retainCompleteTurns } from './history-retention.js'
import { normalizeHarnessIdentity, sameHarnessIdentity, type HarnessIdentity } from '../identity/index.js'
import {
  acknowledgeSandboxOwnerRegistration,
  createSessionSandboxBinding,
  resolveSandboxPartition,
  sameSessionSandboxBindingIdentity,
  sandboxScopeForBinding,
} from './sandboxBindings.js'

const MEMORY_SUMMARY_JSON_SCHEMA: JsonValue = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 16_000 },
  },
})

function readMemorySummary(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InternalError('Memory summary response is invalid.')
  }
  const summary = (value as Record<string, unknown>)['summary']
  if (typeof summary !== 'string' || summary.length < 1 || summary.length > 16_000) {
    throw new InternalError('Memory summary response is invalid.')
  }
  return summary
}

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

function directAgentIdempotencyRunId(sessionId: string, agentId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([sessionId, agentId, idempotencyKey]))
    .digest('hex')
  return `agent_${digest}`
}

function workflowIdempotencyRunId(sessionId: string, workflowId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([sessionId, workflowId, idempotencyKey]))
    .digest('hex')
  return `workflow_${digest}`
}

type HarnessDefinition<S extends BuilderState> = {
  name: string
  logger: Logger
  telemetry?: TelemetryOptions
  telemetryShim?: TelemetryShim
  storage: HarnessStorage
  sandbox: Sandbox
  sandboxBinding?: SandboxBindingOptions<string>
  memory: MemoryEngine
  memoryEmbeddingAlias?: string
  memorySummary?: { alias: string; everyTurns: number; sourceTurns: number }
  workspace?: DurableWorkspace
  defaults: HarnessDefaults
  models: NonNullable<S['models']>
  admission?: ModelAdmission
  tools: NonNullable<S['tools']>
  modelSchemas: {
    readonly agentOutputs: Readonly<Record<string, JsonValue>>
    readonly toolInputs: Readonly<Record<string, JsonValue>>
  }
  skills: NonNullable<S['skills']>
  agents: NonNullable<S['agents']>
  workflows: NonNullable<S['workflows']>
  governance?: GovernanceConfig<S>
  inspection: HarnessInspection
}

type SessionState = {
  sessionId: string
  busy: boolean
  /** Prevents a new run from reopening resources while session cleanup is in progress. */
  releasing: boolean
  sandboxSession: SandboxSessionBase
  mountedSkills: Set<string>
  scope: SandboxScope
  attachmentKey: string
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
  /** Durable checkpoints reject while a background child may still mutate a run partition. */
  checkpointBlockingChildTasks: Set<Promise<unknown>>
  /** Background-task turns waiting for a child-agent concurrency slot. */
  slotWaiters: Array<{
    signal: AbortSignal
    resolve: () => void
    reject: (error: unknown) => void
    cleanup: () => void
  }>
}

type SuspendedWorkflowResult = { readonly __harnessExternalWaitPending: ExternalWaitPendingError }

function isSuspendedWorkflowResult(value: unknown): value is SuspendedWorkflowResult {
  return Boolean(value && typeof value === 'object' && '__harnessExternalWaitPending' in value)
}

type LiveChildTask = {
  descriptor: ChildTaskDescriptor
  controller: AbortController
  result: Promise<JsonValue>
  snapshot: ChildTaskStatus
  cancel: (reason?: string) => Promise<void>
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

/** Runs one workflow-local batch without exposing a second orchestration DSL. */
async function runWorkflowFanOut<T, R>(args: {
  runId: string
  items: readonly T[]
  worker: (item: T, index: number) => Promise<R>
  options?: WorkflowFanOutOptions
  signal: AbortSignal
  maxConcurrency: number
  emit: (event: RunEvent) => Promise<void>
}): Promise<R[]> {
  const requested = args.options?.concurrency ?? args.maxConcurrency
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new ValidationError('Workflow fan-out concurrency must be a positive safe integer.', {
      where: 'invoke_options',
      issues: { fanOutConcurrency: args.options?.concurrency },
    })
  }
  // The workflow's declared delegation policy remains the authority ceiling.
  // A fan-out request can lower it but can never widen it.
  const concurrency = Math.min(requested, args.maxConcurrency)
  const batchId = `fanout_${ulid()}`
  await args.emit({
    type: 'fanout.started',
    runId: args.runId,
    batchId,
    at: now(),
    count: args.items.length,
    concurrency,
  })
  if (args.items.length === 0) {
    await args.emit({ type: 'fanout.finished', runId: args.runId, batchId, at: now(), count: 0, status: 'succeeded' })
    return []
  }

  const results = new Array<R>(args.items.length)
  let nextIndex = 0
  let failure: unknown
  const claim = (): number | undefined => {
    if (failure !== undefined || args.signal.aborted || nextIndex >= args.items.length) return undefined
    const index = nextIndex
    nextIndex += 1
    return index
  }
  const drive = async (): Promise<void> => {
    while (true) {
      const index = claim()
      if (index === undefined) return
      try {
        results[index] = await args.worker(args.items[index] as T, index)
      } catch (error) {
        failure ??= error
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, args.items.length) }, () => drive()))
  if (args.signal.aborted) {
    await args.emit({
      type: 'fanout.finished',
      runId: args.runId,
      batchId,
      at: now(),
      count: args.items.length,
      status: 'cancelled',
    })
    throw abortError(args.signal, 'run', 'Workflow fan-out was cancelled.')
  }
  if (failure !== undefined) {
    await args.emit({
      type: 'fanout.finished',
      runId: args.runId,
      batchId,
      at: now(),
      count: args.items.length,
      status: 'failed',
    })
    throw failure
  }
  await args.emit({
    type: 'fanout.finished',
    runId: args.runId,
    batchId,
    at: now(),
    count: args.items.length,
    status: 'succeeded',
  })
  return results
}

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
  run: (onEvent: (event: RunEvent) => Promise<void>, relaySignal: AbortSignal) => Promise<unknown>,
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

async function runWithOutcome<Output>(
  run: (onEvent: (event: RunEvent) => Promise<void>) => Promise<Output>,
): Promise<RunOutcome<Output>> {
  let runId: string | undefined
  try {
    const output = await run(async (event) => {
      if (event.type === 'run.started') runId = event.runId
    })
    if (!runId) throw new InternalError('Harness run completed without publishing its run identity.')
    return { status: 'completed', runId, output }
  } catch (error) {
    if (error instanceof ExternalWaitPendingError) {
      return { status: 'interrupted', runId: error.runId, interrupt: externalWaitInterrupt(error) }
    }
    throw error
  }
}

async function* projectExecutionEvents<Output>(
  diagnostics: AsyncIterable<RunEvent>,
  updates: OutputUpdateMode,
): AsyncIterable<ExecutionEvent<Output>> {
  try {
    for await (const event of diagnostics) {
      switch (event.type) {
        case 'run.started':
          yield event
          break
        case 'model.delta':
          if (updates === 'text-delta') {
            yield { type: 'output.text.delta', runId: event.runId, id: event.streamId, delta: event.delta }
          }
          break
        case 'model.object.partial':
          if (updates === 'object-snapshot') {
            yield { type: 'output.object.snapshot', runId: event.runId, id: event.streamId, value: event.partial }
          }
          break
        case 'model.object':
          if (updates === 'object-snapshot') {
            yield {
              type: 'output.object.snapshot',
              runId: event.runId,
              id: event.streamId ?? `${event.runId}:object`,
              value: event.object,
            }
          }
          break
        case 'tool.started':
        case 'tool.finished':
          yield event
          break
        case 'approval.requested':
          yield {
            type: 'approval.requested',
            runId: event.runId,
            agentId: event.agentId,
            toolId: event.toolId,
            callId: event.callId,
            approvalId: event.approvalId,
          }
          break
        case 'run.finished':
          if (event.error) break
          yield {
            type: 'run.finished',
            runId: event.runId,
            at: event.at,
            outcome: { status: 'completed', runId: event.runId, output: event.output as Output },
          }
          break
      }
    }
  } catch (error) {
    if (!(error instanceof ExternalWaitPendingError)) throw error
    yield {
      type: 'run.finished',
      runId: error.runId,
      at: new Date().toISOString(),
      outcome: { status: 'interrupted', runId: error.runId, interrupt: externalWaitInterrupt(error) },
    }
  }
}

function externalWaitInterrupt(error: ExternalWaitPendingError) {
  return {
    type: 'external-wait' as const,
    id: error.snapshot.waitId,
    revision: error.snapshot.createdAt,
    kind: error.snapshot.kind,
    schemaVersion: error.snapshot.schemaVersion,
    definitionVersion: error.snapshot.definitionVersion,
    deadline: error.snapshot.deadline,
  }
}

function validateInvokeOptions(opts: InvokeOptions | undefined): void {
  if (opts?.historyWindow !== undefined && opts.historyWindow < 0) {
    throw new ValidationError('Invoke options are invalid.', {
      where: 'invoke_options',
      issues: { historyWindow: opts.historyWindow },
    })
  }
  if (opts?.timeoutMs !== undefined && opts.timeoutMs < 0) {
    throw new ValidationError('Invoke options are invalid.', {
      where: 'invoke_options',
      issues: { timeoutMs: opts.timeoutMs },
    })
  }
  if (!validateContextProjection(opts?.contextProjection)) {
    throw new ValidationError('Invoke options are invalid.', {
      where: 'invoke_options',
      issues: { contextProjection: 'invalid' },
    })
  }
  if (opts?.idempotencyKey !== undefined && !/^[A-Za-z0-9_.:-]{1,120}$/.test(opts.idempotencyKey)) {
    throw new ValidationError('Invoke options are invalid.', {
      where: 'invoke_options',
      issues: { idempotencyKey: 'must match /^[A-Za-z0-9_.:-]{1,120}$/' },
    })
  }
}

function normalizeMessage(message: Omit<Message, 'id' | 'timestamp'>, sessionId: string): Message {
  return {
    ...message,
    sessionId,
    id: ulid(),
    timestamp: now(),
  }
}

export function createSessionHarness<S extends BuilderState>(definition: HarnessDefinition<S>): Harness<S> {
  if (definition.defaults.historyRetention && !definition.storage.replaceMessages) {
    throw new HarnessConfigError('historyRetention requires an atomic HarnessStorage.replaceMessages implementation.', {
      reason: 'storage_atomic_replace_required',
      path: 'storage.replaceMessages',
    })
  }
  const resolvedSkills = loadSkillsSync(definition.skills as Record<string, SkillDefinition>) as NonNullable<
    S['skills']
  > &
    Record<string, ResolvedSkill>
  const sessionStates = new Map<string, SessionState>()
  // Identity is immutable after session creation. Keep only that verified
  // record locally so idempotent replays do not add storage I/O on every turn.
  const sessionRecords = new Map<string, SessionRecord>()
  const sessionAttachmentEpochs = new Map<string, number>()
  // Share first-record allocation while validating each caller's identity
  // independently before it receives a sandbox attachment.
  const sessionRecordOpenings = new Map<string, Promise<SessionRecord>>()
  // In-flight session-state creations, memoized so concurrent first-time callers
  // share one sandbox open (no orphaned sessions) and one SessionState object
  // (so the synchronous busy check/set below serializes runs correctly).
  const sessionStateOpenings = new Map<string, Promise<SessionState>>()
  // One release operation per in-memory session generation. Sharing the same promise makes
  // repeated/concurrent release calls idempotent and prevents double-closing a
  // sandbox or a sandbox-bound MCP runner.
  const sessionResourceReleases = new WeakMap<SessionState, Promise<void>>()
  // Child tasks deliberately outlive an individual workflow handler. Their
  // execution is still owned by this harness instance and is cancelled on
  // session close or harness shutdown.
  const childTasks = new Map<string, LiveChildTask>()
  // A HarnessStorage's createRun operation is intentionally portable and does not
  // promise compare-and-set semantics. Serialize only the short in-process
  // reservation window so concurrent durable retries cannot both publish a
  // child run before either becomes visible in state.
  const childTaskStartLocks = new Map<string, Promise<void>>()
  // Stable per-harness-instance worker id used as the default durable lease owner.
  const durableWorkerId = `worker_${ulid()}`
  const contentCaptureMode = resolveContentCaptureMode(definition.telemetry)
  const telemetry = withTelemetryFlavor(definition.telemetryShim ?? createTelemetryShim(), definition.telemetry)
  async function sandboxLifecycle<T>(
    operation: 'open' | 'detach' | 'terminate',
    action: () => Promise<T>,
    outcome?: (result: T) => Record<string, string>,
  ): Promise<T> {
    return await withSandboxTelemetry(
      telemetry,
      definition.sandbox.telemetryAdapterId ?? 'custom_sandbox',
      operation,
      action,
      outcome,
    )
  }
  function openSandbox(options: SandboxOpenOptions): Promise<SandboxOpenResult<readonly AdapterCapability[]>> {
    return sandboxLifecycle(
      'open',
      () => definition.sandbox.open(options),
      (result) => ({
        'harness.sandbox.disposition': result.disposition,
        'harness.sandbox.live_process_state': result.liveProcessState,
      }),
    )
  }
  function detachSandbox(session: SandboxSessionBase): Promise<void> {
    return sandboxLifecycle('detach', () => session.close())
  }
  function terminateSandbox(options: SandboxTerminateOptions): Promise<void> {
    return sandboxLifecycle('terminate', () => definition.sandbox.terminate(options))
  }
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
      decisionTimeoutMs: definition.defaults.decisionTimeoutMs ?? 10_000,
      skillTimeoutMs: definition.defaults.skillTimeoutMs ?? 60_000,
      modelTimeoutMs: definition.defaults.modelTimeoutMs ?? 300_000,
      maxParallelToolCalls: definition.defaults.maxParallelToolCalls ?? 8,
      ...(definition.defaults.historyWindow !== undefined ? { historyWindow: definition.defaults.historyWindow } : {}),
    },
  }
  configureHarnessAdapters(
    adapterContext,
    definition.models as ModelsConfig,
    definition.storage,
    definition.sandbox,
    definition.memory,
    definition.tools as ToolsConfig,
    definition.workspace,
    definition.governance,
  )
  const modelRegistry = createModelRegistry(definition.models, {
    telemetry,
    harnessName: definition.name,
    ...(definition.admission ? { admission: definition.admission } : {}),
  })
  const mcpRegistry = createMcpRunnerRegistry()
  let shutdownPromise: Promise<{ errors: HarnessError[] }> | undefined

  async function ensureSessionRecord(sessionId: string, options?: SessionOptions): Promise<SessionRecord> {
    const parsedOptions = sessionOptionsSchema.safeParse(options ?? {})
    if (!parsedOptions.success) {
      throw new ValidationError('Session options are invalid.', {
        where: 'sandbox_options',
        issues: parsedOptions.error.issues,
      })
    }
    const normalizedIdentity = normalizeHarnessIdentity(parsedOptions.data.identity)
    const requireIdentity = (record: SessionRecord): SessionRecord => {
      if (!sameHarnessIdentity(record.identity, normalizedIdentity)) {
        throw new ValidationError('Session identity does not match the identity bound when the session was created.', {
          where: 'memory_scope',
          issues: { reason: 'session_identity_mismatch', sessionId },
        })
      }
      if (!record.sandboxBinding) {
        throw new SandboxStateLostError('Session sandbox binding is unavailable.', {
          reason: 'owner_missing',
          lifetime: 'session',
        })
      }
      const requestedBinding = createSessionSandboxBinding({
        harnessName: definition.name,
        record,
        ...(parsedOptions.data.sandboxOwner ? { sandboxOwner: parsedOptions.data.sandboxOwner } : {}),
      })
      if (!sameSessionSandboxBindingIdentity(record.sandboxBinding, requestedBinding)) {
        throw new SandboxConflictError('binding_changed')
      }
      return record
    }
    const cached = sessionRecords.get(sessionId)
    if (cached) return requireIdentity(cached)
    const pending = sessionRecordOpenings.get(sessionId)
    if (pending) return requireIdentity(await pending)

    const opening = (async (): Promise<SessionRecord> => {
      const existing = await definition.storage.getSession(sessionId)
      if (existing) {
        requireIdentity(existing)
        const acknowledged = await acknowledgeOwnedSessionRegistration(existing)
        sessionRecords.set(sessionId, acknowledged)
        return acknowledged
      }
      const createdAt = now()
      const instanceId = ulid()
      const proposed: SessionRecord = {
        id: sessionId,
        instanceId,
        createdAt,
        updatedAt: createdAt,
        runCount: 0,
        ...(normalizedIdentity ? { identity: normalizedIdentity } : {}),
        sandboxBinding: createSessionSandboxBinding({
          harnessName: definition.name,
          record: { id: sessionId, instanceId, ...(normalizedIdentity ? { identity: normalizedIdentity } : {}) },
          ...(parsedOptions.data.sandboxOwner ? { sandboxOwner: parsedOptions.data.sandboxOwner } : {}),
        }),
      }
      let inserted: boolean
      try {
        inserted = await definition.storage.upsertSession(proposed, 'create')
      } catch (error) {
        if (!(error instanceof StateError) || error.meta?.['reason'] !== 'session_identity_mismatch') throw error
        throw new ValidationError('Session identity does not match the identity bound when the session was created.', {
          where: 'memory_scope',
          issues: { reason: 'session_identity_mismatch', sessionId },
        })
      }
      // Another storage client may have won the insert, even with the same
      // timestamp. Only the atomic insertion result grants create authority.
      const stored = await definition.storage.getSession(sessionId)
      if (!stored)
        throw new StateError('Session record disappeared during creation.', {
          op: 'getSession',
          reason: 'session_missing',
        })
      if (inserted && stored.instanceId !== proposed.instanceId) {
        throw new StateError('Session instance changed during creation.', {
          op: 'getSession',
          reason: 'session_instance_mismatch',
        })
      }
      requireIdentity(stored)
      const acknowledged = await acknowledgeOwnedSessionRegistration(stored)
      sessionRecords.set(sessionId, acknowledged)
      return acknowledged
    })()
    sessionRecordOpenings.set(sessionId, opening)
    try {
      return await opening
    } finally {
      sessionRecordOpenings.delete(sessionId)
    }
  }

  /**
   * Registers an implicit session owner before exposing its facade.  This is
   * deliberately independent from opening compute: a session that is only
   * released or closed must still leave the sandbox adapter with enough durable
   * ownership state to perform its administration lifecycle safely.
   */
  async function acknowledgeOwnedSessionRegistration(record: SessionRecord): Promise<SessionRecord> {
    const binding = record.sandboxBinding
    if (binding.relation !== 'owned' || binding.registration === 'registered') return record

    await definition.sandbox.registerOwner({ owner: binding.owner, mode: 'create' })

    // A failed acknowledgement write intentionally leaves the durable record
    // pending.  Retrying acquisition replays the idempotent create registration
    // rather than treating an unacknowledged owner as safe to administer.
    const current = await definition.storage.getSession(record.id)
    if (!current) {
      throw new StateError('Session record disappeared during owner registration.', {
        op: 'getSession',
        reason: 'session_missing',
      })
    }
    if (current.instanceId !== record.instanceId || !sameHarnessIdentity(current.identity, record.identity)) {
      throw new StateError('Session instance changed during owner registration.', {
        op: 'getSession',
        reason: 'session_instance_mismatch',
      })
    }
    if (!sameSessionSandboxBindingIdentity(current.sandboxBinding, binding)) {
      throw new SandboxConflictError('binding_changed')
    }
    if (current.sandboxBinding.disposed || current.sandboxBinding.registration === 'registered') return current

    const acknowledged: SessionRecord = {
      ...current,
      sandboxBinding: acknowledgeSandboxOwnerRegistration(current.sandboxBinding),
    }
    await definition.storage.upsertSession(acknowledged, 'update')

    const persisted = await definition.storage.getSession(record.id)
    if (!persisted) {
      throw new StateError('Session record disappeared while acknowledging owner registration.', {
        op: 'getSession',
        reason: 'session_missing',
      })
    }
    if (persisted.instanceId !== record.instanceId || !sameHarnessIdentity(persisted.identity, record.identity)) {
      throw new StateError('Session instance changed while acknowledging owner registration.', {
        op: 'getSession',
        reason: 'session_instance_mismatch',
      })
    }
    if (!sameSessionSandboxBindingIdentity(persisted.sandboxBinding, binding)) {
      throw new SandboxConflictError('binding_changed')
    }
    if (persisted.sandboxBinding.registration !== 'registered') {
      throw new StateError('Session owner registration was not acknowledged.', {
        op: 'getSession',
        reason: 'owner_registration_pending',
      })
    }
    return persisted
  }

  async function requireSessionRecord(sessionId: string): Promise<SessionRecord> {
    const bound = sessionRecords.get(sessionId)
    const stored = await definition.storage.getSession(sessionId)
    if (
      !bound ||
      !stored ||
      stored.instanceId !== bound.instanceId ||
      !sameHarnessIdentity(stored.identity, bound.identity)
    ) {
      throw new StateError('Session is no longer bound to this client.', {
        op: 'getSession',
        reason: 'session_instance_mismatch',
      })
    }
    return stored
  }

  function sandboxScope(
    record: SessionRecord,
    lifetime: 'session' | 'run',
    options?: { runId?: string; partition?: SandboxPartition },
  ): SandboxScope {
    const partition = options?.partition ?? { kind: 'shared' }
    if (lifetime === 'session') return sandboxScopeForBinding(record.sandboxBinding, partition, lifetime)
    if (!options?.runId) throw new InternalError('Run sandbox scope requires a run id.')
    return sandboxScopeForBinding(record.sandboxBinding, partition, lifetime, options.runId)
  }

  function sandboxAttachmentKey(sessionId: string, scope: SandboxScope): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          sessionId,
          scope.owner,
          scope.partition,
          scope.lifetime,
          scope.lifetime === 'run' ? scope.runId : undefined,
        ]),
      )
      .digest('hex')
  }

  function definitionPartition(
    target: { kind: 'agent' | 'workflow'; id: string },
    policy: SandboxPolicy | undefined,
    inherited?: SandboxPartition,
    useDefault = false,
  ): SandboxPartition {
    return resolveSandboxPartition(
      policy ?? (useDefault ? definition.sandboxBinding?.defaultPolicy : undefined),
      { kind: target.kind, id: target.id, harnessName: definition.name },
      inherited,
    )
  }

  /** Resolves a background task without allowing its default cleanup to touch a parent partition. */
  function childTaskSandboxScope(
    record: SessionRecord,
    parentScope: SandboxScope,
    target: { kind: 'agent'; id: string },
    override: SandboxPolicy | undefined,
    definitionPolicy: SandboxPolicy | undefined,
    taskId: string,
  ): { readonly scope: SandboxScope; readonly taskOwned: boolean } {
    const policy = override ?? definitionPolicy
    if (policy === undefined) {
      return {
        scope: sandboxScope(record, 'run', { runId: taskId, partition: { kind: 'shared' } }),
        taskOwned: true,
      }
    }
    const partition = definitionPartition(target, policy, parentScope.partition)
    return {
      scope:
        parentScope.lifetime === 'run'
          ? sandboxScope(record, 'run', { runId: parentScope.runId, partition })
          : sandboxScope(record, 'session', { partition }),
      taskOwned: false,
    }
  }

  function digestDurableSandboxPolicy(current: HarnessDefinition<S>, workflowId: string): string {
    const entries = (definitions: Record<string, { sandbox?: SandboxPolicy }>) =>
      Object.entries(definitions)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, item]) => [id, item.sandbox ?? current.sandboxBinding?.defaultPolicy ?? 'inherit'])
    return createHash('sha256')
      .update(
        JSON.stringify({
          layout: 'purista.harness.durable-sandbox-policy/v1',
          workflowId,
          defaultPolicy: current.sandboxBinding?.defaultPolicy ?? 'inherit',
          agents: entries(current.agents),
          workflows: entries(current.workflows),
        }),
      )
      .digest('hex')
  }

  async function authorizeBorrowedOwner(record: SessionRecord): Promise<void> {
    const binding = record.sandboxBinding
    if (binding.relation !== 'borrowed') return
    const owner = binding.owner
    const actor = record.identity
    const ownerIdentity = owner.identity
    if (ownerIdentity?.tenantId !== undefined) {
      if (actor?.tenantId !== ownerIdentity.tenantId) throw new SandboxPermissionDeniedError('scope_mismatch')
    } else if (actor?.tenantId !== undefined) {
      throw new SandboxPermissionDeniedError('scope_mismatch')
    }
    if (ownerIdentity?.principalId !== undefined && actor?.principalId !== ownerIdentity.principalId) {
      throw new SandboxPermissionDeniedError('scope_mismatch')
    }
    if (!ownerIdentity && actor && (actor.tenantId !== undefined || actor.principalId !== undefined)) {
      throw new SandboxPermissionDeniedError('scope_mismatch')
    }
    const authorizeOwner = definition.sandboxBinding?.authorizeOwner
    if (!authorizeOwner) {
      throw new HarnessConfigError('Explicit sandbox owners require sandbox.authorizeOwner.', {
        reason: 'invalid_adapter',
        path: 'sandbox.authorizeOwner',
      })
    }
    if (
      !(await authorizeOwner({
        owner,
        ...(actor ? { identity: actor } : {}),
        harnessName: definition.name,
        sessionId: record.id,
      }))
    ) {
      throw new SandboxPermissionDeniedError('owner_not_authorized')
    }
  }

  function getSessionState(
    sessionId: string,
    selection?: { partition?: SandboxPartition; lifetime?: 'session' | 'run'; runId?: string },
  ): Promise<SessionState> {
    const record = sessionRecords.get(sessionId)
    if (!record)
      return Promise.reject(
        new InternalError('Session sandbox opened before its session record was loaded.', { session_id: sessionId }),
      )
    const partition = selection?.partition ?? { kind: 'shared' }
    const lifetime = selection?.lifetime ?? 'session'
    const attachmentKey = createHash('sha256')
      .update(JSON.stringify([sessionId, record.sandboxBinding.owner, partition, lifetime, selection?.runId]))
      .digest('hex')
    const existing = sessionStates.get(attachmentKey)
    if (existing) {
      return Promise.resolve(existing)
    }
    const pending = sessionStateOpenings.get(attachmentKey)
    if (pending) {
      return pending
    }

    const opening = (async () => {
      let record = sessionRecords.get(sessionId)
      if (!record)
        throw new InternalError('Session sandbox opened before its session record was loaded.', {
          session_id: sessionId,
        })
      if (record.sandboxBinding.disposed) {
        throw new SandboxStateLostError('Session sandbox was disposed and cannot be recreated.', {
          reason: 'scope_terminated',
          lifetime: 'session',
        })
      }
      await authorizeBorrowedOwner(record)
      const binding = record.sandboxBinding
      if (binding.registration === 'pending') {
        // New sessions are acknowledged before the façade is returned. This
        // branch is only for a recovered record whose acknowledgement was
        // interrupted; `open()` performs the active-owner attach check.
        await definition.sandbox.registerOwner({ owner: binding.owner, mode: 'create' })
        record = { ...record, sandboxBinding: acknowledgeSandboxOwnerRegistration(binding) }
        await definition.storage.upsertSession(record, 'update')
        sessionRecords.set(sessionId, record)
      }
      const selectedRunId = selection?.runId
      if (lifetime === 'run' && !selectedRunId) {
        throw new InternalError('Run sandbox attachment requires a run id.')
      }
      const resolvedScope =
        lifetime === 'run'
          ? sandboxScope(record, lifetime, { partition, runId: selectedRunId! })
          : sandboxScope(record, lifetime, { partition })
      const opened = await openSandbox({
        scope: resolvedScope,
        // `create` is idempotent for an existing active partition and is the
        // only safe lazy-first-use mode for both owned and authorized borrowed
        // owners. It never recreates terminated state.
        mode: 'create',
        ...(record.identity ? { identity: record.identity } : {}),
      })
      const sandboxSession = opened.session
      const created: SessionState = {
        sessionId,
        busy: false,
        releasing: false,
        sandboxSession,
        mountedSkills: new Set<string>(),
        scope: resolvedScope,
        attachmentKey,
      }
      sessionStates.set(attachmentKey, created)
      sessionAttachmentEpochs.set(sessionId, (sessionAttachmentEpochs.get(sessionId) ?? 0) + 1)
      sessionStateOpenings.delete(attachmentKey)
      return created
    })()
    // Let a failed open be retried instead of caching the rejection forever.
    opening.catch(() => sessionStateOpenings.delete(attachmentKey))
    sessionStateOpenings.set(attachmentKey, opening)
    return opening
  }

  async function appendEvents(runId: string, events: PersistedRunEvent[]): Promise<void> {
    try {
      await definition.storage.appendEvents(runId, events)
    } catch (error) {
      telemetry.recordCounter('harness.events.persist_errors', 1, { harness: definition.name })
      definition.logger.error('Failed to persist run events.', {
        harness: definition.name,
        run_id: runId,
        error: serializeError(error),
      })
    }
  }

  /**
   * Commits one completed logical transcript turn. Model/provider retries
   * happen before this boundary. A redelivered logical run reuses stable
   * message ids, so exact messages are a no-op while a conflicting duplicate
   * remains a state error rather than silently corrupting history.
   */
  async function persistConversationTurn(sessionId: string, messages: readonly Message[]): Promise<void> {
    if (messages.length === 0) return
    const current = await definition.storage.listMessages(sessionId)
    const existing = new Map(current.map((message) => [message.id, message]))
    const additions: Message[] = []
    for (const message of messages) {
      const prior = existing.get(message.id)
      if (!prior) {
        additions.push(message)
        continue
      }
      if (!sameLogicalMessage(prior, message)) {
        throw new StateError('A logical conversation message id was reused with different content.', {
          op: 'appendMessages',
          reason: 'message_id_conflict',
        })
      }
    }
    if (definition.defaults.historyRetention) {
      const retained = retainCompleteTurns([...current, ...additions], definition.defaults.historyRetention)
      await definition.storage.replaceMessages!(sessionId, retained)
      return
    }
    if (additions.length > 0) await definition.storage.appendMessages(sessionId, additions)
  }

  /** Best-effort enrichment: a summary failure never reverses a committed application run. */
  async function refreshMemorySummary(
    sessionId: string,
    sandboxSession: SandboxSessionBase,
    signal: AbortSignal,
    identity?: HarnessIdentity,
  ): Promise<void> {
    const config = definition.memorySummary
    if (!config) return
    const history = await definition.storage.listMessages(sessionId)
    const completeTurns = history.filter((message) => message.role === 'user').length
    if (completeTurns === 0 || completeTurns % config.everyTurns !== 0) return
    const source = history.slice(-config.sourceTurns * 2)
    const handle = modelRegistry[config.alias] as
      | {
          object?: (
            request: {
              messages: readonly { role: 'system' | 'user'; content: string }[]
              schema: JsonValue
              schemaName: string
            },
            signal: AbortSignal,
          ) => Promise<{ object: unknown }>
        }
      | undefined
    if (!handle?.object) {
      definition.logger.error('Configured memory summary model has no object method.', {
        harness: definition.name,
        model_alias: config.alias,
      })
      return
    }
    try {
      const response = await telemetry.span(
        'harness.memory.summary',
        {
          'harness.name': definition.name,
          'harness.session.id': sessionId,
          'harness.memory.summary.model_alias': config.alias,
        },
        () =>
          handle.object!(
            {
              messages: [
                {
                  role: 'system',
                  content:
                    'Summarize the supplied conversation faithfully. Do not invent facts. Return a concise summary.',
                },
                { role: 'user', content: source.map((message) => `${message.role}: ${message.content}`).join('\n') },
              ],
              schema: MEMORY_SUMMARY_JSON_SCHEMA,
              schemaName: 'harness_conversation_summary',
            },
            signal,
          ),
      )
      const summary = readMemorySummary(response.object)
      const model = definition.models[config.alias]!
      const digest = createHash('sha256')
        .update(JSON.stringify(source.map((message) => [message.id, message.content])))
        .digest('hex')
      const memory = createMemoryFacade(
        memoryOptions(sessionId, sandboxSession, signal, identity ? { identity } : {}),
      ).session
      await memory.write(
        '_harness/conversation-summary',
        {
          summary,
          sourceMessageIds: source.map((message) => message.id),
          sourceDigest: digest,
          generatedAt: now(),
          modelAlias: config.alias,
          providerId: model.provider.id,
          model: model.model,
          revision: 'harness.conversation-summary.v1',
        },
        { index: { text: summary } },
      )
      telemetry.recordCounter('harness.memory.summary.count', 1, { 'harness.name': definition.name })
    } catch (error) {
      telemetry.recordCounter('harness.memory.summary.failure_count', 1, { 'harness.name': definition.name })
      definition.logger.error('Memory summary enrichment failed.', {
        harness: definition.name,
        session_id: sessionId,
        error: serializeError(error),
      })
    }
  }

  async function readCommittedAgentOutput(
    sessionId: string,
    runId: string,
    agent: AgentDefinition<S>,
  ): Promise<JsonValue | undefined> {
    const finalMessage = (await definition.storage.listMessages(sessionId)).find(
      (message) => message.id === `msg_${runId}_99_assistant_final`,
    )
    if (!finalMessage) return undefined
    let candidate: unknown
    try {
      candidate = JSON.parse(finalMessage.content)
    } catch {
      return undefined
    }
    const schema = agent.output
    if (schema) {
      try {
        return await validateSchema(schema, candidate, {
          where: 'agent_output',
          message: 'Agent output validation failed.',
        })
      } catch {
        return undefined
      }
    }
    return typeof candidate === 'string' ? candidate : undefined
  }

  async function cancelChildTasks(predicate: (task: LiveChildTask) => boolean, reason: string): Promise<void> {
    const selected = [...childTasks.values()].filter(predicate)
    await Promise.allSettled(selected.map((task) => task.cancel(reason)))
  }

  function attachmentStatesForSession(sessionId: string): SessionState[] {
    return [...sessionStates.values()].filter((candidate) => candidate.sessionId === sessionId)
  }

  async function releaseAllSessionResources(sessionId: string, reason: string): Promise<void> {
    const states = attachmentStatesForSession(sessionId)
    const results = await Promise.allSettled(
      states.map((candidate) => releaseSessionResources(sessionId, candidate, reason)),
    )
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Failed to release session resources.')
  }

  async function disposeSessionSandbox(sessionId: string, record: SessionRecord): Promise<void> {
    await releaseAllSessionResources(sessionId, 'sandbox disposed')
    if (record.sandboxBinding.relation === 'borrowed') return
    const selector = { kind: 'owner' as const, owner: record.sandboxBinding.owner }
    const result = await definition.sandbox.administration.purge({
      selector,
      idempotencyKey: `session:${record.instanceId}:dispose`,
    })
    if (result.state !== 'completed') {
      throw new SandboxError('Sandbox cleanup is pending.', { reason: 'cleanup_pending' })
    }
    if (definition.workspace) {
      const workspaceResult = await definition.workspace.administration.purge({
        selector,
        idempotencyKey: `session:${record.instanceId}:dispose:workspace`,
      })
      if (workspaceResult.state !== 'completed') {
        throw new SandboxError('Workspace cleanup is pending.', { reason: 'cleanup_pending' })
      }
    }
    const stored = await definition.storage.getSession(sessionId)
    if (!stored || stored.instanceId !== record.instanceId) return
    const updated = {
      ...stored,
      sandboxBinding: { ...stored.sandboxBinding, disposed: true },
      updatedAt: now(),
    }
    await definition.storage.upsertSession(updated, 'update')
    sessionRecords.set(sessionId, updated)
  }

  /**
   * Frees only process-local resources. Persisted session, message, and run
   * records deliberately remain intact so callers can reopen the same session
   * id after an idle period or process handoff.
   */
  function releaseSessionResources(sessionId: string, state: SessionState, reason: string): Promise<void> {
    const pending = sessionResourceReleases.get(state)
    if (pending) return pending

    // Facades are generation-bound. An older facade must never release a
    // sandbox opened by a later getSession(id) call for the same logical id.
    if (sessionStates.get(state.attachmentKey) !== state) return Promise.resolve()
    if (state.busy || state.releasing) {
      return Promise.reject(
        new SessionBusyError('Session is busy.', {
          session_id: sessionId,
          reason: state.releasing ? 'session_release_in_progress' : 'concurrent_run',
        }),
      )
    }

    state.releasing = true
    const release = (async (): Promise<void> => {
      // A child task can intentionally outlive its starter workflow. It owns
      // isolated sandboxes/MCP processes, so cancellation must settle before
      // the parent session's shared resources are closed.
      await cancelChildTasks((task) => task.descriptor.sessionId === sessionId, reason)

      const failures: unknown[] = []
      try {
        await mcpRegistry.closeForSandboxKey(state.attachmentKey)
      } catch (error) {
        failures.push(error)
      }
      try {
        await detachSandbox(state.sandboxSession)
      } catch (error) {
        failures.push(error)
      }

      // Evict even when a resource reports a close failure: the resource must
      // never be reused after a release attempt, and the next getSession call
      // receives a fresh sandbox/MCP binding rather than a potentially closed
      // handle. The original error is still surfaced to the caller.
      if (sessionStates.get(state.attachmentKey) === state) sessionStates.delete(state.attachmentKey)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Failed to release session resources.')
    })()
    const completed = release.finally(() => {
      sessionResourceReleases.delete(state)
      state.releasing = false
    })
    sessionResourceReleases.set(state, completed)
    return completed
  }

  async function getRunSummary(runId: string): Promise<RunSummary | undefined> {
    const run = await definition.storage.getRun(runId)
    if (!run) return undefined
    const events = await definition.storage.listEvents(runId)
    const tokenTotals: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let modelCalls = 0
    let toolCalls = 0
    let agentCalls = 0

    for (const event of events) {
      if (event.type === 'agent.started') agentCalls += 1
      if (event.type === 'tool.started') toolCalls += 1
      if (event.type === 'model.completed') modelCalls += 1
      const payload = event.payload
      if (
        (event.type === 'model.completed' ||
          event.type === 'model.embedding.completed' ||
          event.type === 'model.rerank.completed') &&
        isJsonRecord(payload) &&
        isTokenUsage(payload['usage'])
      ) {
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
      ...(run.error ? { error: normalizeSerializedRunError(run.error) } : {}),
    }
  }

  function memoryOptions(
    sessionId: string,
    sandboxSession: SandboxSessionBase,
    signal: AbortSignal,
    opts: {
      runId?: string
      agentId?: string
      workflowId?: string
      identity?: HarnessIdentity
    } = {},
  ): Parameters<typeof createSessionMemory>[0] {
    const embeddingAlias = definition.memoryEmbeddingAlias
    const embeddingModel = embeddingAlias ? definition.models[embeddingAlias] : undefined
    const embeddingHandle = embeddingAlias
      ? (modelRegistry[embeddingAlias] as {
          embed?: (
            input: { input: string },
            signal: AbortSignal,
          ) => Promise<import('../ports/model-provider.js').EmbeddingResponse>
        })
      : undefined
    return {
      engine: definition.memory,
      logger: definition.logger,
      telemetry,
      metrics: adapterMetrics,
      contentCaptureMode,
      signal,
      harnessName: definition.name,
      sessionId,
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...(opts.workflowId ? { workflowId: opts.workflowId } : {}),
      ...(opts.identity ? { identity: opts.identity } : {}),
      ...(embeddingAlias && embeddingModel && embeddingHandle?.embed
        ? {
            embedding: {
              alias: embeddingAlias,
              providerId: embeddingModel.provider.id,
              model: embeddingModel.model,
              embed: (input: string, signal: AbortSignal) => embeddingHandle.embed!({ input }, signal),
            },
          }
        : {}),
    }
  }

  function memoryFacade(opts: {
    sessionId: string
    sandboxSession: SandboxSessionBase
    signal: AbortSignal
    runId: string
    agentId?: string
    workflowId?: string
    identity?: HarnessIdentity
    metadata?: Readonly<Record<string, JsonValue>>
  }): MemoryFacade {
    return createMemoryFacade(memoryOptions(opts.sessionId, opts.sandboxSession, opts.signal, opts))
  }

  /**
   * Validates `opts.durable` and returns the configured Harness storage, or
   * `undefined` for an ephemeral run. Throws before any run record is created.
   */
  function resolveDurableStorage(opts: InvokeOptions | undefined): HarnessStorage | undefined {
    if (!opts?.durable) return undefined
    if (!DURABLE_RUN_ID_PATTERN.test(opts.durable.runId)) {
      throw new ValidationError('Durable run id is invalid.', {
        where: 'invoke_options',
        issues: { 'durable.runId': opts.durable.runId },
      })
    }
    return definition.storage
  }

  return {
    inspect(): HarnessInspection {
      return definition.inspection
    },
    async getSession(sessionId: string, options?: SessionOptions): Promise<Session<S>> {
      const sessionRecord = await ensureSessionRecord(sessionId, options)
      // A borrowed owner is an application-owned capability, not merely a
      // sandbox-open concern. Authorize it before returning a facade so
      // history and memory APIs cannot be used before the application has
      // admitted the caller.
      await authorizeBorrowedOwner(sessionRecord)
      let attachmentEpoch = sessionAttachmentEpochs.get(sessionId) ?? 0
      let state: SessionState | undefined
      let released = false
      const requireSessionState = async (): Promise<SessionState> => {
        if (released) {
          throw new StateError('Session attachment is no longer active.', {
            op: 'getSession',
            reason: 'session_attachment_closed',
          })
        }
        const stored = await definition.storage.getSession(sessionId)
        if (
          !stored ||
          stored.instanceId !== sessionRecord.instanceId ||
          !sameHarnessIdentity(stored.identity, sessionRecord.identity)
        ) {
          throw new StateError('Session instance is no longer active.', {
            op: 'getSession',
            reason: 'session_instance_changed',
          })
        }
        const attached = await getSessionState(sessionId)
        if (state && state !== attached) {
          throw new StateError('Session attachment is no longer active.', {
            op: 'getSession',
            reason: 'session_attachment_closed',
          })
        }
        state = attached
        attachmentEpoch = sessionAttachmentEpochs.get(sessionId) ?? attachmentEpoch
        return attached
      }
      const requireCurrentRecord = async (): Promise<void> => {
        const stored = await definition.storage.getSession(sessionId)
        if (
          !stored ||
          stored.instanceId !== sessionRecord.instanceId ||
          !sameHarnessIdentity(stored.identity, sessionRecord.identity)
        ) {
          throw new StateError('Session instance is no longer active.', {
            op: 'getSession',
            reason: 'session_instance_changed',
          })
        }
      }
      const requireCurrentInstance = async (attachmentRequired = false): Promise<void> => {
        await requireCurrentRecord()
        if (released) {
          throw new StateError('Session attachment is no longer active.', {
            op: 'getSession',
            reason: 'session_attachment_closed',
          })
        }
        if (attachmentRequired) await requireSessionState()
      }
      const lazySandboxSession: SandboxSessionBase = {
        executor: 'unavailable',
        read: async (path) => await (await requireSessionState()).sandboxSession.read(path),
        readText: async (path, encoding) => await (await requireSessionState()).sandboxSession.readText(path, encoding),
        write: async (path, data) => await (await requireSessionState()).sandboxSession.write(path, data),
        remove: async (path, removeOptions) =>
          await (await requireSessionState()).sandboxSession.remove(path, removeOptions),
        list: async (path, listOptions) => await (await requireSessionState()).sandboxSession.list(path, listOptions),
        stat: async (path) => await (await requireSessionState()).sandboxSession.stat(path),
        exists: async (path) => await (await requireSessionState()).sandboxSession.exists(path),
        mount: async (files, path) => await (await requireSessionState()).sandboxSession.mount(files, path),
        close: async () => {
          if (state) await releaseSessionResources(sessionId, state, 'memory session released')
          released = true
        },
      }
      const memory = createMemoryFacade(
        memoryOptions(
          sessionId,
          lazySandboxSession,
          NEVER_ABORT_SIGNAL,
          sessionRecord.identity ? { identity: sessionRecord.identity } : {},
        ),
      ).session
      const workflowEntries = Object.entries(definition.workflows).map(([workflowId, workflow]) => {
        const invoker = {
          run: async (input: WorkflowInput<S, keyof NonNullable<S['workflows']>>, opts?: InvokeOptions) => {
            await requireCurrentInstance(
              !sessionRecord.sandboxBinding.disposed ||
                !(await isSuccessfulWorkflowReplay(sessionId, workflowId, input, opts)),
            )
            return runWithOutcome<WorkflowOutput<S, keyof NonNullable<S['workflows']>>>((onEvent) =>
              runWorkflowCall(sessionId, workflowId, workflow as WorkflowDefinition<S>, input, opts, onEvent) as Promise<
                WorkflowOutput<S, keyof NonNullable<S['workflows']>>
              >,
            )
          },
          async *stream(
            input: WorkflowInput<S, keyof NonNullable<S['workflows']>>,
            opts?: InvokeOptions,
          ): AsyncIterable<ExecutionEvent<WorkflowOutput<S, keyof NonNullable<S['workflows']>>>> {
            await requireCurrentInstance(
              !sessionRecord.sandboxBinding.disposed ||
                !(await isSuccessfulWorkflowReplay(sessionId, workflowId, input, opts)),
            )
            for await (const event of projectExecutionEvents<WorkflowOutput<S, keyof NonNullable<S['workflows']>>>(
              streamWorkflowCall(sessionId, workflowId, workflow as WorkflowDefinition<S>, input, opts),
              workflow.updates ?? 'none',
            )) {
              yield event
            }
          },
          async *observe(
            input: WorkflowInput<S, keyof NonNullable<S['workflows']>>,
            opts?: InvokeOptions,
          ): AsyncIterable<RunEvent> {
            await requireCurrentInstance(
              !sessionRecord.sandboxBinding.disposed ||
                !(await isSuccessfulWorkflowReplay(sessionId, workflowId, input, opts)),
            )
            try {
              yield* streamWorkflowCall(sessionId, workflowId, workflow as WorkflowDefinition<S>, input, opts)
            } catch (error) {
              if (!(error instanceof ExternalWaitPendingError)) throw error
            }
          },
        }
        return [workflowId, invoker]
      })
      const workflows = Object.fromEntries(workflowEntries) as Session<S>['workflows']
      const agentEntries = Object.entries(definition.agents).map(([agentId, agent]) => {
        const invoker = {
          run: async (input: AgentInput<S, keyof NonNullable<S['agents']>>, opts?: InvokeOptions) => {
            await requireCurrentInstance(
              !sessionRecord.sandboxBinding.disposed ||
                !(await isSuccessfulAgentReplay(sessionId, agentId, input, opts)),
            )
            return runWithOutcome<AgentOutput<S, keyof NonNullable<S['agents']>>>((onEvent) =>
              runAgentCall(sessionId, agentId, agent as AgentDefinition<S>, input, opts, onEvent) as Promise<
                AgentOutput<S, keyof NonNullable<S['agents']>>
              >,
            )
          },
          async *stream(
            input: AgentInput<S, keyof NonNullable<S['agents']>>,
            opts?: InvokeOptions,
          ): AsyncIterable<ExecutionEvent<AgentOutput<S, keyof NonNullable<S['agents']>>>> {
            await requireCurrentInstance(
              !sessionRecord.sandboxBinding.disposed ||
                !(await isSuccessfulAgentReplay(sessionId, agentId, input, opts)),
            )
            for await (const event of projectExecutionEvents<AgentOutput<S, keyof NonNullable<S['agents']>>>(
              streamAgentCall(sessionId, agentId, agent as AgentDefinition<S>, input, opts),
              agent.updates ?? 'none',
            )) {
              yield event
            }
          },
          async *observe(
            input: AgentInput<S, keyof NonNullable<S['agents']>>,
            opts?: InvokeOptions,
          ): AsyncIterable<RunEvent> {
            await requireCurrentInstance(
              !sessionRecord.sandboxBinding.disposed ||
                !(await isSuccessfulAgentReplay(sessionId, agentId, input, opts)),
            )
            yield* streamAgentCall(sessionId, agentId, agent as AgentDefinition<S>, input, opts)
          },
        }
        return [agentId, invoker]
      })
      const agents = Object.fromEntries(agentEntries) as Session<S>['agents']

      return {
        id: sessionId,
        agents,
        workflows,
        childTasks: {
          get: (taskId) => getSessionChildTask(sessionId, taskId),
          list: (opts) => listSessionChildTasks(sessionId, opts),
        },
        memory,
        history: {
          list: async (opts) => {
            await requireCurrentRecord()
            return definition.storage.listMessages(sessionId, opts)
          },
        },
        async getRunSummary(runId: string): Promise<RunSummary | undefined> {
          return getRunSummary(runId)
        },
        async clearHistory(): Promise<void> {
          await requireCurrentInstance()
          if (state?.busy || state?.releasing) {
            throw new SessionBusyError('Session is busy.', {
              session_id: sessionId,
              reason: 'history_clear_during_run',
            })
          }
          await definition.storage.clearMessages(sessionId)
        },
        async replaceHistory(messages: ReadonlyArray<Omit<Message, 'id' | 'timestamp'>>): Promise<void> {
          await requireCurrentInstance()
          if (state?.busy || state?.releasing) {
            throw new SessionBusyError('Session is busy.', {
              session_id: sessionId,
              reason: 'history_replace_during_run',
            })
          }
          const parsed = messages.map((message) => {
            try {
              return normalizeMessage(message, sessionId)
            } catch (error) {
              throw new ValidationError(
                'Session history replacement failed validation.',
                { where: 'session_history', issues: { message } },
                error,
              )
            }
          })
          if (definition.storage.replaceMessages) {
            await definition.storage.replaceMessages(sessionId, parsed)
          } else {
            // Non-atomic fallback for adapters without atomic replace.
            await definition.storage.clearMessages(sessionId)
            if (parsed.length > 0) {
              await definition.storage.appendMessages(sessionId, parsed)
            }
          }
        },
        async destroy(): Promise<void> {
          // A stale facade is a no-op. In particular, it must not delete the
          // persisted conversation that a newer getSession(id) has reopened.
          if (
            state &&
            sessionStates.get(state.attachmentKey) !== state &&
            (sessionAttachmentEpochs.get(sessionId) ?? 0) !== attachmentEpoch
          )
            return
          if (!state && released && (sessionAttachmentEpochs.get(sessionId) ?? 0) !== attachmentEpoch) return
          await releaseAllSessionResources(sessionId, 'session destroyed')
          const currentRecord = sessionRecords.get(sessionId)
          if (!currentRecord || currentRecord.instanceId !== sessionRecord.instanceId) return
          if (currentRecord.sandboxBinding.relation === 'owned') {
            if (state) {
              await terminateSandbox({ scope: state.scope, reason: 'session_closed' })
            }
            await disposeSessionSandbox(sessionId, currentRecord)
          }
          await definition.storage.closeSession(sessionId, sessionRecord.instanceId)
          if (sessionRecords.get(sessionId)?.instanceId === sessionRecord.instanceId) {
            sessionRecords.delete(sessionId)
            sessionStateOpenings.delete(sessionId)
          }
        },
        async release(): Promise<void> {
          if (!state) {
            released = true
            return
          }
          await releaseSessionResources(sessionId, state, 'session released')
          released = true
        },
        async disposeSandbox(): Promise<void> {
          await requireCurrentRecord()
          const currentRecord = await requireSessionRecord(sessionId)
          await disposeSessionSandbox(sessionId, currentRecord)
          released = true
        },
      }
    },
    async shutdown(): Promise<{ errors: HarnessError[] }> {
      shutdownPromise ??= shutdownHarness()
      return await shutdownPromise
    },
    $infer: {} as Harness<S>['$infer'],
  }

  async function shutdownHarness(): Promise<{ errors: HarnessError[] }> {
    const errors: HarnessError[] = []
    // Child tasks own MCP runners and isolated sandboxes. They must observe
    // cancellation while those resources are still live.
    await cancelChildTasks(() => true, 'harness shutdown')
    try {
      await mcpRegistry.close()
    } catch (error) {
      errors.push(
        error instanceof HarnessError ? error : new InternalError('Failed to close MCP registry.', undefined, error),
      )
    }
    for (const [sessionId, state] of sessionStates) {
      try {
        await detachSandbox(state.sandboxSession)
      } catch (error) {
        errors.push(
          error instanceof HarnessError
            ? error
            : new InternalError('Failed to close sandbox session.', { session_id: sessionId }, error),
        )
      }
    }
    sessionStates.clear()
    sessionRecords.clear()
    const closed = new Set<object>()
    const closeResource = async (kind: string, id: string, resource: unknown, allowLog = true): Promise<void> => {
      if (
        !resource ||
        (typeof resource !== 'object' && typeof resource !== 'function') ||
        closed.has(resource as object)
      )
        return
      closed.add(resource as object)
      const close = (resource as { close?: unknown }).close
      if (typeof close !== 'function') return
      try {
        await close.call(resource)
      } catch (error) {
        const normalized =
          error instanceof HarnessError
            ? error
            : new InternalError(`Failed to close ${kind}.`, { resource_kind: kind, resource_id: id }, error)
        errors.push(normalized)
        if (allowLog) {
          try {
            definition.logger.error('Harness resource close failed.', {
              resource_kind: kind,
              resource_id: id,
              error: normalized.code,
            })
          } catch {
            // A logger failure must not prevent subsequent resource cleanup.
          }
        }
      }
    }

    for (const [alias, model] of [...Object.entries(definition.models)].reverse()) {
      await closeResource('model_provider', alias, model.provider)
    }
    await closeResource('governance', 'governance', definition.governance)
    await closeResource('workspace', 'workspace', definition.workspace)
    await closeResource('memory', definition.memory.info.id, definition.memory)
    await closeResource('sandbox', 'sandbox', definition.sandbox)
    await closeResource('state', 'state', definition.storage)
    await closeResource('logger', 'logger', definition.logger, false)
    return { errors }
  }

  async function* streamAgentCall<K extends keyof NonNullable<S['agents']>>(
    sessionId: string,
    agentId: string,
    agent: AgentDefinition<S>,
    input: AgentInput<S, K>,
    opts?: InvokeOptions,
  ): AsyncIterable<RunEvent> {
    yield* relayRunEvents((onEvent, relaySignal) => {
      const combined = combineSignals(relaySignal, opts?.signal)
      return runAgentCall(sessionId, agentId, agent, input, { ...opts, signal: combined.signal }, onEvent).finally(() =>
        combined.cleanup(),
      )
    })
  }

  async function runAgentCall<K extends keyof NonNullable<S['agents']>>(
    sessionId: string,
    agentId: string,
    agent: AgentDefinition<S>,
    input: AgentInput<S, K>,
    opts?: InvokeOptions,
    onEvent?: (event: RunEvent) => Promise<void>,
  ): Promise<AgentOutput<S, K>> {
    validateInvokeOptions(opts)
    const boundSession = await requireSessionRecord(sessionId)
    await authorizeBorrowedOwner(boundSession)
    if (opts?.durable) {
      throw new ValidationError('Durable execution is only supported for workflow runs.', {
        where: 'invoke_options',
        issues: { durable: 'agent_run' },
      })
    }
    if (opts?.signal?.aborted) {
      throw new OperationCancelledError('Run was cancelled before start.', { scope: 'run' })
    }

    // HarnessStorage run ids are global. Scope caller-provided delivery keys by the
    // logical session and agent so the same transport key can safely occur in
    // independent conversations. Hashing also keeps the persisted id bounded
    // and avoids placing a caller-controlled delivery id in logs or storage.
    const runId = opts?.idempotencyKey ? directAgentIdempotencyRunId(sessionId, agentId, opts.idempotencyKey) : ulid()
    if (opts?.idempotencyKey) {
      const previous = await definition.storage.getRun(runId)
      if (previous) {
        const sameInvocation =
          previous.sessionId === sessionId &&
          previous.kind === 'agent' &&
          previous.target === agentId &&
          JSON.stringify(previous.input) === JSON.stringify(input)
        if (!sameInvocation) {
          throw new ValidationError('idempotencyKey is already bound to a different agent invocation.', {
            where: 'invoke_options',
            issues: { idempotencyKey: opts.idempotencyKey },
          })
        }
        if (previous.status === 'succeeded') {
          // `stream()` still has to satisfy the run-event lifecycle contract
          // on an idempotent replay. These are relay-only events: the prior
          // completed run is authoritative, so no model call or state/event
          // mutation is performed.
          if (onEvent) {
            const replayedAt = now()
            await onEvent({ type: 'run.started', runId, at: replayedAt })
            await onEvent({ type: 'run.finished', runId, at: replayedAt, output: previous.output ?? null })
          }
          return previous.output as AgentOutput<S, K>
        }
        if (previous.status === 'cancelled') {
          throw new StateError('A cancelled agent invocation cannot be replayed with the same idempotencyKey.', {
            op: 'createRun',
            reason: 'idempotency_terminal_run',
          })
        }
        // A process may have committed the transcript and crashed before it
        // could terminalize the run record. Recover that committed result
        // instead of calling the provider again or treating regenerated
        // timestamps as a transcript conflict.
        const committed = await readCommittedAgentOutput(sessionId, runId, agent)
        if (committed !== undefined) {
          const finishedAt = now()
          await definition.storage.finishRun(runId, { status: 'succeeded', finishedAt, output: committed })
          if (onEvent) {
            await onEvent({ type: 'run.started', runId, at: finishedAt })
            await onEvent({ type: 'run.finished', runId, at: finishedAt, output: committed })
          }
          return committed as AgentOutput<S, K>
        }
      }
    }

    // Busy check precedes createRunSignal so an early SessionBusyError cannot
    // leak the run-timeout timer or the caller-signal abort listener.
    const state = await getSessionState(sessionId, {
      partition: definitionPartition({ kind: 'agent', id: agentId }, agent.sandbox, undefined, true),
    })
    if (state.busy || state.releasing) {
      throw new SessionBusyError('Session is busy.', {
        session_id: sessionId,
        reason: state.releasing ? 'session_release_in_progress' : 'concurrent_run',
      })
    }
    state.busy = true
    const runSignal = createRunSignal(opts?.signal, opts?.timeoutMs ?? definition.defaults.runTimeoutMs)

    const startedAt = now()
    const emit = async (event: RunEvent): Promise<void> => {
      const eventAt = 'at' in event ? event.at : now()
      await onEvent?.(event)
      await appendEvents(runId, [
        { id: ulid(), runId, at: eventAt, type: event.type, payload: sanitizeEventForPersistence(event) },
      ])
    }

    let runCreated = false
    try {
      const memory = memoryFacade({
        sessionId,
        runId,
        agentId,
        signal: runSignal.signal,
        sandboxSession: state.sandboxSession,
        ...(boundSession.identity ? { identity: boundSession.identity } : {}),
        metadata: opts?.metadata ?? {},
      })
      const runRecord: RunRecord = {
        id: runId,
        sessionId,
        kind: 'agent',
        target: agentId,
        startedAt,
        status: 'running',
        input: input as JsonValue,
      }
      await definition.storage.createRun(runRecord)
      runCreated = true

      const result = await withIncomingTraceContext(telemetry, opts, definition.logger, async () =>
        telemetry.span(
          'harness.session.agent_prompt',
          {
            'harness.name': definition.name,
            'harness.session.id': sessionId,
            'harness.run.id': runId,
            'harness.agent.id': agentId,
            'harness.telemetry.content_capture_mode': contentCaptureMode,
            ...metadataSpanAttrs(opts?.metadata),
          },
          async () => {
            await emit({ type: 'run.started', runId, at: startedAt })
            const resolvedHistoryWindow = opts?.historyWindow ?? definition.defaults.historyWindow
            const contextProjection =
              opts?.contextProjection ??
              (agent.model ? definition.models[agent.model]?.contextProjection : undefined) ??
              definition.defaults.contextProjection
            const run = await runDefaultAgent({
              harnessName: definition.name,
              agentId,
              runId,
              sessionId,
              input,
              history: await definition.storage.listMessages(sessionId),
              agent,
              models: withRunEventModelRegistry(
                modelRegistry,
                {
                  harnessName: definition.name,
                  sessionId,
                  runId,
                  agentId,
                },
                emit,
              ),
              skills: resolvedSkills as Record<string, ResolvedSkill>,
              customTools: definition.tools as ToolsConfig,
              modelSchemas: {
                agentOutput: definition.modelSchemas.agentOutputs[agentId],
                toolInputs: definition.modelSchemas.toolInputs,
              },
              ...(definition.governance ? { governance: definition.governance as GovernanceConfig<any> } : {}),
              mcpRegistry,
              session: state.sandboxSession,
              sandboxKey: state.attachmentKey,
              memory,
              mountedSkills: state.mountedSkills,
              ...(resolvedHistoryWindow !== undefined ? { historyWindow: resolvedHistoryWindow } : {}),
              ...(contextProjection ? { contextProjection } : {}),
              maxSteps: definition.defaults.agentMaxIterations ?? 16,
              signal: runSignal.signal,
              runDeadline: runSignal.deadline,
              toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
              decisionTimeoutMs: definition.defaults.decisionTimeoutMs ?? 10_000,
              maxParallelToolCalls: definition.defaults.maxParallelToolCalls ?? 8,
              logger: definition.logger,
			  telemetry,
			  emitEvent: emit,
			  metadata: opts?.metadata ?? {},
			  ...(opts?.hostContext !== undefined ? { hostContext: opts.hostContext } : {}),
			})
            if (run.emitted.length > 0) {
              await persistConversationTurn(sessionId, run.emitted)
              await refreshMemorySummary(sessionId, state.sandboxSession, runSignal.signal, boundSession.identity)
            }
            return run.output
          },
        ),
      )

      const finishedAt = now()
      await emit({ type: 'run.finished', runId, at: finishedAt, output: result as JsonValue })
      await definition.storage.finishRun(runId, { status: 'succeeded', finishedAt, output: result as JsonValue })
      const sessionRecord = await requireSessionRecord(sessionId)
      await definition.storage.upsertSession(
        { ...sessionRecord, updatedAt: finishedAt, runCount: sessionRecord.runCount + 1 },
        'update',
      )
      return result as AgentOutput<S, K>
    } catch (error) {
      const finalError = normalizeRunError(error, runSignal.signal)
      if (!runCreated) {
        throw finalError
      }
      const finishedAt = now()
      const serialized = serializeError(finalError)
      const log =
        finalError instanceof OperationCancelledError
          ? definition.logger.warn.bind(definition.logger)
          : definition.logger.error.bind(definition.logger)
      log('Harness agent run failed.', {
        harness: definition.name,
        session_id: sessionId,
        run_id: runId,
        agent_id: agentId,
        error: serialized,
      })
      const runFinished: RunEvent = { type: 'run.finished', runId, at: finishedAt, error: serialized }
      await terminalizeFailedRun({
        kind: 'agent',
        targetId: agentId,
        sessionId,
        runId,
        primaryError: serialized,
        emitRunFinished: () => emit(runFinished),
        finishRun: () =>
          definition.storage.finishRun(runId, {
            status: finalError instanceof OperationCancelledError ? 'cancelled' : 'failed',
            finishedAt,
            error: serialized,
          }),
        upsertSession: async () => {
          const sessionRecord = await requireSessionRecord(sessionId)
          await definition.storage.upsertSession(
            { ...sessionRecord, updatedAt: finishedAt, runCount: sessionRecord.runCount + 1 },
            'update',
          )
        },
      })
      throw finalError
    } finally {
      runSignal.cleanup()
      state.busy = false
    }
  }

  async function isSuccessfulAgentReplay(
    sessionId: string,
    agentId: string,
    input: unknown,
    opts: InvokeOptions | undefined,
  ): Promise<boolean> {
    if (!opts?.idempotencyKey) return false
    const previous = await definition.storage.getRun(
      directAgentIdempotencyRunId(sessionId, agentId, opts.idempotencyKey),
    )
    return (
      previous?.status === 'succeeded' &&
      previous.sessionId === sessionId &&
      previous.kind === 'agent' &&
      previous.target === agentId &&
      JSON.stringify(previous.input) === JSON.stringify(input)
    )
  }

  async function isSuccessfulWorkflowReplay(
    sessionId: string,
    workflowId: string,
    input: unknown,
    opts: InvokeOptions | undefined,
  ): Promise<boolean> {
    const runId =
      opts?.durable?.runId ??
      (opts?.idempotencyKey ? workflowIdempotencyRunId(sessionId, workflowId, opts.idempotencyKey) : undefined)
    if (!runId) return false
    const previous = await definition.storage.getRun(runId)
    return (
      previous?.status === 'succeeded' &&
      previous.sessionId === sessionId &&
      previous.kind === 'workflow' &&
      previous.target === workflowId &&
      JSON.stringify(previous.input) === JSON.stringify(input)
    )
  }

  async function* streamWorkflowCall<K extends keyof NonNullable<S['workflows']>>(
    sessionId: string,
    workflowId: string,
    workflow: WorkflowDefinition<S>,
    input: WorkflowInput<S, K>,
    opts?: InvokeOptions,
  ): AsyncIterable<RunEvent> {
    yield* relayRunEvents((onEvent, relaySignal) => {
      const combined = combineSignals(relaySignal, opts?.signal)
      return runWorkflowCall(
        sessionId,
        workflowId,
        workflow,
        input,
        { ...opts, signal: combined.signal },
        onEvent,
      ).finally(() => combined.cleanup())
    })
  }

  async function runWorkflowCall<K extends keyof NonNullable<S['workflows']>>(
    sessionId: string,
    workflowId: string,
    workflow: WorkflowDefinition<S>,
    input: WorkflowInput<S, K>,
    opts?: InvokeOptions,
    onEvent?: (event: RunEvent) => Promise<void>,
  ): Promise<WorkflowOutput<S, K>> {
    validateInvokeOptions(opts)
    const boundSession = await requireSessionRecord(sessionId)
    await authorizeBorrowedOwner(boundSession)
    const durableStorage = resolveDurableStorage(opts)
    if (opts?.signal?.aborted) {
      throw new OperationCancelledError('Run was cancelled before start.', { scope: 'run' })
    }

    const runId =
      opts?.durable?.runId ??
      (opts?.idempotencyKey ? workflowIdempotencyRunId(sessionId, workflowId, opts.idempotencyKey) : ulid())
    const previous = await definition.storage.getRun(runId)
    if (previous) {
      const sameInvocation =
        previous.sessionId === sessionId &&
        previous.kind === 'workflow' &&
        previous.target === workflowId &&
        JSON.stringify(previous.input) === JSON.stringify(input)
      if (!sameInvocation) {
        throw new ValidationError('Workflow idempotency key is already bound to a different invocation.', {
          where: 'invoke_options',
          issues: { ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : { 'durable.runId': runId }) },
        })
      }
      if (previous.status === 'succeeded') {
        if (onEvent) {
          const replayedAt = now()
          await onEvent({ type: 'run.started', runId, at: replayedAt })
          await onEvent({ type: 'run.finished', runId, at: replayedAt, output: previous.output ?? null })
        }
        return previous.output as WorkflowOutput<S, K>
      }
      if (previous.status === 'cancelled') {
        throw new StateError('A cancelled workflow invocation cannot be replayed with the same idempotency key.', {
          op: 'createRun',
          reason: 'idempotency_terminal_run',
        })
      }
    }

    // Busy check precedes createRunSignal so an early SessionBusyError cannot
    // leak the run-timeout timer or the caller-signal abort listener.
    const state = await getSessionState(
      sessionId,
      opts?.durable
        ? undefined
        : {
            partition: definitionPartition({ kind: 'workflow', id: workflowId }, workflow.sandbox, undefined, true),
          },
    )
    if (state.busy || state.releasing) {
      throw new SessionBusyError('Session is busy.', {
        session_id: sessionId,
        reason: state.releasing ? 'session_release_in_progress' : 'concurrent_run',
      })
    }
    state.busy = true
    const runSignal = createRunSignal(opts?.signal, opts?.timeoutMs ?? definition.defaults.runTimeoutMs)

    const startedAt = now()
    const durableSandboxScope = opts?.durable
      ? sandboxScope(boundSession, 'run', {
          runId,
          partition: definitionPartition({ kind: 'workflow', id: workflowId }, workflow.sandbox, undefined, true),
        })
      : undefined
    if (opts?.durable && boundSession.sandboxBinding.relation === 'borrowed') {
      throw new HarnessConfigError('Durable workflow execution requires an implicitly owned sandbox.', {
        reason: 'invalid_sandbox_policy',
        path: 'session.sandboxOwner',
      })
    }
    const durableSandboxPolicyDigest = durableSandboxScope
      ? digestDurableSandboxPolicy(definition, workflowId)
      : undefined
    const runRecord: RunRecord = {
      id: runId,
      sessionId,
      kind: 'workflow',
      target: workflowId,
      startedAt,
      status: 'running',
      input: input as JsonValue,
    }

    const emit = async (event: RunEvent): Promise<void> => {
      const eventAt = 'at' in event ? event.at : now()
      await onEvent?.(event)
      await appendEvents(runId, [
        { id: ulid(), runId, at: eventAt, type: event.type, payload: sanitizeEventForPersistence(event) },
      ])
    }

    let durableBinding: DurableWorkflowBinding | undefined
    let runSandboxSession = state.sandboxSession
    let runSandboxScope: SandboxScope | undefined
    let runMountedSkills = state.mountedSkills
    let closeRunSandbox = false
    let runSandboxTerminal = false
    let runCreated = false
    let durableAttemptOwned = false
    const durableSandboxPartitions = new Map<string, SandboxPartition>()
    const retainDurablePartition = (scope: SandboxScope): void => {
      if (scope.lifetime !== 'run' || scope.runId !== runId) return
      durableSandboxPartitions.set(JSON.stringify(scope.partition), scope.partition)
    }
    const delegationState: DelegationRunState = {
      totalChildAgentCalls: 0,
      activeChildAgentCalls: 0,
      inFlightChildCalls: new Set<Promise<unknown>>(),
      checkpointBlockingChildTasks: new Set<Promise<unknown>>(),
      slotWaiters: [],
    }
    try {
      if (durableStorage && opts?.durable) {
        // A durable retry is owned by its existing run record. A competing
        // worker must neither overwrite that record nor terminalize it when
        // acquireRun rejects because another lease is active.
        const existingDurableRun = await durableStorage.getRun(runId)
        if (!existingDurableRun) {
          await definition.storage.createRun(runRecord)
          runCreated = true
        }
        if (!durableSandboxScope || !durableSandboxPolicyDigest)
          throw new InternalError('Durable sandbox scope was not resolved.')
        durableBinding = await beginDurableWorkflow({
          storage: durableStorage,
          ...(definition.workspace ? { workspace: definition.workspace } : {}),
          durable: opts.durable,
          defaultWorkerId: durableWorkerId,
          sessionId,
          workflowId,
          input: input as JsonValue,
          signal: runSignal.signal,
          logger: definition.logger,
          harnessName: definition.name,
          sandbox: {
            owner: durableSandboxScope.owner,
            partition: durableSandboxScope.partition,
            policyDigest: durableSandboxPolicyDigest,
            partitions: () => [...durableSandboxPartitions.values()],
          },
          beforeStepCheckpoint: () => {
            if (delegationState.checkpointBlockingChildTasks.size > 0) {
              throw new SandboxConflictError('checkpoint_busy')
            }
          },
        })
        retainDurablePartition(durableSandboxScope)
        durableAttemptOwned = true
        if (definition.workspace && definition.sandbox.capabilities?.includes('sandbox.workspace_binding')) {
          runSandboxScope = durableSandboxScope
          const opened = await openSandbox({
            scope: runSandboxScope,
            mode: durableBinding.resumed ? 'restore' : 'create',
            ...(boundSession.identity ? { identity: boundSession.identity } : {}),
            signal: runSignal.signal,
          })
          runSandboxSession = opened.session as SandboxSessionBase
          runMountedSkills = new Set<string>()
          closeRunSandbox = true
        }
      } else {
        await definition.storage.createRun(runRecord)
        runCreated = true
      }
      const memory = memoryFacade({
        sessionId,
        runId,
        workflowId,
        signal: runSignal.signal,
        sandboxSession: runSandboxSession,
        ...(boundSession.identity ? { identity: boundSession.identity } : {}),
        metadata: opts?.metadata ?? {},
      })
      const result = await withIncomingTraceContext(telemetry, opts, definition.logger, async () =>
        telemetry.span(
          'harness.session.run',
          {
            'harness.name': definition.name,
            'harness.session.id': sessionId,
            'harness.run.id': runId,
            'harness.workflow.id': workflowId,
            'harness.telemetry.content_capture_mode': contentCaptureMode,
            ...metadataSpanAttrs(opts?.metadata),
          },
          async () => {
            const runStarted: RunEvent = { type: 'run.started', runId, at: startedAt }
            await emit(runStarted)
            const workflowMetrics = createMetrics(telemetry, {
              'harness.name': definition.name,
              'harness.session.id': sessionId,
              'harness.run.id': runId,
              'harness.workflow.id': workflowId,
            })
            const delegationPolicy = resolveDelegationPolicy(workflow)

            const workflowArgs = {
              workflowId,
              workflow,
              input,
              ctx: {
                logger: definition.logger,
                telemetry,
                signal: runSignal.signal,
                runId,
                sessionId,
                models: withRunEventModelRegistry(
                  modelRegistry,
                  {
                    harnessName: definition.name,
                    sessionId,
                    runId,
                    workflowId,
                  },
                  emit,
                ),
                metadata: opts?.metadata ?? {},
                metrics: workflowMetrics,
                memory,
                step: durableBinding
                  ? durableBinding.step
                  : <T extends JsonValue>(stepId: string, fn: () => Promise<T>, options?: DurableStepOptions) =>
                      passthroughStep(stepId, fn, options, runSignal.signal),
                externalWait: createExternalWaitFacade({
                  storage: definition.storage,
                  durable: durableBinding,
                  telemetry,
                  harnessName: definition.name,
                  sessionId,
                  runId,
                  workflowId,
                  emit,
                }),
                fanOut: <T, R>(
                  items: readonly T[],
                  worker: (item: T, index: number) => Promise<R>,
                  options?: WorkflowFanOutOptions,
                ) =>
                  runWorkflowFanOut({
                    runId,
                    items,
                    worker,
                    ...(options ? { options } : {}),
                    signal: runSignal.signal,
                    maxConcurrency: delegationPolicy.maxParallelChildAgentCalls,
                    emit,
                  }),
                childTasks: {
                  start: <K extends keyof NonNullable<S['agents']>>(
                    agentId: K,
                    agentInput: AgentInput<S, K>,
                    taskOptions?: ChildTaskStartOptions<S, K>,
                  ) =>
                    startChildTask({
                      sessionId,
                      parentRunId: runId,
                      workflowId,
                      parentSandboxScope: runSandboxScope ?? state.scope,
                      agentId: agentId as string,
                      agentInput,
                      agent: definition.agents[agentId as string] as AgentDefinition<S>,
                      ...(taskOptions
                        ? { options: taskOptions as ChildTaskStartOptions<S, keyof NonNullable<S['agents']>> }
                        : {}),
                      workflowPolicy: delegationPolicy,
                      delegationState,
                      parentSignal: runSignal.signal,
                      parentDeadline: runSignal.deadline,
                      durable: durableBinding !== undefined,
					  onSandboxScope: retainDurablePartition,
					  metadata: opts?.metadata ?? {},
					  ...(opts?.hostContext !== undefined ? { hostContext: opts.hostContext } : {}),
					}) as Promise<ChildTaskHandle<AgentOutput<S, K>>>,
                },
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
                        throw new OperationCancelledError(
                          'Child-agent call was cancelled before start.',
                          { scope: 'run' },
                          agentOpts.signal.reason,
                        )
                      }
                      validateInvokeOptions(agentOpts)
                      if (agentOpts?.durable) {
                        throw new ValidationError('Durable execution is only supported for workflow runs.', {
                          where: 'invoke_options',
                          issues: { durable: 'agent_run' },
                        })
                      }
                      // An unknown per-call model alias is an invoke-option mistake;
                      // it must not pass the delegation gate or consume call budget.
                      if (agentOpts?.model !== undefined && !(agentOpts.model in (definition.models as ModelsConfig))) {
                        throw new ValidationError('Unknown model alias for child-agent call.', {
                          where: 'invoke_options',
                          issues: { model: agentOpts.model },
                        })
                      }
                      const selectedModelAlias = agentOpts?.model ?? (agent as AgentDefinition<S>).model
                      assertDelegationAllowed({
                        policy: delegationPolicy,
                        state: delegationState,
                        workflowId,
                        agentId,
                        ...(selectedModelAlias ? { modelAlias: selectedModelAlias } : {}),
                      })
                      // Compose signals before consuming budget so a composition
                      // failure can never leak an active delegation slot.
                      const combinedSignal = combineSignals(runSignal.signal, agentOpts?.signal, runSignal.deadline)
                      const agentSignal =
                        agentOpts?.timeoutMs !== undefined
                          ? createRunSignal(combinedSignal.signal, agentOpts.timeoutMs, combinedSignal.deadline)
                          : combinedSignal
                      delegationState.totalChildAgentCalls += 1
                      delegationState.activeChildAgentCalls += 1
                      const delegationCallId = `delegate_${ulid()}`
                      const childCall = (async () => {
                        await authorizeBorrowedOwner(boundSession)
                        const parentScope = runSandboxScope ?? state.scope
                        const inlineScope = sandboxScope(boundSession, parentScope.lifetime, {
                          partition: definitionPartition(
                            { kind: 'agent', id: agentId },
                            (agent as AgentDefinition<S>).sandbox,
                            parentScope.partition,
                          ),
                          ...(parentScope.lifetime === 'run' ? { runId: parentScope.runId } : {}),
                        })
                        retainDurablePartition(inlineScope)
                        const inlineAttachmentKey = sandboxAttachmentKey(sessionId, inlineScope)
                        let inlineSandbox = runSandboxSession
                        let inlineMountedSkills = runMountedSkills
                        let closeInlineSandbox = false
                        if (
                          inlineAttachmentKey !==
                          (runSandboxScope ? sandboxAttachmentKey(sessionId, runSandboxScope) : state.attachmentKey)
                        ) {
                          const opened = await openSandbox({
                            scope: inlineScope,
                            mode: 'create',
                            ...(boundSession.identity ? { identity: boundSession.identity } : {}),
                            signal: agentSignal.signal,
                          })
                          inlineSandbox = opened.session as SandboxSessionBase
                          inlineMountedSkills = new Set<string>()
                          closeInlineSandbox = true
                        }
                        const resolvedHistoryWindow =
                          agentOpts?.historyWindow ?? opts?.historyWindow ?? definition.defaults.historyWindow
                        const contextProjection =
                          agentOpts?.contextProjection ??
                          opts?.contextProjection ??
                          (selectedModelAlias ? definition.models[selectedModelAlias]?.contextProjection : undefined) ??
                          definition.defaults.contextProjection
                        const agentMetadata = { ...(opts?.metadata ?? {}), ...(agentOpts?.metadata ?? {}) }
                        try {
                          const agentMemory = memoryFacade({
                            sessionId,
                            runId,
                            workflowId,
                            agentId,
                            signal: agentSignal.signal,
                            sandboxSession: inlineSandbox,
                            ...(boundSession.identity ? { identity: boundSession.identity } : {}),
                            metadata: agentMetadata,
                          })
                          const run = await runDefaultAgent({
                            harnessName: definition.name,
                            agentId,
                            runId,
                            sessionId,
                            workflowId,
                            delegationCallId,
                            delegationDepth: CHILD_DELEGATION_DEPTH,
                            input: agentInput,
                            history: await definition.storage.listMessages(sessionId),
                            agent: agent as AgentDefinition<S>,
                            ...(selectedModelAlias ? { modelAlias: selectedModelAlias } : {}),
                            models: withRunEventModelRegistry(
                              modelRegistry,
                              {
                                harnessName: definition.name,
                                sessionId,
                                runId,
                                workflowId,
                                agentId,
                                ...(selectedModelAlias ? { modelAlias: selectedModelAlias } : {}),
                              },
                              emit,
                            ),
                            skills: resolvedSkills as Record<string, ResolvedSkill>,
                            customTools: definition.tools as ToolsConfig,
                            modelSchemas: {
                              agentOutput: definition.modelSchemas.agentOutputs[agentId],
                              toolInputs: definition.modelSchemas.toolInputs,
                            },
                            ...(definition.governance
                              ? { governance: definition.governance as GovernanceConfig<any> }
                              : {}),
                            mcpRegistry,
                            session: inlineSandbox,
                            sandboxKey: inlineAttachmentKey,
                            memory: agentMemory,
                            mountedSkills: inlineMountedSkills,
                            ...(resolvedHistoryWindow !== undefined ? { historyWindow: resolvedHistoryWindow } : {}),
                            ...(contextProjection ? { contextProjection } : {}),
                            maxSteps: definition.defaults.agentMaxIterations ?? 16,
                            signal: agentSignal.signal,
                            runDeadline: agentSignal.deadline,
                            toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
                            decisionTimeoutMs: definition.defaults.decisionTimeoutMs ?? 10_000,
                            maxParallelToolCalls: definition.defaults.maxParallelToolCalls ?? 8,
                            logger: definition.logger,
						  telemetry,
						  emitEvent: emit,
						  metadata: agentMetadata,
						  ...((agentOpts?.hostContext ?? opts?.hostContext) !== undefined
							? { hostContext: agentOpts?.hostContext ?? opts?.hostContext }
							: {}),
						})
                          if (run.emitted.length > 0) {
                            await persistConversationTurn(sessionId, run.emitted)
                            await refreshMemorySummary(
                              sessionId,
                              inlineSandbox,
                              agentSignal.signal,
                              boundSession.identity,
                            )
                          }
                          return run.output
                        } finally {
                          if (closeInlineSandbox) {
                            await mcpRegistry.closeForSandboxKey(inlineAttachmentKey)
                            await detachSandbox(inlineSandbox)
                          }
                        }
                      })()
                      delegationState.inFlightChildCalls.add(childCall)
                      try {
                        return await childCall
                      } finally {
                        delegationState.inFlightChildCalls.delete(childCall)
                        releaseDelegationSlot(delegationState)
                        agentSignal.cleanup()
                        if (agentSignal !== combinedSignal) combinedSignal.cleanup()
                      }
                    },
                  ]),
                ) as unknown as WorkflowDefinition<S>['handler'] extends (ctx: infer C) => Promise<unknown>
                  ? C extends { agents: infer A }
                    ? A
                    : never
                  : never,
              },
            } as unknown as Parameters<typeof runWorkflow<S>>[0]

            const workflowTelemetryAttrs = {
              'harness.name': definition.name,
              'harness.session.id': sessionId,
              'harness.run.id': runId,
              'harness.workflow.id': workflowId,
              'gen_ai.operation.name': 'invoke_workflow',
              [ATTR_GEN_AI_WORKFLOW_NAME]: workflowId,
              [ATTR_GEN_AI_CONVERSATION_ID]: sessionId,
              ...metadataSpanAttrs(opts?.metadata),
            }
            const workflowStarted = Date.now()
            let workflowError: unknown
            return telemetry.span('harness.workflow.run', workflowTelemetryAttrs, async () => {
              try {
                return await runWorkflow<S>({
                  ...workflowArgs,
                  ...(opts ? { opts: { ...opts, signal: runSignal.signal } } : { opts: { signal: runSignal.signal } }),
                } as Parameters<typeof runWorkflow<S>>[0])
              } catch (error) {
                if (error instanceof ExternalWaitPendingError) {
                  // A wait is a normal checkpoint-and-suspend transition. Keep
                  // both short spans successful; the run catch below persists the
                  // waiting lifecycle record and returns the public signal to the
                  // delivery worker without recording a false exception span.
                  return { __harnessExternalWaitPending: error } as SuspendedWorkflowResult
                }
                workflowError = error
                throw error
              } finally {
                telemetry.recordHistogram('gen_ai.invoke_workflow.duration', (Date.now() - workflowStarted) / 1000, {
                  ...workflowTelemetryAttrs,
                  ...(workflowError === undefined ? {} : { [ATTR_ERROR_TYPE]: telemetryErrorType(workflowError) }),
                })
              }
            })
          },
        ),
      )

      if (isSuspendedWorkflowResult(result)) {
        throw result.__harnessExternalWaitPending
      }

      // A resolved handler may still have child-agent calls in flight; settle
      // them before terminalizing so no run events trail run.finished.
      if (delegationState.inFlightChildCalls.size > 0) {
        await Promise.allSettled([...delegationState.inFlightChildCalls])
      }
      const finishedAt = now()
      if (durableBinding) {
        await guardDurableStep({ sessionId, runId, workflowId, operation: 'finish_success' }, () =>
          durableBinding!.finishSuccess(result as JsonValue),
        )
        runSandboxTerminal = true
      }
      const runFinished: RunEvent = { type: 'run.finished', runId, at: finishedAt, output: result as JsonValue }
      await emit(runFinished)
      await definition.storage.finishRun(runId, { status: 'succeeded', finishedAt, output: result as JsonValue })
      const sessionRecord = await requireSessionRecord(sessionId)
      await definition.storage.upsertSession(
        { ...sessionRecord, updatedAt: finishedAt, runCount: sessionRecord.runCount + 1 },
        'update',
      )
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
      if (!runCreated && !durableAttemptOwned) {
        throw finalError
      }
      // `beginDurableWorkflow` either acquired a binding or released its own
      // provisional lease before it throws. Without a binding this invocation
      // cannot safely finish a durable run record.
      if (durableStorage && opts?.durable && !durableBinding) {
        throw finalError
      }
      if (finalError instanceof ExternalWaitPendingError) {
        await definition.storage.finishRun(runId, { status: 'waiting' })
        // A durable wait is a normal suspension: do not log it as a workflow
        // failure, emit run.finished, or make the durable run terminal. The
        // finally block releases the lease so a signal can trigger a later run.
        throw finalError
      }
      if (durableBinding && finalError instanceof OperationCancelledError) {
        await guardDurableStep({ sessionId, runId, workflowId, operation: 'finish_cancelled' }, () =>
          durableBinding!.finishCancelled(finalError),
        )
        runSandboxTerminal = true
      }
      const log =
        finalError instanceof OperationCancelledError
          ? definition.logger.warn.bind(definition.logger)
          : definition.logger.error.bind(definition.logger)
      log('Harness workflow run failed.', {
        harness: definition.name,
        session_id: sessionId,
        run_id: runId,
        workflow_id: workflowId,
        error: serialized,
      })
      const runFinished: RunEvent = { type: 'run.finished', runId, at: finishedAt, error: serialized }
      await terminalizeFailedRun({
        kind: 'workflow',
        targetId: workflowId,
        sessionId,
        runId,
        primaryError: serialized,
        emitRunFinished: () => emit(runFinished),
        finishRun: () =>
          definition.storage.finishRun(runId, {
            status:
              finalError instanceof OperationCancelledError ? 'cancelled' : durableBinding ? 'interrupted' : 'failed',
            finishedAt,
            error: serialized,
          }),
        upsertSession: async () => {
          const sessionRecord = await requireSessionRecord(sessionId)
          await definition.storage.upsertSession(
            { ...sessionRecord, updatedAt: finishedAt, runCount: sessionRecord.runCount + 1 },
            'update',
          )
        },
      })
      throw finalError
    } finally {
      // Releases the lease for a non-cancel failure so a retry with the same run
      // id can resume; a no-op once the run was settled (success/cancel).
      if (closeRunSandbox) {
        try {
          await detachSandbox(runSandboxSession)
        } catch (error) {
          definition.logger.warn('Failed to close durable run sandbox.', {
            error_type: telemetryErrorType(error),
          })
        }
      }
      if (durableSandboxScope && runSandboxTerminal) {
        for (const partition of durableSandboxPartitions.values()) {
          const scope = sandboxScope(boundSession, 'run', { runId, partition })
          try {
            await terminateSandbox({ scope, reason: 'run_disposed' })
          } catch (error) {
            definition.logger.warn('Failed to terminate durable run sandbox.', {
              error_type: telemetryErrorType(error),
            })
          }
        }
      }
      if (durableBinding) await durableBinding.dispose()
      runSignal.cleanup()
      state.busy = false
    }
  }

  /** Pass-through step used when a workflow runs without durable execution. */
  function createExternalWaitFacade(args: {
    storage: HarnessStorage
    durable: DurableWorkflowBinding | undefined
    telemetry: TelemetryShim
    harnessName: string
    sessionId: string
    runId: string
    workflowId: string
    emit: (event: RunEvent) => Promise<void>
  }): { wait(request: ExternalWaitRequest): Promise<ExternalWaitResolved> } {
    return {
      wait: async (request) => {
        if (!args.durable) {
          throw new ExternalWaitError('External waits require a durable workflow invocation.', 'durable_required')
        }
        const validatedRequest = validateExternalWaitRequest(request)
        return args.telemetry.span(
          'harness.external_wait.wait',
          {
            'harness.name': args.harnessName,
            'harness.session.id': args.sessionId,
            'harness.run.id': args.runId,
            'harness.workflow.id': args.workflowId,
            'harness.external_wait.kind': validatedRequest.kind,
            'harness.external_wait.schema_version': validatedRequest.schemaVersion,
            'harness.external_wait.definition_version': validatedRequest.definitionVersion,
            'harness.external_wait.deadline_expired': Date.parse(validatedRequest.deadline) <= Date.now(),
          },
          async () => {
            const registration = validateExternalWaitRegistration(
              await args.storage.registerWait({
                ...validatedRequest,
                runId: args.runId,
                sessionId: args.sessionId,
              }),
            )
            assertExternalWaitSnapshotRequest(registration.snapshot, validatedRequest)
            const readback = await args.storage.getWait(validatedRequest.waitId)
            if (!readback)
              throw new ExternalWaitError('External wait adapter returned an invalid snapshot.', 'invalid_snapshot')
            const snapshot = validateExternalWaitSnapshot(readback)
            assertExternalWaitSnapshotRequest(snapshot, validatedRequest)
            if (registration.created) {
              await args.emit({
                type: 'external_wait.requested',
                runId: args.runId,
                at: now(),
                waitId: validatedRequest.waitId,
                kind: validatedRequest.kind,
                schemaVersion: validatedRequest.schemaVersion,
                definitionVersion: validatedRequest.definitionVersion,
                deadline: validatedRequest.deadline,
              })
            }
            if (snapshot.status === 'waiting') {
              await args.emit({
                type: 'external_wait.waiting',
                runId: args.runId,
                at: now(),
                waitId: snapshot.waitId,
                kind: snapshot.kind,
                deadline: snapshot.deadline,
              })
              throw new ExternalWaitPendingError(snapshot, args.runId)
            }
            const resolved = asExternalWaitResolved(snapshot)
            if (!resolved)
              throw new ExternalWaitError('External wait adapter returned an invalid snapshot.', 'invalid_snapshot')
            await args.emit({
              type: 'external_wait.resolved',
              runId: args.runId,
              at: now(),
              waitId: resolved.waitId,
              kind: resolved.kind,
              outcome: resolved.status,
              deadline: resolved.deadline,
            })
            args.telemetry.recordCounter('harness.external_wait.resolved', 1, {
              'harness.name': args.harnessName,
              'harness.workflow.id': args.workflowId,
              'harness.external_wait.kind': resolved.kind,
              'harness.external_wait.outcome': resolved.status,
            })
            return resolved
          },
        )
      },
    }
  }

  /** Pass-through step used when a workflow runs without durable execution. */
  function passthroughStep<T extends JsonValue>(
    _stepId: string,
    fn: () => Promise<T>,
    options: DurableStepOptions = {},
    signal?: AbortSignal,
  ): Promise<T> {
    return runStepWithRetry(fn, options.retry, signal)
  }

  /**
   * Starts a one-shot task in an isolated child execution context. The child
   * keeps the workflow's already-validated agent/model boundary, but receives
   * neither parent messages nor a shared sandbox session.
   */
  async function startChildTask(args: {
    sessionId: string
    parentRunId: string
    workflowId: string
    parentSandboxScope: SandboxScope
    agentId: string
    agentInput: unknown
    agent: AgentDefinition<S>
    options?: {
      idempotencyKey?: string
      timeoutMs?: number
      model?: string
      context?: 'isolated'
      sandbox?: SandboxPolicy
      mode?: 'one_shot' | 'continuable'
    }
    workflowPolicy: EffectiveDelegationPolicy
    delegationState: DelegationRunState
    parentSignal: AbortSignal
    parentDeadline: number
    durable: boolean
		onSandboxScope?: (scope: SandboxScope) => void
		metadata: Readonly<Record<string, JsonValue>>
		hostContext?: unknown
  }): Promise<ChildTaskHandle<JsonValue>> {
    if (args.parentSignal.aborted) throw abortError(args.parentSignal, 'run', 'Run was cancelled.')
    if (args.options?.context !== undefined && args.options.context !== 'isolated') {
      throw new ValidationError('Child-task context policy is invalid.', {
        where: 'invoke_options',
        issues: { context: args.options.context },
      })
    }
    if (args.options?.mode !== undefined && args.options.mode !== 'one_shot' && args.options.mode !== 'continuable') {
      throw new ValidationError('Child-task mode is invalid.', {
        where: 'invoke_options',
        issues: { mode: args.options.mode },
      })
    }
    if (
      args.options?.timeoutMs !== undefined &&
      (!Number.isFinite(args.options.timeoutMs) || args.options.timeoutMs < 0)
    ) {
      throw new ValidationError('Child-task timeout is invalid.', {
        where: 'invoke_options',
        issues: { timeoutMs: args.options.timeoutMs },
      })
    }
    if (args.options?.idempotencyKey !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(args.options.idempotencyKey)) {
      throw new ValidationError('Child-task idempotency key is invalid.', {
        where: 'invoke_options',
        issues: { idempotencyKey: args.options.idempotencyKey },
      })
    }
    if (args.durable && !args.options?.idempotencyKey) {
      throw new ValidationError('Durable child tasks require an idempotency key.', {
        where: 'invoke_options',
        issues: { reason: 'child_task_idempotency_key_required' },
      })
    }
    if (args.durable && args.options?.mode === 'continuable') {
      throw new ValidationError('Continuable child tasks are not available for durable workflow invocations.', {
        where: 'invoke_options',
        issues: { reason: 'durable_continuable_child_task_unsupported' },
      })
    }
    if (args.options?.model !== undefined && !(args.options.model in (definition.models as ModelsConfig))) {
      throw new ValidationError('Unknown model alias for child task.', {
        where: 'invoke_options',
        issues: { model: args.options.model },
      })
    }

    const modelAlias = args.options?.model ?? args.agent.model
    assertDelegationAllowed({
      policy: args.workflowPolicy,
      state: args.delegationState,
      workflowId: args.workflowId,
      agentId: args.agentId,
      ...(modelAlias ? { modelAlias } : {}),
      checkParallel: false,
    })
    args.delegationState.totalChildAgentCalls += 1

    // A durable caller supplies an idempotency key. Repeating its start after
    // a completed durable step returns the existing terminal task rather than
    // publishing a second external agent run.
    const taskId = args.options?.idempotencyKey
      ? `task_${args.parentRunId}_${args.options.idempotencyKey}`
      : `task_${ulid()}`
    const releaseStartLock = await acquireChildTaskStartLock(taskId)
    try {
      const local = childTasks.get(taskId)
      if (local) {
        args.delegationState.totalChildAgentCalls -= 1
        return childTaskHandle(local)
      }
      const existing = await definition.storage.getRun(taskId)
      if (existing) {
        args.delegationState.totalChildAgentCalls -= 1
        if (existing.status === 'running') {
          throw new ValidationError(
            'A durable child task is still running and is not resident in this harness instance.',
            {
              where: 'invoke_options',
              issues: { taskId, reason: 'child_task_recovery_required' },
            },
          )
        }
        const descriptor = await readChildTaskDescriptor(taskId, existing)
        return completedChildTaskHandle(descriptor, existing)
      }

      const controller = new AbortController()
      const parentAndTask = combineSignals(args.parentSignal, controller.signal, args.parentDeadline)
      const taskSignal =
        args.options?.timeoutMs !== undefined
          ? createRunSignal(parentAndTask.signal, args.options.timeoutMs, parentAndTask.deadline)
          : parentAndTask
      const createdAt = now()
      const descriptor: ChildTaskDescriptor = Object.freeze({
        id: taskId,
        parentRunId: args.parentRunId,
        sessionId: args.sessionId,
        workflowId: args.workflowId,
        agentId: args.agentId,
        ...(modelAlias ? { modelAlias } : {}),
        contextPolicy: 'isolated',
        mode: args.options?.mode ?? 'one_shot',
        createdAt,
      })
      await definition.storage.createRun({
        id: taskId,
        sessionId: args.sessionId,
        kind: 'child_task',
        target: args.agentId,
        startedAt: createdAt,
        status: 'running',
        input: args.agentInput as JsonValue,
      })

      if (descriptor.mode === 'continuable') {
        return startContinuableChildTask({
          ...args,
          taskId,
          descriptor,
          createdAt,
          controller,
          taskSignal,
          parentAndTask,
          ...(modelAlias ? { modelAlias } : {}),
        })
      }

      let live: LiveChildTask
      const emit = async (event: RunEvent): Promise<void> => {
        const eventAt = 'at' in event ? event.at : now()
        await appendEvents(taskId, [
          { id: ulid(), runId: taskId, at: eventAt, type: event.type, payload: sanitizeEventForPersistence(event) },
        ])
      }
      const settle = async (
        status: 'succeeded' | 'failed' | 'cancelled',
        error?: ReturnType<typeof serializeError>,
        output?: JsonValue,
      ): Promise<void> => {
        const finishedAt = now()
        live.snapshot = Object.freeze({ descriptor, status, finishedAt, ...(error ? { error } : {}) })
        await emit({
          type: 'child_task.settled',
          runId: taskId,
          taskId,
          at: finishedAt,
          parentRunId: args.parentRunId,
          workflowId: args.workflowId,
          agentId: args.agentId,
          status,
          ...(error ? { error } : {}),
        })
        await emit({
          type: 'run.finished',
          runId: taskId,
          at: finishedAt,
          ...(output !== undefined ? { output } : {}),
          ...(error ? { error } : {}),
        })
        await definition.storage.finishRun(taskId, {
          status,
          finishedAt,
          ...(output !== undefined ? { output } : {}),
          ...(error ? { error } : {}),
        })
      }
      const result = (async (): Promise<JsonValue> => {
        let taskSandbox: SandboxSessionBase | undefined
        let taskSandboxScope: SandboxScope | undefined
        let taskSandboxOwned = false
        let slotAcquired = false
        try {
          await emit({
            type: 'child_task.started',
            runId: taskId,
            taskId,
            at: createdAt,
            parentRunId: args.parentRunId,
            workflowId: args.workflowId,
            agentId: args.agentId,
            ...(modelAlias ? { modelAlias } : {}),
            contextPolicy: 'isolated',
            mode: 'one_shot',
          })
          await emit({ type: 'run.started', runId: taskId, at: createdAt })
          await acquireDelegationSlot(args.delegationState, args.workflowPolicy, taskSignal.signal)
          slotAcquired = true
          const childSession = await requireSessionRecord(args.sessionId)
          await authorizeBorrowedOwner(childSession)
          const selected = childTaskSandboxScope(
            childSession,
            args.parentSandboxScope,
            { kind: 'agent', id: args.agentId },
            args.options?.sandbox,
            args.agent.sandbox,
            taskId,
          )
          taskSandboxScope = selected.scope
          args.onSandboxScope?.(taskSandboxScope)
          taskSandboxOwned = selected.taskOwned
          const opened = await openSandbox({
            scope: taskSandboxScope,
            mode: 'create',
            ...(childSession.identity ? { identity: childSession.identity } : {}),
            signal: taskSignal.signal,
          })
          taskSandbox = opened.session as SandboxSessionBase
          const memory = memoryFacade({
            sessionId: args.sessionId,
            runId: taskId,
            workflowId: args.workflowId,
            agentId: args.agentId,
            signal: taskSignal.signal,
            sandboxSession: taskSandbox,
            ...(childSession.identity ? { identity: childSession.identity } : {}),
            metadata: args.metadata,
          })
          const contextProjection =
            (modelAlias ? definition.models[modelAlias]?.contextProjection : undefined) ??
            definition.defaults.contextProjection
          const run = await runDefaultAgent({
            harnessName: definition.name,
            agentId: args.agentId,
            runId: taskId,
            sessionId: args.sessionId,
            workflowId: args.workflowId,
            delegationCallId: taskId,
            delegationDepth: CHILD_DELEGATION_DEPTH,
            input: args.agentInput,
            // Isolation is intentional: do not fork raw parent history.
            history: [],
            agent: args.agent,
            ...(modelAlias ? { modelAlias } : {}),
            models: withRunEventModelRegistry(
              modelRegistry,
              {
                harnessName: definition.name,
                sessionId: args.sessionId,
                runId: taskId,
                workflowId: args.workflowId,
                agentId: args.agentId,
                ...(modelAlias ? { modelAlias } : {}),
              },
              emit,
            ),
            skills: resolvedSkills as Record<string, ResolvedSkill>,
            customTools: definition.tools as ToolsConfig,
            modelSchemas: {
              agentOutput: definition.modelSchemas.agentOutputs[args.agentId],
              toolInputs: definition.modelSchemas.toolInputs,
            },
            ...(definition.governance ? { governance: definition.governance as GovernanceConfig<any> } : {}),
            mcpRegistry,
            session: taskSandbox,
            sandboxKey: taskSandboxScope ? sandboxAttachmentKey(args.sessionId, taskSandboxScope) : args.sessionId,
            memory,
            mountedSkills: new Set<string>(),
            ...(contextProjection ? { contextProjection } : {}),
            maxSteps: definition.defaults.agentMaxIterations ?? 16,
            signal: taskSignal.signal,
            runDeadline: taskSignal.deadline,
            toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
            decisionTimeoutMs: definition.defaults.decisionTimeoutMs ?? 10_000,
            maxParallelToolCalls: definition.defaults.maxParallelToolCalls ?? 8,
            logger: definition.logger,
			telemetry,
			emitEvent: emit,
			metadata: args.metadata,
			...(args.hostContext !== undefined ? { hostContext: args.hostContext } : {}),
		  })
          await settle('succeeded', undefined, run.output as JsonValue)
          return run.output as JsonValue
        } catch (error) {
          const finalError = normalizeRunError(error, taskSignal.signal)
          const serialized = serializeError(finalError)
          await settle(finalError instanceof OperationCancelledError ? 'cancelled' : 'failed', serialized)
          throw finalError
        } finally {
          if (slotAcquired) releaseDelegationSlot(args.delegationState)
          taskSignal.cleanup()
          if (taskSignal !== parentAndTask) parentAndTask.cleanup()
          if (taskSandbox) {
            try {
              await detachSandbox(taskSandbox)
            } catch (error) {
              definition.logger.warn('Failed to close child-task sandbox.', { error_type: telemetryErrorType(error) })
            }
          }
          if (taskSandboxScope && taskSandboxOwned) {
            try {
              await terminateSandbox({ scope: taskSandboxScope, reason: 'run_disposed' })
            } catch (error) {
              definition.logger.warn('Failed to terminate child-task sandbox.', {
                error_type: telemetryErrorType(error),
              })
            }
          }
          childTasks.delete(taskId)
        }
      })()
      if (args.durable) {
        args.delegationState.checkpointBlockingChildTasks.add(result)
        result.finally(() => args.delegationState.checkpointBlockingChildTasks.delete(result)).catch(() => undefined)
      }
      live = {
        descriptor,
        controller,
        result,
        snapshot: Object.freeze({ descriptor, status: 'running' }),
        cancel: async (reason?: string) => {
          controller.abort(new OperationCancelledError('Child task was cancelled.', { scope: 'run' }, reason))
          await result.catch(() => undefined)
        },
      }
      childTasks.set(taskId, live)
      // Child tasks may intentionally outlive their starter workflow, so a
      // dropped handle must not surface an unhandled rejection.
      result.catch(() => undefined)
      return childTaskHandle(live)
    } finally {
      releaseStartLock()
    }
  }

  async function acquireChildTaskStartLock(taskId: string): Promise<() => void> {
    const previous = childTaskStartLocks.get(taskId) ?? Promise.resolve()
    let resolveCurrent!: () => void
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve
    })
    childTaskStartLocks.set(taskId, current)
    await previous
    let released = false
    return () => {
      if (released) return
      released = true
      resolveCurrent()
      if (childTaskStartLocks.get(taskId) === current) childTaskStartLocks.delete(taskId)
    }
  }

  function childTaskHandle(live: LiveChildTask): ChildTaskHandle<JsonValue> {
    return Object.freeze({
      id: live.descriptor.id,
      result: () => live.result,
      status: async () => live.snapshot,
      cancel: async (reason?: string) => live.cancel(reason),
    })
  }

  /**
   * Runs a task-owned conversation one turn at a time. It deliberately keeps
   * all history in the live task, never in the parent session's transcript.
   * This is an in-process continuable primitive, not a claim of recovery after
   * a process crash; durable workflows reject this mode at start time.
   */
  function startContinuableChildTask(args: {
    sessionId: string
    parentRunId: string
    workflowId: string
    agentId: string
    agentInput: unknown
    agent: AgentDefinition<S>
    options?: { sandbox?: SandboxPolicy }
    parentSandboxScope: SandboxScope
    workflowPolicy: EffectiveDelegationPolicy
		delegationState: DelegationRunState
		metadata: Readonly<Record<string, JsonValue>>
		hostContext?: unknown
		taskId: string
    descriptor: ChildTaskDescriptor
    createdAt: string
    controller: AbortController
    taskSignal: ReturnType<typeof combineSignals> | ReturnType<typeof createRunSignal>
    parentAndTask: ReturnType<typeof combineSignals>
    modelAlias?: string
  }): ChildTaskHandle<JsonValue> {
    const { taskId, descriptor, controller, taskSignal, parentAndTask, modelAlias } = args
    const history: Message[] = []
    let taskSandbox: SandboxSessionBase | undefined
    let taskSandboxScope: SandboxScope | undefined
    let taskSandboxOwned = false
    let settled = false
    let closing = false
    let lastOutput: JsonValue | undefined
    let terminalFailure: unknown
    let complete!: (value: JsonValue) => void
    let fail!: (error: unknown) => void
    const result = new Promise<JsonValue>((resolve, reject) => {
      complete = resolve
      fail = reject
    })
    let chain: Promise<unknown> = Promise.resolve()
    let live: LiveChildTask

    const emit = async (event: RunEvent): Promise<void> => {
      const eventAt = 'at' in event ? event.at : now()
      await appendEvents(taskId, [
        { id: ulid(), runId: taskId, at: eventAt, type: event.type, payload: sanitizeEventForPersistence(event) },
      ])
    }
    const cleanup = async (): Promise<void> => {
      taskSignal.cleanup()
      if (taskSignal !== parentAndTask) parentAndTask.cleanup()
      if (taskSandbox) {
        try {
          await detachSandbox(taskSandbox)
        } catch (error) {
          definition.logger.warn('Failed to close continuable child-task sandbox.', {
            error_type: telemetryErrorType(error),
          })
        }
        taskSandbox = undefined
      }
      if (taskSandboxScope && taskSandboxOwned) {
        try {
          await terminateSandbox({ scope: taskSandboxScope, reason: 'run_disposed' })
        } catch (error) {
          definition.logger.warn('Failed to terminate continuable child-task sandbox.', {
            error_type: telemetryErrorType(error),
          })
        }
        taskSandboxScope = undefined
      }
      childTasks.delete(taskId)
    }
    const settle = async (
      status: 'succeeded' | 'failed' | 'cancelled',
      error?: ReturnType<typeof serializeError>,
      output?: JsonValue,
    ): Promise<void> => {
      if (settled) return
      settled = true
      const finishedAt = now()
      live.snapshot = Object.freeze({ descriptor, status, finishedAt, ...(error ? { error } : {}) })
      await emit({
        type: 'child_task.settled',
        runId: taskId,
        taskId,
        at: finishedAt,
        parentRunId: args.parentRunId,
        workflowId: args.workflowId,
        agentId: args.agentId,
        status,
        ...(error ? { error } : {}),
      })
      await emit({
        type: 'run.finished',
        runId: taskId,
        at: finishedAt,
        ...(output !== undefined ? { output } : {}),
        ...(error ? { error } : {}),
      })
      await definition.storage.finishRun(taskId, {
        status,
        finishedAt,
        ...(output !== undefined ? { output } : {}),
        ...(error ? { error } : {}),
      })
      await cleanup()
      if (status === 'succeeded') complete(output ?? null)
      else
        fail(
          terminalFailure ??
            new InternalError('Continuable child task did not complete successfully.', {
              task_id: taskId,
              status,
              ...(error ? { error } : {}),
            }),
        )
    }
    const runTurn = async (input: unknown): Promise<JsonValue> => {
      if (settled)
        throw new ValidationError('Child task is already terminal.', {
          where: 'invoke_options',
          issues: { taskId, reason: 'child_task_terminal' },
        })
      let slotAcquired = false
      try {
        await acquireDelegationSlot(args.delegationState, args.workflowPolicy, taskSignal.signal)
        slotAcquired = true
        const childSession = await requireSessionRecord(args.sessionId)
        if (!taskSandbox) {
          await authorizeBorrowedOwner(childSession)
          const selected = childTaskSandboxScope(
            childSession,
            args.parentSandboxScope,
            { kind: 'agent', id: args.agentId },
            args.options?.sandbox,
            args.agent.sandbox,
            taskId,
          )
          taskSandboxScope = selected.scope
          taskSandboxOwned = selected.taskOwned
          const opened = await openSandbox({
            scope: taskSandboxScope,
            mode: 'create',
            ...(childSession.identity ? { identity: childSession.identity } : {}),
            signal: taskSignal.signal,
          })
          taskSandbox = opened.session as SandboxSessionBase
        }
        const memory = memoryFacade({
          sessionId: args.sessionId,
          runId: taskId,
          workflowId: args.workflowId,
          agentId: args.agentId,
          signal: taskSignal.signal,
          sandboxSession: taskSandbox,
          ...(childSession.identity ? { identity: childSession.identity } : {}),
          metadata: args.metadata,
        })
        const contextProjection =
          (modelAlias ? definition.models[modelAlias]?.contextProjection : undefined) ??
          definition.defaults.contextProjection
        const run = await runDefaultAgent({
          harnessName: definition.name,
          agentId: args.agentId,
          runId: taskId,
          sessionId: args.sessionId,
          workflowId: args.workflowId,
          delegationCallId: taskId,
          delegationDepth: CHILD_DELEGATION_DEPTH,
          input,
          history,
          agent: args.agent,
          ...(modelAlias ? { modelAlias } : {}),
          models: withRunEventModelRegistry(
            modelRegistry,
            {
              harnessName: definition.name,
              sessionId: args.sessionId,
              runId: taskId,
              workflowId: args.workflowId,
              agentId: args.agentId,
              ...(modelAlias ? { modelAlias } : {}),
            },
            emit,
          ),
          skills: resolvedSkills as Record<string, ResolvedSkill>,
          customTools: definition.tools as ToolsConfig,
          modelSchemas: {
            agentOutput: definition.modelSchemas.agentOutputs[args.agentId],
            toolInputs: definition.modelSchemas.toolInputs,
          },
          ...(definition.governance ? { governance: definition.governance as GovernanceConfig<any> } : {}),
          mcpRegistry,
          session: taskSandbox,
          sandboxKey: taskSandboxScope ? sandboxAttachmentKey(args.sessionId, taskSandboxScope) : args.sessionId,
          memory,
          mountedSkills: new Set<string>(),
          ...(contextProjection ? { contextProjection } : {}),
          maxSteps: definition.defaults.agentMaxIterations ?? 16,
          signal: taskSignal.signal,
          runDeadline: taskSignal.deadline,
          toolTimeoutMs: definition.defaults.toolTimeoutMs ?? 120_000,
          decisionTimeoutMs: definition.defaults.decisionTimeoutMs ?? 10_000,
          maxParallelToolCalls: definition.defaults.maxParallelToolCalls ?? 8,
          logger: definition.logger,
		  telemetry,
		  emitEvent: emit,
		  metadata: args.metadata,
		  ...(args.hostContext !== undefined ? { hostContext: args.hostContext } : {}),
		})
        // Continuable task history is private in-memory loop state. Preserve
        // its established user/assistant/tool shape; the run already emits
        // the current user exactly once, and rebuilt system instructions are
        // configuration rather than task history.
        history.push(...run.emitted.filter((message) => message.role !== 'system'))
        lastOutput = run.output as JsonValue
        return lastOutput
      } catch (error) {
        const finalError = normalizeRunError(error, taskSignal.signal)
        terminalFailure = finalError
        await settle(finalError instanceof OperationCancelledError ? 'cancelled' : 'failed', serializeError(finalError))
        throw finalError
      } finally {
        if (slotAcquired) releaseDelegationSlot(args.delegationState)
      }
    }
    const enqueue = (input: unknown): Promise<JsonValue> => {
      if (closing || settled) {
        return Promise.reject(
          new ValidationError('Child task is closing or already terminal.', {
            where: 'invoke_options',
            issues: { taskId, reason: closing ? 'child_task_closing' : 'child_task_terminal' },
          }),
        )
      }
      const next = chain.then(() => runTurn(input)) as Promise<JsonValue>
      chain = next.catch(() => undefined)
      return next
    }
    const close = async (): Promise<JsonValue | undefined> => {
      closing = true
      await chain
      if (!settled) await settle('succeeded', undefined, lastOutput)
      return await result
    }
    const cancel = async (reason?: string): Promise<void> => {
      closing = true
      controller.abort(new OperationCancelledError('Child task was cancelled.', { scope: 'run' }, reason))
      await chain
      if (!settled) {
        terminalFailure = abortError(taskSignal.signal, 'run', 'Child task was cancelled.')
        await settle('cancelled', serializeError(terminalFailure))
      }
      await result.catch(() => undefined)
    }
    live = {
      descriptor,
      controller,
      result,
      snapshot: Object.freeze({ descriptor, status: 'running' }),
      cancel,
    }
    childTasks.set(taskId, live)
    result.catch(() => undefined)
    const initial = (async () => {
      await emit({
        type: 'child_task.started',
        runId: taskId,
        taskId,
        at: args.createdAt,
        parentRunId: args.parentRunId,
        workflowId: args.workflowId,
        agentId: args.agentId,
        ...(modelAlias ? { modelAlias } : {}),
        contextPolicy: 'isolated',
        mode: 'continuable',
      })
      await emit({ type: 'run.started', runId: taskId, at: args.createdAt })
      return await runTurn(args.agentInput)
    })()
    chain = initial.catch(() => undefined)
    return Object.freeze({
      id: taskId,
      result: () => result,
      status: async () => live.snapshot,
      cancel,
      send: (input: unknown) => enqueue(input),
      close,
    })
  }

  async function readChildTaskDescriptor(taskId: string, record: RunRecord): Promise<ChildTaskDescriptor> {
    const events = await definition.storage.listEvents(taskId, { limit: 1 })
    const started = events.find((event) => event.type === 'child_task.started')
    const payload = started?.payload
    if (
      isJsonRecord(payload) &&
      typeof payload['parentRunId'] === 'string' &&
      typeof payload['workflowId'] === 'string' &&
      typeof payload['agentId'] === 'string' &&
      typeof payload['modelAlias'] === 'string'
    ) {
      return Object.freeze({
        id: taskId,
        parentRunId: payload['parentRunId'],
        sessionId: record.sessionId,
        workflowId: payload['workflowId'],
        agentId: payload['agentId'],
        modelAlias: payload['modelAlias'],
        contextPolicy: 'isolated',
        mode: payload['mode'] === 'continuable' ? 'continuable' : 'one_shot',
        createdAt: record.startedAt,
      })
    }
    throw new ValidationError('Stored child-task descriptor is invalid.', {
      where: 'invoke_options',
      issues: { taskId, reason: 'invalid_child_task_descriptor' },
    })
  }

  function completedChildTaskHandle(descriptor: ChildTaskDescriptor, record: RunRecord): ChildTaskHandle<JsonValue> {
    const error = record.error ? normalizeSerializedRunError(record.error) : undefined
    const snapshot: ChildTaskStatus = Object.freeze({
      descriptor,
      status: record.status as ChildTaskStatus['status'],
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(error ? { error } : {}),
    })
    return Object.freeze({
      id: descriptor.id,
      result: async () => {
        if (record.status === 'succeeded') return record.output as JsonValue
        throw new InternalError('Child task did not complete successfully.', {
          task_id: descriptor.id,
          status: record.status,
          ...(error ? { error } : {}),
        })
      },
      status: async () => snapshot,
      cancel: async () => undefined,
    })
  }

  async function getSessionChildTask(
    sessionId: string,
    taskId: string,
  ): Promise<ChildTaskHandle<JsonValue> | undefined> {
    const live = childTasks.get(taskId)
    if (live && live.descriptor.sessionId === sessionId) return childTaskHandle(live)
    const record = await definition.storage.getRun(taskId)
    if (!record || record.sessionId !== sessionId || record.kind !== 'child_task') return undefined
    const descriptor = await readChildTaskDescriptor(taskId, record)
    if (record.status !== 'running') return completedChildTaskHandle(descriptor, record)
    const unavailable = new ValidationError('Child task is not resident in this harness instance.', {
      where: 'invoke_options',
      issues: { taskId, reason: 'child_task_recovery_required' },
    })
    const snapshot: ChildTaskStatus = Object.freeze({ descriptor, status: 'running' })
    return Object.freeze({
      id: taskId,
      result: async () => {
        throw unavailable
      },
      status: async () => snapshot,
      cancel: async () => {
        throw unavailable
      },
    })
  }

  async function listSessionChildTasks(
    sessionId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<readonly ChildTaskStatus[]> {
    const records = await definition.storage.listRuns(sessionId, opts)
    const childRecords = records.filter((record) => record.kind === 'child_task')
    return await Promise.all(
      childRecords.map(async (record) => {
        const live = childTasks.get(record.id)
        if (live && live.descriptor.sessionId === sessionId) return live.snapshot
        const descriptor = await readChildTaskDescriptor(record.id, record)
        const error = record.error ? normalizeSerializedRunError(record.error) : undefined
        return Object.freeze({
          descriptor,
          status: record.status as ChildTaskStatus['status'],
          ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
          ...(error ? { error } : {}),
        })
      }),
    )
  }

  function resolveDelegationPolicy(workflow: WorkflowDefinition<S>): EffectiveDelegationPolicy {
    const configured = workflow.delegation as WorkflowDelegationPolicy<S> | undefined
    const policy = configured ?? {}
    const enabled = configured ? policy.enabled !== false : definition.defaults.delegation?.enabled === true
    return {
      enabled,
      ...(policy.agents ? { allowedAgents: new Set(policy.agents as readonly string[]) } : {}),
      maxChildAgentCalls:
        policy.maxChildAgentCalls ??
        definition.defaults.delegation?.maxChildAgentCalls ??
        DEFAULT_MAX_CHILD_AGENT_CALLS,
      maxParallelChildAgentCalls:
        policy.maxParallelChildAgentCalls ??
        definition.defaults.delegation?.maxParallelChildAgentCalls ??
        DEFAULT_MAX_PARALLEL_CHILD_AGENT_CALLS,
      maxDepth: policy.maxDepth ?? definition.defaults.delegation?.maxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH,
      ...(policy.modelAliases ? { modelAliases: new Set(policy.modelAliases as readonly string[]) } : {}),
      agentModelAliases: new Map(
        Object.entries(policy.agentModelAliases ?? {}).map(([agentId, aliases]) => [
          agentId,
          new Set(aliases as readonly string[]),
        ]),
      ),
    }
  }

  /**
   * Background task turns queue behind the same per-workflow child-agent
   * ceiling used by direct `ctx.agents.*` calls. They reserve their total-call
   * budget at creation, but consume an active slot only while actually running.
   */
  async function acquireDelegationSlot(
    state: DelegationRunState,
    policy: EffectiveDelegationPolicy,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw abortError(signal, 'run', 'Child task was cancelled before execution.')
    if (state.activeChildAgentCalls < policy.maxParallelChildAgentCalls) {
      state.activeChildAgentCalls += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        resolve: () => {
          waiter.cleanup()
          resolve()
        },
        reject: (error: unknown) => {
          waiter.cleanup()
          reject(error)
        },
        cleanup: () => {
          signal.removeEventListener('abort', onAbort)
          const index = state.slotWaiters.indexOf(waiter)
          if (index >= 0) state.slotWaiters.splice(index, 1)
        },
      }
      const onAbort = () => waiter.reject(abortError(signal, 'run', 'Child task was cancelled while queued.'))
      signal.addEventListener('abort', onAbort, { once: true })
      state.slotWaiters.push(waiter)
    })
  }

  function releaseDelegationSlot(state: DelegationRunState): void {
    state.activeChildAgentCalls = Math.max(0, state.activeChildAgentCalls - 1)
    while (state.activeChildAgentCalls < Number.MAX_SAFE_INTEGER && state.slotWaiters.length > 0) {
      const waiter = state.slotWaiters.shift()
      if (!waiter || waiter.signal.aborted) continue
      state.activeChildAgentCalls += 1
      waiter.resolve()
      return
    }
  }

  function assertDelegationAllowed(args: {
    policy: EffectiveDelegationPolicy
    state: DelegationRunState
    workflowId: string
    agentId: string
    modelAlias?: string
    checkParallel?: boolean
  }): void {
    const { policy, state, workflowId, agentId, modelAlias } = args
    if (!policy.enabled) {
      throw new DelegationPolicyError('Workflow child-agent delegation is disabled.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'delegation_disabled',
      })
    }
    if (policy.allowedAgents && !policy.allowedAgents.has(agentId)) {
      throw new DelegationPolicyError('Workflow is not allowed to invoke this child agent.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'agent_not_allowed',
      })
    }
    if (CHILD_DELEGATION_DEPTH > policy.maxDepth) {
      throw new DelegationPolicyError('Workflow child-agent delegation depth exceeded.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'max_delegation_depth_exceeded',
        limit: policy.maxDepth,
      })
    }
    if (state.totalChildAgentCalls >= policy.maxChildAgentCalls) {
      throw new DelegationPolicyError('Workflow child-agent call budget exceeded.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'max_child_agent_calls_exceeded',
        limit: policy.maxChildAgentCalls,
      })
    }
    if (args.checkParallel !== false && state.activeChildAgentCalls >= policy.maxParallelChildAgentCalls) {
      throw new DelegationPolicyError('Workflow parallel child-agent call budget exceeded.', {
        workflow_id: workflowId,
        agent_id: agentId,
        reason: 'max_parallel_child_agent_calls_exceeded',
        limit: policy.maxParallelChildAgentCalls,
      })
    }
    const allowedModels = policy.agentModelAliases.get(agentId) ?? policy.modelAliases
    if (modelAlias && allowedModels && !allowedModels.has(modelAlias)) {
      throw new DelegationPolicyError(
        'Workflow is not allowed to invoke this child agent with the selected model alias.',
        {
          workflow_id: workflowId,
          agent_id: agentId,
          reason: 'model_alias_not_allowed',
          model_alias: modelAlias,
        },
      )
    }
  }

  /**
   * Runs a durable finalization side effect (runtime finish / workspace lifecycle)
   * without ever masking the primary run outcome (spec 21 §16.1 step 7).
   */
  async function guardDurableStep(
    args: { sessionId: string; runId: string; workflowId: string; operation: string },
    step: () => Promise<void>,
  ): Promise<void> {
    try {
      await step()
    } catch (error) {
      telemetry.recordCounter('harness.runs.durable_errors', 1, {
        harness: definition.name,
        'harness.run.durable.operation': args.operation,
      })
      definition.logger.error('Durable finalization step failed; preserving run outcome.', {
        harness: definition.name,
        session_id: args.sessionId,
        run_id: args.runId,
        workflow_id: args.workflowId,
        operation: args.operation,
        error: serializeError(error),
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
    step: () => Promise<void>,
  ): Promise<void> {
    try {
      await step()
    } catch (error) {
      telemetry.recordCounter('harness.runs.terminalization_errors', 1, {
        harness: definition.name,
        'harness.run.kind': args.kind,
        'harness.run.terminalization.operation': operation,
      })
      definition.logger.error('Failed to terminalize failed run; preserving primary run error.', {
        harness: definition.name,
        session_id: args.sessionId,
        run_id: args.runId,
        [`${args.kind}_id`]: args.targetId,
        operation,
        primary_error: args.primaryError,
        error: serializeError(error),
      })
    }
  }
}

function sameLogicalMessage(left: Message, right: Message): boolean {
  // Timestamps are observability metadata, not logical transcript identity.
  // Retried delivery regenerates them while retaining the same stable id and
  // canonical message content.
  const { timestamp: _leftTimestamp, ...leftLogical } = left
  const { timestamp: _rightTimestamp, ...rightLogical } = right
  return JSON.stringify(leftLogical) === JSON.stringify(rightLogical)
}

function withRunEventModelRegistry<M extends Record<string, unknown>>(
  models: M,
  context: ModelRunContext,
  emitEvent: (event: RunEvent) => Promise<void>,
): M {
  return Object.fromEntries(
    Object.entries(models).map(([alias, handle]) => [
      alias,
      withRunEventModelHandle(alias, handle, context, emitEvent),
    ]),
  ) as M
}

function withRunEventModelHandle(
  alias: string,
  handle: unknown,
  context: ModelRunContext,
  emitEvent: (event: RunEvent) => Promise<void>,
): unknown {
  if (!handle || typeof handle !== 'object') return handle
  const source = handle as Record<string, unknown>
  const wrapped: Record<string, unknown> = { ...source }

  const text = source['text']
  if (typeof text === 'function') {
    wrapped['text'] = async (req: unknown, signal: AbortSignal, ctx?: Partial<ModelRunContext>) => {
      const runContext = mergeModelRunContext(context, ctx)
      const response = (await text.call(source, req, signal, runContext)) as {
        usage?: TokenUsage
        finishReason?: FinishReason
      }
      await emitModelCompleted(emitEvent, context, alias, 'text', response)
      return response
    }
  }

  const object = source['object']
  if (typeof object === 'function') {
    wrapped['object'] = async (req: unknown, signal: AbortSignal, ctx?: Partial<ModelRunContext>) => {
      const runContext = mergeModelRunContext(context, ctx)
      const response = (await object.call(source, req, signal, runContext)) as { object: JsonValue; usage?: TokenUsage }
      await emitModelCompleted(emitEvent, context, alias, 'object', response)
      return response
    }
  }

  const embed = source['embed']
  if (typeof embed === 'function') {
    wrapped['embed'] = async (req: unknown, signal: AbortSignal, ctx?: Partial<ModelRunContext>) => {
      const runContext = mergeModelRunContext(context, ctx)
      const response = (await embed.call(source, req, signal, runContext)) as {
        embeddings: readonly { vector: readonly number[] }[]
        usage?: TokenUsage
      }
      if (runContext.emitRunEvents === true) {
        await emitEvent({
          type: 'model.embedding.completed',
          runId: context.runId,
          ...(context.agentId ? { agentId: context.agentId } : {}),
          count: response.embeddings.length,
          ...(response.embeddings[0] ? { dimensions: response.embeddings[0].vector.length } : {}),
          ...(response.usage ? { usage: response.usage } : {}),
        })
      }
      return response
    }
  }

  const rerank = source['rerank']
  if (typeof rerank === 'function') {
    wrapped['rerank'] = async (req: unknown, signal: AbortSignal, ctx?: Partial<ModelRunContext>) => {
      const runContext = mergeModelRunContext(context, ctx)
      const response = (await rerank.call(source, req, signal, runContext)) as {
        results: readonly unknown[]
        usage?: TokenUsage
      }
      if (runContext.emitRunEvents === true) {
        await emitEvent({
          type: 'model.rerank.completed',
          runId: context.runId,
          ...(context.agentId ? { agentId: context.agentId } : {}),
          count: response.results.length,
          ...(isRerankRequest(req) && req.topN !== undefined ? { topN: req.topN } : {}),
          ...(response.usage ? { usage: response.usage } : {}),
        })
      }
      return response
    }
  }

  const textStream = source['textStream']
  if (typeof textStream === 'function') {
    wrapped['textStream'] = (req: unknown, signal: AbortSignal, ctx?: Partial<ModelRunContext>) => {
      const streamContext = modelStreamRunContext(context, ctx, alias)
      return emitTextStreamRunEvents(
        textStream.call(source, req, signal, streamContext) as AsyncIterable<unknown>,
        streamContext,
        emitEvent,
        signal,
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
        emitEvent,
        signal,
      )
    }
  }

  return wrapped
}

function mergeModelRunContext(
  context: ModelRunContext,
  override: Partial<ModelRunContext> | undefined,
): ModelRunContext {
  // Invocation context is public on model handles, but run identity belongs to
  // the enclosing session. Custom handlers may opt into events; they cannot
  // relabel another run, agent, or workflow.
  return {
    ...context,
    ...(override?.emitRunEvents === true ? { emitRunEvents: true } : {}),
  }
}

function isRerankRequest(value: unknown): value is { topN?: number } {
  return value !== null && typeof value === 'object'
}

function modelStreamRunContext(
  context: ModelRunContext,
  override: Partial<ModelRunContext> | undefined,
  alias: string,
): ModelRunContext {
  const merged = mergeModelRunContext(context, override)
  return {
    ...merged,
    modelAlias: alias,
    streamId: `model_${ulid()}`,
  }
}

async function* emitTextStreamRunEvents(
  stream: AsyncIterable<unknown>,
  context: ModelRunContext,
  emitEvent: (event: RunEvent) => Promise<void>,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  for await (const chunk of withSuccessfulStreamFinish(stream, signal)) {
    if (context.emitRunEvents === true && isTextDeltaChunk(chunk)) {
      await emitEvent({
        type: 'model.delta',
        runId: context.runId,
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        ...(context.modelAlias ? { modelAlias: context.modelAlias } : {}),
        streamId: context.streamId!,
        delta: chunk.text,
      })
    } else if (isTextFinishChunk(chunk)) {
      await emitModelCompleted(emitEvent, context, context.modelAlias!, 'textStream', chunk)
    }
    yield chunk
  }
}

async function* emitObjectStreamRunEvents(
  stream: AsyncIterable<unknown>,
  context: ModelRunContext,
  emitEvent: (event: RunEvent) => Promise<void>,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  for await (const chunk of withSuccessfulStreamFinish(stream, signal)) {
    if (context.emitRunEvents === true && isObjectPartialChunk(chunk)) {
      await emitEvent({
        type: 'model.object.partial',
        runId: context.runId,
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        ...(context.modelAlias ? { modelAlias: context.modelAlias } : {}),
        streamId: context.streamId!,
        partial: chunk.partial,
      })
    } else if (isTextFinishChunk(chunk)) {
      if (!isObjectFinishChunk(chunk)) throw invalidModelCompletion()
      await emitModelCompleted(emitEvent, context, context.modelAlias!, 'objectStream', chunk)
      if (context.emitRunEvents !== true) {
        yield chunk
        continue
      }
      await emitEvent({
        type: 'model.object',
        runId: context.runId,
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.workflowId ? { workflowId: context.workflowId } : {}),
        ...(context.modelAlias ? { modelAlias: context.modelAlias } : {}),
        ...(context.streamId ? { streamId: context.streamId } : {}),
        object: chunk.object,
      })
    }
    yield chunk
  }
}

/** Delay the terminal chunk until the source has successfully exhausted. */
async function* withSuccessfulStreamFinish(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  let finish: { kind: 'finish' } | undefined
  for await (const chunk of stream) {
    if (signal.aborted) throw abortError(signal, 'model', 'Model stream was cancelled.')
    if (finish) {
      throw new ValidationError('Model stream emitted a chunk after its finish.', {
        where: 'model_response',
        issues: [{ code: 'invalid_stream_completion' }],
      })
    }
    if (isTextFinishChunk(chunk)) finish = chunk
    else yield chunk
  }
  if (signal.aborted) throw abortError(signal, 'model', 'Model stream was cancelled.')
  if (finish) yield finish
}

function isTextDeltaChunk(chunk: unknown): chunk is { kind: 'delta'; text: string } {
  return Boolean(
    chunk &&
      typeof chunk === 'object' &&
      (chunk as { kind?: unknown }).kind === 'delta' &&
      typeof (chunk as { text?: unknown }).text === 'string',
  )
}

function isTextFinishChunk(
  chunk: unknown,
): chunk is { kind: 'finish'; usage?: TokenUsage; finishReason?: FinishReason } {
  return Boolean(chunk && typeof chunk === 'object' && (chunk as { kind?: unknown }).kind === 'finish')
}

function isObjectPartialChunk(chunk: unknown): chunk is { kind: 'partial'; partial: JsonValue } {
  return Boolean(chunk && typeof chunk === 'object' && (chunk as { kind?: unknown }).kind === 'partial')
}

function isObjectFinishChunk(chunk: unknown): chunk is { kind: 'finish'; object: JsonValue; usage?: TokenUsage } {
  if (!isTextFinishChunk(chunk)) return false
  // Inspect the own data property without invoking an adapter-supplied getter.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(chunk, 'object')
    return Boolean(descriptor && 'value' in descriptor && isJsonValue(descriptor.value))
  } catch {
    return false
  }
}

const modelCompletionMetadataSchema = z.object({
  usage: tokenUsageSchema.optional(),
  finishReason: finishReasonSchema.optional(),
})

function invalidModelCompletion(): ValidationError {
  return new ValidationError('Model completion is invalid.', {
    where: 'model_response',
    issues: [{ code: 'invalid_model_completion' }],
  })
}

async function emitModelCompleted(
  emitEvent: (event: RunEvent) => Promise<void>,
  context: ModelRunContext,
  alias: string,
  operation: 'text' | 'object' | 'textStream' | 'objectStream',
  response: unknown,
): Promise<void> {
  let metadata: z.infer<typeof modelCompletionMetadataSchema>
  try {
    metadata = modelCompletionMetadataSchema.parse(response)
  } catch {
    // Never preserve parser details or adapter-thrown accessor errors as content metadata.
    throw invalidModelCompletion()
  }
  await emitEvent({
    type: 'model.completed',
    runId: context.runId,
    ...(context.agentId ? { agentId: context.agentId } : {}),
    ...(context.workflowId ? { workflowId: context.workflowId } : {}),
    modelAlias: alias,
    operation,
    ...(operation.endsWith('Stream') && context.streamId ? { streamId: context.streamId } : {}),
    ...(metadata.usage ? { usage: metadata.usage } : {}),
    ...(metadata.finishReason ? { finishReason: metadata.finishReason } : {}),
  })
}

function configureHarnessAdapters<S extends BuilderState>(
  context: HarnessAdapterContext,
  models: ModelsConfig,
  storage: HarnessStorage,
  sandbox: Sandbox,
  memory: MemoryEngine,
  tools: ToolsConfig,
  workspace: DurableWorkspace | undefined,
  governance: GovernanceConfig<S> | undefined,
): void {
  const seen = new Set<unknown>()
  for (const alias of Object.values(models)) {
    configureOne(alias.provider, context, seen)
  }
  configureOne(storage, context, seen)
  configureOne(sandbox, context, seen)
  configureOne(memory, context, seen)
  configureOne(workspace, context, seen)
  for (const policy of governance?.policies ?? []) {
    if (!('kind' in policy) || policy.kind !== 'native') configureOne(policy, context, seen)
  }
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
    span: (name, attrs, fn) =>
      telemetry.span(name, filterTelemetryAttrs(attrs, flavor), (span) => fn(filterSpanAttrs(span, flavor))),
    recordHistogram: (name, value, attrs) =>
      telemetry.recordHistogram(name, value, filterTelemetryAttrs(attrs, flavor)),
    recordCounter: (name, value, attrs) => telemetry.recordCounter(name, value, filterTelemetryAttrs(attrs, flavor)),
    currentTraceparent: () => telemetry.currentTraceparent(),
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
  fn: () => Promise<T>,
): Promise<T> {
  if (!opts?.traceparent) return fn()
  if (!isValidTraceparent(opts.traceparent) || (opts.tracestate !== undefined && !isValidTracestate(opts.tracestate))) {
    logger.warn('Invalid Trace Context ignored.', {
      'harness.warning.code': 'INVALID_TRACE_CONTEXT',
      traceparent: opts.traceparent,
      tracestate: opts.tracestate,
    })
    return fn()
  }
  return (
    telemetry.withTraceContext?.(
      { traceparent: opts.traceparent, ...(opts.tracestate ? { tracestate: opts.tracestate } : {}) },
      fn,
    ) ?? fn()
  )
}

function resolveContentCaptureMode(options: TelemetryOptions | undefined): ContentCaptureMode {
  if (options?.contentCaptureMode !== undefined) return options.contentCaptureMode
  const envValue = process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']
  if (envValue === 'true') return 'SPAN_AND_EVENT'
  if (envValue === 'false') return 'NO_CONTENT'
  if (
    envValue === 'NO_CONTENT' ||
    envValue === 'SPAN_ONLY' ||
    envValue === 'EVENT_ONLY' ||
    envValue === 'SPAN_AND_EVENT'
  )
    return envValue
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

function filterSpanAttrs(
  span: Parameters<TelemetryShim['span']>[2] extends (span: infer S) => Promise<unknown> ? S : never,
  flavor: string,
): typeof span {
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
    },
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
  return (
    key === 'openinference.span.kind' ||
    key.startsWith('llm.') ||
    key.startsWith('tool.') ||
    key.startsWith('retrieval.') ||
    key.startsWith('embedding.') ||
    key.startsWith('reranker.') ||
    key.startsWith('guardrail.') ||
    key.startsWith('evaluator.') ||
    key === 'input.value' ||
    key === 'output.value'
  )
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
        ...(event.error ? { error: event.error } : {}),
      } as unknown as JsonValue
    case 'fanout.started':
      return { batchId: event.batchId, count: event.count, concurrency: event.concurrency }
    case 'fanout.finished':
      return { batchId: event.batchId, count: event.count, status: event.status }
    case 'child_task.started':
      return {
        taskId: event.taskId,
        parentRunId: event.parentRunId,
        workflowId: event.workflowId,
        agentId: event.agentId,
        ...(event.modelAlias ? { modelAlias: event.modelAlias } : {}),
        contextPolicy: event.contextPolicy,
        mode: event.mode,
      }
    case 'child_task.settled':
      return {
        taskId: event.taskId,
        parentRunId: event.parentRunId,
        workflowId: event.workflowId,
        agentId: event.agentId,
        status: event.status,
        ...(event.error ? { error: event.error } : {}),
      } as unknown as JsonValue
    case 'agent.started':
      return agentRunEventMeta(event)
    case 'agent.finished':
      return {
        ...agentRunEventMeta(event),
        ...(event.output !== undefined ? { output: '[redacted]' } : {}),
        ...(event.error ? { error: event.error } : {}),
      } as unknown as JsonValue
    case 'tool.started':
      return { agentId: event.agentId, toolId: event.toolId, callId: event.callId, input: '[redacted]' }
    case 'tool.finished':
      return {
        agentId: event.agentId,
        toolId: event.toolId,
        callId: event.callId,
        ...(event.output !== undefined ? { output: '[redacted]' } : {}),
        ...(event.error ? { error: event.error } : {}),
      } as unknown as JsonValue
    case 'model.message':
      return { agentId: event.agentId, message: '[redacted]' }
    case 'model.delta':
      return { ...modelStreamEventMeta(event), delta: '[redacted]' }
    case 'policy.evaluated':
      return {
        agentId: event.agentId,
        invocationId: event.invocationId,
        toolId: event.toolId,
        callId: event.callId,
        step: event.step,
        evidence: event.evidence,
        effect: event.effect,
        enforced: event.enforced,
      } as unknown as JsonValue
    case 'policy.exposure':
      return {
        agentId: event.agentId,
        invocationId: event.invocationId,
        toolId: event.toolId,
        evidence: event.evidence,
        effect: event.effect,
        enforced: event.enforced,
        step: event.step,
      } as unknown as JsonValue
    case 'approval.requested':
      return {
        agentId: event.agentId,
        invocationId: event.invocationId,
        toolId: event.toolId,
        callId: event.callId,
        step: event.step,
        approvalId: event.approvalId,
        demands: event.demands,
      } as unknown as JsonValue
    case 'approval.finished':
      return {
        agentId: event.agentId,
        invocationId: event.invocationId,
        toolId: event.toolId,
        callId: event.callId,
        step: event.step,
        approvalId: event.approvalId,
        outcome: event.outcome,
        ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      } as unknown as JsonValue
    case 'external_wait.requested':
      return {
        waitId: event.waitId,
        kind: event.kind,
        schemaVersion: event.schemaVersion,
        definitionVersion: event.definitionVersion,
        deadline: event.deadline,
      }
    case 'external_wait.waiting':
      return { waitId: event.waitId, kind: event.kind, deadline: event.deadline }
    case 'external_wait.resolved':
      return { waitId: event.waitId, kind: event.kind, outcome: event.outcome, deadline: event.deadline }
    case 'model.object.partial':
      return { ...modelStreamEventMeta(event), partial: '[redacted]' }
    case 'model.completed':
      return {
        ...(event.agentId ? { agentId: event.agentId } : {}),
        ...(event.workflowId ? { workflowId: event.workflowId } : {}),
        modelAlias: event.modelAlias,
        operation: event.operation,
        ...(event.streamId ? { streamId: event.streamId } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
        ...(event.finishReason ? { finishReason: event.finishReason } : {}),
      } as unknown as JsonValue
    case 'model.object':
      return {
        ...modelStreamEventMeta(event),
        object: '[redacted]',
      } as unknown as JsonValue
    case 'model.embedding.completed':
      return {
        ...(event.agentId ? { agentId: event.agentId } : {}),
        count: event.count,
        ...(event.dimensions !== undefined ? { dimensions: event.dimensions } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
      } as unknown as JsonValue
    case 'model.rerank.completed':
      return {
        ...(event.agentId ? { agentId: event.agentId } : {}),
        count: event.count,
        ...(event.topN !== undefined ? { topN: event.topN } : {}),
        ...(event.usage ? { usage: event.usage } : {}),
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

function modelStreamEventMeta(
  event: Extract<RunEvent, { type: 'model.delta' | 'model.object.partial' | 'model.object' }>,
): Record<string, string> {
  return {
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.workflowId ? { workflowId: event.workflowId } : {}),
    ...(event.modelAlias ? { modelAlias: event.modelAlias } : {}),
    ...(event.streamId ? { streamId: event.streamId } : {}),
  }
}

function agentRunEventMeta(
  event: Extract<RunEvent, { type: 'agent.started' | 'agent.finished' }>,
): Record<string, JsonValue> {
  return {
    agentId: event.agentId,
    ...(event.workflowId ? { workflowId: event.workflowId } : {}),
    ...(event.parentAgentId ? { parentAgentId: event.parentAgentId } : {}),
    ...(event.delegationCallId ? { delegationCallId: event.delegationCallId } : {}),
    ...(event.delegationDepth !== undefined ? { delegationDepth: event.delegationDepth } : {}),
    ...(event.modelAlias ? { modelAlias: event.modelAlias } : {}),
  }
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isTokenUsage(value: unknown): value is TokenUsage {
  return (
    isJsonRecord(value) &&
    typeof value['inputTokens'] === 'number' &&
    typeof value['outputTokens'] === 'number' &&
    typeof value['totalTokens'] === 'number'
  )
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
    ...(error?.meta ? { meta: error.meta } : {}),
  }
}

function createRunSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
  parentDeadline = Number.POSITIVE_INFINITY,
): { signal: AbortSignal; deadline: number; cleanup: () => void; abort: (reason: unknown) => void } {
  const controller = new AbortController()
  const startedAt = Date.now()
  const deadline = Math.min(
    parentDeadline,
    timeoutMs && timeoutMs > 0 ? startedAt + timeoutMs : Number.POSITIVE_INFINITY,
  )
  const relay = () => controller.abort(runAbortReason(parent?.reason))
  if (parent) parent.addEventListener('abort', relay, { once: true })
  if (parent?.aborted) relay()
  const timeout =
    timeoutMs && timeoutMs > 0
      ? setTimeout(
          () => controller.abort(new OperationTimeoutError('Run timed out.', { scope: 'run', timeout_ms: timeoutMs })),
          timeoutMs,
        )
      : undefined
  return {
    signal: controller.signal,
    deadline,
    /** Harness-initiated abort, e.g. to cancel in-flight child-agent calls. */
    abort: (reason: unknown) => controller.abort(runAbortReason(reason)),
    cleanup: () => {
      if (timeout) clearTimeout(timeout)
      if (parent) parent.removeEventListener('abort', relay)
    },
  }
}

function combineSignals(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
  deadline = Number.POSITIVE_INFINITY,
): { signal: AbortSignal; deadline: number; cleanup: () => void } {
  if (!secondary) return { signal: primary, deadline, cleanup: () => undefined }
  const controller = new AbortController()
  const relayPrimary = () => controller.abort(runAbortReason(primary.reason))
  const relaySecondary = () => controller.abort(runAbortReason(secondary.reason))
  primary.addEventListener('abort', relayPrimary, { once: true })
  secondary.addEventListener('abort', relaySecondary, { once: true })
  if (primary.aborted) relayPrimary()
  else if (secondary.aborted) relaySecondary()
  return {
    signal: controller.signal,
    deadline,
    cleanup: () => {
      primary.removeEventListener('abort', relayPrimary)
      secondary.removeEventListener('abort', relaySecondary)
    },
  }
}

function runAbortReason(reason: unknown): unknown {
  if (reason instanceof OperationCancelledError || reason instanceof OperationTimeoutError) return reason
  return new OperationCancelledError('Run was cancelled.', { scope: 'run' }, reason)
}
