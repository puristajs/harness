import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Default maximum bytes captured from one plugin file. */
export const AGENT_PLUGIN_DEFAULT_MAX_FILE_BYTES = 2_097_152 as const
/** Default maximum aggregate bytes captured from one plugin package. */
export const AGENT_PLUGIN_DEFAULT_MAX_PACKAGE_BYTES = 104_857_600 as const
/** Hard upper bound accepted for the per-file limit. */
export const AGENT_PLUGIN_MAX_FILE_BYTES = 16_777_216 as const
/** Hard upper bound accepted for the aggregate package limit. */
export const AGENT_PLUGIN_MAX_PACKAGE_BYTES = 536_870_912 as const
/** Hard maximum number of filesystem entries below a plugin root. */
export const AGENT_PLUGIN_MAX_ENTRIES = 20_000 as const
/** Hard maximum number of segments in a normalized plugin path. */
export const AGENT_PLUGIN_MAX_DEPTH = 64 as const
/** Hard maximum UTF-8 byte length of a normalized plugin path. */
export const AGENT_PLUGIN_MAX_PATH_BYTES = 1_024 as const

const DIGEST_PREFIX = Buffer.from('PURISTA_AGENT_PLUGIN_DIGEST_V1\0', 'utf8')
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const utf8Encoder = new TextEncoder()

export interface AgentPluginSnapshotLimitInput {
	readonly maxFileBytes?: number
	readonly maxPackageBytes?: number
}

export interface AgentPluginSnapshotLimits {
	readonly maxFileBytes: number
	readonly maxPackageBytes: number
}

export type AgentPluginSnapshotFailureKind =
	| 'plugin_root_invalid'
	| 'manifest_invalid'
	| 'path_escape'
	| 'package_too_large'

/** Content-free scanner failure retained inside the Agent Plugins addon. */
export class AgentPluginSnapshotError extends Error {
	public readonly kind: AgentPluginSnapshotFailureKind

	public constructor(kind: AgentPluginSnapshotFailureKind) {
		super('Agent Plugin snapshot failed.')
		this.name = 'AgentPluginSnapshotError'
		this.kind = kind
	}
}

export interface AgentPluginSnapshot {
	readonly resolvedRoot: string
	readonly digest: string
	readonly filePaths: readonly string[]
	readonly entryPaths: readonly string[]
	/** Returns the captured entry kind without exposing a host path. */
	entryKind(normalizedPath: string): 'file' | 'directory' | undefined
	/** Returns a caller-owned copy of the captured bytes. */
	readBytes(normalizedPath: string): Uint8Array | undefined
}

export type AgentPluginNativePath = string | Buffer

/** Private test seam; the package root does not export this module. */
export interface AgentPluginSnapshotFileSystem {
	readonly platform: NodeJS.Platform
	realpath(value: AgentPluginNativePath): AgentPluginNativePath
	lstat(value: AgentPluginNativePath): fs.BigIntStats
	readdir(value: AgentPluginNativePath): readonly (string | Buffer)[]
	open(value: AgentPluginNativePath): number
	fstat(fileDescriptor: number): fs.BigIntStats
	readFile(fileDescriptor: number, expectedBytes: number): Buffer
	close(fileDescriptor: number): void
}

interface EntryFingerprint {
	readonly dev: bigint
	readonly ino: bigint
	readonly mode: bigint
	readonly size: bigint
	readonly mtimeNs: bigint
	readonly ctimeNs: bigint
}

interface InventoryEntry {
	readonly rawKey: string
	readonly normalizedName: string
	readonly normalizedNameBytes: Buffer
	readonly kind: 'file' | 'directory'
	readonly fingerprint: EntryFingerprint
}

interface DirectoryRecord {
	readonly nativePath: AgentPluginNativePath
	readonly normalizedPath: string
	readonly fingerprint: EntryFingerprint
	readonly entries: readonly InventoryEntry[]
}

interface CapturedFile {
	readonly normalizedPath: string
	readonly pathBytes: Buffer
	readonly nativePath: AgentPluginNativePath
	readonly fingerprint: EntryFingerprint
	readonly bytes: Buffer
}

interface ScanState {
	readonly rootNative: AgentPluginNativePath
	readonly rootText: string
	readonly limits: AgentPluginSnapshotLimits
	readonly fileSystem: AgentPluginSnapshotFileSystem
	readonly normalizedPaths: Set<string>
	readonly directories: DirectoryRecord[]
	readonly files: CapturedFile[]
	entryCount: number
	packageBytes: number
}

class SnapshotChanged extends Error {}

/** Validates and freezes the two caller-controlled scan limits. */
export function validateAgentPluginSnapshotLimits(input: AgentPluginSnapshotLimitInput = {}): AgentPluginSnapshotLimits {
	const maxFileBytes = input.maxFileBytes ?? AGENT_PLUGIN_DEFAULT_MAX_FILE_BYTES
	const maxPackageBytes = input.maxPackageBytes ?? AGENT_PLUGIN_DEFAULT_MAX_PACKAGE_BYTES
	if (!positiveSafeInteger(maxFileBytes) || maxFileBytes > AGENT_PLUGIN_MAX_FILE_BYTES
		|| !positiveSafeInteger(maxPackageBytes) || maxPackageBytes > AGENT_PLUGIN_MAX_PACKAGE_BYTES
		|| maxFileBytes > maxPackageBytes) {
		throw new AgentPluginSnapshotError('manifest_invalid')
	}
	return Object.freeze({ maxFileBytes, maxPackageBytes })
}

/**
 * Captures one stable, bounded plugin package and calculates its canonical digest.
 *
 * The enclosing public operation must capture one absolute base directory and pass
 * that same value for every plugin root inspected by the operation.
 */
export function captureAgentPluginSnapshot(
	root: string,
	baseDirectory: string,
	limitInput: AgentPluginSnapshotLimitInput = {},
	fileSystem: AgentPluginSnapshotFileSystem = nodeSnapshotFileSystem,
): AgentPluginSnapshot {
	const limits = validateAgentPluginSnapshotLimits(limitInput)
	const resolvedInput = resolveInputRoot(baseDirectory, root)
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			return captureAttempt(resolvedInput, limits, fileSystem)
		} catch (error) {
			if (!(error instanceof SnapshotChanged)) throw error
			if (attempt === 1) throw new AgentPluginSnapshotError('manifest_invalid')
		}
	}
	throw new AgentPluginSnapshotError('manifest_invalid')
}

const nodeSnapshotFileSystem: AgentPluginSnapshotFileSystem = Object.freeze({
	platform: process.platform,
	realpath(value: AgentPluginNativePath) {
		return process.platform === 'win32'
			? fs.realpathSync.native(value, { encoding: 'utf8' })
			: fs.realpathSync.native(value, { encoding: 'buffer' })
	},
	lstat: (value: AgentPluginNativePath) => fs.lstatSync(value, { bigint: true }),
	readdir(value: AgentPluginNativePath) {
		return process.platform === 'win32'
			? fs.readdirSync(value, { encoding: 'utf8' })
			: fs.readdirSync(value, { encoding: 'buffer' })
	},
	open(value: AgentPluginNativePath) {
		const noFollow = process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW
		return fs.openSync(value, fs.constants.O_RDONLY | noFollow)
	},
	fstat: (fileDescriptor: number) => fs.fstatSync(fileDescriptor, { bigint: true }),
	readFile(fileDescriptor: number, expectedBytes: number) {
		const bytes = Buffer.alloc(expectedBytes)
		let offset = 0
		while (offset < expectedBytes) {
			const count = fs.readSync(fileDescriptor, bytes, offset, expectedBytes - offset, null)
			if (count === 0) break
			offset += count
		}
		const extra = Buffer.alloc(1)
		const extraCount = fs.readSync(fileDescriptor, extra, 0, 1, null)
		return extraCount === 0 ? bytes.subarray(0, offset) : Buffer.concat([bytes.subarray(0, offset), extra])
	},
	close: (fileDescriptor: number) => fs.closeSync(fileDescriptor),
})

function captureAttempt(
	resolvedInput: string,
	limits: AgentPluginSnapshotLimits,
	fileSystem: AgentPluginSnapshotFileSystem,
): AgentPluginSnapshot {
	let rootNative: AgentPluginNativePath
	let rootText: string
	let rootStat: fs.BigIntStats
	let requestedStat: fs.BigIntStats
	try {
		requestedStat = fileSystem.lstat(resolvedInput)
		if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) throw new Error()
	} catch {
		throw new AgentPluginSnapshotError('plugin_root_invalid')
	}
	try {
		rootNative = fileSystem.realpath(resolvedInput)
		rootText = decodeNativePath(rootNative)
		rootStat = fileSystem.lstat(rootNative)
	} catch (error) {
		if (error instanceof AgentPluginSnapshotError) throw error
		return throwScanIoFailure(error)
	}
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new AgentPluginSnapshotError('plugin_root_invalid')
	if (!sameFingerprint(toFingerprint(requestedStat), toFingerprint(rootStat))) throw new SnapshotChanged()

	const state: ScanState = {
		rootNative,
		rootText,
		limits,
		fileSystem,
		normalizedPaths: new Set<string>(),
		directories: [],
		files: [],
		entryCount: 0,
		packageBytes: 0,
	}
	scanDirectory(state, rootNative, [], 0)
	for (const directory of state.directories) verifyDirectory(state, directory)

	const files = [...state.files].sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes))
	const digest = digestFiles(files)
	const filePaths = Object.freeze(files.map(file => file.normalizedPath))
	const bytesByPath = new Map(files.map(file => [file.normalizedPath, Buffer.from(file.bytes)]))
	const kindsByPath = new Map<string, 'file' | 'directory'>([
		...files.map(file => [file.normalizedPath, 'file'] as const),
		...state.directories.filter(directory => directory.normalizedPath !== '').map(directory => [directory.normalizedPath, 'directory'] as const),
	])
	const entryPaths = Object.freeze([...kindsByPath.keys()].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))))
	return Object.freeze({
		resolvedRoot: rootText,
		digest,
		filePaths,
		entryPaths,
		entryKind(normalizedPath: string) { return kindsByPath.get(normalizedPath) },
		readBytes(normalizedPath: string) {
			const value = bytesByPath.get(normalizedPath)
			return value === undefined ? undefined : Uint8Array.from(value)
		},
	})
}

function scanDirectory(
	state: ScanState,
	directoryPath: AgentPluginNativePath,
	parentSegments: readonly string[],
	depth: number,
): void {
	if (depth > AGENT_PLUGIN_MAX_DEPTH) throw new AgentPluginSnapshotError('package_too_large')
	const directoryStat = safeLstat(state.fileSystem, directoryPath)
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new AgentPluginSnapshotError('path_escape')
	assertContained(state, directoryPath)
	const fingerprint = toFingerprint(directoryStat)
	const decodedEntries = readDecodedEntries(state.fileSystem, directoryPath)
		.sort((left, right) => Buffer.compare(left.normalizedNameBytes, right.normalizedNameBytes))
	const inventory: InventoryEntry[] = []

	for (const entry of decodedEntries) {
		state.entryCount += 1
		if (state.entryCount > AGENT_PLUGIN_MAX_ENTRIES) throw new AgentPluginSnapshotError('package_too_large')
		const segments = [...parentSegments, entry.normalizedName]
		if (segments.length > AGENT_PLUGIN_MAX_DEPTH) throw new AgentPluginSnapshotError('package_too_large')
		const normalizedPath = segments.join('/')
		const pathBytes = Buffer.from(utf8Encoder.encode(normalizedPath))
		if (pathBytes.byteLength > AGENT_PLUGIN_MAX_PATH_BYTES) throw new AgentPluginSnapshotError('package_too_large')
		if (state.normalizedPaths.has(normalizedPath)) throw new AgentPluginSnapshotError('manifest_invalid')
		state.normalizedPaths.add(normalizedPath)

		const nativePath = joinNativePath(directoryPath, entry.rawName, state.fileSystem.platform)
		const stat = safeLstat(state.fileSystem, nativePath)
		if (stat.isSymbolicLink()) throw new AgentPluginSnapshotError('path_escape')
		const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : undefined
		if (kind === undefined) throw new AgentPluginSnapshotError('path_escape')
		assertContained(state, nativePath)
		const entryFingerprint = toFingerprint(stat)
		inventory.push({
			rawKey: rawNameKey(entry.rawName),
			normalizedName: entry.normalizedName,
			normalizedNameBytes: entry.normalizedNameBytes,
			kind,
			fingerprint: entryFingerprint,
		})

		if (kind === 'directory') {
			scanDirectory(state, nativePath, segments, depth + 1)
		} else {
			const size = checkedFileSize(stat, state.limits)
			state.packageBytes += size
			if (state.packageBytes > state.limits.maxPackageBytes) throw new AgentPluginSnapshotError('package_too_large')
			const bytes = readStableFile(state.fileSystem, nativePath, stat, size)
			state.files.push({ normalizedPath, pathBytes, nativePath, fingerprint: entryFingerprint, bytes })
		}
	}

	const record: DirectoryRecord = { nativePath: directoryPath, normalizedPath: parentSegments.join('/'), fingerprint, entries: Object.freeze(inventory) }
	verifyDirectory(state, record)
	state.directories.push(record)
}

function readStableFile(
	fileSystem: AgentPluginSnapshotFileSystem,
	filePath: AgentPluginNativePath,
	initialStat: fs.BigIntStats,
	expectedBytes: number,
): Buffer {
	const fileDescriptor = openStableFile(fileSystem, filePath)
	try {
		try {
			const openedStat = fileSystem.fstat(fileDescriptor)
			if (!sameFingerprint(toFingerprint(initialStat), toFingerprint(openedStat)) || !openedStat.isFile()) throw new SnapshotChanged()
			const bytes = fileSystem.readFile(fileDescriptor, expectedBytes)
			const finalDescriptorStat = fileSystem.fstat(fileDescriptor)
			if (bytes.byteLength !== expectedBytes || !sameFingerprint(toFingerprint(openedStat), toFingerprint(finalDescriptorStat))) {
				throw new SnapshotChanged()
			}
			const finalPathStat = safeLstatChanged(fileSystem, filePath)
			if (!finalPathStat.isFile() || finalPathStat.isSymbolicLink()
				|| !sameFingerprint(toFingerprint(finalDescriptorStat), toFingerprint(finalPathStat))) throw new SnapshotChanged()
			return Buffer.from(bytes)
			} catch (error) {
				if (error instanceof SnapshotChanged || error instanceof AgentPluginSnapshotError) throw error
				return throwScanIoFailure(error)
		}
	} finally {
		try { fileSystem.close(fileDescriptor) } catch { /* content was already rejected or captured */ }
	}
}

function openStableFile(fileSystem: AgentPluginSnapshotFileSystem, filePath: AgentPluginNativePath): number {
	try { return fileSystem.open(filePath) } catch (error) { return throwScanIoFailure(error) }
}

function verifyDirectory(state: ScanState, expected: DirectoryRecord): void {
	const stat = safeLstatChanged(state.fileSystem, expected.nativePath)
	if (!stat.isDirectory() || stat.isSymbolicLink() || !sameFingerprint(expected.fingerprint, toFingerprint(stat))) throw new SnapshotChanged()
	const actual = readDecodedEntriesChanged(state.fileSystem, expected.nativePath)
		.sort((left, right) => Buffer.compare(left.normalizedNameBytes, right.normalizedNameBytes))
	if (actual.length !== expected.entries.length) throw new SnapshotChanged()
	for (let index = 0; index < actual.length; index += 1) {
		const current = actual[index]
		const prior = expected.entries[index]
		if (current === undefined || prior === undefined || rawNameKey(current.rawName) !== prior.rawKey
			|| current.normalizedName !== prior.normalizedName) throw new SnapshotChanged()
		const childPath = joinNativePath(expected.nativePath, current.rawName, state.fileSystem.platform)
		const childStat = safeLstatChanged(state.fileSystem, childPath)
		const kind = childStat.isFile() ? 'file' : childStat.isDirectory() ? 'directory' : undefined
		if (childStat.isSymbolicLink() || kind !== prior.kind || !sameFingerprint(prior.fingerprint, toFingerprint(childStat))) {
			throw new SnapshotChanged()
		}
	}
}

function digestFiles(files: readonly CapturedFile[]): string {
	const hash = crypto.createHash('sha256')
	hash.update(DIGEST_PREFIX)
	for (const file of files) {
		hash.update(uint64BigEndian(file.pathBytes.byteLength))
		hash.update(file.pathBytes)
		hash.update(uint64BigEndian(file.bytes.byteLength))
		hash.update(file.bytes)
	}
	return hash.digest('hex')
}

function uint64BigEndian(value: number): Buffer {
	const bytes = Buffer.alloc(8)
	bytes.writeBigUInt64BE(BigInt(value))
	return bytes
}

function readDecodedEntries(
	fileSystem: AgentPluginSnapshotFileSystem,
	directoryPath: AgentPluginNativePath,
): Array<{ rawName: string | Buffer; normalizedName: string; normalizedNameBytes: Buffer }> {
	let entries: readonly (string | Buffer)[]
	try { entries = fileSystem.readdir(directoryPath) } catch (error) { throwScanIoFailure(error) }
	return entries.map(rawName => decodedEntry(rawName))
}

function readDecodedEntriesChanged(
	fileSystem: AgentPluginSnapshotFileSystem,
	directoryPath: AgentPluginNativePath,
): Array<{ rawName: string | Buffer; normalizedName: string; normalizedNameBytes: Buffer }> {
	try { return readDecodedEntries(fileSystem, directoryPath) } catch (error) {
		if (error instanceof AgentPluginSnapshotError && error.kind === 'path_escape') throw new SnapshotChanged()
		throw error
	}
}

function decodedEntry(rawName: string | Buffer): { rawName: string | Buffer; normalizedName: string; normalizedNameBytes: Buffer } {
	let decoded: string
	try { decoded = typeof rawName === 'string' ? strictScalarString(rawName) : utf8Decoder.decode(rawName) }
	catch { throw new AgentPluginSnapshotError('path_escape') }
	const normalizedName = decoded.normalize('NFC')
	if (!normalizedName || normalizedName === '.' || normalizedName === '..' || normalizedName.includes('/')
		|| normalizedName.includes('\\') || path.posix.isAbsolute(normalizedName) || /\p{Cc}/u.test(normalizedName)) {
		throw new AgentPluginSnapshotError('path_escape')
	}
	return { rawName, normalizedName, normalizedNameBytes: Buffer.from(utf8Encoder.encode(normalizedName)) }
}

function strictScalarString(value: string): string {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1)
			if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error()
			index += 1
		} else if (code >= 0xdc00 && code <= 0xdfff) throw new Error()
	}
	return value
}

function resolveInputRoot(baseDirectory: string, root: string): string {
	try {
		if (typeof baseDirectory !== 'string' || !baseDirectory || baseDirectory.includes('\0') || !path.isAbsolute(baseDirectory)) throw new Error()
		if (typeof root !== 'string' || !root || root.includes('\0')) throw new Error()
		strictScalarString(baseDirectory)
		strictScalarString(root)
		return path.resolve(baseDirectory, root)
	} catch {
		throw new AgentPluginSnapshotError('plugin_root_invalid')
	}
}

function decodeNativePath(value: AgentPluginNativePath): string {
	try { return typeof value === 'string' ? strictScalarString(value) : utf8Decoder.decode(value) }
	catch { throw new AgentPluginSnapshotError('plugin_root_invalid') }
}

function assertContained(state: ScanState, candidate: AgentPluginNativePath): void {
	let real: AgentPluginNativePath
	try { real = state.fileSystem.realpath(candidate) } catch (error) { throwScanIoFailure(error) }
	if (!nativePathContained(state.rootNative, real, state.fileSystem.platform)) throw new AgentPluginSnapshotError('path_escape')
}

function nativePathContained(root: AgentPluginNativePath, candidate: AgentPluginNativePath, platform: NodeJS.Platform): boolean {
	if (platform === 'win32') {
		if (typeof root !== 'string' || typeof candidate !== 'string') return false
		const relative = path.win32.relative(root, candidate)
		return relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative))
	}
	if (!Buffer.isBuffer(root) || !Buffer.isBuffer(candidate)) return false
	if (root.equals(candidate)) return true
	if (root.length === 1 && root[0] === 0x2f) return candidate[0] === 0x2f
	return candidate.length > root.length && candidate.subarray(0, root.length).equals(root) && candidate[root.length] === 0x2f
}

function joinNativePath(parent: AgentPluginNativePath, child: string | Buffer, platform: NodeJS.Platform): AgentPluginNativePath {
	if (platform === 'win32') {
		if (typeof parent !== 'string' || typeof child !== 'string') throw new AgentPluginSnapshotError('path_escape')
		return path.win32.join(parent, child)
	}
	if (!Buffer.isBuffer(parent) || !Buffer.isBuffer(child)) throw new AgentPluginSnapshotError('path_escape')
	const separator = parent[parent.length - 1] === 0x2f ? Buffer.alloc(0) : Buffer.from('/')
	return Buffer.concat([parent, separator, child])
}

function checkedFileSize(stat: fs.BigIntStats, limits: AgentPluginSnapshotLimits): number {
	if (stat.size < 0n || stat.size > BigInt(limits.maxFileBytes) || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new AgentPluginSnapshotError('package_too_large')
	}
	return Number(stat.size)
}

function safeLstat(fileSystem: AgentPluginSnapshotFileSystem, value: AgentPluginNativePath): fs.BigIntStats {
	try { return fileSystem.lstat(value) } catch (error) { throwScanIoFailure(error) }
}

function safeLstatChanged(fileSystem: AgentPluginSnapshotFileSystem, value: AgentPluginNativePath): fs.BigIntStats {
	try { return fileSystem.lstat(value) } catch (error) { throwScanIoFailure(error) }
}

function throwScanIoFailure(error: unknown): never {
	const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
	if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ESTALE' || code === 'ELOOP') throw new SnapshotChanged()
	throw new AgentPluginSnapshotError('plugin_root_invalid')
}

function toFingerprint(stat: fs.BigIntStats): EntryFingerprint {
	return {
		dev: stat.dev,
		ino: stat.ino,
		mode: stat.mode,
		size: stat.size,
		mtimeNs: stat.mtimeNs,
		ctimeNs: stat.ctimeNs,
	}
}

function sameFingerprint(left: EntryFingerprint, right: EntryFingerprint): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size
		&& left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function rawNameKey(value: string | Buffer): string {
	return typeof value === 'string' ? `s:${value}` : `b:${value.toString('hex')}`
}

function positiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0
}
