import { isJsonValue } from '@purista/harness'
import type { Infer, JsonValue, ModelAliasId, Schema } from '@purista/harness'
import type { GuardrailPhase } from './config-schema.js'
import type { GuardrailActionContext, GuardrailOutcome, GuardrailValue } from './rails.js'
import { GuardrailsConfigError } from './errors.js'

declare const guardrailActionBrand: unique symbol

type GuardrailToolSelector = readonly [string, ...string[]]
type GuardrailModelSelector = readonly [ModelAliasId, ...ModelAliasId[]]

/** An immutable, opaque action token accepted by `defineGuardrails`. */
export interface GuardrailAction<
  P extends GuardrailPhase = GuardrailPhase,
  Tools extends readonly string[] = readonly [],
  Models extends readonly ModelAliasId[] = readonly [],
> {
  readonly phase: P
  readonly [guardrailActionBrand]: Readonly<{
    tools: Tools
    models: Models
  }>
}

/** Heterogeneous action constraint used by action maps. */
export type AnyGuardrailAction = GuardrailAction<GuardrailPhase, readonly string[], readonly ModelAliasId[]>

type AnySchema = Schema

/** Rejects a schema whose validated value cannot cross a JSON rail boundary. */
type JsonOutputSchema<S extends AnySchema> = Infer<S> extends JsonValue ? S : never

type ActionValue<P extends GuardrailPhase, S extends AnySchema | undefined> = S extends AnySchema
  ? Infer<S> & JsonValue
  : GuardrailValue<P>

type ActionResult<P extends GuardrailPhase, V, CanTransform extends boolean> = CanTransform extends false
  ? Extract<GuardrailOutcome<P, V>, { readonly decision: 'allow' | 'block' }>
  : GuardrailOutcome<P, V>

/** Callback used by an extracted guardrail action definition. */
export type GuardrailEvaluator<
  P extends GuardrailPhase = GuardrailPhase,
  V = GuardrailValue<P>,
  CanTransform extends boolean = true,
> = (
  context: GuardrailActionContext<P, V>,
) => ActionResult<P, V, CanTransform> | Promise<ActionResult<P, V, CanTransform>>

type ToolSelector<P extends GuardrailPhase, Tools extends GuardrailToolSelector | undefined> = P extends
  | 'tool_input'
  | 'tool_output'
  ? { readonly tools: Tools extends GuardrailToolSelector ? Tools : GuardrailToolSelector }
  : { readonly tools?: never }

type ModelSelector<Models extends GuardrailModelSelector | undefined> = Models extends GuardrailModelSelector
  ? { readonly models: Models }
  : { readonly models?: undefined }

type ValueSchemaField<S extends AnySchema | undefined> = S extends AnySchema
  ? { readonly valueSchema: S & JsonOutputSchema<S> }
  : { readonly valueSchema?: undefined }

type ActionDefinitionBase<
  P extends GuardrailPhase,
  S extends AnySchema | undefined,
  CanTransform extends boolean,
  Tools extends GuardrailToolSelector | undefined,
  Models extends GuardrailModelSelector | undefined,
> = ToolSelector<P, Tools> &
  ModelSelector<Models> &
  ValueSchemaField<S> & {
    readonly phase: P
    readonly timeoutMs?: number
    readonly mayTransform?: CanTransform
    readonly evaluate: GuardrailEvaluator<NoInfer<P>, ActionValue<P, S>, CanTransform>
  }

/**
 * Definition accepted only by `defineGuardrailAction`.
 *
 * The helper retains callbacks and schemas privately, leaving callers with an
 * immutable phase token instead of an executable structural object.
 */
export type GuardrailActionDefinition<
  P extends GuardrailPhase = GuardrailPhase,
  S extends AnySchema | undefined = undefined,
  CanTransform extends boolean = true,
> = ActionDefinitionBase<
  P,
  S,
  CanTransform,
  P extends 'tool_input' | 'tool_output' ? GuardrailToolSelector : undefined,
  GuardrailModelSelector | undefined
>

type NormalizedTools<
  P extends GuardrailPhase,
  Tools extends GuardrailToolSelector | undefined,
> = P extends 'tool_input' | 'tool_output' ? Extract<Tools, GuardrailToolSelector> : readonly []

type NormalizedModels<Models extends GuardrailModelSelector | undefined> = Models extends GuardrailModelSelector
  ? Models
  : readonly []

type ActionMetadata = Readonly<{
  valueSchema?: AnySchema
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
export function defineGuardrailAction<
  const P extends Exclude<GuardrailPhase, 'tool_input' | 'tool_output'>,
  const S extends AnySchema,
  const Models extends GuardrailModelSelector | undefined = undefined,
>(
  definition: ActionDefinitionBase<P, S, false, undefined, Models> & {
    readonly valueSchema: S & JsonOutputSchema<S>
    readonly mayTransform: false
  },
): GuardrailAction<P, readonly [], NormalizedModels<Models>>
export function defineGuardrailAction<
  const P extends 'tool_input' | 'tool_output',
  const S extends AnySchema,
  const Tools extends GuardrailToolSelector,
  const Models extends GuardrailModelSelector | undefined = undefined,
>(
  definition: ActionDefinitionBase<P, S, false, Tools, Models> & {
    readonly tools: Tools
    readonly valueSchema: S & JsonOutputSchema<S>
    readonly mayTransform: false
  },
): GuardrailAction<P, Tools, NormalizedModels<Models>>
export function defineGuardrailAction<
  const P extends Exclude<GuardrailPhase, 'tool_input' | 'tool_output'>,
  const S extends AnySchema,
  const Models extends GuardrailModelSelector | undefined = undefined,
>(
  definition: ActionDefinitionBase<P, S, true, undefined, Models> & {
    readonly valueSchema: S & JsonOutputSchema<S>
    readonly mayTransform?: true | undefined
  },
): GuardrailAction<P, readonly [], NormalizedModels<Models>>
export function defineGuardrailAction<
  const P extends 'tool_input' | 'tool_output',
  const S extends AnySchema,
  const Tools extends GuardrailToolSelector,
  const Models extends GuardrailModelSelector | undefined = undefined,
>(
  definition: ActionDefinitionBase<P, S, true, Tools, Models> & {
    readonly tools: Tools
    readonly valueSchema: S & JsonOutputSchema<S>
    readonly mayTransform?: true | undefined
  },
): GuardrailAction<P, Tools, NormalizedModels<Models>>
export function defineGuardrailAction<
  const P extends GuardrailPhase,
  const Tools extends GuardrailToolSelector | undefined = undefined,
  const Models extends GuardrailModelSelector | undefined = undefined,
>(
  definition: ActionDefinitionBase<P, undefined, false, Tools, Models> & {
    readonly valueSchema?: undefined
    readonly mayTransform: false
  },
): GuardrailAction<P, NormalizedTools<P, Tools>, NormalizedModels<Models>>
export function defineGuardrailAction<
  const P extends GuardrailPhase,
  const Tools extends GuardrailToolSelector | undefined = undefined,
  const Models extends GuardrailModelSelector | undefined = undefined,
>(
  definition: ActionDefinitionBase<P, undefined, true, Tools, Models> & {
    readonly valueSchema?: undefined
    readonly mayTransform?: true | undefined
  },
): GuardrailAction<P, NormalizedTools<P, Tools>, NormalizedModels<Models>>
export function defineGuardrailAction(definition: unknown): AnyGuardrailAction {
  return createGuardrailAction(definition)
}

/** Internal constructor used by addon-owned actions after their own validation. */
export function createGuardrailAction<
  P extends GuardrailPhase = GuardrailPhase,
  Tools extends readonly string[] = readonly [],
  Models extends readonly ModelAliasId[] = readonly [],
>(
  definition: unknown,
): GuardrailAction<P, Tools, Models> {
  const source = validateDefinition(definition)
  const token = Object.freeze({ phase: source.phase }) as GuardrailAction<P, Tools, Models>
  metadata.set(
    token,
    Object.freeze({
      ...(source.valueSchema ? { valueSchema: source.valueSchema } : {}),
      ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
      mayTransform: source.mayTransform !== false,
      ...(source.tools ? { tools: Object.freeze([...source.tools]) } : {}),
      models: Object.freeze([...(source.models ?? [])]),
      evaluate: source.evaluate as GuardrailEvaluator,
    }),
  )
  return token
}

export function isGuardrailAction(value: unknown): value is AnyGuardrailAction {
  return typeof value === 'object' && value !== null && metadata.has(value)
}

export function actionMetadata(action: AnyGuardrailAction): ActionMetadata | undefined {
  return metadata.get(action)
}

/** Prepares a schema-validated callback thunk without invoking application code. */
export async function prepareGuardrailAction(
  action: AnyGuardrailAction,
  protectedValue: JsonValue | readonly JsonValue[],
): Promise<((context: GuardrailActionContext) => ReturnType<GuardrailEvaluator>) | undefined> {
  const entry = metadata.get(action)
  if (!entry) return undefined
  const snapshot = snapshotJson(protectedValue)
  let value = freezeJson(snapshot)
  if (entry.valueSchema) {
    const parsed = await validateGuardrailValue(entry.valueSchema, snapshot)
    if (!parsed || !jsonEqual(parsed, snapshot)) return undefined
    value = freezeJson(snapshotJson(parsed))
  }
  return (context) => entry.evaluate({ ...context, phase: action.phase, value })
}

type RuntimeDefinition = Readonly<{
  phase: GuardrailPhase
  valueSchema?: AnySchema
  timeoutMs?: number
  mayTransform?: boolean
  tools?: readonly string[]
  models?: readonly string[]
  evaluate: GuardrailEvaluator
}>

function validateDefinition(definition: unknown): RuntimeDefinition {
  try {
    if (!definition || typeof definition !== 'object') throw invalidActionDefinition()
    const source = definition as Record<string, unknown>
    const fields = new Set(['phase', 'valueSchema', 'timeoutMs', 'mayTransform', 'evaluate', 'tools', 'models'])
    const ownKeys = Reflect.ownKeys(source)
    if (ownKeys.some((field) => typeof field !== 'string' || !fields.has(field)))
      throw invalidActionDefinition()
    const ownFields = new Set(ownKeys)
    if (!ownFields.has('phase')) throw invalidActionDefinition()
    if (!ownFields.has('evaluate')) throw invalidActionDefinition('invalid_action')
    const phaseValue = Reflect.get(source, 'phase')
    const evaluate = Reflect.get(source, 'evaluate')
    const valueSchema = ownFields.has('valueSchema') ? Reflect.get(source, 'valueSchema') : undefined
    const timeoutMs = ownFields.has('timeoutMs') ? Reflect.get(source, 'timeoutMs') : undefined
    const mayTransform = ownFields.has('mayTransform') ? Reflect.get(source, 'mayTransform') : undefined
    const toolSelector = ownFields.has('tools') ? Reflect.get(source, 'tools') : undefined
    const modelSelector = ownFields.has('models') ? Reflect.get(source, 'models') : undefined
    if (!['input', 'output', 'tool_input', 'tool_output', 'retrieval'].includes(phaseValue as GuardrailPhase))
      throw invalidActionDefinition()
    if (typeof evaluate !== 'function') throw invalidActionDefinition('invalid_action')
    if (mayTransform !== undefined && typeof mayTransform !== 'boolean')
      throw invalidActionDefinition()
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== 'number' ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0)
    )
      throw invalidActionDefinition()
    const phase = phaseValue as GuardrailPhase
    let tools: readonly string[] | undefined
    if (isToolPhase(phase)) {
      if (!Array.isArray(toolSelector)) throw invalidActionDefinition()
      const snapshot: unknown[] = [...toolSelector]
      if (snapshot.length === 0 || !uniqueStableIds(snapshot))
        throw invalidActionDefinition()
      tools = Object.freeze(snapshot as string[])
    } else if (toolSelector !== undefined) {
      throw invalidActionDefinition()
    }
    let models: readonly string[] | undefined
    if (modelSelector !== undefined) {
      if (!Array.isArray(modelSelector)) throw invalidActionDefinition()
      const snapshot: unknown[] = [...modelSelector]
      if (snapshot.length === 0 || !uniqueModelAliases(snapshot)) throw invalidActionDefinition()
      models = Object.freeze(snapshot as string[])
    }
    if (valueSchema !== undefined && !isSchema(valueSchema)) throw invalidActionDefinition()
    return Object.freeze({
      phase,
      evaluate: evaluate as GuardrailEvaluator,
      ...(valueSchema === undefined ? {} : { valueSchema }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(mayTransform === undefined ? {} : { mayTransform }),
      ...(tools === undefined ? {} : { tools }),
      ...(models === undefined ? {} : { models }),
    })
  } catch (error) {
    if (error instanceof GuardrailsConfigError) throw error
    throw invalidActionDefinition()
  }
}

function invalidActionDefinition(reason: 'invalid_shape' | 'invalid_action' = 'invalid_shape'): GuardrailsConfigError {
  return new GuardrailsConfigError({ reason, field: 'action' })
}

function isSchema(value: unknown): value is AnySchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    '~standard' in value &&
    typeof (value as { '~standard'?: { validate?: unknown } })['~standard']?.validate === 'function'
  )
}

/**
 * Validates one rail value through Standard Schema exactly once.
 *
 * Guardrail validation is deliberately fail-closed and content-free: validators
 * may be asynchronous, while their issues and exceptions never cross this
 * private boundary. Rails additionally reject transformations because a rail
 * schema is a shape assertion, not an implicit content rewriter.
 */
export async function validateGuardrailValue(schema: AnySchema, candidate: unknown): Promise<JsonValue | undefined> {
  try {
    const result = await schema['~standard'].validate(candidate)
    if ('issues' in result && Array.isArray(result.issues) && result.issues.length > 0) return undefined
    const value = 'value' in result ? result.value : undefined
    return isJsonValue(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isToolPhase(phase: GuardrailPhase): phase is 'tool_input' | 'tool_output' {
  return phase === 'tool_input' || phase === 'tool_output'
}

function uniqueStableIds(values: readonly unknown[]): boolean {
  const ids = new Set<string>()
  return values.every(
    (value) =>
      typeof value === 'string' &&
      /^[a-z][A-Za-z0-9]{0,63}$/.test(value) &&
      !ids.has(value) &&
      (ids.add(value), true),
  )
}

function uniqueModelAliases(values: readonly unknown[]): boolean {
  const aliases = new Set<string>()
  return values.every(
    (value) =>
      typeof value === 'string' &&
      /^[a-z][A-Za-z0-9]{0,63}$/.test(value) &&
      !aliases.has(value) &&
      (aliases.add(value), true),
  )
}

function jsonEqual(left: JsonValue, right: JsonValue | readonly JsonValue[]): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]!))
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) ||
    Array.isArray(right)
  )
    return false
  const leftRecord = left as Record<string, JsonValue>
  const rightRecord = right as Record<string, JsonValue>
  const keys = Object.keys(leftRecord)
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every((key) => Object.hasOwn(rightRecord, key) && jsonEqual(leftRecord[key]!, rightRecord[key]!))
  )
}

function snapshotJson(value: JsonValue | readonly JsonValue[]): JsonValue {
  if (Array.isArray(value)) return value.map((item) => snapshotJson(item))
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotJson(item)]))
  return value
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) value.forEach(freezeJson)
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(freezeJson)
  return Object.freeze(value)
}
