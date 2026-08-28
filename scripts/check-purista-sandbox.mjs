import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const harnessRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRoot = resolve(harnessRoot, '..')
const puristaRoot = join(workspaceRoot, 'purista')
const verificationDirectory = '.sandbox-verification'
const supportedModes = new Set(['source', 'consumer', 'docs'])

function cancelledError() {
	return new Error('Sandbox package verification was cancelled.')
}

function commandError(command, status) {
	return new Error(`Sandbox package verification command ${command} failed with exit code ${status}.`)
}

function assertNotCancelled(signal) {
	if (signal?.aborted) throw cancelledError()
}

function classifyFailure(error) {
	if (error instanceof Error && error.message === 'Sandbox package verification was cancelled.') return 'cancelled'
	if (error instanceof Error && error.message.includes('failed with exit code')) return 'child_command_failed'
	return 'verification_failed'
}

function attachFailureDetail(error, name, value) {
	if (typeof error === 'object' && error !== null) {
		Object.defineProperty(error, name, { configurable: true, enumerable: true, value })
	}
}

/** Creates the only directory layout the verifier is allowed to write. */
export function createVerificationLayout(root = harnessRoot) {
	const verificationRoot = resolve(root, verificationDirectory)
	return {
		root: verificationRoot,
		cache: join(verificationRoot, 'npm-cache'),
		evidence: join(root, 'plans/sandbox-ownership/evidence'),
	}
}

/** Rejects cleanup targets outside a verifier invocation's unique scratch tree. */
export function assertOwnedScratchDirectory(layout, scratchDirectory) {
	const resolved = resolve(scratchDirectory)
	const contained = relative(layout.root, resolved)
	if (contained.startsWith('..')) throw new Error('Scratch directory is outside the verification root.')
	if (!contained.startsWith('run-') || contained.includes('/')) throw new Error('Scratch directory is not an invocation scratch directory.')
}

/** Requires cache provisioning to be an explicit local setup step. */
export async function requireOfflineCache(cacheDirectory) {
	try {
		const entries = await readdir(cacheDirectory)
		if (!entries.includes('_cacache')) throw new Error('missing npm cache data')
	} catch {
		throw new Error(`The offline npm cache is missing or empty: ${cacheDirectory}`)
	}
}

/** Builds the only npm argument shape permitted for verification children. */
export function npmVerificationArguments(layout, command, args = []) {
	return ['--offline', '--cache', layout.cache, command, ...args]
}

/** Runs a guarded child command and returns captured output only when requested. */
export function runCheckedCommand(command, args, { cwd, env, signal, captureOutput = false } = {}) {
	assertNotCancelled(signal)
	try {
		const output = execFileSync(command, args, {
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
			encoding: captureOutput ? 'utf8' : undefined,
			stdio: captureOutput ? 'pipe' : 'inherit',
			signal,
		})
		assertNotCancelled(signal)
		return captureOutput ? output : undefined
	} catch (error) {
		if (signal?.aborted) throw cancelledError()
		const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
			? error.status
			: 'unknown'
		throw commandError(command, status)
	}
}

/** Records only content-free verifier failure state for controller-owned evidence. */
export async function writeFailureEvidence(layout, { failure, cleanupFailure }) {
	await mkdir(layout.evidence, { recursive: true })
	const evidence = {
		kind: 'sandbox_packed_verification_failure',
		failure: failure ? classifyFailure(failure) : 'cleanup_failed',
		cleanup: cleanupFailure ? 'incomplete' : 'complete',
	}
	await writeFile(join(layout.evidence, `packed-purista-verification-${randomUUID()}.json`), `${JSON.stringify(evidence)}\n`)
}

/** Creates one exact cleanup target and preserves the original failure if cleanup also fails. */
export async function withVerificationScratch(layout, operation, {
	removeDirectory = rm,
	recordFailure = writeFailureEvidence,
} = {}) {
	await mkdir(layout.root, { recursive: true })
	const scratchDirectory = await mkdtemp(join(layout.root, 'run-'))
	assertOwnedScratchDirectory(layout, scratchDirectory)
	let result
	let failure
	try {
		result = await operation(scratchDirectory)
	} catch (error) {
		failure = error
	}
	let cleanupFailure
	try {
		await removeDirectory(scratchDirectory, { recursive: true, force: true })
	} catch (error) {
		cleanupFailure = error
	}
	if (failure || cleanupFailure) {
		try {
			await recordFailure(layout, { failure, cleanupFailure })
		} catch {
			attachFailureDetail(failure ?? cleanupFailure, 'sandboxVerificationEvidence', 'unavailable')
		}
	}
	if (cleanupFailure && failure) attachFailureDetail(failure, 'sandboxVerificationCleanup', 'incomplete')
	if (failure) throw failure
	if (cleanupFailure) throw cleanupFailure
	return result
}

/** Allows only the published Harness package entrypoint in verifier fixtures. */
export function assertPublicHarnessSpecifier(specifier) {
	if (specifier.startsWith('.') || specifier.includes('/packages/harness/')) {
		throw new Error('Harness source alias is not permitted in package verification.')
	}
	if (specifier !== '@purista/harness') throw new Error('Harness fixtures must use the public package entrypoint.')
}

/** Copies a fixture only after validating every Harness import it declares. */
export async function copyPublicFixture(source, destination) {
	const content = await readFile(source, 'utf8')
	const importPattern = /\b(?:import|export)\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g
	for (const match of content.matchAll(importPattern)) {
		const specifier = match[1]
		if (specifier === '@purista/harness' || specifier.startsWith('@purista/harness/') || specifier.includes('/packages/harness/')) {
			assertPublicHarnessSpecifier(specifier)
		}
	}
	await writeFile(destination, content)
}

function parseMode(argumentsList) {
	if (argumentsList.length !== 2 || argumentsList[0] !== '--mode' || !supportedModes.has(argumentsList[1])) {
		throw new Error('Usage: node ai-harness/scripts/check-purista-sandbox.mjs --mode <source|consumer|docs>')
	}
	return argumentsList[1]
}

async function readJson(path) {
	return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function installArguments(layout) {
	return npmVerificationArguments(layout, 'install', ['--ignore-scripts', '--no-audit', '--no-fund'])
}

async function packPackageDirectory(destination, { cwd, layout, signal }) {
	const packed = JSON.parse(runCheckedCommand('npm', npmVerificationArguments(layout, 'pack', [
		'--ignore-scripts', '--json', '--pack-destination', destination,
	]), { cwd, signal, captureOutput: true }))
	const [entry] = packed
	if (!entry?.filename) throw new Error(`Packing ${cwd} did not produce a tarball.`)
	return join(destination, entry.filename)
}

async function buildAndPackHarness(scratchDirectory, layout, signal) {
	const harnessPackageRoot = join(harnessRoot, 'packages/harness')
	runCheckedCommand('npm', npmVerificationArguments(layout, 'run', ['build']), { cwd: harnessPackageRoot, signal })
	const tarballs = join(scratchDirectory, 'tarballs')
	await mkdir(tarballs)
	const tarball = await packPackageDirectory(tarballs, { cwd: harnessPackageRoot, layout, signal })
	const manifest = await readJson(join(harnessRoot, 'packages/harness/package.json'))
	return { manifest, tarball }
}

/** Rejects an ambient or stale Harness resolution after a scratch-only install. */
export async function assertInstalledHarness(root, expected) {
	const installed = await readJson(join(root, 'node_modules/@purista/harness/package.json'))
	if (installed.name !== '@purista/harness' || installed.version !== expected.version) {
		throw new Error('The staged Core did not resolve the packed local @purista/harness package.')
	}
	if (expected.tarball) {
		const lock = await readJson(join(root, 'package-lock.json'))
		const resolutions = Object.entries(lock.packages ?? {})
			.filter(([path]) => path.endsWith('node_modules/@purista/harness'))
			.map(([, value]) => value?.resolved)
		const expectedTarball = basename(expected.tarball)
		if (!resolutions.some(resolution => typeof resolution === 'string' && resolution.startsWith('file:') && resolution.endsWith(expectedTarball))) {
			throw new Error('The staged Core did not resolve the packed local @purista/harness package.')
		}
	}
}

async function stageCoreSource(scratchDirectory, harnessTarball) {
	const stagedRoot = join(scratchDirectory, 'purista')
	const stagedCore = join(stagedRoot, 'packages/core')
	await cp(join(puristaRoot, 'packages/core'), stagedCore, {
		recursive: true,
		filter: source => !source.includes('/node_modules/') && !source.includes('/dist/'),
	})
	for (const config of ['tsconfig.json', 'vitest.config.unit.ts', 'vitest.workspaceAliases.ts']) {
		await cp(join(puristaRoot, config), join(stagedRoot, config))
	}
	await cp(join(puristaRoot, 'test/service'), join(stagedRoot, 'test/service'), {
		recursive: true,
		filter: source => !source.includes('/node_modules/') && !source.includes('/dist/'),
	})
	const coreManifestPath = join(stagedCore, 'package.json')
	const coreManifest = await readJson(coreManifestPath)
	coreManifest.dependencies['@purista/harness'] = `file:${relative(stagedCore, harnessTarball)}`
	await writeJson(coreManifestPath, coreManifest)
	await writeJson(join(stagedRoot, 'package.json'), {
		name: 'purista-sandbox-source-check', private: true, type: 'module', workspaces: ['packages/core'],
		devDependencies: {
			'@types/node': coreManifest.devDependencies['@types/node'],
			typescript: (await readJson(join(puristaRoot, 'package.json'))).devDependencies.typescript,
			vitest: coreManifest.devDependencies.vitest,
		},
	})
	await copyPublicFixture(join(harnessRoot, 'scripts/fixtures/purista-sandbox-source.ts'), join(stagedCore, 'src/purista-sandbox-source.ts'))
	return { stagedRoot, stagedCore }
}

function compilerPath(root) {
	return join(root, 'node_modules/typescript/lib/tsc.js')
}

function vitestPath(root) {
	return join(root, 'node_modules/vitest/vitest.mjs')
}

async function runSourceMode(layout, scratchDirectory, harness, signal) {
	const { stagedRoot, stagedCore } = await stageCoreSource(scratchDirectory, harness.tarball)
	runCheckedCommand('npm', installArguments(layout), { cwd: stagedRoot, signal })
	await assertInstalledHarness(stagedRoot, { ...harness.manifest, tarball: harness.tarball })
	runCheckedCommand(process.execPath, [compilerPath(stagedRoot), '--noEmit', '-p', join(stagedCore, 'tsconfig.json')], { cwd: stagedRoot, signal })
	runCheckedCommand(process.execPath, [vitestPath(stagedRoot), '--config', join(stagedRoot, 'vitest.config.unit.ts'), 'run', 'packages/core/src/AgentQueueBuilder/agentQueueBuilder.test.ts'], { cwd: stagedRoot, signal })
}

async function runConsumerMode(layout, scratchDirectory, harness, signal) {
	const { stagedRoot, stagedCore } = await stageCoreSource(scratchDirectory, harness.tarball)
	runCheckedCommand('npm', installArguments(layout), { cwd: stagedRoot, signal })
	await assertInstalledHarness(stagedRoot, { ...harness.manifest, tarball: harness.tarball })
	runCheckedCommand('npm', npmVerificationArguments(layout, 'run', ['build', '--workspace', '@purista/core']), { cwd: stagedRoot, signal })
	const tarballs = join(scratchDirectory, 'tarballs')
	const coreTarball = await packPackageDirectory(tarballs, { cwd: stagedCore, layout, signal })
	const consumerRoot = join(scratchDirectory, 'consumer')
	await mkdir(consumerRoot)
	await writeJson(join(consumerRoot, 'package.json'), {
		name: 'purista-sandbox-public-consumer', private: true, type: 'module',
		dependencies: {
			'@purista/core': `file:${relative(consumerRoot, coreTarball)}`,
			'@purista/harness': `file:${relative(consumerRoot, harness.tarball)}`,
		},
		devDependencies: {
			'@types/node': harness.manifest.devDependencies['@types/node'],
			typescript: (await readJson(join(puristaRoot, 'package.json'))).devDependencies.typescript,
		},
	})
	await writeJson(join(consumerRoot, 'tsconfig.json'), {
		compilerOptions: {
			target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
			exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, noEmit: true,
			skipLibCheck: false, types: ['node'],
		}, include: ['consumer.ts'],
	})
	await copyPublicFixture(join(harnessRoot, 'scripts/fixtures/purista-sandbox-consumer.ts'), join(consumerRoot, 'consumer.ts'))
	runCheckedCommand('npm', installArguments(layout), { cwd: consumerRoot, signal })
	await assertInstalledHarness(consumerRoot, { ...harness.manifest, tarball: harness.tarball })
	runCheckedCommand(process.execPath, [compilerPath(consumerRoot), '-p', 'tsconfig.json'], { cwd: consumerRoot, signal })
	runCheckedCommand(process.execPath, ['consumer.ts'], { cwd: consumerRoot, signal })
}

function copyablePuristaSource(source) {
	const normalized = source.replaceAll('\\', '/')
	return !normalized.includes('/node_modules/') && !normalized.includes('/.git/') && !normalized.includes('/dist/')
		&& !normalized.includes('/coverage/') && !normalized.endsWith('/.env') && !normalized.includes('/.env.')
}

async function runDocsMode(layout, scratchDirectory, harness, signal) {
	const stagedRoot = join(scratchDirectory, 'purista')
	await cp(puristaRoot, stagedRoot, { filter: copyablePuristaSource })
	const coreManifestPath = join(stagedRoot, 'packages/core/package.json')
	const coreManifest = await readJson(coreManifestPath)
	coreManifest.dependencies['@purista/harness'] = `file:${relative(join(stagedRoot, 'packages/core'), harness.tarball)}`
	await writeJson(coreManifestPath, coreManifest)
	runCheckedCommand('npm', installArguments(layout), { cwd: stagedRoot, signal })
	await assertInstalledHarness(stagedRoot, { ...harness.manifest, tarball: harness.tarball })
	runCheckedCommand('npm', npmVerificationArguments(layout, 'run', ['build', '--workspace', '@purista/core']), { cwd: stagedRoot, signal })
	runCheckedCommand('npm', npmVerificationArguments(layout, 'run', ['build:api-docs']), { cwd: stagedRoot, signal })
	runCheckedCommand('npm', npmVerificationArguments(layout, 'run', ['build', '--workspace', '@purista/web']), { cwd: stagedRoot, signal })
	runCheckedCommand('npm', npmVerificationArguments(layout, 'run', ['audit:handbook']), { cwd: stagedRoot, signal })
}

export async function runPuristaSandboxVerification(mode, { root = harnessRoot, signal, steps = {} } = {}) {
	if (!supportedModes.has(mode)) throw new Error(`Unsupported sandbox verification mode: ${mode}`)
	assertNotCancelled(signal)
	const layout = createVerificationLayout(root)
	await requireOfflineCache(layout.cache)
	const selectedSteps = {
		buildAndPackHarness,
		runSourceMode,
		runConsumerMode,
		runDocsMode,
		...steps,
	}
	return withVerificationScratch(layout, async scratchDirectory => {
		const harness = await selectedSteps.buildAndPackHarness(scratchDirectory, layout, signal)
		assertNotCancelled(signal)
		if (mode === 'source') return selectedSteps.runSourceMode(layout, scratchDirectory, harness, signal)
		if (mode === 'consumer') return selectedSteps.runConsumerMode(layout, scratchDirectory, harness, signal)
		return selectedSteps.runDocsMode(layout, scratchDirectory, harness, signal)
	})
}

async function main() {
	const mode = parseMode(process.argv.slice(2))
	await runPuristaSandboxVerification(mode)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch(error => {
		console.error(error instanceof Error ? error.message : 'Sandbox package verification failed.')
		process.exitCode = 1
	})
}
