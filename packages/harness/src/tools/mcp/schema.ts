import { ValidationError } from '../../errors/index.js'
import { isJsonValue, type JsonValue } from '../../models/json.js'

export type McpSchemaValidationWhere = 'mcp_input' | 'mcp_output'

export interface McpSchemaWarning {
  toolId: string
  keyword: string
  path: string
  message: string
}

export interface ValidateMcpJsonSchemaOptions {
  toolId: string
  where: McpSchemaValidationWhere
  schema: unknown
  value: unknown
  warn?: (warning: McpSchemaWarning) => void
}

interface Issue {
  path: string
  message: string
  keyword?: string
}

const supportedKeywords = new Set([
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'enum',
  'format',
  'items',
  'maximum',
  'maxItems',
  'maxLength',
  'minimum',
  'minItems',
  'minLength',
  'not',
  'oneOf',
  'pattern',
  'properties',
  'required',
  'type'
])

const supportedFormats = new Set(['uri', 'email', 'date-time', 'uuid'])
const warned = new Set<string>()

export function validateMcpJsonSchema(opts: ValidateMcpJsonSchemaOptions): JsonValue {
  const schemaIssues = validateSchemaShape(opts.schema, '')
  if (schemaIssues.length > 0) {
    throw new ValidationError('MCP JSON Schema is malformed.', { where: opts.where, issues: schemaIssues })
  }

  warnUnsupportedKeywords(opts.toolId, opts.schema, '', opts.warn)

  const issues = validateValue(opts.schema as JsonSchema, opts.value, '')
  if (issues.length > 0) {
    throw new ValidationError('MCP JSON Schema validation failed.', { where: opts.where, issues })
  }
  if (!isJsonValue(opts.value)) {
    throw new ValidationError('MCP value is not JSON serializable.', { where: opts.where, issues: [{ path: '', message: 'Value must be JSON serializable.' }] })
  }
  return opts.value
}

export function assertMcpJsonSchema(toolId: string, schema: unknown, where: McpSchemaValidationWhere, warn?: (warning: McpSchemaWarning) => void): asserts schema is JsonSchema {
  const issues = validateSchemaShape(schema, '')
  if (issues.length > 0) throw new ValidationError('MCP JSON Schema is malformed.', { where, issues })
  warnUnsupportedKeywords(toolId, schema, '', warn)
}

type JsonSchema = {
  [key: string]: unknown
  $schema?: unknown
  additionalProperties?: unknown
  allOf?: unknown
  anyOf?: unknown
  const?: unknown
  enum?: unknown
  format?: unknown
  items?: unknown
  maximum?: unknown
  maxItems?: unknown
  maxLength?: unknown
  minimum?: unknown
  minItems?: unknown
  minLength?: unknown
  not?: unknown
  oneOf?: unknown
  pattern?: unknown
  properties?: unknown
  required?: unknown
  type?: unknown
}

function validateSchemaShape(schema: unknown, pointer: string): Issue[] {
  if (!isRecord(schema)) return [{ path: pointer, message: 'Schema must be an object.' }]
  const issues: Issue[] = []
  if ('type' in schema && !isValidType(schema.type)) issues.push({ path: pointerJoin(pointer, 'type'), message: 'Schema type must be a string or string array.', keyword: 'type' })
  if ('properties' in schema && !isRecord(schema.properties)) issues.push({ path: pointerJoin(pointer, 'properties'), message: 'properties must be an object.', keyword: 'properties' })
  if ('required' in schema && (!Array.isArray(schema.required) || !schema.required.every((value) => typeof value === 'string'))) issues.push({ path: pointerJoin(pointer, 'required'), message: 'required must be an array of strings.', keyword: 'required' })
  if ('enum' in schema && !Array.isArray(schema.enum)) issues.push({ path: pointerJoin(pointer, 'enum'), message: 'enum must be an array.', keyword: 'enum' })
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (key in schema && (!Array.isArray(schema[key]) || !(schema[key] as unknown[]).every(isRecord))) issues.push({ path: pointerJoin(pointer, key), message: `${key} must be an array of schemas.`, keyword: key })
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (key in schema && typeof schema[key] !== 'number') issues.push({ path: pointerJoin(pointer, key), message: `${key} must be a number.`, keyword: key })
  }
  if ('pattern' in schema && typeof schema.pattern !== 'string') issues.push({ path: pointerJoin(pointer, 'pattern'), message: 'pattern must be a string.', keyword: 'pattern' })
  if ('format' in schema && typeof schema.format !== 'string') issues.push({ path: pointerJoin(pointer, 'format'), message: 'format must be a string.', keyword: 'format' })
  if ('additionalProperties' in schema && typeof schema.additionalProperties !== 'boolean' && !isRecord(schema.additionalProperties)) {
    issues.push({ path: pointerJoin(pointer, 'additionalProperties'), message: 'additionalProperties must be a boolean or schema.', keyword: 'additionalProperties' })
  }

  if (isRecord(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties)) issues.push(...validateSchemaShape(child, pointerJoin(pointerJoin(pointer, 'properties'), name)))
  }
  if (isRecord(schema.items)) issues.push(...validateSchemaShape(schema.items, pointerJoin(pointer, 'items')))
  if (isRecord(schema.not)) issues.push(...validateSchemaShape(schema.not, pointerJoin(pointer, 'not')))
  if (isRecord(schema.additionalProperties)) issues.push(...validateSchemaShape(schema.additionalProperties, pointerJoin(pointer, 'additionalProperties')))
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(schema[key])) {
      ;(schema[key] as unknown[]).forEach((child, index) => {
        issues.push(...validateSchemaShape(child, pointerJoin(pointerJoin(pointer, key), String(index))))
      })
    }
  }
  return issues
}

function validateValue(schema: JsonSchema, value: unknown, path: string): Issue[] {
  const issues: Issue[] = []

  if ('type' in schema && !matchesType(schema.type, value)) {
    issues.push({ path, message: `Value must match type ${JSON.stringify(schema.type)}.`, keyword: 'type' })
    return issues
  }

  if ('const' in schema && !deepEqual(value, schema.const)) issues.push({ path, message: 'Value must equal const.', keyword: 'const' })
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) issues.push({ path, message: 'Value must match one enum value.', keyword: 'enum' })

  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) issues.push(...validateValue(child as JsonSchema, value, path))
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((child) => validateValue(child as JsonSchema, value, path).length === 0)) issues.push({ path, message: 'Value must match at least one anyOf schema.', keyword: 'anyOf' })
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((child) => validateValue(child as JsonSchema, value, path).length === 0).length !== 1) issues.push({ path, message: 'Value must match exactly one oneOf schema.', keyword: 'oneOf' })
  if (isRecord(schema.not) && validateValue(schema.not, value, path).length === 0) issues.push({ path, message: 'Value must not match schema.', keyword: 'not' })

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push({ path, message: `Value must be >= minimum ${schema.minimum}.`, keyword: 'minimum' })
    if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push({ path, message: `Value must be <= maximum ${schema.maximum}.`, keyword: 'maximum' })
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push({ path, message: `Value length must be >= minLength ${schema.minLength}.`, keyword: 'minLength' })
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push({ path, message: `Value length must be <= maxLength ${schema.maxLength}.`, keyword: 'maxLength' })
    if (typeof schema.pattern === 'string' && !(new RegExp(schema.pattern).test(value))) issues.push({ path, message: 'Value must match pattern.', keyword: 'pattern' })
    if (typeof schema.format === 'string' && supportedFormats.has(schema.format) && !matchesFormat(schema.format, value)) issues.push({ path, message: `Value must match ${schema.format} format.`, keyword: 'format' })
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) issues.push({ path, message: `Array length must be >= minItems ${schema.minItems}.`, keyword: 'minItems' })
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) issues.push({ path, message: `Array length must be <= maxItems ${schema.maxItems}.`, keyword: 'maxItems' })
    if (isRecord(schema.items)) value.forEach((item, index) => issues.push(...validateValue(schema.items as JsonSchema, item, pointerJoin(path, String(index)))))
  }
  if (isPlainObject(value)) validateObject(schema, value, path, issues)
  return issues
}

function validateObject(schema: JsonSchema, value: Record<string, unknown>, path: string, issues: Issue[]): void {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  if (Array.isArray(schema.required)) {
    for (const required of schema.required) {
      if (!(required in value)) issues.push({ path: pointerJoin(path, required), message: 'Required property is missing.', keyword: 'required' })
    }
  }
  for (const [name, child] of Object.entries(properties)) {
    if (name in value) issues.push(...validateValue(child as JsonSchema, value[name], pointerJoin(path, name)))
  }
  for (const key of Object.keys(value)) {
    if (key in properties) continue
    if (schema.additionalProperties === false) issues.push({ path: pointerJoin(path, key), message: 'Unknown property is not allowed.', keyword: 'additionalProperties' })
    if (isRecord(schema.additionalProperties)) issues.push(...validateValue(schema.additionalProperties, value[key], pointerJoin(path, key)))
  }
}

function warnUnsupportedKeywords(toolId: string, schema: unknown, pointer: string, warn: ((warning: McpSchemaWarning) => void) | undefined): void {
  if (!isRecord(schema)) return
  for (const [key, value] of Object.entries(schema)) {
    if (!supportedKeywords.has(key)) emitWarning(toolId, key, pointerJoin(pointer, key), warn)
    if (key === 'format' && typeof value === 'string' && !supportedFormats.has(value)) emitWarning(toolId, `format:${value}`, pointerJoin(pointer, key), warn)
  }
  if (isRecord(schema.properties)) for (const [name, child] of Object.entries(schema.properties)) warnUnsupportedKeywords(toolId, child, pointerJoin(pointerJoin(pointer, 'properties'), name), warn)
  if (isRecord(schema.items)) warnUnsupportedKeywords(toolId, schema.items, pointerJoin(pointer, 'items'), warn)
  if (isRecord(schema.not)) warnUnsupportedKeywords(toolId, schema.not, pointerJoin(pointer, 'not'), warn)
  if (isRecord(schema.additionalProperties)) warnUnsupportedKeywords(toolId, schema.additionalProperties, pointerJoin(pointer, 'additionalProperties'), warn)
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(schema[key])) (schema[key] as unknown[]).forEach((child, index) => warnUnsupportedKeywords(toolId, child, pointerJoin(pointerJoin(pointer, key), String(index)), warn))
  }
}

function emitWarning(toolId: string, keyword: string, path: string, warn: ((warning: McpSchemaWarning) => void) | undefined): void {
  const key = `${toolId}\0${keyword}\0${path}`
  if (warned.has(key)) return
  warned.add(key)
  warn?.({ toolId, keyword, path, message: `Unsupported MCP JSON Schema keyword ${keyword} at ${path}.` })
}

function isValidType(value: unknown): boolean {
  const valid = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  return typeof value === 'string' ? valid.has(value) : Array.isArray(value) && value.every((item) => typeof item === 'string' && valid.has(item))
}

function matchesType(type: unknown, value: unknown): boolean {
  if (Array.isArray(type)) return type.some((item) => matchesType(item, value))
  switch (type) {
    case 'object': return isPlainObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true
  }
}

function matchesFormat(format: string, value: string): boolean {
  if (format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  if (format === 'uri') {
    try { new URL(value); return true } catch { return false }
  }
  if (format === 'date-time') return !Number.isNaN(Date.parse(value))
  if (format === 'uuid') return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  return true
}

function pointerJoin(base: string, key: string): string {
  return `${base}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`
}

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
