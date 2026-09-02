import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	collectOfflineVerificationDependencies,
	collectOfflineVerificationSpecs,
	lockedRegistryVersion,
} from './prepare-offline-verification-cache.mjs'

test('collects exact required dependency closure and skips optional peers', () => {
	const registry = name => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-1.0.0.tgz`
	const lock = { packages: {
		'node_modules/root': { version: '1.0.0', resolved: registry('root'), dependencies: { child: '^1.0.0' }, peerDependencies: { required: '^1.0.0', optional: '^1.0.0' }, peerDependenciesMeta: { optional: { optional: true } } },
		'node_modules/child': { version: '1.0.0', resolved: registry('child'), dependencies: { nested: '^2.0.0' } },
		'node_modules/child/node_modules/nested': { version: '2.0.0', resolved: registry('nested') },
		'node_modules/required': { version: '1.0.0', resolved: registry('required') },
		'node_modules/optional': { version: '1.0.0', resolved: registry('optional') },
	} }

	assert.deepEqual(collectOfflineVerificationSpecs(lock, new Set(['root'])), [
		'child@1.0.0',
		'nested@2.0.0',
		'required@1.0.0',
		'root@1.0.0',
	])
})

test('rejects dependencies that are not registry-pinned', () => {
	assert.throws(() => collectOfflineVerificationSpecs({ packages: { 'node_modules/local': { version: '1.0.0', resolved: 'file:../local' } } }, new Set(['local'])), /not pinned/)
})

test('pins generated consumer dependencies to the installed lockfile version', () => {
	const lock = { packages: {
		'node_modules/@types/node': {
			version: '26.4.0',
			resolved: 'https://registry.npmjs.org/@types/node/-/node-26.4.0.tgz',
		},
	} }

	assert.equal(lockedRegistryVersion(lock, '@types/node'), '26.4.0')
})

test('projects the cached closure into exact generated consumer dependencies', () => {
	const registry = name => `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-1.0.0.tgz`
	const lock = { packages: {
		'node_modules/root': { version: '1.0.0', resolved: registry('root'), dependencies: { child: '^1.0.0' } },
		'node_modules/child': { version: '1.0.0', resolved: registry('child') },
	} }

	assert.deepEqual(collectOfflineVerificationDependencies(lock, new Set(['root'])), {
		child: '1.0.0',
		root: '1.0.0',
	})
})
