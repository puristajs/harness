import { z } from 'zod'
import {
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE
} from '@opentelemetry/semantic-conventions/incubating'
import { AgentLoopBudgetError, HarnessError, OperationCancelledError, OperationTimeoutError, PermissionDeniedError, PolicyDeniedError, PolicyEvaluationError, SkillManifestError, ToolError, ToolNotFoundError, ValidationError, serializeError } from '../errors/index.js'
import type { Logger } from '../logger/index.js'
import type { JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import type { AgentDefinition, BuiltinToolName, ContextCheckpoints, GovernanceConfig, GovernanceContext, GovernanceDecision, GovernanceEffect, GovernanceExposureEffect, GovernancePolicyEvaluator, GovernanceToolExposureContext, ModelHandles, NativePolicyDefinition, PermissionMode, PermissionPolicy, ResolvedSkill, RunEvent, ToolsConfig } from '../harness/defineHarness.js'
import type { MemoryFacade } from '../ports/memory.js'
import type { ModelCallOptions, ModelMessage, ModelToolSpec, ObjectResponse, ToolCallSpec } from '../ports/model-provider.js'
import type { SandboxSession, SpawnCapableSandboxSession } from '../sandbox/index.js'
import { createMetrics, type Metrics, type TelemetryShim } from '../telemetry/index.js'
import { buildSkillIndex, mountSkillsOnce } from '../skills/index.js'
import { BUILTIN_ALIAS_TO_CANONICAL, getBuiltinToolSpecs, invokeBuiltinTool } from '../tools/index.js'
import { getMcpToolSpecs, invokeMcpTool, isMcpToolDefinition, type McpRunnerRegistry } from '../tools/mcp/runner.js'
import { ulid } from '../ulid/index.js'
import { abortError, withAbortSignal } from '../runtime/abort.js'
import { metadataSpanAttrs } from '../telemetry/span-attrs.js'

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
  delegationCallId?: string
  delegationDepth?: number
  input: unknown
  history: Message[]
  agent: AgentDefinition<any>
  modelAlias?: string
  models: Record<string, any>
  skills: Record<string, ResolvedSkill>
  customTools: ToolsConfig
  governance?: GovernanceConfig<any>
  mcpRegistry?: McpRunnerRegistry
  session: SandboxSession
  memory: MemoryFacade
  checkpoints: ContextCheckpoints
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
    ...(args.delegationCallId ? { 'harness.agent.delegation_call_id': args.delegationCallId } : {}),
    ...(args.delegationDepth !== undefined ? { 'harness.agent.delegation_depth': args.delegationDepth } : {}),
    'harness.agent.id': args.agentId,
    'gen_ai.operation.name': 'invoke_agent',
    'openinference.span.kind': 'AGENT',
    'metadata.agent_name': args.agentId,
    'metadata.agent_id': args.agentId,
    [ATTR_GEN_AI_AGENT_NAME]: args.agentId,
    [ATTR_GEN_AI_AGENT_ID]: args.agentId,
    'harness.agent.model': args.modelAlias ?? args.agent.model,
    ...(args.modelAlias && args.modelAlias !== args.agent.model ? { 'harness.agent.default_model': args.agent.model } : {}),
    'harness.agent.has_handler': args.agent.handler !== undefined,
    ...metadataSpanAttrs(args.metadata)
  }
  const metrics = createMetrics(args.telemetry, agentAttrs)
  // Spec 08 §9: the harness tracks activated skill names per run when the
  // `read` tool loads `/skills/<name>/SKILL.md`. Only the count is emitted —
  // skill names stay out of telemetry.
  const activatedSkills = new Set<string>()
  return args.telemetry.span(`invoke_agent ${args.agentId}`, agentAttrs, async (span) => {
    try {
      return await runDefaultAgentInner({ ...args, metrics, activatedSkills })
    } finally {
      span.setAttribute('harness.agent.skills_activated', activatedSkills.size)
    }
  })
}

async function runDefaultAgentInner(args: {
  harnessName: string
  agentId: string
  runId: string
  sessionId: string
  workflowId?: string
  delegationCallId?: string
  delegationDepth?: number
  input: unknown
  history: Message[]
  agent: AgentDefinition<any>
  modelAlias?: string
  models: Record<string, any>
  skills: Record<string, ResolvedSkill>
  customTools: ToolsConfig
  governance?: GovernanceConfig<any>
  mcpRegistry?: McpRunnerRegistry
  session: SandboxSession
  memory: MemoryFacade
  checkpoints: ContextCheckpoints
  mountedSkills: Set<string>
  activatedSkills: Set<string>
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

  const selectedModelAlias = args.modelAlias ?? args.agent.model
  if (!args.models[selectedModelAlias]) throw new ValidationError('Unknown model alias', { where: 'agent_input', issues: { model: selectedModelAlias } })
  const skillIds = args.agent.skills ?? []
  await mountSkillsOnce(args.session, args.mountedSkills, args.skills, skillIds)

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
      checkpoints: args.checkpoints,
      metadata: args.metadata ?? {},
      metrics: args.metrics
    }))
    const validated = parseAgentSchema(outputSchema, output, 'agent_output')
    return { output: validated as JsonValue, emitted: [{ id: `msg_${ulid()}_a`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: JSON.stringify(validated), timestamp: new Date().toISOString() }] }
  }

  const baseInstructions = typeof args.agent.instructions === 'function'
    ? args.agent.instructions({ input: parsedInput, runId: args.runId, sessionId: args.sessionId, history: { list: async () => args.history }, memory: args.memory, checkpoints: args.checkpoints, metadata: args.metadata ?? {}, metrics: args.metrics })
    : args.agent.instructions
  const instructions = `${baseInstructions}${buildSkillIndex(args.skills, skillIds)}`

  const enabledBuiltins: BuiltinToolName[] = args.agent.builtinTools === false ? [] : (args.agent.builtinTools?.slice() as BuiltinToolName[] | undefined) ?? ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'list']
  if (skillIds.length > 0 && !enabledBuiltins.includes('read')) {
    throw new SkillManifestError('Agents with skills require the read built-in tool for skill activation.', {
      reason: 'skill_read_tool_missing',
      agent_id: args.agentId
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
  const allToolSpecs = [...builtinSpecs, ...customSpecs]

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
  const maxSteps = args.agent.maxSteps ?? args.maxSteps
  let steps = 0

  const agentEventMeta = {
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    ...(args.delegationCallId ? { delegationCallId: args.delegationCallId } : {}),
    ...(args.delegationDepth !== undefined ? { delegationDepth: args.delegationDepth } : {}),
    modelAlias: selectedModelAlias
  }

  await args.emitEvent?.({ type: 'agent.started', runId: args.runId, agentId: args.agentId, at: new Date().toISOString(), ...agentEventMeta })

  try {
    while (true) {
      if (args.signal.aborted) throw abortError(args.signal, 'run', 'Run was cancelled.')
      if (steps >= maxSteps) throw new AgentLoopBudgetError('Agent loop budget exceeded.', { agent_id: args.agentId, reason: 'iterations_exceeded', limit: maxSteps })
      const prepared = await args.agent.prepareStep?.({
        input: parsedInput,
        runId: args.runId,
        sessionId: args.sessionId,
        history: { list: async () => args.history },
        memory: args.memory,
        checkpoints: args.checkpoints,
        metadata: args.metadata ?? {},
        metrics: args.metrics,
        step: steps,
        model: selectedModelAlias,
        messages: modelMessages,
        tools: allToolSpecs
      })
      const stepModelAlias = prepared?.model ?? selectedModelAlias
      const model = args.models[stepModelAlias]
      if (!model) throw new ValidationError('Unknown model alias', { where: 'agent_input', issues: { model: stepModelAlias } })
      const stepTools = await applyGovernanceToolExposure(args, filterActiveTools(allToolSpecs, prepared?.activeTools, args.agentId), steps)
      const stepMessages = prepared?.messages ? [...prepared.messages] : modelMessages
      const stepInstructions = prepared?.instructions ?? instructions
      const response = await model.object({
        messages: [
          { role: 'system', content: stepInstructions },
          ...stepMessages
        ],
        tools: stepTools,
        schema: z.toJSONSchema(outputSchema) as JsonValue,
        ...(prepared?.call ? { call: prepared.call as ModelCallOptions } : {})
      }, args.signal, {
        harnessName: args.harnessName,
        sessionId: args.sessionId,
        runId: args.runId,
        ...(args.workflowId ? { workflowId: args.workflowId } : {}),
        agentId: args.agentId,
        modelAlias: stepModelAlias
      })

      // Emit one usage-bearing model event per model round-trip (including
      // tool-call steps) so run-summary modelCalls and tokenTotals are accurate
      // for multi-step runs.
      await args.emitEvent?.({
        type: 'model.object',
        runId: args.runId,
        agentId: args.agentId,
        ...(args.workflowId ? { workflowId: args.workflowId } : {}),
        modelAlias: stepModelAlias,
        object: (response.object ?? null) as JsonValue,
        usage: response.usage
      })

      const toolCalls = (response.toolCalls ?? []) as ToolCallSpec[]
      ensureToolCallsWereExposed(toolCalls, stepTools)
      if (await shouldStopAgentLoop(args, parsedInput, stepModelAlias, steps, modelMessages, allToolSpecs, response as ObjectResponse<JsonValue>, toolCalls)) {
        const validated = parseAgentSchema(outputSchema, response.object, 'agent_output')
        emitted.push({ id: `msg_${ulid()}_a`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: JSON.stringify(validated), timestamp: new Date().toISOString() })
        await args.emitEvent?.({ type: 'agent.finished', runId: args.runId, agentId: args.agentId, at: new Date().toISOString(), output: validated as JsonValue, ...agentEventMeta })
        return { output: validated as JsonValue, emitted }
      }
      if (toolCalls.length === 0) {
        const validated = parseAgentSchema(outputSchema, response.object, 'agent_output')
        emitted.push({ id: `msg_${ulid()}_a`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: JSON.stringify(validated), timestamp: new Date().toISOString() })
        await args.emitEvent?.({ type: 'agent.finished', runId: args.runId, agentId: args.agentId, at: new Date().toISOString(), output: validated as JsonValue, ...agentEventMeta })
        return { output: validated as JsonValue, emitted }
      }

      const assistantMsg: Message = {
        id: `msg_${ulid()}_assistant`, sessionId: args.sessionId, runId: args.runId, role: 'assistant', content: '', toolCalls,
        timestamp: new Date().toISOString()
      }
      emitted.push(assistantMsg)
      // Provider round-trip items (e.g. OpenAI Responses reasoning items) stay
      // local to the loop; they are replayed on the next round, not persisted.
      modelMessages.push({ role: 'assistant', content: assistantMsg.content, toolCalls, ...(response.providerItems ? { providerItems: response.providerItems } : {}) })

      args.metrics.histogram('harness.agent.tool_batch.size', toolCalls.length, {
        'harness.agent.tool_batch.max_parallel': args.maxParallelToolCalls
      })
      const outcomes = await runLimited(toolCalls, args.maxParallelToolCalls, (call) => executeToolCall({
        ...args,
        enabledCustomTools
      }, call))
      for (const outcome of outcomes) {
        emitted.push(outcome.emitted)
        modelMessages.push(outcome.modelMessage)
      }
      steps += 1
    }
  } catch (error) {
    // Pair every agent.started with an agent.finished, even on error/cancel/budget.
    await args.emitEvent?.({ type: 'agent.finished', runId: args.runId, agentId: args.agentId, at: new Date().toISOString(), error: serializeError(error), ...agentEventMeta })
    throw error
  }
}

function filterActiveTools(tools: readonly ModelToolSpec[], activeTools: readonly string[] | undefined, agentId: string): ModelToolSpec[] {
  if (!activeTools) return [...tools]
  const requested = new Set(activeTools)
  const filtered = tools.filter((tool) => requested.has(tool.name))
  if (filtered.length !== requested.size) {
    const available = new Set(tools.map((tool) => tool.name))
    const unknown = [...requested].filter((name) => !available.has(name))
    throw new ValidationError('prepareStep referenced an unknown active tool.', {
      where: 'agent_input',
      issues: { agentId, activeTools: unknown }
    })
  }
  return filtered
}

async function applyGovernanceToolExposure(
  args: Parameters<typeof runDefaultAgentInner>[0],
  tools: readonly ModelToolSpec[],
  step: number
): Promise<ModelToolSpec[]> {
  const governance = args.governance
  const exposure = governance?.exposure
  if (!governance || governance.enabled === false || !exposure) return [...tools]

  const rules = exposure.rules ?? []
  const defaultEffect = exposure.defaultEffect ?? 'expose'
  if (rules.length === 0 && defaultEffect === 'expose') return [...tools]

  const enforced = governance.mode !== 'shadow'
  const policyId = exposure.id ?? 'governance.exposure'
  const policyVersion = exposure.version
  const visible: ModelToolSpec[] = []

  for (const tool of tools) {
    const decisions = await evaluateGovernanceExposureRules({
      args,
      defaultEffect,
      policyId,
      ...(policyVersion ? { policyVersion } : {}),
      rules,
      step,
      toolId: tool.name
    })
    const winner = strongestGovernanceExposureDecision(decisions)
    const shouldHide = enforced && winner.effect === 'hide'

    for (const decision of decisions) {
      if (decision.ruleId !== 'default' || decision.effect === 'hide') {
        await args.emitEvent?.({
          type: 'policy.exposure',
          runId: args.runId,
          agentId: args.agentId,
          toolId: tool.name,
          decisionId: decision.decisionId,
          policyId: decision.policyId,
          ...(decision.policyVersion ? { policyVersion: decision.policyVersion } : {}),
          ...(decision.ruleId && decision.ruleId !== 'default' ? { ruleId: decision.ruleId } : {}),
          effect: decision.effect,
          enforced: enforced && winner.effect === 'hide' && decision.effect === 'hide',
          step,
          ...(decision.message ? { message: decision.message } : {}),
          ...(decision.reason ? { reason: decision.reason } : {}),
          ...(decision.riskLevel ? { riskLevel: decision.riskLevel } : {}),
          ...(decision.tags ? { tags: decision.tags } : {})
        })
      }
    }

    if (!shouldHide) visible.push(tool)
  }

  return visible
}

type GovernanceExposureDecision = {
  decisionId: string
  effect: GovernanceExposureEffect
  policyId: string
  policyVersion?: string
  ruleId?: string
  message?: string
  reason?: string
  riskLevel?: GovernanceDecision['riskLevel']
  tags?: readonly string[]
  metadata?: Record<string, JsonValue>
}

async function evaluateGovernanceExposureRules(input: {
  args: Parameters<typeof runDefaultAgentInner>[0]
  defaultEffect: GovernanceExposureEffect
  policyId: string
  policyVersion?: string
  rules: NonNullable<NonNullable<GovernanceConfig<any>['exposure']>['rules']>
  step: number
  toolId: string
}): Promise<GovernanceExposureDecision[]> {
  const { args, defaultEffect, policyId, policyVersion, rules, step, toolId } = input
  const ctx: GovernanceToolExposureContext = {
    toolId,
    agentId: args.agentId,
    runId: args.runId,
    sessionId: args.sessionId,
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    step,
    metadata: args.metadata ?? {}
  }
  const decisions: GovernanceExposureDecision[] = []

  for (const rule of rules) {
    if (rule.tools && !rule.tools.includes(toolId as never)) continue
    let matched = false
    try {
      matched = rule.when ? await rule.when(ctx as never) : true
    } catch (error) {
      throw new PolicyEvaluationError('Governance exposure predicate failed.', {
        tool_name: toolId,
        agent_id: args.agentId,
        policy_id: policyId,
        rule_id: rule.id,
        reason: 'predicate_failed'
      }, error)
    }
    if (!matched) continue
    decisions.push({
      decisionId: createGovernanceDecisionId(args.runId, `step-${step}`, policyId, rule.id, decisions.length),
      effect: rule.effect,
      policyId,
      ...(policyVersion ? { policyVersion } : {}),
      ruleId: rule.id,
      ...(rule.message ? { message: rule.message } : {}),
      ...(rule.reason ? { reason: rule.reason } : {}),
      ...(rule.riskLevel ? { riskLevel: rule.riskLevel } : {}),
      ...(rule.tags ? { tags: rule.tags } : {}),
      ...(rule.metadata ? { metadata: rule.metadata } : {})
    })
  }

  if (decisions.length > 0) return decisions

  return [{
    decisionId: createGovernanceDecisionId(args.runId, `step-${step}`, policyId, 'default', 0),
    effect: defaultEffect,
    policyId,
    ...(policyVersion ? { policyVersion } : {}),
    ruleId: 'default',
    message: defaultEffect === 'hide'
      ? 'No exposure rule matched; governance exposure default hides the tool.'
      : 'No exposure rule matched; governance exposure default exposes the tool.'
  }]
}

function strongestGovernanceExposureDecision(decisions: readonly GovernanceExposureDecision[]): GovernanceExposureDecision {
  return [...decisions].sort((left, right) => governanceExposureRank(right.effect) - governanceExposureRank(left.effect))[0] as GovernanceExposureDecision
}

function governanceExposureRank(effect: GovernanceExposureEffect): number {
  return effect === 'hide' ? 2 : 1
}

function ensureToolCallsWereExposed(toolCalls: readonly ToolCallSpec[], tools: readonly ModelToolSpec[]): void {
  const available = new Set(tools.map((tool) => tool.name))
  for (const call of toolCalls) {
    if (!available.has(call.name)) {
      throw new ToolNotFoundError('Model requested a tool that was not exposed for this step.', {
        tool_id: call.name,
        where: 'model_response'
      })
    }
  }
}

async function shouldStopAgentLoop(
  args: Parameters<typeof runDefaultAgentInner>[0],
  input: unknown,
  selectedModelAlias: string,
  step: number,
  messages: readonly ModelMessage[],
  tools: readonly ModelToolSpec[],
  response: ObjectResponse<JsonValue>,
  toolCalls: readonly ToolCallSpec[]
): Promise<boolean> {
  if (!args.agent.stopWhen) return false
  return args.agent.stopWhen({
    input,
    runId: args.runId,
    sessionId: args.sessionId,
    history: { list: async () => args.history },
    memory: args.memory,
    checkpoints: args.checkpoints,
    metadata: args.metadata ?? {},
    metrics: args.metrics,
    step,
    model: selectedModelAlias,
    messages,
    tools,
    response,
    toolCalls
  })
}

/** Runs `fn` over `items` with bounded concurrency, preserving input order. */
export async function runLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const concurrency = Math.max(1, Math.min(limit, items.length))
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const index = next
      next += 1
      // Index-based termination: an `undefined` element must not truncate the batch.
      if (index >= items.length) return
      results[index] = await fn(items[index] as T)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

async function executeToolCall(
  args: Parameters<typeof runDefaultAgentInner>[0] & {
    enabledCustomTools: Set<string>
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
    result = await withToolSpan(args, canonical, call.id, toolKind, tool && isMcpToolDefinition(tool) ? { server: canonical, upstreamTool: tool.tool, transport: tool.kind === 'mcp_stdio' ? 'stdio' : 'http' } : undefined, async () => {
      const permission = await withToolSignal(args.signal, args.toolTimeoutMs, () => checkPermission(args.agentId, args.runId, args.sessionId, args.agent, canonical, input))
      if (permission.decision === 'deny') {
        throw new PermissionDeniedError('Permission denied.', { tool_name: canonical, agent_id: args.agentId, reason: permission.reason })
      }
      if (canonical in BUILTIN_ALIAS_TO_CANONICAL) {
        await enforceGovernance(args, canonical, input, call.id)
        await args.emitEvent?.({ type: 'tool.started', runId: args.runId, agentId: args.agentId, toolId: canonical, callId: call.id, input: input as JsonValue })
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
        await enforceGovernance(args, canonical, input, call.id)
        await args.emitEvent?.({ type: 'tool.started', runId: args.runId, agentId: args.agentId, toolId: canonical, callId: call.id, input: input as JsonValue })
        return { output: await withToolSignal(args.signal, args.toolTimeoutMs, (signal) => invokeMcpTool(canonical, tool, input, { registry, signal, toolTimeoutMs: args.toolTimeoutMs, sandbox: withSandboxTelemetry(args, canonical), sandboxKey: args.sessionId })) }
      }
      if (tool.kind && tool.kind !== 'ts') {
        throw new ValidationError('Unsupported tool kind.', { where: 'tool_input', issues: { toolId: canonical, kind: tool.kind } })
      }
      const parsed = tool.input.parse(input)
      await enforceGovernance(args, canonical, parsed, call.id)
      await args.emitEvent?.({ type: 'tool.started', runId: args.runId, agentId: args.agentId, toolId: canonical, callId: call.id, input: input as JsonValue })
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
      const cancellation = args.signal.aborted
        ? new OperationCancelledError('Run was cancelled.', { scope: 'run' }, args.signal.reason ?? failure)
        : failure
      // Pair tool.started with a best-effort tool.finished even on cancellation,
      // matching the deliberate started/finished pairing policy above.
      try {
        await args.emitEvent?.({ type: 'tool.finished', runId: args.runId, agentId: args.agentId, toolId: canonical, callId: call.id, error: serializeError(cancellation) })
      } catch {
        // Best-effort: never mask the cancellation with an emit failure.
      }
      throw cancellation
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

async function enforceGovernance(
  args: Parameters<typeof runDefaultAgentInner>[0],
  toolId: string,
  input: unknown,
  callId: string
): Promise<void> {
  const governance = args.governance
  if (!governance || governance.enabled === false) return
  if ((governance.policies ?? []).length === 0) return

  const decisions = await evaluateGovernance(args, governance, toolId, input)
  const defaultEffect = governance.defaultEffect ?? 'deny'
  if (decisions.length === 0 && defaultEffect === 'allow') return
  const effectiveDecisions = decisions.length > 0
    ? decisions
    : [{ effect: 'deny' as const, policyId: 'governance.default', ruleId: 'default', message: 'No governance policy allowed the tool call.' }]
  const materializedDecisions: Array<GovernanceDecision & { decisionId: string }> = effectiveDecisions.map((decision, index) => ({
    ...decision,
    decisionId: decision.decisionId ?? createGovernanceDecisionId(args.runId, callId, decision.policyId, decision.ruleId, index)
  }))
  const winner = strongestGovernanceDecision(materializedDecisions)
  const enforced = governance.mode !== 'shadow'

  for (const decision of materializedDecisions) {
    await args.emitEvent?.({
      type: 'policy.evaluated',
      runId: args.runId,
      agentId: args.agentId,
      toolId,
      callId,
      decisionId: decision.decisionId,
      policyId: decision.policyId,
      ...(decision.policyVersion ? { policyVersion: decision.policyVersion } : {}),
      ...(decision.ruleId ? { ruleId: decision.ruleId } : {}),
      effect: decision.effect,
      enforced: enforced && (decision.effect === 'deny' || decision.effect === 'require_approval'),
      ...(decision.message ? { message: decision.message } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
      ...(decision.riskLevel ? { riskLevel: decision.riskLevel } : {}),
      ...(decision.tags ? { tags: decision.tags } : {})
    })
    await governance.audit?.record(decision, {
      toolId,
      callId,
      agentId: args.agentId,
      runId: args.runId,
      sessionId: args.sessionId,
      ...(args.workflowId ? { workflowId: args.workflowId } : {}),
      metadata: args.metadata ?? {},
      enforced
    })
  }

  if (!enforced) return

  if (winner.effect === 'deny') {
    throw new PolicyDeniedError(winner.message ?? 'Tool call denied by governance policy.', {
      tool_name: toolId,
      agent_id: args.agentId,
      policy_id: winner.policyId,
      ...(winner.ruleId ? { rule_id: winner.ruleId } : {}),
      effect: winner.effect,
      reason: 'policy_deny'
    })
  }

  if (winner.effect !== 'require_approval') return

  if (!governance.approval) {
    throw new PolicyDeniedError('Tool call requires approval, but no approval provider is configured.', {
      tool_name: toolId,
      agent_id: args.agentId,
      policy_id: winner.policyId,
      ...(winner.ruleId ? { rule_id: winner.ruleId } : {}),
      effect: winner.effect,
      reason: 'approval_unavailable'
    })
  }

  const approvalDecisions = materializedDecisions.filter((decision) => decision.effect === 'require_approval')
  const approvalId = `${winner.decisionId}:approval`
  await args.emitEvent?.({
    type: 'approval.requested',
    runId: args.runId,
    agentId: args.agentId,
    toolId,
    callId,
    approvalId,
    decisionId: winner.decisionId,
    policyId: winner.policyId,
    ...(winner.policyVersion ? { policyVersion: winner.policyVersion } : {}),
    ...(winner.ruleId ? { ruleId: winner.ruleId } : {})
  })
  const approval = await withToolSignal(args.signal, args.toolTimeoutMs, () => governance.approval!.request({
    approvalId,
    toolId,
    callId,
    agentId: args.agentId,
    runId: args.runId,
    sessionId: args.sessionId,
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    decisions: approvalDecisions,
    metadata: args.metadata ?? {}
  }))
  await args.emitEvent?.({
    type: 'approval.finished',
    runId: args.runId,
    agentId: args.agentId,
    toolId,
    callId,
    approvalId,
    decisionId: winner.decisionId,
    policyId: winner.policyId,
    ...(winner.policyVersion ? { policyVersion: winner.policyVersion } : {}),
    ...(winner.ruleId ? { ruleId: winner.ruleId } : {}),
    decision: approval.decision,
    ...(approval.approverId ? { approverId: approval.approverId } : {}),
    ...(approval.reason ? { reason: approval.reason } : {})
  })

  if (approval.decision === 'rejected') {
    throw new PolicyDeniedError(approval.reason ?? 'Tool call approval was rejected.', {
      tool_name: toolId,
      agent_id: args.agentId,
      policy_id: winner.policyId,
      ...(winner.ruleId ? { rule_id: winner.ruleId } : {}),
      effect: winner.effect,
      reason: 'approval_rejected'
    })
  }
}

async function evaluateGovernance(
  args: Parameters<typeof runDefaultAgentInner>[0],
  governance: GovernanceConfig<any>,
  toolId: string,
  input: unknown
): Promise<GovernanceDecision[]> {
  const ctx: GovernanceContext = {
    toolId,
    input: input as JsonValue,
    agentId: args.agentId,
    runId: args.runId,
    sessionId: args.sessionId,
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    metadata: args.metadata ?? {}
  }
  const decisions: GovernanceDecision[] = []

  for (const policy of governance.policies ?? []) {
    if ('kind' in policy && policy.kind === 'native') {
      decisions.push(...await evaluateNativePolicy(policy, ctx, args.agentId))
      continue
    }

    try {
      const result = await (policy as GovernancePolicyEvaluator).evaluate(ctx)
      const normalized = Array.isArray(result) ? result : result ? [result] : []
      for (const decision of normalized) {
        if (!isGovernanceEffect(decision.effect)) {
          throw new PolicyEvaluationError('Governance policy returned an invalid effect.', {
            tool_name: toolId,
            agent_id: args.agentId,
            policy_id: policy.id,
            reason: 'invalid_decision'
          })
        }
        decisions.push({
          ...decision,
          policyId: decision.policyId ?? policy.id,
          ...(!decision.policyVersion && policy.version ? { policyVersion: policy.version } : {})
        })
      }
    } catch (error) {
      if (error instanceof PolicyEvaluationError) throw error
      throw new PolicyEvaluationError('Governance policy adapter failed.', {
        tool_name: toolId,
        agent_id: args.agentId,
        policy_id: policy.id,
        reason: 'adapter_failed'
      }, error)
    }
  }

  return decisions
}

async function evaluateNativePolicy(policy: NativePolicyDefinition, ctx: GovernanceContext, agentId: string): Promise<GovernanceDecision[]> {
  const decisions: GovernanceDecision[] = []
  for (const rule of policy.rules) {
    if (rule.tools && !rule.tools.includes(ctx.toolId as never)) continue
    let matched = false
    try {
      matched = rule.when ? await rule.when(ctx as never) : true
    } catch (error) {
      throw new PolicyEvaluationError('Governance policy predicate failed.', {
        tool_name: ctx.toolId,
        agent_id: agentId,
        policy_id: policy.id,
        rule_id: rule.id,
        reason: 'predicate_failed'
      }, error)
    }
    if (!matched) continue
    decisions.push({
      effect: rule.effect,
      policyId: policy.id,
      ...(policy.version ? { policyVersion: policy.version } : {}),
      ruleId: rule.id,
      ...(rule.message ? { message: rule.message } : {}),
      ...(rule.reason ? { reason: rule.reason } : {}),
      ...(rule.riskLevel ? { riskLevel: rule.riskLevel } : {}),
      ...(rule.tags ? { tags: rule.tags } : {}),
      ...(rule.metadata ? { metadata: rule.metadata } : {})
    })
  }
  return decisions
}

function strongestGovernanceDecision<T extends GovernanceDecision>(decisions: readonly T[]): T {
  return [...decisions].sort((left, right) => governanceRank(right.effect) - governanceRank(left.effect))[0] as T
}

function governanceRank(effect: GovernanceEffect): number {
  if (effect === 'deny') return 4
  if (effect === 'require_approval') return 3
  if (effect === 'audit') return 2
  return 1
}

function isGovernanceEffect(effect: unknown): effect is GovernanceEffect {
  return effect === 'allow' || effect === 'audit' || effect === 'require_approval' || effect === 'deny'
}

function createGovernanceDecisionId(runId: string, callId: string, policyId: string, ruleId: string | undefined, index: number): string {
  return [
    'gvd',
    sanitizeDecisionIdPart(runId),
    sanitizeDecisionIdPart(callId),
    sanitizeDecisionIdPart(policyId),
    sanitizeDecisionIdPart(ruleId ?? 'policy'),
    String(index)
  ].join(':')
}

function sanitizeDecisionIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 160)
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
  const attrs = {
    'harness.name': args.harnessName,
    'harness.session.id': args.sessionId,
    'harness.run.id': args.runId,
    ...(args.workflowId ? { 'harness.workflow.id': args.workflowId } : {}),
    'harness.agent.id': args.agentId,
    'harness.tool.id': toolId
  }
  const wrapped: SandboxSession & Partial<SpawnCapableSandboxSession> = {
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
    exec: async (command, opts) => args.telemetry!.span('harness.sandbox.exec', attrs, async (span) => {
      const result = await args.session.exec(command, opts)
      span.setAttributes({
        'harness.exec.exit_code': result.exitCode,
        'harness.exec.duration': result.durationSeconds
      })
      return result
    })
  }
  const spawn = (args.session as Partial<SpawnCapableSandboxSession>).spawn
  if (typeof spawn === 'function') {
    wrapped.spawn = async (command, opts) => args.telemetry!.span('harness.sandbox.spawn', attrs, async () =>
      spawn.call(args.session, command, opts))
  }
  return wrapped
}
