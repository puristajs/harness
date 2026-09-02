#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const examplesRoot = fileURLToPath(new URL('../examples/', import.meta.url))
const ignoredDirectories = new Set(['dist', 'node_modules', 'coverage'])
const sourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md'])

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
for (const file of exampleFiles) {
  const name = relative(repositoryRoot, file)
  const extension = file.slice(file.lastIndexOf('.'))
  if (!sourceExtensions.has(extension)) continue
  const source = await readFile(file, 'utf8')

  if (/packages\/.+\/src/.test(source)) failures.push(`${name}: bypasses a published package export`)
  if (/"rootDir"\s*:\s*"\.\.\/\.\."/.test(source)) failures.push(`${name}: emits a monorepo-shaped output tree`)
  if (/dist\/examples\/.+\/src\//.test(source)) failures.push(`${name}: starts a monorepo-shaped build output`)
  if (/(?:--workspace|-w) @purista\//.test(source)) failures.push(`${name}: requires a sibling workspace to run`)

  if (file.endsWith('package.json')) {
    const manifest = JSON.parse(source)
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dependency, version] of Object.entries(manifest[field] ?? {})) {
        if (dependency.startsWith('@purista/') && /^(?:file|link|workspace):/.test(version)) {
          failures.push(`${name}: ${field}.${dependency} must use the published package version`)
        }
      }
    }
  }
}

for (const manifestPath of exampleFiles.filter(file => file.endsWith('package.json'))) {
  const readmePath = join(dirname(manifestPath), 'README.md')
  const name = relative(repositoryRoot, readmePath)
  const readme = await readFile(readmePath, 'utf8').catch(() => undefined)
  if (readme === undefined) failures.push(`${name}: runnable example needs setup instructions`)
  else if (!/\bnpm install\b/.test(readme)) failures.push(`${name}: setup must install published dependencies from npm`)
}

assert.deepEqual(failures, [], `Example package-boundary violations:\n${failures.join('\n')}`)
process.stdout.write('Verified that Harness examples consume public package exports.\n')
