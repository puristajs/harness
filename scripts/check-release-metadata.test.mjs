import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyReleaseMetadata } from './check-release-metadata.mjs'

function fixture(overrides = {}) {
	const root = '/repo'
	const publicManifest = {
		name: '@purista/harness', version: '3.0.0', files: ['package.json', 'README.md', 'LICENSE'],
		license: 'Apache-2.0', publishConfig: { access: 'public' }, engines: { node: '>=24.15.0' },
		repository: { directory: 'packages/harness' }, bugs: { url: 'https://github.com/puristajs/harness/issues' }, homepage: 'https://purista.dev',
	}
	return {
		root,
		rootManifest: { engines: { node: '>=24.15.0' } },
		workspaces: [{ directory: '/repo/packages/harness', manifest: publicManifest, publishable: false }],
		platformPackages: [],
		lockfile: { packages: { 'packages/harness': { version: '3.0.0' } } },
		...overrides,
	}
}

test('accepts one aligned release unit', () => {
	assert.equal(verifyReleaseMetadata(fixture()).releaseVersion, '3.0.0')
})

test('rejects workspace and internal dependency version drift', () => {
	const value = fixture()
	value.workspaces.push({
		directory: '/repo/examples/demo', publishable: false,
		manifest: { name: '@purista/demo', version: '2.1.0', dependencies: { '@purista/harness': '^2.1.0' } },
	})
	value.lockfile.packages['examples/demo'] = { version: '2.1.0' }
	assert.throws(() => verifyReleaseMetadata(value), /has version 2\.1\.0.*dependencies\.@purista\/harness is \^2\.1\.0/s)
})

test('rejects a native platform package version drift', () => {
	const value = fixture()
	value.platformPackages.push({
		directory: '/repo/packages/native/npm/linux-x64',
		manifest: { name: '@purista/native-linux-x64', version: '2.1.0', publishConfig: { access: 'public' }, license: 'Apache-2.0', engines: { node: '>=24.15.0' } },
	})
	assert.throws(() => verifyReleaseMetadata(value), /@purista\/native-linux-x64 has version 2\.1\.0/)
})
