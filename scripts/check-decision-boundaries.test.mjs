import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'
import { checkDecisionBoundaries, checkDecisionSource, verifyDecisionModules, verifyGuardrailCleanBreak } from './check-decision-boundaries.mjs'

const ts = createRequire(import.meta.url)('typescript')
const artifacts = fileURLToPath(new URL('../.artifacts/decision-consumers/', import.meta.url))
await mkdir(artifacts, { recursive: true })
const root = await mkdtemp(join(artifacts, 'cleanup-fixtures-'))
after(() => rm(root, { recursive: true, force: true }))
const core = 'ai-harness/packages/harness/src/'
const rails = 'ai-harness/packages/harness-guardrails/src/rails.ts'

test('decision callback timers cannot be reimplemented but unrelated lifecycle timers remain valid', () => {
  for (const file of [rails, core + 'governance/index.ts', core + 'decisions/another.ts', core + 'agents/index.ts']) {
    for (const code of ['setTimeout(callback, 100)', 'globalThis.setTimeout(callback, 100)', "globalThis['setTimeout'](callback, 100)", 'const delay = setTimeout; delay(callback, 10)', "import { setTimeout as delay } from 'node:timers/promises'", 'AbortSignal.timeout(10)', 'Promise.race([action(), deadline])']) {
      assert.ok(checkDecisionSource(ts, file, code).some(item => item.rule === 'decision-timer'), file + code)
    }
  }
  for (const [file, code] of [
    [core + 'decisions/execution.ts', 'setTimeout(callback, 100); Promise.race([action(), deadline])'],
    [core + 'agents/tool-execution.ts', 'setTimeout(() => controller.abort(), timeoutMs)'],
    [core + 'models/registry.ts', 'setTimeout(retry, delay)'],
    [rails, 'const signal = new AbortController().signal'],
    [core + 'governance/index.ts', "createHash('sha256').update(approvalTuple)"]
  ]) assert.deepEqual(checkDecisionSource(ts, file, code), [])
})

test('canonical helper and schema owners cannot be shadowed or cloned in the addon', () => {
  for (const code of [
    'function runDecisionOperation() {}', 'const createDecisionEvidence = () => ({})',
    'function isJsonValue(value) { return true }', 'function createDecisionId() {}',
    'const decisionEvidenceSchema = z.object({})', 'type DecisionEvidence = { decisionId: string }',
    "const code = /^[a-z][a-z0-9_]{0,63}$/.test(value)",
    "type GuardrailDecision = { decision: 'allow' } | { decision: 'block' }"
  ]) assert.ok(checkDecisionSource(ts, rails, code).length > 0, code)
  assert.deepEqual(checkDecisionSource(ts, rails, "import { decisionResultSchema, isJsonValue, runDecisionOperation, createDecisionEvidence } from '@purista/harness'; type GuardrailDecision = z.output<typeof decisionResultSchema>"), [])
  assert.deepEqual(checkDecisionSource(ts, core + 'decisions/schemas.ts', "const reasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)"), [])
  assert.deepEqual(checkDecisionSource(ts, 'create-purista/bin.js', 'function toString() {}'), [])
  assert.deepEqual(checkDecisionSource(ts, 'ai-harness/packages/harness-memory-nats/src/index.ts', 'function isJsonValue(value) { return true }'), [])
})

test('closed decision projections reject old fields without banning unrelated metadata', () => {
  for (const code of [
    "const decision: GovernanceDecision = { effect: 'allow', reason: 'prose' }",
    "const result = { decision: 'approved', metadata: {} } satisfies GovernanceApprovalResult",
    "type GovernanceDecision = { effect: string; policyId: string }",
    'const decisionEvidenceSchema = z.object({ decisionId: z.string(), metadata: z.unknown() })'
  ]) assert.ok(checkDecisionSource(ts, core + 'governance/index.ts', code).length > 0, code)
  assert.deepEqual(checkDecisionSource(ts, core + 'agents/index.ts', "const invocation = { metadata: { plan: 'safe' } }; function parse(value: unknown) { return value }; const error = { meta: { reason: 'policy_deny' } }"), [])
})

test('removed review state is scoped to the payment review source, not unrelated business data or prose', () => {
  const file = 'ai-harness/examples/durable-human-review/src/review-task-store.ts'
  for (const code of ["const task = { consumed: true }", "type Status = 'approved' | 'consumed'", "task['consumed'] = true"]) {
    assert.ok(checkDecisionSource(ts, file, code).some(item => item.rule === 'review-consumed'))
  }
  assert.deepEqual(checkDecisionSource(ts, 'starter/src/review.ts', 'const task = { consumed: true, metadata: {} }'), [])
  assert.deepEqual(checkDecisionSource(ts, file, "// consumed is historical prose\nconst message = 'the stream was consumed'"), [])
})

test('guardrail cleanup rejects only retired file configuration surfaces', async () => {
  const workspace = join(root, 'guardrail-clean-break')
  await put('ai-harness/packages/harness-guardrails/package.json', JSON.stringify({ dependencies: { yaml: '^2.0.0' } }), workspace)
  await put('ai-harness/package-lock.json', JSON.stringify({ packages: { 'packages/harness-guardrails': { dependencies: { 'js-yaml': '^4.0.0' } } } }), workspace)
  await put('ai-harness/packages/harness-guardrails/src/config.ts', 'export const legacy = true', workspace)
  await put('ai-harness/packages/harness-guardrails/src/index.ts', 'export { loadGuardrailsConfig } from "./config.js"', workspace)
  await put('ai-harness/docs/guides/guardrails.md', 'Configure a YAML policy file.', workspace)
  await put('ai-harness/packages/harness/src/harness/defineHarness.ts', 'type ToolDefinitionHelpers = unknown; export class Builder {}', workspace)
  const findings = await verifyGuardrailCleanBreak(ts, workspace)
  for (const rule of ['retired-guardrail-dependency', 'retired-guardrail-lockfile-dependency', 'retired-guardrail-artifact', 'retired-guardrail-api', 'retired-guardrail-narrative', 'retired-native-tool-helper']) {
    assert.ok(findings.some(item => item.rule === rule), rule)
  }
  await put('ai-harness/packages/harness-guardrails/package.json', JSON.stringify({ dependencies: { zod: '^4.0.0' } }), workspace)
  await put('ai-harness/package-lock.json', JSON.stringify({ packages: { 'packages/harness-guardrails': { dependencies: { zod: '^4.0.0' } } } }), workspace)
  await rm(join(workspace, 'ai-harness/packages/harness-guardrails/src/config.ts'))
  await put('ai-harness/packages/harness-guardrails/src/index.ts', 'export const defineGuardrails = true', workspace)
  await put('ai-harness/packages/harness-guardrails/LICENSE', 'Configuration files are covered by this license.', workspace)
  await put('ai-harness/docs/guides/guardrails.md', 'Use inline typed configuration.', workspace)
  await put('ai-harness/packages/harness/src/harness/defineHarness.ts', 'class Builder { tools(definitions: Record<string, unknown>) { return definitions } }', workspace)
  assert.deepEqual(await verifyGuardrailCleanBreak(ts, workspace), [])
})

async function put(relative, content = '', workspace = root) {
  const file = join(workspace, relative)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function decisionModules(workspace) {
  for (const name of ['schemas', 'types', 'identity', 'evidence', 'execution', 'index', 'decisions.test']) await put(core + `decisions/${name}.ts`, '', workspace)
  await put(core + 'governance/index.ts', '', workspace)
  await put(core + 'agents/tool-execution.ts', '', workspace)
  await put(core + 'decisions/index.ts', "export { createDecisionEvidence } from './evidence.js'; export { runDecisionOperation } from './execution.js'; export type { DecisionEvidence } from './types.js'", workspace)
  await put(core + 'index.ts', "export { createDecisionEvidence, runDecisionOperation } from './decisions/index.js'; export type { DecisionEvidence } from './decisions/index.js'; export { isJsonValue } from './models/json.js'; export { DecisionBlockedError, DecisionEvaluationError } from './errors/index.js'", workspace)
}

test('required module and public re-export checks detect missing owners, missing exports and leaked private helpers', async () => {
  await decisionModules(root)
  assert.deepEqual(await verifyDecisionModules(ts, root), [])
  await put(core + 'index.ts', "export { createDecisionId } from './decisions/identity.js'")
  const findings = await verifyDecisionModules(ts, root)
  assert.ok(findings.some(item => item.rule === 'missing-export' && item.symbol === 'runDecisionOperation'))
  assert.ok(findings.some(item => item.rule === 'private-export' && item.symbol === 'createDecisionId'))
  await put(core + 'decisions/identity.ts', 'export function createDecisionId() {}')
  await put(core + 'index.ts', "export * from './decisions/identity.js'; export { createDecisionId as leaked } from './decisions/identity.js'")
  assert.ok((await verifyDecisionModules(ts, root)).some(item => item.rule === 'private-export' && item.symbol === 'createDecisionId'))
  assert.ok((await verifyDecisionModules(ts, root)).some(item => item.rule === 'private-export' && item.symbol === 'leaked'))
  await rm(join(root, core + 'decisions/execution.ts'))
  assert.ok((await verifyDecisionModules(ts, root)).some(item => item.rule === 'missing-module'))
})

test('cleanup excludes absent or malformed Voyage but requires and scans in-scope consumers', async () => {
  const workspace = join(root, 'scope')
  await decisionModules(workspace)
  for (const directory of [
    'ai-harness/examples', 'ai-harness/docs', 'ai-harness/skills',
    'purista/packages/core/src/AgentQueueBuilder', 'purista/skills/purista', 'purista/packages/core/skills/purista',
    'purista/web/src/content/handbook/harness', 'purista/web/src/content/handbook-cards/harness',
    'purista/web/src/content/handbook-cards/blocks/agent-pattern', 'starter', 'create-purista',
  ]) await mkdir(join(workspace, directory), { recursive: true })
  for (const file of ['ai-harness/README.md', 'purista/web/src/data/harness-markdown.ts', 'purista/web/src/content/handbook-cards/blocks/agent-pattern.mdx']) await put(file, '', workspace)
  assert.deepEqual(await checkDecisionBoundaries(workspace), [])
  await put('voyage/apps/server/src/invalid.ts', "const onPermission = true; const permissions = { write: 'ask' }; const invalid: string = 42;", workspace)
  await put('voyage/docs/purista-core-harness-migration.md', 'OnPermission', workspace)
  await put('voyage/apps/server/tsconfig.json', '{invalid', workspace)
  assert.deepEqual(await checkDecisionBoundaries(workspace), [])
  await put('starter/agent.ts', 'const onPermission = true', workspace)
  assert.ok((await checkDecisionBoundaries(workspace)).some(item => item.path === 'starter/agent.ts' && item.rule === 'removed-api'))
  for (const required of ['starter', 'create-purista', 'purista/packages/core/src/AgentQueueBuilder']) {
    await rm(join(workspace, required), { recursive: true })
    await assert.rejects(checkDecisionBoundaries(workspace), error => error.message.includes(`Missing required consumer source directory: ${join(workspace, required)}`))
    await mkdir(join(workspace, required), { recursive: true })
  }
})
