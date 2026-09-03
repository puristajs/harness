/**
 * Canonical JSON value type used across harness ports and persistence models.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * Returns whether a value is representable as strict JSON.
 *
 * Unlike `JSON.stringify`, this rejects cycles, sparse arrays, non-finite
 * numbers, accessor properties, symbol keys, and objects with custom
 * prototypes. It never serializes the candidate, so callers can use it at
 * privacy-sensitive boundaries without risking content in an error message.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInner(value, new Set<object>())
}

function isJsonValueInner(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false

  if (ancestors.has(value)) return false
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return isJsonArray(value, ancestors)
    return isJsonObject(value, ancestors)
  } catch {
    return false
  } finally {
    ancestors.delete(value)
  }
}

function isJsonArray(value: unknown[], ancestors: Set<object>): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') return false
    if (key === 'length') continue
    if (!isArrayIndex(key, value.length)) return false
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || !isJsonValueInner(descriptor.value, ancestors)) return false
  }
  return Object.keys(descriptors).filter((key) => key !== 'length').length === value.length
}

function isJsonObject(value: object, ancestors: Set<object>): boolean {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') return false
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor) || !isJsonValueInner(descriptor.value, ancestors)) return false
  }
  return true
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length
}
