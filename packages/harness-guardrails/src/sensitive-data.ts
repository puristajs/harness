import { decisionResultSchema, isJsonValue } from '@purista/harness'
import type { DecisionFailureKind, Infer, JsonValue, Schema } from '@purista/harness'
import { z } from 'zod'
import { createGuardrailAction } from './action.js'
import { GuardrailsConfigError } from './errors.js'
import type { SensitiveDataPolicy } from './config-schema.js'
import type { GuardrailAction, GuardrailActionContext, GuardrailOutcome, GuardrailValue } from './rails.js'
import type { GuardrailPhase } from './config-schema.js'

/** Whether the detector keeps inspection local or sends data to an application-selected cloud service. */
export type SensitiveDataExecutionMode = 'local' | 'cloud'

/** A stable, content-free failure classification emitted by an injected detector. */
export class SensitiveDataDetectorError extends Error {
  /** Stable detector-owned failure kind safe for logs, metrics, and traces. */
  public readonly kind: string

  /**
   * @param kind A stable ASCII classification; the message must never contain inspected content.
   * @param message A safe operator-facing remediation message.
   */
  public constructor(kind: string, message: string) {
    super(message)
    this.name = 'SensitiveDataDetectorError'
    this.kind = kind
  }
}

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
  readonly extract: (value: T) => readonly SensitiveDataTextSegment[]
  readonly replace: (value: T, replacements: readonly SensitiveDataReplacement[]) => T
}

/** Configures one selected structured tool rail with a schema-bound codec. */
type AnySchema = Schema<any, any>
type JsonOutputSchema<S extends AnySchema> = Infer<S> extends JsonValue ? S : never

export interface SensitiveDataToolRailOptions<P extends 'tool_input' | 'tool_output', S extends AnySchema> {
  readonly detector: SensitiveDataDetector
  readonly phase: P
  readonly tools: readonly [string, ...string[]]
  readonly policy: 'input' | 'output'
  readonly operation: Operation
  readonly valueSchema: S & JsonOutputSchema<S>
  readonly codec: SensitiveDataValueCodec<Infer<S>>
}

/** Factory options for the built-in provider-neutral sensitive-data rail actions. */
export interface CreateSensitiveDataActionsOptions {
  readonly detector: SensitiveDataDetector
}

type Operation = 'detect' | 'mask'
type PolicyPhase = 'input' | 'output' | 'retrieval'
type SensitiveDataMetadata = Readonly<{ policyPhase: PolicyPhase; supportedEntities?: readonly string[] }>
const metadata = new WeakMap<object, SensitiveDataMetadata>()

/** Internal rail compiler metadata for sensitive-data tokens. */
export function sensitiveDataMetadata(action: GuardrailAction): SensitiveDataMetadata | undefined {
  return metadata.get(action)
}

/** Private action classification consumed by the rail boundary's safe error projection. */
class SensitiveDataActionError extends Error {
  public constructor(
    readonly failureKind: Extract<
      DecisionFailureKind,
      'sensitive_data_detector_failed' | 'sensitive_data_invalid_result' | 'sensitive_data_codec_failed'
    >,
    cause?: unknown,
  ) {
    super('Sensitive-data inspection failed closed.', { cause })
  }
}

/** Returns the stable failure class without exposing detector text or payloads. */
export function sensitiveDataFailureKind(
  error: unknown,
):
  | Extract<
      DecisionFailureKind,
      'sensitive_data_detector_failed' | 'sensitive_data_invalid_result' | 'sensitive_data_codec_failed'
    >
  | undefined {
  return error instanceof SensitiveDataActionError ? error.failureKind : undefined
}

/**
 * Creates the six exact portable sensitive-data actions. Structured tool
 * protection is authored explicitly with `sensitiveDataToolRail`.
 *
 * @example
 * const actions = createSensitiveDataActions({ detector })
 */
export function createSensitiveDataActions(options: CreateSensitiveDataActionsOptions): Readonly<{
  'detect sensitive data on input': GuardrailAction<'input'>
  'mask sensitive data on input': GuardrailAction<'input'>
  'detect sensitive data on output': GuardrailAction<'output'>
  'mask sensitive data on output': GuardrailAction<'output'>
  'detect sensitive data on retrieval': GuardrailAction<'retrieval'>
  'mask sensitive data on retrieval': GuardrailAction<'retrieval'>
}> {
  validateDetector(options.detector)
  return {
    'detect sensitive data on input': stringAction(options.detector, 'detect', 'input'),
    'mask sensitive data on input': stringAction(options.detector, 'mask', 'input'),
    'detect sensitive data on output': stringAction(options.detector, 'detect', 'output'),
    'mask sensitive data on output': stringAction(options.detector, 'mask', 'output'),
    'detect sensitive data on retrieval': retrievalAction(options.detector, 'detect'),
    'mask sensitive data on retrieval': retrievalAction(options.detector, 'mask'),
  }
}

function bindSensitiveDataMetadata<P extends GuardrailPhase>(
  action: GuardrailAction<P>,
  detector: SensitiveDataDetector,
  policyPhase: PolicyPhase,
): GuardrailAction<P> {
  metadata.set(
    action,
    Object.freeze({
      policyPhase,
      ...(detector.supportedEntities ? { supportedEntities: Object.freeze([...detector.supportedEntities]) } : {}),
    }),
  )
  return action
}

function stringAction<P extends 'input' | 'output'>(
  detector: SensitiveDataDetector,
  operation: 'detect',
  policy: P,
): GuardrailAction<P>
function stringAction<P extends 'input' | 'output'>(
  detector: SensitiveDataDetector,
  operation: 'mask',
  policy: P,
): GuardrailAction<P>
function stringAction<P extends 'input' | 'output'>(
  detector: SensitiveDataDetector,
  operation: Operation,
  policy: P,
): GuardrailAction<P> {
  const action =
    operation === 'detect'
      ? createGuardrailAction<P>({
          phase: policy,
          valueSchema: z.string(),
          mayTransform: false,
          evaluate: async (ctx: GuardrailActionContext<P, string>) =>
            evaluateText(detector, operation, ctx, policyFor(ctx), ctx.value),
        })
      : createGuardrailAction<P>({
          phase: policy,
          valueSchema: z.string(),
          evaluate: async (ctx: GuardrailActionContext<P, string>) =>
            evaluateText(detector, operation, ctx, policyFor(ctx), ctx.value),
        })
  return bindSensitiveDataMetadata(action, detector, policy)
}

function retrievalAction(detector: SensitiveDataDetector, operation: 'detect'): GuardrailAction<'retrieval'>
function retrievalAction(detector: SensitiveDataDetector, operation: 'mask'): GuardrailAction<'retrieval'>
function retrievalAction(detector: SensitiveDataDetector, operation: Operation): GuardrailAction<'retrieval'> {
  const action =
    operation === 'detect'
      ? createGuardrailAction<'retrieval'>({
          phase: 'retrieval',
          valueSchema: z.array(z.string()),
          mayTransform: false,
          evaluate: async (ctx: GuardrailActionContext<'retrieval', readonly string[]>) => {
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
          },
        })
      : createGuardrailAction<'retrieval'>({
          phase: 'retrieval',
          valueSchema: z.array(z.string()),
          evaluate: async (ctx: GuardrailActionContext<'retrieval', readonly string[]>) => {
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
              transformed.push(mask(chunk, outcome.findings, policy.maskToken))
              changed = true
            }
            return changed ? transformedOutcome(transformed) : allow()
          },
        })
  return bindSensitiveDataMetadata(action, detector, 'retrieval')
}

/** Creates one schema-bound sensitive-data action for explicitly selected tools. */
export function sensitiveDataToolRail<const P extends 'tool_input' | 'tool_output', const S extends AnySchema>(
  options: SensitiveDataToolRailOptions<P, S>,
): GuardrailAction<P> {
  validateDetector(options.detector)
  if (!isStableId(options.codec.id)) throw new GuardrailsConfigError({ reason: 'invalid_shape', field: 'codec.id' })
  const evaluate = async (ctx: GuardrailActionContext<P, Infer<S>>): Promise<GuardrailOutcome<P, Infer<S>>> => {
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
      const outcome = await inspect(options.detector, options.operation, ctx, policy, segment.text)
      if (outcome.findings.length === 0) continue
      if (options.operation === 'detect') return blocked()
      replacements.push(
        ...outcome.findings.map((finding) => ({
          id: segment.id,
          start: finding.start,
          end: finding.end,
          value: policy.maskToken,
        })),
      )
    }
    if (replacements.length === 0) return allow()
    try {
      const value = options.codec.replace(ctx.value, replacements)
      return transformed(options.phase, value)
    } catch {
      throw codecError(ctx)
    }
  }
  const action =
    options.operation === 'detect'
      ? createGuardrailAction<P>({
          phase: options.phase,
          tools: options.tools,
          valueSchema: options.valueSchema,
          mayTransform: false,
          evaluate,
        })
      : createGuardrailAction<P>({
          phase: options.phase,
          tools: options.tools,
          valueSchema: options.valueSchema,
          evaluate,
        })
  return bindSensitiveDataMetadata(action, options.detector, options.policy)
}

async function evaluateText<P extends 'input' | 'output'>(
  detector: SensitiveDataDetector,
  operation: Operation,
  ctx: GuardrailActionContext<P, string>,
  policy: SensitiveDataPolicy,
  text: string,
): Promise<GuardrailOutcome<P, string>> {
  if (text.length === 0) return allow()
  const outcome = await inspect(detector, operation, ctx, policy, text)
  if (outcome.findings.length === 0) return allow()
  if (operation === 'detect') return blocked()
  return transformed(ctx.phase, mask(text, outcome.findings, policy.maskToken))
}

async function inspect(
  detector: SensitiveDataDetector,
  operation: Operation,
  ctx: GuardrailActionContext,
  policy: SensitiveDataPolicy,
  text: string,
): Promise<SensitiveDataInspectionResult> {
  const telemetry = ctx.telemetry
  const started = Date.now()
  const attrs = inspectionAttributes(detector, operation, policy)
  try {
    const result = await telemetry!.span('harness.sensitive_data.inspect', attrs, async (span) => {
      try {
        const inspected = await detector.inspect({
          text,
          entities: policy.entities,
          scoreThreshold: policy.scoreThreshold,
          signal: ctx.signal ?? new AbortController().signal,
        })
        try {
          validateResult(inspected, text, policy.entities)
        } catch {
          throw detectorError('sensitive_data_invalid_result')
        }
        const outcome = inspected.findings.length === 0 ? 'allow' : operation === 'detect' ? 'block' : 'transform'
        span.setAttributes({
          'harness.sensitive_data.outcome': outcome,
          'harness.sensitive_data.finding_count': String(Math.min(inspected.findings.length, 100)),
        })
        return inspected
      } catch (error) {
        const classified =
          error instanceof SensitiveDataActionError ? error : detectorError('sensitive_data_detector_failed', error)
        const failureKind = detectorFailureKind(error)
        span.setAttributes({
          'harness.sensitive_data.outcome': 'error',
          'error.type': 'DECISION_EVALUATION_ERROR',
          ...(failureKind ? { 'harness.sensitive_data.failure_kind': failureKind } : {}),
        })
        throw classified
      }
    })
    const outcome = result.findings.length === 0 ? 'allow' : operation === 'detect' ? 'block' : 'transform'
    recordInspection(ctx, attrs, outcome, started)
    if (outcome !== 'allow') logInspection(ctx, detector, operation, outcome, policy)
    return result
  } catch (error) {
    const classified =
      error instanceof SensitiveDataActionError ? error : detectorError('sensitive_data_detector_failed', error)
    const failureKind = detectorFailureKind(error)
    recordInspection(ctx, attrs, 'error', started, 'DECISION_EVALUATION_ERROR', failureKind)
    logInspection(ctx, detector, operation, 'error', policy, 'DECISION_EVALUATION_ERROR', failureKind)
    throw classified
  }
}

function policyFor(ctx: GuardrailActionContext): SensitiveDataPolicy {
  if (!ctx.sensitiveDataPolicy)
    throw new GuardrailsConfigError({ reason: 'missing_policy', field: `rails.${ctx.phase}` })
  return ctx.sensitiveDataPolicy
}

function validateDetector(detector: SensitiveDataDetector): void {
  if (
    !detector ||
    !isStableId(detector.id) ||
    !['local', 'cloud'].includes(detector.executionMode) ||
    typeof detector.inspect !== 'function'
  ) {
    throw new GuardrailsConfigError({ reason: 'invalid_shape', field: 'detector' })
  }
  if (
    detector.supportedEntities &&
    (detector.supportedEntities.length === 0 ||
      detector.supportedEntities.some((entity) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(entity)))
  ) {
    throw new GuardrailsConfigError({ reason: 'invalid_shape', field: 'detector.supportedEntities' })
  }
}

function validateResult(
  result: SensitiveDataInspectionResult,
  text: string,
  requestedEntities: readonly string[],
): void {
  if (!result || !Array.isArray(result.findings)) throw new Error('invalid result')
  let previousEnd = -1
  for (const finding of [...result.findings].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (
      !finding ||
      !requestedEntities.includes(finding.category) ||
      !Number.isSafeInteger(finding.start) ||
      !Number.isSafeInteger(finding.end) ||
      finding.start < 0 ||
      finding.start >= finding.end ||
      finding.end > text.length ||
      finding.start < previousEnd ||
      (finding.score !== undefined && (!Number.isFinite(finding.score) || finding.score < 0 || finding.score > 1))
    ) {
      throw new Error('invalid result')
    }
    previousEnd = finding.end
  }
}

function validateSegments(segments: readonly SensitiveDataTextSegment[]): void {
  const seen = new Set<string>()
  for (const segment of segments) {
    if (!segment || !isStableId(segment.id) || typeof segment.text !== 'string' || seen.has(segment.id))
      throw new Error('invalid codec segments')
    seen.add(segment.id)
  }
}

function mask(text: string, findings: readonly SensitiveDataFinding[], maskToken: string): string {
  return [...findings]
    .sort((a, b) => b.start - a.start || b.end - a.end)
    .reduce((current, finding) => current.slice(0, finding.start) + maskToken + current.slice(finding.end), text)
}

function transformed<P extends GuardrailPhase, V>(phase: P, value: V): GuardrailOutcome<P, V> {
  const target = targetFor(phase)
  return { decision: 'transform', target, value, reasonCode: 'sensitive_data_masked' }
}

function transformedOutcome(value: readonly JsonValue[]): GuardrailOutcome<'retrieval'> {
  return { decision: 'transform', target: 'relevant_chunks', value, reasonCode: 'sensitive_data_masked' }
}

function allow(): Readonly<{ decision: 'allow' }> {
  return { decision: 'allow' }
}
function blocked(): Readonly<{ decision: 'block'; reasonCode: string }> {
  return { decision: 'block', reasonCode: 'sensitive_data_detected' }
}

function targetFor<P extends GuardrailPhase>(phase: P): import('./rails.js').GuardrailTransformTarget<P> {
  return (
    phase === 'input'
      ? 'user_message'
      : phase === 'output'
        ? 'bot_message'
        : phase === 'tool_input'
          ? 'tool_input'
          : phase === 'tool_output'
            ? 'tool_output'
            : 'relevant_chunks'
  ) as import('./rails.js').GuardrailTransformTarget<P>
}

function inspectionAttributes(
  detector: SensitiveDataDetector,
  operation: Operation,
  policy: SensitiveDataPolicy,
): Record<string, string> {
  return {
    'openinference.span.kind': 'GUARDRAIL',
    'harness.sensitive_data.detector.id': detector.id,
    'harness.sensitive_data.execution_mode': detector.executionMode,
    'harness.sensitive_data.operation': operation,
    'harness.sensitive_data.categories': [...policy.entities].sort().slice(0, 16).join(','),
  }
}

function recordInspection(
  ctx: GuardrailActionContext,
  attrs: Record<string, string>,
  outcome: 'allow' | 'block' | 'transform' | 'error',
  started: number,
  errorType?: string,
  failureKind?: string,
): void {
  const dimensions = {
    ...attrs,
    'harness.sensitive_data.outcome': outcome,
    ...(errorType ? { 'error.type': errorType } : {}),
    ...(failureKind ? { 'harness.sensitive_data.failure_kind': failureKind } : {}),
  }
  ctx.telemetry!.recordCounter('harness.sensitive_data.inspections', 1, dimensions)
  ctx.telemetry!.recordHistogram('harness.sensitive_data.duration', (Date.now() - started) / 1000, dimensions)
}

function logInspection(
  ctx: GuardrailActionContext,
  detector: SensitiveDataDetector,
  operation: Operation,
  outcome: 'block' | 'transform' | 'error',
  policy: SensitiveDataPolicy,
  errorCode?: string,
  failureKind?: string,
): void {
  const fields = {
    sensitive_data_detector_id: detector.id,
    sensitive_data_execution_mode: detector.executionMode,
    sensitive_data_operation: operation,
    sensitive_data_outcome: outcome,
    sensitive_data_categories: [...policy.entities].sort().slice(0, 16).join(','),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(failureKind ? { sensitive_data_failure_kind: failureKind } : {}),
  }
  if (outcome === 'block') ctx.logger?.warn('Harness sensitive-data guardrail blocked execution.', fields)
  else if (outcome === 'transform') ctx.logger?.info('Harness sensitive-data guardrail transformed a value.', fields)
  else ctx.logger?.error('Harness sensitive-data guardrail failed closed.', fields)
}

function detectorError(
  reason: 'sensitive_data_detector_failed' | 'sensitive_data_invalid_result',
  cause?: unknown,
): SensitiveDataActionError {
  return new SensitiveDataActionError(reason, cause)
}

function detectorFailureKind(error: unknown): string | undefined {
  const source = error instanceof SensitiveDataDetectorError ? error : error instanceof Error ? error.cause : undefined
  if (!(source instanceof SensitiveDataDetectorError)) return undefined
  const parsed = decisionResultSchema.options[0].shape.reasonCode.safeParse(source.kind)
  return parsed.success ? parsed.data : undefined
}

function codecError(_ctx: GuardrailActionContext): SensitiveDataActionError {
  return new SensitiveDataActionError('sensitive_data_codec_failed')
}

function jsonValueForCodec(value: JsonValue | readonly JsonValue[]): JsonValue {
  if (isReadonlyJsonArray(value)) return [...value]
  if (isJsonValue(value)) return value
  throw new Error('Invalid protected tool value.')
}

function isReadonlyJsonArray(value: JsonValue | readonly JsonValue[]): value is readonly JsonValue[] {
  return Array.isArray(value)
}

function isStableId(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)
}
