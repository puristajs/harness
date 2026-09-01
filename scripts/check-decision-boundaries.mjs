import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyPublicHarnessImports } from './package-boundaries.mjs'
import { filesUnder, scanRemovedSymbols } from './verify-decision-consumers.mjs'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url))
const defaultRoot = existsSync(join(workspaceRoot, 'ai-harness')) ? workspaceRoot : repositoryRoot
const harnessPrefix = 'ai-harness/'
const core = 'ai-harness/packages/harness/src/'
const addon = 'ai-harness/packages/harness-guardrails/src/'
const roots = [
  'ai-harness/packages', 'ai-harness/examples', 'ai-harness/docs', 'ai-harness/skills', 'ai-harness/README.md',
  'purista/packages/core/src/AgentQueueBuilder', 'purista/skills/purista', 'purista/packages/core/skills/purista',
  'purista/web/src/data/harness-markdown.ts', 'purista/web/src/content/handbook/harness',
  'purista/web/src/content/handbook-cards/harness', 'purista/web/src/content/handbook-cards/blocks/agent-pattern',
  'purista/web/src/content/handbook-cards/blocks/agent-pattern.mdx',
  'starter', 'create-purista',
]
const negativeFixtureFiles = [
  'ai-harness/packages/harness/type-tests/harness-typing.ts',
  'ai-harness/packages/harness/test/harness.test.ts',
  'ai-harness/packages/harness/test/governance.test.ts',
  'ai-harness/packages/harness/test/agent-interceptors.test.ts',
  'ai-harness/packages/harness-guardrails/test/guardrails.test.ts',
  'ai-harness/packages/harness-guardrails/type-tests/guardrails-typing.ts',
]
// These are ownership constraints, not a second public-export inventory.
const owners = {
  runDecisionOperation: core + 'decisions/execution.ts',
  createDecisionEvidence: core + 'decisions/evidence.ts',
  createDecisionId: core + 'decisions/identity.ts',
  isJsonValue: core + 'models/json.ts',
  DecisionEvidence: core + 'decisions/types.ts',
  decisionEvidenceSchema: core + 'decisions/schemas.ts',
  decisionResultSchema: core + 'decisions/schemas.ts',
}
// Scan removed result fields, not a mirrored schema of every allowed property.
// Canonical Zod schemas and the runtime/type suites own full shape validation.
const removedResultFields = new Set(['message', 'reason', 'metadata', 'tags', 'riskLevel', 'decisionId', 'policyId', 'policyVersion'])
const unsafeEvidenceFields = new Set(['message', 'reason', 'metadata', 'input', 'output', 'effect', 'enforced', 'failureKind'])
const unsafeAuditFields = new Set([...removedResultFields, 'input', 'output'])
const privateModules = ['decisions/identity.ts', 'governance/index.ts', 'agents/tool-execution.ts']
const retiredGuardrailIdentifiers = new Set([
  'loadGuardrailsConfig', 'parseGuardrailsConfig', 'ParsedGuardrailsConfig',
  'NeMoConfig', 'NeMoRailConfig', 'NeMoSensitiveDataConfig',
])
const guardrailRoots = [
  'ai-harness/packages/harness-guardrails',
  'ai-harness/examples/guardrails',
  'ai-harness/docs/guides/guardrails.md',
  'ai-harness/skills/ai-harness',
]
const retiredGuardrailArtifacts = new Set([
  'config.ts', 'config.yaml', 'config.yml', 'guardrails.yaml', 'guardrails.yml',
  'guardrails.schema.json', 'guardrails-reference.md',
])
const guardrailNarrativeExtensions = new Set(['.md', '.mdx', '.json', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'])

function boundaryLayout(root) {
  const workspace = existsSync(join(root, 'ai-harness'))
  const local = path => path.startsWith(harnessPrefix)
  return {
    roots: workspace ? roots : roots.filter(local).map(path => path.slice(harnessPrefix.length)),
    negativeFixtureFiles: workspace ? negativeFixtureFiles : negativeFixtureFiles.map(path => path.slice(harnessPrefix.length)),
    absolute: path => workspace || !local(path) ? join(root, path) : join(root, path.slice(harnessPrefix.length)),
    virtual: path => (workspace ? relative(root, path) : harnessPrefix + relative(root, path)).replaceAll('\\', '/'),
  }
}

/**
 * Enforce the released guardrail authoring cut without treating unrelated YAML
 * features as guardrail configuration. This is deliberately a small extension
 * of the existing architecture gate: semantic validation stays with the addon
 * test/type suites.
 */
export async function verifyGuardrailCleanBreak(ts, root) {
  const layout = boundaryLayout(root)
  const findings = []
  const report = (path, line, rule, symbol) => findings.push({ path, line, rule, symbol })
  const packagePath = layout.absolute('ai-harness/packages/harness-guardrails/package.json')
  const lockPath = layout.absolute('ai-harness/package-lock.json')
  if (existsSync(packagePath)) {
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'))
    for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const name of Object.keys(pkg[group] ?? {})) if (name === 'yaml' || name === 'js-yaml') report('ai-harness/packages/harness-guardrails/package.json', 1, 'retired-guardrail-dependency', name)
    }
  }
  if (existsSync(lockPath)) {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    const dependencies = lock.packages?.['packages/harness-guardrails']?.dependencies ?? {}
    for (const name of Object.keys(dependencies)) if (name === 'yaml' || name === 'js-yaml') report('ai-harness/package-lock.json', 1, 'retired-guardrail-lockfile-dependency', name)
  }
  for (const configuredRoot of guardrailRoots) {
    const absolute = layout.absolute(configuredRoot)
    if (!existsSync(absolute)) continue
    for (const path of await filesUnder(absolute)) {
      const localPath = layout.virtual(path).replaceAll('\\', '/')
      const basename = localPath.slice(localPath.lastIndexOf('/') + 1)
      if (retiredGuardrailArtifacts.has(basename)) report(localPath, 1, 'retired-guardrail-artifact', basename)
      const extension = extname(path)
      if (!guardrailNarrativeExtensions.has(extension)) continue
      const content = await readFile(path, 'utf8')
      const retiredNarrative = /(?:configuration files?|policy files?|guardrails\.ya?ml|\byaml\b)/i.exec(content)
      if (retiredNarrative) report(localPath, content.slice(0, retiredNarrative.index).split('\n').length, 'retired-guardrail-narrative', retiredNarrative[0])
      if (!['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'].includes(extension)) continue
      const source = ts.createSourceFile(localPath, content, ts.ScriptTarget.Latest, true)
      const visit = node => {
        if (ts.isIdentifier(node) && (retiredGuardrailIdentifiers.has(node.text) || node.text.startsWith('NeMo'))) {
          report(localPath, source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, 'retired-guardrail-api', node.text)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  const sourcePath = layout.absolute('ai-harness/packages/harness/src/harness/defineHarness.ts')
  if (existsSync(sourcePath)) {
    const source = await readFile(sourcePath, 'utf8')
    if (source.includes('ToolDefinitionHelpers') || source.includes('RegisteredTsToolDefinition')) {
      report('ai-harness/packages/harness/src/harness/defineHarness.ts', 1, 'retired-native-tool-helper', 'ToolDefinitionHelpers')
    }
  }
  return findings
}

/** Static ownership checks; sequencing, arbitrary values and privacy require the runtime suites. */
export function checkDecisionSource(ts, path, content) {
  const normalized = path.replaceAll('\\', '/')
  // Tests still pass through the shared removed-API scan and import gate. Local
  // synthetic callbacks are not production ownership implementations.
  if (/(?:^|\/)(?:test|type-tests)\/|\.test\.[cm]?[jt]sx?$/.test(normalized)) return []
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
  const findings = []
  const report = (node, rule, symbol) => findings.push({ path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule, symbol })
  const governed = normalized.startsWith(core + 'decisions/') || normalized.startsWith(core + 'governance/') || normalized.startsWith(addon)
  const ownerScope = governed || normalized === core + 'agents/index.ts' || normalized === core + 'agents/tool-execution.ts'
  const decisionTimer = (governed || normalized === core + 'agents/index.ts') && normalized !== owners.runDecisionOperation
  const review = normalized.startsWith('ai-harness/examples/durable-human-review/src/')
  const declarationName = node => (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) ? node.name?.getText(source) : undefined
  const shapeName = node => {
    let parent = node.parent
    if (ts.isTypeLiteralNode(parent)) {
      while (parent && !ts.isTypeAliasDeclaration(parent)) parent = parent.parent
      return parent?.name.text
    }
    if (!ts.isObjectLiteralExpression(parent)) return undefined
    parent = parent.parent
    if (ts.isCallExpression(parent)) parent = parent.parent
    if (ts.isVariableDeclaration(parent)) return parent.type?.getText(source) ?? parent.name.getText(source)
    if (ts.isSatisfiesExpression(parent) || ts.isAsExpression(parent)) return parent.type.getText(source)
    return undefined
  }
  const visit = node => {
    const name = declarationName(node)
    if (ownerScope && name && Object.hasOwn(owners, name) && normalized !== owners[name]) report(node, 'duplicate-owner', name)
    if (governed && name === 'GuardrailDecision' && ts.isTypeAliasDeclaration(node) && (ts.isUnionTypeNode(node.type) || ts.isTypeLiteralNode(node.type))) report(node, 'duplicate-decision-shape', name)
    if (governed && normalized !== core + 'decisions/schemas.ts' && ts.isRegularExpressionLiteral(node) && node.text.includes('[a-z0-9_]{0,63}')) report(node, 'duplicate-reason-validator', 'reasonCode')
    if (decisionTimer) {
      const member = ts.isPropertyAccessExpression(node) ? `${node.expression.getText(source)}.${node.name.text}`
        : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) ? `${node.expression.getText(source)}.${node.argumentExpression.text}` : undefined
      if ((ts.isIdentifier(node) && ['setTimeout', 'setInterval'].includes(node.text)) ||
        (member && /^(?:globalThis\.(?:setTimeout|setInterval)|AbortSignal\.timeout|Promise\.race)$/.test(member)) ||
        (ts.isStringLiteral(node) && /^node:timers(?:\/promises)?$/.test(node.text) && ts.isImportDeclaration(node.parent))) report(node, 'decision-timer', member ?? node.getText(source))
    }
    if (ts.isPropertyAssignment(node) || ts.isPropertySignature(node)) {
      const shape = shapeName(node)
      const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined
      const removed = /^(?:DecisionEvidence|decisionEvidenceSchema)$/.test(shape) ? unsafeEvidenceFields
        : /^GovernanceAuditRecord$/.test(shape) ? unsafeAuditFields
          : /^(?:Governance(?:Decision|ApprovalResult)|governance(?:Decision|ApprovalResult)Schema|NativePolicyRule(?:ForTool)?|AgentInterceptor(?:Decision|Transform)|Guardrail(?:Decision|Outcome))(?:<|$)/.test(shape) ? removedResultFields : undefined
      if (key && removed?.has(key)) report(node, 'unsafe-decision-field', `${shape}.${key}`)
    }
    if (review && ((ts.isIdentifier(node) && node.text === 'consumed') || (ts.isStringLiteral(node) && node.text === 'consumed'))) report(node, 'review-consumed', 'consumed')
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

async function exportedNames(ts, path, visited = new Set()) {
  if (visited.has(path) || !existsSync(path)) return new Set()
  visited.add(path)
  const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const names = new Set()
  for (const statement of source.statements) {
    if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (statement.name && ts.isIdentifier(statement.name)) names.add(statement.name.text)
      if (ts.isVariableStatement(statement)) for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name)) names.add(item.name.text)
    }
    if (!ts.isExportDeclaration(statement)) continue
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const item of statement.exportClause.elements) names.add(item.name.text)
    } else if (!statement.exportClause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('.')) {
      const target = resolve(dirname(path), statement.moduleSpecifier.text.replace(/\.js$/, '.ts'))
      for (const name of await exportedNames(ts, target, visited)) names.add(name)
    }
  }
  return names
}

/** Check module presence and public re-export continuity without compiling or cloning the API inventory. */
export async function verifyDecisionModules(ts, root) {
  const layout = boundaryLayout(root)
  const findings = []
  const modules = [
    ...['schemas', 'types', 'identity', 'evidence', 'execution', 'index', 'decisions.test'].map(name => core + `decisions/${name}.ts`),
    core + 'governance/index.ts', core + 'agents/tool-execution.ts', core + 'index.ts',
  ]
  for (const path of modules) if (!existsSync(layout.absolute(path))) findings.push({ path, line: 1, rule: 'missing-module', symbol: path })
  const entry = core + 'index.ts'
  const publicNames = await exportedNames(ts, layout.absolute(entry))
  const decisionNames = await exportedNames(ts, layout.absolute(core + 'decisions/index.ts'))
  for (const name of new Set(['createDecisionEvidence', 'runDecisionOperation', 'isJsonValue', 'DecisionBlockedError', 'DecisionEvaluationError', ...decisionNames])) {
    if (!publicNames.has(name)) findings.push({ path: entry, line: 1, rule: 'missing-export', symbol: name })
  }
  for (const module of privateModules) {
    for (const name of await exportedNames(ts, layout.absolute(core + module))) {
      if (publicNames.has(name)) findings.push({ path: entry, line: 1, rule: 'private-export', symbol: name })
    }
  }
  if (existsSync(layout.absolute(entry))) {
    const source = ts.createSourceFile(entry, await readFile(layout.absolute(entry), 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      if (!privateModules.some(module => statement.moduleSpecifier.text === './' + module.replace(/\.ts$/, '.js'))) continue
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) findings.push({ path: entry, line: source.getLineAndCharacterOfPosition(item.getStart(source)).line + 1, rule: 'private-export', symbol: item.name.text })
      }
    }
  }
  return findings
}

/** Run only static gates. Full consumer/build/runtime checks remain separate mandatory acceptance gates. */
export async function checkDecisionBoundaries(root = defaultRoot) {
  const layout = boundaryLayout(root)
  const ts = createRequire(new URL('../package.json', import.meta.url))('typescript')
  const removed = await scanRemovedSymbols(ts, root, { roots: layout.roots, documentation: true, negativeFixtureFiles: layout.negativeFixtureFiles })
  const findings = removed.map(item => ({ ...item, path: layout.virtual(item.path), rule: 'removed-api' }))
  const files = new Set((await Promise.all(layout.roots.map(path => filesUnder(join(root, path))))).flat())
  for (const path of files) {
    if (!['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts', '.cts'].includes(extname(path))) continue
    const content = await readFile(path, 'utf8')
    const localPath = layout.virtual(path)
    findings.push(...checkDecisionSource(ts, localPath, content))
    findings.push(...verifyPublicHarnessImports(ts, path, content).map(item => ({ ...item, path: localPath })))
  }
  findings.push(...await verifyDecisionModules(ts, root))
  findings.push(...await verifyGuardrailCleanBreak(ts, root))
  return findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.rule.localeCompare(right.rule))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2).filter(arg => arg !== '--check')
    if (args.length > 1 || args[0]?.startsWith('-')) throw new Error('Usage: check-decision-boundaries.mjs [--check] [workspace-root]')
    const findings = await checkDecisionBoundaries(args[0] ? resolve(args[0]) : defaultRoot)
    for (const item of findings) console.error(`${item.path}:${item.line} ${item.rule}: ${item.symbol}`)
    if (findings.length) process.exitCode = 1
    else console.log('Decision boundary static checks passed.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
