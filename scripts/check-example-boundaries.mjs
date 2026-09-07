#!/usr/bin/env node

import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const examplesRoot = join(repositoryRoot, 'examples')
const ignoredDirectories = new Set(['dist', 'node_modules', 'coverage'])
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md'])
const codeExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx'])

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else result.push(path)
  }
  return result
}

const failures = []
const exampleFiles = await files(examplesRoot)
const manifests = exampleFiles.filter(file => file.endsWith('package.json'))

for (const file of exampleFiles) {
  const name = relative(repositoryRoot, file)
  if (!sourceExtensions.has(extname(file))) continue
  const source = await readFile(file, 'utf8')

  if (/packages\/.+\/src/.test(source)) failures.push(`${name}: bypasses a published package export`)
  if (/"rootDir"\s*:\s*"\.\.\/\.\."/.test(source)) failures.push(`${name}: emits a monorepo-shaped output tree`)
  if (/dist\/examples\/.+\/src\//.test(source)) failures.push(`${name}: starts a monorepo-shaped build output`)
  if (/(?:--workspace|-w) @purista\//.test(source)) failures.push(`${name}: requires a sibling workspace to run`)

  if (file.endsWith('package.json')) {
    const manifest = JSON.parse(source)
    for (const script of ['build', 'test', 'typecheck']) {
      if (typeof manifest.scripts?.[script] !== 'string' || manifest.scripts[script].trim() === '') {
        failures.push(`${name}: runnable example needs a ${script} script`)
      }
    }
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dependency, version] of Object.entries(manifest[field] ?? {})) {
        if (dependency.startsWith('@purista/') && /^(?:file|link|workspace):/.test(version)) {
          failures.push(`${name}: ${field}.${dependency} must use the published package version`)
        }
      }
    }
  }
}

const removedApiPatterns = [
  ['defineHarnessModule', /\bdefineHarnessModule\b/],
  ['HarnessBuilder', /\bHarnessBuilder\b/],
  ['BuilderState', /\bBuilderState\b/],
  ['empty defineHarness()', /\bdefineHarness\s*\(\s*\)/],
  ['one-argument defineAgent({...})', /\bdefineAgent\s*\(\s*\{/],
  ['one-argument defineWorkflow({...})', /\bdefineWorkflow\s*\(\s*\{/],
  ['fluent registration or build', /\.(?:agent|agents|workflow|workflows|tool|tools|skill|skills|models|memory|sandbox|storage|telemetry|logger|build)\s*\(/],
  ['removed Harness shutdown', /(?:\b\w+\.)*harness\.shutdown\s*\(/],
]

const docsFiles = await files(join(repositoryRoot, 'docs'))
const skillFiles = await files(join(repositoryRoot, 'skills', 'ai-harness'))
const packageDirectories = await readdir(join(repositoryRoot, 'packages'), { withFileTypes: true })
const packageReadmes = packageDirectories
  .filter(entry => entry.isDirectory())
  .map(entry => join(repositoryRoot, 'packages', entry.name, 'README.md'))
const knowledgeFiles = [join(repositoryRoot, 'README.md'), ...docsFiles, ...skillFiles, ...packageReadmes]

for (const file of [...exampleFiles.filter(path => codeExtensions.has(extname(path))), ...knowledgeFiles]) {
  if (!codeExtensions.has(extname(file)) && extname(file) !== '.md' && extname(file) !== '.svg') continue
  if (relative(repositoryRoot, file).startsWith('docs/releases/')) continue
  const source = await readFile(file, 'utf8').catch(() => undefined)
  if (source === undefined) continue
  for (const [label, pattern] of removedApiPatterns) {
    if (pattern.test(source)) failures.push(`${relative(repositoryRoot, file)}: teaches removed v3 API (${label})`)
  }
}

const definitionIdPattern = /^[a-z][A-Za-z0-9]{0,63}$/
const skillIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const literalDefinitionPattern = /\bdefine(?:Tool|McpServer|Agent|Workflow|Catalog)\s*\(\s*(['"])([^'"]+)\1/g
const literalSkillPattern = /\bdefineSkill\s*\(\s*(['"])([^'"]+)\1/g
const literalHarnessNamePattern = /\bdefineHarness\s*\(\s*\{[\s\S]{0,240}?\bname\s*:\s*(['"])([^'"]+)\1/g

for (const file of [...exampleFiles.filter(path => codeExtensions.has(extname(path))), ...knowledgeFiles]) {
  if (!codeExtensions.has(extname(file)) && extname(file) !== '.md') continue
  if (relative(repositoryRoot, file).startsWith('docs/releases/')) continue
  const source = await readFile(file, 'utf8').catch(() => undefined)
  if (source === undefined) continue
  for (const pattern of [literalDefinitionPattern, literalHarnessNamePattern]) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      const id = match[2]
      if (!definitionIdPattern.test(id)) {
        failures.push(`${relative(repositoryRoot, file)}: invalid literal v4 definition id ${JSON.stringify(id)}`)
      }
    }
  }
  literalSkillPattern.lastIndex = 0
  for (const match of source.matchAll(literalSkillPattern)) {
    const id = match[2]
    if (id.length > 64 || !skillIdPattern.test(id)) {
      failures.push(`${relative(repositoryRoot, file)}: invalid literal Agent Skill id ${JSON.stringify(id)}`)
    }
  }
}

for (const manifestPath of manifests) {
  const readmePath = join(dirname(manifestPath), 'README.md')
  const name = relative(repositoryRoot, readmePath)
  const readme = await readFile(readmePath, 'utf8').catch(() => undefined)
  if (readme === undefined) failures.push(`${name}: runnable example needs setup instructions`)
  else if (!/\bnpm install\b/.test(readme)) failures.push(`${name}: setup must install published dependencies from npm`)
}

const quickstartPath = join(examplesRoot, 'quickstart', 'src', 'index.ts')
const quickstart = await readFile(quickstartPath, 'utf8')
for (const [label, pattern, expected] of [
  ['defineAgent', /\bdefineAgent\s*\(/g, 1],
  ['defineHarness', /\bdefineHarness\s*\(/g, 1],
  ['addAgent', /\.addAgent\s*\(/g, 1],
  ['getInstance', /\.getInstance\s*\(/g, 1],
]) {
  const count = quickstart.match(pattern)?.length ?? 0
  if (count !== expected) failures.push(`examples/quickstart/src/index.ts: expected ${expected} ${label} call, found ${count}`)
}
if (/\bdefine(?:Workflow|Tool|Catalog|Skill|McpServer)\s*\(/.test(quickstart)) {
  failures.push('examples/quickstart/src/index.ts: quickstart must contain only one agent definition')
}
if (!/\.getInstance\s*\(\s*\{\s*model\s*:/.test(quickstart)) {
  failures.push('examples/quickstart/src/index.ts: quickstart needs one direct model runtime binding')
}

const markdownFiles = [...new Set([
  join(repositoryRoot, 'README.md'),
  ...exampleFiles.filter(file => extname(file) === '.md'),
  ...docsFiles.filter(file => extname(file) === '.md'),
  ...skillFiles.filter(file => extname(file) === '.md'),
  ...packageReadmes,
])]
for (const file of markdownFiles) {
  const source = await readFile(file, 'utf8').catch(() => undefined)
  if (source === undefined) continue
  const prose = source.replace(/```[\s\S]*?```/g, '')
  const targets = [
    ...[...prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]),
    ...[...prose.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)].map(match => match[1]),
  ]
  for (const rawTarget of targets) {
    const wrapped = rawTarget.trim().match(/^<([^>]+)>/)
    const target = (wrapped?.[1] ?? rawTarget.trim().split(/\s+/)[0]).split('#')[0].split('?')[0]
    if (target === '' || target.startsWith('/') || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    let decoded
    try { decoded = decodeURIComponent(target) } catch { failures.push(`${relative(repositoryRoot, file)}: invalid encoded link ${target}`); continue }
    await access(resolve(dirname(file), decoded)).catch(() => failures.push(`${relative(repositoryRoot, file)}: broken local link ${target}`))
  }
}

assert.deepEqual(failures, [], `Example and documentation boundary violations:\n${failures.join('\n')}`)
process.stdout.write('Verified public example boundaries, v4 usage, runnable scripts, and local documentation links.\n')
