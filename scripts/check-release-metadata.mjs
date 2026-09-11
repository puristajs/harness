import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const dependencyKinds = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const requiredFiles = ['package.json', 'README.md', 'LICENSE']

export function verifyReleaseMetadata({ root, rootManifest, workspaces, platformPackages, lockfile }) {
	const errors = []
	const core = workspaces.find(({ manifest }) => manifest.name === '@purista/harness')
	if (!core) errors.push('Missing @purista/harness workspace.')
	const releaseVersion = core?.manifest.version

	for (const { directory, manifest, publishable } of workspaces) {
		if (releaseVersion && manifest.version !== releaseVersion) {
			errors.push(`${manifest.name} has version ${manifest.version}; expected ${releaseVersion}.`)
		}

		for (const kind of dependencyKinds) {
			for (const [name, range] of Object.entries(manifest[kind] ?? {})) {
				if (name === '@purista/harness' || name.startsWith('@purista/harness-')) {
					const expected = `^${releaseVersion}`
					if (range !== expected) errors.push(`${manifest.name} ${kind}.${name} is ${range}; expected ${expected}.`)
				}
			}
		}

		const lockEntry = lockfile.packages?.[relative(root, directory)]
		if (lockEntry?.version !== manifest.version) {
			errors.push(`${manifest.name} lockfile version is ${lockEntry?.version ?? 'missing'}; expected ${manifest.version}.`)
		}

		if (!publishable) continue
		if (manifest.private === true) errors.push(`${manifest.name} is unexpectedly private.`)
		if (manifest.publishConfig?.access !== 'public') errors.push(`${manifest.name} must publish with public access.`)
		if (manifest.license !== 'Apache-2.0') errors.push(`${manifest.name} must declare Apache-2.0.`)
		if (manifest.engines?.node !== rootManifest.engines?.node) errors.push(`${manifest.name} must use the root Node.js engine.`)
		if (manifest.repository?.directory !== relative(root, directory)) errors.push(`${manifest.name} has incorrect repository.directory.`)
		if (manifest.bugs?.url !== 'https://github.com/puristajs/harness/issues') errors.push(`${manifest.name} has incorrect bugs metadata.`)
		if (typeof manifest.homepage !== 'string' || manifest.homepage.length === 0) errors.push(`${manifest.name} is missing homepage metadata.`)
		for (const filename of requiredFiles) {
			if (!manifest.files?.includes(filename)) errors.push(`${manifest.name} files must include ${filename}.`)
			if (!existsSync(join(directory, filename))) errors.push(`${manifest.name} is missing ${filename}.`)
		}
	}

	for (const { directory, manifest } of platformPackages) {
		if (releaseVersion && manifest.version !== releaseVersion) {
			errors.push(`${manifest.name} has version ${manifest.version}; expected ${releaseVersion}.`)
		}
		if (manifest.publishConfig?.access !== 'public') errors.push(`${manifest.name} must publish with public access.`)
		if (manifest.license !== 'Apache-2.0') errors.push(`${manifest.name} must declare Apache-2.0.`)
		if (manifest.engines?.node !== rootManifest.engines?.node) errors.push(`${manifest.name} must use the root Node.js engine.`)
		if (!existsSync(join(directory, 'LICENSE'))) errors.push(`${manifest.name} is missing LICENSE.`)
	}

	if (errors.length > 0) throw new Error(`Release metadata verification failed:\n- ${errors.join('\n- ')}`)
	return { releaseVersion, workspaceCount: workspaces.length, publishableCount: workspaces.filter(entry => entry.publishable).length, platformCount: platformPackages.length }
}

function readJson(filename) {
	return JSON.parse(readFileSync(filename, 'utf8'))
}

export function loadReleaseMetadata(root) {
	const workspaces = []
	for (const base of ['packages', 'examples']) {
		for (const name of readdirSync(join(root, base)).sort()) {
			const directory = join(root, base, name)
			const manifestPath = join(directory, 'package.json')
			if (!existsSync(manifestPath)) continue
			const manifest = readJson(manifestPath)
			workspaces.push({ directory, manifest, publishable: base === 'packages' && manifest.private !== true })
		}
	}

	const platformRoot = join(root, 'packages/harness-guardrails-native-privacy/npm')
	const platformPackages = readdirSync(platformRoot).sort().map(name => {
		const directory = join(platformRoot, name)
		return { directory, manifest: readJson(join(directory, 'package.json')) }
	})

	return {
		root,
		rootManifest: readJson(join(root, 'package.json')),
		workspaces,
		platformPackages,
		lockfile: readJson(join(root, 'package-lock.json')),
	}
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		const root = resolve(dirname(scriptPath), '..')
		const result = verifyReleaseMetadata(loadReleaseMetadata(root))
		console.log(`Release metadata is aligned at ${result.releaseVersion}: ${result.workspaceCount} workspaces, ${result.publishableCount} public packages, ${result.platformCount} native platform packages.`)
	} catch (error) {
		console.error(error instanceof Error ? error.message : 'Release metadata verification failed.')
		process.exitCode = 1
	}
}
