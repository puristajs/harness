import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { createLocalNerDetector, LocalNerDetectorError, type LocalNerRuntime } from '../src/index.js'
import { createLocalNerDetectorWithRuntime, FakeLocalNerRuntime } from '../src/testing/index.js'

const localModelPath = process.cwd()
const localModelFiles = [{ path: 'package.json', sha256: createHash('sha256').update(await readFile('package.json')).digest('hex') }]

it('uses only a caller-provided local path, maps declared labels, and reports UTF-16 ranges', async () => {
  const calls: unknown[] = []
  const runtime: LocalNerRuntime = {
    async createTokenClassificationPipeline(modelPath, options) {
      calls.push({ modelPath, options })
      return async () => [{ entity_group: 'PER', score: 0.98, start: 3, end: 8 }]
    }
  }
  const detector = createLocalNerDetectorWithRuntime({
    id: 'local-ner-en',
    modelId: 'local-ner-en-v1',
    modelPath: localModelPath,
    modelFiles: localModelFiles,
    labels: { PER: 'PERSON' }
  }, async () => runtime)

  await detector.warmup()
  await expect(detector.inspect({ text: 'A😀Alice', entities: ['PERSON'], scoreThreshold: 0.8, signal: new AbortController().signal })).resolves.toEqual({
    findings: [{ category: 'PERSON', start: 3, end: 8, score: 0.98 }]
  })
  expect(detector.supportedEntities).toEqual(['PERSON'])
  expect(calls).toEqual([{ modelPath: localModelPath, options: { localFilesOnly: true, aggregationStrategy: 'simple' } }])
})

it('provides a deterministic runtime fake without recording inspected text', async () => {
  const runtime = new FakeLocalNerRuntime()
  runtime.enqueue([{ entity_group: 'PER', score: 0.99, start: 0, end: 5 }])
  const detector = createLocalNerDetectorWithRuntime({ id: 'fake-ner', modelId: 'fake-ner-v1', modelPath: localModelPath, modelFiles: localModelFiles, labels: { PER: 'PERSON' } }, async () => runtime)
  await expect(detector.inspect({ text: 'Alice', entities: ['PERSON'], scoreThreshold: 0.5, signal: new AbortController().signal })).resolves.toEqual({ findings: [{ category: 'PERSON', start: 0, end: 5, score: 0.99 }] })
  expect(runtime.loads).toEqual([{ modelPath: localModelPath, options: { localFilesOnly: true, aggregationStrategy: 'simple' } }])
  expect(JSON.stringify(runtime)).not.toContain('Alice')
})

it('never returns unrequested mapped categories and fails closed for malformed model output', async () => {
  const runtime: LocalNerRuntime = {
    async createTokenClassificationPipeline() {
      return async () => [
        { entity_group: 'PER', score: 0.99, start: 0, end: 5 },
        { entity_group: 'ORG', score: 0.99, start: 6, end: 15 }
      ]
    }
  }
  const detector = createLocalNerDetectorWithRuntime({ id: 'local-ner', modelId: 'local-ner-v1', modelPath: localModelPath, modelFiles: localModelFiles, labels: { PER: 'PERSON', ORG: 'ORGANIZATION' } }, async () => runtime)
  await expect(detector.inspect({ text: 'Alice OpenAI', entities: ['PERSON'], scoreThreshold: 0.5, signal: new AbortController().signal })).resolves.toEqual({ findings: [{ category: 'PERSON', start: 0, end: 5, score: 0.99 }] })

  const malformed = createLocalNerDetectorWithRuntime({
    id: 'malformed-ner',
    modelId: 'malformed-ner-v1',
    modelPath: localModelPath,
    modelFiles: localModelFiles,
    labels: { PER: 'PERSON' }
  }, async () => ({ async createTokenClassificationPipeline() { return async () => [{ entity_group: 'PER', score: 1.1, start: 0, end: 5 }] } }))
  await expect(malformed.inspect({ text: 'Alice', entities: ['PERSON'], scoreThreshold: 0.5, signal: new AbortController().signal })).rejects.toMatchObject({ kind: 'invalid_result' } satisfies Partial<LocalNerDetectorError>)
})

it('reports a safe remediation when the optional runtime is unavailable and respects cancellation', async () => {
  const absentPeer = createLocalNerDetector({ id: 'absent-peer-ner', modelId: 'absent-peer-ner-v1', modelPath: localModelPath, modelFiles: localModelFiles, labels: { PER: 'PERSON' } })
  await expect(absentPeer.warmup()).rejects.toMatchObject({
    kind: 'missing_optional_dependency',
    message: 'Local NER requires the optional "@huggingface/transformers" package. Install it with "npm install @purista/harness-guardrails-local-ner @huggingface/transformers".'
  } satisfies Partial<LocalNerDetectorError>)

  const missing = createLocalNerDetectorWithRuntime({
    id: 'missing-ner',
    modelId: 'missing-ner-v1',
    modelPath: localModelPath,
    modelFiles: localModelFiles,
    labels: { PER: 'PERSON' }
  }, async () => { throw new LocalNerDetectorError('missing_optional_dependency') })
  await expect(missing.warmup()).rejects.toMatchObject({
    kind: 'missing_optional_dependency',
    message: 'Local NER requires the optional "@huggingface/transformers" package. Install it with "npm install @purista/harness-guardrails-local-ner @huggingface/transformers".'
  } satisfies Partial<LocalNerDetectorError>)

  const aborted = new AbortController()
  aborted.abort()
  const detector = createLocalNerDetectorWithRuntime({ id: 'abort-ner', modelId: 'abort-ner-v1', modelPath: localModelPath, modelFiles: localModelFiles, labels: { PER: 'PERSON' } }, async () => ({ async createTokenClassificationPipeline() { return async () => [] } }))
  await expect(detector.inspect({ text: 'Alice', entities: ['PERSON'], scoreThreshold: 0.5, signal: aborted.signal })).rejects.toMatchObject({ kind: 'aborted' } satisfies Partial<LocalNerDetectorError>)
})

it('fails before model loading when a declared local model asset does not match its SHA-256 pin', async () => {
  let loads = 0
  const detector = createLocalNerDetectorWithRuntime({
    id: 'integrity-ner',
    modelId: 'integrity-ner-v1',
    modelPath: localModelPath,
    modelFiles: [{ path: 'package.json', sha256: '0'.repeat(64) }],
    labels: { PER: 'PERSON' }
  }, async () => ({
    async createTokenClassificationPipeline() {
      loads += 1
      return async () => []
    }
  }))
  await expect(detector.warmup()).rejects.toMatchObject({ kind: 'model_integrity_failed', message: 'Local NER local model asset integrity validation failed.' } satisfies Partial<LocalNerDetectorError>)
  expect(loads).toBe(0)
})
