import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { defineMcpServer, defineSkill } from '@purista/harness'
import type { McpBinding, McpToolOptions, ModelSchema, Schema, SkillRuntimeId } from '@purista/harness'
import { createHttpMcpBinding, HttpBindingValidationError } from './http.js'
import {
	AGENT_PLUGIN_DEFAULT_MAX_FILE_BYTES,
	AGENT_PLUGIN_DEFAULT_MAX_PACKAGE_BYTES,
	AGENT_PLUGIN_MAX_DEPTH,
	AGENT_PLUGIN_MAX_ENTRIES,
	AGENT_PLUGIN_MAX_FILE_BYTES,
	AGENT_PLUGIN_MAX_PACKAGE_BYTES,
	AGENT_PLUGIN_MAX_PATH_BYTES,
	AgentPluginSnapshotError,
	captureAgentPluginSnapshot,
} from './snapshot.js'
import type { AgentPluginSnapshot, AgentPluginSnapshotLimits } from './snapshot.js'

/** Canonical Agent Plugins 1.0.0 manifest schema identifier. */
export const AGENT_PLUGIN_MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
/** Canonical Agent Plugins 1.0.0 MCP schema identifier. */
export const AGENT_PLUGIN_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
export {
	AGENT_PLUGIN_DEFAULT_MAX_FILE_BYTES,
	AGENT_PLUGIN_DEFAULT_MAX_PACKAGE_BYTES,
	AGENT_PLUGIN_MAX_DEPTH,
	AGENT_PLUGIN_MAX_ENTRIES,
	AGENT_PLUGIN_MAX_FILE_BYTES,
	AGENT_PLUGIN_MAX_PACKAGE_BYTES,
	AGENT_PLUGIN_MAX_PATH_BYTES,
}

/** Application trust decision for one installed Agent Plugin package. */
export type AgentPluginTrust = 'trusted' | 'untrusted'
/** Portable transport names recognized during inspection. */
export type AgentPluginTransport = 'stdio' | 'streamable-http'
/** Location and optional review metadata for an installed plugin package. */
export interface AgentPluginSource { readonly root: string; readonly trust?: AgentPluginTrust; readonly expectedDigest?: string }
/** Plugin source carrying the digest recorded by the application review. */
export interface ApprovedAgentPluginSource extends AgentPluginSource { readonly expectedDigest: string }
/** Bounded package-inspection limits. */
export interface InspectAgentPluginOptions { readonly maxFileBytes?: number; readonly maxPackageBytes?: number }
/** Atomic load request for one or more reviewed plugin packages. */
export interface AgentPluginLoadOptions extends InspectAgentPluginOptions {
	readonly plugins: readonly [ApprovedAgentPluginSource, ...ApprovedAgentPluginSource[]]
	readonly trustedRoots?: readonly string[]
}
/** Recognized portable manifest author fields. */
export interface AgentPluginAuthor { readonly name?: string; readonly email?: string; readonly url?: string }
/** Recognized, path-free manifest metadata returned by inspection. */
export interface AgentPluginManifestSummary {
	readonly $schema: typeof AGENT_PLUGIN_MANIFEST_SCHEMA
	readonly name: string
	readonly version?: string
	readonly description?: string
	readonly author?: AgentPluginAuthor
	readonly homepage?: string
	readonly repository?: string
	readonly license?: string
	readonly keywords?: readonly string[]
}
/** Path-free Agent Skill inventory row. */
export interface AgentPluginSkill { readonly name: string; readonly description: string }
/** Path-free MCP server inventory row, including projection support. */
export type AgentPluginMcpServerSummary =
	| Readonly<{ name: string; transport: 'streamable-http'; supported: true }>
	| Readonly<{ name: string; transport: 'stdio'; supported: false }>
/** Stable diagnostic codes returned by data-only inspection. */
export type AgentPluginDiagnosticCode =
	| 'plugin_root_invalid' | 'manifest_missing' | 'manifest_invalid' | 'manifest_unknown_field'
	| 'manifest_extensions_ignored' | 'schema_unsupported' | 'path_escape' | 'untrusted'
	| 'digest_invalid' | 'digest_mismatch' | 'package_too_large' | 'component_invalid'
	| 'skill_invalid' | 'skill_duplicate' | 'mcp_config_invalid' | 'transport_unsupported' | 'server_invalid'
/** Stable content-free package diagnostic. */
export interface AgentPluginDiagnostic {
	readonly level: 'warn' | 'error'; readonly code: AgentPluginDiagnosticCode; readonly message: string
	readonly pluginName?: string; readonly component?: 'skills' | 'mcp'; readonly item?: string
}
/** Frozen data-only result of inspecting one plugin package. */
export interface AgentPluginInspection {
	readonly valid: boolean; readonly manifest?: AgentPluginManifestSummary; readonly trust: AgentPluginTrust
	readonly digest?: string; readonly skills: readonly AgentPluginSkill[]
	readonly mcpServers: readonly AgentPluginMcpServerSummary[]; readonly diagnostics: readonly AgentPluginDiagnostic[]
}
/** Application-owned runtime requirements for one selected Skill. */
export interface AgentPluginSkillSelection<Runtimes extends readonly SkillRuntimeId[] = readonly SkillRuntimeId[]> { readonly runtimes: Runtimes }
/** Skill selections keyed by the exact portable Skill id. */
export type AgentPluginSkillSelections = Readonly<Record<string, AgentPluginSkillSelection>>
/** Caller-owned typed tools and runtime headers for one portable HTTP server. */
export interface AgentPluginHttpMcpServerSelection<Tools extends Readonly<Record<string, McpToolOptions<ModelSchema, Schema>>> = Readonly<Record<string, McpToolOptions<ModelSchema, Schema>>>> {
	readonly server: string; readonly tools: Tools; readonly headers?: Readonly<Record<string, string>>
	/** Exact Core per-invocation credential resolver, preserved by identity. */
	readonly resolveHeaders?: Extract<McpBinding, { transport: 'http' }>['resolveHeaders']
}
/** HTTP MCP selections keyed by caller-owned local server id. */
export type AgentPluginHttpMcpServerSelections = Readonly<Record<string, AgentPluginHttpMcpServerSelection>>
/** Authentic Core Skill definitions projected from literal selections. */
export type ProjectedAgentPluginSkills<Skills extends AgentPluginSkillSelections> = Readonly<{ [Id in keyof Skills & string]: ReturnType<typeof defineSkill<Id, Skills[Id]['runtimes']>> }>
/** Authentic Core MCP server definitions projected from literal selections. */
export type ProjectedAgentPluginMcpServers<Servers extends AgentPluginHttpMcpServerSelections> = Readonly<{ [Id in keyof Servers & string]: ReturnType<typeof defineMcpServer<Id, Servers[Id]['tools']>> }>
/** Core Streamable HTTP binding shape. */
export type AgentPluginHttpMcpBinding = Extract<McpBinding, { transport: 'http' }>
/** HTTP runtime bindings keyed by the exact selected local server ids. */
export type ProjectedAgentPluginMcpBindings<Servers extends AgentPluginHttpMcpServerSelections> = Readonly<{ [Id in keyof Servers & string]: AgentPluginHttpMcpBinding }>
/** Reviewed package identity carried separately from Core definitions and bindings. */
export interface AgentPluginComponentProvenance { readonly pluginName: string; readonly version?: string; readonly digest: string }
/** Deeply keyed provenance matching the exact selected Skill, server, and tool ids. */
export type AgentPluginBindingProvenance<Skills extends AgentPluginSkillSelections, Servers extends AgentPluginHttpMcpServerSelections> = Readonly<{
	skills: Readonly<{ [Id in keyof Skills & string]: AgentPluginComponentProvenance & Readonly<{ component: 'skill'; skillId: Id }> }>
	mcpServers: Readonly<{ [Id in keyof Servers & string]: AgentPluginComponentProvenance & Readonly<{
		component: 'mcp-server'; localServerId: Id; pluginServerName: Servers[Id]['server']
		tools: Readonly<{ [ToolId in keyof Servers[Id]['tools'] & string]: AgentPluginComponentProvenance & Readonly<{ component: 'mcp-tool'; localToolId: ToolId; remoteName: Servers[Id]['tools'][ToolId]['remoteName'] }> }>
	}> }>
}>
/** Exact selected definitions, HTTP bindings, and separate provenance. */
export interface AgentPluginBindings<Skills extends AgentPluginSkillSelections, Servers extends AgentPluginHttpMcpServerSelections> {
	readonly skills: ProjectedAgentPluginSkills<Skills>; readonly mcpServers: ProjectedAgentPluginMcpServers<Servers>
	readonly mcp: ProjectedAgentPluginMcpBindings<Servers>; readonly provenance: AgentPluginBindingProvenance<Skills, Servers>
}
/** Reviewed plugin handle that can project explicit selections without starting runtime work. */
export interface LoadedAgentPlugin {
	readonly inspection: AgentPluginInspection
	/**
	 * Projects only the explicitly selected Skills and Streamable HTTP MCP servers.
	 *
	 * @example
	 * ```ts
	 * const bindings = plugin.bindings({ skills: {}, mcpServers: {} })
	 * ```
	 */
	bindings<const Skills extends AgentPluginSkillSelections, const Servers extends AgentPluginHttpMcpServerSelections>(options: Readonly<{ skills: Skills; mcpServers: Servers }>): AgentPluginBindings<Skills, Servers>
}

/** Stable binding-selection failure reasons. */
export type AgentPluginLoadErrorReason = 'skill_not_found' | 'mcp_server_not_found' | 'transport_unsupported' | 'duplicate_selection' | 'invalid_selection' | 'invalid_http_headers'
/** Stable package and manifest failure reasons. */
export type AgentPluginManifestErrorReason = 'plugin_root_invalid' | 'manifest_missing' | 'manifest_invalid' | 'schema_unsupported' | 'package_too_large'
/** Stable package trust failure reasons. */
export type AgentPluginTrustErrorReason = 'untrusted' | 'digest_invalid' | 'digest_mismatch'
/** Base class for content-free Agent Plugin failures. */
export class AgentPluginError extends Error {}
/** Invalid package or manifest failure during atomic loading. */
export class AgentPluginManifestError extends AgentPluginError {
	readonly reason: AgentPluginManifestErrorReason
	constructor(reason: AgentPluginManifestErrorReason) { super('Agent Plugin package is invalid.'); this.name = 'AgentPluginManifestError'; this.reason = reason }
}
/** Missing or mismatched application trust failure. */
export class AgentPluginTrustError extends AgentPluginError {
	readonly reason: AgentPluginTrustErrorReason
	constructor(reason: AgentPluginTrustErrorReason) { super('Agent Plugin trust verification failed.'); this.name = 'AgentPluginTrustError'; this.reason = reason }
}
/** Invalid explicit Skill or MCP projection request. */
export class AgentPluginLoadError extends AgentPluginError {
	readonly reason: AgentPluginLoadErrorReason
	constructor(reason: AgentPluginLoadErrorReason) { super('Agent Plugin binding selection is invalid.'); this.name = 'AgentPluginLoadError'; this.reason = reason }
}

type Plain = Record<string, unknown> & {
	root?: unknown; trust?: unknown; expectedDigest?: unknown
	maxFileBytes?: unknown; maxPackageBytes?: unknown; plugins?: unknown; trustedRoots?: unknown
	$schema?: unknown; name?: unknown; version?: unknown; description?: unknown; author?: unknown
	homepage?: unknown; repository?: unknown; license?: unknown; keywords?: unknown; extensions?: unknown
	metadata?: unknown; compatibility?: unknown; type?: unknown; command?: unknown; args?: unknown; env?: unknown; cwd?: unknown
	mcpServers?: unknown; server?: unknown; tools?: unknown; headers?: unknown; url?: unknown; runtimes?: unknown
	remoteName?: unknown; input?: unknown; output?: unknown; skills?: unknown
}
type HttpServer = Readonly<{ name: string; transport: 'streamable-http'; supported: true; url: string; headers?: Readonly<Record<string, string>> }>
type StdioServer = Readonly<{ name: string; transport: 'stdio'; supported: false }>
type Parsed = Readonly<{ snapshot: AgentPluginSnapshot; manifest: AgentPluginManifestSummary; skills: readonly AgentPluginSkill[]; mcpServers: readonly (HttpServer | StdioServer)[]; diagnostics: readonly AgentPluginDiagnostic[] }>
type LazyMap = Readonly<{ keys: readonly string[]; read(key: string): unknown }>
class ManifestParseFailure extends Error {
	constructor(readonly reason: AgentPluginManifestErrorReason, readonly snapshot: AgentPluginSnapshot, readonly diagnostics: readonly AgentPluginDiagnostic[]) { super('manifest') }
}
const pluginNamePattern = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/
const skillNamePattern = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/
const lowerCamelPattern = /^[a-z][A-Za-z0-9]{0,63}$/
const digestPattern = /^[a-f0-9]{64}$/
const runtimeIds = new Set<SkillRuntimeId>(['node', 'python', 'shell'])
const manifestFields = ['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']
const decoder = new TextDecoder('utf-8', { fatal: true })

function byteCompare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)) }
function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key])
		Object.freeze(value)
	}
	return value
}
function ownRecord(value: unknown, allowed: readonly string[]): Plain | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
	let keys: PropertyKey[]
	try {
		const prototype = Reflect.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return undefined
		keys = Reflect.ownKeys(value)
	} catch { return undefined }
	if (keys.some(key => typeof key !== 'string' || !allowed.includes(key))) return undefined
	const result: Plain = Object.create(null)
	try {
		for (const key of keys) {
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
			if (!descriptor || !descriptor.enumerable) return undefined
			result[key as string] = 'value' in descriptor ? descriptor.value : descriptor.get?.call(value)
		}
	} catch { return undefined }
	return result
}
function ownMap(value: unknown): Plain | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
	let keys: PropertyKey[]
	try {
		const prototype = Reflect.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return undefined
		keys = Reflect.ownKeys(value)
	} catch { return undefined }
	if (keys.some(key => typeof key !== 'string')) return undefined
	const result: Plain = Object.create(null)
	try {
		for (const key of keys) {
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
			if (!descriptor || !descriptor.enumerable) return undefined
			result[key as string] = 'value' in descriptor ? descriptor.value : descriptor.get?.call(value)
		}
	} catch { return undefined }
	return result
}
function snapshotLazyMap(value: unknown): LazyMap | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
	let keys: PropertyKey[]
	const descriptors = new Map<string, PropertyDescriptor>()
	try {
		const prototype = Reflect.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return undefined
		keys = Reflect.ownKeys(value)
		if (keys.some(key => typeof key !== 'string')) return undefined
		for (const key of keys as string[]) {
			const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
			if (!descriptor?.enumerable) return undefined
			descriptors.set(key, descriptor)
		}
	} catch { return undefined }
	const reads = new Set<string>()
	return Object.freeze({
		keys: Object.freeze(keys as string[]),
		read(key: string) {
			if (reads.has(key)) throw new AgentPluginLoadError('invalid_selection')
			reads.add(key)
			const descriptor = descriptors.get(key)
			if (!descriptor) throw new AgentPluginLoadError('invalid_selection')
			return 'value' in descriptor ? descriptor.value : descriptor.get?.call(value)
		},
	})
}
function denseArray(value: unknown): readonly unknown[] | undefined {
	if (!Array.isArray(value)) return undefined
	const result: unknown[] = []
	try {
		if (Reflect.getPrototypeOf(value) !== Array.prototype) return undefined
		const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, 'length')
		if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return undefined
		const length = lengthDescriptor.value as number
		const keys = Reflect.ownKeys(value)
		if (keys.length !== length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= length))) return undefined
		for (let index = 0; index < length; index++) {
			if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined
			const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index))
			if (!descriptor || !descriptor.enumerable) return undefined
			result.push('value' in descriptor ? descriptor.value : descriptor.get?.call(value))
		}
	} catch { return undefined }
	return result
}
function limitsOf(value: unknown): AgentPluginSnapshotLimits | undefined {
	const object = ownRecord(value ?? {}, ['maxFileBytes', 'maxPackageBytes'])
	if (!object) return undefined
	const maxFileBytes = object.maxFileBytes ?? AGENT_PLUGIN_DEFAULT_MAX_FILE_BYTES
	const maxPackageBytes = object.maxPackageBytes ?? AGENT_PLUGIN_DEFAULT_MAX_PACKAGE_BYTES
	if (!Number.isSafeInteger(maxFileBytes) || (maxFileBytes as number) < 1 || (maxFileBytes as number) > AGENT_PLUGIN_MAX_FILE_BYTES) return undefined
	if (!Number.isSafeInteger(maxPackageBytes) || (maxPackageBytes as number) < 1 || (maxPackageBytes as number) > AGENT_PLUGIN_MAX_PACKAGE_BYTES || (maxFileBytes as number) > (maxPackageBytes as number)) return undefined
	return Object.freeze({ maxFileBytes: maxFileBytes as number, maxPackageBytes: maxPackageBytes as number })
}
function scanAgentPlugin(root: string, cwd: string, limits: AgentPluginSnapshotLimits): AgentPluginSnapshot {
	return captureAgentPluginSnapshot(root, cwd, limits)
}
function diagnostic(code: AgentPluginDiagnosticCode, metadata: Partial<Pick<AgentPluginDiagnostic, 'pluginName' | 'component' | 'item'>> = {}): AgentPluginDiagnostic {
	const warn = code === 'manifest_unknown_field' || code === 'manifest_extensions_ignored' || code === 'transport_unsupported'
	const item = typeof metadata.item === 'string' && /^[A-Za-z0-9._-]{1,128}$/u.test(metadata.item) ? metadata.item : undefined
	return Object.freeze({
		level: warn ? 'warn' : 'error', code, message: `Agent Plugin diagnostic: ${code}.`,
		...(metadata.pluginName === undefined ? {} : { pluginName: metadata.pluginName }),
		...(metadata.component === undefined ? {} : { component: metadata.component }),
		...(item === undefined ? {} : { item }),
	})
}
function sortDiagnostics(values: readonly AgentPluginDiagnostic[]): readonly AgentPluginDiagnostic[] {
	const unique = new Map<string, AgentPluginDiagnostic>()
	for (const value of values) unique.set(JSON.stringify([value.level, value.code, value.component ?? '', value.item ?? '', value.pluginName ?? '', value.message]), value)
	return Object.freeze([...unique.values()].sort((a, b) => {
		const left = [a.level === 'error' ? '0' : '1', a.code, a.component ?? '', a.item ?? '', a.pluginName ?? '', a.message]
		const right = [b.level === 'error' ? '0' : '1', b.code, b.component ?? '', b.item ?? '', b.pluginName ?? '', b.message]
		for (let index = 0; index < left.length; index++) { const compared = byteCompare(left[index]!, right[index]!); if (compared) return compared }
		return 0
	}))
}

function parseJson(bytes: Uint8Array): unknown { return JSON.parse(decoder.decode(bytes)) }
function parseManifest(bytes: Uint8Array, diagnostics: AgentPluginDiagnostic[]): AgentPluginManifestSummary | undefined {
	let raw: unknown
	try { raw = parseJson(bytes) } catch { diagnostics.push(diagnostic('manifest_invalid')); return undefined }
	const source = ownMap(raw)
	if (!source) { diagnostics.push(diagnostic('manifest_invalid')); return undefined }
	if (source.$schema !== AGENT_PLUGIN_MANIFEST_SCHEMA) {
		diagnostics.push(diagnostic(typeof source.$schema === 'string' ? 'schema_unsupported' : 'manifest_invalid'))
		return undefined
	}
	if (typeof source.name !== 'string' || source.name.length > 64 || !pluginNamePattern.test(source.name)) { diagnostics.push(diagnostic('manifest_invalid')); return undefined }
	const pluginName = source.name
	for (const key of Object.keys(source)) if (!manifestFields.includes(key)) diagnostics.push(diagnostic('manifest_unknown_field', { pluginName, item: key }))
	if (Object.prototype.hasOwnProperty.call(source, 'extensions')) diagnostics.push(diagnostic('manifest_extensions_ignored', { pluginName }))
	const result: Record<string, unknown> = { $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: pluginName }
	for (const key of ['version', 'description', 'homepage', 'repository', 'license'] as const) {
		if (source[key] !== undefined) {
			if (typeof source[key] !== 'string') { diagnostics.push(diagnostic('manifest_invalid', { pluginName })); return undefined }
			result[key] = source[key]
		}
	}
	if (source.author !== undefined) {
		const author = ownRecord(source.author, ['name', 'email', 'url'])
		if (!author || Object.values(author).some(value => typeof value !== 'string')) { diagnostics.push(diagnostic('manifest_invalid', { pluginName })); return undefined }
		result['author'] = Object.freeze({ ...author })
	}
	if (source.keywords !== undefined) {
		const keywords = denseArray(source.keywords)
		if (!keywords || keywords.some(value => typeof value !== 'string')) { diagnostics.push(diagnostic('manifest_invalid', { pluginName })); return undefined }
		result['keywords'] = Object.freeze([...keywords])
	}
	return deepFreeze(result) as unknown as AgentPluginManifestSummary
}

function parseSkill(bytes: Uint8Array, directory: string): AgentPluginSkill | undefined {
	let text: string
	try { text = decoder.decode(bytes) } catch { return undefined }
	const envelope = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)
	if (envelope?.[1] === undefined) return undefined
	let raw: unknown
	try {
		const document = parseDocument(envelope[1], { strict: true })
		if (document.errors.length !== 0) return undefined
		raw = document.toJSON()
	} catch { return undefined }
	const frontmatter = ownRecord(raw, ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'])
	if (!frontmatter || frontmatter.name !== directory || typeof frontmatter.name !== 'string' || frontmatter.name.length > 64 || !skillNamePattern.test(frontmatter.name)) return undefined
	if (typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '' || frontmatter.description.length > 1024) return undefined
	if (frontmatter.license !== undefined && (typeof frontmatter.license !== 'string' || frontmatter.license.trim() === '')) return undefined
	if (frontmatter.compatibility !== undefined && (typeof frontmatter.compatibility !== 'string' || frontmatter.compatibility.trim() === '' || frontmatter.compatibility.length > 500)) return undefined
	if (frontmatter['allowed-tools'] !== undefined && (typeof frontmatter['allowed-tools'] !== 'string' || frontmatter['allowed-tools'].trim() === '' || frontmatter['allowed-tools'] !== frontmatter['allowed-tools'].trim() || /[,\u0000-\u001f\u007f]/u.test(frontmatter['allowed-tools']))) return undefined
	if (frontmatter.metadata !== undefined) {
		const metadata = ownMap(frontmatter.metadata)
		if (!metadata || Object.values(metadata).some(value => typeof value !== 'string')) return undefined
	}
	return Object.freeze({ name: directory, description: frontmatter.description })
}

function validateStdioServer(value: unknown): boolean {
	const server = ownRecord(value, ['type', 'command', 'args', 'env', 'cwd'])
	if (!server || server.type !== 'stdio' || typeof server.command !== 'string' || server.command.length === 0) return false
	const args = server.args === undefined ? [] : denseArray(server.args)
	if (!args || args.some(item => typeof item !== 'string')) return false
	const env = server.env === undefined ? Object.create(null) as Plain : ownMap(server.env)
	if (!env || Object.keys(env).some(key => key === 'PLUGIN_ROOT' || key === 'PLUGIN_DATA' || typeof env[key] !== 'string')) return false
	return server.cwd === undefined || (typeof server.cwd === 'string' && (/^\.\//u.test(server.cwd) || /^\$\{PLUGIN_(?:ROOT|DATA)\}(?:\/|$)/u.test(server.cwd)))
}
function snapshotPortableHttpServer(value: unknown, expectedType: 'streamable-http' | 'sse'): Readonly<{ url: string; headers?: Readonly<Record<string, string>> }> | undefined {
	const server = ownRecord(value, ['type', 'url', 'headers'])
	if (!server || server.type !== expectedType || typeof server.url !== 'string' || server.url.length === 0) return undefined
	if (server.headers === undefined) return Object.freeze({ url: server.url })
	const source = ownMap(server.headers)
	if (!source || Object.values(source).some(header => typeof header !== 'string')) return undefined
	return Object.freeze({ url: server.url, headers: Object.freeze({ ...source }) as Readonly<Record<string, string>> })
}
function parseMcp(bytes: Uint8Array, pluginName: string, diagnostics: AgentPluginDiagnostic[]): readonly (HttpServer | StdioServer)[] {
	let raw: unknown
	try { raw = parseJson(bytes) } catch { diagnostics.push(diagnostic('mcp_config_invalid', { pluginName, component: 'mcp' })); return Object.freeze([]) }
	const config = ownRecord(raw, ['$schema', 'mcpServers'])
	const servers = config && ownMap(config.mcpServers)
	if (!config || config.$schema !== AGENT_PLUGIN_MCP_SCHEMA || !servers) { diagnostics.push(diagnostic('mcp_config_invalid', { pluginName, component: 'mcp' })); return Object.freeze([]) }
	const output: Array<HttpServer | StdioServer> = []
	for (const name of Object.keys(servers).sort(byteCompare)) {
		const value = servers[name]
		const base = ownMap(value)
		if (!base || typeof base.type !== 'string') { diagnostics.push(diagnostic('server_invalid', { pluginName, component: 'mcp', item: name })); continue }
		if (base.type === 'sse') {
			if (snapshotPortableHttpServer(value, 'sse')) diagnostics.push(diagnostic('transport_unsupported', { pluginName, component: 'mcp', item: name }))
			else diagnostics.push(diagnostic('server_invalid', { pluginName, component: 'mcp', item: name }))
			continue
		}
		if (base.type === 'stdio') {
			if (!validateStdioServer(value)) { diagnostics.push(diagnostic('server_invalid', { pluginName, component: 'mcp', item: name })); continue }
			output.push(Object.freeze({ name, transport: 'stdio', supported: false }))
			diagnostics.push(diagnostic('transport_unsupported', { pluginName, component: 'mcp', item: name }))
			continue
		}
		if (base.type === 'streamable-http') {
			const server = snapshotPortableHttpServer(value, 'streamable-http')
			if (server) output.push(Object.freeze({ name, transport: 'streamable-http', supported: true, url: server.url, ...(server.headers === undefined ? {} : { headers: server.headers }) }))
			else diagnostics.push(diagnostic('server_invalid', { pluginName, component: 'mcp', item: name }))
			continue
		}
		diagnostics.push(diagnostic('server_invalid', { pluginName, component: 'mcp', item: name }))
	}
	return Object.freeze(output.sort((left, right) => byteCompare(left.name, right.name) || byteCompare(left.transport, right.transport)))
}

function parseSnapshot(snapshot: AgentPluginSnapshot): Parsed {
	const manifestBytes = snapshot.readBytes('plugin.json')
	if (!manifestBytes) throw new ManifestParseFailure('manifest_missing', snapshot, [diagnostic('manifest_missing')])
	const diagnostics: AgentPluginDiagnostic[] = []
	const manifest = parseManifest(manifestBytes, diagnostics)
	if (!manifest) throw new ManifestParseFailure(diagnostics.some(item => item.code === 'schema_unsupported') ? 'schema_unsupported' : 'manifest_invalid', snapshot, diagnostics)
	const skills: AgentPluginSkill[] = []
	const skillIds = new Set<string>()
	if (snapshot.entryKind('skills') === 'file') diagnostics.push(diagnostic('component_invalid', { pluginName: manifest.name, component: 'skills' }))
	if (snapshot.entryKind('mcp.json') === 'directory') diagnostics.push(diagnostic('component_invalid', { pluginName: manifest.name, component: 'mcp' }))
	for (const entryName of snapshot.entryPaths) {
		const match = /^skills\/([^/]+)$/u.exec(entryName)
		if (match && snapshot.entryKind(entryName) === 'directory' && snapshot.entryKind(`${entryName}/SKILL.md`) !== 'file') {
			diagnostics.push(diagnostic('skill_invalid', { pluginName: manifest.name, component: 'skills', item: match[1]! }))
		}
	}
	for (const fileName of snapshot.filePaths) {
		const match = /^skills\/([^/]+)\/SKILL\.md$/u.exec(fileName)
		if (!match) continue
		const id = match[1]!
		const bytes = snapshot.readBytes(fileName)
		const skill = bytes && parseSkill(bytes, id)
		if (!skill) { diagnostics.push(diagnostic('skill_invalid', { pluginName: manifest.name, component: 'skills', item: id })); continue }
		if (skillIds.has(id)) { diagnostics.push(diagnostic('skill_duplicate', { pluginName: manifest.name, component: 'skills', item: id })); continue }
		skillIds.add(id); skills.push(skill)
	}
	const mcpBytes = snapshot.readBytes('mcp.json')
	return Object.freeze({
		snapshot,
		manifest,
		skills: Object.freeze(skills.sort((left, right) => byteCompare(left.name, right.name))),
		mcpServers: mcpBytes ? parseMcp(mcpBytes, manifest.name, diagnostics) : Object.freeze([]),
		diagnostics: sortDiagnostics(diagnostics),
	})
}

function inspectionFrom(parsed: Parsed, trust: AgentPluginTrust, expectedDigest?: unknown): AgentPluginInspection {
	const diagnostics = [...parsed.diagnostics]
	if (trust === 'untrusted') diagnostics.push(diagnostic('untrusted', { pluginName: parsed.manifest.name }))
	if (expectedDigest !== undefined) {
		if (typeof expectedDigest !== 'string' || !digestPattern.test(expectedDigest)) diagnostics.push(diagnostic('digest_invalid', { pluginName: parsed.manifest.name }))
		else if (expectedDigest !== parsed.snapshot.digest) diagnostics.push(diagnostic('digest_mismatch', { pluginName: parsed.manifest.name }))
	}
	return deepFreeze({
		valid: true, manifest: parsed.manifest, trust, digest: parsed.snapshot.digest,
		skills: parsed.skills,
		mcpServers: parsed.mcpServers.map(({ name, transport, supported }) => Object.freeze({ name, transport, supported })) as AgentPluginMcpServerSummary[],
		diagnostics: sortDiagnostics(diagnostics),
	})
}
function failedInspection(
	codes: AgentPluginDiagnosticCode | readonly AgentPluginDiagnostic[],
	trust: AgentPluginTrust,
	expectedDigest?: unknown,
	snapshot?: AgentPluginSnapshot,
): AgentPluginInspection {
	const diagnostics = typeof codes === 'string' ? [diagnostic(codes)] : [...codes]
	const pluginName = diagnostics.find(item => item.pluginName !== undefined)?.pluginName
	if (trust === 'untrusted') diagnostics.push(diagnostic('untrusted', pluginName === undefined ? {} : { pluginName }))
	if (expectedDigest !== undefined) {
		if (typeof expectedDigest !== 'string' || !digestPattern.test(expectedDigest)) diagnostics.push(diagnostic('digest_invalid', pluginName === undefined ? {} : { pluginName }))
		else if (snapshot !== undefined && expectedDigest !== snapshot.digest) diagnostics.push(diagnostic('digest_mismatch', pluginName === undefined ? {} : { pluginName }))
	}
	return deepFreeze({ valid: false, trust, ...(snapshot === undefined ? {} : { digest: snapshot.digest }), skills: [], mcpServers: [], diagnostics: sortDiagnostics(diagnostics) })
}
function snapshotSource(value: unknown): { root: string; trust: AgentPluginTrust; expectedDigest?: unknown } | undefined {
	const source = ownRecord(value, ['root', 'trust', 'expectedDigest'])
	if (!source || typeof source.root !== 'string' || (source.trust !== undefined && source.trust !== 'trusted' && source.trust !== 'untrusted')) return undefined
	return { root: source.root, trust: source.trust === 'trusted' ? 'trusted' : 'untrusted', ...(source.expectedDigest === undefined ? {} : { expectedDigest: source.expectedDigest }) }
}
function scanFailureCode(error: unknown): AgentPluginDiagnosticCode {
	return error instanceof AgentPluginSnapshotError ? error.kind : 'plugin_root_invalid'
}
function inspectAt(sourceValue: unknown, optionsValue: unknown, cwd: string): { inspection: AgentPluginInspection; parsed?: Parsed; source?: ReturnType<typeof snapshotSource>; limits?: AgentPluginSnapshotLimits } {
	const source = snapshotSource(sourceValue)
	if (!source) return { inspection: failedInspection('manifest_invalid', 'untrusted') }
	const limits = limitsOf(optionsValue)
	if (!limits) return { inspection: failedInspection('manifest_invalid', source.trust, source.expectedDigest) }
	try {
		const snapshot = scanAgentPlugin(source.root, cwd, limits)
		let parsed: Parsed
		try { parsed = parseSnapshot(snapshot) } catch (error) {
			if (error instanceof ManifestParseFailure) return { inspection: failedInspection(error.diagnostics, source.trust, source.expectedDigest, snapshot), source, limits }
			throw error
		}
		return { inspection: inspectionFrom(parsed, source.trust, source.expectedDigest), parsed, source, limits }
	} catch (error) {
		return { inspection: failedInspection(scanFailureCode(error), source.trust, source.expectedDigest), source, limits }
	}
}

/** Inspects one plugin directory synchronously without creating definitions or runtime bindings. */
export function inspectAgentPluginSync(source: AgentPluginSource, options: InspectAgentPluginOptions = {}): AgentPluginInspection {
	return inspectAt(source, options, process.cwd()).inspection
}
/** Async convenience form of {@link inspectAgentPluginSync}. */
export async function inspectAgentPlugin(source: AgentPluginSource, options: InspectAgentPluginOptions = {}): Promise<AgentPluginInspection> {
	const cwd = process.cwd()
	return inspectAt(source, options, cwd).inspection
}

function manifestReason(inspection: AgentPluginInspection): AgentPluginManifestErrorReason | undefined {
	if (inspection.diagnostics.some(item => item.code === 'path_escape')) return 'plugin_root_invalid'
	for (const code of ['plugin_root_invalid', 'manifest_missing', 'manifest_invalid', 'schema_unsupported', 'package_too_large'] as const) {
		if (inspection.diagnostics.some(item => item.code === code)) return code
	}
	return undefined
}
function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function snapshotTrustedRoots(value: unknown, cwd: string): readonly string[] | undefined {
	if (value === undefined) return Object.freeze([])
	const values = denseArray(value)
	if (!values || values.some(item => typeof item !== 'string' || item.length === 0 || item.includes('\0'))) return undefined
	const roots: string[] = []
	try {
		for (const item of values as readonly string[]) {
			const real = fs.realpathSync(path.isAbsolute(item) ? item : path.resolve(cwd, item))
			if (!fs.lstatSync(real).isDirectory()) return undefined
			roots.push(real)
		}
	} catch { return undefined }
	return Object.freeze(roots)
}
function throwSnapshot(error: unknown): never {
	if (error instanceof AgentPluginSnapshotError) {
		if (error.kind === 'package_too_large') throw new AgentPluginManifestError('package_too_large')
		if (error.kind === 'manifest_invalid') throw new AgentPluginManifestError('manifest_invalid')
	}
	throw new AgentPluginManifestError('plugin_root_invalid')
}
function snapshotBindingTop(value: unknown): { skills: LazyMap; mcpServers: LazyMap } {
	const options = ownRecord(value, ['skills', 'mcpServers'])
	if (!options || !Object.prototype.hasOwnProperty.call(options, 'skills') || !Object.prototype.hasOwnProperty.call(options, 'mcpServers')) throw new AgentPluginLoadError('invalid_selection')
	const skills = snapshotLazyMap(options.skills)
	const mcpServers = snapshotLazyMap(options.mcpServers)
	if (!skills || !mcpServers) throw new AgentPluginLoadError('invalid_selection')
	return { skills, mcpServers }
}
function snapshotRuntimes(value: unknown): readonly SkillRuntimeId[] {
	const selection = ownRecord(value, ['runtimes'])
	if (!selection || !Object.prototype.hasOwnProperty.call(selection, 'runtimes')) throw new AgentPluginLoadError('invalid_selection')
	const runtimes = denseArray(selection.runtimes)
	if (!runtimes || runtimes.some(runtime => typeof runtime !== 'string' || !runtimeIds.has(runtime as SkillRuntimeId)) || new Set(runtimes).size !== runtimes.length) throw new AgentPluginLoadError('invalid_selection')
	return Object.freeze([...runtimes] as SkillRuntimeId[])
}
function snapshotMcpSelection(value: unknown): Readonly<{ server: unknown; tools: unknown; readHeaders: () => unknown; readResolveHeaders: () => unknown }> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
	let keys: PropertyKey[]
	try {
		const prototype = Reflect.getPrototypeOf(value)
		if (prototype !== Object.prototype && prototype !== null) return undefined
		keys = Reflect.ownKeys(value)
	} catch { return undefined }
	if (keys.some(key => typeof key !== 'string' || !['server', 'tools', 'headers', 'resolveHeaders'].includes(key))) return undefined
	if (!keys.includes('server') || !keys.includes('tools')) return undefined
	let server: unknown
	let tools: unknown
	let headerDescriptor: PropertyDescriptor | undefined
	let resolveHeadersDescriptor: PropertyDescriptor | undefined
	try {
		const serverDescriptor = Reflect.getOwnPropertyDescriptor(value, 'server')
		const toolsDescriptor = Reflect.getOwnPropertyDescriptor(value, 'tools')
		headerDescriptor = Reflect.getOwnPropertyDescriptor(value, 'headers')
		resolveHeadersDescriptor = Reflect.getOwnPropertyDescriptor(value, 'resolveHeaders')
		if (!serverDescriptor?.enumerable || !toolsDescriptor?.enumerable || (keys.includes('headers') && !headerDescriptor?.enumerable)
			|| (keys.includes('resolveHeaders') && !resolveHeadersDescriptor?.enumerable)) return undefined
		server = 'value' in serverDescriptor ? serverDescriptor.value : serverDescriptor.get?.call(value)
		tools = 'value' in toolsDescriptor ? toolsDescriptor.value : toolsDescriptor.get?.call(value)
	} catch { return undefined }
	let read = false
	let resolveHeadersRead = false
	return Object.freeze({
		server,
		tools,
		readHeaders() {
			if (read) throw new AgentPluginLoadError('invalid_http_headers')
			read = true
			if (!headerDescriptor) return undefined
			return 'value' in headerDescriptor ? headerDescriptor.value : headerDescriptor.get?.call(value)
		},
		readResolveHeaders() {
			if (resolveHeadersRead) throw new AgentPluginLoadError('invalid_selection')
			resolveHeadersRead = true
			if (!resolveHeadersDescriptor) return undefined
			return 'value' in resolveHeadersDescriptor ? resolveHeadersDescriptor.value : resolveHeadersDescriptor.get?.call(value)
		},
	})
}
function validSchema(value: unknown, model: boolean): boolean {
	try {
		if (typeof value !== 'object' || value === null) return false
		const standard = (value as { readonly '~standard'?: unknown })['~standard']
		if (typeof standard !== 'object' || standard === null || typeof (standard as { readonly validate?: unknown }).validate !== 'function') return false
		if (!model) return true
		const jsonSchema = (standard as { readonly jsonSchema?: unknown }).jsonSchema
		return typeof jsonSchema === 'object' && jsonSchema !== null
			&& typeof (jsonSchema as { readonly input?: unknown }).input === 'function'
			&& typeof (jsonSchema as { readonly output?: unknown }).output === 'function'
	} catch { return false }
}
function snapshotTool(value: unknown): McpToolOptions<ModelSchema, Schema> {
	const tool = ownRecord(value, ['remoteName', 'description', 'input', 'output'])
	if (!tool || typeof tool.remoteName !== 'string' || tool.remoteName.trim() === '' || typeof tool.description !== 'string' || tool.description.trim() === '' || !validSchema(tool.input, true) || !validSchema(tool.output, false)) throw new AgentPluginLoadError('invalid_selection')
	return Object.freeze({ remoteName: tool.remoteName, description: tool.description, input: tool.input as ModelSchema, output: tool.output as Schema })
}
function baseProvenance(parsed: Parsed): AgentPluginComponentProvenance {
	return Object.freeze({ pluginName: parsed.manifest.name, ...(parsed.manifest.version === undefined ? {} : { version: parsed.manifest.version }), digest: parsed.snapshot.digest })
}
function createLoaded(parsed: Parsed, inspection: AgentPluginInspection, sourceRoot: string, cwd: string, limits: AgentPluginSnapshotLimits): LoadedAgentPlugin {
	return Object.freeze({
		inspection,
		bindings<const Skills extends AgentPluginSkillSelections, const Servers extends AgentPluginHttpMcpServerSelections>(value: Readonly<{ skills: Skills; mcpServers: Servers }>): AgentPluginBindings<Skills, Servers> {
			let currentSnapshot: AgentPluginSnapshot
			try { currentSnapshot = scanAgentPlugin(sourceRoot, cwd, limits) } catch (error) { throwSnapshot(error) }
			if (currentSnapshot.digest !== parsed.snapshot.digest) throw new AgentPluginTrustError('digest_mismatch')
			const current = parseSnapshot(currentSnapshot)
			const options = snapshotBindingTop(value)
			const skillPlans: Array<readonly [string, readonly SkillRuntimeId[]]> = []
			for (const id of [...options.skills.keys].sort(byteCompare)) {
				if (!current.skills.some(skill => skill.name === id)) throw new AgentPluginLoadError('skill_not_found')
				let selection: unknown
				try { selection = options.skills.read(id) } catch { throw new AgentPluginLoadError('invalid_selection') }
				skillPlans.push(Object.freeze([id, snapshotRuntimes(selection)]))
			}
			type McpPlan = Readonly<{ localId: string; server: HttpServer; tools: Readonly<Record<string, McpToolOptions<ModelSchema, Schema>>>; binding: AgentPluginHttpMcpBinding }>
			const mcpPlans: McpPlan[] = []
			const selectedPortable = new Set<string>()
			for (const localId of [...options.mcpServers.keys].sort(byteCompare)) {
				let rawSelection: unknown
				try { rawSelection = options.mcpServers.read(localId) } catch { throw new AgentPluginLoadError('invalid_selection') }
				const selection = snapshotMcpSelection(rawSelection)
				if (!selection || !lowerCamelPattern.test(localId) || typeof selection.server !== 'string') throw new AgentPluginLoadError('invalid_selection')
				const toolMap = snapshotLazyMap(selection.tools)
				if (!toolMap) throw new AgentPluginLoadError('invalid_selection')
				const server = current.mcpServers.find(item => item.name === selection.server)
				if (!server) throw new AgentPluginLoadError('mcp_server_not_found')
				if (server.transport !== 'streamable-http') throw new AgentPluginLoadError('transport_unsupported')
				if (selectedPortable.has(server.name)) throw new AgentPluginLoadError('duplicate_selection')
				selectedPortable.add(server.name)
				if (toolMap.keys.length === 0) throw new AgentPluginLoadError('invalid_selection')
				const tools: Record<string, McpToolOptions<ModelSchema, Schema>> = Object.create(null)
				for (const toolId of [...toolMap.keys].sort(byteCompare)) {
					if (!lowerCamelPattern.test(toolId)) throw new AgentPluginLoadError('invalid_selection')
					let rawTool: unknown
					try { rawTool = toolMap.read(toolId) } catch { throw new AgentPluginLoadError('invalid_selection') }
					tools[toolId] = snapshotTool(rawTool)
				}
				const remoteNames = new Set<string>()
				for (const toolId of Object.keys(tools).sort(byteCompare)) {
					const remoteName = tools[toolId]!.remoteName
					if (remoteNames.has(remoteName)) throw new AgentPluginLoadError('duplicate_selection')
					remoteNames.add(remoteName)
				}
				let binding: AgentPluginHttpMcpBinding
				try {
					createHttpMcpBinding(server.url, server.headers, undefined)
					let callerHeaders: unknown
					try { callerHeaders = selection.readHeaders() } catch { throw new HttpBindingValidationError('invalid_http_headers') }
					let resolveHeaders: unknown
					try { resolveHeaders = selection.readResolveHeaders() } catch { throw new HttpBindingValidationError('invalid_selection') }
					binding = createHttpMcpBinding(server.url, server.headers, callerHeaders, resolveHeaders)
				} catch (error) {
					if (error instanceof HttpBindingValidationError) throw new AgentPluginLoadError(error.reason)
					throw new AgentPluginLoadError('invalid_selection')
				}
				mcpPlans.push(Object.freeze({ localId, server, tools: Object.freeze(tools), binding }))
			}
			const skills: Record<string, ReturnType<typeof defineSkill>> = Object.create(null)
			const mcpServers: Record<string, ReturnType<typeof defineMcpServer>> = Object.create(null)
			const mcp: Record<string, AgentPluginHttpMcpBinding> = Object.create(null)
			const provenanceSkills: Record<string, unknown> = Object.create(null)
			const provenanceServers: Record<string, unknown> = Object.create(null)
			const base = baseProvenance(current)
			for (const [id, runtimes] of skillPlans) {
				try { skills[id] = defineSkill(id, { directory: pathToFileURL(path.join(current.snapshot.resolvedRoot, 'skills', id)), runtimes }) } catch { throw new AgentPluginLoadError('invalid_selection') }
				provenanceSkills[id] = Object.freeze({ ...base, component: 'skill', skillId: id })
			}
			for (const plan of mcpPlans) {
				let definition: ReturnType<typeof defineMcpServer>
				try { definition = defineMcpServer(plan.localId, { tools: plan.tools }) } catch { throw new AgentPluginLoadError('invalid_selection') }
				mcpServers[plan.localId] = definition
				mcp[plan.localId] = plan.binding
				const toolProvenance: Record<string, unknown> = Object.create(null)
				for (const [toolId, tool] of Object.entries(definition.tools)) toolProvenance[toolId] = Object.freeze({ ...base, component: 'mcp-tool', localToolId: toolId, remoteName: tool.remoteName })
				provenanceServers[plan.localId] = Object.freeze({ ...base, component: 'mcp-server', localServerId: plan.localId, pluginServerName: plan.server.name, tools: Object.freeze(toolProvenance) })
			}
			const provenance = Object.freeze({ skills: Object.freeze(provenanceSkills), mcpServers: Object.freeze(provenanceServers) })
			return Object.freeze({ skills: Object.freeze(skills), mcpServers: Object.freeze(mcpServers), mcp: Object.freeze(mcp), provenance }) as AgentPluginBindings<Skills, Servers>
		},
	})
}

/**
 * Atomically loads reviewed plugin snapshots for later explicit projection.
 *
 * @example
 * ```ts
 * const [plugin] = await loadAgentPlugins({
 *   plugins: [{ root: './installed/research', trust: 'trusted', expectedDigest }],
 * })
 * ```
 */
export async function loadAgentPlugins(optionsValue: AgentPluginLoadOptions): Promise<readonly [LoadedAgentPlugin, ...LoadedAgentPlugin[]]> {
	const cwd = process.cwd()
	const options = ownRecord(optionsValue, ['plugins', 'trustedRoots', 'maxFileBytes', 'maxPackageBytes'])
	const pluginValues = options && denseArray(options.plugins)
	const limitInput = options && {
		...(Object.prototype.hasOwnProperty.call(options, 'maxFileBytes') ? { maxFileBytes: options.maxFileBytes } : {}),
		...(Object.prototype.hasOwnProperty.call(options, 'maxPackageBytes') ? { maxPackageBytes: options.maxPackageBytes } : {}),
	}
	const limits = limitInput && limitsOf(limitInput)
	const trustedRoots = options && snapshotTrustedRoots(options.trustedRoots, cwd)
	if (!options || !pluginValues || pluginValues.length === 0 || !limits || !trustedRoots) throw new AgentPluginManifestError('manifest_invalid')
	const result: LoadedAgentPlugin[] = []
	for (const sourceValue of pluginValues) {
		const source = snapshotSource(sourceValue)
		if (!source) throw new AgentPluginManifestError('manifest_invalid')
		const inspected = inspectAt(source, limits, cwd)
		const reason = manifestReason(inspected.inspection)
		if (reason) throw new AgentPluginManifestError(reason)
		if (!inspected.parsed) throw new AgentPluginManifestError('manifest_invalid')
		const locationTrusted = trustedRoots.some(root => contained(root, inspected.parsed!.snapshot.resolvedRoot))
		if (source.trust !== 'trusted' && !locationTrusted) throw new AgentPluginTrustError('untrusted')
		if (typeof source.expectedDigest !== 'string' || !digestPattern.test(source.expectedDigest)) throw new AgentPluginTrustError('digest_invalid')
		if (source.expectedDigest !== inspected.parsed.snapshot.digest) throw new AgentPluginTrustError('digest_mismatch')
		const inspection = inspectionFrom(inspected.parsed, 'trusted', source.expectedDigest)
		result.push(createLoaded(inspected.parsed, inspection, source.root, cwd, limits))
	}
	return Object.freeze(result) as unknown as readonly [LoadedAgentPlugin, ...LoadedAgentPlugin[]]
}
