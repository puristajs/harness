import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import YAML from 'yaml'
import type { JsonValue } from '@purista/harness'
import { GuardrailsConfigError, type GuardrailPhase } from './errors.js'

export interface NeMoModelConfig {
  type: string
  engine?: string
  model?: string
  parameters?: JsonValue
}

export interface NeMoRailConfig {
  flows: readonly string[]
}

/** Strict portable policy for one sensitive-data rail phase. */
export interface NeMoSensitiveDataPolicy {
  readonly entities: readonly string[]
  readonly maskToken: string
  readonly scoreThreshold: number
}

/** The supported NeMo-shaped sensitive-data configuration subset. */
export interface NeMoSensitiveDataDetectionConfig {
  readonly input?: NeMoSensitiveDataPolicy
  readonly output?: NeMoSensitiveDataPolicy
  readonly retrieval?: NeMoSensitiveDataPolicy
}

export interface NeMoGuardrailsRuntimeConfig {
  readonly sensitiveDataDetection?: NeMoSensitiveDataDetectionConfig
}

export type NeMoRailsConfig = Readonly<Partial<Record<GuardrailPhase, NeMoRailConfig>>> & {
  readonly config?: NeMoGuardrailsRuntimeConfig
}

/** Portable YAML subset accepted from a NeMo Guardrails config directory. */
export interface NeMoGuardrailsConfig {
  models: readonly NeMoModelConfig[]
  rails: NeMoRailsConfig
  instructions?: readonly string[]
  prompts?: JsonValue
  customData?: JsonValue
  sourcePath?: string
}

const SUPPORTED_RAILS = new Set<GuardrailPhase>(['input', 'output', 'tool_input', 'tool_output', 'retrieval'])
const UNSUPPORTED_EXECUTABLE_FILES = new Set(['actions.py', 'config.py'])

/** Loads `config.yml` or `config.yaml` from a NeMo-shaped config file or directory. */
export async function loadGuardrailsConfig(path: string): Promise<NeMoGuardrailsConfig> {
  const absolute = resolve(path)
  const entry = await stat(absolute).catch((error: unknown) => {
    throw new GuardrailsConfigError('Guardrails configuration path does not exist.', { reason: 'path_missing', path: absolute }, error)
  })
  const configPath = entry.isDirectory()
    ? await findConfigFile(absolute)
    : absolute
  if (!['.yml', '.yaml'].includes(extname(configPath))) {
    throw new GuardrailsConfigError('Guardrails configuration must be YAML.', { reason: 'invalid_extension', path: configPath })
  }
  await rejectUnsupportedExecutableFiles(dirname(configPath))
  const source = await readFile(configPath, 'utf8')
  let parsed: unknown
  try {
    parsed = YAML.parse(source)
  } catch (error) {
    throw new GuardrailsConfigError('Guardrails YAML could not be parsed.', { reason: 'yaml_parse_failed', path: configPath }, error)
  }
  return parseGuardrailsConfig(parsed, configPath)
}

/** Parses an already-loaded NeMo-shaped YAML value without touching the filesystem. */
export function parseGuardrailsConfig(value: unknown, sourcePath?: string): NeMoGuardrailsConfig {
  const root = object(value, 'root', sourcePath)
  const railsSource = root['rails'] === undefined ? {} : object(root['rails'], 'rails', sourcePath)
  const rails: Partial<Record<GuardrailPhase, NeMoRailConfig>> = {}
  let runtimeConfig: NeMoGuardrailsRuntimeConfig | undefined
  for (const [key, rail] of Object.entries(railsSource)) {
    if (key === 'config') {
      runtimeConfig = parseRuntimeConfig(rail, sourcePath)
      continue
    }
    if (key === 'dialog' || key === 'execution') {
      throw new GuardrailsConfigError('This NeMo rail category requires a runtime that is not included in the first TypeScript release.', { reason: 'unsupported_rail_category', field: `rails.${key}`, path: sourcePath })
    }
    if (!SUPPORTED_RAILS.has(key as GuardrailPhase)) {
      throw new GuardrailsConfigError('Unknown guardrails rail category.', { reason: 'unknown_rail_category', field: `rails.${key}`, path: sourcePath })
    }
    const railObject = object(rail, `rails.${key}`, sourcePath)
    rails[key as GuardrailPhase] = { flows: strings(railObject['flows'], `rails.${key}.flows`, sourcePath) }
  }
  validateSensitiveDataFlows(rails, runtimeConfig?.sensitiveDataDetection, sourcePath)
  const models = root['models'] === undefined ? [] : array(root['models'], 'models', sourcePath).map((model, index) => {
    const item = object(model, `models[${index}]`, sourcePath)
    return {
      type: string(item['type'], `models[${index}].type`, sourcePath),
      ...(item['engine'] === undefined ? {} : { engine: string(item['engine'], `models[${index}].engine`, sourcePath) }),
      ...(item['model'] === undefined ? {} : { model: string(item['model'], `models[${index}].model`, sourcePath) }),
      ...(item['parameters'] === undefined ? {} : { parameters: json(item['parameters'], `models[${index}].parameters`, sourcePath) })
    }
  })
  return {
    models,
    rails: { ...rails, ...(runtimeConfig ? { config: runtimeConfig } : {}) },
    ...(root['instructions'] === undefined ? {} : { instructions: strings(root['instructions'], 'instructions', sourcePath) }),
    ...(root['prompts'] === undefined ? {} : { prompts: json(root['prompts'], 'prompts', sourcePath) }),
    ...(root['custom_data'] === undefined ? {} : { customData: json(root['custom_data'], 'custom_data', sourcePath) }),
    ...(sourcePath ? { sourcePath } : {})
  }
}

function parseRuntimeConfig(value: unknown, path?: string): NeMoGuardrailsRuntimeConfig {
  const config = object(value, 'rails.config', path)
  rejectUnknownKeys(config, new Set(['sensitive_data_detection']), 'rails.config', path)
  if (config['sensitive_data_detection'] === undefined) return {}
  const source = object(config['sensitive_data_detection'], 'rails.config.sensitive_data_detection', path)
  rejectUnknownKeys(source, new Set(['input', 'output', 'retrieval']), 'rails.config.sensitive_data_detection', path)
  const parsed: { input?: NeMoSensitiveDataPolicy; output?: NeMoSensitiveDataPolicy; retrieval?: NeMoSensitiveDataPolicy } = {}
  for (const phase of ['input', 'output', 'retrieval'] as const) {
    if (source[phase] !== undefined) parsed[phase] = parseSensitiveDataPolicy(source[phase], `rails.config.sensitive_data_detection.${phase}`, path)
  }
  return { sensitiveDataDetection: parsed }
}

function parseSensitiveDataPolicy(value: unknown, field: string, path?: string): NeMoSensitiveDataPolicy {
  const policy = object(value, field, path)
  rejectUnknownKeys(policy, new Set(['entities', 'mask_token', 'score_threshold']), field, path)
  const entities = array(policy['entities'], `${field}.entities`, path).map((item, index) => {
    const entity = string(item, `${field}.entities[${index}]`, path)
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(entity)) throw new GuardrailsConfigError('Sensitive-data entity identifiers must be uppercase ASCII identifiers.', { reason: 'invalid_shape', field: `${field}.entities[${index}]`, path })
    return entity
  })
  if (entities.length === 0 || new Set(entities).size !== entities.length) throw new GuardrailsConfigError('Sensitive-data entities must be a non-empty unique list.', { reason: 'invalid_shape', field: `${field}.entities`, path })
  const maskToken = string(policy['mask_token'], `${field}.mask_token`, path)
  if (maskToken.length > 128) throw new GuardrailsConfigError('Sensitive-data mask_token must be at most 128 UTF-16 code units.', { reason: 'invalid_shape', field: `${field}.mask_token`, path })
  const scoreThreshold = policy['score_threshold']
  if (typeof scoreThreshold !== 'number' || !Number.isFinite(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 1) {
    throw new GuardrailsConfigError('Sensitive-data score_threshold must be a finite number between zero and one.', { reason: 'invalid_shape', field: `${field}.score_threshold`, path })
  }
  return { entities, maskToken, scoreThreshold }
}

function validateSensitiveDataFlows(rails: Partial<Record<GuardrailPhase, NeMoRailConfig>>, config: NeMoSensitiveDataDetectionConfig | undefined, path?: string): void {
  const expected = new Map<string, 'input' | 'output' | 'retrieval'>([
    ['detect sensitive data on input', 'input'],
    ['mask sensitive data on input', 'input'],
    ['detect sensitive data on output', 'output'],
    ['mask sensitive data on output', 'output'],
    ['detect sensitive data on retrieval', 'retrieval'],
    ['mask sensitive data on retrieval', 'retrieval']
  ])
  for (const [phase, rail] of Object.entries(rails) as [GuardrailPhase, NeMoRailConfig][]) {
    for (const flow of rail.flows) {
      const expectedPhase = expected.get(flow)
      if (!expectedPhase) continue
      if (phase !== expectedPhase || !config?.[expectedPhase]) {
        throw new GuardrailsConfigError('A sensitive-data flow requires the matching sensitive_data_detection policy.', { reason: 'invalid_shape', field: `rails.${phase}.flows`, path })
      }
    }
  }
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string, path?: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new GuardrailsConfigError('Unknown guardrails configuration field.', { reason: 'invalid_shape', field: `${field}.${key}`, path })
  }
}

async function findConfigFile(directory: string): Promise<string> {
  const entries = await readdir(directory)
  const candidates = entries.filter((entry) => entry === 'config.yml' || entry === 'config.yaml')
  if (candidates.length !== 1) {
    throw new GuardrailsConfigError('A config directory must contain exactly one config.yml or config.yaml file.', { reason: 'config_file_missing_or_ambiguous', path: directory })
  }
  return join(directory, candidates[0]!)
}

async function rejectUnsupportedExecutableFiles(directory: string): Promise<void> {
  const entries = await readdir(directory)
  const blocked = entries.find((entry) => UNSUPPORTED_EXECUTABLE_FILES.has(entry) || entry.endsWith('.co'))
  if (blocked) {
    throw new GuardrailsConfigError('Python actions and Colang files are not executable in this TypeScript package.', { reason: 'unsupported_executable_config', path: join(directory, blocked) })
  }
}

function object(value: unknown, field: string, path?: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GuardrailsConfigError('Expected a mapping in guardrails configuration.', { reason: 'invalid_shape', field, path })
  return value as Record<string, unknown>
}

function array(value: unknown, field: string, path?: string): unknown[] {
  if (!Array.isArray(value)) throw new GuardrailsConfigError('Expected an array in guardrails configuration.', { reason: 'invalid_shape', field, path })
  return value
}

function string(value: unknown, field: string, path?: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new GuardrailsConfigError('Expected a non-empty string in guardrails configuration.', { reason: 'invalid_shape', field, path })
  return value
}

function strings(value: unknown, field: string, path?: string): readonly string[] {
  return array(value, field, path).map((item, index) => string(item, `${field}[${index}]`, path))
}

function json(value: unknown, field: string, path?: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${field}[${index}]`, path))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, `${field}.${key}`, path)]))
  }
  throw new GuardrailsConfigError('Expected a JSON-compatible configuration value.', { reason: 'invalid_shape', field, path })
}
