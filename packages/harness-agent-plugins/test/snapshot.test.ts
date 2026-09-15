import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
	AGENT_PLUGIN_MAX_ENTRIES,
	AGENT_PLUGIN_MAX_FILE_BYTES,
	AGENT_PLUGIN_MAX_PACKAGE_BYTES,
	AGENT_PLUGIN_MAX_DEPTH,
	AgentPluginSnapshotError,
	captureAgentPluginSnapshot,
	validateAgentPluginSnapshotLimits,
	type AgentPluginNativePath,
	type AgentPluginSnapshotFileSystem,
} from '../src/snapshot.js'

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function temporaryDirectory(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-plugin-snapshot-'))
	roots.push(root)
	return root
}

function write(root: string, relative: string, contents: string | Uint8Array): void {
	const target = path.join(root, relative)
	fs.mkdirSync(path.dirname(target), { recursive: true })
	fs.writeFileSync(target, contents)
}

function snapshot(root: string, limits: Parameters<typeof captureAgentPluginSnapshot>[2] = {}) {
	return captureAgentPluginSnapshot(root, process.cwd(), limits)
}

function nodeFileSystem(overrides: Partial<AgentPluginSnapshotFileSystem> = {}): AgentPluginSnapshotFileSystem {
	const base: AgentPluginSnapshotFileSystem = {
		platform: process.platform,
		realpath(value: AgentPluginNativePath) {
			return process.platform === 'win32'
				? fs.realpathSync.native(value, { encoding: 'utf8' })
				: fs.realpathSync.native(value, { encoding: 'buffer' })
		},
		lstat: value => fs.lstatSync(value, { bigint: true }),
		readdir(value) {
			return process.platform === 'win32'
				? fs.readdirSync(value, { encoding: 'utf8' })
				: fs.readdirSync(value, { encoding: 'buffer' })
		},
		open(value) {
			return fs.openSync(value, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW))
		},
		fstat: descriptor => fs.fstatSync(descriptor, { bigint: true }),
		readFile: descriptor => fs.readFileSync(descriptor),
		close: descriptor => fs.closeSync(descriptor),
	}
	return { ...base, ...overrides }
}

function expectSnapshotFailure(action: () => unknown, kind: AgentPluginSnapshotError['kind']): AgentPluginSnapshotError {
	try { action() } catch (error) {
		expect(error).toBeInstanceOf(AgentPluginSnapshotError)
		const failure = error as AgentPluginSnapshotError
		expect(failure.kind).toBe(kind)
		return failure
	}
	throw new Error('Expected snapshot capture to fail.')
}

describe('Agent Plugin immutable package snapshot', () => {
	it('matches the canonical V1 digest transcript and returns isolated byte copies', () => {
		const root = temporaryDirectory()
		write(root, 'nested/b.bin', Uint8Array.from([0, 1, 2]))
		write(root, 'a.txt', 'A')

		const captured = snapshot(root)

		expect(captured.digest).toBe('7afb7ba1c57df30555e972633a9783ca328fc231cb048901edb8a7927775a236')
		expect(captured.filePaths).toEqual(['a.txt', 'nested/b.bin'])
		expect(Object.isFrozen(captured)).toBe(true)
		expect(Object.isFrozen(captured.filePaths)).toBe(true)
		expect(captured.resolvedRoot).toBe(fs.realpathSync.native(root))
		const first = captured.readBytes('a.txt')
		if (first === undefined) throw new Error('Missing captured bytes.')
		first[0] = 0
		expect(new TextDecoder().decode(captured.readBytes('a.txt'))).toBe('A')
		expect(captured.readBytes('missing')).toBeUndefined()
	})

	it('sorts normalized paths by unsigned UTF-8 bytes', () => {
		const root = temporaryDirectory()
		write(root, 'é.txt', 'accent')
		write(root, 'z.txt', 'ascii')

		expect(snapshot(root).filePaths).toEqual(['z.txt', 'é.txt'])
	})

	it('resolves relative roots against the caller-captured absolute base', () => {
		const root = temporaryDirectory()
		write(root, 'value.txt', 'A')

		const captured = captureAgentPluginSnapshot(path.basename(root), path.dirname(root))

		expect(captured.resolvedRoot).toBe(fs.realpathSync.native(root))
		expectSnapshotFailure(() => captureAgentPluginSnapshot(root, 'relative-base'), 'plugin_root_invalid')
	})

	it.skipIf(process.platform !== 'linux')('rejects invalid raw POSIX UTF-8 names before reading them', () => {
		const root = temporaryDirectory()
		const invalidPath = Buffer.concat([Buffer.from(root), Buffer.from('/'), Buffer.from([0xff])])
		fs.writeFileSync(invalidPath, 'secret')
		let reads = 0
		const base = nodeFileSystem()
		const fileSystem = nodeFileSystem({
			readFile(descriptor, expectedBytes) {
				reads += 1
				return base.readFile(descriptor, expectedBytes)
			},
		})

		expectSnapshotFailure(() => captureAgentPluginSnapshot(root, process.cwd(), {}, fileSystem), 'path_escape')
		expect(reads).toBe(0)
	})

	it.skipIf(process.platform !== 'linux')('rejects distinct POSIX names that normalize to the same NFC path', () => {
		const root = temporaryDirectory()
		write(root, 'é.txt', 'nfc')
		write(root, 'e\u0301.txt', 'nfd')

		expectSnapshotFailure(() => snapshot(root), 'manifest_invalid')
	})

	it('validates configured limits and rejects sparse files before reading content', () => {
		expect(validateAgentPluginSnapshotLimits({ maxFileBytes: AGENT_PLUGIN_MAX_FILE_BYTES, maxPackageBytes: AGENT_PLUGIN_MAX_PACKAGE_BYTES })).toEqual({
			maxFileBytes: AGENT_PLUGIN_MAX_FILE_BYTES,
			maxPackageBytes: AGENT_PLUGIN_MAX_PACKAGE_BYTES,
		})
		expectSnapshotFailure(() => validateAgentPluginSnapshotLimits({ maxFileBytes: AGENT_PLUGIN_MAX_FILE_BYTES + 1 }), 'manifest_invalid')
		expectSnapshotFailure(() => validateAgentPluginSnapshotLimits({ maxPackageBytes: AGENT_PLUGIN_MAX_PACKAGE_BYTES + 1 }), 'manifest_invalid')
		expectSnapshotFailure(() => validateAgentPluginSnapshotLimits({ maxFileBytes: 0 }), 'manifest_invalid')
		expectSnapshotFailure(() => validateAgentPluginSnapshotLimits({ maxFileBytes: 10, maxPackageBytes: 9 }), 'manifest_invalid')

		const root = temporaryDirectory()
		const sparse = path.join(root, 'sparse.bin')
		fs.writeFileSync(sparse, '')
		fs.truncateSync(sparse, 11)
		let reads = 0
		const base = nodeFileSystem()
		const fileSystem = nodeFileSystem({
			readFile(descriptor, expectedBytes) {
				reads += 1
				return base.readFile(descriptor, expectedBytes)
			},
		})

		expectSnapshotFailure(
			() => captureAgentPluginSnapshot(root, process.cwd(), { maxFileBytes: 10, maxPackageBytes: 20 }, fileSystem),
			'package_too_large',
		)
		expect(reads).toBe(0)
	})

	it('accepts exact configured file and aggregate limits and rejects one byte more', () => {
		const fileRoot = temporaryDirectory()
		write(fileRoot, 'exact', '1234567890')
		expect(snapshot(fileRoot, { maxFileBytes: 10, maxPackageBytes: 10 }).filePaths).toEqual(['exact'])
		write(fileRoot, 'extra', 'x')
		expectSnapshotFailure(() => snapshot(fileRoot, { maxFileBytes: 10, maxPackageBytes: 10 }), 'package_too_large')

		const aggregateRoot = temporaryDirectory()
		write(aggregateRoot, 'a', '12345'); write(aggregateRoot, 'b', '12345')
		expect(snapshot(aggregateRoot, { maxFileBytes: 6, maxPackageBytes: 10 }).filePaths).toEqual(['a', 'b'])
		write(aggregateRoot, 'b', '123456')
		expectSnapshotFailure(() => snapshot(aggregateRoot, { maxFileBytes: 6, maxPackageBytes: 10 }), 'package_too_large')
	})

	it.skipIf(process.platform !== 'linux')('accepts exact normalized path and depth bounds and rejects plus one', () => {
		const pathRoot = temporaryDirectory()
		const segment = 'x'.repeat(204)
		write(pathRoot, [segment, segment, segment, segment, segment].join('/'), '')
		expect(snapshot(pathRoot).filePaths[0]).toHaveLength(1_024)
		const pathPlusOneRoot = temporaryDirectory()
		write(pathPlusOneRoot, ['x'.repeat(205), segment, segment, segment, segment].join('/'), '')
		expectSnapshotFailure(() => snapshot(pathPlusOneRoot), 'package_too_large')

		const depthRoot = temporaryDirectory()
		write(depthRoot, Array.from({ length: AGENT_PLUGIN_MAX_DEPTH }, () => 'd').join('/'), '')
		expect(snapshot(depthRoot).filePaths[0]?.split('/')).toHaveLength(AGENT_PLUGIN_MAX_DEPTH)
		const depthPlusOneRoot = temporaryDirectory()
		write(depthPlusOneRoot, Array.from({ length: AGENT_PLUGIN_MAX_DEPTH + 1 }, () => 'd').join('/'), '')
		expectSnapshotFailure(() => snapshot(depthPlusOneRoot), 'package_too_large')
	})

	it('accepts exactly 20,000 entries and rejects entry 20,001 through the filesystem seam', () => {
		const directory = temporaryDirectory()
		const emptyFile = path.join(directory, 'empty'); fs.writeFileSync(emptyFile, '')
		const directoryStat = fs.lstatSync(directory, { bigint: true })
		const fileStat = fs.lstatSync(emptyFile, { bigint: true })
		const names = Array.from({ length: AGENT_PLUGIN_MAX_ENTRIES }, (_, index) => Buffer.from(`f${index.toString().padStart(5, '0')}`))
		const fake = (entries: readonly Buffer[]): AgentPluginSnapshotFileSystem => ({
			platform: 'linux',
			realpath: value => Buffer.isBuffer(value) ? value : Buffer.from(value),
			lstat: value => typeof value === 'string' || (Buffer.isBuffer(value) && value.equals(Buffer.from(directory))) ? directoryStat : fileStat,
			readdir: () => entries,
			open: () => 1,
			fstat: () => fileStat,
			readFile: () => Buffer.alloc(0),
			close: () => undefined,
		})
		expect(captureAgentPluginSnapshot(directory, process.cwd(), {}, fake(names)).filePaths).toHaveLength(AGENT_PLUGIN_MAX_ENTRIES)
		expectSnapshotFailure(() => captureAgentPluginSnapshot(directory, process.cwd(), {}, fake([...names, Buffer.from('overflow')])), 'package_too_large')
	})

	it('enforces aggregate, depth, and normalized-path byte bounds', () => {
		const aggregateRoot = temporaryDirectory()
		write(aggregateRoot, 'a', '123456')
		write(aggregateRoot, 'b', '123456')
		expectSnapshotFailure(
			() => snapshot(aggregateRoot, { maxFileBytes: 10, maxPackageBytes: 10 }),
			'package_too_large',
		)

		const deepRoot = temporaryDirectory()
		let deepDirectory = deepRoot
		for (let index = 0; index < AGENT_PLUGIN_MAX_DEPTH + 1; index += 1) {
			deepDirectory = path.join(deepDirectory, 'd')
			fs.mkdirSync(deepDirectory)
		}
		expectSnapshotFailure(() => snapshot(deepRoot), 'package_too_large')

		if (process.platform === 'linux') {
			const longPathRoot = temporaryDirectory()
			let longDirectory = longPathRoot
			for (let index = 0; index < 5; index += 1) {
				longDirectory = path.join(longDirectory, `${index}${'x'.repeat(208)}`)
				fs.mkdirSync(longDirectory)
			}
			expectSnapshotFailure(() => snapshot(longPathRoot), 'package_too_large')
		}
	})

	it('rejects a symlink root and a contained or escaping symlink without reading targets', () => {
		const realRoot = temporaryDirectory()
		write(realRoot, 'target.txt', 'secret')
		const linkedRoot = `${realRoot}-link`
		roots.push(linkedRoot)
		fs.symlinkSync(realRoot, linkedRoot, 'dir')
		expectSnapshotFailure(() => snapshot(linkedRoot), 'plugin_root_invalid')

		const scanRoot = temporaryDirectory()
		const outside = temporaryDirectory()
		write(outside, 'secret.txt', 'secret')
		fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(scanRoot, 'escape'))
		let reads = 0
		const base = nodeFileSystem()
		const fileSystem = nodeFileSystem({
			readFile(descriptor, expectedBytes) {
				reads += 1
				return base.readFile(descriptor, expectedBytes)
			},
		})
		expectSnapshotFailure(() => captureAgentPluginSnapshot(scanRoot, process.cwd(), {}, fileSystem), 'path_escape')
		expect(reads).toBe(0)
	})

	it.skipIf(process.platform !== 'win32')('rejects a Windows junction before reading its target', () => {
		const realRoot = temporaryDirectory()
		write(realRoot, 'target.txt', 'secret')
		const linkedRoot = `${realRoot}-junction`
		roots.push(linkedRoot)
		fs.symlinkSync(realRoot, linkedRoot, 'junction')

		let reads = 0
		const base = nodeFileSystem()
		const fileSystem = nodeFileSystem({
			readFile(descriptor, expectedBytes) {
				reads += 1
				return base.readFile(descriptor, expectedBytes)
			},
		})

		expectSnapshotFailure(
			() => captureAgentPluginSnapshot(linkedRoot, process.cwd(), {}, fileSystem),
			'plugin_root_invalid',
		)
		expect(reads).toBe(0)
	})

	it.skipIf(process.platform === 'win32')('rejects special filesystem entries', () => {
		const root = temporaryDirectory()
		const fifo = path.join(root, 'pipe')
		try { execFileSync('mkfifo', [fifo]) } catch { return }

		expectSnapshotFailure(() => snapshot(root), 'path_escape')
	})

	it('returns only a fixed content-free failure kind and message', () => {
		const secretRoot = path.join(os.tmpdir(), 'secret-token-that-must-not-leak')
		const failure = expectSnapshotFailure(() => snapshot(secretRoot), 'plugin_root_invalid')

		expect(failure.message).toBe('Agent Plugin snapshot failed.')
		expect(String(failure)).not.toContain('secret-token-that-must-not-leak')
		expect(Object.keys(failure).sort()).toEqual(['kind', 'name'])
	})

	it('reads every stable file exactly once', () => {
		const root = temporaryDirectory()
		write(root, 'a.txt', 'A')
		write(root, 'b.txt', 'B')
		let reads = 0
		const base = nodeFileSystem()
		const fileSystem = nodeFileSystem({
			readFile(descriptor, expectedBytes) {
				reads += 1
				return base.readFile(descriptor, expectedBytes)
			},
		})

		captureAgentPluginSnapshot(root, process.cwd(), {}, fileSystem)
		expect(reads).toBe(2)
	})

	it('discards a changed attempt, retries the whole scan once, and returns only new bytes', () => {
		const root = temporaryDirectory()
		const target = path.join(root, 'value.txt')
		write(root, 'value.txt', 'A')
		let reads = 0
		let mutated = false
		const base = nodeFileSystem()
		const fileSystem = nodeFileSystem({
			readFile(descriptor, expectedBytes) {
				reads += 1
				const bytes = base.readFile(descriptor, expectedBytes)
				if (!mutated) {
					mutated = true
					fs.appendFileSync(target, 'B')
				}
				return bytes
			},
		})

		const captured = captureAgentPluginSnapshot(root, process.cwd(), {}, fileSystem)

		expect(reads).toBe(2)
		expect(new TextDecoder().decode(captured.readBytes('value.txt'))).toBe('AB')
	})

	it('rejects a second complete-scan mutation deterministically', () => {
		const root = temporaryDirectory()
		const target = path.join(root, 'value.txt')
		write(root, 'value.txt', 'A')
		const base = nodeFileSystem()
		const fileSystem = nodeFileSystem({
			readFile(descriptor, expectedBytes) {
				const bytes = base.readFile(descriptor, expectedBytes)
				fs.appendFileSync(target, 'x')
				return bytes
			},
		})

		expectSnapshotFailure(
			() => captureAgentPluginSnapshot(root, process.cwd(), {}, fileSystem),
			'manifest_invalid',
		)
	})

	it('retries when the final directory inventory changes', () => {
		const root = temporaryDirectory()
		write(root, 'a.txt', 'A')
		let rootReads = 0
		let mutated = false
		const base = nodeFileSystem()
		const fileSystem = nodeFileSystem({
			readdir(value) {
				rootReads += 1
				if (rootReads === 2 && !mutated) {
					mutated = true
					write(root, 'b.txt', 'B')
				}
				return base.readdir(value)
			},
		})

		const captured = captureAgentPluginSnapshot(root, process.cwd(), {}, fileSystem)
		expect(captured.filePaths).toEqual(['a.txt', 'b.txt'])
	})

	it('maps permanent read failures to plugin_root_invalid instead of mutation exhaustion', () => {
		const root = temporaryDirectory()
		write(root, 'value.txt', 'A')
		const base = nodeFileSystem()
		const denied = Object.assign(new Error('sensitive path'), { code: 'EACCES' })
		const fileSystem = nodeFileSystem({
			readFile() { throw denied },
			fstat: base.fstat,
		})

		const failure = expectSnapshotFailure(
			() => captureAgentPluginSnapshot(root, process.cwd(), {}, fileSystem),
			'plugin_root_invalid',
		)
		expect(failure.message).not.toContain('sensitive path')
	})

	it('maps root resolution and descriptor failures to content-free snapshot errors', () => {
		const root = temporaryDirectory()
		write(root, 'value.txt', 'A')
		const base = nodeFileSystem()
		expectSnapshotFailure(
			() => captureAgentPluginSnapshot(root, process.cwd(), {}, nodeFileSystem({ realpath() { throw new Error('secret root') } })),
			'plugin_root_invalid',
		)
		const denied = nodeFileSystem({ open() { throw new Error('secret file') } })
		const failure = expectSnapshotFailure(() => captureAgentPluginSnapshot(root, process.cwd(), {}, denied), 'plugin_root_invalid')
		expect(failure.message).toBe('Agent Plugin snapshot failed.')
		const unstable = nodeFileSystem({
			fstat(descriptor) {
				const stat = base.fstat(descriptor)
				return { ...stat, size: stat.size + 1n }
			},
		})
		expectSnapshotFailure(() => captureAgentPluginSnapshot(root, process.cwd(), {}, unstable), 'manifest_invalid')
	})
})
