import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyPackageBoundaries, verifyPublicHarnessImports } from './package-boundaries.mjs'
import { createRequire } from 'node:module'

const ts = createRequire(import.meta.url)('typescript')

const categories = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies']
const detectors = ['@purista/harness-guardrails-local-ner', '@purista/harness-guardrails-native-privacy', '@purista/harness-guardrails-presidio']

for (const category of categories) {
  test(`${category}: keeps Harness and its adapters independent of the PURISTA framework`, () => {
    for (const [name, dependency] of [
      ['@purista/harness', '@purista/core'],
      ['@purista/harness-sandbox-docker', '@purista/core'],
      ['@purista/harness-sandbox-docker', '@purista/natsbridge']
    ]) {
      assert.throws(() => verifyPackageBoundaries([{ name, [category]: { [dependency]: '^3.0.0' } }]), /must not depend on PURISTA framework packages/)
    }
    assert.doesNotThrow(() => verifyPackageBoundaries([
      { name: '@purista/harness-openai', [category]: { openai: '^7.0.0' } },
      { name: '@purista/harness-sandbox-docker', [category]: { zod: '^4.0.0' } },
      { name: '@purista/harness', [category]: { '@opentelemetry/api': '^1.0.0' } }
    ]))
  })

  test(`${category}: permits only the three approved detector-to-contract-owner edges`, () => {
    for (const name of detectors) {
      assert.doesNotThrow(() => verifyPackageBoundaries([{ name, [category]: { '@purista/harness-guardrails': '^3.0.0' } }]))
    }
    assert.throws(() => verifyPackageBoundaries([{
      name: '@purista/harness-guardrails-another-detector', [category]: { '@purista/harness-guardrails': '^3.0.0' }
    }]), /must not depend/)
  })

  test(`${category}: preserves core, Docker, and adapter dependency direction`, () => {
    const forbidden = [
      ['@purista/harness', '@purista/harness-guardrails'],
      ['@purista/harness', '@purista/harness-sandbox-docker'],
      ['@purista/harness-guardrails', '@purista/harness-guardrails-local-ner'],
      ['@purista/harness-sandbox-docker', '@purista/harness-guardrails'],
      ['@purista/harness-sandbox-docker', '@purista/harness-openai'],
      ['@purista/harness-guardrails-local-ner', '@purista/harness-guardrails-presidio'],
      ['@purista/harness-guardrails-local-ner', '@purista/harness-openai'],
      ['@purista/harness-openai', '@purista/harness-anthropic']
    ]
    for (const [name, dependency] of forbidden) {
      assert.throws(() => verifyPackageBoundaries([{ name, [category]: { [dependency]: '^3.0.0' } }]), /must not depend/)
    }
    assert.doesNotThrow(() => verifyPackageBoundaries([{
      name: '@purista/harness-sandbox-docker', [category]: { '@purista/harness': '^3.0.0' }
    }]))
  })
}

test('an approved peer does not conceal a forbidden dependency in another category', () => {
  assert.throws(() => verifyPackageBoundaries([{
    name: '@purista/harness-guardrails-local-ner',
    peerDependencies: { '@purista/harness-guardrails': '^3.0.0' },
    optionalDependencies: { '@purista/harness-guardrails-presidio': '^3.0.0' }
  }]), /harness-guardrails-presidio/)
})

test('adapter imports and re-exports use only published Core entrypoints', () => {
  const file = '/workspace/ai-harness/packages/harness-guardrails/src/rails.ts'
  for (const specifier of ['@purista/harness/src/decisions/index.js', '@purista/harness/decisions', '../../harness/src/index.js', '../../harness/dist/index.js']) {
    for (const code of [`import { value } from '${specifier}'`, `export { value } from '${specifier}'`, `const value = import('${specifier}')`, `const value = require('${specifier}')`]) {
      assert.equal(verifyPublicHarnessImports(ts, file, code).length, 1, code)
    }
  }
  assert.deepEqual(verifyPublicHarnessImports(ts, file, "import { runDecisionOperation } from '@purista/harness'; import { z } from 'zod'; import './config.js'"), [])
  assert.equal(verifyPublicHarnessImports(ts, file, "import { FakeModelProvider } from '@purista/harness/testing'").length, 1)
  assert.deepEqual(verifyPublicHarnessImports(ts, '/workspace/ai-harness/packages/harness-guardrails/test/rails.test.ts', "import { FakeModelProvider } from '@purista/harness/testing'"), [])
  assert.deepEqual(verifyPublicHarnessImports(ts, '/workspace/ai-harness/packages/harness/src/agents/index.ts', "import { runDecisionOperation } from '../decisions/index.js'"), [])
  assert.deepEqual(verifyPublicHarnessImports(ts, '/workspace/ai-harness/examples/living-wiki-jaeger/src/backend/app.ts', "import { defineHarness } from '../../../../packages/harness/src/index.js'"), [])
})
