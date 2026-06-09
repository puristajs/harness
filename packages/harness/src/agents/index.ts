import { z } from 'zod'
import {
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE
} from '@opentelemetry/semantic-conventions/incubating'
import { AgentLoopBudgetError, HarnessConfigError, HarnessError, OperationCancelledError, OperationTimeoutError, PermissionDeniedError, ToolError, ToolNotFoundError, ValidationError, serializeError } from '../errors/index.js'
import type { Logger } from '../logger/index.js'
import type { JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import type { AgentDefinition, BuiltinToolName, ModelHandles, PermissionMode, PermissionPolicy, ResolvedSkill, RunEvent, ToolsConfig } from '../harness/defineHarness.js'
import type { MemoryFacade } from '../ports/memory.js'
import type { ModelMessage, ToolCallSpec } from '../ports/model-provider.js'
import type { SandboxSession } from '../sandbox/index.js'
import { createMetrics, type Metrics, type TelemetryShim } from '../telemetry/index.js'
import { buildSkillIndex, mountSkillsOnce } from '../skills/index.js'
import { BUILTIN_ALIAS_TO_CANONICAL, getBuiltinToolSpecs, invokeBuiltinTool } from '../tools/index.js'
import { getMcpToolSpecs, invokeMcpTool, isMcpToolDefinition, type McpRunnerRegistry } from '../tools/mcp/runner.js'
import { ulid } from '../ulid/index.js'
import { abortError, withAbortSignal } from '../runtime/abort.js'

function stringifyInput(input: unknown): string { return typeof input === 'string' ? input : JSON.stringify(input) }

type ToolKind = 'builtin' | 'ts' | 'mcp_stdio' | 'mcp_http'
type ToolFailure = ReturnType<typeof serializeError>
type PermissionResult =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: 'mode_deny' | 'hook_deny' }
type ToolExecutionOutcome = {
  emitted: Message
  modelMessage: ModelMessage
}

function isReadonlyBuiltin(name: string): boolean { return ['read', 'list', 'glob', 'grep'].includes(name) }

async function checkPermission(agentId: string, runId: string, sessionId: string, def: AgentDefinition<any>, toolName: string, input: unknown): Promise<PermissionResult> {
  if (isReadonlyBuiltin(toolName)) return { decision: 'allow' }
  const perm = (def.permissions as Record<string, unknown> | undefined)?.[toolName]
  const policy = normalizePermissionPolicy(perm)
  const mode = policy.mode
  const target = permissionTarget(toolName, input)

  if (target && matchesAnyPattern(target, policy.deny)) return { decision: 'deny', reason: 'mode_deny' }
  if (policy.allow && policy.allow.length > 0 && (!target || !matchesAnyPattern(target, policy.allow))) {
    return { decision: 'deny', reason: 'mode_deny' }
  }
  if (mode === 'allow') return { decision: 'allow' }
  if (mode === 'deny') return { decision: 'deny', reason: 'mode_deny' }
  if (!def.onPermission) return { decision: 'deny', reason: 'hook_deny' }
  try {
    const decision = await def.onPermission({ toolName, input, agentId, runId, sessionId })
    return decision === 'allow' ? { decision } : { decision, reason: 'hook_deny' }
  } catch {
    throw new PermissionDeniedError('Permission hook failed.', { tool_name: toolName, agent_id: agentId, reason: 'hook_failed' })
  }
}

function normalizePermissionPolicy(perm: unknown): PermissionPolicy {
  if (perm === 'allow' || perm === 'ask' || perm === 'deny') return { mode: perm }
  if (perm && typeof perm === 'object' && 'mode' in perm) {
    const candidate = perm as { mode?: PermissionMode; allow?: readonly string[]; deny?: readonly string[] }
    if (candidate.mode === 'allow' || candidate.mode === 'ask' || candidate.mode === 'deny') {
      return {
        mode: candidate.mode,
        ...(Array.isArray(candidate.allow) ? { allow: candidate.allow.filter(isString) } : {}),
        ...(Array.isArray(candidate.deny) ? { deny: candidate.deny.filter(isString) } : {})
      }
    }
  }
  return { mode: 'allow' }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function permissionTarget(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  if (toolName === 'bash') return typeof record['command'] === 'string' ? record['command'] : undefined
  if (toolName === 'write' || toolName === 'edit') return typeof record['path'] === 'string' ? record['path'] : undefined
  return undefined
}

function matchesAnyPattern(value: string, patterns: readonly string[] | undefined): boolean {
  return patterns?.some((pattern) => globPatternToRegExp(pattern).test(value)) ?? false
}

function globPatternToRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
      continue
    }
    source += escapeRegExp(char ?? '')
  }
  return new RegExp(`${source}$`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')
}

export async function runDefaultAgent(args: {
  harnessName: string
  agentId: string
  runId: string
  sessionId: string
  workflowId?: string
  input: unknown
  history: Message[]
  agent: AgentDefinition<any>
  models: Record<string, any>
  skills: Record<string, ResolvedSkill>
  customTools: ToolsConfig
  mcpRegistry?: McpRunnerRegistry
  session: SandboxSession
  memory: MemoryFacade
  mountedSkills: Set<string>
  historyWindow?: number
  maxSteps: number
  signal: AbortSignal
  toolTimeoutMs: number
  maxParallelToolCalls: number
  logger: Logger
  telemetry: TelemetryShim
  emitEvent?: (event: RunEvent) => Promise<void>
  metadata?: Readonly<Record<string, JsonValue>>
}): Promise<{ output: JsonValue; emitted: Message[] }> {
  const agentAttrs = {
    'harness.name': args.harnessName,
    'harness.session.id': args.sessionId,
    'harness.run.id': args.runId,
    ...(args.workflowId ? { 'harness.workflow.id': args.workflowId } : {}),
    'harness.agent.id': args.agentId,
    'gen_ai.operation.name': 'invoke_agent',
    'openinference.span.kind': 'AGENT',
    'metadata.agent_name': args.agentId,
    'metadata.agent_id': args.agentId,
    [ATTR_GEN_AI_AGENT_NAME]: args.agentId,
    [ATTR_GEN_AI_AGENT_ID]: args.agentId,
    'harness.agent.model': args.agent.model,
    'harness.agent.has_handler': args.agent.handler !== undefined,
    ...metadataSpanAttrs(args.metadata)
  }
  const metrics = createMetrics(args.telemetry, agentAttrs)
  const execute = () => runDefaultAgentInner({ ...args, metrics })
  return args.telemetry.span(`invoke_agent ${args.agentId}`, agentAttrs, execute)
}

function metadataSpanAttrs(metadata: Readonly<Record<string, JsonValue>> | undefined): Record<string, string | number | boolean | undefined> {
  const attrs: Record<string, string | number | boolean | undefined> = {}
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key)) continue
    if (typeof value === 'string') {
      if (value.length <= 256) attrs[`harness.metadata.${key}`] = value
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      attrs[`harness.metadata.${key}`] = value
      continue
    }
    if (typeof value === 'boolean') {
      attrs[`harness.metadata.${key}`] = value
    }
  }
  return attrs
}

async function runDefaultAgentInner(args: {
  harnessName: string
  agentId: string
  runId: string
  sessionId: string
  workflowId?: string
  input: unknown
  history: Message[]
  agent: AgentDefinition<any>
  models: Record<string, any>
  skills: Record<string, ResolvedSkill>
  customTools: ToolsConfig
  mcpRegistry?: McpRunnerRegistry
  session: SandboxSession
  memory: MemoryFacade
  mountedSkills: Set<string>
  historyWindow?: number
  maxSteps: number
  signal: AbortSignal
  toolTimeoutMs: number
  maxParallelToolCalls: number
  logger: Logger
  telemetry: TelemetryShim
  metrics: Metrics
  emitEvent?: (event: RunEvent) => Promise<void>
  metadata?: Readonly<Record<string, JsonValue>>
}): Promise<{ output: JsonValue; emitted: Message[] }> {
  if (args.signal.aborted) throw abortError(args.signal, 'run', 'Run was cancelled.')
  const inputSchema = args.agent.input ?? z.string()
  const outputSchema = args.agent.output ?? z.string()
  const parsedInput = parseAgentSchema(inputSchema, args.input, 'agent_input')

  const model = args.models[args.agent.model]
  if (!model) throw new ValidationError('Unknown model alias', { where: 'agent_input', issues: { model: args.agent.model } })
  const skillIds = args.agent.skills ?? []
  await mountSkillsOnce(args.session, args.mountedSkills, args.skills, skillIds)
  const activatedSkills = new Set<string>()

  if (args.agent.handler) {
    const handler = args.agent.handler
    const output = await withAbortSignal(args.signal, 'run', 'Run was cancelled.', () => handler({
      input: parsedInput,
      signal: args.signal,
      models: args.models as ModelHandles<any>,
      runId: args.runId,
      sessionId: args.sessionId,
      history: { list: async () => args.history },
      memory: args.memory,
      metadata: args.metadata ?? {},
      metrics: args.metrics
    }))
    const validated = parseAgentSchema(outputSchema, output, 'agent_output')
    return { output: validated as JsonValue, emitted: [{ id: `msg_${ulid()}_a`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: JSON.stringify(validated), timestamp: new Date().toISOString() }] }
  }

  const baseInstructions = typeof args.agent.instructions === 'function'
    ? args.agent.instructions({ input: parsedInput, runId: args.runId, sessionId: args.sessionId, history: { list: async () => args.history }, memory: args.memory, metadata: args.metadata ?? {}, metrics: args.metrics })
    : args.agent.instructions
  const instructions = `${baseInstructions}${buildSkillIndex(args.skills, skillIds)}`

  const enabledBuiltins: BuiltinToolName[] = args.agent.builtinTools === false ? [] : (args.agent.builtinTools?.slice() as BuiltinToolName[] | undefined) ?? ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'list']
  if (skillIds.length > 0 && !enabledBuiltins.includes('read')) {
    throw new HarnessConfigError('Agents with skills require the read built-in tool for skill activation.', {
      reason: 'skill_read_tool_missing',
      path: `agents.${args.agentId}.builtinTools`,
      id: args.agentId
    })
  }
  const builtinSpecs = getBuiltinToolSpecs(enabledBuiltins, args.session)
  const enabledCustomTools = new Set<string>((args.agent.tools ?? []) as readonly string[])
  const tsCustomSpecs = Object.entries(args.customTools)
    .filter(([name]) => enabledCustomTools.has(name))
    .flatMap(([name, tool]) => {
      if (tool.kind && tool.kind !== 'ts') {
        return []
      }
      const tsTool = tool as Extract<typeof tool, { input: z.ZodTypeAny }>
      return [{ name, description: tsTool.description, parameters: z.toJSONSchema(tsTool.input) as JsonValue }]
    })
  const mcpSpecs = args.mcpRegistry ? await getMcpToolSpecs(args.customTools, enabledCustomTools, { registry: args.mcpRegistry, signal: args.signal, toolTimeoutMs: args.toolTimeoutMs, sandbox: args.session, sandboxKey: args.sessionId }) : []
  const customSpecs = [...tsCustomSpecs, ...mcpSpecs]

  const nonSystem = args.history.filter((m) => m.role !== 'system')
  const system = args.history.filter((m) => m.role === 'system')
  const cappedNonSystem = args.historyWindow === undefined ? nonSystem : args.historyWindow === 0 ? [] : nonSystem.slice(-args.historyWindow)
  const modelMessages: ModelMessage[] = [...system, ...cappedNonSystem, { id: '', sessionId: args.sessionId, role: 'user', content: stringifyInput(parsedInput), timestamp: new Date().toISOString() } as unknown as Message]
    .flatMap((m) => {
      if (m.role === 'tool' && m.toolResults) {
        return m.toolResults.map((r) => ({ role: 'tool' as const, toolCallId: r.toolCallId, content: JSON.stringify(r.output ?? r.error ?? {}) }))
      }
      return [{ role: m.role, content: m.content, toolCalls: m.toolCalls } as ModelMessage]
    })

  const emitted: Message[] = []
  const maxSteps = Math.min(args.agent.maxSteps ?? args.maxSteps, 64)
  let steps = 0

  while (true) {
    if (args.signal.aborted) throw abortError(args.signal, 'run', 'Run was cancelled.')
    if (steps >= maxSteps) throw new AgentLoopBudgetError('Agent loop budget exceeded.', { agent_id: args.agentId, reason: 'iterations_exceeded', limit: maxSteps })
    if (steps === 0) await args.emitEvent?.({ type: 'agent.started', runId: args.runId, agentId: args.agentId, at: new Date().toISOString() })
    const response = await model.object({
      messages: [
        { role: 'system', content: instructions },
        ...modelMessages
      ],
      tools: [...builtinSpecs, ...customSpecs],
      schema: z.toJSONSchema(outputSchema) as JsonValue
    }, args.signal, {
      harnessName: args.harnessName,
      sessionId: args.sessionId,
      runId: args.runId,
      ...(args.workflowId ? { workflowId: args.workflowId } : {}),
      agentId: args.agentId
    })

    const toolCalls = (response.toolCalls ?? []) as ToolCallSpec[]
    if (toolCalls.length === 0) {
      const validated = parseAgentSchema(outputSchema, response.object, 'agent_output')
      emitted.push({ id: `msg_${ulid()}_a`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: JSON.stringify(validated), timestamp: new Date().toISOString() })
      await args.emitEvent?.({ type: 'model.object', runId: args.runId, agentId: args.agentId, object: validated as JsonValue, usage: response.usage })
      await args.emitEvent?.({ type: 'agent.finished', runId: args.runId, agentId: args.agentId, at: new Date().toISOString(), output: validated as JsonValue })
      return { output: validated as JsonValue, emitted }
    }

    const assistantMsg: Message = {
      id: `msg_${ulid()}_assistant`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: '', toolCalls,
      timestamp: new Date().toISOString()
    }
    emitted.push(assistantMsg)
    modelMessages.push({ role: 'assistant', content: assistantMsg.content, toolCalls })

    args.metrics.histogram('harness.agent.tool_batch.size', toolCalls.length, {
      'harness.agent.tool_batch.max_parallel': args.maxParallelToolCalls
    })
    const outcomes = await runLimited(toolCalls, args.maxParallelToolCalls, (call) => executeToolCall({
      ...args,
      enabledCustomTools,
      activatedSkills
    }, call))
    for (const outcome of outcomes) {
      emitted.push(outcome.emitted)
      modelMessages.push(outcome.modelMessage)
    }
    steps += 1
  }
}

async function runLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const concurrency = Math.max(1, Math.min(limit, items.length))
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

async function executeToolCall(
  args: Parameters<typeof runDefaultAgentInner>[0] & {
    enabledCustomTools: Set<string>
    activatedSkills: Set<string>
  },
  call: ToolCallSpec
): Promise<ToolExecutionOutcome> {
  const canonical = BUILTIN_ALIAS_TO_CANONICAL[call.name] ?? call.name
  const input = call.arguments
  const tool = args.customTools[canonical]
  const toolKind = resolveToolKind(canonical, tool)
  let result: { output?: JsonValue; error?: ToolFailure }

  try {
    if (args.signal.aborted) throw abortError(args.signal, 'run', 'Run was cancelled.')
    await args.emitEvent?.({ type: 'tool.started', runId: args.runId, agentId: args.agentId, toolId: canonical, callId: call.id, input: input as JsonValue })
    result = await withToolSpan(args, canonical, call.id, toolKind, tool && isMcpToolDefinition(tool) ? { server: canonical, upstreamTool: tool.tool, transport: tool.kind === 'mcp_stdio' ? 'stdio' : 'http' } : undefined, async () => {
      const permission = await withToolSignal(args.signal, args.toolTimeoutMs, () => checkPermission(args.agentId, args.runId, args.sessionId, args.agent, canonical, input))
      if (permission.decision === 'deny') {
        throw new PermissionDeniedError('Permission denied.', { tool_name: canonical, agent_id: args.agentId, reason: permission.reason })
      }
      if (canonical in BUILTIN_ALIAS_TO_CANONICAL) {
        const output = await withToolSignal(args.signal, args.toolTimeoutMs, (signal) => invokeBuiltinTool(canonical, input, withSandboxTelemetry(args, canonical), signal))
        if (canonical === 'read') markSkillActivation(input, args.skills, args.activatedSkills)
        return { output }
      }
      if (!args.enabledCustomTools.has(canonical)) {
        throw new ToolNotFoundError('Tool is not allowed for this agent.', { tool_id: canonical, where: 'agent_allowlist' })
      }
      if (!tool) throw new ToolNotFoundError('Tool was not found.', { tool_id: canonical, where: 'registry' })
      if (isMcpToolDefinition(tool)) {
        if (!args.mcpRegistry) throw new ToolNotFoundError('MCP registry is not available.', { tool_id: canonical, where: 'registry' })
        const registry = args.mcpRegistry
        return { output: await withToolSignal(args.signal, args.toolTimeoutMs, (signal) => invokeMcpTool(canonical, tool, input, { registry, signal, toolTimeoutMs: args.toolTimeoutMs, sandbox: withSandboxTelemetry(args, canonical), sandboxKey: args.sessionId })) }
      }
      if (tool.kind && tool.kind !== 'ts') {
        throw new ValidationError('Unsupported tool kind.', { where: 'tool_input', issues: { toolId: canonical, kind: tool.kind } })
      }
      const parsed = tool.input.parse(input)
      const out = await withToolSignal(args.signal, args.toolTimeoutMs, (signal) => tool.handler({
        signal,
        sandbox: withSandboxTelemetry(args, canonical),
        logger: args.logger,
        telemetry: args.telemetry,
        metrics: createMetrics(args.telemetry, {
          'harness.name': args.harnessName,
          'harness.session.id': args.sessionId,
          'harness.run.id': args.runId,
          ...(args.workflowId ? { 'harness.workflow.id': args.workflowId } : {}),
          'harness.agent.id': args.agentId,
          'harness.tool.id': canonical
        }),
        memory: args.memory,
        runId: args.runId,
        sessionId: args.sessionId,
        agentId: args.agentId,
        toolId: canonical
      }, parsed))
      return { output: tool.output.parse(out) as JsonValue }
    })
  } catch (error) {
    const failure = normalizeToolFailure(canonical, error, toolKind)
    if (failure instanceof OperationCancelledError) {
      if (args.signal.aborted) throw new OperationCancelledError('Run was cancelled.', { scope: 'run' }, args.signal.reason ?? failure)
      throw failure
    }
    result = { error: serializeError(failure) }
  }

  await args.emitEvent?.({ type: 'tool.finished', runId: args.runId, agentId: args.agentId, toolId: canonical, callId: call.id, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.error ? { error: result.error } : {}) })
  const toolMessage: Message = {
    id: `msg_${ulid()}_${call.id}`,
    sessionId: args.sessionId,
    runId: args.runId,
    role: 'tool',
    content: '',
    toolResults: [{ toolCallId: call.id, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.error ? { error: result.error } : {}) }],
    timestamp: new Date().toISOString()
  }
  return {
    emitted: toolMessage,
    modelMessage: { role: 'tool', toolCallId: call.id, content: JSON.stringify(result.output ?? result.error ?? {}) }
  }
}

function resolveToolKind(toolId: string, tool: ToolsConfig[string] | undefined): ToolKind {
  if (toolId in BUILTIN_ALIAS_TO_CANONICAL) return 'builtin'
  return tool && isMcpToolDefinition(tool) ? tool.kind : 'ts'
}

function markSkillActivation(input: unknown, skills: Record<string, ResolvedSkill>, activated: Set<string>): void {
  if (!input || typeof input !== 'object') return
  const readPath = (input as { path?: unknown }).path
  if (typeof readPath !== 'string') return
  for (const skill of Object.values(skills)) {
    if (readPath === `${skill.mountPath}/SKILL.md`) {
      activated.add(skill.name)
      return
    }
  }
}

async function withToolSignal<T>(parent: AbortSignal, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (parent.aborted) throw abortError(parent, 'run', 'Run was cancelled.')
  const controller = new AbortController()
  const relay = () => controller.abort(parent.reason)
  parent.addEventListener('abort', relay, { once: true })
  if (parent.aborted) relay()
  let abortListener: (() => void) | undefined
  const timeout = timeoutMs > 0
    ? setTimeout(() => controller.abort(new OperationTimeoutError('Tool execution timed out.', { scope: 'tool', timeout_ms: timeoutMs })), timeoutMs)
    : undefined
  const abortPromise = new Promise<never>((_, reject) => {
    abortListener = () => {
      const reason = controller.signal.reason
      reject(reason instanceof Error ? reason : new OperationCancelledError('Tool execution was cancelled.', { scope: 'tool' }, reason))
    }
    controller.signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    const operation = fn(controller.signal)
    return await Promise.race([operation, abortPromise])
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      if (reason instanceof OperationTimeoutError) throw reason
      if (reason instanceof OperationCancelledError) throw reason
      throw new OperationCancelledError('Tool execution was cancelled.', { scope: 'tool' }, reason ?? error)
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    if (abortListener) controller.signal.removeEventListener('abort', abortListener)
    parent.removeEventListener('abort', relay)
  }
}

async function withToolSpan<T extends { output?: JsonValue; error?: ReturnType<typeof serializeError> }>(
  args: {
    harnessName: string
    sessionId: string
    runId: string
    workflowId?: string
    agentId: string
    telemetry?: TelemetryShim
  },
  toolId: string,
  callId: string,
  toolKind: ToolKind,
  mcpAttrs: { server: string; upstreamTool: string; transport: 'stdio' | 'http' } | undefined,
  fn: () => Promise<T>
): Promise<T> {
  const attrs = {
    'harness.name': args.harnessName,
    'harness.session.id': args.sessionId,
    'harness.run.id': args.runId,
    ...(args.workflowId ? { 'harness.workflow.id': args.workflowId } : {}),
    'harness.agent.id': args.agentId,
    'harness.tool.id': toolId,
    'gen_ai.operation.name': 'execute_tool',
    'openinference.span.kind': 'TOOL',
    'tool.name': toolId,
    'tool.call.id': callId,
    [ATTR_GEN_AI_TOOL_NAME]: toolId,
    [ATTR_GEN_AI_TOOL_CALL_ID]: callId,
    [ATTR_GEN_AI_TOOL_TYPE]: toolKind,
    ...(mcpAttrs ? {
      'harness.mcp.server': mcpAttrs.server,
      'harness.mcp.tool': mcpAttrs.upstreamTool,
      'harness.mcp.transport': mcpAttrs.transport
    } : {})
  }
  const started = Date.now()
  let durationAttrs: Record<string, string | number | boolean | undefined> = {}
  const execute = async () => {
    try {
      const result = await fn()
      return result
    } catch (error) {
      const normalized = normalizeToolFailure(toolId, error, toolKind)
      durationAttrs = {
        'harness.error.code': normalized.code,
        'harness.error.category': normalized.category,
        'harness.error.retriable': normalized.retriable
      }
      throw normalized
    } finally {
      args.telemetry?.recordHistogram('harness.tool.duration', (Date.now() - started) / 1000, { ...attrs, ...durationAttrs })
    }
  }
  return args.telemetry ? args.telemetry.span(`execute_tool ${toolId}`, attrs, execute) : execute()
}

function normalizeToolFailure(toolId: string, error: unknown, toolKind: ToolKind = toolId in BUILTIN_ALIAS_TO_CANONICAL ? 'builtin' : 'ts'): HarnessError {
  if (error instanceof z.ZodError) {
    return new ValidationError('Tool input validation failed', { where: 'tool_input', issues: JSON.parse(JSON.stringify(error.issues)) as JsonValue })
  }
  if (error instanceof HarnessError) return error
  return new ToolError('Tool execution failed.', { tool_id: toolId, tool_kind: toolKind }, error)
}

function parseAgentSchema(schema: z.ZodTypeAny, value: unknown, where: 'agent_input' | 'agent_output'): unknown {
  try {
    return schema.parse(value)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError(
        where === 'agent_input' ? 'Agent input validation failed.' : 'Agent output validation failed.',
        { where, issues: JSON.parse(JSON.stringify(error.issues)) as JsonValue },
        error
      )
    }
    throw error
  }
}

function withSandboxTelemetry(args: {
  harnessName: string
  sessionId: string
  runId: string
  workflowId?: string
  agentId: string
  telemetry?: TelemetryShim
  session: SandboxSession
}, toolId: string): SandboxSession {
  if (!args.telemetry || args.session.executor === 'unavailable') return args.session
  return {
    ...args.session,
    executor: args.session.executor,
    read: args.session.read.bind(args.session),
    readText: args.session.readText.bind(args.session),
    write: args.session.write.bind(args.session),
    remove: args.session.remove.bind(args.session),
    list: args.session.list.bind(args.session),
    stat: args.session.stat.bind(args.session),
    exists: args.session.exists.bind(args.session),
    mount: args.session.mount.bind(args.session),
    close: args.session.close.bind(args.session),
    exec: async (command, opts) => args.telemetry!.span('harness.sandbox.exec', {
      'harness.name': args.harnessName,
      'harness.session.id': args.sessionId,
      'harness.run.id': args.runId,
      ...(args.workflowId ? { 'harness.workflow.id': args.workflowId } : {}),
      'harness.agent.id': args.agentId,
      'harness.tool.id': toolId
    }, async (span) => {
      const result = await args.session.exec(command, opts)
      span.setAttributes({
        'harness.exec.exit_code': result.exitCode,
        'harness.exec.duration': result.durationSeconds
      })
      return result
    })
  }
}
