import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createLocalNerDetectorWithRuntime } from '../dist/testing/index.js'

const detector = createLocalNerDetectorWithRuntime({
  id: 'local-ner-smoke',
  modelId: 'local-ner-smoke-v1',
  modelPath: process.cwd(),
  modelFiles: [{ path: 'package.json', sha256: createHash('sha256').update(await readFile('package.json')).digest('hex') }],
  labels: { PER: 'PERSON' }
}, async () => ({
    async createTokenClassificationPipeline() {
      return async () => [{ entity_group: 'PER', score: 0.99, start: 0, end: 5 }]
    }
  }))

await detector.warmup()
const result = await detector.inspect({ text: 'Alice', entities: ['PERSON'], scoreThreshold: 0.5, signal: new AbortController().signal })
assert.deepEqual(result.findings, [{ category: 'PERSON', start: 0, end: 5, score: 0.99 }])
