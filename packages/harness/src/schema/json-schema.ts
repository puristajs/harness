import { HarnessConfigError } from '../errors/index.js'
import type { JsonValue } from '../models/json.js'
import type { ModelSchema } from './index.js'

export type ModelSchemaBoundary = 'agent_output' | 'tool_input'

/**
 * Projects a model-facing Standard Schema once during Harness build.
 *
 * The Harness requests the input direction because the model produces a value
 * consumed by the validator. The owned result is cloned and recursively frozen
 * before a provider can observe it.
 */
export function projectModelSchema<S extends ModelSchema<any, any>>(
  schema: S,
  boundary: ModelSchemaBoundary,
  id: string
): JsonValue {
  let jsonSchema: S['~standard']['jsonSchema']
  try {
    jsonSchema = schema['~standard'].jsonSchema
  } catch (error) {
    throw projectionError('schema_json_projection_failed', boundary, id, error)
  }
  if (!jsonSchema) {
    throw projectionError('schema_json_projection_missing', boundary, id)
  }

  let input: typeof jsonSchema.input
  try {
    input = jsonSchema.input
  } catch (error) {
    throw projectionError('schema_json_projection_failed', boundary, id, error)
  }
  if (typeof input !== 'function') throw projectionError('schema_json_projection_missing', boundary, id)

  let projected: unknown
  try {
    projected = input({ target: 'draft-2020-12' })
  } catch (error) {
    throw projectionError('schema_json_projection_failed', boundary, id, error)
  }
  let owned: JsonValue | undefined
  try {
    owned = cloneProjectedJson(projected)
  } catch {
    throw projectionError('schema_json_projection_invalid', boundary, id)
  }
  if (owned === undefined) throw projectionError('schema_json_projection_invalid', boundary, id)
  return freezeJson(owned)
}

function projectionError(
  reason: 'schema_json_projection_missing' | 'schema_json_projection_failed' | 'schema_json_projection_invalid',
  schemaBoundary: ModelSchemaBoundary,
  id: string,
  cause?: unknown
): HarnessConfigError {
  return new HarnessConfigError('Model schema projection failed.', {
    reason,
    schemaBoundary,
    id,
    schemaTarget: 'draft-2020-12'
  }, cause)
}

/**
 * Owns the vendor projection without observing or retaining non-enumerable
 * Standard-Schema branding. Zod attaches that brand to its generated object;
 * it is not JSON data and must never enter a model-provider request.
 */
function cloneProjectedJson(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'object') return undefined

  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const clone: JsonValue[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined
      const child = cloneProjectedJson(descriptor.value)
      if (child === undefined) return undefined
      clone.push(child)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue
      if (typeof key === 'symbol') return undefined
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined
    }
    return clone
  }
  if (prototype !== Object.prototype && prototype !== null) return undefined

  const clone: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) return undefined
    // Non-enumerable Standard Schema brands are implementation metadata, not
    // part of the projected JSON document.
    if (!descriptor.enumerable) continue
    if (!('value' in descriptor)) return undefined
    const child = cloneProjectedJson(descriptor.value)
    if (child === undefined) return undefined
    clone[key] = child
  }
  return clone
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}
