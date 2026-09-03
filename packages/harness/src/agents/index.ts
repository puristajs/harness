import { z } from 'zod'
import {
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_AGENT_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_CONVERSATION_ID,
} from '@opentelemetry/semantic-conventions/incubating'
import {
  AgentLoopBudgetError,
  DecisionBlockedError,
  DecisionEvaluationError,
  HarnessConfigError,
  HarnessError,
  InternalError,
  OperationCancelledError,
  OperationTimeoutError,
  SkillManifestError,
  ValidationError,
  serializeError,
} from '../errors/index.js'
import type { Logger } from '../logger/index.js'
import { isJsonValue, type JsonValue } from '../models/json.js'
import type { Message } from '../models/state.js'
import type {
  AgentDefinition,
  AgentExecutionInterception,
  AgentExecutionInterceptor,
  AgentModelRequest,
  BuiltinToolName,
  GovernanceConfig,
  ModelHandles,
  ResolvedSkill,
  RunEvent,
  ToolsConfig,
} from '../harness/defineHarness.js'
import type { MemoryFacade } from '../ports/memory.js'
import type {
  ModelCallOptions,
  ModelMessage,
  ModelToolSpec,
  ObjectResponse,
  ToolCallSpec,
} from '../ports/model-provider.js'
import type { SandboxSessionBase } from '../sandbox/index.js'
import { createMetrics, telemetryErrorType, type Metrics, type TelemetryShim } from '../telemetry/index.js'
import { buildSkillIndex, mountSkillsOnce } from '../skills/index.js'
import { getBuiltinToolSpecs, resolveEnabledBuiltinTools } from '../tools/index.js'
import { getMcpToolSpecs, type McpRunnerRegistry } from '../tools/mcp/runner.js'
import { ulid } from '../ulid/index.js'
import { abortError, withAbortSignal } from '../runtime/abort.js'
import { metadataSpanAttrs } from '../telemetry/span-attrs.js'
import { projectToolResults, type ContextProjectionPolicy } from '../context-projection.js'
import { applyToolExposure } from '../governance/index.js'
import {
  createDecisionEvidence,
  decisionResultSchema,
  providerContinuationSchema,
  runDecisionOperation,
} from '../decisions/index.js'
import type { DecisionExecutionContext } from '../decisions/types.js'
import { validateSchema } from '../schema/validation.js'
import type { Schema } from '../schema/index.js'
import { freezeJson, runPreparedToolBatch } from './tool-execution.js'
import { ToolApprovalPendingError, type ToolApprovalCheckpoint, type ToolApprovalResume } from '../approvals/index.js'

const interceptorTransformSchema = decisionResultSchema.options[0].extend({
  decision: z.literal('transform'),
  value: z.unknown(),
})

function stringifyInput(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input)
}

/**
 * Stable within one logical run so a durable/redelivered run never creates a
 * second transcript entry for the same logical message. The HarnessStorage remains
 * the final duplicate-id authority.
 */
function turnMessageId(runId: string, slot: string): string {
  return `msg_${runId}_${slot}`
}

export async function runDefaultAgent(args: {
  harnessName: string
  agentId: string
  runId: string
  sessionId: string
  /** Stable resolved sandbox attachment key for skill and MCP process state. */
  sandboxKey?: string
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
  /** Model JSON Schemas compiled once by the builder. */
  modelSchemas: {
    readonly agentOutput: JsonValue | undefined
    readonly toolInputs: Readonly<Record<string, JsonValue>>
  }
  governance?: GovernanceConfig<any>
  mcpRegistry?: McpRunnerRegistry
  session: SandboxSessionBase
  memory: MemoryFacade
  mountedSkills: Set<string>
  historyWindow?: number
  contextProjection?: ContextProjectionPolicy
  maxSteps: number
  signal: AbortSignal
  toolTimeoutMs: number
  decisionTimeoutMs: number
  runDeadline?: number
  maxParallelToolCalls: number
  logger: Logger
  telemetry: TelemetryShim
  emitEvent?: (event: RunEvent) => Promise<void>
  metadata?: Readonly<Record<string, JsonValue>>
  /** Opaque per-run value forwarded only to bound host tools. */
  hostContext?: unknown
  /** Validated persisted state and authenticated decisions for one approval resume. */
  approvalResume?: { checkpoint: ToolApprovalCheckpoint; resume: ToolApprovalResume }
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
    [ATTR_GEN_AI_CONVERSATION_ID]: args.sessionId,
    ...((args.modelAlias ?? args.agent.model) ? { 'harness.agent.model': args.modelAlias ?? args.agent.model } : {}),
    ...(args.modelAlias && args.agent.model && args.modelAlias !== args.agent.model
      ? { 'harness.agent.default_model': args.agent.model }
      : {}),
    'harness.agent.has_handler': args.agent.handler !== undefined,
    ...metadataSpanAttrs(args.metadata),
  }
  const metrics = createMetrics(args.telemetry, agentAttrs)
  // Spec 08 §9: the harness tracks activated skill names per run when the
  // `read` tool loads `/skills/<name>/SKILL.md`. Only the count is emitted —
  // skill names stay out of telemetry.
  const activatedSkills = new Set<string>()
  const started = Date.now()
  let operationError: unknown
  return args.telemetry.span(`invoke_agent ${args.agentId}`, agentAttrs, async span => {
    try {
      return await runDefaultAgentInner({ ...args, metrics, activatedSkills })
    } catch (error) {
      operationError = error
      throw error
    } finally {
      span.setAttribute('harness.agent.skills_activated', activatedSkills.size)
      args.telemetry.recordHistogram('gen_ai.invoke_agent.duration', (Date.now() - started) / 1000, {
        ...agentAttrs,
        ...(operationError === undefined ? {} : { [ATTR_ERROR_TYPE]: telemetryErrorType(operationError) }),
      })
    }
  })
}

async function runDefaultAgentInner(args: {
  harnessName: string
  agentId: string
  runId: string
  sessionId: string
  sandboxKey?: string
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
  modelSchemas: {
    readonly agentOutput: JsonValue | undefined
    readonly toolInputs: Readonly<Record<string, JsonValue>>
  }
  governance?: GovernanceConfig<any>
  mcpRegistry?: McpRunnerRegistry
  session: SandboxSessionBase
  memory: MemoryFacade
  mountedSkills: Set<string>
  activatedSkills: Set<string>
  historyWindow?: number
  contextProjection?: ContextProjectionPolicy
  maxSteps: number
  signal: AbortSignal
  toolTimeoutMs: number
  decisionTimeoutMs: number
  runDeadline?: number
  maxParallelToolCalls: number
  logger: Logger
  telemetry: TelemetryShim
  metrics: Metrics
  emitEvent?: (event: RunEvent) => Promise<void>
  metadata?: Readonly<Record<string, JsonValue>>
  hostContext?: unknown
  approvalResume?: { checkpoint: ToolApprovalCheckpoint; resume: ToolApprovalResume }
}): Promise<{ output: JsonValue; emitted: Message[] }> {
  if (args.signal.aborted) throw abortError(args.signal, 'run', 'Run was cancelled.')
  const inputSchema = args.agent.input ?? z.string()
  const outputSchema = args.agent.output ?? z.string()
  let parsedInput = args.approvalResume
    ? args.approvalResume.checkpoint.state.input
    : await validateAgentSchema(inputSchema, args.input, 'agent_input', args.signal)
  if (!args.approvalResume) parsedInput = await applyBeforeInputInterceptors(args, parsedInput)
  if (!isJsonValue(parsedInput))
    throw new ValidationError('Agent input validation failed.', {
      where: 'agent_input',
      issues: { count: 0, truncated: false },
    })

  const selectedModelAlias = args.modelAlias ?? args.agent.model
  if (selectedModelAlias !== undefined && !args.models[selectedModelAlias])
    throw new ValidationError('Unknown model alias', { where: 'agent_input', issues: { model: selectedModelAlias } })
  const skillIds = args.agent.skills ?? []
  await mountSkillsOnce(args.session, args.mountedSkills, args.skills, skillIds)

  const agentEventMeta = {
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    ...(args.delegationCallId ? { delegationCallId: args.delegationCallId } : {}),
    ...(args.delegationDepth !== undefined ? { delegationDepth: args.delegationDepth } : {}),
    ...(selectedModelAlias ? { modelAlias: selectedModelAlias } : {}),
  }

  if (args.approvalResume && args.agent.handler) {
    throw new ValidationError('Custom-handler agents cannot resume a model tool approval.', {
      where: 'invoke_options',
      issues: { resume: 'custom_handler_agent' },
    })
  }
  if (args.agent.handler) {
    await args.emitEvent?.({
      type: 'agent.started',
      runId: args.runId,
      agentId: args.agentId,
      at: new Date().toISOString(),
      ...agentEventMeta,
    })
    try {
      const handler = args.agent.handler
      const output = await withAbortSignal(args.signal, 'run', 'Run was cancelled.', () =>
        handler({
          input: parsedInput,
          signal: args.signal,
          models: args.models as ModelHandles<any>,
          logger: args.logger,
          telemetry: args.telemetry,
          runId: args.runId,
          sessionId: args.sessionId,
          history: { list: async () => args.history },
          memory: args.memory,
          metadata: args.metadata ?? {},
          metrics: args.metrics,
        }),
      )
      const validated = await validateAgentSchema(outputSchema, output, 'agent_output', args.signal)
      await args.emitEvent?.({
        type: 'agent.finished',
        runId: args.runId,
        agentId: args.agentId,
        at: new Date().toISOString(),
        output: validated as JsonValue,
        ...agentEventMeta,
      })
      return {
        output: validated as JsonValue,
        emitted: [
          {
            id: turnMessageId(args.delegationCallId ?? args.runId, '01_user'),
            sessionId: args.sessionId,
            runId: args.runId,
            role: 'user',
            content: stringifyInput(parsedInput),
            timestamp: new Date().toISOString(),
          },
          {
            id: turnMessageId(args.delegationCallId ?? args.runId, '99_assistant_final'),
            sessionId: args.sessionId,
            runId: args.runId,
            role: 'assistant',
            content: JSON.stringify(validated),
            timestamp: new Date().toISOString(),
          },
        ],
      }
    } catch (error) {
      await args.emitEvent?.({
        type: 'agent.finished',
        runId: args.runId,
        agentId: args.agentId,
        at: new Date().toISOString(),
        error: serializeError(error),
        ...agentEventMeta,
      })
      throw error
    }
  }

  if (!selectedModelAlias) {
    throw new ValidationError('Default-loop agents require a model alias.', {
      where: 'agent_input',
      issues: { agentId: args.agentId },
    })
  }

  const baseInstructions =
    typeof args.agent.instructions === 'function'
      ? args.agent.instructions({
          input: parsedInput,
          runId: args.runId,
          sessionId: args.sessionId,
          history: { list: async () => args.history },
          memory: args.memory,
          metadata: args.metadata ?? {},
          metrics: args.metrics,
        })
      : args.agent.instructions
  const instructions = `${baseInstructions}${buildSkillIndex(args.skills, skillIds)}`

  const enabledBuiltins: readonly BuiltinToolName[] = resolveEnabledBuiltinTools(args.agent.builtinTools)
  if (skillIds.length > 0 && !enabledBuiltins.includes('read')) {
    throw new SkillManifestError('Agents with skills require the read built-in tool for skill activation.', {
      reason: 'skill_read_tool_missing',
      agent_id: args.agentId,
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
      const schema = args.modelSchemas.toolInputs[name]
      if (schema === undefined) throw new InternalError('Compiled tool schema was unavailable.')
      return [{ name, description: tool.description, parameters: schema }]
    })
  const mcpSpecs = args.mcpRegistry
    ? await getMcpToolSpecs(args.customTools, enabledCustomTools, {
        registry: args.mcpRegistry,
        signal: args.signal,
        toolTimeoutMs: args.toolTimeoutMs,
        sandbox: args.session,
        sandboxKey: args.sandboxKey ?? args.sessionId,
      })
    : []
  const customSpecs = [...tsCustomSpecs, ...mcpSpecs]
  const allToolSpecs = [...builtinSpecs, ...customSpecs]

  // Agent instructions are reconstructed for every request and are the one
  // canonical default-loop system prompt. Durable history intentionally omits
  // those rebuilt records; ignore pre-v2/imported system records here as well
  // so reopening a session can never duplicate or amplify instructions.
  const nonSystem = args.history.filter(m => m.role !== 'system')
  const cappedNonSystem =
    args.historyWindow === undefined ? nonSystem : args.historyWindow === 0 ? [] : nonSystem.slice(-args.historyWindow)
  const modelMessages: ModelMessage[] = args.approvalResume
    ? [...args.approvalResume.checkpoint.state.modelMessages]
    : [
    ...cappedNonSystem,
    {
      id: '',
      sessionId: args.sessionId,
      role: 'user',
      content: stringifyInput(parsedInput),
      timestamp: new Date().toISOString(),
    } as unknown as Message,
  ].flatMap<ModelMessage>((m): ModelMessage[] => {
    if (m.role === 'tool' && m.toolResults) {
          return m.toolResults.map(r => ({
        role: 'tool' as const,
        toolCallId: r.toolCallId,
        content: JSON.stringify(r.output ?? r.error ?? {}),
      }))
    }
    if (m.role === 'tool') return []
    if (m.role === 'assistant') {
      return [
        {
          role: 'assistant' as const,
          content: m.content,
          ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        },
      ]
    }
    return [{ role: 'user' as const, content: m.content }]
  })

  // Build one logical transcript turn locally and commit it only after the
  // agent has completed. Provider retries therefore never mutate durable
  // history, and a logical run has deterministic message ids on redelivery.
  const emitted: Message[] = args.approvalResume
    ? [...args.approvalResume.checkpoint.state.emitted]
    : [
    {
      id: turnMessageId(args.delegationCallId ?? args.runId, '01_user'),
      sessionId: args.sessionId,
      runId: args.runId,
      role: 'user',
      content: stringifyInput(parsedInput),
      timestamp: new Date().toISOString(),
    },
  ]
  const maxSteps = args.agent.maxSteps ?? args.maxSteps
  let steps = args.approvalResume?.checkpoint.state.step ?? 0
  let approvalResume = args.approvalResume
  let pendingProviderContinuation: ObjectResponse<JsonValue>['providerContinuation']
  let pendingModelAlias = selectedModelAlias

  await args.emitEvent?.({
    type: 'agent.started',
    runId: args.runId,
    agentId: args.agentId,
    at: new Date().toISOString(),
    ...agentEventMeta,
  })

  try {
    while (true) {
      if (args.signal.aborted) throw abortError(args.signal, 'run', 'Run was cancelled.')
      if (steps >= maxSteps)
        throw new AgentLoopBudgetError('Agent loop budget exceeded.', {
          agent_id: args.agentId,
          reason: 'iterations_exceeded',
          limit: maxSteps,
        })
      if (approvalResume) {
        const { state } = approvalResume.checkpoint
        pendingModelAlias = state.modelAlias
        pendingProviderContinuation = state.providerContinuation
        const requestedTools = new Set(state.toolCalls.map(call => call.name))
        const stepTools = allToolSpecs.filter(tool => requestedTools.has(tool.name))
        if (stepTools.length !== requestedTools.size) {
          throw new ValidationError('The pending approval references a tool that is no longer available.', {
            where: 'invoke_options',
            issues: { interruptId: approvalResume.resume.interruptId },
          })
        }
        const batch = await runPreparedToolBatch(
          {
            ...args,
            enabledCustomTools,
            step: steps,
            approvalDecisions: approvalResume.resume.decisions,
            turnMessageId: slot => turnMessageId(args.delegationCallId ?? args.runId, slot),
            beforeTool: async (_toolId, _callId, value) => value,
            afterTool: (toolId, callId, value, signal, deadline) =>
              applyAfterToolInterceptors(
                args,
                parsedInput,
                steps,
                state.modelAlias,
                toolId,
                callId,
                value,
                signal,
                deadline,
              ),
          },
          state.toolCalls,
          stepTools,
        )
        const assistantMsg: Message = {
          id: turnMessageId(args.delegationCallId ?? args.runId, `10_assistant_${steps}`),
          sessionId: args.sessionId,
          runId: args.runId,
          role: 'assistant',
          content: '',
          toolCalls: [...batch.calls],
          timestamp: new Date().toISOString(),
        }
        emitted.push(assistantMsg)
        modelMessages.push({
          role: 'assistant',
          content: assistantMsg.content,
          toolCalls: [...batch.calls],
          ...(state.providerContinuation ? { providerContinuation: state.providerContinuation } : {}),
        })
        for (const outcome of batch.outcomes) {
          emitted.push(outcome.emitted)
          modelMessages.push(outcome.modelMessage)
        }
        approvalResume = undefined
        steps += 1
        continue
      }
      const canonicalMessages = freezeJson([...modelMessages])
      let prepared: Awaited<ReturnType<NonNullable<typeof args.agent.prepareStep>>>
      try {
        prepared = await args.agent.prepareStep?.({
          input: parsedInput,
          runId: args.runId,
          sessionId: args.sessionId,
          history: { list: async () => args.history },
          memory: args.memory,
          metadata: args.metadata ?? {},
          metrics: args.metrics,
          step: steps,
          model: selectedModelAlias,
          messages: canonicalMessages,
          tools: freezeJson([...allToolSpecs]),
        })
      } catch (error) {
        throw new DecisionEvaluationError(prepareStepEvidence(args, steps), 'callback_failed', error)
      }
      const stepModelAlias = prepared?.model ?? selectedModelAlias
      pendingModelAlias = stepModelAlias
      const model = args.models[stepModelAlias]
      if (!model)
        throw new ValidationError('Unknown model alias', { where: 'agent_input', issues: { model: stepModelAlias } })
      const stepTools = await applyGovernanceToolExposure(
        args,
        filterActiveTools(allToolSpecs, prepared?.activeTools, args.agentId),
        steps,
      )
      const stepMessages = prepared?.messages ? [...prepared.messages] : modelMessages
      try {
        if (!stepMessages.every(isStrictModelMessage)) throw new Error('Invalid model messages.')
        assertProtectedTranscript(canonicalMessages, stepMessages)
      } catch (error) {
        throw new DecisionEvaluationError(prepareStepEvidence(args, steps), 'invalid_transform', error)
      }
      const stepInstructions = prepared?.instructions ?? instructions
      let request: AgentModelRequest = {
        messages: [{ role: 'system', content: stepInstructions }, ...stepMessages],
        tools: stepTools,
        schema: requireAgentOutputSchema(args),
        ...(prepared?.call ? { call: prepared.call as ModelCallOptions } : {}),
      }
      request = await applyBeforeModelInterceptors(args, parsedInput, steps, stepModelAlias, request, canonicalMessages)
      if (request.tools.some(tool => !stepTools.some(exposed => structurallyEqual(exposed, tool)))) {
        throw new DecisionEvaluationError(prepareStepEvidence(args, steps), 'invalid_transform')
      }
      const modelContext = {
        harnessName: args.harnessName,
        sessionId: args.sessionId,
        runId: args.runId,
        ...(args.workflowId ? { workflowId: args.workflowId } : {}),
        agentId: args.agentId,
        modelAlias: stepModelAlias,
      }
      let response: ObjectResponse<JsonValue>
      try {
        response = await model.object(request, args.signal, modelContext)
      } catch (error) {
        if (
          !args.contextProjection ||
          args.signal.aborted ||
          !(error instanceof HarnessError) ||
          error.meta?.['reason'] !== 'context_length_exceeded'
        )
          throw error
        response = await model.object(
          { ...request, messages: [request.messages[0]!, ...projectToolResults(stepMessages, args.contextProjection)] },
          args.signal,
          modelContext,
        )
      }
      response = await applyAfterModelInterceptors(args, parsedInput, steps, stepModelAlias, request, response)
      pendingProviderContinuation = response.providerContinuation

      const toolCalls = (response.toolCalls ?? []) as ToolCallSpec[]
      if (
        await shouldStopAgentLoop(
          args,
          parsedInput,
          stepModelAlias,
          steps,
          modelMessages,
          allToolSpecs,
          response as ObjectResponse<JsonValue>,
          toolCalls,
        )
      ) {
        const candidate = await applyBeforeOutputInterceptors(
          args,
          parsedInput,
          steps,
          stepModelAlias,
          response.object as JsonValue,
        )
        const validated = await validateAgentSchema(outputSchema, candidate, 'agent_output', args.signal)
        await args.emitEvent?.({
          type: 'model.object',
          runId: args.runId,
          agentId: args.agentId,
          ...(args.workflowId ? { workflowId: args.workflowId } : {}),
          modelAlias: stepModelAlias,
          object: validated as JsonValue,
        })
        emitted.push({
          id: turnMessageId(args.delegationCallId ?? args.runId, '99_assistant_final'),
          sessionId: args.sessionId,
          runId: args.runId,
          role: 'assistant',
          content: JSON.stringify(validated),
          timestamp: new Date().toISOString(),
        })
        await args.emitEvent?.({
          type: 'agent.finished',
          runId: args.runId,
          agentId: args.agentId,
          at: new Date().toISOString(),
          output: validated as JsonValue,
          ...agentEventMeta,
        })
        return { output: validated as JsonValue, emitted }
      }
      if (toolCalls.length === 0) {
        const candidate = await applyBeforeOutputInterceptors(
          args,
          parsedInput,
          steps,
          stepModelAlias,
          response.object as JsonValue,
        )
        const validated = await validateAgentSchema(outputSchema, candidate, 'agent_output', args.signal)
        await args.emitEvent?.({
          type: 'model.object',
          runId: args.runId,
          agentId: args.agentId,
          ...(args.workflowId ? { workflowId: args.workflowId } : {}),
          modelAlias: stepModelAlias,
          object: validated as JsonValue,
        })
        emitted.push({
          id: turnMessageId(args.delegationCallId ?? args.runId, '99_assistant_final'),
          sessionId: args.sessionId,
          runId: args.runId,
          role: 'assistant',
          content: JSON.stringify(validated),
          timestamp: new Date().toISOString(),
        })
        await args.emitEvent?.({
          type: 'agent.finished',
          runId: args.runId,
          agentId: args.agentId,
          at: new Date().toISOString(),
          output: validated as JsonValue,
          ...agentEventMeta,
        })
        return { output: validated as JsonValue, emitted }
      }

      const batch = await runPreparedToolBatch(
        {
          ...args,
          enabledCustomTools,
          step: steps,
          turnMessageId: slot => turnMessageId(args.delegationCallId ?? args.runId, slot),
          beforeTool: (toolId, callId, value, signal, deadline) =>
            applyBeforeToolInterceptors(
              args,
              parsedInput,
              steps,
              stepModelAlias,
              toolId,
              callId,
              value,
              signal,
              deadline,
            ),
          afterTool: (toolId, callId, value, signal, deadline) =>
            applyAfterToolInterceptors(
              args,
              parsedInput,
              steps,
              stepModelAlias,
              toolId,
              callId,
              value,
              signal,
              deadline,
            ),
        },
        toolCalls,
        stepTools,
      )
      const effectiveToolCalls = batch.calls
      const assistantMsg: Message = {
        id: turnMessageId(args.delegationCallId ?? args.runId, `10_assistant_${steps}`),
        sessionId: args.sessionId,
        runId: args.runId,
        role: 'assistant',
        content: '',
        toolCalls: [...effectiveToolCalls],
        timestamp: new Date().toISOString(),
      }
      emitted.push(assistantMsg)
      // Provider continuation (e.g. OpenAI Responses reasoning items) stays
      // local to the loop; they are replayed on the next round, not persisted.
      modelMessages.push({
        role: 'assistant',
        content: assistantMsg.content,
        toolCalls: [...effectiveToolCalls],
        ...(response.providerContinuation ? { providerContinuation: response.providerContinuation } : {}),
      })

      args.metrics.histogram('harness.agent.tool_batch.size', effectiveToolCalls.length, {
        'harness.agent.tool_batch.max_parallel': args.maxParallelToolCalls,
      })
      for (const outcome of batch.outcomes) {
        emitted.push(outcome.emitted)
        modelMessages.push(outcome.modelMessage)
      }
      steps += 1
    }
  } catch (error) {
    if (error instanceof ToolApprovalPendingError) {
      throw error.attachState({
        input: parsedInput as JsonValue,
        step: steps,
        modelAlias: pendingModelAlias,
        modelMessages: freezeJson([...modelMessages]),
        emitted: freezeJson([...emitted]),
        toolCalls: error.toolCalls,
        ...(pendingProviderContinuation ? { providerContinuation: pendingProviderContinuation } : {}),
      })
    }
    // Pair every agent.started with an agent.finished, even on error/cancel/budget.
    await args.emitEvent?.({
      type: 'agent.finished',
      runId: args.runId,
      agentId: args.agentId,
      at: new Date().toISOString(),
      error: serializeError(error),
      ...agentEventMeta,
    })
    throw error
  }
}

type InterceptorPhase = 'before_input' | 'before_model' | 'after_model' | 'before_tool' | 'after_tool' | 'before_output'
const interceptorHooks = {
  before_input: 'beforeInput',
  before_model: 'beforeModel',
  after_model: 'afterModel',
  before_tool: 'beforeTool',
  after_tool: 'afterTool',
  before_output: 'beforeOutput',
} as const
type DefaultAgentArgs = Parameters<typeof runDefaultAgentInner>[0]

function interceptorContext(
  args: DefaultAgentArgs,
  interceptorId: string,
  input: unknown,
  step: number,
  model: string | undefined,
  decision: DecisionExecutionContext,
) {
  return {
    interceptorId,
    invocationId: args.delegationCallId ?? args.runId,
    agentInput: input,
    step,
    ...(model ? { model } : {}),
    agentId: args.agentId,
    runId: args.runId,
    sessionId: args.sessionId,
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    history: { list: async () => args.history },
    memory: args.memory,
    metadata: args.metadata ?? {},
    metrics: args.metrics,
    models: args.models as ModelHandles<any>,
    signal: args.signal,
    decision,
    logger: args.logger,
    telemetry: args.telemetry,
  }
}

async function applyInterceptors<T>(
  args: DefaultAgentArgs,
  phase: InterceptorPhase,
  value: T,
  invoke: (
    interceptor: AgentExecutionInterceptor<any, any>,
    current: T,
    decision: DecisionExecutionContext,
  ) => AgentExecutionInterception<T> | void | Promise<AgentExecutionInterception<T> | void>,
  execution: DecisionExecutionContext = { signal: args.signal, deadline: args.runDeadline ?? Number.POSITIVE_INFINITY },
  allowTransform = true,
  step = 0,
  onTransform?: (value: JsonValue, evidence: ReturnType<typeof createDecisionEvidence>) => T | Promise<T>,
  toolOccurrence?: { toolId: string; callId: string },
): Promise<T> {
  let current = value
  let ordinal = 0
  for (const interceptor of args.agent.interceptors ?? []) {
    if (!interceptor[interceptorHooks[phase]]) continue
    if (!interceptor.id) {
      throw new HarnessConfigError('Agent interceptor id must be non-empty.', { reason: 'invalid_interceptor' })
    }
    let outcome: unknown
    const evidence = createDecisionEvidence({
      occurrence: {
        invocationId: args.delegationCallId ?? args.runId,
        runId: args.runId,
        agentId: args.agentId,
        sessionId: args.sessionId,
        ...(args.workflowId ? { workflowId: args.workflowId } : {}),
        ...toolOccurrence,
        step,
      },
      source: { kind: 'interceptor', id: interceptor.id },
      phase: evidencePhase(phase),
      ordinal,
    })
    ordinal += 1
    const deadline = Date.now() + args.decisionTimeoutMs
    try {
      outcome = await runDecisionOperation({ signal: execution.signal, deadline }, signal =>
        invoke(interceptor, freezeJson(current), { signal, deadline: Math.min(deadline, execution.deadline) }),
      )
    } catch (error) {
      if (error instanceof OperationTimeoutError && error.meta?.['scope'] === 'decision')
        throw new DecisionEvaluationError(evidence, 'callback_timeout', error)
      if (
        error instanceof DecisionBlockedError ||
        error instanceof DecisionEvaluationError ||
        error instanceof OperationCancelledError ||
        error instanceof OperationTimeoutError
      )
        throw error
      throw new DecisionEvaluationError(evidence, 'callback_failed', error)
    }
    if (outcome === undefined) continue
    const result = parseInterceptorResult(outcome, allowTransform)
    if (!result) throw new DecisionEvaluationError(evidence, 'invalid_result')
    if (result.decision === 'allow') continue
    if (result.decision === 'transform' && allowTransform) {
      if (!isJsonValue(result.value) || !onTransform) throw new DecisionEvaluationError(evidence, 'invalid_transform')
      try {
        current = await onTransform(result.value, evidence)
      } catch (error) {
        if (error instanceof DecisionEvaluationError) throw error
        throw new DecisionEvaluationError(evidence, 'invalid_transform', error)
      }
      continue
    }
    if (result.decision === 'block') {
      throw new DecisionBlockedError(
        createDecisionEvidence({
          occurrence: {
            invocationId: args.delegationCallId ?? args.runId,
            runId: args.runId,
            agentId: args.agentId,
            sessionId: args.sessionId,
            ...(args.workflowId ? { workflowId: args.workflowId } : {}),
            ...toolOccurrence,
            step,
          },
          source: { kind: 'interceptor', id: interceptor.id },
          phase: evidencePhase(phase),
          ordinal: ordinal - 1,
          ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
        }),
      )
    }
    throw new DecisionEvaluationError(evidence, 'invalid_result')
  }
  return current
}

async function applyBeforeInputInterceptors(args: DefaultAgentArgs, input: JsonValue): Promise<JsonValue> {
  const schema = args.agent.input ?? z.string()
  return applyInterceptors(
    args,
    'before_input',
    input,
    (interceptor, current, decision) =>
      interceptor.beforeInput?.({
        ...interceptorContext(args, interceptor.id, current, 0, args.modelAlias ?? args.agent.model, decision),
        input: current,
      }),
    undefined,
    true,
    0,
    async (value, evidence) => {
      try {
        return await validateAgentSchema(schema, value, 'agent_input', args.signal)
      } catch (error) {
        throw new DecisionEvaluationError(evidence, 'invalid_transform', error)
      }
    },
  )
}

async function applyBeforeModelInterceptors(
  args: DefaultAgentArgs,
  input: unknown,
  step: number,
  model: string,
  request: AgentModelRequest,
  canonicalMessages: readonly ModelMessage[],
): Promise<AgentModelRequest> {
  const transformed = await applyInterceptors(
    args,
    'before_model',
    { messages: request.messages },
    (interceptor, current, decision) =>
      interceptor.beforeModel?.({
        ...interceptorContext(args, interceptor.id, input, step, model, decision),
        request: freezeJson({ ...request, messages: current.messages }),
      }),
    undefined,
    true,
    step,
    (value, evidence) => {
      if (!isModelRequestTransform(value)) throw new DecisionEvaluationError(evidence, 'invalid_transform')
      assertProtectedTranscript(canonicalMessages, value.messages)
      return value
    },
  )
  return { ...request, messages: transformed.messages }
}

async function applyAfterModelInterceptors(
  args: DefaultAgentArgs,
  input: unknown,
  step: number,
  model: string,
  request: AgentModelRequest,
  response: ObjectResponse<JsonValue>,
): Promise<ObjectResponse<JsonValue>> {
  await applyInterceptors(
    args,
    'after_model',
    response,
    (interceptor, _current, decision) =>
      interceptor.afterModel?.({
        ...interceptorContext(args, interceptor.id, input, step, model, decision),
        request: freezeJson(request),
        response: freezeJson(response),
      }),
    undefined,
    false,
    step,
  )
  return response
}

async function applyBeforeToolInterceptors(
  args: DefaultAgentArgs,
  agentInput: unknown,
  step: number,
  model: string,
  toolId: string,
  callId: string,
  input: JsonValue,
  signal: AbortSignal,
  deadline: number,
): Promise<JsonValue> {
  return applyInterceptors(
    args,
    'before_tool',
    input,
    (interceptor, current, decision) =>
      interceptor.beforeTool?.({
        ...interceptorContext(args, interceptor.id, agentInput, step, model, decision),
        toolId,
        callId,
        input: current,
      }),
    { signal, deadline },
    true,
    step,
    value => value,
    { toolId, callId },
  )
}

async function applyAfterToolInterceptors(
  args: DefaultAgentArgs,
  agentInput: unknown,
  step: number,
  model: string,
  toolId: string,
  callId: string,
  output: JsonValue,
  signal: AbortSignal,
  deadline: number,
): Promise<JsonValue> {
  return applyInterceptors(
    args,
    'after_tool',
    output,
    (interceptor, current, decision) =>
      interceptor.afterTool?.({
        ...interceptorContext(args, interceptor.id, agentInput, step, model, decision),
        toolId,
        callId,
        output: current,
      }),
    { signal, deadline },
    true,
    step,
    value => value,
    { toolId, callId },
  )
}

async function applyBeforeOutputInterceptors(
  args: DefaultAgentArgs,
  agentInput: unknown,
  step: number,
  model: string,
  output: JsonValue,
): Promise<JsonValue> {
  return applyInterceptors(
    args,
    'before_output',
    output,
    (interceptor, current, decision) =>
      interceptor.beforeOutput?.({
        ...interceptorContext(args, interceptor.id, agentInput, step, model, decision),
        output: current,
      }),
    undefined,
    true,
    step,
    value => value,
  )
}

function parseInterceptorResult(value: unknown, allowTransform: boolean) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const decision = decisionResultSchema.safeParse(value)
    if (decision.success) return decision.data
    if (!allowTransform || !Object.hasOwn(value, 'value')) return undefined
    const transform = interceptorTransformSchema.safeParse(value)
    return transform.success ? transform.data : undefined
  } catch {
    return undefined
  }
}

function prepareStepEvidence(args: DefaultAgentArgs, step: number): ReturnType<typeof createDecisionEvidence> {
  return createDecisionEvidence({
    occurrence: {
      invocationId: args.delegationCallId ?? args.runId,
      runId: args.runId,
      agentId: args.agentId,
      sessionId: args.sessionId,
      ...(args.workflowId ? { workflowId: args.workflowId } : {}),
      step,
    },
    source: { kind: 'interceptor', id: 'prepare_step' },
    phase: 'before_model',
    ordinal: 0,
  })
}

function evidencePhase(
  phase: InterceptorPhase,
): 'input' | 'before_model' | 'after_model' | 'tool_input' | 'tool_output' | 'output' {
  if (phase === 'before_input') return 'input'
  if (phase === 'before_model') return 'before_model'
  if (phase === 'after_model') return 'after_model'
  if (phase === 'before_tool') return 'tool_input'
  if (phase === 'after_tool') return 'tool_output'
  return 'output'
}

function isModelRequestTransform(value: unknown): value is { messages: readonly ModelMessage[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === 1 &&
    Array.isArray(record['messages']) &&
    record['messages'].every(isStrictModelMessage)
  )
}

function isStrictModelMessage(value: unknown): value is ModelMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record['role'] === 'system' || record['role'] === 'user')
    return isStrictContent(record['content']) && Object.keys(record).every(key => key === 'role' || key === 'content')
  if (record['role'] === 'assistant')
    return (
      isStrictContent(record['content']) &&
      (record['toolCalls'] === undefined ||
        (Array.isArray(record['toolCalls']) && record['toolCalls'].every(isStrictToolCall))) &&
      (record['providerContinuation'] === undefined ||
        providerContinuationSchema.safeParse(record['providerContinuation']).success) &&
      Object.keys(record).every(
        key => key === 'role' || key === 'content' || key === 'toolCalls' || key === 'providerContinuation',
      )
    )
  return (
    record['role'] === 'tool' &&
    typeof record['toolCallId'] === 'string' &&
    typeof record['content'] === 'string' &&
    Object.keys(record).every(key => key === 'role' || key === 'toolCallId' || key === 'content')
  )
}

function isStrictContent(value: unknown): boolean {
  if (typeof value === 'string') return true
  if (!Array.isArray(value)) return false
  return value.every(part => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false
    const record = part as Record<string, unknown>
    if (record['kind'] === 'text')
      return typeof record['text'] === 'string' && Object.keys(record).every(key => key === 'kind' || key === 'text')
    if (record['kind'] === 'image' || record['kind'] === 'audio')
      return (
        typeof record['mimeType'] === 'string' &&
        typeof record['dataBase64'] === 'string' &&
        Object.keys(record).every(key => key === 'kind' || key === 'mimeType' || key === 'dataBase64')
      )
    if (record['kind'] === 'image_url')
      return (
        typeof record['url'] === 'string' &&
        (record['mimeType'] === undefined || typeof record['mimeType'] === 'string') &&
        Object.keys(record).every(key => key === 'kind' || key === 'url' || key === 'mimeType')
      )
    if (record['kind'] === 'file')
      return (
        typeof record['mimeType'] === 'string' &&
        typeof record['dataBase64'] === 'string' &&
        (record['filename'] === undefined || typeof record['filename'] === 'string') &&
        Object.keys(record).every(
          key => key === 'kind' || key === 'mimeType' || key === 'dataBase64' || key === 'filename',
        )
      )
    if (record['kind'] === 'file_url')
      return (
        typeof record['url'] === 'string' &&
        (record['mimeType'] === undefined || typeof record['mimeType'] === 'string') &&
        (record['filename'] === undefined || typeof record['filename'] === 'string') &&
        Object.keys(record).every(key => key === 'kind' || key === 'url' || key === 'mimeType' || key === 'filename')
      )
    return false
  })
}

function isStrictToolCall(value: unknown): value is ToolCallSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['name'] === 'string' &&
    isJsonValue(record['arguments']) &&
    Object.keys(record).every(key => key === 'id' || key === 'name' || key === 'arguments')
  )
}

function assertProtectedTranscript(canonical: readonly ModelMessage[], candidate: readonly ModelMessage[]): void {
  if (!candidate.every(isStrictModelMessage))
    throw new ValidationError('Model messages are invalid.', { where: 'model_response', issues: [] })
  const groups = toolInteractionGroups(canonical)
  const retainedResultIndices = new Set<number>()
  const ids = new Set<string>()
  for (const message of candidate)
    if (message.role === 'assistant' && message.toolCalls)
      for (const call of message.toolCalls) {
        if (ids.has(call.id))
          throw new ValidationError('Model messages contain duplicate tool call ids.', {
            where: 'model_response',
            issues: [],
          })
        ids.add(call.id)
      }
  for (const [groupIndex, group] of groups.entries()) {
    const index = candidate.findIndex(message => structurallyEqual(message, group.assistant))
    if (index < 0) {
      if (groupIndex === groups.length - 1)
        throw new ValidationError('The latest tool interaction group must be retained.', {
          where: 'model_response',
          issues: [],
        })
      continue
    }
    if (!group.results.every((result, offset) => structurallyEqual(candidate[index + offset + 1], result)))
      throw new ValidationError('Protected tool interaction groups cannot be rewritten.', {
        where: 'model_response',
        issues: [],
      })
    for (let offset = 0; offset < group.results.length; offset += 1) retainedResultIndices.add(index + offset + 1)
  }
  for (const [index, message] of candidate.entries()) {
    if (
      message.role === 'assistant' &&
      message.toolCalls &&
      !groups.some(group => structurallyEqual(message, group.assistant))
    )
      throw new ValidationError('Protected tool interaction groups cannot be injected.', {
        where: 'model_response',
        issues: [],
      })
    if (message.role === 'tool' && !retainedResultIndices.has(index))
      throw new ValidationError('Protected tool results must belong to one complete retained interaction group.', {
        where: 'model_response',
        issues: [],
      })
  }
}

function toolInteractionGroups(
  messages: readonly ModelMessage[],
): Array<{ assistant: ModelMessage; results: ModelMessage[] }> {
  const groups: Array<{ assistant: ModelMessage; results: ModelMessage[] }> = []
  for (let index = 0; index < messages.length; index += 1) {
    const assistant = messages[index]
    if (!assistant || assistant.role !== 'assistant' || !assistant.toolCalls?.length) continue
    const callIds = new Set(assistant.toolCalls.map(call => call.id))
    const results: ModelMessage[] = []
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const result = messages[cursor]
      if (!result || result.role !== 'tool' || !callIds.has(result.toolCallId)) break
      results.push(result)
    }
    if (results.length !== callIds.size)
      throw new ValidationError('Protected tool interaction group is incomplete.', {
        where: 'model_response',
        issues: [],
      })
    groups.push({ assistant, results })
  }
  return groups
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function filterActiveTools(
  tools: readonly ModelToolSpec[],
  activeTools: readonly string[] | undefined,
  agentId: string,
): ModelToolSpec[] {
  if (!activeTools) return [...tools]
  const requested = new Set(activeTools)
  const filtered = tools.filter(tool => requested.has(tool.name))
  if (filtered.length !== requested.size) {
    const available = new Set(tools.map(tool => tool.name))
    const unknown = [...requested].filter(name => !available.has(name))
    throw new ValidationError('prepareStep referenced an unknown active tool.', {
      where: 'agent_input',
      issues: { agentId, activeTools: unknown },
    })
  }
  return filtered
}

async function applyGovernanceToolExposure(
  args: Parameters<typeof runDefaultAgentInner>[0],
  tools: readonly ModelToolSpec[],
  step: number,
): Promise<ModelToolSpec[]> {
  const visible = await applyToolExposure({
    ...(args.governance ? { governance: args.governance } : {}),
    tools,
    agentId: args.agentId,
    runId: args.runId,
    sessionId: args.sessionId,
    ...(args.workflowId ? { workflowId: args.workflowId } : {}),
    invocationId: args.delegationCallId ?? args.runId,
    step,
    signal: args.signal,
    decisionTimeoutMs: args.decisionTimeoutMs,
    telemetry: args.telemetry,
    ...(args.runDeadline !== undefined ? { deadline: args.runDeadline } : {}),
    metadata: args.metadata ?? {},
    ...(args.emitEvent ? { emitEvent: args.emitEvent } : {}),
  })
  return tools.filter(tool => visible.includes(tool.name))
}

async function shouldStopAgentLoop(
  args: Parameters<typeof runDefaultAgentInner>[0],
  input: unknown,
  selectedModelAlias: string,
  step: number,
  messages: readonly ModelMessage[],
  tools: readonly ModelToolSpec[],
  response: ObjectResponse<JsonValue>,
  toolCalls: readonly ToolCallSpec[],
): Promise<boolean> {
  if (!args.agent.stopWhen) return false
  return args.agent.stopWhen({
    input,
    runId: args.runId,
    sessionId: args.sessionId,
    history: { list: async () => args.history },
    memory: args.memory,
    metadata: args.metadata ?? {},
    metrics: args.metrics,
    step,
    model: selectedModelAlias,
    messages,
    tools,
    response,
    toolCalls,
  })
}

function requireAgentOutputSchema(args: Parameters<typeof runDefaultAgentInner>[0]): JsonValue {
  const schema = args.modelSchemas.agentOutput
  if (schema === undefined) throw new InternalError('Compiled agent output schema was unavailable.')
  return schema
}

function validateAgentSchema(
  schema: Schema,
  value: unknown,
  where: 'agent_input' | 'agent_output',
  signal: AbortSignal,
): Promise<JsonValue> {
  return validateSchema(schema, value, {
    where,
    message: where === 'agent_input' ? 'Agent input validation failed.' : 'Agent output validation failed.',
    assertNotAborted: () => {
      if (signal.aborted) throw abortError(signal, 'run', 'Run was cancelled.')
    },
  })
}
