import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { SensitiveDataDetectorError, type SensitiveDataDetector, type SensitiveDataFinding, type SensitiveDataInspectionRequest } from '@purista/harness-guardrails'

/** Maximum accepted local-NER input size in UTF-16 code units. */
export const LOCAL_NER_MAX_TEXT_LENGTH = 65_536

/** Content-free local NER failure categories safe for observability. */
export type LocalNerDetectorErrorKind = 'missing_optional_dependency' | 'invalid_configuration' | 'invalid_request' | 'model_integrity_failed' | 'model_load_failed' | 'invalid_result' | 'aborted'

/** A content-free operational error from the optional local NER detector. */
export class LocalNerDetectorError extends SensitiveDataDetectorError {
  public declare readonly kind: LocalNerDetectorErrorKind

  /**
   * @param kind Stable safe error classification.
   * @example
   * if (error instanceof LocalNerDetectorError && error.kind === 'missing_optional_dependency') console.error(error.message)
   */
  public constructor(kind: LocalNerDetectorErrorKind) {
    super(kind, messageFor(kind))
    this.name = 'LocalNerDetectorError'
  }
}

/** Aggregate token classification output required from the local runtime. */
export interface LocalNerToken {
  readonly entity_group?: string
  readonly entity?: string
  readonly score?: number
  readonly start?: number
  readonly end?: number
}

/** Testable narrow runtime boundary implemented by Transformers.js. */
export interface LocalNerRuntime {
  createTokenClassificationPipeline(modelPath: string, options: { readonly localFilesOnly: true; readonly aggregationStrategy: 'simple' }): Promise<(text: string) => Promise<readonly LocalNerToken[]> | readonly LocalNerToken[]>
}

/** One application-owned, SHA-256-pinned model file required by the selected local model. */
export interface LocalNerModelFile {
  /** Relative path below `modelPath`; traversal, absolute paths, and symlink escapes are rejected. */
  readonly path: string
  /** Lower-case SHA-256 digest of the exact provisioned file. */
  readonly sha256: string
}

/** Application configuration for an explicitly provisioned, local-only NER model. */
export interface LocalNerDetectorOptions {
  /** Stable content-free detector identifier used by Guardrails telemetry. */
  readonly id: string
  /** Stable local deployment model identifier; it must not be a remote repository id or URL. */
  readonly modelId: string
  /** Absolute filesystem directory containing the already provisioned model artifacts. */
  readonly modelPath: string
  /** SHA-256 manifest of every model asset required by the selected local model. */
  readonly modelFiles: readonly LocalNerModelFile[]
  /** Explicit mapping from aggregate model labels to portable entity categories. */
  readonly labels: Readonly<Record<string, string>>
}

/** A local-only NER detector with an explicit startup warmup operation. */
export interface LocalNerDetector extends SensitiveDataDetector {
  readonly modelId: string
  /** Loads and validates the local model before traffic is accepted. */
  warmup(signal?: AbortSignal): Promise<void>
}

type LocalNerRuntimeLoader = () => Promise<LocalNerRuntime>
type ValidatedOptions = Omit<LocalNerDetectorOptions, 'labels' | 'modelFiles'> & { readonly labels: ReadonlyMap<string, string>; readonly modelFiles: readonly LocalNerModelFile[]; readonly supportedEntities: readonly string[] }
const require = createRequire(import.meta.url)

/**
 * Creates a local-only NER detector backed by the optional Transformers.js peer.
 * Install `@huggingface/transformers` and provision model files locally before use.
 *
 * @example
 * const detector = createLocalNerDetector({ id: 'ner-en', modelId: 'ner-en-v1', modelPath: '/opt/models/ner-en-v1', modelFiles: [{ path: 'model.onnx', sha256: '<sha256>' }], labels: { PER: 'PERSON' } })
 * await detector.warmup()
 */
export function createLocalNerDetector(options: LocalNerDetectorOptions): LocalNerDetector {
  return createLocalNerDetectorWithRuntime(options, loadTransformersJsRuntime)
}

/** @internal Test-only construction seam; export it only from the `./testing` subpath. */
export function createLocalNerDetectorWithRuntime(options: LocalNerDetectorOptions, runtimeLoader: LocalNerRuntimeLoader): LocalNerDetector {
  const validated = validateOptions(options)
  let pipelinePromise: Promise<(text: string) => Promise<readonly LocalNerToken[]> | readonly LocalNerToken[]> | undefined

  const loadPipeline = async (signal?: AbortSignal) => {
    throwIfAborted(signal)
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        await validateModelDirectory(validated.modelPath, validated.modelFiles)
        const runtime = await runtimeLoader()
        try {
          const pipeline = await runtime.createTokenClassificationPipeline(validated.modelPath, { localFilesOnly: true, aggregationStrategy: 'simple' })
          if (typeof pipeline !== 'function') throw new LocalNerDetectorError('model_load_failed')
          return pipeline
        } catch (error) {
          if (error instanceof LocalNerDetectorError) throw error
          throw new LocalNerDetectorError('model_load_failed')
        }
      })()
    }
    return abortable(pipelinePromise, signal)
  }

  return {
    id: validated.id,
    modelId: validated.modelId,
    executionMode: 'local',
    supportedEntities: validated.supportedEntities,
    async warmup(signal?: AbortSignal): Promise<void> {
      await loadPipeline(signal)
    },
    async inspect(request: SensitiveDataInspectionRequest): Promise<{ findings: readonly SensitiveDataFinding[] }> {
      throwIfAborted(request.signal)
      if (request.text.length > LOCAL_NER_MAX_TEXT_LENGTH) throw new LocalNerDetectorError('invalid_request')
      const pipeline = await loadPipeline(request.signal)
      throwIfAborted(request.signal)
      let tokens: readonly LocalNerToken[]
      try {
        tokens = await abortable(Promise.resolve(pipeline(request.text)), request.signal)
      } catch (error) {
        if (error instanceof LocalNerDetectorError) throw error
        throw new LocalNerDetectorError(request.signal.aborted ? 'aborted' : 'model_load_failed')
      }
      throwIfAborted(request.signal)
      return { findings: decodeTokens(tokens, request, validated.labels) }
    }
  }
}

async function loadTransformersJsRuntime(): Promise<LocalNerRuntime> {
  const moduleId = '@huggingface/transformers'
  try {
    require.resolve(moduleId)
  } catch {
    throw new LocalNerDetectorError('missing_optional_dependency')
  }
  let imported: { pipeline?: unknown }
  try {
    imported = await import(moduleId) as { pipeline?: unknown }
  } catch (error) {
    if (moduleNotFound(error)) throw new LocalNerDetectorError('missing_optional_dependency')
    throw new LocalNerDetectorError('model_load_failed')
  }
  if (typeof imported.pipeline !== 'function') throw new LocalNerDetectorError('model_load_failed')
  const pipeline = imported.pipeline as (task: string, model: string, options: Record<string, string | boolean>) => Promise<unknown>
  return {
    async createTokenClassificationPipeline(modelPath, options) {
      const created = await pipeline('token-classification', modelPath, {
        local_files_only: options.localFilesOnly,
        aggregation_strategy: options.aggregationStrategy
      })
      if (typeof created !== 'function') throw new LocalNerDetectorError('model_load_failed')
      return async (text) => {
        const output = await (created as (value: string) => Promise<unknown> | unknown)(text)
        if (!Array.isArray(output)) throw new LocalNerDetectorError('invalid_result')
        return output as readonly LocalNerToken[]
      }
    }
  }
}

function validateOptions(options: LocalNerDetectorOptions): ValidatedOptions {
  if (!options || !isStableId(options.id) || !isStableId(options.modelId) || typeof options.modelPath !== 'string' || !isAbsolute(options.modelPath)) {
    throw new LocalNerDetectorError('invalid_configuration')
  }
  const entries = Object.entries(options.labels ?? {})
  if (entries.length === 0 || entries.some(([label, category]) => !isLabel(label) || !isEntity(category)) || !Array.isArray(options.modelFiles) || options.modelFiles.length === 0 || options.modelFiles.some((file) => !isModelFile(file)) || new Set(options.modelFiles.map((file) => file.path)).size !== options.modelFiles.length) throw new LocalNerDetectorError('invalid_configuration')
  const labels = new Map(entries)
  return { id: options.id, modelId: options.modelId, modelPath: options.modelPath, modelFiles: options.modelFiles, labels, supportedEntities: [...new Set(labels.values())].sort() }
}

async function validateModelDirectory(modelPath: string, modelFiles: readonly LocalNerModelFile[]): Promise<void> {
  let root: string
  try {
    if (!(await stat(modelPath)).isDirectory()) throw new LocalNerDetectorError('invalid_configuration')
    root = await realpath(modelPath)
  } catch (error) {
    if (error instanceof LocalNerDetectorError) throw error
    throw new LocalNerDetectorError('invalid_configuration')
  }
  await Promise.all(modelFiles.map((file) => validateModelFile(root, file)))
}

async function validateModelFile(root: string, file: LocalNerModelFile): Promise<void> {
  try {
    const absolutePath = resolve(root, file.path)
    if (!isWithin(root, absolutePath)) throw new LocalNerDetectorError('model_integrity_failed')
    const resolvedPath = await realpath(absolutePath)
    if (!isWithin(root, resolvedPath) || !(await stat(resolvedPath)).isFile() || await sha256(resolvedPath) !== file.sha256) throw new LocalNerDetectorError('model_integrity_failed')
  } catch (error) {
    if (error instanceof LocalNerDetectorError) throw error
    throw new LocalNerDetectorError('model_integrity_failed')
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function decodeTokens(tokens: readonly LocalNerToken[], request: SensitiveDataInspectionRequest, labels: ReadonlyMap<string, string>): readonly SensitiveDataFinding[] {
  if (!Array.isArray(tokens)) throw new LocalNerDetectorError('invalid_result')
  const findings: SensitiveDataFinding[] = []
  for (const token of tokens) {
    if (!token || typeof token !== 'object') throw new LocalNerDetectorError('invalid_result')
    const label = token.entity_group ?? token.entity
    if (typeof label !== 'string') throw new LocalNerDetectorError('invalid_result')
    const category = labels.get(label)
    if (!category || !request.entities.includes(category)) continue
    if (!Number.isFinite(token.score) || token.score < 0 || token.score > 1 || !Number.isSafeInteger(token.start) || !Number.isSafeInteger(token.end) || token.start < 0 || token.start >= token.end || token.end > request.text.length) {
      throw new LocalNerDetectorError('invalid_result')
    }
    if (token.score >= request.scoreThreshold) findings.push({ category, start: token.start, end: token.end, score: token.score })
  }
  return findings
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LocalNerDetectorError('aborted')
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal)
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new LocalNerDetectorError('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function moduleNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true
  const message = error instanceof Error ? error.message : ''
  return message.includes('@huggingface/transformers') && /cannot find|not found|failed to resolve import/i.test(message)
}

function isStableId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value)
}

function isLabel(value: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

function isEntity(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
}

function isModelFile(value: unknown): value is LocalNerModelFile {
  return typeof value === 'object' && value !== null && 'path' in value && 'sha256' in value && typeof value.path === 'string' && typeof value.sha256 === 'string' && /^[a-z0-9][a-z0-9._/-]{0,255}$/i.test(value.path) && !value.path.split('/').some((segment) => segment === '.' || segment === '..') && /^[a-f0-9]{64}$/.test(value.sha256)
}

function isWithin(root: string, child: string): boolean {
  const difference = relative(root, child)
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !isAbsolute(difference))
}

function messageFor(kind: LocalNerDetectorErrorKind): string {
  if (kind === 'missing_optional_dependency') return 'Local NER requires the optional "@huggingface/transformers" package. Install it with "npm install @purista/harness-guardrails-local-ner @huggingface/transformers".'
  if (kind === 'invalid_configuration') return 'Local NER configuration requires a valid absolute local model directory and label mapping.'
  if (kind === 'invalid_request') return 'Local NER inspection request is invalid or exceeds the configured safety bound.'
  if (kind === 'model_integrity_failed') return 'Local NER local model asset integrity validation failed.'
  if (kind === 'model_load_failed') return 'Local NER could not load or execute the configured local model.'
  if (kind === 'invalid_result') return 'Local NER returned an invalid token-classification result.'
  return 'Local NER inspection was cancelled.'
}
