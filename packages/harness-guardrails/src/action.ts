import { isJsonValue } from '@purista/harness'
import type { JsonValue } from '@purista/harness'
import { z } from 'zod'
import type { GuardrailPhase } from './config-schema.js'
import type { GuardrailActionContext, GuardrailOutcome, GuardrailValue } from './rails.js'

declare const guardrailActionBrand: unique symbol

/** An immutable, opaque action token accepted by `defineGuardrails`. */
export interface GuardrailAction<P extends GuardrailPhase = GuardrailPhase> {
  readonly phase: P
  readonly [guardrailActionBrand]: true
}

type ActionValue<P extends GuardrailPhase, Schema extends z.ZodTypeAny | undefined> =
  Schema extends z.ZodTypeAny ? z.output<Schema> : GuardrailValue<P>

type ActionResult<P extends GuardrailPhase, V, CanTransform extends boolean> =
  CanTransform extends false
    ? Extract<GuardrailOutcome<P, V>, { readonly decision: 'allow' | 'block' }>
    : GuardrailOutcome<P, V>

/** Callback used by an extracted guardrail action definition. */
export type GuardrailEvaluator<
  P extends GuardrailPhase = GuardrailPhase,
  V = GuardrailValue<P>,
  CanTransform extends boolean = true
> = (context: GuardrailActionContext<P, V>) => ActionResult<P, V, CanTransform> | Promise<ActionResult<P, V, CanTransform>>

type ToolSelector<P extends GuardrailPhase> = P extends 'tool_input' | 'tool_output'
  ? { readonly tools: readonly [string, ...string[]] }
  : { readonly tools?: never }

type ValueSchemaField<Schema extends z.ZodTypeAny | undefined> = Schema extends z.ZodTypeAny
  ? { readonly valueSchema: Schema }
  : { readonly valueSchema?: undefined }

type ActionDefinitionBase<
  P extends GuardrailPhase,
  Schema extends z.ZodTypeAny | undefined,
  CanTransform extends boolean
> = ToolSelector<P> & ValueSchemaField<Schema> & {
  readonly phase: P
  readonly timeoutMs?: number
  readonly mayTransform?: CanTransform
  readonly models?: readonly string[]
  readonly evaluate: GuardrailEvaluator<NoInfer<P>, ActionValue<P, Schema>, CanTransform>
}

/**
 * Definition accepted only by `defineGuardrailAction`.
 *
 * The helper retains callbacks and schemas privately, leaving callers with an
 * immutable phase token instead of an executable structural object.
 */
export type GuardrailActionDefinition<
  P extends GuardrailPhase = GuardrailPhase,
  Schema extends z.ZodTypeAny | undefined = undefined,
  CanTransform extends boolean = true
> = ActionDefinitionBase<P, Schema, CanTransform>

type ActionMetadata = Readonly<{
  valueSchema?: z.ZodTypeAny
  timeoutMs?: number
  mayTransform: boolean
  tools?: readonly string[]
  models: readonly string[]
  evaluate: GuardrailEvaluator
}>

const metadata = new WeakMap<object, ActionMetadata>()

/**
 * Creates an opaque action token. The evaluator and schema are intentionally
 * retained in a private side table so tokens cannot be forged or executed by
 * configuration consumers.
 */
export function defineGuardrailAction<const P extends GuardrailPhase, const Schema extends z.ZodType<JsonValue>>(
  definition: GuardrailActionDefinition<P, Schema, false> & { readonly valueSchema: Schema; readonly mayTransform: false }
): GuardrailAction<P>
export function defineGuardrailAction<const P extends 'tool_input' | 'tool_output', const Schema extends z.ZodType<JsonValue>>(
  definition: GuardrailActionDefinition<P, Schema, false> & { readonly tools: readonly [string, ...string[]]; readonly valueSchema: Schema; readonly mayTransform: false }
): GuardrailAction<P>
export function defineGuardrailAction<const P extends GuardrailPhase, const Schema extends z.ZodType<JsonValue>>(
  definition: GuardrailActionDefinition<P, Schema, true> & { readonly valueSchema: Schema; readonly mayTransform?: true | undefined }
): GuardrailAction<P>
export function defineGuardrailAction<const P extends 'tool_input' | 'tool_output', const Schema extends z.ZodType<JsonValue>>(
  definition: GuardrailActionDefinition<P, Schema, true> & { readonly tools: readonly [string, ...string[]]; readonly valueSchema: Schema; readonly mayTransform?: true | undefined }
): GuardrailAction<P>
export function defineGuardrailAction<const P extends GuardrailPhase>(
  definition: GuardrailActionDefinition<P, undefined, false> & { readonly valueSchema?: undefined; readonly mayTransform: false }
): GuardrailAction<P>
export function defineGuardrailAction<const P extends GuardrailPhase>(
  definition: GuardrailActionDefinition<P, undefined, true> & { readonly valueSchema?: undefined; readonly mayTransform?: true | undefined }
): GuardrailAction<P>
export function defineGuardrailAction(definition: unknown): GuardrailAction {
  return createGuardrailAction(definition)
}

/** Internal constructor used by addon-owned actions after their own validation. */
export function createGuardrailAction<P extends GuardrailPhase = GuardrailPhase>(definition: unknown): GuardrailAction<P> {
  const source = validateDefinition(definition)
  const token = Object.freeze({ phase: source.phase }) as GuardrailAction<P>
  metadata.set(token, Object.freeze({
    ...(source.valueSchema ? { valueSchema: source.valueSchema } : {}),
    ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
    mayTransform: source.mayTransform !== false,
    ...(source.tools ? { tools: Object.freeze([...source.tools]) } : {}),
    models: Object.freeze([...(source.models ?? [])]),
    evaluate: source.evaluate as GuardrailEvaluator
  }))
  return token
}

export function isGuardrailAction(value: unknown): value is GuardrailAction {
  return typeof value === 'object' && value !== null && metadata.has(value)
}

export function actionMetadata(action: GuardrailAction): ActionMetadata | undefined {
  return metadata.get(action)
}

/** Prepares a schema-validated callback thunk without invoking application code. */
export function prepareGuardrailAction(
  action: GuardrailAction,
  protectedValue: JsonValue | readonly JsonValue[]
): ((context: GuardrailActionContext) => ReturnType<GuardrailEvaluator>) | undefined {
  const entry = metadata.get(action)
  if (!entry) return undefined
  const snapshot = snapshotJson(protectedValue)
  let value = freezeJson(snapshot)
  if (entry.valueSchema) {
    const parsed = entry.valueSchema.safeParse(snapshot)
    if (!parsed.success || !isJsonValue(parsed.data) || !jsonEqual(parsed.data, snapshot)) return undefined
    value = freezeJson(snapshotJson(parsed.data))
  }
  return (context) => entry.evaluate({ ...context, phase: action.phase, value })
}

type RuntimeDefinition = Readonly<{
  phase: GuardrailPhase
  valueSchema?: z.ZodTypeAny
  timeoutMs?: number
  mayTransform?: boolean
  tools?: readonly string[]
  models?: readonly string[]
  evaluate: GuardrailEvaluator
}>

function validateDefinition(definition: unknown): RuntimeDefinition {
  if (!definition || typeof definition !== 'object') throw new TypeError('Invalid guardrail action definition.')
  const source = definition as Record<string, unknown>
  if (!['input', 'output', 'tool_input', 'tool_output', 'retrieval'].includes(source['phase'] as GuardrailPhase) || typeof source['evaluate'] !== 'function') {
    throw new TypeError('Invalid guardrail action definition.')
  }
  if (source['mayTransform'] !== undefined && typeof source['mayTransform'] !== 'boolean') throw new TypeError('Invalid guardrail action definition.')
  if (source['timeoutMs'] !== undefined && (typeof source['timeoutMs'] !== 'number' || !Number.isSafeInteger(source['timeoutMs']) || source['timeoutMs'] <= 0)) throw new TypeError('Invalid guardrail action definition.')
  const phase = source['phase'] as GuardrailPhase
  if (isToolPhase(phase)) {
    if (!Array.isArray(source['tools']) || source['tools'].length === 0 || !uniqueStableIds(source['tools'])) throw new TypeError('Invalid guardrail action definition.')
  } else if (source['tools'] !== undefined) {
    throw new TypeError('Invalid guardrail action definition.')
  }
  if (source['models'] !== undefined && (!Array.isArray(source['models']) || !uniqueStableIds(source['models']))) throw new TypeError('Invalid guardrail action definition.')
  return source as RuntimeDefinition
}

function isToolPhase(phase: GuardrailPhase): phase is 'tool_input' | 'tool_output' {
  return phase === 'tool_input' || phase === 'tool_output'
}

function uniqueStableIds(values: readonly string[]): boolean {
  const ids = new Set<string>()
  return values.every((value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value) && !ids.has(value) && (ids.add(value), true))
}

function jsonEqual(left: JsonValue, right: JsonValue | readonly JsonValue[]): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]!))
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) || Array.isArray(right)) return false
  const leftRecord = left as Record<string, JsonValue>
  const rightRecord = right as Record<string, JsonValue>
  const keys = Object.keys(leftRecord)
  return keys.length === Object.keys(rightRecord).length && keys.every((key) => Object.hasOwn(rightRecord, key) && jsonEqual(leftRecord[key]!, rightRecord[key]!))
}

function snapshotJson(value: JsonValue | readonly JsonValue[]): JsonValue {
  if (Array.isArray(value)) return value.map((item) => snapshotJson(item))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotJson(item)]))
  return value
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) value.forEach(freezeJson)
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(freezeJson)
  return Object.freeze(value)
}
