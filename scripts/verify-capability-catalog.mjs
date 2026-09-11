import { access, readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { verifyPackageBoundaries } from './package-boundaries.mjs'

const root = process.cwd()
const sourcePath = resolve(root, 'architecture/capability-catalog.yaml')
const outputPath = resolve(root, 'architecture/capability-catalog.generated.json')
const source = JSON.parse(await readFile(sourcePath, 'utf8'))

if (source.version !== 1 || !Array.isArray(source.families)) {
  throw new Error('Capability catalog must contain version 1 and a families array.')
}
for (const family of source.families) {
  for (const field of ['id', 'owner', 'port', 'provider', 'consumer', 'conformance']) {
    if (typeof family[field] !== 'string' || family[field].length === 0) {
      throw new Error(`Capability family is missing ${field}.`)
    }
  }
  await access(resolve(root, family.consumer))
}

const normalized = {
  version: source.version,
  families: [...source.families]
    .map((family) => Object.fromEntries(Object.entries(family).sort(([left], [right]) => left.localeCompare(right))))
    .sort((left, right) => left.id.localeCompare(right.id))
}
const generated = JSON.stringify(normalized, null, 2) + '\n'
const checked = await readFile(outputPath, 'utf8')
if (checked !== generated) {
  throw new Error('Capability catalog is stale. Update architecture/capability-catalog.generated.json.')
}

const packageDirectories = await readdir(resolve(root, 'packages'), { withFileTypes: true })
const manifests = await Promise.all(packageDirectories.filter((entry) => entry.isDirectory()).map(async (entry) => {
  const manifest = JSON.parse(await readFile(resolve(root, 'packages', entry.name, 'package.json'), 'utf8'))
  return manifest
}))
verifyPackageBoundaries(manifests)

console.log(`Verified ${normalized.families.length} capability family entries.`)
