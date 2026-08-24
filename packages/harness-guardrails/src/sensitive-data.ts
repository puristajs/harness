import type { JsonValue } from '@purista/harness'
import { GuardrailEvaluationError, GuardrailsConfigError, type GuardrailPhase } from './errors.js'
import type { NeMoSensitiveDataPolicy } from './config.js'
import type { GuardrailAction, GuardrailActionContext, GuardrailActions, GuardrailOutcome } from './rails.js'

/** Whether the detector keeps inspection local or sends data to an application-selected cloud service. */
export type SensitiveDataExecutionMode = 'local' | 'cloud'

/** One content-free sensitive-data location using JavaScript UTF-16 string offsets. */
export interface SensitiveDataFinding {
  readonly category: string
  readonly start: number
  readonly end: number
  readonly score?: number
}

/** The bounded inspection input passed to an injected detector. */
export interface SensitiveDataInspectionRequest {
  readonly text: string
  readonly entities: readonly string[]
  readonly scoreThreshold: number
  readonly signal: AbortSignal
}

/** Content-free detector result. Matched text and provider payloads never cross this boundary. */
export interface SensitiveDataInspectionResult {
  readonly findings: readonly SensitiveDataFinding[]
}

/** Provider-neutral sensitive-data detector injected at the application composition root. */
export interface SensitiveDataDetector {
  readonly id: string
  readonly executionMode: SensitiveDataExecutionMode
  readonly supportedEntities?: readonly string[]
  inspect(request: SensitiveDataInspectionRequest): Promise<SensitiveDataInspectionResult>
}

/** One selected string field of a structured tool input or output. */
export interface SensitiveDataTextSegment {
  readonly id: string
  readonly text: string
}

/** A content-free replacement emitted for a selected tool value segment. */
export interface SensitiveDataReplacement {
  readonly id: string
  readonly start: number
  readonly end: number
  readonly value: string
}

/** Application-owned extraction and replacement boundary for structured tool values. */
export interface SensitiveDataValueCodec<T extends JsonValue = JsonValue> {
  readonly id: string
  extract(value: T): readonly SensitiveDataTextSegment[]
  replace(value: T, replacements: readonly SensitiveDataReplacement[]): T
}

/** Configures explicit sensitive-data protection for a selected tool phase. */
export interface SensitiveDataToolActionOptions<T extends JsonValue = JsonValue> {
  readonly policy: 'input' | 'output'
  readonly codec: SensitiveDataValueCodec<T>
  readonly detectFlow?: string
  readonly maskFlow?: string
}

/** Factory options for the built-in provider-neutral sensitive-data rail actions. */
export interface CreateSensitiveDataActionsOptions {
  readonly detector: SensitiveDataDetector
  readonly toolInput?: SensitiveDataToolActionOptions
  readonly toolOutput?: SensitiveDataToolActionOptions
}

type Operation = 'detect' | 'mask'
type PolicyPhase = 'input' | 'output' | 'retrieval'
type PolicyBoundAction = GuardrailAction & { readonly sensitiveDataPolicyPhase: PolicyPhase; readonly sensitiveDataSupportedEntities?: readonly string[] }

/**
 * Creates the six exact portable sensitive-data actions and any explicitly
 * configured tool actions. The detector remains injected and provider-neutral.
 *
 * @example
 * const actions = createSensitiveDataActions({ detector })
 */
export function createSensitiveDataActions(options: CreateSensitiveDataActionsOptions): GuardrailActions {
  validateDetector(options.detector)
  const actions: Record<string, GuardrailAction> = {
    'detect sensitive data on input': stringAction(options.detector, 'detect', 'input'),
    'mask sensitive data on input': stringAction(options.detector, 'mask', 'input'),
    'detect sensitive data on output': stringAction(options.detector, 'detect', 'output'),
    'mask sensitive data on output': stringAction(options.detector, 'mask', 'output'),
    'detect sensitive data on retrieval': retrievalAction(options.detector, 'detect'),
    'mask sensitive data on retrieval': retrievalAction(options.detector, 'mask')
  }
  addToolActions(actions, options.detector, 'tool_input', options.toolInput)
  addToolActions(actions, options.detector, 'tool_output', options.toolOutput)
  return actions
}

function addToolActions(actions: Record<string, GuardrailAction>, detector: SensitiveDataDetector, phase: 'tool_input' | 'tool_output', options: SensitiveDataToolActionOptions | undefined): void {
  if (!options) return
  if (!options.detectFlow && !options.maskFlow) throw new GuardrailsConfigError('A sensitive-data tool binding needs a detectFlow or maskFlow.', { reason: 'invalid_shape', field: `${phase}` })
  if (!isStableId(options.codec.id)) throw new GuardrailsConfigError('Sensitive-data codec id must be a stable ASCII identifier.', { reason: 'invalid_shape', field: `${phase}.codec.id` })
  for (const [operation, flow] of [['detect', options.detectFlow], ['mask', options.maskFlow]] as const) {
    if (!flow) continue
    if (!flow.trim() || actions[flow]) throw new GuardrailsConfigError('Sensitive-data tool action flow names must be unique non-empty strings.', { reason: 'invalid_shape', field: `${phase}.${operation}Flow` })
    actions[flow] = toolAction(detector, operation, phase, options)
  }
}

function stringAction(detector: SensitiveDataDetector, operation: Operation, policy: PolicyPhase): PolicyBoundAction {
  return {
    mayTransform: operation === 'mask',
    sensitiveDataPolicyPhase: policy,
    ...(detector.supportedEntities ? { sensitiveDataSupportedEntities: detector.supportedEntities } : {}),
    async evaluate(ctx) {
      if (typeof ctx.value !== 'string') throw codecError(ctx)
      return evaluateText(detector, operation, ctx, policyFor(ctx), ctx.value)
    }
  }
}

function retrievalAction(detector: SensitiveDataDetector, operation: Operation): PolicyBoundAction {
  return {
    mayTransform: operation === 'mask',
    sensitiveDataPolicyPhase: 'retrieval',
    ...(detector.supportedEntities ? { sensitiveDataSupportedEntities: detector.supportedEntities } : {}),
    async evaluate(ctx) {
      if (!Array.isArray(ctx.value)) throw codecError(ctx)
      const policy = policyFor(ctx)
      const transformed: JsonValue[] = []
      let changed = false
      for (const chunk of ctx.value) {
        if (typeof chunk !== 'string') throw codecError(ctx)
        if (chunk.length === 0) {
          transformed.push(chunk)
          continue
        }
        const outcome = await inspect(detector, operation, ctx, policy, chunk)
        if (outcome.findings.length === 0) {
          transformed.push(chunk)
          continue
        }
        if (operation === 'detect') return blocked()
        transformed.push(mask(chunk, outcome.findings, policy.maskToken))
        changed = true
      }
      return changed ? transformedOutcome(transformed) : allow()
    }
  }
}

function toolAction(detector: SensitiveDataDetector, operation: Operation, phase: 'tool_input' | 'tool_output', options: SensitiveDataToolActionOptions): PolicyBoundAction {
  return {
    mayTransform: operation === 'mask',
    sensitiveDataPolicyPhase: options.policy,
    ...(detector.supportedEntities ? { sensitiveDataSupportedEntities: detector.supportedEntities } : {}),
    async evaluate(ctx) {
      const policy = policyFor(ctx)
      let segments: readonly SensitiveDataTextSegment[]
      try {
        segments = options.codec.extract(ctx.value)
        validateSegments(segments)
      } catch {
        throw codecError(ctx)
      }
      const replacements: SensitiveDataReplacement[] = []
      for (const segment of segments) {
        const outcome = await inspect(detector, operation, ctx, policy, segment.text)
        if (outcome.findings.length === 0) continue
        if (operation === 'detect') return blocked()
        replacements.push(...outcome.findings.map((finding) => ({ id: segment.id, start: finding.start, end: finding.end, value: policy.maskToken })))
      }
      if (replacements.length === 0) return allow()
      try {
        const value = options.codec.replace(ctx.value, replacements)
        return transformed(phase, value)
      } catch {
        throw codecError(ctx)
      }
    }
  }
}

async function evaluateText(detector: SensitiveDataDetector, operation: Operation, ctx: GuardrailActionContext, policy: NeMoSensitiveDataPolicy, text: string): Promise<GuardrailOutcome> {
  if (text.length === 0) return allow()
  const outcome = await inspect(detector, operation, ctx, policy, text)
  if (outcome.findings.length === 0) return allow()
  if (operation === 'detect') return blocked()
  return transformed(ctx.phase, mask(text, outcome.findings, policy.maskToken))
}

async function inspect(detector: SensitiveDataDetector, operation: Operation, ctx: GuardrailActionContext, policy: NeMoSensitiveDataPolicy, text: string): Promise<SensitiveDataInspectionResult> {
  const telemetry = ctx.telemetry
  const started = Date.now()
  const attrs = inspectionAttributes(detector, operation, policy)
  try {
    const result = await telemetry!.span('harness.sensitive_data.inspect', attrs, async (span) => {
      try {
        const inspected = await detector.inspect({ text, entities: policy.entities, scoreThreshold: policy.scoreThreshold, signal: ctx.signal ?? new AbortController().signal })
        try {
          validateResult(inspected, text, policy.entities)
        } catch {
          throw detectorError(ctx, 'sensitive_data_invalid_result')
        }
        const outcome = inspected.findings.length === 0 ? 'allow' : operation === 'detect' ? 'block' : 'transform'
        span.setAttributes({ 'harness.sensitive_data.outcome': outcome, 'harness.sensitive_data.finding_count': String(Math.min(inspected.findings.length, 100)) })
        return inspected
      } catch (error) {
        const classified = error instanceof GuardrailEvaluationError ? error : detectorError(ctx, 'sensitive_data_detector_failed')
        span.setAttributes({ 'harness.sensitive_data.outcome': 'error', 'error.type': classified.code })
        throw classified
      }
    })
    const outcome = result.findings.length === 0 ? 'allow' : operation === 'detect' ? 'block' : 'transform'
    recordInspection(ctx, attrs, outcome, started)
    if (outcome !== 'allow') logInspection(ctx, detector, operation, outcome, policy)
    return result
  } catch (error) {
    const classified = error instanceof GuardrailEvaluationError ? error : detectorError(ctx, 'sensitive_data_detector_failed')
    recordInspection(ctx, attrs, 'error', started, classified.code)
    logInspection(ctx, detector, operation, 'error', policy, classified.code)
    throw classified
  }
}

function policyFor(ctx: GuardrailActionContext): NeMoSensitiveDataPolicy {
  if (!ctx.sensitiveDataPolicy) throw new GuardrailsConfigError('Sensitive-data action has no matching sensitive_data_detection policy.', { reason: 'invalid_shape', field: `rails.${ctx.phase}` })
  return ctx.sensitiveDataPolicy
}

function validateDetector(detector: SensitiveDataDetector): void {
  if (!detector || !isStableId(detector.id) || !['local', 'cloud'].includes(detector.executionMode) || typeof detector.inspect !== 'function') {
    throw new GuardrailsConfigError('Sensitive-data detector must expose a stable id, execution mode, and inspect method.', { reason: 'invalid_shape', field: 'detector' })
  }
  if (detector.supportedEntities && (detector.supportedEntities.length === 0 || detector.supportedEntities.some((entity) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(entity)))) {
    throw new GuardrailsConfigError('Sensitive-data detector capabilities must use stable entity identifiers.', { reason: 'invalid_shape', field: 'detector.supportedEntities' })
  }
}

function validateResult(result: SensitiveDataInspectionResult, text: string, requestedEntities: readonly string[]): void {
  if (!result || !Array.isArray(result.findings)) throw new Error('invalid result')
  let previousEnd = -1
  for (const finding of [...result.findings].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (!finding || !requestedEntities.includes(finding.category) || !Number.isSafeInteger(finding.start) || !Number.isSafeInteger(finding.end) || finding.start < 0 || finding.start >= finding.end || finding.end > text.length || finding.start < previousEnd || (finding.score !== undefined && (!Number.isFinite(finding.score) || finding.score < 0 || finding.score > 1))) {
      throw new Error('invalid result')
    }
    previousEnd = finding.end
  }
}

function validateSegments(segments: readonly SensitiveDataTextSegment[]): void {
  const seen = new Set<string>()
  for (const segment of segments) {
    if (!segment || !isStableId(segment.id) || typeof segment.text !== 'string' || seen.has(segment.id)) throw new Error('invalid codec segments')
    seen.add(segment.id)
  }
}

function mask(text: string, findings: readonly SensitiveDataFinding[], maskToken: string): string {
  return [...findings].sort((a, b) => b.start - a.start || b.end - a.end).reduce((current, finding) => current.slice(0, finding.start) + maskToken + current.slice(finding.end), text)
}

function transformed(phase: GuardrailPhase, value: JsonValue): GuardrailOutcome {
  const target = phase === 'input' ? 'user_message' : phase === 'output' ? 'bot_message' : phase === 'tool_input' ? 'tool_input' : phase === 'tool_output' ? 'tool_output' : 'relevant_chunks'
  return { decision: 'transform', target, value, reasonCode: 'sensitive_data_masked' }
}

function transformedOutcome(value: JsonValue): GuardrailOutcome {
  return { decision: 'transform', target: 'relevant_chunks', value, reasonCode: 'sensitive_data_masked' }
}

function allow(): GuardrailOutcome { return { decision: 'allow' } }
function blocked(): GuardrailOutcome { return { decision: 'block', reasonCode: 'sensitive_data_detected' } }

function inspectionAttributes(detector: SensitiveDataDetector, operation: Operation, policy: NeMoSensitiveDataPolicy): Record<string, string> {
  return {
    'openinference.span.kind': 'GUARDRAIL',
    'harness.sensitive_data.detector.id': detector.id,
    'harness.sensitive_data.execution_mode': detector.executionMode,
    'harness.sensitive_data.operation': operation,
    'harness.sensitive_data.categories': [...policy.entities].sort().slice(0, 16).join(',')
  }
}

function recordInspection(ctx: GuardrailActionContext, attrs: Record<string, string>, outcome: 'allow' | 'block' | 'transform' | 'error', started: number, errorType?: string): void {
  const dimensions = { ...attrs, 'harness.sensitive_data.outcome': outcome, ...(errorType ? { 'error.type': errorType } : {}) }
  ctx.telemetry!.recordCounter('harness.sensitive_data.inspections', 1, dimensions)
  ctx.telemetry!.recordHistogram('harness.sensitive_data.duration', (Date.now() - started) / 1000, dimensions)
}

function logInspection(ctx: GuardrailActionContext, detector: SensitiveDataDetector, operation: Operation, outcome: 'block' | 'transform' | 'error', policy: NeMoSensitiveDataPolicy, errorCode?: string): void {
  const fields = { sensitive_data_detector_id: detector.id, sensitive_data_execution_mode: detector.executionMode, sensitive_data_operation: operation, sensitive_data_outcome: outcome, sensitive_data_categories: [...policy.entities].sort().slice(0, 16).join(','), ...(errorCode ? { error_code: errorCode } : {}) }
  if (outcome === 'block') ctx.logger?.warn('Harness sensitive-data guardrail blocked execution.', fields)
  else if (outcome === 'transform') ctx.logger?.info('Harness sensitive-data guardrail transformed a value.', fields)
  else ctx.logger?.error('Harness sensitive-data guardrail failed closed.', fields)
}

function detectorError(ctx: GuardrailActionContext, reason: 'sensitive_data_detector_failed' | 'sensitive_data_invalid_result'): GuardrailEvaluationError {
  return new GuardrailEvaluationError('Sensitive-data inspection failed closed.', { rail_id: ctx.railId, phase: ctx.phase, reason })
}

function codecError(ctx: GuardrailActionContext): GuardrailEvaluationError {
  return new GuardrailEvaluationError('Sensitive-data codec failed closed.', { rail_id: ctx.railId, phase: ctx.phase, reason: 'sensitive_data_codec_failed' })
}

function isStableId(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)
}
