import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
	assertOwnedScratchDirectory,
	assertInstalledHarness,
	assertPublicHarnessSpecifier,
	copyPublicFixture,
	createVerificationLayout,
	npmVerificationArguments,
	requireOfflineCache,
	runCheckedCommand,
	runPuristaSandboxVerification,
	withVerificationScratch,
} from './check-purista-sandbox.mjs'

async function temporaryRoot() {
	return mkdtemp(join(tmpdir(), 'purista-sandbox-verification-test-'))
}

test('requires an explicitly populated workspace-local offline cache', async () => {
	const root = await temporaryRoot()
	const layout = createVerificationLayout(root)

	await assert.rejects(requireOfflineCache(layout.cache), /offline npm cache is missing or empty/i)

	await mkdir(layout.cache, { recursive: true })
	await writeFile(join(layout.cache, 'cache-marker'), 'cached')
	await assert.rejects(requireOfflineCache(layout.cache), /offline npm cache is missing or empty/i)
	await mkdir(join(layout.cache, '_cacache'))
	await assert.doesNotReject(requireOfflineCache(layout.cache))
})

test('creates and removes only its exact workspace-local scratch directory', async () => {
	const root = await temporaryRoot()
	const layout = createVerificationLayout(root)
	await mkdir(layout.root, { recursive: true })
	const preserved = join(layout.root, 'preserved')
	await mkdir(preserved)

	let scratch
	await withVerificationScratch(layout, async directory => {
		scratch = directory
		assertOwnedScratchDirectory(layout, directory)
		await writeFile(join(directory, 'proof.txt'), 'created by this invocation')
	})

	assert.ok(scratch)
	assert.deepEqual(await readdir(layout.root), ['preserved'])
	assert.throws(() => assertOwnedScratchDirectory(layout, layout.root), /not an invocation scratch directory/i)
	assert.throws(() => assertOwnedScratchDirectory(layout, join(layout.root, 'run-another', 'child')), /not an invocation scratch directory/i)
	assert.throws(() => assertOwnedScratchDirectory(layout, join(layout.root, '..', 'escape')), /outside the verification root/i)
})

test('rejects source aliases and private Harness subpaths in staged fixtures', () => {
	assert.doesNotThrow(() => assertPublicHarnessSpecifier('@purista/harness'))
	assert.throws(() => assertPublicHarnessSpecifier('@purista/harness/src/sandbox/index.js'), /public package entrypoint/i)
	assert.throws(() => assertPublicHarnessSpecifier('../../packages/harness/src/index.ts'), /source alias/i)
})

test('rejects a non-public Harness fixture before staging it', async () => {
	const root = await temporaryRoot()
	const source = join(root, 'source.ts')
	const destination = join(root, 'destination.ts')
	await writeFile(source, "import { inMemorySandbox } from '@purista/harness/src/sandbox/index.js'\nvoid inMemorySandbox\n")

	await assert.rejects(copyPublicFixture(source, destination), /public package entrypoint/i)
})

test('applies offline workspace-cache arguments to package installs and packs', () => {
	const layout = createVerificationLayout('/workspace/ai-harness')
	for (const command of [
		npmVerificationArguments(layout, 'install', ['--ignore-scripts', '--no-audit', '--no-fund']),
		npmVerificationArguments(layout, 'run', ['build']),
		npmVerificationArguments(layout, 'pack', ['--ignore-scripts', '--json']),
	]) {
		assert.deepEqual(command.slice(0, 3), ['--offline', '--cache', layout.cache])
	}
	assert.deepEqual(npmVerificationArguments(layout, 'pack', ['--ignore-scripts', '--json']).slice(3), ['pack', '--ignore-scripts', '--json'])
})

test('rejects a stale installed Harness version instead of accepting the manifest range', async () => {
	const root = await temporaryRoot()
	const manifestDirectory = join(root, 'node_modules/@purista/harness')
	await mkdir(manifestDirectory, { recursive: true })
	await writeFile(join(manifestDirectory, 'package.json'), JSON.stringify({ name: '@purista/harness', version: '1.7.3' }))

	await assert.rejects(assertInstalledHarness(root, { version: '3.0.0' }), /did not resolve the packed local/i)
})

test('requires the installed Harness to resolve from the generated tarball', async () => {
	const root = await temporaryRoot()
	const manifestDirectory = join(root, 'node_modules/@purista/harness')
	await mkdir(manifestDirectory, { recursive: true })
	await writeFile(join(manifestDirectory, 'package.json'), JSON.stringify({ name: '@purista/harness', version: '3.0.0' }))
	await writeFile(join(root, 'package-lock.json'), JSON.stringify({
		packages: { 'node_modules/@purista/harness': { resolved: 'file:../stale-harness.tgz' } },
	}))

	await assert.rejects(
		assertInstalledHarness(root, { version: '3.0.0', tarball: '/verification/current-harness.tgz' }),
		/did not resolve the packed local/i,
	)
})

test('fails closed when a guarded child command fails or cancellation is requested', () => {
	assert.throws(
		() => runCheckedCommand(process.execPath, ['--eval', 'process.exit(7)'], { cwd: tmpdir() }),
		/failed with exit code 7/i,
	)

	const controller = new AbortController()
	controller.abort()
	assert.throws(
		() => runCheckedCommand(process.execPath, ['--eval', 'process.exit(0)'], { cwd: tmpdir(), signal: controller.signal }),
		/cancelled/i,
	)
})

test('preserves the original failure, records content-free evidence, and reports incomplete cleanup', async () => {
	const root = await temporaryRoot()
	const layout = createVerificationLayout(root)
	let scratch
	const originalFailure = new Error('child command failure')

	await assert.rejects(
		withVerificationScratch(layout, async directory => {
			scratch = directory
			throw originalFailure
		}, {
			removeDirectory: async () => { throw new Error('cleanup failed') },
		}),
		error => error === originalFailure && error.sandboxVerificationCleanup === 'incomplete',
	)

	const evidenceFiles = await readdir(layout.evidence)
	assert.equal(evidenceFiles.length, 1)
	const evidence = JSON.parse(await readFile(join(layout.evidence, evidenceFiles[0]), 'utf8'))
	assert.deepEqual(evidence, {
		kind: 'sandbox_packed_verification_failure',
		failure: 'verification_failed',
		cleanup: 'incomplete',
	})
	await rm(scratch, { recursive: true, force: true })
})

test('cancels the runner after a guarded child and does not start a subsequent mode step', async () => {
	const root = await temporaryRoot()
	const layout = createVerificationLayout(root)
	await mkdir(join(layout.cache, '_cacache'), { recursive: true })
	const controller = new AbortController()
	const calls = []

	await assert.rejects(
		runPuristaSandboxVerification('source', {
			root,
			signal: controller.signal,
			steps: {
				buildAndPackHarness: async () => {
					calls.push('build')
					controller.abort()
					return { manifest: { version: '3.0.0' }, tarball: '/tmp/harness.tgz' }
				},
				runSourceMode: async () => calls.push('source'),
			},
		}),
		/cancelled/i,
	)
	assert.deepEqual(calls, ['build'])
})
