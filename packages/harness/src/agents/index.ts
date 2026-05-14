import { z } from 'zod'
import {
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE
} from '@opentelemetry/semantic-conventions/incubating'
import { AgentLoopBudgetError, HarnessError, OperationCancelledError, OperationTimeoutError, PermissionDeniedError, ToolError, ToolNotFoundError, ValidationError, serializeError } from '../errors/index.js'
import type { Logger } from '../logger/index.js'
import type { JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import type { AgentDefinition, BuiltinToolName, ModelHandles, ResolvedSkill, RunEvent, SessionMemory, ToolsConfig } from '../harness/defineHarness.js'
import type { ModelMessage } from '../ports/model-provider.js'
import type { SandboxSession } from '../sandbox/index.js'
import { createMetrics, type Metrics, type TelemetryShim } from '../telemetry/index.js'
import { buildSkillIndex, mountSkillsOnce } from '../skills/index.js'
import { BUILTIN_ALIAS_TO_CANONICAL, getBuiltinToolSpecs, invokeBuiltinTool } from '../tools/index.js'
import { getMcpToolSpecs, invokeMcpTool, isMcpToolDefinition, type McpRunnerRegistry } from '../tools/mcp/runner.js'

function stringifyInput(input: unknown): string { return typeof input === 'string' ? input : JSON.stringify(input) }

function isReadonlyBuiltin(name: string): boolean { return ['read', 'list', 'glob', 'grep'].includes(name) }

async function checkPermission(agentId: string, runId: string, sessionId: string, def: AgentDefinition<any>, toolName: string, input: unknown): Promise<'allow' | 'deny'> {
  if (isReadonlyBuiltin(toolName)) return 'allow'
  const perm = (def.permissions as Record<string, unknown> | undefined)?.[toolName]
  const mode = typeof perm === 'string' ? perm : (perm && typeof perm === 'object' && 'mode' in perm ? (perm as { mode: 'allow' | 'ask' | 'deny' }).mode : 'allow')
  if (mode === 'allow') return 'allow'
  if (mode === 'deny') return 'deny'
  if (!def.onPermission) return 'deny'
  try {
    return await def.onPermission({ toolName, input, agentId, runId, sessionId })
  } catch {
    throw new PermissionDeniedError('Permission hook failed.', { tool_name: toolName, agent_id: agentId, reason: 'hook_failed' })
  }
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
  memory: SessionMemory
  mountedSkills: Set<string>
  historyWindow?: number
  maxSteps: number
  signal: AbortSignal
  toolTimeoutMs: number
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
  memory: SessionMemory
  mountedSkills: Set<string>
  historyWindow?: number
  maxSteps: number
  signal: AbortSignal
  toolTimeoutMs: number
  logger: Logger
  telemetry: TelemetryShim
  metrics: Metrics
  emitEvent?: (event: RunEvent) => Promise<void>
  metadata?: Readonly<Record<string, JsonValue>>
}): Promise<{ output: JsonValue; emitted: Message[] }> {
  args.signal.throwIfAborted()
  const inputSchema = args.agent.input ?? z.string()
  const outputSchema = args.agent.output ?? z.string()
  const parsedInput = parseAgentSchema(inputSchema, args.input, 'agent_input')

  const model = args.models[args.agent.model]
  if (!model) throw new ValidationError('Unknown model alias', { where: 'agent_input', issues: { model: args.agent.model } })
  const skillIds = args.agent.skills ?? []
  await mountSkillsOnce(args.session, args.mountedSkills, args.skills, skillIds)

  if (args.agent.handler) {
    const output = await args.agent.handler({
      input: parsedInput,
      signal: args.signal,
      models: args.models as ModelHandles<any>,
      runId: args.runId,
      sessionId: args.sessionId,
      history: { list: async () => args.history },
      memory: args.memory,
      metadata: args.metadata ?? {},
      metrics: args.metrics
    })
    const validated = parseAgentSchema(outputSchema, output, 'agent_output')
    return { output: validated as JsonValue, emitted: [{ id: `msg_${Date.now()}_a`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: JSON.stringify(validated), timestamp: new Date().toISOString() }] }
  }

  const baseInstructions = typeof args.agent.instructions === 'function'
    ? args.agent.instructions({ input: parsedInput, runId: args.runId, sessionId: args.sessionId, history: { list: async () => args.history }, memory: args.memory, metadata: args.metadata ?? {}, metrics: args.metrics })
    : args.agent.instructions
  const instructions = `${baseInstructions}${buildSkillIndex(args.skills, skillIds)}`

  const enabledBuiltins: BuiltinToolName[] = args.agent.builtinTools === false ? [] : (args.agent.builtinTools?.slice() as BuiltinToolName[] | undefined) ?? ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'list']
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
    args.signal.throwIfAborted()
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

    const toolCalls = response.toolCalls ?? []
    if (toolCalls.length === 0) {
      const validated = parseAgentSchema(outputSchema, response.object, 'agent_output')
      emitted.push({ id: `msg_${Date.now()}_a`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: JSON.stringify(validated), timestamp: new Date().toISOString() })
      await args.emitEvent?.({ type: 'model.object', runId: args.runId, agentId: args.agentId, object: validated as JsonValue, usage: response.usage })
      await args.emitEvent?.({ type: 'agent.finished', runId: args.runId, agentId: args.agentId, at: new Date().toISOString(), output: validated as JsonValue })
      return { output: validated as JsonValue, emitted }
    }

    const assistantMsg: Message = {
      id: `msg_${Date.now()}_assistant`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: '', toolCalls,
      timestamp: new Date().toISOString()
    }
    emitted.push(assistantMsg)
    modelMessages.push({ role: 'assistant', content: assistantMsg.content, toolCalls })

    for (const call of toolCalls) {
      const canonical = BUILTIN_ALIAS_TO_CANONICAL[call.name] ?? call.name
      const input = call.arguments
      let result: { output?: JsonValue; error?: ReturnType<typeof serializeError> }
      try {
        args.signal.throwIfAborted()
        await args.emitEvent?.({ type: 'tool.started', runId: args.runId, agentId: args.agentId, toolId: canonical, callId: call.id, input: input as JsonValue })
        const tool = args.customTools[canonical]
        const toolKind: 'builtin' | 'ts' | 'mcp_stdio' | 'mcp_http' = canonical in BUILTIN_ALIAS_TO_CANONICAL ? 'builtin' : tool && isMcpToolDefinition(tool) ? tool.kind : 'ts'
        result = await withToolSpan(args, canonical, call.id, toolKind, tool && isMcpToolDefinition(tool) ? { server: canonical, upstreamTool: tool.tool, transport: tool.kind === 'mcp_stdio' ? 'stdio' : 'http' } : undefined, async () => {
          const decision = await checkPermission(args.agentId, args.runId, args.sessionId, args.agent, canonical, input)
          if (decision === 'deny') {
            throw new PermissionDeniedError('Permission denied.', { tool_name: canonical, agent_id: args.agentId, reason: 'hook_deny' })
          }
          if (canonical in BUILTIN_ALIAS_TO_CANONICAL) {
            return { output: await withToolSignal(args.signal, args.toolTimeoutMs, (signal) => invokeBuiltinTool(canonical, input, withSandboxTelemetry(args, canonical), signal)) }
          }
          if (!enabledCustomTools.has(canonical)) {
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
          const tsTool = tool
          const parsed = tsTool.input.parse(input)
          const out = await withToolSignal(args.signal, args.toolTimeoutMs, (signal) => tsTool.handler({
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
            runId: args.runId,
            sessionId: args.sessionId,
            agentId: args.agentId,
            toolId: canonical
          }, parsed))
          return { output: tsTool.output.parse(out) as JsonValue }
        })
      } catch (error) {
        result = { error: serializeError(normalizeToolFailure(canonical, error)) }
      }
      await args.emitEvent?.({ type: 'tool.finished', runId: args.runId, agentId: args.agentId, toolId: canonical, callId: call.id, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.error ? { error: result.error } : {}) })
      const toolMessage: Message = {
        id: `msg_${Date.now()}_${call.id}`,
        sessionId: args.sessionId,
        runId: args.runId,
        role: 'tool',
        content: '',
        toolResults: [{ toolCallId: call.id, ...(result.output !== undefined ? { output: result.output } : {}), ...(result.error ? { error: result.error } : {}) }],
        timestamp: new Date().toISOString()
      }
      emitted.push(toolMessage)
      modelMessages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result.output ?? result.error ?? {}) })
    }
    steps += 1
  }
}

async function withToolSignal<T>(parent: AbortSignal, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  parent.throwIfAborted()
  const controller = new AbortController()
  const relay = () => controller.abort(parent.reason)
  parent.addEventListener('abort', relay, { once: true })
  const timeout = timeoutMs > 0
    ? setTimeout(() => controller.abort(new OperationTimeoutError('Tool execution timed out.', { scope: 'tool', timeout_ms: timeoutMs })), timeoutMs)
    : undefined
  const timeoutPromise = timeoutMs > 0
    ? new Promise<never>((_, reject) => {
      const check = () => {
        const reason = controller.signal.reason
        reject(reason instanceof Error ? reason : new OperationCancelledError('Tool execution was cancelled.', { scope: 'tool' }, reason))
      }
      controller.signal.addEventListener('abort', check, { once: true })
    })
    : undefined
  try {
    const operation = fn(controller.signal)
    return await (timeoutPromise ? Promise.race([operation, timeoutPromise]) : operation)
  } catch (error) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      if (reason instanceof OperationTimeoutError) throw reason
      throw new OperationCancelledError('Tool execution was cancelled.', { scope: 'tool' }, reason ?? error)
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
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
  toolKind: 'builtin' | 'ts' | 'mcp_stdio' | 'mcp_http',
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
  const execute = async () => {
    try {
      const result = await fn()
      args.telemetry?.recordHistogram('harness.tool.duration', (Date.now() - started) / 1000, attrs)
      return result
    } catch (error) {
      throw normalizeToolFailure(toolId, error)
    }
  }
  return args.telemetry ? args.telemetry.span(`execute_tool ${toolId}`, attrs, execute) : execute()
}

function normalizeToolFailure(toolId: string, error: unknown): HarnessError {
  if (error instanceof z.ZodError) {
    return new ValidationError('Tool input validation failed', { where: 'tool_input', issues: JSON.parse(JSON.stringify(error.issues)) as JsonValue })
  }
  if (error instanceof HarnessError) return error
  return new ToolError('Tool execution failed.', { tool_id: toolId, tool_kind: toolId in BUILTIN_ALIAS_TO_CANONICAL ? 'builtin' : 'ts' }, error)
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
