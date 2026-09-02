import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
} from '@opentelemetry/semantic-conventions/incubating'
import { createHash } from 'node:crypto'
import { ToolApprovalPendingError, type ToolApprovalDecision, type ToolApprovalRequest } from '../approvals/index.js'
import {
  DecisionBlockedError,
  DecisionEvaluationError,
  HarnessError,
  OperationCancelledError,
  OperationTimeoutError,
  PermissionDeniedError,
  PolicyDeniedError,
  ToolError,
  ToolNotFoundError,
  ValidationError,
  serializeError,
} from '../errors/index.js'
import type {
  AgentDefinition,
  GovernanceConfig,
  ResolvedSkill,
  RunEvent,
  ToolsConfig,
} from '../harness/defineHarness.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import type { ModelMessage, ModelToolSpec, ToolCallSpec } from '../ports/model-provider.js'
import type { MemoryFacade } from '../ports/memory.js'
import type { Logger } from '../logger/index.js'
import type { TelemetryShim } from '../telemetry/index.js'
import { createMetrics, telemetryErrorType } from '../telemetry/index.js'
import type { SandboxSessionBase } from '../sandbox/index.js'
import { abortError, withAbortSignal } from '../runtime/abort.js'
import { BUILTIN_ALIAS_TO_CANONICAL, invokePreparedBuiltinTool, prepareBuiltinTool } from '../tools/index.js'
import { prepareMcpTool, isMcpToolDefinition, type McpRunnerRegistry } from '../tools/mcp/runner.js'
import { enforceToolGovernance, type ToolGovernanceResult } from '../governance/index.js'
import { validateSchema } from '../schema/validation.js'

type ToolKind = 'builtin' | 'ts' | 'mcp_stdio' | 'mcp_http'
type ToolFailure = ReturnType<typeof serializeError>

export type ToolExecutionOutcome = { emitted: Message; modelMessage: ModelMessage }

type ToolExecutionArgs = {
  harnessName: string
  agentId: string
  runId: string
  sessionId: string
  sandboxKey?: string
  workflowId?: string
  delegationCallId?: string
  agent: AgentDefinition<any>
  customTools: ToolsConfig
  governance?: GovernanceConfig<any>
  mcpRegistry?: McpRunnerRegistry
  session: SandboxSessionBase
  memory: MemoryFacade
  skills: Record<string, ResolvedSkill>
  activatedSkills: Set<string>
  signal: AbortSignal
  toolTimeoutMs: number
  decisionTimeoutMs: number
  runDeadline?: number
  maxParallelToolCalls: number
  logger: Logger
  telemetry: TelemetryShim
  metadata?: Readonly<Record<string, JsonValue>>
  hostContext?: unknown
  emitEvent?: (event: RunEvent) => Promise<void>
  step: number
  enabledCustomTools: ReadonlySet<string>
  turnMessageId: (slot: string) => string
  beforeTool: (
    toolId: string,
    callId: string,
    input: JsonValue,
    signal: AbortSignal,
    deadline: number,
  ) => Promise<JsonValue>
  afterTool: (
    toolId: string,
    callId: string,
    output: JsonValue,
    signal: AbortSignal,
    deadline: number,
  ) => Promise<JsonValue>
  approvalDecisions?: readonly ToolApprovalDecision[]
}

type PreparedToolInvocation = {
  readonly call: ToolCallSpec
  readonly parsedInput: JsonValue
  readonly tool: ToolsConfig[string] | undefined
  readonly kind: ToolKind
  readonly controller: AbortController
  readonly deadline: number
  readonly invoke: () => Promise<JsonValue>
  readonly cleanup: () => void
  governance?: ToolGovernanceResult
  governanceFailure?: PermissionDeniedError | PolicyDeniedError
}

type PreparedEntry =
  | { readonly kind: 'prepared'; readonly value: PreparedToolInvocation }
  | {
      readonly kind: 'recoverable'
      readonly call: ToolCallSpec
      readonly toolKind: ToolKind
      readonly error: HarnessError
    }

class PreflightValidationError extends Error {
  public constructor(
    readonly call: ToolCallSpec,
    readonly failure: ValidationError,
  ) {
    super(failure.message, { cause: failure })
  }
}

/**
 * Private default-loop tool lifecycle. It canonicalizes and preflights every
 * call before it permits an approval or a tool side effect, then drains a
 * bounded execution batch through one linked controller per prepared call.
 */
export async function runPreparedToolBatch(
  args: ToolExecutionArgs,
  calls: readonly ToolCallSpec[],
  exposed: readonly ModelToolSpec[],
): Promise<{ calls: readonly ToolCallSpec[]; outcomes: readonly ToolExecutionOutcome[] }> {
  const exposedNames = new Set(exposed.map(tool => tool.name))
  const batch = new AbortController()
  const relay = () => batch.abort(args.signal.reason)
  args.signal.addEventListener('abort', relay, { once: true })
  if (args.signal.aborted) relay()
  const entries: PreparedEntry[] = []
  try {
    for (const raw of calls) {
      const canonical = canonicalToolCall(raw, exposedNames)
      try {
        entries.push({ kind: 'prepared', value: await preflight(args, canonical, batch.signal) })
      } catch (error) {
        if (error instanceof PreflightValidationError) {
          entries.push({
            kind: 'recoverable',
            call: error.call,
            toolKind: resolveToolKind(error.call.name, args.customTools[error.call.name]),
            error: error.failure,
          })
          continue
        }
        if (error instanceof ValidationError) {
          entries.push({
            kind: 'recoverable',
            call: canonical,
            toolKind: resolveToolKind(canonical.name, args.customTools[canonical.name]),
            error,
          })
          continue
        }
        batch.abort(error)
        throw error
      }
    }
    const prepared = entries.filter(
      (entry): entry is Extract<PreparedEntry, { kind: 'prepared' }> => entry.kind === 'prepared',
    )
    const approvalRequests: ToolApprovalRequest[] = []
    for (const entry of prepared) {
      const item = entry.value
      if (!args.approvalDecisions) {
        await args.emitEvent?.({
          type: 'tool.input.available',
          runId: args.runId,
          agentId: args.agentId,
          toolId: item.call.name,
          callId: item.call.id,
          input: item.call.arguments as JsonValue,
        })
      }
      try {
        const governance = await enforceToolGovernance(
          {
            ...(args.governance ? { governance: args.governance } : {}),
            ...(args.agent.permissions ? { permissions: args.agent.permissions } : {}),
            toolId: item.call.name,
            input: item.parsedInput,
            callId: item.call.id,
            agentId: args.agentId,
            runId: args.runId,
            sessionId: args.sessionId,
            ...(args.workflowId ? { workflowId: args.workflowId } : {}),
            invocationId: args.delegationCallId ?? args.runId,
            step: args.step,
            signal: item.controller.signal,
            decisionTimeoutMs: args.decisionTimeoutMs,
            telemetry: args.telemetry,
            deadline: Math.min(item.deadline, args.runDeadline ?? Number.POSITIVE_INFINITY),
            metadata: args.metadata ?? {},
            ...(args.emitEvent ? { emitEvent: args.emitEvent } : {}),
          },
          args.approvalDecisions,
        )
        item.governance = governance
        if (governance?.decision === 'approval_required') approvalRequests.push(governance.request)
      } catch (error) {
        if (error instanceof PermissionDeniedError || error instanceof PolicyDeniedError) {
          item.governanceFailure = error
          continue
        }
        throw error
      }
    }
    if (approvalRequests.length > 0) {
      throw new ToolApprovalPendingError(
        approvalRequests,
        entries.map(entry => (entry.kind === 'recoverable' ? entry.call : entry.value.call)),
      )
    }
    const outcomes = await executePrepared(
      args,
      batch,
      prepared.map(entry => entry.value),
    )
    const executed = new Map(outcomes.map(entry => [entry.callId, entry.outcome]))
    const ordered = entries.map(entry =>
      entry.kind === 'recoverable'
        ? recoverableOutcome(args, entry.call, entry.error)
        : executed.get(entry.value.call.id)!,
    )
    return {
      calls: entries.map(entry => (entry.kind === 'recoverable' ? entry.call : entry.value.call)),
      outcomes: ordered,
    }
  } finally {
    for (const entry of entries) if (entry.kind === 'prepared') entry.value.cleanup()
    args.signal.removeEventListener('abort', relay)
  }
}

function canonicalToolCall(call: ToolCallSpec, exposed: ReadonlySet<string>): ToolCallSpec {
  const name = BUILTIN_ALIAS_TO_CANONICAL[call.name] ?? call.name
  if (!exposed.has(name)) {
    throw new ToolNotFoundError('Model requested a tool that was not exposed for this step.', {
      tool_id: name,
      where: 'model_response',
    })
  }
  if (!isJsonValue(call.arguments)) {
    throw new ValidationError('Tool input validation failed.', { where: 'tool_input', issues: [] })
  }
  return Object.freeze({ ...call, name, arguments: freezeJson(call.arguments) })
}

async function preflight(
  args: ToolExecutionArgs,
  raw: ToolCallSpec,
  batchSignal: AbortSignal,
): Promise<PreparedToolInvocation> {
  const controller = new AbortController()
  const startedAt = Date.now()
  const deadline = args.toolTimeoutMs > 0 ? startedAt + args.toolTimeoutMs : Number.POSITIVE_INFINITY
  const onRunAbort = () => controller.abort(args.signal.reason)
  const onBatchAbort = () => controller.abort(batchSignal.reason)
  args.signal.addEventListener('abort', onRunAbort, { once: true })
  batchSignal.addEventListener('abort', onBatchAbort, { once: true })
  const timeout =
    args.toolTimeoutMs > 0
      ? setTimeout(
          () =>
            controller.abort(
              new OperationTimeoutError('Tool execution timed out.', { scope: 'tool', timeout_ms: args.toolTimeoutMs }),
            ),
          args.toolTimeoutMs,
        )
      : undefined
  const cleanup = () => {
    if (timeout !== undefined) clearTimeout(timeout)
    args.signal.removeEventListener('abort', onRunAbort)
    batchSignal.removeEventListener('abort', onBatchAbort)
  }
  let call = raw
  try {
    if (args.signal.aborted) onRunAbort()
    if (batchSignal.aborted) onBatchAbort()
    throwIfAborted(controller.signal)
    const wireArguments = args.approvalDecisions
      ? (raw.arguments as JsonValue)
      : freezeJson(
      await args.beforeTool(
        raw.name,
        raw.id,
        raw.arguments as JsonValue,
        controller.signal,
        Math.min(deadline, args.runDeadline ?? Number.POSITIVE_INFINITY),
      ),
    )
    call = Object.freeze({ ...raw, arguments: wireArguments })
    const tool = args.customTools[call.name]
    const binding = await withAbortSignal(controller.signal, 'tool', 'Tool execution was cancelled.', () =>
      prepareToolBinding(args, call, tool, controller.signal),
    )
    if (!isJsonValue(binding.input))
      throw new ValidationError('Tool input validation failed.', { where: 'tool_input', issues: [] })
    return {
      call,
      parsedInput: freezeJson(binding.input),
      invoke: binding.invoke,
      tool,
      kind: resolveToolKind(call.name, tool),
      controller,
      deadline,
      cleanup,
    }
  } catch (error) {
    cleanup()
    if (error instanceof ValidationError) throw new PreflightValidationError(call, error)
    throw error
  }
}

async function prepareToolBinding(
  args: ToolExecutionArgs,
  call: ToolCallSpec,
  tool: ToolsConfig[string] | undefined,
  signal: AbortSignal,
): Promise<{ input: unknown; invoke: () => Promise<JsonValue> }> {
  if (call.name in BUILTIN_ALIAS_TO_CANONICAL) {
    const prepared = prepareBuiltinTool(call.name, call.arguments)
    return { input: prepared.input, invoke: () => invokePreparedBuiltinTool(prepared, args.session, signal) }
  }
  if (!args.enabledCustomTools.has(call.name))
    throw new ToolNotFoundError('Tool is not allowed for this agent.', { tool_id: call.name, where: 'agent_allowlist' })
  if (!tool) throw new ToolNotFoundError('Tool was not found.', { tool_id: call.name, where: 'registry' })
  if (isMcpToolDefinition(tool)) {
    if (!args.mcpRegistry)
      throw new ToolNotFoundError('MCP registry is not available.', { tool_id: call.name, where: 'registry' })
    return prepareMcpTool(call.name, tool, call.arguments, {
      registry: args.mcpRegistry,
      signal,
      toolTimeoutMs: args.toolTimeoutMs,
      sandbox: args.session,
      sandboxKey: args.sandboxKey ?? args.sessionId,
    })
  }
  if (tool.kind && tool.kind !== 'ts')
    throw new ValidationError('Unsupported tool kind.', { where: 'tool_input', issues: [] })
  const input = await validateSchema(tool.input, call.arguments, {
    where: 'tool_input',
    message: 'Tool input validation failed.',
    assertNotAborted: () => throwIfAborted(signal),
  })
  return {
    input,
    invoke: async () => {
      const value = await tool.handler(
        {
          signal,
          metadata: args.metadata ?? {},
          sandbox: args.session,
          logger: args.logger,
          telemetry: args.telemetry,
          metrics: createMetrics(args.telemetry, {
            'harness.name': args.harnessName,
            'harness.session.id': args.sessionId,
            'harness.run.id': args.runId,
            ...(args.workflowId ? { 'harness.workflow.id': args.workflowId } : {}),
            'harness.agent.id': args.agentId,
            'harness.tool.id': call.name,
          }),
          memory: args.memory,
          runId: args.runId,
          sessionId: args.sessionId,
          agentId: args.agentId,
          toolId: call.name,
          callId: call.id,
          idempotencyKey: toolCallIdempotencyKey(args, call),
          ...(args.hostContext !== undefined ? { hostContext: args.hostContext } : {}),
        },
        input,
      )
      return validateSchema(tool.output, value, {
        where: 'tool_output',
        message: 'Tool output validation failed.',
        assertNotAborted: () => throwIfAborted(signal),
      })
    },
  }
}

function toolCallIdempotencyKey(args: ToolExecutionArgs, call: ToolCallSpec): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        args.harnessName,
        args.runId,
        args.workflowId ?? null,
        args.delegationCallId ?? null,
        args.agentId,
        args.step,
        call.name,
        call.id,
      ]),
    )
    .digest('hex')
  return `tool_${digest}`
}

async function executePrepared(
  args: ToolExecutionArgs,
  batch: AbortController,
  prepared: readonly PreparedToolInvocation[],
): Promise<Array<{ callId: string; outcome: ToolExecutionOutcome }>> {
  const results = new Array<{ callId: string; outcome: ToolExecutionOutcome }>(prepared.length)
  let next = 0
  let terminal: unknown
  const worker = async () => {
    while (!batch.signal.aborted) {
      const index = next++
      if (index >= prepared.length) return
      const item = prepared[index]!
      try {
        results[index] = {
          callId: item.call.id,
          outcome: item.governanceFailure
            ? await governanceDeniedOutcome(args, item, item.governanceFailure)
            : item.governance?.decision === 'rejected'
              ? await approvalRejectedOutcome(args, item, item.governance)
              : await executeOne(args, item),
        }
      } catch (error) {
        terminal ??= error
        batch.abort(error)
        return
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(args.maxParallelToolCalls, prepared.length)) }, () => worker()),
  )
  if (terminal !== undefined) throw terminal
  return results
}

async function governanceDeniedOutcome(
  args: ToolExecutionArgs,
  prepared: PreparedToolInvocation,
  failure: PermissionDeniedError | PolicyDeniedError,
): Promise<ToolExecutionOutcome> {
  const serialized = serializeError(failure)
  await args.emitEvent?.({
    type: 'tool.finished',
    runId: args.runId,
      agentId: args.agentId,
    toolId: prepared.call.name,
    callId: prepared.call.id,
    error: serialized,
  })
  return toolOutcome(args, prepared.call, { error: serialized })
}

async function approvalRejectedOutcome(
  args: ToolExecutionArgs,
  prepared: PreparedToolInvocation,
  governance: Extract<ToolGovernanceResult, { decision: 'rejected' }>,
): Promise<ToolExecutionOutcome> {
  const failure = new ToolError(governance.reason?.trim() || 'Tool execution was rejected by the approver.', {
    tool_id: prepared.call.name,
    tool_kind: 'approval',
  })
  const serialized = serializeError(failure)
  await args.emitEvent?.({
    type: 'tool.finished',
      runId: args.runId,
    agentId: args.agentId,
    toolId: prepared.call.name,
    callId: prepared.call.id,
    error: serialized,
    })
  return toolOutcome(args, prepared.call, { error: serialized })
}

async function executeOne(args: ToolExecutionArgs, prepared: PreparedToolInvocation): Promise<ToolExecutionOutcome> {
  const { call, kind, controller } = prepared
  let started = false
  try {
    throwIfAborted(controller.signal)
    await args.emitEvent?.({
      type: 'tool.started',
      runId: args.runId,
      agentId: args.agentId,
      toolId: call.name,
      callId: call.id,
      input: call.arguments as JsonValue,
    })
    started = true
    const output = await runHandler(args, prepared)
    throwIfAborted(controller.signal)
    const presentation = freezeJson(
      await args.afterTool(
        call.name,
        call.id,
        output,
        controller.signal,
        Math.min(prepared.deadline, args.runDeadline ?? Number.POSITIVE_INFINITY),
      ),
    )
    await args.emitEvent?.({
      type: 'tool.finished',
      runId: args.runId,
      agentId: args.agentId,
      toolId: call.name,
      callId: call.id,
      output: presentation,
    })
    return toolOutcome(args, call, { output: presentation })
  } catch (error) {
    if (terminalToolError(error)) {
      if (started) {
        const failure = normalizeToolFailure(call.name, error, kind)
        await args.emitEvent?.({
          type: 'tool.finished',
          runId: args.runId,
          agentId: args.agentId,
          toolId: call.name,
          callId: call.id,
          error: serializeError(failure),
        })
      }
      throw error
    }
    const failure = normalizeToolFailure(call.name, error, kind)
    await args.emitEvent?.({
      type: 'tool.finished',
      runId: args.runId,
      agentId: args.agentId,
      toolId: call.name,
      callId: call.id,
      error: serializeError(failure),
    })
    return toolOutcome(args, call, { error: serializeError(failure) })
  }
}

async function runHandler(args: ToolExecutionArgs, prepared: PreparedToolInvocation): Promise<JsonValue> {
  const operation = async () => {
    const output = await prepared.invoke()
    if (prepared.call.name === 'read') markSkillActivation(prepared.parsedInput, args.skills, args.activatedSkills)
    return output
  }
  return withToolSpan(args, prepared, () =>
    withAbortSignal(prepared.controller.signal, 'tool', 'Tool execution was cancelled.', operation),
  )
}

async function withToolSpan(
  args: ToolExecutionArgs,
  prepared: PreparedToolInvocation,
  operation: () => Promise<JsonValue>,
): Promise<JsonValue> {
  const tool = prepared.tool
  const mcp =
    tool && isMcpToolDefinition(tool)
      ? {
          server: prepared.call.name,
          upstreamTool: tool.tool,
          transport: tool.kind === 'mcp_stdio' ? 'stdio' : 'http',
          provenance: tool.provenance,
        }
      : undefined
  const attrs = {
    'harness.name': args.harnessName,
    'harness.session.id': args.sessionId,
    'harness.run.id': args.runId,
    ...(args.workflowId ? { 'harness.workflow.id': args.workflowId } : {}),
    'harness.agent.id': args.agentId,
    'harness.tool.id': prepared.call.name,
    'gen_ai.operation.name': 'execute_tool',
    'openinference.span.kind': 'TOOL',
    'tool.name': prepared.call.name,
    'tool.call.id': prepared.call.id,
    [ATTR_GEN_AI_AGENT_NAME]: args.agentId,
    [ATTR_GEN_AI_TOOL_NAME]: prepared.call.name,
    [ATTR_GEN_AI_TOOL_CALL_ID]: prepared.call.id,
    [ATTR_GEN_AI_TOOL_TYPE]: prepared.kind === 'mcp_stdio' || prepared.kind === 'mcp_http' ? 'extension' : 'function',
    ...(mcp
      ? {
          'harness.mcp.server': mcp.server,
          'harness.mcp.tool': mcp.upstreamTool,
          'harness.mcp.transport': mcp.transport,
          ...(mcp.provenance
            ? {
                'harness.plugin.name': mcp.provenance.name,
                ...(mcp.provenance.version ? { 'harness.plugin.version': mcp.provenance.version } : {}),
                'harness.plugin.digest': mcp.provenance.digest,
                'harness.plugin.component': mcp.provenance.component,
              }
            : {}),
        }
      : {}),
  }
  const started = Date.now()
  let succeeded = false
  const execute = async () => {
    try {
      const result = await operation()
      succeeded = true
      return result
    } catch (error) {
      const normalized = normalizeToolFailure(prepared.call.name, error, prepared.kind)
      const errorAttrs = {
        ...attrs,
        [ATTR_ERROR_TYPE]: telemetryErrorType(normalized),
        'harness.error.code': normalized.code,
        'harness.error.category': normalized.category,
        'harness.error.retriable': normalized.retriable,
      }
      args.telemetry.recordHistogram('harness.tool.duration', (Date.now() - started) / 1000, errorAttrs)
      args.telemetry.recordHistogram('gen_ai.execute_tool.duration', (Date.now() - started) / 1000, errorAttrs)
      throw normalized
    } finally {
      if (succeeded) {
        args.telemetry.recordHistogram('harness.tool.duration', (Date.now() - started) / 1000, attrs)
        args.telemetry.recordHistogram('gen_ai.execute_tool.duration', (Date.now() - started) / 1000, attrs)
      }
    }
  }
  return args.telemetry.span(`execute_tool ${prepared.call.name}`, attrs, execute)
}

function terminalToolError(error: unknown): boolean {
  return (
    error instanceof DecisionBlockedError ||
    error instanceof DecisionEvaluationError ||
    error instanceof OperationCancelledError ||
    error instanceof OperationTimeoutError
  )
}

function recoverableOutcome(args: ToolExecutionArgs, call: ToolCallSpec, error: HarnessError): ToolExecutionOutcome {
  return toolOutcome(args, call, { error: serializeError(error) })
}

function toolOutcome(
  args: ToolExecutionArgs,
  call: ToolCallSpec,
  result: { output?: JsonValue; error?: ToolFailure },
): ToolExecutionOutcome {
  const emitted: Message = {
    id: args.turnMessageId(`20_tool_${call.id}`),
    sessionId: args.sessionId,
    runId: args.runId,
    role: 'tool',
    content: '',
    toolResults: [
      {
        toolCallId: call.id,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error ? { error: result.error } : {}),
      },
    ],
    timestamp: new Date().toISOString(),
  }
  return {
    emitted,
    modelMessage: { role: 'tool', toolCallId: call.id, content: JSON.stringify(result.output ?? result.error ?? {}) },
  }
}

function resolveToolKind(toolId: string, tool: ToolsConfig[string] | undefined): ToolKind {
  if (toolId in BUILTIN_ALIAS_TO_CANONICAL) return 'builtin'
  return tool && isMcpToolDefinition(tool) ? tool.kind : 'ts'
}

function normalizeToolFailure(toolId: string, error: unknown, toolKind: ToolKind): HarnessError {
  if (error instanceof HarnessError) return error
  return new ToolError('Tool execution failed.', { tool_id: toolId, tool_kind: toolKind }, error)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal, 'tool', 'Tool execution was cancelled.')
}

function markSkillActivation(input: JsonValue, skills: Record<string, ResolvedSkill>, activated: Set<string>): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return
  const path = input['path']
  if (typeof path !== 'string') return
  for (const skill of Object.values(skills))
    if (path === `${skill.mountPath}/SKILL.md`) {
      activated.add(skill.name)
      return
    }
}

/** Private shared freeze for validated values and the envelopes exposed to hooks. */
export function freezeJson<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value)) freezeJson(child, seen)
  return Object.freeze(value)
}
