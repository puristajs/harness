import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import { parseDocument } from 'yaml'
import { z } from 'zod'
import type { SkillDefinition, SkillRuntimeId, BuiltInToolDefinition } from '../definitions/types.js'
import { createDefinitionIdentity, freezeDefinition } from '../definitions/identity.js'
import { OperationCancelledError, OperationTimeoutError, SkillManifestError } from '../errors/index.js'
import { abortError, withAbortSignal } from '../runtime/abort.js'
import { isReadOnlyMountCapableSession, type SandboxSessionBase } from '../sandbox/index.js'
import { bindReadSkillTool, type ExecutableToolBinding } from '../tools/bindings.js'

const MAX_ENTRIES = 5_000
const MAX_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_TEXT_BYTES = 256 * 1024
const MAX_PATH_BYTES = 512
const NAME = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/
const FRONTMATTER_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])

export type SkillManifest = Readonly<{
	name: string
	description: string
	license?: string
	compatibility?: string
	metadata?: Readonly<Record<string, string>>
	'allowed-tools'?: string
}>

/** @internal Immutable, bounded snapshot loaded once during instance initialization. */
export interface LoadedSkillSnapshot<Id extends string = string> {
	readonly id: Id
	readonly directory: string
	readonly mountPath: `/skills/${Id}`
	readonly runtimes: readonly SkillRuntimeId[]
	readonly manifest: SkillManifest
	readText(relativePath?: string): Readonly<{ skill: Id; path: string; content: string }>
	mountReadOnly(session: SandboxSessionBase): Promise<void>
}

type FileSnapshot = Readonly<{ path: string; bytes: Uint8Array }>

/** @internal Loads declared file-URL Skills into detached snapshots in id order. */
export async function loadSkillSnapshots<const Skills extends readonly SkillDefinition[]>(
	definitions: Skills,
	signal?: AbortSignal,
): Promise<Readonly<{ [Id in Skills[number]['id']]: LoadedSkillSnapshot<Id> }>> {
	const result: Record<string, LoadedSkillSnapshot> = {}
	for (const definition of [...definitions].sort((a, b) => a.id.localeCompare(b.id))) {
		throwIfSkillAborted(signal)
		result[definition.id] = await loadOneSkill(definition, signal)
	}
	return Object.freeze(result) as Readonly<{ [Id in Skills[number]['id']]: LoadedSkillSnapshot<Id> }>
}

async function loadOneSkill<const Id extends string>(definition: SkillDefinition<Id>, signal?: AbortSignal): Promise<LoadedSkillSnapshot<Id>> {
	const directoryUrl = definition.directory
	if (directoryUrl.protocol !== 'file:' || directoryUrl.search !== '' || directoryUrl.hash !== '') fail('invalid_skill_url', definition)
	let directory: string
	try { directory = fileURLToPath(directoryUrl) } catch (error) { fail('invalid_skill_url', definition, undefined, error) }
	let rootStat
	try { rootStat = await skillOperation(signal, () => fs.lstat(directory)) } catch (error) {
		if (isNodeError(error, 'ENOENT')) fail('directory_missing', definition)
		if (isOperationControlError(error)) throw error
		fail('unsafe_skill_entry', definition, undefined, error)
	}
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('unsafe_skill_entry', definition)

	const files: FileSnapshot[] = []
	let entries = 0
	let bytes = 0
	const walk = async (absolute: string, relative: string): Promise<void> => {
		throwIfSkillAborted(signal)
		const children = (await skillOperation(signal, () => fs.readdir(absolute))).sort()
		for (const name of children) {
			throwIfSkillAborted(signal)
			const childRelative = relative ? `${relative}/${name}` : name
			assertSkillPath(childRelative, definition)
			entries += 1
			if (entries > MAX_ENTRIES) fail('scan_limit_reached', definition, childRelative)
			const childAbsolute = path.join(absolute, name)
			const stat = await skillOperation(signal, () => fs.lstat(childAbsolute))
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) fail('unsafe_skill_entry', definition, childRelative)
			if (stat.isDirectory()) await walk(childAbsolute, childRelative)
			else {
				if (childRelative === 'SKILL.md' && stat.size > MAX_TEXT_BYTES) fail('skill_file_too_large', definition, childRelative)
				if (stat.size > MAX_TOTAL_BYTES || bytes + stat.size > MAX_TOTAL_BYTES) fail('scan_limit_reached', definition, childRelative)
				const data = new Uint8Array(await skillOperation(signal, () => fs.readFile(childAbsolute)))
				bytes += data.byteLength
				if (bytes > MAX_TOTAL_BYTES) fail('scan_limit_reached', definition, childRelative)
				files.push(Object.freeze({ path: childRelative, bytes: new Uint8Array(data) }))
			}
		}
	}
	try { await walk(directory, '') }
	catch (error) {
		if (error instanceof SkillManifestError || isOperationControlError(error)) throw error
		fail('unsafe_skill_entry', definition, undefined, error)
	}
	const skillMd = files.find(file => file.path === 'SKILL.md')
	if (skillMd === undefined) fail('missing_skill_md', definition)
	if (skillMd.bytes.byteLength > MAX_TEXT_BYTES) fail('skill_file_too_large', definition, 'SKILL.md')
	const content = decodeText(skillMd.bytes, definition, 'SKILL.md')
	const manifest = parseManifest(content, definition, path.basename(directory))
	const runtimes = Object.freeze([...(definition.runtimes ?? [])])
	const mountPath = `/skills/${definition.id}` as const

	const snapshot: LoadedSkillSnapshot<Id> = {
		id: definition.id,
		directory: directoryUrl.href,
		mountPath,
		runtimes,
		manifest,
		readText(relativePath = 'SKILL.md') {
			assertSkillPath(relativePath, definition)
			const file = files.find(candidate => candidate.path === relativePath)
			if (file === undefined) fail('invalid_skill_path', definition, relativePath)
			if (file.bytes.byteLength > MAX_TEXT_BYTES) fail('skill_file_too_large', definition, relativePath)
			return Object.freeze({ skill: definition.id, path: relativePath, content: decodeText(file.bytes, definition, relativePath) })
		},
		async mountReadOnly(session) {
			if (runtimes.length === 0) return
			if (!isReadOnlyMountCapableSession(session)) fail('readonly_mount_unsupported', definition)
			const detached = new Map(files.map(file => [file.path, new Uint8Array(file.bytes)] as const))
			try { await skillOperation(undefined, () => session.mountReadOnly(detached, mountPath)) }
			catch (error) {
				if (error instanceof SkillManifestError || isOperationControlError(error)) throw error
				fail('readonly_mount_unsupported', definition, undefined, error)
			}
		},
	}
	return Object.freeze(snapshot)
}

/** @internal Creates the reserved reader only for an agent with selected Skills. */
export function createReadSkillBinding<const Id extends string>(
	selected: Readonly<Record<Id, LoadedSkillSnapshot<Id>>>,
): ExecutableToolBinding | undefined {
	const ids = Object.keys(selected).sort() as Id[]
	if (ids.length === 0) return undefined
	const input = z.object({ skill: z.enum(ids as [Id, ...Id[]]), path: z.string().optional().default('SKILL.md') }).strict()
	const output = z.object({ skill: z.enum(ids as [Id, ...Id[]]), path: z.string(), content: z.string() }).strict()
	const value = {
		kind: 'tool' as const, id: 'read_skill' as const,
		description: 'Read one text file from a selected Agent Skill snapshot.', input, output,
		requires: Object.freeze({ memory: Object.freeze([]), sandbox: Object.freeze([]) }),
	}
	const definition = freezeDefinition(value, createDefinitionIdentity('built-in-tool', 'read_skill')) as unknown as BuiltInToolDefinition<'read_skill', typeof input, typeof output>
	return bindReadSkillTool(definition, async value => {
		return selected[value.skill].readText(value.path)
	})
}

function parseManifest(content: string, definition: SkillDefinition, basename: string): SkillManifest {
	const envelope = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
	if (envelope?.[1] === undefined) fail('invalid_frontmatter', definition, 'SKILL.md')
	const document = parseDocument(envelope[1], { strict: true })
	if (document.errors.length > 0) fail('invalid_frontmatter', definition, 'SKILL.md', document.errors[0])
	let value: unknown
	try { value = document.toJSON() } catch (error) { fail('invalid_frontmatter', definition, 'SKILL.md', error) }
	if (!isPlainRecord(value) || Object.keys(value).some(key => !FRONTMATTER_FIELDS.has(key))) fail('invalid_frontmatter', definition, 'SKILL.md')
	if (typeof value['name'] !== 'string' || !NAME.test(value['name'])) fail('invalid_name', definition, 'SKILL.md')
	if (value['name'] !== definition.id || value['name'] !== basename) fail('name_mismatch', definition, 'SKILL.md')
	if (typeof value['description'] !== 'string' || value['description'].trim().length === 0 || value['description'].length > 1_024) fail('missing_description', definition, 'SKILL.md')
	for (const field of ['license', 'compatibility', 'allowed-tools'] as const) {
		if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].trim().length === 0)) fail('invalid_frontmatter', definition, 'SKILL.md')
	}
	if (typeof value['allowed-tools'] === 'string' && (value['allowed-tools'] !== value['allowed-tools'].trim() || /[,\u0000-\u001f\u007f]/.test(value['allowed-tools']))) fail('invalid_frontmatter', definition, 'SKILL.md')
	if (typeof value['compatibility'] === 'string' && value['compatibility'].length > 500) fail('invalid_frontmatter', definition, 'SKILL.md')
	let metadata: Readonly<Record<string, string>> | undefined
	if (value['metadata'] !== undefined) {
		if (!isPlainRecord(value['metadata']) || Object.values(value['metadata']).some(item => typeof item !== 'string')) fail('invalid_frontmatter', definition, 'SKILL.md')
		metadata = Object.freeze(Object.fromEntries(Object.entries(value['metadata']).sort(([a], [b]) => a.localeCompare(b))) as Record<string, string>)
	}
	const license = typeof value['license'] === 'string' ? value['license'] : undefined
	const compatibility = typeof value['compatibility'] === 'string' ? value['compatibility'] : undefined
	const allowedTools = typeof value['allowed-tools'] === 'string' ? value['allowed-tools'] : undefined
	return Object.freeze({
		name: value['name'], description: value['description'],
		...(license !== undefined ? { license } : {}),
		...(compatibility !== undefined ? { compatibility } : {}),
		...(metadata !== undefined ? { metadata } : {}),
		...(allowedTools !== undefined ? { 'allowed-tools': allowedTools } : {}),
	})
}

function assertSkillPath(relativePath: string, definition: SkillDefinition): void {
	if (typeof relativePath !== 'string' || new TextEncoder().encode(relativePath).byteLength > MAX_PATH_BYTES
		|| relativePath.startsWith('/') || relativePath.includes('\\') || /[\u0000-\u001f\u007f]/.test(relativePath)
		|| relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
		fail('invalid_skill_path', definition, typeof relativePath === 'string' ? relativePath : undefined)
	}
}

function decodeText(bytes: Uint8Array, definition: SkillDefinition, relativePath: string): string {
	try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
	catch (error) { fail('invalid_skill_encoding', definition, relativePath, error) }
}

function fail(
	reason: ConstructorParameters<typeof SkillManifestError>[1]['reason'],
	definition: Pick<SkillDefinition, 'id' | 'directory'>,
	relativePath?: string,
	_cause?: unknown,
): never {
	throw new SkillManifestError('Agent Skill package is invalid.', {
		reason, skill_id: definition.id, directory: definition.directory.href,
		...(relativePath === undefined ? {} : { path: relativePath }),
	})
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code
}

function throwIfSkillAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw abortError(signal, 'agent', 'Agent Skill initialization was cancelled.')
}

async function skillOperation<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
	try {
		return signal === undefined
			? await operation()
			: await withAbortSignal(signal, 'agent', 'Agent Skill initialization was cancelled.', operation)
	} catch (error) {
		if (isOperationControlError(error)) throw error
		if (error instanceof Error && error.name === 'AbortError') {
			throw new OperationCancelledError('Agent Skill initialization was cancelled.', { scope: 'agent' }, error)
		}
		throw error
	}
}

function isOperationControlError(error: unknown): error is OperationCancelledError | OperationTimeoutError {
	return error instanceof OperationCancelledError || error instanceof OperationTimeoutError
}
