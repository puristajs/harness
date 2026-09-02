import { createHash } from 'node:crypto'
import type { ToolApprovalDecision, ToolApprovalRequest } from '../approvals/index.js'
import { createDecisionEvidence, runDecisionOperation } from '../decisions/index.js'
import type { z } from 'zod'
import type { DecisionEvidence, DecisionExecutionContext, DecisionOccurrence } from '../decisions/index.js'
import {
  DecisionEvaluationError,
  HarnessConfigError,
  OperationCancelledError,
  OperationTimeoutError,
  PermissionDeniedError,
  PolicyDeniedError,
} from '../errors/index.js'
import { isSelectedGovernanceTool } from '../harness/defineHarness.js'
import type {
  AgentPermissions,
  GovernanceConfig,
  GovernanceContext,
  GovernanceEffect,
  GovernanceExposureEffect,
  GovernancePolicyEvaluator,
  PermissionMode,
  PermissionPolicy,
  RunEvent,
} from '../harness/defineHarness.js'
import type { JsonValue } from '../models/json.js'
import { governancePolicyResultSchema, permissionPolicySchema } from '../decisions/schemas.js'
import { telemetryErrorType, type SpanAttrs, type TelemetryShim } from '../telemetry/index.js'

type Invocation = {
  readonly agentId: string
  readonly runId: string
  readonly sessionId: string
  readonly workflowId?: string
  readonly invocationId: string
  readonly step: number
  readonly signal: AbortSignal
  readonly decisionTimeoutMs: number
  readonly telemetry?: TelemetryShim
  readonly deadline?: number
  readonly metadata: Readonly<Record<string, JsonValue>>
  readonly emitEvent?: (event: RunEvent) => Promise<void>
}

type ToolInvocation = Invocation & {
  readonly toolId: string
  readonly callId: string
  readonly input: JsonValue
  readonly permissions?: AgentPermissions
  readonly governance?: GovernanceConfig
}

type Evaluated = { readonly effect: GovernanceEffect; readonly evidence: DecisionEvidence; readonly engine: string }

/** Result of evaluating one parsed tool call before any tool in its batch executes. */
export type ToolGovernanceResult =
  | undefined
  | { readonly decision: 'rejected'; readonly approvalId: string; readonly reason?: string }
  | { readonly decision: 'approval_required'; readonly request: ToolApprovalRequest }

/** Evaluates permissions, governance policies, audit and approval requirements for a parsed tool call. */
export async function enforceToolGovernance(
  invocation: ToolInvocation,
  suppliedDecisions: readonly ToolApprovalDecision[] = [],
): Promise<ToolGovernanceResult> {
  const occurrence = occurrenceFor(invocation)
  const demands: DecisionEvidence[] = []
  const permission = permissionDecision(invocation.permissions, invocation.toolId, invocation.input)
  if (permission === 'deny') {
    invocation.telemetry?.recordCounter('harness.permission.denials', 1, {
      'gen_ai.tool.name': invocation.toolId,
      'harness.agent.id': invocation.agentId,
      'harness.session.id': invocation.sessionId,
    })
    throw new PermissionDeniedError(
      createDecisionEvidence({
        occurrence,
        source: { kind: 'permission', id: invocation.toolId },
        phase: 'permission',
        ordinal: 0,
      }),
    )
  }
  if (permission === 'require_approval') {
    demands.push(
      createDecisionEvidence({
        occurrence,
        source: { kind: 'permission', id: invocation.toolId },
        phase: 'permission',
        ordinal: 0,
      }),
    )
  }

  const governance = invocation.governance
  const policyEnabled = governance?.enabled !== false
  const evaluated = policyEnabled && governance ? await evaluatePolicies(invocation, occurrence) : []
  const enforced = governance?.mode !== 'shadow'
  const winner = strongest(evaluated)

  for (const decision of evaluated) {
    const applied = Boolean(
      enforced &&
        decision.effect === winner?.effect &&
        (decision.effect === 'deny' || decision.effect === 'require_approval'),
    )
    await invocation.emitEvent?.({
      type: 'policy.evaluated',
      runId: invocation.runId,
      agentId: invocation.agentId,
      invocationId: invocation.invocationId,
      toolId: invocation.toolId,
      callId: invocation.callId,
      step: invocation.step,
      evidence: decision.evidence,
      effect: decision.effect,
      enforced: applied,
    })
    if (governance?.audit) {
      try {
        await runGovernanceCallback(invocation, execution =>
          governance.audit!.record(
            {
          evidence: decision.evidence,
          toolId: invocation.toolId,
          callId: invocation.callId,
          invocationId: invocation.invocationId,
          agentId: invocation.agentId,
          runId: invocation.runId,
          sessionId: invocation.sessionId,
          ...(invocation.workflowId ? { workflowId: invocation.workflowId } : {}),
          step: invocation.step,
          effect: decision.effect,
              enforced: applied,
            },
            execution,
          ),
        )
      } catch (error) {
        throw decisionFailure(decision.evidence, error, 'audit_failed')
      }
    }
  }

  if (enforced && winner?.effect === 'deny') {
    invocation.telemetry?.recordCounter('harness.policy.denials', 1, policyMetricAttrs(invocation, winner))
    throw new PolicyDeniedError(winner.evidence, 'policy_deny')
  }
  if (enforced)
    demands.push(
      ...evaluated.filter(decision => decision.effect === 'require_approval').map(decision => decision.evidence),
    )
  if (demands.length === 0) return
  Object.freeze(demands)

  const approvalId = approvalIdentity(invocation, demands)
  const supplied = suppliedDecisions.find(decision => decision.approvalId === approvalId)
  if (supplied) {
    await safeTerminalEvent(invocation, approvalId, supplied.approved ? 'approved' : 'rejected')
    return supplied.approved
      ? undefined
      : {
          decision: 'rejected',
      approvalId,
          ...(supplied.reason ? { reason: supplied.reason } : {}),
  }
  }
  for (const demand of demands) {
    invocation.telemetry?.recordCounter(
      'harness.approval.requests',
      1,
      approvalMetricAttrs(invocation, demand, evaluated),
    )
  }
  await invocation.emitEvent?.({
    type: 'approval.requested',
    runId: invocation.runId,
    agentId: invocation.agentId,
    invocationId: invocation.invocationId,
    toolId: invocation.toolId,
    callId: invocation.callId,
    step: invocation.step,
    approvalId,
    demands,
  })
  return {
    decision: 'approval_required',
    request: Object.freeze({
      approvalId,
      runId: invocation.runId,
      agentId: invocation.agentId,
      ...(invocation.workflowId ? { workflowId: invocation.workflowId } : {}),
      invocationId: invocation.invocationId,
      step: invocation.step,
      toolId: invocation.toolId,
      callId: invocation.callId,
      input: invocation.input,
      demands,
    }),
  }
}

/** Applies fail-closed tool exposure rules before one model step. */
export async function applyToolExposure(
  invocation: Invocation & { readonly governance?: GovernanceConfig; readonly tools: readonly { name: string }[] },
): Promise<string[]> {
  const governance = invocation.governance
  const exposure = governance?.exposure
  if (!governance || governance.enabled === false || !exposure) return invocation.tools.map(tool => tool.name)
  const visible: string[] = []
  for (const tool of invocation.tools) {
    const occurrence: DecisionOccurrence = {
      invocationId: invocation.invocationId,
      runId: invocation.runId,
      agentId: invocation.agentId,
      sessionId: invocation.sessionId,
      ...(invocation.workflowId ? { workflowId: invocation.workflowId } : {}),
      toolId: tool.name,
      step: invocation.step,
    }
    const source = {
      kind: 'exposure' as const,
      id: exposure.id ?? 'governance.exposure',
      ...(exposure.version ? { version: exposure.version } : {}),
    }
    let selected: { effect: GovernanceExposureEffect; evidence: DecisionEvidence } | undefined
    let ordinal = 0
    for (const rule of exposure.rules ?? []) {
      if (!isSelectedGovernanceTool(tool.name, rule.tools)) continue
      const evidence = createDecisionEvidence({
        occurrence,
        source: { ...source, ruleId: rule.id },
        phase: 'exposure',
        ordinal,
      })
      ordinal += 1
      let predicateResult: unknown
      try {
        predicateResult = await runGovernanceCallback(invocation, execution =>
          rule.when
            ? rule.when({
                toolId: tool.name as never,
                agentId: invocation.agentId,
                runId: invocation.runId,
                sessionId: invocation.sessionId,
                ...(invocation.workflowId ? { workflowId: invocation.workflowId } : {}),
                step: invocation.step,
                metadata: invocation.metadata,
                ...execution,
              })
            : true,
        )
      } catch (error) {
        throw decisionFailure(evidence, error, 'callback_failed')
      }
      if (typeof predicateResult !== 'boolean') throw new DecisionEvaluationError(evidence, 'invalid_result')
      const matched = predicateResult
      if (!matched) continue
      const candidate = { effect: rule.effect, evidence }
      if (!selected || (candidate.effect === 'hide' && selected.effect !== 'hide')) selected = candidate
      await invocation.emitEvent?.({
        type: 'policy.exposure',
        runId: invocation.runId,
        agentId: invocation.agentId,
        invocationId: invocation.invocationId,
        toolId: tool.name,
        step: invocation.step,
        evidence,
        effect: rule.effect,
        enforced: governance.mode !== 'shadow' && rule.effect === 'hide',
      })
    }
    if (!selected) {
      const effect = exposure.defaultEffect ?? 'expose'
      selected = {
        effect,
        evidence: createDecisionEvidence({
          occurrence,
          source: { ...source, ruleId: 'default' },
          phase: 'exposure',
          ordinal,
        }),
      }
    }
    if (governance.mode === 'shadow' || selected.effect !== 'hide') visible.push(tool.name)
  }
  return visible
}

async function evaluatePolicies(invocation: ToolInvocation, occurrence: DecisionOccurrence): Promise<Evaluated[]> {
  const governance = invocation.governance!
  const evaluated: Evaluated[] = []
  let ordinal = 0
  for (const policy of governance.policies ?? []) {
    if ('kind' in policy && policy.kind === 'native') {
      for (const rule of policy.rules) {
        if (!isSelectedGovernanceTool(invocation.toolId, rule.tools)) continue
        const evidence = createDecisionEvidence({
          occurrence,
          source: {
            kind: 'policy',
            id: policy.id,
            ...(policy.version ? { version: policy.version } : {}),
            ruleId: rule.id,
          },
          phase: 'policy',
          ordinal,
          ...(rule.reasonCode ? { reasonCode: rule.reasonCode } : {}),
        })
        ordinal += 1
        let predicateResult: unknown
        try {
          predicateResult = await withPolicyTelemetry(
            invocation,
            {
            id: policy.id,
            engine: 'native',
            ...(policy.version ? { version: policy.version } : {}),
            },
            async () =>
              runGovernanceCallback(invocation, execution =>
                rule.when ? rule.when(contextFor(invocation, execution.signal, execution.deadline)) : true,
              ),
            {
            ruleId: rule.id,
            effect: rule.effect,
            },
          )
        } catch (error) {
          throw decisionFailure(evidence, error, 'callback_failed')
        }
        if (typeof predicateResult !== 'boolean') throw new DecisionEvaluationError(evidence, 'invalid_result')
        const matched = predicateResult
        if (matched) evaluated.push({ effect: rule.effect, evidence, engine: 'native' })
      }
      continue
    }
    const externalPolicy = policy as GovernancePolicyEvaluator
    const firstOrdinal = ordinal
    const baseEvidence = createDecisionEvidence({
      occurrence,
      source: {
        kind: 'policy',
        id: externalPolicy.id,
        ...(externalPolicy.version ? { version: externalPolicy.version } : {}),
      },
      phase: 'policy',
      ordinal: firstOrdinal,
    })
    let result: z.output<typeof governancePolicyResultSchema>
    try {
      result = await withPolicyTelemetry(invocation, externalPolicy, async (span, attrs) => {
        const output = await runGovernanceCallback(invocation, execution =>
          externalPolicy.evaluate(contextFor(invocation, execution.signal, execution.deadline)),
        )
        const parsed = parseDecisionResult(governancePolicyResultSchema, output, baseEvidence)
        const decisions = parsed === undefined ? [] : Array.isArray(parsed) ? parsed : [parsed]
        const effects = [...new Set(decisions.map(decision => decision.effect))]
        const ruleIds = [...new Set(decisions.flatMap(decision => (decision.ruleId ? [decision.ruleId] : [])))]
        const resultAttrs: Record<string, string | number | boolean | string[]> = {
          ...(effects.length === 1 ? { 'harness.policy.effect': effects[0] } : {}),
          ...(ruleIds.length === 1 ? { 'harness.policy.rule_id': ruleIds[0] } : {}),
        }
        Object.assign(attrs, resultAttrs)
        span?.setAttributes(resultAttrs)
        return parsed
      })
    } catch (error) {
      if (error instanceof DecisionEvaluationError) throw error
      throw decisionFailure(baseEvidence, error, 'callback_failed')
    }
    if (result === undefined) {
      ordinal += 1
      continue
    }
    const values = Array.isArray(result) ? result : [result]
    ordinal += Math.max(1, values.length)
    for (const [index, value] of values.entries()) {
      const evidence = createDecisionEvidence({
        occurrence,
        source: {
          kind: 'policy',
          id: externalPolicy.id,
          ...(externalPolicy.version ? { version: externalPolicy.version } : {}),
          ...(value.ruleId ? { ruleId: value.ruleId } : {}),
        },
        phase: 'policy',
        ordinal: firstOrdinal + index,
        ...(value.reasonCode ? { reasonCode: value.reasonCode } : {}),
      })
      evaluated.push({ effect: value.effect, evidence, engine: externalPolicy.engine ?? 'custom' })
    }
  }
  if (
    evaluated.length === 0 &&
    (governance.policies?.length ?? 0) > 0 &&
    (governance.defaultEffect ?? 'deny') === 'deny'
  ) {
    evaluated.push({
      effect: 'deny',
      engine: 'harness',
      evidence: createDecisionEvidence({
        occurrence,
        source: { kind: 'policy', id: 'governance.default', ruleId: 'default' },
        phase: 'policy',
        ordinal,
      }),
    })
  }
  return evaluated
}

function policyMetricAttrs(invocation: ToolInvocation, decision: Evaluated): Record<string, string | number | boolean> {
  return {
    'harness.policy.engine': decision.engine,
    ...(decision.evidence.source.ruleId ? { 'harness.policy.rule_id': decision.evidence.source.ruleId } : {}),
    'harness.agent.id': invocation.agentId,
    'harness.tool.id': invocation.toolId,
  }
}

function approvalMetricAttrs(
  invocation: ToolInvocation,
  demand: DecisionEvidence,
  evaluated: readonly Evaluated[],
): Record<string, string | number | boolean> {
  const decision = evaluated.find(candidate => candidate.evidence.decisionId === demand.decisionId)
  return {
    'harness.policy.engine': decision?.engine ?? (demand.source.kind === 'permission' ? 'permission' : 'harness'),
    ...(demand.source.ruleId ? { 'harness.policy.rule_id': demand.source.ruleId } : {}),
    'harness.agent.id': invocation.agentId,
    'harness.tool.id': invocation.toolId,
    'harness.approval.status': 'requested',
  }
}

async function withPolicyTelemetry<T>(
  invocation: ToolInvocation,
  policy: { readonly id: string; readonly version?: string; readonly engine?: string },
  action: (
    span: { setAttributes(attrs: Record<string, string | number | boolean | string[]>): unknown } | undefined,
    attrs: SpanAttrs,
  ) => Promise<T>,
  result?: { readonly ruleId?: string; readonly effect?: GovernanceEffect },
): Promise<T> {
  const attrs: SpanAttrs = {
    'openinference.span.kind': 'GUARDRAIL',
    'harness.policy.engine': policy.engine ?? 'custom',
    'harness.policy.name': policy.id,
    'harness.policy.version': policy.version,
    ...(result?.ruleId ? { 'harness.policy.rule_id': result.ruleId } : {}),
    ...(result?.effect ? { 'harness.policy.effect': result.effect } : {}),
    'harness.policy.phase': 'pre',
    'harness.policy.mode': invocation.governance?.mode ?? 'enforce',
    'harness.policy.enforced': invocation.governance?.mode !== 'shadow',
    'harness.tool.id': invocation.toolId,
    'harness.agent.id': invocation.agentId,
    'harness.session.id': invocation.sessionId,
    'harness.run.id': invocation.runId,
    ...(invocation.workflowId ? { 'harness.workflow.id': invocation.workflowId } : {}),
  }
  const started = Date.now()
  let failure: unknown
  try {
    return invocation.telemetry
      ? await invocation.telemetry.span('harness.policy.evaluate', attrs, async span => action(span, attrs))
      : await action(undefined, attrs)
  } catch (error) {
    failure = error
    throw error
  } finally {
    const metricAttrs = { ...attrs, ...(failure === undefined ? {} : { 'error.type': telemetryErrorType(failure) }) }
    invocation.telemetry?.recordCounter('harness.policy.evaluations', 1, metricAttrs)
    invocation.telemetry?.recordHistogram('harness.policy.duration', (Date.now() - started) / 1000, metricAttrs)
  }
}

function contextFor(invocation: ToolInvocation, signal: AbortSignal, deadline: number): GovernanceContext {
  return {
    toolId: invocation.toolId as never,
    input: invocation.input as never,
    callId: invocation.callId,
    invocationId: invocation.invocationId,
    agentId: invocation.agentId,
    runId: invocation.runId,
    sessionId: invocation.sessionId,
    ...(invocation.workflowId ? { workflowId: invocation.workflowId } : {}),
    step: invocation.step,
    metadata: invocation.metadata,
    signal,
    deadline,
  } as GovernanceContext
}

function parseDecisionResult<T>(schema: z.ZodType<T>, value: unknown, evidence: DecisionEvidence): T {
  try {
    return schema.parse(value)
  } catch (error) {
    throw new DecisionEvaluationError(evidence, 'invalid_result', error)
  }
}

function permissionDecision(
  permissions: AgentPermissions | undefined,
  toolId: string,
  input: JsonValue,
): PermissionMode {
  if (['read', 'list', 'glob', 'grep'].includes(toolId)) return 'allow'
  const policy = normalizePermissionPolicy(permissions?.[toolId as keyof AgentPermissions])
  const target = permissionTarget(toolId, input)
  if (target && matches(target, policy.deny)) return 'deny'
  if (policy.allow?.length && (!target || !matches(target, policy.allow))) return 'deny'
  return policy.mode
}

function normalizePermissionPolicy(value: unknown): PermissionPolicy {
  if (value === undefined) return { mode: 'allow' }
  const parsed = permissionPolicySchema.safeParse(value)
  if (!parsed.success) throw new HarnessConfigError('Agent permissions are invalid.', { reason: 'invalid_agent' })
  return typeof parsed.data === 'string'
    ? { mode: parsed.data }
    : {
    mode: parsed.data.mode,
    ...(parsed.data.allow !== undefined ? { allow: parsed.data.allow } : {}),
        ...(parsed.data.deny !== undefined ? { deny: parsed.data.deny } : {}),
  }
}

function permissionTarget(toolId: string, input: JsonValue): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const value = input as Record<string, JsonValue>
  if (toolId === 'bash') return typeof value['command'] === 'string' ? value['command'] : undefined
  return toolId === 'write' || toolId === 'edit'
    ? typeof value['path'] === 'string'
      ? value['path']
      : undefined
    : undefined
}

function matches(value: string, patterns: readonly string[] | undefined): boolean {
  return patterns?.some(pattern => permissionPattern(pattern).test(value)) ?? false
}

function permissionPattern(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*') {
      const recursive = pattern[index + 1] === '*'
      source += recursive ? '.*' : '[^/]*'
      if (recursive) index += 1
    } else {
      source += char.replace(/[\\^$+?.()|[\]{}]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`)
}

function occurrenceFor(invocation: ToolInvocation): DecisionOccurrence {
  return {
    invocationId: invocation.invocationId,
    runId: invocation.runId,
    agentId: invocation.agentId,
    sessionId: invocation.sessionId,
    ...(invocation.workflowId ? { workflowId: invocation.workflowId } : {}),
    toolId: invocation.toolId,
    callId: invocation.callId,
    step: invocation.step,
  }
}

function runGovernanceCallback<T>(
  invocation: Invocation,
  operation: (execution: DecisionExecutionContext) => Promise<T> | T,
): Promise<T> {
  const deadline = Date.now() + invocation.decisionTimeoutMs
  return runDecisionOperation({ signal: invocation.signal, deadline }, signal =>
    operation({ signal, deadline: Math.min(deadline, invocation.deadline ?? Number.POSITIVE_INFINITY) }),
  )
}

function strongest(values: readonly Evaluated[]): Evaluated | undefined {
  let winner: Evaluated | undefined
  for (const value of values) if (!winner || rank(value.effect) > rank(winner.effect)) winner = value
  return winner
}

function rank(effect: GovernanceEffect): number {
  return effect === 'deny' ? 4 : effect === 'require_approval' ? 3 : effect === 'audit' ? 2 : 1
}

function approvalIdentity(invocation: ToolInvocation, demands: readonly DecisionEvidence[]): string {
  return `approval_${createHash('sha256')
    .update(
      JSON.stringify([
        invocation.runId,
        invocation.invocationId,
        'approval',
        invocation.step,
        invocation.toolId,
        invocation.callId,
        demands.map(demand => demand.decisionId),
      ]),
      'utf8',
    )
    .digest('hex')}`
}

function decisionFailure(
  evidence: DecisionEvidence,
  error: unknown,
  fallback: 'callback_failed' | 'audit_failed',
): DecisionEvaluationError | OperationCancelledError | OperationTimeoutError {
  if (error instanceof OperationTimeoutError && error.meta?.['scope'] === 'decision')
    return new DecisionEvaluationError(
      evidence,
      fallback === 'audit_failed' ? 'audit_failed' : 'callback_timeout',
      error,
    )
  if (error instanceof OperationCancelledError || error instanceof OperationTimeoutError) return error
  return new DecisionEvaluationError(evidence, fallback, error)
}

async function safeTerminalEvent(
  invocation: ToolInvocation,
  approvalId: string,
  outcome: 'approved' | 'rejected',
): Promise<void> {
  await invocation.emitEvent?.({
    type: 'approval.finished',
    runId: invocation.runId,
    agentId: invocation.agentId,
    invocationId: invocation.invocationId,
    toolId: invocation.toolId,
    callId: invocation.callId,
    step: invocation.step,
    approvalId,
    outcome,
  })
}
