import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const verificationWorkspaces = [
	'packages/harness',
	'packages/harness-sandbox-docker',
	'packages/harness-sandbox-kubernetes',
	'packages/harness-storage-postgres',
]

function resolveDependencyEntry(packages, parentPath, dependencyName) {
	let parent = parentPath
	while (true) {
		const candidate = parent ? `${parent}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`
		if (packages[candidate]) return candidate
		const boundary = parent.lastIndexOf('/node_modules/')
		if (boundary < 0) {
			if (!parent) return undefined
			parent = ''
		} else {
			parent = parent.slice(0, boundary)
		}
	}
}

function packageName(entryPath) {
	return entryPath.slice(entryPath.lastIndexOf('node_modules/') + 'node_modules/'.length)
}

/** Returns the exact locked registry version used by generated offline consumers. */
export function lockedRegistryVersion(lock, dependencyName) {
	const entryPath = resolveDependencyEntry(lock.packages ?? {}, '', dependencyName)
	if (!entryPath) throw new Error(`Offline verification dependency ${dependencyName} is missing from package-lock.json.`)
	const entry = lock.packages[entryPath]
	if (typeof entry?.version !== 'string' || typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) {
		throw new Error(`Offline verification dependency ${entryPath} is not pinned to the npm registry.`)
	}
	return entry.version
}

/** Returns the exact registry package closure needed by packed release consumers. */
export function collectOfflineVerificationSpecs(lock, rootDependencies) {
	const packages = lock.packages ?? {}
	const pending = [...rootDependencies].map(name => {
		const entry = resolveDependencyEntry(packages, '', name)
		if (!entry) throw new Error(`Offline verification dependency ${name} is missing from package-lock.json.`)
		return entry
	})
	const visited = new Set()
	const specs = new Set()
	while (pending.length) {
		const entryPath = pending.shift()
		if (!entryPath || visited.has(entryPath)) continue
		visited.add(entryPath)
		const entry = packages[entryPath]
		if (typeof entry?.version !== 'string' || typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) {
			throw new Error(`Offline verification dependency ${entryPath} is not pinned to the npm registry.`)
		}
		specs.add(`${packageName(entryPath)}@${entry.version}`)
		const dependencies = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies }
		for (const dependencyName of Object.keys(dependencies)) {
			if (entry.peerDependenciesMeta?.[dependencyName]?.optional) continue
			const dependency = resolveDependencyEntry(packages, entryPath, dependencyName)
			if (dependency) pending.push(dependency)
		}
	}
	return [...specs].sort()
}

/** Returns an exact dependency map that keeps generated offline consumers on the cached graph. */
export function collectOfflineVerificationDependencies(lock, rootDependencies) {
	const dependencies = {}
	for (const spec of collectOfflineVerificationSpecs(lock, rootDependencies)) {
		const separator = spec.lastIndexOf('@')
		const name = spec.slice(0, separator)
		const version = spec.slice(separator + 1)
		if (dependencies[name] && dependencies[name] !== version) {
			throw new Error(`Offline verification dependency ${name} resolves to multiple versions.`)
		}
		dependencies[name] = version
	}
	return dependencies
}

async function rootDependencies(root) {
	const names = new Set(['@types/node'])
	for (const workspace of verificationWorkspaces) {
		const manifest = JSON.parse(await readFile(join(root, workspace, 'package.json'), 'utf8'))
		for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
			if (!name.startsWith('@purista/')) names.add(name)
		}
		for (const name of Object.keys(manifest.peerDependencies ?? {})) {
			if (!name.startsWith('@purista/') && !manifest.peerDependenciesMeta?.[name]?.optional) names.add(name)
		}
	}
	return names
}

/** Returns the exact registry graph used by the offline package consumers. */
export async function offlineVerificationDependencies(root = defaultRoot) {
	const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
	return collectOfflineVerificationDependencies(lock, await rootDependencies(root))
}

/** Primes registry manifests and tarballs before packed verifiers switch npm to offline mode. */
export async function prepareOfflineVerificationCache(root = defaultRoot, { addPackage } = {}) {
	const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
	const specs = collectOfflineVerificationSpecs(lock, await rootDependencies(root))
	const cache = join(root, '.sandbox-verification/npm-cache')
	const add = addPackage ?? (spec => execFileAsync('npm', ['cache', 'add', spec, '--cache', cache], { cwd: root }))
	for (let index = 0; index < specs.length; index += 8) await Promise.all(specs.slice(index, index + 8).map(add))
	return specs
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	const specs = await prepareOfflineVerificationCache()
	process.stdout.write(`Prepared ${specs.length} packages for offline release verification.\n`)
}
